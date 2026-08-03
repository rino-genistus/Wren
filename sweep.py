"""Render a batch of replies and measure how much they sound assembled.

Wren speaks a reply as a small number of separately-synthesised clips. Every join
between two of them is a place where the pitch, the level and the timbre can step,
because Kokoro renders each clip as its own complete utterance and knows nothing
about the one before it. Those steps are what "put together in chunks" means, and
this is what measures them.

Run it and listen to samples/sweep-01/. Each reply is written twice: as Wren
actually spoke it, and — in reference/ — as a single Kokoro utterance of the same
final text. The reference has no joins by construction, so the difference between
the two is exactly the cost of Wren's clipping, and the reference is the ceiling
this pipeline can reach without changing voice or model.

    python3 sweep.py [--dir samples/sweep-01] [--quick]

Playback is stubbed. Rendering twenty replies at realtime would take four minutes
of silence and tell us nothing that the samples don't.
"""

import argparse
import json
import os
import sys
import time
import wave

import numpy

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import llm  # noqa: E402
import tts  # noqa: E402

# (slug, prompt, fresh) — fresh=False keeps the previous turn's history, which is
# how the follow-up pair at the end gets a pronoun to resolve.
PROMPTS = [
    # The eight from the previous round, unchanged, so the old samples/ set stays
    # a valid before-and-after.
    ("01-tallest-mountain", "wat is the tallest mountain in the world.", True),
    ("02-greeting", "hey there, how are you doing today?", True),
    ("03-cooking", "what should I cook for dinner tonight?", True),
    ("04-sky-blue", "why is the sky blue?", True),
    ("05-shops", "what time do the shops usually shut?", True),
    ("06-aeroplanes", "how do aeroplanes stay in the air?", True),
    ("07-weather", "how's the weather?", True),
    # Deliberately un-stripped: checks Wren answers rather than correcting the name.
    ("08-name", "hey ren, what's the capital of Japan?", True),
    # Wider coverage. Long replies are where the joins are, short ones are where
    # the latency is, and both need to be in the set.
    ("09-tides", "explain why the tides happen", True),
    ("10-time-now", "what time is it right now?", True),
    ("11-opinion", "do you think reading fiction is worth the time?", True),
    ("12-continents", "how many continents are there?", True),
    ("13-definition", "what does the word gregarious mean?", True),
    ("14-comparison", "what's the difference between a crocodile and an alligator?", True),
    ("15-proper-noun", "who wrote Wuthering Heights?", True),
    ("16-instruction", "tell me how to boil an egg properly", True),
    ("17-how-are-you", "are you all right?", True),
    ("18-long-question",
     "if I wanted to get better at playing the piano but I only have about twenty "
     "minutes a day to practise, what would you say is the best thing to focus on?",
     True),
    ("19-follow-up-a", "who painted the Mona Lisa?", True),
    ("20-follow-up-b", "and where is it kept?", False),
]

# Two sentences, so the inter-sentence prosody is in shot, rendered as one
# utterance so the A/B is about the voice and not about our joins.
AB_TEXT = ("I can't check that for you. If you tell me roughly where you are, "
           "I can still say what to expect this time of year.")
AB_VOICES = ["bf_emma", "bf_alice", "bf_isabella", "bf_lily",
             "bm_daniel", "bm_fable", "bm_george", "bm_lewis"]
AB_SPEEDS = [0.95, 1.00, 1.05]

# 20ms window, 10ms hop, at Kokoro's 24kHz.
FRAME = 480
HOP = 240
# Frames quieter than this fraction of the clip's peak are silence, and comparing
# two silences tells us nothing about whether a join is audible.
QUIET = 0.02
# Pitch search range for a female/male speaking voice.
F0_LOW, F0_HIGH = 60, 400


# ---------------------------------------------------------------- capture ----

class Capture:
    """Stands in for the output device, keeping everything written to it."""

    def __init__(self):
        self.parts = []

    def write(self, samples):
        self.parts.append(numpy.asarray(samples, dtype=numpy.float32).copy())

    def start(self):
        pass

    def abort(self):
        pass

    def audio(self):
        if not self.parts:
            return numpy.zeros(0, dtype=numpy.float32)
        return numpy.concatenate(self.parts)


def instrument():
    """Record where each clip lands in the output, without touching tts.py.

    A join is at the sample offset the joiner had already written when the next
    clip arrived — the crossfade straddles it. Knowing that offset is what lets
    the metrics look at the join rather than at speech in general.

    A sentence's pause is written in front of the clip that follows it rather
    than behind the one that earned it, so the silence a seam has to be measured
    across is the one still *owed* when this clip turns up, and the join itself
    lands after that silence has been written.
    """
    original = tts._Joiner
    joins = []

    class Recording(original):
        def write(self, speech, pause):
            owed = self.pending
            joins.append({"at": (self.written + int(owed * tts.SAMPLE_RATE))
                                / tts.SAMPLE_RATE,
                          "pause": owed})
            return super().write(speech, pause)

    tts._Joiner = Recording
    return joins


# ---------------------------------------------------------------- metrics ----

def _frames(audio):
    count = 1 + max(0, (len(audio) - FRAME) // HOP)
    window = numpy.hanning(FRAME).astype(numpy.float32)
    return numpy.stack([audio[i * HOP:i * HOP + FRAME] * window
                        for i in range(count)]) if count else numpy.zeros((0, FRAME))


def _spectra(frames):
    return numpy.log(numpy.abs(numpy.fft.rfft(frames, axis=-1)) + 1e-8)


def _rms(audio):
    return float(numpy.sqrt(numpy.mean(numpy.square(audio)))) if len(audio) else 0.0


def _db(value, reference=1.0):
    return 20 * numpy.log10(max(value, 1e-9) / max(reference, 1e-9))


def _f0(audio):
    """Normalised-autocorrelation pitch, or None where the window isn't voiced.

    Normalised rather than raw, because a raw autocorrelation of a decaying vowel
    peaks at the wrong lag. The lowest lag within 90% of the best one is taken
    rather than the best itself — otherwise a strong second harmonic reads as an
    octave jump, and an octave of spurious "pitch step" would be the loudest
    number in this whole report.
    """
    if len(audio) < 2 * tts.SAMPLE_RATE // F0_LOW:
        return None
    audio = audio - audio.mean()
    energy = numpy.square(audio)
    if _rms(audio) < 1e-4:
        return None
    low = tts.SAMPLE_RATE // F0_HIGH
    high = min(tts.SAMPLE_RATE // F0_LOW, len(audio) - low)
    if high <= low:
        return None
    lags = numpy.arange(low, high)
    total = energy.sum()
    scores = numpy.array([
        float(numpy.dot(audio[:len(audio) - lag], audio[lag:])
              / (numpy.sqrt(max(energy[:len(audio) - lag].sum(), 1e-12)
                            * max(energy[lag:].sum(), 1e-12))))
        for lag in lags]) if total > 0 else numpy.zeros(len(lags))
    best = float(scores.max())
    if best < 0.45:
        return None
    lag = int(lags[numpy.flatnonzero(scores >= 0.9 * best)[0]])
    return tts.SAMPLE_RATE / lag


def seam_metrics(audio, at, pause=0.0):
    """How much of a discontinuity the join at `at` seconds is.

    The numbers that matter are the *ratios*: the spectral and level change across
    the join, each divided by the median change across an ordinary frame boundary
    in the same clip. 1.0 means the join is no more of an event than any other
    moment of that speech. The raw dB and semitone figures are there to say how
    big the step is; the ratios are what say whether it is a seam.

    `pause` is the silence we inserted before this clip, which has to be stepped
    back over — measuring the last 20ms "before the join" would otherwise measure
    our own silence and report a 160dB step.
    """
    peak = float(numpy.abs(audio).max()) or 1.0
    index = int(at * tts.SAMPLE_RATE)
    end = index - int(pause * tts.SAMPLE_RATE)

    # Step back past anything quiet to find where speech actually stopped. Some
    # of that is the pause we inserted, but Kokoro also renders its own pauses —
    # a semicolon buys ~150ms at -33dB, which is not silence and survives both
    # trims. Measuring a spectral step from inside one of those says the join is
    # a seam when what it really found is a pause the model meant to be there.
    speech = numpy.flatnonzero(numpy.abs(audio[:end]) > QUIET * peak)
    end = int(speech[-1]) + 1 if len(speech) else end
    gap = (index - end) / tts.SAMPLE_RATE

    before = audio[max(0, end - FRAME):end]
    after = audio[index:index + FRAME]
    if len(before) < FRAME or len(after) < FRAME:
        return None

    window = numpy.hanning(FRAME).astype(numpy.float32)
    across = float(numpy.mean(numpy.abs(
        _spectra(before * window) - _spectra(after * window))))

    # Baseline: the same measurements everywhere else in the clip, skipping
    # silence and skipping the neighbourhood of the join itself.
    spectral, level = [], []
    for start in range(0, len(audio) - 2 * FRAME, HOP):
        if abs(start + FRAME - index) < FRAME or abs(start + FRAME - end) < FRAME:
            continue
        left = audio[start:start + FRAME]
        right = audio[start + FRAME:start + 2 * FRAME]
        if _rms(left) < QUIET * peak or _rms(right) < QUIET * peak:
            continue
        spectral.append(float(numpy.mean(numpy.abs(
            _spectra(left * window) - _spectra(right * window)))))
        level.append(abs(_db(_rms(right), _rms(left))))

    half = FRAME * 2  # 40ms either side, for level and pitch
    level_before = _rms(audio[max(0, end - half):end])
    level_after = _rms(audio[index:index + half])
    step = abs(_db(level_after, level_before))
    pitch_before = _f0(audio[max(0, end - 2 * half):end])
    pitch_after = _f0(audio[index:index + 2 * half])

    return {
        "at": round(at, 3),
        # Silence between the last speech and the join: ours plus whatever Kokoro
        # rendered. A join with a real gap in front of it is a pause, not a seam.
        "gap_ms": round(gap * 1000),
        "spectral_ratio": round(across / float(numpy.median(spectral)), 2)
                          if spectral else None,
        "level_step_db": round(step, 2),
        "level_ratio": round(step / max(float(numpy.median(level)), 0.01), 2)
                       if level else None,
        # Semitones, because that is the unit the ear works in. Within-phrase
        # pitch movement is well under a semitone across 20ms, so anything past
        # about 1 is a reset rather than a contour.
        "pitch_step_semitones": round(abs(12 * numpy.log2(pitch_after / pitch_before)), 2)
                                if pitch_before and pitch_after else None,
        "voiced_both_sides": bool(pitch_before and pitch_after),
    }


def clip_metrics(audio):
    """Whole-clip health: clicks, DC, noise floor, and the longest gap in it."""
    if not len(audio):
        return {}
    steps = numpy.abs(numpy.diff(audio))
    typical = float(numpy.percentile(steps, 99.99)) or 1e-9
    peak = float(numpy.abs(audio).max()) or 1.0

    # Longest run of near-silence, and where it starts. Edges of the quiet mask,
    # rather than a loop, because these clips are a few hundred thousand samples.
    quiet = numpy.abs(audio) < QUIET * peak
    edges = numpy.flatnonzero(numpy.diff(numpy.concatenate(
        ([0], quiet.view(numpy.int8), [0]))))
    starts, ends = edges[::2], edges[1::2]
    longest, where = 0, 0
    if len(starts):
        which = int(numpy.argmax(ends - starts))
        longest, where = int(ends[which] - starts[which]), int(starts[which])

    frames = _frames(audio)
    levels = numpy.sqrt(numpy.mean(numpy.square(frames), axis=-1)) if len(frames) else numpy.zeros(1)

    return {
        "seconds": round(len(audio) / tts.SAMPLE_RATE, 3),
        # Every reply ends with SENTENCE_PAUSE written to the device, so the
        # speech-only length is what compares fairly against a reference render.
        "speech_seconds": round(len(tts._trim(audio)) / tts.SAMPLE_RATE, 3),
        # Trimming cuts at the first sample above the threshold, which is a step
        # from nothing into a live waveform. Above ~3 that step is a click.
        "click_ratio": round(float(steps.max()) / typical, 2),
        "dc_offset": round(float(audio.mean()), 5),
        "noise_floor_db": round(float(_db(numpy.percentile(levels, 10), peak)), 1),
        "longest_gap_s": round(longest / tts.SAMPLE_RATE, 3),
        "longest_gap_at": round(where / tts.SAMPLE_RATE, 3),
        "peak": round(peak, 3),
    }


# ------------------------------------------------------------------ output ----

def save(path, audio):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with wave.open(path, "w") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(tts.SAMPLE_RATE)
        out.writeframes((numpy.clip(audio, -1, 1) * 32767).astype(numpy.int16).tobytes())


def render(text, voice=tts.VOICE, speed=tts.SPEED):
    """One Kokoro call for the whole text — no joins anywhere in it."""
    audio, _ = tts._get_kokoro().create(text, voice=voice, speed=speed, lang=tts.LANG)
    return tts._trim(audio)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dir", default=os.path.join(HERE, "samples", "sweep-01"))
    parser.add_argument("--quick", action="store_true",
                        help="skip the voice and speed A/B renders")
    parser.add_argument("--reanalyse", action="store_true",
                        help="recompute the metrics over the audio already in --dir")
    args = parser.parse_args()

    if args.reanalyse:
        reanalyse(args.dir)
        return

    tts.TAIL_GUARD = 0.0
    capture = Capture()
    tts._get_stream = lambda: capture
    joins = instrument()

    print("warming…", flush=True)
    tts.warm()
    llm.warm()

    rows = []
    for slug, prompt, fresh in PROMPTS:
        if fresh:
            llm.reset()
        capture.parts.clear()
        joins.clear()
        said = []
        first_chunk = []

        def tee(chunks):
            for chunk in chunks:
                if not first_chunk:
                    first_chunk.append(time.monotonic())
                said.append(chunk)
                yield chunk

        started = time.monotonic()
        stats = tts.speak(tee(llm.reply(prompt)))
        wall = (time.monotonic() - started) * 1000

        text = " ".join(said)
        audio = capture.audio()
        reference = render(text) if text else audio

        save(os.path.join(args.dir, f"{slug}.wav"), audio)
        save(os.path.join(args.dir, "reference", f"{slug}.wav"), reference)

        # joins[0] is the start of the first clip, which is not a join. `pause` is
        # what the *previous* clip asked for, so a join carrying SENTENCE_PAUSE is
        # one where we inserted silence rather than letting Kokoro phrase it.
        seams = []
        for previous, join in zip(joins, joins[1:]):
            measured = seam_metrics(audio, join["at"], previous["pause"])
            if measured:
                seams.append(dict(measured, pause=previous["pause"]))

        row = {
            "slug": slug,
            "prompt": prompt,
            "said": text,
            "clips": stats["clips"],
            "first_audio_ms": round(stats["first_audio_ms"] or 0),
            # Time to the first speakable chunk out of the model. Everything
            # after this is ours; everything before it is the 3B's.
            "first_chunk_ms": round((first_chunk[0] - started) * 1000) if first_chunk else None,
            "slack_ms": None if stats["slack_ms"] is None else round(stats["slack_ms"]),
            "synth_ms": round(stats["synth_ms"]),
            # What tts.py's cost model says the synthesis should have taken. Above
            # 1.0 means Kokoro was slower than the model predicts, which is what
            # the opener's cover budget is computed from — so a number much above
            # 1.0 is a starvation waiting to happen.
            "synth_vs_model": round(
                stats["synth_ms"] / 1000
                / max(stats["clips"] * tts.SYNTH_FIXED
                      + tts.SYNTH_PER_SECOND * stats["audio_seconds"], 1e-6), 2),
            "wall_ms": round(wall),
            "seams": seams,
            "audio": clip_metrics(audio),
            "reference": clip_metrics(reference),
        }
        row["synth_hold_ms"] = (None if row["first_chunk_ms"] is None
                                else row["first_audio_ms"] - row["first_chunk_ms"])
        row["excess_s"] = round(row["audio"]["speech_seconds"]
                                - row["reference"]["speech_seconds"], 3)
        rows.append(row)

        worst = max((s["spectral_ratio"] or 0 for s in seams), default=0)
        print(f"\n{slug}  <- {prompt!r}\n  {text}", flush=True)
        print(f"  clips {stats['clips']} | first audio {row['first_audio_ms']}ms "
              f"({row['first_chunk_ms']}ms model + {row['synth_hold_ms']}ms us) | "
              f"slack {row['slack_ms']}ms | spoke {row['audio']['speech_seconds']:.1f}s | "
              f"excess {row['excess_s']:+.2f}s vs reference | worst seam x{worst:.2f}",
              flush=True)

    if not args.quick:
        print("\nrendering the A/B sets…", flush=True)
        for voice in AB_VOICES:
            save(os.path.join(args.dir, "voices", f"{voice}.wav"),
                 render(AB_TEXT, voice=voice))
        for speed in AB_SPEEDS:
            save(os.path.join(args.dir, "speed", f"{speed:.2f}.wav"),
                 render(AB_TEXT, speed=speed))

    summarise(args.dir, rows)


def reanalyse(directory):
    """Recompute the metrics over audio already rendered.

    The measurements have been wrong more than once — reading a level step across
    our own inserted silence, then across one of Kokoro's. Being able to fix the
    metric and re-derive the numbers, rather than re-rolling twenty replies from
    a model that answers differently every time, is what keeps a correction to
    the measurement from looking like a change in the result.
    """
    import soundfile

    with open(os.path.join(directory, "metrics.json")) as source:
        rows = json.load(source)["rows"]
    for row in rows:
        audio, _ = soundfile.read(os.path.join(directory, f"{row['slug']}.wav"),
                                  dtype="float32")
        reference, _ = soundfile.read(
            os.path.join(directory, "reference", f"{row['slug']}.wav"), dtype="float32")
        seams = []
        for seam in row["seams"]:
            measured = seam_metrics(audio, seam["at"], seam["pause"])
            if measured:
                seams.append(dict(measured, pause=seam["pause"]))
        row["seams"] = seams
        row["audio"] = clip_metrics(audio)
        row["reference"] = clip_metrics(reference)
        row["excess_s"] = round(row["audio"]["speech_seconds"]
                                - row["reference"]["speech_seconds"], 3)
    summarise(directory, rows)


def summarise(directory, rows):
    firsts = sorted(row["first_audio_ms"] for row in rows)
    clips = [row["clips"] for row in rows]
    slacks = [row["slack_ms"] for row in rows if row["slack_ms"] is not None]
    excess = sorted(row["excess_s"] for row in rows)
    holds = sorted(row["synth_hold_ms"] for row in rows
                   if row["synth_hold_ms"] is not None)
    ratios = [seam["spectral_ratio"] for row in rows for seam in row["seams"]
              if seam["spectral_ratio"]]
    pitches = [seam["pitch_step_semitones"] for row in rows for seam in row["seams"]
               if seam["pitch_step_semitones"]]
    levels = [seam["level_ratio"] for row in rows for seam in row["seams"]
              if seam["level_ratio"]]

    def spread(values, digits=2):
        return {"median": round(float(numpy.median(values)), digits),
                "max": round(max(values), digits)} if values else None

    summary = {
        "replies": len(rows),
        "first_audio_ms": {"median": firsts[len(firsts) // 2],
                           "min": firsts[0], "max": firsts[-1]},
        # How much of the wait is ours. The rest is the model thinking, which no
        # amount of audio work will shorten.
        "synth_hold_ms": {"median": holds[len(holds) // 2],
                          "min": holds[0], "max": holds[-1]} if holds else None,
        "clips_per_reply": round(sum(clips) / len(clips), 2),
        "seams": len(ratios),
        "seamless_replies": sum(1 for row in rows if not row["seams"]),
        "inserted_pause_seams": sum(1 for row in rows for seam in row["seams"]
                                    if seam["pause"] > 0),
        "worst_slack_ms": min(slacks) if slacks else None,
        "excess_s": {"median": excess[len(excess) // 2],
                     "min": excess[0], "max": excess[-1]},
        "seam_spectral_ratio": spread(ratios),
        "seam_level_ratio": spread(levels),
        "seam_pitch_step_semitones": spread(pitches),
        "synth_vs_model": spread([row["synth_vs_model"] for row in rows
                                  if "synth_vs_model" in row]),
        "worst_click_ratio": round(max(row["audio"]["click_ratio"] for row in rows), 2),
        "worst_dc_offset": round(max(abs(row["audio"]["dc_offset"]) for row in rows), 5),
    }

    with open(os.path.join(directory, "metrics.json"), "w") as out:
        json.dump({"summary": summary, "rows": rows}, out, indent=2)

    lines = ["# Sweep", "",
             "`python3 sweep.py` regenerates everything here.", "",
             "`reference/` is the same final text rendered as one Kokoro utterance —",
             "no joins by construction, so it is the ceiling this pipeline can reach",
             "without changing voice or model. Listen to a pair back to back.", "",
             "## Summary", "", "```", json.dumps(summary, indent=2), "```", "",
             "## Replies", "",
             "| | clips | first audio | model | us | slack | spoke | excess vs ref | worst seam |",
             "|---|---|---|---|---|---|---|---|---|"]
    for row in rows:
        worst = max((seam["spectral_ratio"] or 0 for seam in row["seams"]), default=0)
        lines.append(
            f"| {row['slug']} | {row['clips']} | {row['first_audio_ms']}ms | "
            f"{row['first_chunk_ms']}ms | {row['synth_hold_ms']}ms | "
            f"{row['slack_ms']}ms | {row['audio']['speech_seconds']:.1f}s | "
            f"{row['excess_s']:+.2f}s | {'—' if not worst else f'x{worst:.2f}'} |")
    lines += ["", "## What was said", ""]
    for row in rows:
        lines.append(f"**{row['slug']}** — _{row['prompt']}_  ")
        lines.append(f"{row['said']}")
        lines.append("")
    with open(os.path.join(directory, "README.md"), "w") as out:
        out.write("\n".join(lines) + "\n")

    print(f"\n{'=' * 68}")
    print(json.dumps(summary, indent=2))
    print(f"\nwritten to {directory}")


if __name__ == "__main__":
    main()
