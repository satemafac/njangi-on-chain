import React, { useEffect, useId, useRef, useState } from 'react';
import { goalDisplayFont } from '@/lib/fonts';

export interface GoalPotProgressProps {
  /** Progress toward the goal, 0-100. Values outside the range are clamped. */
  percent: number;
  /** Diameter-ish size of the jar in px (the SVG keeps a portrait aspect ratio). */
  size?: number;
  /** Big headline under the jar, e.g. the amount saved or a date. */
  primaryLabel?: string;
  /** Supporting line under the headline, e.g. "of $5,000 • 24% there". */
  secondaryLabel?: string;
  /** Small eyebrow above the jar, e.g. the goal name. */
  title?: string;
  /** 'amount' fills with coins; 'date' fills with a calendar tint. */
  goalKind?: 'amount' | 'date';
  /** Force the celebratory full state regardless of percent. */
  achieved?: boolean;
  /** Animate the fill rise + count-up. Defaults to true. */
  animate?: boolean;
  className?: string;
}

/**
 * A playful "savings pot" that fills up as a circle's pooled contributions
 * climb toward its shared goal. Friends watch the jar fill — the level rises
 * and the number counts up together — and the jar bursts into a celebration
 * when the goal is reached.
 *
 * Purely presentational — callers compute `percent` (cumulative / target, or
 * elapsed-time for date goals) and pass display labels.
 *
 * Design intelligence applied: ui-ux-pro-max "number count-up" + delightful
 * micro-interactions; frontend-design's "one memorable high-impact moment".
 */
export default function GoalPotProgress({
  percent,
  size = 168,
  primaryLabel,
  secondaryLabel,
  title,
  goalKind = 'amount',
  achieved = false,
  animate = true,
  className = '',
}: GoalPotProgressProps) {
  const rawId = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const clipId = `pot-clip-${rawId}`;
  const fillId = `pot-fill-${rawId}`;
  const glassId = `pot-glass-${rawId}`;
  const waveAnim = `pot-wave-${rawId}`;
  const bobAnim = `pot-bob-${rawId}`;
  const popAnim = `pot-pop-${rawId}`;

  const target = Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0));
  const isFull = achieved || target >= 100;

  // Count-up: animate the displayed value (which drives BOTH the liquid level
  // and the number) from its previous value to the new target.
  const [displayP, setDisplayP] = useState(animate ? 0 : target);
  const fromRef = useRef(animate ? 0 : target);
  useEffect(() => {
    const reduce =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!animate || reduce) {
      setDisplayP(target);
      fromRef.current = target;
      return;
    }
    const from = fromRef.current;
    let raf = 0;
    let startTs = 0;
    const dur = 1000;
    const step = (now: number) => {
      if (!startTs) startTs = now;
      const t = Math.min(1, (now - startTs) / dur);
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplayP(from + (target - from) * eased);
      if (t < 1) {
        raf = requestAnimationFrame(step);
      } else {
        fromRef.current = target;
      }
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, animate]);

  const shown = Math.max(0, Math.min(100, displayP));

  // Jar interior geometry (viewBox 0 0 120 150).
  const interiorTop = 34;
  const interiorBottom = 138;
  const interiorHeight = interiorBottom - interiorTop;
  // Keep a sliver of fill visible once anything lands, so the pot never looks
  // empty after the first contribution.
  const effectiveP = shown > 0 && shown < 4 ? 4 : shown;
  const fillTopY = interiorBottom - (effectiveP / 100) * interiorHeight;
  const showCheck = isFull && shown >= 99.5;

  const palette =
    goalKind === 'date'
      ? { from: '#60a5fa', to: '#2563eb', glow: 'rgba(37,99,235,0.30)' }
      : { from: '#34d399', to: '#059669', glow: 'rgba(5,150,105,0.28)' };
  const accent = isFull ? { from: '#fbbf24', to: '#f59e0b', glow: 'rgba(245,158,11,0.35)' } : palette;

  const width = size;
  const height = Math.round(size * 1.25);

  // Celebration sparkle burst positions (degrees around the jar center).
  const sparkles = [
    { x: 22, y: 40 },
    { x: 98, y: 44 },
    { x: 16, y: 92 },
    { x: 104, y: 96 },
    { x: 40, y: 22 },
    { x: 80, y: 20 },
  ];

  return (
    <div className={`${goalDisplayFont.className} flex flex-col items-center ${className}`}>
      {title ? (
        <p className="mb-1 max-w-[14rem] truncate text-center text-[11px] font-semibold uppercase tracking-[0.18em] text-[#717784]">
          {title}
        </p>
      ) : null}

      <svg
        width={width}
        height={height}
        viewBox="0 0 120 150"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        role="img"
        aria-label={
          secondaryLabel
            ? `Goal progress: ${Math.round(target)}% — ${secondaryLabel}`
            : `Goal progress: ${Math.round(target)}%`
        }
      >
        <defs>
          <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={accent.from} />
            <stop offset="100%" stopColor={accent.to} />
          </linearGradient>
          <linearGradient id={glassId} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0.9" />
            <stop offset="100%" stopColor="#eef2f7" stopOpacity="0.5" />
          </linearGradient>
          <clipPath id={clipId}>
            <rect x="18" y={interiorTop} width="84" height={interiorHeight} rx="20" />
          </clipPath>
        </defs>

        {/* Glow + sparkle burst when the goal is reached */}
        {isFull ? (
          <>
            <ellipse cx="60" cy="86" rx="56" ry="62" fill={accent.glow} opacity="0.9" />
            {showCheck
              ? sparkles.map((s, i) => (
                  <circle
                    key={i}
                    cx={s.x}
                    cy={s.y}
                    r="3.4"
                    fill="#fbbf24"
                    className={animate ? popAnim : undefined}
                    style={animate ? { animationDelay: `${i * 90}ms` } : undefined}
                  />
                ))
              : null}
          </>
        ) : null}

        {/* Jar lid */}
        <rect x="34" y="14" width="52" height="14" rx="6" fill="#cdd6e2" />
        <rect x="38" y="11" width="44" height="8" rx="4" fill="#dde4ee" />

        {/* Jar glass body */}
        <rect
          x="14"
          y="30"
          width="92"
          height="112"
          rx="24"
          fill={`url(#${glassId})`}
          stroke="#c4cdda"
          strokeWidth="2.5"
        />

        {/* Liquid fill, clipped to the jar interior (level driven by count-up) */}
        <g clipPath={`url(#${clipId})`}>
          <g style={{ transform: `translateY(${fillTopY - interiorBottom}px)` }}>
            {/* Body of the liquid (anchored at the bottom, raised via translateY) */}
            <rect x="16" y={interiorBottom} width="88" height={interiorHeight + 8} fill={`url(#${fillId})`} />
            {/* Wavy surface */}
            <g className={animate ? waveAnim : undefined}>
              <path
                d={`M-40 ${interiorBottom} q 20 -9 40 0 t 40 0 t 40 0 t 40 0 t 40 0 V ${interiorBottom + 12} H -40 Z`}
                fill={`url(#${fillId})`}
                opacity="0.95"
              />
              <path
                d={`M-40 ${interiorBottom} q 20 9 40 0 t 40 0 t 40 0 t 40 0 t 40 0 V ${interiorBottom + 12} H -40 Z`}
                fill={accent.to}
                opacity="0.35"
              />
            </g>
            {/* Floating bubbles for a little life */}
            {shown > 8 ? (
              <g className={animate ? bobAnim : undefined} fill="#ffffff" opacity="0.5">
                <circle cx="42" cy={interiorBottom - 14} r="3" />
                <circle cx="70" cy={interiorBottom - 24} r="2" />
                <circle cx="58" cy={interiorBottom - 9} r="2.4" />
              </g>
            ) : null}
          </g>
        </g>

        {/* Glass shine */}
        <rect x="24" y="40" width="10" height="80" rx="5" fill="#ffffff" opacity="0.45" />

        {/* Centered count-up percent / achieved badge */}
        {showCheck ? (
          <path
            d="M48 84 l8 9 l16 -19"
            stroke="#ffffff"
            strokeWidth="6"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        ) : (
          <text
            x="60"
            y="92"
            textAnchor="middle"
            fontSize="26"
            fontWeight="700"
            fill={shown > 52 ? '#ffffff' : '#1f2937'}
            style={{ fontVariantNumeric: 'tabular-nums' }}
          >
            {Math.round(shown)}%
          </text>
        )}
      </svg>

      {(primaryLabel || secondaryLabel) && (
        <div className="mt-1 text-center">
          {primaryLabel ? (
            <p className="text-lg font-semibold tracking-[-0.01em] text-[#171923]">{primaryLabel}</p>
          ) : null}
          {secondaryLabel ? <p className="mt-0.5 text-xs text-[#5f6674]">{secondaryLabel}</p> : null}
        </div>
      )}

      {/* Scoped keyframes (unique names avoid collisions when multiple jars render) */}
      <style>{`
        @keyframes ${waveAnim} { from { transform: translateX(0); } to { transform: translateX(-80px); } }
        @keyframes ${bobAnim} { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-4px); } }
        @keyframes ${popAnim} { 0% { transform: scale(0); opacity: 0; } 40% { transform: scale(1.25); opacity: 1; } 100% { transform: scale(0.6); opacity: 0; } }
        .${waveAnim} { animation: ${waveAnim} 3.2s linear infinite; }
        .${bobAnim} { animation: ${bobAnim} 2.6s ease-in-out infinite; }
        .${popAnim} { transform-box: fill-box; transform-origin: center; animation: ${popAnim} 1.1s ease-out forwards; }
        @media (prefers-reduced-motion: reduce) {
          .${waveAnim}, .${bobAnim}, .${popAnim} { animation: none; }
        }
      `}</style>
    </div>
  );
}
