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
- **R3 — shared modules** *(todo)*: a colormap-LUT module shared by `psfplot.js`
  and 3-D mesh coloring (task 4); one small canvas line-chart component reused by
  the sweep chart (1), line-cut (2), and A/B overlay (3).

## Feature tasks

1. **Broadband / frequency-sweep analysis.** `compute_sweep(fmin,fmax,points,
   spacing,band)` over the current geometry; per-frequency metrics (beamwidth,
   PSL, max-sidelobe) + incoherent band-averaged maps (needs R2). Analysis panel
   with a "Run sweep" button (too costly live) and a canvas line-chart (log-f x).
2. **Optional 1-D line-cut.** Off by default behind a toggle. Client-side polyline
   sampling of the current map (`PSFPlot.sampleLine`), rendered in the shared line
   chart; supports pinning cuts to overlay across settings. No engine change.
3. **Array A/B comparison + PDF report.** Two config snapshots computed and shown
   side-by-side with a metrics diff (optionally on a shared dB reference via R2).
   Report via print-to-PDF: a clean report DOM (config tables, embedded map PNGs,
   metrics, optional charts, notes) + `window.print()`.
4. **Loadable STL, PSF on surface points.** Parse STL client-side (three.js
   `STLLoader`), sample surface points down to a budget, beamform them via R1
   (`compute_on_points`), color per-vertex with the shared colormap LUT (R3).
   Gated behind a button (per-point evaluation is costly).
5. **Mic selection/move editor.** 2-D top-down editor: click / Ctrl+click /
   rectangle-marquee selection, drag to move, arrow-key nudge, snap, undo/redo.
   Editing converts the working array into a `Manual { pos, weights }` source.
6. **Optional sensor noise floor.** *(done)* White per-sensor variance σ² adds
   `σ²·Σ_m|h_m|²` to the output; diagonal removal cancels it. Exposed as a dB
   slider (`σ² = 10^(dB/10)`) behind an enable checkbox.
7. **Functional beamforming.** `P(t) = (hᴴ·C^{1/ν}·h)^ν` (Dougherty), which sharpens
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
2. Task 1 sweep (needs R2) → task 2 line-cut (R3 chart) → task 3 A/B + PDF (R2, R3)
3. Task 4 STL (R1, R3) → task 5 mic editor → task 7 functional beamforming
