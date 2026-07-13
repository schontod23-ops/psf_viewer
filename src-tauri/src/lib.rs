//! Tauri bridge. All physics lives in `psf-core`; this file only marshals the
//! request from the webview, calls the engine, and serialises the result back.

use psf_core::{
    build_array, compute_psf, metrics as compute_metrics, weights_for, ArraySource, FocusConfig,
    Metrics, Shading, Source, SteeringFormulation,
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![compute])
        .run(tauri::generate_context!())
        .expect("error while running PSF Array Viewer");
}
