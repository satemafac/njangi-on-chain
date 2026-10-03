// PayoutCelebration.tsx — the moment a member collects their turn.
//
// Spec: marketing/handoff/inbox/003-founder-moments-spec/SPEC.md §2–3.
//
// Copy rules, enforced by wording here and by `npm run check:copy`:
//  * A payout is the member's OWN turn — their circle's contributions coming
//    to them on schedule. Never "winnings", "profits", "returns", "growth",
//    "earned". Say "your turn", "your payout".
//  * Dignified, not casino: one heading, the facts, two actions.
//  * No auto-posting anywhere. "Share" copies a plain-text card the member
//    pastes wherever they choose.
//  * "Share your story" is a quote with an explicit marketing-consent
//    checkbox; nothing is stored without it (see /api/testimonials).
//
// Visual language mirrors VerificationRequiredModal / BillingUpsellModal
// (paper surface, ink text, pill buttons) so the moment feels like the
// product, and the confetti is the same restrained kind GoalCelebration uses.

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import * as Dialog from '@radix-ui/react-dialog';
import { CheckCircle2, Copy, MessageSquareQuote, PlusCircle, X } from 'lucide-react';
import { toast } from 'react-hot-toast';
import { copyToClipboard, manualCopyMessage } from '@/lib/copy-to-clipboard';

export interface PayoutCelebrationProps {
  open: boolean;
  onClose: () => void;
  /** Formatted amount, e.g. "50 USDC". Circle currency only — no local estimate. */
  amount: string;
  /** Round number within the rotation, as shown elsewhere in the panel. */
  cycleNo: number | string;
  circleName?: string;
  circleId: string;
  /** Transaction digest of the claim; used so the moment shows once per payout. */
  txDigest?: string | null;
}

const QUOTE_MIN = 12;
const QUOTE_MAX = 600;

export function buildShareText(input: {
  amount: string;
  cycleNo: number | string;
  circleName?: string;
}): string {
  const circle = input.circleName ? ` in ${input.circleName}` : '';
  return (
    `It's my turn: I just received my circle payout of ${input.amount}` +
    `${circle}, round ${input.cycleNo}. Nobody held the pot. njangionchain.com`
  );
}

export function PayoutCelebration({
  open,
  onClose,
  amount,
  cycleNo,
  circleName,
  circleId,
}: PayoutCelebrationProps) {
  const [mode, setMode] = useState<'moment' | 'story' | 'thanks'>('moment');
  const [quote, setQuote] = useState('');
  const [consent, setConsent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduceMotion(mq.matches);
  }, []);

  useEffect(() => {
    if (open) {
      setMode('moment');
      setQuote('');
      setConsent(false);
    }
  }, [open]);

  const onCopyCard = useCallback(async () => {
    const text = buildShareText({ amount, cycleNo, circleName });
    const outcome = await copyToClipboard(text);
    if (outcome === 'failed') {
      toast(manualCopyMessage('Share text', text), { duration: 8000 });
    } else {
      toast.success('Copied. Paste it wherever you like.');
    }
  }, [amount, cycleNo, circleName]);

  const onSubmitStory = useCallback(async () => {
    const trimmed = quote.trim();
    if (trimmed.length < QUOTE_MIN) {
      toast.error(`A few more words — at least ${QUOTE_MIN} characters.`);
      return;
    }
    if (!consent) {
      toast.error('Tick the consent box so we know we may share your story.');
      return;
    }
    setSubmitting(true);
    try {
      const resp = await fetch('/api/testimonials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ circleId, quote: trimmed, consentMarketing: true }),
      });
      if (!resp.ok) {
        const body = (await resp.json().catch(() => ({}))) as { message?: string };
        toast.error(body.message ?? 'Could not save your story right now.');
        return;
      }
      setMode('thanks');
    } catch {
      toast.error('Could not save your story right now.');
    } finally {
      setSubmitting(false);
    }
  }, [quote, consent, circleId]);

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-[#14161c]/50 backdrop-blur-sm" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-[28px] border border-[#dfd6ca] bg-[#fbfaf7] p-6 shadow-[0_28px_80px_-40px_rgba(15,23,42,0.45)] sm:p-7"
          aria-describedby="payout-celebration-desc"
        >
          {!reduceMotion && mode === 'moment' ? (
            <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-24 overflow-hidden">
              {Array.from({ length: 14 }).map((_, i) => (
                <span
                  key={i}
                  className="absolute block h-2 w-2 rounded-sm"
                  style={{
                    left: `${6 + i * 6.5}%`,
                    top: '-8px',
                    background: i % 3 === 0 ? '#E8B04B' : i % 3 === 1 ? '#3f7d54' : '#171923',
                    animation: `njangi-confetti-fall ${1.6 + (i % 4) * 0.3}s ease-in ${(i % 5) * 0.12}s both`,
                    transform: `rotate(${(i * 37) % 360}deg)`,
                    opacity: 0.85,
                  }}
                />
              ))}
              <style>{`@keyframes njangi-confetti-fall { to { transform: translateY(120px) rotate(200deg); opacity: 0; } }`}</style>
            </div>
          ) : null}

          {mode === 'moment' ? (
            <>
              <div className="flex h-11 w-11 items-center justify-center rounded-full border border-[#e9dcb8] bg-[#fbf3df]">
                <CheckCircle2 className="h-5 w-5 text-[#b9832a]" />
              </div>
              <Dialog.Title className="mt-4 pr-8 text-2xl font-semibold tracking-[-0.03em] text-[#171923]">
                It&apos;s your turn.
              </Dialog.Title>
              <Dialog.Description
                id="payout-celebration-desc"
                className="mt-2 text-sm leading-6 text-[#5d6674]"
              >
                Your circle paid in, and the pot came to you on schedule. Nobody held it
                along the way.
              </Dialog.Description>

              <dl className="mt-5 grid grid-cols-2 gap-3 rounded-[18px] border border-[#e9e1d6] bg-white p-4">
                <div>
                  <dt className="text-[11px] uppercase tracking-[0.14em] text-[#8b8578]">Your payout</dt>
                  <dd className="mt-1 text-lg font-semibold text-[#171923]">{amount}</dd>
                </div>
                <div>
                  <dt className="text-[11px] uppercase tracking-[0.14em] text-[#8b8578]">Round</dt>
                  <dd className="mt-1 text-lg font-semibold text-[#171923]">{cycleNo}</dd>
                </div>
                {circleName ? (
                  <div className="col-span-2">
                    <dt className="text-[11px] uppercase tracking-[0.14em] text-[#8b8578]">Circle</dt>
                    <dd className="mt-1 text-sm font-medium text-[#171923]">{circleName}</dd>
                  </div>
                ) : null}
              </dl>

              <div className="mt-6 flex flex-col gap-3">
                <button
                  type="button"
                  onClick={() => setMode('story')}
                  className="inline-flex items-center justify-center gap-2 rounded-full bg-[#1d2533] px-5 py-2.5 text-sm font-semibold text-white transition-colors duration-200 hover:bg-[#101723]"
                >
                  <MessageSquareQuote className="h-4 w-4" />
                  Share your story
                </button>
                <div className="flex flex-col gap-3 sm:flex-row">
                  <Link
                    href="/create-circle"
                    onClick={onClose}
                    className="inline-flex flex-1 items-center justify-center gap-2 rounded-full border border-[#d5ccbf] bg-white px-5 py-2.5 text-sm font-semibold text-[#334155] transition-colors duration-200 hover:bg-[#f6f3ee]"
                  >
                    <PlusCircle className="h-4 w-4" />
                    Start your own circle
                  </Link>
                  <button
                    type="button"
                    onClick={onCopyCard}
                    className="inline-flex flex-1 items-center justify-center gap-2 rounded-full border border-[#d5ccbf] bg-white px-5 py-2.5 text-sm font-semibold text-[#334155] transition-colors duration-200 hover:bg-[#f6f3ee]"
                  >
                    <Copy className="h-4 w-4" />
                    Copy share text
                  </button>
                </div>
                <p className="text-center text-[11px] leading-5 text-[#8b8578]">
                  We never post on your behalf. Sharing is always your choice.
                </p>
              </div>
            </>
          ) : null}

          {mode === 'story' ? (
            <>
              <Dialog.Title className="pr-8 text-xl font-semibold tracking-[-0.03em] text-[#171923]">
                What has your circle meant to you?
              </Dialog.Title>
              <Dialog.Description
                id="payout-celebration-desc"
                className="mt-2 text-sm leading-6 text-[#5d6674]"
              >
                A sentence or two, in your own words. Real stories from real circles
                are how other families find out this exists.
              </Dialog.Description>
              <textarea
                value={quote}
                onChange={(e) => setQuote(e.target.value.slice(0, QUOTE_MAX))}
                rows={4}
                maxLength={QUOTE_MAX}
                placeholder="For example: I run our family circle from Maryland now, and nobody has to hold the cash anymore."
                className="mt-4 w-full rounded-[16px] border border-[#e9e1d6] bg-white p-3 text-sm leading-6 text-[#171923] outline-none focus:border-[#b9832a]"
              />
              <div className="mt-1 text-right text-[11px] text-[#8b8578]">
                {quote.trim().length}/{QUOTE_MAX}
              </div>
              <label className="mt-3 flex items-start gap-3 rounded-[16px] border border-[#e9e1d6] bg-white p-3 text-xs leading-5 text-[#4b5565]">
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={(e) => setConsent(e.target.checked)}
                  className="mt-0.5 h-4 w-4"
                />
                <span>
                  I agree that Njangi On-Chain may quote this story, with my first name
                  or anonymously, in its own materials. I can withdraw this at any time
                  from my record page, and it will not be used after that.
                </span>
              </label>
              <div className="mt-5 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
                <button
                  type="button"
                  onClick={() => setMode('moment')}
                  className="inline-flex items-center justify-center rounded-full border border-[#d5ccbf] bg-white px-5 py-2.5 text-sm font-semibold text-[#334155] hover:bg-[#f6f3ee]"
                >
                  Back
                </button>
                <button
                  type="button"
                  onClick={onSubmitStory}
                  disabled={submitting || !consent || quote.trim().length < QUOTE_MIN}
                  className="inline-flex items-center justify-center rounded-full bg-[#1d2533] px-5 py-2.5 text-sm font-semibold text-white hover:bg-[#101723] disabled:opacity-50"
                >
                  {submitting ? 'Saving…' : 'Share my story'}
                </button>
              </div>
            </>
          ) : null}

          {mode === 'thanks' ? (
            <>
              <Dialog.Title className="pr-8 text-xl font-semibold tracking-[-0.03em] text-[#171923]">
                Thank you.
              </Dialog.Title>
              <Dialog.Description
                id="payout-celebration-desc"
                className="mt-2 text-sm leading-6 text-[#5d6674]"
              >
                Your story is saved. A person reads every one before anything is shared,
                and you can withdraw it from your record page whenever you like.
              </Dialog.Description>
              <div className="mt-6 flex justify-end">
                <button
                  type="button"
                  onClick={onClose}
                  className="inline-flex items-center justify-center rounded-full bg-[#1d2533] px-5 py-2.5 text-sm font-semibold text-white hover:bg-[#101723]"
                >
                  Done
                </button>
              </div>
            </>
          ) : null}

          <Dialog.Close asChild>
            <button
              type="button"
              onClick={onClose}
              className="absolute right-5 top-5 rounded-full border border-[#e5ddd2] bg-white p-2 text-[#667085] transition-colors duration-200 hover:text-[#171923]"
            >
              <X className="h-4 w-4" />
              <span className="sr-only">Close</span>
            </button>
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export default PayoutCelebration;
