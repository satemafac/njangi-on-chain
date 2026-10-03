import { motion, type Variants } from 'framer-motion';
import { Check, Wallet, type LucideIcon } from 'lucide-react';
import { EASE_APPLE, useReducedMotionAfterMount } from './motion';

export type FeatureKey = 'ledger' | 'custody' | 'borderless' | 'friction';
export type Feature = { key: FeatureKey; icon: LucideIcon; title: string; body: string };

/*
 * Apple-style bento: four tiles of unequal width on a black canvas, each a
 * short headline, one sentence, and a small diagram that plays once when the
 * tile arrives. Tiles are not links, so they don't pretend to be — no hover
 * lift, no tilt. Diagrams are decorative (aria-hidden); the copy carries it.
 */

const tileIn: Variants = {
  hidden: { opacity: 0, y: 40 },
  show: (i: number) => ({
    opacity: 1,
    y: 0,
    transition: { duration: 1, ease: EASE_APPLE, delay: (i % 2) * 0.08 },
  }),
};

export default function FeatureBento({ features }: { features: Feature[] }) {
  // Reduced motion: tiles and diagrams are simply present, settled — they
  // don't wait for an in-view trigger to become visible.
  const reduce = useReducedMotionAfterMount();
  const arrive = reduce ? { animate: 'show' } : { whileInView: 'show' };
  return (
    <div className="mx-auto grid max-w-[1100px] gap-4 md:grid-cols-12 md:gap-5">
      {features.map((feature, i) => (
        <motion.article
          key={feature.key}
          custom={i}
          variants={tileIn}
          initial="hidden"
          {...arrive}
          viewport={{ once: true, amount: 0.2 }}
          className={`relative flex min-h-[26rem] flex-col overflow-hidden rounded-[28px] bg-night-tile p-7 sm:p-9 md:p-10 ${
            i === 0 || i === 3 ? 'md:col-span-7' : 'md:col-span-5'
          }`}
        >
          <div
            aria-hidden
            className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full"
            style={{ background: 'radial-gradient(closest-side, rgba(232,176,75,0.10), transparent)' }}
          />
          <div className="relative">
            <span className="flex h-11 w-11 items-center justify-center rounded-full bg-gold/[0.12] text-gold">
              <feature.icon className="h-5 w-5" strokeWidth={1.8} />
            </span>
            <h3 className="type-tile mt-6 max-w-[20ch] text-mist">{feature.title}</h3>
            <p className="type-body mt-3 max-w-[36ch] text-mist-2">{feature.body}</p>
          </div>
          <motion.div
            aria-hidden
            className="relative mt-auto pt-10"
            initial="hidden"
            {...arrive}
            viewport={{ once: true, amount: 0.6 }}
          >
            {feature.key === 'ledger' && <LedgerDiagram />}
            {feature.key === 'custody' && <CustodyDiagram />}
            {feature.key === 'borderless' && <BorderlessDiagram />}
            {feature.key === 'friction' && <FrictionDiagram />}
          </motion.div>
        </motion.article>
      ))}
    </div>
  );
}

/* ---------- diagrams ---------- */

const stagger = (delayChildren = 0.2, staggerChildren = 0.12): Variants => ({
  hidden: {},
  show: { transition: { delayChildren, staggerChildren } },
});

const pop: Variants = {
  hidden: { opacity: 0, scale: 0.4 },
  show: { opacity: 1, scale: 1, transition: { duration: 0.5, ease: EASE_APPLE } },
};

/** Every member's line in the shared record, each confirmed in turn. */
function LedgerDiagram() {
  const widths = ['46%', '38%', '52%', '31%'];
  return (
    <motion.div variants={stagger(0.25, 0.14)} className="space-y-2.5">
      {widths.map((w, i) => (
        <div key={i} className="flex items-center gap-3 rounded-2xl bg-white/[0.04] px-4 py-3">
          <span className="h-7 w-7 shrink-0 rounded-full bg-white/[0.08]" />
          <span className="h-2 rounded-full bg-white/[0.14]" style={{ width: w }} />
          <span className="ml-auto h-2 w-10 shrink-0 rounded-full bg-white/[0.08]" />
          <motion.span
            variants={pop}
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-gold text-black"
          >
            <Check className="h-3 w-3" strokeWidth={3} />
          </motion.span>
        </div>
      ))}
    </motion.div>
  );
}

/** Wallet to wallet, directly — no one in the middle holding the pot. */
function CustodyDiagram() {
  return (
    <div className="flex items-center gap-4">
      <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-white/[0.06] text-mist-2">
        <Wallet className="h-6 w-6" strokeWidth={1.6} />
      </span>
      <div className="relative h-px flex-1 bg-[repeating-linear-gradient(90deg,rgba(255,255,255,0.22)_0_6px,transparent_6px_12px)]">
        {/* A full-width carrier translated by its own width, so the dot
            crosses the track on transform alone (no `left` animation). */}
        <motion.span
          className="absolute inset-y-0 left-0 w-full"
          variants={{
            hidden: { x: '0%', opacity: 0 },
            show: {
              x: ['0%', '100%'],
              opacity: [0, 1, 1, 0],
              transition: {
                x: { duration: 1.8, delay: 0.35, ease: EASE_APPLE },
                opacity: { duration: 1.8, delay: 0.35, times: [0, 0.15, 0.85, 1] },
              },
            },
          }}
        >
          <span className="absolute -left-[5px] -top-[5px] h-[11px] w-[11px] rounded-full bg-gold shadow-[0_0_16px_rgba(232,176,75,0.8)]" />
        </motion.span>
      </div>
      <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-gold/[0.14] text-gold">
        <Wallet className="h-6 w-6" strokeWidth={1.6} />
      </span>
    </div>
  );
}

/** Three cities on one arc of the circle. */
function BorderlessDiagram() {
  const draw: Variants = {
    hidden: { pathLength: 0, opacity: 0 },
    show: (i: number) => ({
      pathLength: 1,
      opacity: 1,
      transition: { duration: 1.1, delay: 0.25 + i * 0.25, ease: EASE_APPLE },
    }),
  };
  return (
    <svg viewBox="0 0 320 110" className="h-auto w-full max-w-[420px]">
      <line x1="10" y1="92" x2="310" y2="92" stroke="rgba(255,255,255,0.1)" strokeDasharray="2 6" />
      <motion.path
        custom={0}
        variants={draw}
        d="M 40 92 Q 100 12 160 92"
        fill="none"
        stroke="#E8B04B"
        strokeWidth="1.5"
      />
      <motion.path
        custom={1}
        variants={draw}
        d="M 160 92 Q 220 12 280 92"
        fill="none"
        stroke="#E8B04B"
        strokeWidth="1.5"
      />
      <motion.path
        custom={2}
        variants={draw}
        d="M 40 92 Q 160 -40 280 92"
        fill="none"
        stroke="rgba(77,162,255,0.7)"
        strokeWidth="1.2"
      />
      {[40, 160, 280].map((x) => (
        <g key={x}>
          <circle cx={x} cy={92} r={11} fill="rgba(232,176,75,0.15)" />
          <circle cx={x} cy={92} r={5} fill="#f6d99a" />
        </g>
      ))}
    </svg>
  );
}

/** The did-you-pay-yet thread fades out; one settled state remains. */
function FrictionDiagram() {
  const fade: Variants = {
    hidden: { opacity: 1, x: 0 },
    show: { opacity: 0.32, x: -6, transition: { duration: 0.8, ease: EASE_APPLE } },
  };
  return (
    <motion.div variants={stagger(0.3, 0.18)} className="flex flex-col gap-2.5">
      {[62, 48, 56].map((w, i) => (
        <motion.div
          key={i}
          variants={fade}
          className="flex w-fit flex-col gap-1.5 rounded-[18px] rounded-bl-md bg-white/[0.07] px-4 py-3"
          style={{ minWidth: `${w}%` }}
        >
          <span className="h-1.5 w-[70%] rounded-full bg-white/[0.2]" />
          <span className="h-1.5 w-[45%] rounded-full bg-white/[0.12]" />
        </motion.div>
      ))}
      <motion.div
        variants={{
          hidden: { opacity: 0, y: 10 },
          show: { opacity: 1, y: 0, transition: { duration: 0.7, ease: EASE_APPLE } },
        }}
        className="ms-auto flex items-center gap-2 rounded-[18px] rounded-br-md bg-gold px-4 py-3 text-[#1d1d1f]"
      >
        <Check className="h-4 w-4" strokeWidth={2.6} />
        <span className="h-1.5 w-16 rounded-full bg-black/25" />
      </motion.div>
    </motion.div>
  );
}
