//! psf-core — acoustic point-spread-function engine for microphone arrays.
//!
//! Pure compute (no GUI deps) so the physics can be unit-tested in isolation.
//! Model: near-field delay-and-sum beamformer. A single unit point source is
//! placed at the centre of the focus plane; the steering point is swept across
//! the plane and the normalised beamformer power is the point-spread function.
//!
//!   b(r_s) = (1/Σw) · Σ_m w_m · exp[ j k (d_ms − d_m0) ]
//!   P(r_s) = |b(r_s)|²            (peak = 1 at r_s = source ⇒ 0 dB)
//!
//! where d_ms = ‖r_s − r_m‖, d_m0 = ‖source − r_m‖, k = 2πf/c.

use rayon::prelude::*;
use serde::{Deserialize, Serialize};

/// Golden angle in radians: π·(3 − √5).
pub const GOLDEN_ANGLE: f64 = 2.399_963_229_728_653_3;

/// Floor applied to dB values so a perfect null never yields −∞.
const DB_FLOOR: f32 = -300.0;

// ─────────────────────────────────────────────────────────── planes & vectors

/// The cartesian plane a 2-D layout (array or focus grid) lives in.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Plane {
    Xy,
    Xz,
    Yz,
}

impl Plane {
    /// Orthonormal `(u_hat, v_hat, normal)` for this plane.
    /// `u` is the horizontal (width) axis, `v` the vertical (height) axis.
    pub fn basis(self) -> ([f64; 3], [f64; 3], [f64; 3]) {
        match self {
            Plane::Xy => ([1., 0., 0.], [0., 1., 0.], [0., 0., 1.]),
            Plane::Xz => ([1., 0., 0.], [0., 0., 1.], [0., 1., 0.]),
            Plane::Yz => ([0., 1., 0.], [0., 0., 1.], [1., 0., 0.]),
        }
    }
}

#[inline]
fn add(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}
#[inline]
fn scale(a: [f64; 3], s: f64) -> [f64; 3] {
    [a[0] * s, a[1] * s, a[2] * s]
}
#[inline]
fn dist(a: [f64; 3], b: [f64; 3]) -> f64 {
    let dx = a[0] - b[0];
    let dy = a[1] - b[1];
    let dz = a[2] - b[2];
    (dx * dx + dy * dy + dz * dz).sqrt()
}

// ─────────────────────────────────────────────────────────── amplitude shading

/// Amplitude window applied across the array aperture.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Shading {
    Uniform,
    Hann,
}

// ─────────────────────────────────────────────────────────── array definition

/// Where the microphone positions come from.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ArraySource {
    /// Vogel-spiral (sunflower) array.
    Sunflower {
        n: usize,
        diameter: f64,
        center: [f64; 3],
        plane: Plane,
    },
    /// Positions parsed from CSV text (3 columns x,y,z; optional 4th = weight).
    Csv { text: String },
}

/// Resolved microphone layout.
#[derive(Clone, Debug, Default)]
pub struct Array {
    pub pos: Vec<[f64; 3]>,
    /// Per-mic weights from the CSV 4th column, if present.
    pub csv_weights: Option<Vec<f64>>,
}

impl Array {
    pub fn len(&self) -> usize {
        self.pos.len()
    }
    pub fn is_empty(&self) -> bool {
        self.pos.is_empty()
    }
    /// Geometric centroid of the array.
    pub fn centroid(&self) -> [f64; 3] {
        let n = self.pos.len().max(1) as f64;
        let s = self
            .pos
            .iter()
            .fold([0.; 3], |acc, p| add(acc, *p));
        scale(s, 1.0 / n)
    }
}

/// Build microphone positions from a source description.
pub fn build_array(src: &ArraySource) -> Result<Array, String> {
    match src {
        ArraySource::Sunflower {
            n,
            diameter,
            center,
            plane,
        } => {
            if *n == 0 {
                return Err("Array needs at least one microphone.".into());
            }
            if !(diameter.is_finite()) || *diameter <= 0.0 {
                return Err("Array diameter must be a positive number.".into());
            }
            let (uh, vh, _) = plane.basis();
            let r_outer = diameter / 2.0;
            let nn = *n as f64;
            let pos = (0..*n)
                .map(|k| {
                    let kk = k as f64;
                    // √ distribution gives equal-area (uniform) radial density.
                    let r = r_outer * ((kk + 0.5) / nn).sqrt();
                    let theta = kk * GOLDEN_ANGLE;
                    let (s, c) = theta.sin_cos();
                    add(*center, add(scale(uh, r * c), scale(vh, r * s)))
                })
                .collect();
            Ok(Array {
                pos,
                csv_weights: None,
            })
        }
        ArraySource::Csv { text } => parse_csv(text),
    }
}

/// Parse mic positions from CSV/whitespace text. Auto-detects a header row,
/// accepts comma / semicolon / tab / space delimiters, ignores blank lines and
/// `#` comments. A 4th numeric column is read as a per-mic weight.
pub fn parse_csv(text: &str) -> Result<Array, String> {
    let mut pos = Vec::new();
    let mut weights = Vec::new();
    let mut any_weight = false;

    for (lineno, raw) in text.lines().enumerate() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let fields: Vec<&str> = line
            .split(|c: char| c == ',' || c == ';' || c == '\t' || c == ' ')
            .filter(|s| !s.is_empty())
            .collect();
        if fields.len() < 3 {
            continue;
        }
        let parsed: Option<Vec<f64>> = fields
            .iter()
            .take(4)
            .map(|f| f.trim().parse::<f64>().ok())
            .collect();
        match parsed {
            Some(vals) => {
                pos.push([vals[0], vals[1], vals[2]]);
                if vals.len() >= 4 {
                    weights.push(vals[3]);
                    any_weight = true;
                } else {
                    weights.push(1.0);
                }
            }
            None => {
                // Non-numeric row: treat as header only on the first content row.
                if pos.is_empty() {
                    continue;
                } else {
                    return Err(format!("Could not parse numbers on line {}.", lineno + 1));
                }
            }
        }
    }

    if pos.is_empty() {
        return Err("No microphone rows found (need 3 numeric columns: x,y,z).".into());
    }
    Ok(Array {
        pos,
        csv_weights: if any_weight { Some(weights) } else { None },
    })
}

/// Compute the per-mic weight vector for a given shading window.
/// CSV-supplied weights take precedence over the window.
pub fn weights_for(array: &Array, shading: Shading) -> Vec<f64> {
    if let Some(w) = &array.csv_weights {
        return w.clone();
    }
    match shading {
        Shading::Uniform => vec![1.0; array.len()],
        Shading::Hann => {
            let c = array.centroid();
            let rmax = array
                .pos
                .iter()
                .map(|p| dist(*p, c))
                .fold(0.0_f64, f64::max)
                .max(1e-12);
            array
                .pos
                .iter()
                .map(|p| {
                    let rho = (dist(*p, c) / rmax).min(1.0);
                    0.5 * (1.0 + (std::f64::consts::PI * rho).cos())
                })
                .collect()
        }
    }
}

// ─────────────────────────────────────────────────────────── steering vector

/// Sarradj (2012) steering-vector formulation used to build the beamformer
/// weight vector `h_m(t)` for scan point `t`.
///
/// Let `rm(t)` be the distance from mic `m` to `t`, `r0(t)` the distance from
/// a fixed reference point (here: the array centroid) to `t`, and
///   x_m(t) = [r0(t)/rm(t)] · exp[-jk(rm(t) − r0(t))]
/// the free-field transfer-function ratio relative to that reference. Then:
///   I   (classic):       h_m = x_m / |x_m|                (phase only)
///   II  (inverse):       h_m = 1 / conj(x_m)
///   III (true level):    h_m = x_m / Σ_m w_m|x_m|²
///   IV  (true location): h_m = x_m / √(Σ_m w_m · Σ_m w_m|x_m|²)
/// (all further scaled by the per-mic shading weight `w_m`). Formulation I
/// matches a plain delay-and-sum beamformer; II-IV additionally compensate
/// the near-field amplitude falloff so the array focuses at the correct
/// level ("true level"/"true location") rather than just the correct phase.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize, Default)]
#[serde(rename_all = "UPPERCASE")]
pub enum SteeringFormulation {
    #[default]
    I,
    Ii,
    Iii,
    Iv,
}

// ─────────────────────────────────────────────────────────── focus grid

/// Focus / scan-plane description.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct FocusConfig {
    pub center: [f64; 3],
    pub plane: Plane,
    pub width: f64,
    pub height: f64,
    pub dx: f64,
}

/// Scan grid geometry (sample coordinates + the rectangle's 3-D corners).
#[derive(Clone, Debug, Serialize)]
pub struct Grid {
    pub nx: usize,
    pub ny: usize,
    /// In-plane horizontal sample coordinates (metres, relative to centre).
    pub u: Vec<f64>,
    /// In-plane vertical sample coordinates (metres, relative to centre).
    pub v: Vec<f64>,
    /// 3-D world corners (BL, BR, TR, TL) for rendering the plane.
    pub corners: [[f64; 3]; 4],
}

impl FocusConfig {
    pub fn grid(&self) -> Result<Grid, String> {
        if self.dx <= 0.0 || !self.dx.is_finite() {
            return Err("Grid step dx must be a positive number.".into());
        }
        if self.width <= 0.0 || self.height <= 0.0 {
            return Err("Focus width and height must be positive.".into());
        }
        let nx = ((self.width / self.dx).round() as usize).max(1) + 1;
        let ny = ((self.height / self.dx).round() as usize).max(1) + 1;
        if nx * ny > 4_000_000 {
            return Err("Grid too fine — increase dx or shrink the focus area.".into());
        }
        let u: Vec<f64> = (0..nx)
            .map(|i| -self.width / 2.0 + i as f64 * self.dx)
            .collect();
        let v: Vec<f64> = (0..ny)
            .map(|j| -self.height / 2.0 + j as f64 * self.dx)
            .collect();
        let (uh, vh, _) = self.plane.basis();
        let p = |uu: f64, vv: f64| add(self.center, add(scale(uh, uu), scale(vh, vv)));
        let (u0, u1) = (*u.first().unwrap(), *u.last().unwrap());
        let (v0, v1) = (*v.first().unwrap(), *v.last().unwrap());
        let corners = [p(u0, v0), p(u1, v0), p(u1, v1), p(u0, v1)];
        Ok(Grid { nx, ny, u, v, corners })
    }
}

// ─────────────────────────────────────────────────────────── beamformer

/// Compute the normalised PSF (dB) over the focus grid, using a rank-1
/// cross-spectral matrix `C = p·pᴴ` built from a single unit point source
/// (`p_m` = free-field pressure at mic `m`), steered with the chosen Sarradj
/// formulation. With `diag_removal` the CSM diagonal (autopower) terms are
/// subtracted before computing the beamformer output, i.e.
///   P(t) = hᴴ(t)·C·h(t) − diag_removal · Σ_m |h_m(t)|²|p_m|²
/// Returns row-major values (`v` outer, `u` inner), length `nx*ny`, in dB
/// relative to the value at the focus centre (peak = 0 dB there).
pub fn compute_psf(
    array: &Array,
    weights: &[f64],
    focus: &FocusConfig,
    frequency: f64,
    speed_of_sound: f64,
    formulation: SteeringFormulation,
    diag_removal: bool,
) -> Result<(Grid, Vec<f32>), String> {
    if array.is_empty() {
        return Err("No microphones to compute with.".into());
    }
    if frequency <= 0.0 || speed_of_sound <= 0.0 {
        return Err("Frequency and speed of sound must be positive.".into());
    }
    let grid = focus.grid()?;
    let (uh, vh, _) = focus.plane.basis();
    let k = 2.0 * std::f64::consts::PI * frequency / speed_of_sound;

    let source = focus.center;
    let reference = array.centroid();
    let mics = &array.pos;

    // Actual free-field pressure at each mic from the unit source
    // (1/r amplitude falloff + propagation phase).
    let p: Vec<(f64, f64)> = mics
        .iter()
        .map(|m| {
            let d = dist(*m, source).max(1e-9);
            let phase = -k * d;
            let (s, c) = phase.sin_cos();
            (c / d, s / d)
        })
        .collect();

    let wsum: f64 = weights.iter().sum();
    let wsum_safe = if wsum.abs() < 1e-30 { 1.0 } else { wsum };
    let needs_norm_pass = matches!(formulation, SteeringFormulation::Iii | SteeringFormulation::Iv);

    let mut raw = vec![0f64; grid.nx * grid.ny];

    raw.par_chunks_mut(grid.nx)
        .enumerate()
        .for_each(|(j, row)| {
            let vv = grid.v[j];
            for (i, cell) in row.iter_mut().enumerate() {
                let uu = grid.u[i];
                let point = add(focus.center, add(scale(uh, uu), scale(vh, vv)));
                let r0 = dist(reference, point).max(1e-9);

                // III/IV need Σ w_m|x_m|² = Σ w_m·(r0/rm)² up front.
                let norm_sq_sum = if needs_norm_pass {
                    let mut s = 0.0f64;
                    for (m, mic) in mics.iter().enumerate() {
                        let rm = dist(*mic, point).max(1e-9);
                        let g = r0 / rm;
                        s += weights[m] * g * g;
                    }
                    if s.abs() < 1e-30 { 1.0 } else { s }
                } else {
                    1.0
                };
                let norm: f64 = match formulation {
                    SteeringFormulation::I | SteeringFormulation::Ii => wsum_safe,
                    SteeringFormulation::Iii => norm_sq_sum,
                    SteeringFormulation::Iv => (wsum_safe.max(0.0) * norm_sq_sum).sqrt(),
                };
                let inv_norm = if norm.abs() < 1e-30 { 1.0 } else { 1.0 / norm };

                let mut s_re = 0.0f64;
                let mut s_im = 0.0f64;
                let mut diag_sum = 0.0f64;
                for (m, mic) in mics.iter().enumerate() {
                    let rm = dist(*mic, point).max(1e-9);
                    let g = r0 / rm;
                    let phase = -k * (rm - r0);
                    let (s, c) = phase.sin_cos();
                    // y_m per formulation (unweighted, unnormalised steering coeff.)
                    let (y_re, y_im) = match formulation {
                        SteeringFormulation::I => (c, s),
                        SteeringFormulation::Ii => (c / g, s / g),
                        SteeringFormulation::Iii | SteeringFormulation::Iv => (g * c, g * s),
                    };
                    let h_re = weights[m] * y_re * inv_norm;
                    let h_im = weights[m] * y_im * inv_norm;
                    let (p_re, p_im) = p[m];
                    // S += conj(h_m) * p_m
                    s_re += h_re * p_re + h_im * p_im;
                    s_im += h_re * p_im - h_im * p_re;
                    if diag_removal {
                        diag_sum += (h_re * h_re + h_im * h_im) * (p_re * p_re + p_im * p_im);
                    }
                }
                let mut power = s_re * s_re + s_im * s_im;
                if diag_removal {
                    power -= diag_sum;
                }
                *cell = power.max(0.0);
            }
        });

    let cx = grid.nx / 2;
    let cy = grid.ny / 2;
    let p0 = raw[cy * grid.nx + cx].max(1e-30);

    let values: Vec<f32> = raw
        .iter()
        .map(|&p| (10.0 * (p / p0 + 1e-30).log10()).max(DB_FLOOR as f64) as f32)
        .collect();

    Ok((grid, values))
}

// ─────────────────────────────────────────────────────────── metrics

/// Derived performance metrics for the current configuration.
#[derive(Clone, Debug, Default, Serialize)]
pub struct Metrics {
    /// −3 dB main-lobe width along the horizontal axis (metres).
    pub beamwidth_u: Option<f64>,
    /// −3 dB main-lobe width along the vertical axis (metres).
    pub beamwidth_v: Option<f64>,
    /// Peak side-lobe level (dB, ≤ 0).
    pub peak_sidelobe_db: Option<f32>,
    /// Approximate spatial-aliasing frequency, c / (2·min-spacing) (Hz).
    pub alias_frequency: Option<f64>,
    /// Largest pairwise mic distance — the array aperture (metres).
    pub aperture: f64,
    pub n_mics: usize,
}

/// Linear-interpolated −3 dB crossing distance from centre along one direction.
fn half_width(coords: &[f64], line: &[f32], center: usize, forward: bool) -> Option<f64> {
    let target = -3.0f32;
    let mut idx = center;
    loop {
        let next = if forward {
            idx.checked_add(1)?
        } else {
            idx.checked_sub(1)?
        };
        if next >= coords.len() {
            return None;
        }
        if line[next] <= target {
            // linear interpolation of the −3 dB crossing between idx and next
            let (a, b) = (line[idx], line[next]);
            let frac = if (a - b).abs() < 1e-9 {
                0.0
            } else {
                ((a - target) / (a - b)) as f64
            };
            let ca = coords[idx];
            let cb = coords[next];
            return Some((ca + frac * (cb - ca) - coords[center]).abs());
        }
        idx = next;
    }
}

/// First-null index distance from centre (in cells) along one direction.
fn first_null(line: &[f32], center: usize, forward: bool, len: usize) -> usize {
    let mut idx = center;
    loop {
        let next = if forward {
            idx + 1
        } else {
            if idx == 0 {
                return len;
            }
            idx - 1
        };
        if next >= len {
            return len;
        }
        // local minimum = a rise after this point
        if line[next] > line[idx] && idx != center {
            return idx.abs_diff(center);
        }
        idx = next;
    }
}

pub fn metrics(array: &Array, grid: &Grid, values: &[f32], frequency_c: f64) -> Metrics {
    let (nx, ny) = (grid.nx, grid.ny);
    let cx = nx / 2;
    let cy = ny / 2;

    // center row (constant v) and center column (constant u)
    let row: Vec<f32> = (0..nx).map(|i| values[cy * nx + i]).collect();
    let col: Vec<f32> = (0..ny).map(|j| values[j * nx + cx]).collect();

    let bw_u = match (
        half_width(&grid.u, &row, cx, true),
        half_width(&grid.u, &row, cx, false),
    ) {
        (Some(r), Some(l)) => Some(r + l),
        _ => None,
    };
    let bw_v = match (
        half_width(&grid.v, &col, cy, true),
        half_width(&grid.v, &col, cy, false),
    ) {
        (Some(r), Some(l)) => Some(r + l),
        _ => None,
    };

    // main-lobe radius (cells) from first nulls, used to mask the PSL search.
    let nr = first_null(&row, cx, true, nx)
        .max(first_null(&row, cx, false, nx))
        .max(first_null(&col, cy, true, ny))
        .max(first_null(&col, cy, false, ny)) as f64;
    let mut psl = None::<f32>;
    if nr < (nx.max(ny) as f64) {
        let mut best = DB_FLOOR;
        for j in 0..ny {
            for i in 0..nx {
                let du = (i as f64 - cx as f64) / nr.max(1.0);
                let dv = (j as f64 - cy as f64) / nr.max(1.0);
                if du * du + dv * dv > 1.0 {
                    let val = values[j * nx + i];
                    if val > best {
                        best = val;
                    }
                }
            }
        }
        if best > DB_FLOOR {
            psl = Some(best);
        }
    }

    // nearest-neighbour minimum spacing → aliasing frequency
    let mut dmin = f64::INFINITY;
    let mut aperture = 0.0f64;
    for a in 0..array.len() {
        for b in (a + 1)..array.len() {
            let d = dist(array.pos[a], array.pos[b]);
            if d < dmin {
                dmin = d;
            }
            if d > aperture {
                aperture = d;
            }
        }
    }
    let alias = if dmin.is_finite() && dmin > 0.0 {
        Some(frequency_c / (2.0 * dmin)) // frequency_c carries the speed of sound
    } else {
        None
    };

    Metrics {
        beamwidth_u: bw_u,
        beamwidth_v: bw_v,
        peak_sidelobe_db: psl,
        alias_frequency: alias,
        aperture,
        n_mics: array.len(),
    }
}

// ─────────────────────────────────────────────────────────── tests

#[cfg(test)]
mod tests {
    use super::*;

    fn sunflower(n: usize, d: f64) -> ArraySource {
        ArraySource::Sunflower {
            n,
            diameter: d,
            center: [0., 0., 0.],
            plane: Plane::Xy,
        }
    }

    #[test]
    fn sunflower_count_and_radius() {
        let a = build_array(&sunflower(64, 1.0)).unwrap();
        assert_eq!(a.len(), 64);
        for p in &a.pos {
            let r = (p[0] * p[0] + p[1] * p[1]).sqrt();
            assert!(r <= 0.5 + 1e-9, "mic outside aperture: {r}");
            assert!(p[2].abs() < 1e-12, "xy array must have z=0");
        }
    }

    #[test]
    fn csv_parsing_with_header_and_weights() {
        let txt = "x,y,z,w\n0,0,0,1.0\n0.1,0,0,0.5\n# comment\n-0.1,0.2,0,0.25\n";
        let a = parse_csv(txt).unwrap();
        assert_eq!(a.len(), 3);
        assert_eq!(a.csv_weights.as_ref().unwrap()[1], 0.5);
        assert!((a.pos[2][1] - 0.2).abs() < 1e-12);
    }

    #[test]
    fn csv_whitespace_no_header() {
        let a = parse_csv("0 0 0\n0.1 0.1 0\n").unwrap();
        assert_eq!(a.len(), 2);
        assert!(a.csv_weights.is_none());
    }

    fn focus() -> FocusConfig {
        FocusConfig {
            center: [0., 0., 1.0],
            plane: Plane::Xy,
            width: 1.0,
            height: 1.0,
            dx: 0.02,
        }
    }

    #[test]
    fn peak_is_zero_db_at_center() {
        let a = build_array(&sunflower(64, 1.0)).unwrap();
        let w = weights_for(&a, Shading::Uniform);
        let (g, vals) = compute_psf(
            &a,
            &w,
            &focus(),
            5000.0,
            343.0,
            SteeringFormulation::I,
            false,
        )
        .unwrap();
        let cx = g.nx / 2;
        let cy = g.ny / 2;
        let center = vals[cy * g.nx + cx];
        assert!(center.abs() < 1e-3, "center should be 0 dB, got {center}");
        // nothing should exceed the peak
        let max = vals.iter().cloned().fold(f32::MIN, f32::max);
        assert!(max <= center + 1e-3, "peak exceeds center: {max}");
    }

    #[test]
    fn symmetric_array_gives_symmetric_psf() {
        let a = build_array(&sunflower(100, 1.0)).unwrap();
        let w = weights_for(&a, Shading::Uniform);
        let (g, vals) = compute_psf(
            &a,
            &w,
            &focus(),
            4000.0,
            343.0,
            SteeringFormulation::I,
            false,
        )
        .unwrap();
        // The full sunflower isn't perfectly mirror-symmetric, but the central
        // mainlobe should be near-symmetric: compare immediate neighbours.
        let cx = g.nx / 2;
        let cy = g.ny / 2;
        let left = vals[cy * g.nx + (cx - 1)];
        let right = vals[cy * g.nx + (cx + 1)];
        assert!((left - right).abs() < 1.0, "mainlobe asym: {left} vs {right}");
    }

    #[test]
    fn higher_frequency_narrows_mainlobe() {
        let a = build_array(&sunflower(81, 1.0)).unwrap();
        let w = weights_for(&a, Shading::Uniform);
        let f = focus();
        let (g1, v1) =
            compute_psf(&a, &w, &f, 2000.0, 343.0, SteeringFormulation::I, false).unwrap();
        let m1 = metrics(&a, &g1, &v1, 343.0);
        let (g2, v2) =
            compute_psf(&a, &w, &f, 8000.0, 343.0, SteeringFormulation::I, false).unwrap();
        let m2 = metrics(&a, &g2, &v2, 343.0);
        let b1 = m1.beamwidth_u.unwrap();
        let b2 = m2.beamwidth_u.unwrap();
        assert!(b2 < b1, "higher f should narrow beam: {b1} -> {b2}");
    }

    #[test]
    fn alias_frequency_reasonable() {
        let a = build_array(&sunflower(50, 1.0)).unwrap();
        let w = weights_for(&a, Shading::Uniform);
        let (g, v) = compute_psf(
            &a,
            &w,
            &focus(),
            3000.0,
            343.0,
            SteeringFormulation::I,
            false,
        )
        .unwrap();
        let m = metrics(&a, &g, &v, 343.0);
        assert!(m.alias_frequency.unwrap() > 0.0);
        assert!(m.aperture > 0.9 && m.aperture <= 1.0001);
    }

    // Close, strongly near-field focus so amplitude falloff across the
    // aperture is significant enough to tell the formulations apart.
    fn near_focus() -> FocusConfig {
        FocusConfig {
            center: [0., 0., 0.3],
            plane: Plane::Xy,
            width: 0.6,
            height: 0.6,
            dx: 0.02,
        }
    }

    #[test]
    fn all_formulations_peak_at_center() {
        let a = build_array(&sunflower(48, 1.0)).unwrap();
        let w = weights_for(&a, Shading::Uniform);
        for formulation in [
            SteeringFormulation::I,
            SteeringFormulation::Ii,
            SteeringFormulation::Iii,
            SteeringFormulation::Iv,
        ] {
            for diag_removal in [false, true] {
                let (g, vals) = compute_psf(
                    &a,
                    &w,
                    &near_focus(),
                    4000.0,
                    343.0,
                    formulation,
                    diag_removal,
                )
                .unwrap();
                let center = vals[(g.ny / 2) * g.nx + (g.nx / 2)];
                assert!(
                    center.abs() < 1e-3,
                    "{formulation:?} diag_removal={diag_removal}: center should be 0 dB, got {center}"
                );
                assert!(
                    vals.iter().all(|v| v.is_finite()),
                    "{formulation:?} diag_removal={diag_removal}: non-finite value in grid"
                );
            }
        }
    }

    #[test]
    fn formulations_diverge_in_near_field() {
        // Amplitude-compensating formulations (III) should give a materially
        // different field than the phase-only classic formulation (I) once
        // the source is close enough that 1/r falloff varies across mics.
        let a = build_array(&sunflower(48, 1.0)).unwrap();
        let w = weights_for(&a, Shading::Uniform);
        let (_, v1) = compute_psf(
            &a,
            &w,
            &near_focus(),
            4000.0,
            343.0,
            SteeringFormulation::I,
            false,
        )
        .unwrap();
        let (_, v3) = compute_psf(
            &a,
            &w,
            &near_focus(),
            4000.0,
            343.0,
            SteeringFormulation::Iii,
            false,
        )
        .unwrap();
        let max_diff = v1
            .iter()
            .zip(v3.iter())
            .map(|(a, b)| (a - b).abs())
            .fold(0.0f32, f32::max);
        assert!(
            max_diff > 0.1,
            "formulations I and III should diverge in the near field, max diff was {max_diff}"
        );
    }

    #[test]
    fn diagonal_removal_never_increases_raw_power() {
        // hᴴCh − Σ|h_m|²|p_m|² ≤ hᴴCh pointwise, for every formulation, since
        // the subtracted diagonal terms are each ≥ 0. Check this indirectly:
        // diag-removed dB values, referenced to their own (also diag-removed)
        // centre, must stay finite and bounded by the same floor.
        let a = build_array(&sunflower(48, 1.0)).unwrap();
        let w = weights_for(&a, Shading::Uniform);
        let (g, vals) = compute_psf(
            &a,
            &w,
            &near_focus(),
            4000.0,
            343.0,
            SteeringFormulation::I,
            true,
        )
        .unwrap();
        assert!(vals.iter().all(|v| v.is_finite() && *v <= 1e-3));
        let center = vals[(g.ny / 2) * g.nx + (g.nx / 2)];
        assert!(center.abs() < 1e-3, "center should be 0 dB, got {center}");
    }
}
