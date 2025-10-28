/**
 * Message Queue Service
 * Reliable message delivery with retry logic, prioritization, and backpressure handling
 */

import { appLogger } from '../utils/logger';
import { whatsappSender, SendMessageRequest, SendResult } from './whatsapp-sender.service';

// ============================================================================
// TYPES & INTERFACES
// ============================================================================

export type MessagePriority = 'high' | 'normal' | 'low';
export type MessageStatus = 'pending' | 'processing' | 'sent' | 'failed' | 'expired';

export interface QueuedMessage {
  id: string;
  request: SendMessageRequest;
  priority: MessagePriority;
  status: MessageStatus;
  createdAt: number;
  expiresAt: number;
  attempts: number;
  maxAttempts: number;
  nextRetryAt: number;
  lastError?: string;
  result?: SendResult;
}

export interface QueueStats {
  pending: number;
  processing: number;
  sent: number;
  failed: number;
  expired: number;
  totalQueued: number;
  totalProcessed: number;
  averageRetries: number;
  successRate: number;
}

export interface QueueConfig {
  maxQueueSize: number;
  maxConcurrent: number;
  messageTimeout: number; // ms
  retryDelay: number; // ms
  maxRetries: number;
  backoffMultiplier: number;
  enablePersistence: boolean;
  persistencePath?: string;
}

// ============================================================================
// DEFAULT CONFIGURATION
// ============================================================================

const DEFAULT_CONFIG: QueueConfig = {
  maxQueueSize: 10000,
  maxConcurrent: 10,
  messageTimeout: 24 * 60 * 60 * 1000, // 24 hours
  retryDelay: 5000, // 5 seconds
  maxRetries: 5,
  backoffMultiplier: 2,
  enablePersistence: false,
};

// ============================================================================
// MESSAGE QUEUE SERVICE
// ============================================================================

export class MessageQueueService {
  private queue: Map<string, QueuedMessage> = new Map();
  private priorityQueue: string[] = []; // IDs ordered by priority
  private processing: Set<string> = new Set();
  private config: QueueConfig;

  private stats = {
    totalQueued: 0,
    totalProcessed: 0,
    totalSent: 0,
    totalFailed: 0,
    totalExpired: 0,
  };

  private processingInterval: NodeJS.Timeout | null = null;
  private persistenceInterval: NodeJS.Timeout | null = null;

  constructor(config: Partial<QueueConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    appLogger.info('Message Queue Service initialized', {
      maxQueueSize: this.config.maxQueueSize,
      maxConcurrent: this.config.maxConcurrent,
      maxRetries: this.config.maxRetries,
      enablePersistence: this.config.enablePersistence,
    });
  }

  // ==================== QUEUE MANAGEMENT ====================

  /**
   * Add a message to the queue
   */
  public async enqueue(
    request: SendMessageRequest,
    priority: MessagePriority = 'normal',
    maxAttempts: number = this.config.maxRetries
  ): Promise<QueuedMessage> {
    // Check queue size
    if (this.queue.size >= this.config.maxQueueSize) {
      throw new Error(`Queue is full. Max size: ${this.config.maxQueueSize}`);
    }

    const messageId = this.generateMessageId();
    const now = Date.now();

    const queuedMessage: QueuedMessage = {
      id: messageId,
      request,
      priority,
      status: 'pending',
      createdAt: now,
      expiresAt: now + this.config.messageTimeout,
      attempts: 0,
      maxAttempts,
      nextRetryAt: now,
    };

    this.queue.set(messageId, queuedMessage);
    this.priorityQueue.push(messageId);
    this.stats.totalQueued++;

    appLogger.debug('Message enqueued', {
      messageId,
      to: request.to,
      priority,
      queueSize: this.queue.size,
    });

    return queuedMessage;
  }

  /**
   * Enqueue multiple messages
   */
  public async enqueueBatch(
    requests: Array<{ request: SendMessageRequest; priority?: MessagePriority }>
  ): Promise<QueuedMessage[]> {
    const messages: QueuedMessage[] = [];

    for (const item of requests) {
      try {
        const message = await this.enqueue(item.request, item.priority || 'normal');
        messages.push(message);
      } catch (error) {
        appLogger.error('Failed to enqueue batch item', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    appLogger.info('Batch enqueued', { count: messages.length });
    return messages;
  }

  /**
   * Get a specific queued message
   */
  public getMessage(messageId: string): QueuedMessage | undefined {
    return this.queue.get(messageId);
  }

  /**
   * Remove a message from queue
   */
  public removeMessage(messageId: string): boolean {
    const removed = this.queue.delete(messageId);
    if (removed) {
      this.priorityQueue = this.priorityQueue.filter((id) => id !== messageId);
      appLogger.debug('Message removed from queue', { messageId });
    }
    return removed;
  }

  // ==================== PROCESSING ====================

  /**
   * Start processing queue
   */
  public start(intervalMs: number = 1000): void {
    if (this.processingInterval) {
      appLogger.warn('Queue processing already started');
      return;
    }

    appLogger.info('Starting message queue processing', { intervalMs });

    this.processingInterval = setInterval(async () => {
      await this.processQueue();
    }, intervalMs);

    // Start persistence if enabled
    if (this.config.enablePersistence) {
      this.persistenceInterval = setInterval(async () => {
        await this.persistQueue();
      }, 60000); // Every minute
    }
  }

  /**
   * Stop processing queue
   */
  public stop(): void {
    if (this.processingInterval) {
      clearInterval(this.processingInterval);
      this.processingInterval = null;
      appLogger.info('Stopped message queue processing');
    }

    if (this.persistenceInterval) {
      clearInterval(this.persistenceInterval);
      this.persistenceInterval = null;
    }
  }

  /**
   * Process queue - main processing loop
   */
  private async processQueue(): Promise<void> {
    // Check for expired messages
    this.cleanExpiredMessages();

    // Check backpressure
    if (this.processing.size >= this.config.maxConcurrent) {
      return;
    }

    // Get next message from priority queue
    const messageId = this.getNextMessage();
    if (!messageId) {
      return;
    }

    const message = this.queue.get(messageId);
    if (!message) {
      return;
    }

    // Check if ready to retry
    if (message.nextRetryAt > Date.now()) {
      return;
    }

    // Process the message
    await this.processMessage(message);
  }

  /**
   * Process a single message
   */
  private async processMessage(message: QueuedMessage): Promise<void> {
    if (this.processing.has(message.id)) {
      return; // Already processing
    }

    try {
      this.processing.add(message.id);
      message.status = 'processing';
      message.attempts++;

      appLogger.debug('Processing message', {
        messageId: message.id,
        attempt: message.attempts,
        maxAttempts: message.maxAttempts,
      });

      // Send message
      const result = await whatsappSender.sendMessage(message.request);

      // Handle result
      if (result.success) {
        message.status = 'sent';
        message.result = result;
        this.stats.totalSent++;

        appLogger.info('Message sent successfully', {
          queueMessageId: message.id,
          to: message.request.to,
          whatsappMessageId: result.messageId,
        });

        // Keep in queue for a bit (for tracking), then remove
        setTimeout(() => {
          this.removeMessage(message.id);
        }, 5000);
      } else {
        // Handle failure
        message.lastError = result.error;

        if (message.attempts >= message.maxAttempts) {
          // Max retries exceeded
          message.status = 'failed';
          this.stats.totalFailed++;

          appLogger.warn('Message delivery failed - max retries exceeded', {
            messageId: message.id,
            to: message.request.to,
            attempts: message.attempts,
            error: result.error,
          });

          // Remove after delay
          setTimeout(() => {
            this.removeMessage(message.id);
          }, 60000);
        } else {
          // Schedule retry
          message.status = 'pending';
          const delayMs = this.calculateBackoff(message.attempts);
          message.nextRetryAt = Date.now() + delayMs;

          appLogger.debug('Message scheduled for retry', {
            messageId: message.id,
            attempt: message.attempts,
            retryAt: new Date(message.nextRetryAt),
            error: result.error,
          });
        }
      }
    } catch (error) {
      message.lastError = error instanceof Error ? error.message : String(error);
      message.status = 'pending';

      if (message.attempts >= message.maxAttempts) {
        message.status = 'failed';
        this.stats.totalFailed++;
      } else {
        const delayMs = this.calculateBackoff(message.attempts);
        message.nextRetryAt = Date.now() + delayMs;
      }

      appLogger.error('Error processing message', {
        messageId: message.id,
        error: message.lastError,
      });
    } finally {
      this.processing.delete(message.id);
      this.stats.totalProcessed++;
    }
  }

  // ==================== UTILITY METHODS ====================

  /**
   * Get next message from priority queue
   */
  private getNextMessage(): string | undefined {
    // Sort by priority and retry time
    const pendingMessages = Array.from(this.queue.values())
      .filter(
        (m) =>
          m.status === 'pending' &&
          !this.processing.has(m.id) &&
          m.nextRetryAt <= Date.now() &&
          m.expiresAt > Date.now()
      )
      .sort((a, b) => {
        // Priority: high > normal > low
        const priorityOrder = { high: 0, normal: 1, low: 2 };
        const priorityDiff = priorityOrder[a.priority] - priorityOrder[b.priority];
        if (priorityDiff !== 0) return priorityDiff;

        // Then by retry time
        return a.nextRetryAt - b.nextRetryAt;
      });

    return pendingMessages[0]?.id;
  }

  /**
   * Clean expired messages
   */
  private cleanExpiredMessages(): void {
    const now = Date.now();
    const expiredIds: string[] = [];

    for (const [id, message] of this.queue.entries()) {
      if (message.expiresAt < now && message.status !== 'sent') {
        message.status = 'expired';
        this.stats.totalExpired++;
        expiredIds.push(id);

        appLogger.warn('Message expired', {
          messageId: id,
          age: now - message.createdAt,
        });
      }
    }

    // Remove expired messages
    expiredIds.forEach((id) => {
      this.queue.delete(id);
      this.priorityQueue = this.priorityQueue.filter((mid) => mid !== id);
    });
  }

  /**
   * Calculate exponential backoff
   */
  private calculateBackoff(attemptNumber: number): number {
    const exponent = Math.min(attemptNumber - 1, 5); // Cap at 2^5 = 32x
    const multiplier = Math.pow(this.config.backoffMultiplier, exponent);
    const delayMs = this.config.retryDelay * multiplier;

    // Add jitter (±10%)
    const jitter = delayMs * 0.1 * (Math.random() * 2 - 1);
    return Math.max(this.config.retryDelay, delayMs + jitter);
  }

  /**
   * Generate unique message ID
   */
  private generateMessageId(): string {
    return `msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }

  /**
   * Persist queue to storage (if enabled)
   */
  private async persistQueue(): Promise<void> {
    if (!this.config.enablePersistence || !this.config.persistencePath) {
      return;
    }

    try {
      const messages = Array.from(this.queue.values());
      appLogger.debug('Persisting queue', {
        count: messages.length,
        path: this.config.persistencePath,
      });

      // TODO: Implement persistence logic (file, database, etc.)
    } catch (error) {
      appLogger.error('Failed to persist queue', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ==================== STATISTICS ====================

  /**
   * Get queue statistics
   */
  public getStats(): QueueStats {
    let pending = 0;
    let processing = 0;
    let sent = 0;
    let failed = 0;
    let expired = 0;

    for (const message of this.queue.values()) {
      switch (message.status) {
        case 'pending':
          pending++;
          break;
        case 'processing':
          processing++;
          break;
        case 'sent':
          sent++;
          break;
        case 'failed':
          failed++;
          break;
        case 'expired':
          expired++;
          break;
      }
    }

    const totalAttempts = Array.from(this.queue.values()).reduce(
      (sum, m) => sum + m.attempts,
      0
    );
    const messageCount = this.queue.size;
    const avgRetries = messageCount > 0 ? totalAttempts / messageCount : 0;

    const totalProcessed = this.stats.totalSent + this.stats.totalFailed;
    const successRate =
      totalProcessed > 0 ? Math.round((this.stats.totalSent / totalProcessed) * 100) : 0;

    return {
      pending,
      processing,
      sent,
      failed,
      expired,
      totalQueued: this.stats.totalQueued,
      totalProcessed: this.stats.totalProcessed,
      averageRetries: Math.round(avgRetries * 100) / 100,
      successRate,
    };
  }

  /**
   * Reset statistics
   */
  public resetStats(): void {
    this.stats = {
      totalQueued: 0,
      totalProcessed: 0,
      totalSent: 0,
      totalFailed: 0,
      totalExpired: 0,
    };

    appLogger.info('Queue statistics reset');
  }

  /**
   * Get queue size
   */
  public getQueueSize(): number {
    return this.queue.size;
  }

  /**
   * Clear queue (careful!)
   */
  public clearQueue(): number {
    const size = this.queue.size;
    this.queue.clear();
    this.priorityQueue = [];
    this.processing.clear();

    appLogger.warn('Queue cleared', { messagesRemoved: size });
    return size;
  }
}

// ============================================================================
// SINGLETON INSTANCE
// ============================================================================

let instance: MessageQueueService | null = null;

export function getMessageQueue(config?: Partial<QueueConfig>): MessageQueueService {
  if (!instance) {
    instance = new MessageQueueService(config);
  }
  return instance;
}

export const messageQueue = getMessageQueue();
