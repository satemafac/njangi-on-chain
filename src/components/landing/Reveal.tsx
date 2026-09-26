import { type ReactNode } from 'react';
import { motion, type Variants } from 'framer-motion';
import { EASE_APPLE, useReducedMotionAfterMount } from './motion';

// Apple-paced: content drifts up a short distance and settles over ~1s,
// siblings following a beat apart. Slower and shorter-travelled than a
// typical "fade-up" — the page should feel like it is arriving, not popping.
const containerVariants: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.1, delayChildren: 0.04 } },
};

const itemVariants: Variants = {
  hidden: { opacity: 0, y: 32 },
  show: {
    opacity: 1,
    y: 0,
    transition: { duration: 1, ease: EASE_APPLE },
  },
};

/**
 * Staggered-reveal container. Children should be <RevealItem>.
 *
 * Server and first client render are identical (hidden, revealed in view),
 * so hydration never mismatches. For reduced-motion visitors the reveal then
 * fires straight away instead of waiting for scroll, and the page-level
 * `<MotionConfig reducedMotion="user">` strips the travel — they get a short
 * fade into place, nothing moving.
 */
export function Reveal({
  children,
  className = '',
  amount = 0.2,
}: {
  children: ReactNode;
  className?: string;
  amount?: number;
}) {
  const reduce = useReducedMotionAfterMount();
  return (
    <motion.div
      className={className}
      variants={containerVariants}
      initial="hidden"
      {...(reduce ? { animate: 'show' } : { whileInView: 'show' })}
      viewport={{ once: true, amount, margin: '0px 0px -8% 0px' }}
    >
      {children}
    </motion.div>
  );
}

/** A single staggered child. */
export function RevealItem({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <motion.div className={className} variants={itemVariants}>
      {children}
    </motion.div>
  );
}
