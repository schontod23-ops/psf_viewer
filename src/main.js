import "./style.css";
import { PSFPlot } from "./psfplot.js";
import { Geometry3D } from "./geometry3d.js";
import { LineChart, CHART_PALETTE } from "./linechart.js";
import { MicEditor } from "./micedit.js";

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

let listenPromise = null;
function getListen() {
  if (!isTauri) return Promise.resolve(null);
  if (!listenPromise)
    listenPromise = import("@tauri-apps/api/event")
      .then((m) => m.listen)
      .catch(() => null);
  return listenPromise;
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
  // hand-edited layout (source === "manual"); survives save/load
  manualPos: null,
  manualWeights: null,
  fplane: "xy",
  fcenter: [0, 0, 1],
  width: 1,
  height: 1,
  dx: 0.02,
  frequency: 5000,
  c: 343,
  shading: "uniform",
  steering: "I",
  // beamforming algorithm: "conventional" | "functional" (exponent nu)
  algorithm: "conventional",
  nu: 16,
  diagRemoval: false,
  // optional white sensor-noise floor: σ² = 10^(noiseDb/10) when enabled
  noiseEnabled: false,
  noiseDb: -40,
  dyn: 30,
  levels: 10,
  lines: true,
  cut: false,
  colormap: "turbo",
  // source marker (primary source)
  srcPos: [0, 0, 1],
  srcAtFocus: false,
  // additional incoherent sources: { pos:[x,y,z], amplitude }
  extraSources: [],
  // 3D options
  multiplane: false,
  planeFade: true,
  micColorByWeight: false,
  // STL model (the geometry itself is not persisted — only how to interpret it)
  stlName: null,
  stlScale: 1,
  stlRotX: 0,
  stlRotY: 0,
  stlRotZ: 0,
  stlTx: 0,
  stlTy: 0,
  stlTz: 0,
  stlDensity: 2000,
  stlPsf: false,
  // broadband sweep
  sweepFmin: 1000,
  sweepFmax: 10000,
  sweepPoints: 24,
  sweepLog: true,
  sweepBand: true,
  showBand: false,
};

// Last sweep result (not persisted — it is derived and can be large).
let lastSweep = null;
// Mirrors psf_core::MAX_SWEEP_POINTS.
const MAX_SWEEP_POINTS = 200;

// ───────────────────────── views ─────────────────────────
const plot = new PSFPlot(document.getElementById("plot"));
const geo = new Geometry3D(document.getElementById("three"));
plot.onTexture = (cv, plane) => geo.setTexture(cv, plane);

const $ = (id) => document.getElementById(id);

// ───────────────────────── control wiring ─────────────────────────

// Registry of silent slider setters (state → DOM) keyed by slider id,
// used when applying a loaded configuration without re-triggering compute.
const sliderSetters = {};

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
  sliderSetters[id] = sync;

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
bindSlider("noise", "noiseDb", (v) => `${v | 0} dB`);
bindSlider("nu", "nu", (v) => `${v | 0}`);

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
  if (e.key !== "Escape") return;
  if (!$("settings-overlay").hidden) closeSettings();
  else if (!$("sweep-overlay").hidden) $("sweep-overlay").hidden = true;
  else if (!$("compare-overlay").hidden) closeCompare();
  // The editor's own canvas uses Esc to clear its selection, so only close the
  // dialog when the canvas does not have focus.
  else if (!$("mic-overlay").hidden && document.activeElement !== (micEditor && micEditor.canvas)) {
    $("mic-overlay").hidden = true;
  }
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

// ── additional sources editor ──
function renderExtraSources() {
  const host = $("extra-sources");
  host.innerHTML = "";
  state.extraSources.forEach((src, idx) => {
    const row = document.createElement("div");
    row.className = "src-row";
    const mk = (val, step, label, on) => {
      const el = document.createElement("input");
      el.type = "number";
      el.value = val;
      el.step = step;
      el.setAttribute("aria-label", label);
      el.addEventListener("input", () => { on(parseFloat(el.value)); });
      return el;
    };
    row.appendChild(mk(src.pos[0], 0.05, `source ${idx + 2} x`, (v) => { src.pos[0] = v || 0; onExtraChanged(); }));
    row.appendChild(mk(src.pos[1], 0.05, `source ${idx + 2} y`, (v) => { src.pos[1] = v || 0; onExtraChanged(); }));
    row.appendChild(mk(src.pos[2], 0.05, `source ${idx + 2} z`, (v) => { src.pos[2] = v || 0; onExtraChanged(); }));
    row.appendChild(mk(src.amplitude, 0.1, `source ${idx + 2} amplitude`, (v) => { src.amplitude = isFinite(v) ? v : 1; onExtraChanged(); }));
    const del = document.createElement("button");
    del.className = "src-del";
    del.textContent = "×";
    del.title = "Remove source";
    del.addEventListener("click", () => {
      state.extraSources.splice(idx, 1);
      renderExtraSources();
      onExtraChanged();
    });
    row.appendChild(del);
    host.appendChild(row);
  });
}

function onExtraChanged() {
  geo.updateExtraSources(state.extraSources);
  schedule();
}

$("add-source").addEventListener("click", () => {
  // New source seeded just off the primary source so it's visible.
  const base = state.srcPos;
  state.extraSources.push({ pos: [base[0] + 0.2, base[1], base[2]], amplitude: 1 });
  renderExtraSources();
  onExtraChanged();
});

// Multiplane toggle
$("multiplane").addEventListener("change", (e) => {
  state.multiplane = e.target.checked;
  geo.setMultiplane(state.multiplane);
  schedule();
});

$("plane-fade").addEventListener("change", (e) => {
  state.planeFade = e.target.checked;
  geo.setPlaneFade(state.planeFade);
});

$("mic-color-weight").addEventListener("change", (e) => {
  state.micColorByWeight = e.target.checked;
  geo.setMicColorByWeight(state.micColorByWeight);
});

$("diag-removal").addEventListener("change", (e) => {
  state.diagRemoval = e.target.checked;
  schedule();
});

$("noise-enable").addEventListener("change", (e) => {
  state.noiseEnabled = e.target.checked;
  $("noise-field").hidden = !state.noiseEnabled;
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
      if (key === "viewmode") {
        applyViewMode(btn.dataset.val);
        return;
      }
      if (key === "source") updateSourceVisibility();
      if (key === "steering") $("lab-steering").textContent = `Formulation ${btn.dataset.val}`;
      if (key === "algorithm") updateAlgorithmUI();
      schedule();
    });
  });
});

// Functional beamforming exposes the ν exponent and has no diagonal to remove,
// so the diagonal-removal toggle is disabled while it is selected.
function updateAlgorithmUI() {
  const functional = state.algorithm === "functional";
  $("nu-field").hidden = !functional;
  const dr = $("diag-removal");
  dr.disabled = functional;
  const row = dr.closest(".check");
  if (row) row.style.opacity = functional ? "0.45" : "";
}

// ───────────────────────── 2-D / 3-D view toggle ─────────────────────────
const VIEW_MODE_KEY = "psf-view-mode";
function applyViewMode(mode) {
  const app = document.querySelector(".app");
  app.classList.remove("hide-3d", "hide-psf");
  if (mode === "3d") app.classList.add("hide-psf");
  else if (mode === "2d") app.classList.add("hide-3d");
  localStorage.setItem(VIEW_MODE_KEY, mode);
  geo.resize();
}

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
updateAlgorithmUI();

// Restore the last view-mode choice (default "both" if none saved).
{
  const savedMode = localStorage.getItem(VIEW_MODE_KEY) || "both";
  setSeg("viewmode", savedMode);
  applyViewMode(savedMode);
}

// ───────────────────────── collapsible sidebar sections ─────────────────────────
const SECTION_STATE_KEY = "psf-sections";
{
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(SECTION_STATE_KEY)) || {}; } catch { saved = {}; }
  document.querySelectorAll("details[data-sec]").forEach((el) => {
    const id = el.dataset.sec;
    if (id in saved) el.open = saved[id];
    el.addEventListener("toggle", () => {
      saved[id] = el.open;
      localStorage.setItem(SECTION_STATE_KEY, JSON.stringify(saved));
    });
  });
}

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
    case "manual":
      return {
        kind: "manual",
        pos: (state.manualPos || []).map((p) => p.slice()),
        weights: state.manualWeights ? state.manualWeights.slice() : null,
      };
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
    sources: activeSources(),
    frequency: state.frequency,
    physics: buildPhysics(),
  };
}

// The physics block every engine request carries (mirrors `Physics` in the Rust
// bridge). Sent as a nested object rather than flattened.
function buildPhysics() {
  return {
    speed_of_sound: state.c,
    shading: state.shading,
    steering: state.steering,
    diag_removal: state.diagRemoval,
    // σ² per sensor; 0 disables the noise floor entirely.
    noise_power: state.noiseEnabled ? Math.pow(10, state.noiseDb / 10) : 0,
    algorithm:
      state.algorithm === "functional"
        ? { kind: "functional", nu: state.nu }
        : { kind: "conventional" },
  };
}

// The scene's incoherent point sources. The primary source is always the
// one driven by the Source panel (state.srcPos); any extra sources the user
// has added live in state.extraSources as {pos:[x,y,z], amplitude}.
function activeSources() {
  const list = [{ pos: state.srcPos.slice(), amplitude: 1 }];
  for (const s of state.extraSources) {
    list.push({ pos: s.pos.slice(), amplitude: s.amplitude });
  }
  return list;
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

// Sources that need something loaded/edited before they can resolve to an array.
function arrayNotReady() {
  if (state.source === "csv" && !state.csvText) {
    return "Load a CSV of microphone positions first.";
  }
  if (state.source === "manual" && !(state.manualPos && state.manualPos.length)) {
    return "No hand-edited layout yet — open the microphone editor first.";
  }
  return null;
}

async function compute() {
  const blocked = arrayNotReady();
  if (blocked) {
    toast(blocked);
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
    saveSession();
  } catch (e) {
    toast(e);
  }
}

// Project each source's world position onto the focus plane's (u,v) axes,
// relative to the focus centre, so the plot can mark it.
function sourcesInPlane(plane) {
  const [uh, vh] = planeBasis(plane);
  const c = state.fcenter;
  const proj = (pos) => ({
    u: (pos[0] - c[0]) * uh[0] + (pos[1] - c[1]) * uh[1] + (pos[2] - c[2]) * uh[2],
    v: (pos[0] - c[0]) * vh[0] + (pos[1] - c[1]) * vh[1] + (pos[2] - c[2]) * vh[2],
  });
  return activeSources().map((s) => proj(s.pos));
}

function drawPlot(res) {
  // Show the band-averaged map instead of the single-frequency one when asked —
  // but only while it still matches the current grid (the user may have resized
  // the focus plane since the sweep ran).
  const band =
    state.showBand && lastSweep && lastSweep.band_values &&
    lastSweep.nx === res.nx && lastSweep.ny === res.ny
      ? lastSweep.band_values
      : null;

  plot.render({
    values: band || res.values,
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
    colormap: state.colormap,
    sources: sourcesInPlane(state.fplane),
  });
  $("psf-plane").textContent = " · " + state.fplane + (band ? " · band average" : "");
  renderCut();
}

// Render a PSF result into an offscreen canvas and push the texture to geo
function renderOffscreenTexture(res, plane) {
  const cv = document.createElement("canvas");
  const SIZE = 256;
  cv.width = cv.height = SIZE;
  const ctx = cv.getContext("2d");
  plot.renderTexture(
    { ...res, dynamicDb: state.dyn, levels: state.levels, colormap: state.colormap },
    cv, ctx
  );
  geo.setTexture(cv, plane);
}

// ───────────────────────── export ─────────────────────────
function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportPng() {
  const canvas = plot.canvas;
  if (!canvas || !canvas.width) {
    toast("Nothing to export yet.");
    return;
  }
  canvas.toBlob((blob) => {
    if (!blob) {
      toast("PNG export failed.");
      return;
    }
    downloadBlob(blob, `psf-${state.fplane}-${state.frequency | 0}Hz-${timestamp()}.png`);
  }, "image/png");
}

function exportCsv() {
  const res = lastResults[state.fplane];
  if (!res) {
    toast("Nothing to export yet.");
    return;
  }
  const [au, av] = planeAxesLabels(state.fplane);
  const lines = [];
  lines.push(`# PSF Array Viewer export`);
  lines.push(`# plane=${state.fplane} frequency_Hz=${state.frequency} speed_of_sound_m_s=${state.c}`);
  lines.push(`# steering=${state.steering} shading=${state.shading} diag_removal=${state.diagRemoval} noise_dB=${state.noiseEnabled ? state.noiseDb : "off"}`);
  lines.push(`# algorithm=${state.algorithm}${state.algorithm === "functional" ? ` nu=${state.nu}` : ""}`);
  lines.push(`# source_m=[${state.srcPos.join(",")}] grid=${res.nx}x${res.ny}`);
  lines.push(`${au}_m,${av}_m,level_dB`);
  for (let j = 0; j < res.ny; j++) {
    for (let i = 0; i < res.nx; i++) {
      lines.push(`${res.u[i]},${res.v[j]},${res.values[j * res.nx + i]}`);
    }
  }
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  downloadBlob(blob, `psf-${state.fplane}-${state.frequency | 0}Hz-${timestamp()}.csv`);
}

function planeAxesLabels(label) {
  if (label === "xz") return ["x", "z"];
  if (label === "yz") return ["y", "z"];
  return ["x", "y"];
}

$("export-png").addEventListener("click", exportPng);
$("export-csv").addEventListener("click", exportCsv);

// ───────────────────────── microphone editor ─────────────────────────
// Seeded from whatever array is currently resolved. Applying an edit converts the
// array into a `manual` layout — a generator would otherwise overwrite the edit on
// the next recompute.
let micEditor = null;

function openMicEditor() {
  const res = lastResults[state.fplane];
  if (!res || !res.mics || !res.mics.length) {
    toast("Nothing to edit yet.");
    return;
  }
  $("mic-overlay").hidden = false;
  if (!micEditor) {
    micEditor = new MicEditor($("mic-canvas"));
    micEditor.onChange = () => {
      updateMicSub();
      scheduleMicPreview();
    };
  }
  // Editing happens in the array's own plane (out-of-plane offsets are preserved).
  micEditor.load(res.mics.map((p) => p.slice()), state.aplane);
  applyMicSnap();
  updateMicSub();
  micEditor.canvas.focus();
}

function updateMicSub() {
  if (!micEditor) return;
  const sel = micEditor.selectedCount();
  $("mic-sub").textContent =
    ` · ${micEditor.count()} mics` + (sel ? ` · ${sel} selected` : "") + ` · ${state.aplane} plane`;
}

function applyMicSnap() {
  if (!micEditor) return;
  const on = $("mic-snap-on").checked;
  const step = parseFloat($("mic-snap").value);
  micEditor.setSnap(on && step > 0 ? step : 0);
  micEditor.draw();
}

function closeMicEditor() {
  $("mic-overlay").hidden = true;
  clearTimeout(micPreviewTimer);
  // Revert the live preview if the edit wasn't applied.
  const res = lastResults[state.fplane];
  if (res) {
    geo.previewMics(res.mics, res.weights);
    drawPlot(res);
  }
}

// Live preview while dragging in the editor: the 3-D mic cloud moves
// immediately, and a debounced recompute (same 140 ms cadence as `schedule()`)
// keeps the PSF map in sync without waiting for "Apply".
let micPreviewTimer = null;
function scheduleMicPreview() {
  if (!micEditor) return;
  geo.previewMics(micEditor.positions());
  clearTimeout(micPreviewTimer);
  micPreviewTimer = setTimeout(runMicPreview, 140);
}

async function runMicPreview() {
  if (!micEditor || !micEditor.count()) return;
  const before = lastResults[state.fplane];
  const pos = micEditor.positions();
  const w = before && before.weights;
  const weights = w && w.length === pos.length ? w.slice() : null;
  const req = { ...buildRequest(state.fplane), array: { kind: "manual", pos, weights } };
  try {
    const inv = await getInvoke();
    const res = inv ? await inv("compute", { req }) : jsCompute(req);
    drawPlot(res);
    geo.previewMics(res.mics, res.weights);
  } catch {
    // Ignore transient errors while dragging — the next step will retry.
  }
}

$("mic-edit").addEventListener("click", openMicEditor);
$("mic-close").addEventListener("click", closeMicEditor);
$("mic-overlay").addEventListener("click", (e) => {
  if (e.target.id === "mic-overlay") closeMicEditor();
});
$("mic-snap-on").addEventListener("change", applyMicSnap);
$("mic-snap").addEventListener("input", applyMicSnap);

// Reset re-seeds from the live array, discarding edits made in the dialog.
$("mic-reset").addEventListener("click", () => {
  const res = lastResults[state.fplane];
  if (!res) return;
  micEditor.load(res.mics.map((p) => p.slice()), state.aplane);
  applyMicSnap();
  updateMicSub();
});

$("mic-apply").addEventListener("click", () => {
  if (!micEditor || !micEditor.count()) return;
  const before = lastResults[state.fplane];
  state.manualPos = micEditor.positions();
  // Keep per-mic weights only if the count still lines up (mics may be deleted);
  // otherwise fall back to the shading window.
  const w = before && before.weights;
  state.manualWeights =
    w && w.length === state.manualPos.length ? w.slice() : null;

  state.source = "manual";
  setSeg("source", "manual");
  updateSourceVisibility();
  $("manual-status").textContent = `Hand-edited layout · ${state.manualPos.length} microphones.`;
  closeMicEditor();
  schedule();
});

// ───────────────────────── STL model + surface PSF ─────────────────────────
// The model is parsed client-side (three.js STLLoader). Painting the PSF onto it
// beamforms an area-weighted uniform surface sample through the same engine
// core the map uses (compute_on_points / beamformPointsJS), so map and model
// always agree.
let stlBuffer = null;   // kept so a transform change can re-parse
let stlSample = null;   // { points, totalArea } from the last load

function showStlControls(on) {
  document.querySelectorAll("[data-when-stl]").forEach((el) => (el.hidden = !on));
  $("stl-run").hidden = !(on && state.stlPsf);
}

function stlXform() {
  return {
    scale: state.stlScale,
    rotX: state.stlRotX, rotY: state.stlRotY, rotZ: state.stlRotZ,
    tx: state.stlTx, ty: state.stlTy, tz: state.stlTz,
  };
}

function loadStlBuffer(buffer, xform) {
  const count = geo.loadSTL(buffer, xform);
  resampleStl();
  $("stl-status").textContent =
    `${state.stlName || "model"} · ${count.toLocaleString()} vertices · ${stlSample.points.length.toLocaleString()} samples`;
  showStlControls(true);
  if (state.stlPsf) runSurfacePsf();
}

/** Redraw the surface sample cloud at the current density (no re-parse needed). */
function resampleStl() {
  stlSample = geo.surfacePoints(state.stlDensity);
  if (state.stlPsf) runSurfacePsf();
}

async function runSurfacePsf() {
  if (!stlSample || !state.stlPsf) return;
  const btn = $("stl-run");
  btn.disabled = true;
  btn.textContent = "Evaluating…";
  try {
    const req = {
      array: buildArrayDescriptor(),
      sources: activeSources(),
      points: stlSample.points,
      frequency: state.frequency,
      physics: buildPhysics(),
    };
    const inv = await getInvoke();
    const res = inv ? await inv("compute_on_points", { req }) : jsComputeOnPoints(req);
    geo.setSurfaceLevels(stlSample.points, res.values, state.dyn, state.colormap);
  } catch (e) {
    toast(typeof e === "string" ? e : e.message || "Surface evaluation failed.");
  } finally {
    btn.disabled = false;
    btn.textContent = "Evaluate surface";
  }
}

$("stl-btn").addEventListener("click", () => $("stl-input").click());
$("stl-input").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      stlBuffer = reader.result;
      state.stlName = file.name;
      loadStlBuffer(stlBuffer, stlXform());
    } catch {
      toast("Could not parse that STL.");
    }
  };
  reader.onerror = () => toast("Could not read that file.");
  reader.readAsArrayBuffer(file);
  e.target.value = "";
});

$("stl-clear").addEventListener("click", () => {
  geo.clearSTL();
  stlBuffer = null;
  stlSample = null;
  state.stlName = null;
  state.stlPsf = false;
  $("stl-psf").checked = false;
  $("stl-status").textContent = "Optional. The PSF can be painted onto the model's surface.";
  showStlControls(false);
});

$("stl-scale").addEventListener("change", (e) => {
  const v = parseFloat(e.target.value);
  if (!(v > 0) || !stlBuffer) return;
  state.stlScale = v;
  loadStlBuffer(stlBuffer, stlXform());   // re-parse: geometry transforms are not reversible
});

// Rotation/translation also bake into the geometry, so they re-parse too.
function bindStlTransform(id, key) {
  $(id).addEventListener("change", (e) => {
    const v = parseFloat(e.target.value);
    if (!isFinite(v) || !stlBuffer) return;
    state[key] = v;
    loadStlBuffer(stlBuffer, stlXform());
  });
}
bindStlTransform("stl-rx", "stlRotX");
bindStlTransform("stl-ry", "stlRotY");
bindStlTransform("stl-rz", "stlRotZ");
bindStlTransform("stl-tx", "stlTx");
bindStlTransform("stl-ty", "stlTy");
bindStlTransform("stl-tz", "stlTz");

$("stl-density").addEventListener("change", (e) => {
  const v = parseFloat(e.target.value);
  if (!(v > 0) || !stlBuffer) return;
  state.stlDensity = v;
  resampleStl();
  $("stl-status").textContent =
    `${state.stlName || "model"} · ${stlSample.points.length.toLocaleString()} samples`;
});

$("stl-psf").addEventListener("change", (e) => {
  state.stlPsf = e.target.checked;
  $("stl-run").hidden = !state.stlPsf;
  if (state.stlPsf) runSurfacePsf();
  else geo.clearSurfaceLevels();
});

$("stl-run").addEventListener("click", runSurfacePsf);

// ───────────────────────── frequency sweep ─────────────────────────
// A sweep is far too costly to run on every slider nudge, so it is explicit:
// the user presses "Run sweep". Results feed two charts and, optionally, a
// band-averaged map drawn in place of the single-frequency one.
let chartBw = null;
let chartPsl = null;

function buildSweepRequest() {
  // The base request carries the whole scene; `frequency` is simply swept over
  // (the Rust SweepRequest ignores it; the JS engine overrides it per step).
  return {
    ...buildRequest(state.fplane),
    f_min: state.sweepFmin,
    f_max: state.sweepFmax,
    n_points: Math.round(state.sweepPoints),
    log_spacing: state.sweepLog,
    band_map: state.sweepBand,
  };
}

async function runSweep() {
  const blocked = arrayNotReady();
  if (blocked) {
    toast(blocked);
    return;
  }
  const btn = $("sweep-run");
  const bar = $("sweep-progress");
  btn.disabled = true;
  btn.textContent = "Running…";
  bar.value = 0;
  bar.hidden = false;
  let unlisten = null;
  try {
    const req = buildSweepRequest();
    const inv = await getInvoke();
    if (inv) {
      const listen = await getListen();
      if (listen) {
        unlisten = await listen("sweep-progress", (e) => {
          bar.value = e.payload.step / e.payload.total;
        });
      }
      lastSweep = await inv("compute_sweep", { req });
    } else {
      lastSweep = await jsComputeSweep(req, (step, total) => { bar.value = step / total; });
    }

    $("sweep-open").disabled = false;
    const hasBand = !!lastSweep.band_values;
    $("show-band-row").hidden = !hasBand;
    if (!hasBand && state.showBand) {
      state.showBand = false;
      $("show-band").checked = false;
    }
    openSweep();
    // Repaint the map so a band average (if enabled) takes effect immediately.
    const r = lastResults[state.fplane];
    if (r) drawPlot(r);
  } catch (e) {
    toast(typeof e === "string" ? e : e.message || "Sweep failed.");
  } finally {
    if (unlisten) unlisten();
    btn.disabled = false;
    btn.textContent = "Run sweep";
    bar.hidden = true;
  }
}

function openSweep() {
  if (!lastSweep) return;
  $("sweep-overlay").hidden = false;
  // Built lazily: the hosts have no size until the overlay is shown.
  if (!chartBw) chartBw = new LineChart($("chart-bw"));
  if (!chartPsl) chartPsl = new LineChart($("chart-psl"));
  renderSweepCharts();
}
function closeSweep() {
  $("sweep-overlay").hidden = true;
}

function renderSweepCharts() {
  if (!lastSweep || !chartBw || !chartPsl) return;
  const pts = lastSweep.points;
  // A metric can be undefined at a given frequency (e.g. the −3 dB crossing
  // falls outside the grid). NaN leaves a gap in the line rather than a spike.
  const at = (p, key, scale = 1) => [p.frequency, p[key] == null ? NaN : p[key] * scale];

  const markers = lastSweep.alias_frequency
    ? [{ x: lastSweep.alias_frequency, label: "alias" }]
    : [];
  const fFmt = (v) => (v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k` : `${v.toFixed(0)}`);

  chartBw.render({
    series: [
      { label: "u", color: CHART_PALETTE[0], points: pts.map((p) => at(p, "beamwidth_u", 1000)) },
      { label: "v", color: CHART_PALETTE[1], points: pts.map((p) => at(p, "beamwidth_v", 1000)) },
    ],
    xLabel: "frequency (Hz)",
    yLabel: "width (mm)",
    xLog: state.sweepLog,
    markers,
    xFormat: fFmt,
    yFormat: (v) => v.toFixed(0),
  });

  chartPsl.render({
    series: [
      { label: "PSL", color: CHART_PALETTE[2], points: pts.map((p) => at(p, "peak_sidelobe_db")) },
    ],
    xLabel: "frequency (Hz)",
    yLabel: "level (dB)",
    xLog: state.sweepLog,
    markers,
    xFormat: fFmt,
    yFormat: (v) => v.toFixed(1),
  });

  const f0 = pts[0].frequency;
  const f1 = pts[pts.length - 1].frequency;
  $("sweep-sub").textContent = ` · ${pts.length} points · ${fmtFreq(f0)} – ${fmtFreq(f1)}`;
}

function exportSweepCsv() {
  if (!lastSweep) {
    toast("Run a sweep first.");
    return;
  }
  const lines = [];
  lines.push("# PSF Array Viewer — frequency sweep");
  lines.push(`# steering=${state.steering} shading=${state.shading} diag_removal=${state.diagRemoval} noise_dB=${state.noiseEnabled ? state.noiseDb : "off"}`);
  lines.push(`# mics=${lastSweep.n_mics} aperture_m=${lastSweep.aperture} alias_Hz=${lastSweep.alias_frequency ?? ""}`);
  lines.push("frequency_Hz,beamwidth_u_m,beamwidth_v_m,peak_sidelobe_dB");
  for (const p of lastSweep.points) {
    lines.push([
      p.frequency,
      p.beamwidth_u ?? "",
      p.beamwidth_v ?? "",
      p.peak_sidelobe_db ?? "",
    ].join(","));
  }
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  downloadBlob(blob, `psf-sweep-${timestamp()}.csv`);
}

// Sweep parameters do not affect the live map, so they must not trigger compute.
function bindSweepNumber(id, setter) {
  const el = $(id);
  el.addEventListener("input", () => setter(parseFloat(el.value)));
}
bindSweepNumber("sweep-fmin", (v) => { if (v > 0) state.sweepFmin = v; });
bindSweepNumber("sweep-fmax", (v) => { if (v > 0) state.sweepFmax = v; });
bindSweepNumber("sweep-points", (v) => {
  if (v >= 2) state.sweepPoints = Math.min(MAX_SWEEP_POINTS, Math.round(v));
});
$("sweep-log").addEventListener("change", (e) => {
  state.sweepLog = e.target.checked;
  if (lastSweep) renderSweepCharts();
});
$("sweep-band").addEventListener("change", (e) => { state.sweepBand = e.target.checked; });
$("show-band").addEventListener("change", (e) => {
  state.showBand = e.target.checked;
  const r = lastResults[state.fplane];
  if (r) drawPlot(r);
});
$("sweep-run").addEventListener("click", runSweep);
$("sweep-open").addEventListener("click", openSweep);
$("sweep-close").addEventListener("click", closeSweep);
$("sweep-overlay").addEventListener("click", (e) => {
  if (e.target.id === "sweep-overlay") closeSweep();
});
$("sweep-csv").addEventListener("click", exportSweepCsv);

// ───────────────────────── 1-D line cut ─────────────────────────
// Optional (off by default, zero layout cost when off). Cuts run through the
// map's peak along u and v. Pinned cuts stay on the chart as dashed overlays so
// the user can compare frequencies, shadings or algorithms against each other.
let chartCut = null;
let pinnedCuts = []; // in-memory only — derived data, never persisted

function cutLabel() {
  const alg = state.algorithm === "functional" ? `func ν${state.nu}` : "conv";
  return `${fmtFreq(state.frequency)} · ${state.shading} · ${alg}`;
}

function currentCuts() {
  const res = lastResults[state.fplane];
  if (!res || !state.cut) return null;
  const pk = plot.peakUV();
  if (!pk) return null;
  const uMin = res.u[0], uMax = res.u[res.nx - 1];
  const vMin = res.v[0], vMax = res.v[res.ny - 1];
  // Clamp to the display's dynamic range: raw nulls run to −300 dB and would
  // otherwise collapse the chart's y scale.
  const clamp = (pts) => pts.map(([s, db]) => [s, isFinite(db) ? Math.max(-state.dyn, db) : NaN]);
  return {
    u: clamp(plot.sampleLine(uMin, pk.v, uMax, pk.v)),
    v: clamp(plot.sampleLine(pk.u, vMin, pk.u, vMax)),
  };
}

function renderCut() {
  if (!state.cut) return;
  if (!chartCut) chartCut = new LineChart($("chart-cut"));
  const cur = currentCuts();
  if (!cur) return;

  const series = [];
  pinnedCuts.forEach((pin, i) => {
    const c = CHART_PALETTE[(i + 2) % CHART_PALETTE.length];
    series.push({ label: `${pin.label} u`, color: c, points: pin.u, dashed: true });
    series.push({ label: `${pin.label} v`, color: c, points: pin.v, dashed: true });
  });
  series.push({ label: "u", color: CHART_PALETTE[0], points: cur.u });
  series.push({ label: "v", color: CHART_PALETTE[1], points: cur.v });

  chartCut.render({
    series,
    xLabel: "position through peak (m)",
    yLabel: "level (dB)",
    xLog: false,
    hLines: [{ y: -3, label: "−3 dB" }],
    xFormat: (v) => v.toFixed(2),
    yFormat: (v) => v.toFixed(0),
  });
}

function setCutEnabled(on) {
  state.cut = on;
  document.querySelector(".stage-psf").classList.toggle("with-cut", on);
  if (on) renderCut();
}

$("cut").addEventListener("change", (e) => setCutEnabled(e.target.checked));
$("cut-pin").addEventListener("click", () => {
  const cur = currentCuts();
  if (!cur) {
    toast("Nothing to pin yet.");
    return;
  }
  if (pinnedCuts.length >= 3) pinnedCuts.shift(); // keep the chart readable
  pinnedCuts.push({ label: cutLabel(), u: cur.u, v: cur.v });
  renderCut();
});
$("cut-clear").addEventListener("click", () => {
  pinnedCuts = [];
  renderCut();
});

// ───────────────────────── cursor readout ─────────────────────────
(function bindReadout() {
  const host = $("plot");
  const readout = $("psf-readout");
  host.addEventListener("mousemove", (e) => {
    const r = plot.valueAt(e.clientX, e.clientY);
    if (!r) {
      readout.hidden = true;
      return;
    }
    const [au, av] = planeAxesLabels(state.fplane);
    readout.hidden = false;
    readout.textContent = `${au} ${r.u.toFixed(3)}  ${av} ${r.v.toFixed(3)} m   ${r.db.toFixed(1)} dB`;
  });
  host.addEventListener("mouseleave", () => { readout.hidden = true; });
})();

// ───────────────────────── save / load configuration ─────────────────────────
function currentConfig() {
  return { app: "psf-array-viewer", version: 1, state: JSON.parse(JSON.stringify(state)) };
}

function saveConfig() {
  const blob = new Blob([JSON.stringify(currentConfig(), null, 2)], { type: "application/json" });
  downloadBlob(blob, `psf-config-${timestamp()}.json`);
}

// Push the whole `state` object back into every control (no per-control
// event dispatch — we recompute once at the end).
function setSeg(key, val) {
  const seg = document.querySelector(`.seg[data-seg="${key}"]`);
  if (!seg) return;
  seg.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.val === val));
}

function syncAllControls() {
  const sliderMap = {
    n: "n", diameter: "diameter", "ring-n": "ringN", "ring-diameter": "ringDiameter",
    "grid-pitch": "gridPitch", "cross-n": "crossN", "cross-length": "crossLength",
    dx: "dx", frequency: "frequency", dyn: "dyn", levels: "levels", noise: "noiseDb", nu: "nu",
  };
  for (const id in sliderMap) {
    const setter = sliderSetters[id];
    if (setter) setter(state[sliderMap[id]]);
  }
  $("grid-nx").value = state.gridNx;
  $("grid-ny").value = state.gridNy;
  $("acx").value = state.acenter[0];
  $("acy").value = state.acenter[1];
  $("acz").value = state.acenter[2];
  $("fcx").value = state.fcenter[0];
  $("fcy").value = state.fcenter[1];
  $("fcz").value = state.fcenter[2];
  $("width").value = state.width;
  $("height").value = state.height;
  $("c").value = state.c;
  syncSrcInputs();

  setSeg("source", state.source);
  setSeg("aplane", state.aplane);
  setSeg("fplane", state.fplane);
  setSeg("shading", state.shading);
  setSeg("steering", state.steering);
  setSeg("algorithm", state.algorithm);
  setSeg("colormap", state.colormap);
  $("lab-steering").textContent = `Formulation ${state.steering}`;
  updateAlgorithmUI();

  $("src-at-focus").checked = state.srcAtFocus;
  $("src-pos-fields").style.opacity = state.srcAtFocus ? "0.45" : "1";
  $("src-pos-fields").style.pointerEvents = state.srcAtFocus ? "none" : "";
  $("multiplane").checked = state.multiplane;
  $("plane-fade").checked = state.planeFade;
  $("mic-color-weight").checked = state.micColorByWeight;

  // The STL geometry itself is never persisted (only the units scale), so a
  // restored session always starts without a model loaded.
  state.stlName = null;
  state.stlPsf = false;
  $("stl-psf").checked = false;
  $("stl-scale").value = state.stlScale;
  $("stl-rx").value = state.stlRotX;
  $("stl-ry").value = state.stlRotY;
  $("stl-rz").value = state.stlRotZ;
  $("stl-tx").value = state.stlTx;
  $("stl-ty").value = state.stlTy;
  $("stl-tz").value = state.stlTz;
  $("stl-density").value = state.stlDensity;
  showStlControls(false);
  $("diag-removal").checked = state.diagRemoval;
  $("noise-enable").checked = state.noiseEnabled;
  $("noise-field").hidden = !state.noiseEnabled;
  $("lines").checked = state.lines;
  $("cut").checked = state.cut;
  setCutEnabled(state.cut);

  $("sweep-fmin").value = state.sweepFmin;
  $("sweep-fmax").value = state.sweepFmax;
  $("sweep-points").value = state.sweepPoints;
  $("sweep-log").checked = state.sweepLog;
  $("sweep-band").checked = state.sweepBand;
  // A restored session has no sweep result yet, so the band controls stay off.
  state.showBand = false;
  $("show-band").checked = false;
  $("show-band-row").hidden = true;
  if (state.csvName) $("csv-status").textContent = `Loaded ${state.csvName}`;
  if (state.manualPos && state.manualPos.length) {
    $("manual-status").textContent = `Hand-edited layout · ${state.manualPos.length} microphones.`;
  }

  updateSourceVisibility();
  renderExtraSources();
  geo.setMultiplane(state.multiplane);
  geo.setPlaneFade(state.planeFade);
  geo.setMicColorByWeight(state.micColorByWeight);
  geo.updateSource(state.srcPos);
  geo.updateExtraSources(state.extraSources);
}

function applyConfig(cfg, silent = false) {
  const s = cfg && cfg.state;
  if (!s || typeof s !== "object") {
    if (!silent) toast("Not a valid PSF Array Viewer config file.");
    return false;
  }
  Object.assign(state, s);
  // Ensure the 3-vectors are real arrays (in case of a partial file).
  state.acenter = Array.isArray(s.acenter) ? s.acenter.slice() : state.acenter;
  state.fcenter = Array.isArray(s.fcenter) ? s.fcenter.slice() : state.fcenter;
  state.srcPos = Array.isArray(s.srcPos) ? s.srcPos.slice() : state.srcPos;
  state.extraSources = Array.isArray(s.extraSources)
    ? s.extraSources.map((x) => ({ pos: (x.pos || [0, 0, 0]).slice(), amplitude: x.amplitude ?? 1 }))
    : [];
  state.manualPos = Array.isArray(s.manualPos) ? s.manualPos.map((p) => p.slice()) : null;
  state.manualWeights = Array.isArray(s.manualWeights) ? s.manualWeights.slice() : null;
  syncAllControls();
  compute();
  if (!silent) toast("Configuration loaded.");
  return true;
}

// ── session persistence: remember the last setup across reloads ──
const SESSION_KEY = "psf-viewer:session";
function saveSession() {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(currentConfig()));
  } catch {
    /* storage full or unavailable — non-fatal */
  }
}

$("config-save").addEventListener("click", saveConfig);
$("config-load").addEventListener("click", () => $("config-input").click());
$("config-input").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      applyConfig(JSON.parse(String(reader.result)));
    } catch {
      toast("Could not parse that config file.");
    }
  };
  reader.onerror = () => toast("Could not read that file.");
  reader.readAsText(file);
  e.target.value = ""; // allow re-loading the same file
});

// ───────────────────────── A/B comparison + PDF report ─────────────────────────
// A snapshot captures what is *already* on screen — the state, the metrics, the
// rendered map, and the line cuts — so switching designs needs no recompute.
const snapshots = { A: null, B: null };
let chartAb = null;

function takeSnapshot(slot) {
  const res = lastResults[state.fplane];
  if (!res) {
    toast("Nothing to capture yet.");
    return;
  }
  snapshots[slot] = {
    slot,
    time: new Date().toLocaleString(),
    state: JSON.parse(JSON.stringify(state)),
    metrics: res.metrics,
    // The plot canvas already carries axes and the colorbar, so it stands alone.
    png: plot.canvas.toDataURL("image/png"),
    cuts: currentCuts(),
  };
  updateSnapStatus();
}

function updateSnapStatus() {
  const tag = (s) => (snapshots[s] ? describeDesign(snapshots[s].state) : "empty");
  $("snap-status").textContent = `A: ${tag("A")}   ·   B: ${tag("B")}`;
  $("compare-open").disabled = !(snapshots.A && snapshots.B);
}

// A one-line human description of a design, used for slot labels and captions.
function describeDesign(s) {
  const arr =
    s.source === "sunflower" ? `sunflower ${s.n}·${s.diameter}m`
    : s.source === "ring" ? `ring ${s.ringN}·${s.ringDiameter}m`
    : s.source === "grid" ? `grid ${s.gridNx}×${s.gridNy}·${s.gridPitch}m`
    : s.source === "cross" ? `cross ${s.crossN}·${s.crossLength}m`
    : s.source === "manual" ? `manual ${(s.manualPos || []).length} mics`
    : `csv ${s.csvName || ""}`;
  const alg = s.algorithm === "functional" ? `functional ν${s.nu}` : "conventional";
  return `${arr} · ${fmtFreq(s.frequency)} · ${alg}`;
}

// Rows for the metrics table. `fmt` renders a value; `delta` renders B − A.
const METRIC_ROWS = [
  { key: "n_mics", label: "Microphones", fmt: (v) => (v == null ? "—" : `${v}`), diff: (a, b) => `${b - a > 0 ? "+" : ""}${b - a}` },
  { key: "aperture", label: "Aperture", fmt: (v) => (v == null ? "—" : fmtLen(v)), diff: (a, b) => fmtLen(b - a) },
  { key: "beamwidth_u", label: "−3 dB beam (u)", fmt: (v) => (v == null ? "—" : `${(v * 1000).toFixed(0)} mm`), diff: (a, b) => `${((b - a) * 1000).toFixed(0)} mm` },
  { key: "beamwidth_v", label: "−3 dB beam (v)", fmt: (v) => (v == null ? "—" : `${(v * 1000).toFixed(0)} mm`), diff: (a, b) => `${((b - a) * 1000).toFixed(0)} mm` },
  { key: "peak_sidelobe_db", label: "Peak side lobe", fmt: (v) => (v == null ? "—" : `${v.toFixed(1)} dB`), diff: (a, b) => `${(b - a).toFixed(1)} dB` },
  { key: "alias_frequency", label: "Alias frequency", fmt: (v) => (v == null ? "—" : fmtFreq(v)), diff: (a, b) => fmtFreq(b - a) },
];

function metricsTableHtml(a, b) {
  const head = b
    ? "<thead><tr><th>Metric</th><th>A</th><th>B</th><th>Δ (B−A)</th></tr></thead>"
    : "<thead><tr><th>Metric</th><th>Value</th></tr></thead>";
  const rows = METRIC_ROWS.map((r) => {
    const va = a.metrics[r.key];
    if (!b) return `<tr><td>${r.label}</td><td>${r.fmt(va)}</td></tr>`;
    const vb = b.metrics[r.key];
    const d = va != null && vb != null ? r.diff(va, vb) : "—";
    return `<tr><td>${r.label}</td><td>${r.fmt(va)}</td><td>${r.fmt(vb)}</td><td class="delta">${d}</td></tr>`;
  }).join("");
  return `${head}<tbody>${rows}</tbody>`;
}

function openCompare() {
  const { A, B } = snapshots;
  if (!A || !B) return;
  $("compare-overlay").hidden = false;

  $("ab-img-a").src = A.png;
  $("ab-img-b").src = B.png;
  $("ab-cap-a").textContent = `A — ${describeDesign(A.state)}`;
  $("ab-cap-b").textContent = `B — ${describeDesign(B.state)}`;
  $("ab-table").innerHTML = metricsTableHtml(A, B);

  // Overlay the two designs' cuts, if both snapshots captured them.
  const both = A.cuts && B.cuts;
  $("chart-ab").hidden = !both;
  $("ab-cut-title").hidden = !both;
  if (both) {
    if (!chartAb) chartAb = new LineChart($("chart-ab"));
    chartAb.render({
      series: [
        { label: "A u", color: CHART_PALETTE[0], points: A.cuts.u },
        { label: "A v", color: CHART_PALETTE[0], points: A.cuts.v, dashed: true },
        { label: "B u", color: CHART_PALETTE[2], points: B.cuts.u },
        { label: "B v", color: CHART_PALETTE[2], points: B.cuts.v, dashed: true },
      ],
      xLabel: "position through peak (m)",
      yLabel: "level (dB)",
      xLog: false,
      hLines: [{ y: -3, label: "−3 dB" }],
      xFormat: (v) => v.toFixed(2),
      yFormat: (v) => v.toFixed(0),
    });
  }
}
function closeCompare() {
  $("compare-overlay").hidden = true;
}

// ── printable report ──
// Built as a plain DOM subtree that only @media print reveals, then handed to the
// browser's print dialog — which every platform can render straight to PDF. No PDF
// library is bundled; this project keeps its payload small on purpose.
function configRowsHtml(s) {
  const rows = [
    ["Array", describeDesign(s)],
    ["Array plane / centre", `${s.aplane} · [${s.acenter.join(", ")}] m`],
    ["Focus plane / centre", `${s.fplane} · [${s.fcenter.join(", ")}] m`],
    ["Focus size / step", `${s.width} × ${s.height} m · dx ${s.dx} m`],
    ["Frequency", fmtFreq(s.frequency)],
    ["Speed of sound", `${s.c} m/s`],
    ["Shading", s.shading],
    ["Steering", `Formulation ${s.steering}`],
    ["Algorithm", s.algorithm === "functional" ? `Functional (ν = ${s.nu})` : "Conventional"],
    ["Diagonal removal", s.algorithm === "functional" ? "n/a" : s.diagRemoval ? "on" : "off"],
    ["Sensor noise", s.noiseEnabled ? `${s.noiseDb} dB` : "off"],
    ["Sources", `${1 + (s.extraSources || []).length}`],
    ["Dynamic range", `${s.dyn} dB`],
  ];
  return rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join("");
}

function designSectionHtml(snap, title) {
  return `
    <section>
      <h2>${title}</h2>
      <table><tbody>${configRowsHtml(snap.state)}</tbody></table>
    </section>`;
}

function buildReport() {
  const { A, B } = snapshots;
  // Compare A/B when both slots are filled; otherwise report the live design.
  let designs = [];
  if (A && B) designs = [A, B];
  else if (A || B) designs = [A || B];
  else {
    const res = lastResults[state.fplane];
    if (!res) {
      toast("Nothing to report yet.");
      return false;
    }
    designs = [{
      slot: "—",
      state: JSON.parse(JSON.stringify(state)),
      metrics: res.metrics,
      png: plot.canvas.toDataURL("image/png"),
      cuts: currentCuts(),
    }];
  }

  const maps = designs
    .map((d) => `<figure><figcaption>${d.slot !== "—" ? d.slot + " — " : ""}${describeDesign(d.state)}</figcaption><img src="${d.png}" /></figure>`)
    .join("");

  const two = designs.length === 2;
  const sweepHtml =
    lastSweep && chartBw && chartPsl
      ? `<section>
           <h2>Frequency sweep</h2>
           <div class="maps">
             <figure><figcaption>−3 dB main-lobe width</figcaption><img src="${chartBw.canvas.toDataURL("image/png")}" /></figure>
             <figure><figcaption>Peak side-lobe level</figcaption><img src="${chartPsl.canvas.toDataURL("image/png")}" /></figure>
           </div>
         </section>`
      : "";

  $("report").innerHTML = `
    <h1>PSF Array Viewer — report</h1>
    <div class="meta">Generated ${new Date().toLocaleString()}</div>

    <section>
      <h2>Point spread function</h2>
      <div class="maps${two ? "" : " single"}">${maps}</div>
    </section>

    <section>
      <h2>Metrics</h2>
      <table>${metricsTableHtml(designs[0], two ? designs[1] : null)}</table>
    </section>

    ${designs.map((d) => designSectionHtml(d, two ? `Configuration ${d.slot}` : "Configuration")).join("")}
    ${sweepHtml}
  `;
  return true;
}

function printReport() {
  if (!buildReport()) return;
  // Give the browser a tick to lay out the freshly-injected images.
  setTimeout(() => window.print(), 60);
}

$("snap-a").addEventListener("click", () => takeSnapshot("A"));
$("snap-b").addEventListener("click", () => takeSnapshot("B"));
$("compare-open").addEventListener("click", openCompare);
$("compare-close").addEventListener("click", closeCompare);
$("compare-overlay").addEventListener("click", (e) => {
  if (e.target.id === "compare-overlay") closeCompare();
});
$("ab-clear").addEventListener("click", () => {
  snapshots.A = null;
  snapshots.B = null;
  updateSnapStatus();
  closeCompare();
});
$("report-btn").addEventListener("click", printReport);
$("ab-report").addEventListener("click", () => {
  closeCompare();
  printReport();
});

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
  if (a.kind === "manual") {
    const pos = (a.pos || []).map((p) => p.slice());
    if (!pos.length) throw "Array needs at least one microphone.";
    if (a.weights && a.weights.length !== pos.length) {
      throw "Manual array: one weight per microphone is required.";
    }
    return { pos, weights: a.weights ? a.weights.slice() : null };
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
// Radial window taper at normalised aperture radius rho — mirrors
// Shading::taper in psf-core/src/lib.rs.
function shadingTaper(shading, rho) {
  const pi = Math.PI;
  switch (shading) {
    case "hann":     return 0.5 * (1 + Math.cos(pi * rho));
    case "hamming":  return 0.54 + 0.46 * Math.cos(pi * rho);
    case "blackman": return 0.42 + 0.5 * Math.cos(pi * rho) + 0.08 * Math.cos(2 * pi * rho);
    default:         return 1;
  }
}
function weightsForJS(arr, shading) {
  if (arr.weights) return arr.weights.slice();
  if (shading && shading !== "uniform") {
    const c = centroid(arr.pos);
    const rmax = Math.max(1e-12, ...arr.pos.map((p) => vdist(p, c)));
    return arr.pos.map((p) => shadingTaper(shading, Math.min(1, vdist(p, c) / rmax)));
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

// ── small complex linear algebra (functional beamforming only) ──
// Mirrors psf-core: used only on the S×S source Gram matrix, S = source count.
const cadd = (a, b) => [a[0] + b[0], a[1] + b[1]];
const cmul = (a, b) => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];
const cconj = (a) => [a[0], -a[1]];

// Jacobi eigendecomposition of a small complex Hermitian matrix (n×n, row-major).
// Returns { lambda, v } with eigenvector i in COLUMN i of v. Mirrors
// psf_core::hermitian_eig — see there for the rotation derivation.
function hermitianEig(aIn, n) {
  const a = aIn.map((c) => [c[0], c[1]]);
  const v = Array.from({ length: n * n }, () => [0, 0]);
  for (let i = 0; i < n; i++) v[i * n + i] = [1, 0];
  if (n <= 1) return { lambda: Array.from({ length: n }, (_, i) => a[i * n + i][0]), v };

  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0;
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++)
        if (i !== j) off += a[i * n + j][0] ** 2 + a[i * n + j][1] ** 2;
    if (Math.sqrt(off) <= 1e-13) break;

    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = a[p * n + q];
        const r = Math.hypot(apq[0], apq[1]);
        if (r <= 1e-18) continue;
        const app = a[p * n + p][0];
        const aqq = a[q * n + q][0];
        const phi = Math.atan2(apq[1], apq[0]);
        const theta = 0.5 * Math.atan2(2 * r, app - aqq);
        const c = Math.cos(theta), s = Math.sin(theta);
        const ePos = [Math.cos(phi), Math.sin(phi)];
        const eNeg = [Math.cos(phi), -Math.sin(phi)];
        const uPQ = cmul([-s, 0], ePos);
        const uQP = cmul([s, 0], eNeg);

        for (let i = 0; i < n; i++) {          // A ← A·U (columns p, q)
          const aip = a[i * n + p], aiq = a[i * n + q];
          a[i * n + p] = cadd(cmul(aip, [c, 0]), cmul(aiq, uQP));
          a[i * n + q] = cadd(cmul(aip, uPQ), cmul(aiq, [c, 0]));
        }
        const uhPQ = cconj(uQP), uhQP = cconj(uPQ);
        for (let j = 0; j < n; j++) {          // A ← Uᴴ·A (rows p, q)
          const apj = a[p * n + j], aqj = a[q * n + j];
          a[p * n + j] = cadd(cmul([c, 0], apj), cmul(uhPQ, aqj));
          a[q * n + j] = cadd(cmul(uhQP, apj), cmul([c, 0], aqj));
        }
        for (let i = 0; i < n; i++) {          // V ← V·U (columns p, q)
          const vip = v[i * n + p], viq = v[i * n + q];
          v[i * n + p] = cadd(cmul(vip, [c, 0]), cmul(viq, uQP));
          v[i * n + q] = cadd(cmul(vip, uPQ), cmul(viq, [c, 0]));
        }
      }
    }
  }
  return { lambda: Array.from({ length: n }, (_, i) => a[i * n + i][0]), v };
}

// Sarradj (2012) steering-vector formulations — mirrors psf-core/src/lib.rs.
// x_m(t) = (r0/rm) * exp(-jk(rm - r0)); reference r0 is the array centroid.
//   I   (classic):       h_m = x_m / |x_m|                (phase only)
//   II  (inverse):       h_m = 1 / conj(x_m)
//   III (true level):    h_m = x_m / Σ w_m|x_m|²
//   IV  (true location): h_m = x_m / sqrt(Σw_m * Σ w_m|x_m|²)
// Beamform an arbitrary point cloud → raw (un-normalised) linear power.
// This is the JS mirror of psf_core::compute_at_points (roadmap R1/R2): the grid
// map and the STL surface map both run through it, so the two engines and the two
// scan geometries can never drift apart.
function beamformPointsJS(arr, weights, points, sources, phys, frequency) {
  const k         = (2 * Math.PI * frequency) / phys.speed_of_sound;
  const reference = centroid(arr.pos);
  const formulation = phys.steering || "I";
  const noise        = Math.max(0, phys.noise_power || 0);   // σ² per sensor
  const algorithm    = phys.algorithm || { kind: "conventional" };
  const isFunctional = algorithm.kind === "functional";
  // Diagonal removal is conventional-only — functional reaches C through its
  // low-rank eigenpairs, where there is no materialised diagonal to strip.
  const diagRemoval  = !!phys.diag_removal && !isFunctional;
  const nsrc = sources.length;

  // Free-field complex pressure at each mic from each source (p[mi][s] = gₛ at
  // mic mi). Only this propagation vector is needed — no cross-spectral matrix
  // (or its diagonal) is ever formed.
  const p = [];
  for (let mi = 0; mi < arr.pos.length; mi++) {
    const row = [];
    for (let s = 0; s < nsrc; s++) {
      const d = Math.max(1e-9, vdist(arr.pos[mi], sources[s].pos));
      const ph = -k * d;
      const a = sources[s].amplitude;
      row.push([a * Math.cos(ph) / d, a * Math.sin(ph) / d]);
    }
    p.push(row);
  }

  const wsum = weights.reduce((a, b) => a + b, 0);
  const wsumSafe = Math.abs(wsum) < 1e-30 ? 1 : wsum;
  const needsNormPass = formulation === "III" || formulation === "IV";
  const sRe = new Float64Array(nsrc), sIm = new Float64Array(nsrc), sDiag = new Float64Array(nsrc);

  // Functional beamforming: C = G·Gᴴ + σ²I is low-rank in the sources, so its
  // eigenpairs come from the S×S Gram matrix M_st = gₛᴴ·g_t — never an N×N CSM.
  //   hᴴC^{1/ν}h = σ^{2/ν}·‖h‖² + Σ_i [(λ_i+σ²)^{1/ν} − σ^{2/ν}]·|z_i|²/λ_i
  // with z_i = Σ_s v_{s,i}·Sₛ, so it rides on the per-source projections Sₛ and
  // ‖h‖² the scan loop already accumulates.
  let ft = null;
  if (isFunctional) {
    const nu = isFinite(algorithm.nu) && algorithm.nu >= 1 ? algorithm.nu : 1;
    const gram = Array.from({ length: nsrc * nsrc }, () => [0, 0]);
    for (let s = 0; s < nsrc; s++) {
      for (let t = 0; t < nsrc; t++) {
        let acc = [0, 0];
        for (let mi = 0; mi < p.length; mi++) acc = cadd(acc, cmul(cconj(p[mi][s]), p[mi][t]));
        gram[s * nsrc + t] = acc;
      }
    }
    const { lambda, v } = hermitianEig(gram, nsrc);
    const base = Math.pow(noise, 1 / nu);          // σ^{2/ν}  (noise is σ²)
    const coef = lambda.map((l) =>
      l <= 1e-30 ? 0 : (Math.pow(l + noise, 1 / nu) - base) / l
    );
    ft = { nu, base, coef, v, n: nsrc };
  }

  const raw = new Float64Array(points.length);
  for (let idx = 0; idx < points.length; idx++) {
    const pt = points[idx];
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

    sRe.fill(0);
    sIm.fill(0);
    if (diagRemoval) sDiag.fill(0);
    let hNorm2 = 0;   // Σ_m |h_m|² — array response to white sensor noise
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
      const hMag2 = hRe * hRe + hIm * hIm;
      hNorm2 += hMag2;
      const prow = p[mi];
      for (let s2 = 0; s2 < nsrc; s2++) {
        const pRe = prow[s2][0], pIm = prow[s2][1];
        sRe[s2] += hRe * pRe + hIm * pIm;
        sIm[s2] += hRe * pIm - hIm * pRe;
        if (diagRemoval) sDiag[s2] += hMag2 * (pRe * pRe + pIm * pIm);
      }
    }

    let power;
    if (ft) {
      // Functional: P = (hᴴC^{1/ν}h)^ν, from the projections already in hand.
      let acc = ft.base * hNorm2;
      for (let i2 = 0; i2 < ft.n; i2++) {
        let z = [0, 0];
        for (let s2 = 0; s2 < ft.n; s2++) {
          z = cadd(z, cmul(ft.v[s2 * ft.n + i2], [sRe[s2], sIm[s2]]));
        }
        acc += ft.coef[i2] * (z[0] * z[0] + z[1] * z[1]);
      }
      power = Math.pow(Math.max(0, acc), ft.nu);
    } else {
      // Conventional: incoherent sum of per-source powers, each with its own
      // autopower (diagonal) term removed when requested — no CSM materialised.
      power = 0;
      for (let s2 = 0; s2 < nsrc; s2++) {
        let ps = sRe[s2] * sRe[s2] + sIm[s2] * sIm[s2];
        if (diagRemoval) ps -= sDiag[s2];
        power += ps;
      }
      // White sensor-noise floor σ²·Σ_m|h_m|² — added to the output, and
      // stripped again by diagonal removal (which is why DR rejects it).
      const noiseContrib = noise * hNorm2;
      power += noiseContrib;
      if (diagRemoval) power -= noiseContrib;
    }
    raw[idx] = Math.max(0, power);
  }

  return raw;
}

// Mirrors psf_core::normalize_to_db — peak-referenced dB, floored at −300.
function normalizeToDbJS(raw) {
  let p0 = 1e-30;
  for (let i = 0; i < raw.length; i++) if (raw[i] > p0) p0 = raw[i];
  const out = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    out[i] = Math.max(-300, 10 * Math.log10(raw[i] / p0 + 1e-30));
  }
  return out;
}

function jsCompute(req) {
  const phys    = req.physics || {};
  const arr     = buildArrayJS(req);
  const weights = weightsForJS(arr, phys.shading);
  const f       = req.focus;
  const g       = gridJS(f);
  const sources = (req.sources && req.sources.length)
    ? req.sources
    : [{ pos: f.center, amplitude: 1 }];

  // Grid scan points, row-major (v outer, u inner).
  const points = [];
  for (let j = 0; j < g.ny; j++) {
    for (let i = 0; i < g.nx; i++) {
      points.push(vadd(f.center, vadd(vscale(g.uh, g.u[i]), vscale(g.vh, g.v[j]))));
    }
  }

  const raw = beamformPointsJS(arr, weights, points, sources, phys, req.frequency);
  const values = normalizeToDbJS(raw);
  const metrics = metricsJS(arr, g, values, phys.speed_of_sound);
  // `raw` (un-normalised linear power) rides along so a sweep can band-average in
  // the power domain before normalising once.
  return { mics: arr.pos, weights, nx: g.nx, ny: g.ny, u: g.u, v: g.v, corners: g.corners, values, raw, metrics };
}

// Mirrors the compute_on_points Tauri command — beamform an explicit point cloud
// (the surface samples of a loaded STL model).
function jsComputeOnPoints(req) {
  const phys    = req.physics || {};
  const arr     = buildArrayJS(req);
  const weights = weightsForJS(arr, phys.shading);
  const raw = beamformPointsJS(arr, weights, req.points, req.sources, phys, req.frequency);
  return { values: normalizeToDbJS(raw) };
}

// Mirrors psf_core::sweep_frequencies.
function sweepFrequenciesJS(fMin, fMax, n, log) {
  if (!(n >= 1)) throw "Sweep needs at least one frequency point.";
  if (n > MAX_SWEEP_POINTS) throw `Sweep is limited to ${MAX_SWEEP_POINTS} frequency points.`;
  if (!isFinite(fMin) || !isFinite(fMax) || fMin <= 0 || fMax <= 0) throw "Sweep frequencies must be positive.";
  if (fMax < fMin) throw "Sweep f max must be at least f min.";
  if (n === 1) return [fMin];
  const nn = n - 1;
  return Array.from({ length: n }, (_, i) => {
    const t = i / nn;
    return log ? fMin * Math.pow(fMax / fMin, t) : fMin + t * (fMax - fMin);
  });
}

// Mirrors psf_core::compute_sweep — per-frequency metrics plus an optional
// incoherent (power-domain) band average, normalised once at the end.
// `onStep(step, total)`, if given, is called after each frequency, yielding to
// the event loop every few steps so the caller's progress bar can repaint.
async function jsComputeSweep(req, onStep) {
  const freqs = sweepFrequenciesJS(req.f_min, req.f_max, req.n_points, req.log_spacing);
  const points = [];
  let band = null;
  let first = null;

  for (let i = 0; i < freqs.length; i++) {
    const f = freqs[i];
    const r = jsCompute({ ...req, frequency: f });
    if (!first) first = r;
    if (req.band_map) {
      if (!band) band = new Float64Array(r.raw.length);
      for (let i = 0; i < band.length; i++) band[i] += r.raw[i];
    }
    points.push({
      frequency: f,
      beamwidth_u: r.metrics.beamwidth_u,
      beamwidth_v: r.metrics.beamwidth_v,
      peak_sidelobe_db: r.metrics.peak_sidelobe_db,
    });
    if (onStep) onStep(i + 1, freqs.length);
    if (i % 4 === 3) await new Promise((r) => setTimeout(r));
  }

  let band_values = null;
  if (req.band_map && band) {
    let p0 = 1e-30;
    for (let i = 0; i < band.length; i++) if (band[i] > p0) p0 = band[i];
    band_values = new Float32Array(band.length);
    for (let i = 0; i < band.length; i++) {
      band_values[i] = Math.max(-300, 10 * Math.log10(band[i] / p0 + 1e-30));
    }
  }

  return {
    points,
    band_values,
    nx: first.nx, ny: first.ny, u: first.u, v: first.v,
    alias_frequency: first.metrics.alias_frequency,
    aperture: first.metrics.aperture,
    n_mics: first.metrics.n_mics,
  };
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
// Restore the previous session if one was saved, else compute defaults.
(function boot() {
  let raw = null;
  try {
    raw = localStorage.getItem(SESSION_KEY);
  } catch {
    raw = null;
  }
  if (raw) {
    try {
      if (applyConfig(JSON.parse(raw), true)) return;
    } catch {
      /* corrupt session — fall through to defaults */
    }
  }
  compute();
})();
