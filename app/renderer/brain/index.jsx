// The brain.
//
// The seam between Wren's event stream and a React tree. Everything outside this
// file sees the same plain object the 2D brain returned — `handle(record)`,
// `setVisible(on)`, `destroy()` — so main.js's call site is unchanged and React
// is an implementation detail of one panel rather than a fact about the app.
//
// handle() never touches React state. Records arrive at conversational rates and
// carry a number per region; re-rendering a tree for each one would be a frame
// budget spent on bookkeeping. They go into `life`, a plain store, and the scene
// reads it inside useFrame. React is only asked to re-render for the three things
// a person does: hover, click, and switch tabs.

import { useState, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { Canvas } from '@react-three/fiber'

import { Brain, pickDeepest } from './scene.jsx'
import { CAMERA } from './atlas.js'
import { createLife } from './life.js'
import { readLook } from './look.js'

/** The smallest thing that can tell React the tab changed without a race: a
 *  setter that exists from the first line, whether or not React has mounted. */
function createSwitch(initial) {
  let value = initial
  const listeners = new Set()
  return {
    get: () => value,
    set(next) {
      if (next === value) return
      value = next
      for (const listener of listeners) listener()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

function Mount({ life, look, onSelect, shown }) {
  const visible = useSyncExternalStore(shown.subscribe, shown.get)
  const [pinned, setPinned] = useState(null)

  // It drifts until you touch it, and then it is yours. Not just on drag: a
  // brain that keeps turning while you are trying to point at something moves
  // the target out from under the cursor, which is the whole reason the drift
  // is slow in the first place.
  const [drifting, setDrifting] = useState(true)
  const settle = () => setDrifting(false)

  return (
    <Canvas
      onPointerMove={settle}
      onPointerDown={settle}
      onWheel={settle}
      // Stopped whenever the Mind view is not on screen. A second always-on
      // render loop competing with MLX for the GPU is latency spent on a picture
      // nobody is looking at, and latency is the one thing Wren cannot spend.
      frameloop={visible ? 'always' : 'never'}
      camera={CAMERA}
      dpr={[1, 2]}
      gl={{ antialias: true, alpha: true, powerPreference: 'low-power' }}
      raycaster={{ filter: pickDeepest }}
      onPointerMissed={() => setPinned(null)}
    >
      <Brain
        life={life}
        look={look}
        onSelect={onSelect}
        pinned={pinned}
        setPinned={setPinned}
        drifting={drifting}
        settle={settle}
      />
    </Canvas>
  )
}

export function createBrain(container, { onSelect } = {}) {
  const look = readLook()

  // Journal replay pushes the whole backlog through handle() in one tick. Without
  // this the brain queues hundreds of impulses and strobes; with it, state is set
  // directly and nothing pulses.
  const life = createLife({
    catchingUp: () => document.body.classList.contains('is-catching-up'),
  })

  const shown = createSwitch(false)
  const root = createRoot(container)
  root.render(<Mount life={life} look={look} onSelect={onSelect} shown={shown} />)

  return {
    handle(record) {
      life.handle(record)
    },

    setVisible(next) {
      if (next) life.resume()
      else life.pause()
      shown.set(next)
    },

    destroy() {
      life.pause()
      shown.set(false)
      root.unmount()
    },
  }
}
