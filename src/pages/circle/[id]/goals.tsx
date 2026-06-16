// goals.tsx — The circle's smart-goals page: milestone timeline for
// every member, the admin's milestone creator (Premium-gated), proof
// submission for verification-gated milestones, and the permissionless
// "update progress" + "celebrate" actions on top of
// njangi_milestones.move. Viewing existing milestones is always free —
// members never lose visibility because the admin's plan lapsed.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/router';
import NextLink from 'next/link';
import { toast } from 'react-hot-toast';
import { ArrowLeft, RefreshCw, Sparkles, Target } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useMilestones } from '@/hooks/useMilestones';
import { useZkLoginSigner } from '@/hooks/useZkLoginSigner';
import MilestoneTimeline, {
  type MilestoneTimelineBusyAction,
} from '@/components/milestones/MilestoneTimeline';
import MilestoneCreator from '@/components/milestones/MilestoneCreator';
import GoalCelebration from '@/components/milestones/GoalCelebration';
import GoalPotProgress from '@/components/goals/GoalPotProgress';
import { goalDisplayFont } from '@/lib/fonts';
import BillingUpsellModal from '@/components/BillingUpsellModal';
import {
  clearPendingMilestonePlan,
  explainMilestoneError,
  loadPendingMilestonePlan,
  type MilestoneDraft,
} from '@/components/milestones/milestone-plan';
import {
  findUncountedEscrows,
  isCircleMember,
  readCircleGoalContext,
  type CircleGoalContext,
  type UncountedEscrow,
} from '@/lib/milestone-discovery';
import {
  buildCompleteMilestoneTx,
  buildRecordCycleProgressTx,
  buildSubmitMilestoneProofTx,
  buildVerifyMilestoneTx,
} from '@/services/milestone-service';
import { resolveCircleSettlementCoin } from '@/lib/circle-settlement';
import { getCurrentNetwork, getNetworkConfig } from '@/services/network-config';
import { getPooledSuiClient } from '@/services/sui-rpc-failover';
import { priceService } from '@/services/price-service';
import type { NetworkType } from '@/services/whatsapp-registry-service';

const pageSurfaceClass =
  'rounded-[30px] border border-[#ddd5c9] bg-white/88 shadow-[0_30px_90px_-62px_rgba(15,23,42,0.42)] backdrop-blur';
const sectionCardClass =
  'rounded-[24px] border border-[#e9e1d6] bg-[#fbfaf7] p-5 shadow-[0_24px_60px_-56px_rgba(15,23,42,0.42)] sm:p-6';
const eyebrowClass =
  'text-[11px] font-semibold uppercase tracking-[0.22em] text-[#7a818e]';

export default function CircleGoalsPage() {
  const router = useRouter();
  const { id } = router.query;
  const circleId = typeof id === 'string' ? id : null;
  const { isAuthenticated, isLoading: authLoading, userAddress } = useAuth();
  const { isReady: signerReady, signAndExecute } = useZkLoginSigner();
  const network = getCurrentNetwork() as NetworkType;

  const [goalContext, setGoalContext] = useState<CircleGoalContext | null>(null);
  const [contextLoading, setContextLoading] = useState(true);
  const [memberProbe, setMemberProbe] = useState<boolean | null>(null);
  const [pendingEscrows, setPendingEscrows] = useState<UncountedEscrow[]>([]);
  const [busyAction, setBusyAction] = useState<MilestoneTimelineBusyAction>(null);
  const [upsellOpen, setUpsellOpen] = useState(false);
  const [suiPrice, setSuiPrice] = useState<number | null>(null);
  const [pendingSketch, setPendingSketch] = useState<MilestoneDraft[] | null>(null);

  const rpcClient = useMemo(
    () => getPooledSuiClient({ network, rpcUrl: getNetworkConfig(network).rpcUrl }),
    [network],
  );

  const {
    loading: milestonesLoading,
    initialLoaded: milestonesInitialLoaded,
    error: milestonesError,
    summary,
    state,
    progress,
    overallPercent,
    goalAchieved,
    smartGoalsEntitled,
    refresh,
  } = useMilestones({ circleId, network });

  // Require sign-in (same pattern as the circle detail page).
  useEffect(() => {
    if (authLoading) return;
    if (!isAuthenticated && circleId) {
      const returnUrl = encodeURIComponent(`/circle/${circleId}/goals`);
      router.replace(`/?returnUrl=${returnUrl}`);
    }
  }, [authLoading, isAuthenticated, router, circleId]);

  // Circle goal context (smart-goal config + rotation state + admin).
  useEffect(() => {
    if (!circleId) return;
    let cancelled = false;
    setContextLoading(true);
    readCircleGoalContext(circleId, network)
      .then((ctx) => {
        if (!cancelled) setGoalContext(ctx);
      })
      .finally(() => {
        if (!cancelled) setContextLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [circleId, network]);

  const isAdmin = Boolean(
    userAddress &&
      goalContext?.admin &&
      goalContext.admin.toLowerCase() === userAddress.toLowerCase(),
  );

  // Best-effort membership probe (gates the proof form; the contract
  // enforces membership on chain regardless).
  useEffect(() => {
    if (!goalContext?.membersTableId || !userAddress) return;
    let cancelled = false;
    isCircleMember(goalContext.membersTableId, userAddress, network, rpcClient).then(
      (result) => {
        if (!cancelled) setMemberProbe(result);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [goalContext?.membersTableId, userAddress, network, rpcClient]);

  // Opportunistic progress check: are there settled (claimed) rounds the
  // tracker hasn't counted yet? record_cycle_progress is permissionless,
  // so anyone on this page may click "Update progress". This enumerates
  // EVERY escrow the circle ever opened (paginated), not just the most
  // recent one — once the next cycle opens, an older claimed-but-
  // uncredited escrow would otherwise become undiscoverable and the
  // cumulative total would under-count forever.
  const checkPendingEscrow = useCallback(async () => {
    if (!circleId || !state?.creditedTableId) {
      setPendingEscrows([]);
      return;
    }
    try {
      const uncounted = await findUncountedEscrows(
        rpcClient,
        network,
        circleId,
        state.creditedTableId,
      );
      setPendingEscrows(uncounted);
    } catch (err) {
      console.warn('[goals] pending escrow check failed', err);
      setPendingEscrows([]);
    }
  }, [circleId, state?.creditedTableId, network, rpcClient]);

  useEffect(() => {
    void checkPendingEscrow();
  }, [checkPendingEscrow]);

  // Creation-time sketch (saved by create-circle) pre-fills the creator
  // while the circle has no tracker yet.
  useEffect(() => {
    if (!isAdmin || !userAddress || summary) return;
    const saved = loadPendingMilestonePlan(userAddress);
    if (saved && saved.entries.length > 0) {
      setPendingSketch(saved.entries);
      const needsPrice = saved.entries.some(
        (entry) => entry.kind === 'monetary' && typeof entry.targetUsd === 'number',
      );
      if (needsPrice) {
        priceService
          .getSUIPrice()
          .then((price) => setSuiPrice(price ?? null))
          .catch(() => setSuiPrice(null));
      }
    }
  }, [isAdmin, userAddress, summary]);

  // Settlement coin: pin to the existing tracker's `T` when there is one
  // (record/complete calls must match it); otherwise derive it from the
  // circle's auto-swap mode for tracker creation.
  const settlement = useMemo(() => {
    if (state?.assetType) {
      const isSui = state.assetType.toLowerCase().endsWith('::sui::sui');
      return {
        coinType: state.assetType,
        coinSymbol: isSui ? 'SUI' : 'USDC',
        coinDecimals: isSui ? 9 : 6,
      };
    }
    return resolveCircleSettlementCoin(goalContext?.autoSwapEnabled ?? false);
  }, [state?.assetType, goalContext?.autoSwapEnabled]);

  const usdToDisplay = useCallback(
    (usd: number): number | null => {
      if (settlement.coinSymbol === 'USDC') return usd;
      if (suiPrice && suiPrice > 0) return usd / suiPrice;
      return null;
    },
    [settlement.coinSymbol, suiPrice],
  );

  const runAction = useCallback(
    async (
      action: NonNullable<MilestoneTimelineBusyAction>,
      build: Parameters<typeof signAndExecute>[0]['build'],
      gasBudget: number,
      successMessage: string,
    ) => {
      if (!signerReady) {
        toast.error('Please sign in again so your session can sign transactions.');
        return;
      }
      setBusyAction(action);
      try {
        const result = await signAndExecute({ build, gasBudget });
        try {
          await rpcClient.waitForTransaction({
            digest: result.digest,
            options: { showEffects: false },
            timeout: 15_000,
          });
        } catch {
          /* indexing lag — the refresh below retries */
        }
        toast.success(successMessage);
        await refresh();
        await checkPendingEscrow();
      } catch (err) {
        toast.error(explainMilestoneError(err));
      } finally {
        setBusyAction(null);
      }
    },
    [signerReady, signAndExecute, rpcClient, refresh, checkPendingEscrow],
  );

  // Credit the OLDEST uncounted round first; runAction re-runs
  // checkPendingEscrow afterwards, so any remaining rounds surface one by
  // one until the tracker has counted them all.
  const nextPendingEscrow = pendingEscrows[0] ?? null;

  const onRecordProgress = useCallback(() => {
    if (!summary || !nextPendingEscrow) return;
    void runAction(
      { kind: 'record' },
      buildRecordCycleProgressTx({
        network,
        coinType: settlement.coinType,
        milestonesId: summary.milestonesId,
        escrowId: nextPendingEscrow.escrowId,
      }),
      60_000_000,
      `Round ${nextPendingEscrow.cycleNo} counted toward the goal.`,
    );
  }, [summary, nextPendingEscrow, runAction, network, settlement.coinType]);

  const onCompleteMilestone = useCallback(
    (index: number) => {
      if (!summary) return;
      const isFinal = state ? index === state.milestones.length - 1 : false;
      void runAction(
        { kind: 'complete', index },
        buildCompleteMilestoneTx({
          network,
          coinType: settlement.coinType,
          milestonesId: summary.milestonesId,
          milestoneIndex: index,
        }),
        60_000_000,
        isFinal
          ? 'Final milestone complete — the circle achieved its goal!'
          : 'Milestone complete — celebrate together!',
      );
    },
    [summary, state, runAction, network, settlement.coinType],
  );

  const onVerifyMilestone = useCallback(
    (index: number) => {
      if (!summary || !circleId) return;
      void runAction(
        { kind: 'verify', index },
        buildVerifyMilestoneTx({
          network,
          coinType: settlement.coinType,
          milestonesId: summary.milestonesId,
          circleId,
          milestoneIndex: index,
        }),
        60_000_000,
        'Milestone confirmed — anyone can now mark it complete.',
      );
    },
    [summary, circleId, runAction, network, settlement.coinType],
  );

  const onSubmitProof = useCallback(
    (index: number, proofText: string) => {
      if (!summary || !circleId || !proofText) return;
      void runAction(
        { kind: 'proof', index },
        buildSubmitMilestoneProofTx({
          network,
          coinType: settlement.coinType,
          milestonesId: summary.milestonesId,
          circleId,
          milestoneIndex: index,
          proof: proofText,
        }),
        60_000_000,
        'Proof submitted for the admin to review.',
      );
    },
    [summary, circleId, runAction, network, settlement.coinType],
  );

  const onPublished = useCallback(() => {
    if (userAddress) clearPendingMilestonePlan(userAddress);
    setPendingSketch(null);
    void refresh();
  }, [userAddress, refresh]);

  if (authLoading || !circleId) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#f6f3ee]">
        <RefreshCw className="h-6 w-6 animate-spin text-stone-400" />
      </div>
    );
  }

  // summary === null is indeterminate until the first exhaustive scan
  // settles or after a foreground load errored — only an exhaustive scan
  // may conclude "no tracker" (see milestone-discovery.ts). Gate the
  // creator CTA on a settled answer. Deliberately NOT `!milestonesLoading`:
  // once discovery has settled, an in-flight refresh must not unmount the
  // creator (and wipe the admin's typed draft). Background polls never
  // set `milestonesError`, so the settled answer survives flaky polls too.
  const discoverySettled = milestonesInitialLoaded && !milestonesError;
  const noTrackerYet = discoverySettled && summary === null;
  const hasGoal = goalContext?.hasGoal ?? null;
  const finalMilestone = state?.milestones[state.milestones.length - 1] ?? null;

  return (
    <div className="min-h-screen bg-[#f6f3ee] text-[#171923]">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[420px] bg-[radial-gradient(circle_at_top_left,_rgba(108,122,147,0.16),_transparent_34%),radial-gradient(circle_at_85%_8%,_rgba(218,204,178,0.28),_transparent_24%),linear-gradient(180deg,_rgba(255,255,255,0.58)_0%,_rgba(246,243,238,0)_72%)]" />

      <main className="relative mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8 lg:py-10">
        <div className="mb-6 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => router.push(`/circle/${circleId}`)}
            className="inline-flex items-center gap-2 rounded-full border border-[#d7cec1] bg-white px-4 py-2.5 text-sm font-semibold text-[#334155] shadow-[0_18px_36px_-30px_rgba(15,23,42,0.42)] transition-all duration-200 hover:-translate-y-0.5 hover:bg-[#fbfaf7]"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to circle
          </button>
          <button
            type="button"
            onClick={() => {
              void refresh();
              void checkPendingEscrow();
            }}
            disabled={milestonesLoading}
            className="inline-flex items-center gap-2 rounded-full border border-[#d7cec1] bg-white px-4 py-2.5 text-sm font-semibold text-[#334155] transition-colors hover:bg-[#fbfaf7] disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${milestonesLoading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>

        <div className={`${pageSurfaceClass} p-5 sm:p-8`}>
          <div className="mb-6">
            <p className={eyebrowClass}>Community Goal</p>
            <h1 className={`${goalDisplayFont.className} mt-2 text-2xl font-semibold tracking-[-0.02em] text-[#171923] sm:text-3xl`}>
              {goalContext?.name ? `${goalContext.name} — Smart Goals` : 'Smart Goals'}
            </h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-[#5f6674]">
              Milestones the whole circle reaches together. Progress is read
              straight from settled rounds on chain — nothing here moves
              funds.
            </p>
            {state && state.milestones.length > 0 && !goalAchieved ? (
              <div className="mt-4">
                <GoalPotProgress
                  percent={overallPercent}
                  size={150}
                  goalKind={goalContext?.goalKind === 'date' ? 'date' : 'amount'}
                  primaryLabel={`Saved: ${(Number(BigInt(state.cumulativeContributed)) / 10 ** settlement.coinDecimals).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${settlement.coinSymbol}`}
                  secondaryLabel={`${overallPercent}% of the way to the goal`}
                />
              </div>
            ) : null}
          </div>

          <div className="space-y-5">
            {/* Celebration on the achieved goal */}
            {state && goalAchieved ? (
              <GoalCelebration
                circleName={goalContext?.name}
                milestoneCount={state.milestones.length}
                totalContributed={state.cumulativeContributed}
                coinSymbol={settlement.coinSymbol}
                coinDecimals={settlement.coinDecimals}
                achievedAtMs={finalMilestone?.completedAtMs}
              />
            ) : null}

            {/* Loading / error states. The loading card only appears until
                the FIRST discovery settles — later refreshes (manual or the
                30s poll) keep the real content mounted so the admin's
                in-progress milestone draft is never unmounted and wiped. */}
            {contextLoading || !milestonesInitialLoaded ? (
              <div className={sectionCardClass}>
                <p className="text-sm text-stone-600">Loading the circle&rsquo;s goal…</p>
              </div>
            ) : milestonesError && !state ? (
              <div className={sectionCardClass}>
                <p className="text-sm text-amber-800">
                  We couldn&rsquo;t load the goal tracker right now. Please try a
                  refresh.
                </p>
              </div>
            ) : hasGoal === false ? (
              /* Empty state: not a smart-goal circle */
              <div className={sectionCardClass}>
                <div className="flex h-11 w-11 items-center justify-center rounded-full border border-[#d8e2f0] bg-white text-[#5f708a]">
                  <Target className="h-5 w-5" />
                </div>
                <h2 className="mt-4 text-lg font-semibold text-slate-900">
                  This circle doesn&rsquo;t have a smart goal
                </h2>
                <p className="mt-2 max-w-xl text-sm leading-6 text-stone-600">
                  Smart goals give a circle shared milestones to celebrate —
                  savings totals reached together or dates the circle keeps
                  going until. Progress comes from settled rounds on chain, so
                  it can&rsquo;t be faked, and reaching the final milestone is a
                  moment for the whole circle.
                </p>
                <p className="mt-3 max-w-xl text-sm leading-6 text-stone-600">
                  A smart goal is chosen when a circle is created and this one
                  runs as a classic rotation.
                  {isAdmin
                    ? ' As the admin you can start a new smart-goal circle any time, or review this circle’s settings.'
                    : ''}
                </p>
                {isAdmin ? (
                  <div className="mt-4 flex flex-wrap gap-3">
                    <NextLink
                      href={`/circle/${circleId}/manage`}
                      className="inline-flex items-center justify-center rounded-full border border-stone-300 bg-white px-5 py-2.5 text-sm font-semibold text-slate-700 transition-colors hover:bg-stone-50"
                    >
                      Circle settings
                    </NextLink>
                    <NextLink
                      href="/create-circle"
                      className="inline-flex items-center justify-center rounded-full bg-[#1d2533] px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-[#101723]"
                    >
                      Create a smart-goal circle
                    </NextLink>
                  </div>
                ) : null}
              </div>
            ) : (
              <>
                {/* Timeline (always free to view) */}
                {state && state.milestones.length > 0 ? (
                  <div className={sectionCardClass}>
                    <div className="mb-4">
                      <p className={eyebrowClass}>Milestones</p>
                      <h2 className="mt-2 text-lg font-semibold text-slate-900">
                        The road we&rsquo;re walking together
                      </h2>
                    </div>
                    <MilestoneTimeline
                      state={state}
                      progress={progress}
                      coinSymbol={settlement.coinSymbol}
                      coinDecimals={settlement.coinDecimals}
                      isAdmin={isAdmin}
                      isMember={isAdmin ? true : memberProbe}
                      signerReady={signerReady}
                      busyAction={busyAction}
                      canRecordProgress={Boolean(nextPendingEscrow)}
                      uncountedCycleNo={nextPendingEscrow?.cycleNo ?? null}
                      uncountedTotal={pendingEscrows.length}
                      onRecordProgress={onRecordProgress}
                      onCompleteMilestone={onCompleteMilestone}
                      onVerifyMilestone={onVerifyMilestone}
                      onSubmitProof={onSubmitProof}
                    />
                  </div>
                ) : null}

                {/* Admin creator: shown when there is provably no tracker
                    yet (exhaustive scan settled) or the tracker is still
                    open for additions. Hidden while discovery is
                    indeterminate so a flaky RPC can never invite a
                    duplicate tracker. */}
                {isAdmin &&
                !goalContext?.rotationStarted &&
                !state?.locked &&
                (noTrackerYet || state) ? (
                    <div className={sectionCardClass}>
                      <div className="mb-4">
                        <p className={eyebrowClass}>
                          {state && state.milestones.length > 0
                            ? 'Extend the plan'
                            : 'Set up the plan'}
                        </p>
                        <h2 className="mt-2 text-lg font-semibold text-slate-900">
                          {state && state.milestones.length > 0
                            ? 'Add more milestones'
                            : 'Define your circle’s milestones'}
                        </h2>
                        {smartGoalsEntitled === false ? (
                          <p className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-[#e2d3ae] bg-[#fdf6e7] px-3 py-1.5 text-xs font-semibold text-[#a07b2f]">
                            <Sparkles className="h-3.5 w-3.5" />
                            Defining smart goals is a Premium feature
                          </p>
                        ) : null}
                      </div>
                      <MilestoneCreator
                        circleId={circleId}
                        network={network}
                        coinType={settlement.coinType}
                        coinSymbol={settlement.coinSymbol}
                        coinDecimals={settlement.coinDecimals}
                        summary={summary}
                        state={state}
                        rotationStarted={goalContext?.rotationStarted ?? false}
                        entitled={smartGoalsEntitled}
                        onGateBlocked={() => setUpsellOpen(true)}
                        onPublished={onPublished}
                        initialSketch={pendingSketch}
                        usdToDisplay={usdToDisplay}
                      />
                    </div>
                  ) : null}

                {/* Admin note when the definition window has closed */}
                {isAdmin && noTrackerYet && goalContext?.rotationStarted ? (
                  <div className={sectionCardClass}>
                    <h2 className="text-lg font-semibold text-slate-900">
                      The milestone window has closed
                    </h2>
                    <p className="mt-2 max-w-xl text-sm leading-6 text-stone-600">
                      Milestones are defined before a circle&rsquo;s first payout
                      settles, and this circle&rsquo;s rotation is already under
                      way. The smart goal set at creation still stands — and
                      your next circle can define its milestones right after
                      it&rsquo;s created.
                    </p>
                  </div>
                ) : null}

                {/* Member-facing waiting state: no tracker yet, or a
                    tracker that exists but holds zero milestones — either
                    way there is nothing to show a member but the promise. */}
                {!isAdmin &&
                (noTrackerYet || (state !== null && state.milestones.length === 0)) ? (
                  <div className={sectionCardClass}>
                    <h2 className="text-lg font-semibold text-slate-900">
                      Milestones are coming
                    </h2>
                    <p className="mt-2 max-w-xl text-sm leading-6 text-stone-600">
                      This is a smart-goal circle, but the admin hasn&rsquo;t
                      published its milestones yet. Once they do, you&rsquo;ll see
                      the full road map here — and every settled round will
                      move the circle closer to the goal.
                    </p>
                  </div>
                ) : null}
              </>
            )}
          </div>
        </div>
      </main>

      <BillingUpsellModal
        open={upsellOpen}
        onClose={() => setUpsellOpen(false)}
        feature="smartGoals"
      />
    </div>
  );
}
