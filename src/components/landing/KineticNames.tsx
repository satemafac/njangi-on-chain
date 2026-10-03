import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { EASE_APPLE, useReducedMotionAfterMount } from './motion';

const SLIDE_S = 0.7;

/**
 * Kinetic type: cycles the names a savings circle is known by across cultures,
 * flipping one word in place — the heritage of the rotating-savings tradition,
 * rendered as motion.
 *
 * The run is bounded and both starts and *lands* on `settleOn` (the brand
 * name): server HTML, no-JS and reduced motion all show that word, and the
 * animated run reads "ours → the world's many names → ours" instead of
 * freezing on whichever word a timer happened to stop on. Names are sampled
 * across the whole list so a short run still spans cultures rather than the
 * first few alphabetically.
 *
 * Timing is chained, not a blind interval: the next word is only scheduled
 * once the previous slide has finished. On a busy main thread (a low-end
 * phone, a hidden tab) an interval keeps firing while frames stall, and
 * AnimatePresence piles every pending word into the slot at once.
 *
 * Accessibility: the animated word is decorative (aria-hidden) — pair it with a
 * static sr-only label at the call site. To satisfy WCAG 2.2.2 (no auto-motion
 * past 5s without a control) it settles after a short, bounded run AND pauses
 * while a mouse is over it.
 */
export default function KineticNames({
  names,
  className = '',
  interval = 2000,
  maxCycles = 6,
  settleOn,
}: {
  names: string[];
  className?: string;
  interval?: number;
  maxCycles?: number;
  /** Word the run starts from and comes to rest on. Defaults to the last name. */
  settleOn?: string;
}) {
  // Read after mount so the first client render matches the server HTML
  // (framer's hook reports the real preference immediately, which renders a
  // different element than the server did for reduced-motion visitors).
  const reduce = useReducedMotionAfterMount();
  const [index, setIndex] = useState(0);
  const hoverPausedRef = useRef(false);
  const hiddenRef = useRef(false);
  const timerRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    const sync = () => {
      hiddenRef.current = document.visibilityState === 'hidden';
    };
    sync();
    document.addEventListener('visibilitychange', sync);
    return () => document.removeEventListener('visibilitychange', sync);
  }, []);

  // The exact words this run will show: home, a spread of others, home again.
  const sequence = useMemo(() => {
    const unique = names.filter((n, i) => names.indexOf(n) === i);
    if (unique.length === 0) return [];

    const settle =
      settleOn && unique.includes(settleOn) ? settleOn : unique[unique.length - 1];
    const pool = unique.filter((n) => n !== settle);
    const steps = Math.max(0, Math.min(maxCycles, pool.length));
    if (steps === 0) return [settle];

    // Even stride across the full list so a 6-step run still spans cultures.
    const stride = pool.length / steps;
    const picked = Array.from({ length: steps }, (_, i) => pool[Math.floor(i * stride)]);
    return [settle, ...picked, settle];
  }, [names, maxCycles, settleOn]);

  const last = sequence.length - 1;

  /** Advance one word after `delay`, holding while hovered or hidden. */
  const scheduleNext = useCallback(
    (delay: number) => {
      window.clearTimeout(timerRef.current);
      const tick = () => {
        if (hoverPausedRef.current || hiddenRef.current) {
          timerRef.current = window.setTimeout(tick, 300);
          return;
        }
        setIndex((i) => Math.min(i + 1, last));
      };
      timerRef.current = window.setTimeout(tick, delay);
    },
    [last]
  );

  useEffect(() => {
    setIndex(0);
    if (reduce || sequence.length <= 1) return;
    scheduleNext(interval);
    return () => window.clearTimeout(timerRef.current);
  }, [reduce, sequence, interval, scheduleNext]);

  if (sequence.length === 0) return null;

  const current = reduce ? sequence[last] : sequence[Math.min(index, last)];

  return (
    <span
      aria-hidden
      onPointerEnter={(event) => {
        // Only a real mouse can pause — on touch, pointerenter fires on tap and
        // pointerleave often never does, which would latch the cycle forever.
        if (event.pointerType === 'mouse') hoverPausedRef.current = true;
      }}
      onPointerLeave={() => {
        hoverPausedRef.current = false;
      }}
      onPointerCancel={() => {
        hoverPausedRef.current = false;
      }}
      className="relative inline-grid align-baseline"
    >
      {/* Invisible sizers hold the box at the widest word in the run, measured in
          the real font — so the line never reflows as the word changes. They stay
          in flow, which is also what gives the box its true text baseline. */}
      {sequence.map((name, i) => (
        <span
          key={`sizer-${i}`}
          className="invisible col-start-1 row-start-1 whitespace-nowrap"
        >
          {name}
        </span>
      ))}

      {/* Animated layer sits on top and is clipped, so the slide is masked without
          turning the outer box into a scroll container (which would break the
          baseline the sizers just established). */}
      <span className="absolute inset-0 overflow-hidden">
        {reduce ? (
          <span className={`absolute inset-0 whitespace-nowrap ${className}`}>
            {current}
          </span>
        ) : (
          <AnimatePresence initial={false}>
            <motion.span
              key={index}
              className={`absolute inset-0 whitespace-nowrap ${className}`}
              // Travel is exactly the mask height (100% resolves against the
              // element's own box, which is inset-0 of the clip), so the outgoing
              // word clears the top as the incoming one arrives from the bottom.
              // Anything shorter leaves both inside the window at once — that is
              // what made the names overlap mid-switch. No opacity fade either:
              // crossfading two words in the same slot reads as ghosting.
              initial={{ y: '100%' }}
              animate={{ y: '0%' }}
              exit={{ y: '-100%' }}
              transition={{ duration: SLIDE_S, ease: EASE_APPLE }}
              onAnimationComplete={(definition) => {
                // Chain the next word off the finished *arrival* (the exit of
                // the outgoing word reports completion too — ignore it).
                const arrived =
                  typeof definition === 'object' &&
                  definition !== null &&
                  (definition as { y?: string }).y === '0%';
                if (arrived && index > 0 && index < last) {
                  scheduleNext(Math.max(interval - SLIDE_S * 1000, 250));
                }
              }}
            >
              {current}
            </motion.span>
          </AnimatePresence>
        )}
      </span>
    </span>
  );
}
