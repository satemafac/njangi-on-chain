import { useEffect, useState } from 'react';

/**
 * Motion tokens for the landing page.
 *
 * Apple's marketing motion is slow to settle and never springs past its
 * target: long ease-out curves (~1s) for content arriving, and short, plain
 * curves (~200ms) for controls answering a tap. Everything on the landing
 * pulls from these two so the page moves with one voice.
 */

/** Content entering: a long, soft deceleration (apple.com's reveal curve). */
export const EASE_APPLE: [number, number, number, number] = [0.28, 0.11, 0.32, 1];

/** Controls responding: menus, toggles, accordions. */
export const EASE_UI: [number, number, number, number] = [0.25, 0.1, 0.25, 1];

/** Linear-interpolate `a → b` by `t`. */
export const mix = (a: number, b: number, t: number) => a + (b - a) * t;

/** Hermite smoothstep clamped to [0, 1]; the easing for scroll-scrubbed ranges. */
export const smooth = (edge0: number, edge1: number, x: number) => {
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1);
  return t * t * (3 - 2 * t);
};

/**
 * `prefers-reduced-motion`, but `false` until after mount.
 *
 * Components that render a *different structure* for reduced motion (a
 * static list instead of a pinned scroll scene) must match the server HTML
 * on the first client render or React throws a hydration mismatch. This hook
 * guarantees that: the server and the first client pass both see `false`,
 * then the real preference lands in an effect (and tracks later changes).
 */
export function useReducedMotionAfterMount(): boolean {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => setReduce(query.matches);
    sync();
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);
  return reduce;
}
