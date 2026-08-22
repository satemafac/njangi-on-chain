import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'react-hot-toast';
import { Transaction } from '@mysten/sui/transactions';
import { SuiClient } from '@mysten/sui/client';
import GoalPotProgress from '@/components/goals/GoalPotProgress';
import { goalDisplayFont } from '@/lib/fonts';
import { useZkLoginSigner } from '@/hooks/useZkLoginSigner';
import { getPooledSuiClient } from '@/services/sui-rpc-failover';
import { getNetworkConfig } from '@/services/network-config';
import type { NetworkType } from '@/services/whatsapp-registry-service';
import {
  readGoalPoolState,
  readContributorAmount,
  type GoalPoolState,
} from '@/lib/goal-pool-discovery';
import {
  buildContributeToPoolTx,
  buildReleaseTx,
  buildCancelTx,
  buildCancelAfterDeadlineTx,
  buildClaimRefundTx,
} from '@/services/goal-pool-service';
import {
  findFreshestAttestation,
  resolveComplianceConfigId,
} from '@/lib/compliance-gate';
import VerificationRequiredModal from '@/components/VerificationRequiredModal';

interface Props {
  poolId: string;
  network: NetworkType;
  userAddress: string | null;
}

function resolveCoin(coinType: string): { symbol: string; decimals: number } {
  return coinType.toLowerCase().endsWith('::sui::sui')
    ? { symbol: 'SUI', decimals: 9 }
    : { symbol: 'USDC', decimals: 6 };
}

function fmt(base: string | bigint, decimals: number): string {
  const n = Number(BigInt(base)) / 10 ** decimals;
  return n.toLocaleString(undefined, { maximumFractionDigits: decimals >= 9 ? 4 : 2 });
}

function short(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}

const primaryBtn =
  'inline-flex items-center justify-center gap-2 rounded-full bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white transition duration-100 hover:bg-emerald-700 active:scale-[0.98] disabled:opacity-50';
const ghostBtn =
  'inline-flex items-center justify-center gap-2 rounded-full border border-stone-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 transition duration-100 hover:bg-stone-50 active:scale-[0.98] disabled:opacity-50';

export default function GoalPoolPanel({ poolId, network, userAddress }: Props) {
  const { isReady, signAndExecute } = useZkLoginSigner();
  const [state, setState] = useState<GoalPoolState | null>(null);
  const [loading, setLoading] = useState(true);
  const [myContribution, setMyContribution] = useState('0');
  const [amountInput, setAmountInput] = useState('');
  const [busy, setBusy] = useState(false);
  // Gated pool + no attestation on the caller's wallet: explain the
  // verification requirement instead of a dead-end error toast.
  const [showVerificationRequired, setShowVerificationRequired] = useState(false);

  const rpc = useMemo(
    () => getPooledSuiClient({ network, rpcUrl: getNetworkConfig(network).rpcUrl }),
    [network],
  );

  const refresh = useCallback(async () => {
    const s = await readGoalPoolState(poolId, network);
    setState(s);
    if (s?.contributionsTableId && userAddress) {
      setMyContribution(await readContributorAmount(s.contributionsTableId, userAddress, network));
    }
    setLoading(false);
  }, [poolId, network, userAddress]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const runWithSigner = useCallback(
    async (build: (txb: Transaction, client: SuiClient) => void | Promise<void>, gasBudget: number, successMsg: string) => {
      if (!isReady) {
        toast.error('Sign in again to continue.');
        return;
      }
      setBusy(true);
      const tid = toast.loading('Submitting…');
      try {
        const result = await signAndExecute({ build, gasBudget });
        try {
          await rpc.waitForTransaction({ digest: result.digest, timeout: 15000 });
        } catch {
          /* indexing lag — refresh below still picks it up */
        }
        toast.success(successMsg, { id: tid });
        await refresh();
        setTimeout(() => {
          void refresh();
        }, 2500);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Transaction failed', { id: tid });
      } finally {
        setBusy(false);
      }
    },
    [isReady, signAndExecute, rpc, refresh],
  );

  const view = useMemo(() => {
    if (!state) return null;
    const coin = resolveCoin(state.coinType);
    const now = Date.now();
    const total = BigInt(state.totalRaised);
    const target = BigInt(state.targetAmount);
    const targetMs = Number(state.targetDateMs);
    const createdMs = Number(state.createdAtMs);
    const deadlineMs = Number(state.deadlineMs);
    const hasAmount = target > BigInt(0);
    const hasReleaseDate = targetMs > 0;
    // Pure-date pots fill by elapsed time; anything with an amount fills by amount.
    const isDate = !hasAmount && hasReleaseDate;

    // Mirror the on-chain unified condition: met when amount reached OR date arrives.
    const goalMet = (hasAmount && total >= target) || (hasReleaseDate && now >= targetMs);
    const percent = hasAmount
      ? Math.min(100, Number((total * BigInt(10000)) / target) / 100)
      : hasReleaseDate && targetMs > createdMs
        ? Math.min(100, Math.max(0, ((now - createdMs) / (targetMs - createdMs)) * 100))
        : 0;

    const isAdmin = !!userAddress && userAddress.toLowerCase() === state.admin.toLowerCase();
    const deadlinePassed = deadlineMs > 0 && now > deadlineMs;
    const myAmount = BigInt(myContribution);

    return {
      coin,
      isDate,
      hasAmount,
      hasReleaseDate,
      goalMet,
      percent,
      isAdmin,
      deadlinePassed,
      myAmount,
      total,
      target,
      targetMs,
      canContribute: !state.released && !state.cancelled,
      canRelease: !state.released && !state.cancelled && goalMet && balanceGtZero(state.balance),
      canCancelAdmin: isAdmin && !state.released && !state.cancelled && !goalMet,
      canCancelDeadline: !state.released && !state.cancelled && deadlinePassed && !goalMet,
      canRefund: state.cancelled && myAmount > BigInt(0),
    };
  }, [state, userAddress, myContribution]);

  const onContribute = useCallback(async () => {
    if (!state || !userAddress) return;
    const coin = resolveCoin(state.coinType);
    const value = parseFloat(amountInput);
    if (!Number.isFinite(value) || value <= 0) {
      toast.error('Enter an amount to chip in.');
      return;
    }
    // Gated pools route through contribute_with_attestation — resolve the
    // caller's freshest ComplianceAttestation first (same flow as the
    // rotational escrow panel) and explain instead of erroring when they
    // don't have one yet.
    let attestationObjectId: string | undefined;
    let complianceConfigId: string | undefined;
    if (state.requiresAttestation) {
      const attestation = await findFreshestAttestation(userAddress, network).catch(
        () => null,
      );
      if (!attestation) {
        setShowVerificationRequired(true);
        return;
      }
      attestationObjectId = attestation.objectId;
      // contribute_with_attestation validates against the EXACT config
      // pinned on the pool and takes that object as an argument. Prefer
      // the pinned id read off the pool itself; fall back to the lineage
      // singleton (same resolver the open flow used to pin it).
      complianceConfigId =
        state.compliancyConfigId ??
        (await resolveComplianceConfigId(network).catch(() => null)) ??
        undefined;
      if (!complianceConfigId) {
        toast.error(
          'Verification is required for this pool but is not configured yet. Please contact support.',
        );
        return;
      }
    }
    const base = BigInt(Math.round(value * 10 ** coin.decimals));
    void runWithSigner(
      buildContributeToPoolTx({
        network,
        coinType: state.coinType,
        poolId,
        amount: base,
        ownerAddress: userAddress,
        attestationObjectId,
        complianceConfigId,
      }),
      120_000_000,
      'Added to the pot! 🎉',
    ).then(() => setAmountInput(''));
  }, [state, userAddress, amountInput, network, poolId, runWithSigner]);

  const onRelease = useCallback(() => {
    if (!state) return;
    void runWithSigner(
      buildReleaseTx({ network, coinType: state.coinType, poolId }),
      120_000_000,
      'Goal reached — pot released to the beneficiary! 🎉',
    );
  }, [state, network, poolId, runWithSigner]);

  const onCancel = useCallback(() => {
    if (!state) return;
    void runWithSigner(
      buildCancelTx({ network, coinType: state.coinType, poolId }),
      60_000_000,
      'Pool cancelled — contributors can now refund.',
    );
  }, [state, network, poolId, runWithSigner]);

  const onCancelDeadline = useCallback(() => {
    if (!state) return;
    void runWithSigner(
      buildCancelAfterDeadlineTx({ network, coinType: state.coinType, poolId }),
      60_000_000,
      'Deadline passed — refunds are open.',
    );
  }, [state, network, poolId, runWithSigner]);

  const onRefund = useCallback(() => {
    if (!state) return;
    void runWithSigner(
      buildClaimRefundTx({ network, coinType: state.coinType, poolId }),
      120_000_000,
      'Refunded to your wallet.',
    );
  }, [state, network, poolId, runWithSigner]);

  if (loading) {
    return <div className="rounded-[24px] border border-[#e7dfd4] bg-[#fbfaf7] p-6 text-sm text-[#5f6674]">Loading the pot…</div>;
  }
  if (!state || !view) {
    return <div className="rounded-[24px] border border-red-200 bg-red-50 p-6 text-sm text-red-700">Could not load this goal pool.</div>;
  }

  const { coin } = view;
  const released = state.released;
  const cancelled = state.cancelled;

  const copyShare = () => {
    if (typeof window === 'undefined') return;
    void navigator.clipboard?.writeText(window.location.href);
    toast.success('Link copied — share it with friends!');
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <h1 className={`${goalDisplayFont.className} text-2xl font-semibold tracking-[-0.02em] text-[#171923] sm:text-3xl`}>
          {state.name || 'Goal pool'}
        </h1>
        <button type="button" onClick={copyShare} className={ghostBtn}>
          Share
        </button>
      </div>

      {/* The growing pot */}
      <div className="flex flex-col items-center gap-6 rounded-[28px] border border-[#e7dfd4] bg-white/85 p-6 sm:p-8">
        <GoalPotProgress
          percent={released ? 100 : view.percent}
          size={190}
          achieved={released || (view.goalMet && !cancelled)}
          goalKind={view.isDate ? 'date' : 'amount'}
          primaryLabel={
            view.hasAmount
              ? `Goal: ${fmt(view.target, coin.decimals)} ${coin.symbol}`
              : new Date(view.targetMs).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
          }
          secondaryLabel={
            cancelled
              ? 'Cancelled — refunds open'
              : released
                ? `Released to ${short(state.beneficiary)}`
                : view.hasAmount
                  ? `${fmt(view.total, coin.decimals)} of ${fmt(view.target, coin.decimals)} ${coin.symbol}${view.hasReleaseDate ? ` · by ${new Date(view.targetMs).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}` : ''}`
                  : `${fmt(view.total, coin.decimals)} ${coin.symbol} pooled`
          }
        />

        <div className="flex flex-wrap items-center justify-center gap-2 text-xs">
          <span className="rounded-full border border-[#dde5ef] bg-white px-3 py-1.5 font-medium text-[#51627b]">
            {state.contributorCount} contributor{state.contributorCount === 1 ? '' : 's'}
          </span>
          <span className="rounded-full border border-[#dde5ef] bg-white px-3 py-1.5 font-medium text-[#51627b]">
            Beneficiary {short(state.beneficiary)}
          </span>
          {state.requiresAttestation ? (
            <span className="rounded-full border border-amber-200 bg-amber-50 px-3 py-1.5 font-medium text-amber-800">
              Verification required
            </span>
          ) : null}
        </div>
      </div>

      {/* Contribute — gated pools included; the handler resolves the
          caller's attestation and explains when verification is missing. */}
      {view.canContribute ? (
        <div className="rounded-[24px] border border-emerald-200/70 bg-gradient-to-br from-emerald-50 to-[#fbfaf7] p-5">
          <h3 className={`${goalDisplayFont.className} text-lg font-semibold text-[#0f5132]`}>Chip in to the pot</h3>
          <p className="mt-1 text-sm text-[#3f6b54]">Add any amount — every contribution makes the pot grow.</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-2 rounded-md border border-gray-300 bg-white px-3 py-2">
              <input
                type="number"
                value={amountInput}
                onChange={(e) => setAmountInput(e.target.value)}
                placeholder="0.00"
                min="0"
                step="0.01"
                className="w-32 border-0 p-0 text-sm focus:outline-none focus:ring-0"
              />
              <span className="text-sm text-gray-500">{coin.symbol}</span>
            </div>
            <button type="button" onClick={onContribute} disabled={busy} className={primaryBtn}>
              Chip in
            </button>
          </div>
          {view.myAmount > BigInt(0) ? (
            <p className="mt-2 text-xs text-[#3f6b54]">You have chipped in {fmt(view.myAmount, coin.decimals)} {coin.symbol} so far.</p>
          ) : null}
        </div>
      ) : null}

      {/* Release */}
      {view.canRelease ? (
        <div className="rounded-[24px] border border-amber-200 bg-amber-50/80 p-5">
          <h3 className={`${goalDisplayFont.className} text-lg font-semibold text-amber-900`}>The goal is reached 🎉</h3>
          <p className="mt-1 text-sm text-amber-800">
            Release the full pot ({fmt(view.total, coin.decimals)} {coin.symbol}) to {short(state.beneficiary)}.
          </p>
          <button type="button" onClick={onRelease} disabled={busy} className={`${primaryBtn} mt-3 bg-amber-500 hover:bg-amber-600`}>
            Release the pot
          </button>
        </div>
      ) : null}

      {/* Refund */}
      {view.canRefund ? (
        <div className="rounded-[24px] border border-stone-200 bg-white p-5">
          <h3 className="text-base font-semibold text-[#171923]">Claim your refund</h3>
          <p className="mt-1 text-sm text-[#5f6674]">
            This pool was cancelled. You can reclaim your {fmt(view.myAmount, coin.decimals)} {coin.symbol}.
          </p>
          <button type="button" onClick={onRefund} disabled={busy} className={`${primaryBtn} mt-3`}>
            Refund {fmt(view.myAmount, coin.decimals)} {coin.symbol}
          </button>
        </div>
      ) : null}

      {/* Organizer / deadline controls */}
      {(view.canCancelAdmin || view.canCancelDeadline) && !view.canRefund ? (
        <div className="flex flex-wrap gap-2">
          {view.canCancelAdmin ? (
            <button type="button" onClick={onCancel} disabled={busy} className={ghostBtn}>
              Cancel pool &amp; open refunds
            </button>
          ) : null}
          {view.canCancelDeadline && !view.canCancelAdmin ? (
            <button type="button" onClick={onCancelDeadline} disabled={busy} className={ghostBtn}>
              Deadline passed — open refunds
            </button>
          ) : null}
        </div>
      ) : null}

      {released ? (
        <p className="text-center text-sm font-medium text-emerald-700">
          Released {fmt(view.total, coin.decimals)} {coin.symbol} to the beneficiary. 🎉
        </p>
      ) : null}

      <VerificationRequiredModal
        open={showVerificationRequired}
        onClose={() => setShowVerificationRequired(false)}
      />
    </div>
  );
}

function balanceGtZero(balance: string): boolean {
  try {
    return BigInt(balance) > BigInt(0);
  } catch {
    return false;
  }
}
