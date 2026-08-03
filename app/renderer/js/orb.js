// The orb.
//
// One canvas, seven states, used verbatim by the main window and the desktop orb
// — same code, different radius. There are no hard edges anywhere: every element
// is a radial gradient or a soft stroke, because the moment the orb has an
// outline it stops being a presence and becomes a circle.
//
// Nothing here cuts. State changes move targets, and every drawn value chases its
// target on an exponential approach, so the orb is always mid-transition rather
// than switching. That is the entire reason it reads as alive.

const TAU = Math.PI * 2

/** Frame-rate independent ease toward a target. `tau` is seconds to ~63%. */
function approach(current, target, tau, dt) {
  return current + (target - current) * (1 - Math.exp(-dt / tau))
}

function hex(value) {
  const clean = value.trim().replace('#', '')
  const full = clean.length === 3 ? clean.replace(/./g, (c) => c + c) : clean
  const n = parseInt(full, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function rgba([r, g, b], alpha) {
  return `rgba(${r | 0}, ${g | 0}, ${b | 0}, ${Math.max(0, Math.min(1, alpha))})`
}

function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

// How each state wants the orb to sit. `scale` is a multiple of the base radius,
// `glow` is overall brightness, `period` is the breath in seconds, `depth` is how
// far the breath swings.
const STATES = {
  loading: { scale: 0.42, glow: 0.5, period: 5.0, depth: 0.05 },
  idle: { scale: 1.0, glow: 0.82, period: 4.0, depth: 0.06 },
  engaged: { scale: 1.06, glow: 1.0, period: 4.0, depth: 0.07 },
  hearing: { scale: 1.12, glow: 1.08, period: 3.0, depth: 0.03 },
  thinking: { scale: 0.86, glow: 0.95, period: 0.62, depth: 0.09 },
  speaking: { scale: 1.18, glow: 1.25, period: 2.2, depth: 0.05 },
}

// The ring — boot sweep and engagement both live on this circle, in that order.
// One object with two jobs rather than two rings that happen to look alike.
const RING = 1.62
const SEGMENTS = 90

export function createOrb(canvas, options = {}) {
  const context = canvas.getContext('2d')
  const styles = getComputedStyle(document.documentElement)
  const palette = {
    glow: hex(styles.getPropertyValue('--glow') || '#c9a7ff'),
    hot: hex(styles.getPropertyValue('--glow-hot') || '#ebdcff'),
    deep: hex(styles.getPropertyValue('--glow-deep') || '#7b5fb0'),
    cool: hex(styles.getPropertyValue('--cool') || '#6e8fa8'),
    fail: hex(styles.getPropertyValue('--fail') || '#e0776a'),
  }

  const base = {
    radiusRatio: options.radiusRatio ?? 0.16, // Of the smaller canvas dimension
    centre: options.centre ?? { x: 0.5, y: 0.5 },
    // How far the bloom carries, as a multiple of the orb's radius. The desktop
    // orb runs tighter than the window one: a 100px halo is a lot of light to
    // leave sitting on someone's screen, and the tighter field is what lets the
    // whole effect terminate inside a window small enough to place at an edge.
    bloomReach: options.bloomReach ?? 3.6,
  }

  let width = 0
  let height = 0
  let dpr = 1

  // Per-instance, because `loading` is rewritten as Wren assembles and the two
  // surfaces each own their own orb.
  const profiles = Object.fromEntries(
    Object.entries(STATES).map(([name, values]) => [name, { ...values }]),
  )

  const now = { ...profiles.loading, tint: 0, ring: 0, level: 0 }
  let state = 'loading'
  let target = { ...profiles.loading }

  let phase = 0 // Breath phase, advanced by dt/period so period changes don't jump
  let tintTarget = 0 // 0 = glow, 1 = cool (a rejected utterance)
  let level = 0 // Mic level, 0..1
  let levelTarget = 0

  // Mood is designed in but has no source yet — pinned neutral. When something
  // upstream produces one, the orb picks it up with no further work here.
  let mood = { warmth: 0.5, energy: 0.5 }

  let engagement = null // { until, duration } — the depleting attention ring
  const waves = [] // Speaking blooms, outward
  const ripples = [] // Hearing, inward

  // The boot sweep. One lap = fully loaded.
  let sweep = 0
  let sweepTarget = 0
  let sweepAlpha = 0
  let sweepAlphaTarget = 1 // Visible from the first frame: Wren starts loading
  let stalled = false
  let failed = false // A subsystem didn't load; the head stops and goes red
  let closed = false // The lap has completed; flash, then fade out
  let flash = 0

  let muted = false // Mic off upstream — drawn as a bar across the orb
  let mute = 0 // Chases `muted`, so it slides in rather than appearing

  function resize() {
    const rect = canvas.getBoundingClientRect()
    dpr = Math.min(window.devicePixelRatio || 1, 2)
    width = rect.width
    height = rect.height
    canvas.width = Math.round(width * dpr)
    canvas.height = Math.round(height * dpr)
    context.setTransform(dpr, 0, 0, dpr, 0, 0)
  }

  const observer = new ResizeObserver(resize)
  observer.observe(canvas)
  resize()

  function baseRadius() {
    return Math.min(width, height) * base.radiusRatio
  }

  function draw(time, dt) {
    context.clearRect(0, 0, width, height)
    if (!width || !height) return

    // ── Chase every target ────────────────────────────────────────────────────
    now.scale = approach(now.scale, target.scale, 0.22, dt)
    now.glow = approach(now.glow, target.glow, 0.28, dt)
    now.period = approach(now.period, target.period, 0.35, dt)
    now.depth = approach(now.depth, target.depth, 0.3, dt)
    now.tint = approach(now.tint, tintTarget, 0.18, dt)
    level = approach(level, levelTarget, 0.09, dt)

    phase += dt / now.period
    const breath = Math.sin(phase * TAU)

    const cx = width * base.centre.x
    const cy = height * base.centre.y
    const r0 = baseRadius()

    // Every effect must terminate inside the canvas. On the transparent desktop
    // window a gradient clipped by the canvas edge leaves a flat straight cut —
    // which is exactly what a faint rectangle on your desktop is made of. This
    // is the hard guarantee that nothing ever paints the boundary again.
    const field = Math.min(width, height) * 0.5

    // Breathing, plus whatever the mic is hearing on top of it.
    const swell = 1 + breath * now.depth + level * 0.14
    const radius = r0 * now.scale * swell
    const glow = now.glow * (1 + breath * now.depth * 0.9)

    // Warmth shifts the core between lavender and its highlight; energy is
    // reserved for the breath rate. Both are neutral until a mood signal exists.
    const warm = mix(palette.glow, palette.hot, mood.warmth * 0.35)
    const core = mix(warm, palette.cool, now.tint)
    const deep = mix(palette.deep, palette.cool, now.tint)

    context.save()
    context.globalCompositeOperation = 'lighter'

    // ── Bloom ─────────────────────────────────────────────────────────────────
    // A wide, low-alpha field. This is what lights the space around the orb and
    // keeps it from looking pasted onto the background. Its alpha is lower than
    // it was on near-black: on Dusk the same values washed out rather than glowed.
    const bloomRadius = Math.min(radius * base.bloomReach, field)
    const bloom = context.createRadialGradient(cx, cy, radius * 0.2, cx, cy, bloomRadius)
    bloom.addColorStop(0, rgba(core, 0.23 * glow))
    bloom.addColorStop(0.24, rgba(core, 0.1 * glow))
    bloom.addColorStop(0.58, rgba(deep, 0.038 * glow))
    bloom.addColorStop(1, rgba(deep, 0))
    context.fillStyle = bloom
    context.beginPath()
    context.arc(cx, cy, bloomRadius, 0, TAU)
    context.fill()

    // ── Body ──────────────────────────────────────────────────────────────────
    // The stop at 0.52 is what gives the orb mass; without it the gradient falls
    // off evenly and reads as a blur rather than an object.
    const body = context.createRadialGradient(
      cx - radius * 0.14, cy - radius * 0.18, radius * 0.04,
      cx, cy, radius * 1.3,
    )
    body.addColorStop(0, rgba(mix(core, palette.hot, 0.75), Math.min(1, 1.35 * glow)))
    body.addColorStop(0.2, rgba(mix(core, palette.hot, 0.3), Math.min(1, 1.15 * glow)))
    body.addColorStop(0.52, rgba(core, 0.8 * glow))
    body.addColorStop(0.8, rgba(deep, 0.24 * glow))
    body.addColorStop(1, rgba(deep, 0))
    context.fillStyle = body
    context.beginPath()
    context.arc(cx, cy, radius * 1.3, 0, TAU)
    context.fill()

    // A small, tight specular. It is the difference between something lit from
    // within and a soft patch of colour — the eye reads the hot point as the
    // source and everything else as falloff.
    const spec = radius * 0.4
    const sx = cx - radius * 0.2
    const sy = cy - radius * 0.26
    const specular = context.createRadialGradient(sx, sy, 0, sx, sy, spec)
    specular.addColorStop(0, rgba(palette.hot, Math.min(1, 0.66 * glow)))
    specular.addColorStop(1, rgba(palette.hot, 0))
    context.fillStyle = specular
    context.beginPath()
    context.arc(sx, sy, spec, 0, TAU)
    context.fill()

    drawRipples(cx, cy, radius, glow, core, field, dt)
    drawWaves(cx, cy, radius, glow, core, field, dt)
    drawSweep(cx, cy, radius, core, dt, time)

    context.restore()

    drawEngagement(cx, cy, radius, core, dt)
    drawMute(cx, cy, radius, dt)
  }

  // Muted. Cut out of everything already drawn rather than painted over it, so
  // the mark reads the same on the main window's background and on whatever
  // arbitrary desktop the orb is floating above. A slash through a light is the
  // one "off" symbol nobody has to learn.
  function drawMute(cx, cy, radius, dt) {
    mute = approach(mute, muted ? 1 : 0, 0.16, dt)
    if (mute < 0.01) return

    const reach = radius * 1.5 * mute
    const angle = -Math.PI / 4
    const dx = Math.cos(angle) * reach
    const dy = Math.sin(angle) * reach

    context.save()
    context.globalCompositeOperation = 'destination-out'
    context.lineCap = 'round'
    context.lineWidth = Math.max(2.5, radius * 0.17)
    context.strokeStyle = rgba([0, 0, 0], mute)
    context.beginPath()
    context.moveTo(cx - dx, cy - dy)
    context.lineTo(cx + dx, cy + dy)
    context.stroke()
    context.restore()
  }

  // Hearing: rings travelling *inward*, as though the orb were drawing your voice
  // in. Outward would read as Wren speaking, which is the opposite.
  function drawRipples(cx, cy, radius, glow, core, field, dt) {
    for (let i = ripples.length - 1; i >= 0; i -= 1) {
      const ripple = ripples[i]
      ripple.t += dt / ripple.life
      if (ripple.t >= 1) {
        ripples.splice(i, 1)
        continue
      }
      const eased = ripple.t * ripple.t * (3 - 2 * ripple.t)
      const r = Math.min(radius * (2.5 - eased * 1.55), field - 2)
      const alpha = Math.sin(ripple.t * Math.PI) * 0.3 * ripple.strength * glow
      context.strokeStyle = rgba(core, alpha)
      context.lineWidth = 1.4 + ripple.strength
      context.beginPath()
      context.arc(cx, cy, r, 0, TAU)
      context.stroke()
    }
  }

  // Speaking: blooms outward on each chunk. One per chunk, so a long reply
  // visibly pushes more of them than a short one.
  function drawWaves(cx, cy, radius, glow, core, field, dt) {
    for (let i = waves.length - 1; i >= 0; i -= 1) {
      const wave = waves[i]
      wave.t += dt / wave.life
      if (wave.t >= 1) {
        waves.splice(i, 1)
        continue
      }
      const eased = 1 - Math.pow(1 - wave.t, 2.4)
      const r = Math.min(radius * (1 + eased * 1.9), field)
      const alpha = (1 - wave.t) * 0.26 * wave.strength * glow
      const gradient = context.createRadialGradient(cx, cy, r * 0.82, cx, cy, r)
      gradient.addColorStop(0, rgba(core, 0))
      gradient.addColorStop(0.7, rgba(core, alpha))
      gradient.addColorStop(1, rgba(core, 0))
      context.fillStyle = gradient
      context.beginPath()
      context.arc(cx, cy, r, 0, TAU)
      context.fill()
    }
  }

  // Boot: one ring, one lap. It advances only when a subsystem has genuinely
  // landed — Wren can measure *which* stage finished but has no honest number
  // inside a stage, since the two big weight loads report nothing until they are
  // done. So the arc is determinate and never creeps, and the shimmering head is
  // the indeterminate half: the ring says how far in we are, the head says Wren
  // is still working.
  function drawSweep(cx, cy, radius, core, dt, time) {
    sweepAlpha = approach(sweepAlpha, sweepAlphaTarget, 0.4, dt)
    if (sweepAlpha < 0.004) return

    // Faster on the final lap so `ready` doesn't arrive before the ring closes.
    sweep = approach(sweep, sweepTarget, sweepTarget >= 1 ? 0.3 : 0.5, dt)
    flash = approach(flash, 0, 0.3, dt)

    if (!closed && sweepTarget >= 1 && sweep > 0.985) {
      closed = true
      flash = 1
      setTimeout(() => {
        sweepAlphaTarget = 0
      }, 420)
    }

    const r = radius * RING
    const start = -Math.PI / 2
    const step = (TAU * sweep) / SEGMENTS

    // The unfilled remainder, so the lap has a track to run around and you can
    // see how much of Wren is still to come.
    context.lineWidth = 1.4
    context.strokeStyle = rgba(core, 0.05 * sweepAlpha)
    context.beginPath()
    context.arc(cx, cy, r, 0, TAU)
    context.stroke()

    // Canvas can't gradient along an arc, so the tail-to-head ramp is drawn as
    // short overlapping segments. Ninety strokes is nothing.
    context.lineWidth = 1.8 + flash * 1.2
    context.lineCap = 'butt'
    for (let i = 0; i < SEGMENTS && step > 0; i += 1) {
      const t = i / (SEGMENTS - 1)
      const a0 = start + step * i
      const alpha = (0.1 + 0.72 * Math.pow(t, 1.6) + flash * 0.5) * sweepAlpha
      context.strokeStyle = rgba(mix(core, palette.hot, 0.3 + t * 0.45), alpha)
      context.beginPath()
      context.arc(cx, cy, r, a0, a0 + step * 1.08)
      context.stroke()
    }

    // The head. Shimmers while a stage is in flight; slower and deeper when the
    // stage has genuinely stalled, which is the only signal that a first-run
    // download is running rather than that Wren has hung. When a stage has
    // actually failed it stops moving altogether and goes red — a head still
    // breathing over a load that has given up is the animation lying.
    const rate = stalled ? 0.55 : 1.6
    const wobble = stalled ? 0.4 : 0.24
    // Once the lap closes the head stops working and simply fades with the ring.
    const shimmer = closed || failed ? 1 : 1 - wobble + wobble * Math.sin(time * TAU * rate)
    const angle = start + TAU * sweep
    const hx = cx + Math.cos(angle) * r
    const hy = cy + Math.sin(angle) * r
    const headR = stalled || failed ? 9 : 7
    const tip = failed ? palette.fail : palette.hot
    const halo = failed ? palette.fail : core
    const head = context.createRadialGradient(hx, hy, 0, hx, hy, headR)
    head.addColorStop(0, rgba(tip, 0.95 * shimmer * sweepAlpha))
    head.addColorStop(0.4, rgba(halo, 0.42 * shimmer * sweepAlpha))
    head.addColorStop(1, rgba(halo, 0))
    context.fillStyle = head
    context.beginPath()
    context.arc(hx, hy, headR, 0, TAU)
    context.fill()
  }

  // The follow-up window, made visible for the first time. `engaged_until` is
  // real state upstream that you currently cannot see at all — so you never know
  // whether you still have Wren's attention without saying her name to find out.
  // Same circle the boot sweep ran around: it fills once, then depletes forever.
  function drawEngagement(cx, cy, radius, core, dt) {
    const wanted = engagement ? 1 : 0
    now.ring = approach(now.ring, wanted, 0.3, dt)
    if (now.ring < 0.01) return

    let remaining = 1
    if (engagement) {
      remaining = Math.max(0, (engagement.until - performance.now() / 1000) / engagement.duration)
      if (remaining <= 0) engagement = null
    }

    const r = radius * RING
    context.save()
    context.lineWidth = 1.5
    context.lineCap = 'round'

    context.strokeStyle = rgba(core, 0.07 * now.ring)
    context.beginPath()
    context.arc(cx, cy, r, 0, TAU)
    context.stroke()

    context.strokeStyle = rgba(core, 0.42 * now.ring)
    context.beginPath()
    context.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + TAU * remaining)
    context.stroke()
    context.restore()
  }

  let last = performance.now()
  let running = true
  function frame(time) {
    if (!running) return
    const dt = Math.min(0.05, (time - last) / 1000) // Clamp so a stalled tab can't jump
    last = time
    draw(time / 1000, dt)
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)

  return {
    setState(next) {
      if (!profiles[next] || next === state) return
      state = next
      target = { ...profiles[next] }
      if (next !== 'hearing') levelTarget = 0
    },

    get state() {
      return state
    },

    /** A rejected utterance: one quick cool flicker, then back to the core hue. */
    flicker() {
      tintTarget = 1
      setTimeout(() => {
        tintTarget = 0
      }, 260)
    },

    /** Mic level, 0..1. Drives both the swell and how hard the ripples read. */
    setLevel(value) {
      levelTarget = Math.max(0, Math.min(1, value))
      if (state === 'hearing' && ripples.length < 5) {
        ripples.push({ t: 0, life: 1.15, strength: 0.45 + levelTarget * 0.9 })
      }
    },

    /** One bloom per spoken chunk. */
    pulse(strength = 1) {
      waves.push({ t: 0, life: 1.5, strength })
    },

    /** Seconds of attention remaining, and the full window it is counting down from. */
    setEngagement(seconds, duration) {
      engagement = seconds > 0
        ? { until: performance.now() / 1000 + seconds, duration: duration || seconds }
        : null
    },

    /**
     * How much of Wren is loaded, 0..1. Drives the sweep and the orb's own
     * growth from a single number, so the ring and the body can never disagree
     * about how far along the load is.
     */
    setProgress(fraction) {
      const eased = Math.max(0, Math.min(1, fraction))
      sweepTarget = eased
      profiles.loading.scale = 0.36 + eased * 0.52
      profiles.loading.glow = 0.38 + eased * 0.44
      if (state === 'loading') target = { ...profiles.loading }
    },

    /** Hold the head shimmering: this stage genuinely is not progressing. */
    setStalled(on) {
      stalled = Boolean(on)
    },

    /** A subsystem didn't load. The head stops and goes red; the arc holds. */
    setFailed(on) {
      failed = Boolean(on)
      if (failed) stalled = false
    },

    /**
     * Take the ring away without the closing flash. Used when the load finishes
     * with a casualty: the lap genuinely did not complete, and flashing it shut
     * would claim otherwise.
     */
    dismissSweep() {
      closed = true
      sweepAlphaTarget = 0
    },

    /** Mic off upstream. Never set from a click — only from what Wren reports. */
    setMuted(on) {
      muted = Boolean(on)
    },

    get muted() {
      return muted
    },

    /** Boot finished: one slow, deliberate full breath before settling. */
    settle() {
      phase = 0.25 // Start the exhale from the top, so `ready` reads as a sigh
      stalled = false
      // Not when something failed: racing the arc to full while it fades out
      // would claim the lap completed during the one second you can still see it.
      if (!failed) sweepTarget = 1
      target = { ...profiles.idle, scale: 1.32, glow: 1.2 }
      setTimeout(() => {
        if (state === 'idle') target = { ...profiles.idle }
      }, 1400)
    },

    setMood(next) {
      mood = { ...mood, ...next }
    },

    destroy() {
      running = false
      observer.disconnect()
    },
  }
}
