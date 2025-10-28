/**
 * Sui Event Parser Service
 * Converts raw Sui events into typed application objects
 */

import { appLogger } from '../utils/logger';
import {
  SuiEvent,
  ParsedBlockchainEvent,
  NewCycleStartedEvent,
  MemberContributedEvent,
  AllMembersContributedEvent,
  DeadlineApproachingEvent,
  PayoutOverdueEvent,
  ContributorOverdueEvent,
  PayoutReminderEvent,
  NotificationSentEvent,
  EVENT_TYPES,
} from '../utils/sui-event-types';

export class SuiEventParserService {
  constructor(private packageId: string) {}

  /**
   * Parse a raw Sui event into a typed event object
   */
  public parseEvent(rawEvent: SuiEvent, eventType: string): ParsedBlockchainEvent | null {
    try {
      const json = rawEvent.parsedJson as Record<string, any>;
      const timestamp = rawEvent.timestampMs ? parseInt(rawEvent.timestampMs, 10) : Date.now();
      const txDigest = rawEvent.id.txDigest;

      switch (eventType) {
        case EVENT_TYPES.NEW_CYCLE_STARTED:
          return this.parseNewCycleStarted(json, txDigest, timestamp);
        case EVENT_TYPES.MEMBER_CONTRIBUTED:
          return this.parseMemberContributed(json, txDigest, timestamp);
        case EVENT_TYPES.ALL_MEMBERS_CONTRIBUTED:
          return this.parseAllMembersContributed(json, txDigest, timestamp);
        case EVENT_TYPES.DEADLINE_APPROACHING:
          return this.parseDeadlineApproaching(json, txDigest, timestamp);
        case EVENT_TYPES.PAYOUT_OVERDUE:
          return this.parsePayoutOverdue(json, txDigest, timestamp);
        case EVENT_TYPES.CONTRIBUTOR_OVERDUE:
          return this.parseContributorOverdue(json, txDigest, timestamp);
        case EVENT_TYPES.PAYOUT_REMINDER:
          return this.parsePayoutReminder(json, txDigest, timestamp);
        case EVENT_TYPES.NOTIFICATION_SENT:
          return this.parseNotificationSent(json, txDigest, timestamp);
        default:
          appLogger.warn(`Unknown event type: ${eventType}`);
          return null;
      }
    } catch (error) {
      appLogger.error('Failed to parse event', {
        eventType,
        error: (error as Error).message,
        rawEvent: JSON.stringify(rawEvent),
      });
      return null;
    }
  }

  /**
   * Parse NewCycleStartedEvent
   */
  private parseNewCycleStarted(
    json: Record<string, any>,
    txDigest: string,
    timestamp: number
  ): NewCycleStartedEvent {
    return {
      type: 'NewCycleStartedEvent',
      circleId: this.normalizeId(json.circle_id),
      startTime: this.parseNumber(json.start_time),
      cycleNumber: this.parseNumber(json.cycle_number),
      totalMembers: this.parseNumber(json.total_members),
      txDigest,
      timestamp,
    };
  }

  /**
   * Parse MemberContributedEvent
   */
  private parseMemberContributed(
    json: Record<string, any>,
    txDigest: string,
    timestamp: number
  ): MemberContributedEvent {
    return {
      type: 'MemberContributedEvent',
      circleId: this.normalizeId(json.circle_id),
      memberId: this.normalizeId(json.member_id),
      memberAddress: this.normalizeAddress(json.member_address),
      amountContributed: this.normalizeAmount(json.amount_contributed),
      totalContributed: this.normalizeAmount(json.total_contributed),
      txDigest,
      timestamp,
    };
  }

  /**
   * Parse AllMembersContributedEvent
   */
  private parseAllMembersContributed(
    json: Record<string, any>,
    txDigest: string,
    timestamp: number
  ): AllMembersContributedEvent {
    return {
      type: 'AllMembersContributedEvent',
      circleId: this.normalizeId(json.circle_id),
      cycleNumber: this.parseNumber(json.cycle_number),
      totalAmount: this.normalizeAmount(json.total_amount),
      completedAt: this.parseNumber(json.completed_at),
      txDigest,
      timestamp,
    };
  }

  /**
   * Parse DeadlineApproachingEvent
   */
  private parseDeadlineApproaching(
    json: Record<string, any>,
    txDigest: string,
    timestamp: number
  ): DeadlineApproachingEvent {
    return {
      type: 'DeadlineApproachingEvent',
      circleId: this.normalizeId(json.circle_id),
      hoursUntil: this.parseNumber(json.hours_until),
      deadline: this.parseNumber(json.deadline),
      membersContributed: this.parseNumber(json.members_contributed),
      membersRemaining: this.parseNumber(json.members_remaining),
      txDigest,
      timestamp,
    };
  }

  /**
   * Parse PayoutOverdueEvent
   */
  private parsePayoutOverdue(
    json: Record<string, any>,
    txDigest: string,
    timestamp: number
  ): PayoutOverdueEvent {
    return {
      type: 'PayoutOverdueEvent',
      circleId: this.normalizeId(json.circle_id),
      overdueMinutes: this.parseNumber(json.overdue_minutes),
      adminsNotified: this.parseNumber(json.admins_notified),
      txDigest,
      timestamp,
    };
  }

  /**
   * Parse ContributorOverdueEvent
   */
  private parseContributorOverdue(
    json: Record<string, any>,
    txDigest: string,
    timestamp: number
  ): ContributorOverdueEvent {
    return {
      type: 'ContributorOverdueEvent',
      circleId: this.normalizeId(json.circle_id),
      contributorAddress: this.normalizeAddress(json.contributor_address),
      overdueHours: this.parseNumber(json.overdue_hours),
      expectedAmount: this.normalizeAmount(json.expected_amount),
      txDigest,
      timestamp,
    };
  }

  /**
   * Parse PayoutReminderEvent
   */
  private parsePayoutReminder(
    json: Record<string, any>,
    txDigest: string,
    timestamp: number
  ): PayoutReminderEvent {
    return {
      type: 'PayoutReminderEvent',
      circleId: this.normalizeId(json.circle_id),
      reminderType: (json.reminder_type as
        | 'pending_approval'
        | 'ready_to_send'
        | 'delayed'
        | 'custom') || 'custom',
      recipient: this.normalizeAddress(json.recipient),
      reminderData: json.reminder_data || {},
      txDigest,
      timestamp,
    };
  }

  /**
   * Parse NotificationSentEvent
   */
  private parseNotificationSent(
    json: Record<string, any>,
    txDigest: string,
    timestamp: number
  ): NotificationSentEvent {
    return {
      type: 'NotificationSent',
      circleId: this.normalizeId(json.circle_id),
      messageType: String(json.message_type || 'unknown'),
      recipient: String(json.recipient || ''),
      success: Boolean(json.success),
      txDigest,
      timestamp,
    };
  }

  /**
   * Helper: Normalize ID fields
   */
  private normalizeId(value: any): string {
    if (typeof value === 'string') {
      return value;
    }
    if (typeof value === 'object' && value?.id) {
      return String(value.id);
    }
    return String(value || '');
  }

  /**
   * Helper: Normalize address fields
   */
  private normalizeAddress(value: any): string {
    if (typeof value === 'string') {
      return value.startsWith('0x') ? value : `0x${value}`;
    }
    if (typeof value === 'object' && value?.address) {
      const addr = String(value.address);
      return addr.startsWith('0x') ? addr : `0x${addr}`;
    }
    return `0x${String(value || '')}`;
  }

  /**
   * Helper: Normalize amount fields (handle both string and number)
   */
  private normalizeAmount(value: any): string {
    if (typeof value === 'string') {
      return value;
    }
    if (typeof value === 'number') {
      return String(value);
    }
    if (typeof value === 'object' && value?.value) {
      return String(value.value);
    }
    return String(value || '0');
  }

  /**
   * Helper: Parse numeric values safely
   */
  private parseNumber(value: any): number {
    if (typeof value === 'number') {
      return value;
    }
    if (typeof value === 'string') {
      const parsed = parseInt(value, 10);
      return isNaN(parsed) ? 0 : parsed;
    }
    if (typeof value === 'object' && value?.value) {
      return parseInt(String(value.value), 10) || 0;
    }
    return 0;
  }

  /**
   * Validate event data integrity
   */
  public validateEvent(event: ParsedBlockchainEvent): boolean {
    if (!event.circleId || event.circleId.length === 0) {
      appLogger.warn('Invalid event: missing circleId', { event });
      return false;
    }

    if (!event.txDigest || event.txDigest.length === 0) {
      appLogger.warn('Invalid event: missing txDigest', { event });
      return false;
    }

    if (event.timestamp <= 0) {
      appLogger.warn('Invalid event: invalid timestamp', { event });
      return false;
    }

    return true;
  }
}
