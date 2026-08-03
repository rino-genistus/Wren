# DESIGN.md — Wren 3D Brain

Design brief for the 3D brain visualization. Replaces the 2D sagittal `brain.js`
render with a rotatable 3D brain, while preserving everything that made the 2D
version honest and legible.

## What we're building

A rotatable 3D brain at the head of the Mind view. The user can orbit it freely.
Hovering or clicking a region raises a small popup naming the region and describing
what it does (anatomically, and what it maps to in Wren). Regions light up in real
time when their subsystem fires, driven by the same event stream the 2D brain used.

## Invariants — carry these from the 2D brain, do not drop them

1. **The honesty rule is enforced by the drawing, not a caption.** Two regions
   (neocortex, cingulate gyrus) are unbuilt. They must be visibly *present* and
   visibly *empty* — drawn as dashed/hollow wireframe, never lit, using the existing
   `--fainter` treatment. The ratio "nine lit, two dark" is the picture's whole point.
   They are still hoverable; their popup states they are not yet built.
2. **Reuse the event model.** Expose `brain.handle(record)` with the SAME signature as
   the current 2D brain, so `main.js`'s single call site is unchanged. No new record
   kinds, no Python changes. Activity sets a region's `emissiveIntensity` and decays,
   exactly mirroring the current "stage/hold/cool" logic.
3. **Reuse the color tokens.** Map to the existing `breath.css` variables — do not
   invent new colors: `--warm` = accepted/active, `--cool` = idle/rejected,
   `--fail` = error, `--fainter` = unbuilt/dashed.
4. **Interior stays legible.** In 3D, deep regions (hippocampus, thalamus) and the two
   dark regions must remain visible. Use a translucent shell so nothing important hides
   behind cortex.

## Visual direction

**Translucent shell + node accents (hybrid).**
- The cortex is a semi-transparent glass-like mesh, tinted toward `--cool`, so deep
  structures read through the surface.
- Active regions are lit as glowing nodes/volumes, not neon — quiet emissive, restrained.
- Four pathways connect regions; a travelling highlight runs along the active pathway
  during a turn, so a turn reads as one traversal rather than ten independent lamps
  (same intent as the 2D version).
- Palette stays dark, clinical, and sparse. This is an instrument, not sci-fi stock art.
  Keep it consistent with `breath.css`. Avoid busy particle fields and rainbow glow.

## Two highlight channels (keep them visually distinct)

- **Hover (user-driven, transient):** a rim/outline highlight on the region under the
  cursor, plus the popup. Clears on pointer-out.
- **Activity (event-driven):** emissive glow from `handle(record)`. This is independent
  of hover — a region can glow from activity while the user hovers a different one.

## Regions & popup copy

Each region's popup shows its name + this description. Store as data in the atlas
(mirror the existing `brain-atlas.js` "copy as data" pattern).

| Region | Subsystem | Popup description |
|---|---|---|
| Prefrontal cortex | LLM | Planning and reasoning. In Wren: the language model — lit and held while Wren is thinking. |
| Supplementary motor area | Kokoro TTS | Sequences movement. In Wren: speech output — pulses once per spoken chunk, holds across the utterance. |
| Thalamus | the gate | The brain's relay and gate for incoming signals. In Wren: the gate model — warm on accept, cool on reject. |
| Superior temporal | voiceprint | Processes voice identity. In Wren: the voiceprint check — brightness tracks the match score. |
| Auditory cortex | ASR | Receives hearing. In Wren: incoming speech recognition — ripples with input level. |
| Cerebellum | mic loop | Coordination and timing. In Wren: the mic loop and half-duplex guard keeping listening and speaking from colliding. |
| Brainstem | the process | Runs the body beneath awareness. In Wren: the process itself — the daemon staying alive. |
| Hippocampus | the deque | Holds short-term memory. In Wren: the recent-turn deque — four beads from history; empty slots stay drawn. |
| **Neocortex** | *(unbuilt)* | Long-term memory and knowledge. In Wren: **not yet built.** Drawn dashed; never lights. |
| **Cingulate gyrus** | *(unbuilt)* | Emotion, motivation, conflict-monitoring. In Wren: mood and opinions. **Not yet built.** Drawn dashed; never lights. |

## Interaction

- **Rotate:** orbit controls (drag to rotate, scroll to zoom, clamp zoom range). Optional
  slow auto-rotate when idle; stop auto-rotate on user interaction.
- **Hover:** rim-highlight the region + show popup anchored to it (use drei `<Html>` so the
  popup tracks the region in 3D). Popup shows region name + description.
- **Click:** keep the popup pinned and scroll to / flash the matching Mind panel below,
  preserving the current click-to-panel behavior (exactly one panel lit).
- **Unbuilt regions** are hoverable and show their "not yet built" popup, but never light.

## Technical

- **react-three-fiber + drei.** OrbitControls for rotation, `<Html>` for popups,
  raycasting via per-mesh `onPointerOver`/`onPointerOut`/`onClick` (no manual centre
  hit-testing — R3F handles it).
- **Mesh:** a glTF brain with separately-named region meshes. Source: **Z-Anatomy**
  (open, CC-BY-SA, labeled brain substructures) exported to glTF, or BodyParts3D. Region
  mesh names must map to the atlas keys above.
- **Materials:** each region has its own material; activity animates `emissiveIntensity`
  toward a target and decays on the next `spoke`/`history` event, mirroring current decay.
- **Perf:** pause the render loop when the Conversation tab is shown, resume on return
  (same as the current rAF behavior). Keep draw calls low; the shell is one mesh.
- **Parity target:** the five existing fixtures replay through `brain.handle(record)`
  unaltered and light the correct regions. Failed stages stroke `--fail` transiently on
  prefrontal (a bad turn), not permanently on brainstem (process death arrives separately).

## Out of scope (do not build)

- Filling the two empty panels with data. The brain draws the *shape* of what's missing
  and links to those panels; it invents no data.
- New record kinds, Python changes, or a second event pipeline.