/**
 * Event Parser Utilities
 * Helper functions for event parsing, filtering, and transformation
 */

import {
  ParsedBlockchainEvent,
  EventFilterCriteria,
  NewCycleStartedEvent,
  MemberContributedEvent,
  AllMembersContributedEvent,
  DeadlineApproachingEvent,
  PayoutOverdueEvent,
  ContributorOverdueEvent,
  PayoutReminderEvent,
  NotificationSentEvent,
} from './sui-event-types';
import { appLogger } from './logger';

/**
 * Advanced filtering predicate builder
 */
export class EventFilterBuilder {
  private predicates: Array<(event: ParsedBlockchainEvent) => boolean> = [];

  /**
   * Filter by circle ID (can match multiple)
   */
  public byCircleIds(circleIds: string[]): this {
    if (circleIds.length > 0) {
      this.predicates.push((event) => circleIds.includes((event as any).circleId));
    }
    return this;
  }

  /**
   * Filter by event type (can match multiple)
   */
  public byEventTypes(eventTypes: string[]): this {
    if (eventTypes.length > 0) {
      this.predicates.push((event) => eventTypes.includes(event.type));
    }
    return this;
  }

  /**
   * Filter by timestamp range
   */
  public byTimestampRange(fromMs?: number, toMs?: number): this {
    this.predicates.push((event) => {
      if (fromMs && event.timestamp < fromMs) return false;
      if (toMs && event.timestamp > toMs) return false;
      return true;
    });
    return this;
  }

  /**
   * Filter by transaction digest
   */
  public byTxDigest(txDigest: string): this {
    this.predicates.push((event) => event.txDigest === txDigest);
    return this;
  }

  /**
   * Filter by member address (for MemberContributedEvent)
   */
  public byMemberAddress(address: string): this {
    this.predicates.push((event) => {
      if (event.type === 'MemberContributedEvent') {
        return (event as MemberContributedEvent).memberAddress === normalizeAddress(address);
      }
      return false;
    });
    return this;
  }

  /**
   * Filter by recipient address (for notification events)
   */
  public byRecipient(recipient: string): this {
    this.predicates.push((event) => {
      if (event.type === 'PayoutReminderEvent') {
        return (event as PayoutReminderEvent).recipient === normalizeAddress(recipient);
      }
      if (event.type === 'NotificationSent') {
        return (event as NotificationSentEvent).recipient === recipient;
      }
      return false;
    });
    return this;
  }

  /**
   * Filter by notification success (for NotificationSentEvent)
   */
  public byNotificationSuccess(success: boolean): this {
    this.predicates.push((event) => {
      if (event.type === 'NotificationSent') {
        return (event as NotificationSentEvent).success === success;
      }
      return false;
    });
    return this;
  }

  /**
   * Filter by amount threshold (for MemberContributedEvent)
   */
  public byMinAmount(minAmount: string | number): this {
    const minNum = typeof minAmount === 'string' ? parseInt(minAmount, 10) : minAmount;
    this.predicates.push((event) => {
      if (event.type === 'MemberContributedEvent') {
        const amount = parseInt((event as MemberContributedEvent).amountContributed, 10);
        return amount >= minNum;
      }
      return false;
    });
    return this;
  }

  /**
   * Filter by deadline hours (for DeadlineApproachingEvent)
   */
  public byDeadlineHoursBefore(hours: number): this {
    this.predicates.push((event) => {
      if (event.type === 'DeadlineApproachingEvent') {
        return (event as DeadlineApproachingEvent).hoursUntil <= hours;
      }
      return false;
    });
    return this;
  }

  /**
   * Custom predicate
   */
  public where(predicate: (event: ParsedBlockchainEvent) => boolean): this {
    this.predicates.push(predicate);
    return this;
  }

  /**
   * Build the filter function
   */
  public build(): (event: ParsedBlockchainEvent) => boolean {
    return (event) => this.predicates.every((p) => p(event));
  }

  /**
   * Filter an array of events
   */
  public filter(events: ParsedBlockchainEvent[]): ParsedBlockchainEvent[] {
    const filterFn = this.build();
    return events.filter(filterFn);
  }
}

/**
 * Event grouping utilities
 */
export class EventGrouper {
  /**
   * Group events by circle ID
   */
  public static groupByCircleId(
    events: ParsedBlockchainEvent[]
  ): Map<string, ParsedBlockchainEvent[]> {
    const grouped = new Map<string, ParsedBlockchainEvent[]>();

    for (const event of events) {
      const circleId = (event as any).circleId;
      if (!grouped.has(circleId)) {
        grouped.set(circleId, []);
      }
      grouped.get(circleId)!.push(event);
    }

    return grouped;
  }

  /**
   * Group events by event type
   */
  public static groupByEventType(
    events: ParsedBlockchainEvent[]
  ): Map<string, ParsedBlockchainEvent[]> {
    const grouped = new Map<string, ParsedBlockchainEvent[]>();

    for (const event of events) {
      if (!grouped.has(event.type)) {
        grouped.set(event.type, []);
      }
      grouped.get(event.type)!.push(event);
    }

    return grouped;
  }

  /**
   * Group events by timestamp bucket (hourly, daily, etc)
   */
  public static groupByTimeBucket(
    events: ParsedBlockchainEvent[],
    bucketSizeMs: number
  ): Map<number, ParsedBlockchainEvent[]> {
    const grouped = new Map<number, ParsedBlockchainEvent[]>();

    for (const event of events) {
      const bucketKey = Math.floor(event.timestamp / bucketSizeMs) * bucketSizeMs;
      if (!grouped.has(bucketKey)) {
        grouped.set(bucketKey, []);
      }
      grouped.get(bucketKey)!.push(event);
    }

    return grouped;
  }

  /**
   * Group events hierarchically (by circle, then by type)
   */
  public static groupHierarchical(
    events: ParsedBlockchainEvent[]
  ): Map<string, Map<string, ParsedBlockchainEvent[]>> {
    const hierarchical = new Map<string, Map<string, ParsedBlockchainEvent[]>>();

    for (const event of events) {
      const circleId = (event as any).circleId;

      if (!hierarchical.has(circleId)) {
        hierarchical.set(circleId, new Map());
      }

      const circleEvents = hierarchical.get(circleId)!;
      if (!circleEvents.has(event.type)) {
        circleEvents.set(event.type, []);
      }

      circleEvents.get(event.type)!.push(event);
    }

    return hierarchical;
  }
}

/**
 * Event validation utilities
 */
export class EventValidator {
  /**
   * Validate all required fields are present
   */
  public static validateRequired(event: ParsedBlockchainEvent): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    // Common fields
    if (!event.circleId || event.circleId.trim().length === 0) {
      errors.push('Missing or empty circleId');
    }
    if (!event.txDigest || event.txDigest.trim().length === 0) {
      errors.push('Missing or empty txDigest');
    }
    if (event.timestamp <= 0) {
      errors.push('Invalid timestamp');
    }

    // Type-specific fields
    switch (event.type) {
      case 'MemberContributedEvent': {
        const e = event as MemberContributedEvent;
        if (!e.memberAddress) errors.push('Missing memberAddress');
        if (!e.amountContributed) errors.push('Missing amountContributed');
        break;
      }
      case 'PayoutReminderEvent': {
        const e = event as PayoutReminderEvent;
        if (!e.recipient) errors.push('Missing recipient');
        break;
      }
      case 'NotificationSent': {
        const e = event as NotificationSentEvent;
        if (!e.messageType) errors.push('Missing messageType');
        break;
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Validate data types
   */
  public static validateTypes(event: ParsedBlockchainEvent): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (typeof event.type !== 'string') {
      errors.push('event.type must be a string');
    }
    if (typeof event.timestamp !== 'number') {
      errors.push('event.timestamp must be a number');
    }
    if (typeof event.txDigest !== 'string') {
      errors.push('event.txDigest must be a string');
    }

    // Type-specific validation
    switch (event.type) {
      case 'MemberContributedEvent': {
        const e = event as MemberContributedEvent;
        if (typeof e.amountContributed !== 'string') {
          errors.push('amountContributed must be a string');
        }
        break;
      }
      case 'DeadlineApproachingEvent': {
        const e = event as DeadlineApproachingEvent;
        if (typeof e.hoursUntil !== 'number') {
          errors.push('hoursUntil must be a number');
        }
        break;
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Full validation
   */
  public static validate(event: ParsedBlockchainEvent): { valid: boolean; errors: string[] } {
    const requiredCheck = this.validateRequired(event);
    if (!requiredCheck.valid) {
      return requiredCheck;
    }

    return this.validateTypes(event);
  }
}

/**
 * Event transformation utilities
 */
export class EventTransformer {
  /**
   * Convert event to JSON with human-readable timestamps
   */
  public static toJSON(
    event: ParsedBlockchainEvent
  ): Record<string, any> {
    return {
      ...event,
      timestamp: new Date(event.timestamp).toISOString(),
      timestampMs: event.timestamp,
    };
  }

  /**
   * Create a summary of events for logging/reporting
   */
  public static createSummary(events: ParsedBlockchainEvent[]): {
    total: number;
    byType: Record<string, number>;
    byCircle: Record<string, number>;
    timeRange: { start: number; end: number };
  } {
    const byType = new Map<string, number>();
    const byCircle = new Map<string, number>();
    let minTime = Infinity;
    let maxTime = -Infinity;

    for (const event of events) {
      // Count by type
      byType.set(event.type, (byType.get(event.type) || 0) + 1);

      // Count by circle
      const circleId = (event as any).circleId;
      byCircle.set(circleId, (byCircle.get(circleId) || 0) + 1);

      // Track time range
      minTime = Math.min(minTime, event.timestamp);
      maxTime = Math.max(maxTime, event.timestamp);
    }

    return {
      total: events.length,
      byType: Object.fromEntries(byType),
      byCircle: Object.fromEntries(byCircle),
      timeRange: {
        start: minTime === Infinity ? 0 : minTime,
        end: maxTime === -Infinity ? 0 : maxTime,
      },
    };
  }

  /**
   * Deduplicate events (by txDigest + eventType)
   */
  public static deduplicate(events: ParsedBlockchainEvent[]): ParsedBlockchainEvent[] {
    const seen = new Set<string>();
    const unique: ParsedBlockchainEvent[] = [];

    for (const event of events) {
      const key = `${event.type}:${event.txDigest}`;
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(event);
      }
    }

    appLogger.debug('Event deduplication', {
      original: events.length,
      deduplicated: unique.length,
      removed: events.length - unique.length,
    });

    return unique;
  }

  /**
   * Sort events by timestamp
   */
  public static sortByTimestamp(
    events: ParsedBlockchainEvent[],
    ascending = true
  ): ParsedBlockchainEvent[] {
    return [...events].sort((a, b) => {
      return ascending ? a.timestamp - b.timestamp : b.timestamp - a.timestamp;
    });
  }

  /**
   * Paginate events
   */
  public static paginate(
    events: ParsedBlockchainEvent[],
    pageSize: number,
    pageNumber: number
  ): {
    events: ParsedBlockchainEvent[];
    pagination: {
      pageNumber: number;
      pageSize: number;
      totalEvents: number;
      totalPages: number;
      hasNext: boolean;
      hasPrev: boolean;
    };
  } {
    const totalPages = Math.ceil(events.length / pageSize);
    const start = (pageNumber - 1) * pageSize;
    const end = start + pageSize;

    return {
      events: events.slice(start, end),
      pagination: {
        pageNumber,
        pageSize,
        totalEvents: events.length,
        totalPages,
        hasNext: pageNumber < totalPages,
        hasPrev: pageNumber > 1,
      },
    };
  }
}

/**
 * Utility functions
 */

export function normalizeAddress(addr: string): string {
  return addr.startsWith('0x') ? addr : `0x${addr}`;
}

export function normalizeAmount(amount: string | number): string {
  return typeof amount === 'string' ? amount : String(amount);
}

export function parseAmount(amount: string): number {
  return parseInt(amount, 10) || 0;
}

export function formatAmount(amount: string | number, decimals = 2): string {
  const num = typeof amount === 'string' ? parseFloat(amount) : amount;
  return num.toFixed(decimals);
}

export function millisToSeconds(ms: number): number {
  return Math.round(ms / 1000);
}

export function secondsToMillis(seconds: number): number {
  return seconds * 1000;
}

/**
 * Create a filter criteria from common parameters
 */
export function createFilterCriteria(params: {
  circleIds?: string[];
  eventTypes?: string[];
  fromTime?: number;
  toTime?: number;
}): EventFilterCriteria {
  return {
    circleId: params.circleIds?.[0],
    eventTypes: params.eventTypes,
    fromTimestamp: params.fromTime,
    toTimestamp: params.toTime,
  };
}
