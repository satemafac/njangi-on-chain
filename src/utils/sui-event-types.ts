/**
 * Sui Blockchain Event Types
 * Defines all event structures emitted by the whatsapp_integration Move contract
 */

export interface SuiEvent {
  id: {
    txDigest: string;
    eventSeq: string;
  };
  packageId: string;
  transactionModule: string;
  sender: string;
  type: string;
  parsedJson: Record<string, unknown>;
  bcs?: string;
  timestampMs?: string;
}

// Event type constants matching Move contract
export const EVENT_TYPES = {
  NEW_CYCLE_STARTED: 'NewCycleStartedEvent',
  MEMBER_CONTRIBUTED: 'MemberContributedEvent',
  ALL_MEMBERS_CONTRIBUTED: 'AllMembersContributedEvent',
  DEADLINE_APPROACHING: 'DeadlineApproachingEvent',
  PAYOUT_OVERDUE: 'PayoutOverdueEvent',
  CONTRIBUTOR_OVERDUE: 'ContributorOverdueEvent',
  PAYOUT_REMINDER: 'PayoutReminderEvent',
  NOTIFICATION_SENT: 'NotificationSent',
} as const;

/**
 * Parsed event types - represent events after extraction from blockchain
 */

export interface NewCycleStartedEvent {
  type: 'NewCycleStartedEvent';
  circleId: string;
  startTime: number;
  cycleNumber: number;
  totalMembers: number;
  txDigest: string;
  timestamp: number;
}

export interface MemberContributedEvent {
  type: 'MemberContributedEvent';
  circleId: string;
  memberId: string;
  memberAddress: string;
  amountContributed: string;
  totalContributed: string;
  txDigest: string;
  timestamp: number;
}

export interface AllMembersContributedEvent {
  type: 'AllMembersContributedEvent';
  circleId: string;
  cycleNumber: number;
  totalAmount: string;
  completedAt: number;
  txDigest: string;
  timestamp: number;
}

export interface DeadlineApproachingEvent {
  type: 'DeadlineApproachingEvent';
  circleId: string;
  hoursUntil: number;
  deadline: number;
  membersContributed: number;
  membersRemaining: number;
  txDigest: string;
  timestamp: number;
}

export interface PayoutOverdueEvent {
  type: 'PayoutOverdueEvent';
  circleId: string;
  overdueMinutes: number;
  adminsNotified: number;
  txDigest: string;
  timestamp: number;
}

export interface ContributorOverdueEvent {
  type: 'ContributorOverdueEvent';
  circleId: string;
  contributorAddress: string;
  overdueHours: number;
  expectedAmount: string;
  txDigest: string;
  timestamp: number;
}

export interface PayoutReminderEvent {
  type: 'PayoutReminderEvent';
  circleId: string;
  reminderType: 'pending_approval' | 'ready_to_send' | 'delayed' | 'custom';
  recipient: string;
  reminderData: Record<string, unknown>;
  txDigest: string;
  timestamp: number;
}

export interface NotificationSentEvent {
  type: 'NotificationSent';
  circleId: string;
  messageType: string;
  recipient: string;
  success: boolean;
  txDigest: string;
  timestamp: number;
}

// Union type for all events
export type ParsedBlockchainEvent =
  | NewCycleStartedEvent
  | MemberContributedEvent
  | AllMembersContributedEvent
  | DeadlineApproachingEvent
  | PayoutOverdueEvent
  | ContributorOverdueEvent
  | PayoutReminderEvent
  | NotificationSentEvent;

/**
 * Event subscription configuration
 */
export interface EventSubscriptionConfig {
  packageId: string;
  eventTypes: string[];
  cursor?: string;
  maxEventsPerQuery?: number;
  pollingIntervalMs?: number;
  shouldBacktrack?: boolean;
}

/**
 * RPC connection configuration
 */
export interface RpcConnectionConfig {
  url: string;
  name: string;
  maxRetries?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
  priority?: number; // Lower is higher priority
}

/**
 * Event listener state
 */
export interface EventListenerState {
  isConnected: boolean;
  lastProcessedCursor: string | null;
  eventsProcessed: number;
  lastEventTimestamp: number;
  connectionRetries: number;
  lastError?: {
    message: string;
    timestamp: number;
    code?: string;
  };
}

/**
 * Event filtering criteria
 */
export interface EventFilterCriteria {
  circleId?: string;
  eventTypes?: string[];
  fromTimestamp?: number;
  toTimestamp?: number;
  senderAddress?: string;
}

export type EventHandler = (event: ParsedBlockchainEvent) => Promise<void>;
