// Takes the project record's screenshots from the running app (npm run dev) into docs/record/.
//   node tools/capture_record.mjs
import { chromium } from 'playwright-core';
const OUT = new URL('../docs/record/', import.meta.url).pathname;
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const open = async (settings = {}) => {
  await page.goto('http://localhost:5191/');
  await page.evaluate((s) => { localStorage.clear(); localStorage.setItem('lego.settings.v1', JSON.stringify(s)); }, settings);
  await page.reload();
  await page.waitForFunction(() => !document.getElementById('loading'));
};
const shot = async (name, wait = 1600) => {
  await page.waitForTimeout(wait);
  await page.screenshot({ path: OUT + name + '.jpg', type: 'jpeg', quality: 86 });
  console.log('saved', name);
};
const go = (js) => page.evaluate(js);

await open({ booklet: 'hidden' });
await go(`lego.go(lego.set.steps.length, {animate:false}); document.getElementById('fin-close').click()`);
await page.waitForTimeout(1200);
await go(`(() => { const v = lego.viewer, b = v.modelBox, c = b.getCenter(v.controls.target.clone());
  v.controls.target.copy(c); v.camera.position.set(c.x - 560, c.y + 470, c.z + 800); })()`);
await shot('cover-finished-falcon', 2200);

await open();
await shot('advance-step-1');
await go(`lego.go(40, {animate:false})`); await shot('advance-step-41');
await go(`lego.go(lego.set.bags[8].first + 40, {animate:false})`); await shot('advance-bag-9');
await go(`lego.go(lego.set.bags[1].first + 3, {animate:false})`); await shot('sub-landing-foot-x6');
await go(`lego.go(lego.set.steps.findIndex(s => s.attach && s.sub === 0), {animate:false})`); await shot('sub-attach');
await go(`lego.go(lego.set.bags[2].first, {animate:false}); document.getElementById('bk-prev').click()`); await shot('booklet-bag-page', 2600);

// pick & place: hold the first tray piece over its spot so it snaps
await open({ mode: 'pick', hints: 'always' });
await go(`lego.go(12, {animate:false})`);
await page.waitForTimeout(1200);
{
  const b = await (await page.$('#tray-items .part')).boundingBox();
  await page.mouse.move(b.x + 48, b.y + 50); await page.mouse.down();
  await page.mouse.move(b.x + 120, b.y - 120, { steps: 5 });
  const t = await go(`(() => { const id = [...lego.viewer.ghosts.keys()].find(i => { const p = lego.set.parts[i]; return true; }); return lego.viewer.toScreen(lego.set.parts[id].centre); })()`);
  await page.mouse.move(t.x + 70, t.y + 60, { steps: 6 });
  await shot('pick-holding', 500);
  await page.mouse.move(t.x + 6, t.y + 4, { steps: 6 });
  await shot('pick-snapped', 400);
  await page.mouse.up();
}

// free build: red bricks on the half-built hull
await open({ mode: 'free' });
await go(`lego.go(60, {animate:false})`);
await page.waitForTimeout(900);
await page.click('#tray-tabs button[data-tab=all]');
await page.fill('#tray-search', '3001');
await page.click('#palette button[title="Bright Red"]');
await page.waitForTimeout(300);
{
  const b = await (await page.$('#tray-items .part')).boundingBox();
  await page.mouse.click(b.x + 40, b.y + 40);
  for (const [x, y] of [[560, 380], [600, 400], [640, 420]]) { await page.mouse.move(x, y, { steps: 5 }); await page.mouse.click(x, y); await page.waitForTimeout(150); }
  await page.mouse.move(700, 360, { steps: 5 });
}
await shot('free-build', 600);
await page.keyboard.press('Escape');
await go(`document.getElementById('settings').showModal()`);
await shot('settings', 500);

await open({ booklet: 'left', background: 'dark' });
await go(`lego.go(lego.set.bags[5].first + 20, {animate:false})`);
await shot('dark-booklet-left');

console.log(errors.length ? errors.join('\n') : 'no page errors');
await browser.close();
