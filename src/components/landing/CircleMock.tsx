import { useRef } from 'react';
import { motion, useScroll, useTransform } from 'framer-motion';
import type { LucideIcon } from 'lucide-react';
import { useReducedMotionAfterMount } from './motion';

export type MockStat = { label: string; value: string; caption: string };
export type MockRow = { icon: LucideIcon; title: string; body: string };

/**
 * What members actually see, shown the way Apple shows a screen: one
 * product surface that lands as you scroll to it (tilts up from the table,
 * scales to rest). Illustrative — the label says so.
 */
export default function CircleMock({
  heading,
  badge,
  caption,
  stats,
  rows,
}: {
  heading: string;
  badge: string;
  caption: string;
  stats: MockStat[];
  rows: MockRow[];
}) {
  const ref = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotionAfterMount();
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start end', 'start 0.3'] });
  const rotateX = useTransform(scrollYProgress, [0, 1], [14, 0]);
  const scale = useTransform(scrollYProgress, [0, 1], [0.9, 1]);
  const y = useTransform(scrollYProgress, [0, 1], [70, 0]);
  const opacity = useTransform(scrollYProgress, [0, 0.45], [0.2, 1]);

  return (
    <div ref={ref} className="mx-auto max-w-[1040px] [perspective:1800px]">
      <motion.div
        style={
          reduce
            ? { rotateX: 0, scale: 1, y: 0, opacity: 1 } // explicit rest, not undefined (see HeroStage)
            : { rotateX, scale, y, opacity, transformOrigin: '50% 100%' }
        }
        className="relative overflow-hidden rounded-[28px] bg-night-tile p-2 shadow-[0_60px_120px_-50px_rgba(232,176,75,0.25)] ring-1 ring-white/[0.08] sm:rounded-[34px] sm:p-3"
      >
        <div className="rounded-[22px] bg-[#0b0b0d] p-5 ring-1 ring-white/[0.05] sm:rounded-[26px] sm:p-8 md:p-10">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-2" aria-hidden>
              <span className="h-2.5 w-2.5 rounded-full bg-white/[0.14]" />
              <span className="h-2.5 w-2.5 rounded-full bg-white/[0.14]" />
              <span className="h-2.5 w-2.5 rounded-full bg-white/[0.14]" />
            </div>
            <span className="rounded-full bg-white/[0.06] px-3 py-1 text-[12px] font-medium text-mist-3">
              {badge}
            </span>
          </div>

          <p className="type-tile mt-7 text-mist">{heading}</p>

          <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {stats.map((stat) => (
              <div key={stat.label} className="rounded-2xl bg-white/[0.04] p-4 sm:p-5">
                <p className="text-[12px] font-medium text-mist-3">{stat.label}</p>
                <p className="mt-1.5 text-[1.5rem] font-semibold leading-tight tracking-[0.004em] text-mist">
                  {stat.value}
                </p>
                <p className="type-caption mt-2 text-mist-3">{stat.caption}</p>
              </div>
            ))}
          </div>

          <ul className="mt-3 grid gap-3 md:grid-cols-3">
            {rows.map((row) => (
              <li key={row.title} className="rounded-2xl bg-white/[0.04] p-4 sm:p-5">
                <span className="flex h-9 w-9 items-center justify-center rounded-full bg-gold/[0.12] text-gold">
                  <row.icon className="h-[18px] w-[18px]" strokeWidth={1.8} />
                </span>
                <p className="mt-4 text-[17px] font-semibold tracking-[-0.022em] text-mist">{row.title}</p>
                <p className="type-caption mt-1.5 text-mist-2">{row.body}</p>
              </li>
            ))}
          </ul>
        </div>
      </motion.div>
      <p className="type-fine mt-5 text-center text-mist-3">{caption}</p>
    </div>
  );
}
