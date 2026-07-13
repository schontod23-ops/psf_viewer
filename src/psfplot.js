// psfplot.js — filled-contour (contourf) PSF renderer.
// Computes marching-squares contours with d3-contour, fills turbo bands, draws
// axes + colorbar, and cross-dissolves between updates. Also produces a clean
// square texture (map only) for the 3-D focus plane.

import { contours as d3contours } from "d3-contour";
import {
  interpolateTurbo,
  interpolateViridis,
  interpolateMagma,
  interpolateInferno,
  interpolateCividis,
  interpolateGreys,
} from "d3-scale-chromatic";

// Available PSF colormaps, keyed by the value used in the UI/state.
const COLORMAPS = {
  turbo: interpolateTurbo,
  viridis: interpolateViridis,
  magma: interpolateMagma,
  inferno: interpolateInferno,
  cividis: interpolateCividis,
  greys: interpolateGreys,
};
function interpFor(name) {
  return COLORMAPS[name] || interpolateTurbo;
}

const MONO = '11px "SF Mono","JetBrains Mono","Roboto Mono",ui-monospace,monospace';
const INK = "#e7eef7";
const DIM = "#8d9cb2";
const FAINT = "#5d6b82";
const STROKE = "rgba(125,145,175,0.18)";

function niceTicks(min, max, n) {
  const span = max - min || 1;
  const step0 = span / n;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const norm = step0 / mag;
  const step = (norm >= 5 ? 5 : norm >= 2 ? 2 : 1) * mag;
  const out = [];
  for (let t = Math.ceil(min / step) * step; t <= max + 1e-9; t += step)
    out.push(Math.abs(t) < 1e-9 ? 0 : t);
  return out;
}

export class PSFPlot {
  constructor(host) {
    this.host = host;
    this.canvas = document.createElement("canvas");
    this.canvas.style.width = "100%";
    this.canvas.style.height = "100%";
    host.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d");
    this.textureCanvas = document.createElement("canvas"); // map only, for 3D
    this.prev = null; // last rendered display bitmap (offscreen canvas)
    this.last = null; // last render args, for resize
    this.onTexture = null;
    this._raf = 0;
    new ResizeObserver(() => this.resize()).observe(host);
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const r = this.host.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    this.canvas.width = Math.round(r.width * dpr);
    this.canvas.height = Math.round(r.height * dpr);
    this.dpr = dpr;
    if (this.last) this.render(this.last, false);
  }

  // Map a viewport pointer position to {u, v, db} at the nearest grid cell,
  // or null if the pointer is outside the map rectangle.
  valueAt(clientX, clientY) {
    if (!this.mapGeom || !this.last) return null;
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return null;
    const px = (clientX - rect.left) * (this.canvas.width / rect.width);
    const py = (clientY - rect.top) * (this.canvas.height / rect.height);
    const { ox, oy, mapW, mapH } = this.mapGeom;
    if (px < ox || px > ox + mapW || py < oy || py > oy + mapH) return null;
    const { nx, ny, u, v, values } = this.last;
    const fx = (px - ox) / mapW; // 0..1 along u
    const fy = 1 - (py - oy) / mapH; // 0..1 along v (flip: +v up)
    const i = Math.max(0, Math.min(nx - 1, Math.round(fx * (nx - 1))));
    const j = Math.max(0, Math.min(ny - 1, Math.round(fy * (ny - 1))));
    return { u: u[i], v: v[j], db: values[j * nx + i] };
  }

  // args: {values, nx, ny, u, v, dynamicDb, levels, showLines, planeLabel}
  render(args, animate = true) {
    this.last = args;
    const dpr = this.dpr || Math.min(window.devicePixelRatio || 1, 2);
    const W = this.canvas.width;
    const H = this.canvas.height;
    if (!W || !H) {
      this.resize();
      return;
    }

    const { values, nx, ny, u, v, dynamicDb, levels, showLines } = args;
    const interp = interpFor(args.colormap);

    // plot geometry (device px)
    const m = { l: 52 * dpr, r: 74 * dpr, t: 30 * dpr, b: 40 * dpr };
    const pw = W - m.l - m.r;
    const ph = H - m.t - m.b;
    // keep data aspect ratio inside the available rect
    const dataAspect = args.width && args.height ? args.width / args.height : nx / ny;
    let mapW = pw,
      mapH = ph;
    if (pw / ph > dataAspect) mapW = ph * dataAspect;
    else mapH = pw / dataAspect;
    const ox = m.l + (pw - mapW) / 2;
    const oy = m.t + (ph - mapH) / 2;
    // Remember the map rectangle (device px) so pointer hits can be mapped
    // back to data coordinates in valueAt().
    this.mapGeom = { ox, oy, mapW, mapH };

    // clamp values into [-dyn, 0]
    const clamped = new Float64Array(values.length);
    for (let i = 0; i < values.length; i++)
      clamped[i] = Math.max(-dynamicDb, Math.min(0, values[i]));

    // thresholds (band boundaries)
    const thr = [];
    for (let i = 0; i <= levels; i++) thr.push(-dynamicDb + (dynamicDb * i) / levels);
    const geoms = d3contours().size([nx, ny]).thresholds(thr)(clamped);

    // ── render map into textureCanvas (no axes), used for both display & 3D ──
    const texW = Math.max(2, Math.round(mapW));
    const texH = Math.max(2, Math.round(mapH));
    this.textureCanvas.width = texW;
    this.textureCanvas.height = texH;
    const tctx = this.textureCanvas.getContext("2d");
    const tx = (gx) => (gx / (nx - 1)) * texW;
    const ty = (gy) => texH - (gy / (ny - 1)) * texH; // flip: +v up

    tctx.clearRect(0, 0, texW, texH);
    // base fill = lowest band colour
    tctx.fillStyle = interp(0);
    tctx.fillRect(0, 0, texW, texH);
    for (const g of geoms) {
      const s = (g.value + dynamicDb) / dynamicDb; // 0..1
      tctx.fillStyle = interp(Math.max(0, Math.min(1, s)));
      tctx.beginPath();
      for (const poly of g.coordinates)
        for (const ring of poly) {
          ring.forEach(([x, y], i) =>
            i ? tctx.lineTo(tx(x), ty(y)) : tctx.moveTo(tx(x), ty(y))
          );
          tctx.closePath();
        }
      tctx.fill("evenodd");
    }
    if (showLines) {
      tctx.lineWidth = 1;
      tctx.strokeStyle = "rgba(0,0,0,0.28)";
      for (const g of geoms) {
        tctx.beginPath();
        for (const poly of g.coordinates)
          for (const ring of poly) {
            ring.forEach(([x, y], i) =>
              i ? tctx.lineTo(tx(x), ty(y)) : tctx.moveTo(tx(x), ty(y))
            );
            tctx.closePath();
          }
        tctx.stroke();
      }
    }
    if (this.onTexture) this.onTexture(this.textureCanvas, args.planeLabel);

    // ── compose full display into an offscreen canvas ──
    const off = document.createElement("canvas");
    off.width = W;
    off.height = H;
    const c = off.getContext("2d");

    // map
    c.imageSmoothingEnabled = true;
    c.drawImage(this.textureCanvas, ox, oy, mapW, mapH);
    c.strokeStyle = STROKE;
    c.lineWidth = 1;
    c.strokeRect(ox + 0.5, oy + 0.5, mapW, mapH);

    // source markers — a small crosshair at each source's in-plane (u,v).
    // Falls back to the grid centre if no sources were supplied.
    const u0m = u[0], u1m = u[u.length - 1];
    const v0m = v[0], v1m = v[v.length - 1];
    const srcs = (args.sources && args.sources.length)
      ? args.sources
      : [{ u: (u0m + u1m) / 2, v: (v0m + v1m) / 2 }];
    for (const sm of srcs) {
      // Skip sources whose in-plane projection lands outside the map.
      if (sm.u < Math.min(u0m, u1m) || sm.u > Math.max(u0m, u1m)) continue;
      if (sm.v < Math.min(v0m, v1m) || sm.v > Math.max(v0m, v1m)) continue;
      const px = ox + ((sm.u - u0m) / (u1m - u0m)) * mapW;
      const py = oy + mapH - ((sm.v - v0m) / (v1m - v0m)) * mapH;
      const r = 6 * dpr;
      c.strokeStyle = "rgba(255,255,255,0.7)";
      c.lineWidth = 1.2 * dpr;
      c.beginPath();
      c.arc(px, py, r, 0, Math.PI * 2);
      c.moveTo(px - r * 1.7, py);
      c.lineTo(px - r * 0.6, py);
      c.moveTo(px + r * 0.6, py);
      c.lineTo(px + r * 1.7, py);
      c.moveTo(px, py - r * 1.7);
      c.lineTo(px, py - r * 0.6);
      c.moveTo(px, py + r * 0.6);
      c.lineTo(px, py + r * 1.7);
      c.stroke();
    }
    c.lineWidth = 1;

    // axes
    c.fillStyle = DIM;
    c.font = `${10 * dpr}px ${MONO.split("px ")[1]}`;
    c.textAlign = "center";
    c.textBaseline = "top";
    const u0 = u[0],
      u1 = u[u.length - 1];
    for (const t of niceTicks(u0, u1, 5)) {
      const px = ox + ((t - u0) / (u1 - u0)) * mapW;
      c.strokeStyle = STROKE;
      c.beginPath();
      c.moveTo(px, oy + mapH);
      c.lineTo(px, oy + mapH + 4 * dpr);
      c.stroke();
      c.fillText(t.toFixed(2), px, oy + mapH + 7 * dpr);
    }
    c.textAlign = "right";
    c.textBaseline = "middle";
    const v0 = v[0],
      v1 = v[v.length - 1];
    for (const t of niceTicks(v0, v1, 5)) {
      const py = oy + mapH - ((t - v0) / (v1 - v0)) * mapH;
      c.strokeStyle = STROKE;
      c.beginPath();
      c.moveTo(ox - 4 * dpr, py);
      c.lineTo(ox, py);
      c.stroke();
      c.fillText(t.toFixed(2), ox - 8 * dpr, py);
    }

    // axis titles
    const [au, av] = planeAxes(args.planeLabel);
    c.fillStyle = FAINT;
    c.textAlign = "center";
    c.textBaseline = "bottom";
    c.font = `${10 * dpr}px ${MONO.split("px ")[1]}`;
    c.fillText(`${au}  (m)`, ox + mapW / 2, H - 4 * dpr);
    c.save();
    c.translate(12 * dpr, oy + mapH / 2);
    c.rotate(-Math.PI / 2);
    c.fillText(`${av}  (m)`, 0, 0);
    c.restore();

    // ── colorbar ──
    const cbx = ox + mapW + 22 * dpr;
    const cbw = 12 * dpr;
    const cbh = mapH;
    const cby = oy;
    const grad = c.createLinearGradient(0, cby, 0, cby + cbh);
    for (let i = 0; i <= 32; i++) {
      const s = i / 32;
      grad.addColorStop(1 - s, interp(s)); // top = 0 dB
    }
    c.fillStyle = grad;
    c.fillRect(cbx, cby, cbw, cbh);
    c.strokeStyle = STROKE;
    c.strokeRect(cbx + 0.5, cby + 0.5, cbw, cbh);
    c.fillStyle = DIM;
    c.textAlign = "left";
    c.textBaseline = "middle";
    for (const t of niceTicks(-dynamicDb, 0, 5)) {
      const py = cby + (-t / dynamicDb) * cbh;
      c.beginPath();
      c.strokeStyle = STROKE;
      c.moveTo(cbx + cbw, py);
      c.lineTo(cbx + cbw + 4 * dpr, py);
      c.stroke();
      c.fillText(`${t.toFixed(0)}`, cbx + cbw + 7 * dpr, py);
    }
    c.fillStyle = FAINT;
    c.textAlign = "left";
    c.textBaseline = "bottom";
    c.fillText("dB", cbx, cby - 6 * dpr);

    // ── present (cross-dissolve) ──
    cancelAnimationFrame(this._raf);
    const ctx = this.ctx;
    if (!animate || !this.prev) {
      ctx.clearRect(0, 0, W, H);
      ctx.drawImage(off, 0, 0);
    } else {
      const prev = this.prev;
      const start = performance.now();
      const dur = 280;
      const tick = (now) => {
        const k = Math.min(1, (now - start) / dur);
        const e = 1 - Math.pow(1 - k, 3);
        ctx.clearRect(0, 0, W, H);
        ctx.globalAlpha = 1;
        ctx.drawImage(prev, 0, 0);
        ctx.globalAlpha = e;
        ctx.drawImage(off, 0, 0);
        ctx.globalAlpha = 1;
        if (k < 1) this._raf = requestAnimationFrame(tick);
      };
      this._raf = requestAnimationFrame(tick);
    }
    this.prev = off;
  }

  // Render a PSF result into an existing canvas/context (no axes, used for off-plane textures).
  renderTexture(res, canvas, ctx) {
    const { values, nx, ny, dynamicDb = 30, levels = 10 } = res;
    const interp = interpFor(res.colormap);
    const W = canvas.width, H = canvas.height;
    const clamped = new Float64Array(values.length);
    for (let i = 0; i < values.length; i++)
      clamped[i] = Math.max(-dynamicDb, Math.min(0, values[i]));
    const thr = [];
    for (let i = 0; i <= levels; i++) thr.push(-dynamicDb + (dynamicDb * i) / levels);
    const geoms = d3contours().size([nx, ny]).thresholds(thr)(clamped);
    const tx = (gx) => (gx / (nx - 1)) * W;
    const ty = (gy) => H - (gy / (ny - 1)) * H;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = interp(0);
    ctx.fillRect(0, 0, W, H);
    for (const g of geoms) {
      const s = (g.value + dynamicDb) / dynamicDb;
      ctx.fillStyle = interp(Math.max(0, Math.min(1, s)));
      ctx.beginPath();
      for (const poly of g.coordinates)
        for (const ring of poly) {
          ring.forEach(([x, y], i) => i ? ctx.lineTo(tx(x), ty(y)) : ctx.moveTo(tx(x), ty(y)));
          ctx.closePath();
        }
      ctx.fill("evenodd");
    }
  }
}

function planeAxes(label) {
  switch (label) {
    case "xz":
      return ["x", "z"];
    case "yz":
      return ["y", "z"];
    default:
      return ["x", "y"];
  }
}
