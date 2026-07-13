//! Tauri bridge. All physics lives in `psf-core`; this file only marshals the
//! request from the webview, calls the engine, and serialises the result back.

use psf_core::{
    build_array, compute_psf, metrics as compute_metrics, sweep_frequencies, weights_for,
    ArraySource, FocusConfig, Metrics, Shading, Source, SteeringFormulation, SweepResult,
};
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
pub struct ComputeRequest {
    array: ArraySource,
    focus: FocusConfig,
    /// One or more incoherent point sources, independent of `focus.center`
    /// (which is just the centre of the scanned grid).
    sources: Vec<Source>,
    frequency: f64,
    speed_of_sound: f64,
    shading: Shading,
    #[serde(default)]
    steering: SteeringFormulation,
    #[serde(default)]
    diag_removal: bool,
    /// Per-sensor white-noise variance σ² (0 = off). Adds an optional sensor
    /// noise floor to the beamformer output.
    #[serde(default)]
    noise_power: f64,
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
    let weights = weights_for(&array, req.shading);
    let (grid, values) = compute_psf(
        &array,
        &weights,
        &req.focus,
        &req.sources,
        req.frequency,
        req.speed_of_sound,
        req.steering,
        req.diag_removal,
        req.noise_power,
    )?;
    let metrics = compute_metrics(&array, &grid, &values, req.speed_of_sound);
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
    speed_of_sound: f64,
    shading: Shading,
    #[serde(default)]
    steering: SteeringFormulation,
    #[serde(default)]
    diag_removal: bool,
    #[serde(default)]
    noise_power: f64,
    f_min: f64,
    f_max: f64,
    n_points: usize,
    #[serde(default)]
    log_spacing: bool,
    #[serde(default)]
    band_map: bool,
}

/// Resolve the array, sweep the beamformer across the frequency band, and return
/// per-frequency metrics plus (optionally) the band-averaged map.
#[tauri::command]
fn compute_sweep(req: SweepRequest) -> Result<SweepResult, String> {
    let array = build_array(&req.array)?;
    let weights = weights_for(&array, req.shading);
    let frequencies = sweep_frequencies(req.f_min, req.f_max, req.n_points, req.log_spacing)?;
    psf_core::compute_sweep(
        &array,
        &weights,
        &req.focus,
        &req.sources,
        &frequencies,
        req.speed_of_sound,
        req.steering,
        req.diag_removal,
        req.noise_power,
        req.band_map,
    )
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![compute, compute_sweep])
        .run(tauri::generate_context!())
        .expect("error while running PSF Array Viewer");
}
