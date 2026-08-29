import {
  getRecoveryProposalUiState,
  getRecoveryDelegateCardCopy,
  type RecoveryProposalLike,
} from '@/lib/recovery-ui';

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

describe('getRecoveryDelegateCardCopy', () => {
  const base = {
    statusKnown: true as boolean,
    autoReleaseEnabled: true,
    delegateStatus: 'none' as 'none' | 'valid' | 'invalid',
    authorityMode: 'member_fallback' as 'delegate_grace' | 'member_fallback',
  };

  const allStrings = (copy: Record<string, string>) =>
    Object.entries(copy)
      .filter(([key]) => key !== 'requirement')
      .map(([, value]) => value);

  it('never demands a delegate on a circle where auto-release is off', () => {
    // The shipped bug: activate_circle only enforces a delegate when
    // auto-release is enabled, and such a circle can never HAVE one
    // (njangi_circles.move:555 stores option::none() at creation, and there is
    // no entry point to change it). Demanding one was unsatisfiable.
    const copy = getRecoveryDelegateCardCopy({ ...base, autoReleaseEnabled: false });

    expect(copy.requirement).toBe('not_applicable');
    for (const value of allStrings(copy as unknown as Record<string, string>)) {
      expect(value).not.toMatch(/required|before activating|must keep/i);
    }
  });

  it('asserts nothing about auto-release while the status is unknown', () => {
    // The regression this guards: getRecoveryAutoReleaseUiState(null) returns
    // enabled:false, identical to a genuinely disabled circle. Branching on
    // `enabled` alone would announce "auto-release is off, no delegate needed"
    // for a circle where it is ON and the delegate is MISSING — a false
    // all-clear on a safety control.
    const copy = getRecoveryDelegateCardCopy({ ...base, statusKnown: false });

    expect(copy.requirement).toBe('unknown');
    for (const value of allStrings(copy as unknown as Record<string, string>)) {
      expect(value).not.toMatch(/\b(enabled|disabled|not configured|no fallback)\b/i);
    }
  });

  it('distinguishes a failed load from a load still in flight', () => {
    const loading = getRecoveryDelegateCardCopy({ ...base, statusKnown: false });
    const errored = getRecoveryDelegateCardCopy({ ...base, statusKnown: false, loadError: true });

    expect(loading.requirement).toBe('unknown');
    expect(errored.requirement).toBe('unknown');
    expect(errored.summaryBody).not.toBe(loading.summaryBody);
    expect(errored.summaryBody).toMatch(/refresh/i);
  });

  it('still demands a delegate when auto-release is genuinely enabled', () => {
    const copy = getRecoveryDelegateCardCopy(base);

    expect(copy.requirement).toBe('required');
    expect(copy.summaryTitle).toBe('Delegate required.');
    expect(copy.formHint).toMatch(/required before activation/i);
  });

  it('flags a configured but ineligible delegate separately from a missing one', () => {
    const copy = getRecoveryDelegateCardCopy({ ...base, delegateStatus: 'invalid' });

    expect(copy.requirement).toBe('attention');
    expect(copy.summaryTitle).not.toBe('Delegate required.');
  });

  it('reports a healthy delegate without warning language', () => {
    const copy = getRecoveryDelegateCardCopy({
      ...base,
      delegateStatus: 'valid',
      authorityMode: 'delegate_grace',
    });

    expect(copy.requirement).toBe('healthy');
    expect(copy.authorityModeLabel).toBe('24h delegate window');
    expect(copy.summaryBody).not.toMatch(/required/i);
  });
});
