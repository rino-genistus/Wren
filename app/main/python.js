'use strict'

// The real Wren, behind the same interface as the fixture replayer.
//
// Spawns `wren_v1.py` with two extra pipes: fd 3 carries her events out, fd 4
// carries commands in. Both are named in the environment rather than assumed —
// see events.py for what happens when a process guesses that fd 3 is its own.
//
// Nothing in the renderer knows this exists. `createSource` picks between this
// and `ReplaySource`, and both emit the same `event` records, so every fixture
// script keeps working and the UI cannot tell the difference.

const { EventEmitter } = require('node:events')
const { spawn, spawnSync } = require('node:child_process')
const path = require('node:path')

const EVENT_FD = 3
const COMMAND_FD = 4

// Wren's dependencies live under one specific interpreter and it is not
// necessarily the one called `python3` — on the machine this was built on,
// `python3` is missing kaldi_native_fbank and `python3.13` has it. Rather than
// hardcode either, ask each candidate whether it can actually import the
// discriminating package. It is one cheap C extension, so this costs
// milliseconds, and it fails loudly instead of at the voiceprint stage.
function findPython() {
  const candidates = [process.env.WREN_PYTHON, 'python3.13', 'python3', 'python']
  for (const candidate of candidates) {
    if (!candidate) continue
    const probe = spawnSync(candidate, ['-c', 'import kaldi_native_fbank'], {
      timeout: 20000,
      stdio: 'ignore',
    })
    if (probe.status === 0) return candidate
  }
  return null
}

class PythonSource extends EventEmitter {
  constructor(root) {
    super()
    this.root = root
    this.child = null
    this.buffer = ''
    this.stopping = false
  }

  start() {
    const python = findPython()
    if (!python) {
      // The same channel as everything else, so a missing interpreter renders
      // as Wren's failure panel rather than a window that never fills in.
      queueMicrotask(() =>
        this.emit('event', {
          kind: 'error',
          message:
            'No Python with Wren\'s dependencies. Set WREN_PYTHON to the interpreter ' +
            'that can `import kaldi_native_fbank`.',
        }))
      return this
    }

    const script = path.join(this.root, 'wren_v1.py')
    this.child = spawn(python, ['-u', script], {
      cwd: this.root,
      env: {
        ...process.env,
        WREN_EVENT_FD: String(EVENT_FD),
        WREN_COMMAND_FD: String(COMMAND_FD),
        PYTHONUNBUFFERED: '1',
      },
      // 0 ignored: Wren reads the microphone, never the keyboard. 1 and 2 are
      // forwarded to Electron's console — her terminal narration is still worth
      // having when something goes wrong, it just isn't the UI's source.
      stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
    })

    this.child.stdout.on('data', (chunk) => process.stdout.write(`[wren] ${chunk}`))
    this.child.stderr.on('data', (chunk) => process.stderr.write(`[wren] ${chunk}`))

    const events = this.child.stdio[EVENT_FD]
    events.setEncoding('utf8')
    events.on('data', (chunk) => this.consume(chunk))

    this.child.on('error', (error) => {
      this.emit('event', { kind: 'error', message: `couldn't start Wren: ${error.message}` })
    })

    this.child.on('exit', (code, signal) => {
      this.child = null
      if (this.stopping) return
      // Never respawn on our own. A crash loop that hides itself behind a
      // working-looking orb is worse than a window that says what happened.
      this.emit('event', {
        kind: 'error',
        message: signal
          ? `Wren stopped (${signal}).`
          : `Wren exited with code ${code}.`,
      })
      this.emit('end')
    })

    return this
  }

  // fd 3 is a byte stream, so a record can arrive in pieces or several at once.
  consume(chunk) {
    this.buffer += chunk
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() ?? ''
    for (const line of lines) {
      const text = line.trim()
      if (!text) continue
      try {
        this.emit('event', JSON.parse(text))
      } catch {
        // A malformed line is a bug upstream, not a reason to stop reading.
        process.stderr.write(`[wren] unparseable event: ${text}\n`)
      }
    }
  }

  send(command) {
    const pipe = this.child?.stdio[COMMAND_FD]
    if (!pipe || pipe.destroyed) return
    pipe.write(`${JSON.stringify(command)}\n`)
  }

  stop() {
    if (!this.child) return
    this.stopping = true
    const child = this.child
    child.kill('SIGTERM')
    // She closes the audio device and shuts the executors down on SIGTERM. If
    // something is wedged, don't leave a process holding the microphone.
    setTimeout(() => {
      if (!child.killed || child.exitCode === null) child.kill('SIGKILL')
    }, 2000).unref?.()
  }
}

module.exports = { PythonSource, findPython }
