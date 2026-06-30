// geometry3d.js — 3-D scene: array geometry, multi-plane PSF quads, source marker.
// Optional path-tracing via three-gpu-pathtracer (must be installed separately:
//   npm install three-gpu-pathtracer
// Falls back silently to standard WebGL renderer if the package is absent.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

// Lazy-load the path tracer so the app works without the package
let PathTracerModule = null;
async function loadPathTracer() {
  if (PathTracerModule) return PathTracerModule;
  try {
    // @vite-ignore — optional, not bundled; resolved only if the package is
    // present at runtime. Absence is caught below and falls back to WebGL.
    PathTracerModule = await import(/* @vite-ignore */ "three-gpu-pathtracer");
    return PathTracerModule;
  } catch {
    return null;
  }
}

// ── plane metadata ───────────────────────────────────────────────
const PLANES = ["xy", "xz", "yz"];
const PLANE_COLOR = { xy: 0x58d4ff, xz: 0x6ee7a8, yz: 0xffb454 };
const PLANE_OPACITY_ACTIVE = 0.97;
const PLANE_OPACITY_PASSIVE = 0.55;

// ── microphone sprite ────────────────────────────────────────────
function discTexture() {
  const s = 64;
  const cv = document.createElement("canvas");
  cv.width = cv.height = s;
  const g = cv.getContext("2d");
  const grad = g.createRadialGradient(s/2, s/2, 0, s/2, s/2, s/2);
  grad.addColorStop(0,    "rgba(220,245,255,1)");
  grad.addColorStop(0.35, "rgba(120,215,255,0.95)");
  grad.addColorStop(1,    "rgba(120,215,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, s, s);
  return new THREE.CanvasTexture(cv);
}

// ── source marker sprite (warm star) ────────────────────────────
function sourceSprite() {
  const s = 64;
  const cv = document.createElement("canvas");
  cv.width = cv.height = s;
  const g = cv.getContext("2d");
  // outer glow
  const glow = g.createRadialGradient(s/2, s/2, 0, s/2, s/2, s/2);
  glow.addColorStop(0,    "rgba(255,230,80,1)");
  glow.addColorStop(0.25, "rgba(255,160,40,0.9)");
  glow.addColorStop(0.55, "rgba(255,80,20,0.4)");
  glow.addColorStop(1,    "rgba(255,60,10,0)");
  g.fillStyle = glow;
  g.fillRect(0, 0, s, s);
  // bright core
  const core = g.createRadialGradient(s/2, s/2, 0, s/2, s/2, s*0.12);
  core.addColorStop(0, "rgba(255,255,220,1)");
  core.addColorStop(1, "rgba(255,220,80,0)");
  g.fillStyle = core;
  g.beginPath();
  g.arc(s/2, s/2, s*0.12, 0, Math.PI*2);
  g.fill();
  return new THREE.CanvasTexture(cv);
}

// ── checkerboard placeholder for planes without a texture yet ───
function checkerTexture(color) {
  const s = 128;
  const cv = document.createElement("canvas");
  cv.width = cv.height = s;
  const g = cv.getContext("2d");
  const hex = "#" + color.toString(16).padStart(6,"0");
  g.fillStyle = "rgba(0,0,0,0)";
  g.fillRect(0, 0, s, s);
  g.strokeStyle = hex;
  g.lineWidth = 1;
  g.globalAlpha = 0.18;
  const N = 8;
  for (let i = 0; i <= N; i++) {
    const x = (i/N)*s, y = (i/N)*s;
    g.beginPath(); g.moveTo(x,0); g.lineTo(x,s); g.stroke();
    g.beginPath(); g.moveTo(0,y); g.lineTo(s,y); g.stroke();
  }
  return new THREE.CanvasTexture(cv);
}

export class Geometry3D {
  constructor(host) {
    this.host = host;
    this.scene = new THREE.Scene();

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    host.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.width  = "100%";
    this.renderer.domElement.style.height = "100%";

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
    this.camera.position.set(1.4, 1.0, 1.8);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.rotateSpeed   = 0.7;
    this.controls.autoRotate      = true;
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

    // Lighting — physical setup for path tracer AND standard renderer
    const ambient = new THREE.AmbientLight(0x8090a0, 0.8);
    this.scene.add(ambient);

    const key = new THREE.DirectionalLight(0xbfe6ff, 1.2);
    key.position.set(2, 3.5, 2);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.near = 0.1;
    key.shadow.camera.far  = 20;
    key.shadow.radius = 4;
    this.scene.add(key);

    const fill = new THREE.DirectionalLight(0xffe0b0, 0.4);
    fill.position.set(-2, 1, -1);
    this.scene.add(fill);

    // A subtle environment (hemisphere sky)
    this.scene.add(new THREE.HemisphereLight(0x334466, 0x0a0d14, 0.6));

    // Groups
    this.micSprite    = discTexture();
    this.srcSprite    = sourceSprite();
    this.micGroup     = new THREE.Group();
    this.scene.add(this.micGroup);

    // Per-plane meshes & textures
    this.planeMeshes  = {};   // plane → THREE.Mesh
    this.planeTex     = {};   // plane → THREE.CanvasTexture
    this.planeCorners = {};   // plane → corners array (for rebuilding)

    this.sourceMesh   = null;
    this.gridHelper   = null;
    this.axes         = null;

    // State
    this._framed    = false;
    this._multiplane = false;
    this._activePlane = "xy";

    // Path tracer state
    this._raytrace    = false;
    this._ptRenderer  = null;  // PathTracingRenderer instance
    this._ptReady     = false;
    this._ptDirty     = false;

    this._raf     = 0;
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
    if (this._ptRenderer) {
      this._ptRenderer.setSize(r.width, r.height);
      this._ptRenderer.reset();
    }
  }

  // Called by main.js whenever the PSF texture for a given plane is ready
  setTexture(canvas, plane) {
    const p = plane || "xy";
    if (this.planeTex[p]) this.planeTex[p].dispose();
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    this.planeTex[p] = tex;
    if (this.planeMeshes[p]) {
      this.planeMeshes[p].material.map = tex;
      this.planeMeshes[p].material.needsUpdate = true;
    }
    this._markDirty();
  }

  setMultiplane(enabled) {
    this._multiplane = enabled;
    this._syncPlaneVisibility();
    this._markDirty();
  }

  // mics, weights, corners are for the primary (active) plane
  // allResults: { xy, xz, yz } — corners needed to position other planes
  update(mics, weights, corners, activePlane, allResults, multiplane) {
    this._activePlane = activePlane || "xy";
    this._multiplane  = multiplane || false;

    // ── microphones ──
    this.micGroup.clear();
    const positions = new Float32Array(mics.length * 3);
    mics.forEach((p, i) => { positions[i*3]=p[0]; positions[i*3+1]=p[1]; positions[i*3+2]=p[2]; });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
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

    // ── focus planes ──
    // Always (re)build the active plane; build others from allResults if present
    const planeCorners = {};
    planeCorners[this._activePlane] = corners;

    if (allResults) {
      for (const p of PLANES) {
        if (p !== this._activePlane && allResults[p]) {
          planeCorners[p] = allResults[p].corners;
        }
      }
    }

    for (const p of PLANES) {
      if (planeCorners[p]) {
        this._buildPlane(p, planeCorners[p]);
      }
    }

    this._syncPlaneVisibility();

    // ── bounds ──
    const all = mics.concat(corners);
    const bounds = boundsOf(all);
    const span = Math.max(bounds.size, 0.5);

    if (this.gridHelper) this.scene.remove(this.gridHelper);
    const grid = new THREE.GridHelper(span*2.4, 12, 0x2a3b52, 0x18222f);
    grid.material.opacity = 0.32;
    grid.material.transparent = true;
    grid.position.set(bounds.center[0], bounds.min[1] - span*0.05, bounds.center[2]);
    this.gridHelper = grid;
    this.scene.add(grid);

    if (this.axes) this.scene.remove(this.axes);
    this.axes = makeAxes(span*0.5);
    this.axes.position.set(bounds.center[0], bounds.min[1] - span*0.05, bounds.center[2]);
    this.scene.add(this.axes);

    if (!this._framed) {
      const c = bounds.center;
      this.controls.target.set(c[0], c[1], c[2]);
      const d = span * 2.1;
      this.camera.position.set(c[0]+d*0.7, c[1]+d*0.55, c[2]+d*0.9);
      this.camera.near = Math.max(0.001, span*0.01);
      this.camera.far  = span * 40;
      this.camera.updateProjectionMatrix();
      this.controls.update();
      this._framed = true;
    }

    this._markDirty();
  }

  _buildPlane(plane, corners) {
    // Remove old
    if (this.planeMeshes[plane]) {
      this.scene.remove(this.planeMeshes[plane]);
      this.planeMeshes[plane].geometry.dispose();
      this.planeMeshes[plane].material.dispose();
    }
    this.planeCorners[plane] = corners;

    const [BL, BR, TR, TL] = corners;
    const pg = new THREE.BufferGeometry();
    const verts = new Float32Array([...BL,...BR,...TR, ...BL,...TR,...TL]);
    const uv    = new Float32Array([0,0, 1,0, 1,1,  0,0, 1,1, 0,1]);
    pg.setAttribute("position", new THREE.BufferAttribute(verts, 3));
    pg.setAttribute("uv",       new THREE.BufferAttribute(uv,    2));
    pg.computeVertexNormals();

    const tex = this.planeTex[plane] ||
      (() => { const t = checkerTexture(PLANE_COLOR[plane]); this.planeTex[plane] = t; return t; })();

    const pmat = new THREE.MeshPhysicalMaterial({
      map: tex,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: PLANE_OPACITY_ACTIVE,
      roughness: 0.15,
      metalness: 0.0,
      clearcoat: 0.6,
      clearcoatRoughness: 0.1,
    });
    const mesh = new THREE.Mesh(pg, pmat);
    this.scene.add(mesh);
    this.planeMeshes[plane] = mesh;

    // border loop
    const color = PLANE_COLOR[plane];
    const edge = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints([BL,BR,TR,TL].map((p) => new THREE.Vector3(...p))),
      new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.7 })
    );
    mesh.add(edge);
  }

  _syncPlaneVisibility() {
    for (const p of PLANES) {
      const mesh = this.planeMeshes[p];
      if (!mesh) continue;
      if (p === this._activePlane) {
        mesh.visible = true;
        mesh.material.opacity = PLANE_OPACITY_ACTIVE;
      } else if (this._multiplane) {
        mesh.visible = true;
        mesh.material.opacity = PLANE_OPACITY_PASSIVE;
      } else {
        mesh.visible = false;
      }
    }
  }

  updateSource(pos) {
    if (!pos) return;
    if (!this.sourceMesh) {
      // Sprite-based source marker
      const mat = new THREE.SpriteMaterial({
        map: this.srcSprite,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      this.sourceMesh = new THREE.Sprite(mat);
      this.scene.add(this.sourceMesh);
    }
    this.sourceMesh.position.set(pos[0], pos[1], pos[2]);
    this._markDirty();
  }

  // ── Path tracing ──────────────────────────────────────────────
  async setRaytrace(enabled) {
    this._raytrace = enabled;
    if (enabled) {
      await this._initPathTracer();
    } else {
      this._ptRenderer = null;
      this._ptReady    = false;
    }
    this._markDirty();
  }

  async _initPathTracer() {
    const mod = await loadPathTracer();
    if (!mod) {
      console.warn("three-gpu-pathtracer not installed. Run: npm install three-gpu-pathtracer");
      this._raytrace = false;
      return;
    }
    const { WebGLPathTracer } = mod;
    const r = this.host.getBoundingClientRect();
    const pt = new WebGLPathTracer(this.renderer);
    pt.setSize(r.width || 800, r.height || 600);
    pt.renderScale = 0.5;          // start at half-res for fast first pass
    pt.tiles.set(2, 2);
    pt.multipleImportanceSampling = true;
    pt.bounces = 4;
    pt.setScene(this.scene, this.camera);
    this._ptRenderer = pt;
    this._ptReady    = true;
  }

  _markDirty() {
    this._ptDirty = true;
    if (this._ptRenderer) this._ptRenderer.reset();
  }

  _animate() {
    this._raf = requestAnimationFrame(this._animate);
    this.controls.update();

    // Pulse source marker
    if (this.sourceMesh) {
      const s = 0.06 + 0.02 * Math.sin(performance.now() * 0.003);
      this.sourceMesh.scale.setScalar(s);
    }

    if (this._raytrace && this._ptReady && this._ptRenderer) {
      // Progressive path tracing — accumulates samples each frame
      this._ptRenderer.renderSample();
    } else {
      this.renderer.render(this.scene, this.camera);
    }
  }
}

// ── helpers ──────────────────────────────────────────────────────

function boundsOf(points) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const p of points)
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i], p[i]);
      max[i] = Math.max(max[i], p[i]);
    }
  const center = [0,1,2].map((i) => (min[i]+max[i])/2);
  const size   = Math.max(max[0]-min[0], max[1]-min[1], max[2]-min[2]) || 1;
  return { min, max, center, size };
}

function makeAxes(len) {
  const g  = new THREE.Group();
  const mk = (dir, color) => {
    const m   = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.5 });
    const geo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0,0,0),
      new THREE.Vector3(...dir),
    ]);
    return new THREE.Line(geo, m);
  };
  g.add(mk([len,0,0], 0x6b7d99));
  g.add(mk([0,len,0], 0x6b7d99));
  g.add(mk([0,0,len], 0x6b7d99));
  return g;
}
