"""Read LDraw parts into triangle meshes.

    from ldraw import Library
    lib = Library()                          # ~/Documents/dev/tools/ldraw-lib/ldraw
    pos, idx = lib.mesh('3001')              # mm, Y up (three.js frame), outward winding

LDraw units are LDU (0.4 mm) with -Y up; a mesh is returned rotated 180 degrees about X and
scaled to millimetres, so it sits in the same frame as the rest of the app. Back-face culling
rules (BFC) are followed so every triangle winds counter-clockwise seen from outside; parts
that are not BFC-certified get both windings. Colours are ignored: a part is one colour.
"""
import os

LDRAW = os.path.expanduser('~/Documents/dev/tools/ldraw-lib/ldraw')
# parts still in review at LDraw (same CC BY licence) are used only when the official library lacks one
UNOFFICIAL = os.path.expanduser('~/Documents/dev/tools/ldraw-lib/unofficial')
LDU = 0.4


def det3(m):
    a, b, c, d, e, f, g, h, i = m
    return a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g)


class Library:
    def __init__(self, root=LDRAW, extra=UNOFFICIAL):
        self.root = root
        self.files = {}
        for base in (root, extra):
            for sub, prefix in (('parts', ''), ('p', ''), ('parts/s', 's/'), ('p/48', '48/'), ('p/8', '8/')):
                d = os.path.join(base, sub)
                if not os.path.isdir(d):
                    continue
                for f in os.listdir(d):
                    if f.lower().endswith('.dat'):
                        self.files.setdefault((prefix + f).lower(), os.path.join(d, f))
        self.cache = {}

    def has(self, name):
        return self.key(name) in self.files

    @staticmethod
    def key(name):
        n = name.strip().replace('\\', '/').lower()
        return n if n.endswith('.dat') else n + '.dat'

    def header(self, name):
        """The first line (the part's description) of a part file."""
        path = self.files.get(self.key(name))
        if not path:
            return None
        with open(path, encoding='utf-8', errors='replace') as f:
            first = f.readline().strip()
        return first[2:].strip() if first.startswith('0 ') else first

    def triangles(self, name):
        """Triangles of a file in its own LDU frame, wound CCW (outward). Cached per file."""
        k = self.key(name)
        if k in self.cache:
            return self.cache[k]
        path = self.files.get(k)
        if path is None:
            self.cache[k] = []
            return []
        tris = []
        certified, ccw, invert_next = False, True, False
        with open(path, encoding='utf-8', errors='replace') as f:
            for line in f:
                t = line.split()
                if not t:
                    continue
                if t[0] == '0':
                    if len(t) > 1 and t[1] == 'BFC':
                        words = [w.upper() for w in t[2:]]
                        if 'CERTIFY' in words:
                            certified = 'NOCERTIFY' not in words
                        if 'CW' in words:
                            ccw = False
                        if 'CCW' in words:
                            ccw = True
                        if 'INVERTNEXT' in words:
                            invert_next = True
                    continue
                if t[0] == '1' and len(t) >= 15:
                    x, y, z = map(float, t[2:5])
                    m = list(map(float, t[5:14]))
                    sub = ' '.join(t[14:])
                    flip = invert_next ^ (det3(m) < 0)
                    invert_next = False
                    for tri in self.triangles(sub):
                        pts = []
                        for (px, py, pz) in tri:
                            pts.append((m[0] * px + m[1] * py + m[2] * pz + x,
                                        m[3] * px + m[4] * py + m[5] * pz + y,
                                        m[6] * px + m[7] * py + m[8] * pz + z))
                        tris.append(tuple(pts) if not flip else (pts[0], pts[2], pts[1]))
                    continue
                if t[0] in ('3', '4'):
                    n = int(t[0])
                    v = list(map(float, t[2:2 + 3 * n]))
                    pts = [tuple(v[3 * i:3 * i + 3]) for i in range(n)]
                    polys = [pts] if n == 3 else [[pts[0], pts[1], pts[2]], [pts[0], pts[2], pts[3]]]
                    for p in polys:
                        if not certified:
                            tris.append((p[0], p[1], p[2]))
                            tris.append((p[0], p[2], p[1]))
                        elif ccw:
                            tris.append((p[0], p[1], p[2]))
                        else:
                            tris.append((p[0], p[2], p[1]))
                    invert_next = False
        self.cache[k] = tris
        return tris

    def mesh(self, name):
        """Welded mesh in mm, three.js frame: (positions flat list, triangle index list)."""
        seen, pos, idx = {}, [], []
        for tri in self.triangles(name):
            for (x, y, z) in tri:
                p = (round(x * LDU, 3), round(-y * LDU, 3), round(-z * LDU, 3))
                j = seen.get(p)
                if j is None:
                    j = seen[p] = len(pos) // 3
                    pos.extend(p)
                idx.append(j)
        # a 180-degree turn about X is a proper rotation, so LDraw's outward winding is kept
        return pos, idx


def signed_volume(pos, idx):
    v = 0.0
    for i in range(0, len(idx), 3):
        a, b, c = (pos[3 * idx[i + k]:3 * idx[i + k] + 3] for k in range(3))
        v += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6
    return v


if __name__ == '__main__':
    import sys
    lib = Library()
    for name in sys.argv[1:] or ['3001']:
        pos, idx = lib.mesh(name)
        xs, ys, zs = pos[0::3], pos[1::3], pos[2::3]
        print(name, lib.header(name), f'{len(idx)//3} tris',
              f'x {min(xs):.1f}..{max(xs):.1f} y {min(ys):.1f}..{max(ys):.1f} z {min(zs):.1f}..{max(zs):.1f}',
              f'volume {signed_volume(pos, idx):.0f} mm3')
