// micedit.js — 2-D top-down microphone editor.
//
// Editing happens in the array plane's (u, v) basis, but each microphone's
// out-of-plane component is preserved, so a 3-D layout (e.g. from CSV) survives
// a round trip through the editor instead of being flattened.
//
// Selection:  click = select one · Ctrl/Cmd+click = toggle · drag on empty
//             space = rectangle marquee · drag on a mic = move the selection.
// Keyboard:   arrows nudge, Delete removes, Ctrl+A selects all, Esc clears.

const INK = "#e7eef7";
const DIM = "#8d9cb2";
const FAINT = "#5d6b82";
const GRID = "rgba(125,145,175,0.10)";
const AXIS = "rgba(125,145,175,0.30)";
const ACCENT = "#58d4ff";
const SEL = "#ffb454";

const PAD = 34; // px of margin around the array's extents

function basis(plane) {
  if (plane === "xz") return [[1, 0, 0], [0, 0, 1], [0, 1, 0]];
  if (plane === "yz") return [[0, 1, 0], [0, 0, 1], [1, 0, 0]];
  return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
}
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export class MicEditor {
  constructor(host) {
    this.host = host;
    this.canvas = document.createElement("canvas");
    Object.assign(this.canvas.style, { width: "100%", height: "100%", display: "block", cursor: "crosshair" });
    host.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d");

    this.pts = [];        // { u, v, n }  — n = out-of-plane component (preserved)
    this.origin = [0, 0, 0];
    this.plane = "xy";
    this.sel = new Set();
    this.snap = 0;        // grid step in metres; 0 = off
    this.onChange = null; // called after any edit (for the count readout)

    this.drag = null;     // { mode: "move" | "marquee", … }
    this._bind();
    new ResizeObserver(() => this.draw()).observe(host);
  }

  /** Seed the editor from world-space mic positions. */
  load(mics, plane) {
    this.plane = plane || "xy";
    const [uh, vh, nh] = basis(this.plane);
    // Use the centroid as the in-plane origin so the view is centred on the array.
    const c = [0, 1, 2].map((i) => mics.reduce((s, p) => s + p[i], 0) / Math.max(1, mics.length));
    this.origin = c;
    this.pts = mics.map((p) => {
      const d = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
      return { u: dot(d, uh), v: dot(d, vh), n: dot(d, nh) };
    });
    this.sel.clear();
    this._fit();
    this.draw();
  }

  /** Back to world-space positions, restoring the out-of-plane component. */
  positions() {
    const [uh, vh, nh] = basis(this.plane);
    const c = this.origin;
    return this.pts.map((p) => [
      c[0] + uh[0] * p.u + vh[0] * p.v + nh[0] * p.n,
      c[1] + uh[1] * p.u + vh[1] * p.v + nh[1] * p.n,
      c[2] + uh[2] * p.u + vh[2] * p.v + nh[2] * p.n,
    ]);
  }

  /** Indices removed by the user, so callers can drop matching weights. */
  keptIndices() {
    return this.pts.map((p) => p.src);
  }

  count() {
    return this.pts.length;
  }
  selectedCount() {
    return this.sel.size;
  }
  setSnap(step) {
    this.snap = step > 0 ? step : 0;
  }

  // ── view transform ───────────────────────────────────────────────
  _fit() {
    const r = this.host.getBoundingClientRect();
    const w = Math.max(2, r.width), h = Math.max(2, r.height);
    let u0 = -0.5, u1 = 0.5, v0 = -0.5, v1 = 0.5;
    if (this.pts.length) {
      u0 = Math.min(...this.pts.map((p) => p.u));
      u1 = Math.max(...this.pts.map((p) => p.u));
      v0 = Math.min(...this.pts.map((p) => p.v));
      v1 = Math.max(...this.pts.map((p) => p.v));
    }
    const su = u1 - u0 || 1;
    const sv = v1 - v0 || 1;
    // One scale for both axes: the array must not be visually distorted.
    this.scale = Math.min((w - 2 * PAD) / su, (h - 2 * PAD) / sv);
    this.cu = (u0 + u1) / 2;
    this.cv = (v0 + v1) / 2;
    this.w = w;
    this.h = h;
  }

  _sx(u) { return this.w / 2 + (u - this.cu) * this.scale; }
  _sy(v) { return this.h / 2 - (v - this.cv) * this.scale; }   // +v is up
  _iu(px) { return this.cu + (px - this.w / 2) / this.scale; }
  _iv(py) { return this.cv - (py - this.h / 2) / this.scale; }

  _hit(px, py) {
    const R = 9;
    for (let i = this.pts.length - 1; i >= 0; i--) {
      const dx = this._sx(this.pts[i].u) - px;
      const dy = this._sy(this.pts[i].v) - py;
      if (dx * dx + dy * dy <= R * R) return i;
    }
    return -1;
  }

  _snap(val) {
    return this.snap > 0 ? Math.round(val / this.snap) * this.snap : val;
  }

  // ── interaction ──────────────────────────────────────────────────
  _bind() {
    const pos = (e) => {
      const r = this.canvas.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };

    this.canvas.addEventListener("mousedown", (e) => {
      const [px, py] = pos(e);
      const hit = this._hit(px, py);
      const additive = e.ctrlKey || e.metaKey;

      if (hit >= 0) {
        if (additive) {
          if (this.sel.has(hit)) this.sel.delete(hit);
          else this.sel.add(hit);
        } else if (!this.sel.has(hit)) {
          this.sel.clear();
          this.sel.add(hit);
        }
        // Drag the whole selection, remembering each mic's start position.
        this.drag = {
          mode: "move",
          u0: this._iu(px),
          v0: this._iv(py),
          start: [...this.sel].map((i) => ({ i, u: this.pts[i].u, v: this.pts[i].v })),
        };
      } else {
        if (!additive) this.sel.clear();
        this.drag = { mode: "marquee", px0: px, py0: py, px, py, additive, base: new Set(this.sel) };
      }
      this.draw();
    });

    window.addEventListener("mousemove", (e) => {
      if (!this.drag) return;
      const [px, py] = pos(e);
      if (this.drag.mode === "move") {
        const du = this._iu(px) - this.drag.u0;
        const dv = this._iv(py) - this.drag.v0;
        for (const s of this.drag.start) {
          this.pts[s.i].u = this._snap(s.u + du);
          this.pts[s.i].v = this._snap(s.v + dv);
        }
        if (this.onChange) this.onChange();
      } else {
        this.drag.px = px;
        this.drag.py = py;
        const [a, b] = [Math.min(this.drag.px0, px), Math.max(this.drag.px0, px)];
        const [c, d] = [Math.min(this.drag.py0, py), Math.max(this.drag.py0, py)];
        this.sel = new Set(this.drag.additive ? this.drag.base : []);
        this.pts.forEach((p, i) => {
          const x = this._sx(p.u), y = this._sy(p.v);
          if (x >= a && x <= b && y >= c && y <= d) this.sel.add(i);
        });
      }
      this.draw();
    });

    window.addEventListener("mouseup", () => {
      if (!this.drag) return;
      this.drag = null;
      this.draw();
      if (this.onChange) this.onChange();
    });

    this.canvas.setAttribute("tabindex", "0");
    this.canvas.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
        e.preventDefault();
        this.sel = new Set(this.pts.map((_, i) => i));
        this.draw();
        return;
      }
      if (e.key === "Escape") {
        this.sel.clear();
        this.draw();
        return;
      }
      if ((e.key === "Delete" || e.key === "Backspace") && this.sel.size) {
        e.preventDefault();
        if (this.sel.size >= this.pts.length) return; // never delete every mic
        this.pts = this.pts.filter((_, i) => !this.sel.has(i));
        this.sel.clear();
        this.draw();
        if (this.onChange) this.onChange();
        return;
      }
      const step = (this.snap > 0 ? this.snap : 0.005) * (e.shiftKey ? 5 : 1);
      const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[e.key];
      if (!d || !this.sel.size) return;
      e.preventDefault();
      for (const i of this.sel) {
        this.pts[i].u += d[0];
        this.pts[i].v += d[1];
      }
      this.draw();
      if (this.onChange) this.onChange();
    });
  }

  // ── render ───────────────────────────────────────────────────────
  draw() {
    const r = this.host.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) return;
    if (this.w !== r.width || this.h !== r.height || !this.scale) this._fit();

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(r.width * dpr);
    this.canvas.height = Math.round(r.height * dpr);
    const g = this.ctx;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, this.w, this.h);

    // snap grid
    if (this.snap > 0) {
      const px = this.snap * this.scale;
      if (px >= 6) {
        g.strokeStyle = GRID;
        g.lineWidth = 1;
        const u0 = this._iu(0), u1 = this._iu(this.w);
        const v0 = this._iv(this.h), v1 = this._iv(0);
        for (let u = Math.ceil(u0 / this.snap) * this.snap; u <= u1; u += this.snap) {
          g.beginPath(); g.moveTo(this._sx(u), 0); g.lineTo(this._sx(u), this.h); g.stroke();
        }
        for (let v = Math.ceil(v0 / this.snap) * this.snap; v <= v1; v += this.snap) {
          g.beginPath(); g.moveTo(0, this._sy(v)); g.lineTo(this.w, this._sy(v)); g.stroke();
        }
      }
    }

    // axes through the array origin
    g.strokeStyle = AXIS;
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(0, this._sy(0)); g.lineTo(this.w, this._sy(0));
    g.moveTo(this._sx(0), 0); g.lineTo(this._sx(0), this.h);
    g.stroke();

    // microphones
    this.pts.forEach((p, i) => {
      const x = this._sx(p.u), y = this._sy(p.v);
      const on = this.sel.has(i);
      g.beginPath();
      g.arc(x, y, on ? 6 : 4.5, 0, Math.PI * 2);
      g.fillStyle = on ? SEL : ACCENT;
      g.globalAlpha = on ? 1 : 0.85;
      g.fill();
      g.globalAlpha = 1;
      if (on) {
        g.strokeStyle = SEL;
        g.lineWidth = 1.5;
        g.beginPath();
        g.arc(x, y, 10, 0, Math.PI * 2);
        g.stroke();
      }
    });

    // marquee
    if (this.drag && this.drag.mode === "marquee") {
      const x = Math.min(this.drag.px0, this.drag.px);
      const y = Math.min(this.drag.py0, this.drag.py);
      const w = Math.abs(this.drag.px - this.drag.px0);
      const h = Math.abs(this.drag.py - this.drag.py0);
      g.fillStyle = "rgba(88,212,255,0.10)";
      g.strokeStyle = ACCENT;
      g.lineWidth = 1;
      g.fillRect(x, y, w, h);
      g.strokeRect(x + 0.5, y + 0.5, w, h);
    }

    // scale bar + hint
    g.font = '10px "SF Mono","JetBrains Mono",ui-monospace,monospace';
    g.fillStyle = FAINT;
    g.textAlign = "left";
    g.textBaseline = "bottom";
    const barM = niceStep(120 / this.scale);
    const barPx = barM * this.scale;
    const bx = 14, by = this.h - 14;
    g.strokeStyle = AXIS;
    g.beginPath();
    g.moveTo(bx, by); g.lineTo(bx + barPx, by);
    g.moveTo(bx, by - 4); g.lineTo(bx, by);
    g.moveTo(bx + barPx, by - 4); g.lineTo(bx + barPx, by);
    g.stroke();
    g.fillText(`${barM >= 1 ? barM.toFixed(2) + " m" : (barM * 1000).toFixed(0) + " mm"}`, bx, by - 6);

    g.fillStyle = this.sel.size ? DIM : FAINT;
    g.textAlign = "right";
    g.textBaseline = "top";
    g.fillText(
      this.sel.size ? `${this.sel.size} of ${this.pts.length} selected` : `${this.pts.length} microphones`,
      this.w - 14,
      12
    );
    g.fillStyle = FAINT;
    g.fillText("drag · ctrl+click · marquee · arrows · del", this.w - 14, 26);
    void INK;
  }
}

function niceStep(raw) {
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / mag;
  return (n >= 5 ? 5 : n >= 2 ? 2 : 1) * mag;
}
