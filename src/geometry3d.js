// geometry3d.js — rotatable 3-D view of the array geometry and focus plane.
// The focus plane is textured live with the PSF map for visual cohesion.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

function discTexture() {
  const s = 64;
  const cv = document.createElement("canvas");
  cv.width = cv.height = s;
  const g = cv.getContext("2d");
  const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grad.addColorStop(0, "rgba(220,245,255,1)");
  grad.addColorStop(0.35, "rgba(120,215,255,0.95)");
  grad.addColorStop(1, "rgba(120,215,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, s, s);
  const t = new THREE.CanvasTexture(cv);
  return t;
}

export class Geometry3D {
  constructor(host) {
    this.host = host;
    this.scene = new THREE.Scene();
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    host.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.width = "100%";
    this.renderer.domElement.style.height = "100%";

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
    this.camera.position.set(1.4, 1.0, 1.8);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.rotateSpeed = 0.7;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.55;
    this.idleTimer = 0;
    this.controls.addEventListener("start", () => {
      this.controls.autoRotate = false;
      clearTimeout(this.idleTimer);
    });
    this.controls.addEventListener("end", () => {
      clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => (this.controls.autoRotate = true), 4000);
    });

    // lighting (subtle — most things are unlit/emissive)
    this.scene.add(new THREE.AmbientLight(0x8090a0, 1.1));
    const key = new THREE.DirectionalLight(0xbfe6ff, 0.6);
    key.position.set(2, 3, 2);
    this.scene.add(key);

    // groups we rebuild on update
    this.micSprite = discTexture();
    this.micGroup = new THREE.Group();
    this.scene.add(this.micGroup);

    this.planeMesh = null;
    this.planeTex = null;
    this.sourceDot = null;
    this.gridHelper = null;
    this.axes = null;

    this._raf = 0;
    this._animate = this._animate.bind(this);
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
    this._animate();
  }

  resize() {
    const r = this.host.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    this.renderer.setSize(r.width, r.height, false);
    this.camera.aspect = r.width / r.height;
    this.camera.updateProjectionMatrix();
  }

  setTexture(canvas) {
    if (!this.planeMesh) return;
    if (this.planeTex) this.planeTex.dispose();
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    this.planeTex = tex;
    this.planeMesh.material.map = tex;
    this.planeMesh.material.needsUpdate = true;
  }

  // mics: [[x,y,z]...], weights: [..], corners: [BL,BR,TR,TL]
  update(mics, weights, corners) {
    // ── mics ──
    this.micGroup.clear();
    const wmax = Math.max(1e-9, ...weights);
    const positions = new Float32Array(mics.length * 3);
    mics.forEach((p, i) => {
      positions[i * 3] = p[0];
      positions[i * 3 + 1] = p[1];
      positions[i * 3 + 2] = p[2];
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const avgW = weights.reduce((a, b) => a + b, 0) / Math.max(1, weights.length);
    const mat = new THREE.PointsMaterial({
      size: 0.05,
      map: this.micSprite,
      transparent: true,
      depthWrite: false,
      sizeAttenuation: true,
      color: 0x9fe6ff,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
    });
    this.micGroup.add(new THREE.Points(geo, mat));

    // ── focus plane ──
    if (this.planeMesh) {
      this.scene.remove(this.planeMesh);
      this.planeMesh.geometry.dispose();
      this.planeMesh.material.dispose();
    }
    const [BL, BR, TR, TL] = corners;
    const pg = new THREE.BufferGeometry();
    const verts = new Float32Array([
      ...BL, ...BR, ...TR,
      ...BL, ...TR, ...TL,
    ]);
    const uv = new Float32Array([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1]);
    pg.setAttribute("position", new THREE.BufferAttribute(verts, 3));
    pg.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    pg.computeVertexNormals();
    const pmat = new THREE.MeshBasicMaterial({
      map: this.planeTex || null,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.96,
    });
    this.planeMesh = new THREE.Mesh(pg, pmat);
    this.scene.add(this.planeMesh);

    // plane border
    const edge = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(
        [BL, BR, TR, TL].map((p) => new THREE.Vector3(...p))
      ),
      new THREE.LineBasicMaterial({ color: 0x58d4ff, transparent: true, opacity: 0.55 })
    );
    this.planeMesh.add(edge);

    // ── source dot at plane centre ──
    const center = [
      (BL[0] + TR[0]) / 2,
      (BL[1] + TR[1]) / 2,
      (BL[2] + TR[2]) / 2,
    ];
    if (this.sourceDot) this.scene.remove(this.sourceDot);
    const dotGeo = new THREE.SphereGeometry(0.018, 16, 16);
    const dotMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    this.sourceDot = new THREE.Mesh(dotGeo, dotMat);
    this.sourceDot.position.set(...center);
    this.scene.add(this.sourceDot);

    // ── reference grid + axes (rebuilt to scene scale) ──
    const all = mics.concat(corners);
    const bounds = boundsOf(all);
    const span = Math.max(bounds.size, 0.5);
    if (this.gridHelper) this.scene.remove(this.gridHelper);
    const grid = new THREE.GridHelper(span * 2.4, 12, 0x2a3b52, 0x18222f);
    grid.material.opacity = 0.32;
    grid.material.transparent = true;
    grid.position.set(bounds.center[0], bounds.min[1] - span * 0.05, bounds.center[2]);
    this.gridHelper = grid;
    this.scene.add(grid);

    if (this.axes) this.scene.remove(this.axes);
    this.axes = makeAxes(span * 0.5);
    this.axes.position.set(bounds.center[0], bounds.min[1] - span * 0.05, bounds.center[2]);
    this.scene.add(this.axes);

    // frame the camera the first time only
    if (!this._framed) {
      const c = bounds.center;
      this.controls.target.set(c[0], c[1], c[2]);
      const d = span * 2.1;
      this.camera.position.set(c[0] + d * 0.7, c[1] + d * 0.55, c[2] + d * 0.9);
      this.camera.near = Math.max(0.001, span * 0.01);
      this.camera.far = span * 40;
      this.camera.updateProjectionMatrix();
      this.controls.update();
      this._framed = true;
    }
  }

  _animate() {
    this._raf = requestAnimationFrame(this._animate);
    this.controls.update();
    if (this.sourceDot) {
      const s = 1 + 0.15 * Math.sin(performance.now() * 0.003);
      this.sourceDot.scale.setScalar(s);
    }
    this.renderer.render(this.scene, this.camera);
  }
}

function boundsOf(points) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const p of points)
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i], p[i]);
      max[i] = Math.max(max[i], p[i]);
    }
  const center = [0, 1, 2].map((i) => (min[i] + max[i]) / 2);
  const size = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]) || 1;
  return { min, max, center, size };
}

function makeAxes(len) {
  const g = new THREE.Group();
  const mk = (dir, color) => {
    const m = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.5 });
    const geo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(...dir),
    ]);
    return new THREE.Line(geo, m);
  };
  g.add(mk([len, 0, 0], 0x6b7d99));
  g.add(mk([0, len, 0], 0x6b7d99));
  g.add(mk([0, 0, len], 0x6b7d99));
  return g;
}
