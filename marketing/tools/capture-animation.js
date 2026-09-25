/**
 * capture-animation.js — render a CSS-animated HTML frame to a numbered PNG
 * sequence, for encoding to MP4.
 *
 *   node marketing/tools/capture-animation.js \
 *     --in  marketing/assets/nobody-holds-the-pot.html \
 *     --out marketing/assets/export/frames \
 *     --seconds 7 --fps 24 --size 1080
 *
 *   --size N sets a square. --width W --height H sets any frame (Reels: 1080x1920).
 *   --probe t1,t2,... renders only those timestamps (seconds) — for layout checks.
 *
 * Seeking uses the Web Animations API (animation.currentTime), NOT
 * animation-delay. Setting a delay on an already-running animation does not
 * reseek it — it resolves against the original start time, so the same
 * timestamp yields different frames depending on how long the page has been
 * open. currentTime is deterministic.
 */
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
}

(async () => {
  const input = path.resolve(arg('in'));
  const outDir = path.resolve(arg('out'));
  const seconds = parseFloat(arg('seconds', '7'));
  const fps = parseInt(arg('fps', '24'), 10);
  const size = parseInt(arg('size', '1080'), 10);
  const width = parseInt(arg('width', String(size)), 10);
  const height = parseInt(arg('height', String(size)), 10);
  const probe = arg('probe', '');

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
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  await page.goto(`file://${input}`, { waitUntil: 'networkidle0' });

  // The frame is responsive; pin it to an exact export size.
  await page.addStyleTag({
    content: `body{padding:0!important;margin:0!important;min-height:0!important;background:#0a0a0c!important}
              .frame{width:${width}px!important;height:${height}px!important;aspect-ratio:auto!important;
                     border:none!important;border-radius:0!important}`,
  });
  await page.evaluate(() => document.fonts.ready);

  // Pause every animation once, up front.
  await page.evaluate(() => {
    document.getAnimations().forEach((a) => a.pause());
  });

  const times = probe
    ? probe.split(',').map((t) => parseFloat(t) * 1000)
    : Array.from({ length: Math.round(seconds * fps) }, (_, i) => (i / fps) * 1000);
  const total = times.length;
  for (let i = 0; i < total; i++) {
    const ms = times[i];
    await page.evaluate((t) => {
      document.getAnimations().forEach((a) => { a.currentTime = t; });
    }, ms);
    await page.screenshot({
      path: path.join(outDir, probe ? `probe-${(ms / 1000).toFixed(2)}s.png` : `f${String(i).padStart(4, '0')}.png`),
      omitBackground: false,
    });
  }

  await browser.close();
  console.log(`${total} frames -> ${outDir}`);
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
