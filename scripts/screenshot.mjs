// Screenshot the hero with real-clock waiting (for blog images etc.)
// Usage: node scripts/screenshot.mjs [url] [outfile]
import puppeteer from 'puppeteer-core';

const url = process.argv[2] ?? 'http://127.0.0.1:4321/?shot';
const out = process.argv[3] ?? 'public/images/blog/hero-launch.png';

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/chromium',
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-gpu',
    '--enable-unsafe-swiftshader',
    '--use-angle=swiftshader',
    '--hide-scrollbars',
  ],
});

const page = await browser.newPage();
await page.setViewport({ width: 1680, height: 945, deviceScaleFactor: 2 });
await page.goto(url, { waitUntil: 'load', timeout: 60000 });
await page.waitForSelector('#globe.ready', { timeout: 60000 });
// let a few rAF frames settle
await new Promise((r) => setTimeout(r, 1200));
await page.screenshot({ path: out });
await browser.close();
console.log('written:', out);
