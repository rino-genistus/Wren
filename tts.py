"""Wren's voice — Kokoro-82M on onnxruntime, played as it's synthesised.

Keeps the audio path free of torch: onnxruntime already runs openWakeWord,
Silero and WeSpeaker here, so Kokoro joins them rather than pulling in a second
runtime. (The `kokoro` PyPI package would have brought torch, transformers and
spacy along for the same model.)

Synthesis runs at roughly 3x realtime on this machine, which means only the
*first* chunk's latency is ever felt — once playback starts, generation stays
comfortably ahead of the speaker.
"""

import os
import queue
import threading
import time

import numpy
import onnxruntime as ort
import sounddevice as sd

HERE = os.path.dirname(os.path.abspath(__file__))
MODELS = os.path.join(HERE, "models")
RELEASE = ("https://github.com/thewh1teagle/kokoro-onnx/releases/download/"
           "model-files-v1.0")

# fp32. The fp16 build is 20% faster and half the size, but its output diverges
# audibly from fp32 (0.52 correlation across the spectrum bins that carry energy,
# not the ~1.0 a transparent conversion would give), and sounding human is the
# point here. The int8 build is 3x *slower* — same lesson ARM taught us with
# Parakeet. models/kokoro-v1.0.fp16.onnx is kept alongside if you want to A/B it.
MODEL_FILE = "kokoro-v1.0.onnx"
VOICES_FILE = "voices-v1.0.bin"

VOICE = "bf_emma"
# Must match the voice's accent — `lang` drives phonemisation, so a British
# voice reading American phonemes is a mismatch you can hear. Other British
# voices in the same file: bf_isabella, bf_alice, bf_lily, bm_george, bm_lewis.
LANG = "en-gb"
SPEED = 1.0
SAMPLE_RATE = 24000  # Kokoro's native rate; the mic path is separate at 16kHz

# Kokoro pads every clip it synthesises with silence — averaging 54ms of lead
# and 147ms of tail. Written back to back that put ~200ms of dead air at every
# join, which is what made Wren sound like it was reading line by line rather
# than talking. Trim its padding off and insert a join of our own choosing.
#
# 0.004 of peak is -48dB. The old 0.02 (-34dB) was cutting into the signal, not
# the padding: measured, the loudest sample it discarded was -34.5dB — i.e. right
# at the threshold, mid-decay — and it took 13-22ms off each clip. That is the
# release of the final consonant, so words ended clipped. Kokoro's own trim runs
# at -60dB, so anything above that is deliberate output, not silence.
TRIM_THRESHOLD = 0.004
# Mid-phrase, where speech should be continuous. Zero, because a gap here is an
# invented pause: the two pieces are halves of one breath group. The click that
# a hard join would make is handled by the crossfade, not by hiding it in silence.
JOIN_PAUSE = 0.0

# Between sentences, where a pause is what a person would do. Speakers reach a
# conversational ~150 wpm while articulating at ~208 by pausing here, so this is
# not dead air to be minimised — take it out and Wren sounds breathless.
SENTENCE_PAUSE = 0.25

# What it costs to render D seconds of audio, fitted on this machine: a 1.34s
# clip took 499ms and a 4.97s clip took 1461ms. Note what it implies — rendering
# beats playback for any clip longer than 0.2s, so once the first clip is a whole
# sentence it covers everything after it and the stream cannot run dry. Only the
# short fallback opener needs checking, which is the one place _fits_after is used.
SYNTH_FIXED = 0.144
SYNTH_PER_SECOND = 0.265
# For turning a sentence into a duration before we've synthesised it. Counted in
# phonemes rather than characters because that is what actually gets spoken:
# "5 and 7 pm" is ten characters and says "five and seven pee em", which a
# character count underestimates by 22% and a phoneme count by 8%. We phonemise
# the sentence anyway, so this costs nothing.
PHONEMES_PER_SECOND = 18.3

# Below this, a sentence is synthesised whole. Splitting one costs ~0.2s of extra
# duration and a prosodic reset — Kokoro slows into the end of every piece and
# starts the next one fresh — while the latency it saves grows with the length
# (~0.19 * duration), so on a short sentence you pay the seam and get almost
# nothing.
#
# 2.8s is where the measurements separate cleanly. Splitting sentences of 3.4s
# and up cost +0.07 to +0.24s of extra duration; splitting a 2.7s one cost +0.60s
# at the best of the six available cut points and +0.34s at the worst, because
# both halves are then short enough that their final lengthening is a large
# fraction of the whole. Short replies — which is most of them in conversation —
# are therefore spoken as a single clip with no seam at all.
MIN_SPLIT_SECONDS = 2.8
# Headroom over the minimum opening that keeps the stream fed, since the duration
# is estimated rather than known. Small, and deliberately: a longer opening delays
# the first sample and measured *worse* on excess duration too — breaking after
# "I'd say" cost +0.13s where breaking six words later cost +0.23s. Measured
# margin at 1.05 is still 400ms+ of slack on every reply.
OPENER_MARGIN = 1.05
# Don't break after a phoneme this short. Function words — "the" (ðɪ), "or" (ɔː),
# "a" (ə) — are short and belong to what follows them, so cutting after one
# strands it: measured, breaking after "the" cost +0.62s of extra duration where
# breaking after "classic" a few words later cost +0.07s.
MIN_PHONEME_WORD = 4

# Trimming cuts at the first sample above the threshold, which is a step from
# silence into a live waveform — a click waiting to happen. Overlapping the two
# clips by a few milliseconds and crossfading covers the step without leaving the
# gap that fading each edge to zero would. Equal-power (sqrt) rather than linear,
# because the two sides are uncorrelated: linear ramps would dip the loudness
# through the middle of the join and put a hole exactly where the seam is.
#
# Keep this short. Tried and reverted: 60ms, plus a "fade trim" that cut back
# Kokoro's utterance-edge fade before overlapping. The reasoning was sound — the
# last ~120ms of a clip really does decay 25-30dB, and overlapping the two fades
# really does make them sum back to level, taking the measured level step from
# 24dB to 3dB. It sounded worse, and the numbers say why:
#
#   overlap   level step   spectral   speech mixed   length vs whole
#      8ms       24.2dB      1.65x        ~2ms          -0.087s
#     60ms        3.3dB      1.20x       ~11ms          -0.182s
#
# 60ms is most of a syllable. Trimming the fades guarantees both sides of the
# overlap are live speech, so the join stops being a crossfade and becomes two
# different phonemes sounding at once — heard as a slurred or doubled word — and
# it deletes 95ms more real speech per seam than a short one does.
#
# The trap was the metric. "Spectral discontinuity" asks whether the join is an
# abrupt change, and smearing two signals together scores well on that by
# construction; it cannot distinguish a smooth join from a smeared one. Anything
# tried here needs a second metric that measures how much of the overlap has
# both clips audible at once, or it will optimise straight back into this.
CROSSFADE = 0.008

# Measured sweep on this M2 Pro: 6 threads beat both the default and 10.
INTRA_OP_THREADS = 6

# Built-in speakers into a built-in mic — hold the mic closed a moment longer so
# the room ringing out doesn't get segmented as a new utterance.
TAIL_GUARD = 0.25

# People make a noise while they're forming a thought, and it's what stops a
# pause from reading as "did it hear me?". Wren waits this long for the real
# reply; only if it hasn't arrived does it fill the gap.
#
# Tuning this is a straight trade. The first real chunk is ready at ~650-830ms
# depending on how much history is in front of the model, so 0.7 catches the
# slower half and leaves quick turns clean. Drop it to 0.35 and the filler fires
# on essentially every turn: perceived latency becomes a flat ~750ms instead of
# ~1100ms, at the cost of Wren always making a noise first. Set None to disable.
# Speakers produce filled pauses roughly six times per 100 words. Wren's replies
# run ~25 words, so the natural rate is about one turn in four — not every turn,
# which is what a 0.7s deadline gave once the 3B slowed the first chunk down.
# Set this above the usual first-chunk time so it fires only when genuinely late.
# Off. A filler that fires only on the slow turns is, from the listening end,
# a noise that arrives at unpredictable moments — it reads as Wren hesitating at
# random rather than thinking. Silence before an answer is easier to listen to
# than an "Hmm." you cannot predict. Set to a number of seconds to re-enable.
FILLER_AFTER = None

# Deliberately non-committal: these have to sit in front of an answer to a
# question and an acknowledgement of a statement without sounding wrong in
# either. "Sure." and "Right." read as agreement and don't survive that test.
# Short ones only — "Let me see." is a whole sentence and reads as stalling,
# where "Hmm." reads as thinking.
FILLERS = ["Hmm.", "Well,", "Okay,"]

# Two in a row is a tic however well-timed each one was.
FILLER_MIN_GAP_TURNS = 2

_filler_audio = []
_last_filler = -1
_turns_since_filler = FILLER_MIN_GAP_TURNS

# True while audio is reaching the speakers. The mic loop reads this to stay
# half-duplex; only this module writes it.
speaking = False

_kokoro = None
_stream = None
_interrupt = threading.Event()


def _paths():
    model = os.path.join(MODELS, MODEL_FILE)
    voices = os.path.join(MODELS, VOICES_FILE)
    missing = [path for path in (model, voices) if not os.path.exists(path)]
    if missing:
        raise FileNotFoundError(
            "Kokoro model files are missing. Fetch them once (~340MB):\n"
            f"  mkdir -p {MODELS}\n"
            f"  curl -L -o {model} {RELEASE}/{MODEL_FILE}\n"
            f"  curl -L -o {voices} {RELEASE}/{VOICES_FILE}")
    return model, voices


def _get_kokoro():
    global _kokoro
    if _kokoro is None:
        from kokoro_onnx import Kokoro
        model, voices = _paths()
        options = ort.SessionOptions()
        options.intra_op_num_threads = INTRA_OP_THREADS
        options.inter_op_num_threads = 1
        options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        # CoreML is available but falls back to CPU on most of this graph — its
        # dynamic dimensions are unbounded — so it costs compilation and buys
        # nothing.
        session = ort.InferenceSession(model, sess_options=options,
                                       providers=["CPUExecutionProvider"])
        _kokoro = Kokoro.from_session(session, voices)
    return _kokoro


def _get_stream():
    """One long-lived output stream.

    A fresh stream per sentence would leave an audible gap exactly where prosody
    needs continuity, and pay for opening the device every time.
    """
    global _stream
    if _stream is None:
        _stream = sd.OutputStream(samplerate=SAMPLE_RATE, channels=1, dtype="float32")
        _stream.start()
    return _stream


def _trim(samples):
    """Strip Kokoro's own padding, returning the speech alone.

    Same idea as speaker._trim_silence, on mono float32 rather than windowed
    int16. The threshold is relative to the clip's own peak so a quiet clip
    isn't erased and a loud one isn't left with its padding. Pauses and joins
    are the _Joiner's business, not this function's.
    """
    loud = numpy.flatnonzero(numpy.abs(samples) > numpy.abs(samples).max() * TRIM_THRESHOLD)
    if not len(loud):
        return samples[:0]
    return samples[loud[0]:loud[-1] + 1]


def _phonemise(text):
    """The phonemes Kokoro would derive from this text, so we can cut them up.

    Cutting text and phonemising the pieces separately changes how they are
    pronounced: espeak stresses each fragment as a whole utterance, so the last
    word of every piece gets promoted. In "I'd say go for a classic combo…" the
    word "go" is `ɡˌəʊ` in context and `ɡˈəʊ` as the end of a fragment. Phonemise
    once, cut the phonemes, and every piece keeps the pronunciation it would have
    had in the whole sentence.
    """
    return _get_kokoro().tokenizer.phonemize(text, LANG)


def _opening_cut(phonemes, seconds):
    """Where to break the reply's first sentence, or None to keep it whole.

    Only the first sentence is ever split, and only to get audio started: a whole
    sentence takes as long to synthesise as it does to say a third of it, so
    speaking the opening while the rest renders saves most of a second. Every
    later sentence is one clip, because by then playback is already covering.

    The split has to buy enough time to render what follows it — that is the
    stall this guards against — so it takes the larger of the timing requirement
    and a clause boundary, when there is one early enough to be worth using.
    """
    if seconds < MIN_SPLIT_SECONDS:
        return None
    # Fraction of the sentence the opening has to be for its playback to cover
    # the rest's synthesis: f*D >= SYNTH_FIXED + SYNTH_PER_SECOND*(1-f)*D.
    needed = ((SYNTH_FIXED + SYNTH_PER_SECOND * seconds)
              / (seconds * (1 + SYNTH_PER_SECOND)))
    floor = int(len(phonemes) * min(needed, 0.5))
    target = int(len(phonemes) * min(needed * OPENER_MARGIN, 0.5))

    # A comma is where a pause belongs anyway, so prefer one if there is a usable
    # one nearby — the seam stops being a seam and becomes punctuation. It has to
    # be past the floor, though: replies open "I don't know," often enough that
    # taking any early comma left the opening too short to cover what followed,
    # and the stream ran dry a fifth of a second into the answer.
    window = phonemes[:int(target * 1.6)]
    clause = max(window.rfind(", "), window.rfind("; "))
    if clause >= floor:
        return clause + 2

    # Walk forward to the first break that doesn't strand a function word.
    cut = phonemes.find(" ", target)
    while 0 < cut < len(phonemes) - 1:
        word = phonemes[:cut].rsplit(" ", 1)[-1].strip(",;:")
        if len(word) >= MIN_PHONEME_WORD:
            return cut + 1
        cut = phonemes.find(" ", cut + 1)
    return None


def _clips(text, first):
    """Yield (payload, is_phonemes, pause) for one chunk of a reply."""
    # A chunk that ends a sentence has earned a pause; one that doesn't is half
    # of a breath group and must run straight on into what follows.
    pause = SENTENCE_PAUSE if text.rstrip().endswith((".", "!", "?", "…")) else JOIN_PAUSE
    if not first:
        yield text, False, pause
        return

    phonemes = _phonemise(text)
    cut = _opening_cut(phonemes, len(phonemes) / PHONEMES_PER_SECOND)
    if cut is None:
        yield phonemes, True, pause
        return
    yield phonemes[:cut].strip(), True, JOIN_PAUSE
    yield phonemes[cut:].strip(), True, pause


def _synth(payload, is_phonemes=False):
    return _trim(_get_kokoro().create(payload, voice=VOICE, speed=SPEED, lang=LANG,
                                      is_phonemes=is_phonemes)[0])


class _Joiner:
    """Writes clips to the device as one continuous waveform.

    Holds back the last few milliseconds of a clip that runs on into the next,
    so the two can be crossfaded rather than butted together. Butting them steps
    the waveform and clicks; fading both edges to zero instead leaves a hole at
    exactly the seam we are trying to hide. Only the overlap is held back, so
    this costs 8ms of latency rather than a buffer's worth.

    A clip that ends with a pause is not held back — there the separation is the
    point, and there is nothing to hide.

    A sentence's pause is written *before the sentence that follows it* rather
    than after the sentence that earned it. The two sound identical mid-reply,
    and they differ at the end of one: a reply's last chunk ends a sentence, so
    writing the pause eagerly appended SENTENCE_PAUSE of silence after Wren's
    final word and then sat through it — the mic stayed shut for a quarter of a
    second of nothing, on every single turn. Deferring it means the last pause
    is simply never written, because nothing follows it.
    """

    def __init__(self, stream):
        self.stream = stream
        self.carry = numpy.zeros(0, dtype=numpy.float32)
        self.pending = 0.0  # A pause owed to the clip that follows, not the one behind
        self.written = 0

    def _put(self, samples):
        if len(samples):
            self.written += len(samples)
            self.stream.write(samples)

    def write(self, speech, pause):
        if self.pending:
            self._put(numpy.zeros(int(self.pending * SAMPLE_RATE), dtype=numpy.float32))
            self.pending = 0.0

        if len(self.carry):
            overlap = min(len(self.carry), len(speech))
            # Equal-power, not linear: the two sides are uncorrelated, so linear
            # ramps would dip the loudness through the middle of the crossfade
            # and put an audible hole where the join is.
            ramp = numpy.sqrt(numpy.linspace(0.0, 1.0, overlap, dtype=numpy.float32))
            self._put(self.carry[:overlap] * ramp[::-1] + speech[:overlap] * ramp)
            self._put(self.carry[overlap:])
            self.carry = self.carry[:0]
            speech = speech[overlap:]

        if pause > 0:
            self._put(speech)
            self.pending = pause
            return
        hold = min(int(CROSSFADE * SAMPLE_RATE), len(speech))
        self._put(speech[:len(speech) - hold])
        self.carry = speech[len(speech) - hold:]

    def flush(self):
        # `pending` is deliberately dropped: a pause with nothing after it is
        # dead air at the end of the turn, not phrasing.
        self._put(self.carry)
        self.carry = self.carry[:0]
        self.pending = 0.0


def _next_filler():
    """Rotate through the fillers, never the same one twice and never back to back."""
    global _last_filler
    if not _filler_audio or _turns_since_filler < FILLER_MIN_GAP_TURNS:
        return None, None
    _last_filler = (_last_filler + 1) % len(_filler_audio)
    return FILLERS[_last_filler], _filler_audio[_last_filler]


def speak(chunks, on_chunk=None, on_filler=None):
    """Synthesise and play an iterable of text chunks.

    A reply becomes one clip per sentence, plus at most one extra cut inside the
    opening sentence to get audio started. Kokoro renders each clip as a complete
    utterance — slowing into its end and resetting at the start of the next — so
    every cut costs about 0.2s of extra duration and an audible seam. Making few
    of them is the whole reason this sounds spoken rather than assembled.

    Synthesis runs ahead of playback on its own thread. That ordering matters:
    `write` blocks until the device has taken the samples, so synthesising inline
    meant the remainder only began generating once the opening had finished
    playing, leaving an audible ~1s hole in the middle.

    Blocks until the audio has finished, so the caller must run it off the mic
    thread. Returns timings for the report line.
    """
    global speaking, _turns_since_filler
    _interrupt.clear()
    started = time.monotonic()
    ready = queue.Queue(maxsize=2)  # Stay ahead, but don't synthesise the world
    synth_seconds = 0.0
    clips = 0

    def emit(text, payload, is_phonemes, pause):
        nonlocal synth_seconds, clips
        mark = time.monotonic()
        samples = _synth(payload, is_phonemes)
        synth_seconds += time.monotonic() - mark
        clips += 1
        while not _interrupt.is_set():
            try:
                ready.put((text, samples, pause), timeout=0.2)
                return
            except queue.Full:
                continue

    def synthesise():
        try:
            # One clip per sentence. Every split costs ~0.2s of extra duration
            # and a prosodic reset, because Kokoro renders each piece as a
            # complete utterance — slowing into its end, starting the next one
            # fresh. That is what made Wren sound assembled rather than spoken.
            #
            # The one exception is the reply's opening sentence, which _clips
            # may break in two so audio can start before the whole thing has
            # rendered. That cut is made in phoneme space, so the words either
            # side of it are pronounced as they would have been in one breath.
            for index, chunk in enumerate(chunks):
                if _interrupt.is_set():
                    return
                for payload, is_phonemes, pause in _clips(chunk, first=index == 0):
                    if _interrupt.is_set():
                        return
                    emit(chunk, payload, is_phonemes, pause)
        finally:
            ready.put(None)

    worker = threading.Thread(target=synthesise, daemon=True)
    worker.start()

    playback_started = None
    filled = None
    shown = None
    slack = None  # Worst margin between a clip being needed and being ready
    joiner = _Joiner(_get_stream())
    try:
        while not _interrupt.is_set():
            if playback_started is None and FILLER_AFTER is not None:
                # Give the real reply a head start; only cover the gap if it
                # misses the deadline. The filler buys ~0.7s of cover, which is
                # enough for the first chunk to land behind it seamlessly.
                try:
                    item = ready.get(timeout=FILLER_AFTER)
                except queue.Empty:
                    filled, samples = _next_filler()
                    if samples is not None:
                        speaking = True
                        playback_started = time.monotonic()
                        if on_filler:
                            on_filler(filled)
                        joiner.write(samples, SENTENCE_PAUSE)
                    item = ready.get()
            else:
                item = ready.get()
            if item is None:
                break
            chunk, samples, pause = item
            if playback_started is None:
                # Close the mic before the first sample reaches the speakers.
                speaking = True
                playback_started = time.monotonic()
            else:
                # How much audio the device still had left when this clip turned
                # up. Negative means it ran dry and Wren caught its breath
                # mid-sentence, which is the failure this whole pipeline is shaped
                # to avoid.
                spare = (playback_started + joiner.written / SAMPLE_RATE
                         - time.monotonic())
                slack = spare if slack is None else min(slack, spare)
            if on_chunk and chunk != shown:
                shown = chunk
                on_chunk(chunk)
            joiner.write(samples, pause)
        joiner.flush()
    finally:
        _interrupt.set()  # Release the worker if we stopped early
        audio_seconds = joiner.written / SAMPLE_RATE
        if playback_started is not None:
            # write() returns once the device has accepted the samples, not once
            # it has played them, so wait out whatever is still in the buffer.
            drain = playback_started + audio_seconds + TAIL_GUARD - time.monotonic()
            if drain > 0:
                time.sleep(drain)
        speaking = False
        _turns_since_filler = 0 if filled else _turns_since_filler + 1

    return {
        "first_audio_ms": None if playback_started is None
                          else (playback_started - started) * 1000,
        "synth_ms": synth_seconds * 1000,
        "audio_seconds": audio_seconds,
        "clips": clips,
        "slack_ms": None if slack is None else slack * 1000,
        "filler": filled,
    }


def stop():
    """Cut playback immediately.

    Unused while Wren is half-duplex; it exists so barge-in is a flag and a
    check rather than a rewrite of the playback loop.
    """
    _interrupt.set()
    if _stream is not None:
        _stream.abort()
        _stream.start()


def warm():
    """Compile the graph, render the fillers, and open the audio device.

    Pre-rendering costs ~1.4s here so that covering a gap later costs nothing —
    synthesising a filler on demand would defeat the entire point of having one.
    """
    _get_kokoro().create("Hello.", voice=VOICE, speed=SPEED, lang=LANG)
    if FILLER_AFTER is not None and not _filler_audio:
        # Trimmed like everything else — "Hmm." carries a 181ms tail, and left
        # in place it makes the filler sound detached from the answer after it.
        _filler_audio.extend(_synth(text) for text in FILLERS)
    _get_stream()
