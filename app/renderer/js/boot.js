// The startup animation — the words and the layout half of it.
//
// The ring itself belongs to the orb and is driven from `presence.js`, because
// it is drawn on both surfaces. What lives here is the main window's part: the
// single word beneath the orb naming the capability just gained, the failure
// panels when a subsystem doesn't load, and the moment the window stops being a
// loading screen and becomes a conversation.
//
// Genuinely progress-driven: six subsystems load in wren_v1.py and the ring
// advances as each one lands. There is no fake progress bar, because there is no
// honest number to put in one.

import { STAGES } from './presence.js'
import { stageFailure } from './failure.js'

export function createBoot({ stage, word, failures, retry }) {
  const index = new Map(STAGES.map((entry, i) => [entry.name, i]))
  const notes = new Map() // Whatever a `start` record said it was doing
  const panels = new Map() // Stage name → its failure panel, while it is failing
  let finished = false

  function say(text, note) {
    word.classList.add('is-fading')
    setTimeout(() => {
      word.textContent = note ? `${text} · ${note}` : text
      word.classList.remove('is-fading')
    }, 200)
  }

  function clearPanel(name) {
    panels.get(name)?.remove()
    panels.delete(name)
  }

  return {
    stages: STAGES,

    onStage(record) {
      const i = index.get(record.name)
      if (i === undefined) return
      const entry = STAGES[i]

      if (record.status === 'start') {
        if (record.note) notes.set(record.name, record.note)
        // A retry that has begun: the panel has served its purpose.
        clearPanel(record.name)
        return
      }

      if (record.status === 'error') {
        // The word alone was the whole bug — it named the casualty and stopped.
        // The panel says what it costs and offers the one thing that might fix
        // it, and the load carries on around it.
        if (!finished) say(entry.word, 'failed')
        clearPanel(record.name)
        const panel = stageFailure(record, retry)
        panels.set(record.name, panel)
        failures.append(panel)
        return
      }

      clearPanel(record.name)
      if (!finished) say(entry.word)
    },

    // Presence owns the timing; this is only the label. A stalled stage says what
    // it is actually doing — a first-run HuggingFace pull is not a hang, and
    // saying "downloading — 2.3 GB" is worth more than any animation.
    onStall(name, on) {
      if (finished || !on) return
      const i = index.get(name)
      if (i === undefined) return
      say(STAGES[i].word, notes.get(name) || 'still loading')
    },

    onReady() {
      if (finished) return
      finished = true

      // Let the ring close and the settle breath begin before the layout moves.
      // Moving both at once reads as two unrelated animations.
      setTimeout(() => {
        stage.dataset.phase = 'ready'
        say('listening')
      }, 620)
    },

    get finished() {
      return finished
    },
  }
}
