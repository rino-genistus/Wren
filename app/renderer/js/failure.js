// The failure surface.
//
// Three different things fail in Wren and until now all three rendered as
// silence: a subsystem that won't load, a reply that threw, and the process
// itself dying. Each gets the same shape here — what broke in Wren's own words,
// the detail underneath for when you need it, and one action that might fix it.
//
// The rule this exists to enforce: never state a failure without stating what to
// do about it. A stopped ring and the word FAILED leaves the user to guess, and
// guessing is the thing a status display is supposed to prevent.

// What each subsystem failing actually costs you, said plainly. The detail line
// carries the exception; this carries the consequence, which is the part you
// need in order to decide whether to bother.
const SUBSYSTEMS = {
  wakeword: {
    what: 'I can’t find my wake word model.',
    means: 'I won’t wake to my name — ask me something outright and I’ll still answer.',
  },
  vad: {
    what: 'My speech detector didn’t load.',
    means: 'I can’t tell talking from noise, so I won’t hear you at all.',
  },
  asr: {
    what: 'I can’t load the model I use to understand words.',
    means: 'I’ll hear that you spoke but never what you said.',
  },
  voiceprint: {
    what: 'I couldn’t read your voiceprint.',
    means: 'I’ll answer any voice, not just yours. Run enroll.py to fix that.',
  },
  warm: {
    what: 'My voice didn’t load.',
    means: 'I can still listen and think, but I won’t be able to say anything.',
  },
  brain: {
    what: 'My brain isn’t answering.',
    means: 'I’ll hear you and know you, but I’ll have nothing to reply with.',
  },
}

function element(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/**
 * One panel. `action` is `{ label, run }` or omitted for a failure with no
 * remedy — in which case the panel says so rather than offering a dead button.
 */
export function failurePanel({ what, means, detail, action }) {
  const panel = element('div', 'failure')
  panel.append(element('p', 'what', what))
  if (means) panel.append(element('p', 'means', means))
  if (detail) panel.append(element('p', 'detail', detail))

  if (action) {
    const button = element('button', 'label act', action.label)
    button.addEventListener('click', () => {
      if (panel.dataset.busy === 'true') return
      panel.dataset.busy = 'true'
      button.textContent = action.busyLabel ?? 'Trying…'
      action.run()
    })
    panel.append(button)
  }

  return panel
}

/** A stage that failed to load, turned into a panel. */
export function stageFailure(record, retry) {
  const known = SUBSYSTEMS[record.name]
  return failurePanel({
    what: known?.what ?? `${record.name} didn’t load.`,
    means: known?.means,
    detail: record.message,
    action: retry ? { label: 'Try again', run: () => retry(record.name) } : null,
  })
}
