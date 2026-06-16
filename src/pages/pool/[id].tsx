import React from 'react';
import { useRouter } from 'next/router';
import { useAuth } from '@/contexts/AuthContext';
import { getCurrentNetwork } from '@/services/network-config';
import type { NetworkType } from '@/services/whatsapp-registry-service';
import GoalPoolPanel from '@/components/goals/GoalPoolPanel';

/**
 * Public goal-pool page. Anyone with the link can watch the pot grow and (after
 * signing in) chip in. The whole "pool money with friends" experience lives
 * here — no circle membership, no security deposit.
 */
export default function GoalPoolPage() {
  const router = useRouter();
  const { id } = router.query;
  const { userAddress } = useAuth();
  const poolId = typeof id === 'string' ? id : '';
  const network = getCurrentNetwork() as NetworkType;

  return (
    <div className="min-h-screen bg-[#f6f3ee] text-[#171923]">
      <main className="relative mx-auto max-w-3xl px-4 py-6 sm:px-6 sm:py-8">
        <div className="mb-6">
          <button
            type="button"
            onClick={() => router.push('/dashboard')}
            className="inline-flex items-center gap-2 rounded-full border border-stone-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 transition hover:bg-stone-50"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
            Dashboard
          </button>
        </div>

        {poolId ? (
          <GoalPoolPanel poolId={poolId} network={network} userAddress={userAddress ?? null} />
        ) : (
          <p className="text-sm text-[#5f6674]">Loading…</p>
        )}
      </main>
    </div>
  );
}
