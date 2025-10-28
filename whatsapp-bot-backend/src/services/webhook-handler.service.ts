/**
 * Webhook Handler Service
 * Processes WhatsApp delivery status updates and incoming messages
 * Integrates with message queue for status tracking
 */

import { appLogger } from '../utils/logger';
import { messageQueue } from './message-queue.service';

// ============================================================================
// TYPES & INTERFACES
// ============================================================================

export type DeliveryStatus = 'sent' | 'delivered' | 'read' | 'failed';
export type MessageType = 'text' | 'image' | 'document' | 'audio' | 'video' | 'button' | 'interactive';

export interface WhatsAppStatusUpdate {
  messageId: string;
  status: DeliveryStatus;
  timestamp: string;
  recipientId?: string;
  errors?: Array<{
    code: number;
    title: string;
    message: string;
  }>;
}

export interface IncomingWhatsAppMessage {
  from: string;
  messageId: string;
  timestamp: string;
  type: MessageType;
  text?: { body: string };
  image?: { id: string; mime_type: string; sha256: string };
  document?: { id: string; mime_type: string; sha256: string; filename: string };
  audio?: { id: string; mime_type: string; sha256: string };
  video?: { id: string; mime_type: string; sha256: string };
}

export interface MessageDeliveryRecord {
  messageId: string;
  waMessageId: string;
  to: string;
  status: DeliveryStatus;
  createdAt: number;
  sentAt?: number;
  deliveredAt?: number;
  readAt?: number;
  failedAt?: number;
  errors?: string[];
  attempts: number;
}

export interface DeliveryMetrics {
  totalReceived: number;
  totalProcessed: number;
  sent: number;
  delivered: number;
  read: number;
  failed: number;
  averageDeliveryTime: number;
  averageReadTime: number;
}

// ============================================================================
// WEBHOOK HANDLER SERVICE
// ============================================================================

export class WebhookHandlerService {
  private deliveryRecords: Map<string, MessageDeliveryRecord> = new Map();
  private waMessageIdToQueueId: Map<string, string> = new Map();
  
  private metrics = {
    totalReceived: 0,
    totalProcessed: 0,
    sent: 0,
    delivered: 0,
    read: 0,
    failed: 0,
    deliveryTimes: [] as number[],
    readTimes: [] as number[],
  };

  constructor() {
    appLogger.info('Webhook Handler Service initialized');
  }

  // ==================== STATUS UPDATE HANDLING ====================

  /**
   * Process WhatsApp delivery status update
   */
  public async handleStatusUpdate(update: WhatsAppStatusUpdate): Promise<void> {
    const startTime = Date.now();

    try {
      appLogger.debug('Processing status update', {
        messageId: update.messageId,
        status: update.status,
        recipientId: update.recipientId,
      });

      // Get or create delivery record
      let record = this.deliveryRecords.get(update.messageId);

      if (!record) {
        record = this.createDeliveryRecord(update.messageId, update.recipientId);
      }

      // Update status based on previous state
      const previousStatus = record.status;
      record.status = update.status;

      // Update timestamps
      const now = Date.now();
      switch (update.status) {
        case 'sent':
          record.sentAt = now;
          this.metrics.sent++;
          break;
        case 'delivered':
          record.deliveredAt = now;
          this.metrics.delivered++;
          
          // Calculate delivery time
          if (record.sentAt) {
            const deliveryTime = now - record.sentAt;
            this.metrics.deliveryTimes.push(deliveryTime);
            
            appLogger.info('Message delivered', {
              messageId: update.messageId,
              deliveryTime,
            });
          }
          break;
        case 'read':
          record.readAt = now;
          this.metrics.read++;
          
          // Calculate read time
          if (record.sentAt) {
            const readTime = now - record.sentAt;
            this.metrics.readTimes.push(readTime);
            
            appLogger.info('Message read', {
              messageId: update.messageId,
              readTime,
            });
          }
          break;
        case 'failed':
          record.failedAt = now;
          this.metrics.failed++;
          
          // Store error details
          if (update.errors && update.errors.length > 0) {
            record.errors = update.errors.map((e) => `${e.code}: ${e.message}`);
            
            appLogger.warn('Message delivery failed', {
              messageId: update.messageId,
              errors: record.errors,
            });
          }
          break;
      }

      record.attempts++;
      this.metrics.totalProcessed++;

      // Update queue message if tracked
      await this.updateQueueMessage(update.messageId, record);

      appLogger.info('Status update processed', {
        messageId: update.messageId,
        previousStatus,
        newStatus: update.status,
        duration: Date.now() - startTime,
      });
    } catch (error) {
      appLogger.error('Failed to process status update', {
        messageId: update.messageId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Handle multiple status updates
   */
  public async handleStatusUpdateBatch(updates: WhatsAppStatusUpdate[]): Promise<void> {
    appLogger.debug('Processing status update batch', { count: updates.length });

    const promises = updates.map((update) => this.handleStatusUpdate(update));
    await Promise.allSettled(promises);

    appLogger.info('Status update batch processed', { count: updates.length });
  }

  // ==================== INCOMING MESSAGE HANDLING ====================

  /**
   * Process incoming WhatsApp message
   */
  public async handleIncomingMessage(message: IncomingWhatsAppMessage): Promise<void> {
    try {
      appLogger.info('Incoming WhatsApp message received', {
        from: message.from,
        messageId: message.messageId,
        type: message.type,
      });

      // Log message metadata
      if (message.text) {
        appLogger.debug('Message content', {
          from: message.from,
          content: message.text.body.substring(0, 100),
          contentLength: message.text.body.length,
        });
      }

      // TODO: Process incoming message
      // - Store in database if needed
      // - Route to appropriate handler based on type
      // - Send acknowledgment to WhatsApp
      // - Trigger any automated responses

      this.metrics.totalReceived++;
    } catch (error) {
      appLogger.error('Failed to process incoming message', {
        messageId: message.messageId,
        from: message.from,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Handle multiple incoming messages
   */
  public async handleIncomingMessageBatch(messages: IncomingWhatsAppMessage[]): Promise<void> {
    appLogger.debug('Processing incoming message batch', { count: messages.length });

    const promises = messages.map((msg) => this.handleIncomingMessage(msg));
    await Promise.allSettled(promises);

    appLogger.info('Incoming message batch processed', { count: messages.length });
  }

  // ==================== DELIVERY RECORD MANAGEMENT ====================

  /**
   * Create new delivery record
   */
  private createDeliveryRecord(
    messageId: string,
    recipientId?: string
  ): MessageDeliveryRecord {
    const record: MessageDeliveryRecord = {
      messageId,
      waMessageId: messageId,
      to: recipientId || 'unknown',
      status: 'sent',
      createdAt: Date.now(),
      attempts: 0,
    };

    this.deliveryRecords.set(messageId, record);
    return record;
  }

  /**
   * Get delivery record for a message
   */
  public getDeliveryRecord(messageId: string): MessageDeliveryRecord | undefined {
    return this.deliveryRecords.get(messageId);
  }

  /**
   * Register queue message for tracking
   */
  public registerQueueMessage(waMessageId: string, queueMessageId: string): void {
    this.waMessageIdToQueueId.set(waMessageId, queueMessageId);
    appLogger.debug('Queue message registered for tracking', {
      waMessageId,
      queueMessageId,
    });
  }

  /**
   * Update queue message with delivery status
   */
  private async updateQueueMessage(
    waMessageId: string,
    record: MessageDeliveryRecord
  ): Promise<void> {
    const queueMessageId = this.waMessageIdToQueueId.get(waMessageId);
    if (!queueMessageId) {
      return;
    }

    const queueMessage = messageQueue.getMessage(queueMessageId);
    if (!queueMessage) {
      return;
    }

    // Update queue message result
    queueMessage.result = {
      success: record.status !== 'failed',
      messageId: waMessageId,
      to: record.to,
      status: record.status,
      timestamp: Date.now(),
    };

    appLogger.debug('Queue message updated with delivery status', {
      queueMessageId,
      waMessageId,
      status: record.status,
    });
  }

  // ==================== DELIVERY TRACKING ====================

  /**
   * Track all delivery records
   */
  public getAllDeliveryRecords(): MessageDeliveryRecord[] {
    return Array.from(this.deliveryRecords.values());
  }

  /**
   * Get delivery records by status
   */
  public getRecordsByStatus(status: DeliveryStatus): MessageDeliveryRecord[] {
    return Array.from(this.deliveryRecords.values()).filter((r) => r.status === status);
  }

  /**
   * Get delivery records for recipient
   */
  public getRecordsByRecipient(recipientId: string): MessageDeliveryRecord[] {
    return Array.from(this.deliveryRecords.values()).filter((r) => r.to === recipientId);
  }

  /**
   * Get delivery record with full timeline
   */
  public getDeliveryTimeline(messageId: string): {
    record: MessageDeliveryRecord | undefined;
    timeline: Array<{ status: DeliveryStatus; timestamp: number }>;
  } {
    const record = this.deliveryRecords.get(messageId);
    const timeline: Array<{ status: DeliveryStatus; timestamp: number }> = [];

    if (!record) {
      return { record: undefined, timeline };
    }

    if (record.sentAt) {
      timeline.push({ status: 'sent', timestamp: record.sentAt });
    }
    if (record.deliveredAt) {
      timeline.push({ status: 'delivered', timestamp: record.deliveredAt });
    }
    if (record.readAt) {
      timeline.push({ status: 'read', timestamp: record.readAt });
    }
    if (record.failedAt) {
      timeline.push({ status: 'failed', timestamp: record.failedAt });
    }

    return { record, timeline };
  }

  // ==================== METRICS & ANALYTICS ====================

  /**
   * Get delivery metrics
   */
  public getMetrics(): DeliveryMetrics {
    const avgDeliveryTime =
      this.metrics.deliveryTimes.length > 0
        ? Math.round(
            this.metrics.deliveryTimes.reduce((a, b) => a + b, 0) /
              this.metrics.deliveryTimes.length
          )
        : 0;

    const avgReadTime =
      this.metrics.readTimes.length > 0
        ? Math.round(
            this.metrics.readTimes.reduce((a, b) => a + b, 0) / this.metrics.readTimes.length
          )
        : 0;

    return {
      totalReceived: this.metrics.totalReceived,
      totalProcessed: this.metrics.totalProcessed,
      sent: this.metrics.sent,
      delivered: this.metrics.delivered,
      read: this.metrics.read,
      failed: this.metrics.failed,
      averageDeliveryTime: avgDeliveryTime,
      averageReadTime: avgReadTime,
    };
  }

  /**
   * Get delivery success rate
   */
  public getSuccessRate(): number {
    const total = this.metrics.sent + this.metrics.failed;
    if (total === 0) return 0;
    return Math.round(
      ((this.metrics.sent + this.metrics.delivered) / total) * 100
    );
  }

  /**
   * Get failed messages for analysis
   */
  public getFailedMessages(limit: number = 100): MessageDeliveryRecord[] {
    return this.getRecordsByStatus('failed').slice(0, limit);
  }

  /**
   * Clean up old delivery records
   */
  public cleanupOldRecords(olderThanMs: number = 7 * 24 * 60 * 60 * 1000): number {
    const now = Date.now();
    let removed = 0;

    for (const [messageId, record] of this.deliveryRecords.entries()) {
      if (now - record.createdAt > olderThanMs) {
        this.deliveryRecords.delete(messageId);
        this.waMessageIdToQueueId.delete(messageId);
        removed++;
      }
    }

    if (removed > 0) {
      appLogger.info('Old delivery records cleaned up', { count: removed });
    }

    return removed;
  }

  /**
   * Reset metrics
   */
  public resetMetrics(): void {
    this.metrics = {
      totalReceived: 0,
      totalProcessed: 0,
      sent: 0,
      delivered: 0,
      read: 0,
      failed: 0,
      deliveryTimes: [],
      readTimes: [],
    };

    appLogger.info('Webhook handler metrics reset');
  }

  /**
   * Get handler statistics
   */
  public getStatistics(): {
    totalRecords: number;
    recordsByStatus: Record<DeliveryStatus, number>;
    metrics: DeliveryMetrics;
    successRate: number;
  } {
    const recordsByStatus: Record<DeliveryStatus, number> = {
      sent: this.metrics.sent,
      delivered: this.metrics.delivered,
      read: this.metrics.read,
      failed: this.metrics.failed,
    };

    return {
      totalRecords: this.deliveryRecords.size,
      recordsByStatus,
      metrics: this.getMetrics(),
      successRate: this.getSuccessRate(),
    };
  }
}

// ============================================================================
// SINGLETON INSTANCE
// ============================================================================

let instance: WebhookHandlerService | null = null;

export function getWebhookHandler(): WebhookHandlerService {
  if (!instance) {
    instance = new WebhookHandlerService();
  }
  return instance;
}

export const webhookHandler = getWebhookHandler();
