// Open the app in Chrome, run optional JS, save screenshots, print console errors.
//   node tools/shot.mjs out.png [--js "lego.go(10)"] [--wait 1500] [--size 1600x1000] [--headed] [--fresh]
import { chromium } from 'playwright-core';
const args = process.argv.slice(2);
const out = args[0] || 'shot.png';
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const [w, h] = opt('--size', '1600x1000').split('x').map(Number);
const browser = await chromium.launch({ channel: 'chrome', headless: !args.includes('--headed'), args: ['--use-angle=metal', '--enable-gpu'] });
const page = await browser.newPage({ viewport: { width: w, height: h } });
const errors = [];
page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && errors.push(`${m.type()}: ${m.text()}`));
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
await page.goto(opt('--url', 'http://localhost:5191/'));
if (args.includes('--fresh')) { await page.evaluate(() => localStorage.clear()); await page.reload(); }
const t0 = Date.now();
await page.waitForFunction(() => !document.getElementById('loading'), null, { timeout: 120000 }).catch(() => errors.push('never finished loading'));
console.log('loaded in', Date.now() - t0, 'ms');
for (let i = 0; i < args.length; i++) if (args[i] === '--js') {
  const r = await page.evaluate(args[i + 1]).catch((e) => 'ERR ' + e.message);
  if (r !== undefined) console.log('js:', typeof r === 'string' ? r : JSON.stringify(r));
  await page.waitForTimeout(+opt('--wait', 1200));
}
await page.waitForTimeout(+opt('--wait', 1200));
await page.screenshot({ path: out });
console.log(errors.length ? errors.slice(0, 20).join('\n') : 'no console errors');
await browser.close();
