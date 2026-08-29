import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'react-hot-toast';
import {
  buildAdvanceCircleAfterClaimTx,
  buildContributeWithAutoCoinTx,
  buildFinalizeAndRedeemTx,
  buildFinalizeAndRedeemWithAttestationTx,
  buildOpenCycleTx,
} from '@/services/cycle-escrow-service';
import { preparePaymentCoin } from '@/lib/payment-coin-builder';
import { useZkLoginSigner } from '@/hooks/useZkLoginSigner';
import type { TransactionBuilder } from '@/lib/zklogin-client-signer';
import { useTranslation } from '@/hooks/useTranslation';
import {
  findCurrentCycleEscrow,
  listContributors,
  readCycleEscrowState,
  type CycleEscrowLiveState,
  type CycleEscrowSummary,
} from '@/lib/cycle-escrow-discovery';
import { getNetworkConfig, getPackageIdForNetwork } from '@/services/network-config';
import { getPooledSuiClient } from '@/services/sui-rpc-failover';
import type { NetworkType } from '@/services/whatsapp-registry-service';
import {
  findFreshestAttestation,
  isComplianceGateEnabled,
  resolveComplianceConfigId,
} from '@/lib/compliance-gate';
import { isTimedEscrowEntriesEnabled } from '@/config/feature-flags';
import VerificationRequiredModal from '@/components/VerificationRequiredModal';
import {
  preflightSanctionsCheck,
  SANCTIONS_BLOCKED_MESSAGE,
} from '@/lib/sanctions-preflight';

interface CycleEscrowPanelProps {
  circleId: string;
  network: NetworkType;
  /** Canonical Move type for the circle's contribution currency. Defaults to SUI. */
  coinType?: string;
  /** Display symbol, e.g. "SUI" or "USDC". */
  coinSymbol?: string;
  /** Token decimals — 9 for SUI, 6 for USDC. Used to format amounts. */
  coinDecimals?: number;
  /** Optional human label for the circle, used in the header. */
  circleName?: string;
  /** True when the signed-in user is the admin. */
  isAdmin: boolean;
  /**
   * Optional map of `address → display name` so the UI can show
   * "It's Aminata's turn this round" instead of a raw 0x address.
   */
  memberNames?: Record<string, string>;
  /**
   * Render the admin-only "Open this round" button. Members never see
   * this; admins use it from the manage page. Default false so the
   * member-facing contribute page stays clean.
   */
  showAdminOpenButton?: boolean;
  /**
   * True when the underlying circle is active (all security deposits
   * paid). When false, the admin "Open this round" button is disabled
   * and we explain that deposits must be in first.
   */
  circleIsActive?: boolean;
  /**
   * When true, once the panel detects that the circle is active and no
   * round is open yet, it auto-fires the admin "Open this round" call
   * exactly once. Use this to chain "Activate Circle → Open first round"
   * from the manage page so the admin doesn't have to click twice.
   * The parent should clear the flag after firing via `onAutoOpenFired`.
   */
  autoOpenWhenReady?: boolean;
  /** Callback fired once the panel kicks off an auto-open. */
  onAutoOpenFired?: () => void;
}

const DEFAULT_COIN_TYPE =
  '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';

function shortenAddress(addr: string | null | undefined): string {
  if (!addr) return '—';
  const lower = addr.toLowerCase();
  return lower.length > 14 ? `${lower.slice(0, 8)}…${lower.slice(-4)}` : lower;
}

function formatAmount(baseUnits: string | bigint, decimals: number, symbol: string) {
  try {
    const v = typeof baseUnits === 'bigint' ? baseUnits : BigInt(baseUnits);
    if (v === 0n) return `0 ${symbol}`;
    const divisor = 10n ** BigInt(decimals);
    const whole = v / divisor;
    const fraction = v % divisor;
    if (fraction === 0n) return `${whole.toString()} ${symbol}`;
    const fractionStr = fraction.toString().padStart(decimals, '0').replace(/0+$/, '');
    return `${whole.toString()}.${fractionStr} ${symbol}`;
  } catch {
    return `${String(baseUnits)} ${symbol}`;
  }
}

function explain(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

type Stage =
  | 'loading'
  | 'no-round-open'
  | 'in-progress'
  | 'full-waiting-for-claim'
  | 'completed';

export function CycleEscrowPanel({
  circleId,
  network,
  coinType = DEFAULT_COIN_TYPE,
  coinSymbol = 'SUI',
  coinDecimals = 9,
  circleName,
  isAdmin,
  memberNames,
  showAdminOpenButton = false,
  circleIsActive = true,
  autoOpenWhenReady = false,
  onAutoOpenFired,
}: CycleEscrowPanelProps) {
  const { isReady, userAddress, signAndExecute } = useZkLoginSigner();
  const { t } = useTranslation();
  const [summary, setSummary] = useState<CycleEscrowSummary | null>(null);
  const [liveState, setLiveState] = useState<CycleEscrowLiveState | null>(null);
  const [contributors, setContributors] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  // Distinguishes "could not read this round" from "no round yet". Without
  // it a rate-limited lookup renders as a confident (and wrong) statement
  // that the admin has not opened the round.
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState<null | 'open' | 'pay' | 'claim' | 'advance'>(null);
  const [lastDigest, setLastDigest] = useState<string | null>(null);
  // Gated round + no attestation on the caller's wallet: explain the
  // verification requirement instead of a dead-end error toast.
  const [showVerificationRequired, setShowVerificationRequired] = useState(false);
  // Phase 12: when the central WhatsApp dispatcher reports `no_link`
  // (member hasn't paired their phone yet), surface a friendly prompt so
  // they can ask the admin to add them. We check this lazily after a
  // successful action so it doesn't slow down the initial render.
  const [whatsAppLinked, setWhatsAppLinked] = useState<boolean | null>(null);

  const rpcClient = useMemo(
    () => getPooledSuiClient({ network, rpcUrl: getNetworkConfig(network).rpcUrl }),
    [network],
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const found = await findCurrentCycleEscrow(network, circleId);
      setSummary(found);
      if (found) {
        const state = await readCycleEscrowState(found.escrowId, network, rpcClient);
        setLiveState(state);
        const paidList = await listContributors(found.escrowId, network);
        setContributors(paidList);
      } else {
        setLiveState(null);
        setContributors([]);
      }
    } catch (err) {
      console.warn('[CycleEscrowPanel] refresh failed', err);
      // Say so, rather than falling through to the "not open yet" copy.
      setLoadError(true);
      setSummary(null);
      setLiveState(null);
      setContributors([]);
    } finally {
      setLoading(false);
    }
  }, [circleId, network, rpcClient]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Best-effort link probe — uses the existing admin-link-circle GET
  // path. If the member's circle isn't linked, we surface a CTA below
  // the round status. We don't block the panel on this; failures are
  // silent and just leave the prompt hidden.
  useEffect(() => {
    let cancelled = false;
    fetch(
      `/api/whatsapp/admin-link-circle?circleId=${encodeURIComponent(circleId)}&network=${network}`,
    )
      .then((resp) => (resp.ok ? resp.json() : null))
      .then((body) => {
        if (cancelled || !body) return;
        const linked = Boolean(body?.data?.isLinked);
        setWhatsAppLinked(linked);
      })
      .catch(() => {
        /* ignore — we'll just hide the prompt */
      });
    return () => {
      cancelled = true;
    };
  }, [circleId, network]);

  const recipient = liveState?.recipient ?? summary?.recipient ?? null;
  const contributionAmountBase = liveState?.contributionAmount ?? summary?.contributionAmount ?? '0';
  const totalRequired = liveState?.requiredContributors ?? summary?.requiredContributors ?? 0;
  const paidSoFar = liveState?.contributorsSoFar ?? contributors.length;
  const userHasPaid =
    !!userAddress &&
    contributors.some((c) => c.toLowerCase() === userAddress.toLowerCase());
  const isUserRecipient =
    !!userAddress && !!recipient && userAddress.toLowerCase() === recipient.toLowerCase();

  const stage: Stage = useMemo(() => {
    if (loading) return 'loading';
    if (!summary || !liveState) return 'no-round-open';
    if (liveState.claimed) return 'completed';
    if (liveState.finalized) return 'full-waiting-for-claim';
    if (paidSoFar >= totalRequired && totalRequired > 0) return 'full-waiting-for-claim';
    return 'in-progress';
  }, [loading, summary, liveState, paidSoFar, totalRequired]);

  const recipientLabel = useMemo(() => {
    if (!recipient) return '—';
    const name = memberNames?.[recipient.toLowerCase()] ?? memberNames?.[recipient];
    if (name) return name;
    return shortenAddress(recipient);
  }, [recipient, memberNames]);

  const progressLabel = useMemo(() => {
    if (!summary || totalRequired === 0) return '';
    return t('escrow.progressLabel', { paid: paidSoFar, required: totalRequired });
  }, [summary, paidSoFar, totalRequired, t]);

  const progressPercentage = useMemo(() => {
    if (totalRequired <= 0) return 0;
    return Math.min(100, Math.round((paidSoFar / totalRequired) * 100));
  }, [paidSoFar, totalRequired]);

  // Per-member rows for the progress ring + status pills. We prefer the
  // full rotation list from the frozen snapshot (includes the recipient);
  // if it isn't available yet we reconstruct an approximate list from the
  // recipient + everyone who has paid so far.
  const memberRows = useMemo(() => {
    const recipientLower = recipient?.toLowerCase() ?? null;
    const paid = new Set(contributors.map((c) => c.toLowerCase()));
    const source =
      liveState?.members && liveState.members.length > 0
        ? liveState.members
        : recipient
          ? [recipient, ...contributors.filter((c) => c.toLowerCase() !== recipientLower)]
          : contributors;
    return source.map((addr) => {
      const lower = addr.toLowerCase();
      const isRecipient = !!recipientLower && lower === recipientLower;
      const hasContributed = paid.has(lower);
      const name = memberNames?.[lower] ?? memberNames?.[addr];
      return {
        addr,
        label: name ?? shortenAddress(addr),
        isRecipient,
        hasContributed,
      };
    });
  }, [liveState?.members, contributors, recipient, memberNames]);

  const friendlyAmount = formatAmount(contributionAmountBase, coinDecimals, coinSymbol);

  const runWithSigner = useCallback(
    async (
      action: Stage | 'open' | 'pay' | 'claim' | 'advance',
      build: TransactionBuilder,
      gasBudget: number,
    ) => {
      if (!isReady) {
        toast.error(t('toast.signInAgain'));
        return;
      }
      setBusy(
        action === 'open' || action === 'pay' || action === 'claim' || action === 'advance'
          ? action
          : null,
      );
      try {
        const result = await signAndExecute({ build, gasBudget });
        setLastDigest(result.digest);
        toast.success(
          action === 'open'
            ? t('toast.roundOpened')
            : action === 'pay'
              ? t('toast.sharePaid')
              : action === 'advance'
                ? 'Cycle advanced to the next recipient.'
                : t('toast.payoutSent'),
        );
        // Wait for the fullnode to finish indexing this tx so the
        // follow-up reads see fresh state. Without this, refresh() can
        // hit stale data and the pot counter doesn't move until the
        // user manually refreshes.
        try {
          await rpcClient.waitForTransaction({
            digest: result.digest,
            options: { showEffects: false },
            timeout: 15_000,
          });
        } catch (waitErr) {
          console.warn('[CycleEscrowPanel] waitForTransaction timed out', waitErr);
        }
        await refresh();
        // Belt-and-braces: a second refresh after a short pause covers
        // the case where one RPC indexes faster than another in the
        // failover pool.
        setTimeout(() => {
          void refresh();
        }, 1500);
      } catch (err) {
        toast.error(t('toast.genericError', { error: explain(err) }));
      } finally {
        setBusy(null);
      }
    },
    [isReady, signAndExecute, refresh, rpcClient, t],
  );

  // SUI is the only non-stablecoin settlement token. Any other coin type
  // (USDC, etc.) is a USD-pegged stablecoin, so we open the escrow with the
  // `open_cycle_stable` path that derives the per-member amount from the
  // circle's USD value at the coin's decimals. Match SUI in either form —
  // short `0x2::sui::SUI` or the long zero-padded address.
  const isStableSettlement = !coinType.toLowerCase().endsWith('::sui::sui');

  const onStartRound = useCallback(async () => {
    // Escrow opens sign client-side (straight to RPC), so the server
    // choke points never see this flow — courtesy OFAC preflight; the
    // server screens stay authoritative (docs/sanctions-program.md).
    if (userAddress && (await preflightSanctionsCheck(userAddress))) {
      toast.error(SANCTIONS_BLOCKED_MESSAGE);
      return;
    }
    // Compliance gating is an ops lever, not a per-circle admin control:
    // OFF unless NEXT_PUBLIC_COMPLIANCE_GATE_ENABLED is set (a corridor
    // that demands KYC). No user-facing toggle — for the CEX/DEX-funded,
    // no-KYC launch, admins never opt a circle into verification
    // (docs/compliance-roadmap-cex-dex-non-kyc.md §0).
    const gated = isComplianceGateEnabled();
    // The gated entrypoints need the shared ComplianceConfig object as an
    // argument. Resolve it up front and abort with a readable message if
    // it can't be found — sending the call without it aborts on-chain
    // with an unfriendly "Incorrect number of arguments".
    let complianceConfigId: string | undefined;
    if (gated) {
      complianceConfigId =
        (await resolveComplianceConfigId(network).catch(() => null)) ?? undefined;
      if (!complianceConfigId) {
        toast.error(
          'Verification is required in your region but is not configured yet. Please contact support.',
        );
        return;
      }
    }
    const build = buildOpenCycleTx({
      network,
      circleId,
      coinType,
      withComplianceGate: gated,
      complianceConfigId,
      stableDecimals: isStableSettlement ? coinDecimals : undefined,
    });
    void runWithSigner('open', build, 80_000_000);
  }, [network, circleId, coinType, coinDecimals, isStableSettlement, runWithSigner, userAddress]);

  // Auto-chain: when the manage page sets `autoOpenWhenReady` after a
  // successful Activate Circle call, fire onStartRound exactly once as
  // soon as the panel sees the circle as active and no round open yet.
  useEffect(() => {
    if (!autoOpenWhenReady) return;
    if (!isAdmin || !showAdminOpenButton) return;
    if (!isReady || !circleIsActive) return;
    if (busy === 'open') return;
    if (loading) return;
    // Stage check: only when no round is currently open.
    if (summary || liveState) return;
    onAutoOpenFired?.();
    void onStartRound();
  }, [
    autoOpenWhenReady,
    isAdmin,
    showAdminOpenButton,
    isReady,
    circleIsActive,
    busy,
    loading,
    summary,
    liveState,
    onAutoOpenFired,
    onStartRound,
  ]);

  // Phase 8: resolve the member's freshest valid ComplianceAttestation
  // once per session and reuse it for gated contribute/finalize calls.
  // Returns null when the attestation isn't required, or throws with a
  // njangi-friendly toast when it is required and missing.
  const resolveAttestationIdOrAbort = useCallback(async (): Promise<string | null> => {
    const gateActive =
      !!liveState?.requiresAttestation || isComplianceGateEnabled();
    if (!gateActive) return null;
    if (!userAddress) return null;
    const attestation = await findFreshestAttestation(userAddress, network);
    if (!attestation) {
      // No dead-end toast: the modal explains what verification is and
      // that the circle admin arranges it (there is no self-serve KYC
      // flow yet — see VerificationRequiredModal for the full context).
      setShowVerificationRequired(true);
      return 'ABORT';
    }
    return attestation.objectId;
  }, [liveState?.requiresAttestation, userAddress, network]);

  const onPayShare = useCallback(async () => {
    if (!summary || !userAddress) return;
    const attestationId = await resolveAttestationIdOrAbort();
    if (attestationId === 'ABORT') return;

    if (attestationId) {
      // Gated contribute: we inline the auto-coin + gated moveCall in a
      // single builder so the PTB contains the coin split + the
      // compliance-checked contribute in one atomic transaction.
      const packageId = getPackageIdForNetwork(network);
      if (!packageId) {
        toast.error('Missing package id for this network; restart the dev server.');
        return;
      }
      const contributionAmount = BigInt(contributionAmountBase);
      const escrowId = summary.escrowId;
      const ownerAddress = userAddress;
      // The on-chain *_with_attestation entries take the escrow-pinned
      // ComplianceConfig as an argument; omitting it is an arity abort —
      // the dormant bug that silently broke every gated contribution
      // until 2026-08-23. Resolve it up front and refuse with a readable
      // message rather than aborting on-chain.
      const complianceConfigId =
        (await resolveComplianceConfigId(network).catch(() => null)) ?? undefined;
      if (!complianceConfigId) {
        toast.error(
          'Verification is required in your region but is not configured yet. Please contact support.',
        );
        return;
      }
      const timedTarget = isTimedEscrowEntriesEnabled()
        ? 'contribute_timed_with_attestation'
        : 'contribute_with_attestation';
      const build: TransactionBuilder = async (txb, client) => {
        const { coinArg } = await preparePaymentCoin({
          txb,
          client,
          owner: ownerAddress,
          coinType,
          amount: contributionAmount,
        });
        txb.moveCall({
          target: `${packageId}::njangi_cycle_escrow::${timedTarget}`,
          typeArguments: [coinType],
          arguments: [
            txb.object(escrowId),
            coinArg,
            txb.object(attestationId),
            txb.object(complianceConfigId),
            txb.object('0x6'),
          ],
        });
      };
      void runWithSigner('pay', build, 120_000_000);
      return;
    }

    const build = buildContributeWithAutoCoinTx({
      network,
      coinType,
      escrowId: summary.escrowId,
      contributionAmount: BigInt(contributionAmountBase),
      ownerAddress: userAddress,
    });
    void runWithSigner('pay', build, 100_000_000);
  }, [summary, userAddress, network, coinType, contributionAmountBase, runWithSigner, resolveAttestationIdOrAbort]);

  const onCollectPayout = useCallback(async () => {
    if (!summary) return;
    const attestationId = await resolveAttestationIdOrAbort();
    if (attestationId === 'ABORT') return;

    // Same arity requirement as the gated contribute: the on-chain entry
    // takes the escrow-pinned ComplianceConfig, so resolve it or refuse
    // readably instead of aborting on-chain.
    let collectConfigId: string | undefined;
    if (attestationId) {
      collectConfigId =
        (await resolveComplianceConfigId(network).catch(() => null)) ?? undefined;
      if (!collectConfigId) {
        toast.error(
          'Verification is required in your region but is not configured yet. Please contact support.',
        );
        return;
      }
    }

    const build = attestationId
      ? buildFinalizeAndRedeemWithAttestationTx({
          network,
          escrowId: summary.escrowId,
          coinType,
          // Advance the circle's rotation atomically with the payout — without
          // this the cycle stalls on the same recipient.
          circleId,
          attestationObjectId: attestationId,
          complianceConfigId: collectConfigId as string,
        })
      : buildFinalizeAndRedeemTx({
          network,
          escrowId: summary.escrowId,
          coinType,
          circleId,
        });
    void runWithSigner('claim', build, 120_000_000);
  }, [summary, network, coinType, circleId, runWithSigner, resolveAttestationIdOrAbort]);

  // Recovery: advance a circle whose payout was collected but whose rotation
  // never moved on (e.g. claimed before the collect flow chained the advance).
  // Permissionless + idempotent on-chain, so it's safe to expose to the admin.
  const onAdvanceCycle = useCallback(() => {
    if (!summary) return;
    const build = buildAdvanceCircleAfterClaimTx({
      network,
      coinType,
      circleId,
      escrowId: summary.escrowId,
    });
    void runWithSigner('advance', build, 60_000_000);
  }, [summary, network, coinType, circleId, runWithSigner]);

  return (
    <section className="rounded-2xl border border-emerald-200 bg-white p-5 shadow-sm">
      <header className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.2em] text-emerald-700">
            {t('escrow.sectionTitle')}
          </p>
          <h3 className="mt-1 text-lg font-semibold text-slate-900">
            {circleName
              ? t('escrow.header.withCircle', {
                  circle: circleName,
                  cycle: summary?.cycleNo ?? '—',
                })
              : t('escrow.header.noCircle', { cycle: summary?.cycleNo ?? '—' })}
          </h3>
          <p className="mt-1 text-sm text-slate-600">{t('escrow.headerBlurb')}</p>
        </div>
        <button
          type="button"
          onClick={refresh}
          disabled={loading}
          className="self-start rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100 disabled:opacity-50"
        >
          {loading ? t('escrow.refreshing') : t('escrow.refresh')}
        </button>
      </header>

      {!isReady ? (
        <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          {t('escrow.signInHint')}
        </div>
      ) : null}

      {whatsAppLinked === false ? (
        <div className="mt-4 rounded-lg border border-yellow-200 bg-yellow-50 p-3 text-sm text-yellow-900">
          📱 We couldn&rsquo;t find a WhatsApp number for this circle. Ask your admin
          to link it on the manage page so you get round reminders, payout
          alerts, and KYC confirmations on WhatsApp.
        </div>
      ) : null}

      {stage === 'loading' ? (
        <div className="mt-5 rounded-lg border border-dashed border-slate-200 p-4 text-sm text-slate-600">
          {t('escrow.loading')}
        </div>
      ) : stage === 'no-round-open' ? (
        <div className="mt-5 rounded-lg border border-dashed border-slate-200 p-4">
          <p className="text-sm text-slate-700">
            {loadError ? t('escrow.loadFailed') : t('escrow.notOpen')}
          </p>
          {isAdmin && showAdminOpenButton ? (
            <>
              <button
                type="button"
                onClick={onStartRound}
                disabled={!isReady || busy === 'open' || !circleIsActive}
                className="mt-3 inline-flex items-center justify-center rounded-full bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:opacity-50"
              >
                {busy === 'open' ? t('escrow.openingRound') : t('escrow.openRound')}
              </button>
              {!circleIsActive ? (
                // Deliberately does NOT enumerate the activation requirements.
                // It used to, and got them wrong: it claimed a non-admin
                // recovery delegate was always needed, when activate_circle
                // only requires one if auto-release is enabled — and a circle
                // created without auto-release can never have a delegate at
                // all. The manage page owns that truth via
                // getActivationRequirementMessage(), which is gated correctly
                // and lists what is actually outstanding for THIS circle.
                //
                // Kept as raw English to match the neighbouring WhatsApp
                // warning; adding a t() key would oblige EN+FR parity updates
                // for a string only the admin manage page renders.
                <p className="mt-2 text-xs text-amber-700">
                  Activate the circle first. Use the <span className="font-semibold">Activate Circle</span> action
                  in the Circle Management section below — it lists exactly what is still
                  outstanding for this circle.
                </p>
              ) : null}
            </>
          ) : (
            <p className="mt-2 text-xs text-slate-500">{t('escrow.onlyAdminOpens')}</p>
          )}
        </div>
      ) : (
        <>
          <div className="mt-5 grid gap-3 sm:grid-cols-3">
            <div className="rounded-lg bg-emerald-50 p-3">
              <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-emerald-700">
                {t('escrow.yourShare')}
              </p>
              <p className="mt-1 text-lg font-semibold text-emerald-900">
                {friendlyAmount}
              </p>
            </div>
            <div className="rounded-lg bg-slate-50 p-3">
              <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-600">
                {t('escrow.whoseTurn')}
              </p>
              <p className="mt-1 text-lg font-semibold text-slate-900">
                {recipientLabel}
              </p>
              {isUserRecipient ? (
                <p className="mt-1 text-xs font-medium text-emerald-700">
                  {t('escrow.yourTurn')}
                </p>
              ) : null}
            </div>
            <div className="rounded-lg bg-slate-50 p-3">
              <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-600">
                {t('escrow.paymentsReceived')}
              </p>
              <p className="mt-1 text-lg font-semibold text-slate-900">
                {paidSoFar} / {totalRequired}
              </p>
              <p className="mt-1 text-xs text-slate-500">{progressLabel}</p>
            </div>
          </div>

          {liveState && totalRequired > 0 ? (
            <div className="mt-6 flex flex-col items-center">
              <div className="relative h-36 w-36">
                <svg className="h-full w-full" viewBox="0 0 100 100">
                  <circle cx="50" cy="50" r="45" fill="none" stroke="#e7e5e4" strokeWidth="8" />
                  <circle
                    cx="50"
                    cy="50"
                    r="45"
                    fill="none"
                    stroke={progressPercentage === 100 ? '#10B981' : '#0f172a'}
                    strokeWidth="8"
                    strokeDasharray={`${progressPercentage * 2.83} 283`}
                    strokeDashoffset="0"
                    transform="rotate(-90 50 50)"
                    strokeLinecap="round"
                    className="transition-all duration-500 ease-in-out"
                  />
                  <text
                    x="50"
                    y="48"
                    textAnchor="middle"
                    dominantBaseline="middle"
                    className={`fill-current text-xl font-bold ${
                      progressPercentage === 100 ? 'text-emerald-600' : 'text-slate-900'
                    }`}
                  >
                    {`${progressPercentage}%`}
                  </text>
                  <text
                    x="50"
                    y="64"
                    textAnchor="middle"
                    dominantBaseline="middle"
                    className="fill-current text-[9px] uppercase tracking-wide text-slate-500"
                  >
                    Complete
                  </text>
                </svg>

                {(() => {
                  const ringMembers = memberRows.filter((m) => !m.isRecipient);
                  const numDots = ringMembers.length;
                  return ringMembers.map((member, index) => {
                    const angle =
                      numDots > 0 ? (index / numDots) * Math.PI * 2 - Math.PI / 2 : 0;
                    const x = 50 + 55 * Math.cos(angle);
                    const y = 50 + 55 * Math.sin(angle);
                    const dotColor = member.hasContributed ? 'bg-emerald-500' : 'bg-stone-300';
                    return (
                      <div key={member.addr} className="group">
                        <div
                          className={`absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 transform rounded-full border border-white ${dotColor} transition-all duration-200 hover:scale-125`}
                          style={{ left: `${x}%`, top: `${y}%` }}
                        />
                        <div
                          className="absolute z-10 hidden rounded bg-slate-900 p-2 text-xs text-white group-hover:block"
                          style={{
                            left: `${x}%`,
                            top: `${y}%`,
                            transform: 'translate(-50%, -100%)',
                            marginTop: '-10px',
                          }}
                        >
                          <p className="whitespace-nowrap">
                            {member.label}
                            {member.hasContributed ? ' ✓' : ' ✘'}
                          </p>
                        </div>
                      </div>
                    );
                  });
                })()}
              </div>

              <div className="mt-4 text-center">
                <p className="text-sm font-medium text-slate-900">
                  {t('escrow.progressLabel', { paid: paidSoFar, required: totalRequired })}
                </p>
                <p className="text-xs text-slate-500">{t('escrow.ringCaption')}</p>
              </div>

              <div className="mt-3 grid w-full max-w-xs grid-cols-1 gap-2 text-xs">
                {memberRows.map((member) => {
                  const statusText = member.isRecipient
                    ? t('escrow.status.receiving')
                    : member.hasContributed
                      ? t('escrow.status.paid')
                      : t('escrow.status.pending');
                  const statusColorClass = member.isRecipient
                    ? 'text-sky-700 font-medium'
                    : member.hasContributed
                      ? 'text-emerald-700 font-medium'
                      : 'text-slate-500';
                  const dotColorClass = member.isRecipient
                    ? 'bg-sky-500'
                    : member.hasContributed
                      ? 'bg-emerald-500'
                      : 'bg-stone-300';
                  return (
                    <div
                      key={member.addr}
                      className="flex items-center justify-between rounded-full border border-stone-200 bg-white px-3 py-2"
                    >
                      <div className="flex items-center">
                        <div className={`mr-2 h-3 w-3 rounded-full ${dotColorClass}`} />
                        <span className="font-mono">{member.label}</span>
                      </div>
                      <span className={`ml-4 ${statusColorClass}`}>{statusText}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}

          <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            {stage === 'in-progress' ? (
              isUserRecipient ? (
                <p className="text-sm font-medium text-emerald-700">
                  You&rsquo;re the recipient this round. You don&rsquo;t pay your
                  own share — just wait for the others to contribute, then
                  click <span className="font-semibold">Collect payout</span>{' '}
                  when the pot is full.
                </p>
              ) : userHasPaid ? (
                <p className="text-sm font-medium text-emerald-700">
                  {t('escrow.alreadyPaid')}
                </p>
              ) : (
                <>
                  <p className="text-sm text-slate-700">
                    {t('escrow.prompt.payYourShare')}
                  </p>
                  <button
                    type="button"
                    onClick={onPayShare}
                    disabled={!isReady || busy === 'pay'}
                    className="inline-flex items-center justify-center rounded-full bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:opacity-50"
                  >
                    {busy === 'pay'
                      ? t('escrow.action.paying')
                      : t('escrow.action.payShare', { amount: friendlyAmount })}
                  </button>
                </>
              )
            ) : null}

            {stage === 'full-waiting-for-claim' ? (
              isUserRecipient ? (
                <>
                  <p className="text-sm text-slate-700">
                    {t('escrow.prompt.collectPayout')}
                  </p>
                  <button
                    type="button"
                    onClick={onCollectPayout}
                    disabled={!isReady || busy === 'claim'}
                    className="inline-flex items-center justify-center rounded-full bg-emerald-700 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-emerald-800 disabled:opacity-50"
                  >
                    {busy === 'claim'
                      ? t('escrow.action.collecting')
                      : t('escrow.action.collect')}
                  </button>
                </>
              ) : (
                <p className="text-sm text-slate-700">
                  {t('escrow.prompt.someoneElseCollects', { recipient: recipientLabel })}
                </p>
              )
            ) : null}

            {stage === 'completed' ? (
              <div className="flex w-full flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-sm font-medium text-emerald-700">
                  {t('escrow.completed', {
                    cycle: summary?.cycleNo ?? '—',
                    recipient: recipientLabel,
                  })}
                </p>
                {showAdminOpenButton ? (
                  <button
                    type="button"
                    onClick={onAdvanceCycle}
                    disabled={!isReady || busy === 'advance'}
                    title="If the rotation didn't move to the next recipient after this payout was collected, click to advance the circle."
                    className="inline-flex items-center justify-center rounded-full border border-emerald-300 bg-white px-4 py-2 text-sm font-semibold text-emerald-800 shadow-sm hover:bg-emerald-50 disabled:opacity-50"
                  >
                    {busy === 'advance' ? 'Advancing…' : 'Advance to next round'}
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        </>
      )}

      {lastDigest ? (
        <p className="mt-4 text-[11px] text-slate-500">
          {t('escrow.lastTx', { digest: lastDigest })}
        </p>
      ) : null}

      <VerificationRequiredModal
        open={showVerificationRequired}
        onClose={() => setShowVerificationRequired(false)}
      />
    </section>
  );
}

export default CycleEscrowPanel;
