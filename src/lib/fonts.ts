import { Fredoka } from 'next/font/google';

/**
 * Playful, rounded display font scoped to the Smart Goal surfaces (the pot,
 * the goal headlines, the creation flow). Gives the "pool money with friends"
 * experience a distinct, friendly personality without touching the rest of the
 * app's typography. Sourced from the ui-ux-pro-max "Playful Creative" pairing.
 */
export const goalDisplayFont = Fredoka({
  subsets: ['latin'],
  weight: ['500', '600', '700'],
  display: 'swap',
});
