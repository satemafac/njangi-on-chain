import React, { type ReactNode } from 'react';
import { RefreshCw } from 'lucide-react';
import { RecoveryStateBadge } from '@/components/recovery/RecoveryStateBadge';
import type { RecoveryProposalUiState } from '@/lib/recovery-ui';

interface RecoveryVoteLike {
  voter: string;
  approved: boolean;
  votedAt: number;
}

interface RecoveryProposalLike {
  proposer: string;
  deadline: number;
  yesVotes: number;
  noVotes: number;
  majorityThreshold: number;
  eligibleVoters: string[];
  votes: RecoveryVoteLike[];
}

interface RecoveryProposalCardProps {
  eyebrow: string;
  title: string;
  description: string;
  stateLabel: string;
  rawState: number;
  proposal: RecoveryProposalLike;
  proposalUi: RecoveryProposalUiState;
  now: number;
  formatDate: (timestamp: number, useLocalTime?: boolean) => string;
  formatRelativeDuration: (milliseconds: number) => string;
  onRefresh?: () => void;
  loading?: boolean;
  footerTags?: ReactNode;
  actionArea?: ReactNode;
  className?: string;
}

const shortenAddress = (value: string): string => `${value.slice(0, 6)}...${value.slice(-4)}`;

export function RecoveryProposalCard({
  eyebrow,
  title,
  description,
  stateLabel,
  rawState,
  proposal,
  proposalUi,
  now,
  formatDate,
  formatRelativeDuration,
  onRefresh,
  loading = false,
  footerTags,
  actionArea,
  className = '',
}: RecoveryProposalCardProps) {
  return (
    <div className={`rounded-[24px] border border-stone-200 bg-white p-5 sm:p-6 ${className}`.trim()}>
      <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
        <div className="max-w-2xl">
          <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-500">{eyebrow}</p>
          <h3 className="mt-3 text-2xl font-semibold tracking-[-0.04em] text-slate-950">{title}</h3>
          <p className="mt-3 text-sm leading-7 text-slate-600">{description}</p>
        </div>

        <div className="w-full max-w-sm rounded-[20px] border border-stone-200 bg-stone-50 p-4">
          <div className="flex items-center justify-between gap-3">
            <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-500">Proposal status</p>
            {onRefresh && (
              <button
                type="button"
                onClick={onRefresh}
                disabled={loading}
                className="inline-flex items-center gap-2 rounded-full border border-stone-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 transition-colors hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
                Refresh
              </button>
            )}
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <RecoveryStateBadge rawState={rawState} stateLabel={stateLabel} />
            <span className="inline-flex items-center rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700">
              Proposed by {shortenAddress(proposal.proposer)}
            </span>
          </div>

          <p className="mt-3 text-sm leading-6 text-slate-600">Deadline: {formatDate(proposal.deadline, true)}</p>
          <p className="mt-1 text-sm leading-6 text-slate-600">
            {proposalUi.deadlineSummary || `${formatRelativeDuration(proposal.deadline - now)} remaining`}
          </p>
        </div>
      </div>

      <div className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-[20px] border border-stone-200 bg-stone-50 p-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-500">Yes votes</p>
          <p className="mt-2 text-2xl font-semibold text-slate-950">{proposal.yesVotes}</p>
          <p className="mt-1 text-xs text-slate-500">Need {proposal.majorityThreshold} to pass</p>
        </div>
        <div className="rounded-[20px] border border-stone-200 bg-stone-50 p-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-500">No votes</p>
          <p className="mt-2 text-2xl font-semibold text-slate-950">{proposal.noVotes}</p>
          <p className="mt-1 text-xs text-slate-500">{proposalUi.voteCount} total votes recorded</p>
        </div>
        <div className="rounded-[20px] border border-stone-200 bg-stone-50 p-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-500">Eligible voters</p>
          <p className="mt-2 text-2xl font-semibold text-slate-950">{proposalUi.eligibleVoterCount}</p>
          <p className="mt-1 text-xs text-slate-500">{proposalUi.pendingVoteCount} votes still pending</p>
        </div>
        <div className="rounded-[20px] border border-stone-200 bg-stone-50 p-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-500">Threshold</p>
          <p className="mt-2 text-2xl font-semibold text-slate-950">{proposal.majorityThreshold}</p>
          <p className="mt-1 text-xs text-slate-500">Snapshot-based majority requirement</p>
        </div>
      </div>

      <div className="mt-6">
        <div className="mb-2 flex items-center justify-between gap-3">
          <p className="text-sm font-medium text-slate-700">Approval progress</p>
          <p className="text-xs text-slate-500">
            {proposal.yesVotes} / {proposal.majorityThreshold} yes votes
          </p>
        </div>
        <div className="h-3 rounded-full bg-stone-200" aria-label="Emergency stop approval progress">
          <div
            className={`h-3 rounded-full transition-all duration-500 ${
              proposalUi.isPassed ? 'bg-emerald-500' : proposalUi.isFailed ? 'bg-red-500' : 'bg-amber-500'
            }`}
            style={{ width: `${proposalUi.progressPercent}%` }}
          />
        </div>
      </div>

      {footerTags ? <div className="mt-5 flex flex-wrap items-center gap-2">{footerTags}</div> : null}

      {proposalUi.resultBannerTone && (
        <div
          className={`mt-5 rounded-[18px] border p-4 text-sm ${
            proposalUi.resultBannerTone === 'success'
              ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
              : 'border-red-200 bg-red-50 text-red-900'
          }`}
        >
          <p className="font-medium">{proposalUi.resultBannerTitle}</p>
          <p className="mt-2 leading-6">{proposalUi.resultBannerMessage}</p>
        </div>
      )}

      {actionArea ? <div className="mt-5">{actionArea}</div> : null}

      {proposal.votes.length > 0 && (
        <div className="mt-5 rounded-[24px] border border-stone-200 bg-stone-50">
          <div className="border-b border-stone-200 px-4 py-3 sm:px-5">
            <p className="text-sm font-medium text-slate-900">Recent votes</p>
          </div>
          <div className="divide-y divide-stone-200">
            {proposal.votes
              .slice()
              .sort((left, right) => right.votedAt - left.votedAt)
              .slice(0, 6)
              .map((vote) => (
                <div key={`${vote.voter}-${vote.votedAt}`} className="flex items-center justify-between gap-3 px-4 py-3 sm:px-5">
                  <div>
                    <p className="font-mono text-sm font-medium text-slate-950">{shortenAddress(vote.voter)}</p>
                    <p className="mt-1 text-xs text-slate-500">{formatDate(vote.votedAt, true)}</p>
                  </div>
                  <span
                    className={`inline-flex rounded-full px-3 py-1 text-xs font-medium ${
                      vote.approved ? 'bg-emerald-100 text-emerald-800' : 'bg-stone-100 text-slate-700'
                    }`}
                  >
                    {vote.approved ? 'Approved' : 'Rejected'}
                  </span>
                </div>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}
