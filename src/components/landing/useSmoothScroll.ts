import { useEffect } from 'react';
import Lenis from 'lenis';

/**
 * Lenis smooth scroll, scoped to the landing page. Skipped entirely under
 * prefers-reduced-motion (native scroll runs instead). Lenis drives its own
 * rAF loop; framer-motion's whileInView / useScroll read the resulting scroll
 * position, and the WebGL scenes read window.scrollY — one scroll source.
 */
export function useSmoothScroll() {
  useEffect(() => {
    if (
      typeof window === 'undefined' ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      return;
    }

    // autoRaf:false → our manual loop is the single rAF driver.
    const lenis = new Lenis({ lerp: 0.1, smoothWheel: true, autoRaf: false });
    // Expose for programmatic scrolling (anchor links / e2e checks).
    (window as unknown as { lenis?: Lenis }).lenis = lenis;
    let raf = 0;
    const loop = (time: number) => {
      lenis.raf(time);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      lenis.destroy();
    };
  }, []);
}
