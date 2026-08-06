'use strict'

// A few kilobytes of window placement, written to userData. Deliberately not a
// dependency: this is one JSON file, and the orb's position is the only thing in
// the app worth remembering between launches.

const fs = require('node:fs')
const path = require('node:path')
const { app } = require('electron')

const file = path.join(app.getPath('userData'), 'wren-ui.json')

let cache = null

function all() {
  if (cache) return cache
  try {
    cache = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    cache = {}
  }
  return cache
}

function get(key, fallback) {
  const value = all()[key]
  return value === undefined ? fallback : value
}

function set(key, value) {
  all()[key] = value
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(cache, null, 2))
  } catch {
    // Losing a window position is not worth taking the app down for.
  }
}

module.exports = { get, set }
