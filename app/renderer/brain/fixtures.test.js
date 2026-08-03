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

import { REGIONS } from './atlas.js'
import { createLife } from './life.js'

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
