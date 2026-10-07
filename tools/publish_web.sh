#!/usr/bin/env bash
## Publish Brick Builder to GitHub Pages -> https://juslangit.github.io/brick-builder/
##   ./tools/publish_web.sh
## 1. converts the set with LDraw part shapes (never Mecabricks' own meshes — D-008)
## 2. refuses to go on if any part mesh did not come from LDraw
## 3. builds with Vite and force-pushes dist/ to the gh-pages branch
## Needs GITHUB_TOKEN in ~/.claude/.env.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source "$HOME/.claude/.env"; set +a
VER="$(git rev-parse --short HEAD)$(git diff --quiet || echo -dirty)"

echo "== convert (LDraw shapes)"
python3 tools/convert.py
python3 - <<'PY'
import json, sys
s = json.load(open('public/sets/75192/set.json'))
bad = [t['ref'] for t in s['types'] if not (t.get('ldraw') or t.get('flex'))]
if bad:
    sys.exit(f'not publishing: {len(bad)} part meshes are not from LDraw: {bad[:10]}')
print(f"ok: {sum(1 for t in s['types'] if t.get('ldraw'))} LDraw parts, {sum(1 for t in s['types'] if t.get('flex'))} generated hoses")
PY

echo "== build ($VER)"
npm run build > /dev/null

echo "== GitHub Pages"
TMP="$(mktemp -d)"
cp -R dist/. "$TMP/" && touch "$TMP/.nojekyll"
git -C "$TMP" init -q -b gh-pages
git -C "$TMP" -c user.email=luqmanh1891@gmail.com -c user.name=juslangit add -A
git -C "$TMP" -c user.email=luqmanh1891@gmail.com -c user.name=juslangit commit -q -m "Web build $VER"
git -C "$TMP" -c "credential.helper=!f() { echo username=juslangit; echo password=$GITHUB_TOKEN; }; f" \
	push -q -f https://github.com/juslangit/brick-builder.git gh-pages
rm -rf "$TMP"
echo "done: $VER is going live at https://juslangit.github.io/brick-builder/ (takes a minute or two)"
