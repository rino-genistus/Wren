"""Record your voice once so Wren can tell you from everyone else.

Run:  python enroll.py
"""

import numpy
import sounddevice as sd

import speaker

SEGMENTS = 5
SEGMENT_DURATION = 4.0

PROMPTS = [
    "the quick brown fox jumps over the lazy dog",
    "what is the weather like this afternoon",
    "remind me to call the dentist tomorrow morning",
    "play something quiet while I finish this",
    "how long does it take to get downtown from here",
]


def record(duration):
    audio = sd.rec(int(duration * speaker.SAMPLE_RATE), samplerate=speaker.SAMPLE_RATE,
                   channels=1, dtype="int16")
    sd.wait()
    return audio


print(f"Enrolling your voice — {SEGMENTS} phrases, {SEGMENT_DURATION:.0f}s each.")
print("Speak normally, at the distance and volume you'd actually use.\n")

embeddings = []
for index in range(SEGMENTS):
    input(f"[{index + 1}/{SEGMENTS}] Press Enter, then say: {PROMPTS[index]!r}\n> ")
    print("    recording...")
    audio = record(SEGMENT_DURATION)
    embeddings.append(speaker.embed(audio))
    print("    done\n")

# Averaging then re-normalising gives a centroid of how you sound across phrases,
# which generalises better than any single recording.
voiceprint = numpy.mean(embeddings, axis=0)
voiceprint /= numpy.linalg.norm(voiceprint)
numpy.save(speaker.VOICEPRINT_PATH, voiceprint)

agreement = [float(numpy.dot(embedding, voiceprint)) for embedding in embeddings]
print(f"Saved to {speaker.VOICEPRINT_PATH}")
print(f"Self-similarity across your samples: min {min(agreement):.2f}, mean "
      f"{sum(agreement) / len(agreement):.2f}")
print(f"Acceptance threshold is {speaker.SIMILARITY_THRESHOLD} "
      f"(speaker.SIMILARITY_THRESHOLD). If your own min sits near it, lower it.")
