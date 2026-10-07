// Loads a converted set (public/sets/<id>/set.json + geo.bin) into Three.js geometry.
import * as THREE from 'three';

async function fetchBuffer(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body || !total) return res.arrayBuffer();
  // content-length can be the compressed size (GitHub Pages gzips), so collect chunks of any size
  // and use it only for the progress bar
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onProgress?.(Math.min(0.99, got / total));
  }
  const out = new Uint8Array(got);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out.buffer;
}

export async function loadSet(id, onProgress) {
  const base = `${import.meta.env.BASE_URL}sets/${id}/`;
  const [json, bin] = await Promise.all([
    fetch(base + 'set.json').then((r) => r.json()),
    fetchBuffer(base + 'geo.bin', onProgress),
  ]);

  const geometries = json.types.map((t) => {
    const [po, n, no, io, ni] = t.g;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(bin, po, n * 3), 3));
    g.setIndex(new THREE.BufferAttribute(new Uint32Array(bin, io, ni), 1));
    if (no >= 0) g.setAttribute('normal', new THREE.BufferAttribute(new Int8Array(bin, no, n * 3), 3, true));
    else if (n) g.computeVertexNormals();
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  });

  const parts = json.parts.map((row, id) => {
    const m = row.slice(2, 14);
    const matrix = new THREE.Matrix4().fromArray([m[0], m[1], m[2], 0, m[3], m[4], m[5], 0, m[6], m[7], m[8], 0, m[9], m[10], m[11], 1]);
    const type = row[0];
    const centre = new THREE.Vector3();
    geometries[type].boundingBox.getCenter(centre).applyMatrix4(matrix);
    return { id, type, color: row[1], decorated: !!row[14], matrix, centre };
  });

  const stepOf = new Int32Array(parts.length);
  json.steps.forEach((s, i) => s.parts.forEach((p) => (stepOf[p] = i)));

  // where each sub-assembly starts, so a sub step knows which earlier steps belong to it
  const subStart = {};
  json.steps.forEach((s, i) => {
    if (s.sub != null && subStart[s.sub] == null) subStart[s.sub] = i;
  });

  // booklet pages: a bag page before each bag, then its steps
  const pages = [];
  json.bags.forEach((b, bi) => {
    pages.push({ kind: 'bag', bag: bi });
    for (let s = b.first; s < b.first + b.count; s++) pages.push({ kind: 'step', step: s });
  });
  const pageOfStep = new Int32Array(json.steps.length);
  pages.forEach((p, i) => p.kind === 'step' && (pageOfStep[p.step] = i));

  return { ...json, geometries, parts, stepOf, subStart, pages, pageOfStep };
}

/** The parts of one copy of a step; a repeated sub-assembly (×N) lists copy 1 first. */
export function firstCopy(step) {
  const n = step.repeat || 1;
  return n > 1 ? step.parts.slice(0, step.parts.length / n) : step.parts;
}

/** Parts of a step (or any list of ids) grouped for a callout: [{type, color, count, ids}] */
export function callout(set, ids) {
  const groups = new Map();
  for (const id of ids) {
    const p = set.parts[id];
    const base = set.types[p.type].of ?? p.type;
    const key = `${base}|${p.color}`;
    if (!groups.has(key)) groups.set(key, { type: p.type, base, color: p.color, count: 0, ids: [] });
    const g = groups.get(key);
    g.count++;
    g.ids.push(id);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || a.base - b.base);
}
