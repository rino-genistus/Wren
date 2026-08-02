'use strict'

// Everything that differs between macOS, Windows and Linux lives here, so the
// cross-platform move later is a matter of filling in branches rather than
// hunting for assumptions scattered through the window code.

const mac = process.platform === 'darwin'

module.exports = {
  mac,

  // The main window's titlebar. Breath has no chrome of its own, so on macOS we
  // keep the traffic lights and float them over the background; elsewhere we
  // drop the frame entirely.
  mainWindowChrome: () =>
    mac
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 18 } }
      : { frame: false },

  // 'floating' sits above normal windows but below menus and dialogs — high
  // enough to always be visible, low enough not to cover a system prompt.
  orbLevel: () => (mac ? 'floating' : 'screen-saver'),

  // Follow the user across Spaces and over fullscreen apps. No equivalent
  // elsewhere; the orb simply lives on whichever desktop it was placed.
  followWorkspaces: (win) => {
    if (mac) win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  },
}
