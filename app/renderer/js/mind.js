// The Mind.
//
// Four panels. Two of them show something real, because two of them have
// something real behind them: the system prompt, which is where Wren's character
// genuinely lives, and the four-turn history deque, which is the entire honest
// answer to "what does Wren remember".
//
// The other two are laid out and empty. There is no memory store and no
// reflection pass — building one to fill a panel would be adding behaviour to
// Wren in order to have something to draw. The empty states describe the shape of
// what goes there, and the constraints any implementation has to respect, so the
// design work survives until it is wanted.

// The measured consequences recorded in llm.py's comments. These are the reason
// each value is what it is, and they are far more useful next to the number than
// buried in a source file.
const LEVERS = [
  {
    key: 'temperature',
    label: 'Temperature',
    because: 'At 0.7 the register wandered — the model drifted into folksy American idiom a few turns in. Lower keeps it consistent across a session.',
  },
  {
    key: 'max_sentences',
    label: 'Max sentences',
    because: 'Asking politely for brevity produced 7.1s replies. Consuming at most two sentences is a monologue guard, and it cuts at a natural pause.',
  },
  {
    key: 'max_reply_chars',
    label: 'Max reply',
    suffix: ' chars',
    because: 'One run-on sentence reached 15s of speech while obeying the sentence limit. About 8s at Kokoro’s pace — a worst-case ceiling, not a target.',
  },
  {
    key: 'history_turns',
    label: 'History',
    suffix: ' turns',
    because: 'Every prompt token costs ~1.33ms of prefill. Six turns spent ~145ms per reply remembering exchanges a spoken conversation rarely refers back to.',
  },
]

const EMPTY = [
  {
    title: 'Long-term memory',
    note: 'nothing behind this yet',
    what: 'Facts Wren has kept: what was learned, when it formed, how often it has been recalled, and — live, as a turn happens — which of them were put in front of the model.',
    constraint:
      'Whatever fills this has to write on the responder thread after a reply finishes, where it costs no conversational latency, and read against a hard token budget: every injected token is ~1.33ms of prefill on the 3B.',
  },
  {
    title: 'Thoughts, opinions, feelings',
    note: 'nothing behind this yet',
    what: 'A timeline of stances tied to the turns that formed them, and a mood — warmth and energy — drifting across a session. The orb already takes a mood input; it is pinned neutral, so a signal here would colour Wren’s presence on the desktop with no further work.',
    constraint:
      'This is the one part that would change what Wren says rather than what you see. Whenever it is built it belongs behind a toggle that starts off.',
  },
]

// Rough, and labelled rough. The real count depends on the tokeniser; this is
// the ~54 tokens/turn figure from llm.py's comments applied to actual text.
function estimateTokens(messages) {
  const characters = messages.reduce((total, message) => total + message.content.length, 0)
  return Math.round(characters / 3.6) + messages.length * 4
}

export function createMind(root) {
  root.innerHTML = ''

  function element(tag, className, text) {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined) node.textContent = text
    return node
  }

  function panel(title, note) {
    const section = element('section', 'panel')
    const head = element('div', 'panel-head')
    head.append(element('h2', 'label', title))
    if (note) head.append(element('span', 'note', note))
    section.append(head)
    return section
  }

  // ── Personality ─────────────────────────────────────────────────────────────
  const personality = panel('Personality', 'read-only — editing needs a mutable prompt upstream')
  const prompt = element('p', 'prompt', 'Waiting for Wren.')
  const levers = element('div', 'levers')
  personality.append(prompt, levers)

  // ── Working memory ──────────────────────────────────────────────────────────
  const working = panel('Working memory', 'the deque actually in front of the model')
  const messages = element('div', 'messages')
  working.append(messages)

  root.append(personality, working)

  for (const entry of EMPTY) {
    const section = panel(entry.title, entry.note)
    const empty = element('div', 'empty')
    empty.append(element('p', 'what', entry.what))
    empty.append(element('p', 'constraint', entry.constraint))
    section.append(empty)
    root.append(section)
  }

  function emptyMemory() {
    messages.innerHTML = ''
    const line = element('p', 'constraint', 'Empty. Wren remembers nothing between restarts — this deque is cleared on launch and holds four turns at a time.')
    line.style.margin = '4px 0'
    messages.append(line)
  }

  emptyMemory()

  return {
    personality(record) {
      prompt.textContent = record.prompt
      levers.innerHTML = ''
      for (const lever of LEVERS) {
        const value = record[lever.key]
        if (value === undefined) continue
        const cell = element('div', 'lever')
        cell.append(element('span', 'label', lever.label))
        cell.append(element('span', 'value', `${value}${lever.suffix ?? ''}`))
        cell.append(element('span', 'because', lever.because))
        levers.append(cell)
      }
      working.querySelector('.note').textContent =
        `the deque actually in front of the model — ${record.history_turns} turns`
    },

    history(record) {
      if (!record.messages?.length) {
        emptyMemory()
        return
      }
      messages.innerHTML = ''
      for (const message of record.messages) {
        const line = element('div', `message ${message.role}`)
        line.append(element('span', 'who', message.role === 'user' ? 'you' : 'wren'))
        line.append(element('span', 'what', message.content))
        messages.append(line)
      }
      const total = element('p', 'constraint', `~${estimateTokens(record.messages)} tokens of prefill on every reply`)
      total.style.margin = '10px 0 0'
      messages.append(total)
    },
  }
}
