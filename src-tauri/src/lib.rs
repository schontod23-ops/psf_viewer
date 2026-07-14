//! Tauri bridge. All physics lives in `psf-core`; this file only marshals the
//! request from the webview, calls the engine, and serialises the result back.

use psf_core::{
    build_array, compute_at_points, compute_psf, metrics as compute_metrics, normalize_to_db,
    sweep_frequencies, weights_for, Algorithm, ArraySource, BeamformOptions, FocusConfig, Metrics,
    Shading, Source, SteeringFormulation, SweepResult,
};
use serde::{Deserialize, Serialize};
use tauri::Emitter;

/// Payload for the `sweep-progress` event emitted once per swept frequency,
/// so the frontend can show a determinate progress bar during a sweep.
#[derive(Clone, Serialize)]
struct SweepProgress {
    step: usize,
    total: usize,
}

/// The physics settings every request carries, sent by the frontend as a nested
/// `physics` object and folded into a `BeamformOptions` here. Deliberately not
/// `#[serde(flatten)]`-ed: flatten plus the internally-tagged `Algorithm` enum is
/// a needless sharp edge.
#[derive(Deserialize)]
pub struct Physics {
    speed_of_sound: f64,
    shading: Shading,
    #[serde(default)]
    steering: SteeringFormulation,
    #[serde(default)]
    diag_removal: bool,
    /// Per-sensor white-noise variance σ² (0 = off).
    #[serde(default)]
    noise_power: f64,
    #[serde(default)]
    algorithm: Algorithm,
}

impl Physics {
    fn options(&self, frequency: f64) -> BeamformOptions {
        BeamformOptions {
            frequency,
            speed_of_sound: self.speed_of_sound,
            formulation: self.steering,
            diag_removal: self.diag_removal,
            noise_power: self.noise_power,
            algorithm: self.algorithm,
        }
    }
}

#[derive(Deserialize)]
pub struct ComputeRequest {
    array: ArraySource,
    focus: FocusConfig,
    /// One or more incoherent point sources, independent of `focus.center`
    /// (which is just the centre of the scanned grid).
    sources: Vec<Source>,
    frequency: f64,
    physics: Physics,
}

#[derive(Serialize)]
pub struct ComputeResponse {
    mics: Vec<[f64; 3]>,
    weights: Vec<f64>,
    nx: usize,
    ny: usize,
    u: Vec<f64>,
    v: Vec<f64>,
    corners: [[f64; 3]; 4],
    values: Vec<f32>,
    metrics: Metrics,
}

/// Resolve the array, run the beamformer, and return geometry + PSF + metrics.
#[tauri::command]
fn compute(req: ComputeRequest) -> Result<ComputeResponse, String> {
    let array = build_array(&req.array)?;
    let weights = weights_for(&array, req.physics.shading);
    let opts = req.physics.options(req.frequency);
    let (grid, values) = compute_psf(&array, &weights, &req.focus, &req.sources, &opts)?;
    let metrics = compute_metrics(&array, &grid, &values, opts.speed_of_sound);
    Ok(ComputeResponse {
        mics: array.pos,
        weights,
        nx: grid.nx,
        ny: grid.ny,
        u: grid.u,
        v: grid.v,
        corners: grid.corners,
        values,
        metrics,
    })
}

/// A broadband sweep over the same scene, at `n_points` frequencies from `f_min`
/// to `f_max`. Optionally also returns an incoherent band-averaged map.
#[derive(Deserialize)]
pub struct SweepRequest {
    array: ArraySource,
    focus: FocusConfig,
    sources: Vec<Source>,
    f_min: f64,
    f_max: f64,
    n_points: usize,
    #[serde(default)]
    log_spacing: bool,
    #[serde(default)]
    band_map: bool,
    physics: Physics,
}

/// Resolve the array, sweep the beamformer across the frequency band, and return
/// per-frequency metrics plus (optionally) the band-averaged map. Runs on a
/// blocking thread and emits `sweep-progress` after each frequency step so the
/// frontend can show a determinate progress bar.
#[tauri::command]
async fn compute_sweep(app: tauri::AppHandle, req: SweepRequest) -> Result<SweepResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let array = build_array(&req.array)?;
        let weights = weights_for(&array, req.physics.shading);
        let frequencies = sweep_frequencies(req.f_min, req.f_max, req.n_points, req.log_spacing)?;
        // `frequency` is overridden for each swept step.
        let opts = req.physics.options(frequencies[0]);
        let mut on_step = |step: usize, total: usize| {
            let _ = app.emit("sweep-progress", SweepProgress { step, total });
        };
        psf_core::compute_sweep(
            &array,
            &weights,
            &req.focus,
            &req.sources,
            &frequencies,
            &opts,
            req.band_map,
            Some(&mut on_step),
        )
    })
    .await
    .map_err(|e| format!("Sweep task panicked: {e}"))?
}

/// Beamform at an arbitrary set of world-space points — used to paint the PSF
/// onto the surface samples of a loaded STL model.
#[derive(Deserialize)]
pub struct PointsRequest {
    array: ArraySource,
    sources: Vec<Source>,
    points: Vec<[f64; 3]>,
    frequency: f64,
    physics: Physics,
}

/// Levels at the requested points, in dB relative to the peak *over those points*.
#[derive(Serialize)]
pub struct PointsResponse {
    values: Vec<f32>,
}

#[tauri::command]
fn compute_on_points(req: PointsRequest) -> Result<PointsResponse, String> {
    if req.points.is_empty() {
        return Err("No surface points to evaluate.".into());
    }
    let array = build_array(&req.array)?;
    let weights = weights_for(&array, req.physics.shading);
    let opts = req.physics.options(req.frequency);
    let raw = compute_at_points(&array, &weights, &req.points, &req.sources, &opts)?;
    Ok(PointsResponse {
        values: normalize_to_db(&raw),
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            compute,
            compute_sweep,
            compute_on_points
        ])
        .run(tauri::generate_context!())
        .expect("error while running PSF Array Viewer");
}
