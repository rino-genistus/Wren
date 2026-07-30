"""Speaker identity — keeps Wren from answering anyone but you.

Wraps the WeSpeaker ResNet34 ONNX embedder. Runs on onnxruntime alongside
openWakeWord and Silero, so the audio path stays free of torch.
"""

import os

import numpy
import kaldi_native_fbank as knf
import onnxruntime as ort
from huggingface_hub import hf_hub_download

SAMPLE_RATE = 16000
MODEL_REPO = "Wespeaker/wespeaker-voxceleb-resnet34-LM"
MODEL_FILE = "voxceleb_resnet34_LM.onnx"
VOICEPRINT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "voiceprint.npy")

# Cosine similarity above which an utterance is accepted as yours. Raise it if
# other voices get through, lower it if you get ignored.
SIMILARITY_THRESHOLD = 0.5

# Too short and the embedding is unreliable, so we accept rather than reject —
# the wake word and addressee gate still apply.
MIN_SAMPLES = int(0.6 * SAMPLE_RATE)

# Embedding cost grows with duration, and a short window separates speakers
# *better* than a long one: measured margins were 0.686 at 1.5s, 0.729 at 2.0s,
# 0.677 on full 6s utterances. Capping also bounds latency however long you talk.
# 1.5s would save ~36ms; 2.0s buys headroom for real voices that sound alike,
# which are far harder to tell apart than the test voices those numbers came from.
EMBED_SAMPLES = int(2.0 * SAMPLE_RATE)

_session = None


def _get_session():
    global _session
    if _session is None:
        options = ort.SessionOptions()
        options.inter_op_num_threads = 1
        options.intra_op_num_threads = 1
        path = hf_hub_download(MODEL_REPO, MODEL_FILE)
        _session = ort.InferenceSession(path, sess_options=options,
                                        providers=["CPUExecutionProvider"])
    return _session


def _fbank(audio_int16):
    """80-dim kaldi filterbank, mean-normalised — what WeSpeaker was trained on."""
    options = knf.FbankOptions()
    options.frame_opts.samp_freq = SAMPLE_RATE
    options.frame_opts.dither = 0.0
    options.frame_opts.snip_edges = True
    options.mel_opts.num_bins = 80
    extractor = knf.OnlineFbank(options)
    # kaldi expects 16-bit sample magnitudes as floats, not [-1, 1].
    extractor.accept_waveform(SAMPLE_RATE, audio_int16.flatten().astype(numpy.float32).tolist())
    extractor.input_finished()
    frames = numpy.stack([extractor.get_frame(i) for i in range(extractor.num_frames_ready)])
    return frames - frames.mean(axis=0, keepdims=True)


def _trim_silence(audio_int16, window=int(0.02 * SAMPLE_RATE)):
    """Strip near-silence from both ends before embedding.

    This matters more than it looks: an utterance arrives with preroll in front
    and the endpointing silence behind it, and that padding drags the embedding
    toward whatever silence encodes. On a short reply like "yeah, okay" the
    padding is a third of the clip and pulled its similarity from 0.60 to 0.39 —
    enough to reject the enrolled speaker outright.
    """
    audio = audio_int16.flatten()
    usable = len(audio) - len(audio) % window
    if not usable:
        return audio
    energy = numpy.abs(audio[:usable].reshape(-1, window)).mean(axis=1)
    loud = numpy.flatnonzero(energy > max(energy.max() * 0.1, 20.0))
    if not len(loud):
        return audio
    return audio[loud[0] * window:(loud[-1] + 1) * window]


def embed(audio_int16):
    """Return a 256-d L2-normalised voice embedding."""
    audio = _trim_silence(audio_int16)[:EMBED_SAMPLES]
    feats = _fbank(audio)[None, :, :].astype(numpy.float32)
    embedding = _get_session().run(None, {"feats": feats})[0][0]
    return embedding / numpy.linalg.norm(embedding)


def load_voiceprint():
    """Load the enrolled voiceprint, or None if enrollment hasn't been run."""
    if not os.path.exists(VOICEPRINT_PATH):
        return None
    return numpy.load(VOICEPRINT_PATH)


def similarity(audio_int16, voiceprint):
    return float(numpy.dot(embed(audio_int16), voiceprint))


def check(audio_int16, voiceprint):
    """Return (accepted, score) for an utterance.

    `score` is None when identity wasn't actually assessed — no voiceprint
    enrolled, or a clip too short to embed reliably — which the caller reports
    differently from a genuine match. Both cases accept, so Wren stays usable
    before enrollment has been run.
    """
    if voiceprint is None or len(audio_int16) < MIN_SAMPLES:
        return True, None
    score = similarity(audio_int16, voiceprint)
    return score >= SIMILARITY_THRESHOLD, score
