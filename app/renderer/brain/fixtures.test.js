// Fixture parity.
//
// Every fixture, replayed through the reducer the way the renderer replays it,
// asserting which regions light. This is the check that survives the picture
// changing: the 3D brain replaced the 2D one, and what a record means did not.
//
// Runs in plain Node — `npm run fixtures` from app/ — because life.js imports
// nothing but the atlas. No Electron, no WebGL, no window.

import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { CAMERA, CENTRE, REGIONS, SHELL } from './atlas.js'
import { createLife } from './life.js'
import { EXPLODE_SCALE, EXPLODE_SHIFT, explodeOffset } from './view.js'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../fixtures')

// A tenth of a second between records. Fast enough that a whole fixture is a
// conversation rather than an afternoon, slow enough that a rise is visible
// before the next record lands.
const STEP = 0.1

/** Replay one fixture, reporting the brightest each region ever got. */
function replay(records) {
  const life = createLife()
  life.resume()
  const peak = new Map(REGIONS.map((region) => [region.key, 0]))
  const observe = () => {
    for (const [key, state] of life.regions) {
      peak.set(key, Math.max(peak.get(key), state.now))
    }
  }

  for (const record of records) {
    life.handle(record)
    life.advance(STEP)
    observe()
  }
  // Let the tail of the last record play out.
  for (let i = 0; i < 30; i += 1) {
    life.advance(STEP)
    observe()
  }
  return { life, peak }
}

// Same shape main/source.js reads them in: comments and blanks skipped, so the
// records here are exactly the records the renderer would see.
const read = (name) =>
  readFileSync(join(FIXTURES, name), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('//'))
    .map((line) => JSON.parse(line))

const names = readdirSync(FIXTURES).filter((name) => name.endsWith('.jsonl')).sort()
assert.equal(names.length, 5, 'expected five fixtures')

const LIT = 0.2 // Bright enough that you would see it happen.
const results = []

for (const name of names) {
  const records = read(name)
  const { life, peak } = replay(records)
  const kinds = new Set(records.map((record) => record.kind))
  results.push({ name, records: records.length, peak, kinds, life })

  // ── The honesty rule ────────────────────────────────────────────────────────
  // Not "the scene declines to draw them" — nothing in the reducer may so much
  // as raise them, so there is no state a future renderer could accidentally
  // light. This is the assertion the whole picture rests on.
  for (const region of REGIONS) {
    if (region.live) continue
    const state = life.regions.get(region.key)
    assert.equal(peak.get(region.key), 0, `${name}: ${region.key} lit and must never`)
    assert.equal(state.hold, 0, `${name}: ${region.key} holds`)
    assert.equal(state.failed, 0, `${name}: ${region.key} failed`)
    assert.equal(state.hurt, 0, `${name}: ${region.key} hurt`)
  }

  // Anything at all arriving means the process is up.
  assert.ok(life.regions.get('brainstem').loaded, `${name}: brainstem never came up`)

  // Every loader that finished lit the region that owns it.
  for (const record of records) {
    if (record.kind !== 'stage' || record.status !== 'done') continue
    const owner = REGIONS.find((region) => region.stages.includes(record.name))
    if (!owner) continue
    assert.ok(peak.get(owner.key) > LIT, `${name}: stage ${record.name} did not light ${owner.key}`)
  }

  // And every kind that has a region behind it reached it.
  const expects = {
    hearing: 'auditory',
    verdict: 'thalamus',
    thinking: 'prefrontal',
    speaking: 'motor',
    filler: 'motor',
    wake: 'auditory',
  }
  for (const [kind, key] of Object.entries(expects)) {
    if (!kinds.has(kind)) continue
    assert.ok(peak.get(key) > LIT, `${name}: ${kind} did not light ${key}`)
  }
}

// ── The specific claims each fixture is here to make ────────────────────────

const boot = results.find((entry) => entry.name === 'boot.jsonl')
for (const region of REGIONS) {
  if (!region.live || !region.stages.length) continue
  assert.ok(boot.life.regions.get(region.key).loaded, `boot: ${region.key} never loaded`)
  assert.equal(boot.life.regions.get(region.key).failed, 0, `boot: ${region.key} failed`)
}

// A stage that died stays failed, and the reply that died is a bad turn on the
// prefrontal rather than a dead process on the brainstem.
const failed = results.find((entry) => entry.name === 'boot-fail.jsonl')
const dead = REGIONS.filter((region) => failed.life.regions.get(region.key).failed)
assert.ok(dead.length > 0, 'boot-fail: nothing is marked failed')
assert.equal(failed.life.regions.get('brainstem').failed, 0, 'boot-fail: the process is not dead')
assert.ok(failed.life.regions.get('brainstem').loaded, 'boot-fail: the process should still be up')

// A whole conversation: the traversal happens and the deque fills.
const session = results.find((entry) => entry.name === 'session.jsonl')
for (const key of ['auditory', 'thalamus', 'prefrontal', 'motor', 'hippocampus']) {
  assert.ok(session.peak.get(key) > LIT, `session: ${key} never lit`)
}
assert.ok(session.life.filled > 0, 'session: history never reached the hippocampus')
assert.ok(session.life.filled <= 4, 'session: more beads than the deque holds')

// ── Journal replay ──────────────────────────────────────────────────────────
//
// Reopening the window pushes the whole backlog through handle() in one tick.
// Nothing may pulse: no impulse, no traveller, no flare. The brain has to land
// on what Wren is doing now rather than replay the afternoon at once.

for (const name of names) {
  const life = createLife({ catchingUp: () => true })
  life.resume()
  for (const record of read(name)) life.handle(record)

  for (const [key, state] of life.regions) {
    assert.equal(state.impulse, 0, `${name}: ${key} queued an impulse while catching up`)
    assert.equal(state.now, state.hold, `${name}: ${key} did not land on its held value`)
  }
  for (const [key, travellers] of Object.entries(life.flows)) {
    assert.equal(travellers.length, 0, `${name}: pathway ${key} has travellers mid-replay`)
  }
  assert.equal(life.flare, 0, `${name}: the deque flared during replay`)
  assert.equal(life.filledNow, life.filled, `${name}: the deque is mid-animation after replay`)
}

// ── The exploded layout ─────────────────────────────────────────────────────
//
// The exploded view exists so that every region — the deep ones and the two
// dark ones especially — becomes individually visible. A region that comes
// apart into the middle of another one has not done that, and by the time you
// notice in a screenshot you are guessing at numbers. So it is asserted here:
// the vectors are plain arithmetic in view.js and this runs in Node.

// A patch is a thin curved tile, and which way it is thin depends on which way
// it faces — so a sphere around it would claim several times the space it
// occupies and force the layout to spread further than it needs to. This walks
// the same window scene.jsx builds the mesh from and takes the real box.
//
// The plain ellipsoid stands in for the folded surface; FOLD_HEADROOM covers the
// gyri, which push out by a few percent of the radius.
const FOLD_HEADROOM = 1.08

function patchExtent({ dir, spread, thickness }) {
  const { radii } = SHELL.parts[0]
  const norm = (v) => {
    const length = Math.hypot(...v)
    return v.map((component) => component / length)
  }
  const cross = (a, b) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ]

  const outward = norm(dir)
  const across = Math.abs(outward[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0]
  const right = norm(cross(across, outward))
  const up = norm(cross(outward, right))

  const lo = [Infinity, Infinity, Infinity]
  const hi = [-Infinity, -Infinity, -Infinity]
  const steps = 12
  for (let row = 0; row <= steps; row += 1) {
    for (let column = 0; column <= steps; column += 1) {
      const u = Math.sin(((column / steps) * 2 - 1) * spread[0])
      const v = Math.sin(((row / steps) * 2 - 1) * spread[1])
      const point = norm(outward.map((component, axis) => component + right[axis] * u + up[axis] * v))
      for (let axis = 0; axis < 3; axis += 1) {
        const value = point[axis] * radii[axis] * FOLD_HEADROOM
        lo[axis] = Math.min(lo[axis], value * (1 - thickness))
        hi[axis] = Math.max(hi[axis], value)
      }
    }
  }
  // Centred on the region's own anchor, so it slots into the symmetric box test
  // the other shapes use. Grown to cover, never to fit.
  return [0, 1, 2].map((axis) => (hi[axis] - lo[axis]) / 2)
}

/** Half-extents, per axis, of a region's placeholder mesh. */
function extent(shape) {
  if (shape.kind === 'blob') return shape.radii
  if (shape.kind === 'arc') {
    const reach = shape.radius + shape.tube
    return [reach, reach, shape.tube]
  }
  if (shape.kind === 'patch') return patchExtent(shape)
  // The turned stem, at its widest — which is the pons, not either end.
  const waist = Math.max(shape.top, shape.bottom) * 1.5
  return [waist, shape.height / 2, waist]
}

/** Every copy of every region, where it ends up once the brain is apart. */
const placed = []
for (const region of REGIONS) {
  const offset = explodeOffset(region)
  const length = Math.hypot(offset[0], offset[1], offset[2])
  // A region with no direction never leaves the middle, and everything else
  // comes apart around it. This is the assertion that catches the two regions
  // sitting on the centre if their override is ever dropped.
  assert.ok(Number.isFinite(length), `${region.key}: explode vector is not a number`)
  assert.ok(length > 0.2, `${region.key}: barely moves when the brain comes apart (${length.toFixed(3)})`)

  for (const side of region.mirror ? [1, -1] : [1]) {
    placed.push({
      key: region.key,
      shape: region.shape,
      at: [
        region.at[0] + offset[0],
        region.at[1] + offset[1],
        (region.at[2] + offset[2]) * side,
      ],
    })
  }
}

// Visibly apart, not merely not-intersecting.
const GAP = 0.12

for (let i = 0; i < placed.length; i += 1) {
  for (let j = i + 1; j < placed.length; j += 1) {
    const a = placed[i]
    const b = placed[j]
    if (a.key === b.key) {
      // The two copies of a paired structure. They only have to clear each
      // other across the midline.
      assert.ok(
        Math.abs(a.at[2] - b.at[2]) > 2 * extent(a.shape)[2] + GAP,
        `${a.key}: its two copies overlap on the midline`,
      )
      continue
    }

    // Boxes for the blobs and the stem, spheres for the two arcs — an arc is
    // rotated into place and its axis-aligned box would claim space it does not
    // occupy, which would fail regions that are genuinely clear.
    const round = a.shape.kind === 'arc' || b.shape.kind === 'arc'
    const ea = extent(a.shape)
    const eb = extent(b.shape)
    const apart = round
      ? Math.hypot(a.at[0] - b.at[0], a.at[1] - b.at[1], a.at[2] - b.at[2]) >
        Math.max(...ea) + Math.max(...eb) + GAP
      : [0, 1, 2].some((axis) => Math.abs(a.at[axis] - b.at[axis]) > ea[axis] + eb[axis] + GAP)

    assert.ok(apart, `exploded: ${a.key} and ${b.key} overlap`)
  }
}

// And it all has to still be in the frame. Spacing regions apart and pushing one
// off the top of the canvas is the same failure wearing a different face — and
// the fix for an overlap is usually to throw something further, so the two
// pressures pull against each other and both need to be written down.
const distance = Math.hypot(
  CAMERA.position[0] - CENTRE[0],
  CAMERA.position[1] - CENTRE[1],
  CAMERA.position[2] - CENTRE[2],
)
// Only the vertical. `fov` is the vertical half-angle, and the brain stage is a
// fixed 470px tall across the full width of the Mind view — so the horizontal is
// always the generous axis and the height is what runs out. Worst case, which is
// a region straight above or below the centre rather than the far corner.
const reach = distance * Math.tan(((CAMERA.fov / 2) * Math.PI) / 180)

for (const part of placed) {
  const bound = Math.max(...extent(part.shape))
  const far = Math.abs(EXPLODE_SCALE * part.at[1] + EXPLODE_SHIFT[1] - CENTRE[1]) + EXPLODE_SCALE * bound
  assert.ok(far < reach, `exploded: ${part.key} leaves the top or bottom of the frame (${far.toFixed(2)} of ${reach.toFixed(2)})`)
}

// ── Report ──────────────────────────────────────────────────────────────────

const width = Math.max(...REGIONS.map((region) => region.key.length))
for (const { name, records, peak } of results) {
  const lit = REGIONS.filter((region) => peak.get(region.key) > LIT).length
  console.log(`${name.padEnd(20)} ${String(records).padStart(3)} records | ${lit}/${REGIONS.length} lit`)
}
console.log()
for (const region of REGIONS) {
  const row = results.map(({ peak }) => peak.get(region.key).toFixed(2).padStart(5)).join(' ')
  console.log(`${region.key.padEnd(width)} ${region.live ? ' ' : '·'} ${row}`)
}
console.log(`\n${' '.repeat(width + 2)}${results.map((r) => r.name.replace('.jsonl', '').slice(0, 5).padStart(5)).join(' ')}`)
console.log('\nAll fixtures replay. Unbuilt regions never light.')
