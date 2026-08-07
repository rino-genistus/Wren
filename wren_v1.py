
import json
import os
import queue
import re
import signal
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

import affect
import events
import llm
import speaker
import tts

HERE = os.path.dirname(os.path.abspath(__file__))

SAMPLE_RATE = 16000
BLOCK_SIZE = 1280 # 80ms — openWakeWord requires 1280-sample int16 frames at 16kHz

# Prefer the copy inside the repo so Wren is self-contained; fall back to where
# it was first trained so an existing checkout keeps working.
WAKEWORD_PATH = os.path.join(HERE, "models", "wren.onnx")
if not os.path.exists(WAKEWORD_PATH):
    WAKEWORD_PATH = "/Users/rino/Downloads/wren.onnx"
WAKEWORD_THRESHOLD = 0.5 # Raise if it false-fires, lower if it misses you
WAKE_LOOKBACK = 1.0 # A wake word this long before speech onset still counts as addressing us
WAKE_DEBOUNCE = 1.5 # One "wren" spans several blocks; treat re-fires within this as the same one

VAD_THRESHOLD = 0.5 # Silero speech probability above which a block counts as speech
VAD_FRAME_SIZE = 640 # 40ms — must divide BLOCK_SIZE evenly
SPECULATE_AFTER = 0.16 # Seconds of non-speech after which we start transcribing on spec

# People hit 0-200ms turn-taking gaps by *predicting* when you'll finish from
# what you're saying, not by waiting to be sure. A fixed timer can't do both:
# short enough to feel responsive means cutting in when you pause to think.
# So endpoint on the words. Once the speculative transcript is in hand we know
# whether the sentence sounds finished, and can wait accordingly.
SILENCE_COMPLETE = 0.32 # "...in the world?" — you're done, answer
SILENCE_TRAILING = 0.7  # "...and then I was going to" — you're mid-thought, wait
SILENCE_UNKNOWN = 0.4   # No transcript yet; the old fixed behaviour

# Why the fast path isn't shorter: text-only projection cannot see prosody, and
# the ASR punctuates whatever it is handed as though it were a whole sentence —
# it rendered the fragment "what is the tallest" as "what is the tallest?".
# Trusting that at 0.24s made Wren cut in on a 280ms thinking pause and answer
# half a question, which is worse than the fixed timer it replaced. Keeping the
# fast path above a typical mid-sentence pause still beats 0.4s without that
# failure. The real win here is SILENCE_TRAILING catching the clear cases.
PREROLL_DURATION = 0.3 # Seconds kept from before speech onset
MIN_UTTERANCE_DURATION = 0.3 # Ignore blips too short to be words
ASR_MODEL = "mlx-community/parakeet-tdt-0.6b-v3"

FOLLOW_UP_WINDOW = 20.0 # Seconds after a turn during which no wake word is needed
MIN_GATE_WORDS = 3 # Idle-state utterances shorter than this are ignored
DECISION_LOG = "decisions.jsonl"

BLOCK_DURATION = BLOCK_SIZE / SAMPLE_RATE
AFFECT_TICK_BLOCKS = round(1.0 / BLOCK_DURATION) # ~once a second, however long a block is
complete_blocks = int(SILENCE_COMPLETE / BLOCK_DURATION)
trailing_blocks = int(SILENCE_TRAILING / BLOCK_DURATION)
unknown_blocks = int(SILENCE_UNKNOWN / BLOCK_DURATION)
speculate_after_blocks = max(1, int(SPECULATE_AFTER / BLOCK_DURATION))
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
        self.speculated = False
        self.recanted = False
        self.projected = None  # True finished, False mid-thought, None unknown
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
            if self.speculated:
                # We guessed you were finished and you weren't. Whatever was
                # started on that guess has to be thrown away.
                self.speculated = False
                self.recanted = True
            self.silent_blocks = 0
            return None

        self.silent_blocks += 1

        # Emit early, once, so transcription can run *during* the rest of the
        # silence window instead of after it. The extra silence changes neither
        # the transcript nor the speaker embedding — speaker._trim_silence
        # strips both ends — so a provisional result is the final result unless
        # you start talking again.
        if self.silent_blocks == speculate_after_blocks and not self.speculated:
            self.speculated = True
            return self._emit(final=False)

        if self.silent_blocks < self.endpoint_blocks():
            return None
        return self._emit(final=True)

    def endpoint_blocks(self):
        """How long to wait for more speech, given what you appear to have said.

        The transcript usually lands before the old fixed 400ms was up, so by
        then we can tell a finished question from someone drawing breath.
        Asymmetric on purpose: judging you finished when you aren't means
        interrupting you, so anything unrecognised waits the old duration.
        """
        if self.projected is None:
            return unknown_blocks
        return complete_blocks if self.projected else trailing_blocks

    def _emit(self, final):
        audio = numpy.concatenate(self.blocks, axis=0)
        # The wake word counts if it fired during this utterance, or just before
        # it — that's what lets "wren, what's the weather" work as one phrase.
        wake_fired = self.wake_time > self.onset_time - WAKE_LOOKBACK
        if final:
            self.reset()
            self.vad.reset_states()
        return audio, wake_fired, final


def transcribe(asr, audio_int16):
    audio = audio_int16.flatten().astype(numpy.float32) / 32768.0
    # MLX compiles its graph per input shape, so a novel length occasionally costs an
    # extra ~100ms recompile. Pad up to a whole second of silence: shapes repeat across
    # utterances, the graph is reused, and trailing silence doesn't change the text.
    padded_length = int(numpy.ceil(len(audio) / SAMPLE_RATE) * SAMPLE_RATE)
    audio = numpy.pad(audio, (0, padded_length - len(audio)))
    mel = get_logmel(mx.array(audio), asr.preprocessor_config)
    return asr.generate(mel)[0].text.strip()


# Words that almost never end a sentence. Someone who stops here has paused to
# think, not finished — the phrase is still reaching for its object. Generous on
# purpose: every word listed here buys patience, and being patient in error only
# costs a moment, where being impatient in error talks over you.
TRAILING_WORDS = {
    "and", "but", "or", "so", "because", "if", "when", "while", "that", "which",
    "the", "a", "an", "my", "your", "his", "her", "its", "our", "their", "this",
    "these", "those", "some", "any",
    "to", "of", "for", "with", "from", "at", "in", "on", "by", "about", "into",
    "like", "as", "than", "over", "under", "between",
    "is", "are", "was", "were", "be", "been", "am", "do", "does", "did", "have",
    "has", "had", "can", "could", "will", "would", "should", "may", "might",
    # Subject pronouns only. "it", "you", "her", "them" and "there" are left out
    # deliberately — they close questions constantly ("how tall is it", "how are
    # you", "is anyone there"), and listing them would slow down the commonest
    # phrasings there are.
    "i", "he", "she", "we", "they",
    "um", "uh", "er", "erm",
    # Degree words and superlatives are still reaching for their noun — "what is
    # the tallest" is a fragment however confidently the ASR punctuates it. Some
    # of these do occasionally end a sentence ("that's the best"), which costs
    # only patience, so they earn their place.
    "most", "more", "less", "least", "best", "worst", "very", "quite", "such",
    "another", "each", "every", "both", "either", "neither", "same",
    "biggest", "tallest", "largest", "smallest", "highest", "lowest",
    "nearest", "closest", "furthest", "cheapest", "fastest", "longest",
}


def sounds_finished(text):
    """Guess whether an utterance is complete, the way a listener would.

    This is turn-end projection: people reach 200ms gaps by predicting the end
    of your sentence from its grammar, rather than waiting for silence to prove
    it. A trailing conjunction or article is the clearest signal that more is
    coming, and it costs nothing to check.
    """
    stripped = text.strip()
    if not stripped:
        return None
    if stripped.endswith(","):
        return False
    words = re.findall(r"[a-z']+", stripped.lower())
    if not words:
        return None
    # The last word decides, and it outranks the ASR's full stop. Parakeet
    # punctuates whatever it is handed as if it were whole — it returned the
    # fragment "what is the tallest" as "what is the tallest?" — so treating a
    # terminal "?" as proof of completeness is trusting a guess about the very
    # thing being guessed at.
    return words[-1] not in TRAILING_WORDS


# A name is usually addressed with a greeting in front of it, and the greeting is
# no more part of the question than the name is.
GREETINGS = r"(?:hey|hi|hello|ok|okay|so|um|uh)"
NAME_PREFIX = rf"^\s*(?:{GREETINGS}[\s,]+)?w?ren"
# The name standing as its own word, which is all we will assume without evidence.
WAKE_PREFIX = re.compile(NAME_PREFIX + r"\b[\s,.!?]*", re.IGNORECASE)
# The name run into the word after it, which is only safe to assume when the wake
# detector heard it — "render the page" opens with these same three letters.
WAKE_PREFIX_GLUED = re.compile(NAME_PREFIX + r"(?:\b[\s,.!?]*|(?=[a-z]))",
                               re.IGNORECASE)


def strip_wake_word(text, glued=False):
    """Drop the leading name so downstream never sees it.

    The ASR has no idea "Wren" is a name and reliably writes it as "Ren", so
    match what Parakeet actually produces rather than the spelling we intend.

    Safe to call on any accepted utterance, not only when the wake word fired.
    "Hey Ren, how's the weather?" came in through the gate instead, so nothing
    stripped the name and Wren spent its reply saying "I'm Wren, not Ren." The
    anchor is what keeps this conservative: the name has to open the utterance,
    so it is being used to address Wren rather than talked about.

    `glued` is for the wake path only. Parakeet runs the name into whatever
    follows when you don't pause after it — "wren what is the tallest" came back
    as "Renwat is the tallest", which left the name in the question and had Wren
    answering about a mountain called Renwat. Stripping that needs to cut inside
    a word, and the next word loses its first letter ("wat"), which the model
    reads through without trouble. But it is a guess, and applied to any
    utterance it eats real words — "render the page" becomes "der the page". So
    it is only allowed when the detector actually heard the name.
    """
    pattern = WAKE_PREFIX_GLUED if glued else WAKE_PREFIX
    return pattern.sub("", text).strip()


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
    # Opening with the name is the clearest signal there is — that is what a
    # vocative is for — so it doesn't have to pass the length or phrasing tests.
    # Without this, "Hey Ren, how's the weather?" only got through because it
    # happened to end in a question mark, and "hey ren turn the lights off"
    # would have been dropped. The word boundary is what keeps it safe:
    # "rendering is slow" does not match.
    if WAKE_PREFIX.match(text):
        return True
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


def emit_state(engaged):
    """The listening state, for anything watching. No terminal output.

    Separate from `show_state` because mute changes the state without changing
    anything the terminal has to say about it — and printing IDLE again every
    time the UI toggles the mic would be noise in the one place that has to stay
    readable.
    """
    remaining = max(0.0, engaged_until - time.monotonic()) if engaged else 0.0
    events.emit("state", engaged=engaged, ends_in=round(remaining, 2),
                muted=events.commands.muted)


def show_state(engaged):
    """Announce the listening state — the thing you can't otherwise see."""
    if engaged:
        print(paint("1;32", f"\n┌─ ENGAGED · just talk, no wake word · {FOLLOW_UP_WINDOW:.0f}s ─"))
    else:
        print(paint("1;34", '└─ IDLE · say "wren", or ask a question outright ─\n'))
    emit_state(engaged)


def report(verdict, reason, score, text, elapsed_ms, speculated=False):
    """One line per utterance: what Wren heard, what it did, and why.

    A "⚡" means the transcript was already waiting when you stopped talking,
    so the milliseconds shown are what the endpoint actually cost rather than
    what the models cost.
    """
    voice = "  --  " if score is None else f"{score:+.2f}"
    if verdict:
        mark, colour = "✓", "32"
    else:
        mark, colour = "✗", "2"
    speed = f"{'⚡' if speculated else ' '}{elapsed_ms:4.0f}ms"
    print(paint(colour, f"  {mark} {reason:<10} voice {voice} {speed}  {text!r}"))
    events.emit("verdict", accepted=bool(verdict), reason=reason, score=score,
                text=text, ms=round(elapsed_ms, 1), speculated=speculated)


def report_affect():
    """One line per turn: where affect landed, same shape as report()'s verdict line.

    Printed only on turns — not on the once-a-second idle tick in main(), which
    would otherwise scroll a mood reading past every quiet second and bury
    everything else in the terminal. The idle tick still emits to the UI; it
    just doesn't narrate itself here.
    """
    state = affect_engine.get_state_telemetry()
    print(paint("35", f"    affect  V {state['valence']:+.2f}  A {state['arousal']:.2f}  ·  "
                      f"fatigue {state['fatigue']:.2f}  curiosity {state['curiosity']:.2f}  "
                      f"trust {state['social_trust']:.2f}  boredom {state['boredom']:.2f}  "
                      f"security {state['existential_security']:.2f}  ·  {state['dominant_drive']}"))
    events.emit("affect", **state)


def narrate(chunks):
    """Pass chunks through to the synthesiser, printing whole sentences as they form.

    Display is driven by generation, not by playback. Tying it to playback meant
    the transcript arrived *behind* the speech — and printing raw chunks showed
    fragments, since they're cut for latency rather than for reading. This prints
    each sentence the moment the model completes it, so the text leads the audio.
    """
    said = ""
    shown = 0
    for chunk in chunks:
        said = f"{said} {chunk}".strip()
        complete = llm.sentences(said)
        # The last sentence may still be growing, so hold it back until either
        # another one starts behind it or the reply ends.
        for sentence in complete[shown:-1]:
            print(paint("36", f"  ♪ {sentence}"))
            events.emit("speaking", chunk=sentence)
        shown = max(shown, len(complete) - 1)
        yield chunk
    for sentence in llm.sentences(said)[shown:]:
        print(paint("36", f"  ♪ {sentence}"))
        events.emit("speaking", chunk=sentence)


def respond(text):
    """Generate and speak a reply. Runs on the responder thread, never the mic thread."""
    global engaged_until
    said = []
    try:
        # No on_filler *line*: the display is driven by generation and so runs
        # ahead of the audio, which put "Hmm." *after* the sentence it was meant
        # to precede. It's a thinking noise rather than content, and the timing
        # line below already records when one was used. The event is a different
        # matter — the UI shows the filler set apart from the reply, so it can
        # afford to know about it the moment it is spoken.
        spoken = narrate(llm.reply(text, affect_engine=affect_engine))
        stats = tts.speak(
            _collect(spoken, said),
            on_filler=lambda filler: events.emit("filler", text=filler),
        )
    except Exception as error:  # A bad reply shouldn't take the whole mic loop down
        print(paint("31", f"  ! response failed: {error}"))
        events.emit("error", message=f"{type(error).__name__}: {error}")
        # A failed turn is exactly the signal existential_security exists to
        # track — tick it down rather than leave affect blind to the failure.
        affect_engine.tick(user_interacted=True, success_rate=0.0, error_rate=1.0)
        report_affect()
        return
    finally:
        # Re-arm from the moment the turn passes back to you. Setting this when
        # the utterance was accepted instead would spend the window on Wren's own
        # talking — a six-second reply would eat six of your twenty seconds.
        engaged_until = time.monotonic() + FOLLOW_UP_WINDOW

    if stats["first_audio_ms"] is not None:
        covered = " · filler" if stats["filler"] else ""
        print(paint("2", f"    first audio {stats['first_audio_ms']:.0f}ms · "
                         f"synth {stats['synth_ms']:.0f}ms · "
                         f"spoke {stats['audio_seconds']:.1f}s{covered}"))

    # The authoritative version of the reply, regrouped into whole sentences.
    # Whatever streamed as chunks is replaced by this, so a reply cut for
    # time-to-first-audio never leaves fragments on the page.
    events.emit("spoke", sentences=llm.sentences(" ".join(said).strip()),
                first_audio_ms=stats["first_audio_ms"], synth_ms=stats["synth_ms"],
                audio_seconds=stats["audio_seconds"], filler=stats["filler"])
    events.emit("history", messages=list(llm.history))

    # No token count comes back from either backend today, so approximate one
    # from what was actually said — the usual ~4-chars-per-token rule of thumb —
    # rather than plumb real counts through both streaming paths for this.
    tokens = max(1, len(" ".join(said)) // 4)
    affect_engine.tick(tokens_generated=tokens, user_interacted=True,
                       success_rate=1.0, error_rate=0.0)
    report_affect()


def _collect(chunks, into):
    """Tee the chunks on their way to the synthesiser, so respond() keeps a copy."""
    for chunk in chunks:
        into.append(chunk)
        yield chunk


def handle(text):
    """Hand the accepted utterance off and get straight back to listening.

    This must not block: the mic thread is already spending ~120ms per utterance
    on transcription, and a reply costs seconds. Blocking here would back up the
    block queue and splice the overflow onto your next utterance.
    """
    print(paint("1;37", f"  → {text}"))
    events.emit("thinking", text=text)
    responder.submit(respond, text)


# ── Loading ───────────────────────────────────────────────────────────────────
# Six subsystems, each bracketed so that anything watching can see which one is
# in flight and which have landed. Every stage is also re-runnable on its own,
# because "try again" is only worth offering if it can retry the part that
# actually failed rather than restarting Wren.
#
# A stage that raises is reported and survived. One missing model file should
# cost you that capability, not the process: without a brain Wren can still hear
# you and know you, and saying so is more use than a traceback.

wakeword = None
vad = None
asr = None
voiceprint = None
segmenter = None
brain_ok = False
brain_status = "not loaded"

# Cheap pure-Python construction, unlike everything else on this page — no
# _load_* stage needed, it's ready the moment the module is imported.
affect_engine = affect.AffectEngine()

pool = ThreadPoolExecutor(max_workers=1)
responder = ThreadPoolExecutor(max_workers=1)

engaged_until = 0.0


def _load_wakeword():
    global wakeword
    wakeword = None
    with events.loading("wakeword") as stage:
        wakeword = WakeWordModel(wakeword_models=[WAKEWORD_PATH],
                                 inference_framework="onnx")
    return stage


def _load_vad():
    global vad
    vad = None
    with events.loading("vad") as stage:
        vad = VAD()
    return stage


def _load_asr():
    global asr
    asr = None
    with events.loading("asr") as stage:
        asr = parakeet_mlx.from_pretrained(ASR_MODEL)
    return stage


def _load_voiceprint():
    global voiceprint
    voiceprint = None
    with events.loading("voiceprint") as stage:
        voiceprint = speaker.load_voiceprint()
    return stage


def _load_warm():
    # Warm everything now so the first real turn doesn't pay any cold-start cost. The ASR
    # clip is a realistic duration on purpose — MLX builds its graph per input shape, so
    # warming on a clip much shorter than a real utterance leaves most of the compilation
    # to the first command.
    with events.loading("warm") as stage:
        if asr is None:
            raise RuntimeError("the transcriber didn't load, so there is nothing to warm")
        transcribe(asr, numpy.zeros(SAMPLE_RATE * 3, dtype=numpy.int16))
        tts.warm()
    return stage


def _load_brain():
    global brain_ok, brain_status
    with events.loading("brain") as stage:
        brain_ok, brain_status = llm.available()
        if brain_ok:
            # Warm *through the responder*, not here. MLX binds a model to the thread
            # that loaded it, and the responder thread is the only one that generates —
            # warming on the main thread would strand the weights where they can't be
            # used. The executor keeps one worker alive, so it's the same thread later.
            responder.submit(llm.warm).result()
    if not stage.ok:
        brain_ok, brain_status = False, "unreachable"
    return stage


LOADERS = {
    "wakeword": _load_wakeword,
    "vad": _load_vad,
    "asr": _load_asr,
    "voiceprint": _load_voiceprint,
    "warm": _load_warm,
    "brain": _load_brain,
}

# Without these three there is no listening at all: the segmenter is built from
# the first two and the third is what turns audio into words. The other three
# each cost you something specific and nothing more.
ESSENTIAL = ("wakeword", "vad", "asr")


failed_stages = set()
announced = False


def load(only=None):
    """Bring the subsystems up, or just the ones named. Returns what failed."""
    global segmenter
    for name, loader in LOADERS.items():
        if only and name not in only:
            continue
        stage = loader()
        if stage.ok:
            failed_stages.discard(name)
        else:
            failed_stages.add(name)
            # Swallowing the exception must not mean swallowing the news of it.
            # The terminal used to get a traceback; it still gets the one line
            # of it that matters.
            print(paint("31", f"  ! {name} failed: "
                              f"{type(stage.error).__name__}: {stage.error}"))
    if wakeword is not None and vad is not None:
        segmenter = Segmenter(wakeword, vad)
    return sorted(failed_stages)


def listening_possible():
    """Whether Wren can hear you at all. The other three stages are luxuries."""
    return not set(ESSENTIAL) & failed_stages


def announce():
    """The startup banner, unchanged, plus the same facts as one `ready` record.

    Idempotent, because a retry that finally brings the last essential stage up
    announces from the command thread and `main` would otherwise print it twice.
    """
    global announced
    if announced:
        return
    announced = True
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

    events.emit("ready", wakeword="wren", threshold=WAKEWORD_THRESHOLD,
                voiceprint="enrolled" if voiceprint is not None else "not enrolled",
                similarity_threshold=speaker.SIMILARITY_THRESHOLD,
                model=llm.MODEL, brain_status=brain_status,
                voice=tts.VOICE, tts="kokoro-82M", failed=sorted(failed_stages))
    events.emit("personality", prompt=llm.SYSTEM_PROMPT, temperature=llm.TEMPERATURE,
                max_sentences=llm.MAX_SENTENCES, max_reply_chars=llm.MAX_REPLY_CHARS,
                history_turns=llm.HISTORY_TURNS)


# ── Commands ──────────────────────────────────────────────────────────────────
# Anything the UI asks for. Mute is a flag the mic loop reads; stop and reset
# happen here and now, on the reader thread, because a barge-in that waits for
# the next 80ms block to be processed is a barge-in you can hear being late.
#
# Retrying a stage is the exception, and it is a thread question rather than a
# latency one. See `retries`.

# Stage retries, queued for the main thread to run. Not run on the reader thread:
# MLX binds a model to whichever thread loaded it and refuses to run it from any
# other, and two of the six loaders are on the wrong side of that. `asr` loads
# the model the mic loop transcribes with, and `warm` runs a generate through it
# — so loading either here would strand the weights where transcribe() cannot
# reach them. It is the same trap `_load_brain` already sidesteps by warming
# through the responder, which is the thread that generates.
#
# The main thread drains this between blocks. That means a retry blocks the mic
# loop for as long as the stage takes, which is fine: blocks queue up rather than
# being lost, and a subsystem that isn't up is not one Wren can use anyway.
retries = queue.Queue()


def on_command(record):
    kind = record.get("kind")
    if kind == "stop":
        tts.stop()
    elif kind == "reset":
        llm.reset()
        events.emit("history", messages=[])
    elif kind == "retry":
        stage = record.get("stage")
        if stage in LOADERS:
            retries.put(stage)
        elif record.get("text"):
            handle(record["text"])


def run_retries():
    """Run whatever the reader thread has queued. Main thread only."""
    while True:
        try:
            stage = retries.get_nowait()
        except queue.Empty:
            return
        load(only=[stage])
        # If that was the last thing standing between Wren and listening, the
        # boot finishes now rather than on the next restart.
        if not announced and listening_possible():
            announce()

# ── Running ───────────────────────────────────────────────────────────────────


def _shutdown(signum, frame):
    """Electron kills the child with SIGTERM. Leave nothing behind.

    Without this the mic stream stays open and the executors keep the process
    alive, so quitting the app left a Wren holding the microphone. Raising
    SystemExit here unwinds through the `with` below, which closes the device.
    """
    tts.stop()
    pool.shutdown(wait=False, cancel_futures=True)
    responder.shutdown(wait=False, cancel_futures=True)
    raise SystemExit(0)


def main():
    global engaged_until

    # Both are no-ops unless a parent process opened the descriptors, which is
    # what keeps `python wren_v1.py` behaving exactly as it always has.
    events.listen()
    events.commands.on(on_command)
    signal.signal(signal.SIGTERM, _shutdown)

    load()
    if not listening_possible():
        # Nothing to listen with. Stay up rather than exiting: the failure has
        # already been reported in full, and a process that has quit cannot be
        # asked to try again.
        print(paint("31", "\nWren can't listen — see the failures above."))
        while not listening_possible():
            run_retries()
            time.sleep(0.2)

    announce()

    engaged = False
    pending = None
    was_hearing = False
    was_muted = False
    blocks = 0
    last_wake_seen = segmenter.wake_time

    show_state(engaged)

    with sd.InputStream(callback=audio_callback, channels=1, samplerate=SAMPLE_RATE,
                        blocksize=BLOCK_SIZE, dtype="int16"):
        while True:
            block = block_queue.get()

            # Anything the UI asked to reload. Here rather than on the reader
            # thread so a reloaded model belongs to the thread that uses it.
            if not retries.empty():
                run_retries()

            # Muted. The stream stays open — closing and reopening the device
            # costs the better part of a second and can hand back a different
            # one — but nothing downstream ever sees the audio.
            if events.commands.muted != was_muted:
                was_muted = events.commands.muted
                if was_muted:
                    segmenter.reset()
                    wakeword.reset()
                    was_hearing = False
                emit_state(engaged)
            if was_muted:
                continue

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

            # The one signal with no print behind it, because a terminal has no
            # use for it: how loud you are, ten times a second. It is what makes
            # the orb move with your voice rather than merely change state.
            blocks += 1
            if events.attached() and blocks % 3 == 0:
                rms = float(numpy.sqrt(numpy.mean(
                    (block.astype(numpy.float32) / 32768.0) ** 2)))
                events.emit("level", rms=round(min(1.0, rms * 6.0), 3))

            # Advances boredom/decay even between turns, so a long silence shows
            # up in affect rather than only updating when someone speaks. The
            # tick itself always runs — state has to keep moving whether or not
            # anyone's watching — only the emit is gated on a listener existing.
            if blocks % AFFECT_TICK_BLOCKS == 0:
                affect_engine.tick(user_interacted=False)
                if events.attached():
                    events.emit("affect", **affect_engine.get_state_telemetry())

            emitted = segmenter.push(block)

            if segmenter.recanted:
                # You paused, we started work on the guess, then you carried on.
                # Drop it; the utterance will be transcribed again when it truly ends.
                segmenter.recanted = False
                pending = None

            # Live feedback, so a silent drop is never ambiguous with never hearing
            # you at all. These fire the moment they happen, before transcription.
            if segmenter.wake_time > last_wake_seen:
                last_wake_seen = segmenter.wake_time
                print(paint("1;33", "  ◆ wake word"))
                events.emit("wake")
            if segmenter.speech_started and not was_hearing:
                print(paint("2", "  ● hearing you..."))
                events.emit("hearing", on=True)
            elif was_hearing and not segmenter.speech_started:
                # No print: the terminal has nothing to say about you stopping,
                # but the orb has to come back out of `hearing`.
                events.emit("hearing", on=False)
            was_hearing = segmenter.speech_started

            if emitted is None:
                continue

            audio, wake_fired, final = emitted

            # Speaker ID is onnxruntime on the CPU and the ASR is MLX on the GPU, so
            # running them together costs max(~155ms, ~82ms) instead of their sum.
            # Both go to the pool rather than the mic thread: while they run we still
            # have to notice you starting to speak again.
            if not final:
                if len(audio) >= min_utterance_samples:
                    # Transcribe here, on this thread, so the remaining silence is
                    # spent waiting rather than working. It has to be this thread:
                    # MLX gives each thread its own stream and refuses to run a
                    # model from one it wasn't loaded on. Blocking the mic loop for
                    # ~120ms is safe — blocks queue up rather than being lost, so a
                    # resumed sentence is still noticed, just fractionally later.
                    identity = pool.submit(speaker.check, audio, voiceprint)
                    text = transcribe(asr, audio)
                    pending = (text, identity)
                    # Now that there are words, the segmenter can stop guessing at
                    # how long to wait and read it off the grammar instead.
                    segmenter.projected = sounds_finished(text)
                continue

            duration = len(audio) / SAMPLE_RATE
            started = time.monotonic()

            if len(audio) < min_utterance_samples:
                report(False, "too short", None, f"{duration:.1f}s", 0)
                pending = None
                continue

            if pending is None:
                # No usable guess — an utterance short enough to end before we ever
                # speculated, or one we recanted. Speaker ID is onnxruntime on the
                # CPU and the ASR is MLX on the GPU, so running them together costs
                # max(~155ms, ~82ms) rather than their sum.
                identity = pool.submit(speaker.check, audio, voiceprint)
                text = transcribe(asr, audio)
                speculated = False
            else:
                text, identity = pending
                pending = None
                speculated = True

            is_me, score = identity.result()
            elapsed_ms = (time.monotonic() - started) * 1000

            if not is_me:
                # Still shows the transcript — you need to see what it rejected to
                # judge whether the threshold is right.
                report(False, "not you", score, text, elapsed_ms, speculated)
                continue
            if not text:
                report(False, "no speech", score, "", elapsed_ms, speculated)
                continue

            if wake_fired:
                accepted, reason = True, "wake"
            elif engaged:
                accepted, reason = True, "follow-up"
            else:
                # Judged on the whole utterance, before the name comes off: stripping
                # first would push a short request under MIN_GATE_WORDS and have the
                # gate reject something addressed to Wren by name.
                accepted, reason = is_addressed(text), "gate"
                log_decision(text, accepted)

            # However the utterance was accepted, the name is not part of the
            # question. "Hey Ren, how's the weather?" reached the gate rather than the
            # wake word, so nothing used to strip it and Wren answered the name
            # instead of the question.
            if accepted:
                text = strip_wake_word(text, glued=wake_fired)
                if not text:
                    # Just the name — you have Wren's attention, so hold the window
                    # open and wait for what you actually wanted to say.
                    report(True, reason, score, "(name only)", elapsed_ms, speculated)
                    engaged_until = time.monotonic() + FOLLOW_UP_WINDOW
                    if not engaged:
                        engaged = True
                        show_state(engaged)
                    continue

            report(accepted, reason, score, text, elapsed_ms, speculated)
            if accepted:
                handle(text)
                engaged_until = time.monotonic() + FOLLOW_UP_WINDOW
                if not engaged:
                    engaged = True
                    show_state(engaged)



if __name__ == "__main__":
    main()
