'use strict'

// Wren's presence on the desktop: a transparent, always-on-top window that
// outlives the main window. Three things make it behave like an object on your
// screen rather than a window that happens to be round.
//
//   1. Click-through everywhere except the orb itself. The window is a 380x160
//      rectangle so the caption has room; without hit-testing it would swallow
//      clicks across all of that.
//   2. Manual dragging. `-webkit-app-region: drag` fights the hit-testing and
//      stutters on transparent windows, so we track the cursor ourselves.
//   3. A fixed size. Wren's replies are capped at 140 characters upstream
//      (llm.py MAX_REPLY_CHARS), which always fits — so the window never
//      resizes, and the orb never appears to move while a caption arrives.
//
// The window is deliberately much larger than the orb looks. Everything the orb
// draws — the bloom, the speaking waves — has to reach zero *inside* the canvas,
// because a gradient clipped by the canvas edge leaves a flat straight cut, and
// on a transparent always-on-top window that cut is a faint rectangle sitting on
// the user's desktop. `orb.js` clamps as a backstop; this is the room that keeps
// the clamp from ever being needed.

const { BrowserWindow, Menu, screen } = require('electron')
const path = require('node:path')
const platform = require('./platform')
const store = require('./store')

const WIDTH = 400
const HEIGHT = 180

let win = null
let dragging = null

function workAreaFor(point) {
  return screen.getDisplayNearestPoint(point).workArea
}

// Where the window sits for a given edge. The orb is drawn at whichever end of
// the window faces that edge, so 'left' means window flush left with the orb on
// its left side and the caption extending right.
//
// The window goes flush to the screen edge and the slot's own geometry provides
// the inset: the orb's centre sits 90px in (half the 180px slot in orb.css) and
// its visible body about 46px in. That is deliberate rather than a fudged
// offset — pushing the window further out to hug the edge more tightly would
// put part of it off-screen.
function positionForEdge(edge, area, current) {
  const y = current ? current.y : Math.round(area.y + area.height / 2 - HEIGHT / 2)
  switch (edge) {
    case 'left':
      return { x: area.x, y }
    default:
      return { x: area.x + area.width - WIDTH, y }
  }
}

function nearestEdge(bounds, area) {
  const centre = bounds.x + WIDTH / 2
  return centre < area.x + area.width / 2 ? 'left' : 'right'
}

function create() {
  const saved = store.get('orb', null)
  const primary = screen.getPrimaryDisplay().workArea
  const edge = saved?.edge ?? 'right'
  const start = saved
    ? { x: saved.x, y: saved.y }
    : positionForEdge(edge, primary, null)

  win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    x: start.x,
    y: start.y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false, // We move it ourselves; see the drag handlers below.
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: [`--wren-surface=orb`, `--wren-edge=${edge}`],
    },
  })

  win.setAlwaysOnTop(true, platform.orbLevel())
  platform.followWorkspaces(win)
  win.loadFile(path.join(__dirname, '..', 'renderer', 'orb.html'))

  // Start fully click-through. The renderer turns this off the moment the
  // pointer is genuinely over the orb, and back on when it leaves.
  win.setIgnoreMouseEvents(true, { forward: true })

  win.once('ready-to-show', () => win.showInactive())
  win.on('closed', () => {
    win = null
  })

  return win
}

function setPassthrough(pass) {
  if (!win || dragging) return
  win.setIgnoreMouseEvents(pass, { forward: true })
}

function beginDrag() {
  if (!win) return
  const cursor = screen.getCursorScreenPoint()
  const bounds = win.getBounds()
  dragging = {
    offsetX: cursor.x - bounds.x,
    offsetY: cursor.y - bounds.y,
    timer: setInterval(() => {
      if (!win || !dragging) return
      const point = screen.getCursorScreenPoint()
      win.setPosition(
        Math.round(point.x - dragging.offsetX),
        Math.round(point.y - dragging.offsetY),
        false,
      )
    }, 8),
  }
  win.setIgnoreMouseEvents(false)
}

function endDrag() {
  if (!win || !dragging) return
  clearInterval(dragging.timer)
  dragging = null

  const bounds = win.getBounds()
  const area = workAreaFor({ x: bounds.x + WIDTH / 2, y: bounds.y + HEIGHT / 2 })
  const edge = nearestEdge(bounds, area)
  const target = positionForEdge(edge, area, null)

  // Keep the vertical position the user chose; only the horizontal snaps.
  const to = {
    x: target.x,
    y: Math.min(Math.max(bounds.y, area.y), area.y + area.height - HEIGHT),
  }

  glideTo(to, () => {
    store.set('orb', { x: to.x, y: to.y, edge })
    win.webContents.send('orb:edge', edge)
  })
}

// Snapping instantly reads as a glitch; over ~220ms it reads as the orb settling.
function glideTo(to, done) {
  const from = win.getBounds()
  const started = Date.now()
  const duration = 220
  const step = () => {
    if (!win) return
    const progress = Math.min(1, (Date.now() - started) / duration)
    const eased = 1 - Math.pow(1 - progress, 3)
    win.setPosition(
      Math.round(from.x + (to.x - from.x) * eased),
      Math.round(from.y + (to.y - from.y) * eased),
      false,
    )
    if (progress < 1) setTimeout(step, 8)
    else done?.()
  }
  step()
}

function popupMenu(onCommand, onOpenMain, onQuit) {
  if (!win) return
  Menu.buildFromTemplate([
    { label: 'Open Wren', click: onOpenMain },
    { type: 'separator' },
    { label: 'Mute mic', click: () => onCommand({ kind: 'mute' }) },
    { label: 'Stop speaking', click: () => onCommand({ kind: 'stop' }) },
    { label: 'New conversation', click: () => onCommand({ kind: 'reset' }) },
    { type: 'separator' },
    { label: 'Quit Wren', click: onQuit },
  ]).popup({ window: win })
}

module.exports = {
  create,
  get: () => win,
  setPassthrough,
  beginDrag,
  endDrag,
  popupMenu,
  WIDTH,
  HEIGHT,
}
