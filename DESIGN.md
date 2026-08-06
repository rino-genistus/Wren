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

- **Outer shell:** one brain-silhouette mesh. Its only job is the recognizable
  silhouette. Rendered translucent, tinted `--cool`. It is **non-interactive** —
  `raycast={() => null}` so hover/click pass through to the interior regions. It never
  lights and shows no popup. It fades to near-invisible while exploded.

  **Built, and not from a glTF.** The plan was to source a mesh (NIH 3D, Sketchfab,
  Z-Anatomy) and decimate it in Blender. What shipped instead is procedural: a sphere
  pushed into shape by `surfaceAt` in `scene.jsx` — tapered frontal pole, flattened
  underside, lateral and longitudinal fissures, and a ridged-noise fold field for the
  gyri, seeded so Wren has the same brain every launch. It is legible as anatomy, it
  costs one pass over the vertices at mount, and it needs no asset pipeline or licence
  audit. A glTF is still the eventual upgrade — the TODO at the head of `atlas.js` is
  the live one, and names `app/renderer/brain/brain.glb` as the path and the CSP
  directive it would need.
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
- Click empty space -> animate back to ASSEMBLED; shell fades back in.

**Escape is not a way out, and that is decided.** This section originally gave
Escape the collapse, which was wrong: Escape already stops Wren speaking, and that
is the most-used control in a voice interface. A key that stops a reply on one tab
and rearranges a drawing on another is a key you cannot trust in either place. So
clicking past every region is the only way back to ASSEMBLED — `onPointerMissed` on
the canvas, which is where a click-past belongs anyway. See the comment on
`onPointerMissed` in `scene.jsx`.

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

## The glass finish — half done

The target look is luminous glass with the glow coming from *inside*. Both halves were
deferred until the motion was nailed, because `transmission` and bloom each cost
performance and layering them onto an animation still being tuned makes it hard to tell
what is slow. The motion is nailed, and one half has landed:

- **Bloom — done.** One `EffectComposer` pass in `scene.jsx`, `luminanceThreshold` set
  above the room *and* above an idle region, so blooming is something activity does
  rather than a haze over everything. It costs a full-screen pass, but only while the
  Mind view is on screen: the render loop is stopped everywhere else. Two things it
  forced, both worth knowing before touching it — the canvas is `alpha: false` and
  clears to `--ink` (bloom over a transparent canvas is a black rectangle), and the
  page behind it has to stay flat `--ink` for that opaque rectangle to be invisible,
  which is why `--sky` in `breath.css` ends its wash inside the presence band.
- **Transmission — still to do.** Shell would use `MeshPhysicalMaterial` with
  `transmission`, low roughness, thin-walled, so lit interior regions refract and glow
  *through* the cortex. Re-check perf after: transmission on top of the bloom pass is
  the expensive combination, and the folded shell is the densest mesh in the scene.

## Out of scope (do not build)

- Filling the two empty Mind panels with data. The brain draws the *shape* of what's
  missing and links to those panels; it invents no data.
- New record kinds, Python changes, or a second event pipeline.