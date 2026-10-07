// Close-ups of the printed parts in the finished model, for checking prints by eye.
//   node tools/capture_prints.mjs <out-dir> [url]
import { chromium } from 'playwright-core';
const [dir = '.', url = 'http://localhost:5191/'] = process.argv.slice(2);
const SHOTS = {
  cockpit: [['29096d1', '44375d3'], 1.4],
  dejarik: [['3960d13'], 2.2],
  bb8: [['34462d1', '20952d1'], 2.6],
  c3po: [['30480d1', '3814d771', '3815d267', '3816d267'], 2.2],
  han: [['3814d973', '3815d373', '3816d373', '3626d1024'], 2.2],
  leia: [['3814d974', '3815d374', '3626d1025'], 2.2],
  tiles: [['3069d39'], 1.6],
};
const b = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal'] });
const page = await b.newPage({ viewport: { width: 1000, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(url);
await page.evaluate(() => { localStorage.clear(); localStorage.setItem('lego.settings.v1', JSON.stringify({ booklet: 'hidden', animation: 'off' })); });
await page.reload();
await page.waitForFunction(() => !document.getElementById('loading'), null, { timeout: 120000 });
await page.evaluate(() => { lego.go(lego.set.steps.length, { animate: false }); document.getElementById('fin-close').click(); document.getElementById('hint').style.display = 'none'; });
for (const [name, [refs, scale]] of Object.entries(SHOTS)) {
  const n = await page.evaluate(([refs, scale]) => {
    const ids = lego.set.parts.filter((p) => refs.includes(lego.set.types[p.type].ref)).map((p) => p.id);
    lego.viewer.frameIds(ids.slice(0, 4), { minSize: 10, scale, instant: true });
    return ids.length;
  }, [refs, scale]);
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${dir}/print-${name}.png` });
  console.log(name, n, 'parts');
}
console.log(errors.length ? errors.join('\n') : 'no page errors');
await b.close();
