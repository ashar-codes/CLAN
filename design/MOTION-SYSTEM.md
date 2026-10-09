# Motion system

Motion explains *where something went*. Nothing loops except the Guide's slow drift and an active transfer.

| Token | Value | Use |
|---|---|---|
| `--t-quick` | 140 ms | press, hover |
| `--t-base` | 240 ms | panels, toasts, menu items |
| `--t-slow` | 520 ms | screen-level change (exam mode, focus) |
| `--ease-out` | cubic-bezier(.22,1,.36,1) | entrances |
| `--ease-spring` | cubic-bezier(.34,1.56,.64,1) | objects that "lift" (room objects, wheel spokes, + button) |

| Moment | Motion |
|---|---|
| Screen enter | 8 px rise + fade (`--t-base`) |
| Room object hover | lifts 6 px with spring; its label fades in |
| Radial wheel | spokes fly out from the person, staggered by angle |
| Send file | a chip arcs from the file to the person (900 ms; ease-out up, ease-in down, shrinks); then the person's Beacon switches to *transfer* (spinning ring) until verified, then a toast |
| Quick Capture | + rotates to ×; items rise in, 30 ms stagger |
| Focus mode | vignette fades in; navigation dims to 25 %; Beacon → focus |
| Campus | camera glides to the chosen building (critically damped lerp, ~1 s) |
| Exam mode | page reveals top-down (`clip-path`), palette shifts to exam tokens |

`prefers-reduced-motion: reduce` sets every duration to 0 and the send flight to 1 ms; state changes still happen.

## Astra additions

`packages/design/src/motion.ts` preserves native/3D equivalents of the existing duration tokens and a frame-rate-independent camera damping coefficient. The file-flight duration is now centralized (850 ms). Character arrival is 520 ms, followed by two quiet breathing cycles; Focus is still. Room and course entrances use the existing 240 ms rise/fade. Campus rendering is on demand, with a camera that stops requesting frames when settled. Reduced motion responds live, including for an explicitly selected Full experience. Minimal suppresses all CSS animation. Mobile uses a cancellable native opacity transition and no 3D scene.
