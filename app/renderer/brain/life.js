// Activity.
//
// The event stream, reduced to a number per region. This is the whole of what
// `handle(record)` does; the scene only reads the result and writes it onto
// materials. Keeping it here — plain JS, no three, no react, no DOM — means the
// fixtures can be replayed through it in Node, which is the parity check that
// matters: the picture may change, what lights must not.
//
// Ported unchanged from the 2D brain. Rise fast, fall slow, and nothing cuts.

import { REGIONS, PATHWAYS } from './atlas.js'

/** Frame-rate independent ease toward a target. `tau` is seconds to ~63%. */
export function approach(current, target, tau, dt) {
  return current + (target - current) * (1 - Math.exp(-dt / tau))
}

// Which stage failing puts which region into the failed look. Derived from the
// atlas rather than restated, so a region that changes hands only changes there.
const REGION_BY_STAGE = new Map()
for (const region of REGIONS) {
  for (const stage of region.stages) REGION_BY_STAGE.set(stage, region.key)
}

export function createLife({ catchingUp = () => false } = {}) {
  // `hold` is a level a state record sets and its counterpart clears. `impulse`
  // is set by a discrete event and decays. Drawn activation chases the larger of
  // the two.
  //
  // `failed` is a stage that did not load and stays that way until a retry.
  // `hurt` is a turn that went wrong and fades — the difference between a
  // subsystem being absent and one having a bad moment.
  const regions = new Map()
  for (const region of REGIONS) {
    regions.set(region.key, {
      now: 0,
      hold: 0,
      impulse: 0,
      loaded: false,
      failed: 0,
      hurt: 0,
      tint: 0,
      tintTarget: 0,
    })
  }

  const flows = Object.fromEntries(Object.keys(PATHWAYS).map((key) => [key, []]))

  const life = {
    regions,
    flows,
    running: false,
    clock: 0,
    level: 0,
    levelTarget: 0,
    filled: 0, // Hippocampus beads occupied, 0..4
    filledNow: 0,
    flare: 0, // The newest bead, flaring
    speakingUntil: 0,
  }

  // Nothing accumulates while the loop is stopped — impulses only decay in
  // advance(), so one queued behind a hidden tab would be arbitrarily stale.
  function fire(key, strength = 1) {
    const state = regions.get(key)
    if (!state || !life.running || catchingUp()) return
    state.impulse = Math.max(state.impulse, strength)
  }

  function hold(key, value) {
    const state = regions.get(key)
    if (!state) return
    state.hold = value
    if (catchingUp()) state.now = value
  }

  function send(key, lands, duration = 0.45) {
    if (!life.running || catchingUp()) return
    flows[key].push({ t: 0, lands, duration })
  }

  // ── Events ──────────────────────────────────────────────────────────────────

  life.handle = function handle(record) {
    switch (record.kind) {
      case 'stage': {
        const key = REGION_BY_STAGE.get(record.name)
        // Anything loading at all means the process is up.
        regions.get('brainstem').loaded = true
        hold('brainstem', 0.18)
        if (!key) break
        const state = regions.get(key)
        if (record.status === 'done') {
          state.loaded = true
          state.failed = 0
          fire(key, 0.9)
        } else if (record.status === 'error') {
          state.failed = 1
          state.loaded = false
        }
        break
      }

      case 'ready':
        for (const region of REGIONS) {
          if (!region.live || !region.stages.length) continue
          const state = regions.get(region.key)
          if (!state.failed) state.loaded = true
        }
        for (const name of record.failed ?? []) {
          const key = REGION_BY_STAGE.get(name)
          if (key) regions.get(key).failed = 1
        }
        hold('brainstem', 0.18)
        hold('cerebellum', 0.14)
        break

      // A reply that failed, not a process that died — wren_v1 emits this from
      // the responder's exception handler and carries on. It belongs on the part
      // that could not answer, and it fades.
      case 'error':
        hold('prefrontal', 0)
        hold('motor', 0)
        life.speakingUntil = 0
        regions.get('prefrontal').hurt = 1
        fire('prefrontal', 0.8)
        break

      case 'level':
        life.levelTarget = Math.max(0, Math.min(1, record.rms ?? 0))
        break

      case 'hearing':
        hold('auditory', record.on ? 0.8 : 0)
        hold('voiceprint', record.on ? 0.3 : 0)
        if (!record.on) life.levelTarget = 0
        break

      case 'wake':
        fire('auditory', 1)
        send('hear', 'thalamus', 0.4)
        break

      case 'verdict': {
        const state = regions.get('thalamus')
        state.tintTarget = record.accepted ? 0 : 1
        fire('thalamus', 1)
        // Voiceprint brightness is the similarity itself, not a fixed flash.
        fire('voiceprint', Math.max(0.25, Math.min(1, record.score ?? 0)))
        if (record.accepted) send('judge', 'prefrontal', 0.5)
        hold('auditory', 0)
        break
      }

      case 'thinking':
        hold('prefrontal', 0.9)
        break

      case 'filler':
        fire('motor', 0.7)
        break

      case 'speaking':
        if (!life.speakingUntil) send('speak', 'motor', 0.35)
        hold('motor', 0.85)
        hold('cerebellum', 0.5)
        life.speakingUntil = life.clock + 4
        fire('motor', 1)
        break

      case 'spoke':
        hold('prefrontal', 0)
        // The mouth stays busy for as long as there is audio left to play.
        life.speakingUntil = life.clock + Math.max(0.6, record.audio_seconds ?? 1)
        break

      case 'history': {
        const messages = record.messages ?? []
        const next = Math.min(4, Math.ceil(messages.length / 2))
        if (next > life.filled && !catchingUp()) {
          send('store', 'hippocampus', 0.7)
          life.flare = 1
        }
        life.filled = next
        if (catchingUp()) life.filledNow = next
        hold('hippocampus', next ? 0.35 : 0)
        hold('motor', 0)
        hold('cerebellum', 0.14)
        life.speakingUntil = 0
        break
      }

      default:
        break
    }
  }

  // ── Time ────────────────────────────────────────────────────────────────────

  life.advance = function advance(dt) {
    life.clock += dt
    life.level = approach(life.level, life.levelTarget, 0.09, dt)
    life.filledNow = approach(life.filledNow, life.filled, 0.3, dt)
    life.flare = approach(life.flare, 0, 0.5, dt)
    if (life.speakingUntil && life.clock > life.speakingUntil) {
      regions.get('motor').hold = 0
      life.speakingUntil = 0
    }

    for (const region of REGIONS) {
      const state = regions.get(region.key)
      state.impulse = approach(state.impulse, 0, 0.9, dt)
      const wanted = Math.max(state.hold, state.impulse)
      // Falling is slower than rising: a region that has just fired should still
      // be visibly warm a moment later, the way the orb stays mid-transition.
      state.now = approach(state.now, wanted, wanted > state.now ? 0.14 : 0.55, dt)
      state.tint = approach(state.tint, state.tintTarget, 0.22, dt)
      state.hurt = approach(state.hurt, 0, 0.8, dt)
    }

    // Travellers. When one reaches the far end it lands as an impulse there.
    for (const key of Object.keys(flows)) {
      const travellers = flows[key]
      for (let index = travellers.length - 1; index >= 0; index -= 1) {
        const traveller = travellers[index]
        traveller.t += dt / traveller.duration
        if (traveller.t >= 1) {
          fire(traveller.lands, 1)
          travellers.splice(index, 1)
        }
      }
    }
  }

  // Resuming snaps rather than animating: the brain should look like whatever
  // Wren is doing now, not replay the conversation that happened while the tab
  // was hidden.
  //
  // Impulses are dropped rather than snapped to. They only decay while the loop
  // runs, so an impulse that arrived while this was hidden is however old the tab
  // is — restoring it would light every region that has fired since you last
  // looked, all at once.
  life.resume = function resume() {
    for (const state of regions.values()) {
      state.impulse = 0
      state.now = state.hold
      state.tint = state.tintTarget
    }
    for (const key of Object.keys(flows)) flows[key].length = 0
    life.filledNow = life.filled
    life.flare = 0
    life.running = true
  }

  life.pause = function pause() {
    life.running = false
  }

  return life
}
