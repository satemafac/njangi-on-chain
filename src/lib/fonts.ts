import localFont from 'next/font/local';

/**
 * Playful, rounded display font scoped to the Smart Goal surfaces (the pot,
 * the goal headlines, the creation flow). Gives the "pool money with friends"
 * experience a distinct, friendly personality without touching the rest of the
 * app's typography. Sourced from the ui-ux-pro-max "Playful Creative" pairing.
 *
 * Bundled (src/fonts/fredoka, SIL OFL 1.1, from @fontsource/fredoka 5.3.0, the
 * Latin subset next/font/google used to fetch) so a build never downloads it:
 * next/font/google's loader throws on a font URL without a file extension and
 * failed Vercel builds at random ("Cannot read properties of null (reading '1')").
 */
export const goalDisplayFont = localFont({
  src: [
    { path: '../fonts/fredoka/fredoka-latin-500-normal.woff2', weight: '500', style: 'normal' },
    { path: '../fonts/fredoka/fredoka-latin-600-normal.woff2', weight: '600', style: 'normal' },
    { path: '../fonts/fredoka/fredoka-latin-700-normal.woff2', weight: '700', style: 'normal' },
  ],
  display: 'swap',
});
