// The main window.

import { createOrb } from './orb.js'
import { createBoot } from './boot.js'
import { createPresence } from './presence.js'
import { createTranscript } from './transcript.js'
import { createTelemetry } from './telemetry.js'
import { createMind } from './mind.js'
import { createDev } from './dev.js'

const stage = document.getElementById('stage')
const word = document.getElementById('state-word')
const stopButton = document.getElementById('control-stop')
const muteButton = document.getElementById('control-mute')

const command = (kind, fields = {}) => window.wren.command({ kind, ...fields })

// The ratio is what decides how much of its band the orb fills, and the band is
// set per view in breath.css. Raised from 0.1 when the two views got their own
// sizes: on the conversation Wren should be bigger than she used to be, and the
// band cannot grow to do that on its own without pushing the transcript down.
const orb = createOrb(document.getElementById('orb'), { radiusRatio: 0.14 })
const boot = createBoot({
  stage,
  word,
  failures: document.getElementById('failures'),
  retry: (name) => command('retry', { stage: name }),
})
const transcript = createTranscript(document.getElementById('transcript'), {
  retry: (text) => command('retry', { text }),
})
const mind = createMind(document.getElementById('mind'))

const telemetry = createTelemetry({
  root: document.getElementById('telemetry'),
  toggle: document.getElementById('telemetry-toggle'),
  body: document.getElementById('telemetry-body'),
  glance: document.getElementById('telemetry-glance'),
})

// Once Wren is ready the word belongs to the presence, not the boot sequence.
// Presence also owns the load: it drives the ring on both surfaces and decides
// when a stage has stalled, and boot only writes the label for it.
const presence = createPresence(orb, {
  onStall: (name, on) => boot.onStall(name, on),
  onMute: (on) => {
    muteButton.dataset.on = String(on)
    muteButton.textContent = on ? 'Muted' : 'Mute'
  },
  onWord: (text) => {
    if (!boot.finished) return
    if (word.textContent === text) return
    word.classList.add('is-fading')
    setTimeout(() => {
      word.textContent = text
      word.classList.remove('is-fading')
    }, 180)
  },
})

// ── Views ──────────────────────────────────────────────────────────────────────
//
// How much of the room Wren takes. On the conversation she has it — she is the
// thing you are talking to, and she holds her size while you read. On the Mind
// page she steps back to a small light above it and only comes forward again
// when there is something to come forward for. Muted
// she recedes furthest: nothing is going to happen, and the orb should not sit
// there at full size implying otherwise.
//
// The band around her shrinks in CSS at the same time. This is the second half:
// the band is the page's business, this is Wren's.

const BUSY = new Set(['hearing', 'thinking', 'speaking'])

function refocus() {
  if (stage.dataset.view !== 'mind') {
    orb.setFocus(1)
    return
  }
  orb.setFocus(orb.muted ? 0.6 : BUSY.has(orb.state) ? 1 : 0.78)
}

for (const tab of document.querySelectorAll('.view-tab')) {
  tab.addEventListener('click', () => {
    const next = tab.dataset.view
    if (stage.dataset.view === next) return
    stage.dataset.view = next
    for (const other of document.querySelectorAll('.view-tab')) {
      other.classList.toggle('is-active', other === tab)
    }
    document.getElementById('view-talk').classList.toggle('is-shown', next === 'talk')
    document.getElementById('view-mind').classList.toggle('is-shown', next === 'mind')
    refocus()
  })
}

refocus()

// ── Controls ───────────────────────────────────────────────────────────────────
// Stop is only offered while there is something to stop; a permanently visible
// Stop that does nothing most of the time teaches you to ignore it.

stopButton.addEventListener('click', () => command('stop'))
muteButton.addEventListener('click', () => command('mute'))

// ⌘⇧M rather than ⌘M: Electron's default macOS menu owns ⌘M for Minimize and the
// app menu takes the accelerator before the renderer ever sees the key.
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    command('stop')
    return
  }
  if (event.key.toLowerCase() === 'm' && event.shiftKey && (event.metaKey || event.ctrlKey)) {
    event.preventDefault()
    command('mute')
  }
})

// ── Events ─────────────────────────────────────────────────────────────────────

function handle(record) {
  presence.handle(record)
  stopButton.hidden = orb.state !== 'speaking'
  // Every record, because any of them can change the state or the mute flag that
  // this reads. It sets a number; the orb eases toward it on its own clock.
  refocus()

  switch (record.kind) {
    case 'stage':
      boot.onStage(record)
      break

    case 'ready':
      boot.onReady()
      telemetry.ready(record)
      break

    case 'personality':
      mind.personality(record)
      break

    case 'history':
      mind.history(record)
      break

    case 'verdict':
      telemetry.verdict(record)
      if (record.accepted) transcript.accept(record)
      else transcript.reject(record)
      break

    case 'thinking':
      transcript.thinking()
      break

    case 'filler':
      transcript.filler(record.text)
      break

    case 'speaking':
      transcript.speaking(record.chunk)
      break

    case 'spoke':
      transcript.spoke(record)
      telemetry.spoke(record)
      break

    case 'error':
      transcript.fail(record.message)
      break

    default:
      break
  }
}

window.wren.onEvent(handle)

// Anything that happened while this window was closed. The orb keeps Wren
// running with no window at all, so reopening has to catch up rather than start
// from an empty transcript.
window.wren.journal().then((past) => {
  if (!past.length) return
  document.body.classList.add('is-catching-up')
  for (const record of past) handle(record)
  requestAnimationFrame(() => document.body.classList.remove('is-catching-up'))
})

createDev(document.getElementById('dev'), {
  stages: boot.stages,
  inject: (record) => window.wren.dev.inject(record),
})
