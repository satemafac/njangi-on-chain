// GoalCelebration.tsx — The full-circle GoalAchieved moment. Fires when
// the tracker's final milestone completes (the contract emits
// `GoalAchieved` exactly once). Tasteful CSS confetti in the brand
// palette (respects prefers-reduced-motion) plus a shareable summary —
// the celebration belongs to the whole circle, so the copy centres
// "we", not "you".

import React, { useMemo, useState } from 'react';
import { Check, Copy, PartyPopper } from 'lucide-react';
import { formatBaseAmount } from './milestone-plan';

export interface GoalCelebrationProps {
  circleName?: string | null;
  milestoneCount: number;
  /** Total credited contributions, base units of the settlement coin. */
  totalContributed: string;
  coinSymbol: string;
  coinDecimals: number;
  /** Completion timestamp of the final milestone (ms); 0/undefined hides the date. */
  achievedAtMs?: number;
}

const CONFETTI_COLORS = ['#10b981', '#a07b2f', '#5f708a', '#e2b13c', '#1d2533', '#3f7d54'];
const CONFETTI_COUNT = 18;

export function GoalCelebration({
  circleName,
  milestoneCount,
  totalContributed,
  coinSymbol,
  coinDecimals,
  achievedAtMs,
}: GoalCelebrationProps) {
  const [copied, setCopied] = useState(false);

  const amountLabel = `${formatBaseAmount(totalContributed, coinDecimals)} ${coinSymbol}`;
  const dateLabel =
    achievedAtMs && achievedAtMs > 0
      ? new Date(achievedAtMs).toLocaleDateString(undefined, {
          year: 'numeric',
          month: 'long',
          day: 'numeric',
        })
      : null;

  const shareText = useMemo(() => {
    const name = circleName?.trim() ? `“${circleName.trim()}”` : 'Our savings circle';
    const when = dateLabel ? ` on ${dateLabel}` : '';
    return (
      `${name} reached its goal${when}! ` +
      `Together we saved ${amountLabel} and hit all ${milestoneCount} milestone${milestoneCount === 1 ? '' : 's'} — ` +
      `every contribution counted. Saving works better when we do it together.`
    );
  }, [circleName, dateLabel, amountLabel, milestoneCount]);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(shareText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      /* clipboard unavailable — leave the text visible to copy by hand */
    }
  };

  // Deterministic confetti placement so SSR + hydration agree.
  const confetti = useMemo(
    () =>
      Array.from({ length: CONFETTI_COUNT }, (_, i) => ({
        left: `${(i * 53) % 100}%`,
        delay: `${((i * 37) % 20) / 10}s`,
        duration: `${3 + ((i * 29) % 20) / 10}s`,
        color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
        size: 5 + ((i * 13) % 5),
        rotate: (i * 47) % 360,
      })),
    [],
  );

  return (
    <div className="relative overflow-hidden rounded-[28px] border border-emerald-200 bg-gradient-to-br from-emerald-50 via-[#fbfaf7] to-amber-50/60 p-6 shadow-[0_24px_70px_-58px_rgba(15,23,42,0.34)] sm:p-7">
      <style>{`
        @keyframes njangi-confetti-fall {
          0% { transform: translateY(-12px) rotate(0deg); opacity: 0; }
          10% { opacity: 0.9; }
          100% { transform: translateY(180px) rotate(280deg); opacity: 0; }
        }
        .njangi-confetti-piece { animation: njangi-confetti-fall linear infinite; }
        @media (prefers-reduced-motion: reduce) {
          .njangi-confetti-piece { display: none; }
        }
      `}</style>
      <div aria-hidden className="pointer-events-none absolute inset-0">
        {confetti.map((piece, i) => (
          <span
            key={i}
            className="njangi-confetti-piece absolute top-0 rounded-[2px]"
            style={{
              left: piece.left,
              width: `${piece.size}px`,
              height: `${piece.size + 3}px`,
              backgroundColor: piece.color,
              animationDelay: piece.delay,
              animationDuration: piece.duration,
              transform: `rotate(${piece.rotate}deg)`,
            }}
          />
        ))}
      </div>

      <div className="relative">
        <div className="flex h-12 w-12 items-center justify-center rounded-full border border-emerald-300 bg-white text-emerald-700">
          <PartyPopper className="h-6 w-6" />
        </div>
        <h2 className="mt-4 text-2xl font-semibold tracking-[-0.03em] text-[#171923]">
          We did it — goal achieved!
        </h2>
        <p className="mt-2 max-w-xl text-sm leading-6 text-[#4b5565]">
          {circleName?.trim() ? (
            <>
              <span className="font-semibold">{circleName.trim()}</span> reached
              every milestone it set out for
            </>
          ) : (
            <>This circle reached every milestone it set out for</>
          )}
          {dateLabel ? ` on ${dateLabel}` : ''}. Every member&rsquo;s contribution
          made this happen — this win belongs to the whole circle.
        </p>

        <div className="mt-5 grid grid-cols-2 gap-3 sm:max-w-md">
          <div className="rounded-[18px] border border-emerald-200 bg-white/80 p-3.5">
            <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-emerald-700">
              Saved together
            </p>
            <p className="mt-1 text-lg font-semibold text-slate-900">{amountLabel}</p>
          </div>
          <div className="rounded-[18px] border border-emerald-200 bg-white/80 p-3.5">
            <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-emerald-700">
              Milestones reached
            </p>
            <p className="mt-1 text-lg font-semibold text-slate-900">
              {milestoneCount} of {milestoneCount}
            </p>
          </div>
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={onCopy}
            className="inline-flex items-center gap-2 rounded-full bg-[#1d2533] px-5 py-2.5 text-sm font-semibold text-white transition-colors duration-200 hover:bg-[#101723]"
          >
            {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            {copied ? 'Copied — share it with the circle' : 'Copy celebration message'}
          </button>
          <p className="text-xs text-stone-500">
            Paste it into your circle&rsquo;s WhatsApp chat and celebrate together.
          </p>
        </div>
      </div>
    </div>
  );
}

export default GoalCelebration;
