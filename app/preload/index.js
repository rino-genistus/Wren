'use strict'

// The only bridge between main and the renderers. Nothing else crosses: no
// require, no node globals, no fs. The renderer receives events and can send a
// fixed set of intents back — that is the whole surface.

const { contextBridge, ipcRenderer } = require('electron')

const surfaceArgument = process.argv.find((argument) => argument.startsWith('--wren-surface='))
const edgeArgument = process.argv.find((argument) => argument.startsWith('--wren-edge='))

contextBridge.exposeInMainWorld('wren', {
  // 'main' | 'orb' — the two renderers share orb.js and the design tokens, and
  // differ only in what else they draw.
  surface: surfaceArgument ? surfaceArgument.split('=')[1] : 'main',
  edge: edgeArgument ? edgeArgument.split('=')[1] : 'right',

  onEvent: (handler) => {
    ipcRenderer.on('wren:event', (_event, record) => handler(record))
  },
  onReplayEnd: (handler) => {
    ipcRenderer.on('wren:replay-end', () => handler())
  },
  onEdge: (handler) => {
    ipcRenderer.on('orb:edge', (_event, edge) => handler(edge))
  },

  // Everything the main window missed while it was hidden.
  journal: () => ipcRenderer.invoke('wren:journal'),

  command: (command) => ipcRenderer.send('wren:command', command),

  orb: {
    passthrough: (pass) => ipcRenderer.send('orb:passthrough', pass),
    dragStart: () => ipcRenderer.send('orb:drag-start'),
    dragEnd: () => ipcRenderer.send('orb:drag-end'),
    activate: () => ipcRenderer.send('orb:activate'),
    menu: () => ipcRenderer.send('orb:menu'),
  },

  dev: {
    inject: (record) => ipcRenderer.send('dev:inject', record),
  },
})
