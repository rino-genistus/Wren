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

const orb = createOrb(document.getElementById('orb'), { radiusRatio: 0.1 })
const boot = createBoot({ stage, word })
const transcript = createTranscript(document.getElementById('transcript'))
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
  })
}

// ── Events ─────────────────────────────────────────────────────────────────────

function handle(record) {
  presence.handle(record)

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
