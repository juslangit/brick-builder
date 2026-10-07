import { chromium } from 'playwright-core';
import fs from 'fs';
const b = await chromium.launch({ channel: 'chrome', headless: false });
const p = await b.newPage();
await p.goto(process.argv[2], { waitUntil: 'domcontentloaded', timeout: 60000 });
await p.waitForTimeout(6000);
fs.writeFileSync(process.argv[3], await p.evaluate(() => document.body.innerText));
await b.close();
