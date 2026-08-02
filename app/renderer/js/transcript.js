// The transcript.
//
// One list, no bubbles. A turn opens the moment an utterance is accepted and
// fills in as Wren answers, so the gap between the two is visible rather than
// blank.
//
// Wren's words appear a *sentence* at a time, never a chunk at a time. The
// chunks upstream are cut for time-to-first-audio — the opening one breaks
// mid-clause at a word boundary — so rendering them as they arrive shows the
// answer as fragments. This is the same reason respond() collects them and
// prints through llm.sentences instead.

const SENTENCE_SPLIT = /(?<=[.!?…])\s+/

function sentencesOf(text) {
  return text
    .trim()
    .split(SENTENCE_SPLIT)
    .map((part) => part.trim())
    .filter(Boolean)
}

export function createTranscript(list) {
  let open = null // The turn currently being answered

  function nearBottom() {
    const view = list.parentElement
    return view.scrollHeight - view.scrollTop - view.clientHeight < 120
  }

  function scroll() {
    const view = list.parentElement
    requestAnimationFrame(() => {
      view.scrollTo({ top: view.scrollHeight, behavior: 'smooth' })
    })
  }

  function add(element) {
    const follow = nearBottom()
    list.append(element)
    if (follow) scroll()
  }

  function element(tag, className, text) {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined) node.textContent = text
    return node
  }

  return {
    /** An utterance Wren declined. Shown, but never as a turn. */
    reject(record) {
      const turn = element('li', `turn rejected ${record.reason.replace(/\s+/g, '-')}`)
      const said = record.text ? `“${record.text}”` : '—'
      turn.append(element('p', 'heard', said))

      const detail = [record.reason]
      if (record.score !== null && record.score !== undefined) {
        detail.push(`voice ${record.score >= 0 ? '+' : ''}${record.score.toFixed(2)}`)
      }
      if (record.ms) detail.push(`${Math.round(record.ms)}ms`)
      turn.append(element('span', 'label reason', detail.join(' · ')))
      add(turn)
    },

    /** An accepted utterance. Opens a turn waiting for the reply. */
    accept(record) {
      if (record.text === '(name only)') {
        const turn = element('li', 'turn rejected name-only')
        turn.append(element('span', 'label reason', 'wren · listening'))
        add(turn)
        open = null
        return
      }

      const turn = element('li', 'turn')
      turn.append(element('p', 'heard', record.text))
      const said = element('p', 'said')
      turn.append(said)
      add(turn)

      open = { turn, said, buffer: '', rendered: 0, filler: null }
    },

    /** Wren has the question and is generating. */
    thinking() {
      if (!open) return
      open.said.append(element('span', 'waiting', '···'))
    },

    /** A gap-covering "Hmm." — it was really spoken, so it belongs in the record. */
    filler(text) {
      if (!open) return
      open.filler = element('span', 'filler', `${text} `)
      open.said.prepend(open.filler)
    },

    /** A spoken chunk. Only whole sentences are committed to the page. */
    speaking(chunk) {
      if (!open) return
      open.said.querySelector('.waiting')?.remove()
      open.buffer = `${open.buffer} ${chunk}`.trim()

      const complete = sentencesOf(open.buffer)
      // The trailing fragment is held back until it terminates, unless it is all
      // there is — a reply that never lands a full stop should still be visible.
      const commit = SENTENCE_SPLIT.test(open.buffer) || /[.!?…]$/.test(open.buffer)
        ? complete
        : complete.slice(0, -1)

      for (let i = open.rendered; i < commit.length; i += 1) {
        open.said.append(element('span', 'sentence', `${commit[i]} `))
      }
      if (commit.length > open.rendered) {
        open.rendered = commit.length
        if (nearBottom()) scroll()
      }
    },

    /** The authoritative version, regrouped upstream. Replaces whatever streamed. */
    spoke(record) {
      if (!open) return
      const final = record.sentences?.length ? record.sentences : sentencesOf(open.buffer)
      open.said.textContent = ''
      if (open.filler) open.said.append(open.filler)
      for (const sentence of final) {
        open.said.append(element('span', 'sentence', `${sentence} `))
      }
      open.turn.dataset.firstAudio = record.first_audio_ms ?? ''
      open = null
    },

    /** respond() caught something. The mic loop survived; say so plainly. */
    fail(message) {
      if (!open) {
        const turn = element('li', 'turn')
        turn.append(element('p', 'said failed', message))
        add(turn)
        return
      }
      open.said.querySelector('.waiting')?.remove()
      open.said.append(element('span', 'failed', message))
      open = null
    },
  }
}
