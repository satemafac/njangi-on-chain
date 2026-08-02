#!/usr/bin/env node
/**
 * Renders the Open Graph share cards into public/og/.
 *
 * Run after editing a card's copy:  node scripts/generate-og.mjs
 * Output is committed, not generated during `next build` — see below.
 *
 * WHY satori AND NOT sharp-with-SVG-text
 * --------------------------------------
 * sharp rasterises SVG through librsvg, which resolves `font-family` against
 * *system* fonts. Instrument Serif and Manrope are not installed on a build
 * container, so the same SVG renders with brand type locally and with a
 * fallback serif on CI — silently. satori takes an explicit font buffer and
 * emits SVG with the text already converted to <path>, so the SVG handed to
 * sharp contains no text elements at all and librsvg's font lookup never
 * happens. Same reason @vercel/og uses satori internally.
 *
 * WHY THE OUTPUT IS COMMITTED
 * ---------------------------
 * These change only when marketing copy changes, which is rare. Committing
 * them keeps the Vercel build free of an image pipeline, makes each card
 * reviewable as an image in the diff, and means a font or library upgrade can
 * never quietly restyle every share card on a deploy. The tradeoff is repo
 * weight: keep the cards small and do not add one per dynamic entity.
 *
 * These six cards previously 404'd, so every learn/blog/faq link shared to
 * WhatsApp or Slack rendered with no preview image at all:
 *   /images/faq-hero.jpg  /images/learn-hero.jpg  /images/njangi-hero.jpg
 *   /images/blockchain-rosca.jpg  /images/blog-hero.jpg
 *   /images/blog/traditional-vs-blockchain.jpg
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import satori from 'satori';
import sharp from 'sharp';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public/og');

const WIDTH = 1200;
const HEIGHT = 630;

// Lifted from the landing palette (src/pages/index.tsx, globals.css).
const INK = '#0a0a0c';
const CREAM = '#f5f1e8';
const GOLD = '#E8B04B';
const MUTED = '#8b8578';

/**
 * Every card. `eyebrow` is the section, `title` the promise. Keep titles short
 * enough to breathe at 1200x630 — roughly 60 characters.
 */
const CARDS = [
  {
    slug: 'learn',
    eyebrow: 'Learn',
    title: 'Rotating savings circles, explained',
  },
  {
    slug: 'learn-what-is-njangi',
    eyebrow: 'Learn · Njangi',
    title: 'What is a njangi?',
  },
  {
    slug: 'learn-blockchain-rosca',
    eyebrow: 'Learn · ROSCA',
    title: 'What is a ROSCA?',
  },
  {
    slug: 'learn-tontine-blockchain',
    eyebrow: 'Learn · Tontine',
    title: 'What is a tontine?',
  },
  {
    slug: 'learn-sou-sou-crypto',
    eyebrow: 'Learn · Susu',
    title: 'What is a susu?',
  },
  {
    slug: 'faq',
    eyebrow: 'Questions',
    title: 'A few things people ask first',
  },
  {
    slug: 'pricing',
    eyebrow: 'Pricing',
    title: 'Free to run a circle. Pay only for coordination.',
  },
  {
    slug: 'blog',
    eyebrow: 'Writing',
    title: 'Notes on community savings',
  },
  {
    slug: 'blog-traditional-savings-vs-blockchain',
    eyebrow: 'Writing',
    title: 'Traditional savings circles vs. on-chain',
  },
  {
    slug: 'legal',
    eyebrow: 'Legal',
    title: 'Terms, privacy, and risk disclosure',
  },
  {
    slug: 'join',
    eyebrow: 'You have been invited',
    title: 'Join the circle',
  },
];

/** satori accepts a React-element-shaped object; no JSX needed in a .mjs script. */
const el = (type, props = {}, children) => ({
  type,
  props: children === undefined ? props : { ...props, children },
});

function buildCard({ eyebrow, title }, markDataUri) {
  return el(
    'div',
    {
      style: {
        width: WIDTH,
        height: HEIGHT,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        padding: '72px 80px',
        backgroundColor: INK,
        // A single warm bloom behind the mark, so the card is not flat black.
        backgroundImage:
          'radial-gradient(900px 520px at 78% 8%, rgba(232,176,75,0.16), rgba(10,10,12,0) 62%)',
      },
    },
    [
      // Wordmark lockup
      el('div', { style: { display: 'flex', alignItems: 'center', gap: 20 } }, [
        el('img', { src: markDataUri, width: 68, height: 68, style: { borderRadius: 16 } }),
        el('div', { style: { display: 'flex', flexDirection: 'column' } }, [
          el(
            'div',
            {
              style: {
                fontFamily: 'Instrument Serif',
                fontSize: 40,
                color: CREAM,
                letterSpacing: '-0.02em',
                lineHeight: 1,
              },
            },
            'Njangi'
          ),
          el(
            'div',
            {
              style: {
                fontFamily: 'Manrope',
                fontSize: 13,
                fontWeight: 700,
                color: GOLD,
                letterSpacing: '0.42em',
                marginTop: 6,
              },
            },
            'ON-CHAIN'
          ),
        ]),
      ]),

      // Message
      el('div', { style: { display: 'flex', flexDirection: 'column' } }, [
        el(
          'div',
          {
            style: {
              fontFamily: 'Manrope',
              fontSize: 20,
              fontWeight: 600,
              color: GOLD,
              letterSpacing: '0.28em',
              textTransform: 'uppercase',
            },
          },
          eyebrow
        ),
        el(
          'div',
          {
            style: {
              fontFamily: 'Instrument Serif',
              fontSize: 74,
              color: CREAM,
              lineHeight: 1.1,
              letterSpacing: '-0.01em',
              marginTop: 22,
              maxWidth: 900,
            },
          },
          title
        ),
      ]),

      // Footer rule
      el(
        'div',
        {
          style: {
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            borderTop: '1px solid #2a2620',
            paddingTop: 26,
            fontFamily: 'Manrope',
            fontSize: 21,
            color: MUTED,
          },
        },
        [
          el('div', {}, 'njangionchain.com'),
          el('div', { style: { color: '#6f6a5f' } }, 'Rotating savings circles'),
        ]
      ),
    ]
  );
}

async function main() {
  await mkdir(OUT, { recursive: true });

  const [serif, sans, sansBold, mark] = await Promise.all([
    readFile(join(ROOT, 'node_modules/@fontsource/instrument-serif/files/instrument-serif-latin-400-normal.woff')),
    readFile(join(ROOT, 'node_modules/@fontsource/manrope/files/manrope-latin-600-normal.woff')),
    readFile(join(ROOT, 'node_modules/@fontsource/manrope/files/manrope-latin-700-normal.woff')),
    readFile(join(ROOT, 'public/icons/icon-192.png')),
  ]);

  const markDataUri = `data:image/png;base64,${mark.toString('base64')}`;

  const fonts = [
    { name: 'Instrument Serif', data: serif, weight: 400, style: 'normal' },
    { name: 'Manrope', data: sans, weight: 600, style: 'normal' },
    { name: 'Manrope', data: sansBold, weight: 700, style: 'normal' },
  ];

  for (const card of CARDS) {
    const svg = await satori(buildCard(card, markDataUri), { width: WIDTH, height: HEIGHT, fonts });
    const png = await sharp(Buffer.from(svg))
      .png({ compressionLevel: 9, effort: 10 })
      .toBuffer();
    await writeFile(join(OUT, `${card.slug}.png`), png);
    console.log(`  public/og/${card.slug}.png`.padEnd(52), `${(png.length / 1024).toFixed(1)} KB`);
  }

  console.log(`\n[generate-og] wrote ${CARDS.length} cards`);
}

main().catch((err) => {
  console.error('[generate-og] failed:', err);
  process.exit(1);
});
