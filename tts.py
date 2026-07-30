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

VOICE = "af_heart"
SPEED = 1.0
SAMPLE_RATE = 24000  # Kokoro's native rate; the mic path is separate at 16kHz

# Measured sweep on this M2 Pro: 6 threads beat both the default and 10.
INTRA_OP_THREADS = 6

# Built-in speakers into a built-in mic — hold the mic closed a moment longer so
# the room ringing out doesn't get segmented as a new utterance.
TAIL_GUARD = 0.25

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


def speak(chunks, on_chunk=None):
    """Synthesise and play an iterable of text chunks.

    Synthesis runs a chunk ahead of playback on its own thread. That ordering is
    the difference between speech and stilted speech: `write` blocks until the
    device has taken the samples, so synthesising inline meant each sentence only
    began generating once the previous one had finished playing, leaving an
    audible ~1s hole at every sentence boundary.

    Blocks until the audio has finished, so the caller must run it off the mic
    thread. Returns timings for the report line.
    """
    global speaking
    _interrupt.clear()
    started = time.monotonic()
    ready = queue.Queue(maxsize=2)  # Stay ahead, but don't synthesise the world
    synth_seconds = 0.0

    def synthesise():
        nonlocal synth_seconds
        try:
            for chunk in chunks:
                if _interrupt.is_set():
                    return
                mark = time.monotonic()
                samples, _ = _get_kokoro().create(chunk, voice=VOICE, speed=SPEED,
                                                  lang="en-us")
                synth_seconds += time.monotonic() - mark
                while not _interrupt.is_set():
                    try:
                        ready.put((chunk, samples), timeout=0.2)
                        break
                    except queue.Full:
                        continue
        finally:
            ready.put(None)

    worker = threading.Thread(target=synthesise, daemon=True)
    worker.start()

    playback_started = None
    audio_seconds = 0.0
    try:
        while not _interrupt.is_set():
            item = ready.get()
            if item is None:
                break
            chunk, samples = item
            if playback_started is None:
                # Close the mic before the first sample reaches the speakers.
                speaking = True
                playback_started = time.monotonic()
            if on_chunk:
                on_chunk(chunk)
            _get_stream().write(samples)
            audio_seconds += len(samples) / SAMPLE_RATE
    finally:
        _interrupt.set()  # Release the worker if we stopped early
        if playback_started is not None:
            # write() returns once the device has accepted the samples, not once
            # it has played them, so wait out whatever is still in the buffer.
            drain = playback_started + audio_seconds + TAIL_GUARD - time.monotonic()
            if drain > 0:
                time.sleep(drain)
        speaking = False

    return {
        "first_audio_ms": None if playback_started is None
                          else (playback_started - started) * 1000,
        "synth_ms": synth_seconds * 1000,
        "audio_seconds": audio_seconds,
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
    """Compile the graph and open the audio device before the first real reply."""
    _get_kokoro().create("Hello.", voice=VOICE, speed=SPEED, lang="en-us")
    _get_stream()
