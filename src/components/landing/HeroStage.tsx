import { useRef, type ReactNode } from 'react';
import dynamic from 'next/dynamic';
import { motion, useScroll, useTransform } from 'framer-motion';
import { useReducedMotionAfterMount } from './motion';

// Browser-only and lazy: three.js stays out of SSR and the critical path, so
// the headline paints (and animates in via CSS) before any WebGL arrives.
const DiasporaMeridian = dynamic(() => import('./DiasporaMeridian'), {
  ssr: false,
  loading: () => null,
});

/**
 * The hero as a pinned stage. The section is taller than the viewport; its
 * inner stage sticks while that extra runway scrolls, and scroll progress
 * (0 → 1) drives the choreography: the copy lifts and recedes, the globe
 * rises from a horizon into a centred product shot. Only transform and
 * opacity move — nothing re-lays-out while scrubbing.
 *
 * Reduced motion collapses the runway to a single static viewport (in CSS).
 */
export default function HeroStage({
  id,
  children,
}: {
  id?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  const reduce = useReducedMotionAfterMount();
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ['start start', 'end end'],
  });

  const copyOpacity = useTransform(scrollYProgress, [0, 0.42], [1, 0]);
  const copyY = useTransform(scrollYProgress, [0, 0.6], [0, -110]);
  const copyScale = useTransform(scrollYProgress, [0, 0.6], [1, 0.94]);
  // The warm horizon glow brightens as the planet clears the fold.
  const glowOpacity = useTransform(scrollYProgress, [0, 0.7], [0.4, 0.75]);

  return (
    <section
      ref={ref}
      id={id}
      // The runway is decided in CSS, not after hydration: a JS switch would
      // re-lay-out the page (and, under the global reduced-motion rule, run
      // it as a transition) the moment the preference is read.
      className="relative h-[100svh] motion-safe:h-[175svh] motion-safe:md:h-[185svh]"
    >
      <div className="sticky top-0 h-[100svh] overflow-hidden">
        {/* CSS fallback + base glow: carries the hero if WebGL never arrives. */}
        <motion.div
          aria-hidden
          className="absolute inset-0"
          style={{
            opacity: reduce ? 0.6 : glowOpacity,
            background:
              'radial-gradient(56% 38% at 50% 100%, rgba(232,176,75,0.16), rgba(232,176,75,0.04) 55%, transparent 75%)',
          }}
        />
        {/* Always the same progress value: swapping the prop would tear down
            and rebuild the WebGL scene. The globe reads reduced motion itself
            and renders one settled frame. */}
        <DiasporaMeridian progress={scrollYProgress} />

        {/* Keep the copy crisp: a soft dark vignette under the text column. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              'radial-gradient(70% 55% at 50% 30%, rgba(0,0,0,0.55), transparent 70%)',
          }}
        />

        <motion.div
          className="relative z-10 h-full will-change-transform"
          // Reduced motion passes explicit rest values rather than dropping
          // the style prop: framer would otherwise leave the last scrubbed
          // inline values on the element.
          style={reduce ? { opacity: 1, y: 0, scale: 1 } : { opacity: copyOpacity, y: copyY, scale: copyScale }}
        >
          {children}
        </motion.div>

        {/* Seam-free hand-off into the next (black) section. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-gradient-to-b from-transparent to-black"
        />
      </div>
    </section>
  );
}
