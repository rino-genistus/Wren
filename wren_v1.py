
import json
import queue
import re
import sys
import time
from collections import deque
from concurrent.futures import ThreadPoolExecutor

import numpy
import mlx.core as mx
import sounddevice as sd
import parakeet_mlx
from parakeet_mlx.audio import get_logmel
from openwakeword.model import Model as WakeWordModel
from openwakeword.vad import VAD

import llm
import speaker
import tts

SAMPLE_RATE = 16000
BLOCK_SIZE = 1280 # 80ms — openWakeWord requires 1280-sample int16 frames at 16kHz

WAKEWORD_PATH = "/Users/rino/Downloads/wren.onnx"
WAKEWORD_THRESHOLD = 0.5 # Raise if it false-fires, lower if it misses you
WAKE_LOOKBACK = 1.0 # A wake word this long before speech onset still counts as addressing us
WAKE_DEBOUNCE = 1.5 # One "wren" spans several blocks; treat re-fires within this as the same one

VAD_THRESHOLD = 0.5 # Silero speech probability above which a block counts as speech
VAD_FRAME_SIZE = 640 # 40ms — must divide BLOCK_SIZE evenly
SILENCE_DURATION = 0.4 # Seconds of non-speech that ends an utterance
PREROLL_DURATION = 0.3 # Seconds kept from before speech onset
MIN_UTTERANCE_DURATION = 0.3 # Ignore blips too short to be words
ASR_MODEL = "mlx-community/parakeet-tdt-0.6b-v3"

FOLLOW_UP_WINDOW = 20.0 # Seconds after a turn during which no wake word is needed
MIN_GATE_WORDS = 3 # Idle-state utterances shorter than this are ignored
DECISION_LOG = "decisions.jsonl"

BLOCK_DURATION = BLOCK_SIZE / SAMPLE_RATE
silent_blocks_limit = int(SILENCE_DURATION / BLOCK_DURATION)
preroll_blocks = int(PREROLL_DURATION / BLOCK_DURATION)
min_utterance_samples = int(MIN_UTTERANCE_DURATION * SAMPLE_RATE)

block_queue = queue.Queue()


def audio_callback(indata, frames, time_info, status):
    if status:
        print(status)
    # Only hand the block off here; all the work happens on the main thread.
    block_queue.put(indata.copy())


class Segmenter:
    """Consumes every block, emits (audio, wake_fired) when an utterance ends.

    Both models run on all audio — openWakeWord at ~2.2ms and Silero at ~0.22ms
    per 80ms block, so listening continuously costs almost nothing.
    """

    def __init__(self, wakeword, vad):
        self.wakeword = wakeword
        self.vad = vad
        self.preroll = deque(maxlen=preroll_blocks)
        self.reset()
        self.wake_time = -1e9

    def reset(self):
        self.blocks = []
        self.speech_started = False
        self.onset_time = 0.0
        self.silent_blocks = 0
        self.preroll.clear()

    def push(self, block):
        flat = block.flatten()

        now = time.monotonic()
        if (self.wakeword.predict(flat)["wren"] > WAKEWORD_THRESHOLD
                and now - self.wake_time > WAKE_DEBOUNCE):
            # A single spoken "wren" spans several blocks and keeps clearing the
            # threshold, so collapse the run into one event.
            self.wake_time = now
            self.wakeword.reset()

        # Silero scores speech specifically, so a fan or keyboard won't hold a
        # recording open the way a plain RMS gate would.
        is_speech = float(self.vad.predict(flat, frame_size=VAD_FRAME_SIZE)) > VAD_THRESHOLD

        if not self.speech_started:
            self.preroll.append(block)
            if is_speech:
                self.speech_started = True
                self.onset_time = time.monotonic()
                self.blocks = list(self.preroll)
                self.preroll.clear()
            return None

        self.blocks.append(block)
        if is_speech:
            self.silent_blocks = 0
            return None

        self.silent_blocks += 1
        if self.silent_blocks < silent_blocks_limit:
            return None

        audio = numpy.concatenate(self.blocks, axis=0)
        # The wake word counts if it fired during this utterance, or just before
        # it — that's what lets "wren, what's the weather" work as one phrase.
        wake_fired = self.wake_time > self.onset_time - WAKE_LOOKBACK
        self.reset()
        self.vad.reset_states()
        return audio, wake_fired


def transcribe(asr, audio_int16):
    audio = audio_int16.flatten().astype(numpy.float32) / 32768.0
    # MLX compiles its graph per input shape, so a novel length occasionally costs an
    # extra ~100ms recompile. Pad up to a whole second of silence: shapes repeat across
    # utterances, the graph is reused, and trailing silence doesn't change the text.
    padded_length = int(numpy.ceil(len(audio) / SAMPLE_RATE) * SAMPLE_RATE)
    audio = numpy.pad(audio, (0, padded_length - len(audio)))
    mel = get_logmel(mx.array(audio), asr.preprocessor_config)
    return asr.generate(mel)[0].text.strip()


def strip_wake_word(text):
    """Drop the leading name so downstream never sees it.

    The ASR has no idea "Wren" is a name and reliably writes it as "Ren", so
    match what Parakeet actually produces rather than the spelling we intend.
    Only ever called when the wake word genuinely fired, so a leading "ren"
    really is the name and not the first word of what you said.
    """
    return re.sub(r"^\s*w?ren\b[\s,.!?]*", "", text, flags=re.IGNORECASE).strip()


ACKNOWLEDGEMENTS = {"yeah", "yes", "no", "okay", "ok", "hmm", "mhm", "uh", "um",
                    "sure", "right", "cool", "nice", "oh", "huh", "wow", "thanks"}
REQUEST_OPENERS = {"what", "when", "where", "who", "why", "how", "which", "whose",
                   "is", "are", "was", "were", "do", "does", "did", "can", "could",
                   "should", "would", "will", "tell", "give", "show", "play", "set",
                   "find", "open", "make", "write", "explain", "remind", "add", "let"}


def is_addressed(text):
    """Decide whether idle-state speech was meant for Wren.

    Deliberately conservative — it only guards the first turn of a conversation,
    so a miss costs one wake word while a false accept interrupts you. The real
    answer is an LLM classification call once Wren has a brain; this keeps the
    signature it will need.
    """
    words = re.findall(r"[a-z']+", text.lower())
    if len(words) < MIN_GATE_WORDS:
        return False
    if all(word in ACKNOWLEDGEMENTS for word in words):
        return False
    return text.rstrip().endswith("?") or words[0] in REQUEST_OPENERS


def log_decision(text, accepted):
    """Record idle-state verdicts so the gate can be tuned against real data."""
    with open(DECISION_LOG, "a") as handle:
        handle.write(json.dumps({"time": time.time(), "text": text,
                                 "accepted": accepted}) + "\n")


USE_COLOUR = sys.stdout.isatty()


def paint(code, text):
    return f"\033[{code}m{text}\033[0m" if USE_COLOUR else text


def show_state(engaged):
    """Announce the listening state — the thing you can't otherwise see."""
    if engaged:
        print(paint("1;32", f"\n┌─ ENGAGED · just talk, no wake word · {FOLLOW_UP_WINDOW:.0f}s ─"))
    else:
        print(paint("1;34", '└─ IDLE · say "wren", or ask a question outright ─\n'))


def report(verdict, reason, score, text, elapsed_ms):
    """One line per utterance: what Wren heard, what it did, and why."""
    voice = "  --  " if score is None else f"{score:+.2f}"
    if verdict:
        mark, colour = "✓", "32"
    else:
        mark, colour = "✗", "2"
    print(paint(colour, f"  {mark} {reason:<10} voice {voice}  {elapsed_ms:4.0f}ms  {text!r}"))


def respond(text):
    """Generate and speak a reply. Runs on the responder thread, never the mic thread."""
    global engaged_until
    try:
        stats = tts.speak(llm.reply(text),
                          on_chunk=lambda chunk: print(paint("36", f"  ♪ {chunk}")))
    except Exception as error:  # A bad reply shouldn't take the whole mic loop down
        print(paint("31", f"  ! response failed: {error}"))
        return
    finally:
        # Re-arm from the moment the turn passes back to you. Setting this when
        # the utterance was accepted instead would spend the window on Wren's own
        # talking — a six-second reply would eat six of your twenty seconds.
        engaged_until = time.monotonic() + FOLLOW_UP_WINDOW

    if stats["first_audio_ms"] is not None:
        print(paint("2", f"    first audio {stats['first_audio_ms']:.0f}ms · "
                         f"synth {stats['synth_ms']:.0f}ms · "
                         f"spoke {stats['audio_seconds']:.1f}s"))


def handle(text):
    """Hand the accepted utterance off and get straight back to listening.

    This must not block: the mic thread is already spending ~120ms per utterance
    on transcription, and a reply costs seconds. Blocking here would back up the
    block queue and splice the overflow onto your next utterance.
    """
    print(paint("1;37", f"  → {text}"))
    responder.submit(respond, text)


wakeword = WakeWordModel(wakeword_models=[WAKEWORD_PATH], inference_framework="onnx")
vad = VAD()
asr = parakeet_mlx.from_pretrained(ASR_MODEL)
voiceprint = speaker.load_voiceprint()

# Warm everything now so the first real turn doesn't pay any cold-start cost. The ASR
# clip is a realistic duration on purpose — MLX builds its graph per input shape, so
# warming on a clip much shorter than a real utterance leaves most of the compilation
# to the first command. Ollama's cold model load is the expensive one at ~17s.
transcribe(asr, numpy.zeros(SAMPLE_RATE * 3, dtype=numpy.int16))
tts.warm()
brain_ok, brain_status = llm.available()
if brain_ok:
    llm.warm()

segmenter = Segmenter(wakeword, vad)
pool = ThreadPoolExecutor(max_workers=1)
responder = ThreadPoolExecutor(max_workers=1)
engaged_until = 0.0
engaged = False
was_hearing = False
last_wake_seen = segmenter.wake_time

print(f"Wake word   {'wren':<14} threshold {WAKEWORD_THRESHOLD}")
if voiceprint is None:
    print(paint("33", "Voice ID    not enrolled    ANY voice will be accepted — "
                      "run enroll.py to restrict Wren to yours"))
else:
    print(f"Voice ID    enrolled       accepts above {speaker.SIMILARITY_THRESHOLD}")
brain = f"Brain       {llm.MODEL:<14} {brain_status}"
print(brain if brain_ok else paint("33", brain))
print(f"Voice       {tts.VOICE:<14} kokoro-82M")
print("\nEverything Wren hears is shown below, accepted or not.")
show_state(engaged)

with sd.InputStream(callback=audio_callback, channels=1, samplerate=SAMPLE_RATE,
                    blocksize=BLOCK_SIZE, dtype="int16"):
    while True:
        block = block_queue.get()

        if tts.speaking:
            # Don't listen to ourselves — the built-in mic hears the built-in
            # speakers. Discard partial state so Wren's own voice can't be
            # spliced onto the front of your next utterance, and clear the wake
            # detector so it can't be left part-charged by Wren saying "wren".
            segmenter.reset()
            wakeword.reset()
            was_hearing = False
            continue

        if engaged and time.monotonic() >= engaged_until:
            engaged = False
            show_state(engaged)

        emitted = segmenter.push(block)

        # Live feedback, so a silent drop is never ambiguous with never hearing
        # you at all. These fire the moment they happen, before transcription.
        if segmenter.wake_time > last_wake_seen:
            last_wake_seen = segmenter.wake_time
            print(paint("1;33", "  ◆ wake word"))
        if segmenter.speech_started and not was_hearing:
            print(paint("2", "  ● hearing you..."))
        was_hearing = segmenter.speech_started

        if emitted is None:
            continue

        audio, wake_fired = emitted
        duration = len(audio) / SAMPLE_RATE
        started = time.monotonic()

        if len(audio) < min_utterance_samples:
            report(False, "too short", None, f"{duration:.1f}s", 0)
            continue

        # Speaker ID is onnxruntime on the CPU and the ASR is MLX on the GPU, so
        # running them together costs max(~155ms, ~82ms) instead of their sum.
        # If the voice turns out not to be yours the transcript is simply dropped.
        speaker_check = pool.submit(speaker.check, audio, voiceprint)
        text = transcribe(asr, audio)
        is_me, score = speaker_check.result()
        elapsed_ms = (time.monotonic() - started) * 1000

        if not is_me:
            # Still shows the transcript — you need to see what it rejected to
            # judge whether the threshold is right.
            report(False, "not you", score, text, elapsed_ms)
            continue
        if not text:
            report(False, "no speech", score, "", elapsed_ms)
            continue

        if wake_fired:
            text = strip_wake_word(text)
            if not text:
                # Just the name — you have Wren's attention, so hold the window
                # open and wait for what you actually wanted to say.
                report(True, "wake", score, "(name only)", elapsed_ms)
                engaged_until = time.monotonic() + FOLLOW_UP_WINDOW
                if not engaged:
                    engaged = True
                    show_state(engaged)
                continue

        if wake_fired:
            accepted, reason = True, "wake"
        elif engaged:
            accepted, reason = True, "follow-up"
        else:
            accepted, reason = is_addressed(text), "gate"
            log_decision(text, accepted)

        report(accepted, reason, score, text, elapsed_ms)
        if accepted:
            handle(text)
            engaged_until = time.monotonic() + FOLLOW_UP_WINDOW
            if not engaged:
                engaged = True
                show_state(engaged)
