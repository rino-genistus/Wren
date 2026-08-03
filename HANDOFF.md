# Worktree state — audio path

Uncommitted changes to the voice pipeline, and what was tried and rejected.
The `app/**` + `wren_v1.py` + `events.py` changes are a separate piece of work,
written up in `HANDOFF-app.md`.

## Mine (this round)

| File | Change |
|---|---|
| `tts.py` | Deferred pause in `_Joiner`; `CROSSFADE` comment records a rejected experiment |
| `llm.py` | `_closed`/`budgeted` — reply budget no longer truncates mid-clause |
| `sweep.py` | New, untracked. Regenerates `samples/sweep-01/` + `metrics.json` |
| `.gitignore` | Ignores `samples/sweep-*/` |
| `samples/*.wav` | Re-rendered with current code |

Not mine, do not touch: `app/**`, `wren_v1.py`, `events.py`, `_orig_wren_probe.py`.

## 1. Deferred pause (`tts.py`, `_Joiner`)

A sentence's pause is now written **in front of the clip that follows it**, not
behind the clip that earned it. `_Joiner.pending` holds it; `flush()` drops it.

Why: a reply's last chunk ends a sentence, so the pause was appended after Wren's
final word and `speak()` sat through it — 0.25s of dead air before the mic
reopened, every turn, on top of `TAIL_GUARD`.

Measured over 20 replies: excess duration vs a whole-utterance render went
**+0.22s median → 0.00s**; single-clip replies now measure exactly +0.00.
Mid-reply pauses verified intact.

`sweep.py`'s `instrument()` depends on this ordering — it reads `self.pending` to
place the seam. Change one, change the other.

## 2. Reply budget (`llm.py`)

`budgeted()` truncates at a clause and closes it rather than dropping the tail,
which used to leave replies hanging: `"...alligators have a wider,"` then silence.
Applied at **both** call sites — the in-loop one and the tail flush.

`_closed()` edge cases, all previously live bugs:
- `room` can be negative (the opening chunk is exempt from the budget). Negative
  `end` makes `str.rfind` search from the *end* of the string and return nearly
  the whole chunk. Clamped via `MIN_CLOSE_CHARS = 40`.
- A cut landing on an existing full stop produced `"...possibly fit.."`.

## 3. REVERTED — do not re-apply without a new metric

`tts.py` was reverted to HEAD after a user report of *"worse, more delays, plays
duplicates"*. The reverted work: `CROSSFADE` 8ms → 60ms, a `_fade_trim` that cut
Kokoro's utterance-edge fade before overlapping, `SENTENCE_PAUSE` 0.25 → 0.35,
and tail-coalescing.

Trimming the fades guarantees **both sides of the overlap are live speech**, so a
60ms join is two phonemes sounding at once — heard as a slurred/doubled word.

| overlap | level step | spectral | speech mixed | length vs whole |
|---|---|---|---|---|
| 8ms (current) | 24.2dB | 1.65x | ~2ms | −0.087s |
| 60ms | 3.3dB | 1.20x | ~11ms | −0.182s |

**The metric was the trap.** "Spectral discontinuity" measures whether a join is
abrupt; smearing two signals is maximally un-abrupt, so it scores better the more
you smear. Anything tried here needs a *second* metric — how much of the overlap
has both clips audible at once — plus length against a whole render to catch
deleted speech. Full note in the `CROSSFADE` comment in `tts.py`.

Also rejected earlier, with numbers, in the `_opening_cut` comment: voiceless cut
points (moved 2 of 9 cuts, changed nothing).

## Known-open, not regressions

- **`14-comparison` starves at −158ms slack** on long two-sentence replies.
  Pre-existing (baseline −175ms). The reverted tail-coalescing did fix it to
  +297ms and is separable if someone wants it back on its own merits.
- **~6-semitone pitch reset at every opening split** — 155–165Hz falling before
  the cut, 215–220Hz flat after, for the whole second clip. Crossfading cannot
  fix a pitch step. Only complete fix is not splitting: ~+820ms first-audio on
  the ~45% of replies that split. `MIN_SPLIT_SECONDS` is the dial.
- Tail-coalescing is a **no-op today** regardless: `MAX_SENTENCES = 2` means a
  reply is opening + one sentence, so there is never a second tail to coalesce.

## Benchmarking

- Stub `tts._get_stream` and set `TAIL_GUARD = 0`, or realtime playback makes a
  sweep look like a hang.
- **Stub with a stream that blocks like a device.** An instant-return stub hides
  back-pressure, which is what the cover check reasons about — that gap is part
  of why the crossfade regression got through.
- Interpreter: `/opt/miniconda3/bin/python3` (default `python3` lacks
  `kokoro_onnx`). Use `-u` when redirecting.
- Absolute first-audio numbers move ±300ms with machine load between runs. Only
  paired, same-content comparisons are trustworthy.
- `python3 sweep.py` regenerates everything; `--reanalyse` recomputes metrics
  over existing audio without re-synthesising.

## Current state

`py_compile` clean. Budget properties 5/5, phoneme-slice property 7/7. First
audio median ~1250ms. Slack positive on 19/20. Not committed.
