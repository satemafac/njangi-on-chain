import { useEffect, useRef, useState } from 'react';
import { animate, useInView } from 'framer-motion';
import { EASE_APPLE } from './motion';

export type Proof = {
  label: string;
  /** Counts up from 0 when it scrolls into view. */
  count?: number;
  suffix?: string;
  /** Shown as-is when there is no number to count (e.g. "Syncing"). */
  text?: string;
};

/**
 * Apple's "by the numbers" band: a few big figures, one short caption each,
 * divided by hairlines. Numbers count up once when they arrive; words (a
 * status like "Syncing", or "Self-held") are set a size down so a long
 * translation never breaks the row.
 */
export default function ProofNumbers({ items }: { items: Proof[] }) {
  return (
    <dl className="mx-auto grid max-w-[1100px] grid-cols-1 gap-y-14 sm:grid-cols-3 sm:gap-y-0 sm:divide-x sm:divide-white/[0.12] rtl:sm:divide-x-reverse">
      {items.map((item) => (
        <div key={item.label} className="flex flex-col-reverse items-center px-6 text-center">
          <dt className="type-body mt-3 text-mist-3">{item.label}</dt>
          <dd className="flex min-h-[1em] items-end justify-center text-mist type-figure">
            {typeof item.count === 'number' ? (
              <CountUp to={item.count} suffix={item.suffix} />
            ) : (
              <span className="type-headline pb-[0.12em]">{item.text}</span>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function CountUp({ to, suffix = '' }: { to: number; suffix?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, amount: 0.8 });
  // Server + first paint show the real figure (crawlers, no-JS, and anyone
  // who lands with it already on screen). Only a figure that is still below
  // the fold is parked at 0 so it can count up when it arrives.
  const [value, setValue] = useState(to);
  const parked = useRef(false);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setValue(to);
      return;
    }
    if (!inView) {
      parked.current = true;
      setValue(0);
    } else if (!parked.current) {
      setValue(to);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [to]);

  useEffect(() => {
    if (!inView || !parked.current) return;
    const controls = animate(0, to, {
      duration: 1.4,
      ease: EASE_APPLE,
      onUpdate: (v) => setValue(Math.round(v)),
    });
    return () => controls.stop();
  }, [inView, to]);

  return (
    <span ref={ref}>
      {value}
      <span className="text-gold">{suffix}</span>
    </span>
  );
}
