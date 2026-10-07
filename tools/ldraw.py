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


def load_colours(root=LDRAW):
    """LDraw colour code -> '#rrggbb', from LDConfig.ldr."""
    table = {}
    path = os.path.join(root, 'LDConfig.ldr')
    if os.path.exists(path):
        for line in open(path, encoding='utf-8', errors='replace'):
            t = line.split()
            if len(t) > 6 and t[1] == '!COLOUR' and 'CODE' in t and 'VALUE' in t:
                table[int(t[t.index('CODE') + 1])] = t[t.index('VALUE') + 1].lower()
    return table


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
        """Triangles (p0, p1, p2, colour) of a file in its own LDU frame, wound CCW (outward).
        Colour 16 is the part's own colour; printed areas carry their LDraw colour code.
        Cached per file."""
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
                    col = int(t[1]) if t[1].lstrip('-').isdigit() else (int(t[1], 16) if t[1].startswith('0x') else 16)
                    x, y, z = map(float, t[2:5])
                    m = list(map(float, t[5:14]))
                    sub = ' '.join(t[14:])
                    flip = invert_next ^ (det3(m) < 0)
                    invert_next = False
                    for tri in self.triangles(sub):
                        pts = []
                        for (px, py, pz) in tri[:3]:
                            pts.append((m[0] * px + m[1] * py + m[2] * pz + x,
                                        m[3] * px + m[4] * py + m[5] * pz + y,
                                        m[6] * px + m[7] * py + m[8] * pz + z))
                        c = tri[3] if tri[3] not in (16, 24) else col
                        tris.append((pts[0], pts[1], pts[2], c) if not flip else (pts[0], pts[2], pts[1], c))
                    continue
                if t[0] in ('3', '4'):
                    n = int(t[0])
                    col = int(t[1]) if t[1].lstrip('-').isdigit() else (int(t[1], 16) if t[1].startswith('0x') else 16)
                    v = list(map(float, t[2:2 + 3 * n]))
                    pts = [tuple(v[3 * i:3 * i + 3]) for i in range(n)]
                    polys = [pts] if n == 3 else [[pts[0], pts[1], pts[2]], [pts[0], pts[2], pts[3]]]
                    for p in polys:
                        if not certified:
                            tris.append((p[0], p[1], p[2], col))
                            tris.append((p[0], p[2], p[1], col))
                        elif ccw:
                            tris.append((p[0], p[1], p[2], col))
                        else:
                            tris.append((p[0], p[2], p[1], col))
                    invert_next = False
        self.cache[k] = tris
        return tris

    def mesh(self, name, colours=False):
        """Welded mesh in mm, three.js frame: (positions flat list, triangle index list), plus
        with colours=True a list of one LDraw colour code per triangle (16 = the part's colour)."""
        seen, pos, idx, cols = {}, [], [], []
        for tri in self.triangles(name):
            cols.append(tri[3])
            for (x, y, z) in tri[:3]:
                p = (round(x * LDU, 3), round(-y * LDU, 3), round(-z * LDU, 3))
                j = seen.get(p)
                if j is None:
                    j = seen[p] = len(pos) // 3
                    pos.extend(p)
                idx.append(j)
        # a 180-degree turn about X is a proper rotation, so LDraw's outward winding is kept
        return (pos, idx, cols) if colours else (pos, idx)


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
