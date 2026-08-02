// The desktop orb.
//
// Three things make this behave like an object on your screen rather than a
// window that happens to be round:
//
//   1. Hit-testing. The window is 380x160 and mostly empty; without this it
//      would eat clicks across all of it. Main keeps the window ignoring mouse
//      events and forwarding them here, and we turn that off only while the
//      pointer is genuinely over the orb.
//   2. Manual dragging, because `-webkit-app-region: drag` fights the
//      hit-testing and stutters on a transparent window.
//   3. A caption that never resizes the window, so the orb doesn't shift under
//      the pointer when Wren starts speaking.

import { createOrb } from './orb.js'
import { createPresence } from './presence.js'

const perch = document.getElementById('perch')
const slot = document.getElementById('slot')
const bubble = document.getElementById('bubble')
const bubbleText = document.getElementById('bubble-text')

perch.dataset.edge = window.wren.edge

// A tighter bloom than the main window's, so that everything drawn reaches zero
// well inside the 180px slot — see orb.css for why that matters here.
const orb = createOrb(document.getElementById('orb'), {
  radiusRatio: 0.13,
  bloomReach: 2.6,
})

// ── Caption ────────────────────────────────────────────────────────────────────

let spoken = ''
let filler = null
let hideTimer = null

function paintCaption() {
  bubbleText.textContent = ''
  if (filler) {
    const span = document.createElement('span')
    span.className = 'filler'
    span.textContent = `${filler} `
    bubbleText.append(span)
  }
  bubbleText.append(document.createTextNode(spoken))
  perch.dataset.caption = spoken || filler ? 'true' : 'false'
}

function caption(text, options = {}) {
  clearTimeout(hideTimer)

  if (text === null) {
    spoken = ''
    filler = null
    perch.dataset.caption = 'false'
    return
  }

  if (options.filler) {
    filler = text
  } else if (options.final) {
    spoken = text
    filler = null
  } else if (options.append) {
    spoken = `${spoken} ${text}`.trim()
  } else {
    spoken = text
  }

  paintCaption()

  if (options.final) {
    // Long enough to finish reading a two-sentence reply, short enough that the
    // orb goes back to being just an orb.
    hideTimer = setTimeout(() => {
      perch.dataset.caption = 'false'
      spoken = ''
      filler = null
    }, 2500)
  }
}

const presence = createPresence(orb, { onCaption: caption })

window.wren.onEvent((record) => presence.handle(record))
window.wren.onEdge((edge) => {
  perch.dataset.edge = edge
})

// ── Pointer ────────────────────────────────────────────────────────────────────

const HIT_RADIUS = 40
const DRAG_THRESHOLD = 4

let interactive = false
let press = null

function overOrb(x, y) {
  const box = slot.getBoundingClientRect()
  const dx = x - (box.left + box.width / 2)
  const dy = y - (box.top + box.height / 2)
  return Math.hypot(dx, dy) <= HIT_RADIUS
}

function setInteractive(next) {
  if (next === interactive) return
  interactive = next
  window.wren.orb.passthrough(!next)
}

// Arrives even while the window is ignoring mouse events, because main forwards
// it. This is the whole mechanism.
window.addEventListener('mousemove', (event) => {
  if (press?.dragging) return
  setInteractive(overOrb(event.clientX, event.clientY))
})

window.addEventListener('mouseleave', () => {
  if (!press) setInteractive(false)
})

slot.addEventListener('mousedown', (event) => {
  if (!overOrb(event.clientX, event.clientY)) return

  if (event.button === 2) {
    window.wren.orb.menu()
    return
  }
  if (event.button !== 0) return

  event.preventDefault()
  press = { x: event.screenX, y: event.screenY, dragging: false }
})

window.addEventListener('mousemove', (event) => {
  if (!press || press.dragging) return
  if (Math.hypot(event.screenX - press.x, event.screenY - press.y) < DRAG_THRESHOLD) return

  // Main takes over from here: it tracks the cursor and moves the window, which
  // keeps the pointer at a fixed offset inside it — so mouseup still lands here.
  press.dragging = true
  perch.classList.add('is-dragging')
  window.wren.orb.dragStart()
})

window.addEventListener('mouseup', () => {
  if (!press) return
  const { dragging } = press
  press = null

  if (dragging) {
    perch.classList.remove('is-dragging')
    window.wren.orb.dragEnd()
    return
  }
  window.wren.orb.activate()
})

window.addEventListener('contextmenu', (event) => {
  event.preventDefault()
  if (overOrb(event.clientX, event.clientY)) window.wren.orb.menu()
})
