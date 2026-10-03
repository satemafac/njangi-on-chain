import { useRef, type ElementType } from 'react';
import { motion, useScroll, useTransform, type MotionValue } from 'framer-motion';
import { useReducedMotionAfterMount } from './motion';

/**
 * A statement that lights up word by word as it scrolls through the
 * viewport — the reading pace is the scroll pace (apple.com's highlight
 * paragraphs). Words rest at 38% opacity, which keeps even the unlit state
 * at ≥3:1 for this display size, and reach full strength by the time the
 * paragraph is two-thirds up the screen. Opacity only; no layout moves.
 */
export default function ScrollLitText({
  text,
  as: Tag = 'p',
  className = '',
}: {
  text: string;
  as?: ElementType;
  className?: string;
}) {
  const ref = useRef<HTMLElement>(null);
  const reduce = useReducedMotionAfterMount();
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ['start 0.82', 'end 0.42'],
  });
  const words = text.split(/\s+/).filter(Boolean);

  return (
    <Tag ref={ref} className={className}>
      {words.map((word, i) => (
        <Word
          key={`${i}-${word}`}
          progress={scrollYProgress}
          start={i / words.length}
          end={(i + 1) / words.length}
          still={reduce}
        >
          {word}
        </Word>
      ))}
    </Tag>
  );
}

function Word({
  children,
  progress,
  start,
  end,
  still,
}: {
  children: string;
  progress: MotionValue<number>;
  start: number;
  end: number;
  still: boolean;
}) {
  const opacity = useTransform(progress, [start, end], [0.38, 1]);
  return (
    <>
      <motion.span style={{ opacity: still ? 1 : opacity }}>{children}</motion.span>{' '}
    </>
  );
}
