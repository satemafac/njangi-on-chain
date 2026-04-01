import { getRecoveryProposalUiState, type RecoveryProposalLike } from '@/lib/recovery-ui';

const baseProposal = (): RecoveryProposalLike => ({
  deadline: 10_000,
  passedAt: null,
  yesVotes: 1,
  noVotes: 0,
  majorityThreshold: 3,
  eligibleVoters: ['0xAlice', '0xBob', '0xCarol', '0xDave'],
  votes: [
    {
      voter: '0xAlice',
      approved: true,
      votedAt: 5_000,
    },
  ],
});

describe('recovery-ui helpers', () => {
  it('treats a proposal as passed when passedAt is recorded', () => {
    const proposal = baseProposal();
    proposal.passedAt = 8_000;

    expect(
      getRecoveryProposalUiState({
        proposal,
        userAddress: '0xBob',
        now: 7_500,
      }),
    ).toMatchObject({
      phase: 'passed',
      isPassed: true,
      canVote: false,
      titleLabel: 'passed',
      deadlineSummary: 'Majority approval already exists.',
      resultBannerTitle: 'Recovery approved',
    });
  });

  it('treats a proposal as passed when yes votes meet the threshold', () => {
    const proposal = baseProposal();
    proposal.yesVotes = 3;
    proposal.votes = [
      ...proposal.votes,
      { voter: '0xBob', approved: true, votedAt: 6_000 },
      { voter: '0xCarol', approved: true, votedAt: 7_000 },
    ];

    const state = getRecoveryProposalUiState({
      proposal,
      userAddress: '0xDave',
      now: 7_500,
    });

    expect(state.phase).toBe('passed');
    expect(state.progressPercent).toBe(100);
    expect(state.canVote).toBe(false);
  });

  it('marks a proposal as failed when the deadline passes without majority approval', () => {
    const state = getRecoveryProposalUiState({
      proposal: baseProposal(),
      userAddress: '0xBob',
      now: 10_001,
    });

    expect(state).toMatchObject({
      phase: 'failed',
      isFailed: true,
      canVote: false,
      deadlineSummary: 'Voting window expired without majority approval.',
      closedVoteTone: 'danger',
      resultBannerTitle: 'Proposal closed without majority',
    });
    expect(state.closedVoteMessage).toContain('deadline passed without majority approval');
  });

  it('allows an eligible member to vote while the proposal is pending', () => {
    const state = getRecoveryProposalUiState({
      proposal: baseProposal(),
      userAddress: '0xbob',
      now: 7_500,
    });

    expect(state).toMatchObject({
      phase: 'pending',
      isPending: true,
      currentUserEligibleToVote: true,
      currentUserVote: null,
      canVote: true,
      titleLabel: 'in progress',
    });
  });

  it('blocks voting for a member whose vote is already recorded, regardless of address casing', () => {
    const proposal = baseProposal();
    proposal.votes = [
      ...proposal.votes,
      { voter: '0xBOB', approved: false, votedAt: 6_500 },
    ];

    const state = getRecoveryProposalUiState({
      proposal,
      userAddress: '0xbob',
      now: 7_500,
    });

    expect(state.currentUserVote).toEqual({
      voter: '0xBOB',
      approved: false,
      votedAt: 6_500,
    });
    expect(state.canVote).toBe(false);
    expect(state.closedVoteMessage).toBe('Your vote has already been recorded as no.');
  });

  it('shows the ineligible snapshot message for wallets outside the voter set', () => {
    const state = getRecoveryProposalUiState({
      proposal: baseProposal(),
      userAddress: '0xEve',
      now: 7_500,
    });

    expect(state.currentUserEligibleToVote).toBe(false);
    expect(state.canVote).toBe(false);
    expect(state.closedVoteTone).toBe('neutral');
    expect(state.closedVoteMessage).toBe('Your wallet is not in the eligible voter snapshot for this proposal.');
  });
});
