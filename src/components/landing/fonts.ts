import localFont from 'next/font/local';

/**
 * The public site's two faces, declared once so every page shares the same
 * font instances (and the same preload decisions).
 *
 * - Sans: SF Pro via `-apple-system` on Apple devices — see `.apple` in
 *   globals.css. Inter is the stand-in everywhere else; `preload: false` so
 *   Apple devices, which never use it, never download it. Apply
 *   `sansFont.variable` on any root (or portal) that carries `.apple`.
 * - Serif: the brand's heritage voice — the wordmark and the tradition's names.
 *
 * Both are bundled under src/fonts (SIL OFL 1.1, from Fontsource 5.3.0: the
 * Latin subset next/font/google used to fetch; Inter's variable file carries the
 * weight and optical-size axes `axes: ['opsz']` asked for), so a build never
 * downloads them: next/font/google's loader throws on a font URL without a file
 * extension and failed Vercel builds at random.
 */
export const sansFont = localFont({
  src: '../../fonts/inter/inter-latin-opsz-normal.woff2',
  weight: '100 900',
  style: 'normal',
  display: 'swap',
  preload: false,
  variable: '--font-landing-sans',
});

export const serifFont = localFont({
  src: '../../fonts/instrument-serif/instrument-serif-latin-400-normal.woff2',
  weight: '400',
  style: 'normal',
  display: 'swap',
});
