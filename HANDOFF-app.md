# Worktree state — UI hardening + the Python seam

Uncommitted on `main`. Companion to `HANDOFF.md`, which covers the audio path
(`tts.py`, `llm.py`, `samples/`, `sweep.py`) and is **not** this work.

Two pieces: failure/control handling in the Electron UI, and the seam connecting
`wren_v1.py` to it. The renderer↔source interface did not change, so every fixture
still replays unaltered.

## New files

| File | What it is |
|---|---|
| `events.py` (200) | Python side of the seam. JSON-per-line out on fd 3, commands in on fd 4. |
| `app/main/python.js` (142) | `PythonSource` — spawns Wren, same interface as `ReplaySource`. |
| `app/renderer/js/failure.js` (84) | One failure panel, shared by boot and transcript. |
| `app/fixtures/boot-fail.jsonl` (30) | Brain dies at t=8.1, `ready` still arrives, a turn dies at t=13.9. |

## Modified

- `wren_v1.py` — load block + mic loop wrapped in `main()`; six `_load_*()` behind a
  `LOADERS` dict with `ESSENTIAL = ("wakeword","vad","asr")` and a `failed_stages` set;
  ~13 `events.emit` calls, each placed beside an existing `print`; `level` at ~10Hz;
  `on_command` for stop/reset/retry/mute; SIGTERM handler.
- `app/main/source.js` — `createSource` returns `PythonSource` when there's no `--replay`;
  `ManualSource` only under `--manual`.
- `app/renderer/js/` — `boot.js` (panels Map; failures render instead of dead-ending),
  `transcript.js` (tracks last `asked`, retry re-sends it), `presence.js` (`failed` Set,
  `setFailed`, no ready-flash on an incomplete lap), `orb.js` (fail head colour,
  `drawMute` slash cut with `destination-out`), `main.js` (`command()`, control listeners, keys).
- `app/renderer/index.html`, `style/breath.css` — `.controls`, `.failures`, and a compact
  ready-phase form so the boot panel stops competing with the conversation.
- `app/package.json` — `start` is now real Wren; added `manual` and `fail`.

Not from this work, present in the worktree: `llm.py`, `tts.py`, `samples/*.wav`,
`.gitignore`, `_orig_wren_probe.py`, `sweep.py`.

---

## Things that will bite you

**Never probe whether fd 3 is open.** The first `events.py` did (`os.fstat(3)` → attached).
Fd 3 is frequently already inherited, and writing JSON into one that belonged to Metal
produced `[metal::Device] Unable to load kernel arangefloat32` — ASR and brain both dead,
with a signature pointing nowhere near the cause. Emission now requires an explicit
`WREN_EVENT_FD` / `WREN_COMMAND_FD` handshake from the parent. Full story in the comment
at the top of `events.py`.

**`python3` is the wrong interpreter for `wren_v1.py`** — missing `kaldi_native_fbank`;
`python3.13` has it. (`HANDOFF.md` names `/opt/miniconda3/bin/python3` for the TTS sweeps —
a third one. They are not interchangeable.) `findPython()` in `python.js` probes candidates
rather than hardcoding; override with `WREN_PYTHON`.

**`tts.stop()` already existed** at `tts.py:612`. The plan called for adding it; no change
was needed, and `tts.py` was not touched.

**⌘⇧M, not ⌘M**, for mute — Electron's default macOS menu owns ⌘M for Minimize and takes
the accelerator before the renderer sees it. Keys are main-window only; the orb is
click-through and never focused, and reaching it needs a global shortcut that would hijack
Esc system-wide.

**A swallowed stage failure must still print.** `_Stage.__exit__` returns `True` so one dead
subsystem doesn't kill the process — which also swallowed the traceback the terminal used to
get. `load()` prints one line per failure to compensate.

**Launch Electron with `env -u ELECTRON_RUN_AS_NODE`** — this shell sets it, which boots
Electron as plain Node.

## Verification that was run

Bare `python3.13 -u wren_v1.py` banner byte-identical to the pre-refactor baseline — this is
the check that caught the fd bug, and it should be step one after any change to `wren_v1.py`.
Full event stream over the real pipes (stages, ready, personality, state, hearing, verdict,
thinking, speaking, 177 `level` records, mute both ways). Commands `stop` / `reset` /
`retry brain` all land; retry re-runs the stage in 0.6s. No orphaned Python after quit
(`pgrep -f wren_v1`). All fixtures replay and spawn no Python.

**Not observed live:** barge-in actually cutting speech mid-reply. The command path is
verified end to end and `tts.stop()` is pre-existing, but nothing was ever interrupted
mid-sentence.

## Deliberately not done

- **Accessibility / reduced-motion pass** — declined by the user. No `aria-live` on the
  transcript, no focus styles; `prefers-reduced-motion` only shortens one transition while
  the orb breathes at full amplitude.
- **The Mind's two empty panels stay empty.** No brain/personality/memory work is in flight;
  the user wants those sections pre-planned, not built. Don't fill them.
