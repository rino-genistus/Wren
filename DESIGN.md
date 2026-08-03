# DESIGN.md — Wren 3D Brain

Design brief and source of truth for the 3D brain visualization at the head of the
Mind view. A rotatable brain that assembles into a recognizable whole and explodes
apart on click, driven by the same event stream as the original 2D brain.

## What we're building

A translucent 3D brain the user can orbit. **Assembled**, it reads as a recognizable
whole brain. **Clicking a region explodes it apart** so every region — including the
deep and the unbuilt ones — becomes individually visible; the user can spin the
exploded form too. Regions light in real time when their subsystem fires, and hovering
any region raises a popup naming it and describing what it does (anatomically, and in
Wren). Lighting, hover, and the honesty treatment all persist in both states.

## Invariants — never drop these

1. **The honesty rule is enforced by the drawing, not a caption.** Two regions
   (neocortex, cingulate gyrus) are unbuilt: drawn dashed/hollow with `--fainter`,
   hoverable (popup says "not yet built"), and they NEVER light — assembled or exploded.
   The ratio "nine lit, two dark" is the picture's whole point, and the exploded view
   must make it *more* legible, not less.
2. **Reuse the event model.** `brain.handle(record)` keeps its exact current signature;
   `main.js`'s single call site is unchanged. No new record kinds, no Python changes.
   Regions light identically whether assembled or exploded — only their position differs.
3. **Reuse the color tokens.** Map to existing `breath.css` variables only — invent no
   new colors: `--warm` accepted/active, `--cool` idle/rejected, `--fail` error,
   `--fainter` unbuilt/dashed.
4. **Interior stays legible.** Deep regions (thalamus, hippocampus) and the two dark
   regions must be visible. Assembled, the translucent shell shows them through; exploded,
   they separate out fully.

## Geometry — shell + interior regions

Two layers, splitting "looks like a brain" from "lightable per region":

- **Outer shell:** one detailed brain-silhouette mesh (glTF at `assets/brain-shell.glb`;
  scaffold a low-poly fallback + TODO so it renders before the real mesh lands). Its only
  job is the recognizable silhouette. Rendered translucent, tinted `--cool`. It is
  **non-interactive** — `raycast={() => null}` so hover/click pass through to the interior
  regions. It never lights and shows no popup. It fades to near-invisible while exploded.
  Source options: NIH 3D (3d.nih.gov, many CC0), Sketchfab (CC filter), or Z-Anatomy
  cortex. Decimate once in Blender to keep it light.
- **Interior regions:** the lightable/hoverable/dashed meshes, positioned inside the
  shell at anatomically-plausible spots (thalamus & hippocampus deep/central, auditory
  & superior temporal lateral, prefrontal forward, cerebellum low-back, brainstem
  descending, SMA upper). They can stay abstract — seen through frosted cortex when
  assembled, and they carry all interaction.

## Interaction — assembled <-> exploded

Two states with a spring/lerp transition (~0.6s), duration a named constant.

- **ASSEMBLED (default):** regions in home positions inside the shell — the whole brain.
  Hover a region -> rim highlight + popup.
- **EXPLODED:** regions animate outward along explode vectors (spaced so each is
  individually visible); shell fades to near-invisible so it doesn't occlude. OrbitControls
  still work — the exploded brain is fully spinnable.

Two-level click drill (resolves the conflict with the existing click-to-panel behavior):

- Click a region **while ASSEMBLED** -> animate to EXPLODED and pin that region's popup.
- Click a region **while EXPLODED** -> scroll to + flash its Mind panel (the original
  click-to-panel behavior, moved one level down; exactly one panel lit).
- Click empty space or press **Escape while EXPLODED** -> animate back to ASSEMBLED;
  shell fades back in.

Explode vectors: default to each region's centroid direction from brain center, scaled
by `EXPLODE_DISTANCE` (named constant). Allow a per-region override in the atlas for deep
regions (thalamus, hippocampus) that need hand-tuning. Animate all regions together.

## Two highlight channels (keep visually distinct, in both states)

- **Hover (user-driven, transient):** rim/outline on the region under the cursor + popup
  (drei `<Html>`, anchored so it tracks the region in 3D). Clears on pointer-out.
- **Activity (event-driven):** emissive glow from `handle(record)`, decays on the next
  `spoke`/`history` event. Independent of hover — a region can glow from activity while
  the user hovers a different one.

## Regions & popup copy

Store as data in the atlas (mirror the `brain-atlas.js` "copy as data" pattern).

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

## Technical

- **react-three-fiber + drei.** OrbitControls for rotation (works in both states);
  `<Html>` for popups; per-mesh `onPointerOver`/`onPointerOut`/`onClick` (no manual
  hit-testing). Shell mesh `raycast={() => null}`.
- **Materials:** each region has its own material; activity animates `emissiveIntensity`
  toward a target and decays, mirroring the current stage/hold/cool logic.
- **Perf:** pause the render loop on the Conversation tab, resume on return. Keep draw
  calls low; the shell is one mesh.
- **Named constants:** `EXPLODE_DISTANCE`, transition duration, and existing tunables.
- **Parity target:** the five existing fixtures replay through `handle(record)` unaltered
  and light the correct regions in BOTH states. Failed stages stroke `--fail` transiently
  on prefrontal (a bad turn), not permanently on brainstem (process death arrives
  separately, via `python.js` exit).

## Later — glass finish (do NOT do until motion is nailed)

The target look is luminous glass with the glow coming from *inside* — not the current
flat grey dome. Deferred on purpose: `transmission` and bloom both cost performance, and
layering them onto an animation still being tuned makes it hard to tell what's slow.
Nail the exploded-view motion first, then do a finish pass:

- Shell uses `MeshPhysicalMaterial` with `transmission` (real glass refraction), low
  roughness, thin-walled — so lit interior regions refract and glow *through* the cortex.
- A restrained bloom post-process pass so activity glow blooms softly rather than just
  tinting. Keep it subtle — this is an instrument, not neon.
- Re-check perf after: transmission + bloom on an animated scene is the expensive combo.

## Out of scope (do not build)

- Filling the two empty Mind panels with data. The brain draws the *shape* of what's
  missing and links to those panels; it invents no data.
- New record kinds, Python changes, or a second event pipeline.