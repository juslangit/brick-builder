#!/usr/bin/env python3
"""Find the LDraw part for every Mecabricks part type, and how it lines up.

    .venv/bin/python tools/match_ldraw.py            # writes data/ldraw-map.json

Mecabricks and LDraw put a part's origin and axes in different places. For each part type
this tries every LDraw candidate (the same number, the base number without Mecabricks'
v2/d123 suffixes, LDraw's a/b/c variants, a few known renames) in all 24 right-angle
orientations, slides it onto the Mecabricks mesh, and keeps the fit with the smallest mean
surface distance. The map is ours to publish; the Mecabricks meshes are not (D-008).
"""
import json, os, re, sys, zipfile
import numpy as np
from scipy.spatial import cKDTree

sys.path.insert(0, os.path.dirname(__file__))
import convert                                       # noqa: E402
from ldraw import Library                            # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'data', 'ldraw-map.json')

# Mecabricks numbers that LDraw files under another number
RENAMES = {
    '3814': ['973'], '3626': ['3626c', '3626b'], '30480': ['30480'], '20952': ['20952'],
    '4865': ['4865b', '4865a'], '4085': ['4085d', '4085c', '4085b'], '3839': ['3839b', '3839a'],
    '4599': ['4599b', '4599a'], '3794': ['3794b', '3794a'], '44301': ['44301b', '44301a'],
    '60475': ['60475b', '60475a'], '30359': ['30359b', '30359a'], '2654': ['2654b', '2654a'],
    '3957': ['3957b', '3957a'], '4285': ['4285b', '4285a'], '30367': ['30367c', '30367b', '30367a'],
    '2412': ['2412b', '2412a'], '4460': ['4460b', '4460a'], '30554': ['30554b', '30554a'],
    '3818': ['3818'], '3819': ['3819'], '3820': ['3820'], '14769': ['14769'], '3069': ['3069b'],
    '64567': ['64567', '577b'], '4697': ['4697b', '4697a'],
    '34462': ['20953', '37837'],
    # Chewbacca's bowcaster (crossbow with mini shooter) is in neither LDraw library; the plain
    # minifig crossbow stands in for it
    '20105': ['2570', '65510'], '26169': ['4865b', '4865a', '30010', '23969'],
}
# parts LDraw files under a number we could not find: let the shape fit pick from a family
SEARCH = {'21777': r'^0 Minifig Hair', '41822': r'^0 (Wing|Wedge|Plate) +(Plate +)?4 x +4'}


def rotations():
    out = []
    for perm in ((0, 1, 2), (0, 2, 1), (1, 0, 2), (1, 2, 0), (2, 0, 1), (2, 1, 0)):
        for sx in (1, -1):
            for sy in (1, -1):
                for sz in (1, -1):
                    m = np.zeros((3, 3))
                    for row, (col, sign) in enumerate(zip(perm, (sx, sy, sz))):
                        m[row, col] = sign
                    if np.linalg.det(m) > 0:
                        out.append(m)
    return out


ROTS = rotations()


def sample(pos, idx, n=4000, seed=1):
    """Points spread evenly over a mesh's surface."""
    P = np.asarray(pos, float).reshape(-1, 3)
    T = np.asarray(idx, int).reshape(-1, 3)
    if not len(T):
        return P
    a, b, c = P[T[:, 0]], P[T[:, 1]], P[T[:, 2]]
    area = np.linalg.norm(np.cross(b - a, c - a), axis=1) / 2
    if area.sum() <= 0:
        return P
    rng = np.random.default_rng(seed)
    pick = rng.choice(len(T), n, p=area / area.sum())
    u, v = rng.random(n), rng.random(n)
    flip = u + v > 1
    u[flip], v[flip] = 1 - u[flip], 1 - v[flip]
    return a[pick] + (b[pick] - a[pick]) * u[:, None] + (c[pick] - a[pick]) * v[:, None]


def kabsch(src, dst):
    """Rotation and translation moving points `src` onto matching points `dst`."""
    cs, cd = src.mean(0), dst.mean(0)
    U, _, Vt = np.linalg.svd((src - cs).T @ (dst - cd))
    D = np.diag([1, 1, np.sign(np.linalg.det(Vt.T @ U.T))])
    R = Vt.T @ D @ U.T
    return R, cd - R @ cs


def score(tm, meca, q):
    d1, _ = tm.query(q)
    d2, _ = cKDTree(q).query(meca)
    return (d1.mean() + d2.mean()) / 2


def fit(meca, ldr):
    """Best (error, R, t) placing LDraw points `ldr` onto Mecabricks points `meca`."""
    tm = cKDTree(meca)
    mc = (meca.min(0) + meca.max(0)) / 2
    msize = meca.max(0) - meca.min(0)
    trials = []
    # the orientations whose box matches best are always tried, even when nothing matches well
    best_size = min(np.abs((ldr @ R.T).max(0) - (ldr @ R.T).min(0) - msize).max() for R in ROTS)
    for R in ROTS:
        q = ldr @ R.T
        size = q.max(0) - q.min(0)
        R_size = np.abs(size - msize).max()
        if R_size > max(2.0, 0.15 * msize.max()) and R_size > best_size + 0.5:
            continue
        t = mc - (q.min(0) + q.max(0)) / 2
        for _ in range(4):   # slide into place
            d, i = tm.query(q + t)
            t = t + np.median(meca[i] - (q + t), axis=0)
        trials.append((score(tm, meca, q + t), R, t))
    if not trials:
        return (1e9, None, None)
    trials.sort(key=lambda x: x[0])
    best = trials[0]
    # parts Mecabricks keeps slightly turned (minifig arms, hands) need a free rotation:
    # refine the best few with ICP and keep it only when it really is closer
    for err0, R0, t0 in trials[:3]:
        R, t = R0.copy(), t0.copy()
        for _ in range(30):
            q = ldr @ R.T + t
            _, i = tm.query(q)
            dR, dt = kabsch(q, meca[i])
            R, t = dR @ R, dR @ t + dt
        err = score(tm, meca, ldr @ R.T + t)
        if err < best[0] - 0.02:
            best = (err, R, t)
    # a fit within 2 degrees of square is square: straighten it so parts meet cleanly
    err, R, t = best
    A = np.round(R)
    if abs(np.linalg.det(A) - 1) < 1e-6 and np.degrees(np.arccos(np.clip((np.trace(A.T @ R) - 1) / 2, -1, 1))) < 2:
        q = ldr @ A.T
        for _ in range(4):
            _, i = tm.query(q + t)
            t = t + np.median(meca[i] - (q + t), axis=0)
        best = (score(tm, meca, q + t), A, t)
    return best


def candidates(lib, ref):
    names = [ref]
    base = ref
    while re.search(r'(v\d+|d\d+|p\w+)$', base):
        base = re.sub(r'(v\d+|d\d+|p\w+)$', '', base)
    names += [base] + RENAMES.get(base, []) + [base + s for s in 'abcdef']
    if base in SEARCH:
        pat = re.compile(SEARCH[base], re.I)
        names += [k[:-4] for k in lib.files if '/' not in k and re.match(r'^[0-9]+[a-z]?\.dat$', k)
                  and pat.match('0 ' + (lib.header(k) or ''))]
    out = []
    for n in names:
        if n not in out and lib.has(n):
            out.append(n)
    return out


def main():
    src = convert.SRC
    model = json.load(open(os.path.join(src, 'model.json')))['data']
    z = zipfile.ZipFile(os.path.join(src, 'geometries.zip'))
    extras = json.load(open(os.path.join(src, 'extras.json')))
    type_ids, types, meshes, _ = convert.meca_types(model, z, extras)
    lib = Library()
    result, report = {}, []
    only = sys.argv[sys.argv.index('--refs') + 1:] if '--refs' in sys.argv else None
    if only and os.path.exists(OUT):
        result = json.load(open(OUT))
    for t, info, (pos, _, idx) in zip(type_ids, types, meshes):
        if info['flex'] or (only and info['ref'] not in only):
            continue
        meca = sample(pos, idx)
        best = None
        for c in candidates(lib, info['ref']):
            lpos, lidx = lib.mesh(c)
            if not lidx:
                continue
            err, R, tr = fit(meca, sample(lpos, lidx))
            if R is not None and (best is None or err < best[0]):
                best = (err, c, R, tr)
        if best is None:
            report.append((99, info['ref'], info['name'], '-'))
            continue
        err, c, R, tr = best
        result[t] = {'ref': info['ref'], 'name': info['name'], 'ldraw': c, 'desc': lib.header(c),
                     'rot': [round(float(v), 5) for v in R.flatten()], 'pos': tr.round(3).tolist(), 'err': round(float(err), 3)}
        report.append((err, info['ref'], info['name'], c))
    report.sort(reverse=True)
    print('worst fits (mean surface distance in mm):')
    for err, ref, name, c in report[:40]:
        print(f'  {err:6.2f}  {ref:12} {name[:40]:40} -> {c}')
    good = sum(1 for r in report if r[0] < 0.5)
    print(f'{len(result)} matched, {good} within 0.5 mm, {sum(1 for r in report if r[0] == 99)} without a candidate')
    json.dump(result, open(OUT, 'w'), indent=1)


if __name__ == '__main__':
    main()
