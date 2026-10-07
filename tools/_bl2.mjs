import { chromium } from 'playwright-core';
const b = await chromium.launch({ channel: 'chrome', headless: false });
const p = await b.newPage();
for (const m of process.argv.slice(2)) {
  await p.goto(`https://www.bricklink.com/catalogItemInv.asp?M=${m}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await p.waitForTimeout(3500);
  const t = await p.evaluate(() => document.body.innerText);
  const rows = t.split('\n').filter((l) => /^\*?\s*\t?\s*\d+\s*\t/.test(l) || /\t\s*\d{3,}[a-z]*pb|\t\s*(973|970|3626|3815|3816|3817|30480)/.test(l));
  console.log('== ' + m); rows.slice(0, 14).forEach((r) => console.log('  ' + r.replace(/\s+/g, ' ').slice(0, 150)));
}
await b.close();
