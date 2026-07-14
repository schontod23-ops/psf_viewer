// geometry3d.js — 3-D scene: array geometry, multi-plane PSF quads, source marker.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import { rgbLut, lutColor } from "./colormap.js";

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
    this.stlMesh      = null;   // optional loaded STL model

    // State
    this._framed    = false;
    this._multiplane = false;
    this._planeFade  = true;
    this._micColorByWeight = false;
    this._lastMics    = null;
    this._lastWeights = null;
    this._activePlane = "xy";

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

  setPlaneFade(enabled) {
    this._planeFade = enabled;
    this._syncPlaneVisibility();
    this._markDirty();
  }

  /** Cheap live update of just the mic point cloud (e.g. while dragging in the editor). */
  previewMics(mics, weights) {
    this._lastMics = mics;
    if (weights) this._lastWeights = weights;
    this._buildMicPoints();
    this._markDirty();
  }

  setMicColorByWeight(enabled) {
    this._micColorByWeight = enabled;
    if (this._lastMics) this._buildMicPoints();
    this._markDirty();
  }

  /** Rebuild the microphone point cloud, optionally colored by weight. */
  _buildMicPoints() {
    const mics = this._lastMics || [];
    const weights = this._lastWeights || [];
    this.micGroup.clear();
    const positions = new Float32Array(mics.length * 3);
    mics.forEach((p, i) => { positions[i*3]=p[0]; positions[i*3+1]=p[1]; positions[i*3+2]=p[2]; });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));

    const matOpts = {
      size: 0.05,
      map: this.micSprite,
      transparent: true,
      depthWrite: false,
      sizeAttenuation: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
    };

    if (this._micColorByWeight && weights.length === mics.length && mics.length) {
      const lut = rgbLut("turbo");
      const wMin = Math.min(...weights), wMax = Math.max(...weights);
      const span = wMax - wMin || 1;
      const colors = new Float32Array(mics.length * 3);
      weights.forEach((w, i) => {
        const t = (w - wMin) / span;
        const idx = Math.min(255, Math.max(0, Math.round(t * 255)));
        colors[i*3] = lut[idx*3]; colors[i*3+1] = lut[idx*3+1]; colors[i*3+2] = lut[idx*3+2];
      });
      geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
      matOpts.vertexColors = true;
      matOpts.color = 0xffffff;
    } else {
      matOpts.color = 0x9fe6ff;
    }

    this.micGroup.add(new THREE.Points(geo, new THREE.PointsMaterial(matOpts)));
  }

  // mics, weights, corners are for the primary (active) plane
  // allResults: { xy, xz, yz } — corners needed to position other planes
  update(mics, weights, corners, activePlane, allResults, multiplane) {
    this._activePlane = activePlane || "xy";
    this._multiplane  = multiplane || false;
    this._lastMics    = mics;
    this._lastWeights = weights;
    this._buildMicPoints();

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
        mesh.material.opacity = this._planeFade ? PLANE_OPACITY_ACTIVE : 1.0;
      } else if (this._multiplane) {
        mesh.visible = true;
        mesh.material.opacity = this._planeFade ? PLANE_OPACITY_PASSIVE : 1.0;
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

  // Show any additional incoherent sources as a pool of dimmer sprites.
  updateExtraSources(list) {
    if (!this._extraSprites) this._extraSprites = [];
    const arr = list || [];
    // Grow the pool as needed.
    while (this._extraSprites.length < arr.length) {
      const mat = new THREE.SpriteMaterial({
        map: this.srcSprite,
        transparent: true,
        opacity: 0.85,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const sp = new THREE.Sprite(mat);
      this.scene.add(sp);
      this._extraSprites.push(sp);
    }
    for (let i = 0; i < this._extraSprites.length; i++) {
      const sp = this._extraSprites[i];
      if (i < arr.length) {
        sp.position.set(arr[i].pos[0], arr[i].pos[1], arr[i].pos[2]);
        sp.visible = true;
      } else {
        sp.visible = false;
      }
    }
    this._markDirty();
  }

  // ── STL model ─────────────────────────────────────────────────
  // Load an STL, transformed by units-scale, rotation and translation.
  // "Painting the PSF" evaluates the beamformer only at a sparse,
  // density-controlled sample of surface points (`surfacePoints()`, the JS
  // equivalent of open3d's sample_points_uniformly — evaluating every vertex
  // of a real STL would be far too slow) and then colours *every* mesh
  // vertex by propagating the nearest sample's value (`setSurfaceLevels()`,
  // via a small kd-tree), so the whole surface appears painted rather than
  // just the sampled points.

  /**
   * Parse STL bytes and add the mesh. `xform` converts model units → metres
   * (`scale`), then orients (`rotX/Y/Z`, degrees) then positions (`tx/ty/tz`,
   * metres) — baked directly into world-space vertices, same as the previous
   * scale-only behaviour, so `surfacePoints()` can keep handing back plain
   * world-space points.
   */
  loadSTL(arrayBuffer, xform = {}) {
    const { scale = 1, rotX = 0, rotY = 0, rotZ = 0, tx = 0, ty = 0, tz = 0 } = xform;
    const geo = new STLLoader().parse(arrayBuffer);
    this.clearSTL();

    geo.scale(scale, scale, scale);
    if (rotX) geo.rotateX(THREE.MathUtils.degToRad(rotX));
    if (rotY) geo.rotateY(THREE.MathUtils.degToRad(rotY));
    if (rotZ) geo.rotateZ(THREE.MathUtils.degToRad(rotZ));
    if (tx || ty || tz) geo.translate(tx, ty, tz);
    geo.computeVertexNormals();
    // Ensure non-indexed so each triangle vertex has its own colour slot.
    const g = geo.index ? geo.toNonIndexed() : geo;

    const n = g.getAttribute("position").count;
    // RGBA: alpha lets setSurfaceLevels() hide vertices below the dynamic-range floor.
    const colors = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) { colors[i*4]=0.6; colors[i*4+1]=0.6; colors[i*4+2]=0.6; colors[i*4+3]=1; }
    g.setAttribute("color", new THREE.BufferAttribute(colors, 4));

    const mat = new THREE.MeshPhysicalMaterial({
      vertexColors: true,
      transparent: true,
      side: THREE.DoubleSide,
      roughness: 0.55,
      metalness: 0.0,
      clearcoat: 0.25,
    });
    this.stlMesh = new THREE.Mesh(g, mat);
    this.stlMesh.castShadow = true;
    this.stlMesh.receiveShadow = true;
    this.scene.add(this.stlMesh);
    this._markDirty();
    return g.getAttribute("position").count;
  }

  clearSTL() {
    this.clearSurfaceLevels();
    if (!this.stlMesh) return;
    this.scene.remove(this.stlMesh);
    this.stlMesh.geometry.dispose();
    this.stlMesh.material.dispose();
    this.stlMesh = null;
    this._markDirty();
  }

  setSTLVisible(visible) {
    if (this.stlMesh) this.stlMesh.visible = visible;
    this._markDirty();
  }

  /**
   * An area-weighted uniform sample of world-space points over the mesh
   * surface — `density` points per m² on average, mirroring open3d's
   * sample_points_uniformly. Each triangle is chosen with probability
   * proportional to its area, then a uniformly-random point is taken inside
   * it via barycentric coordinates.
   */
  surfacePoints(density = 2000, maxPoints = 60000) {
    if (!this.stlMesh) return null;
    const pos = this.stlMesh.geometry.getAttribute("position");
    const triCount = pos.count / 3;
    if (triCount < 1) return { points: [] };

    const areas = new Float64Array(triCount);
    const va = new THREE.Vector3(), vb = new THREE.Vector3(), vc = new THREE.Vector3();
    const ab = new THREE.Vector3(), ac = new THREE.Vector3(), cross = new THREE.Vector3();
    let totalArea = 0;
    for (let t = 0; t < triCount; t++) {
      va.fromBufferAttribute(pos, t * 3);
      vb.fromBufferAttribute(pos, t * 3 + 1);
      vc.fromBufferAttribute(pos, t * 3 + 2);
      ab.subVectors(vb, va);
      ac.subVectors(vc, va);
      cross.crossVectors(ab, ac);
      const area = cross.length() * 0.5;
      areas[t] = area;
      totalArea += area;
    }

    const n = Math.min(maxPoints, Math.max(0, Math.round(density * totalArea)));
    const cdf = new Float64Array(triCount);
    let acc = 0;
    for (let t = 0; t < triCount; t++) { acc += areas[t]; cdf[t] = acc; }

    const points = new Array(n);
    for (let i = 0; i < n; i++) {
      const r = Math.random() * totalArea;
      // binary search for the first triangle whose cumulative area exceeds r
      let lo = 0, hi = triCount - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cdf[mid] < r) lo = mid + 1; else hi = mid;
      }
      const t = lo;
      va.fromBufferAttribute(pos, t * 3);
      vb.fromBufferAttribute(pos, t * 3 + 1);
      vc.fromBufferAttribute(pos, t * 3 + 2);
      let u = Math.random(), v = Math.random();
      if (u + v > 1) { u = 1 - u; v = 1 - v; }
      const x = va.x + u * (vb.x - va.x) + v * (vc.x - va.x);
      const y = va.y + u * (vb.y - va.y) + v * (vc.y - va.y);
      const z = va.z + u * (vb.z - va.z) + v * (vc.z - va.z);
      points[i] = [x, y, z];
    }
    return { points, totalArea };
  }

  /**
   * Colour the whole mesh from dB levels evaluated at a sparse sample of
   * surface points: every mesh vertex takes the value of its nearest sample
   * (via a kd-tree over `points`), so the full surface reads as painted
   * rather than just the evaluated points. Vertices whose nearest sample is
   * below the dynamic-range floor are made transparent instead of dim.
   */
  setSurfaceLevels(points, values, dynamicDb, colormap) {
    if (!this.stlMesh || !points.length) return;
    const lut = rgbLut(colormap);
    const tree = buildKdTree(points);
    const pos = this.stlMesh.geometry.getAttribute("position");
    const color = this.stlMesh.geometry.getAttribute("color");
    const total = color.count;
    for (let i = 0; i < total; i++) {
      const s = kdNearest(tree, points, pos.getX(i), pos.getY(i), pos.getZ(i));
      const v = values[s];
      const [r, g, b] = lutColor(lut, v, dynamicDb);
      const a = v < -dynamicDb ? 0 : 1;
      color.setXYZW(i, r, g, b, a);
    }
    color.needsUpdate = true;
    this._markDirty();
  }

  /** Reset the mesh to a neutral opaque grey (PSF painting switched off). */
  clearSurfaceLevels() {
    if (!this.stlMesh) return;
    const color = this.stlMesh.geometry.getAttribute("color");
    for (let i = 0; i < color.count; i++) color.setXYZW(i, 0.6, 0.6, 0.6, 1);
    color.needsUpdate = true;
    this._markDirty();
  }

  _markDirty() {}

  _animate() {
    this._raf = requestAnimationFrame(this._animate);
    this.controls.update();

    // Pulse source markers
    const s = 0.06 + 0.02 * Math.sin(performance.now() * 0.003);
    if (this.sourceMesh) this.sourceMesh.scale.setScalar(s);
    if (this._extraSprites) {
      for (const sp of this._extraSprites) if (sp.visible) sp.scale.setScalar(s * 0.85);
    }

    this.renderer.render(this.scene, this.camera);
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

// ── tiny 3-D kd-tree (nearest-neighbour only) ─────────────────────
// Used to propagate a sparse sample of evaluated surface points onto every
// mesh vertex, so setSurfaceLevels() can colour the whole STL surface.
function buildKdTree(points) {
  function build(indices, depth) {
    if (!indices.length) return null;
    const axis = depth % 3;
    indices.sort((a, b) => points[a][axis] - points[b][axis]);
    const mid = indices.length >> 1;
    return {
      idx: indices[mid],
      axis,
      left: build(indices.slice(0, mid), depth + 1),
      right: build(indices.slice(mid + 1), depth + 1),
    };
  }
  return build(points.map((_, i) => i), 0);
}

function kdNearest(root, points, x, y, z) {
  let best = -1, bestD2 = Infinity;
  const q = [x, y, z];
  (function visit(node) {
    if (!node) return;
    const p = points[node.idx];
    const dx = p[0] - x, dy = p[1] - y, dz = p[2] - z;
    const d2 = dx*dx + dy*dy + dz*dz;
    if (d2 < bestD2) { bestD2 = d2; best = node.idx; }
    const diff = q[node.axis] - p[node.axis];
    const near = diff < 0 ? node.left : node.right;
    const far  = diff < 0 ? node.right : node.left;
    visit(near);
    if (diff * diff < bestD2) visit(far);
  })(root);
  return best;
}
