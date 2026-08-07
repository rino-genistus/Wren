// The telemetry drawer.
//
// Wren already measures all of this and prints it to a terminal nobody is
// looking at. None of it is invented here: every number below arrives on the
// event stream exactly as tts.speak, report(), and report_affect() produce it.
//
// Folded away by default. The transcript is the window; this is for the days you
// are tuning rather than talking.

const METRICS = [
  { key: 'first_audio_ms', label: 'First audio', unit: 'ms', round: 0 },
  { key: 'synth_ms', label: 'Synth', unit: 'ms', round: 0 },
  { key: 'audio_seconds', label: 'Spoke', unit: 's', round: 1 },
  { key: 'endpoint_ms', label: 'Endpoint', unit: 'ms', round: 0 },
  { key: 'score', label: 'Voice', unit: '', round: 2, signed: true },
  { key: 'reason', label: 'Verdict', text: true },
  { key: 'filler', label: 'Filler', text: true },
  { key: 'speculated', label: 'Speculative', text: true },
]

// Same seven fields affect.py's get_state_telemetry() returns, in the same
// order — this reads the wire format, it doesn't reinvent it. `valence` is
// signed because 0 is a real, meaningful middle, not an absence of data.
const AFFECT_METRICS = [
  { key: 'valence', label: 'Valence', round: 2, signed: true },
  { key: 'arousal', label: 'Arousal', round: 2 },
  { key: 'fatigue', label: 'Fatigue', round: 2 },
  { key: 'curiosity', label: 'Curiosity', round: 2 },
  { key: 'social_trust', label: 'Trust', round: 2 },
  { key: 'boredom', label: 'Boredom', round: 2 },
  { key: 'existential_security', label: 'Security', round: 2 },
  { key: 'dominant_drive', label: 'Drive', text: true },
]

export function createTelemetry({ root, toggle, body, glance }) {
  const latest = {}
  let facts = null

  const cells = new Map()

  function buildGrid(metrics, { heading } = {}) {
    if (heading) {
      const label = document.createElement('div')
      label.className = 'label telemetry-section'
      label.textContent = heading
      body.append(label)
    }
    const grid = document.createElement('div')
    grid.className = 'telemetry-grid'
    body.append(grid)
    for (const metric of metrics) {
      const cell = document.createElement('div')
      cell.className = 'metric'
      const label = document.createElement('span')
      label.className = 'label'
      label.textContent = metric.label
      const value = document.createElement('span')
      value.className = 'value dim'
      value.textContent = '—'
      cell.append(label, value)
      grid.append(cell)
      cells.set(metric.key, value)
    }
  }

  buildGrid(METRICS)
  buildGrid(AFFECT_METRICS, { heading: 'Affect' })

  function render(metric, raw) {
    const cell = cells.get(metric.key)
    if (raw === null || raw === undefined || raw === '') {
      cell.className = 'value dim'
      cell.textContent = metric.key === 'filler' ? 'none' : '—'
      return
    }
    cell.className = 'value'
    if (metric.text) {
      cell.textContent = typeof raw === 'boolean' ? (raw ? 'yes' : 'no') : String(raw)
      return
    }
    const number = Number(raw).toFixed(metric.round)
    const signed = metric.signed && Number(raw) >= 0 ? `+${number}` : number
    cell.textContent = ''
    cell.append(document.createTextNode(signed))
    if (metric.unit) {
      const unit = document.createElement('span')
      unit.className = 'unit'
      unit.textContent = metric.unit
      cell.append(unit)
    }
  }

  function paint() {
    for (const metric of METRICS) render(metric, latest[metric.key])
    for (const metric of AFFECT_METRICS) render(metric, latest[metric.key])

    // The collapsed line is the three numbers worth glancing at: how fast Wren
    // answered, how sure it was you, and why it accepted.
    const bits = []
    if (latest.first_audio_ms != null) bits.push(`${Math.round(latest.first_audio_ms)}ms`)
    if (latest.score != null) bits.push(`voice ${latest.score >= 0 ? '+' : ''}${latest.score.toFixed(2)}`)
    if (latest.reason) bits.push(latest.reason)
    if (latest.filler) bits.push('filler')
    glance.textContent = bits.length ? bits.join('  ·  ') : (facts ? 'ready' : '—')
  }

  function open(next) {
    root.dataset.open = String(next)
    body.style.height = next ? `${body.scrollHeight}px` : '0px'
  }

  toggle.addEventListener('click', () => open(root.dataset.open !== 'true'))
  document.addEventListener('keydown', (event) => {
    if (event.key === 't' && !event.metaKey && !event.ctrlKey && !event.altKey) {
      open(root.dataset.open !== 'true')
    }
  })

  return {
    ready(record) {
      facts = record
      paint()
    },
    verdict(record) {
      latest.score = record.score
      latest.reason = record.reason
      latest.endpoint_ms = record.ms
      latest.speculated = record.speculated
      // A new utterance invalidates the previous reply's numbers.
      latest.first_audio_ms = null
      latest.synth_ms = null
      latest.audio_seconds = null
      latest.filler = null
      paint()
    },
    spoke(record) {
      latest.first_audio_ms = record.first_audio_ms
      latest.synth_ms = record.synth_ms
      latest.audio_seconds = record.audio_seconds
      latest.filler = record.filler
      paint()
      if (root.dataset.open === 'true') open(true)
    },
    affect(record) {
      for (const metric of AFFECT_METRICS) latest[metric.key] = record[metric.key]
      paint()
    },
  }
}
