#!/usr/bin/env python3
"""Write data/debug/compare.json: the weakest LDraw matches next to their Mecabricks meshes,
for tools/compare.html. Local review only — the Mecabricks meshes must not be published."""
import json, os, sys, zipfile
sys.path.insert(0, os.path.dirname(__file__))
import convert
from ldraw import Library

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
mp = json.load(open(os.path.join(ROOT, 'data', 'ldraw-map.json')))
model = json.load(open(os.path.join(convert.SRC, 'model.json')))['data']
z = zipfile.ZipFile(os.path.join(convert.SRC, 'geometries.zip'))
ids, types, meshes, _ = convert.meca_types(model, z, json.load(open(os.path.join(convert.SRC, 'extras.json'))))
lib = Library()

def diag(pos):
    xs, ys, zs = pos[0::3], pos[1::3], pos[2::3]
    return ((max(xs)-min(xs))**2 + (max(ys)-min(ys))**2 + (max(zs)-min(zs))**2) ** 0.5

rows = []
for t, info, (pos, _, idx) in zip(ids, types, meshes):
    if t in mp and pos:
        rows.append((mp[t]['err'] / max(diag(pos), 1), t, pos, idx))
rows.sort(reverse=True)
args = sys.argv[1:]
if args and args[0] == '--refs':
    args = args[1:]
    rows = [r for r in rows if mp[r[1]]['ref'] in args]
    want = len(rows)
else:
    want = int(args[0]) if args else 48
out = []
for rel, t, pos, idx in rows[:want]:
    m = mp[t]
    lpos, lidx = lib.mesh(m['ldraw'])
    R, p = m['rot'], m['pos']
    tp = []
    for i in range(0, len(lpos), 3):
        x, y, zz = lpos[i:i+3]
        tp += [round(R[0]*x + R[1]*y + R[2]*zz + p[0], 3), round(R[3]*x + R[4]*y + R[5]*zz + p[1], 3), round(R[6]*x + R[7]*y + R[8]*zz + p[2], 3)]
    out.append({'id': t, 'ref': m['ref'], 'name': m['name'], 'ldraw': m['ldraw'], 'desc': m['desc'], 'err': m['err'], 'rel': round(rel, 4),
                'meca': [pos, idx], 'ld': [tp, lidx]})
os.makedirs(os.path.join(ROOT, 'data', 'debug'), exist_ok=True)
json.dump(out, open(os.path.join(ROOT, 'data', 'debug', 'compare.json'), 'w'))
print(len(out), 'parts written')
