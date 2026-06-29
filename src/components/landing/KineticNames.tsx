import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';

/**
 * Kinetic type: cycles the names a savings circle is known by across cultures,
 * flipping one word in place — the heritage of the rotating-savings tradition,
 * rendered as motion.
 *
 * Accessibility: the animated word is decorative (aria-hidden) — pair it with a
 * static sr-only label at the call site. To satisfy WCAG 2.2.2 (no auto-motion
 * past 5s without a control) it settles after a short, bounded run AND pauses
 * while the pointer is over it. Reduced-motion → static first word.
 */
export default function KineticNames({
  names,
  className = '',
  interval = 2000,
  maxCycles = 6,
}: {
  names: string[];
  className?: string;
  interval?: number;
  maxCycles?: number;
}) {
  const reduce = useReducedMotion();
  const [index, setIndex] = useState(0);
  const pausedRef = useRef(false);

  useEffect(() => {
    if (reduce || names.length <= 1) return;
    let count = 0;
    const id = window.setInterval(() => {
      if (pausedRef.current) return;
      setIndex((i) => (i + 1) % names.length);
      count += 1;
      if (count >= maxCycles) window.clearInterval(id); // settle, don't loop forever
    }, interval);
    return () => window.clearInterval(id);
  }, [reduce, names.length, interval, maxCycles]);

  return (
    <span
      aria-hidden
      onPointerEnter={() => {
        pausedRef.current = true;
      }}
      onPointerLeave={() => {
        pausedRef.current = false;
      }}
      className={`relative inline-grid overflow-hidden align-baseline ${className}`}
      style={{ minWidth: '11ch' }}
    >
      {reduce ? (
        <span className="col-start-1 row-start-1">{names[0]}</span>
      ) : (
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={names[index]}
            className="col-start-1 row-start-1 whitespace-nowrap"
            initial={{ y: '0.9em', opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: '-0.9em', opacity: 0 }}
            transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
          >
            {names[index]}
          </motion.span>
        </AnimatePresence>
      )}
    </span>
  );
}
