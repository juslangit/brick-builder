# data

`mecabricks-75192/` (git-ignored) — the 75192 UCS Millennium Falcon from
https://www.mecabricks.com/en/models/87X2RWRqjZY, captured 2026-10-07 from the
Mecabricks editor while signed in as juslangit.

- `model.json` — the editor's `api/workshop/model/load` response. `data.file.objects.list`
  is a flat list; `"1"` is the kind (scene/group/part), `"0"` the child indices, `"2"` a group's
  name, `"5"` a part's library id, `"6"` its 4x4 transform (column-major), `"8"` its LEGO colour id.
  `data.library.official[id].extra.reference` is the LEGO part number (e.g. `3023`).
- `geometries.zip` — the meshes for every part type (Three.js JSON format 3), plus
  `configurations/` with stud/connection points.

7,562 parts, 429 part types, 28 colours, grouped Bag 1–17 with step groups inside
(e.g. "75192 / Steps 1 - 31").
