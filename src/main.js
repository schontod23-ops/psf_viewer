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
  dyn: 30,
  levels: 10,
  lines: true,
};

// ───────────────────────── views ─────────────────────────
const plot = new PSFPlot(document.getElementById("plot"));
const geo = new Geometry3D(document.getElementById("three"));
plot.onTexture = (cv) => geo.setTexture(cv);

const $ = (id) => document.getElementById(id);

// ───────────────────────── control wiring ─────────────────────────
function bindSlider(id, key, fmt) {
  const el = $(id);
  const lab = $("lab-" + id.replace("frequency", "f").replace("diameter", "d"));
  const sync = () => {
    state[key] = parseFloat(el.value);
    if (lab) lab.textContent = fmt(state[key]);
  };
  el.addEventListener("input", () => {
    sync();
    schedule();
  });
  sync();
}
bindSlider("n", "n", (v) => `${v | 0}`);
bindSlider("diameter", "diameter", (v) => `${v.toFixed(2)} m`);
bindSlider("dx", "dx", (v) => `${v.toFixed(3)} m`);
bindSlider("frequency", "frequency", (v) => `${v | 0} Hz`);
bindSlider("dyn", "dyn", (v) => `${v | 0} dB`);
bindSlider("levels", "levels", (v) => `${v | 0}`);

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
bindNumber("fcx", (v) => (state.fcenter[0] = v || 0));
bindNumber("fcy", (v) => (state.fcenter[1] = v || 0));
bindNumber("fcz", (v) => (state.fcenter[2] = v || 0));
bindNumber("width", (v) => (state.width = v > 0 ? v : state.width));
bindNumber("height", (v) => (state.height = v > 0 ? v : state.height));
bindNumber("c", (v) => (state.c = v > 0 ? v : state.c));

$("lines").addEventListener("change", (e) => {
  state.lines = e.target.checked;
  // display-only: re-render last plot without recompute
  if (lastResult) drawPlot(lastResult);
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
      if (key === "dyn" || key === "levels") {
        /* n/a */
      }
      schedule();
    });
  });
});

function updateSourceVisibility() {
  document.querySelectorAll("[data-when]").forEach((el) => {
    const [k, v] = el.dataset.when.split("=");
    el.hidden = state[k] !== v;
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
let lastResult = null;
function schedule() {
  clearTimeout(timer);
  timer = setTimeout(compute, 140);
}

function buildRequest() {
  const array =
    state.source === "sunflower"
      ? {
          kind: "sunflower",
          n: state.n,
          diameter: state.diameter,
          center: state.acenter.slice(),
          plane: state.aplane,
        }
      : { kind: "csv", text: state.csvText || "" };
  const focus = {
    center: state.fcenter.slice(),
    plane: state.fplane,
    width: state.width,
    height: state.height,
    dx: state.dx,
  };
  return {
    array,
    focus,
    frequency: state.frequency,
    speed_of_sound: state.c,
    shading: state.shading,
  };
}

async function compute() {
  if (state.source === "csv" && !state.csvText) {
    toast("Load a CSV of microphone positions first.");
    return;
  }
  let res;
  try {
    const inv = await getInvoke();
    res = inv
      ? await inv("compute", { req: buildRequest() })
      : jsCompute(buildRequest());
  } catch (e) {
    toast(typeof e === "string" ? e : e.message || "Compute failed.");
    return;
  }
  lastResult = res;
  drawPlot(res);
  geo.update(res.mics, res.weights, res.corners);
  updateReadouts(res);
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
  $("m-psl").textContent =
    m.peak_sidelobe_db != null ? `${m.peak_sidelobe_db.toFixed(1)} dB` : "—";
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
// Faithful, compact port of psf-core so the app also runs as a web preview.
const GOLDEN = 2.399963229728653;
function planeBasis(p) {
  if (p === "xz") return [[1, 0, 0], [0, 0, 1]];
  if (p === "yz") return [[0, 1, 0], [0, 0, 1]];
  return [[1, 0, 0], [0, 1, 0]];
}
const vadd = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const vscale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const vdist = (a, b) =>
  Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

function buildArrayJS(req) {
  const a = req.array;
  if (a.kind === "sunflower") {
    const [uh, vh] = planeBasis(a.plane);
    const r0 = a.diameter / 2;
    const pos = [];
    for (let k = 0; k < a.n; k++) {
      const r = r0 * Math.sqrt((k + 0.5) / a.n);
      const th = k * GOLDEN;
      pos.push(
        vadd(a.center, vadd(vscale(uh, r * Math.cos(th)), vscale(vh, r * Math.sin(th))))
      );
    }
    return { pos, weights: null };
  }
  // CSV
  const pos = [];
  const w = [];
  let anyW = false;
  for (const raw of a.text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const f = line.split(/[,;\t ]+/).filter(Boolean).map(Number);
    if (f.length < 3 || f.slice(0, 3).some((x) => !isFinite(x))) continue;
    pos.push([f[0], f[1], f[2]]);
    if (f.length >= 4 && isFinite(f[3])) {
      w.push(f[3]);
      anyW = true;
    } else w.push(1);
  }
  if (!pos.length) throw "No microphone rows found (need 3 numeric columns).";
  return { pos, weights: anyW ? w : null };
}

function centroid(pos) {
  const s = pos.reduce((a, p) => vadd(a, p), [0, 0, 0]);
  return vscale(s, 1 / Math.max(1, pos.length));
}
function weightsForJS(arr, shading) {
  if (arr.weights) return arr.weights.slice();
  if (shading === "hann") {
    const c = centroid(arr.pos);
    const rmax = Math.max(1e-12, ...arr.pos.map((p) => vdist(p, c)));
    return arr.pos.map((p) => {
      const rho = Math.min(1, vdist(p, c) / rmax);
      return 0.5 * (1 + Math.cos(Math.PI * rho));
    });
  }
  return arr.pos.map(() => 1);
}

function gridJS(focus) {
  const nx = Math.max(1, Math.round(focus.width / focus.dx)) + 1;
  const ny = Math.max(1, Math.round(focus.height / focus.dx)) + 1;
  const u = Array.from({ length: nx }, (_, i) => -focus.width / 2 + i * focus.dx);
  const v = Array.from({ length: ny }, (_, j) => -focus.height / 2 + j * focus.dx);
  const [uh, vh] = planeBasis(focus.plane);
  const P = (uu, vv) => vadd(focus.center, vadd(vscale(uh, uu), vscale(vh, vv)));
  const corners = [
    P(u[0], v[0]),
    P(u[nx - 1], v[0]),
    P(u[nx - 1], v[ny - 1]),
    P(u[0], v[ny - 1]),
  ];
  return { nx, ny, u, v, corners, uh, vh };
}

function jsCompute(req) {
  const arr = buildArrayJS(req);
  const weights = weightsForJS(arr, req.shading);
  const f = req.focus;
  const g = gridJS(f);
  const k = (2 * Math.PI * req.frequency) / req.speed_of_sound;
  const d0 = arr.pos.map((m) => vdist(m, f.center));
  const wsum = weights.reduce((a, b) => a + b, 0) || 1;
  const values = new Float32Array(g.nx * g.ny);
  for (let j = 0; j < g.ny; j++) {
    for (let i = 0; i < g.nx; i++) {
      const pt = vadd(f.center, vadd(vscale(g.uh, g.u[i]), vscale(g.vh, g.v[j])));
      let re = 0,
        im = 0;
      for (let mi = 0; mi < arr.pos.length; mi++) {
        const ph = k * (vdist(arr.pos[mi], pt) - d0[mi]);
        re += weights[mi] * Math.cos(ph);
        im += weights[mi] * Math.sin(ph);
      }
      const p = ((re * re + im * im) / (wsum * wsum)) + 1e-30;
      values[j * g.nx + i] = Math.max(-300, 10 * Math.log10(p));
    }
  }
  const metrics = metricsJS(arr, g, values, req.speed_of_sound);
  return {
    mics: arr.pos,
    weights,
    nx: g.nx,
    ny: g.ny,
    u: g.u,
    v: g.v,
    corners: g.corners,
    values,
    metrics,
  };
}

function halfWidth(coords, line, center, fwd) {
  let idx = center;
  for (;;) {
    const next = fwd ? idx + 1 : idx - 1;
    if (next < 0 || next >= coords.length) return null;
    if (line[next] <= -3) {
      const a = line[idx],
        b = line[next];
      const frac = Math.abs(a - b) < 1e-9 ? 0 : (a + 3) / (a - b);
      return Math.abs(coords[idx] + frac * (coords[next] - coords[idx]) - coords[center]);
    }
    idx = next;
  }
}
function firstNull(line, center, fwd, len) {
  let idx = center;
  for (;;) {
    const next = fwd ? idx + 1 : idx - 1;
    if (next < 0 || next >= len) return len;
    if (line[next] > line[idx] && idx !== center) return Math.abs(idx - center);
    idx = next;
  }
}
function metricsJS(arr, g, values, c) {
  const { nx, ny, u, v } = g;
  const cx = nx >> 1,
    cy = ny >> 1;
  const row = Array.from({ length: nx }, (_, i) => values[cy * nx + i]);
  const col = Array.from({ length: ny }, (_, j) => values[j * nx + cx]);
  const bwU =
    halfWidth(u, row, cx, true) != null && halfWidth(u, row, cx, false) != null
      ? halfWidth(u, row, cx, true) + halfWidth(u, row, cx, false)
      : null;
  const bwV =
    halfWidth(v, col, cy, true) != null && halfWidth(v, col, cy, false) != null
      ? halfWidth(v, col, cy, true) + halfWidth(v, col, cy, false)
      : null;
  const nr = Math.max(
    firstNull(row, cx, true, nx),
    firstNull(row, cx, false, nx),
    firstNull(col, cy, true, ny),
    firstNull(col, cy, false, ny)
  );
  let psl = null;
  if (nr < Math.max(nx, ny)) {
    let best = -300;
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const du = (i - cx) / Math.max(1, nr),
          dv = (j - cy) / Math.max(1, nr);
        if (du * du + dv * dv > 1) best = Math.max(best, values[j * nx + i]);
      }
    if (best > -300) psl = best;
  }
  let dmin = Infinity,
    aperture = 0;
  for (let a = 0; a < arr.pos.length; a++)
    for (let b = a + 1; b < arr.pos.length; b++) {
      const d = vdist(arr.pos[a], arr.pos[b]);
      if (d < dmin) dmin = d;
      if (d > aperture) aperture = d;
    }
  return {
    beamwidth_u: bwU,
    beamwidth_v: bwV,
    peak_sidelobe_db: psl,
    alias_frequency: isFinite(dmin) && dmin > 0 ? c / (2 * dmin) : null,
    aperture,
    n_mics: arr.pos.length,
  };
}

// ───────────────────────── ambient interference field ─────────────────────────
(function ambientField() {
  const cv = document.getElementById("field");
  const ctx = cv.getContext("2d");
  const RES = 150;
  cv.width = RES;
  cv.height = RES;
  cv.style.width = "100vw";
  cv.style.height = "100vh";
  const img = ctx.createImageData(RES, RES);
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const sources = [
    [0.3, 0.35],
    [0.72, 0.28],
    [0.5, 0.78],
  ];
  function frame(t) {
    const ph = t * 0.00015;
    let o = 0;
    for (let y = 0; y < RES; y++) {
      for (let x = 0; x < RES; x++) {
        const fx = x / RES,
          fy = y / RES;
        let s = 0;
        for (let k = 0; k < sources.length; k++) {
          const dx = fx - sources[k][0],
            dy = fy - sources[k][1];
          const r = Math.sqrt(dx * dx + dy * dy);
          s += Math.sin(r * 70 - ph * (1 + k * 0.3));
        }
        const val = (s / sources.length) * 0.5 + 0.5;
        // turbo-ish cool tint, kept dark; CSS opacity flattens it
        img.data[o++] = 30 + val * 40;
        img.data[o++] = 90 + val * 80;
        img.data[o++] = 150 + val * 90;
        img.data[o++] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    if (!reduce) requestAnimationFrame(frame);
  }
  if (reduce) frame(0);
  else requestAnimationFrame(frame);
})();

// ───────────────────────── go ─────────────────────────
compute();
