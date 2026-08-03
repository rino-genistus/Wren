// The scene.
//
// Wren's interior in three dimensions, lit off the event stream she already
// emits. Eight regions are wired to something real and light when it fires; two
// are dashed and never light, because there is no long-term memory and no mood
// behind them. That ratio is the point of the picture — it is a map of what
// exists, and drawing the dark parts is the only way the map stays honest.
//
// Two highlight channels, deliberately unlike each other:
//
//   activity — emissive, from handle(record). Comes from Wren, decays on its own.
//   hover    — a rim shell around the region under the cursor, plus the popup.
//              Comes from you, and vanishes the moment you look away.
//
// A region can be glowing from activity while you hover a different one, which
// is the whole reason they cannot share a treatment.
//
// And two states. Assembled it is a brain, which is what makes it legible —
// but a brain hides its own contents, and the two regions that are the point of
// the picture are the least visible things in it. Clicking takes it apart:
// every region travels outward along its own vector, the shell fades, and the
// wiring goes with it, because a rail drawn to where a region used to be is the
// picture lying. Lighting is identical in both states; only position differs.

import { useMemo, useRef, useState } from 'react'
import { useFrame } from '@react-three/fiber'
// Deep imports on purpose. drei's index re-exports every helper it has, and
// pulling the two this needs off the barrel drags troika text, BVH and the rest
// into the bundle for nothing.
import { Html } from '@react-three/drei/web/Html.js'
import { OrbitControls } from '@react-three/drei/core/OrbitControls.js'
import { Bloom, EffectComposer } from '@react-three/postprocessing'
import {
  AdditiveBlending,
  BackSide,
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  FrontSide,
  Group,
  LatheGeometry,
  Line,
  LineBasicMaterial,
  LineDashedMaterial,
  QuadraticBezierCurve3,
  RingGeometry,
  SphereGeometry,
  TorusGeometry,
  Vector2,
  Vector3,
} from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { SimplexNoise } from 'three/examples/jsm/math/SimplexNoise.js'

import { CAMERA, CENTRE, EAR, PATHWAYS, REGIONS, SHELL, ZOOM } from './atlas.js'
import { EXPLODE_SCALE, EXPLODE_SHIFT, explodeOffset } from './view.js'

// ── Geometry ──────────────────────────────────────────────────────────────────
//
// Everything here is placeholder primitives standing in for the glTF. See the
// TODO at the head of atlas.js — when the real mesh lands, buildRegion becomes a
// lookup into its named nodes and nothing else in this file changes.

// ── The fold field ────────────────────────────────────────────────────────────
//
// A cortex is not a sphere with a ripple on it. What makes a brain recognisable
// at a glance is the convolution: long meandering gyri separated by creases,
// irregular but evenly sized, covering the whole surface.
//
// Ridged noise rather than plain: `1 - |n|` puts a crease where plain fBm would
// put a smooth trough, and squaring it sharpens the crease further. A sulcus is
// a fold pressed together, not a dip. The sample point is warped by a second,
// slower noise first, which is what stops the folds reading as corrugation and
// makes them wander the way real gyri do.

// Seeded, so Wren has the same brain every time she starts. SimplexNoise takes
// anything with a random() — left to Math it would reshuffle the cortex on every
// reload, which is a strange thing for an anatomy to do.
function seeded(state) {
  return {
    random() {
      state |= 0
      state = (state + 0x6d2b79f5) | 0
      let t = Math.imul(state ^ (state >>> 15), 1 | state)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    },
  }
}

const noise = new SimplexNoise(seeded(0x57ee9))

const GYRI = 3.4 // Roughly eight folds across a hemisphere
const FOLD = 0.105 // How deep, as a fraction of the radius
const WARP = 0.26 // How far the folds wander off a regular grid

/** Ridged fBm, 0..1, peaking on the crests. */
function folds(x, y, z, octaves = 2) {
  let sum = 0
  let norm = 0
  let amplitude = 1
  let frequency = 1
  for (let octave = 0; octave < octaves; octave += 1) {
    const n = 1 - Math.abs(noise.noise3d(x * frequency, y * frequency, z * frequency))
    sum += n * n * amplitude
    norm += amplitude
    frequency *= 2.03 // Not exactly 2: octaves that share a period line up
    // Falls away fast. The top octave has to stay coarser than the mesh or the
    // folds stop being folds and become a fur of single-vertex spikes.
    amplitude *= 0.34
  }
  return sum / norm
}

// The shell is a sphere pushed into the shape of a brain: tapered at the frontal
// pole, flattened underneath, split down the midline, grooved by the lateral
// fissure that separates the temporal lobe, and folded all over. Primitives
// alone read as a bag of marbles — the fissures and the convolution are what
// make it legible as anatomy, and they cost one pass over the vertices at mount.
//
// Written as a function of a direction rather than a loop over one geometry, so
// that a region can be cut from the very same surface — a patch of cortex is
// then literally a piece of this brain rather than a lozenge parked next to it.
function surfaceAt(unit, radii, shape, out) {
  {
    const lat = Math.asin(Math.max(-1, Math.min(1, unit.y)))
    const lon = Math.atan2(unit.z, unit.x)
    let radius = 1

    if (shape === 'cerebrum') {
      // The frontal pole is narrower than the occipital.
      radius *= 1 - 0.15 * Math.max(0, unit.x) ** 2
      // The lateral fissure, running back and up from the front. This is the cut
      // that frees the temporal lobe, and it has to be deep enough to read as a
      // lobe boundary rather than a scratch — it is the single line that makes a
      // side view legible as a brain.
      radius *= 1 - 0.17 * Math.exp(-((lat + 0.4) ** 2) / 0.006) * Math.abs(Math.sin(lon)) ** 0.5
      // The longitudinal fissure between the hemispheres.
      radius *= 1 - 0.14 * Math.exp(-(unit.z * unit.z) / 0.0045) * Math.max(0, unit.y) ** 0.5

      // Gyri. Warped first, so they meander rather than ruling the surface into
      // stripes, and eased off toward the underside where the cortex is smooth
      // and sits against the skull base.
      const wx = unit.x + WARP * noise.noise3d(unit.x * 1.7 + 19.3, unit.y * 1.7, unit.z * 1.7)
      const wy = unit.y + WARP * noise.noise3d(unit.x * 1.7, unit.y * 1.7 + 7.1, unit.z * 1.7)
      const wz = unit.z + WARP * noise.noise3d(unit.x * 1.7, unit.y * 1.7, unit.z * 1.7 + 31.7)
      // Subtracted, not added. The sharp feature in a ridged field is the ridge
      // itself, and pushing that outward grows a coat of spikes. Cutting inward
      // instead puts the sharp edge at the bottom of a groove — which is what a
      // sulcus is — and leaves the broad rounded ground between them, which is
      // what a gyrus is.
      const relief = 1 - 0.55 * Math.max(0, -unit.y) ** 1.5
      radius *= 1 - FOLD * relief * folds(wx * GYRI, wy * GYRI, wz * GYRI)
    } else {
      // Cerebellar foliation: far finer than the cortex, and horizontal — the
      // cerebellum is banded where the cerebrum is convoluted, and that
      // difference in texture is most of how the two read apart.
      radius *= 1 + 0.032 * Math.sin(lat * 34) * (0.7 + 0.3 * Math.cos(lon * 3))
      // The vermis, down the midline between the two halves.
      radius *= 1 - 0.11 * Math.exp(-(unit.z * unit.z) / 0.004)
    }

    out.set(unit.x * radii[0], unit.y * radii[1], unit.z * radii[2]).multiplyScalar(radius)
    // The underside of the brain is flat where it sits on the skull base.
    if (out.y < 0) out.y *= 0.88
  }
  return out
}

/** Push a sphere's vertices onto that surface. */
function sculpt(geometry, radii, shape) {
  const position = geometry.attributes.position
  const unit = new Vector3()
  const out = new Vector3()
  for (let index = 0; index < position.count; index += 1) {
    unit.fromBufferAttribute(position, index).normalize()
    surfaceAt(unit, radii, shape, out)
    position.setXYZ(index, out.x, out.y, out.z)
  }
  geometry.computeVertexNormals()
  return geometry
}

function buildShell() {
  // Dense enough for the folds to have vertices to live in. Built once at mount;
  // nothing here runs per frame.
  const parts = SHELL.parts.map(({ at, radii, shape }) => {
    const part = sculpt(new SphereGeometry(1, 192, 128), radii, shape)
    part.translate(at[0], at[1], at[2])
    return part
  })
  const stem = stalk(SHELL.stem)
  stem.rotateZ(SHELL.stem.tilt)
  stem.translate(SHELL.stem.at[0], SHELL.stem.at[1], SHELL.stem.at[2])
  parts.push(stem)
  return mergeGeometries(parts, false)
}

// The brainstem, as a profile turned about its axis: the midbrain at the top,
// the pons bulging out below it, then the medulla tapering away. A plain cone is
// the one part of this that anyone would recognise as wrong — the pons is the
// landmark, and it is the whole silhouette of a stem seen from the side.
function stalk({ top, bottom, height }) {
  const steps = 20
  const profile = []
  for (let step = 0; step <= steps; step += 1) {
    const t = step / steps // 0 at the midbrain, 1 at the medulla
    const taper = top + (bottom - top) * t
    const pons = 1 + 0.5 * Math.exp(-((t - 0.32) ** 2) / 0.014)
    profile.push(new Vector2(Math.max(0.004, taper * pons), height * (0.5 - t)))
  }
  return new LatheGeometry(profile, 28)
}

// A piece of cortex, cut from the cortex. Sampled off the same surface function
// the shell is built from, so it carries the same gyri and sits in its own
// hollow when the brain is assembled — and when it comes apart it reads as a
// piece that came out of a brain rather than a pill that was never in one.
function patch({ dir, spread, thickness }, at) {
  const outward = new Vector3(...dir).normalize()
  // Any two axes across the direction. Z-up unless we are looking at the poles.
  const across = new Vector3(0, 1, 0)
  if (Math.abs(outward.y) > 0.9) across.set(1, 0, 0)
  const right = new Vector3().crossVectors(across, outward).normalize()
  const up = new Vector3().crossVectors(outward, right).normalize()

  const { radii, shape } = SHELL.parts[0]
  // Laid out in rings and spokes rather than rows and columns, so the outline is
  // an ellipse. A rectangular tile has four corners that no piece of anatomy has
  // and reads as something stamped onto the brain rather than taken out of it.
  const RINGS = 16
  const SPOKES = 48
  const unit = new Vector3()
  const point = new Vector3()
  const outer = []
  const inner = []

  for (let ring = 0; ring <= RINGS; ring += 1) {
    const reach = ring / RINGS
    for (let spoke = 0; spoke < SPOKES; spoke += 1) {
      const angle = (spoke / SPOKES) * Math.PI * 2
      unit
        .copy(outward)
        .addScaledVector(right, Math.sin(reach * Math.cos(angle) * spread[0]))
        .addScaledVector(up, Math.sin(reach * Math.sin(angle) * spread[1]))
        .normalize()
      surfaceAt(unit, radii, shape, point)
      outer.push(point.x - at[0], point.y - at[1], point.z - at[2])
      // Thickest in the middle, thinning to the rim, so the slab has a bevel
      // rather than a cliff all the way round.
      const depth = 1 - thickness * (0.3 + 0.7 * Math.cos((Math.PI / 2) * reach))
      inner.push(point.x * depth - at[0], point.y * depth - at[1], point.z * depth - at[2])
    }
  }

  // Two sheets and a rim between them, so it is a slab of cortex with an edge
  // you can see the thickness of, not a decal.
  const positions = new Float32Array([...outer, ...inner])
  const sheet = (RINGS + 1) * SPOKES
  const indices = []
  const quad = (a, b, c, d) => indices.push(a, b, c, a, c, d)
  const index = (ring, spoke) => ring * SPOKES + (spoke % SPOKES)

  for (let ring = 0; ring < RINGS; ring += 1) {
    for (let spoke = 0; spoke < SPOKES; spoke += 1) {
      const a = index(ring, spoke)
      const b = index(ring, spoke + 1)
      const c = index(ring + 1, spoke + 1)
      const d = index(ring + 1, spoke)
      quad(a, b, c, d)
      quad(sheet + a, sheet + d, sheet + c, sheet + b)
    }
  }
  for (let spoke = 0; spoke < SPOKES; spoke += 1) {
    const a = index(RINGS, spoke)
    const b = index(RINGS, spoke + 1)
    quad(a, b, sheet + b, sheet + a)
  }

  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(positions, 3))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  return geometry
}

function buildRegion(region) {
  const shape = region.shape
  if (shape.kind === 'arc') {
    return new TorusGeometry(shape.radius, shape.tube, 16, 60, shape.sweep)
  }
  if (shape.kind === 'stalk') {
    return stalk(shape)
  }
  if (shape.kind === 'patch') {
    return patch(shape, region.at)
  }
  const blob = new SphereGeometry(1, 44, 32)
  if (shape.folded) sculpt(blob, shape.radii, 'cerebellum')
  else blob.scale(shape.radii[0], shape.radii[1], shape.radii[2])
  return blob
}

// The dashed outline an unbuilt region wears. A few rings rather than a
// wireframe of the mesh: every triangle edge of a sphere is a scribble, and a
// scribble is louder than the eight regions that are actually wired to
// something. Dashed has to read as absence, which means reading quietly.
function outlineRings(shape) {
  const rings = []
  const ring = (a, b, plane, offset = 0) => {
    const points = []
    for (let step = 0; step <= 72; step += 1) {
      const t = (step / 72) * Math.PI * 2
      const u = Math.cos(t) * a
      const v = Math.sin(t) * b
      if (plane === 'xy') points.push(new Vector3(u, v, offset))
      else if (plane === 'xz') points.push(new Vector3(u, offset, v))
      else points.push(new Vector3(offset, u, v))
    }
    rings.push(points)
  }

  if (shape.kind === 'blob') {
    const [a, b, c] = shape.radii
    ring(a, b, 'xy')
    ring(a, c, 'xz')
    ring(b, c, 'yz')
    // Two lines of latitude, so it reads as a volume and not a gyroscope.
    for (const height of [-0.6, 0.6]) {
      const shrink = Math.sqrt(1 - height * height)
      ring(a * shrink, c * shrink, 'xz', b * height)
    }
  } else if (shape.kind === 'arc') {
    for (const offset of [-shape.tube, 0, shape.tube]) {
      const points = []
      for (let step = 0; step <= 64; step += 1) {
        const t = (step / 64) * shape.sweep
        points.push(new Vector3(Math.cos(t) * shape.radius, Math.sin(t) * shape.radius, offset))
      }
      rings.push(points)
    }
  }
  return rings
}

// ── Colour ────────────────────────────────────────────────────────────────────
// Scratch instances, reused every frame. Allocating a Color per region per frame
// is the kind of garbage that shows up as a stutter and nothing else.

const scratch = new Color()
const scratchB = new Color()

/** The 2D brain's tint, unchanged: glow → cool as the gate rejects, → fail as a
 *  turn goes wrong, and hard fail for a subsystem that never loaded. */
function tintOf(look, state, out) {
  if (state.failed) return out.copy(look.fail)
  out.copy(look.glow).lerp(look.cool, state.tint)
  return out.lerp(look.fail, state.hurt)
}

// ── Picking ───────────────────────────────────────────────────────────────────
//
// R3F does the raycasting; this only decides which hit wins.
//
// Assembled, deepest wins: REGIONS is ordered deep-and-small first and `rank` is
// its index, so the hippocampus beats the mantle it sits inside — the same rule
// the 2D brain used, and the reason the deep structures stay reachable through a
// translucent cortex instead of being permanently shadowed by whatever is
// nearest the camera.
//
// Exploded, that rule is actively wrong. Nothing is inside anything any more, so
// a ray that grazes a near region on its way to a deep one would resolve the
// far one — you would point at the neocortex and read the thalamus. Once they
// are apart, nearest wins, which is the order three.js already sorted them in.
export function pickRegion(hits, exploded) {
  let best = null
  for (const hit of hits) {
    const rank = hit.object.userData.rank
    if (rank === undefined) continue
    if (!best) best = hit
    else if (exploded ? hit.distance < best.distance : rank < best.object.userData.rank) best = hit
  }
  return best ? [best] : []
}

// ── Shell ─────────────────────────────────────────────────────────────────────
// One mesh, translucent, tinted toward --cool, so the deep structures read
// through it. Never raycast: hovering the outside of the head must fall through
// to whatever region is behind it, or to nothing at all.

// Assembled it is the silhouette that makes the picture a brain; exploded it is
// a bag around parts you are trying to see, so it goes almost all the way out.
// Not all the way: a trace of it is what tells you the head is still there and
// the pieces are going to go back into it.
// Lower than it was on the dark room, not higher. Additive light lands on a
// brighter floor now, so the same alpha reads as more — a lighter room wants
// less glow on top of it, not more.
const SHELL_SOLID = 0.44
const SHELL_GHOST = 0.03

function Shell({ look, view }) {
  const geometry = useMemo(() => buildShell(), [])
  const material = useRef()

  useFrame(() => {
    if (!material.current) return
    const open = view.amount
    material.current.opacity = SHELL_SOLID + (SHELL_GHOST - SHELL_SOLID) * open
    material.current.emissiveIntensity = 0.12 * (1 - open)
  })

  return (
    <mesh geometry={geometry} raycast={() => null} renderOrder={0}>
      {/* The one thing in this app that is not additive.

          Additive light has no shading, and shading is the only thing that makes
          a convolution legible — lit crests, dark sulci. Drawn additively and
          double-sided, the folded cortex stopped being a surface at all and
          became a wash of overlapping foil. So: front faces only, normal
          blending, one lit skin you can see through. The rule additive existed
          to enforce — never a dark hole on the room — is kept by the surface
          being lit rather than by the blend mode. */}
      <meshStandardMaterial
        ref={material}
        color={look.cool}
        emissive={look.cool}
        emissiveIntensity={0.06}
        roughness={0.88}
        metalness={0}
        transparent
        opacity={SHELL_SOLID}
        depthWrite={false}
        side={FrontSide}
      />
    </mesh>
  )
}

// ── The deque ─────────────────────────────────────────────────────────────────
// Four slots. Empty slots stay drawn — the gaps are the message, and they are
// most of what there is to say about Wren's memory.

function Beads({ region, life, look }) {
  const group = useRef()
  const geometry = useMemo(() => new SphereGeometry(0.036, 14, 10), [])

  useFrame(() => {
    const state = life.regions.get(region.key)
    let index = 0
    for (const bead of group.current.children) {
      const occupancy = Math.max(0, Math.min(1, life.filledNow - index))
      const newest = index === Math.ceil(life.filledNow) - 1 ? life.flare : 0
      const material = bead.material
      material.opacity = 0.2 + occupancy * 0.75
      material.emissiveIntensity = occupancy * (0.5 + state.now * 1.6 + newest * 2.4)
      scratch.copy(look.fainter).lerp(look.glow, occupancy)
      material.color.copy(scratch)
      bead.scale.setScalar(1 + newest * 0.5)
      index += 1
    }
  })

  return (
    <group ref={group}>
      {region.beads.map((at, index) => (
        <mesh key={index} position={at} geometry={geometry} raycast={() => null}>
          <meshStandardMaterial
            emissive={look.hot}
            emissiveIntensity={0}
            roughness={0.5}
            transparent
            opacity={0.2}
            depthWrite={false}
            blending={AdditiveBlending}
          />
        </mesh>
      ))}
    </group>
  )
}

// ── A region ──────────────────────────────────────────────────────────────────

function Region({ region, rank, life, look, view, hovered, pinned, onHover, onPick }) {
  const geometry = useMemo(() => buildRegion(region), [region])
  const material = useRef()
  const rim = useRef()
  // One per copy of the region. Where it travels to when the brain comes apart.
  const drift = useRef([])
  const offset = useMemo(() => explodeOffset(region), [region])

  // The dashed treatment. It means exactly what it means on the .empty panels
  // below — laid out, described, and with nothing behind it — so an unbuilt
  // region is recognisable as unbuilt before you have read a word of the popup.
  const dashes = useMemo(() => {
    if (region.live) return null
    const group = new Group()
    for (const points of outlineRings(region.shape)) {
      const line = new Line(
        new BufferGeometry().setFromPoints(points),
        new LineDashedMaterial({
          color: look.fainter,
          dashSize: 0.03,
          gapSize: 0.032,
          transparent: true,
          opacity: 0.9,
          depthWrite: false,
        }),
      )
      line.computeLineDistances()
      line.raycast = () => null
      group.add(line)
    }
    return group
  }, [region, look])

  const near = hovered === region.key
  const held = pinned === region.key

  useFrame(() => {
    const state = life.regions.get(region.key)
    // An unbuilt region never lights. Not dimly, not on hover, not on error —
    // that is the whole mechanism, so it is a branch and not a multiplier.
    // Nothing about coming apart reaches this line.
    const lit = region.live ? state.now : 0

    // Set rather than declared, because a re-render — every hover is one —
    // would re-apply a position prop and snap the region back to its home.
    for (const group of drift.current) {
      if (group) group.position.set(offset[0] * view.amount, offset[1] * view.amount, offset[2] * view.amount)
    }

    // Assembled, a quiet region reads because the shell is lit behind it.
    // Exploded there is nothing behind it, so it has to hold itself against an
    // empty room — and coming apart is supposed to make every region *more*
    // visible, the dark two most of all. Presence, not light: this raises what
    // is drawn, never what is emitted, so activity keeps the emissive channel
    // to itself and an unbuilt region gains substance without gaining a glow.
    const open = view.amount

    if (material.current) {
      const surface = material.current
      if (region.live) {
        tintOf(look, state, scratch)
        surface.emissive.copy(scratch)
        // The floor is only there once the brain is apart: a region alone in the
        // dark has nothing behind it to be seen against, and the exploded view
        // exists precisely so that every region is visible. It is far below what
        // activity reaches, so a working region still stands out among resting
        // ones — and it is inside the `region.live` branch, so it can never
        // reach the two that are unbuilt.
        surface.emissiveIntensity = state.failed
          ? 0.45 + lit * 0.9
          : lit * 1.3 + state.hurt * 0.7 + open * 0.12
        // Darker than --fainter at rest, and darkest while the brain is whole.
        // The key light had to come up for the cortex to have shadows in its
        // folds, and an additive region catches that same light — left at full,
        // inside the head, every quiet subsystem becomes a lamp and there is no
        // headroom for the one that is working. Once it comes apart there is
        // nothing in front of it and no lamps to compete with, so it gets its
        // full colour back.
        scratchB
          .copy(look.fainter)
          .multiplyScalar(0.45 + 0.55 * open)
          .lerp(scratch, Math.min(1, lit * 0.7 + state.hurt))
        surface.color.copy(scratchB)
        // Idle sits low on purpose. A subsystem that is merely up should be a
        // presence in the volume, not a lamp — otherwise there is no headroom
        // left to show the one that is actually working.
        surface.opacity = (state.loaded ? 0.2 : 0.08) + lit * 0.4 + state.failed * 0.28 + open * 0.34
      } else {
        // Barely there. An unbuilt region is its dashes; the solid behind them
        // exists only to be hoverable and to catch a rim, and at any real
        // opacity it becomes a smooth lid sitting on the cortex — which reads as
        // a part of Wren that is present and quiet rather than absent.
        surface.opacity = 0.035 + (near || held ? 0.03 : 0) + open * 0.05
      }
    }

    // Hovering an unbuilt region brightens its dashes without ever filling them.
    // It is the one acknowledgement they get, and it is not light.
    if (dashes) {
      const wanted = near ? 1 : held ? 0.95 : 0.62 + open * 0.3
      for (const line of dashes.children) {
        line.material.opacity += (wanted - line.material.opacity) * 0.25
      }
    }

    if (rim.current) {
      // Hover is a rim, activity is emissive. Deliberately different channels:
      // one is the app telling you something, the other is you asking.
      const wanted = near ? 0.5 : held ? 0.24 : 0
      rim.current.material.opacity += (wanted - rim.current.material.opacity) * 0.28
      rim.current.visible = rim.current.material.opacity > 0.004
    }
  })

  const body = (
    <>
      {/* Before the shell, so the cortex is drawn over it and a deep region
          reads as being *under* the surface rather than stuck to the front of
          it. It costs some brightness while assembled, which is correct: light
          inside a head is dimmer than light in the open, and the shell fades out
          of the way the moment the brain comes apart. */}
      <mesh
        geometry={geometry}
        renderOrder={-1}
        userData={{ region: region.key, rank }}
        onPointerOver={(event) => {
          event.stopPropagation()
          onHover(region.key)
        }}
        onPointerOut={() => onHover(null, region.key)}
        onClick={(event) => {
          event.stopPropagation()
          onPick(region)
        }}
      >
        {/* Additive, like every glow in this app: a region adds light to the
            room rather than painting over it. Subtractive here would make an
            unlit region a hole in the brain, which is the opposite of what a
            quiet subsystem is. */}
        <meshStandardMaterial
          ref={material}
          color={look.fainter}
          emissive={region.live ? look.glow : look.fainter}
          emissiveIntensity={0}
          roughness={0.5}
          metalness={0}
          transparent
          opacity={region.live ? 0.16 : 0.05}
          depthWrite={false}
          blending={AdditiveBlending}
          side={DoubleSide}
        />
      </mesh>

      {dashes && <primitive object={dashes} />}

      <mesh ref={rim} geometry={geometry} scale={1.09} visible={false} raycast={() => null}>
        <meshBasicMaterial
          color={region.live ? look.hot : look.faint}
          side={BackSide}
          transparent
          opacity={0}
          depthWrite={false}
          blending={AdditiveBlending}
        />
      </mesh>

      {region.beads && <Beads region={region} life={life} look={look} />}
    </>
  )

  // A paired structure is one region drawn twice. The outer group reflects
  // across the midline, so the copy is a true mirror rather than a rotated one —
  // and because the drift sits inside that reflection, a pair comes apart
  // symmetrically off one vector rather than needing two.
  const sides = region.mirror ? [1, -1] : [1]
  return sides.map((side, index) => (
    <group key={side} scale={[1, 1, side]}>
      <group ref={(node) => { drift.current[index] = node }}>
        <group position={region.at} rotation={region.turn ?? [0, 0, 0]}>
          {body}
        </group>
      </group>
    </group>
  ))
}

// ── Pathways ──────────────────────────────────────────────────────────────────
// Independent lamps read as a dashboard. A travelling highlight along the active
// pathway is what makes a turn read as one traversal.

// Three travellers per pathway is more than Wren ever has in flight at once;
// the pool exists so nothing is allocated mid-conversation.
const POOL = 3

function Pathways({ life, look, view }) {
  const groups = useRef({})
  const rig = useRef()
  const curves = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(PATHWAYS).map(([name, { from, via, to }]) => [
          name,
          new QuadraticBezierCurve3(new Vector3(...from), new Vector3(...via), new Vector3(...to)),
        ]),
      ),
    [],
  )

  // The rails themselves: faint, always drawn. A pathway you only see when it
  // fires reads as an effect; one that is always there reads as wiring.
  const rails = useMemo(
    () =>
      Object.entries(curves).map(([name, curve]) => {
        const line = new Line(
          new BufferGeometry().setFromPoints(curve.getPoints(48)),
          new LineBasicMaterial({ color: look.fainter, transparent: true, opacity: 0.9, depthWrite: false, blending: AdditiveBlending }),
        )
        line.raycast = () => null
        return [name, line]
      }),
    [curves, look],
  )

  const spark = useMemo(() => new SphereGeometry(0.05, 12, 9), [])
  const point = useMemo(() => new Vector3(), [])

  useFrame(() => {
    // The rails run between the regions' home positions, so once the regions
    // leave, the wiring is a diagram of somewhere they no longer are. It goes
    // with them rather than lying: exploded is the parts, assembled is the
    // system, and a traversal is something you watch assembled.
    const here = 1 - view.amount
    if (rig.current) rig.current.visible = here > 0.01
    if (here <= 0.01) return

    // Quieter than they were: on the folded cortex a bright rail reads as a
    // scratch across the surface rather than as wiring underneath it.
    for (const [, line] of rails) line.material.opacity = 0.5 * here

    for (const [name, curve] of Object.entries(curves)) {
      const pool = groups.current[name]?.children ?? []
      const travellers = life.flows[name]
      for (let index = 0; index < pool.length; index += 1) {
        const traveller = travellers[index]
        const mesh = pool[index]
        if (!traveller) {
          mesh.visible = false
          continue
        }
        mesh.visible = true
        curve.getPoint(Math.min(1, traveller.t), point)
        mesh.position.copy(point)
        const fade = Math.sin(Math.min(1, traveller.t) * Math.PI) * here
        mesh.material.opacity = fade * 0.85
        mesh.material.emissiveIntensity = fade * 2.6
        mesh.scale.setScalar(0.7 + fade * 0.5)
      }
    }
  })

  return (
    <group ref={rig}>
      {rails.map(([name, line]) => (
        <primitive key={name} object={line} />
      ))}
      {Object.keys(curves).map((name) => (
        <group key={name} ref={(node) => { groups.current[name] = node }}>
          {Array.from({ length: POOL }, (_, index) => (
            <mesh key={index} geometry={spark} visible={false} raycast={() => null}>
              <meshStandardMaterial
                color={look.hot}
                emissive={look.hot}
                emissiveIntensity={0}
                transparent
                opacity={0}
                depthWrite={false}
                blending={AdditiveBlending}
              />
            </mesh>
          ))}
        </group>
      ))}
    </group>
  )
}

// ── Ears ──────────────────────────────────────────────────────────────────────
// Mic level, as rings arriving at the auditory cortex from outside the skull.
// Inward, not outward: sound is arriving.

function Ears({ life, look, view }) {
  const sides = useRef([])
  const geometry = useMemo(() => new RingGeometry(0.97, 1, 48), [])

  useFrame(() => {
    const state = life.regions.get('auditory')
    // Sound arriving at a head that has come apart is an ear ring around
    // nothing. It fades with the rest of the wiring.
    const amount = life.level * state.hold * (1 - view.amount)
    for (const group of sides.current) {
      if (!group) continue
      group.visible = amount > 0.01
      let ring = 0
      for (const mesh of group.children) {
        const phase = 1 - ((life.clock * 1.1 + ring / 3) % 1)
        mesh.scale.setScalar(0.06 + phase * 0.34)
        mesh.material.opacity = (1 - phase) * amount * 0.7
        ring += 1
      }
    }
  })

  return (
    <>
      {[1, -1].map((side) => (
        <group key={side} ref={(node) => { sides.current[side > 0 ? 0 : 1] = node }} position={[EAR[0], EAR[1], EAR[2] * side]}>
          {[0, 1, 2].map((ring) => (
            <mesh key={ring} geometry={geometry} raycast={() => null}>
              <meshBasicMaterial color={look.glow} transparent opacity={0} depthWrite={false} side={DoubleSide} blending={AdditiveBlending} />
            </mesh>
          ))}
        </group>
      ))}
    </>
  )
}

// ── The popup ─────────────────────────────────────────────────────────────────

function Popup({ region, pinned, view }) {
  const anchor = useRef()
  const offset = useMemo(() => explodeOffset(region), [region])

  // It rides its region out and back rather than staying where the region used
  // to be. A paired structure keeps the +Z copy, as it does assembled.
  useFrame(() => {
    if (!anchor.current) return
    const open = view.amount
    anchor.current.position.set(
      region.at[0] + offset[0] * open,
      region.at[1] + offset[1] * open + 0.16,
      region.at[2] + offset[2] * open,
    )
  })

  return (
    <group ref={anchor} position={[region.at[0], region.at[1] + 0.16, region.at[2]]}>
      <Html zIndexRange={[30, 10]} className="brain-popup-anchor" pointerEvents="none">
        <div className="brain-popup" data-pinned={String(pinned)} data-unbuilt={String(!region.live)}>
          <span className="label">{region.title}</span>
          {!region.live && <span className="brain-unbuilt">not yet built</span>}
          <span className="brain-what">{region.what}</span>
        </div>
      </Html>
    </group>
  )
}

// ── The whole thing ───────────────────────────────────────────────────────────

function Tick({ life, view }) {
  // Mounted first among its siblings, so both clocks advance before anything
  // reads them. One frame either way would not be visible, but the ordering is
  // free and this way nothing is ever drawn from a half-stepped state.
  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.05)
    life.advance(dt)
    view.advance(dt)
  })
  return null
}

// Everything that comes apart lives under one group, which shrinks by as much as
// the parts spread. Exploded, they span about twice what the assembled brain
// does and would leave the frame — and dollying the camera instead would fight
// OrbitControls and throw away whatever zoom the user had chosen. Scaling in
// place reads as the brain opening up where it stands.
function Rig({ view, children }) {
  const rig = useRef()
  useFrame(() => {
    if (!rig.current) return
    const open = view.amount
    rig.current.scale.setScalar(1 + (EXPLODE_SCALE - 1) * open)
    // And slides back to where the camera is pointed, since the parts do not
    // spread evenly about the centre and would otherwise sink out of frame.
    rig.current.position.set(EXPLODE_SHIFT[0] * open, EXPLODE_SHIFT[1] * open, EXPLODE_SHIFT[2] * open)
  })
  return <group ref={rig}>{children}</group>
}

// `pinned` and the exploded state both live one level up, in index.jsx: clicking
// past every region has to let go of both, and onPointerMissed belongs on the
// canvas.
export function Brain({ life, look, view, exploded, onSelect, pinned, setPinned, drifting, settle }) {
  const [hovered, setHovered] = useState(null)

  const onHover = (key, leaving) => {
    setHovered((current) => (key === null ? (current === leaving ? null : current) : key))
  }

  // Two levels, because one click cannot both open the brain and send you to a
  // panel below it. Assembled, a click is "show me this" — it comes apart and
  // pins what you asked for. Exploded, you are already looking at the thing, so
  // a click is "tell me more" and lands on the panel.
  const onPick = (region) => {
    setPinned(region.key)
    if (!exploded) {
      view.set(true)
      return
    }
    if (region.panel) onSelect?.(region.panel)
  }

  const shown = REGIONS.find((region) => region.key === (hovered ?? pinned)) ?? null

  return (
    <>
      <Tick life={life} view={view} />

      {/* The canvas clears to the room rather than to nothing, which gives the
          bloom pass a real backdrop instead of a transparent one — the
          difference between a glow and a black rectangle.

          It only looks identical to the page because the page under it really is
          flat --ink: `--sky` in breath.css ends the top wash inside the presence
          band for exactly this reason. Let that gradient reach down here and this
          opaque rectangle becomes visible, with four hard edges. */}
      <color attach="background" args={[look.ink.r, look.ink.g, look.ink.b]} />

      {/* Enough light to give the folds their shadows and no more — the regions
          carry their own light, and anything brighter washes out the difference
          between one that is working and one that is merely up. */}
      <ambientLight intensity={0.3} />
      <directionalLight position={[2.5, 3, 2]} intensity={0.95} />
      <directionalLight position={[-2, -1, -2.5]} intensity={0.26} color={look.cool} />

      <Rig view={view}>
        <Shell look={look} view={view} />
        <Pathways life={life} look={look} view={view} />
        <Ears life={life} look={look} view={view} />

        {REGIONS.map((region, rank) => (
          <Region
            key={region.key}
            region={region}
            rank={rank}
            life={life}
            look={look}
            view={view}
            hovered={hovered}
            pinned={pinned}
            onHover={onHover}
            onPick={onPick}
          />
        ))}

        {shown && <Popup region={shown} pinned={!hovered && !!pinned} view={view} />}
      </Rig>

      <OrbitControls
        makeDefault
        enablePan={false}
        enableDamping
        dampingFactor={0.08}
        minDistance={ZOOM.min}
        maxDistance={ZOOM.max}
        target={CENTRE}
        autoRotate={drifting}
        autoRotateSpeed={0.3}
        onStart={settle}
      />

      {/* One pass, and a threshold set above the room and above an idle region,
          so bloom is something activity does rather than a haze over everything.
          It costs a full-screen pass — but only while the Mind view is on
          screen, because the loop is stopped everywhere else. */}
      <EffectComposer disableNormalPass multisampling={0}>
        <Bloom mipmapBlur intensity={0.55} luminanceThreshold={0.52} luminanceSmoothing={0.3} radius={0.65} />
      </EffectComposer>
    </>
  )
}

export { CAMERA }
