# Brick Builder

Build LEGO sets in 3D, step by step, with a booklet we generate ourselves.
First set: **75192 UCS Millennium Falcon** — 7,562 parts in 1,494 steps over 17 bags.

Three ways to build, switchable at any time (top bar or Settings):

- **Click to advance** — each step's pieces drop into place. ▶ / → / Space.
- **Pick & place** — drag each piece from the tray onto the model; it snaps in when it is close.
- **Free build** — take any part in any colour from the bin and place it anywhere (studs snap
  to the grid, R rotates, right-click removes, Cmd-Z undoes). Pieces that match the step
  still count towards it.

## Run it

```bash
npm install
npm run convert     # data/mecabricks-75192 -> public/sets/75192 (needs the captured data)
npm run dev         # http://localhost:5173
```

The model data is not in the repo: it is another Mecabricks user's model
(https://www.mecabricks.com/en/models/87X2RWRqjZY), captured into `data/mecabricks-75192/`
— see `data/README.md`.

## How it is made

- `tools/convert.py` turns the Mecabricks data into `set.json` (colours, part types, every
  part's transform, bags, steps) and `geo.bin` (one mesh per part type, studs baked in).
  It also cuts the steps: each piece goes in only once something it sits on is built,
  lowest and nearest first, and repeated sub-assemblies (six landing feet) are built together.
- `src/viewer.js` draws finished parts as instanced meshes (about 770 draw calls for the
  whole ship), the parts being worked on one by one, ghosts, and the booklet pictures.
- `src/main.js` holds the three modes, the booklet panel and the settings.

## Checks

```bash
node tools/test-modes.mjs <dir>      # drives all three modes with real mouse input
node tools/shot.mjs out.png --js "lego.go(40)"
node tools/capture_record.mjs        # the project record's screenshots
```
