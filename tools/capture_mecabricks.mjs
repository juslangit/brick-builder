// Saves a Mecabricks model the way the Mecabricks editor itself downloads it.
//   node tools/capture_mecabricks.mjs [modelId] [outDir]
// Mecabricks' own File > Export has no LDraw any more and its .zmbx export hung for 10+ minutes
// on this model, so we keep what the editor loads: the scene (api/workshop/model/load), the
// meshes (api/workshop/model/downloadZip), the shared stud pieces (extras.json) and the colour
// table (api/materials). A real Chrome window opens with a persistent profile; sign in once
// (account juslangit) if Mecabricks asks. See data/README.md for the format.
import { chromium } from 'playwright-core';
import fs from 'fs';
import path from 'path';
const id = process.argv[2] || '87X2RWRqjZY';
const out = process.argv[3] || new URL('../data/mecabricks-75192/', import.meta.url).pathname;
const profile = path.join(process.env.HOME, 'Documents/dev/scratch/meca-export/profile');
fs.mkdirSync(out, { recursive: true });
const ctx = await chromium.launchPersistentContext(profile, { channel: 'chrome', headless: false, viewport: { width: 1400, height: 900 } });
const page = ctx.pages()[0] || (await ctx.newPage());
const want = [
  [/\/api\/workshop\/model\/load/, 'model.json'],
  [/\/api\/workshop\/model\/downloadZip/, 'geometries.zip'],
  [/\/shared\/extras\.json/, 'extras.json'],
  [/\/api\/materials/, 'materials.json'],
];
const got = new Set();
page.on('response', async (r) => {
  for (const [re, name] of want) {
    if (!re.test(r.url())) continue;
    try {
      fs.writeFileSync(path.join(out, name), await r.body());
      got.add(name);
      console.log('saved', name);
    } catch (e) {
      console.log('could not read', name, e.message);
    }
  }
});
await page.goto(`https://www.mecabricks.com/en/workshop/${id}`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => /Parts: \d+/.test(document.body.innerText), null, { timeout: 180000 });
// the meshes come last: the server builds a zip first, which can take a while
for (let t = 0; t < 180 && got.size < want.length; t++) await page.waitForTimeout(1000);
await page.waitForTimeout(1000);
await ctx.close();
const missing = want.map((w) => w[1]).filter((n) => !got.has(n));
console.log(missing.length ? `missing: ${missing.join(', ')}` : `all four files in ${out}`);
