/**
 * capture-slides.js — screenshot every `.slide` in a carousel HTML file to
 * numbered JPEGs at an exact pixel size, ready for Instagram.
 *
 *   node marketing/tools/capture-slides.js \
 *     --in  marketing/assets/carousel-poverty-tax.html \
 *     --out marketing/assets/export/poverty-tax \
 *     --size 1080 [--quality 92] [--sheet]
 *
 * The carousel files are responsive (`width: min(1080px, 92vmin)`); we pin
 * each slide to --size so the export never depends on the viewport. Relative
 * asset URLs (grounds under marketing/assets/carousel/) resolve against the
 * HTML file's own directory because the page is loaded as file://.
 */
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

(async () => {
  const input = path.resolve(arg('in'));
  const outDir = path.resolve(arg('out'));
  const size = parseInt(arg('size', '1080'), 10);
  const quality = parseInt(arg('quality', '92'), 10);

  if (!fs.existsSync(input)) {
    console.error(`input not found: ${input}`);
    process.exit(1);
  }
  fs.mkdirSync(outDir, { recursive: true });

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--force-device-scale-factor=1', '--hide-scrollbars', '--disable-gpu'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: size + 80, height: size + 80, deviceScaleFactor: 1 });
  await page.goto(`file://${input}`, { waitUntil: 'networkidle0' });
  await page.addStyleTag({
    content: `body{padding:0!important;margin:0!important;gap:0!important;background:#050506!important}
              .slide{width:${size}px!important;height:${size}px!important;aspect-ratio:auto!important;
                     border:none!important;border-radius:0!important}`,
  });
  await page.evaluate(() => document.fonts.ready);

  const slides = await page.$$('.slide');
  if (!slides.length) {
    console.error('no .slide elements found');
    process.exit(1);
  }
  const written = [];
  for (let i = 0; i < slides.length; i++) {
    const file = path.join(outDir, `slide-${String(i + 1).padStart(2, '0')}.jpg`);
    await slides[i].evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await slides[i].screenshot({ path: file, type: 'jpeg', quality });
    written.push(file);
  }
  await browser.close();

  console.log(`${written.length} slides -> ${outDir}`);
  if (flag('sheet')) {
    // Contact sheet for a quick visual review: rows of 5.
    const { execFileSync } = require('child_process');
    const inputs = written.flatMap((f) => ['-i', f]);
    const n = written.length;
    const cols = Math.min(5, n);
    const rows = Math.ceil(n / cols);
    // Pad the last row with black tiles so xstack has a full grid.
    const pad = cols * rows - n;
    const padInputs = Array.from({ length: pad }, () => ['-f', 'lavfi', '-i', `color=c=black:s=${size}x${size}:d=1`]).flat();
    const layout = Array.from({ length: cols * rows }, (_, k) => `${(k % cols) * size}_${Math.floor(k / cols) * size}`).join('|');
    const sheet = path.join(outDir, 'sheet.jpg');
    execFileSync('ffmpeg', ['-v', 'error', '-y', ...inputs, ...padInputs, '-filter_complex',
      `xstack=inputs=${cols * rows}:layout=${layout},scale=${cols * 360}:-1`, '-frames:v', '1', sheet]);
    console.log(`sheet -> ${sheet}`);
  }
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
