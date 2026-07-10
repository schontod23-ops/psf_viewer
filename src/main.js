import "./style.css";
import { PSFPlot } from "./psfplot.js";
import { Geometry3D } from "./geometry3d.js";

// ───────────────────────── Tauri detection ─────────────────────────
const isTauri = !!(window.__TAURI_INTERNALS__ || window.__TAURI__);
let invokePromise = null;
function getInvoke() {
  if (!isTauri) return Promise.resolve(null);
  if (!invokePromise)
    invokePromise = import("@tauri-apps/api/core")
      .then((m) => m.invoke)
      .catch(() => null);
  return invokePromise;
}

// ───────────────────────── state ─────────────────────────
const state = {
  source: "sunflower",
  n: 64,
  diameter: 0.5,
  // ring
  ringN: 16,
  ringDiameter: 0.5,
  // grid
  gridNx: 8,
  gridNy: 8,
  gridPitch: 0.05,
  // cross
  crossN: 9,
  crossLength: 0.5,
  aplane: "xy",
  acenter: [0, 0, 0],
  csvText: null,
  csvName: null,
  fplane: "xy",
  fcenter: [0, 0, 1],
  width: 1,
  height: 1,
  dx: 0.02,
  frequency: 5000,
  c: 343,
  shading: "uniform",
  steering: "I",
  diagRemoval: false,
  dyn: 30,
  levels: 10,
  lines: true,
  // source marker
  srcPos: [0, 0, 1],
  srcAtFocus: false,
  // 3D options
  multiplane: false,
  raytrace: false,
};

// ───────────────────────── views ─────────────────────────
const plot = new PSFPlot(document.getElementById("plot"));
const geo = new Geometry3D(document.getElementById("three"));
plot.onTexture = (cv, plane) => geo.setTexture(cv, plane);

const $ = (id) => document.getElementById(id);

// ───────────────────────── control wiring ─────────────────────────

// Slider with paired number input
function bindSlider(id, key, fmt) {
  const slider = $(id);
  const num = $(`${id}-num`);
  const lab = $("lab-" + id.replace("frequency", "f").replace("diameter", "d"));

  function sync(val) {
    state[key] = val;
    if (lab) lab.textContent = fmt(val);
    if (slider.value != val) slider.value = val;
    if (num && num.value != val) num.value = val;
  }

  slider.addEventListener("input", () => { sync(parseFloat(slider.value)); schedule(); });

  if (num) {
    num.addEventListener("input", () => {
      const v = parseFloat(num.value);
      if (!isFinite(v)) return;
      const clamped = Math.min(parseFloat(num.max || Infinity), Math.max(parseFloat(num.min || -Infinity), v));
      sync(clamped);
      schedule();
    });
  }

  sync(parseFloat(slider.value));
}
bindSlider("n", "n", (v) => `${v | 0}`);
bindSlider("diameter", "diameter", (v) => `${v.toFixed(2)} m`);
bindSlider("ring-n", "ringN", (v) => `${v | 0}`);
bindSlider("ring-diameter", "ringDiameter", (v) => `${v.toFixed(2)} m`);
bindSlider("grid-pitch", "gridPitch", (v) => `${v.toFixed(3)} m`);
bindSlider("cross-n", "crossN", (v) => `${v | 0}`);
bindSlider("cross-length", "crossLength", (v) => `${v.toFixed(2)} m`);
bindSlider("dx", "dx", (v) => `${v.toFixed(3)} m`);
bindSlider("frequency", "frequency", (v) => `${v | 0} Hz`);
bindSlider("dyn", "dyn", (v) => `${v | 0} dB`);
bindSlider("levels", "levels", (v) => `${v | 0}`);

// ───────────────────────── slider bounds settings ─────────────────────────
// Per-slider min/max/step, editable at runtime and persisted so users can
// widen (or narrow) the ranges baked into the HTML defaults.
const SLIDER_DEFAULT_BOUNDS = {
  n: { min: 4, max: 256, step: 1 },
  diameter: { min: 0.05, max: 3, step: 0.01 },
  dx: { min: 0.005, max: 0.1, step: 0.005 },
  frequency: { min: 100, max: 20000, step: 50 },
  dyn: { min: 6, max: 60, step: 1 },
  levels: { min: 4, max: 24, step: 1 },
};
const SLIDER_BOUNDS_KEY = "psf-viewer:slider-bounds";

function loadSliderBounds() {
  let stored = {};
  try {
    stored = JSON.parse(localStorage.getItem(SLIDER_BOUNDS_KEY) || "{}");
  } catch {
    stored = {};
  }
  const merged = {};
  for (const id in SLIDER_DEFAULT_BOUNDS) {
    merged[id] = { ...SLIDER_DEFAULT_BOUNDS[id], ...(stored[id] || {}) };
  }
  return merged;
}
let sliderBounds = loadSliderBounds();

function applySliderBounds(id, bounds) {
  const slider = $(id);
  const num = $(`${id}-num`);
  for (const el of [slider, num]) {
    if (!el) continue;
    el.min = bounds.min;
    el.max = bounds.max;
    el.step = bounds.step;
  }
  const clamped = Math.min(bounds.max, Math.max(bounds.min, parseFloat(slider.value)));
  slider.value = clamped;
  if (num) num.value = clamped;
  slider.dispatchEvent(new Event("input"));
}

function applyAllSliderBounds() {
  for (const id in sliderBounds) applySliderBounds(id, sliderBounds[id]);
}
applyAllSliderBounds();

function openSettings() {
  for (const id in sliderBounds) {
    $(`set-${id}-min`).value = sliderBounds[id].min;
    $(`set-${id}-max`).value = sliderBounds[id].max;
    $(`set-${id}-step`).value = sliderBounds[id].step;
  }
  $("settings-overlay").hidden = false;
}
function closeSettings() {
  $("settings-overlay").hidden = true;
}
$("settings-btn").addEventListener("click", openSettings);
$("settings-close").addEventListener("click", closeSettings);
$("settings-overlay").addEventListener("click", (e) => {
  if (e.target.id === "settings-overlay") closeSettings();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("settings-overlay").hidden) closeSettings();
});

$("settings-apply").addEventListener("click", () => {
  const next = {};
  for (const id in SLIDER_DEFAULT_BOUNDS) {
    const min = parseFloat($(`set-${id}-min`).value);
    const max = parseFloat($(`set-${id}-max`).value);
    const step = parseFloat($(`set-${id}-step`).value);
    if (![min, max, step].every(isFinite) || step <= 0 || max <= min) {
      toast(`Invalid bounds for "${id}" — max must exceed min, step must be positive.`);
      return;
    }
    next[id] = { min, max, step };
  }
  sliderBounds = next;
  localStorage.setItem(SLIDER_BOUNDS_KEY, JSON.stringify(sliderBounds));
  applyAllSliderBounds();
  closeSettings();
});

$("settings-reset").addEventListener("click", () => {
  sliderBounds = JSON.parse(JSON.stringify(SLIDER_DEFAULT_BOUNDS));
  localStorage.removeItem(SLIDER_BOUNDS_KEY);
  applyAllSliderBounds();
  openSettings();
});

function bindNumber(id, setter) {
  const el = $(id);
  el.addEventListener("input", () => {
    setter(parseFloat(el.value));
    schedule();
  });
}
bindNumber("acx", (v) => (state.acenter[0] = v || 0));
bindNumber("acy", (v) => (state.acenter[1] = v || 0));
bindNumber("acz", (v) => (state.acenter[2] = v || 0));
bindNumber("grid-nx", (v) => (state.gridNx = Math.max(1, Math.round(v) || 1)));
bindNumber("grid-ny", (v) => (state.gridNy = Math.max(1, Math.round(v) || 1)));

// Focus center — also drives srcPos when srcAtFocus is on
function bindFocusCenter(id, axis) {
  const el = $(id);
  el.addEventListener("input", () => {
    const v = parseFloat(el.value) || 0;
    state.fcenter[axis] = v;
    if (state.srcAtFocus) {
      state.srcPos[axis] = v;
      syncSrcInputs();
      geo.updateSource(state.srcPos);
    }
    schedule();
  });
}
bindFocusCenter("fcx", 0);
bindFocusCenter("fcy", 1);
bindFocusCenter("fcz", 2);

bindNumber("width",  (v) => (state.width  = v > 0 ? v : state.width));
bindNumber("height", (v) => (state.height = v > 0 ? v : state.height));
bindNumber("c",      (v) => (state.c      = v > 0 ? v : state.c));

// Source position
function syncSrcInputs() {
  $("srx").value = state.srcPos[0];
  $("sry").value = state.srcPos[1];
  $("srz").value = state.srcPos[2];
}
function bindSrcAxis(id, axis) {
  const el = $(id);
  el.addEventListener("input", () => {
    if (state.srcAtFocus) return;
    state.srcPos[axis] = parseFloat(el.value) || 0;
    geo.updateSource(state.srcPos);
    schedule();
  });
}
bindSrcAxis("srx", 0);
bindSrcAxis("sry", 1);
bindSrcAxis("srz", 2);

$("src-at-focus").addEventListener("change", (e) => {
  state.srcAtFocus = e.target.checked;
  $("src-pos-fields").style.opacity = state.srcAtFocus ? "0.45" : "1";
  $("src-pos-fields").style.pointerEvents = state.srcAtFocus ? "none" : "";
  if (state.srcAtFocus) {
    state.srcPos = state.fcenter.slice();
    syncSrcInputs();
    geo.updateSource(state.srcPos);
  }
  schedule();
});

// Multiplane toggle
$("multiplane").addEventListener("change", (e) => {
  state.multiplane = e.target.checked;
  geo.setMultiplane(state.multiplane);
  schedule();
});

// Ray-trace toggle
$("raytrace").addEventListener("change", (e) => {
  state.raytrace = e.target.checked;
  $("rt-badge").hidden = !state.raytrace;
  geo.setRaytrace(state.raytrace);
});

$("diag-removal").addEventListener("change", (e) => {
  state.diagRemoval = e.target.checked;
  schedule();
});

$("lines").addEventListener("change", (e) => {
  state.lines = e.target.checked;
  if (lastResults.xy) drawPlot(lastResults[state.fplane] || lastResults.xy);
});

// segmented controls
document.querySelectorAll(".seg").forEach((seg) => {
  const key = seg.dataset.seg;
  seg.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => {
      seg.querySelectorAll("button").forEach((b) => b.classList.remove("on"));
      btn.classList.add("on");
      state[key] = btn.dataset.val;
      if (key === "source") updateSourceVisibility();
      if (key === "steering") $("lab-steering").textContent = `Formulation ${btn.dataset.val}`;
      schedule();
    });
  });
});

function updateSourceVisibility() {
  document.querySelectorAll("[data-when]").forEach((el) => {
    const [k, v] = el.dataset.when.split("=");
    el.hidden = state[k] !== v;
  });
  document.querySelectorAll("[data-when-not]").forEach((el) => {
    const [k, v] = el.dataset.whenNot.split("=");
    el.hidden = state[k] === v;
  });
}
updateSourceVisibility();

// CSV file load
$("csv-btn").addEventListener("click", () => $("csv-input").click());
$("csv-input").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    state.csvText = String(reader.result);
    state.csvName = file.name;
    $("csv-status").textContent = `Loaded ${file.name}`;
    schedule();
  };
  reader.onerror = () => toast("Could not read that file.");
  reader.readAsText(file);
});

// ───────────────────────── compute pipeline ─────────────────────────
let timer = 0;
// Store per-plane results for the 3D multi-plane view
const lastResults = { xy: null, xz: null, yz: null };

function schedule() {
  clearTimeout(timer);
  timer = setTimeout(compute, 140);
}

function buildArrayDescriptor() {
  const center = state.acenter.slice();
  const plane = state.aplane;
  switch (state.source) {
    case "ring":
      return { kind: "ring", n: state.ringN, diameter: state.ringDiameter, center, plane };
    case "grid":
      return { kind: "grid", nx: state.gridNx, ny: state.gridNy, pitch: state.gridPitch, center, plane };
    case "cross":
      return { kind: "cross", n: state.crossN, length: state.crossLength, center, plane };
    case "csv":
      return { kind: "csv", text: state.csvText || "" };
    case "sunflower":
    default:
      return { kind: "sunflower", n: state.n, diameter: state.diameter, center, plane };
  }
}

function buildRequest(planeName) {
  const plane = planeName || state.fplane;
  const array = buildArrayDescriptor();

  // Choose a sensible default center for off-axis planes:
  // the user's focus center, but mapped into the correct axes
  const center = state.fcenter.slice();

  const focus = {
    center,
    plane,
    width: state.width,
    height: state.height,
    dx: state.dx,
  };
  return {
    array,
    focus,
    source: state.srcPos.slice(),
    frequency: state.frequency,
    speed_of_sound: state.c,
    shading: state.shading,
    steering: state.steering,
    diag_removal: state.diagRemoval,
  };
}

async function computePlane(planeName) {
  try {
    const inv = await getInvoke();
    return inv
      ? await inv("compute", { req: buildRequest(planeName) })
      : jsCompute(buildRequest(planeName));
  } catch (e) {
    throw typeof e === "string" ? e : (e.message || "Compute failed.");
  }
}

async function compute() {
  if (state.source === "csv" && !state.csvText) {
    toast("Load a CSV of microphone positions first.");
    return;
  }

  try {
    // Always compute the primary (fplane) result for the 2D panel
    const primary = await computePlane(state.fplane);
    lastResults[state.fplane] = primary;
    drawPlot(primary);
    updateReadouts(primary);

    if (state.multiplane) {
      // Compute the other two planes in parallel
      const others = ["xy", "xz", "yz"].filter((p) => p !== state.fplane);
      const [r1, r2] = await Promise.all(others.map((p) => computePlane(p).catch(() => null)));
      lastResults[others[0]] = r1;
      lastResults[others[1]] = r2;

      // Send textures for other planes to the 3D view
      others.forEach((p, i) => {
        const r = [r1, r2][i];
        if (r) renderOffscreenTexture(r, p);
      });
    }

    // Update 3D geometry (always use primary for mics/corners)
    geo.update(primary.mics, primary.weights, primary.corners, state.fplane, lastResults, state.multiplane);
    geo.updateSource(state.srcPos);
  } catch (e) {
    toast(e);
  }
}

function drawPlot(res) {
  plot.render({
    values: res.values,
    nx: res.nx,
    ny: res.ny,
    u: res.u,
    v: res.v,
    width: state.width,
    height: state.height,
    dynamicDb: state.dyn,
    levels: state.levels,
    showLines: state.lines,
    planeLabel: state.fplane,
  });
  $("psf-plane").textContent = " · " + state.fplane;
}

// Render a PSF result into an offscreen canvas and push the texture to geo
function renderOffscreenTexture(res, plane) {
  const cv = document.createElement("canvas");
  const SIZE = 256;
  cv.width = cv.height = SIZE;
  const ctx = cv.getContext("2d");
  plot.renderTexture(
    { ...res, dynamicDb: state.dyn, levels: state.levels },
    cv, ctx
  );
  geo.setTexture(cv, plane);
}

// ───────────────────────── readouts ─────────────────────────
const fmtFreq = (hz) => (hz >= 1000 ? `${(hz / 1000).toFixed(2)} kHz` : `${hz | 0} Hz`);
const fmtLen = (m) =>
  Math.abs(m) >= 1 ? `${m.toFixed(2)} m` : `${(m * 1000).toFixed(m * 1000 < 100 ? 1 : 0)} mm`;

function updateReadouts(res) {
  const m = res.metrics;
  $("st-f").textContent = fmtFreq(state.frequency);
  $("st-lambda").textContent = fmtLen(state.c / state.frequency);
  $("st-alias").textContent = m.alias_frequency ? fmtFreq(m.alias_frequency) : "—";

  $("m-n").textContent = m.n_mics;
  $("m-ap").textContent = fmtLen(m.aperture);
  const bu = m.beamwidth_u != null ? (m.beamwidth_u * 1000).toFixed(0) : "—";
  const bv = m.beamwidth_v != null ? (m.beamwidth_v * 1000).toFixed(0) : "—";
  $("m-bw").textContent = `${bu} × ${bv} mm`;
  $("m-psl").textContent = m.peak_sidelobe_db != null ? `${m.peak_sidelobe_db.toFixed(1)} dB` : "—";
  $("m-alias").textContent = m.alias_frequency ? fmtFreq(m.alias_frequency) : "—";

  const st = $("m-state");
  if (m.alias_frequency && state.frequency > m.alias_frequency) {
    st.textContent = "grating lobes";
    st.className = "v warn";
  } else {
    st.textContent = "alias-free";
    st.className = "v good";
  }
}

// ───────────────────────── toast ─────────────────────────
let toastTimer = 0;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 3600);
}

// ════════════════════════ JS fallback engine ════════════════════════
const GOLDEN = 2.399963229728653;
function planeBasis(p) {
  if (p === "xz") return [[1, 0, 0], [0, 0, 1]];
  if (p === "yz") return [[0, 1, 0], [0, 0, 1]];
  return [[1, 0, 0], [0, 1, 0]];
}
const vadd   = (a, b) => [a[0]+b[0], a[1]+b[1], a[2]+b[2]];
const vscale = (a, s) => [a[0]*s,    a[1]*s,    a[2]*s];
const vdist  = (a, b) => Math.hypot(a[0]-b[0], a[1]-b[1], a[2]-b[2]);

function buildArrayJS(req) {
  const a = req.array;
  if (a.kind === "sunflower") {
    const [uh, vh] = planeBasis(a.plane);
    const r0 = a.diameter / 2;
    const pos = [];
    for (let k = 0; k < a.n; k++) {
      const r  = r0 * Math.sqrt((k + 0.5) / a.n);
      const th = k * GOLDEN;
      pos.push(vadd(a.center, vadd(vscale(uh, r*Math.cos(th)), vscale(vh, r*Math.sin(th)))));
    }
    return { pos, weights: null };
  }
  if (a.kind === "ring") {
    const [uh, vh] = planeBasis(a.plane);
    const r = a.diameter / 2;
    const pos = [];
    for (let k = 0; k < a.n; k++) {
      const th = (k / a.n) * 2 * Math.PI;
      pos.push(vadd(a.center, vadd(vscale(uh, r*Math.cos(th)), vscale(vh, r*Math.sin(th)))));
    }
    return { pos, weights: null };
  }
  if (a.kind === "grid") {
    const [uh, vh] = planeBasis(a.plane);
    const u0 = -(a.nx - 1) * a.pitch / 2;
    const v0 = -(a.ny - 1) * a.pitch / 2;
    const pos = [];
    for (let j = 0; j < a.ny; j++)
      for (let i = 0; i < a.nx; i++) {
        const uu = u0 + i * a.pitch, vv = v0 + j * a.pitch;
        pos.push(vadd(a.center, vadd(vscale(uh, uu), vscale(vh, vv))));
      }
    return { pos, weights: null };
  }
  if (a.kind === "cross") {
    const [uh, vh] = planeBasis(a.plane);
    const half = a.length / 2, step = a.length / (a.n - 1);
    const pos = [];
    for (let i = 0; i < a.n; i++) pos.push(vadd(a.center, vscale(uh, -half + i*step)));
    for (let j = 0; j < a.n; j++) {
      const vv = -half + j*step;
      if (Math.abs(vv) < 1e-12) continue;
      pos.push(vadd(a.center, vscale(vh, vv)));
    }
    return { pos, weights: null };
  }
  const pos = [], w = [];
  let anyW = false;
  for (const raw of a.text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const f = line.split(/[,;\t ]+/).filter(Boolean).map(Number);
    if (f.length < 3 || f.slice(0,3).some((x) => !isFinite(x))) continue;
    pos.push([f[0], f[1], f[2]]);
    if (f.length >= 4 && isFinite(f[3])) { w.push(f[3]); anyW = true; } else w.push(1);
  }
  if (!pos.length) throw "No microphone rows found (need 3 numeric columns).";
  return { pos, weights: anyW ? w : null };
}

function centroid(pos) {
  const s = pos.reduce((a,p) => vadd(a,p), [0,0,0]);
  return vscale(s, 1 / Math.max(1, pos.length));
}
function weightsForJS(arr, shading) {
  if (arr.weights) return arr.weights.slice();
  if (shading === "hann") {
    const c = centroid(arr.pos);
    const rmax = Math.max(1e-12, ...arr.pos.map((p) => vdist(p, c)));
    return arr.pos.map((p) => { const rho = Math.min(1, vdist(p,c)/rmax); return 0.5*(1+Math.cos(Math.PI*rho)); });
  }
  return arr.pos.map(() => 1);
}

function gridJS(focus) {
  const nx = Math.max(1, Math.round(focus.width  / focus.dx)) + 1;
  const ny = Math.max(1, Math.round(focus.height / focus.dx)) + 1;
  const u  = Array.from({ length: nx }, (_, i) => -focus.width /2 + i*focus.dx);
  const v  = Array.from({ length: ny }, (_, j) => -focus.height/2 + j*focus.dx);
  const [uh, vh] = planeBasis(focus.plane);
  const P = (uu, vv) => vadd(focus.center, vadd(vscale(uh,uu), vscale(vh,vv)));
  const corners = [P(u[0],v[0]), P(u[nx-1],v[0]), P(u[nx-1],v[ny-1]), P(u[0],v[ny-1])];
  return { nx, ny, u, v, corners, uh, vh };
}

// Sarradj (2012) steering-vector formulations — mirrors psf-core/src/lib.rs.
// x_m(t) = (r0/rm) * exp(-jk(rm - r0)); reference r0 is the array centroid.
//   I   (classic):       h_m = x_m / |x_m|                (phase only)
//   II  (inverse):       h_m = 1 / conj(x_m)
//   III (true level):    h_m = x_m / Σ w_m|x_m|²
//   IV  (true location): h_m = x_m / sqrt(Σw_m * Σ w_m|x_m|²)
function jsCompute(req) {
  const arr       = buildArrayJS(req);
  const weights   = weightsForJS(arr, req.shading);
  const f         = req.focus;
  const g         = gridJS(f);
  const k         = (2 * Math.PI * req.frequency) / req.speed_of_sound;
  const reference = centroid(arr.pos);
  const formulation = req.steering || "I";
  const diagRemoval  = !!req.diag_removal;
  const source = req.source || f.center;

  // actual free-field pressure at each mic from the unit source
  const p = arr.pos.map((m) => {
    const d = Math.max(1e-9, vdist(m, source));
    const ph = -k * d;
    return [Math.cos(ph) / d, Math.sin(ph) / d];
  });

  const wsum = weights.reduce((a, b) => a + b, 0);
  const wsumSafe = Math.abs(wsum) < 1e-30 ? 1 : wsum;
  const needsNormPass = formulation === "III" || formulation === "IV";

  const raw = new Float64Array(g.nx * g.ny);
  for (let j = 0; j < g.ny; j++) {
    for (let i = 0; i < g.nx; i++) {
      const pt = vadd(f.center, vadd(vscale(g.uh, g.u[i]), vscale(g.vh, g.v[j])));
      const r0 = Math.max(1e-9, vdist(reference, pt));

      let normSqSum = 1;
      if (needsNormPass) {
        let s = 0;
        for (let mi = 0; mi < arr.pos.length; mi++) {
          const rm = Math.max(1e-9, vdist(arr.pos[mi], pt));
          const gm = r0 / rm;
          s += weights[mi] * gm * gm;
        }
        normSqSum = Math.abs(s) < 1e-30 ? 1 : s;
      }
      let norm;
      if (formulation === "III") norm = normSqSum;
      else if (formulation === "IV") norm = Math.sqrt(Math.max(0, wsumSafe) * normSqSum);
      else norm = wsumSafe;
      const invNorm = Math.abs(norm) < 1e-30 ? 1 : 1 / norm;

      let sRe = 0, sIm = 0, diagSum = 0;
      for (let mi = 0; mi < arr.pos.length; mi++) {
        const rm = Math.max(1e-9, vdist(arr.pos[mi], pt));
        const gm = r0 / rm;
        const ph = -k * (rm - r0);
        const c = Math.cos(ph), s = Math.sin(ph);
        let yRe, yIm;
        if (formulation === "II") { yRe = c / gm; yIm = s / gm; }
        else if (formulation === "III" || formulation === "IV") { yRe = gm * c; yIm = gm * s; }
        else { yRe = c; yIm = s; }
        const hRe = weights[mi] * yRe * invNorm;
        const hIm = weights[mi] * yIm * invNorm;
        const [pRe, pIm] = p[mi];
        sRe += hRe * pRe + hIm * pIm;
        sIm += hRe * pIm - hIm * pRe;
        if (diagRemoval) diagSum += (hRe * hRe + hIm * hIm) * (pRe * pRe + pIm * pIm);
      }
      let power = sRe * sRe + sIm * sIm;
      if (diagRemoval) power -= diagSum;
      raw[j * g.nx + i] = Math.max(0, power);
    }
  }

  // Normalise to the grid's own peak — the source (and thus the peak) need
  // not sit at the grid's geometric centre.
  const p0 = Math.max(1e-30, raw.reduce((a, b) => Math.max(a, b), 0));
  const values = new Float32Array(g.nx * g.ny);
  for (let idx = 0; idx < raw.length; idx++) {
    values[idx] = Math.max(-300, 10 * Math.log10(raw[idx] / p0 + 1e-30));
  }

  const metrics = metricsJS(arr, g, values, req.speed_of_sound);
  return { mics: arr.pos, weights, nx: g.nx, ny: g.ny, u: g.u, v: g.v, corners: g.corners, values, metrics };
}

function halfWidth(coords, line, center, fwd) {
  let idx = center;
  for (;;) {
    const next = fwd ? idx+1 : idx-1;
    if (next < 0 || next >= coords.length) return null;
    if (line[next] <= -3) {
      const a = line[idx], b = line[next];
      const frac = Math.abs(a-b) < 1e-9 ? 0 : (a+3)/(a-b);
      return Math.abs(coords[idx] + frac*(coords[next]-coords[idx]) - coords[center]);
    }
    idx = next;
  }
}
function firstNull(line, center, fwd, len) {
  let idx = center;
  for (;;) {
    const next = fwd ? idx+1 : idx-1;
    if (next < 0 || next >= len) return len;
    if (line[next] > line[idx] && idx !== center) return Math.abs(idx-center);
    idx = next;
  }
}
function metricsJS(arr, g, values, c) {
  const { nx, ny, u, v } = g;
  // The mainlobe peak (normalised to exactly 0 dB) isn't necessarily at the
  // grid's geometric middle — the source can sit anywhere. Locate it.
  let peakIdx = 0;
  for (let idx = 1; idx < values.length; idx++) {
    if (values[idx] > values[peakIdx]) peakIdx = idx;
  }
  const cx = peakIdx % nx, cy = (peakIdx / nx) | 0;
  const row = Array.from({ length: nx }, (_, i) => values[cy*nx+i]);
  const col = Array.from({ length: ny }, (_, j) => values[j*nx+cx]);
  const bwU = halfWidth(u,row,cx,true) != null && halfWidth(u,row,cx,false) != null
    ? halfWidth(u,row,cx,true) + halfWidth(u,row,cx,false) : null;
  const bwV = halfWidth(v,col,cy,true) != null && halfWidth(v,col,cy,false) != null
    ? halfWidth(v,col,cy,true) + halfWidth(v,col,cy,false) : null;
  const nr = Math.max(
    firstNull(row,cx,true,nx), firstNull(row,cx,false,nx),
    firstNull(col,cy,true,ny), firstNull(col,cy,false,ny)
  );
  let psl = null;
  if (nr < Math.max(nx,ny)) {
    let best = -300;
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const du = (i-cx)/Math.max(1,nr), dv = (j-cy)/Math.max(1,nr);
        if (du*du+dv*dv > 1) best = Math.max(best, values[j*nx+i]);
      }
    if (best > -300) psl = best;
  }
  let dmin = Infinity, aperture = 0;
  for (let a = 0; a < arr.pos.length; a++)
    for (let b = a+1; b < arr.pos.length; b++) {
      const d = vdist(arr.pos[a], arr.pos[b]);
      if (d < dmin) dmin = d;
      if (d > aperture) aperture = d;
    }
  return {
    beamwidth_u: bwU, beamwidth_v: bwV, peak_sidelobe_db: psl,
    alias_frequency: isFinite(dmin) && dmin > 0 ? c/(2*dmin) : null,
    aperture, n_mics: arr.pos.length,
  };
}

// ───────────────────────── ambient interference field ─────────────────────────
(function ambientField() {
  const cv  = document.getElementById("field");
  const ctx = cv.getContext("2d");
  const RES = 150;
  cv.width = RES; cv.height = RES;
  cv.style.width = "100vw"; cv.style.height = "100vh";
  const img = ctx.createImageData(RES, RES);
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const sources = [[0.3,0.35],[0.72,0.28],[0.5,0.78]];
  function frame(t) {
    const ph = t * 0.00015; let o = 0;
    for (let y = 0; y < RES; y++) {
      for (let x = 0; x < RES; x++) {
        const fx = x/RES, fy = y/RES;
        let s = 0;
        for (let k = 0; k < sources.length; k++) {
          const dx = fx-sources[k][0], dy = fy-sources[k][1];
          s += Math.sin(Math.sqrt(dx*dx+dy*dy)*70 - ph*(1+k*0.3));
        }
        const val = (s/sources.length)*0.5+0.5;
        img.data[o++] = 30+val*40; img.data[o++] = 90+val*80;
        img.data[o++] = 150+val*90; img.data[o++] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    if (!reduce) requestAnimationFrame(frame);
  }
  if (reduce) frame(0); else requestAnimationFrame(frame);
})();

// ───────────────────────── go ─────────────────────────
compute();
