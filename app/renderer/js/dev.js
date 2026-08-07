// Dev overlay — ⌥⌘D.
//
// Injects a single record as though it had arrived from Wren, through main, so
// both surfaces react to it. Tuning a 4s breath cycle or the speaking bloom
// against a scripted replay means re-running the whole replay for every tweak;
// this makes it one click. It also reaches states the fixtures don't script —
// speaking straight into hearing, thinking into error.

const BUTTONS = [
  ['ready', () => [
    { kind: 'ready', wakeword: 'wren', voiceprint: 'enrolled', model: 'llama-3.2-3b', brain_status: 'ready (in-process)', voice: 'bf_emma' },
    { kind: 'state', engaged: false },
  ]],
  ['idle', () => [{ kind: 'state', engaged: false }]],
  ['engaged 20s', () => [{ kind: 'state', engaged: true, ends_in: 20 }]],
  ['engaged 4s', () => [{ kind: 'state', engaged: true, ends_in: 4 }]],
  ['wake', () => [{ kind: 'wake' }]],
  ['hearing on', () => [{ kind: 'hearing', on: true }]],
  ['hearing off', () => [{ kind: 'hearing', on: false }]],
  ['level lo', () => [{ kind: 'level', rms: 0.15 }]],
  ['level mid', () => [{ kind: 'level', rms: 0.55 }]],
  ['level hi', () => [{ kind: 'level', rms: 0.95 }]],
  ['thinking', () => [{ kind: 'thinking', text: 'what were we saying' }]],
  ['filler', () => [{ kind: 'filler', text: 'Hmm.' }]],
  ['speak', () => [{ kind: 'speaking', chunk: 'Yes, of course.' }]],
  ['spoke', () => [{ kind: 'spoke', first_audio_ms: 644, synth_ms: 455, audio_seconds: 2.1, filler: null, sentences: ['Yes, of course.'] }]],
  ['affect calm', () => [{ kind: 'affect', valence: 0.15, arousal: 0.22, fatigue: 0.05, curiosity: 0.52, social_trust: 0.5, boredom: 0.02, existential_security: 0.98, dominant_drive: 'curiosity' }]],
  ['affect strained', () => [{ kind: 'affect', valence: -0.3, arousal: 0.61, fatigue: 0.72, curiosity: 0.31, social_trust: 0.44, boredom: 0.08, existential_security: 0.4, dominant_drive: 'low_existential_security' }]],
  ['accept', () => [{ kind: 'verdict', accepted: true, reason: 'wake', score: 0.72, text: 'what were we saying', ms: 118, speculated: true }]],
  ['not you', () => [{ kind: 'verdict', accepted: false, reason: 'not you', score: 0.19, text: 'is the kettle on', ms: 155, speculated: false }]],
  ['gate', () => [{ kind: 'verdict', accepted: false, reason: 'gate', score: 0.68, text: 'I should head off', ms: 121, speculated: true }]],
  ['error', () => [{ kind: 'error', message: 'response failed: connection reset' }]],
  // Nothing else emits history, and it is the only way to reach the deque — the
  // Mind's working-memory panel and the brain's hippocampus both hang off it.
  ['history +1', (state) => [{ kind: 'history', messages: state.nextHistory() }]],
  ['history clear', (state) => [{ kind: 'history', messages: state.clearHistory() }]],
  ['stage done', (state) => [{ kind: 'stage', name: state.nextStage(), status: 'done' }]],
  ['stage stall', (state) => [{ kind: 'stage', name: state.peekStage(), status: 'start' }]],
]

// Enough turns to fill the deque twice over, so eviction is reachable.
const TURNS = [
  ['what were we saying', 'You were asking about the kettle.'],
  ['is it raining', 'Lightly, and it should stop by four.'],
  ['remind me later', 'I can’t yet — nothing here survives a restart.'],
  ['what time is it', 'Just past nine.'],
  ['thanks', 'Any time.'],
]

export function createDev(root, { stages, inject }) {
  let cursor = 0
  const names = stages.map((stage) => stage.name)
  let turns = 0
  const state = {
    nextStage: () => names[Math.min(cursor++, names.length - 1)],
    peekStage: () => names[Math.min(cursor, names.length - 1)],
    // The deque keeps four turns and drops the oldest, so this mirrors it.
    nextHistory: () => {
      turns = Math.min(turns + 1, TURNS.length)
      return TURNS.slice(Math.max(0, turns - 4), turns).flatMap(([user, assistant]) => [
        { role: 'user', content: user },
        { role: 'assistant', content: assistant },
      ])
    },
    clearHistory: () => {
      turns = 0
      return []
    },
  }

  const title = document.createElement('span')
  title.className = 'dev-title'
  title.textContent = 'inject'
  root.append(title)

  for (const [label, build] of BUTTONS) {
    const button = document.createElement('button')
    button.textContent = label
    button.addEventListener('click', () => {
      for (const record of build(state)) inject(record)
    })
    root.append(button)
  }

  document.addEventListener('keydown', (event) => {
    if (event.altKey && event.metaKey && event.code === 'KeyD') {
      root.hidden = !root.hidden
    }
  })
}
