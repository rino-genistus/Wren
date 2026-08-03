// The palette.
//
// Read once from the stylesheet, the same five-plus-two tokens orb.js reads by
// name. Nothing here is a colour literal: the fallbacks exist only so the module
// survives being constructed before the stylesheet has applied.
//
// DESIGN.md names the active colour `--warm`. There is no such token — the app's
// one saturated colour is the orb's lavender, so warm/active maps onto the
// `--glow` family and nothing new is invented.

import { Color } from 'three'

const TOKENS = {
  glow: '#c9a7ff', // active
  hot: '#ebdcff', // the peak of active
  deep: '#7b5fb0',
  cool: '#6e8fa8', // idle, rejected, and the tint of the shell
  fail: '#e0776a',
  faint: '#6e6d80',
  fainter: '#35364a', // unbuilt
  ink: '#191b22',
}

export function readLook() {
  const styles = getComputedStyle(document.documentElement)
  const look = {}
  for (const [name, fallback] of Object.entries(TOKENS)) {
    const value = styles.getPropertyValue(`--${name === 'hot' ? 'glow-hot' : name === 'deep' ? 'glow-deep' : name}`)
    look[name] = new Color((value || '').trim() || fallback)
  }
  return look
}
