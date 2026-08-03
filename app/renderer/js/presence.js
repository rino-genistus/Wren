// Wren's state, as the orb understands it.
//
// Shared by both surfaces so the orb in the window and the orb on the desktop
// can never disagree about what Wren is doing. Everything here is derived from
// the event stream; nothing is inferred or timed out locally except the return
// from `speaking`, which the stream itself marks with `spoke`, and the stall
// timer below.

// The only chrome in the app. One word — never a sentence, never a spinner.
const WORDS = {
  idle: 'listening',
  engaged: 'go on',
  hearing: 'hearing you',
  thinking: 'thinking',
  speaking: 'speaking',
}

// The six subsystems `wren_v1.py` loads, in order, paired with the capability
// each one buys. The word names what Wren just gained, not the file just read —
// "ears" is more use than "openwakeword".
//
// This lives here rather than in boot.js because the loading ring is drawn on
// both surfaces and the count has to be the same on each.
export const STAGES = [
  { name: 'wakeword', word: 'ears' },
  { name: 'vad', word: 'attention' },
  { name: 'asr', word: 'words' },
  { name: 'voiceprint', word: 'you' },
  { name: 'warm', word: 'voice' },
  { name: 'brain', word: 'mind' },
]

// Long enough that a normal load never trips it — the slowest cached stage is
// the ASR at ~3.5s — and short enough that a first-run download is called out
// rather than left looking like a hang.
const STALL_AFTER = 6000

export function createPresence(orb, { onWord, onCaption, onStall, onMute } = {}) {
  let engaged = false
  let ready = false

  // The load. One ring, one lap: the orb fills as Wren's parts arrive.
  const loaded = new Set()
  const failed = new Set()
  let stallTimer = null

  function clearStall() {
    clearTimeout(stallTimer)
    stallTimer = null
    orb.setStalled(false)
    onStall?.(null, false)
  }

  function settle() {
    const next = engaged ? 'engaged' : 'idle'
    orb.setState(next)
    onWord?.(WORDS[next])
  }

  function enter(state) {
    orb.setState(state)
    onWord?.(WORDS[state])
  }

  return {
    get ready() {
      return ready
    },

    handle(record) {
      switch (record.kind) {
        // The ring only ever advances on a stage that genuinely landed. There is
        // no honest number *inside* a stage — the two big weight loads report
        // nothing until they finish — so between completions the ring holds
        // still and the head shimmers instead.
        case 'stage':
          if (record.status === 'done') {
            failed.delete(record.name)
            orb.setFailed(failed.size > 0)
            if (loaded.has(record.name)) break
            loaded.add(record.name)
            clearStall()
            orb.setProgress(loaded.size / STAGES.length)
          } else if (record.status === 'start') {
            // A retry counts as un-failing until it says otherwise.
            failed.delete(record.name)
            orb.setFailed(failed.size > 0)
            clearTimeout(stallTimer)
            stallTimer = setTimeout(() => {
              orb.setStalled(true)
              onStall?.(record.name, true, record.note)
            }, STALL_AFTER)
          } else if (record.status === 'error') {
            clearStall()
            failed.add(record.name)
            orb.setFailed(true)
          }
          break

        case 'ready':
          ready = true
          clearStall()
          if (failed.size) {
            // The load finished with a casualty. Take the ring away rather than
            // flashing it shut — the lap did not complete, and saying it did
            // would be the one thing this ring exists not to do.
            orb.dismissSweep()
          } else {
            // Close the lap even if the compressed fixtures skipped stages: the
            // orb is always fully assembled by the time it settles, never partly.
            orb.setProgress(1)
          }
          orb.setState('idle')
          orb.settle()
          break

        case 'state':
          engaged = Boolean(record.engaged)
          orb.setEngagement(engaged ? (record.ends_in ?? 20) : 0, record.ends_in ?? 20)
          if (record.muted !== undefined) {
            orb.setMuted(record.muted)
            onMute?.(Boolean(record.muted))
          }
          if (!ready) break
          settle()
          break

        case 'hearing':
          if (!ready) break
          if (record.on) enter('hearing')
          else if (orb.state === 'hearing') settle()
          break

        case 'level':
          orb.setLevel(record.rms ?? 0)
          break

        case 'wake':
          // The wake word is an instant, not a state — a single bright pulse.
          orb.pulse(0.5)
          break

        case 'verdict':
          if (!record.accepted) {
            orb.flicker()
            if (orb.state === 'hearing') settle()
          }
          break

        case 'thinking':
          enter('thinking')
          onCaption?.(null)
          break

        case 'filler':
          enter('speaking')
          orb.pulse(0.6)
          onCaption?.(record.text, { filler: true })
          break

        case 'speaking':
          enter('speaking')
          orb.pulse(1)
          onCaption?.(record.chunk, { append: true })
          break

        case 'spoke':
          onCaption?.(record.sentences?.join(' ') ?? null, { final: true })
          settle()
          break

        case 'error':
          settle()
          onCaption?.(null)
          break

        default:
          break
      }
    },
  }
}
