/**
 * Notification Context Aggregator Service
 * Combines data from multiple sources to build complete notification contexts
 * for WhatsApp messages based on blockchain events
 */

import { appLogger } from '../utils/logger';
import { suiDataFetcher, NotificationContext as DataFetcherContext } from './sui-data-fetcher.service';
import { circleMemberFetcher, NotificationEligibility } from './circle-member-fetcher.service';

/**
 * Recipient information for a notification
 */
export interface NotificationRecipient {
  address: string;
  phoneNumber?: string;
  name: string;
  role: 'admin' | 'member';
  priority: 'high' | 'medium' | 'low';
  reason: string;
  whatsappType: 'individual' | 'group';
}

/**
 * Message template variables
 */
export interface TemplateVariables {
  circleName: string;
  memberCount: number;
  adminCount: number;
  contributedCount: number;
  pendingCount: number;
  daysUntilDeadline: number;
  deadlineDate: string;
  amountPerMember: string;
  totalContribution: string;
  payoutDate?: string;
  payoutStatus?: string;
  recipientName: string;
  recipientRole: string;
  [key: string]: string | number | undefined;
}

/**
 * Complete notification context for a specific recipient
 */
export interface RecipientNotificationContext {
  circleId: string;
  circleName: string;
  eventType: string;
  recipient: NotificationRecipient;
  templateVariables: TemplateVariables;
  whatsappPhone: string;
  whatsappType: 'individual' | 'group';
  priority: 'high' | 'medium' | 'low';
  timestamp: number;
}

/**
 * Notification batch for a group or circle
 */
export interface NotificationBatch {
  circleId: string;
  eventType: string;
  totalRecipients: number;
  recipients: NotificationRecipient[];
  contexts: RecipientNotificationContext[];
  createdAt: number;
}

/**
 * Event type with metadata
 */
export interface EventMetadata {
  type: string;
  circleId: string;
  data?: Record<string, any>;
}

/**
 * Query result with error handling
 */
interface AggregationResult<T> {
  success: boolean;
  data?: T;
  error?: string;
  duration: number;
}

export class NotificationContextAggregatorService {
  private static instance: NotificationContextAggregatorService;
  private contextCache: Map<string, { data: any; timestamp: number }> = new Map();
  private cacheTTL = 180000; // 3 minutes for aggregated contexts

  private constructor() {
    appLogger.info('Notification Context Aggregator Service initialized');
  }

  /**
   * Get singleton instance
   */
  public static getInstance(): NotificationContextAggregatorService {
    if (!NotificationContextAggregatorService.instance) {
      NotificationContextAggregatorService.instance = new NotificationContextAggregatorService();
    }
    return NotificationContextAggregatorService.instance;
  }

  /**
   * Aggregate complete notification context for an event
   */
  public async aggregateNotificationContext(
    eventType: string,
    circleId: string,
    eventData?: Record<string, any>
  ): Promise<AggregationResult<NotificationBatch>> {
    const startTime = Date.now();
    const cacheKey = `batch:${circleId}:${eventType}`;

    // Check cache
    const cached = this.getFromCache(cacheKey);
    if (cached) {
      return {
        success: true,
        data: cached,
        duration: Date.now() - startTime,
      };
    }

    try {
      // Fetch all necessary data in parallel
      const [dataContext, eligibleMembers] = await Promise.all([
        suiDataFetcher.getNotificationContext(circleId),
        circleMemberFetcher.getNotificationEligibleMembers(circleId, eventType),
      ]);

      if (!dataContext.success || !dataContext.data || eligibleMembers.length === 0) {
        const errorMsg = !dataContext.success
          ? dataContext.error
          : eligibleMembers.length === 0
          ? 'No eligible members for this event'
          : 'Unknown error';

        throw new Error(errorMsg);
      }

      // Build recipients list
      const recipients = this.buildRecipients(dataContext.data, eligibleMembers);

      // Build individual contexts for each recipient
      const contexts: RecipientNotificationContext[] = [];
      for (const recipient of recipients) {
        const context = this.buildRecipientContext(
          eventType,
          circleId,
          dataContext.data,
          recipient,
          eventData
        );
        contexts.push(context);
      }

      // Build batch
      const batch: NotificationBatch = {
        circleId,
        eventType,
        totalRecipients: recipients.length,
        recipients,
        contexts,
        createdAt: Date.now(),
      };

      // Cache the batch
      this.setCache(cacheKey, batch);

      const duration = Date.now() - startTime;

      appLogger.info('Notification batch aggregated', {
        circleId,
        eventType,
        recipients: recipients.length,
        duration,
      });

      return {
        success: true,
        data: batch,
        duration,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appLogger.error('Failed to aggregate notification context', {
        circleId,
        eventType,
        error: message,
        duration: Date.now() - startTime,
      });

      return {
        success: false,
        error: message,
        duration: Date.now() - startTime,
      };
    }
  }

  /**
   * Build recipient list from eligibility data
   */
  private buildRecipients(
    dataContext: DataFetcherContext,
    eligibleMembers: NotificationEligibility[]
  ): NotificationRecipient[] {
    return eligibleMembers
      .filter((eligible) => eligible.shouldNotify)
      .map((eligible) => ({
        address: eligible.address,
        phoneNumber: dataContext.whatsappLink.phoneNumber,
        name: eligible.name,
        role: eligible.role,
        priority: eligible.priority,
        reason: eligible.reason,
        whatsappType: dataContext.whatsappLink.type,
      }));
  }

  /**
   * Build context for a specific recipient
   */
  private buildRecipientContext(
    eventType: string,
    circleId: string,
    dataContext: DataFetcherContext,
    recipient: NotificationRecipient,
    eventData?: Record<string, any>
  ): RecipientNotificationContext {
    // Build template variables
    const templateVariables = this.buildTemplateVariables(
      dataContext,
      recipient,
      eventData
    );

    return {
      circleId,
      circleName: dataContext.circleName,
      eventType,
      recipient,
      templateVariables,
      whatsappPhone: recipient.phoneNumber || '',
      whatsappType: recipient.whatsappType,
      priority: recipient.priority,
      timestamp: Date.now(),
    };
  }

  /**
   * Build template variables for message rendering
   */
  private buildTemplateVariables(
    dataContext: DataFetcherContext,
    recipient: NotificationRecipient,
    eventData?: Record<string, any>
  ): TemplateVariables {
    const contributedCount = dataContext.members.filter((m) => m.hasContributed).length;
    const pendingCount = dataContext.members.length - contributedCount;
    const deadlineDate = new Date(dataContext.cycle.deadline).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });

    const payoutDate = dataContext.payoutInfo.nextPayoutDate
      ? new Date(dataContext.payoutInfo.nextPayoutDate).toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        })
      : undefined;

    return {
      circleName: dataContext.circleName,
      memberCount: dataContext.members.length,
      adminCount: dataContext.members.filter((m) => m.role === 'admin').length,
      contributedCount,
      pendingCount,
      daysUntilDeadline: dataContext.cycle.daysUntilDeadline,
      deadlineDate,
      amountPerMember: this.formatAmount(dataContext.payoutInfo.amountPerMember),
      totalContribution: this.formatAmount(dataContext.cycle.totalContributionRequired),
      payoutDate,
      payoutStatus: dataContext.payoutInfo.status,
      recipientName: recipient.name,
      recipientRole: recipient.role,
      ...eventData, // Merge custom event data
    };
  }

  /**
   * Get context for a single recipient
   */
  public async getRecipientContext(
    eventType: string,
    circleId: string,
    recipientAddress: string,
    eventData?: Record<string, any>
  ): Promise<AggregationResult<RecipientNotificationContext>> {
    const startTime = Date.now();

    try {
      // Get full batch
      const batchResult = await this.aggregateNotificationContext(
        eventType,
        circleId,
        eventData
      );

      if (!batchResult.success || !batchResult.data) {
        throw new Error(batchResult.error || 'Failed to aggregate context');
      }

      // Find recipient context
      const recipientContext = batchResult.data.contexts.find(
        (ctx) => ctx.recipient.address === recipientAddress
      );

      if (!recipientContext) {
        throw new Error(`Recipient ${recipientAddress} not found in context`);
      }

      appLogger.debug('Recipient context fetched', {
        circleId,
        eventType,
        recipientAddress: recipientAddress.substring(0, 6) + '...',
        duration: Date.now() - startTime,
      });

      return {
        success: true,
        data: recipientContext,
        duration: Date.now() - startTime,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appLogger.error('Failed to get recipient context', {
        circleId,
        eventType,
        recipientAddress: recipientAddress.substring(0, 6) + '...',
        error: message,
        duration: Date.now() - startTime,
      });

      return {
        success: false,
        error: message,
        duration: Date.now() - startTime,
      };
    }
  }

  /**
   * Filter contexts by recipient role
   */
  public async getAdminContexts(
    batch: NotificationBatch
  ): Promise<RecipientNotificationContext[]> {
    return batch.contexts.filter((ctx) => ctx.recipient.role === 'admin');
  }

  /**
   * Filter contexts by priority
   */
  public async getContextsByPriority(
    batch: NotificationBatch,
    priority: 'high' | 'medium' | 'low'
  ): Promise<RecipientNotificationContext[]> {
    return batch.contexts.filter((ctx) => ctx.priority === priority);
  }

  /**
   * Get contexts for individual chats (not group)
   */
  public async getIndividualChatContexts(
    batch: NotificationBatch
  ): Promise<RecipientNotificationContext[]> {
    return batch.contexts.filter((ctx) => ctx.whatsappType === 'individual');
  }

  /**
   * Get contexts for group chats
   */
  public async getGroupChatContexts(
    batch: NotificationBatch
  ): Promise<RecipientNotificationContext[]> {
    return batch.contexts.filter((ctx) => ctx.whatsappType === 'group');
  }

  /**
   * Validate context completeness
   */
  public validateContext(context: RecipientNotificationContext): boolean {
    const requiredFields = [
      'circleId',
      'circleName',
      'eventType',
      'recipient',
      'templateVariables',
      'whatsappPhone',
      'whatsappType',
    ];

    for (const field of requiredFields) {
      if (!context[field as keyof RecipientNotificationContext]) {
        appLogger.warn(`Missing required field in context: ${field}`);
        return false;
      }
    }

    // Validate recipient
    const { recipient } = context;
    if (!recipient.address || !recipient.name || !recipient.role) {
      appLogger.warn('Invalid recipient data in context');
      return false;
    }

    return true;
  }

  /**
   * Get aggregation statistics
   */
  public getAggregationStats(batch: NotificationBatch): {
    total: number;
    byRole: { admins: number; members: number };
    byPriority: { high: number; medium: number; low: number };
    byType: { individual: number; group: number };
  } {
    const stats = {
      total: batch.contexts.length,
      byRole: { admins: 0, members: 0 },
      byPriority: { high: 0, medium: 0, low: 0 },
      byType: { individual: 0, group: 0 },
    };

    for (const context of batch.contexts) {
      const role = context.recipient.role;
      const priority = context.priority;
      const type = context.whatsappType;

      if (role === 'admin') stats.byRole.admins++;
      else stats.byRole.members++;

      if (priority === 'high') stats.byPriority.high++;
      else if (priority === 'medium') stats.byPriority.medium++;
      else stats.byPriority.low++;

      if (type === 'individual') stats.byType.individual++;
      else stats.byType.group++;
    }

    return stats;
  }

  /**
   * Format amount for display
   */
  private formatAmount(amount: string): string {
    try {
      const num = parseInt(amount);
      // Assuming amounts are in smallest units, divide by 10^9 for display
      return (num / 1e9).toFixed(2);
    } catch {
      return amount;
    }
  }

  /**
   * Interpolate template variables in a string
   */
  public interpolateTemplate(template: string, variables: TemplateVariables): string {
    let result = template;

    // Replace {{variable}} patterns
    for (const [key, value] of Object.entries(variables)) {
      if (value !== undefined && value !== null) {
        const pattern = new RegExp(`{{\\s*${key}\\s*}}`, 'g');
        result = result.replace(pattern, String(value));
      }
    }

    return result;
  }

  /**
   * Cache helpers
   */
  private getFromCache(key: string): any | null {
    const cached = this.contextCache.get(key);
    if (!cached) return null;

    if (Date.now() - cached.timestamp > this.cacheTTL) {
      this.contextCache.delete(key);
      return null;
    }

    return cached.data;
  }

  private setCache(key: string, data: any): void {
    this.contextCache.set(key, {
      data,
      timestamp: Date.now(),
    });
  }

  /**
   * Clear cache
   */
  public clearCache(): void {
    this.contextCache.clear();
    appLogger.debug('Notification context aggregator cache cleared');
  }

  /**
   * Get cache statistics
   */
  public getCacheStats(): {
    size: number;
    entries: Array<{ key: string; age: number }>;
  } {
    const entries = Array.from(this.contextCache.entries()).map(([key, value]) => ({
      key,
      age: Date.now() - value.timestamp,
    }));

    return {
      size: this.contextCache.size,
      entries,
    };
  }
}

// Export singleton instance
export const notificationContextAggregator = NotificationContextAggregatorService.getInstance();
