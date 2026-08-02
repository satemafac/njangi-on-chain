#!/usr/bin/env node
/**
 * Builds every icon size the site declares, from the brand mandala.
 *
 * Run after replacing the source artwork:  npm run generate:icons
 * The PNGs and .ico under public/icons/ are build output - never hand-edit them.
 *
 * SOURCE: public/brand/icon-source.png, the full-detail mandala. It is stored
 * here already trimmed to its own bounding box, because the original
 * njangi-on-chain-logo.png is a 2464x1536 canvas on which the artwork occupies
 * only 1054x1070 - 43% of the width, floating in transparency. That padding is
 * the single biggest reason the mark rendered as a small badge adrift in a
 * white tile in Google results, and why every UI use of it needed a
 * scale-[2.25] hack to fill its own box.
 *
 * What this script fixes, while keeping the artwork exactly as drawn:
 *   - trims the padding so the mark goes edge to edge
 *   - composites onto an opaque ground, so Google has nothing to composite
 *     the transparency onto itself
 *   - emits square sizes that are multiples of 48px, which is the only shape
 *     Google will consider for a search-result favicon
 *
 * Sizes:
 *   48/96/144/192  rel="icon" - multiples of 48, per Google's favicon rule.
 *                  512 is NOT in this set (512 / 48 = 10.67).
 *   512            web app manifest and schema.org Organization.logo, where
 *                  the multiple-of-48 rule does not apply.
 *   180            apple-touch-icon, Apple's fixed size.
 *   16/32/48       packed into favicon.ico for browser tabs.
 *
 * A note for whoever revisits this: the mandala's linework is genuinely fine,
 * and below about 24px it reads as a coloured disc rather than a ring of
 * figures. That is a property of the artwork, not of this pipeline - the crop
 * and the opaque ground get it as legible as it can be at that size. If small
 * sizes ever need to read more clearly, the answer is a simplified icon-only
 * variant of the mark, not a change here.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'public/brand/icon-source.png');
const ICONS = join(ROOT, 'public/icons');
const BRAND = join(ROOT, 'public/brand');

/** Ground colour, matching the landing background and the theme-color meta. */
const GROUND = { r: 0x0a, g: 0x0a, b: 0x0c, alpha: 1 };

/**
 * Fraction of the tile the artwork fills. The mandala is a circle inside a
 * square frame, so a little breathing room stops it looking cropped — but it
 * stays far tighter than the 43% it occupied before.
 */
const FILL = 0.9;

/** Android and friends crop maskable icons and only guarantee the central 80%. */
const MASKABLE_FILL = 0.66;

/**
 * Composite the artwork onto an opaque square ground at the requested size.
 * Rendering from the high-resolution source each time rather than downscaling
 * an already-downscaled raster keeps the fine linework as sharp as it can be.
 */
async function render(source, size, fill = FILL) {
  const inner = Math.round(size * fill);
  const art = await sharp(source)
    .resize(inner, inner, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .toBuffer();
  const offset = Math.round((size - inner) / 2);

  return (
    sharp({ create: { width: size, height: size, channels: 4, background: GROUND } })
      .composite([{ input: art, top: offset, left: offset }])
      .flatten({ background: GROUND })
      // flatten() makes every pixel opaque but sharp keeps the now-pointless
      // alpha channel, since the composited input had one. Drop it: smaller
      // files, and no way for transparency to creep back in later.
      .removeAlpha()
      .png({ compressionLevel: 9, effort: 10 })
      .toBuffer()
  );
}

/**
 * Pack PNGs into an .ico container. Vista-era and later ICO allows PNG payloads
 * verbatim, which every browser in use understands, so there is no BMP encoding
 * to do and no dependency to add.
 */
function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);

  const entries = Buffer.alloc(16 * images.length);
  let offset = 6 + 16 * images.length;

  images.forEach(({ size, buf }, i) => {
    const o = i * 16;
    entries.writeUInt8(size >= 256 ? 0 : size, o); // width (0 means 256)
    entries.writeUInt8(size >= 256 ? 0 : size, o + 1); // height
    entries.writeUInt8(0, o + 2); // palette size
    entries.writeUInt8(0, o + 3); // reserved
    entries.writeUInt16LE(1, o + 4); // colour planes
    entries.writeUInt16LE(32, o + 6); // bits per pixel
    entries.writeUInt32LE(buf.length, o + 8);
    entries.writeUInt32LE(offset, o + 12);
    offset += buf.length;
  });

  return Buffer.concat([header, entries, ...images.map((i) => i.buf)]);
}

async function main() {
  const source = await readFile(SRC);
  await mkdir(ICONS, { recursive: true });
  await mkdir(BRAND, { recursive: true });

  const written = [];
  const write = async (path, buf) => {
    await writeFile(path, buf);
    written.push([path.replace(`${ROOT}/`, ''), buf.length]);
  };

  for (const size of [48, 96, 144, 192, 512]) {
    await write(join(ICONS, `icon-${size}.png`), await render(source, size));
  }

  await write(join(ICONS, 'apple-touch-icon.png'), await render(source, 180));
  await write(
    join(ICONS, 'icon-maskable-512.png'),
    await render(source, 512, MASKABLE_FILL)
  );

  // Multi-resolution .ico, written to both locations so the root convention
  // (browsers request /favicon.ico unprompted) and the declared <link> agree.
  const ico = buildIco(
    await Promise.all(
      [16, 32, 48].map(async (size) => ({ size, buf: await render(source, size) }))
    )
  );
  await write(join(ICONS, 'favicon.ico'), ico);
  await write(join(ROOT, 'public/favicon.ico'), ico);

  // Square opaque logo for schema.org Organization.logo. Google asks for an
  // opaque, square logo; the old value pointed at the untrimmed transparent
  // canvas and declared it as 512x512 when it was 2464x1536.
  await write(join(BRAND, 'logo-square-512.png'), await render(source, 512));

  const pad = Math.max(...written.map(([p]) => p.length));
  for (const [path, bytes] of written) {
    console.log(`  ${path.padEnd(pad)}  ${(bytes / 1024).toFixed(1)} KB`);
  }
  console.log(`\n[generate-icons] wrote ${written.length} files from public/brand/icon-source.png`);
}

main().catch((err) => {
  console.error('[generate-icons] failed:', err);
  process.exit(1);
});
