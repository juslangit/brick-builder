// The 3D view: the finished part of the model as instanced meshes, the parts being
// worked on as single meshes, ghosts for where parts go, and off-screen renders for
// the booklet pictures and part thumbnails.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { firstCopy } from './set.js';

const BOOKLET_DIR = new THREE.Vector3(-1, 0.95, 1.25).normalize();
const BOOKLET_BG = new THREE.Color('#dbe7f3');

const ease = (t) => 1 - Math.pow(1 - t, 3);
const bounce = (t) => {
  const n = 7.5625, d = 2.75;
  if (t < 1 / d) return n * t * t;
  if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75;
  if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375;
  return n * (t -= 2.625 / d) * t + 0.984375;
};

export class Viewer {
  constructor(container, set, settings) {
    this.set = set;
    this.settings = settings;
    this.container = container;
    this.tweens = [];
    this.printGeo = new Map(); // printed parts, per colour (geoFor / matFor)
    this.printMat = new Map();

    const r = (this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: false }));
    r.setPixelRatio(Math.min(devicePixelRatio, settings.quality === 'fast' ? 1 : 2));
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.05;
    container.appendChild(r.domElement);

    this.scene = new THREE.Scene();
    const pm = new THREE.PMREMGenerator(r);
    this.scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(-300, 800, 500);
    this.scene.add(sun, new THREE.HemisphereLight(0xffffff, 0x8899aa, 0.5));

    this.camera = new THREE.PerspectiveCamera(35, 1, 2, 20000);
    this.controls = new OrbitControls(this.camera, r.domElement);
    this.controls.enableDamping = true;
    this.controls.zoomToCursor = true;
    this.controls.screenSpacePanning = true;
    this.controls.maxDistance = 6000;

    this.buildMaterials();
    this.buildModel();
    this.buildGround();
    this.applyBackground();

    this.solid = new Map(); // id -> mesh, parts drawn one by one
    this.ghosts = new Map();
    this.layer = new THREE.Group();
    this.ghostLayer = new THREE.Group();
    this.freeLayer = new THREE.Group();
    this.scene.add(this.layer, this.ghostLayer, this.freeLayer);

    this.thumbCache = new Map();
    this.snapCache = new Map();

    const box = this.modelBox;
    const c = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3()).length();
    this.controls.target.copy(c);
    this.camera.position.copy(c).addScaledVector(BOOKLET_DIR, size * 1.1);

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    r.setAnimationLoop(() => this.frame());
  }

  // ------------------------------------------------------------ setup
  buildMaterials() {
    this.instMat = {};
    this.solidMat = {};
    for (const [id, c] of Object.entries(this.set.colors)) {
      const make = () => {
        const m = new THREE.MeshStandardMaterial({ color: c.rgb, roughness: 0.32, metalness: 0 });
        if (c.kind === 'transparent') Object.assign(m, { transparent: true, opacity: 0.55, roughness: 0.05 });
        if (c.kind === 'chrome' || c.kind === 'metal') Object.assign(m, { metalness: 0.9, roughness: 0.2 });
        if (c.kind === 'pearlescent') Object.assign(m, { metalness: 0.55, roughness: 0.3 });
        if (c.kind === 'rubber') Object.assign(m, { roughness: 0.8 });
        m.userData.base = { transparent: m.transparent, opacity: m.opacity };
        return m;
      };
      this.instMat[id] = make();
      this.solidMat[id] = make();
    }
    this.ghostMat = new THREE.MeshStandardMaterial({
      color: '#4aa3ff', transparent: true, opacity: 0.28, depthWrite: false, roughness: 0.4, emissive: '#1d5fa8', emissiveIntensity: 0.35,
    });
    this.heldGlow = new THREE.Color('#ffd400');
  }

  /** The geometry for a part in a colour: printed parts get their print colours baked in. */
  geoFor(type, color) {
    const g = this.set.geometries[type];
    if (!g.userData.printed) return g;
    const key = `${type}|${color}`;
    if (!this.printGeo.has(key)) {
      const c = g.clone();
      const pr = g.getAttribute('print');
      const base = new THREE.Color(this.set.colors[color]?.rgb ?? '#888888');
      const tmp = new THREE.Color();
      const arr = new Float32Array(pr.count * 3);
      for (let i = 0; i < pr.count; i++) {
        const col = pr.getW(i) === 0 ? base : tmp.setRGB(pr.getX(i) / 255, pr.getY(i) / 255, pr.getZ(i) / 255, THREE.SRGBColorSpace);
        arr[i * 3] = col.r;
        arr[i * 3 + 1] = col.g;
        arr[i * 3 + 2] = col.b;
      }
      c.setAttribute('color', new THREE.BufferAttribute(arr, 3));
      this.printGeo.set(key, c);
    }
    return this.printGeo.get(key);
  }

  /** The material for a part: printed parts take their colours from the geometry. */
  matFor(type, color, kind = 'solid') {
    const base = (kind === 'inst' ? this.instMat : this.solidMat)[color];
    if (!this.set.geometries[type].userData.printed) return base;
    const key = `${kind}|${color}`;
    if (!this.printMat.has(key)) {
      const m = base.clone();
      m.color.set('#ffffff');
      m.vertexColors = true;
      m.userData.base = base.userData.base;
      this.printMat.set(key, m);
    }
    return this.printMat.get(key);
  }

  buildModel() {
    const { parts, geometries, stepOf } = this.set;
    const groups = new Map();
    for (const p of parts) {
      const key = `${p.type}|${p.color}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(p.id);
    }
    this.groups = [];
    this.modelBox = new THREE.Box3();
    this.model = new THREE.Group();
    for (const [key, ids] of groups) {
      ids.sort((a, b) => stepOf[a] - stepOf[b]);
      const [type, color] = key.split('|');
      const mesh = new THREE.InstancedMesh(this.geoFor(+type, +color), this.matFor(+type, +color, 'inst'), ids.length);
      ids.forEach((id, i) => mesh.setMatrixAt(i, parts[id].matrix));
      mesh.computeBoundingSphere();
      mesh.computeBoundingBox();
      this.modelBox.union(mesh.boundingBox);
      mesh.userData.ids = ids;
      mesh.userData.steps = ids.map((id) => stepOf[id]);
      this.groups.push(mesh);
      this.model.add(mesh);
    }
    this.scene.add(this.model);
  }

  buildGround() {
    const size = this.modelBox.getSize(new THREE.Vector3());
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(128, 128, 10, 128, 128, 128);
    grad.addColorStop(0, 'rgba(0,0,0,0.28)');
    grad.addColorStop(0.6, 'rgba(0,0,0,0.08)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 256, 256);
    const tex = new THREE.CanvasTexture(c);
    const r = Math.max(size.x, size.z) * 0.85;
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(r * 2, r * 2), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
    this.ground.rotation.x = -Math.PI / 2;
    const ctr = this.modelBox.getCenter(new THREE.Vector3());
    this.ground.position.set(ctr.x, this.modelBox.min.y - 0.5, ctr.z);
    this.groundY = this.modelBox.min.y;
    this.scene.add(this.ground);
    // an invisible plane the free-build mode can place parts on
    this.floor = new THREE.Mesh(new THREE.PlaneGeometry(20000, 20000), new THREE.MeshBasicMaterial({ visible: false }));
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.position.y = this.groundY;
    this.scene.add(this.floor);
  }

  applyBackground() {
    const dark = this.settings.background === 'dark';
    this.scene.background = new THREE.Color(dark ? '#1b1f27' : '#eef2f6');
    this.ground.material.opacity = dark ? 0.6 : 1;
  }

  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = w + 'px';
    this.renderer.domElement.style.height = h + 'px';
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setQuality(q) {
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, q === 'fast' ? 1 : 2));
    this.resize();
  }

  // ------------------------------------------------------------ what is drawn
  /** Show every part whose step is below `limit` as part of the model; hide it while a sub-assembly is built. */
  showBase(limit, hide = false) {
    for (const mesh of this.groups) {
      const steps = mesh.userData.steps;
      let lo = 0, hi = steps.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (steps[mid] < limit) lo = mid + 1;
        else hi = mid;
      }
      mesh.count = lo;
      mesh.visible = lo > 0 && !hide;
    }
  }

  makeMesh(id, material) {
    const p = this.set.parts[id];
    const mesh = material
      ? new THREE.Mesh(this.set.geometries[p.type], material)
      : new THREE.Mesh(this.geoFor(p.type, p.color), this.matFor(p.type, p.color));
    mesh.matrixAutoUpdate = false;
    mesh.matrix.copy(p.matrix);
    mesh.userData.id = id;
    return mesh;
  }

  /** Draw exactly these parts one by one. New ones can drop in. */
  setSolid(ids, { animate = false } = {}) {
    const want = new Set(ids);
    for (const [id, mesh] of this.solid) {
      if (!want.has(id)) {
        this.layer.remove(mesh);
        this.solid.delete(id);
      }
    }
    let n = 0;
    const speed = this.settings.animation === 'slow' ? 2 : 1;
    for (const id of ids) {
      if (this.solid.has(id)) continue;
      const mesh = this.makeMesh(id);
      this.solid.set(id, mesh);
      this.layer.add(mesh);
      if (animate && this.settings.animation !== 'off') this.drop(mesh, n++ * 70 * speed, speed);
    }
  }

  drop(mesh, delay, speed = 1) {
    const target = mesh.matrix.clone();
    const height = 60;
    mesh.matrix.copy(target).premultiply(new THREE.Matrix4().makeTranslation(0, height, 0));
    mesh.visible = false;
    this.tween(450 * speed, (t) => {
      mesh.visible = true;
      const y = height * (1 - bounce(t));
      mesh.matrix.copy(target).premultiply(new THREE.Matrix4().makeTranslation(0, y, 0));
    }, delay);
  }

  /** A short glow on a part that has just gone in. */
  flash(id) {
    const mesh = this.solid.get(id);
    if (!mesh) return;
    const mat = mesh.material.clone();
    mesh.material = mat;
    mat.emissive = new THREE.Color('#ffd400');
    const p = this.set.parts[id];
    this.tween(500, (t) => (mat.emissiveIntensity = 0.8 * (1 - t)), 0, () => (mesh.material = this.matFor(p.type, p.color)));
  }

  setGhosts(ids) {
    const want = new Set(ids);
    for (const [id, mesh] of this.ghosts) {
      if (!want.has(id)) {
        this.ghostLayer.remove(mesh);
        this.ghosts.delete(id);
      }
    }
    for (const id of ids) {
      if (this.ghosts.has(id)) continue;
      const mesh = this.makeMesh(id, this.ghostMat);
      mesh.renderOrder = 2;
      this.ghosts.set(id, mesh);
      this.ghostLayer.add(mesh);
    }
  }

  // ------------------------------------------------------------ the part in your hand
  setHeld(type, color) {
    if (this.held) this.scene.remove(this.held);
    this.held = null;
    if (type == null) return;
    const mat = this.matFor(type, color).clone();
    mat.emissive = this.heldGlow.clone();
    mat.emissiveIntensity = 0;
    this.held = new THREE.Mesh(this.geoFor(type, color), mat);
    this.held.matrixAutoUpdate = false;
    this.held.renderOrder = 3;
    this.scene.add(this.held);
  }

  placeHeld(matrix, snapped) {
    if (!this.held) return;
    this.held.matrix.copy(matrix);
    this.held.material.emissiveIntensity = snapped ? 0.45 : 0;
  }

  // ------------------------------------------------------------ geometry helpers
  ray(clientX, clientY) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    const rc = new THREE.Raycaster();
    rc.setFromCamera(ndc, this.camera);
    return rc;
  }

  toScreen(v) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const p = v.clone().project(this.camera);
    return { x: rect.left + ((p.x + 1) / 2) * rect.width, y: rect.top + ((1 - p.y) / 2) * rect.height, behind: p.z > 1 };
  }

  boxOf(ids) {
    const box = new THREE.Box3();
    const tmp = new THREE.Box3();
    for (const id of ids) {
      const p = this.set.parts[id];
      tmp.copy(this.set.geometries[p.type].boundingBox).applyMatrix4(p.matrix);
      box.union(tmp);
    }
    return box;
  }

  /** Move the camera so these parts fill the view, keeping the current viewing direction. */
  frameIds(ids, { minSize = 90, scale = 1.6, instant = false } = {}) {
    if (!ids.length) return;
    const box = this.boxOf(ids);
    const centre = box.getCenter(new THREE.Vector3());
    const size = Math.max(box.getSize(new THREE.Vector3()).length(), minSize);
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    const dist = (size * scale) / (2 * Math.tan((this.camera.fov * Math.PI) / 360));
    const toPos = centre.clone().addScaledVector(dir, dist);
    const fromPos = this.camera.position.clone(), fromT = this.controls.target.clone();
    if (instant || this.settings.animation === 'off') {
      this.camera.position.copy(toPos);
      this.controls.target.copy(centre);
      return;
    }
    this.tween(650, (t) => {
      const k = ease(t);
      this.camera.position.lerpVectors(fromPos, toPos, k);
      this.controls.target.lerpVectors(fromT, centre, k);
    });
  }

  frameAll() {
    const all = this.set.parts.map((p) => p.id);
    this.frameIds(all, { scale: 1.1 });
  }

  // ------------------------------------------------------------ off-screen renders
  renderTo(scene, camera, w, h, background) {
    const rt = new THREE.WebGLRenderTarget(w, h, { samples: 4, colorSpace: THREE.SRGBColorSpace });
    const r = this.renderer;
    const prevBg = scene.background;
    const prevClear = r.getClearAlpha();
    scene.background = background;
    r.setClearAlpha(background ? 1 : 0);
    r.setRenderTarget(rt);
    r.clear();
    r.render(scene, camera);
    r.setClearAlpha(prevClear);
    const px = new Uint8Array(w * h * 4);
    r.readRenderTargetPixels(rt, 0, 0, w, h, px);
    r.setRenderTarget(null);
    scene.background = prevBg;
    rt.dispose();
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(w, h);
    for (let y = 0; y < h; y++) img.data.set(px.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
    ctx.putImageData(img, 0, 0);
    return c;
  }

  /** A part on its own, for callouts and the parts bin. */
  thumb(type, color, size = 112) {
    const key = `${type}|${color}|${size}`;
    if (this.thumbCache.has(key)) return this.thumbCache.get(key);
    if (!this.thumbScene) {
      this.thumbScene = new THREE.Scene();
      this.thumbScene.environment = this.scene.environment;
      const sun = new THREE.DirectionalLight(0xffffff, 1.3);
      sun.position.set(-1, 2, 1.5);
      this.thumbScene.add(sun, new THREE.HemisphereLight(0xffffff, 0x8899aa, 0.6));
      this.thumbCam = new THREE.PerspectiveCamera(25, 1, 1, 5000);
    }
    const geo = this.set.geometries[type];
    const mesh = new THREE.Mesh(this.geoFor(type, color), this.matFor(type, color));
    this.thumbScene.add(mesh);
    const s = geo.boundingSphere;
    const dist = (s.radius * 1.15) / Math.sin((this.thumbCam.fov * Math.PI) / 360);
    this.thumbCam.position.copy(s.center).addScaledVector(new THREE.Vector3(-1, 1.1, 1.3).normalize(), dist);
    this.thumbCam.lookAt(s.center);
    const canvas = this.renderTo(this.thumbScene, this.thumbCam, size, size, null);
    this.thumbScene.remove(mesh);
    const url = canvas.toDataURL();
    this.thumbCache.set(key, url);
    return url;
  }

  /** The booklet picture for a step: the model as it is after that step, framed on the new parts. */
  snapshot(stepIndex, w = 560, h = 400) {
    const key = `${stepIndex}|${w}x${h}`;
    if (this.snapCache.has(key)) return this.snapCache.get(key);
    const { steps, subStart } = this.set;
    const step = steps[stepIndex];
    const saved = this.groups.map((m) => [m.count, m.visible]);
    const hidden = [this.layer, this.ghostLayer, this.freeLayer, this.held].filter(Boolean);
    hidden.forEach((o) => (o.visible = false));

    const temp = new THREE.Group();
    let focus = step.parts;
    if (step.sub != null) {
      // a sub-assembly is drawn on its own, as in a printed booklet
      this.groups.forEach((m) => (m.visible = false));
      const ids = [];
      for (let s = subStart[step.sub]; s <= stepIndex; s++) ids.push(...firstCopy(steps[s]));
      ids.forEach((id) => temp.add(this.makeMesh(id)));
      focus = ids;
      if (step.attach) {
        this.showBase(stepIndex + 1, false);
        this.groups.forEach((m) => (m.visible = m.count > 0));
        temp.clear();
      }
    } else {
      this.showBase(stepIndex + 1, false);
    }
    this.scene.add(temp);

    const cam = new THREE.PerspectiveCamera(30, w / h, 2, 20000);
    const box = this.boxOf(focus);
    const centre = box.getCenter(new THREE.Vector3());
    const size = Math.max(box.getSize(new THREE.Vector3()).length(), step.sub != null && !step.attach ? 30 : 140);
    const dist = (size * 1.25) / (2 * Math.tan((cam.fov * Math.PI) / 360)) / Math.min(1, w / h);
    cam.position.copy(centre).addScaledVector(BOOKLET_DIR, dist);
    cam.lookAt(centre);
    this.ground.visible = false;
    const canvas = this.renderTo(this.scene, cam, w, h, BOOKLET_BG);
    this.ground.visible = true;

    this.scene.remove(temp);
    hidden.forEach((o) => (o.visible = true));
    this.groups.forEach((m, i) => ([m.count, m.visible] = saved[i]));
    const url = canvas.toDataURL('image/jpeg', 0.88);
    if (this.snapCache.size > 80) this.snapCache.delete(this.snapCache.keys().next().value);
    this.snapCache.set(key, url);
    return url;
  }

  // ------------------------------------------------------------ loop
  tween(ms, fn, delay = 0, done) {
    this.tweens.push({ t0: performance.now() + delay, ms, fn, done });
  }

  frame() {
    const now = performance.now();
    this.tweens = this.tweens.filter((tw) => {
      if (now < tw.t0) return true;
      const t = Math.min(1, (now - tw.t0) / tw.ms);
      tw.fn(t);
      if (t >= 1) tw.done?.();
      return t < 1;
    });
    this.onFrame?.();
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}
