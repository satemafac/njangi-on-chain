// MilestoneCreator.tsx — Admin-only editor for a circle's smart-goal
// milestones. Builds the ordered plan locally (with validation that
// mirrors the contract's aborts: strictly-increasing targets, future
// dates, 32-milestone cap, 256-byte descriptions) and publishes it
// through the Phase 2 client-side zkLogin signer:
//
//   tx1  create_circle_milestones<T>(circle)        (when no tracker yet)
//   tx2  add_monetary_milestone / add_time_milestone — all adds in ONE
//        programmable transaction block, in plan order.
//
// Premium gate: smart-goal CREATION is a Premium feature. The parent
// passes the preflight result; when the caller is not entitled, the
// publish button routes to `onGateBlocked` (upsell modal) instead of
// signing. Viewing existing milestones is never gated.

import React, { useEffect, useMemo, useState } from 'react';
import { toast } from 'react-hot-toast';
import { CalendarDays, Coins, Loader2, Plus, Trash2 } from 'lucide-react';
import { useZkLoginSigner } from '@/hooks/useZkLoginSigner';
import {
  buildAddMonetaryMilestoneTx,
  buildAddTimeMilestoneTx,
  buildCreateCircleMilestonesTx,
} from '@/services/milestone-service';
import {
  findCircleMilestones,
  type CircleMilestonesState,
  type CircleMilestonesSummary,
} from '@/lib/milestone-discovery';
import { getNetworkConfig } from '@/services/network-config';
import { getPooledSuiClient } from '@/services/sui-rpc-failover';
import type { NetworkType } from '@/services/whatsapp-registry-service';
import type { Transaction } from '@mysten/sui/transactions';
import {
  MAX_DESCRIPTION_BYTES,
  MAX_MILESTONES,
  descriptionByteLength,
  explainMilestoneError,
  parseDisplayAmountToBase,
  validatePublishPlan,
  type MilestoneDraft,
} from './milestone-plan';

interface EditorRow {
  kind: 'monetary' | 'time';
  description: string;
  /** Display-unit amount as typed (exact-parsed at publish time). */
  amountText: string;
  /** datetime-local value, e.g. "2026-09-01T12:00". */
  dateText: string;
  requiresVerification: boolean;
}

export interface MilestoneCreatorProps {
  circleId: string;
  network: NetworkType;
  /** Settlement coin of the circle's cycles — the tracker's `T`. */
  coinType: string;
  coinSymbol: string;
  coinDecimals: number;
  /** Existing tracker identity (null when not created yet). */
  summary: CircleMilestonesSummary | null;
  /** Live tracker state (null when not created/loaded). */
  state: CircleMilestonesState | null;
  /** True once the circle's first payout settled — definition frozen. */
  rotationStarted: boolean;
  /** Premium preflight: true/false once resolved, null while loading. */
  entitled: boolean | null;
  /** Called instead of signing when the caller is not entitled. */
  onGateBlocked: () => void;
  /** Called after a successful publish so the parent can refresh. */
  onPublished: () => void;
  /** Optional creation-time sketch to pre-fill (USD amounts). */
  initialSketch?: MilestoneDraft[] | null;
  /** Converts a USD sketch amount into settlement-coin display units;
   *  return null when no rate is available (the field stays blank). */
  usdToDisplay?: (usd: number) => number | null;
}

function emptyRow(kind: 'monetary' | 'time'): EditorRow {
  return { kind, description: '', amountText: '', dateText: '', requiresVerification: false };
}

function toLocalDateTimeInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function rowsToPublishPlan(
  rows: EditorRow[],
  coinDecimals: number,
): { plan: MilestoneDraft[]; parseErrors: string[] } {
  const plan: MilestoneDraft[] = [];
  const parseErrors: string[] = [];
  rows.forEach((row, index) => {
    if (row.kind === 'monetary') {
      const base = parseDisplayAmountToBase(row.amountText, coinDecimals);
      if (base === null) {
        parseErrors.push(
          `Milestone ${index + 1}: enter a plain amount (up to ${coinDecimals} decimal places).`,
        );
      }
      plan.push({
        kind: 'monetary',
        description: row.description,
        targetAmountBase: (base ?? 0n).toString(),
        requiresVerification: row.requiresVerification,
      });
    } else {
      const ms = row.dateText ? new Date(row.dateText).getTime() : NaN;
      if (!Number.isFinite(ms)) {
        parseErrors.push(`Milestone ${index + 1}: pick a target date.`);
      }
      plan.push({
        kind: 'time',
        description: row.description,
        targetTimestampMs: Number.isFinite(ms) ? ms : 0,
        requiresVerification: row.requiresVerification,
      });
    }
  });
  return { plan, parseErrors };
}

export function MilestoneCreator({
  circleId,
  network,
  coinType,
  coinSymbol,
  coinDecimals,
  summary,
  state,
  rotationStarted,
  entitled,
  onGateBlocked,
  onPublished,
  initialSketch,
  usdToDisplay,
}: MilestoneCreatorProps) {
  const { isReady, signAndExecute } = useZkLoginSigner();
  const [rows, setRows] = useState<EditorRow[]>([]);
  const [busy, setBusy] = useState<null | 'creating' | 'publishing'>(null);
  const [prefilled, setPrefilled] = useState(false);

  const rpcClient = useMemo(
    () => getPooledSuiClient({ network, rpcUrl: getNetworkConfig(network).rpcUrl }),
    [network],
  );

  // Pre-fill from a creation-time sketch exactly once.
  useEffect(() => {
    if (prefilled || !initialSketch || initialSketch.length === 0) return;
    setRows(
      initialSketch.map((entry) => {
        if (entry.kind === 'time') {
          return {
            kind: 'time',
            description: entry.description,
            amountText: '',
            dateText: entry.targetTimestampMs
              ? toLocalDateTimeInput(entry.targetTimestampMs)
              : '',
            requiresVerification: entry.requiresVerification,
          };
        }
        const display =
          typeof entry.targetUsd === 'number' && usdToDisplay
            ? usdToDisplay(entry.targetUsd)
            : null;
        return {
          kind: 'monetary',
          description: entry.description,
          amountText:
            display !== null && Number.isFinite(display)
              ? display.toFixed(Math.min(4, coinDecimals)).replace(/\.?0+$/, '')
              : '',
          dateText: '',
          requiresVerification: entry.requiresVerification,
        };
      }),
    );
    setPrefilled(true);
  }, [initialSketch, prefilled, usdToDisplay, coinDecimals]);

  const onChainMilestones = useMemo(() => state?.milestones ?? [], [state?.milestones]);
  const existingOnChainCount = onChainMilestones.length;
  const monetaryFloorBase = useMemo(() => {
    let floor = 0n;
    for (const m of onChainMilestones) {
      if (m.kind !== 'monetary') continue;
      try {
        const t = BigInt(m.targetAmount);
        if (t > floor) floor = t;
      } catch {
        /* skip unparseable */
      }
    }
    return floor;
  }, [onChainMilestones]);
  const timeFloorMs = useMemo(
    () =>
      onChainMilestones.reduce(
        (max, m) => (m.kind === 'time' && m.targetTimestampMs > max ? m.targetTimestampMs : max),
        0,
      ),
    [onChainMilestones],
  );

  const { plan, parseErrors } = useMemo(
    () => rowsToPublishPlan(rows, coinDecimals),
    [rows, coinDecimals],
  );
  const validationErrors = useMemo(() => {
    if (rows.length === 0) return [];
    const errors = [...parseErrors];
    if (parseErrors.length === 0) {
      errors.push(
        ...validatePublishPlan(plan, {
          nowMs: Date.now(),
          monetaryFloorBase,
          timeFloorMs,
          existingOnChainCount,
        }),
      );
    }
    return errors;
  }, [rows.length, plan, parseErrors, monetaryFloorBase, timeFloorMs, existingOnChainCount]);

  const definitionFrozen = rotationStarted || Boolean(state?.locked);
  const atCapacity = existingOnChainCount + rows.length >= MAX_MILESTONES;

  const updateRow = (index: number, patch: Partial<EditorRow>) => {
    setRows((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };
  const removeRow = (index: number) => {
    setRows((prev) => prev.filter((_, i) => i !== index));
  };
  const addRow = (kind: 'monetary' | 'time') => {
    setRows((prev) => [...prev, emptyRow(kind)]);
  };

  const publish = async () => {
    if (entitled === false) {
      onGateBlocked();
      return;
    }
    if (!isReady) {
      toast.error('Please sign in again so your session can sign transactions.');
      return;
    }
    if (rows.length === 0 || validationErrors.length > 0) return;

    try {
      let milestonesId = summary?.milestonesId ?? null;

      if (!milestonesId) {
        setBusy('creating');
        const createResult = await signAndExecute({
          build: buildCreateCircleMilestonesTx({ network, coinType, circleId }),
          gasBudget: 60_000_000,
        });
        try {
          await rpcClient.waitForTransaction({
            digest: createResult.digest,
            options: { showEffects: false },
            timeout: 15_000,
          });
        } catch {
          /* indexing lag — the discovery poll below retries anyway */
        }
        // The tracker id comes from the MilestonesCreated event; poll the
        // canonical discovery path until the fullnode has indexed it.
        for (let attempt = 0; attempt < 6 && !milestonesId; attempt += 1) {
          const found = await findCircleMilestones(rpcClient, network, circleId);
          if (found) {
            milestonesId = found.milestonesId;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 2_000));
        }
        if (!milestonesId) {
          toast.error(
            'The goal tracker was created but is still indexing. Refresh in a moment and add your milestones then.',
          );
          onPublished();
          return;
        }
      }

      setBusy('publishing');
      const trackerId = milestonesId;
      const builders = plan.map((entry) =>
        entry.kind === 'monetary'
          ? buildAddMonetaryMilestoneTx({
              network,
              coinType,
              milestonesId: trackerId,
              circleId,
              targetAmount: BigInt(entry.targetAmountBase ?? '0'),
              description: entry.description.trim(),
              requiresVerification: entry.requiresVerification,
            })
          : buildAddTimeMilestoneTx({
              network,
              coinType,
              milestonesId: trackerId,
              circleId,
              targetTimestampMs: entry.targetTimestampMs ?? 0,
              description: entry.description.trim(),
              requiresVerification: entry.requiresVerification,
            }),
      );
      const addsResult = await signAndExecute({
        build: (txb: Transaction) => {
          builders.forEach((apply) => apply(txb));
        },
        gasBudget: 50_000_000 + 10_000_000 * builders.length,
      });
      try {
        await rpcClient.waitForTransaction({
          digest: addsResult.digest,
          options: { showEffects: false },
          timeout: 15_000,
        });
      } catch {
        /* the parent refresh below re-reads regardless */
      }
      toast.success(
        rows.length === 1
          ? 'Milestone published — the whole circle can see it now.'
          : `${rows.length} milestones published — the whole circle can see them now.`,
      );
      setRows([]);
      onPublished();
    } catch (err) {
      toast.error(explainMilestoneError(err));
    } finally {
      setBusy(null);
    }
  };

  if (definitionFrozen) {
    return (
      <div className="rounded-[20px] border border-stone-200 bg-[#fbfaf7] p-4">
        <p className="text-sm leading-6 text-stone-600">
          {state?.locked
            ? 'The milestone plan is locked: progress has been recorded, so targets can no longer change. That keeps the goal honest for everyone.'
            : 'The rotation has started, so the milestone plan can no longer change. Milestones are defined before the first payout settles.'}
        </p>
      </div>
    );
  }

  return (
    <div>
      <p className="text-sm leading-6 text-stone-600">
        Define the milestones your circle will celebrate on the way to its
        goal. Savings milestones build on each other (each target is the
        TOTAL saved together), and date milestones mark how long the circle
        keeps going. Once the first round settles, the plan locks.
      </p>

      {rows.length > 0 ? (
        <ol className="mt-4 space-y-3">
          {rows.map((row, index) => (
            <li
              key={index}
              className="rounded-[18px] border border-stone-200 bg-white p-4"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-stone-500">
                  {row.kind === 'monetary' ? (
                    <Coins className="h-3.5 w-3.5" />
                  ) : (
                    <CalendarDays className="h-3.5 w-3.5" />
                  )}
                  Milestone {existingOnChainCount + index + 1} ·{' '}
                  {row.kind === 'monetary' ? 'Savings target' : 'Date target'}
                </span>
                <button
                  type="button"
                  onClick={() => removeRow(index)}
                  className="rounded-full border border-stone-200 bg-white p-1.5 text-stone-400 transition-colors hover:text-red-600"
                  aria-label={`Remove milestone ${index + 1}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <div className="sm:col-span-2">
                  <input
                    type="text"
                    value={row.description}
                    onChange={(e) => updateRow(index, { description: e.target.value })}
                    placeholder='What are we celebrating? e.g. "First three rounds saved"'
                    className="w-full rounded-full border border-stone-300 bg-white px-4 py-2 text-sm text-slate-900 placeholder:text-stone-400 focus:border-stone-400 focus:outline-none"
                  />
                  <p className="mt-1 text-[11px] text-stone-400">
                    {descriptionByteLength(row.description)}/{MAX_DESCRIPTION_BYTES}
                  </p>
                </div>
                {row.kind === 'monetary' ? (
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      inputMode="decimal"
                      value={row.amountText}
                      onChange={(e) => updateRow(index, { amountText: e.target.value })}
                      placeholder="Total saved together"
                      className="w-full rounded-full border border-stone-300 bg-white px-4 py-2 text-sm text-slate-900 placeholder:text-stone-400 focus:border-stone-400 focus:outline-none"
                    />
                    <span className="text-sm font-medium text-stone-500">{coinSymbol}</span>
                  </div>
                ) : (
                  <input
                    type="datetime-local"
                    value={row.dateText}
                    onChange={(e) => updateRow(index, { dateText: e.target.value })}
                    className="w-full rounded-full border border-stone-300 bg-white px-4 py-2 text-sm text-slate-900 focus:border-stone-400 focus:outline-none"
                  />
                )}
                <label className="flex items-center gap-2 text-xs text-stone-600">
                  <input
                    type="checkbox"
                    checked={row.requiresVerification}
                    onChange={(e) =>
                      updateRow(index, { requiresVerification: e.target.checked })
                    }
                    className="h-4 w-4 rounded border-stone-300"
                  />
                  Needs my confirmation before it completes
                </label>
              </div>
            </li>
          ))}
        </ol>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => addRow('monetary')}
          disabled={atCapacity || busy !== null}
          className="inline-flex items-center gap-1.5 rounded-full border border-stone-300 bg-white px-4 py-2 text-xs font-semibold text-slate-700 transition-colors hover:bg-stone-50 disabled:opacity-50"
        >
          <Plus className="h-3.5 w-3.5" />
          Savings milestone
        </button>
        <button
          type="button"
          onClick={() => addRow('time')}
          disabled={atCapacity || busy !== null}
          className="inline-flex items-center gap-1.5 rounded-full border border-stone-300 bg-white px-4 py-2 text-xs font-semibold text-slate-700 transition-colors hover:bg-stone-50 disabled:opacity-50"
        >
          <Plus className="h-3.5 w-3.5" />
          Date milestone
        </button>
      </div>
      {atCapacity ? (
        <p className="mt-2 text-xs text-amber-700">
          A circle can hold at most {MAX_MILESTONES} milestones.
        </p>
      ) : null}

      {validationErrors.length > 0 ? (
        <ul className="mt-4 space-y-1 rounded-[14px] border border-amber-200 bg-amber-50/70 p-3">
          {validationErrors.map((error, i) => (
            <li key={i} className="text-xs leading-5 text-amber-900">
              {error}
            </li>
          ))}
        </ul>
      ) : null}

      {rows.length > 0 ? (
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => void publish()}
            disabled={busy !== null || validationErrors.length > 0 || entitled === null}
            className="inline-flex items-center gap-2 rounded-full bg-[#1d2533] px-5 py-2.5 text-sm font-semibold text-white transition-colors duration-200 hover:bg-[#101723] disabled:opacity-50"
          >
            {busy !== null ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {busy === 'creating'
              ? 'Creating goal tracker…'
              : busy === 'publishing'
                ? 'Publishing milestones…'
                : summary
                  ? 'Publish milestones'
                  : 'Create tracker & publish milestones'}
          </button>
          <p className="text-xs text-stone-500">
            {summary
              ? 'One transaction adds every milestone in order.'
              : 'Two quick transactions: create the tracker, then add your milestones.'}
          </p>
        </div>
      ) : null}
    </div>
  );
}

export default MilestoneCreator;
