'use strict'

const { BrowserWindow } = require('electron')
const path = require('node:path')
const platform = require('./platform')
const store = require('./store')

let win = null
let isQuitting = () => false

function create() {
  const saved = store.get('main', null)

  win = new BrowserWindow({
    width: saved?.width ?? 720,
    height: saved?.height ?? 840,
    x: saved?.x,
    y: saved?.y,
    minWidth: 460,
    minHeight: 520,
    backgroundColor: '#191B22', // --ink. Set here so the window never flashes white.
    show: false,
    ...platform.mainWindowChrome(),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: ['--wren-surface=main'],
    },
  })

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'))

  // Show only once the first frame is painted. The startup animation begins the
  // instant the window appears, and a white flash before it would undo the one
  // thing the animation exists to do.
  win.once('ready-to-show', () => win.show())

  const remember = () => {
    if (!win || win.isMinimized() || win.isDestroyed()) return
    const { x, y, width, height } = win.getBounds()
    store.set('main', { x, y, width, height })
  }
  win.on('moved', remember)
  win.on('resized', remember)
  win.on('closed', () => {
    win = null
  })

  // Closing the main window hides it — Wren keeps running and the orb stays on
  // the desktop. Only an explicit quit ends the process. Attached here rather
  // than by the caller so a window recreated later still behaves this way.
  win.on('close', (event) => {
    if (isQuitting()) return
    event.preventDefault()
    win.hide()
  })

  return win
}

function onQuitting(predicate) {
  isQuitting = predicate
}

function show() {
  if (!win || win.isDestroyed()) create()
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

module.exports = { create, onQuitting, show }
