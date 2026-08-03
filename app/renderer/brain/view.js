// What you are looking at.
//
// `life` is what Wren is doing; this is what the user has asked the picture to
// do about it. Kept apart on purpose: the brain has one state that arrives from
// the event stream and one that arrives from a click, and mixing them would put
// interaction state inside the module the fixtures replay through.
//
// Plain numbers, no three and no DOM, so the layout can be asserted in Node —
// which is what makes the explode vectors tunable rather than guessed at.

import { CENTRE, REGIONS } from './atlas.js'

// How far a region travels from the brain's centre when it comes apart. In brain
// units, where the whole cerebrum is about two across.
export const EXPLODE_DISTANCE = 0.8

// The transition, either direction. Long enough to read as one thing coming
// apart rather than a cut, short enough that it is not a wait.
export const EXPLODE_SECONDS = 0.6

// The rig shrinks as it opens. Exploded, the parts span roughly twice what the
// assembled brain does, and the camera sits close enough that they would leave
// the frame — so the whole assembly scales down by about as much as it spreads
// out. Doing it here rather than dollying the camera leaves OrbitControls alone
// and keeps whatever zoom the user chose.
//
// The ceiling is around 0.54: past that the topmost region clears the top of a
// 380px stage. fixtures.test.js checks it against the camera, so this and the
// vectors in the atlas cannot drift apart quietly.
export const EXPLODE_SCALE = 0.5

/** Ease with zero velocity at both ends, so nothing starts or stops abruptly. */
function smootherstep(t) {
  return t * t * t * (t * (t * 6 - 15) + 10)
}

/** The smallest thing that can tell React something changed without a race: a
 *  setter that exists from the first line, whether or not React has mounted. */
export function createSwitch(initial) {
  let value = initial
  const listeners = new Set()
  return {
    get: () => value,
    set(next) {
      if (next === value) return
      value = next
      for (const listener of listeners) listener()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

/** Assembled ↔ exploded. React subscribes to the boolean; the frame loop reads
 *  `amount` directly, so the animation never re-renders anything. */
export function createView() {
  const open = createSwitch(false)
  let progress = 0 // Linear 0..1, so the duration is exactly EXPLODE_SECONDS
  let eased = 0

  return {
    get: open.get,
    subscribe: open.subscribe,
    set: open.set,

    /** 0 assembled, 1 fully apart, eased. */
    get amount() {
      return eased
    },

    advance(dt) {
      const step = dt / EXPLODE_SECONDS
      const wanted = open.get() ? progress + step : progress - step
      progress = Math.max(0, Math.min(1, wanted))
      eased = smootherstep(progress)
    },

    // Coming back to the Mind tab lands on the current state rather than playing
    // a transition that was interrupted by leaving.
    snap() {
      progress = open.get() ? 1 : 0
      eased = progress
    },
  }
}

/**
 * Where a region sits when the brain is apart, relative to where it sits when
 * assembled. Outward from the centre by default — which is what makes the
 * exploded form still read as a brain rather than a shelf of parts — with the
 * atlas free to override the direction for anything the default cannot place.
 */
export function explodeOffset(region) {
  const direction = region.explode ?? [
    region.at[0] - CENTRE[0],
    region.at[1] - CENTRE[1],
    region.at[2] - CENTRE[2],
  ]
  const length = Math.hypot(direction[0], direction[1], direction[2])
  // A region sitting on the centre has no direction to travel in. The atlas
  // gives those an explicit one; this is only here so a missing override is a
  // region that stays put rather than a NaN that removes it from the scene.
  if (length < 1e-6) return [0, 0, 0]
  const reach = (EXPLODE_DISTANCE * (region.spread ?? 1)) / length
  return [direction[0] * reach, direction[1] * reach, direction[2] * reach]
}

/**
 * Where the rig has to sit for the exploded parts to be centred on the point the
 * camera is looking at.
 *
 * The vectors are chosen so regions clear each other, not so they balance, and
 * more of the brain hangs below the middle than above it — left alone, opening
 * it drops the whole picture toward the bottom of the frame. Derived rather than
 * dialled in, so retuning a vector re-centres the composition instead of
 * quietly knocking it askew.
 */
export const EXPLODE_SHIFT = (() => {
  const sum = [0, 0, 0]
  let copies = 0
  for (const region of REGIONS) {
    const offset = explodeOffset(region)
    // Both copies of a paired structure: their ±Z cancels, which is the point.
    for (const side of region.mirror ? [1, -1] : [1]) {
      sum[0] += region.at[0] + offset[0]
      sum[1] += region.at[1] + offset[1]
      sum[2] += (region.at[2] + offset[2]) * side
      copies += 1
    }
  }
  return sum.map((total, axis) => CENTRE[axis] - (EXPLODE_SCALE * total) / copies)
})()
