import { useRef } from 'react';
import {
  motion,
  useMotionValue,
  useScroll,
  useTransform,
  type MotionValue,
} from 'framer-motion';
import { Coins, User } from 'lucide-react';
import { useReducedMotionAfterMount } from './motion';

export type StoryStep = { number: string; title: string; body: string };

/*
 * How a circle turns, told by scroll. A pinned stage holds a ring of eight
 * members around the pot; one progress value (0 → 1 across the runway)
 * scrubs the whole scene, forwards and backwards:
 *
 *   step 1  members arrive, each gets a wallet (the gold badge)
 *   step 2  the ring draws in and the payout order is numbered
 *   step 3  everyone pays in, the pot fills, pays member 1, and the turn
 *           passes to member 2
 *
 * The copy is real DOM text (read in order by assistive tech); the drawing
 * is decorative. Reduced motion gets the same three states as a plain list.
 */

const N = 8;
const RING = 150;
const NODE_R = 19;
const POT_R = 46;

// Step windows on the shared progress axis.
const S1: [number, number] = [0.02, 0.26];
const S2: [number, number] = [0.34, 0.58];
const S3: [number, number] = [0.66, 0.97];

const angle = (i: number) => (-90 + (360 / N) * i) * (Math.PI / 180);
const at = (i: number, r = RING) => ({ x: r * Math.cos(angle(i)), y: r * Math.sin(angle(i)) });
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
// Sub-window of step 3, as a fraction of it.
const s3 = (a: number, b: number): [number, number] => [lerp(S3[0], S3[1], a), lerp(S3[0], S3[1], b)];

function Member({ i, p }: { i: number; p: MotionValue<number> }) {
  const { x, y } = at(i);
  const arrive = lerp(S1[0], S1[1] - 0.06, i / N);
  const opacity = useTransform(p, [arrive, arrive + 0.05], [0, 1]);
  const scale = useTransform(p, [arrive, arrive + 0.06], [0.55, 1]);
  const badge = useTransform(p, [arrive + 0.05, arrive + 0.09], [0, 1]);
  const orderOpacity = useTransform(
    p,
    [lerp(S2[0] + 0.04, S2[1] - 0.04, i / N), lerp(S2[0] + 0.08, S2[1], i / N)],
    [0, 1]
  );
  // Member 1 receives the pot (and stays gold: paid this lap).
  const paid = useTransform(p, i === 0 ? s3(0.5, 0.62) : [2, 3], [0, 1]);
  const label = at(i, RING + 38);

  return (
    <g>
      <motion.g style={{ opacity, scale, x, y }}>
        <circle r={NODE_R} fill="#1d1d1f" stroke="rgba(255,255,255,0.16)" strokeWidth={1} />
        <motion.circle r={NODE_R} fill="url(#story-gold)" style={{ opacity: paid }} />
        <User x={-8} y={-8} width={16} height={16} color="#a1a1a6" strokeWidth={1.8} />
        <motion.g style={{ opacity: badge }}>
          <circle cx={13} cy={-13} r={5.5} fill="#E8B04B" stroke="#000" strokeWidth={2} />
        </motion.g>
      </motion.g>
      <motion.text
        x={label.x}
        y={label.y}
        textAnchor="middle"
        dominantBaseline="central"
        fill="#86868b"
        fontSize={13}
        fontWeight={600}
        style={{ opacity: orderOpacity }}
      >
        {i + 1}
      </motion.text>
    </g>
  );
}

function Contribution({ i, p }: { i: number; p: MotionValue<number> }) {
  const from = at(i);
  const [a, b] = s3(0.02 + i * 0.025, 0.3 + i * 0.025);
  const t = useTransform(p, [a, b], [0, 1]);
  const cx = useTransform(t, (v) => lerp(from.x * 0.86, 0, v));
  const cy = useTransform(t, (v) => lerp(from.y * 0.86, 0, v));
  const opacity = useTransform(t, [0, 0.12, 0.85, 1], [0, 1, 1, 0]);
  return <motion.circle r={4} fill="#f6d99a" cx={cx} cy={cy} style={{ opacity }} />;
}

function Ring({ p }: { p: MotionValue<number> }) {
  const draw = useTransform(p, [S2[0], S2[1] - 0.06], [0, 1]);
  const potIn = useTransform(p, [S2[0] + 0.1, S2[1]], [0, 1]);
  // Pot fills with the contributions, empties into member 1's payout.
  const fill = useTransform(p, [...s3(0.12, 0.44), ...s3(0.5, 0.6)], [0, 1, 1, 0]);
  const fillY = useTransform(fill, (v) => lerp(POT_R, -POT_R, v));
  const payT = useTransform(p, s3(0.46, 0.6), [0, 1]);
  const target = at(0);
  const payX = useTransform(payT, (v) => lerp(0, target.x, v));
  const payY = useTransform(payT, (v) => lerp(0, target.y * 0.86, v));
  const payOpacity = useTransform(payT, [0, 0.1, 0.9, 1], [0, 1, 1, 0]);
  // The turn: a halo that settles on member 1 as they're paid, then walks
  // the ring to member 2. Positioned by angle (cx/cy), so it travels the
  // circle instead of spinning in place.
  const turn = useTransform(p, s3(0.66, 0.88), [0, 1]);
  const haloOpacity = useTransform(p, s3(0.54, 0.62), [0, 1]);
  const haloAngle = (v: number) => angle(0) + v * ((Math.PI * 2) / N);
  const haloX = useTransform(turn, (v) => RING * Math.cos(haloAngle(v)));
  const haloY = useTransform(turn, (v) => RING * Math.sin(haloAngle(v)));

  return (
    <svg viewBox="-206 -206 412 412" className="h-full w-full overflow-visible" aria-hidden>
      <defs>
        <linearGradient id="story-gold" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#f6d99a" />
          <stop offset="0.5" stopColor="#E8B04B" />
          <stop offset="1" stopColor="#C8902F" />
        </linearGradient>
        <radialGradient id="story-glow">
          <stop offset="0" stopColor="rgba(232,176,75,0.22)" />
          <stop offset="1" stopColor="rgba(232,176,75,0)" />
        </radialGradient>
        <clipPath id="story-pot">
          <circle r={POT_R - 3} />
        </clipPath>
      </defs>

      <circle r={RING + 60} fill="url(#story-glow)" />
      <circle r={RING} fill="none" stroke="rgba(255,255,255,0.09)" strokeWidth={1.5} />
      <g transform="rotate(-90)">
        <motion.circle
          r={RING}
          fill="none"
          stroke="url(#story-gold)"
          strokeWidth={1.5}
          style={{ pathLength: draw }}
        />
      </g>

      {/* The pot */}
      <motion.g style={{ opacity: potIn }}>
        <circle r={POT_R} fill="#0e0e10" stroke="rgba(232,176,75,0.45)" strokeWidth={1.2} />
        <g clipPath="url(#story-pot)">
          <motion.rect
            x={-POT_R}
            y={0}
            width={POT_R * 2}
            height={POT_R * 2 + 4}
            fill="url(#story-gold)"
            opacity={0.9}
            style={{ y: fillY }}
          />
        </g>
        <Coins x={-11} y={-11} width={22} height={22} color="#f5f5f7" strokeWidth={1.6} />
      </motion.g>

      {Array.from({ length: N }, (_, i) => (
        <Contribution key={`c${i}`} i={i} p={p} />
      ))}
      <motion.circle r={7} fill="#f6d99a" cx={payX} cy={payY} style={{ opacity: payOpacity }} />

      {Array.from({ length: N }, (_, i) => (
        <Member key={`m${i}`} i={i} p={p} />
      ))}
      <motion.circle
        r={NODE_R + 8}
        fill="none"
        stroke="#f6d99a"
        strokeWidth={1.6}
        cx={haloX}
        cy={haloY}
        style={{ opacity: haloOpacity }}
      />
    </svg>
  );
}

function StepCopy({
  step,
  index,
  p,
}: {
  step: StoryStep;
  index: number;
  p: MotionValue<number>;
}) {
  const windows = [S1, S2, S3];
  const [a, b] = windows[index];
  const first = index === 0;
  const last = index === windows.length - 1;
  // Hand-offs are sequential (out, then in) so two captions never share the
  // slot at once — overlapping crossfades read as ghosting.
  const inRange = [a - 0.03, a + 0.01];
  const outRange = [b + 0.01, b + 0.05];
  const keys = first ? outRange : last ? inRange : [...inRange, ...outRange];
  const opacity = useTransform(p, keys, first ? [1, 0] : last ? [0, 1] : [0, 1, 1, 0]);
  const y = useTransform(p, keys, first ? [0, -18] : last ? [18, 0] : [18, 0, 0, -18]);
  return (
    <motion.div style={{ opacity, y }} className="col-start-1 row-start-1">
      <p className="type-eyebrow text-gold">{step.number}</p>
      <h3 className="type-headline mt-3 text-mist">{step.title}</h3>
      <p className="type-intro mt-4 max-w-md text-mist-2">{step.body}</p>
    </motion.div>
  );
}

function Progress({ p }: { p: MotionValue<number> }) {
  const bars = [S1, S2, S3].map(([a, b]) => [a - 0.02, b] as [number, number]);
  return (
    <div className="flex gap-2" aria-hidden>
      {bars.map((range, i) => (
        <ProgressBar key={i} p={p} range={range} />
      ))}
    </div>
  );
}

function ProgressBar({ p, range }: { p: MotionValue<number>; range: [number, number] }) {
  const scaleX = useTransform(p, range, [0, 1]);
  return (
    <span className="relative h-[3px] w-10 overflow-hidden rounded-full bg-white/[0.12]">
      <motion.span className="absolute inset-0 origin-left rounded-full bg-gold" style={{ scaleX }} />
    </span>
  );
}

/** A frozen scene at a fixed progress (reduced-motion list). */
function StillRing({ at: value }: { at: number }) {
  const p = useMotionValue(value);
  return <Ring p={p} />;
}

export default function RotationStory({ steps }: { steps: StoryStep[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotionAfterMount();
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start start', 'end end'] });

  if (reduce) {
    const stills = [S1[1] + 0.02, S2[1] + 0.02, S3[1] + 0.02];
    return (
      <ol className="mx-auto grid max-w-[1100px] gap-16 px-5 sm:px-8 md:gap-24">
        {steps.map((step, i) => (
          <li key={step.number} className="grid items-center gap-8 md:grid-cols-2 md:gap-16">
            <div className="mx-auto aspect-square w-full max-w-[380px]">
              <StillRing at={stills[i] ?? 1} />
            </div>
            <div>
              <p className="type-eyebrow text-gold">{step.number}</p>
              <h3 className="type-headline mt-3 text-mist">{step.title}</h3>
              <p className="type-intro mt-4 max-w-md text-mist-2">{step.body}</p>
            </div>
          </li>
        ))}
      </ol>
    );
  }

  return (
    <div ref={ref} className="relative h-[380svh]">
      <div className="sticky top-0 flex h-[100svh] items-center overflow-hidden pt-[52px]">
        <div className="mx-auto grid w-full max-w-[1180px] items-center gap-6 px-5 sm:px-8 md:grid-cols-[1.2fr_0.8fr] md:gap-14">
          <div className="mx-auto aspect-square w-full max-w-[min(360px,46svh)] md:max-w-[min(640px,76svh)]">
            <Ring p={scrollYProgress} />
          </div>
          <div>
            <ol className="grid min-h-[13.5rem] md:min-h-[16rem]">
              {steps.map((step, i) => (
                <li key={step.number} className="col-start-1 row-start-1">
                  <StepCopy step={step} index={i} p={scrollYProgress} />
                </li>
              ))}
            </ol>
            <div className="mt-8">
              <Progress p={scrollYProgress} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
