# Mandelbrot Explorer

An interactive Mandelbrot set explorer that runs in the browser. It renders on
every CPU core with Web Workers in 64-bit precision for deep zooms, or on the
GPU with WebGL for real-time exploring near the top level. Plain HTML and
JavaScript, with no build step and no dependencies.

## Run it

Double-click `index.html`. No server needed: the render workers are built
in-page from a Blob URL, so they also run from `file://`. Serving the folder
(`python -m http.server`) works too.

## Controls

| Input | Action |
|---|---|
| Scroll / double-click | Zoom in at the cursor (Shift + double-click zooms out) |
| Drag | Pan |
| `P` | Next palette (Mono, Ember, Ocean, Neon, Sunset) |
| `C` | Cycle colours |
| `G` | Toggle GPU mode |
| `[` / `]` | Halve / double the iteration budget |
| `Q` | Toggle 2× supersampling (smoother edges, sharper fine detail, ~1.6× render time) |
| `1`–`4` | Whole set, spiral arms, seahorse valley, elephant valley |
| `R` | Reset to the whole set |
| `S` | Save the current view as a PNG |
| `H` | Hide the overlay |

The URL updates with the current view (`#x,y,zoom`), so a link reopens the same spot.

## How it renders

- **One row per task, across every core.** Rows go out to a pool of workers
  (one per CPU thread), one row at a time, centre rows first. Busy areas no
  longer stall a single worker. When you move, rows queued for the old view are
  dropped instead of drawn late.
- **Coarse pass, then full resolution.** A quick 1-in-8 pass appears first.
  The last image is also stretched and shifted to the new view straight away,
  so zooming and panning feel immediate.
- **Skipping the expensive interior.** Points in the main cardioid and the
  period-2 bulb are detected in closed form, and a periodicity check spots
  orbits that have settled into a cycle. Pixels inside the set are where the
  full iteration count gets spent, so this is where most of the time goes.
- **Detail that follows zoom.** The iteration budget grows with zoom depth
  instead of a fixed 20,000.
- **Smooth colouring.** A normalised iteration count and cosine palettes,
  through a lookup table. Switching palettes or cycling colours only recolours
  the stored escape values; it doesn't recompute.
- **GPU mode** runs the same formula in a WebGL fragment shader. 32-bit floats
  run out of precision around 10,000× zoom, so past that it switches back to the
  CPU on its own.

- **Native resolution.** The canvas is sized in device pixels
  (`devicePixelRatio`), so Windows display scaling and high-DPI screens get
  one computed point per physical pixel.

At 1280×720 on a 24-thread machine, a typical view renders in about 130–450 ms.

## History

This merges earlier experiments into one page: the first single-threaded
canvas versions, a Web Worker version, and a WebGL shader version.
