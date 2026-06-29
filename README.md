# PSF Array Viewer

A small, fast desktop application for visualising the **acoustic point-spread
function (PSF)** of a microphone array. Configure an array and a focus plane,
and the app shows the beamformer's spatial response as a filled-contour map
(matplotlib-style `turbo` colormap) next to a rotatable 3-D view of the
geometry.

Built with **Rust + Tauri** (native, size-optimised binary) — the physics runs
in Rust, the 3-D geometry is drawn with three.js, and the PSF map is rendered
with d3-contour on a canvas.

---

## What it shows

The app models a **near-field delay-and-sum beamformer**. A single unit point
source is placed at the centre of the focus plane. The steering point is swept
across the plane, and the normalised beamformer power at each point is the PSF:

```
b(r_s) = (1 / Σ w_m) · Σ_m  w_m · exp[ j k (d_ms − d_m0) ]
P(r_s) = |b(r_s)|²            k = 2πf / c
```

where `d_ms = ‖r_s − r_m‖` is the distance from steering point to mic *m*,
`d_m0` is the distance from the source to mic *m*, and `w_m` are the shading
weights. `P` is normalised so the peak at the source is `1` (0 dB). The map is
shown in dB over an adjustable dynamic range.

This is the classic array PSF: a main lobe at the source, a ring of nulls, and
side lobes whose level and spacing depend on the array layout. Above the array's
**spatial-aliasing frequency** (`c / 2·d_min`), grating lobes appear — the app
flags this in the status bar.

## Features

- **Array definition**
  - *Sunflower* (Vogel-spiral) array — set microphone count, diameter, plane
    (xy / xz / yz) and centre.
  - *CSV import* — load positions from a file (`x, y, z`, optional 4th column =
    per-mic weight).
- **Focus plane** — centre, plane, width, height and grid step `dx`.
- **Physics** — frequency, speed of sound, and an amplitude-shading window
  (Uniform or Hann).
- **Display** — dynamic range (dB), number of contour bands, contour lines on/off.
- **Live metrics** — microphone count, aperture, −3 dB beamwidth (u × v), peak
  side-lobe level, and spatial-aliasing frequency.
- Rotatable 3-D geometry with the focus plane textured by the live PSF.

## Project layout

```
psf-array-viewer/
├── psf-core/            # pure-Rust physics engine (unit-tested, no GUI deps)
│   └── src/lib.rs
├── src-tauri/           # Tauri shell — thin command wrapper over psf-core
│   ├── src/lib.rs       #   #[tauri::command] compute(...)
│   ├── tauri.conf.json
│   └── icons/
├── src/                 # frontend
│   ├── main.js          # state, controls, compute pipeline, ambient field
│   ├── psfplot.js       # contourf renderer (turbo) + colorbar + axes
│   ├── geometry3d.js    # three.js geometry view
│   └── style.css
├── examples/array.csv   # sample two-ring array
├── index.html
└── .github/workflows/build.yml
```

The physics lives entirely in `psf-core` so it can be tested without the webview
toolchain:

```bash
cd psf-core && cargo test
```

## Running locally

**Prerequisites:** [Rust](https://rustup.rs), [Node 18+](https://nodejs.org),
and the Tauri system dependencies for your OS
(see https://tauri.app/start/prerequisites/). On Debian/Ubuntu:

```bash
sudo apt-get install libwebkit2gtk-4.1-dev libgtk-3-dev \
  libayatana-appindicator3-dev librsvg2-dev patchelf build-essential
```

Then:

```bash
npm install
npm run tauri dev      # hot-reloading dev build
npm run tauri build    # optimised installers for the current OS
```

> The frontend also runs as a plain web preview (`npm run dev`) using an
> equivalent JavaScript beamformer, handy for tweaking the UI without a full
> Tauri build.

## Building installers (Windows + Linux)

A GitHub Actions workflow (`.github/workflows/build.yml`) builds on native
runners:

- **Linux** (`ubuntu-22.04`) → `.AppImage` and `.deb`
- **Windows** (`windows-latest`) → NSIS `.exe` installer

**To get installers:**

- **Tagged release** — push a tag and a draft GitHub Release is created with the
  installers attached:
  ```bash
  git tag v0.1.0 && git push origin v0.1.0
  ```
- **Ad-hoc** — trigger the workflow manually (Actions → *build* → *Run
  workflow*); the installers are uploaded as build artifacts.

## CSV format

Plain text, one microphone per line. Comma, semicolon, tab or space delimited.
A header row and `#` comment lines are ignored.

```csv
# x, y, z, weight
x,y,z,weight
0.12,0.0,0.0,1.0
0.0849,0.0849,0.0,1.0
...
```

Columns are `x y z` in metres. An optional 4th column sets the microphone's
weight (overriding the shading window). See `examples/array.csv`.

## Notes on size

The release profile is tuned for a small binary (`opt-level = "z"`, LTO,
`panic = "abort"`, symbols stripped). The bundle embeds the web assets; the
JavaScript is dominated by three.js (~130 kB gzipped). Plotly was deliberately
avoided to keep things light.

## License

MIT.
