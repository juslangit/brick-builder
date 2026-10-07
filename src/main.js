import * as THREE from 'three';
import './style.css';
import { loadSet, callout, firstCopy } from './set.js';
import { Viewer } from './viewer.js';
import { loadSettings, saveSettings, loadProgress, saveProgress, SNAP_PX } from './store.js';

const $ = (s) => document.querySelector(s);
const settings = loadSettings();
let set, viewer, progress;
let bookletPage = 0, bookletFollow = true;
let trayTab = 'step', freeColor = 194, freeRot = 0, trayQuery = '';
let hold = null; // { type, base, color, fromTray, sticky, snapped, target, free }
let lastFramedStep = -1;

// ------------------------------------------------------------------ boot
async function boot() {
  set = await loadSet(settings.set, (f) => {
    $('#load-fill').style.width = `${Math.round(f * 100)}%`;
    $('#load-text').textContent = `Opening the box… ${Math.round(f * 100)}%`;
  });
  $('#load-text').textContent = 'Sorting the pieces…';
  await new Promise((r) => setTimeout(r, 30));
  progress = loadProgress(set.set);
  progress.step = Math.min(Math.max(0, progress.step | 0), set.steps.length);

  viewer = new Viewer($('#stage'), set, settings);
  viewer.onFrame = processThumbQueue;
  window.lego = { set, viewer, settings, go, state: () => ({ ...progress, mode: settings.mode }) }; // for tests and the console

  $('#set-number').textContent = set.set;
  $('#set-name').textContent = set.name;
  $('#set-pieces').textContent = `${set.pieces.toLocaleString()} pieces`;
  $('#step-total').textContent = set.steps.length;
  $('#step-input').max = set.steps.length;
  $('#bag-select').innerHTML = set.bags.map((b, i) => `<option value="${i}">${b.name}</option>`).join('');

  renderFreeParts();
  bindUi();
  applySettings();
  refresh({ animate: false, frame: true });
  $('#loading').remove();
}

// ------------------------------------------------------------------ state helpers
const stepCount = () => set.steps.length;
const currentStep = () => set.steps[progress.step];
const placedSet = () => new Set(progress.placed);
const unplaced = () => (currentStep()?.parts ?? []).filter((id) => !placedSet().has(id));

function save() {
  saveProgress(set.set, progress);
}

function go(step, { animate = true } = {}) {
  step = Math.max(0, Math.min(stepCount(), step));
  if (step === progress.step) return;
  cancelHold();
  progress.step = step;
  progress.placed = [];
  save();
  refresh({ animate });
}

function next() {
  if (progress.step >= stepCount()) return;
  go(progress.step + 1);
}

function prev() {
  go(progress.step - 1, { animate: false });
}

// ------------------------------------------------------------------ drawing the build
function refresh({ animate = false, frame = true } = {}) {
  const s = currentStep();
  const done = !s;
  const inSub = s && s.sub != null && !s.attach;
  const subFrom = inSub ? set.subStart[s.sub] : progress.step;

  viewer.showBase(subFrom, inSub);
  const solid = [];
  for (let k = subFrom; k < progress.step; k++) solid.push(...set.steps[k].parts);
  if (s) {
    if (settings.mode === 'advance') solid.push(...s.parts);
    else solid.push(...progress.placed);
  }
  viewer.setSolid(solid, { animate: animate && settings.mode === 'advance' });
  updateGhosts();

  if (frame && settings.autoCamera && s && lastFramedStep !== progress.step) {
    lastFramedStep = progress.step;
    let ids = s.parts;
    if (inSub || s.attach) {
      // a repeated sub-assembly is framed on its first copy, the way the booklet shows it
      ids = [];
      for (let k = set.subStart[s.sub]; k <= progress.step; k++) ids.push(...firstCopy(set.steps[k]));
    }
    if (ids.length) viewer.frameIds(ids, { minSize: inSub ? 40 : 110, scale: inSub ? 2.2 : 1.8 });
  }
  if (done && frame) viewer.frameAll();

  // step bar
  $('#step-input').value = Math.min(progress.step + 1, stepCount());
  $('#bag-select').value = s ? s.bag : set.bags.length - 1;
  const placedParts = (s ? partsBefore(progress.step) : set.parts.length) + (settings.mode === 'advance' ? 0 : progress.placed.length);
  const pct = Math.round((placedParts / set.parts.length) * 100);
  $('#progress-fill').style.width = pct + '%';
  $('#progress-text').textContent = `${placedParts.toLocaleString()} / ${set.parts.length.toLocaleString()} pieces · ${pct}%`;
  $('#btn-next').disabled = done;
  $('#btn-prev').disabled = progress.step === 0;

  $('#finished').hidden = !(done && !progress.finishedSeen);
  $('#fin-count').textContent = set.parts.length.toLocaleString();

  updateHint();
  renderTray();
  if (bookletFollow) bookletPage = s ? set.pageOfStep[progress.step] : set.pages.length - 1;
  renderBooklet();
}

let partsBeforeCache = null;
function partsBefore(step) {
  if (!partsBeforeCache) {
    partsBeforeCache = new Int32Array(stepCount() + 1);
    set.steps.forEach((s, i) => (partsBeforeCache[i + 1] = partsBeforeCache[i] + s.parts.length));
  }
  return partsBeforeCache[step];
}

function updateGhosts() {
  const s = currentStep();
  if (!s || settings.mode === 'advance' || settings.hints === 'off') return viewer.setGhosts([]);
  let ids = unplaced();
  if (hold) ids = ids.filter((id) => matches(id, hold));
  else if (settings.hints === 'holding') ids = [];
  viewer.setGhosts(ids);
}

function updateHint() {
  const s = currentStep();
  const el = $('#hint');
  if (!s) return (el.textContent = 'All done — the whole set is built');
  const sub = s.sub != null ? set.subs[s.sub] : null;
  const subName = sub ? `${sub.name}${sub.repeat > 1 ? ` ×${sub.repeat}` : ''}` : '';
  if (s.attach) return (el.textContent = `${subName} is finished — it goes in where you built it`);
  const where = sub ? `Building: ${subName} · ` : '';
  const n = firstCopy(s).length, times = s.repeat > 1 ? ` (×${s.repeat})` : '';
  if (settings.mode === 'advance') el.textContent = `${where}${n} new piece${n === 1 ? '' : 's'}${times} — press ▶ for the next step`;
  else if (settings.mode === 'pick') el.textContent = hold ? 'Move it to its spot — it snaps in when it is close' : `${where}Drag each piece from the tray onto the model (${unplaced().length} left)`;
  else el.textContent = hold ? (hold.free ? 'Click to put it down · R rotates · Esc puts it back' : 'Click near a blue ghost to fit it, or anywhere to place it') : `${where}Free build — take any part from the bin. Parts that match the step count towards it`;
}

// ------------------------------------------------------------------ tray (pick & place, free build)
function renderTray() {
  const tray = $('#tray');
  const show = settings.mode !== 'advance' && currentStep() || settings.mode === 'free';
  tray.hidden = !show;
  if (!show) return;
  const free = settings.mode === 'free';
  $('#tray-tabs').hidden = !free;
  $('#tray-search').hidden = !(free && trayTab === 'all');
  $('#palette').hidden = !(free && trayTab === 'all');
  const items = $('#tray-items');
  let groups;
  if (!free || trayTab === 'step') {
    groups = callout(set, unplaced()).map((g) => ({ ...g, free: false }));
  } else {
    const q = trayQuery.trim().toLowerCase();
    const seen = new Set();
    groups = [];
    set.types.forEach((t, i) => {
      if (t.of != null || t.flex || seen.has(t.ref)) return;
      seen.add(t.ref);
      if (q && !(t.name.toLowerCase().includes(q) || t.ref.toLowerCase().includes(q))) return;
      groups.push({ type: i, base: i, color: freeColor, count: null, free: true, name: t.name });
    });
    groups = groups.slice(0, 160);
  }
  items.innerHTML = '';
  for (const g of groups) {
    const el = document.createElement('div');
    el.className = 'part';
    const t = set.types[g.type];
    el.title = `${t.name} (${t.ref}) — ${set.colors[g.color]?.name ?? ''}`;
    el.innerHTML = `<img alt="">${g.count ? `<span class="n">${g.count}x</span>` : ''}<span class="ref">${t.ref}</span>`;
    queueThumb(el.querySelector('img'), g.type, g.color, 112);
    if (hold && hold.base === g.base && hold.color === g.color) el.classList.add('held');
    el.addEventListener('pointerdown', (e) => startHold(e, g, el));
    items.appendChild(el);
  }
}

function renderPalette() {
  const pal = $('#palette');
  pal.innerHTML = '';
  for (const id of set.used) {
    const c = set.colors[id];
    if (!c) continue;
    const b = document.createElement('button');
    b.style.background = c.rgb;
    b.title = c.name;
    if (+id === freeColor) b.classList.add('on');
    b.onclick = () => {
      freeColor = +id;
      renderPalette();
      renderTray();
    };
    pal.appendChild(b);
  }
}

// thumbnails are rendered a few per frame so the page never stalls
const thumbQueue = [];
function queueThumb(img, type, color, size) {
  thumbQueue.push({ img, type, color, size });
}
function processThumbQueue() {
  const t0 = performance.now();
  while (thumbQueue.length && performance.now() - t0 < 8) {
    const { img, type, color, size } = thumbQueue.shift();
    if (!img.isConnected) continue;
    img.src = viewer.thumb(type, color, size);
  }
}

// ------------------------------------------------------------------ holding a part
const matches = (id, h) => {
  const p = set.parts[id];
  return (set.types[p.type].of ?? p.type) === h.base && p.color === h.color;
};

function startHold(e, g, el) {
  e.preventDefault();
  if (hold && hold.base === g.base && hold.color === g.color) return cancelHold();
  cancelHold();
  hold = { type: g.type, base: g.base, color: g.color, el, sticky: false, free: g.free, x0: e.clientX, y0: e.clientY, moved: false };
  el.classList.add('held');
  viewer.setHeld(g.type, g.color);
  viewer.controls.enabled = false;
  viewer.held.visible = false;
  updateGhosts();
  updateHint();
  const up = (ev) => {
    window.removeEventListener('pointerup', up);
    if (!hold) return;
    if (!hold.moved) {
      hold.sticky = true; // a click picks it up; the next click on the model puts it down
      viewer.controls.enabled = true;
      return;
    }
    drop(ev);
  };
  window.addEventListener('pointerup', up);
}

function cancelHold(shake = false) {
  if (!hold) return;
  if (shake) {
    hold.el?.classList.remove('shake');
    void hold.el?.offsetWidth;
    hold.el?.classList.add('shake');
  }
  hold.el?.classList.remove('held');
  hold = null;
  viewer.setHeld(null);
  viewer.controls.enabled = true;
  updateGhosts();
  updateHint();
}

function onPointerMove(e) {
  if (!hold) return;
  if (Math.hypot(e.clientX - hold.x0, e.clientY - hold.y0) > 6) hold.moved = true;
  const overTray = e.target.closest?.('.tray, .stepbar, #booklet, .top');
  viewer.held.visible = !overTray;
  if (overTray) return;
  positionHeld(e.clientX, e.clientY);
}

function nearestTarget(x, y) {
  let best = null, bestD = Infinity;
  for (const id of unplaced()) {
    if (!matches(id, hold)) continue;
    const s = viewer.toScreen(set.parts[id].centre);
    if (s.behind) continue;
    const d = Math.hypot(s.x - x, s.y - y);
    if (d < bestD) (bestD = d), (best = id);
  }
  return { id: best, d: bestD };
}

function positionHeld(x, y) {
  const near = currentStep() ? nearestTarget(x, y) : { id: null, d: Infinity };
  hold.snapped = near.id != null && near.d < SNAP_PX[settings.snap];
  hold.target = near.id;
  if (hold.snapped) {
    const p = set.parts[near.id];
    if (set.parts[near.id].type !== hold.type) {
      viewer.setHeld(p.type, hold.color);
      hold.type = p.type;
    }
    viewer.placeHeld(p.matrix, true);
    return;
  }
  const rc = viewer.ray(x, y);
  if (settings.mode === 'free') {
    hold.freeMatrix = freePlacement(rc);
    viewer.placeHeld(hold.freeMatrix, false);
    return;
  }
  // pick & place: float the part under the cursor at the depth of its nearest spot
  const ref = near.id != null ? set.parts[near.id] : null;
  const depth = ref ? viewer.camera.position.distanceTo(ref.centre) : viewer.camera.position.distanceTo(viewer.controls.target);
  const point = rc.ray.at(depth, new THREE.Vector3());
  const m = ref ? ref.matrix.clone() : new THREE.Matrix4();
  const centreOffset = ref ? ref.centre.clone().sub(new THREE.Vector3().setFromMatrixPosition(ref.matrix)) : new THREE.Vector3();
  m.setPosition(point.sub(centreOffset));
  viewer.placeHeld(m, false);
}

function drop(e) {
  if (!hold) return;
  if (e.target.closest?.('.tray, .stepbar, #booklet, .top')) return cancelHold(true);
  if (hold.snapped && hold.target != null) {
    place(hold.target);
    const keep = settings.mode === 'free' || hold.sticky;
    const g = { type: hold.type, base: hold.base, color: hold.color, free: hold.free };
    cancelHold();
    // keep holding the same kind of part if more of it are needed
    if (keep && unplaced().some((id) => matches(id, g))) reHold(g);
    return;
  }
  if (settings.mode === 'free' && hold.freeMatrix) {
    addFreePart(hold.type, hold.color, hold.freeMatrix);
    if (!hold.sticky) cancelHold();
    return;
  }
  cancelHold(true);
}

function reHold(g) {
  renderTray();
  const el = [...document.querySelectorAll('#tray-items .part')].find((x) => x.classList.contains('held')) ?? null;
  hold = { ...g, el, sticky: true, moved: true, x0: 0, y0: 0 };
  viewer.setHeld(g.type, g.color);
  updateGhosts();
  updateHint();
}

function place(id) {
  if (progress.placed.includes(id)) return;
  progress.placed.push(id);
  save();
  viewer.setSolid([...viewer.solid.keys(), id]);
  viewer.flash(id);
  refresh({ frame: false });
  if (!unplaced().length) stepComplete();
}

function stepComplete() {
  toast(`Step ${progress.step + 1} done!`);
  if (settings.autoAdvance) setTimeout(() => progress.placed.length && !unplaced().length && next(), 650);
}

// ------------------------------------------------------------------ free build
function freePlacement(rc) {
  const targets = [...viewer.groups.filter((m) => m.visible), viewer.layer, viewer.freeLayer, viewer.floor];
  const hit = rc.intersectObjects(targets, true)[0];
  const point = hit ? hit.point : rc.ray.at(400, new THREE.Vector3());
  const geo = set.geometries[hold.type];
  const rot = new THREE.Matrix4().makeRotationY((freeRot * Math.PI) / 2);
  const box = geo.boundingBox.clone().applyMatrix4(rot);
  const size = box.getSize(new THREE.Vector3());
  const snap = (v, extent) => {
    const odd = Math.round(extent / 8) % 2 === 1;
    return Math.round((v - (odd ? 4 : 0)) / 8) * 8 + (odd ? 4 : 0);
  };
  const x = snap(point.x, size.x) - (box.min.x + box.max.x) / 2;
  const z = snap(point.z, size.z) - (box.min.z + box.max.z) / 2;
  const y = point.y - box.min.y;
  return new THREE.Matrix4().makeTranslation(x, y, z).multiply(rot);
}

function addFreePart(type, color, matrix) {
  progress.free.push({ t: type, c: color, m: matrix.toArray().map((v) => Math.round(v * 1000) / 1000) });
  save();
  renderFreeParts();
}

function renderFreeParts() {
  viewer.freeLayer.clear();
  progress.free.forEach((f, i) => {
    const mesh = new THREE.Mesh(set.geometries[f.t], viewer.solidMat[f.c]);
    mesh.matrixAutoUpdate = false;
    mesh.matrix.fromArray(f.m);
    mesh.userData.free = i;
    viewer.freeLayer.add(mesh);
  });
}

function removeFreeAt(x, y) {
  const hit = viewer.ray(x, y).intersectObjects(viewer.freeLayer.children, false)[0];
  if (!hit) return false;
  progress.free.splice(hit.object.userData.free, 1);
  save();
  renderFreeParts();
  return true;
}

// ------------------------------------------------------------------ booklet
function renderBooklet() {
  if (settings.booklet === 'hidden') return;
  const page = set.pages[bookletPage];
  const body = $('#bk-body');
  $('#bk-page').textContent = `· page ${bookletPage + 1} of ${set.pages.length}`;
  $('#bk-prev').disabled = bookletPage === 0;
  $('#bk-next').disabled = bookletPage >= set.pages.length - 1;
  const onCurrent = page.kind === 'step' ? page.step === progress.step : currentStep()?.bag === page.bag && set.bags[page.bag].first === progress.step;
  $('#bk-follow').hidden = bookletFollow || onCurrent;
  $('#bk-build').hidden = onCurrent || (page.kind === 'step' && page.step === progress.step);
  body.innerHTML = '';
  const el = document.createElement('div');
  el.className = 'page' + (onCurrent ? ' current' : '');
  if (page.kind === 'bag') {
    const b = set.bags[page.bag];
    const ids = [];
    for (let k = b.first; k < b.first + b.count; k++) ids.push(...set.steps[k].parts);
    const groups = callout(set, ids);
    el.classList.add('bagpage');
    el.innerHTML = `<div class="bagicon">${page.bag + 1}</div><h2>Open ${b.name}</h2>
      <p class="muted">${ids.length} pieces · ${b.count} steps</p><div class="callout"></div>`;
    const co = el.querySelector('.callout');
    for (const g of groups) co.appendChild(calloutItem(g, 64));
  } else {
    const s = set.steps[page.step];
    const sub = s.sub != null ? set.subs[s.sub] : null;
    el.innerHTML = `<div class="bagtag">Bag ${s.bag + 1}</div><div class="stepno">${page.step + 1}</div>`;
    const holder = sub && !s.attach ? document.createElement('div') : el;
    if (sub && !s.attach) {
      holder.className = 'subframe';
      holder.innerHTML = `<div class="sublabel">${sub.name}${sub.repeat > 1 ? `<span class="repeat">×${sub.repeat}</span>` : ''}</div>`;
      el.appendChild(holder);
    }
    if (s.parts.length) {
      const co = document.createElement('div');
      co.className = 'callout';
      // a repeated sub-assembly lists the pieces for one copy, as booklets do
      const groups = callout(set, s.parts).map((g) => ({ ...g, count: g.count / (s.repeat || 1) }));
      for (const g of groups) co.appendChild(calloutItem(g, 80));
      holder.appendChild(co);
    }
    if (s.attach) {
      const a = document.createElement('div');
      a.className = 'attach';
      a.textContent = `${sub.name}${sub.repeat > 1 ? ` ×${sub.repeat}` : ''} goes in place`;
      el.appendChild(a);
    }
    const img = document.createElement('img');
    img.className = 'shot';
    img.alt = `Step ${page.step + 1}`;
    holder.appendChild(img);
    requestAnimationFrame(() => img.isConnected && (img.src = viewer.snapshot(page.step)));
  }
  const pn = document.createElement('div');
  pn.className = 'pnum';
  pn.textContent = bookletPage + 1;
  el.appendChild(pn);
  body.appendChild(el);
  body.scrollTop = 0;
}

function calloutItem(g, size) {
  const d = document.createElement('div');
  d.className = 'ci';
  const t = set.types[g.type];
  d.title = `${t.name} (${t.ref}) — ${set.colors[g.color]?.name ?? ''}`;
  d.innerHTML = `<img alt=""><b>${g.count}x</b>`;
  queueThumb(d.querySelector('img'), g.type, g.color, size * 2 > 160 ? 160 : size * 2);
  return d;
}

function turnPage(delta) {
  bookletPage = Math.max(0, Math.min(set.pages.length - 1, bookletPage + delta));
  const p = set.pages[bookletPage];
  bookletFollow = p.kind === 'step' ? p.step === progress.step : false;
  renderBooklet();
}

// ------------------------------------------------------------------ settings + ui
function applySettings() {
  document.querySelectorAll('.modes button').forEach((b) => b.classList.toggle('on', b.dataset.mode === settings.mode));
  $('#main').className = `booklet-${settings.booklet}`;
  document.body.classList.toggle('dark', settings.background === 'dark');
  viewer.applyBackground();
  viewer.setQuality(settings.quality);
  viewer.resize();
  const f = $('#settings form');
  for (const [k, v] of Object.entries(settings)) {
    const input = f.elements[k];
    if (!input) continue;
    if (input.type === 'checkbox') input.checked = v;
    else input.value = v;
  }
  renderPalette();
}

function changeSetting(k, v) {
  settings[k] = v;
  saveSettings(settings);
  cancelHold();
  if (k === 'mode') progress.placed = settings.mode === 'advance' ? [] : progress.placed;
  applySettings();
  refresh({ frame: false });
  if (k === 'booklet' && v !== 'hidden') renderBooklet();
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1500);
}

function bindUi() {
  document.querySelectorAll('.modes button').forEach((b) => (b.onclick = () => changeSetting('mode', b.dataset.mode)));
  $('#btn-next').onclick = next;
  $('#btn-prev').onclick = prev;
  $('#btn-frame').onclick = () => viewer.frameAll();
  $('#btn-booklet').onclick = () => changeSetting('booklet', settings.booklet === 'hidden' ? 'right' : 'hidden');
  $('#btn-settings').onclick = () => $('#settings').showModal();
  $('#step-input').onchange = (e) => go((+e.target.value || 1) - 1, { animate: false });
  $('#bag-select').onchange = (e) => go(set.bags[+e.target.value].first, { animate: false });
  $('#bk-prev').onclick = () => turnPage(-1);
  $('#bk-next').onclick = () => turnPage(1);
  $('#bk-follow').onclick = () => {
    bookletFollow = true;
    bookletPage = currentStep() ? set.pageOfStep[progress.step] : set.pages.length - 1;
    renderBooklet();
  };
  $('#bk-build').onclick = () => {
    const p = set.pages[bookletPage];
    bookletFollow = true;
    go(p.kind === 'step' ? p.step : set.bags[p.bag].first, { animate: false });
  };
  $('#fin-close').onclick = () => {
    progress.finishedSeen = true;
    save();
    $('#finished').hidden = true;
  };

  const form = $('#settings form');
  form.addEventListener('change', (e) => {
    const el = e.target;
    changeSetting(el.name, el.type === 'checkbox' ? el.checked : el.value);
  });
  $('#btn-reset').onclick = () => {
    if (!confirm('Start the set again from step 1? Your free-build parts are removed too.')) return;
    progress = { step: 0, placed: [], free: [] };
    save();
    renderFreeParts();
    lastFramedStep = -1;
    $('#settings').close();
    refresh({ frame: true });
  };

  $('#tray-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    trayTab = b.dataset.tab;
    document.querySelectorAll('#tray-tabs button').forEach((x) => x.classList.toggle('on', x === b));
    renderTray();
  });
  $('#tray-search').addEventListener('input', (e) => {
    trayQuery = e.target.value;
    renderTray();
  });

  window.addEventListener('pointermove', onPointerMove);
  const canvas = viewer.renderer.domElement;
  let down = null;
  canvas.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY, b: e.button }));
  canvas.addEventListener('pointerup', (e) => {
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) return (down = null);
    down = null;
    if (hold?.sticky) drop(e);
  });
  canvas.addEventListener('contextmenu', (e) => {
    if (settings.mode !== 'free') return;
    e.preventDefault();
    if (hold) return cancelHold();
    removeFreeAt(e.clientX, e.clientY);
  });

  window.addEventListener('keydown', (e) => {
    if (e.target.closest('input, select, dialog')) return;
    if (e.key === 'ArrowRight' || (e.key === ' ' && settings.mode === 'advance')) (e.preventDefault(), next());
    else if (e.key === 'ArrowLeft') prev();
    else if (e.key === 'Escape') cancelHold();
    else if (e.key === 'b' || e.key === 'B') changeSetting('booklet', settings.booklet === 'hidden' ? 'right' : 'hidden');
    else if (e.key === 'f' || e.key === 'F') viewer.frameAll();
    else if (e.key === 'h' || e.key === 'H') changeSetting('hints', { always: 'holding', holding: 'off', off: 'always' }[settings.hints]);
    else if ((e.key === 'r' || e.key === 'R') && hold) {
      freeRot = (freeRot + 1) % 4;
      if (hold.lastX != null) positionHeld(hold.lastX, hold.lastY);
    } else if ((e.key === 'z' || e.key === 'Z') && (e.metaKey || e.ctrlKey) && settings.mode === 'free' && progress.free.length) {
      progress.free.pop();
      save();
      renderFreeParts();
    }
  });
  window.addEventListener('pointermove', (e) => hold && ((hold.lastX = e.clientX), (hold.lastY = e.clientY)));
}

boot().catch((err) => {
  console.error(err);
  $('#load-text').textContent = `Could not open the set: ${err.message}. Run "npm run convert" first.`;
});
