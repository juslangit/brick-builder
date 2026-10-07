// Drives the three modes with real mouse input and checks the build state after each.
//   node tools/test-modes.mjs <screenshot-dir>
import { chromium } from 'playwright-core';
const dir = process.argv[2] || '.';
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await page.goto(process.env.URL || 'http://localhost:5191/');
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.waitForFunction(() => !document.getElementById('loading'));
const state = () => page.evaluate(() => lego.state());
let fails = 0;
const check = (ok, msg) => { console.log(ok ? 'PASS' : 'FAIL', msg); if (!ok) fails++; };

// ---- click to advance
await page.click('#btn-next'); await page.click('#btn-next');
check((await state()).step === 2, 'advance: two clicks on ▶ reach step 3');
await page.keyboard.press('ArrowLeft');
check((await state()).step === 1, 'advance: ← goes back a step');

// ---- pick & place: drag every tray piece onto its spot
await page.click('.modes button[data-mode=pick]');
await page.waitForTimeout(900);
const startStep = (await state()).step;
const need = await page.evaluate(() => lego.set.steps[lego.state().step].parts.length);
for (let i = 0; i < need; i++) {
  const item = await page.$('#tray-items .part');
  if (!item) break;
  const b = await item.boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + 60, b.y - 80, { steps: 4 });
  const t = await page.evaluate(() => {
    // the held part's ghost targets are on screen; use the first one
    const ids = [...lego.viewer.ghosts.keys()];
    const p = lego.set.parts[ids[0]];
    return p ? lego.viewer.toScreen(p.centre) : null;
  });
  if (!t) { check(false, 'pick: a ghost target is shown while holding'); break; }
  await page.mouse.move(t.x + 10, t.y + 8, { steps: 8 });
  if (i === 0) await page.screenshot({ path: `${dir}/pick-holding.png` });
  await page.mouse.up();
  await page.waitForTimeout(150);
}
await page.waitForTimeout(1200);
const afterPick = await state();
check(afterPick.step === startStep + 1, `pick: placing all ${need} pieces finishes the step and moves on (step ${afterPick.step + 1})`);
// a drop far from any spot is refused
{
  const item = await page.$('#tray-items .part'); const b = await item.boundingBox();
  await page.mouse.move(b.x + 40, b.y + 40); await page.mouse.down();
  await page.mouse.move(200, 150, { steps: 6 }); await page.mouse.up();
  await page.waitForTimeout(200);
  check((await state()).placed.length === 0, 'pick: a drop far from the spot is refused');
}

// ---- free build: place a part from the bin on the floor
await page.click('.modes button[data-mode=free]');
await page.waitForTimeout(600);
await page.click('#tray-tabs button[data-tab=all]');
await page.fill('#tray-search', '3001');
await page.waitForTimeout(300);
const brick = await page.$('#tray-items .part'); const bb = await brick.boundingBox();
await page.mouse.click(bb.x + 40, bb.y + 40);               // pick it up
await page.mouse.move(300, 300, { steps: 6 });
await page.mouse.click(300, 300);                           // put it down
await page.waitForTimeout(300);
await page.keyboard.press('Escape');
check((await state()).free.length === 1, 'free: a 2x4 brick from the bin is placed in the scene');
await page.screenshot({ path: `${dir}/free.png` });

// ---- booklet page turning and settings
await page.click('#bk-next'); await page.click('#bk-next');
check(await page.isVisible('#bk-build'), 'booklet: turning pages offers "Build from this page"');
await page.click('#btn-settings');
await page.selectOption('select[name=booklet]', 'left');
await page.click('dialog button.primary');
check(await page.evaluate(() => document.getElementById('main').className === 'booklet-left'), 'settings: booklet moves to the left');
await page.screenshot({ path: `${dir}/left.png` });

console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
await browser.close();
process.exit(fails ? 1 : 0);
