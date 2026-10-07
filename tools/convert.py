#!/usr/bin/env python3
"""Convert the captured Mecabricks 75192 data into what the app loads.

    python3 tools/convert.py            # data/mecabricks-75192 -> public/sets/75192/

Writes set.json (colours, part types, every part with its transform, bags, steps)
and geo.bin (one mesh per part type, studs/tubes/pins baked in).
See data/README.md for the input format and the knowledge base (04-methods.md)
for how the steps are cut.
"""
import json, math, os, re, struct, sys, zipfile
from collections import Counter, defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# 'ldraw' (default, publishable): part shapes from the LDraw library, placed by data/ldraw-map.json.
# 'mecabricks': Mecabricks' own meshes — for local comparison only, never to be published (D-008).
SOURCE = 'mecabricks' if '--mecabricks' in sys.argv else 'ldraw'
# printed parts: real base colour and the LDraw print to use (see data/prints.json)
PRINTS = {k: v for k, v in json.load(open(os.path.join(ROOT, 'data', 'prints.json'))).items() if not k.startswith('_')}
SRC = os.path.join(ROOT, 'data', 'mecabricks-75192')
OUT = os.path.join(ROOT, 'public', 'sets', '75192')

# ---------------------------------------------------------------- geometry

def parse_geo(g):
    """Three.js JSON model format 3 -> (positions, normals, indices). Normals may be None."""
    V = g['vertices']; N = g.get('normals') or []; F = g['faces']
    layers = len(g.get('uvs') or [])
    pos, nor, idx, seen = [], [], [], {}
    have_normals = True

    def vert(vi, ni):
        key = (vi, ni)
        j = seen.get(key)
        if j is None:
            j = seen[key] = len(pos) // 3
            pos.extend(V[vi*3:vi*3+3])
            nor.extend(N[ni*3:ni*3+3] if ni is not None else (0, 0, 0))
        return j

    i = 0
    while i < len(F):
        t = F[i]; i += 1
        quad = t & 1; n = 4 if quad else 3
        vs = F[i:i+n]; i += n
        if t & 2: i += 1                      # material
        if t & 4: i += layers                 # face uv
        if t & 8: i += layers * n             # face-vertex uvs
        fn = None; vn = None
        if t & 16: fn = F[i]; i += 1
        if t & 32: vn = F[i:i+n]; i += n
        if t & 64: i += 1
        if t & 128: i += n
        ns = vn if vn is not None else ([fn]*n if fn is not None else [None]*n)
        if ns[0] is None: have_normals = False
        ids = [vert(vs[k], ns[k]) for k in range(n)]
        if quad:
            idx += [ids[0], ids[1], ids[3], ids[1], ids[2], ids[3]]
        else:
            idx += ids
    return pos, (nor if have_normals else None), idx


def quat_rotate(q, v):
    x, y, z, w = q
    vx, vy, vz = v
    # t = 2 * cross(q.xyz, v)
    tx = 2 * (y*vz - z*vy); ty = 2 * (z*vx - x*vz); tz = 2 * (x*vy - y*vx)
    return (vx + w*tx + (y*tz - z*ty), vy + w*ty + (z*tx - x*tz), vz + w*tz + (x*ty - y*tx))


def append(mesh, part, q=(0, 0, 0, 1), p=(0, 0, 0)):
    pos, nor, idx = mesh
    ppos, pnor, pidx = part
    base = len(pos) // 3
    for k in range(0, len(ppos), 3):
        x, y, z = quat_rotate(q, ppos[k:k+3])
        pos += [x + p[0], y + p[1], z + p[2]]
        nor += list(quat_rotate(q, pnor[k:k+3])) if pnor else [0, 0, 0]
    idx += [base + j for j in pidx]


def bezier(p0, p1, p2, p3, t):
    u = 1 - t
    return [u*u*u*p0[k] + 3*u*u*t*p1[k] + 3*u*t*t*p2[k] + t*t*t*p3[k] for k in range(3)]


def tube(curves, radius, radial=10, per_seg=24):
    """A hose: a tube along chained cubic bezier segments."""
    pts = []
    for seg in curves:
        p0, p1, p2, p3 = seg[0], seg[1], seg[2], seg[3]
        for s in range(per_seg + 1):
            if pts and s == 0: continue
            pts.append(bezier(p0, p1, p2, p3, s / per_seg))
    pos, nor, idx = [], [], []
    up = (0, 1, 0)
    for i, c in enumerate(pts):
        a = pts[max(i-1, 0)]; b = pts[min(i+1, len(pts)-1)]
        t = [b[k]-a[k] for k in range(3)]; tl = math.sqrt(sum(x*x for x in t)) or 1; t = [x/tl for x in t]
        ref = up if abs(t[1]) < 0.9 else (1, 0, 0)
        n1 = [ref[1]*t[2]-ref[2]*t[1], ref[2]*t[0]-ref[0]*t[2], ref[0]*t[1]-ref[1]*t[0]]
        l = math.sqrt(sum(x*x for x in n1)) or 1; n1 = [x/l for x in n1]
        n2 = [t[1]*n1[2]-t[2]*n1[1], t[2]*n1[0]-t[0]*n1[2], t[0]*n1[1]-t[1]*n1[0]]
        for r in range(radial):
            ang = 2*math.pi*r/radial
            nv = [math.cos(ang)*n1[k] + math.sin(ang)*n2[k] for k in range(3)]
            pos += [c[k] + radius*nv[k] for k in range(3)]; nor += nv
    for i in range(len(pts)-1):
        for r in range(radial):
            a = i*radial + r; b = i*radial + (r+1) % radial
            c = a + radial; d = b + radial
            idx += [a, c, b, b, c, d]
    return pos, nor, idx


def tube_radius(conf):
    r = 1.0
    for f in conf.get('design tree', []):
        if f.get('feature') == 'shape' and 'radius' in f: base = f['radius']
    for f in conf.get('design tree', []):
        if f.get('feature') == 'extrude':
            r = max(r, base * max(f.get('scale', [1, 1])))
    return r

def crease_normals(pos, idx, crease=35, face_rgb=None):
    """Split vertices where faces meet at more than `crease` degrees: hard edges on bricks,
    smooth shading on round parts. With face_rgb (one (r,g,b) or None per triangle) it also
    returns RGBA bytes per vertex: alpha 0 = the part's own colour, 255 = a printed colour."""
    cos_c = math.cos(math.radians(crease))
    fn = []
    for i in range(0, len(idx), 3):
        a, b, c = (pos[3*idx[i+k]:3*idx[i+k]+3] for k in range(3))
        u = [b[k]-a[k] for k in range(3)]; v = [c[k]-a[k] for k in range(3)]
        n = [u[1]*v[2]-u[2]*v[1], u[2]*v[0]-u[0]*v[2], u[0]*v[1]-u[1]*v[0]]
        l = math.sqrt(sum(x*x for x in n)) or 1
        fn.append((n[0]/l, n[1]/l, n[2]/l, l))      # unit normal and twice the area
    faces_of = defaultdict(list)
    for f in range(len(fn)):
        for k in range(3): faces_of[idx[3*f+k]].append(f)
    out_pos, out_nor, out_idx, out_col, seen = [], [], [], [], {}
    for f in range(len(fn)):
        nf = fn[f]
        fc = face_rgb[f] if face_rgb else None
        for k in range(3):
            vi = idx[3*f+k]
            acc = [0.0, 0.0, 0.0]
            for g in faces_of[vi]:
                ng = fn[g]
                if ng[0]*nf[0] + ng[1]*nf[1] + ng[2]*nf[2] >= cos_c:
                    for j in range(3): acc[j] += ng[j] * ng[3]
            l = math.sqrt(sum(x*x for x in acc)) or 1
            n = (round(acc[0]/l, 2), round(acc[1]/l, 2), round(acc[2]/l, 2))
            key = (vi, n, fc)
            j = seen.get(key)
            if j is None:
                j = seen[key] = len(out_pos) // 3
                out_pos.extend(pos[3*vi:3*vi+3]); out_nor.extend(n)
                out_col.extend((fc[0], fc[1], fc[2], 255) if fc else (0, 0, 0, 0))
            out_idx.append(j)
    if face_rgb:
        return out_pos, out_nor, out_idx, out_col
    return out_pos, out_nor, out_idx


def use_ldraw(types, meshes):
    """Swap every Mecabricks mesh for its LDraw part, turned and moved onto the same spot."""
    from ldraw import Library, load_colours
    mp = json.load(open(os.path.join(ROOT, 'data', 'ldraw-map.json')))
    prints = PRINTS
    lib = Library()
    ldcol = load_colours()

    def rgb(code):
        if code >= 0x2000000:
            v = code & 0xFFFFFF
            return (v >> 16, (v >> 8) & 255, v & 255)
        h = ldcol.get(code)
        return (int(h[1:3], 16), int(h[3:5], 16), int(h[5:7], 16)) if h else None
    missing = [t['ref'] for t in types if not t['flex'] and str(t['id']) not in mp]
    if missing:
        sys.exit(f'no LDraw match for {missing} — run tools/match_ldraw.py')
    done = {}
    for i, t in enumerate(types):
        if t['flex']:
            continue
        m = mp[str(t['id'])]
        pr = prints.get(t['ref'], {})
        part = pr.get('ldraw') or m['ldraw']
        key = (part, tuple(m['rot']), tuple(m['pos']))
        if key not in done:
            lpos, lidx, lcol = lib.mesh(part, colours=True)
            face_rgb = [None if c == 16 else rgb(c) for c in lcol] if pr.get('ldraw') else None
            R, p = m['rot'], m['pos']
            tp = []
            for j in range(0, len(lpos), 3):
                x, y, z = lpos[j:j+3]
                tp += [R[0]*x + R[1]*y + R[2]*z + p[0], R[3]*x + R[4]*y + R[5]*z + p[1], R[6]*x + R[7]*y + R[8]*z + p[2]]
            done[key] = list(crease_normals(tp, lidx, face_rgb=face_rgb))
        meshes[i] = done[key]
        t['ldraw'] = part
        if pr:
            t['print'] = pr['match']


# ---------------------------------------------------------------- steps

RANGE = re.compile(r'steps?\s*(\d+)(?:\s*-\s*(\d+))?', re.I)
MAX_PER_STEP = 8


def meca_types(model, z, extras_src):
    """Every part type in the model with its Mecabricks mesh (studs, tubes and pins baked in)."""
    lib = model['library']['official']
    L = model['file']['objects']['list']
    extras = {f'{cat}:{k}': parse_geo(v) for cat in ('knobs', 'tubes', 'pins') for k, v in extras_src[cat].items()}
    type_ids = sorted({str(o['5']) for o in L if o['1'] == 'part'}, key=int)
    meshes, types, confs = [], [], {}
    for t in type_ids:
        x = lib[t]['extra']
        if x['version'] == 2:
            conf = json.loads(z.read(f"configurations/2/{x['configuration']}"))
            gfile = f"geometries/2/{conf['geometry']['file']}" if x['type'] != 'flexible' else None
        else:
            m = x.get('mesh') or x['reference'] + '.json'
            cpath = f'configurations/1/{m}'
            conf = json.loads(z.read(cpath)) if cpath in z.namelist() else {}
            gfile = f'geometries/1/{m}'
        confs[t] = conf
        if gfile:
            mesh = list(parse_geo(json.loads(z.read(gfile))))
            if mesh[1] is None: mesh[1] = []
            ex = (conf.get('geometry') or {}).get('extras') or {}
            for cat in ('knobs', 'tubes', 'pins'):
                for e in ex.get(cat, []):
                    key = f"{cat}:{e['type']}"
                    if key in extras:
                        append(mesh, extras[key], e['transform']['quaternion'], e['transform']['position'])
        else:
            mesh = [[], [], []]   # flexible: one mesh per placed part, built in main()
        meshes.append(mesh)
        types.append({'id': int(t), 'ref': x['reference'], 'name': lib[t]['name'],
                      'flex': x['type'] == 'flexible'})
    return type_ids, types, meshes, confs


def main():
    model = json.load(open(os.path.join(SRC, 'model.json')))['data']
    mats = json.load(open(os.path.join(SRC, 'materials.json')))['data']
    extras_src = json.load(open(os.path.join(SRC, 'extras.json')))
    z = zipfile.ZipFile(os.path.join(SRC, 'geometries.zip'))
    lib = model['library']['official']
    L = model['file']['objects']['list']

    colors = {}
    for grp in mats:
        for m in grp['materials']:
            colors[str(m['reference'])] = {'name': m['name'], 'rgb': '#' + m['rgb'].lower(),
                                           'kind': grp['name'], 'legacy': m.get('legacy', False)}

    # ---- part types
    type_ids, types, meshes, confs = meca_types(model, z, extras_src)
    tindex = {t: i for i, t in enumerate(type_ids)}
    if SOURCE == 'ldraw':
        use_ldraw(types, meshes)

    # ---- parts
    def fallback_colour(ref, name):
        if ref in PRINTS: return PRINTS[ref]['color']
        if 'Head' in name: return 283
        return 194

    parts, part_of_obj = [], {}
    for oi, o in enumerate(L):
        if o['1'] != 'part': continue
        t = str(o['5']); ti = tindex[t]
        m = o['6']
        if types[ti]['flex']:
            curves = (o.get('10') or {}).get('11')
            conf = confs[t]
            if not curves:
                curves = conf['inputs']['v:1']['value']
            types.append({'id': int(t), 'ref': types[ti]['ref'], 'name': types[ti]['name'], 'flex': True, 'of': ti})
            meshes.append(list(tube(curves, tube_radius(conf))))
            ti = len(types) - 1
        col = o.get('8')
        decorated = col is None
        if decorated: col = fallback_colour(lib[t]['extra']['reference'], lib[t]['name'])
        part_of_obj[oi] = len(parts)
        parts.append({'t': ti, 'c': col, 'm': [round(m[k], 5) for k in (0, 1, 2, 4, 5, 6, 8, 9, 10, 12, 13, 14)],
                      'd': decorated})

    # bounding boxes per mesh, world centres per part
    for ti, mesh in enumerate(meshes):
        pos = mesh[0]
        if pos:
            mn = [min(pos[k::3]) for k in range(3)]; mx = [max(pos[k::3]) for k in range(3)]
        else:
            mn = mx = [0, 0, 0]
        types[ti]['bb'] = [round(v, 3) for v in mn + mx]

    def centre(p):
        bb = types[p['t']]['bb']; c = [(bb[k] + bb[k+3]) / 2 for k in range(3)]; m = p['m']
        return [m[0]*c[0] + m[3]*c[1] + m[6]*c[2] + m[9],
                m[1]*c[0] + m[4]*c[1] + m[7]*c[2] + m[10],
                m[2]*c[0] + m[5]*c[1] + m[8]*c[2] + m[11]]
    centres = [centre(p) for p in parts]

    # ---- steps
    # World boxes, so we can tell which parts touch.
    def world_box(p):
        bb = types[p['t']]['bb']; m = p['m']
        xs, ys, zs = [], [], []
        for cx in (bb[0], bb[3]):
            for cy in (bb[1], bb[4]):
                for cz in (bb[2], bb[5]):
                    xs.append(m[0]*cx + m[3]*cy + m[6]*cz + m[9])
                    ys.append(m[1]*cx + m[4]*cy + m[7]*cz + m[10])
                    zs.append(m[2]*cx + m[5]*cy + m[8]*cz + m[11])
        return (min(xs), min(ys), min(zs), max(xs), max(ys), max(zs))
    boxes = [world_box(p) for p in parts]
    TOL = 0.6
    CELL = 24.0

    def touches(a, b):
        A, B = boxes[a], boxes[b]
        return all(A[k] - TOL <= B[k+3] and B[k] - TOL <= A[k+3] for k in range(3))

    def cells(pid):
        B = boxes[pid]
        r = [range(int(math.floor((B[k] - TOL) / CELL)), int(math.floor((B[k+3] + TOL) / CELL)) + 1) for k in range(3)]
        return [(x, y, z) for x in r[0] for y in r[1] for z in r[2]]

    class Built:
        """Parts already in the model, bucketed in space for quick contact checks."""
        def __init__(self): self.grid = defaultdict(list)
        def add(self, pid):
            for c in cells(pid): self.grid[c].append(pid)
        def touching(self, pid):
            for c in cells(pid):
                for q in self.grid.get(c, ()):
                    if touches(pid, q): return True
            return False

    def dist(a, b):
        return math.sqrt(sum((a[k] - b[k]) ** 2 for k in range(3)))

    def grow(pids, built, n, wait=False):
        """Cut a block into steps the way a booklet would: each piece goes on something
        already built, the lowest and nearest first, and a step stays in one area.
        With wait=True, pieces that have nothing to sit on yet are returned instead of
        floating in mid-air, so a later block can place them once their support exists."""
        size = max(2, min(MAX_PER_STEP, math.ceil(len(pids) / max(1, n))))
        rest = set(pids)
        adj = {p: [q for q in pids if q != p and touches(p, q)] for p in pids}
        ok = {p: built.touching(p) for p in pids}
        steps, last = [], None
        while rest:
            cur = []
            while rest and len(cur) < size:
                cands = [p for p in rest if ok[p]]
                if not cands:
                    if cur: break                       # nothing connects: end the step here
                    if wait and built.grid: return steps, sorted(rest)
                    low = min(boxes[p][1] for p in rest)
                    cands = [p for p in rest if boxes[p][1] <= low + 1]
                ref = ([sum(centres[p][k] for p in cur) / len(cur) for k in range(3)] if cur else last)
                key = lambda p: (dist(centres[p], ref) if ref else 0) + 2.0 * boxes[p][1]
                pick = min(cands, key=key)
                if cur and dist(centres[pick], ref) > 64 and len(cur) >= size // 2:
                    break                               # too far away: start a new step there
                cur.append(pick); rest.discard(pick); built.add(pick)
                for q in adj[pick]: ok[q] = True
            if not cur: continue
            last = [sum(centres[p][k] for p in cur) / len(cur) for k in range(3)]
            steps.append(cur)
        return steps, []

    def descendants(oi):
        o = L[oi]
        if o['1'] == 'part': return [part_of_obj[oi]]
        out = []
        for c in o.get('0', []): out += descendants(c)
        return out

    def chunk_count(n, rng):
        if rng:
            a, b = rng; r = b - a + 1
            return max(math.ceil(n / MAX_PER_STEP), min(r, math.ceil(n / 3)))
        return math.ceil(n / 6)

    def base_type(p):
        t = parts[p]['t']
        return types[t].get('of', t)

    subs = []

    def blocks_of(gi, inherited):
        """[(key, block)] for a group; the key orders blocks inside a bag by booklet step number."""
        o = L[gi]
        mt = RANGE.search(o.get('2') or '')
        rng = (int(mt.group(1)), int(mt.group(2) or mt.group(1))) if mt else None
        key = rng[0] if rng else inherited
        end = rng[1] if rng else key
        out = []
        direct = [part_of_obj[c] for c in o.get('0', []) if L[c]['1'] == 'part']
        if direct:
            out.append((key, {'parts': direct, 'n': chunk_count(len(direct), rng)}))
        child_groups = [c for c in o.get('0', []) if L[c]['1'] != 'part']
        last = key
        handled = set()
        sig = lambda c: (L[c].get('2') or '', tuple((base_type(p), parts[p]['c']) for p in descendants(c)))
        for c in child_groups:
            if c in handled: continue
            name = L[c].get('2') or ''
            if RANGE.search(name):
                out += blocks_of(c, last)
                last = max(last, int(RANGE.search(name).group(1)))
                continue
            # an unnumbered group is a sub-assembly; identical siblings are built together (xN)
            copies = [d for d in child_groups if d not in handled and not RANGE.search(L[d].get('2') or '') and sig(d) == sig(c)]
            handled.update(copies)
            label = name if name and name != 'Group' else (f"{o.get('2')} sub-assembly" if o.get('2') else 'Sub-assembly')
            sid = len(subs); subs.append({'name': label, 'repeat': len(copies)})
            k = end + 0.5 if rng else last + 0.01
            out.append((k, {'sub': sid, 'copies': [descendants(d) for d in copies]}))
            last = k
        return out

    root = L[0]
    bags, steps = [], []
    built = Built()
    for bi, gi in enumerate(root['0']):
        name = L[gi].get('2') or f'Bag {bi+1}'
        blocks = sorted(blocks_of(gi, 0), key=lambda b: b[0])
        bags.append({'name': name, 'first': len(steps)})
        waiting = []
        for bk, (_, blk) in enumerate(blocks):
            if 'sub' in blk:
                copies = blk['copies']; first = copies[0]
                pos_in = {p: i for i, p in enumerate(first)}
                for chk in grow(first, Built(), math.ceil(len(first) / 6))[0]:
                    ids = [cp[pos_in[p]] for cp in copies for p in chk]
                    steps.append({'parts': ids, 'sub': blk['sub'], 'repeat': len(copies), 'bag': bi})
                steps.append({'parts': [], 'sub': blk['sub'], 'attach': True, 'repeat': len(copies), 'bag': bi})
                for cp in copies:
                    for p in cp: built.add(p)
            else:
                todo = blk['parts'] + waiting
                is_last = not any('sub' not in b for _, b in blocks[bk + 1:])
                chunks_, waiting = grow(todo, built, blk['n'] + math.ceil(len(waiting) / MAX_PER_STEP), wait=not is_last)
                for chk in chunks_:
                    steps.append({'parts': chk, 'bag': bi})
        if waiting:   # anything still unsupported at the end of a bag goes in last
            for chk in grow(waiting, built, math.ceil(len(waiting) / 6))[0]:
                steps.append({'parts': chk, 'bag': bi})
            waiting = []
        bags[-1]['count'] = len(steps) - bags[-1]['first']

    placed = Counter(p for s in steps for p in s['parts'])
    assert len(placed) == len(parts) and max(placed.values()) == 1, 'every part must be in exactly one step'

    # how many pieces go in touching nothing already built (sub-assemblies start on their own)
    check, floating, sub_seen = Built(), 0, set()
    for st in steps:
        new = st['parts']
        for p in new:
            if not check.touching(p) and not any(touches(p, q) for q in new if q != p):
                if st.get('sub') is None or st['sub'] in sub_seen: floating += 1
        for p in new: check.add(p)
        if st.get('sub') is not None: sub_seen.add(st['sub'])
    print(f'floating pieces: {floating} of {len(parts)}')

    step_of = [0] * len(parts)
    for si, s in enumerate(steps):
        for p in s['parts']: step_of[p] = si

    # ---- write
    os.makedirs(OUT, exist_ok=True)
    blob = bytearray(); geo = []
    for mesh in meshes:
        pos, nor, idx = mesh[:3]
        col = mesh[3] if len(mesh) > 3 else None
        n = len(pos) // 3
        po = len(blob); blob += struct.pack(f'<{len(pos)}f', *pos)
        if nor and len(nor) == len(pos):
            no = len(blob); blob += struct.pack(f'<{len(nor)}b', *[max(-127, min(127, round(v * 127))) for v in nor])
            while len(blob) % 4: blob.append(0)
        else:
            no = -1
        io = len(blob); blob += struct.pack(f'<{len(idx)}I', *idx)
        co = -1
        if col:
            co = len(blob); blob += bytes(col)
            while len(blob) % 4: blob.append(0)
        geo.append([po, n, no, io, len(idx), co])
    for t, g in zip(types, geo): t['g'] = g

    used = {str(p['c']) for p in parts}
    out = {
        'set': '75192', 'name': 'Millennium Falcon', 'pieces': len(parts),
        'source': 'https://www.mecabricks.com/en/models/87X2RWRqjZY',
        'colors': colors, 'used': sorted(used, key=int),
        'types': types,
        'parts': [[p['t'], p['c'], *p['m'], 1 if p['d'] else 0] for p in parts],
        'bags': bags, 'subs': subs,
        'steps': [{k: v for k, v in s.items()} for s in steps],
    }
    with open(os.path.join(OUT, 'set.json'), 'w') as f: json.dump(out, f, separators=(',', ':'))
    with open(os.path.join(OUT, 'geo.bin'), 'wb') as f: f.write(blob)
    sizes = [len(s['parts']) for s in steps if s['parts']]
    print(f"{len(parts)} parts, {len(types)} meshes, {len(steps)} steps "
          f"({len(subs)} sub-assemblies), parts/step median {sorted(sizes)[len(sizes)//2]} max {max(sizes)}")
    print('per bag:', [b['count'] for b in bags])
    print(f"geo.bin {len(blob)/1e6:.1f} MB, set.json {os.path.getsize(os.path.join(OUT, 'set.json'))/1e6:.1f} MB")


if __name__ == '__main__':
    main()
