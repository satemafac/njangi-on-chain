import { useRef, type ReactNode } from 'react';

/**
 * Pointer-tilt wrapper for tactile 3D depth on hover. Rotates toward the cursor
 * in real perspective and tracks a soft gold glare. No-op under reduced motion
 * or on touch (coarse pointer), so keyboard/touch users get a flat, stable card.
 */
export default function TiltCard({
  children,
  className = '',
  max = 7,
}: {
  children: ReactNode;
  className?: string;
  max?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);

  const reduce = () =>
    typeof window !== 'undefined' &&
    (window.matchMedia('(prefers-reduced-motion: reduce)').matches ||
      window.matchMedia('(pointer: coarse)').matches);

  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = ref.current;
    if (!el || reduce()) return;
    const r = el.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width - 0.5;
    const py = (e.clientY - r.top) / r.height - 0.5;
    el.style.transform = `perspective(1000px) rotateX(${-py * max}deg) rotateY(${
      px * max
    }deg) translateZ(0)`;
    el.style.setProperty('--glare-x', `${(px + 0.5) * 100}%`);
    el.style.setProperty('--glare-y', `${(py + 0.5) * 100}%`);
  };

  const onLeave = () => {
    const el = ref.current;
    if (!el) return;
    el.style.transform = 'perspective(1000px) rotateX(0) rotateY(0)';
  };

  return (
    <div
      ref={ref}
      onPointerMove={onMove}
      onPointerLeave={onLeave}
      className={`group/tilt relative transition-transform duration-200 ease-out will-change-transform ${className}`}
      style={
        {
          ['--glare-x' as string]: '50%',
          ['--glare-y' as string]: '50%',
        } as React.CSSProperties
      }
    >
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 rounded-[inherit] opacity-0 transition-opacity duration-300 group-hover/tilt:opacity-100"
        style={{
          background:
            'radial-gradient(420px circle at var(--glare-x) var(--glare-y), rgba(232,176,75,0.16), transparent 60%)',
        }}
      />
      {children}
    </div>
  );
}
