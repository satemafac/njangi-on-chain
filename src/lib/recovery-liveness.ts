export interface RecoveryVoteSummary {
  voter: string;
  approved: boolean;
  votedAt: number;
}

export interface RecoveryProposalSummary {
  proposer: string;
  createdAt: number;
  deadline: number;
  passedAt: number | null;
  yesVotes: number;
  noVotes: number;
  majorityThreshold: number;
  eligibleVoters: string[];
  votes: RecoveryVoteSummary[];
}

export interface RecoveryStatusSnapshot {
  rawState: number;
  stateLabel: string;
  proposal: RecoveryProposalSummary | null;
  autoReleaseEnabled: boolean;
  autoReleaseDelayMs: number;
  autoReleaseStartTime: number;
  autoReleaseTriggerTime: number | null;
  lastAdminHeartbeatAt: number;
  nextInCommand: string | null;
  lastUpdatedAt: number;
}

export type RecoveryAutoReleaseViewerRole =
  | 'admin'
  | 'delegate'
  | 'member_fallback'
  | 'member_waiting_delegate'
  | 'ineligible_viewer';

export interface RecoveryAutoReleaseUiState {
  enabled: boolean;
  isTerminal: boolean;
  ready: boolean;
  remainingMs: number;
  delegateExclusiveUntil: number | null;
  memberFallbackUnlockTime: number | null;
  memberFallbackRemainingMs: number;
  memberFallbackReady: boolean;
  configuredDelegate: string | null;
  validDelegate: string | null;
  delegateStatus: 'none' | 'valid' | 'invalid';
  viewerRole: RecoveryAutoReleaseViewerRole;
  viewerIsAdmin: boolean;
  viewerIsEligibleActiveMember: boolean;
  viewerCanTriggerWhenReady: boolean;
  viewerCanTrigger: boolean;
  viewerBlockedByDelegate: boolean;
  authorityMode: 'delegate_grace' | 'member_fallback';
}

export const AUTO_RELEASE_DELEGATE_GRACE_PERIOD_MS = 24 * 60 * 60 * 1000;

const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
};

const unwrapMoveValue = (value: unknown): unknown => {
  const record = asRecord(value);
  if (!record) {
    return value;
  }

  if ('fields' in record) {
    return unwrapMoveValue(record.fields);
  }

  if ('value' in record) {
    return unwrapMoveValue(record.value);
  }

  return value;
};

const moveVectorToArray = (value: unknown): unknown[] => {
  if (Array.isArray(value)) {
    return value;
  }

  const unwrapped = unwrapMoveValue(value);
  if (Array.isArray(unwrapped)) {
    return unwrapped;
  }

  const record = asRecord(unwrapped);
  if (!record || !Array.isArray(record.vec)) {
    return [];
  }

  return record.vec;
};

const moveOptionToValue = (value: unknown): unknown | null => {
  if (value === null || typeof value === 'undefined') {
    return null;
  }

  if (Array.isArray(value)) {
    return value.length > 0 ? value[0] : null;
  }

  const record = asRecord(value);
  if (!record) {
    return value;
  }

  if ('some' in record) {
    return record.some ?? null;
  }

  const vec = moveVectorToArray(record);
  return vec.length > 0 ? vec[0] : null;
};

const parseU64Like = (value: unknown): bigint => {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.max(0, Math.trunc(value)));
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  return 0n;
};

const parseMoveBool = (value: unknown): boolean => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  return false;
};

const parseAddressList = (value: unknown): string[] =>
  moveVectorToArray(value)
    .map((entry) => {
      if (typeof entry === 'string') return entry;
      const record = asRecord(entry);
      if (typeof record?.value === 'string') return record.value;
      return null;
    })
    .filter((entry): entry is string => Boolean(entry));

const parseRecoveryVoteSummaries = (value: unknown): RecoveryVoteSummary[] =>
  moveVectorToArray(value)
    .map((entry) => {
      const fields = asRecord(unwrapMoveValue(entry));
      if (!fields || typeof fields.voter !== 'string') {
        return null;
      }

      return {
        voter: fields.voter,
        approved: parseMoveBool(fields.approved),
        votedAt: Number(parseU64Like(fields.voted_at)),
      };
    })
    .filter((entry): entry is RecoveryVoteSummary => entry !== null);

export const getRecoveryStateLabel = (value: number): string => {
  switch (value) {
    case 1:
      return 'Proposal Pending';
    case 2:
      return 'Stopped';
    case 3:
      return 'Refunded';
    default:
      return 'Active';
  }
};

const parseRecoveryProposal = (value: unknown): RecoveryProposalSummary | null => {
  const proposalValue = moveOptionToValue(value);
  const fields = asRecord(unwrapMoveValue(proposalValue));
  if (!fields || typeof fields.proposer !== 'string') {
    return null;
  }

  return {
    proposer: fields.proposer,
    createdAt: Number(parseU64Like(fields.created_at)),
    deadline: Number(parseU64Like(fields.deadline)),
    passedAt: (() => {
      const passedAtValue = moveOptionToValue(fields.passed_at);
      if (passedAtValue === null) {
        return null;
      }
      return Number(parseU64Like(passedAtValue));
    })(),
    yesVotes: Number(parseU64Like(fields.yes_votes)),
    noVotes: Number(parseU64Like(fields.no_votes)),
    majorityThreshold: Number(parseU64Like(fields.majority_threshold)),
    eligibleVoters: parseAddressList(fields.eligible_voters),
    votes: parseRecoveryVoteSummaries(fields.votes),
  };
};

export const parseRecoveryStatus = (
  configFields: Record<string, unknown> | null | undefined,
): RecoveryStatusSnapshot | null => {
  if (!configFields) {
    return null;
  }

  const rawState = Number(parseU64Like(configFields.recovery_state));
  const autoReleaseEnabled = parseMoveBool(configFields.auto_release_enabled);
  const autoReleaseDelayMs = Number(parseU64Like(configFields.auto_release_delay_ms));
  const autoReleaseStartTime = Number(parseU64Like(configFields.auto_release_start_time));
  const nextInCommandValue = moveOptionToValue(configFields.next_in_command);

  return {
    rawState,
    stateLabel: getRecoveryStateLabel(rawState),
    proposal: parseRecoveryProposal(configFields.recovery_proposal),
    autoReleaseEnabled,
    autoReleaseDelayMs,
    autoReleaseStartTime,
    autoReleaseTriggerTime: autoReleaseEnabled ? autoReleaseStartTime + autoReleaseDelayMs : null,
    lastAdminHeartbeatAt: autoReleaseStartTime,
    nextInCommand: typeof nextInCommandValue === 'string' ? nextInCommandValue : null,
    lastUpdatedAt: Number(parseU64Like(configFields.recovery_state_updated_at)),
  };
};

const normalizeAddress = (value: string | null | undefined): string | null =>
  typeof value === 'string' && value.length > 0 ? value.toLowerCase() : null;

export const getRecoveryAutoReleaseUiState = ({
  recoveryStatus,
  adminAddress,
  userAddress,
  viewerIsEligibleActiveMember,
  delegateIsEligibleActiveMember,
  now = Date.now(),
}: {
  recoveryStatus: Pick<
    RecoveryStatusSnapshot,
    'rawState' | 'autoReleaseEnabled' | 'autoReleaseTriggerTime' | 'nextInCommand'
  > | null;
  adminAddress?: string | null;
  userAddress?: string | null;
  viewerIsEligibleActiveMember: boolean;
  delegateIsEligibleActiveMember: boolean;
  now?: number;
}): RecoveryAutoReleaseUiState => {
  const isTerminal = recoveryStatus?.rawState === 2 || recoveryStatus?.rawState === 3;
  const enabled = recoveryStatus?.autoReleaseEnabled === true;
  const triggerTime = recoveryStatus?.autoReleaseTriggerTime ?? null;
  const remainingMs = triggerTime ? Math.max(0, triggerTime - now) : 0;
  const ready = Boolean(enabled && triggerTime && remainingMs === 0 && !isTerminal);
  const normalizedAdmin = normalizeAddress(adminAddress);
  const normalizedUser = normalizeAddress(userAddress);
  const normalizedConfiguredDelegate = normalizeAddress(recoveryStatus?.nextInCommand ?? null);
  const validDelegate =
    normalizedConfiguredDelegate
      && normalizedConfiguredDelegate !== normalizedAdmin
      && delegateIsEligibleActiveMember
        ? normalizedConfiguredDelegate
        : null;
  const delegateExclusiveUntil = validDelegate && triggerTime
    ? triggerTime + AUTO_RELEASE_DELEGATE_GRACE_PERIOD_MS
    : null;
  const memberFallbackUnlockTime = triggerTime
    ? validDelegate
      ? delegateExclusiveUntil
      : triggerTime
    : null;
  const memberFallbackRemainingMs = memberFallbackUnlockTime
    ? Math.max(0, memberFallbackUnlockTime - now)
    : 0;
  const memberFallbackReady = Boolean(
    enabled && memberFallbackUnlockTime && memberFallbackRemainingMs === 0 && !isTerminal,
  );
  const delegateStatus: RecoveryAutoReleaseUiState['delegateStatus'] =
    !normalizedConfiguredDelegate ? 'none' : validDelegate ? 'valid' : 'invalid';

  const viewerIsAdmin = Boolean(normalizedUser && normalizedAdmin && normalizedUser === normalizedAdmin);
  const viewerIsDelegate = Boolean(normalizedUser && validDelegate && normalizedUser === validDelegate);
  const viewerCanFallbackEventually = Boolean(
    viewerIsEligibleActiveMember && !viewerIsAdmin,
  );
  const viewerBlockedByDelegate = Boolean(
    viewerIsEligibleActiveMember
      && !viewerIsAdmin
      && !!validDelegate
      && !viewerIsDelegate
      && !memberFallbackReady,
  );
  const viewerCanFallback = Boolean(
    viewerCanFallbackEventually && (!validDelegate || memberFallbackReady),
  );
  const viewerCanTriggerWhenReady = Boolean(
    enabled && !isTerminal && (viewerIsDelegate || viewerCanFallbackEventually),
  );

  let viewerRole: RecoveryAutoReleaseViewerRole = 'ineligible_viewer';
  if (viewerIsAdmin) {
    viewerRole = 'admin';
  } else if (viewerIsDelegate) {
    viewerRole = 'delegate';
  } else if (viewerCanFallback) {
    viewerRole = 'member_fallback';
  } else if (viewerBlockedByDelegate) {
    viewerRole = 'member_waiting_delegate';
  }

  return {
    enabled,
    isTerminal,
    ready,
    remainingMs,
    delegateExclusiveUntil,
    memberFallbackUnlockTime,
    memberFallbackRemainingMs,
    memberFallbackReady,
    configuredDelegate: normalizedConfiguredDelegate,
    validDelegate,
    delegateStatus,
    viewerRole,
    viewerIsAdmin,
    viewerIsEligibleActiveMember,
    viewerCanTriggerWhenReady,
    viewerCanTrigger: ready && (viewerIsDelegate || viewerCanFallback),
    viewerBlockedByDelegate,
    authorityMode: validDelegate && !memberFallbackReady ? 'delegate_grace' : 'member_fallback',
  };
};
