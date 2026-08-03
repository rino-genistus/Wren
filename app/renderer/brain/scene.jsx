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

import { useMemo, useRef, useState } from 'react'
import { useFrame } from '@react-three/fiber'
// Deep imports on purpose. drei's index re-exports every helper it has, and
// pulling the two this needs off the barrel drags troika text, BVH and the rest
// into the bundle for nothing.
import { Html } from '@react-three/drei/web/Html.js'
import { OrbitControls } from '@react-three/drei/core/OrbitControls.js'
import {
  AdditiveBlending,
  BackSide,
  BufferGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  Group,
  Line,
  LineBasicMaterial,
  LineDashedMaterial,
  QuadraticBezierCurve3,
  RingGeometry,
  SphereGeometry,
  TorusGeometry,
  Vector3,
} from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

import { CAMERA, EAR, PATHWAYS, REGIONS, SHELL, ZOOM } from './atlas.js'

// ── Geometry ──────────────────────────────────────────────────────────────────
//
// Everything here is placeholder primitives standing in for the glTF. See the
// TODO at the head of atlas.js — when the real mesh lands, buildRegion becomes a
// lookup into its named nodes and nothing else in this file changes.

// The shell is a sphere pushed into the shape of a brain: tapered at the frontal
// pole, flattened underneath, split down the midline, grooved by the lateral
// fissure that separates the temporal lobe, and wrinkled all over. Primitives
// alone read as a bag of marbles — the fissures are what make it legible as
// anatomy, and they cost one pass over the vertices.
function sculpt(geometry, radii, shape) {
  const position = geometry.attributes.position
  const unit = new Vector3()
  const out = new Vector3()
  for (let index = 0; index < position.count; index += 1) {
    unit.fromBufferAttribute(position, index).normalize()
    const lat = Math.asin(Math.max(-1, Math.min(1, unit.y)))
    const lon = Math.atan2(unit.z, unit.x)
    let radius = 1

    if (shape === 'cerebrum') {
      // The frontal pole is narrower than the occipital.
      radius *= 1 - 0.15 * Math.max(0, unit.x) ** 2
      // The lateral fissure, running back and up from the front — this is what
      // cuts the temporal lobe free and gives the side of the brain its shape.
      radius *= 1 - 0.1 * Math.exp(-((lat + 0.4) ** 2) / 0.008) * Math.abs(Math.sin(lon)) ** 0.6
      // The longitudinal fissure between the hemispheres.
      radius *= 1 - 0.12 * Math.exp(-(unit.z * unit.z) / 0.0045) * Math.max(0, unit.y) ** 0.5
      // Gyri.
      radius *= 1 + 0.02 * Math.sin(lon * 7.4 + lat * 2.6) * Math.sin(lat * 8.2 + 1.1)
    } else {
      // Cerebellar foliation: much finer banding, and horizontal.
      radius *= 1 + 0.028 * Math.sin(lat * 26)
      radius *= 1 - 0.09 * Math.exp(-(unit.z * unit.z) / 0.004)
    }

    out.set(unit.x * radii[0], unit.y * radii[1], unit.z * radii[2]).multiplyScalar(radius)
    // The underside of the brain is flat where it sits on the skull base.
    if (out.y < 0) out.y *= 0.88
    position.setXYZ(index, out.x, out.y, out.z)
  }
  geometry.computeVertexNormals()
  return geometry
}

function buildShell() {
  const parts = SHELL.parts.map(({ at, radii, shape }) => {
    const part = sculpt(new SphereGeometry(1, 128, 84), radii, shape)
    part.translate(at[0], at[1], at[2])
    return part
  })
  const { at, top, bottom, height, tilt } = SHELL.stem
  const stem = new CylinderGeometry(top, bottom, height, 24, 1)
  stem.rotateZ(tilt)
  stem.translate(at[0], at[1], at[2])
  parts.push(stem)
  return mergeGeometries(parts, false)
}

function buildRegion(shape) {
  if (shape.kind === 'arc') {
    return new TorusGeometry(shape.radius, shape.tube, 12, 44, shape.sweep)
  }
  if (shape.kind === 'stalk') {
    return new CylinderGeometry(shape.top, shape.bottom, shape.height, 20, 1)
  }
  const blob = new SphereGeometry(1, 28, 20)
  blob.scale(shape.radii[0], shape.radii[1], shape.radii[2])
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
// R3F does the raycasting; this only decides which hit wins. REGIONS is ordered
// deep-and-small first and `rank` is its index, so the hippocampus beats the
// mantle it sits inside — the same rule the 2D brain used, and the reason the
// deep structures stay reachable through a translucent cortex instead of being
// permanently shadowed by whatever is nearest the camera.
export function pickDeepest(hits) {
  let best = null
  for (const hit of hits) {
    const rank = hit.object.userData.rank
    if (rank === undefined) continue
    if (!best || rank < best.object.userData.rank) best = hit
  }
  return best ? [best] : []
}

// ── Shell ─────────────────────────────────────────────────────────────────────
// One mesh, translucent, tinted toward --cool, so the deep structures read
// through it. Never raycast: hovering the outside of the head must fall through
// to whatever region is behind it, or to nothing at all.

function Shell({ look }) {
  const geometry = useMemo(() => buildShell(), [])
  return (
    <mesh geometry={geometry} raycast={() => null}>
      <meshStandardMaterial
        color={look.cool}
        emissive={look.cool}
        emissiveIntensity={0.12}
        roughness={0.62}
        metalness={0}
        transparent
        opacity={0.3}
        depthWrite={false}
        blending={AdditiveBlending}
        side={DoubleSide}
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

function Region({ region, rank, life, look, hovered, pinned, onHover, onPick }) {
  const geometry = useMemo(() => buildRegion(region.shape), [region])
  const material = useRef()
  const rim = useRef()

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
    const lit = region.live ? state.now : 0

    if (material.current) {
      const surface = material.current
      if (region.live) {
        tintOf(look, state, scratch)
        surface.emissive.copy(scratch)
        surface.emissiveIntensity = state.failed
          ? 0.45 + lit * 0.9
          : lit * 1.3 + state.hurt * 0.7
        scratchB.copy(look.fainter).lerp(scratch, Math.min(1, lit * 0.7 + state.hurt))
        surface.color.copy(scratchB)
        // Idle sits low on purpose. A subsystem that is merely up should be a
        // presence in the volume, not a lamp — otherwise there is no headroom
        // left to show the one that is actually working.
        surface.opacity = (state.loaded ? 0.15 : 0.06) + lit * 0.3 + state.failed * 0.25
      } else {
        surface.opacity = 0.04 + (near || held ? 0.03 : 0)
      }
    }

    // Hovering an unbuilt region brightens its dashes without ever filling them.
    // It is the one acknowledgement they get, and it is not light.
    if (dashes) {
      const wanted = near ? 1 : held ? 0.95 : 0.62
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
      <mesh
        geometry={geometry}
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
  // across the midline, so the copy is a true mirror rather than a rotated one.
  const sides = region.mirror ? [1, -1] : [1]
  return sides.map((side) => (
    <group key={side} scale={[1, 1, side]}>
      <group position={region.at} rotation={region.turn ?? [0, 0, 0]}>
        {body}
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

function Pathways({ life, look }) {
  const groups = useRef({})
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
        const fade = Math.sin(Math.min(1, traveller.t) * Math.PI)
        mesh.material.opacity = fade * 0.85
        mesh.material.emissiveIntensity = fade * 2.6
        mesh.scale.setScalar(0.7 + fade * 0.5)
      }
    }
  })

  return (
    <group>
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

function Ears({ life, look }) {
  const sides = useRef([])
  const geometry = useMemo(() => new RingGeometry(0.97, 1, 48), [])

  useFrame(() => {
    const state = life.regions.get('auditory')
    const amount = life.level * state.hold
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

function Popup({ region, pinned }) {
  const at = [region.at[0], region.at[1] + 0.16, region.at[2]]
  return (
    <Html position={at} zIndexRange={[30, 10]} className="brain-popup-anchor" pointerEvents="none">
      <div className="brain-popup" data-pinned={String(pinned)} data-unbuilt={String(!region.live)}>
        <span className="label">{region.title}</span>
        {!region.live && <span className="brain-unbuilt">not yet built</span>}
        <span className="brain-what">{region.what}</span>
      </div>
    </Html>
  )
}

// ── The whole thing ───────────────────────────────────────────────────────────

function Tick({ life }) {
  // Mounted first among its siblings, so the clock advances before anything
  // reads it. One frame either way would not be visible, but the ordering is
  // free and this way nothing is ever drawn from a half-stepped state.
  useFrame((_, delta) => life.advance(Math.min(delta, 0.05)))
  return null
}

// `pinned` lives one level up, in index.jsx, because clicking past every region
// has to let go of it and onPointerMissed belongs on the canvas.
export function Brain({ life, look, onSelect, pinned, setPinned, drifting, settle }) {
  const [hovered, setHovered] = useState(null)

  const onHover = (key, leaving) => {
    setHovered((current) => (key === null ? (current === leaving ? null : current) : key))
  }

  const onPick = (region) => {
    setPinned(region.key)
    if (region.panel) onSelect?.(region.panel)
  }

  const shown = REGIONS.find((region) => region.key === (hovered ?? pinned)) ?? null

  return (
    <>
      <Tick life={life} />

      {/* Dark and clinical. Enough light to give the shell a form and no more —
          the regions carry their own light and anything else washes them out. */}
      <ambientLight intensity={0.35} />
      <directionalLight position={[2.5, 3, 2]} intensity={0.42} />
      <directionalLight position={[-2, -1, -2.5]} intensity={0.2} color={look.cool} />

      <Shell look={look} />
      <Pathways life={life} look={look} />
      <Ears life={life} look={look} />

      {REGIONS.map((region, rank) => (
        <Region
          key={region.key}
          region={region}
          rank={rank}
          life={life}
          look={look}
          hovered={hovered}
          pinned={pinned}
          onHover={onHover}
          onPick={onPick}
        />
      ))}

      {shown && <Popup region={shown} pinned={!hovered && !!pinned} />}

      <OrbitControls
        makeDefault
        enablePan={false}
        enableDamping
        dampingFactor={0.08}
        minDistance={ZOOM.min}
        maxDistance={ZOOM.max}
        target={[-0.04, -0.04, 0]}
        autoRotate={drifting}
        autoRotateSpeed={0.3}
        onStart={settle}
      />
    </>
  )
}

export { CAMERA }
