# PSF Array Viewer — Roadmap

Planned feature work, the invariants it must respect, and the design decisions
already locked. The physics lives in `psf-core` (Rust) with a mirrored JavaScript
fallback in `src/main.js` (`jsCompute`) for the browser preview; **every physics
change lands in both engines** unless a feature is explicitly native-only.

## Invariants

- **No cross-spectral matrix for the conventional PSF.** The delay-and-sum PSF is
  the incoherent per-source sum `Σ_s |hᴴ·gₛ|²` — computed directly from the
  projection of each source's free-field pressure vector `gₛ` onto the steering
  vector `h`. No N×N CSM (nor its diagonal) is ever formed. Diagonal removal is
  the per-source term `Σ_m |h_m|²|g_{s,m}|²`, folded into the same per-mic pass.
  Functional beamforming (task 7) also respects this: it needs `C^{1/ν}`, but the
  sources are a known low-rank set, so the eigendecomposition comes from a tiny
  S×S Gram matrix rather than an N×N CSM (see task 7).
- **No third-party JS charting/PDF libraries.** Plotly was deliberately avoided
  for binary size; keep charts and reports as small self-contained canvas/DOM code.
- **Small native binary.** Prefer self-contained Rust (e.g. a compact Jacobi
  eigensolver) over pulling LAPACK/BLAS system dependencies.

## Locked decisions

| Area | Decision |
| --- | --- |
| PDF report (task 3) | Browser **print-to-PDF**: a printable report DOM + `@media print` CSS + `window.print()`. No bundled PDF lib. |
| Mic editor (task 5) | **2-D top-down** array-plane editor is the primary editing surface; in-3-D drag deferred. Needs a `Manual { pos, weights }` `ArraySource` variant. |
| Beamforming algorithms (task 7) | Scope reduced to **Functional beamforming only** — MVDR/Capon, Robust adaptive and MUSIC are dropped. Because Functional needs no N×N CSM (low-rank S×S route), it runs in **both engines**; the earlier "native-only" constraint no longer applies. |

## Foundational refactors

- **R1 — `compute_at_points(points)`** *(done)*: the per-point beamformer core,
  extracted from `compute_psf`, accepts any point cloud. `compute_psf` is now a
  thin grid wrapper over it. Unlocks arbitrary scan geometry (tasks 4, 7).
- **R2 — raw power + separate normalization** *(done)*: `compute_at_points`
  returns **raw linear power**; `normalize_to_db` converts to peak-referenced dB.
  Lets callers combine maps before normalizing (band-averaging, shared-reference
  A/B, noise floor).
- **R3 — shared modules** *(done)*: `src/linechart.js` is the small dependency-free
  canvas line chart (sweep charts, line-cut, and the A/B overlay all use it).
  `src/colormap.js` is the single source of truth for the colour ramps — used by
  the 2-D contour renderer and by the 3-D mesh colouring, so a map and a model
  painted from it always agree.

## Feature tasks

1. **Broadband / frequency-sweep analysis.** *(done)* `compute_sweep` runs the
   beamformer across a lin/log frequency band, recording −3 dB beamwidths and peak
   side-lobe level per frequency, and optionally accumulating an incoherent
   band-averaged map (raw power summed, normalised once — the reason for R2).
   Driven from an Analysis panel with an explicit "Run sweep" button (too costly
   to run live); results plot in a sweep dialog with the aliasing frequency marked,
   export to CSV, and the band map can replace the single-frequency map.
2. **Optional 1-D line-cut.** *(done)* Off by default behind a toggle, so it costs
   no layout when unused. `PSFPlot.sampleLine` bilinearly samples the current map
   along a segment; cuts run through the map's peak along u and v and render in
   the shared line chart with a −3 dB reference. Cuts can be **pinned** as dashed
   overlays to compare frequencies, shadings or algorithms. No engine change —
   the map data is already client-side.
3. **Array A/B comparison + PDF report.** Two config snapshots computed and shown
   side-by-side with a metrics diff (optionally on a shared dB reference via R2).
   Report via print-to-PDF: a clean report DOM (config tables, embedded map PNGs,
   metrics, optional charts, notes) + `window.print()`.
4. **Loadable STL, PSF on surface points.** *(done)* The STL is parsed client-side
   (three.js `STLLoader`) with a units→metres scale. Its surface vertices are
   thinned to a 4000-point budget and beamformed through the R1 point-cloud core
   (`compute_on_points` natively, `beamformPointsJS` in the web preview), then
   painted back as per-vertex colours using the shared colormap LUT (R3). Gated
   behind an explicit "Evaluate surface" button, since per-point evaluation is
   costly. The mesh itself is not persisted — only the units scale.
5. **Mic selection/move editor.** *(done)* A 2-D top-down editor (`src/micedit.js`)
   seeded from whatever array is currently resolved: click to select, Ctrl+click to
   toggle, drag a marquee to select many, drag to move, arrows to nudge, Del to
   remove, optional snap-to-grid. Editing happens in the array plane's (u, v) basis
   but **preserves each mic's out-of-plane component**, so a 3-D layout (e.g. from
   CSV) survives a round trip. Applying converts the array into a
   `Manual { pos, weights }` source, which persists through save/load — a generator
   would otherwise clobber the edit on the next recompute.
6. **Optional sensor noise floor.** *(done)* White per-sensor variance σ² adds
   `σ²·Σ_m|h_m|²` to the output; diagonal removal cancels it. Exposed as a dB
   slider (`σ² = 10^(dB/10)`) behind an enable checkbox.
7. **Functional beamforming.** *(done)* `P(t) = (hᴴ·C^{1/ν}·h)^ν` (Dougherty), which sharpens
   the main lobe and suppresses side lobes as the exponent ν grows. Implemented
   **without forming a CSM**: with `C = Σ_s gₛgₛᴴ + σ²I` the signal subspace has
   rank ≤ S (the source count), so its eigenpairs come from the S×S Gram matrix
   `M_{st} = gₛᴴ·g_t` — decomposed *once*, not per scan point. Then

   ```
   hᴴC^{1/ν}h = Σ_i (λ_i + σ²)^{1/ν}·|u_iᴴh|²  +  σ^{2/ν}·( ‖h‖² − Σ_i |u_iᴴh|² )
   ```

   where `u_iᴴh` follows from the per-source projections `Sₛ = hᴴgₛ` and `‖h‖² =
   Σ_m|h_m|²` — **both already computed** in `compute_at_points` (the latter added
   for the task-6 noise floor). Only a tiny S×S Hermitian eigendecomposition is
   new; for a single source it is closed-form. Runs in both engines. UI: an
   algorithm selector (Conventional / Functional) plus a ν control.

## Suggested sequencing

1. R1 + R2 *(done)* → task 6 noise floor *(done)*
2. R3 line-chart *(done)* → task 1 sweep *(done)*
3. Task 2 line-cut (reuses the R3 chart) → task 3 A/B + PDF (R2, R3)
4. Task 4 STL (R1, + R3 colormap module) → task 5 mic editor → task 7 functional
   beamforming
