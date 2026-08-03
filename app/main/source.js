'use strict'

// The seam.
//
// Everything upstream of the UI arrives through one object: an EventEmitter that
// emits `event` with a parsed record, and accepts `send(command)` going back the
// other way. Today the only implementation replays a fixture file. Later a
// `python.js` sibling reads fd 3 of the real process and writes fd 4, behind this
// same interface — nothing in the renderer knows or cares which is attached.

const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const path = require('node:path')

class ReplaySource extends EventEmitter {
  constructor(file, { speed = 1 } = {}) {
    super()
    this.file = file
    this.speed = speed
    this.timers = []
    this.records = []
  }

  start() {
    let text
    try {
      text = fs.readFileSync(this.file, 'utf8')
    } catch (error) {
      // Surface it through the same channel as everything else, so a missing
      // fixture renders as Wren's error state rather than a silent dead app.
      queueMicrotask(() =>
        this.emit('event', { kind: 'error', message: `fixture not found: ${this.file}` }))
      return this
    }

    this.records = text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('//'))
      .map((line, index) => {
        try {
          return JSON.parse(line)
        } catch {
          throw new Error(`${path.basename(this.file)}:${index + 1} is not valid JSON`)
        }
      })

    if (!this.records.length) return this

    // `t` is seconds on a monotonic clock, exactly as the real stream will carry
    // it, so fixtures are written in absolute session time and replayed as deltas
    // from the first record. That keeps a hand-authored fixture and a recorded
    // one indistinguishable.
    const origin = this.records[0].t ?? 0
    for (const record of this.records) {
      const delay = (((record.t ?? origin) - origin) * 1000) / this.speed
      this.timers.push(setTimeout(() => this.emit('event', record), delay))
    }

    const last = this.records[this.records.length - 1]
    const end = (((last.t ?? origin) - origin) * 1000) / this.speed
    this.timers.push(setTimeout(() => this.emit('end'), end + 250))
    return this
  }

  // In replay there is nothing to command. Emitted rather than dropped so the
  // dev overlay can show that a menu item did fire.
  send(command) {
    this.emit('command', command)
  }

  stop() {
    for (const timer of this.timers) clearTimeout(timer)
    this.timers = []
  }
}

// A source driven entirely by hand from the dev overlay. Same interface, no
// schedule — used for tuning motion, where waiting out a replay for every tweak
// is the whole problem.
class ManualSource extends EventEmitter {
  start() {
    return this
  }
  send(command) {
    this.emit('command', command)
  }
  stop() {}
  inject(record) {
    this.emit('event', record)
  }
}

function createSource(argv, appRoot) {
  const at = argv.indexOf('--replay')
  const speedFlag = argv.find((argument) => argument.startsWith('--speed='))
  const speed = speedFlag ? Number(speedFlag.split('=')[1]) || 1 : 1

  if (at !== -1 && argv[at + 1]) {
    const given = argv[at + 1]
    const file = path.isAbsolute(given) ? given : path.join(appRoot, given)
    return new ReplaySource(file, { speed })
  }

  // Nothing to replay and nothing to drive by hand: run the real Wren. The
  // repo root is one level above `app/`, which is where wren_v1.py lives.
  if (argv.includes('--manual')) return new ManualSource()
  const { PythonSource } = require('./python')
  return new PythonSource(path.join(appRoot, '..'))
}

module.exports = { createSource, ReplaySource, ManualSource }
