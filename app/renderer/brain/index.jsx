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

import { Brain, pickRegion } from './scene.jsx'
import { CAMERA } from './atlas.js'
import { createLife } from './life.js'
import { readLook } from './look.js'
import { createSwitch, createView } from './view.js'

function Mount({ life, look, view, onSelect, shown }) {
  const visible = useSyncExternalStore(shown.subscribe, shown.get)
  // The boolean only. The animation between the two states is read off `view`
  // inside the frame loop and never re-renders anything.
  const exploded = useSyncExternalStore(view.subscribe, view.get)
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
      // Opaque, clearing to the room colour — a bloom pass over a transparent
      // canvas is the one place this scene could go wrong for free. Nothing is
      // lost by it only as long as the page behind is flat --ink; see the
      // background colour in scene.jsx.
      gl={{ antialias: true, alpha: false, powerPreference: 'low-power' }}
      raycaster={{ filter: (hits) => pickRegion(hits, exploded) }}
      // Clicking past everything puts it back together. The one way out, since
      // Escape belongs to Stop and a control that stops Wren speaking should not
      // have to share a key with a drawing.
      onPointerMissed={() => {
        setPinned(null)
        view.set(false)
      }}
    >
      <Brain
        life={life}
        look={look}
        view={view}
        exploded={exploded}
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
  const view = createView()
  const root = createRoot(container)
  root.render(<Mount life={life} look={look} view={view} onSelect={onSelect} shown={shown} />)

  return {
    handle(record) {
      life.handle(record)
    },

    setVisible(next) {
      // Leaving the tab does not put the brain back together — you come back to
      // what you left. It only lands there rather than animating a transition
      // that was interrupted by looking away.
      if (next) {
        life.resume()
        view.snap()
      } else {
        life.pause()
      }
      shown.set(next)
    },

    destroy() {
      life.pause()
      shown.set(false)
      root.unmount()
    },
  }
}
