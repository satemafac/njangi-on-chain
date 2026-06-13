import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getNetworkConfig } from '@/services/network-config';
import { getPooledSuiClient } from '@/services/sui-rpc-failover';
import type { NetworkType } from '@/services/whatsapp-registry-service';
import {
  computeGoalProgress,
  findCircleMilestones,
  nextIncompleteMilestone,
  readCircleMilestonesState,
  type CircleMilestonesState,
  type CircleMilestonesSummary,
  type MilestoneProgress,
  type MilestoneState,
} from '@/lib/milestone-discovery';
// Client-safe mirror of entitlement-gate's browser preflight — the gate
// itself transitively imports the Stripe SDK + pg pool and must never be
// value-imported from client code (see entitlement-preflight.ts).
import { hasFeaturePreflight } from '@/components/milestones/entitlement-preflight';

const DEFAULT_POLL_INTERVAL_MS = 30_000;

export interface UseMilestonesOptions {
  circleId: string | null | undefined;
  network: NetworkType;
  /** Poll interval for live progress; 0 disables polling. Default 30s. */
  pollIntervalMs?: number;
  /** Set false to suspend loading entirely (e.g. tab not visible). */
  enabled?: boolean;
}

export interface UseMilestonesResult {
  /**
   * True while the first load (or a manual `refresh()`) is in flight.
   * Background polls NEVER flip this — a poll silently updates state in
   * place so consumers can keep stateful children (e.g. the milestone
   * creator form) mounted without losing user input every interval.
   */
  loading: boolean;
  /**
   * True once the first load attempt for the current circle/network has
   * settled (success OR error). Use this — not `loading` — to decide
   * whether to show a full-content loading placeholder, so later
   * refreshes never unmount the page's content.
   */
  initialLoaded: boolean;
  error: string | null;
  /** Tracker identity from the MilestonesCreated event; null when the
   *  circle has no smart-goal tracker yet. */
  summary: CircleMilestonesSummary | null;
  /** Live parsed tracker state; null until discovered. */
  state: CircleMilestonesState | null;
  /** Per-milestone progress (0–100 + condition-met), index-aligned. */
  progress: MilestoneProgress[];
  /** Mean of the per-milestone percentages — a single community-facing
   *  "how far along is our goal" number. */
  overallPercent: number;
  /** The next milestone eligible for completion, or null once achieved. */
  nextMilestone: MilestoneState | null;
  goalAchieved: boolean;
  /**
   * Premium preflight for the smart-goals feature. `null` while the check
   * is in flight; `true` whenever billing is disabled (everything passes).
   * UI surfaces use this to show the upsell BEFORE the server 402s — the
   * server-side asserts remain authoritative.
   */
  smartGoalsEntitled: boolean | null;
  refresh: () => Promise<void>;
}

/**
 * Loads and polls the smart-goal milestone state for a circle. Discovery
 * is event-derived (MilestonesCreated) and cached for the hook's
 * lifetime; live state re-reads the shared object on every poll.
 */
export function useMilestones({
  circleId,
  network,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  enabled = true,
}: UseMilestonesOptions): UseMilestonesResult {
  const [loading, setLoading] = useState(true);
  const [initialLoaded, setInitialLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<CircleMilestonesSummary | null>(null);
  const [state, setState] = useState<CircleMilestonesState | null>(null);
  const [smartGoalsEntitled, setSmartGoalsEntitled] = useState<boolean | null>(null);
  // The tracker id never changes once created; remember it so polls skip
  // the event scan after the first successful discovery.
  const summaryRef = useRef<CircleMilestonesSummary | null>(null);
  const aliveRef = useRef(true);

  const rpcClient = useMemo(
    () => getPooledSuiClient({ network, rpcUrl: getNetworkConfig(network).rpcUrl }),
    [network],
  );

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // Reset cached discovery when the target circle changes.
  useEffect(() => {
    summaryRef.current = null;
    setSummary(null);
    setState(null);
    setError(null);
    setInitialLoaded(false);
    setLoading(true);
  }, [circleId, network]);

  /**
   * Foreground refreshes (first load, manual `refresh()`) flip `loading`
   * and surface errors. Background polls do neither: they update
   * summary/state silently on success and only console-warn on failure,
   * so a 30s poll (or a flaky RPC mid-poll) can never swap the page back
   * to a loading/error placeholder and unmount stateful children — e.g.
   * the admin's in-progress milestone draft on a circle with no tracker.
   */
  const runRefresh = useCallback(
    async (background: boolean) => {
      if (!circleId || !enabled) {
        setLoading(false);
        // Nothing will ever load in this configuration; report "settled"
        // so consumers don't show a placeholder forever.
        setInitialLoaded(true);
        return;
      }
      if (!background) setLoading(true);
      try {
        let found = summaryRef.current;
        if (!found || found.circleId.toLowerCase() !== circleId.toLowerCase()) {
          found = await findCircleMilestones(rpcClient, network, circleId);
          if (!aliveRef.current) return;
          summaryRef.current = found;
        }
        setSummary(found);
        if (found) {
          const liveState = await readCircleMilestonesState(
            found.milestonesId,
            network,
            rpcClient,
          );
          if (!aliveRef.current) return;
          setState(liveState);
        } else {
          setState(null);
        }
        setError(null);
      } catch (err) {
        if (!aliveRef.current) return;
        console.warn('[useMilestones] refresh failed', err);
        // Background failures keep the last-known-good answer on screen.
        if (!background) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (aliveRef.current) {
          if (!background) setLoading(false);
          setInitialLoaded(true);
        }
      }
    },
    [circleId, enabled, network, rpcClient],
  );

  const refresh = useCallback(() => runRefresh(false), [runRefresh]);

  // Initial load (foreground) + polling (background).
  useEffect(() => {
    if (!enabled || !circleId) return;
    void runRefresh(false);
    if (pollIntervalMs <= 0) return;
    const timer = setInterval(() => {
      void runRefresh(true);
    }, pollIntervalMs);
    return () => clearInterval(timer);
  }, [runRefresh, enabled, circleId, pollIntervalMs]);

  // Premium preflight (smart goals). Passes wholesale while
  // NEXT_PUBLIC_BILLING_ENABLED=false; resolves to false on any error so
  // the UI errs toward showing the upsell, never toward hiding the gate.
  useEffect(() => {
    let cancelled = false;
    hasFeaturePreflight('smartGoals')
      .then((entitled) => {
        if (!cancelled) setSmartGoalsEntitled(entitled);
      })
      .catch(() => {
        if (!cancelled) setSmartGoalsEntitled(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const progress = useMemo<MilestoneProgress[]>(() => {
    if (!state) return [];
    return computeGoalProgress(state, {
      nowMs: Date.now(),
      originMs: summary?.createdAtMs && summary.createdAtMs > 0 ? summary.createdAtMs : undefined,
    });
  }, [state, summary?.createdAtMs]);

  const overallPercent = useMemo(() => {
    if (progress.length === 0) return 0;
    const total = progress.reduce((sum, entry) => sum + entry.percent, 0);
    return Math.round(total / progress.length);
  }, [progress]);

  const nextMilestone = useMemo(
    () => (state ? nextIncompleteMilestone(state) : null),
    [state],
  );

  return {
    loading,
    initialLoaded,
    error,
    summary,
    state,
    progress,
    overallPercent,
    nextMilestone,
    goalAchieved: state?.goalAchieved ?? false,
    smartGoalsEntitled,
    refresh,
  };
}
