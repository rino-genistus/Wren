// The atlas.
//
// Geometry and copy as data, in a fixed brain-space that scene.jsx builds meshes
// from. Nothing here imports three or react: this file is plain numbers and
// strings so the anatomy can be nudged without touching the render, the copy
// sits next to the thing it describes, and the whole atlas can be read in Node.
//
// Brain-space, right-handed, roughly two units nose to occiput:
//
//   +X  anterior — the front of the head, where the prefrontal pole is
//   +Y  superior — up
//   +Z  right    — lateral, so ±Z is the pair of hemispheres
//
// Regions marked `mirror` exist on both sides and are drawn twice from one
// material, so hovering either copy hovers the region. Everything else is
// midline or spans it.

// ── Placeholder geometry ──────────────────────────────────────────────────────
//
// TODO — swap in the real mesh. These are primitives standing in for a glTF
// brain with separately-named region meshes (Z-Anatomy, CC-BY-SA, exported to
// glTF; BodyParts3D is the other candidate). Drop the file at
// `app/renderer/brain/brain.glb`, name each substructure mesh with the `key`
// below, and scene.jsx will prefer the glTF node over the primitive. Positions
// here are already anatomical, so the wiring is testable before the mesh lands
// and does not change when it does.
//
// Loading it will also need `connect-src 'self'` added to the CSP in
// index.html — GLTFLoader fetches, and `default-src 'none'` currently forbids
// that. The directive is left out until something actually needs it.
//
//   blob  — an ellipsoid: radii [x, y, z]
//   arc   — a partial torus: ring radius, tube radius, sweep in radians
//   stalk — a tapered cylinder

// One merged mesh. The cerebrum carries its own fissures and gyri — scene.jsx
// sculpts them rather than assembling lobes out of spheres — with the cerebellum
// tucked under the back of it and the stem descending between.
export const SHELL = {
  parts: [
    { at: [0, 0.04, 0], radii: [1.02, 0.72, 0.7], shape: 'cerebrum' },
    { at: [-0.68, -0.46, 0], radii: [0.4, 0.24, 0.46], shape: 'cerebellum' },
  ],
  stem: { at: [-0.2, -0.62, 0], top: 0.14, bottom: 0.09, height: 0.6, tilt: 0.22 },
}

// ── Regions ───────────────────────────────────────────────────────────────────
//
// Ordered deep-and-small first. The raycast filter in scene.jsx resolves ties by
// this order, so the hippocampus wins over the mantle it sits inside — the same
// rule the 2D brain used, carried over so the deep structures stay reachable.
//
//   live    — is there anything behind it? A dormant region is drawn dashed and
//             never lights, which is the whole honesty mechanism.
//   stages  — loaders that light it during boot (wren_v1.py's LOADERS).
//   panel   — which Mind panel a click scrolls to, or null.
//   what    — the popup body. Anatomy first, then what it is in Wren.

export const REGIONS = [
  {
    key: 'thalamus',
    title: 'Thalamus',
    what: 'The brain’s relay and gate for incoming signals. In Wren: the gate — warm on accept, cool on reject.',
    live: true,
    stages: [],
    panel: null,
    at: [-0.02, 0.02, 0],
    shape: { kind: 'blob', radii: [0.2, 0.145, 0.2] },
  },
  {
    key: 'hippocampus',
    title: 'Hippocampus',
    what: 'Holds short-term memory. In Wren: the recent-turn deque — four beads from history; empty slots stay drawn.',
    live: true,
    stages: [],
    panel: 'working',
    at: [-0.08, -0.26, 0.36],
    turn: [Math.PI / 2, 0.35, 0.25],
    mirror: true,
    shape: { kind: 'arc', radius: 0.3, tube: 0.072, sweep: 2.6 },
    // Four slots along the curve, oldest first. The deque, drawn. Local to the
    // region's own frame, so they follow it to the other hemisphere.
    beads: [
      [0.277, 0.114, 0],
      [0.164, 0.251, 0],
      [-0.012, 0.3, 0],
      [-0.178, 0.241, 0],
    ],
  },
  {
    key: 'motor',
    title: 'Supplementary motor area',
    what: 'Sequences movement. In Wren: speech output — pulses once per spoken chunk, holds across the utterance.',
    live: true,
    stages: ['warm'],
    panel: null,
    at: [0.14, 0.55, 0],
    shape: { kind: 'blob', radii: [0.22, 0.17, 0.4] },
  },
  {
    key: 'voiceprint',
    title: 'Superior temporal gyrus',
    what: 'Processes voice identity. In Wren: the voiceprint check — brightness tracks the match score.',
    live: true,
    stages: ['voiceprint'],
    panel: null,
    at: [0.06, -0.2, 0.58],
    mirror: true,
    shape: { kind: 'blob', radii: [0.44, 0.115, 0.14] },
  },
  {
    key: 'auditory',
    title: 'Auditory cortex',
    what: 'Receives hearing. In Wren: incoming speech recognition — ripples with input level.',
    live: true,
    stages: ['asr'],
    panel: null,
    at: [0.02, -0.38, 0.54],
    mirror: true,
    shape: { kind: 'blob', radii: [0.42, 0.105, 0.14] },
  },
  {
    key: 'prefrontal',
    title: 'Prefrontal cortex',
    what: 'Planning and reasoning. In Wren: the language model — lit and held while Wren is thinking.',
    live: true,
    stages: ['brain'],
    panel: 'personality',
    at: [0.66, 0.14, 0],
    shape: { kind: 'blob', radii: [0.33, 0.35, 0.53] },
  },
  {
    key: 'brainstem',
    title: 'Brainstem',
    what: 'Runs the body beneath awareness. In Wren: the process itself — the daemon staying alive.',
    live: true,
    stages: [],
    panel: null,
    at: [-0.2, -0.62, 0],
    turn: [0, 0, 0.22],
    shape: { kind: 'stalk', top: 0.11, bottom: 0.07, height: 0.52 },
  },
  {
    key: 'cerebellum',
    title: 'Cerebellum',
    what: 'Coordination and timing. In Wren: the mic loop and half-duplex guard keeping listening and speaking from colliding.',
    live: true,
    stages: ['wakeword', 'vad'],
    panel: null,
    at: [-0.68, -0.46, 0],
    shape: { kind: 'blob', radii: [0.31, 0.17, 0.36] },
  },

  // ── Dashed from here down. Nothing behind either of these. ──────────────────
  {
    key: 'cingulate',
    title: 'Cingulate gyrus',
    what: 'Emotion, motivation, conflict-monitoring. In Wren: mood and opinions. Not yet built — drawn dashed, never lights.',
    live: false,
    stages: [],
    panel: 'feelings',
    at: [0.0, 0.1, 0],
    turn: [0, 0, -0.15],
    shape: { kind: 'arc', radius: 0.46, tube: 0.075, sweep: 3.4 },
  },
  {
    key: 'mantle',
    title: 'Neocortex',
    what: 'Long-term memory and knowledge. In Wren: not yet built — drawn dashed, never lights.',
    live: false,
    stages: [],
    panel: 'longterm',
    at: [-0.52, 0.3, 0],
    shape: { kind: 'blob', radii: [0.42, 0.36, 0.6] },
  },
]

// ── Pathways ──────────────────────────────────────────────────────────────────
//
// Independent lamps read as a dashboard. These carry a travelling highlight when
// a signal moves, which is what makes the picture one system rather than ten.
// `store` takes the long way over the callosum, the route the cingulum bundle
// actually takes. Endpoints are the +Z copy of any mirrored region.

export const PATHWAYS = {
  hear: { from: [0.02, -0.38, 0.54], via: [0.12, -0.16, 0.34], to: [-0.02, 0.02, 0] },
  judge: { from: [-0.02, 0.02, 0], via: [0.34, 0.16, 0.06], to: [0.66, 0.14, 0] },
  speak: { from: [0.66, 0.14, 0], via: [0.52, 0.48, 0], to: [0.14, 0.55, 0] },
  store: { from: [0.66, 0.14, 0], via: [0.3, 0.46, 0.3], to: [-0.08, -0.26, 0.36] },
}

// Where the mic level arrives from, just outside the skull. Mirrored, and facing
// outward along ±Z so the rings read as sound closing on the cortex.
export const EAR = [0.02, -0.34, 0.98]

// Where the camera sits before anyone touches it: three-quarters from the front
// left, high enough that the temporal lobe does not hide the deep structures.
export const CAMERA = { position: [2.15, 1.0, 2.25], fov: 32, near: 0.1, far: 20 }
export const ZOOM = { min: 2.0, max: 5.0 }
