import { Instrument_Serif, Inter } from 'next/font/google';

/**
 * The public site's two faces, declared once so every page shares the same
 * font instances (and the same preload decisions).
 *
 * - Sans: SF Pro via `-apple-system` on Apple devices — see `.apple` in
 *   globals.css. Inter is the stand-in everywhere else; `preload: false` so
 *   Apple devices, which never use it, never download it. Apply
 *   `sansFont.variable` on any root (or portal) that carries `.apple`.
 * - Serif: the brand's heritage voice — the wordmark and the tradition's names.
 */
export const sansFont = Inter({
  subsets: ['latin'],
  axes: ['opsz'],
  display: 'swap',
  preload: false,
  variable: '--font-landing-sans',
});

export const serifFont = Instrument_Serif({
  subsets: ['latin'],
  weight: '400',
  display: 'swap',
});
