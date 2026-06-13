// MilestonesManageCard.tsx — Self-contained "Smart Goals" section for
// the circle manage page. Keeps the manage-page diff minimal: it reads
// the circle's smart-goal config and tracker status itself and links the
// admin to the dedicated goals page where milestones are defined and
// celebrated. Viewing status here is never premium-gated.

import React, { useEffect, useMemo, useState } from 'react';
import NextLink from 'next/link';
import { Target } from 'lucide-react';
import { useMilestones } from '@/hooks/useMilestones';
import {
  readCircleGoalContext,
  type CircleGoalContext,
} from '@/lib/milestone-discovery';
import type { NetworkType } from '@/services/whatsapp-registry-service';

export interface MilestonesManageCardProps {
  circleId: string;
  network: NetworkType;
  isAdmin: boolean;
}

const eyebrowClass =
  'text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-500';
const titleClass = 'text-xl font-semibold tracking-tight text-slate-950';

export function MilestonesManageCard({
  circleId,
  network,
  isAdmin,
}: MilestonesManageCardProps) {
  const [goalContext, setGoalContext] = useState<CircleGoalContext | null>(null);
  const [contextLoaded, setContextLoaded] = useState(false);

  const { loading, summary, state } = useMilestones({
    circleId,
    network,
    // The manage page is long-lived and already RPC-heavy; one read is
    // enough here — the goals page does the live polling.
    pollIntervalMs: 0,
  });

  useEffect(() => {
    let cancelled = false;
    readCircleGoalContext(circleId, network)
      .then((ctx) => {
        if (!cancelled) {
          setGoalContext(ctx);
          setContextLoaded(true);
        }
      })
      .catch(() => {
        if (!cancelled) setContextLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [circleId, network]);

  const completedCount = useMemo(
    () => state?.milestones.filter((m) => m.completed).length ?? 0,
    [state],
  );

  const statusLine = (() => {
    if (!contextLoaded || loading) return 'Checking the goal tracker…';
    if (goalContext && !goalContext.hasGoal) {
      return 'This circle runs as a classic rotation without a smart goal. Smart goals are chosen when a circle is created.';
    }
    if (!summary) {
      return isAdmin
        ? 'This is a smart-goal circle, but its milestones haven’t been defined yet. Set them on the goals page before the first round settles.'
        : 'This is a smart-goal circle. The admin hasn’t defined its milestones yet.';
    }
    if (state) {
      if (state.goalAchieved) {
        return `Goal achieved — all ${state.milestones.length} milestones reached. Visit the goals page to celebrate together.`;
      }
      return `${completedCount} of ${state.milestones.length} milestone${state.milestones.length === 1 ? '' : 's'} reached so far.`;
    }
    return 'Goal tracker found — open the goals page for live progress.';
  })();

  const showGoalsLink = !goalContext || goalContext.hasGoal || Boolean(summary);

  return (
    <>
      <div className="mb-5">
        <p className={eyebrowClass}>Community Goal</p>
        <h3 className={`${titleClass} mt-2`}>Smart Goals</h3>
        <p className="mt-2 text-sm leading-6 text-slate-500">
          Milestones the whole circle works toward and celebrates together.
          Progress comes straight from settled rounds on chain.
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-[18px] border border-stone-200 bg-[#fbfaf7] p-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[#d8e2f0] bg-white text-[#5f708a]">
            <Target className="h-4 w-4" />
          </span>
          <p className="text-sm leading-6 text-slate-700">{statusLine}</p>
        </div>
        {showGoalsLink ? (
          <NextLink
            href={`/circle/${circleId}/goals`}
            className="inline-flex shrink-0 items-center justify-center rounded-full bg-slate-950 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800"
          >
            Open goals page
          </NextLink>
        ) : null}
      </div>
    </>
  );
}

export default MilestonesManageCard;
