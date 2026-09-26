import { useRef } from 'react';
import { motion, useScroll, useTransform, type MotionValue } from 'framer-motion';
import { useReducedMotionAfterMount } from './motion';

/**
 * The tradition's many names, set large in the brand serif, lighting one
 * after another as the wall scrolls through the viewport — twenty-five
 * communities, one practice. Unlit names rest at the tertiary gray (4.1:1,
 * well above the 3:1 large-text floor); `highlight` lands in gold.
 */
export default function NamesLight({
  names,
  highlight,
  serifClassName,
}: {
  names: string[];
  highlight?: string;
  serifClassName: string;
}) {
  const ref = useRef<HTMLParagraphElement>(null);
  const reduce = useReducedMotionAfterMount();
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start 0.85', 'end 0.55'] });

  return (
    <p
      ref={ref}
      className={`${serifClassName} mx-auto max-w-[1000px] text-center text-[clamp(1.9rem,1.1rem+2.9vw,3.75rem)] leading-[1.22] tracking-[-0.01em]`}
    >
      {names.map((name, i) => (
        <Name
          key={name}
          name={name}
          progress={scrollYProgress}
          start={(i / names.length) * 0.9}
          end={(i / names.length) * 0.9 + 0.1}
          gold={name === highlight}
          still={reduce}
        />
      ))}
    </p>
  );
}

function Name({
  name,
  progress,
  start,
  end,
  gold,
  still,
}: {
  name: string;
  progress: MotionValue<number>;
  start: number;
  end: number;
  gold: boolean;
  still: boolean;
}) {
  const lit = useTransform(progress, [start, end], [0, 1]);
  return (
    <>
      <span className="relative inline-block whitespace-nowrap px-[0.22em]">
        <span className="text-mist-4">{name}</span>
        <motion.span
          aria-hidden
          className={`absolute inset-0 px-[0.22em] ${gold ? 'text-gold-gradient' : 'text-mist'}`}
          style={{ opacity: still ? 1 : lit }}
        >
          {name}
        </motion.span>
      </span>{' '}
    </>
  );
}
