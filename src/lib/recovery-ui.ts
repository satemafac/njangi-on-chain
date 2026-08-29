/**
 * Copy for the admin-liveness ("next in command") card.
 *
 * Exists because the manage page told every admin that activation "requires
 * ... a non-admin recovery delegate". `activate_circle`
 * (move/sources/njangi_circles.move:635) enforces that only inside
 * `if (config::is_auto_release_enabled(&circle.id))`, and on a circle where
 * auto-release is OFF the demand is not merely premature — it is
 * unsatisfiable. At creation the contract stores
 * `if (auto_release_enabled) { next_in_command } else { option::none() }`
 * (njangi_circles.move:555), and `config::set_auto_release_config` has no
 * entry point, so such a circle cannot have a delegate and cannot gain one.
 * The UI was demanding an action while disabling the only button for it.
 *
 * `requirement` is deliberately five-way rather than a boolean. The dangerous
 * state is `unknown`: `getRecoveryAutoReleaseUiState(null)` returns
 * `enabled: false`, which is indistinguishable from a genuinely disabled
 * circle. Branching on `enabled` alone would let an unloaded page announce
 * "auto-release is off, no delegate needed" for a circle where it is ON and
 * the delegate is MISSING — a false all-clear on a safety control, strictly
 * worse than the over-warning it replaces. Callers must pass `statusKnown`.
 */
export type RecoveryDelegateRequirement =
  | 'unknown'
  | 'not_applicable'
  | 'required'
  | 'attention'
  | 'healthy';

export interface RecoveryDelegateCardCopy {
  requirement: RecoveryDelegateRequirement;
  delegateValueFallback: string;
  delegateHint: string;
  authorityModeLabel: string;
  authorityModeHint: string;
  formHint: string;
  summaryTitle: string;
  summaryBody: string;
}

export const getRecoveryDelegateCardCopy = ({
  statusKnown,
  loadError = false,
  autoReleaseEnabled,
  delegateStatus,
  authorityMode,
  circleIsActive = false,
}: {
  statusKnown: boolean;
  loadError?: boolean;
  autoReleaseEnabled: boolean;
  delegateStatus: 'none' | 'valid' | 'invalid';
  authorityMode: 'delegate_grace' | 'member_fallback';
  circleIsActive?: boolean;
}): RecoveryDelegateCardCopy => {
  // Nothing here may assert that auto-release is on OR off.
  if (!statusKnown) {
    const body = loadError
      ? 'Recovery configuration could not be loaded. Refresh to see whether this circle has an admin-liveness fallback.'
      : 'Checking whether this circle has an admin-liveness fallback…';
    return {
      requirement: 'unknown',
      delegateValueFallback: '—',
      delegateHint: body,
      authorityModeLabel: '—',
      authorityModeHint: body,
      formHint: body,
      summaryTitle: loadError ? 'Recovery configuration unavailable' : 'Checking recovery configuration…',
      summaryBody: body,
    };
  }

  // Settled state, not a to-do: the choice was made at creation and the
  // contract gives no way to change it.
  if (!autoReleaseEnabled) {
    const body =
      'This circle was created without the admin-liveness fallback, so it has no next in command. That choice is fixed at creation and does not block activation.';
    return {
      requirement: 'not_applicable',
      delegateValueFallback: 'Not applicable',
      delegateHint: body,
      authorityModeLabel: 'No fallback configured',
      authorityModeHint:
        'Members recover this circle through the member-majority emergency stop instead.',
      formHint: body,
      summaryTitle: 'Auto-release is off for this circle.',
      summaryBody: body,
    };
  }

  if (delegateStatus === 'none') {
    const body =
      'Set a valid delegate before activating this circle so the admin-liveness fallback path is fully armed.';
    return {
      requirement: 'required',
      delegateValueFallback: 'Delegate required',
      delegateHint: circleIsActive
        ? 'Active auto-release circles must keep a valid next-in-command wallet configured.'
        : 'Set a valid next-in-command before activating the circle.',
      authorityModeLabel: 'Active-member fallback',
      authorityModeHint:
        'Auto-release now requires a valid delegate address before this fallback should be relied on.',
      formHint: 'Required before activation: choose an active non-admin member as next in command.',
      summaryTitle: 'Delegate required.',
      summaryBody: body,
    };
  }

  if (delegateStatus === 'invalid') {
    const body =
      'The configured next in command is not an eligible active non-admin member. Choose another before relying on this path.';
    return {
      requirement: 'attention',
      delegateValueFallback: 'Delegate needs attention',
      delegateHint: body,
      authorityModeLabel: authorityMode === 'delegate_grace' ? '24h delegate window' : 'Active-member fallback',
      authorityModeHint: body,
      formHint: 'Choose an active non-admin member as next in command.',
      summaryTitle: 'Delegate needs attention.',
      summaryBody: body,
    };
  }

  return {
    requirement: 'healthy',
    delegateValueFallback: 'Delegate configured',
    delegateHint: 'The delegate gets 24 hours of exclusive recovery authority if the heartbeat expires.',
    authorityModeLabel: authorityMode === 'delegate_grace' ? '24h delegate window' : 'Active-member fallback',
    authorityModeHint:
      'If the admin heartbeat expires, the next in command can act before eligible active members can.',
    formHint: 'The next in command must remain an active non-admin member.',
    summaryTitle: 'Delegate is healthy.',
    summaryBody:
      'The admin-liveness fallback is armed. Your next signed admin action refreshes the heartbeat timer.',
  };
};

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
