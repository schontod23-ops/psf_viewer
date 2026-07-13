// linechart.js — small dependency-free canvas line chart on the instrument theme.
// Shared component (roadmap R3): the frequency-sweep panel uses it now; the 1-D
// line-cut and the A/B overlay will reuse it. No charting library — Plotly and
// friends are deliberately avoided to keep the bundle small.
//
//   chart.render({
//     series:  [{ label, color?, points: [[x, y], …], dashed? }],
//     xLabel, yLabel,
//     xLog:    true,                       // log-spaced x axis (frequency)
//     yInvert: false,                      // draw y downward (levels in dB)
//     markers: [{ x, label, color? }],     // vertical reference lines
//     xFormat, yFormat,                    // value → string for ticks/readout
//   });

export const CHART_PALETTE = ["#58d4ff", "#6ee7a8", "#ffb454", "#d98cff", "#ff7a8a"];

const CSS = {
  ink: "#e7eef7",
  inkDim: "#8d9cb2",
  inkFaint: "#5d6b82",
  grid: "rgba(125, 145, 175, 0.12)",
  axis: "rgba(125, 145, 175, 0.30)",
  warn: "#ffb454",
};

const M = { top: 16, right: 16, bottom: 36, left: 58 };

export class LineChart {
  constructor(host) {
    this.host = host;
    this.canvas = document.createElement("canvas");
    Object.assign(this.canvas.style, { width: "100%", height: "100%", display: "block" });
    host.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d");
    this.cfg = null;
    this.hover = null;

    this.canvas.addEventListener("mousemove", (e) => {
      const r = this.canvas.getBoundingClientRect();
      this.hover = { x: e.clientX - r.left, y: e.clientY - r.top };
      this.draw();
    });
    this.canvas.addEventListener("mouseleave", () => {
      this.hover = null;
      this.draw();
    });

    new ResizeObserver(() => this.draw()).observe(host);
  }

  render(cfg) {
    this.cfg = cfg;
    this.draw();
  }

  // ── scales ────────────────────────────────────────────────────────
  _bounds() {
    const { series, xLog, yInvert } = this.cfg;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const s of series) {
      for (const [x, y] of s.points) {
        if (!isFinite(x) || !isFinite(y)) continue;
        if (xLog && x <= 0) continue;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    if (!isFinite(x0)) { x0 = 0; x1 = 1; }
    if (!isFinite(y0)) { y0 = 0; y1 = 1; }
    if (x1 <= x0) x1 = x0 + (xLog ? x0 * 0.1 || 1 : 1);
    // Pad the y range a little so lines never graze the frame.
    const pad = (y1 - y0) * 0.08 || Math.abs(y1) * 0.08 || 1;
    y0 -= pad;
    y1 += pad;
    return { x0, x1, y0, y1, yInvert: !!yInvert };
  }

  _scales(w, h) {
    const b = this._bounds();
    const { xLog } = this.cfg;
    const pw = w - M.left - M.right;
    const ph = h - M.top - M.bottom;
    const lx0 = xLog ? Math.log10(b.x0) : b.x0;
    const lx1 = xLog ? Math.log10(b.x1) : b.x1;
    const sx = (x) => {
      const lx = xLog ? Math.log10(Math.max(x, 1e-12)) : x;
      return M.left + ((lx - lx0) / (lx1 - lx0 || 1)) * pw;
    };
    const sy = (y) => M.top + ph - ((y - b.y0) / (b.y1 - b.y0 || 1)) * ph;
    const ix = (px) => {
      const t = (px - M.left) / (pw || 1);
      const lx = lx0 + t * (lx1 - lx0);
      return xLog ? Math.pow(10, lx) : lx;
    };
    return { b, sx, sy, ix, pw, ph };
  }

  // ── ticks ─────────────────────────────────────────────────────────
  _xTicks(b) {
    if (!this.cfg.xLog) return niceTicks(b.x0, b.x1, 6);
    const out = [];
    const d0 = Math.floor(Math.log10(b.x0));
    const d1 = Math.ceil(Math.log10(b.x1));
    for (let d = d0; d <= d1; d++) {
      for (const m of [1, 2, 5]) {
        const v = m * Math.pow(10, d);
        if (v >= b.x0 && v <= b.x1) out.push(v);
      }
    }
    return out.length ? out : niceTicks(b.x0, b.x1, 6);
  }

  // ── draw ──────────────────────────────────────────────────────────
  draw() {
    const cfg = this.cfg;
    if (!cfg) return;
    const r = this.host.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = r.width, h = r.height;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    const g = this.ctx;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);

    const { b, sx, sy, ix, ph } = this._scales(w, h);
    const xFmt = cfg.xFormat || ((v) => shortNum(v));
    const yFmt = cfg.yFormat || ((v) => shortNum(v));

    // grid + axes
    g.font = "10px system-ui, sans-serif";
    g.textBaseline = "middle";

    const xTicks = this._xTicks(b);
    for (const t of xTicks) {
      const px = sx(t);
      g.strokeStyle = CSS.grid;
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(px, M.top);
      g.lineTo(px, M.top + ph);
      g.stroke();
      g.fillStyle = CSS.inkFaint;
      g.textAlign = "center";
      g.fillText(xFmt(t), px, M.top + ph + 13);
    }

    const yTicks = niceTicks(b.y0, b.y1, 5);
    for (const t of yTicks) {
      const py = sy(t);
      g.strokeStyle = CSS.grid;
      g.beginPath();
      g.moveTo(M.left, py);
      g.lineTo(w - M.right, py);
      g.stroke();
      g.fillStyle = CSS.inkFaint;
      g.textAlign = "right";
      g.fillText(yFmt(t), M.left - 8, py);
    }

    g.strokeStyle = CSS.axis;
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(M.left, M.top);
    g.lineTo(M.left, M.top + ph);
    g.lineTo(w - M.right, M.top + ph);
    g.stroke();

    // axis labels
    g.fillStyle = CSS.inkDim;
    g.textAlign = "center";
    if (cfg.xLabel) g.fillText(cfg.xLabel, M.left + (w - M.left - M.right) / 2, h - 6);
    if (cfg.yLabel) {
      g.save();
      g.translate(12, M.top + ph / 2);
      g.rotate(-Math.PI / 2);
      g.fillText(cfg.yLabel, 0, 0);
      g.restore();
    }

    // vertical markers (e.g. the spatial-aliasing frequency)
    for (const mk of cfg.markers || []) {
      if (!isFinite(mk.x) || mk.x < b.x0 || mk.x > b.x1) continue;
      const px = sx(mk.x);
      g.save();
      g.strokeStyle = mk.color || CSS.warn;
      g.setLineDash([4, 4]);
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(px, M.top);
      g.lineTo(px, M.top + ph);
      g.stroke();
      g.restore();
      if (mk.label) {
        g.fillStyle = mk.color || CSS.warn;
        g.textAlign = "left";
        g.fillText(mk.label, px + 4, M.top + 7);
      }
    }

    // series
    g.lineWidth = 1.75;
    g.lineJoin = "round";
    g.lineCap = "round";
    cfg.series.forEach((s, i) => {
      const color = s.color || CHART_PALETTE[i % CHART_PALETTE.length];
      g.save();
      g.strokeStyle = color;
      if (s.dashed) g.setLineDash([5, 4]);
      g.beginPath();
      let pen = false;
      for (const [x, y] of s.points) {
        if (!isFinite(x) || !isFinite(y)) { pen = false; continue; }  // gap
        const px = sx(x), py = sy(y);
        if (pen) g.lineTo(px, py);
        else { g.moveTo(px, py); pen = true; }
      }
      g.stroke();
      g.restore();
    });

    // legend
    let ly = M.top + 4;
    g.textAlign = "left";
    cfg.series.forEach((s, i) => {
      if (!s.label) return;
      const color = s.color || CHART_PALETTE[i % CHART_PALETTE.length];
      const lx = w - M.right - 108;
      g.strokeStyle = color;
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(lx, ly);
      g.lineTo(lx + 14, ly);
      g.stroke();
      g.fillStyle = CSS.inkDim;
      g.fillText(s.label, lx + 20, ly);
      ly += 14;
    });

    // hover crosshair + readout
    if (this.hover && this.hover.x >= M.left && this.hover.x <= w - M.right) {
      const xv = ix(this.hover.x);
      const px = sx(xv);
      g.save();
      g.strokeStyle = CSS.axis;
      g.setLineDash([2, 3]);
      g.beginPath();
      g.moveTo(px, M.top);
      g.lineTo(px, M.top + ph);
      g.stroke();
      g.restore();

      const parts = [xFmt(xv)];
      cfg.series.forEach((s) => {
        const p = nearestPoint(s.points, xv);
        if (p) parts.push(`${s.label ? s.label + " " : ""}${yFmt(p[1])}`);
      });
      const text = parts.join("   ");
      g.font = "10px system-ui, sans-serif";
      const tw = g.measureText(text).width;
      const bx = Math.min(Math.max(px + 8, M.left), w - M.right - tw - 12);
      g.fillStyle = "rgba(12, 17, 25, 0.92)";
      g.strokeStyle = CSS.axis;
      g.lineWidth = 1;
      roundRect(g, bx, M.top + 2, tw + 12, 18, 5);
      g.fill();
      g.stroke();
      g.fillStyle = CSS.ink;
      g.textAlign = "left";
      g.fillText(text, bx + 6, M.top + 11);
    }
  }
}

// ── helpers ─────────────────────────────────────────────────────────
function niceTicks(a, b, count) {
  if (!(isFinite(a) && isFinite(b)) || b <= a) return [a];
  const raw = (b - a) / Math.max(1, count);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
  const out = [];
  for (let v = Math.ceil(a / step) * step; v <= b + step * 1e-9; v += step) out.push(v);
  return out;
}

function nearestPoint(points, x) {
  let best = null, bd = Infinity;
  for (const p of points) {
    if (!isFinite(p[0]) || !isFinite(p[1])) continue;
    const d = Math.abs(p[0] - x);
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}

function shortNum(v) {
  const a = Math.abs(v);
  if (a >= 1000) return `${(v / 1000).toFixed(a >= 10000 ? 0 : 1)}k`;
  if (a >= 10) return v.toFixed(0);
  if (a >= 1) return v.toFixed(1);
  return v.toFixed(2);
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
