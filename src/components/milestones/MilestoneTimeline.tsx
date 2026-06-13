// MilestoneTimeline.tsx — Ordered milestone list for a circle's smart
// goal. Monetary milestones show cumulative-contributed vs target;
// time milestones show a countdown. Completed milestones get a
// celebratory state. Progress/completion actions ride the permissionless
// Move entry points (anyone signed in can pay the gas), proof submission
// is member-only and verification admin-only — the contract enforces
// both, the UI just narrates them.

import React, { useMemo, useState } from 'react';
import { CheckCircle2, Clock, Loader2, PartyPopper, ShieldCheck, Sparkles } from 'lucide-react';
import type {
  CircleMilestonesState,
  MilestoneProgress,
  MilestoneState,
} from '@/lib/milestone-discovery';
import { formatBaseAmount } from './milestone-plan';

export type MilestoneTimelineBusyAction =
  | { kind: 'record' }
  | { kind: 'complete' | 'verify' | 'proof'; index: number }
  | null;

export interface MilestoneTimelineProps {
  state: CircleMilestonesState;
  /** Index-aligned per-milestone progress from computeGoalProgress. */
  progress: MilestoneProgress[];
  coinSymbol: string;
  coinDecimals: number;
  /** True when the signed-in user is the circle admin. */
  isAdmin: boolean;
  /** Best-effort membership probe; null = unknown (fail open). */
  isMember: boolean | null;
  /** True when the client-side zkLogin signer is ready. */
  signerReady: boolean;
  busyAction: MilestoneTimelineBusyAction;
  /**
   * True when a settled (claimed) round exists that has not been counted
   * toward the goal yet — surfaces the permissionless "update progress"
   * button anyone can click.
   */
  canRecordProgress: boolean;
  /** Cycle number of the uncounted settled round, for friendlier copy. */
  uncountedCycleNo?: number | null;
  /** Total settled rounds awaiting a progress update (>= 1 when
   *  `canRecordProgress`); rounds are credited oldest-first, one click
   *  per round. */
  uncountedTotal?: number;
  onRecordProgress: () => void;
  onCompleteMilestone: (index: number) => void;
  onVerifyMilestone: (index: number) => void;
  onSubmitProof: (index: number, proofText: string) => void;
}

function formatAmount(base: string | bigint, decimals: number, symbol: string): string {
  return `${formatBaseAmount(base, decimals)} ${symbol}`;
}

function formatDate(ms: number): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function countdownLabel(targetMs: number, nowMs: number): string {
  const remaining = targetMs - nowMs;
  if (remaining <= 0) return 'Date reached';
  const days = Math.floor(remaining / 86_400_000);
  if (days >= 2) return `${days} days to go`;
  if (days === 1) return '1 day to go';
  const hours = Math.floor(remaining / 3_600_000);
  if (hours >= 1) return `${hours} hour${hours === 1 ? '' : 's'} to go`;
  return 'Less than an hour to go';
}

function isBusy(
  busy: MilestoneTimelineBusyAction,
  kind: 'complete' | 'verify' | 'proof',
  index: number,
): boolean {
  return busy !== null && busy.kind === kind && busy.index === index;
}

export function MilestoneTimeline({
  state,
  progress,
  coinSymbol,
  coinDecimals,
  isAdmin,
  isMember,
  signerReady,
  busyAction,
  canRecordProgress,
  uncountedCycleNo,
  uncountedTotal,
  onRecordProgress,
  onCompleteMilestone,
  onVerifyMilestone,
  onSubmitProof,
}: MilestoneTimelineProps) {
  const [proofDrafts, setProofDrafts] = useState<Record<number, string>>({});
  const nowMs = useMemo(() => Date.now(), []);
  const anyBusy = busyAction !== null;
  const completedCount = state.milestones.filter((m) => m.completed).length;

  const renderMilestone = (milestone: MilestoneState) => {
    const index = milestone.index;
    const entryProgress = progress[index] ?? {
      index,
      percent: 0,
      conditionMet: false,
    };
    const isActive = !milestone.completed && index === state.nextToComplete;
    const isUpcoming = !milestone.completed && index > state.nextToComplete;
    const awaitingVerification =
      isActive &&
      milestone.requiresVerification &&
      !milestone.verifiedBy;
    const readyToCelebrate =
      isActive && entryProgress.conditionMet && !awaitingVerification;
    const proofDraft = proofDrafts[index] ?? '';

    const statusIcon = milestone.completed ? (
      <span className="flex h-9 w-9 items-center justify-center rounded-full border border-emerald-300 bg-emerald-50 text-emerald-700">
        <CheckCircle2 className="h-5 w-5" />
      </span>
    ) : isActive ? (
      <span className="flex h-9 w-9 items-center justify-center rounded-full border border-[#1d2533] bg-white text-sm font-semibold text-[#1d2533]">
        {index + 1}
      </span>
    ) : (
      <span className="flex h-9 w-9 items-center justify-center rounded-full border border-stone-300 bg-white text-sm font-semibold text-stone-400">
        {index + 1}
      </span>
    );

    return (
      <li key={index} className="relative pl-14">
        {/* Connector line */}
        {index < state.milestones.length - 1 ? (
          <span
            aria-hidden
            className={`absolute left-[17px] top-10 h-[calc(100%-18px)] w-0.5 ${
              milestone.completed ? 'bg-emerald-200' : 'bg-stone-200'
            }`}
          />
        ) : null}
        <span className="absolute left-0 top-1">{statusIcon}</span>

        <div
          className={`rounded-[20px] border p-4 sm:p-5 ${
            milestone.completed
              ? 'border-emerald-200 bg-emerald-50/60'
              : isActive
                ? 'border-[#d5dde8] bg-white shadow-[0_18px_44px_-38px_rgba(15,23,42,0.4)]'
                : 'border-stone-200 bg-[#fbfaf7]'
          }`}
        >
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <p
                className={`text-sm font-semibold ${
                  isUpcoming ? 'text-stone-500' : 'text-slate-900'
                }`}
              >
                {milestone.description || `Milestone ${index + 1}`}
              </p>
              <p className="mt-1 text-xs text-stone-500">
                {milestone.kind === 'monetary'
                  ? `Target: ${formatAmount(milestone.targetAmount, coinDecimals, coinSymbol)} saved together`
                  : `Target date: ${formatDate(milestone.targetTimestampMs)}`}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {milestone.requiresVerification ? (
                <span
                  className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-semibold ${
                    milestone.verifiedBy
                      ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                      : 'border-amber-200 bg-amber-50 text-amber-800'
                  }`}
                >
                  <ShieldCheck className="h-3.5 w-3.5" />
                  {milestone.verifiedBy ? 'Admin confirmed' : 'Needs admin confirmation'}
                </span>
              ) : null}
              {milestone.completed ? (
                <span className="inline-flex items-center gap-1 rounded-full border border-emerald-300 bg-white px-2.5 py-1 text-[11px] font-semibold text-emerald-700">
                  <PartyPopper className="h-3.5 w-3.5" />
                  Reached {formatDate(milestone.completedAtMs)}
                </span>
              ) : null}
            </div>
          </div>

          {/* Progress bar */}
          {!milestone.completed ? (
            <div className="mt-3">
              <div className="h-2 w-full overflow-hidden rounded-full bg-stone-200">
                <div
                  className={`h-full rounded-full transition-all duration-500 ${
                    entryProgress.conditionMet ? 'bg-emerald-500' : 'bg-[#1d2533]'
                  }`}
                  style={{ width: `${Math.max(2, entryProgress.percent)}%` }}
                />
              </div>
              <div className="mt-1.5 flex items-center justify-between text-xs text-stone-500">
                {milestone.kind === 'monetary' ? (
                  <span>
                    {formatAmount(state.cumulativeContributed, coinDecimals, coinSymbol)} of{' '}
                    {formatAmount(milestone.targetAmount, coinDecimals, coinSymbol)}
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1">
                    <Clock className="h-3.5 w-3.5" />
                    {countdownLabel(milestone.targetTimestampMs, nowMs)}
                  </span>
                )}
                <span>{entryProgress.percent}%</span>
              </div>
            </div>
          ) : (
            <p className="mt-2 text-xs text-emerald-800/80">
              {milestone.kind === 'monetary'
                ? `The circle had saved ${formatAmount(milestone.achievedValue, coinDecimals, coinSymbol)} together when this milestone was reached.`
                : 'The circle kept going all the way to this date — milestone reached.'}
            </p>
          )}

          {/* Verification flow on the active milestone */}
          {awaitingVerification ? (
            <div className="mt-3 rounded-[14px] border border-amber-200 bg-amber-50/70 p-3">
              <p className="text-xs leading-5 text-amber-900">
                This milestone needs the admin&rsquo;s one-time confirmation before
                it can complete.
                {milestone.proofCount > 0
                  ? ` ${milestone.proofCount} proof${milestone.proofCount === 1 ? '' : 's'} submitted so far.`
                  : ''}
              </p>
              {isAdmin ? (
                <button
                  type="button"
                  onClick={() => onVerifyMilestone(index)}
                  disabled={!signerReady || anyBusy}
                  className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-[#1d2533] px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-[#101723] disabled:opacity-50"
                >
                  {isBusy(busyAction, 'verify', index) ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <ShieldCheck className="h-3.5 w-3.5" />
                  )}
                  Confirm this milestone
                </button>
              ) : isMember !== false ? (
                <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                  <input
                    type="text"
                    value={proofDraft}
                    onChange={(e) =>
                      setProofDrafts((prev) => ({ ...prev, [index]: e.target.value }))
                    }
                    placeholder="Link or reference the admin can check (e.g. a document hash)"
                    maxLength={512}
                    className="w-full rounded-full border border-stone-300 bg-white px-4 py-2 text-xs text-slate-900 placeholder:text-stone-400 focus:border-stone-400 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      onSubmitProof(index, proofDraft.trim());
                      setProofDrafts((prev) => ({ ...prev, [index]: '' }));
                    }}
                    disabled={!signerReady || anyBusy || proofDraft.trim().length === 0}
                    className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-full border border-amber-300 bg-white px-4 py-2 text-xs font-semibold text-amber-900 transition-colors hover:bg-amber-50 disabled:opacity-50"
                  >
                    {isBusy(busyAction, 'proof', index) ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : null}
                    Submit proof
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}

          {/* Celebrate (permissionless completion) */}
          {readyToCelebrate ? (
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-[14px] border border-emerald-200 bg-emerald-50/70 p-3">
              <p className="text-xs leading-5 text-emerald-900">
                The target is reached — anyone in the circle can mark this
                milestone complete for everyone.
              </p>
              <button
                type="button"
                onClick={() => onCompleteMilestone(index)}
                disabled={!signerReady || anyBusy}
                className="inline-flex items-center gap-1.5 rounded-full bg-emerald-600 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-emerald-700 disabled:opacity-50"
              >
                {isBusy(busyAction, 'complete', index) ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Sparkles className="h-3.5 w-3.5" />
                )}
                Celebrate this milestone
              </button>
            </div>
          ) : null}
        </div>
      </li>
    );
  };

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-stone-600">
          {completedCount} of {state.milestones.length} milestone
          {state.milestones.length === 1 ? '' : 's'} reached ·{' '}
          {formatAmount(state.cumulativeContributed, coinDecimals, coinSymbol)} saved together
        </p>
      </div>

      {canRecordProgress ? (
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-[18px] border border-sky-200 bg-sky-50/70 p-4">
          <p className="text-sm leading-6 text-sky-900">
            {typeof uncountedTotal === 'number' && uncountedTotal > 1
              ? `${uncountedTotal} collected rounds haven't been counted toward the goal yet${
                typeof uncountedCycleNo === 'number'
                  ? ` — round ${uncountedCycleNo} is next`
                  : ''
              }.`
              : typeof uncountedCycleNo === 'number'
                ? `Round ${uncountedCycleNo} was collected but hasn't been counted toward the goal yet.`
                : 'A collected round hasn’t been counted toward the goal yet.'}{' '}
            Anyone can update the tracker — it only reads the settled round.
          </p>
          <button
            type="button"
            onClick={onRecordProgress}
            disabled={!signerReady || anyBusy}
            className="inline-flex items-center gap-1.5 rounded-full bg-sky-700 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-sky-800 disabled:opacity-50"
          >
            {busyAction?.kind === 'record' ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : null}
            Update progress
          </button>
        </div>
      ) : null}

      <ol className="space-y-4">{state.milestones.map(renderMilestone)}</ol>
    </div>
  );
}

export default MilestoneTimeline;
