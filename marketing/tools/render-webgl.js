#!/usr/bin/env node
/**
 * render-webgl.js — render a WebGL film page frame by frame on the GPU and
 * encode it with ffmpeg.
 *
 *   node marketing/tools/render-webgl.js \
 *     --page "assets/circles/film.html?tl=/assets/export/circles-ep01-tontine/timeline-gemini.json" \
 *     --out  marketing/assets/export/circles-ep01-tontine/film.mp4 \
 *     --seconds 78.5 --fps 30 [--audio master.wav] [--samples 16]
 *
 *   --probe 1.5,12.8,-1 --probe-dir <dir>   render only those timestamps to PNG
 *
 * Why a local HTTP server: ES modules (three.js) do not load from file://.
 * marketing/ is served at http://127.0.0.1:<port>/, so the page path is
 * relative to marketing/.
 *
 * Contract with the page: it sets window.__ready = true once fonts, textures
 * and shaders are ready, and window.__frame(tSeconds, samples) renders that
 * instant (motion blur + depth of field by sub-frame accumulation inside the
 * page) and resolves to a data: URL of raw RGBA bytes, bottom-up rows.
 * Headless Chrome runs on the Metal GPU through ANGLE.
 */
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const puppeteer = require('puppeteer-core');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ROOT = path.resolve(__dirname, '..');            // marketing/
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.svg': 'image/svg+xml',
};

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
}

function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      const file = path.normalize(path.join(ROOT, rel));
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404); res.end('not found'); return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function ffmpeg(args) {
  const p = spawn('ffmpeg', args, { stdio: ['pipe', 'inherit', 'inherit'] });
  const done = new Promise((resolve, reject) => p.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`ffmpeg exit ${c}`)))));
  return { p, done };
}

async function write(stream, buf) {
  if (!stream.write(buf)) await new Promise((r) => stream.once('drain', r));
}

(async () => {
  const page = arg('page');
  const W = parseInt(arg('width', '1080'), 10);
  const H = parseInt(arg('height', '1920'), 10);
  const fps = parseInt(arg('fps', '30'), 10);
  const seconds = parseFloat(arg('seconds', '0'));
  const samples = parseInt(arg('samples', '16'), 10);
  const probe = arg('probe', '');
  const probeDir = arg('probe-dir', '');
  const out = arg('out', '');
  const audio = arg('audio', '');
  const start = parseFloat(arg('start', '0'));

  const server = await serve();
  const url = `http://127.0.0.1:${server.address().port}/${page.replace(/^\//, '')}`;
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    protocolTimeout: 600000,
    args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu-rasterization',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--force-device-scale-factor=1'],
  });
  const tab = await browser.newPage();
  tab.on('console', (m) => { if (['error', 'warn', 'log'].includes(m.type())) console.log(`[page:${m.type()}] ${m.text()}`); });
  tab.on('pageerror', (e) => console.error(`[page:error] ${e.message}`));
  await tab.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
  await tab.goto(url, { waitUntil: 'load' });
  await tab.waitForFunction('window.__ready === true || window.__failed', { timeout: 180000 });
  const failed = await tab.evaluate(() => window.__failed || null);
  if (failed) throw new Error(`page failed to initialise: ${failed}`);

  const grab = async (t) => {
    const dataUrl = await tab.evaluate((tt, n) => window.__frame(tt, n), t, samples);
    return Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
  };

  if (probe) {
    fs.mkdirSync(probeDir, { recursive: true });
    for (const t of probe.split(',').map(Number)) {
      const buf = await grab(t);
      const f = ffmpeg(['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`, '-i', '-',
        '-vf', 'vflip', '-frames:v', '1', path.join(probeDir, `probe-${t.toFixed(2)}s.png`)]);
      await write(f.p.stdin, buf); f.p.stdin.end(); await f.done;
    }
    console.log(`probes -> ${probeDir}`);
  } else {
    const n = Math.round((seconds - start) * fps);
    const args = ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`, '-r', String(fps), '-i', '-'];
    if (audio) args.push('-ss', String(start), '-i', audio);
    args.push('-vf', 'vflip', '-c:v', 'libx264', '-profile:v', 'high', '-level', '4.2', '-preset', 'slow', '-crf', '15',
      '-pix_fmt', 'yuv420p', '-r', String(fps));
    if (audio) args.push('-c:a', 'aac', '-b:a', '192k', '-shortest');
    args.push('-movflags', '+faststart', out);
    const f = ffmpeg(args);
    const t0 = Date.now();
    for (let i = 0; i < n; i++) {
      await write(f.p.stdin, await grab(start + i / fps));
      if (i % 60 === 0 || i === n - 1) {
        const el = (Date.now() - t0) / 1000;
        console.log(`frame ${i + 1}/${n}  ${((i + 1) / el).toFixed(2)} fps  eta ${(((n - i - 1) * el) / (i + 1) / 60).toFixed(1)} min`);
      }
    }
    f.p.stdin.end();
    await f.done;
    console.log(`mp4 -> ${out}`);
  }
  await browser.close();
  server.close();
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
