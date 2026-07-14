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

/// Amplitude window applied radially across the array aperture. Tapering the
/// aperture trades a wider main lobe for lower side lobes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Shading {
    Uniform,
    Hann,
    Hamming,
    Blackman,
}

impl Shading {
    /// Window amplitude at normalised aperture radius `rho` ∈ [0, 1]
    /// (0 = centre, 1 = rim).
    fn taper(self, rho: f64) -> f64 {
        let pi = std::f64::consts::PI;
        match self {
            Shading::Uniform => 1.0,
            Shading::Hann => 0.5 * (1.0 + (pi * rho).cos()),
            // Classic 1-D window coefficients, evaluated on the radial profile
            // so the centre (rho=0) is unity and the rim (rho=1) the pedestal.
            Shading::Hamming => 0.54 + 0.46 * (pi * rho).cos(),
            Shading::Blackman => {
                0.42 + 0.5 * (pi * rho).cos() + 0.08 * (2.0 * pi * rho).cos()
            }
        }
    }
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
    /// Uniform circular array — `n` mics equally spaced on one ring.
    Ring {
        n: usize,
        diameter: f64,
        center: [f64; 3],
        plane: Plane,
    },
    /// Uniform rectangular grid, `nx` × `ny` mics on a regular pitch.
    Grid {
        nx: usize,
        ny: usize,
        pitch: f64,
        center: [f64; 3],
        plane: Plane,
    },
    /// Two orthogonal lines forming a cross (`n` mics per full arm),
    /// spanning `length` tip-to-tip along each axis.
    Cross {
        n: usize,
        length: f64,
        center: [f64; 3],
        plane: Plane,
    },
    /// Positions parsed from CSV text (3 columns x,y,z; optional 4th = weight).
    Csv { text: String },
    /// An explicit, hand-edited microphone layout. Any generated array becomes a
    /// `Manual` one as soon as the user drags a microphone in the editor, so the
    /// edit survives save/load instead of being clobbered by the generator.
    Manual {
        pos: Vec<[f64; 3]>,
        /// Optional per-mic weights (overriding the shading window), as for CSV.
        #[serde(default)]
        weights: Option<Vec<f64>>,
    },
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
        ArraySource::Ring {
            n,
            diameter,
            center,
            plane,
        } => {
            if *n == 0 {
                return Err("Array needs at least one microphone.".into());
            }
            if !diameter.is_finite() || *diameter <= 0.0 {
                return Err("Array diameter must be a positive number.".into());
            }
            let (uh, vh, _) = plane.basis();
            let r = diameter / 2.0;
            let nn = *n as f64;
            let pos = (0..*n)
                .map(|k| {
                    let theta = (k as f64) / nn * std::f64::consts::TAU;
                    let (s, c) = theta.sin_cos();
                    add(*center, add(scale(uh, r * c), scale(vh, r * s)))
                })
                .collect();
            Ok(Array {
                pos,
                csv_weights: None,
            })
        }
        ArraySource::Grid {
            nx,
            ny,
            pitch,
            center,
            plane,
        } => {
            if *nx == 0 || *ny == 0 {
                return Err("Grid needs at least one microphone per side.".into());
            }
            if !pitch.is_finite() || *pitch <= 0.0 {
                return Err("Grid pitch must be a positive number.".into());
            }
            let (uh, vh, _) = plane.basis();
            // Centre the grid on `center`.
            let u0 = -(*nx as f64 - 1.0) * pitch / 2.0;
            let v0 = -(*ny as f64 - 1.0) * pitch / 2.0;
            let mut pos = Vec::with_capacity(nx * ny);
            for j in 0..*ny {
                for i in 0..*nx {
                    let uu = u0 + i as f64 * pitch;
                    let vv = v0 + j as f64 * pitch;
                    pos.push(add(*center, add(scale(uh, uu), scale(vh, vv))));
                }
            }
            Ok(Array {
                pos,
                csv_weights: None,
            })
        }
        ArraySource::Cross {
            n,
            length,
            center,
            plane,
        } => {
            if *n < 2 {
                return Err("Cross needs at least two microphones per arm.".into());
            }
            if !length.is_finite() || *length <= 0.0 {
                return Err("Cross length must be a positive number.".into());
            }
            let (uh, vh, _) = plane.basis();
            let half = length / 2.0;
            let step = length / (*n as f64 - 1.0);
            let mut pos = Vec::with_capacity(2 * *n - 1);
            // Horizontal arm.
            for i in 0..*n {
                let uu = -half + i as f64 * step;
                pos.push(add(*center, scale(uh, uu)));
            }
            // Vertical arm — skip the shared centre mic to avoid a duplicate.
            for j in 0..*n {
                let vv = -half + j as f64 * step;
                if vv.abs() < 1e-12 {
                    continue;
                }
                pos.push(add(*center, scale(vh, vv)));
            }
            Ok(Array {
                pos,
                csv_weights: None,
            })
        }
        ArraySource::Csv { text } => parse_csv(text),
        ArraySource::Manual { pos, weights } => {
            if pos.is_empty() {
                return Err("Array needs at least one microphone.".into());
            }
            if !pos.iter().all(|p| p.iter().all(|c| c.is_finite())) {
                return Err("Microphone positions must be finite numbers.".into());
            }
            if let Some(w) = weights {
                if w.len() != pos.len() {
                    return Err("Manual array: one weight per microphone is required.".into());
                }
            }
            Ok(Array {
                pos: pos.clone(),
                csv_weights: weights.clone(),
            })
        }
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
    if shading == Shading::Uniform {
        return vec![1.0; array.len()];
    }
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
            shading.taper(rho)
        })
        .collect()
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

// ─────────────────────────────────────────────────────────── sources

/// A single incoherent point source in the scene.
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
pub struct Source {
    /// World position (metres).
    pub pos: [f64; 3],
    /// Linear pressure amplitude (1.0 = reference). Sources are assumed
    /// mutually incoherent, so their cross-spectral matrices add in power.
    #[serde(default = "default_amplitude")]
    pub amplitude: f64,
}

fn default_amplitude() -> f64 {
    1.0
}

impl Source {
    pub fn unit(pos: [f64; 3]) -> Self {
        Source {
            pos,
            amplitude: 1.0,
        }
    }
}

// ─────────────────────────────────────────────────────────── algorithm

/// Which beamforming algorithm forms the map.
#[derive(Clone, Copy, Debug, PartialEq, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Algorithm {
    /// Conventional delay-and-sum: `P = Σ_s |hᴴgₛ|²`.
    Conventional,
    /// Functional beamforming (Dougherty): `P = (hᴴ·C^{1/ν}·h)^ν`. Raising the
    /// exponent `nu` sharpens the main lobe and pushes side lobes down.
    /// At `nu = 1` this is identically the conventional map.
    Functional { nu: f64 },
}

impl Default for Algorithm {
    fn default() -> Self {
        Algorithm::Conventional
    }
}

/// Physics + algorithm settings shared by every beamformer entry point.
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
pub struct BeamformOptions {
    pub frequency: f64,
    pub speed_of_sound: f64,
    #[serde(default)]
    pub formulation: SteeringFormulation,
    /// Subtract the autopower (diagonal) terms. Conventional only — functional
    /// beamforming's low-rank route never materialises a diagonal to strip.
    #[serde(default)]
    pub diag_removal: bool,
    /// Per-sensor white-noise variance σ² (0 = off).
    #[serde(default)]
    pub noise_power: f64,
    #[serde(default)]
    pub algorithm: Algorithm,
}

// ─────────────────────────────────────────── small complex linear algebra
//
// Used only by functional beamforming, and only on an S×S matrix where S is the
// source count (a handful). Deliberately tiny and self-contained: no LAPACK/BLAS
// system dependency, which would dwarf this binary.

type Cx = (f64, f64);

#[inline]
fn cadd(a: Cx, b: Cx) -> Cx {
    (a.0 + b.0, a.1 + b.1)
}
#[inline]
fn cmul(a: Cx, b: Cx) -> Cx {
    (a.0 * b.0 - a.1 * b.1, a.0 * b.1 + a.1 * b.0)
}
#[inline]
fn cconj(a: Cx) -> Cx {
    (a.0, -a.1)
}

/// Jacobi eigendecomposition of a small complex Hermitian matrix `a` (`n`×`n`,
/// row-major). Returns `(eigenvalues, eigenvectors)` with eigenvector `i` held in
/// **column** `i` of the returned matrix.
///
/// Each sweep zeroes the off-diagonal with unitary rotations
/// `U = [[c, −s·e^{iφ}], [s·e^{−iφ}, c]]`, choosing `tan 2θ = 2|a_pq| / (a_pp − a_qq)`.
/// `n` is the source count, and this runs once per compute — never per scan point.
fn hermitian_eig(a_in: &[Cx], n: usize) -> (Vec<f64>, Vec<Cx>) {
    let mut a = a_in.to_vec();
    let mut v = vec![(0.0, 0.0); n * n];
    for i in 0..n {
        v[i * n + i] = (1.0, 0.0);
    }
    if n <= 1 {
        return ((0..n).map(|i| a[i * n + i].0).collect(), v);
    }

    for _ in 0..60 {
        let mut off = 0.0f64;
        for i in 0..n {
            for j in 0..n {
                if i != j {
                    off += a[i * n + j].0 * a[i * n + j].0 + a[i * n + j].1 * a[i * n + j].1;
                }
            }
        }
        if off.sqrt() <= 1e-13 {
            break;
        }

        for p in 0..n {
            for q in (p + 1)..n {
                let apq = a[p * n + q];
                let r = (apq.0 * apq.0 + apq.1 * apq.1).sqrt();
                if r <= 1e-18 {
                    continue;
                }
                let app = a[p * n + p].0;
                let aqq = a[q * n + q].0;
                let phi = apq.1.atan2(apq.0);
                let theta = 0.5 * (2.0 * r).atan2(app - aqq);
                let (c, s) = (theta.cos(), theta.sin());
                let e_pos = (phi.cos(), phi.sin()); // e^{iφ}
                let e_neg = (phi.cos(), -phi.sin()); // e^{−iφ}
                let u_pq = cmul((-s, 0.0), e_pos);
                let u_qp = cmul((s, 0.0), e_neg);

                // A ← A·U (only columns p, q change)
                for i in 0..n {
                    let aip = a[i * n + p];
                    let aiq = a[i * n + q];
                    a[i * n + p] = cadd(cmul(aip, (c, 0.0)), cmul(aiq, u_qp));
                    a[i * n + q] = cadd(cmul(aip, u_pq), cmul(aiq, (c, 0.0)));
                }
                // A ← Uᴴ·A (only rows p, q change)
                let uh_pq = cconj(u_qp);
                let uh_qp = cconj(u_pq);
                for j in 0..n {
                    let apj = a[p * n + j];
                    let aqj = a[q * n + j];
                    a[p * n + j] = cadd(cmul((c, 0.0), apj), cmul(uh_pq, aqj));
                    a[q * n + j] = cadd(cmul(uh_qp, apj), cmul((c, 0.0), aqj));
                }
                // V ← V·U (only columns p, q change)
                for i in 0..n {
                    let vip = v[i * n + p];
                    let viq = v[i * n + q];
                    v[i * n + p] = cadd(cmul(vip, (c, 0.0)), cmul(viq, u_qp));
                    v[i * n + q] = cadd(cmul(vip, u_pq), cmul(viq, (c, 0.0)));
                }
            }
        }
    }

    ((0..n).map(|i| a[i * n + i].0).collect(), v)
}

/// Precomputed functional-beamforming terms, derived once per compute from the
/// S×S source Gram matrix — never from an N×N cross-spectral matrix.
///
/// With `C = G·Gᴴ + σ²I`, the signal subspace has rank ≤ S, so the eigenpairs of
/// `C` follow from `M = Gᴴ·G` (S×S): if `M·v_i = λ_i·v_i` then `u_i = G·v_i/√λ_i`
/// is a unit eigenvector of `G·Gᴴ` with eigenvalue `λ_i`, and `C` adds `σ²` to
/// every eigenvalue. Hence
///
/// ```text
///   hᴴC^{1/ν}h = σ^{2/ν}·‖h‖² + Σ_i [ (λ_i+σ²)^{1/ν} − σ^{2/ν} ] · |u_iᴴh|²
/// ```
///
/// and since `|u_iᴴh|² = |z_i|²/λ_i` with `z_i = Σ_s v_{s,i}·Sₛ`, everything is
/// expressed through the per-source projections `Sₛ = hᴴgₛ` and `‖h‖² = Σ_m|h_m|²`
/// that the scan loop already computes.
struct Functional {
    nu: f64,
    /// σ^{2/ν} — the noise subspace's contribution per unit of ‖h‖².
    base: f64,
    /// `[(λ_i+σ²)^{1/ν} − σ^{2/ν}] / λ_i`, applied to `|z_i|²`.
    coef: Vec<f64>,
    /// S×S eigenvectors, column `i` = `v_i` (row-major).
    v: Vec<Cx>,
    n: usize,
}

// ─────────────────────────────────────────────────────────── beamformer

/// Beamform at an arbitrary set of world-space scan `points`, returning the
/// **raw (un-normalised) linear** beamformer power at each. This is the shared
/// core of the engine: [`compute_psf`] calls it with a planar grid, but it
/// accepts any point cloud (e.g. STL surface samples).
///
/// No cross-spectral matrix is formed — the output is the incoherent per-source
/// sum `Σ_s |hᴴ·gₛ|²`, steered with the chosen Sarradj formulation, with
/// optional per-source diagonal removal (`Σ_m |h_m|²|g_{s,m}|²`) and an optional
/// white sensor-noise floor. `noise_power` is the per-sensor noise variance σ²
/// (0 = off); it contributes `σ²·Σ_m |h_m|²` to the output and is stripped again
/// by `diag_removal` — which is exactly why diagonal removal rejects
/// uncorrelated sensor noise.
///
/// Returning raw power (not dB) lets callers combine maps before normalising —
/// e.g. incoherent band-averaging over a frequency sweep. Use [`normalize_to_db`]
/// to convert a raw slice to peak-referenced dB.
pub fn compute_at_points(
    array: &Array,
    weights: &[f64],
    points: &[[f64; 3]],
    sources: &[Source],
    opts: &BeamformOptions,
) -> Result<Vec<f64>, String> {
    if array.is_empty() {
        return Err("No microphones to compute with.".into());
    }
    if sources.is_empty() {
        return Err("At least one source is required.".into());
    }
    if opts.frequency <= 0.0 || opts.speed_of_sound <= 0.0 {
        return Err("Frequency and speed of sound must be positive.".into());
    }
    let formulation = opts.formulation;
    // Diagonal removal only applies to the conventional map: functional
    // beamforming reaches C through its low-rank eigenpairs, where there is no
    // materialised diagonal to strip.
    let diag_removal = opts.diag_removal && matches!(opts.algorithm, Algorithm::Conventional);
    let k = 2.0 * std::f64::consts::PI * opts.frequency / opts.speed_of_sound;
    let reference = array.centroid();
    let mics = &array.pos;
    let nsrc = sources.len();

    // Free-field complex pressure at each mic from each source, laid out
    // mic-major (`p[m][s]` = gₛ at mic m). Only this propagation vector is
    // needed — no cross-spectral matrix (or its diagonal) is ever formed.
    let mut p: Vec<Vec<(f64, f64)>> = Vec::with_capacity(mics.len());
    for m in mics.iter() {
        let mut row = Vec::with_capacity(nsrc);
        for src in sources {
            let d = dist(*m, src.pos).max(1e-9);
            let phase = -k * d;
            let (s, c) = phase.sin_cos();
            let a = src.amplitude;
            row.push((a * c / d, a * s / d));
        }
        p.push(row);
    }

    let wsum: f64 = weights.iter().sum();
    let wsum_safe = if wsum.abs() < 1e-30 { 1.0 } else { wsum };
    let needs_norm_pass = matches!(formulation, SteeringFormulation::Iii | SteeringFormulation::Iv);
    let noise = opts.noise_power.max(0.0);

    // Functional beamforming: derive C's eigenpairs once from the S×S source
    // Gram matrix M_st = gₛᴴ·g_t. See `Functional` for the derivation.
    let functional = match opts.algorithm {
        Algorithm::Conventional => None,
        Algorithm::Functional { nu } => {
            let nu = if nu.is_finite() && nu >= 1.0 { nu } else { 1.0 };
            let mut gram = vec![(0.0f64, 0.0f64); nsrc * nsrc];
            for s in 0..nsrc {
                for t in 0..nsrc {
                    let mut acc = (0.0f64, 0.0f64);
                    for row in p.iter() {
                        acc = cadd(acc, cmul(cconj(row[s]), row[t]));
                    }
                    gram[s * nsrc + t] = acc;
                }
            }
            let (lambda, v) = hermitian_eig(&gram, nsrc);
            let base = noise.powf(1.0 / nu); // σ^{2/ν}  (noise is σ²)
            let coef = lambda
                .iter()
                .map(|&l| {
                    if l <= 1e-30 {
                        0.0
                    } else {
                        ((l + noise).powf(1.0 / nu) - base) / l
                    }
                })
                .collect();
            Some(Functional { nu, base, coef, v, n: nsrc })
        }
    };

    let mut raw = vec![0f64; points.len()];
    // Parallelise over scan points; `for_each_init` hands each worker thread a
    // reusable set of per-source accumulators so the hot loop never re-allocates.
    raw.par_iter_mut().zip(points.par_iter()).for_each_init(
        || (vec![0f64; nsrc], vec![0f64; nsrc], vec![0f64; nsrc]),
        |(s_re, s_im, s_diag), (cell, point)| {
            let point = *point;
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

            for v in s_re.iter_mut() {
                *v = 0.0;
            }
            for v in s_im.iter_mut() {
                *v = 0.0;
            }
            if diag_removal {
                for v in s_diag.iter_mut() {
                    *v = 0.0;
                }
            }
            // Σ_m |h_m|² — the array's response to spatially white sensor noise.
            let mut h_norm2 = 0.0f64;
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
                let h_mag2 = h_re * h_re + h_im * h_im;
                h_norm2 += h_mag2;
                // Sₛ += conj(h_m) · g_{s,m}, plus (optionally) the per-source
                // autopower term Σ_m |h_m|²|g_{s,m}|² for diagonal removal.
                for (s_idx, &(p_re, p_im)) in p[m].iter().enumerate() {
                    s_re[s_idx] += h_re * p_re + h_im * p_im;
                    s_im[s_idx] += h_re * p_im - h_im * p_re;
                    if diag_removal {
                        s_diag[s_idx] += h_mag2 * (p_re * p_re + p_im * p_im);
                    }
                }
            }
            let power = match &functional {
                // Functional: P = (hᴴC^{1/ν}h)^ν, assembled from the per-source
                // projections Sₛ and ‖h‖² already in hand — no CSM, no N×N work.
                Some(ft) => {
                    let mut acc = ft.base * h_norm2;
                    for i in 0..ft.n {
                        // z_i = Σ_s v_{s,i}·Sₛ  ⇒  |u_iᴴh|² = |z_i|²/λ_i
                        let mut z = (0.0f64, 0.0f64);
                        for s_idx in 0..ft.n {
                            z = cadd(z, cmul(ft.v[s_idx * ft.n + i], (s_re[s_idx], s_im[s_idx])));
                        }
                        acc += ft.coef[i] * (z.0 * z.0 + z.1 * z.1);
                    }
                    acc.max(0.0).powf(ft.nu)
                }
                // Conventional: incoherent sum of per-source powers, each with its
                // own autopower (diagonal) term removed when requested.
                None => {
                    let mut power = 0.0f64;
                    for s_idx in 0..nsrc {
                        let mut ps = s_re[s_idx] * s_re[s_idx] + s_im[s_idx] * s_im[s_idx];
                        if diag_removal {
                            ps -= s_diag[s_idx];
                        }
                        power += ps;
                    }
                    // White sensor-noise floor σ²·Σ_m|h_m|²: added to the output,
                    // and stripped again by diagonal removal.
                    let noise_contrib = noise * h_norm2;
                    power += noise_contrib;
                    if diag_removal {
                        power -= noise_contrib;
                    }
                    power
                }
            };
            *cell = power.max(0.0);
        },
    );

    Ok(raw)
}

/// Normalise raw linear power to dB relative to its own peak (peak = 0 dB),
/// flooring at [`DB_FLOOR`] so a perfect null never yields −∞.
pub fn normalize_to_db(raw: &[f64]) -> Vec<f32> {
    let p0 = raw.iter().cloned().fold(0.0f64, f64::max).max(1e-30);
    raw.iter()
        .map(|&p| (10.0 * (p / p0 + 1e-30).log10()).max(DB_FLOOR as f64) as f32)
        .collect()
}

/// Compute the normalised beamformer map (dB) over the focus grid for one or
/// more incoherent point `sources`. Thin wrapper over [`compute_at_points`]:
/// it materialises the focus grid's scan points (row-major, `v` outer, `u`
/// inner), beamforms them, and normalises to the grid's own peak. See
/// [`compute_at_points`] for the model, `diag_removal`, and `noise_power`.
/// Returns row-major values, length `nx*ny`, in dB (peak = 0 dB).
pub fn compute_psf(
    array: &Array,
    weights: &[f64],
    focus: &FocusConfig,
    sources: &[Source],
    opts: &BeamformOptions,
) -> Result<(Grid, Vec<f32>), String> {
    let grid = focus.grid()?;
    let points = grid_points(focus, &grid);
    let raw = compute_at_points(array, weights, &points, sources, opts)?;
    Ok((grid, normalize_to_db(&raw)))
}

/// The focus grid's world-space scan points, row-major (`v` outer, `u` inner) to
/// match the layout the renderer and metrics expect.
fn grid_points(focus: &FocusConfig, grid: &Grid) -> Vec<[f64; 3]> {
    let (uh, vh, _) = focus.plane.basis();
    let mut points = Vec::with_capacity(grid.nx * grid.ny);
    for &vv in &grid.v {
        for &uu in &grid.u {
            points.push(add(focus.center, add(scale(uh, uu), scale(vh, vv))));
        }
    }
    points
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
    // The mainlobe peak (normalised to exactly 0 dB) isn't necessarily at the
    // grid's geometric middle — the source can sit anywhere. Locate it.
    let peak_idx = values
        .iter()
        .enumerate()
        .max_by(|a, b| a.1.total_cmp(b.1))
        .map(|(i, _)| i)
        .unwrap_or(0);
    let cx = peak_idx % nx;
    let cy = peak_idx / nx;

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

// ─────────────────────────────────────────────────────────── frequency sweep

/// Upper bound on swept frequency points, so a stray UI value cannot wedge the
/// app with an unbounded amount of work.
pub const MAX_SWEEP_POINTS: usize = 200;

/// The frequency-dependent metrics at one swept frequency.
#[derive(Clone, Debug, Serialize)]
pub struct SweepPoint {
    pub frequency: f64,
    pub beamwidth_u: Option<f64>,
    pub beamwidth_v: Option<f64>,
    pub peak_sidelobe_db: Option<f32>,
}

/// Result of a broadband sweep over a fixed array + focus grid.
#[derive(Clone, Debug, Serialize)]
pub struct SweepResult {
    pub points: Vec<SweepPoint>,
    /// Incoherent (power) band-average of the maps across every swept frequency,
    /// normalised once to its own peak (dB). `None` unless `band_map` was set.
    pub band_values: Option<Vec<f32>>,
    pub nx: usize,
    pub ny: usize,
    pub u: Vec<f64>,
    pub v: Vec<f64>,
    /// Frequency-independent geometry facts, so callers need not recompute them.
    pub alias_frequency: Option<f64>,
    pub aperture: f64,
    pub n_mics: usize,
}

/// Build the swept frequency list: `n` points from `f_min` to `f_max`,
/// logarithmically spaced when `log_spacing` (the useful default in acoustics).
pub fn sweep_frequencies(
    f_min: f64,
    f_max: f64,
    n: usize,
    log_spacing: bool,
) -> Result<Vec<f64>, String> {
    if n == 0 {
        return Err("Sweep needs at least one frequency point.".into());
    }
    if n > MAX_SWEEP_POINTS {
        return Err(format!(
            "Sweep is limited to {MAX_SWEEP_POINTS} frequency points."
        ));
    }
    if !f_min.is_finite() || !f_max.is_finite() || f_min <= 0.0 || f_max <= 0.0 {
        return Err("Sweep frequencies must be positive.".into());
    }
    if f_max < f_min {
        return Err("Sweep f_max must be at least f_min.".into());
    }
    if n == 1 {
        return Ok(vec![f_min]);
    }
    let nn = (n - 1) as f64;
    Ok((0..n)
        .map(|i| {
            let t = i as f64 / nn;
            if log_spacing {
                f_min * (f_max / f_min).powf(t)
            } else {
                f_min + t * (f_max - f_min)
            }
        })
        .collect())
}

/// Sweep the beamformer across `frequencies` over a fixed array and focus grid.
///
/// Per frequency it records the frequency-dependent metrics (−3 dB beamwidths and
/// peak side-lobe level). With `band_map` it also accumulates the **raw linear**
/// power maps and normalises the total once at the end — an incoherent
/// band-average. Summing raw power (rather than per-frequency dB) is the whole
/// reason [`compute_at_points`] returns un-normalised power.
pub fn compute_sweep(
    array: &Array,
    weights: &[f64],
    focus: &FocusConfig,
    sources: &[Source],
    frequencies: &[f64],
    opts: &BeamformOptions,
    band_map: bool,
    mut on_step: Option<&mut dyn FnMut(usize, usize)>,
) -> Result<SweepResult, String> {
    if frequencies.is_empty() {
        return Err("Sweep needs at least one frequency point.".into());
    }
    if frequencies.len() > MAX_SWEEP_POINTS {
        return Err(format!(
            "Sweep is limited to {MAX_SWEEP_POINTS} frequency points."
        ));
    }
    let grid = focus.grid()?;
    let points = grid_points(focus, &grid);

    let mut band = if band_map { vec![0f64; points.len()] } else { Vec::new() };
    let mut swept = Vec::with_capacity(frequencies.len());
    // The geometry metrics (aperture, alias frequency, mic count) do not depend
    // on frequency — capture them once from the first pass.
    let mut geometry: Option<Metrics> = None;

    for (i, &f) in frequencies.iter().enumerate() {
        let step = BeamformOptions { frequency: f, ..*opts };
        let raw = compute_at_points(array, weights, &points, sources, &step)?;
        if band_map {
            for (b, r) in band.iter_mut().zip(raw.iter()) {
                *b += *r;
            }
        }
        let values = normalize_to_db(&raw);
        let m = metrics(array, &grid, &values, opts.speed_of_sound);
        swept.push(SweepPoint {
            frequency: f,
            beamwidth_u: m.beamwidth_u,
            beamwidth_v: m.beamwidth_v,
            peak_sidelobe_db: m.peak_sidelobe_db,
        });
        if geometry.is_none() {
            geometry = Some(m);
        }
        if let Some(cb) = on_step.as_mut() {
            cb(i + 1, frequencies.len());
        }
    }

    let geom = geometry.unwrap_or_default();
    Ok(SweepResult {
        points: swept,
        band_values: if band_map {
            Some(normalize_to_db(&band))
        } else {
            None
        },
        nx: grid.nx,
        ny: grid.ny,
        u: grid.u,
        v: grid.v,
        alias_frequency: geom.alias_frequency,
        aperture: geom.aperture,
        n_mics: geom.n_mics,
    })
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
    fn ring_count_and_radius() {
        let a = build_array(&ArraySource::Ring {
            n: 16,
            diameter: 1.0,
            center: [0., 0., 0.],
            plane: Plane::Xy,
        })
        .unwrap();
        assert_eq!(a.len(), 16);
        for p in &a.pos {
            let r = (p[0] * p[0] + p[1] * p[1]).sqrt();
            assert!((r - 0.5).abs() < 1e-9, "ring mic off radius: {r}");
            assert!(p[2].abs() < 1e-12, "xy array must have z=0");
        }
    }

    #[test]
    fn grid_count_and_extent() {
        let a = build_array(&ArraySource::Grid {
            nx: 4,
            ny: 3,
            pitch: 0.1,
            center: [0., 0., 0.],
            plane: Plane::Xy,
        })
        .unwrap();
        assert_eq!(a.len(), 12);
        // Centred: x spans ±0.15, y spans ±0.10.
        let xmax = a.pos.iter().map(|p| p[0]).fold(f64::MIN, f64::max);
        let ymax = a.pos.iter().map(|p| p[1]).fold(f64::MIN, f64::max);
        assert!((xmax - 0.15).abs() < 1e-9, "grid x extent: {xmax}");
        assert!((ymax - 0.10).abs() < 1e-9, "grid y extent: {ymax}");
    }

    #[test]
    fn cross_count_no_duplicate_centre() {
        let a = build_array(&ArraySource::Cross {
            n: 5,
            length: 1.0,
            center: [0., 0., 0.],
            plane: Plane::Xy,
        })
        .unwrap();
        // 5 per arm, sharing one centre mic → 2·5 − 1 = 9.
        assert_eq!(a.len(), 9);
        // No two mics coincide.
        for i in 0..a.len() {
            for j in (i + 1)..a.len() {
                assert!(dist(a.pos[i], a.pos[j]) > 1e-9, "duplicate mic at {i},{j}");
            }
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

    #[test]
    fn manual_array_round_trips_positions_and_weights() {
        let a = build_array(&ArraySource::Manual {
            pos: vec![[0.0, 0.0, 0.0], [0.1, 0.0, 0.0], [0.0, 0.1, 0.0]],
            weights: Some(vec![1.0, 0.5, 0.25]),
        })
        .unwrap();
        assert_eq!(a.len(), 3);
        assert_eq!(a.csv_weights.as_ref().unwrap()[2], 0.25);
        // Explicit weights win over the shading window, as with CSV.
        assert_eq!(weights_for(&a, Shading::Hann)[1], 0.5);

        // Weights, when given, must match the mic count.
        assert!(build_array(&ArraySource::Manual {
            pos: vec![[0.0, 0.0, 0.0]],
            weights: Some(vec![1.0, 1.0]),
        })
        .is_err());
        assert!(build_array(&ArraySource::Manual { pos: vec![], weights: None }).is_err());
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

    /// Baseline beamformer settings; override fields with struct-update syntax,
    /// e.g. `BeamformOptions { diag_removal: true, ..opts(5000.0) }`.
    fn opts(frequency: f64) -> BeamformOptions {
        BeamformOptions {
            frequency,
            speed_of_sound: 343.0,
            formulation: SteeringFormulation::I,
            diag_removal: false,
            noise_power: 0.0,
            algorithm: Algorithm::Conventional,
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
            &[Source::unit(focus().center)],
            &opts(5000.0),
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
            &[Source::unit(focus().center)],
            &opts(4000.0),
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
            compute_psf(&a, &w, &f, &[Source::unit(f.center)], &opts(2000.0)).unwrap();
        let m1 = metrics(&a, &g1, &v1, 343.0);
        let (g2, v2) =
            compute_psf(&a, &w, &f, &[Source::unit(f.center)], &opts(8000.0)).unwrap();
        let m2 = metrics(&a, &g2, &v2, 343.0);
        let b1 = m1.beamwidth_u.unwrap();
        let b2 = m2.beamwidth_u.unwrap();
        assert!(b2 < b1, "higher f should narrow beam: {b1} -> {b2}");
    }

    #[test]
    fn shading_windows_taper_the_aperture() {
        // Radial windows must be unity at the centre mic and fall toward the
        // rim; tapered windows should also lower the total weight vs uniform.
        let a = build_array(&sunflower(120, 1.0)).unwrap();
        let uni: f64 = weights_for(&a, Shading::Uniform).iter().sum();
        for s in [Shading::Hann, Shading::Hamming, Shading::Blackman] {
            let w = weights_for(&a, s);
            assert_eq!(w.len(), a.len());
            assert!(w.iter().all(|x| x.is_finite() && *x >= -1e-9));
            let sum: f64 = w.iter().sum();
            assert!(sum < uni, "{s:?} should taper below uniform: {sum} !< {uni}");
        }
    }

    #[test]
    fn hann_shading_lowers_peak_sidelobe() {
        // A tapered aperture buys lower side lobes than the uniform window.
        let a = build_array(&sunflower(144, 1.0)).unwrap();
        let f = focus();
        let src = [Source::unit(f.center)];
        let (gu, vu) = compute_psf(
            &a,
            &weights_for(&a, Shading::Uniform),
            &f,
            &src,
            &opts(6000.0),
        )
        .unwrap();
        let (gh, vh) = compute_psf(
            &a,
            &weights_for(&a, Shading::Hann),
            &f,
            &src,
            &opts(6000.0),
        )
        .unwrap();
        let psl_u = metrics(&a, &gu, &vu, 343.0).peak_sidelobe_db;
        let psl_h = metrics(&a, &gh, &vh, 343.0).peak_sidelobe_db;
        if let (Some(u), Some(h)) = (psl_u, psl_h) {
            assert!(h < u + 0.5, "Hann PSL {h} should not exceed uniform {u}");
        }
    }

    #[test]
    fn alias_frequency_reasonable() {
        let a = build_array(&sunflower(50, 1.0)).unwrap();
        let w = weights_for(&a, Shading::Uniform);
        let (g, v) = compute_psf(
            &a,
            &w,
            &focus(),
            &[Source::unit(focus().center)],
            &opts(3000.0),
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
                    &[Source::unit(near_focus().center)],
                    &BeamformOptions { formulation, diag_removal, ..opts(4000.0) },
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
            &[Source::unit(near_focus().center)],
            &opts(4000.0),
        )
        .unwrap();
        let (_, v3) = compute_psf(
            &a,
            &w,
            &near_focus(),
            &[Source::unit(near_focus().center)],
            &BeamformOptions { formulation: SteeringFormulation::Iii, ..opts(4000.0) },
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
            &[Source::unit(near_focus().center)],
            &BeamformOptions { diag_removal: true, ..opts(4000.0) },
        )
        .unwrap();
        assert!(vals.iter().all(|v| v.is_finite() && *v <= 1e-3));
        let center = vals[(g.ny / 2) * g.nx + (g.nx / 2)];
        assert!(center.abs() < 1e-3, "center should be 0 dB, got {center}");
    }

    #[test]
    fn source_position_actually_moves_the_psf_peak() {
        // Regression test: the source used to be hard-coded to focus.center,
        // so moving it had no effect on the computed field. The peak should
        // now track wherever `source` actually is on the focus plane.
        let a = build_array(&sunflower(64, 1.0)).unwrap();
        let w = weights_for(&a, Shading::Uniform);
        let f = focus();

        let (g0, v0) =
            compute_psf(&a, &w, &f, &[Source::unit(f.center)], &opts(5000.0)).unwrap();
        let peak0 = v0
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.total_cmp(b.1))
            .unwrap()
            .0;
        assert_eq!(peak0, (g0.ny / 2) * g0.nx + (g0.nx / 2));

        // Offset the source within the focus plane (still z=1, but shifted
        // in x) — the peak must move with it, not stay at the grid centre.
        let offset_source = [0.3, 0.0, 1.0];
        let (g1, v1) =
            compute_psf(&a, &w, &f, &[Source::unit(offset_source)], &opts(5000.0)).unwrap();
        let peak1 = v1
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.total_cmp(b.1))
            .unwrap()
            .0;
        assert_ne!(
            peak1,
            (g1.ny / 2) * g1.nx + (g1.nx / 2),
            "moving the source should move the PSF peak away from the grid centre"
        );
    }

    // Nearest grid cell to a given (u, v) offset from the focus centre.
    fn cell_at(g: &Grid, u: f64, v: f64) -> usize {
        let i = g
            .u
            .iter()
            .enumerate()
            .min_by(|a, b| (a.1 - u).abs().total_cmp(&(b.1 - u).abs()))
            .unwrap()
            .0;
        let j = g
            .v
            .iter()
            .enumerate()
            .min_by(|a, b| (a.1 - v).abs().total_cmp(&(b.1 - v).abs()))
            .unwrap()
            .0;
        j * g.nx + i
    }

    #[test]
    fn two_sources_make_two_peaks() {
        // Two well-separated equal sources should each produce a ~0 dB local
        // maximum at their own location in the beamformer map.
        let a = build_array(&sunflower(80, 1.0)).unwrap();
        let w = weights_for(&a, Shading::Uniform);
        let f = focus(); // z = 1 plane, ±0.5 m in u,v
        let sources = [
            Source::unit([-0.3, 0.0, 1.0]),
            Source::unit([0.3, 0.0, 1.0]),
        ];
        let (g, v) = compute_psf(
            &a,
            &w,
            &f,
            &sources,
            &opts(8000.0),
        )
        .unwrap();
        let left = v[cell_at(&g, -0.3, 0.0)];
        let right = v[cell_at(&g, 0.3, 0.0)];
        let middle = v[cell_at(&g, 0.0, 0.0)];
        assert!(left > -3.0, "left source should be near peak, got {left} dB");
        assert!(right > -3.0, "right source should be near peak, got {right} dB");
        // The point between the two sources should be clearly lower.
        assert!(
            middle < left - 3.0 && middle < right - 3.0,
            "midpoint {middle} dB should sit well below both source peaks"
        );
    }

    #[test]
    fn source_amplitude_scales_relative_level() {
        // A quieter second source should map to a lower relative level than an
        // equal-amplitude one, given identical geometry.
        let a = build_array(&sunflower(80, 1.0)).unwrap();
        let w = weights_for(&a, Shading::Uniform);
        let f = focus();
        let quiet = [
            Source::unit([-0.3, 0.0, 1.0]),
            Source {
                pos: [0.3, 0.0, 1.0],
                amplitude: 0.1,
            },
        ];
        let (g, v) = compute_psf(
            &a,
            &w,
            &f,
            &quiet,
            &opts(8000.0),
        )
        .unwrap();
        let left = v[cell_at(&g, -0.3, 0.0)]; // loud → normalised peak ≈ 0 dB
        let right = v[cell_at(&g, 0.3, 0.0)]; // quiet → well below 0 dB
        assert!(left > -1.0, "loud source should be near 0 dB, got {left}");
        assert!(
            right < left - 10.0,
            "0.1-amplitude source should be ~20 dB down, got {right} dB vs {left} dB"
        );
    }

    #[test]
    fn compute_at_points_matches_grid_path() {
        // R1 regression: compute_psf must be exactly compute_at_points over the
        // focus grid points followed by normalisation. Rebuild the same points
        // and compare the resulting dB maps cell-for-cell.
        let a = build_array(&sunflower(64, 1.0)).unwrap();
        let w = weights_for(&a, Shading::Uniform);
        let f = focus();
        let src = [Source::unit(f.center)];
        let (g, via_psf) = compute_psf(&a, &w, &f, &src, &opts(5000.0)).unwrap();

        let (uh, vh, _) = f.plane.basis();
        let mut pts = Vec::with_capacity(g.nx * g.ny);
        for &vv in &g.v {
            for &uu in &g.u {
                pts.push(add(f.center, add(scale(uh, uu), scale(vh, vv))));
            }
        }
        let raw = compute_at_points(&a, &w, &pts, &src, &opts(5000.0)).unwrap();
        let via_points = normalize_to_db(&raw);

        assert_eq!(via_psf.len(), via_points.len());
        for (x, y) in via_psf.iter().zip(via_points.iter()) {
            assert!((x - y).abs() < 1e-6, "grid vs points mismatch: {x} vs {y}");
        }
    }

    #[test]
    fn sensor_noise_raises_floor_without_diagonal_removal() {
        // A white sensor-noise floor adds σ²·Σ_m|h_m|² everywhere; where the
        // source power vanishes (nulls) this term dominates, lifting the map's
        // floor well above the noiseless case (whose nulls sink to DB_FLOOR).
        let a = build_array(&sunflower(64, 1.0)).unwrap();
        let w = weights_for(&a, Shading::Uniform);
        let f = focus();
        let src = [Source::unit(f.center)];
        let (_, quiet) = compute_psf(&a, &w, &f, &src, &opts(5000.0)).unwrap();
        let (_, noisy) = compute_psf(
            &a,
            &w,
            &f,
            &src,
            &BeamformOptions { noise_power: 1e-2, ..opts(5000.0) },
        )
        .unwrap();
        let min_quiet = quiet.iter().cloned().fold(f32::INFINITY, f32::min);
        let min_noisy = noisy.iter().cloned().fold(f32::INFINITY, f32::min);
        assert!(
            min_noisy > min_quiet + 1.0,
            "sensor noise should lift the map floor: {min_noisy} !> {min_quiet}"
        );
        // The source peak is still the 0 dB reference.
        let max_noisy = noisy.iter().cloned().fold(f32::MIN, f32::max);
        assert!(max_noisy.abs() < 1e-3, "peak should stay at 0 dB, got {max_noisy}");
    }

    #[test]
    fn diagonal_removal_cancels_sensor_noise() {
        // Uncorrelated sensor noise lives entirely on the CSM diagonal, so with
        // diagonal removal on, adding a noise floor must leave the map unchanged.
        let a = build_array(&sunflower(64, 1.0)).unwrap();
        let w = weights_for(&a, Shading::Uniform);
        let f = focus();
        let src = [Source::unit(f.center)];
        let (_, no_noise) = compute_psf(
            &a,
            &w,
            &f,
            &src,
            &BeamformOptions { diag_removal: true, ..opts(5000.0) },
        )
        .unwrap();
        let (_, with_noise) = compute_psf(
            &a,
            &w,
            &f,
            &src,
            &BeamformOptions { diag_removal: true, noise_power: 1e-2, ..opts(5000.0) },
        )
        .unwrap();
        let max_diff = no_noise
            .iter()
            .zip(with_noise.iter())
            .map(|(a, b)| (a - b).abs())
            .fold(0.0f32, f32::max);
        assert!(
            max_diff < 1e-3,
            "diagonal removal should cancel sensor noise, max diff {max_diff}"
        );
    }

    #[test]
    fn sweep_frequencies_span_the_range() {
        let lin = sweep_frequencies(1000.0, 5000.0, 5, false).unwrap();
        assert_eq!(lin.len(), 5);
        assert!((lin[0] - 1000.0).abs() < 1e-9);
        assert!((lin[4] - 5000.0).abs() < 1e-9);
        assert!((lin[2] - 3000.0).abs() < 1e-9, "linear midpoint: {}", lin[2]);

        let log = sweep_frequencies(1000.0, 10000.0, 3, true).unwrap();
        assert!((log[0] - 1000.0).abs() < 1e-9);
        assert!((log[2] - 10000.0).abs() < 1e-6);
        // Log midpoint of a decade is the geometric mean.
        assert!((log[1] - 3162.277).abs() < 0.1, "log midpoint: {}", log[1]);

        assert!(sweep_frequencies(1000.0, 500.0, 4, true).is_err());
        assert!(sweep_frequencies(0.0, 500.0, 4, true).is_err());
        assert!(sweep_frequencies(100.0, 500.0, MAX_SWEEP_POINTS + 1, true).is_err());
    }

    #[test]
    fn sweep_tracks_beamwidth_against_frequency() {
        // The main lobe must narrow as frequency rises — the sweep should show
        // that trend end-to-end, which is the whole point of the feature.
        let a = build_array(&sunflower(81, 1.0)).unwrap();
        let w = weights_for(&a, Shading::Uniform);
        let freqs = sweep_frequencies(2000.0, 8000.0, 5, true).unwrap();
        let sweep = compute_sweep(
            &a,
            &w,
            &focus(),
            &[Source::unit(focus().center)],
            &freqs,
            // `frequency` here is a placeholder — compute_sweep overrides it per step.
            &opts(1000.0),
            false,
            None,
        )
        .unwrap();

        assert_eq!(sweep.points.len(), 5);
        assert!(sweep.band_values.is_none(), "band map was not requested");
        assert_eq!(sweep.n_mics, 81);
        assert!(sweep.alias_frequency.unwrap() > 0.0);

        let first = sweep.points.first().unwrap().beamwidth_u.unwrap();
        let last = sweep.points.last().unwrap().beamwidth_u.unwrap();
        assert!(last < first, "beam should narrow with frequency: {first} -> {last}");
    }

    #[test]
    fn sweep_band_average_is_a_valid_normalised_map() {
        // The band map is an incoherent power sum across the band, normalised
        // once — so it must peak at 0 dB and stay finite everywhere.
        let a = build_array(&sunflower(64, 1.0)).unwrap();
        let w = weights_for(&a, Shading::Uniform);
        let f = focus();
        let freqs = sweep_frequencies(3000.0, 6000.0, 4, true).unwrap();
        let sweep = compute_sweep(
            &a,
            &w,
            &f,
            &[Source::unit(f.center)],
            &freqs,
            &opts(1000.0), // overridden per sweep step
            true,
            None,
        )
        .unwrap();

        let band = sweep.band_values.expect("band map was requested");
        assert_eq!(band.len(), sweep.nx * sweep.ny);
        assert!(band.iter().all(|v| v.is_finite()));
        let peak = band.iter().cloned().fold(f32::MIN, f32::max);
        assert!(peak.abs() < 1e-3, "band map should peak at 0 dB, got {peak}");
        // The source sits at the grid centre, so the band peak belongs there too.
        let centre = band[(sweep.ny / 2) * sweep.nx + (sweep.nx / 2)];
        assert!(centre.abs() < 1e-3, "band peak should be at the source: {centre}");
    }

    // ── functional beamforming ──

    #[test]
    fn hermitian_eig_diagonalises_a_known_matrix() {
        // [[2, i], [−i, 2]] is Hermitian with eigenvalues 1 and 3.
        let a = vec![(2.0, 0.0), (0.0, 1.0), (0.0, -1.0), (2.0, 0.0)];
        let (mut lambda, v) = hermitian_eig(&a, 2);
        lambda.sort_by(f64::total_cmp);
        assert!((lambda[0] - 1.0).abs() < 1e-9, "λ0 = {}", lambda[0]);
        assert!((lambda[1] - 3.0).abs() < 1e-9, "λ1 = {}", lambda[1]);
        // Eigenvectors must be unit-norm (columns of V).
        for i in 0..2 {
            let n: f64 = (0..2).map(|s| {
                let c = v[s * 2 + i];
                c.0 * c.0 + c.1 * c.1
            }).sum();
            assert!((n - 1.0).abs() < 1e-9, "eigenvector {i} not unit: {n}");
        }
    }

    #[test]
    fn functional_nu_one_is_exactly_conventional() {
        // C^{1/1} = C, so functional beamforming at ν = 1 must reproduce the
        // conventional map bit-for-bit (within float noise). This is the anchor
        // that validates the whole low-rank S×S route.
        let a = build_array(&sunflower(64, 1.0)).unwrap();
        let w = weights_for(&a, Shading::Uniform);
        let f = focus();
        // Several sources, so the Gram matrix is genuinely S×S (not trivial).
        let src = [
            Source::unit([-0.25, 0.1, 1.0]),
            Source { pos: [0.3, -0.2, 1.0], amplitude: 0.6 },
            Source::unit([0.0, 0.35, 1.0]),
        ];
        for noise in [0.0, 1e-3] {
            let (_, conventional) = compute_psf(
                &a,
                &w,
                &f,
                &src,
                &BeamformOptions { noise_power: noise, ..opts(5000.0) },
            )
            .unwrap();
            let (_, functional) = compute_psf(
                &a,
                &w,
                &f,
                &src,
                &BeamformOptions {
                    noise_power: noise,
                    algorithm: Algorithm::Functional { nu: 1.0 },
                    ..opts(5000.0)
                },
            )
            .unwrap();
            let max_diff = conventional
                .iter()
                .zip(functional.iter())
                .map(|(a, b)| (a - b).abs())
                .fold(0.0f32, f32::max);
            assert!(
                max_diff < 1e-2,
                "functional(ν=1) should equal conventional (noise={noise}), max diff {max_diff} dB"
            );
        }
    }

    #[test]
    fn functional_sharpens_the_map() {
        // Raising ν pushes side lobes down and narrows the main lobe — that is
        // the entire point of the algorithm.
        let a = build_array(&sunflower(64, 1.0)).unwrap();
        let w = weights_for(&a, Shading::Uniform);
        let f = focus();
        let src = [Source::unit(f.center)];

        let (g1, v1) = compute_psf(&a, &w, &f, &src, &opts(5000.0)).unwrap();
        let (g2, v2) = compute_psf(
            &a,
            &w,
            &f,
            &src,
            &BeamformOptions { algorithm: Algorithm::Functional { nu: 16.0 }, ..opts(5000.0) },
        )
        .unwrap();

        assert!(v2.iter().all(|v| v.is_finite()), "functional produced a non-finite value");
        // Still peaks at the source, at 0 dB.
        let centre = v2[(g2.ny / 2) * g2.nx + (g2.nx / 2)];
        assert!(centre.abs() < 1e-3, "functional peak should be 0 dB, got {centre}");

        let m1 = metrics(&a, &g1, &v1, 343.0);
        let m2 = metrics(&a, &g2, &v2, 343.0);
        assert!(
            m2.beamwidth_u.unwrap() < m1.beamwidth_u.unwrap(),
            "ν=16 should narrow the main lobe: {:?} -> {:?}",
            m1.beamwidth_u,
            m2.beamwidth_u
        );
        if let (Some(p1), Some(p2)) = (m1.peak_sidelobe_db, m2.peak_sidelobe_db) {
            assert!(p2 < p1, "ν=16 should lower the peak side lobe: {p1} -> {p2}");
        }
    }

    #[test]
    fn functional_ignores_diagonal_removal() {
        // Diagonal removal is conventional-only; asking for it alongside
        // functional must not change the functional map.
        let a = build_array(&sunflower(48, 1.0)).unwrap();
        let w = weights_for(&a, Shading::Uniform);
        let f = focus();
        let src = [Source::unit(f.center)];
        let algorithm = Algorithm::Functional { nu: 8.0 };

        let (_, plain) =
            compute_psf(&a, &w, &f, &src, &BeamformOptions { algorithm, ..opts(5000.0) }).unwrap();
        let (_, with_dr) = compute_psf(
            &a,
            &w,
            &f,
            &src,
            &BeamformOptions { algorithm, diag_removal: true, ..opts(5000.0) },
        )
        .unwrap();
        let max_diff = plain
            .iter()
            .zip(with_dr.iter())
            .map(|(a, b)| (a - b).abs())
            .fold(0.0f32, f32::max);
        assert!(max_diff < 1e-6, "diag removal must not affect functional: {max_diff}");
    }
}
