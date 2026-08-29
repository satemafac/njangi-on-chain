import {
  AUTO_RELEASE_DELEGATE_GRACE_PERIOD_MS,
  getRecoveryAutoReleaseUiState,
  parseRecoveryStatus,
} from '@/lib/recovery-liveness';

const ADMIN_ADDRESS = '0x00000000000000000000000000000000000000000000000000000000000000aa';
const DELEGATE_ADDRESS = '0x00000000000000000000000000000000000000000000000000000000000000bb';
const MEMBER_ADDRESS = '0x00000000000000000000000000000000000000000000000000000000000000cc';

describe('recovery liveness helpers', () => {
  it('parses delegate and heartbeat fields from config', () => {
    const status = parseRecoveryStatus({
      recovery_state: '0',
      recovery_proposal: { vec: [] },
      auto_release_enabled: true,
      auto_release_delay_ms: '1000',
      auto_release_start_time: '5000',
      next_in_command: { vec: [DELEGATE_ADDRESS] },
      recovery_state_updated_at: '5500',
    });

    expect(status).toMatchObject({
      rawState: 0,
      autoReleaseEnabled: true,
      autoReleaseDelayMs: 1000,
      autoReleaseStartTime: 5000,
      autoReleaseTriggerTime: 6000,
      lastAdminHeartbeatAt: 5000,
      nextInCommand: DELEGATE_ADDRESS,
      lastUpdatedAt: 5500,
    });
  });

  it('parses an inlined recovery proposal struct payload', () => {
    const status = parseRecoveryStatus({
      recovery_state: '1',
      recovery_proposal: {
        type: '0x1::recovery::RecoveryProposal',
        fields: {
          proposer: ADMIN_ADDRESS,
          created_at: '7000',
          deadline: '9000',
          passed_at: null,
          yes_votes: '1',
          no_votes: '0',
          majority_threshold: '2',
          eligible_voters: [ADMIN_ADDRESS, DELEGATE_ADDRESS, MEMBER_ADDRESS],
          votes: [],
        },
      },
      auto_release_enabled: true,
      auto_release_delay_ms: '1000',
      auto_release_start_time: '5000',
      next_in_command: DELEGATE_ADDRESS,
      recovery_state_updated_at: '7500',
    });

    expect(status?.rawState).toBe(1);
    expect(status?.proposal).toMatchObject({
      proposer: ADMIN_ADDRESS,
      createdAt: 7000,
      deadline: 9000,
      passedAt: null,
      yesVotes: 1,
      noVotes: 0,
      majorityThreshold: 2,
      eligibleVoters: [ADMIN_ADDRESS, DELEGATE_ADDRESS, MEMBER_ADDRESS],
      votes: [],
    });
  });

  it('authorizes the valid delegate first when expiry is reached', () => {
    const state = getRecoveryAutoReleaseUiState({
      recoveryStatus: {
        rawState: 0,
        autoReleaseEnabled: true,
        autoReleaseTriggerTime: 1000,
        nextInCommand: DELEGATE_ADDRESS,
      },
      adminAddress: ADMIN_ADDRESS,
      userAddress: DELEGATE_ADDRESS,
      viewerIsEligibleActiveMember: true,
      delegateIsEligibleActiveMember: true,
      now: 1000,
    });

    expect(state.viewerRole).toBe('delegate');
    expect(state.delegateStatus).toBe('valid');
    expect(state.viewerCanTrigger).toBe(true);
    expect(state.authorityMode).toBe('delegate_grace');
    expect(state.memberFallbackReady).toBe(false);
    expect(state.memberFallbackUnlockTime).toBe(1000 + AUTO_RELEASE_DELEGATE_GRACE_PERIOD_MS);
  });

  it('blocks active members during the delegate-exclusive grace window', () => {
    const state = getRecoveryAutoReleaseUiState({
      recoveryStatus: {
        rawState: 0,
        autoReleaseEnabled: true,
        autoReleaseTriggerTime: 1000,
        nextInCommand: DELEGATE_ADDRESS,
      },
      adminAddress: ADMIN_ADDRESS,
      userAddress: MEMBER_ADDRESS,
      viewerIsEligibleActiveMember: true,
      delegateIsEligibleActiveMember: true,
      now: 1000,
    });

    expect(state.viewerRole).toBe('member_waiting_delegate');
    expect(state.viewerBlockedByDelegate).toBe(true);
    expect(state.viewerCanTrigger).toBe(false);
    expect(state.memberFallbackReady).toBe(false);
  });

  it('unlocks member fallback after the delegate grace window expires', () => {
    const state = getRecoveryAutoReleaseUiState({
      recoveryStatus: {
        rawState: 0,
        autoReleaseEnabled: true,
        autoReleaseTriggerTime: 1000,
        nextInCommand: DELEGATE_ADDRESS,
      },
      adminAddress: ADMIN_ADDRESS,
      userAddress: MEMBER_ADDRESS,
      viewerIsEligibleActiveMember: true,
      delegateIsEligibleActiveMember: true,
      now: 1000 + AUTO_RELEASE_DELEGATE_GRACE_PERIOD_MS,
    });

    expect(state.viewerRole).toBe('member_fallback');
    expect(state.viewerBlockedByDelegate).toBe(false);
    expect(state.viewerCanTrigger).toBe(true);
    expect(state.memberFallbackReady).toBe(true);
    expect(state.authorityMode).toBe('member_fallback');
  });

  it('falls back immediately to any active non-admin member when no valid delegate exists', () => {
    const state = getRecoveryAutoReleaseUiState({
      recoveryStatus: {
        rawState: 0,
        autoReleaseEnabled: true,
        autoReleaseTriggerTime: 1000,
        nextInCommand: DELEGATE_ADDRESS,
      },
      adminAddress: ADMIN_ADDRESS,
      userAddress: MEMBER_ADDRESS,
      viewerIsEligibleActiveMember: true,
      delegateIsEligibleActiveMember: false,
      now: 1000,
    });

    expect(state.delegateStatus).toBe('invalid');
    expect(state.viewerRole).toBe('member_fallback');
    expect(state.viewerCanTrigger).toBe(true);
    expect(state.memberFallbackReady).toBe(true);
    expect(state.authorityMode).toBe('member_fallback');
  });

  it('never allows the admin to trigger auto-release', () => {
    const state = getRecoveryAutoReleaseUiState({
      recoveryStatus: {
        rawState: 0,
        autoReleaseEnabled: true,
        autoReleaseTriggerTime: 1000,
        nextInCommand: null,
      },
      adminAddress: ADMIN_ADDRESS,
      userAddress: ADMIN_ADDRESS,
      viewerIsEligibleActiveMember: true,
      delegateIsEligibleActiveMember: false,
      now: 1000,
    });

    expect(state.viewerRole).toBe('admin');
    expect(state.viewerCanTrigger).toBe(false);
  });

  it('invalidates a delegate that matches the admin and reopens member fallback', () => {
    const state = getRecoveryAutoReleaseUiState({
      recoveryStatus: {
        rawState: 0,
        autoReleaseEnabled: true,
        autoReleaseTriggerTime: 1000,
        nextInCommand: ADMIN_ADDRESS,
      },
      adminAddress: ADMIN_ADDRESS,
      userAddress: MEMBER_ADDRESS,
      viewerIsEligibleActiveMember: true,
      delegateIsEligibleActiveMember: true,
      now: 1000,
    });

    expect(state.delegateStatus).toBe('invalid');
    expect(state.validDelegate).toBeNull();
    expect(state.viewerRole).toBe('member_fallback');
    expect(state.viewerCanTrigger).toBe(true);
    expect(state.memberFallbackReady).toBe(true);
  });

  /**
   * Coverage gap that let the delegate bug ship: every other case in this file
   * passes autoReleaseEnabled: true, so nothing pinned the behaviour callers
   * actually had to branch on.
   */
  it('reports a null snapshot identically to a disabled circle — callers must check status is known', () => {
    const unknown = getRecoveryAutoReleaseUiState({
      recoveryStatus: null,
      adminAddress: ADMIN_ADDRESS,
      userAddress: ADMIN_ADDRESS,
      viewerIsEligibleActiveMember: false,
      delegateIsEligibleActiveMember: false,
      now: 10_000,
    });

    expect(unknown.enabled).toBe(false);
    expect(unknown.delegateStatus).toBe('none');
    expect(unknown.ready).toBe(false);
    expect(unknown.memberFallbackReady).toBe(false);
    // This is the trap: `enabled === false` here means "we have not read the
    // circle", not "auto-release is off". UI must not render a settled state
    // from it — see getRecoveryDelegateCardCopy's `statusKnown` input.
  });

  it('never arms the fallback on a circle where auto-release is disabled', () => {
    const disabled = getRecoveryAutoReleaseUiState({
      recoveryStatus: {
        rawState: 0,
        autoReleaseEnabled: false,
        autoReleaseTriggerTime: 2_000,
        nextInCommand: DELEGATE_ADDRESS,
      },
      adminAddress: ADMIN_ADDRESS,
      userAddress: MEMBER_ADDRESS,
      viewerIsEligibleActiveMember: true,
      delegateIsEligibleActiveMember: true,
      // Well past the trigger time — an enabled circle would be armed here.
      now: 999_999,
    });

    expect(disabled.enabled).toBe(false);
    expect(disabled.ready).toBe(false);
    expect(disabled.memberFallbackReady).toBe(false);
    expect(disabled.viewerCanTrigger).toBe(false);
  });
});
