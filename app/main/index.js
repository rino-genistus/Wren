'use strict'

const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('node:path')

const windows = require('./windows')
const orb = require('./orb-window')
const { createSource } = require('./source')

const appRoot = path.join(__dirname, '..')
let source = null
let quitting = false

// Every event Wren has emitted this session. The main window can be closed and
// reopened at will; when it comes back it needs the conversation it missed.
const journal = []
const JOURNAL_LIMIT = 2000

function broadcast(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

function publish(record) {
  journal.push(record)
  if (journal.length > JOURNAL_LIMIT) journal.shift()
  broadcast('wren:event', record)
}

function start() {
  windows.onQuitting(() => quitting)
  windows.create()
  orb.create()

  source = createSource(process.argv, appRoot)
  source.on('event', publish)
  source.on('end', () => broadcast('wren:replay-end'))
  source.start()
}

app.whenReady().then(start)

app.on('activate', () => {
  windows.show()
})

// Deliberately empty. Closing the main window leaves Wren running with only the
// orb on screen — that is the point of the orb.
app.on('window-all-closed', () => {})

app.on('before-quit', () => {
  quitting = true
  source?.stop()
})

// ── Renderer → main ────────────────────────────────────────────────────────────

ipcMain.handle('wren:journal', () => journal)

ipcMain.on('wren:command', (_event, command) => {
  source?.send(command)
})

// The orb reports whether the pointer is genuinely over its circle; everywhere
// else in that window, clicks belong to whatever is behind it.
ipcMain.on('orb:passthrough', (_event, pass) => orb.setPassthrough(pass))
ipcMain.on('orb:drag-start', () => orb.beginDrag())
ipcMain.on('orb:drag-end', () => orb.endDrag())
ipcMain.on('orb:activate', () => windows.show())
ipcMain.on('orb:menu', () =>
  orb.popupMenu(
    (command) => source?.send(command),
    () => windows.show(),
    () => app.quit(),
  ))

// The dev overlay injects a record as though it had arrived from Wren, so both
// surfaces react. Tuning the orb against a scripted replay would mean re-running
// the script for every tweak.
ipcMain.on('dev:inject', (_event, record) => publish(record))
