# CODE-OVERVIEW.md — what the code is and how it works

A reading guide to the whole repository. `DESIGN.md` is the brief for one feature
(the 3D brain). The two `HANDOFF*.md` files were written as notes on work in
progress and read as though it were still uncommitted — it has all landed, so
treat them as a record of what was tried and rejected, which is the part of them
still worth having. This file is the map of everything that exists.

---

## 1. What Wren is

A local, always-on voice assistant with a desktop presence. You talk, it decides
whether you were talking to *it*, whether you are *you*, transcribes, thinks with
a local LLM, and speaks back — all on-device, no network calls at runtime.

Two halves that can each run without the other:

| Half | Language | Entry point | What it is |
|---|---|---|---|
| **Wren herself** | Python | `wren_v1.py` | The mic loop: hear → gate → transcribe → think → speak. Runs fine standalone in a terminal. |
| **The UI** | Electron + JS | `app/main/index.js` | A window and a floating desktop orb that visualise what Wren is doing. Can run entirely off recorded fixtures with no Python at all. |

They meet at one narrow seam: **`events.py` ⇄ `app/main/python.js`**, a
line-delimited JSON stream over two extra file descriptors. Nothing else crosses.

The organising constraint everywhere is **latency** — a conversation is only a
conversation if replies come back at human turn-taking speed. Most of the odd
decisions in the code (speculative transcription, phoneme-space splitting,
streaming chunks, history capped at 4 turns) are latency, not cleverness.

---

## 2. The end-to-end path of one turn

```
microphone
  │  80ms int16 blocks, 16kHz            sounddevice callback → block_queue
  ▼
Segmenter.push(block)                    wren_v1.py
  │  openWakeWord  → did you say "wren"?
  │  Silero VAD    → is this speech?
  │  buffers the utterance, decides when you've stopped
  ▼  (audio, wake_fired, final)
  ├─ speaker.check(audio, voiceprint)    WeSpeaker ResNet34, on CPU  ─┐ run
  └─ transcribe(asr, audio)              Parakeet MLX, on GPU        ─┘ together
  ▼
gate: wake word fired?  engaged window open?  is_addressed(text)?
  ▼  accepted
handle(text) → responder thread (mic loop keeps listening)
  ▼
llm.reply(text)      streams speakable chunks from Llama-3.2-3B via MLX
  ▼
tts.speak(chunks)    Kokoro-82M via onnxruntime, synth thread ahead of playback
  ▼
speakers             (mic loop discards its own audio while tts.speaking is True)
```

Every arrow above also emits a JSON record on fd 3 if a UI is attached, which is
what drives the orb, transcript, telemetry and brain.

### The three latency tricks worth knowing

1. **Speculative transcription** (`Segmenter.push`) — after only 160ms of
   silence, the utterance is transcribed *provisionally* while the rest of the
   silence window elapses. If you resume speaking, the guess is "recanted" and
   thrown away. So on a normal turn the transcript is already in hand the moment
   you actually stop.
2. **Turn-end projection** (`sounds_finished`, `TRAILING_WORDS`) — once the
   speculative transcript exists, the endpoint timeout is chosen from the
   *grammar*: 0.32s if the sentence sounds complete, 0.7s if it ends on "and",
   "the", "tallest" (you're mid-thought), 0.4s if unknown. Asymmetric on purpose
   — being impatient means interrupting you.
3. **Streaming, chunked speech** (`llm.reply` + `tts.speak`) — the LLM yields the
   first speakable chunk as soon as one sentence (or, on a slow opener, one
   clause) is complete, and TTS may split *that* sentence once more in phoneme
   space, so audio starts while the rest is still generating.

---

## 3. Python — Wren herself

### `wren_v1.py` (843 lines) — the mic loop and everything around it

The only file with a `main()`. Structure, top to bottom:

- **Constants with reasons.** Nearly every tunable has a comment recording the
  measurement behind it. `SILENCE_COMPLETE/TRAILING/UNKNOWN`, `WAKE_LOOKBACK`,
  `FOLLOW_UP_WINDOW = 20s`, `MIN_GATE_WORDS = 3`.
- **`Segmenter`** — consumes every 80ms block. Runs both the wake-word model and
  the VAD on all audio (they cost ~2.4ms/block combined), keeps 0.3s of preroll
  so the start of a word isn't clipped, and emits an utterance twice: once
  speculatively, once finally.
- **`transcribe()`** — pads audio up to a whole second so MLX reuses its compiled
  graph across utterances instead of recompiling per novel input shape.
- **`sounds_finished()` / `TRAILING_WORDS`** — the turn-end projector.
- **`strip_wake_word()` / `WAKE_PREFIX{,_GLUED}`** — removes a leading "wren"
  (the ASR writes it as "Ren"). The `glued` variant, allowed only when the wake
  detector actually fired, cuts inside a word to handle "Renwat is the tallest".
- **`is_addressed()`** — the idle-state gate. Conservative: name-prefix, or ≥3
  words that aren't all acknowledgements and either end in "?" or start with a
  request opener. Verdicts append to `decisions.jsonl` for later tuning.
- **`respond()` / `narrate()` / `handle()`** — the responder thread. `handle()`
  must never block: the mic thread is already spending ~120ms per utterance.
  `narrate()` prints/emits whole *sentences* as the model completes them, so text
  leads the audio.
- **Loading (`LOADERS`, `load()`, `announce()`)** — six stages: `wakeword`, `vad`,
  `asr`, `voiceprint`, `warm`, `brain`. Each is individually re-runnable (that's
  what makes "Try again" in the UI meaningful), and a stage that raises is
  reported and survived — `ESSENTIAL = (wakeword, vad, asr)` is the subset
  without which there is no listening at all.
- **`on_command()` / `run_retries()`** — stop / reset / retry (mute is handled in
  `events.py`). Stop and reset run on the command-reader thread, because a
  barge-in that waits for the next 80ms block is one you can hear being late. A
  stage retry does not: it goes on the `retries` queue and the **main thread**
  drains it between blocks, because MLX binds a model to whichever thread loaded
  it, and `asr` is the model the mic loop transcribes with.
- **`main()`** — the loop: mute check, half-duplex check (`tts.speaking`),
  engagement expiry, ~10Hz level emission, segmenter push, gate, dispatch.

### `llm.py` (364) — the brain

Local Llama-3.2-3B-Instruct-4bit through MLX in-process (Ollama is a supported
fallback backend at ~3.4x slower per token). What it really is: a *chunker*.

- `SYSTEM_PROMPT` is load-bearing — output goes straight to a speech synthesiser,
  so markdown, lists and performed personality are banned explicitly. Comments
  record which observed failure each sentence of the prompt answers.
- `reply()` streams tokens into a buffer and cuts at `SENTENCE_END`; on the first
  chunk only, a `CLAUSE_END` is accepted after a 0.25s grace so a long opening
  sentence doesn't hold back the first audio.
- Three limits, all cutting at natural pauses: `MAX_SENTENCES = 2`,
  `MAX_REPLY_CHARS = 140`, `MAX_TOKENS = 80` (a backstop).
- `budgeted()` / `_closed()` — when the budget runs out mid-sentence, cut at a
  clause and close it with a full stop rather than leaving the reply hanging.
- `history` is a 4-turn deque — every prompt token is ~1.33ms of prefill.

### `tts.py` (540) — the voice

Kokoro-82M on onnxruntime (fp32; fp16 diverges audibly, int8 is slower). The core
problem it solves: a reply is several separately-synthesised clips, and Kokoro
renders each as a *complete utterance* — slowing into its end, resetting at the
start of the next — so every join is a place Wren sounds assembled rather than
spoken. The whole file is about making few joins and hiding the ones that remain.

- `_phonemise()` + `_opening_cut()` — the reply's first sentence may be split once
  to start audio sooner, and that cut is made **in phoneme space** so neither side
  changes pronunciation. The cut point must be far enough in that its playback
  covers synthesis of the remainder (`SYNTH_FIXED`, `SYNTH_PER_SECOND`), prefers a
  comma, and refuses to strand a short function word (`MIN_PHONEME_WORD`).
  Sentences under `MIN_SPLIT_SECONDS = 2.8` are never split — the seam costs more
  than the latency saves.
- `_trim()` — strips Kokoro's own ~54ms lead / ~147ms tail padding, which
  otherwise put ~200ms of dead air at every join.
- `_Joiner` — writes clips to one long-lived output stream as a continuous
  waveform, holding back `CROSSFADE = 8ms` for an equal-power crossfade. Pauses
  are **deferred**: a sentence's pause is written in front of the clip that
  follows it, so the reply's final pause is simply never written (that was 0.25s
  of dead air before the mic reopened, every turn).
- `speak()` — synthesis runs on its own thread ahead of playback, returns
  `first_audio_ms`, `synth_ms`, `audio_seconds`, `clips`, `slack_ms`, `filler`.
  `slack_ms` is the margin by which the stream avoided running dry.
- Fillers ("Hmm.", "Well,") are built and pre-rendered but **disabled**
  (`FILLER_AFTER = None`) — an unpredictable thinking noise read as hesitation.
- `speaking` is the half-duplex flag the mic loop reads; `stop()` exists for
  barge-in.

The long `CROSSFADE` comment records a rejected 60ms experiment and *why the
metric was the trap* — spectral discontinuity rewards smearing two signals
together, so any future attempt needs a second metric measuring overlap where
both clips are audible.

### `speaker.py` (114) — is it you?

WeSpeaker ResNet34 ONNX embedder → 256-d L2-normalised vector, cosine against the
enrolled `voiceprint.npy`, threshold 0.5. Notable: `_trim_silence()` before
embedding (padding dragged "yeah, okay" from 0.60 to 0.39 and rejected the
enrolled speaker), and a 2.0s embedding cap that both bounds latency and
*separates speakers better* than a longer window. Returns `(accepted, score)` with
`score=None` meaning identity wasn't assessed — both cases accept, so Wren is
usable before enrollment.

### `enroll.py` (52) — run once

Records 5×4s prompts, averages the embeddings, re-normalises, writes
`voiceprint.npy`, and prints your own self-similarity so you can sanity-check the
threshold.

### `events.py` (200) — the seam

Events out on `WREN_EVENT_FD`, commands in on `WREN_COMMAND_FD`. Not stdout —
Wren's terminal output is for a person and full of ANSI colour.

**The rule the file exists to enforce:** never go looking for an open descriptor.
An earlier version checked whether fd 3 happened to be open and used it; fd 3 is
inherited far more often than you'd think, Wren wrote JSON into a handle owned by
Metal, and the GPU stopped loading kernels. A descriptor is only ours if the
parent names it in the environment.

With the variables unset — i.e. every time you run `python wren_v1.py` yourself —
every function here is a no-op. That property is what the whole instrumentation
rests on.

Also holds `_Stage` (the `with events.loading(name)` bracket that reports and
swallows a stage failure, exposing `.ok`) and `Commands` (the reader thread; mute
is a flag, everything else goes to the registered handler).

### `sweep.py` (536) — the benchmark harness

Renders 20 replies, writes each **twice**: as Wren actually spoke it, and as a
single Kokoro utterance of the same final text in `reference/`. The reference has
no joins by construction, so the difference is exactly the cost of the clipping.

Stubs `tts._get_stream` with a `Capture` object and sets `TAIL_GUARD = 0` —
otherwise realtime playback makes a sweep look like a hang. Measures per-seam
level step, spectral ratio, F0 continuity; per-clip speech duration; and
`excess_s` against the reference. `--reanalyse` recomputes metrics over existing
audio. Also renders A/B sets across 8 voices and 3 speeds.

---

## 4. The Electron app

```
app/
  main/      Node side: windows, the orb window, and the source of events
  preload/   The only bridge — a fixed, tiny API on window.wren
  renderer/  Two surfaces (main window, desktop orb) sharing orb.js + presence.js
  fixtures/  Recorded/authored sessions as .jsonl, for running with no Python
```

### `main/` — the Node side

- **`index.js`** — creates both windows, creates the source, and rebroadcasts
  every record to every window. Keeps a **journal** of up to 2000 records: the
  main window can be closed and reopened at will (Wren keeps running behind the
  orb), so on reopen it replays what it missed.
- **`source.js`** — `createSource(argv)` returns one of three objects with the
  same interface (`.on('event')`, `.send(command)`, `.stop()`): `ReplaySource`
  (a `.jsonl` fixture, replayed on its own `t` timestamps), `ManualSource`
  (`--manual`, driven entirely by the dev overlay), or `PythonSource` (the
  default — real Wren). The renderer cannot tell which is attached.
- **`python.js`** — spawns `wren_v1.py` with `stdio: [ignore, pipe, pipe, pipe,
  pipe]`, naming fds 3 and 4 in the environment. `findPython()` probes candidate
  interpreters by asking each to `import kaldi_native_fbank`, because Wren's deps
  live under one specific Python and it is not necessarily `python3`. Never
  respawns on crash — a crash loop hidden behind a working-looking orb is worse
  than a window that says what happened.
- **`windows.js`** — the main window. Closing it *hides* it; only an explicit
  quit ends the process. Remembers bounds via `store.js`.
- **`orb-window.js`** — the desktop presence: a 400×180 transparent,
  always-on-top, click-through window. Three deliberate mechanisms: hit-testing
  (the renderer reports whether the pointer is genuinely over the circle),
  manual dragging (`-webkit-app-region: drag` stutters on transparent windows),
  and a fixed size (replies are capped at 140 chars upstream, so the caption
  always fits and the orb never moves under your cursor). Snaps to the nearest
  screen edge with a 220ms glide; right-click opens a small menu.
- **`store.js`** — one JSON file of window placement. Deliberately not a dependency.
- **`platform.js`** — every macOS/Windows/Linux difference, in one file.

### `preload/index.js` — the entire bridge

`window.wren` exposes: `surface` ('main' | 'orb'), `edge`, `onEvent`, `onEdge`,
`journal()`, `command()`, an `orb.*` group (passthrough/drag/activate/menu) and
`dev.inject`. No `require`, no node globals, no fs. The renderers run under a
strict CSP (`default-src 'none'`).

### `renderer/js/` — the main window

- **`main.js`** — wiring. Builds orb, boot, transcript, mind, brain, telemetry,
  presence; routes every record; owns the two view tabs, the Stop/Mute buttons,
  Esc and ⌘⇧M (⌘M is taken by Electron's Minimize), and the journal catch-up.
- **`orb.js` (523)** — *the* piece of visual code, used verbatim by both surfaces
  at different radii. One canvas, six state profiles (`loading`, `idle`,
  `engaged`, `hearing`, `thinking`, `speaking`) each defining scale/glow/breath
  period/depth. Nothing cuts: state changes move *targets* and every drawn value
  chases its target on a frame-rate-independent exponential approach, which is
  the whole reason it reads as alive. Draws a bloom, a body gradient with a
  deliberate mass stop, a specular highlight, inward ripples for hearing,
  outward waves for speaking, and one ring that serves two jobs in sequence —
  the boot sweep (advances only on genuinely-completed stages; the head shimmers
  for the indeterminate part, slows when stalled, stops and goes red on failure)
  and then the depleting engagement window. Hard rule: every effect must reach
  zero *inside* the canvas, or the transparent desktop window shows a faint
  rectangle.
- **`presence.js`** — the event stream reduced to orb state, shared by both
  surfaces so they can never disagree. Owns `STAGES` (the six loaders paired with
  the capability each buys: ears, attention, words, you, voice, mind) and the
  6s stall detector.
- **`boot.js`** — the startup words and the failure panels; flips the layout from
  loading screen to conversation on `ready`.
- **`transcript.js`** — one list, no bubbles. A turn opens on `verdict.accepted`
  and fills in as Wren answers. Commits Wren's words a **sentence** at a time
  (the chunks upstream are cut for latency and would render as fragments), then
  replaces everything with the authoritative `spoke.sentences`.
- **`failure.js`** — one panel shape shared by boot failures, reply failures and
  process death. Encodes what each subsystem failing *costs you* in Wren's own
  voice, plus one action that might fix it. The rule: never state a failure
  without stating what to do about it.
- **`telemetry.js`** — a folded drawer of numbers that already exist upstream
  (first audio, synth, spoke, endpoint, voice score, verdict, filler,
  speculative). Nothing is invented here. Toggle with `t`.
- **`mind.js`** — four panels. Two are real (the system prompt with the measured
  reason for each lever; the 4-turn deque actually in front of the model). Two are
  deliberately **empty** — long-term memory and feelings — describing the shape
  and constraints of what would go there. Building something to fill a panel
  would be adding behaviour to Wren in order to have something to draw.
- **`dev.js`** — ⌥⌘D overlay that injects single records through main, so both
  surfaces react. Exists because tuning a 4s breath cycle against a scripted
  replay means re-running the replay for every tweak.
- **`orb-app.js`** — the desktop orb's renderer: caption bubble, hit-testing,
  drag threshold, context menu.
- **`brain.js` / `brain.js.map`** — build output. Do not edit; `npm run build`
  regenerates it from `renderer/brain/` with esbuild.

### `renderer/brain/` — the 3D brain (react-three-fiber)

Heads the Mind view. A translucent brain you can orbit; click a region and it
**explodes apart**, click again and it opens that region's Mind panel, click past
it and it reassembles.

The point of the picture is honesty: **eight regions are wired to something real
and light when it fires; two are dashed and never light**, because there is no
long-term memory and no mood behind them. The ratio is the message, and it is
drawn rather than captioned.

| File | What it is |
|---|---|
| `atlas.js` | Geometry, anatomy and popup copy **as data**. Plain numbers and strings — no three, no react — so it can be read in Node. Defines the shell, ten regions (position, shape primitive, which loader stages light it, which panel it links to, its explode vector), four pathways, camera. |
| `life.js` | The event stream reduced to **one number per region**. Plain JS, no three/react/DOM — which is what makes the fixture parity test possible. `hold` (a level a state sets and its counterpart clears) vs `impulse` (a discrete event that decays); rise fast, fall slow. This is the entirety of what `handle(record)` does. |
| `view.js` | Assembled ↔ exploded: `EXPLODE_DISTANCE`, `EXPLODE_SECONDS`, `EXPLODE_SCALE`, per-region `explodeOffset()`, and a derived `EXPLODE_SHIFT` that re-centres the composition so retuning a vector can't quietly knock it askew. |
| `look.js` | Reads the seven design tokens off the stylesheet. No colour literals except survival fallbacks. |
| `scene.jsx` (969) | The render. Sculpts the cortex with simplex-noise folds rather than assembling lobes out of spheres; builds each region as a blob/arc/stalk/patch; two deliberately-unlike highlight channels (emissive **activity** from the event stream, rim shell + popup for **hover**); travelling highlights along the pathways; hippocampus beads for the deque; one bloom pass thresholded above idle. |
| `index.jsx` | The seam. Exposes the same plain `{handle, setVisible, destroy}` object the old 2D brain did, so `main.js`'s call site never changed and React stays an implementation detail of one panel. `handle()` never touches React state — records arrive at conversational rates and go straight into `life`; React re-renders only for hover, click and tab switch. |
| `fixtures.test.js` | **The parity check.** Replays all five fixtures through `life.js` in plain Node and asserts which regions light, plus layout assertions against the camera. `npm run fixtures`. |

The render loop is stopped whenever the Mind view isn't on screen — a second
always-on GPU loop competing with MLX is latency spent on a picture nobody is
looking at.

### `renderer/style/`

`tokens.css` is the design system ("Dusk"): a mid-tone slate-indigo room, one
lavender orb, type as the interface. Neutrals are derived in OKLCH on the orb's
own hue so the room belongs to the same colour as the light in it. `breath.css`
(916) is the main window's layout, `orb.css` the desktop orb's, `fonts.css` the
two self-hosted families.

---

## 5. The event protocol

One JSON object per line, `{"t": seconds_since_start, "kind": ..., ...}`.

**Wren → UI**

| kind | Fields | Meaning |
|---|---|---|
| `stage` | `name`, `status` (start/done/error), `message?`, `note?` | A subsystem loading. Drives the boot ring. |
| `ready` | wakeword, threshold, voiceprint, model, brain_status, voice, `failed[]` | Boot finished (possibly with casualties). |
| `personality` | prompt, temperature, max_sentences, max_reply_chars, history_turns | Feeds the Mind's personality panel. |
| `state` | `engaged`, `ends_in`, `muted` | Listening state. No terminal output — mute changes state without changing what the terminal has to say. |
| `hearing` | `on` | Speech onset/offset. |
| `level` | `rms` | ~10Hz mic level. The one signal with no print behind it. |
| `wake` | — | The wake word fired. An instant, not a state. |
| `verdict` | accepted, reason, score, text, ms, speculated | What Wren heard and what it did about it. |
| `thinking` | `text` | Accepted; generating. |
| `filler` | `text` | A gap-covering "Hmm." was actually spoken. |
| `speaking` | `chunk` | A completed sentence, emitted as generated (leads the audio). |
| `spoke` | `sentences[]`, first_audio_ms, synth_ms, audio_seconds, filler | The authoritative reply, regrouped. |
| `history` | `messages[]` | The 4-turn deque after this turn. |
| `error` | `message` | A reply threw. The mic loop survived. |

**UI → Wren:** `{kind: "mute", on?}`, `{kind: "stop"}`, `{kind: "reset"}`,
`{kind: "retry", stage}` or `{kind: "retry", text}`.

Fixtures in `app/fixtures/` are files of exactly these records with `t`
timestamps — hand-authored and recorded ones are indistinguishable by design.
`boot`, `boot-stall`, `boot-fail`, `session`, `edge-cases`.

---

## 6. Running it

```bash
# Wren alone, in a terminal (no UI, events are no-ops)
python3.13 wren_v1.py          # NB: needs the interpreter that has kaldi_native_fbank

# Enroll your voice, once
python3.13 enroll.py

# The app, driving real Wren
cd app && npm start            # runs `npm run build` first (esbuild → renderer/js/brain.js)

# The app on recorded data — no Python spawned at all
npm run boot | stall | fail | session | edges
npm run manual                 # dev overlay drives everything (⌥⌘D)

# The brain's parity test, plain Node
npm run fixtures

# TTS benchmark sweep (playback stubbed)
/opt/miniconda3/bin/python3 -u sweep.py [--quick] [--reanalyse]
```

**Interpreters are not interchangeable.** `wren_v1.py` needs the one with
`kaldi_native_fbank` (`python3.13` on the build machine); `sweep.py` needs the one
with `kokoro_onnx` (`/opt/miniconda3/bin/python3`). `findPython()` probes rather
than hardcodes; override with `WREN_PYTHON`. Launch Electron with
`env -u ELECTRON_RUN_AS_NODE` if your shell sets it.

**Models on disk:** `models/kokoro-v1.0.onnx` + `voices-v1.0.bin` (fetched once,
~340MB — `tts._paths()` prints the curl commands). The wake word
(`models/wren.onnx`), Parakeet ASR, WeSpeaker embedder and Llama weights come
from HuggingFace caches.

---

## 7. Other files

| Path | What |
|---|---|
| `DESIGN.md` | The brief for the 3D brain — invariants, geometry, interaction, region copy, and what is deliberately deferred. |
| `HANDOFF.md` | Uncommitted audio-path work: the deferred pause, the reply budget, and a **reverted** crossfade experiment with the numbers explaining why. |
| `HANDOFF-app.md` | Uncommitted UI + seam work, and "things that will bite you" (the fd 3 story, interpreter mismatch, ⌘⇧M). |
| `decisions.jsonl` | Every idle-state gate verdict, appended live. Training/tuning data for `is_addressed()`. |
| `samples/` | Rendered replies. `sweep-00-baseline/` and `sweep-01/` each hold 20 replies + `reference/` (join-free renders) + `metrics.json` + voice/speed A/Bs. |
| `voiceprint.npy` | Your enrolled 256-d embedding. |
| `brain-inspo/` | Reference images for the 3D brain. |
| `__pycache__/` | Build artefact. |

---

## 8. How to read this codebase

The comments are the documentation, and they are unusually load-bearing — most
constants carry the measurement that produced them and most functions carry the
bug they exist to prevent. If a value looks arbitrary, the comment above it
probably says which experiment set it. Four that repay reading in full:

- `tts.py` — the `CROSSFADE` block (why a good-looking metric was the trap)
- `events.py` — the module docstring (why probing fd 3 broke the GPU)
- `wren_v1.py` — `TRAILING_WORDS` and `strip_wake_word` (why each is conservative)
- `renderer/brain/scene.jsx` — the header (why two highlight channels, and why
  two dark regions)

Three invariants worth not breaking:

1. **Instrumentation must not change behaviour.** With the fd env vars unset,
   everything in `events.py` is a no-op, and `python wren_v1.py` behaves exactly
   as it always has. The check is that the bare terminal banner stays
   byte-identical to the pre-instrumentation baseline. That baseline is
   `git show 982a422:wren_v1.py` — verified byte-identical to the frozen
   `_orig_wren_probe.py` copy that used to sit in the tree, which is why the copy
   was dropped and git pointed at instead.
2. **The renderer↔source interface is fixed.** Fixtures, manual mode and real
   Wren are interchangeable, and `brain.handle(record)` keeps its signature —
   which is what lets `fixtures.test.js` be a real regression test.
3. **The two dark brain regions stay dark, and the two empty Mind panels stay
   empty,** until something real is behind them.
