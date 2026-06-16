import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { goalDisplayFont } from '@/lib/fonts';
import GoalPotProgress from '@/components/goals/GoalPotProgress';
import { getPooledSuiClient } from '@/services/sui-rpc-failover';
import { getNetworkConfig } from '@/services/network-config';
import type { NetworkType } from '@/services/whatsapp-registry-service';
import {
  findGoalPoolsByAdmin,
  readGoalPoolState,
  type GoalPoolSummary,
  type GoalPoolState,
} from '@/lib/goal-pool-discovery';

interface Props {
  userAddress: string | null;
  network: NetworkType;
}

// Lightweight client-side cache so the section paints instantly on the next
// dashboard mount. Sui stays the source of truth — this is a localStorage
// memo of read results (no Postgres mirror of chain state), revalidated in
// the background on every mount.
const CACHE_VERSION = 'v1';
const CACHE_TTL_MS = 5 * 60 * 1000;

interface CachedPools {
  version: string;
  timestamp: number;
  summaries: GoalPoolSummary[];
  states: Record<string, GoalPoolState | null>;
}

function cacheKey(network: NetworkType, address: string): string {
  return `njangi_goalpools_${CACHE_VERSION}_${network}_${address.toLowerCase()}`;
}

function readCache(network: NetworkType, address: string): CachedPools | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(cacheKey(network, address));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedPools;
    if (parsed.version !== CACHE_VERSION) return null;
    if (Date.now() - parsed.timestamp > CACHE_TTL_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(
  network: NetworkType,
  address: string,
  summaries: GoalPoolSummary[],
  states: Record<string, GoalPoolState | null>,
): void {
  if (typeof window === 'undefined') return;
  try {
    const payload: CachedPools = { version: CACHE_VERSION, timestamp: Date.now(), summaries, states };
    window.localStorage.setItem(cacheKey(network, address), JSON.stringify(payload));
  } catch {
    /* quota / serialization issues are non-fatal — the chain read still works */
  }
}

function resolveCoin(coinType: string): { symbol: string; decimals: number } {
  return coinType.toLowerCase().endsWith('::sui::sui')
    ? { symbol: 'SUI', decimals: 9 }
    : { symbol: 'USDC', decimals: 6 };
}

function fmt(base: string | bigint, decimals: number): string {
  try {
    const n = Number(BigInt(base)) / 10 ** decimals;
    return n.toLocaleString(undefined, { maximumFractionDigits: decimals >= 9 ? 4 : 2 });
  } catch {
    return '0';
  }
}

function safeBig(value: string | undefined): bigint {
  try {
    return BigInt(value ?? '0');
  } catch {
    return BigInt(0);
  }
}

interface PoolView {
  poolId: string;
  name: string;
  goalKind: 'amount' | 'date';
  percent: number;
  achieved: boolean;
  primaryLabel: string;
  secondaryLabel: string;
  status: 'released' | 'cancelled' | 'verify' | 'active';
}

function buildView(summary: GoalPoolSummary, state: GoalPoolState | null): PoolView {
  const coin = resolveCoin(summary.assetType || state?.coinType || '');
  const now = Date.now();
  const target = safeBig(summary.targetAmount);
  const total = safeBig(state?.totalRaised);
  const targetMs = Number(summary.targetDateMs);
  const openedMs = summary.openedAtMs;
  // Mirror the on-chain unified rule: a goal can have an amount, a date, or both.
  const hasAmount = target > BigInt(0);
  const hasReleaseDate = targetMs > 0;
  const isDate = !hasAmount && hasReleaseDate; // pure-date pots fill by elapsed time

  const released = !!state?.released;
  const cancelled = !!state?.cancelled;
  const goalMet = (hasAmount && total >= target) || (hasReleaseDate && now >= targetMs);

  let percent: number;
  if (released) {
    percent = 100;
  } else if (hasAmount) {
    percent = Math.min(100, Number((total * BigInt(10000)) / target) / 100);
  } else if (hasReleaseDate && targetMs > openedMs) {
    percent = Math.min(100, Math.max(0, ((now - openedMs) / (targetMs - openedMs)) * 100));
  } else {
    percent = 0;
  }

  const status: PoolView['status'] = released
    ? 'released'
    : cancelled
      ? 'cancelled'
      : summary.requiresAttestation
        ? 'verify'
        : 'active';

  const pooledLabel = state ? `${fmt(total, coin.decimals)} ${coin.symbol} pooled` : 'Loading…';
  const dateShort = hasReleaseDate ? new Date(targetMs).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '';
  const primaryLabel = hasAmount
    ? `Goal ${fmt(target, coin.decimals)} ${coin.symbol}`
    : `By ${new Date(targetMs).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
  const secondaryLabel = released
    ? 'Released to the beneficiary'
    : cancelled
      ? 'Cancelled — refunds open'
      : hasAmount && hasReleaseDate
        ? `${pooledLabel} · by ${dateShort}`
        : pooledLabel;

  return {
    poolId: summary.poolId,
    name: summary.name || 'Goal pool',
    goalKind: isDate ? 'date' : 'amount',
    percent,
    achieved: released || (goalMet && !cancelled),
    primaryLabel,
    secondaryLabel,
    status,
  };
}

const STATUS_BADGE: Record<Exclude<PoolView['status'], 'active'>, { label: string; className: string }> = {
  released: { label: 'Released', className: 'border-emerald-200 bg-emerald-50 text-emerald-700' },
  cancelled: { label: 'Cancelled', className: 'border-stone-200 bg-stone-100 text-stone-600' },
  verify: { label: 'Verification', className: 'border-amber-200 bg-amber-50 text-amber-800' },
};

type PoolFilter = 'all' | 'active' | 'released' | 'cancelled';
const FILTERS: { key: PoolFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'active', label: 'Active' },
  { key: 'released', label: 'Released' },
  { key: 'cancelled', label: 'Cancelled' },
];
function matchesFilter(view: PoolView, filter: PoolFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'released') return view.status === 'released';
  if (filter === 'cancelled') return view.status === 'cancelled';
  return view.status === 'active' || view.status === 'verify'; // 'active' = still open
}

/**
 * "Your goal pools" — a dashboard band that lists the signed-in user's
 * non-rotating goal pools, each shown as a friendly savings-pot jar that links
 * to its full pool page. Additive to the circles list; renders nothing when the
 * user has no pools so it never clutters the dashboard for the common case.
 */
export default function GoalPoolsSection({ userAddress, network }: Props) {
  const [summaries, setSummaries] = useState<GoalPoolSummary[]>([]);
  const [states, setStates] = useState<Record<string, GoalPoolState | null>>({});
  // `known` flips true once we've resolved at least one source (cache or chain),
  // so we can keep the section hidden until we actually know there are pools.
  const [known, setKnown] = useState(false);
  const [filter, setFilter] = useState<PoolFilter>('all');

  const client = useMemo(
    () => getPooledSuiClient({ network, rpcUrl: getNetworkConfig(network).rpcUrl }),
    [network],
  );

  useEffect(() => {
    if (!userAddress) {
      setSummaries([]);
      setStates({});
      setKnown(true);
      return;
    }

    let active = true;

    // 1) Seed instantly from cache (lazy/cached, mirroring how circles load).
    const cached = readCache(network, userAddress);
    if (cached) {
      setSummaries(cached.summaries);
      setStates(cached.states);
      setKnown(true);
    }

    // 2) Revalidate against the chain in the background.
    void (async () => {
      const discovered = await findGoalPoolsByAdmin(client, network, userAddress);
      if (!active) return;
      setSummaries(discovered);
      setKnown(true);

      if (discovered.length === 0) {
        setStates({});
        writeCache(network, userAddress, discovered, {});
        return;
      }

      // Lazy-load each pool's live state (totalRaised / released / cancelled).
      const entries = await Promise.all(
        discovered.map(async (s): Promise<[string, GoalPoolState | null]> => {
          try {
            return [s.poolId, await readGoalPoolState(s.poolId, network, client)];
          } catch {
            return [s.poolId, null];
          }
        }),
      );
      if (!active) return;
      const nextStates = Object.fromEntries(entries) as Record<string, GoalPoolState | null>;
      setStates(nextStates);
      writeCache(network, userAddress, discovered, nextStates);
    })();

    return () => {
      active = false;
    };
  }, [userAddress, network, client]);

  // Keep the section out of the layout entirely until we know there are pools —
  // avoids an empty-flash for the (common) zero-pool case.
  if (!known || !userAddress || summaries.length === 0) return null;

  const views = summaries.map((s) => buildView(s, states[s.poolId] ?? null));
  const counts: Record<PoolFilter, number> = {
    all: views.length,
    active: views.filter((v) => matchesFilter(v, 'active')).length,
    released: views.filter((v) => matchesFilter(v, 'released')).length,
    cancelled: views.filter((v) => matchesFilter(v, 'cancelled')).length,
  };
  const filtered = views.filter((v) => matchesFilter(v, filter));

  return (
    <section className="rounded-[32px] border border-stone-200 bg-white shadow-[0_24px_70px_-42px_rgba(15,23,42,0.32)]">
      <div className="p-8 sm:p-10">
        <div className="flex flex-col gap-8">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-emerald-700/80">
                Smart Goals
              </p>
              <h3 className={`${goalDisplayFont.className} mt-3 text-2xl font-semibold tracking-tight text-slate-950 sm:text-3xl`}>
                Your goal pools
              </h3>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
                Pots you opened to pool money toward a shared goal. Watch each one fill, then release it to the beneficiary.
              </p>
            </div>

            {/* Status filter */}
            <div className="inline-flex flex-wrap items-center gap-1.5 rounded-full border border-stone-200 bg-stone-50 p-1" role="tablist" aria-label="Filter goal pools by status">
              {FILTERS.map(({ key, label }) => {
                const isActive = filter === key;
                return (
                  <button
                    key={key}
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    onClick={() => setFilter(key)}
                    className={`rounded-full px-3.5 py-1.5 text-sm font-medium transition ${
                      isActive ? 'bg-slate-900 text-white shadow-sm' : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {label} <span className={isActive ? 'text-white/70' : 'text-slate-400'}>{counts[key]}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {filtered.length === 0 ? (
            <p className="rounded-[20px] border border-dashed border-stone-200 bg-stone-50/60 px-5 py-8 text-center text-sm text-slate-500">
              No {filter === 'all' ? '' : `${filter} `}goal pools.
            </p>
          ) : (
          <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
            {filtered.map((view) => {
              const badge = view.status === 'active' ? null : STATUS_BADGE[view.status];
              return (
                <Link
                  key={view.poolId}
                  href={`/pool/${view.poolId}`}
                  aria-label={`Open goal pool ${view.name}`}
                  className="group flex flex-col items-center rounded-[24px] border border-[#e7dfd4] bg-[#fbfaf7] p-5 text-center transition duration-150 hover:-translate-y-0.5 hover:border-[#d8cdba] hover:bg-white hover:shadow-[0_18px_40px_-28px_rgba(15,23,42,0.4)] focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:ring-offset-2"
                >
                  <div className="flex w-full items-center justify-between gap-2">
                    <h4 className={`${goalDisplayFont.className} min-w-0 flex-1 truncate text-left text-base font-semibold text-slate-950`}>
                      {view.name}
                    </h4>
                    {badge ? (
                      <span className={`shrink-0 rounded-full border px-2.5 py-1 text-[11px] font-medium ${badge.className}`}>
                        {badge.label}
                      </span>
                    ) : null}
                  </div>

                  <GoalPotProgress
                    percent={view.percent}
                    size={132}
                    goalKind={view.goalKind}
                    achieved={view.achieved}
                    primaryLabel={view.primaryLabel}
                    secondaryLabel={view.secondaryLabel}
                    className="mt-3"
                  />

                  <span className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-emerald-700 transition group-hover:gap-2.5">
                    View pool
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                  </span>
                </Link>
              );
            })}
          </div>
          )}
        </div>
      </div>
    </section>
  );
}
