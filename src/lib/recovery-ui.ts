export interface RecoveryVoteLike {
  voter: string;
  approved: boolean;
  votedAt: number;
}

export interface RecoveryProposalLike {
  deadline: number;
  passedAt: number | null;
  yesVotes: number;
  noVotes: number;
  majorityThreshold: number;
  eligibleVoters: string[];
  votes: RecoveryVoteLike[];
}

export type RecoveryProposalPhase = 'pending' | 'passed' | 'failed';
export type RecoveryProposalTone = 'neutral' | 'success' | 'danger';

export interface RecoveryProposalUiState {
  phase: RecoveryProposalPhase;
  isPassed: boolean;
  isFailed: boolean;
  isPending: boolean;
  isDeadlinePassed: boolean;
  eligibleVoterCount: number;
  voteCount: number;
  pendingVoteCount: number;
  progressPercent: number;
  currentUserEligibleToVote: boolean;
  currentUserVote: RecoveryVoteLike | null;
  canVote: boolean;
  titleLabel: 'in progress' | 'passed' | 'failed';
  deadlineSummary: string | null;
  closedVoteTone: RecoveryProposalTone;
  closedVoteMessage: string;
  resultBannerTone: Exclude<RecoveryProposalTone, 'neutral'> | null;
  resultBannerTitle: string | null;
  resultBannerMessage: string | null;
}

const normalizeAddress = (value: string | null | undefined): string | null =>
  typeof value === 'string' && value.length > 0 ? value.toLowerCase() : null;

export const getRecoveryProposalUiState = ({
  proposal,
  userAddress,
  now = Date.now(),
}: {
  proposal: RecoveryProposalLike;
  userAddress?: string | null;
  now?: number;
}): RecoveryProposalUiState => {
  const isPassed = Boolean(proposal.passedAt) || proposal.yesVotes >= proposal.majorityThreshold;
  const isDeadlinePassed = proposal.deadline > 0 && now > proposal.deadline;
  const isFailed = !isPassed && isDeadlinePassed;
  const phase: RecoveryProposalPhase = isPassed ? 'passed' : isFailed ? 'failed' : 'pending';
  const normalizedUserAddress = normalizeAddress(userAddress);
  const currentUserVote = normalizedUserAddress
    ? proposal.votes.find((vote) => normalizeAddress(vote.voter) === normalizedUserAddress) ?? null
    : null;
  const currentUserEligibleToVote = normalizedUserAddress
    ? proposal.eligibleVoters.some((address) => normalizeAddress(address) === normalizedUserAddress)
    : false;
  const canVote = phase === 'pending' && currentUserEligibleToVote && !currentUserVote;

  let closedVoteTone: RecoveryProposalTone = 'neutral';
  let closedVoteMessage = 'Your wallet is not in the eligible voter snapshot for this proposal.';

  if (currentUserVote) {
    closedVoteTone = 'success';
    closedVoteMessage = `Your vote has already been recorded as ${currentUserVote.approved ? 'yes' : 'no'}.`;
  } else if (phase === 'passed') {
    closedVoteTone = 'success';
    closedVoteMessage = 'Voting is closed because majority approval has already been reached.';
  } else if (phase === 'failed') {
    closedVoteTone = 'danger';
    closedVoteMessage = 'Voting is closed because the proposal deadline passed without majority approval.';
  }

  let resultBannerTone: Exclude<RecoveryProposalTone, 'neutral'> | null = null;
  let resultBannerTitle: string | null = null;
  let resultBannerMessage: string | null = null;

  if (phase === 'passed') {
    resultBannerTone = 'success';
    resultBannerTitle = 'Recovery approved';
    resultBannerMessage = 'Majority approval is locked in. The admin can now execute the emergency stop and refund path.';
  } else if (phase === 'failed') {
    resultBannerTone = 'danger';
    resultBannerTitle = 'Proposal closed without majority';
    resultBannerMessage = 'The voting window ended before the required yes-vote threshold was reached. Recovery cannot proceed through the vote path unless a new proposal is created.';
  }

  return {
    phase,
    isPassed,
    isFailed,
    isPending: phase === 'pending',
    isDeadlinePassed,
    eligibleVoterCount: proposal.eligibleVoters.length,
    voteCount: proposal.votes.length,
    pendingVoteCount: Math.max(proposal.eligibleVoters.length - proposal.votes.length, 0),
    progressPercent: Math.min(100, (proposal.yesVotes / Math.max(proposal.majorityThreshold, 1)) * 100),
    currentUserEligibleToVote,
    currentUserVote,
    canVote,
    titleLabel: phase === 'passed' ? 'passed' : phase === 'failed' ? 'failed' : 'in progress',
    deadlineSummary:
      phase === 'passed'
        ? 'Majority approval already exists.'
        : phase === 'failed'
          ? 'Voting window expired without majority approval.'
          : null,
    closedVoteTone,
    closedVoteMessage,
    resultBannerTone,
    resultBannerTitle,
    resultBannerMessage,
  };
};
