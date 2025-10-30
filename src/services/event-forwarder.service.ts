/**
 * Event Forwarder Service
 * Handles reliable delivery of blockchain events to backend services
 * with queue-based forwarding, retry logic, and acknowledgment
 */

// Simple logger for this service
const appLogger = {
  info: (msg: string, data?: unknown) => console.log(`[INFO] ${msg}`, data),
  warn: (msg: string, data?: unknown) => console.warn(`[WARN] ${msg}`, data),
  error: (msg: string, data?: unknown) => console.error(`[ERROR] ${msg}`, data),
  debug: (msg: string, data?: unknown) => console.debug(`[DEBUG] ${msg}`, data),
};

import { ParsedBlockchainEvent } from '../utils/sui-event-types';

/**
 * Forward attempt record
 */
interface ForwardAttempt {
  eventId: string;
  endpoint: string;
  timestamp: number;
  success: boolean;
  statusCode?: number;
  errorMessage?: string;
  retryCount: number;
}

/**
 * Queued event
 */
interface QueuedEvent {
  id: string;
  event: ParsedBlockchainEvent;
  endpoint: string;
  retryCount: number;
  lastAttempt?: number;
  createdAt: number;
  attempts: ForwardAttempt[];
}

/**
 * Forward result
 */
interface ForwardResult {
  success: boolean;
  eventId: string;
  endpoint: string;
  statusCode?: number;
  error?: string;
  retryCount: number;
  message: string;
}

export class EventForwarderService {
  private queue: Map<string, QueuedEvent> = new Map();
  private maxRetries = 5;
  private retryDelayMs = 1000; // Start with 1s, exponential backoff
  private maxRetryDelayMs = 60000; // Max 60s between retries
  private batchSize = 10;
  private processingTimer?: NodeJS.Timeout;
  private isProcessing = false;
  private forwardAttempts: ForwardAttempt[] = [];
  private maxAttemptHistory = 10000; // Keep last 10k attempts

  // Endpoint configurations
  private endpoints: Map<
    string,
    {
      url: string;
      timeout: number;
      authToken?: string;
      headers?: Record<string, string>;
    }
  > = new Map();

  constructor(private pollingIntervalMs = 2000) {
    this.initializeDefaultEndpoints();
  }

  /**
   * Initialize default backend endpoints
   */
  private initializeDefaultEndpoints(): void {
    // WhatsApp notification endpoint
    this.registerEndpoint('whatsapp-notification', {
      url: process.env.WHATSAPP_BACKEND_URL || 'http://localhost:3001/api/events/whatsapp',
      timeout: 30000,
      authToken: process.env.BACKEND_AUTH_TOKEN,
    });

    // Circle update endpoint
    this.registerEndpoint('circle-update', {
      url: process.env.CIRCLE_BACKEND_URL || 'http://localhost:3001/api/events/circle',
      timeout: 30000,
      authToken: process.env.BACKEND_AUTH_TOKEN,
    });

    // Analytics endpoint
    this.registerEndpoint('analytics', {
      url: process.env.ANALYTICS_URL || 'http://localhost:3001/api/events/analytics',
      timeout: 30000,
      authToken: process.env.BACKEND_AUTH_TOKEN,
    });

    appLogger.info('Event forwarder initialized with endpoints', {
      endpoints: Array.from(this.endpoints.keys()),
    });
  }

  /**
   * Register a backend endpoint
   */
  public registerEndpoint(
    name: string,
    config: {
      url: string;
      timeout: number;
      authToken?: string;
      headers?: Record<string, string>;
    }
  ): void {
    this.endpoints.set(name, config);
    appLogger.info(`Registered endpoint: ${name}`, { url: config.url });
  }

  /**
   * Queue an event for forwarding
   */
  public async queueEvent(
    event: ParsedBlockchainEvent,
    endpoint?: string
  ): Promise<void> {
    const targetEndpoint = endpoint || this.getEndpointForEvent(event);

    const eventId = `${event.txDigest}:${event.type}`;
    const queuedEvent: QueuedEvent = {
      id: eventId,
      event,
      endpoint: targetEndpoint,
      retryCount: 0,
      createdAt: Date.now(),
      attempts: [],
    };

    this.queue.set(eventId, queuedEvent);

    appLogger.debug('Event queued for forwarding', {
      eventId,
      endpoint: targetEndpoint,
      eventType: event.type,
    });
  }

  /**
   * Queue multiple events
   */
  public async queueEvents(
    events: ParsedBlockchainEvent[],
    endpoint?: string
  ): Promise<void> {
    for (const event of events) {
      await this.queueEvent(event, endpoint);
    }
  }

  /**
   * Determine target endpoint based on event type
   */
  private getEndpointForEvent(event: ParsedBlockchainEvent): string {
    // Route events to appropriate endpoints
    switch (event.type) {
      case 'NotificationSent':
      case 'PayoutReminderEvent':
      case 'NewCycleStartedEvent':
      case 'MemberContributedEvent':
        return 'whatsapp-notification';

      case 'AllMembersContributedEvent':
      case 'PayoutOverdueEvent':
        return 'circle-update';

      case 'DeadlineApproachingEvent':
      case 'ContributorOverdueEvent':
        return 'analytics';

      default:
        return 'whatsapp-notification';
    }
  }

  /**
   * Start processing the queue
   */
  public start(): void {
    if (this.processingTimer) {
      appLogger.warn('Event forwarder already running');
      return;
    }

    appLogger.info('Starting event forwarder', { pollingInterval: this.pollingIntervalMs });

    this.processingTimer = setInterval(() => {
      this.processQueue().catch((error) => {
        appLogger.error('Error processing forward queue', { error: error.message });
      });
    }, this.pollingIntervalMs);

    // Process immediately
    this.processQueue().catch((error) => {
      appLogger.error('Error in initial queue processing', { error: error.message });
    });
  }

  /**
   * Stop processing the queue
   */
  public stop(): void {
    if (this.processingTimer) {
      clearInterval(this.processingTimer);
      this.processingTimer = undefined;
      appLogger.info('Event forwarder stopped');
    }
  }

  /**
   * Process queued events
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessing || this.queue.size === 0) {
      return;
    }

    this.isProcessing = true;

    try {
      const now = Date.now();
      const itemsToProcess: QueuedEvent[] = [];

      // Get items ready to forward
      for (const [_, queuedEvent] of this.queue) {
        // Skip if retry delay not elapsed
        if (queuedEvent.lastAttempt) {
          const delayMs = this.calculateBackoffDelay(queuedEvent.retryCount);
          if (now - queuedEvent.lastAttempt < delayMs) {
            continue;
          }
        }

        itemsToProcess.push(queuedEvent);

        if (itemsToProcess.length >= this.batchSize) {
          break;
        }
      }

      // Process batch
      for (const queuedEvent of itemsToProcess) {
        const result = await this.forwardEvent(queuedEvent);

        if (result.success) {
          // Remove from queue on success
          this.queue.delete(queuedEvent.id);
          appLogger.info(`Event forwarded successfully`, {
            eventId: queuedEvent.id,
            endpoint: result.endpoint,
          });
        } else {
          // Update retry count
          queuedEvent.retryCount++;
          queuedEvent.lastAttempt = now;

          if (queuedEvent.retryCount >= this.maxRetries) {
            // Max retries exceeded
            appLogger.error(`Max retries exceeded for event`, {
              eventId: queuedEvent.id,
              retries: queuedEvent.retryCount,
              lastError: result.error,
            });
            this.queue.delete(queuedEvent.id);
          } else {
            appLogger.warn(`Event forward failed, will retry`, {
              eventId: queuedEvent.id,
              attempt: queuedEvent.retryCount,
              nextRetryIn: this.calculateBackoffDelay(queuedEvent.retryCount),
              error: result.error,
            });
          }
        }
      }
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Forward a single event to its endpoint
   */
  private async forwardEvent(queuedEvent: QueuedEvent): Promise<ForwardResult> {
    const endpoint = this.endpoints.get(queuedEvent.endpoint);

    if (!endpoint) {
      return {
        success: false,
        eventId: queuedEvent.id,
        endpoint: queuedEvent.endpoint,
        error: `Unknown endpoint: ${queuedEvent.endpoint}`,
        retryCount: queuedEvent.retryCount,
        message: 'Endpoint not configured',
      };
    }

    const attempt: ForwardAttempt = {
      eventId: queuedEvent.id,
      endpoint: queuedEvent.endpoint,
      timestamp: Date.now(),
      success: false,
      retryCount: queuedEvent.retryCount,
    };

    try {
      const response = await this.makeRequest(
        endpoint.url,
        queuedEvent.event,
        endpoint.timeout,
        endpoint.authToken,
        endpoint.headers
      );

      attempt.success = response.ok;
      attempt.statusCode = response.status;

      queuedEvent.attempts.push(attempt);
      this.recordAttempt(attempt);

      if (response.ok) {
        return {
          success: true,
          eventId: queuedEvent.id,
          endpoint: queuedEvent.endpoint,
          statusCode: response.status,
          retryCount: queuedEvent.retryCount,
          message: 'Event forwarded successfully',
        };
      } else {
        const errorText = await response.text();
        return {
          success: false,
          eventId: queuedEvent.id,
          endpoint: queuedEvent.endpoint,
          statusCode: response.status,
          error: `HTTP ${response.status}: ${errorText}`,
          retryCount: queuedEvent.retryCount,
          message: 'Endpoint returned error',
        };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      attempt.errorMessage = errorMessage;
      attempt.success = false;

      queuedEvent.attempts.push(attempt);
      this.recordAttempt(attempt);

      return {
        success: false,
        eventId: queuedEvent.id,
        endpoint: queuedEvent.endpoint,
        error: errorMessage,
        retryCount: queuedEvent.retryCount,
        message: 'Request failed',
      };
    }
  }

  /**
   * Make HTTP request to endpoint
   */
  private async makeRequest(
    url: string,
    event: ParsedBlockchainEvent,
    timeout: number,
    authToken?: string,
    additionalHeaders?: Record<string, string>
  ): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-Event-Type': event.type,
        'X-Event-ID': `${event.txDigest}:${event.type}`,
        'X-Timestamp': String(event.timestamp),
        ...additionalHeaders,
      };

      if (authToken) {
        headers['Authorization'] = `Bearer ${authToken}`;
      }

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(event),
        signal: controller.signal,
      });

      return response;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Calculate exponential backoff delay
   */
  private calculateBackoffDelay(retryCount: number): number {
    const exponentialDelay = this.retryDelayMs * Math.pow(2, retryCount);
    return Math.min(exponentialDelay, this.maxRetryDelayMs);
  }

  /**
   * Record forward attempt for monitoring
   */
  private recordAttempt(attempt: ForwardAttempt): void {
    this.forwardAttempts.push(attempt);
    if (this.forwardAttempts.length > this.maxAttemptHistory) {
      this.forwardAttempts = this.forwardAttempts.slice(-this.maxAttemptHistory);
    }
  }

  /**
   * Get queue status
   */
  public getStatus(): {
    queueSize: number;
    pendingEvents: number;
    processingStats: {
      totalAttempts: number;
      successfulForwards: number;
      failedAttempts: number;
      averageRetries: number;
    };
    endpoints: string[];
  } {
    const attempts = this.forwardAttempts;
    const successful = attempts.filter((a) => a.success).length;
    const failed = attempts.length - successful;
    const totalRetries = attempts.reduce((sum, a) => sum + a.retryCount, 0);

    return {
      queueSize: this.queue.size,
      pendingEvents: this.queue.size,
      processingStats: {
        totalAttempts: attempts.length,
        successfulForwards: successful,
        failedAttempts: failed,
        averageRetries: attempts.length > 0 ? totalRetries / attempts.length : 0,
      },
      endpoints: Array.from(this.endpoints.keys()),
    };
  }

  /**
   * Get recent attempts (for monitoring)
   */
  public getRecentAttempts(limit = 100): ForwardAttempt[] {
    return this.forwardAttempts.slice(-limit);
  }

  /**
   * Get queued events
   */
  public getQueuedEvents(): QueuedEvent[] {
    return Array.from(this.queue.values());
  }

  /**
   * Manually retry a failed event
   */
  public retryEvent(eventId: string): boolean {
    const queuedEvent = this.queue.get(eventId);
    if (!queuedEvent) {
      return false;
    }

    queuedEvent.retryCount = 0;
    queuedEvent.lastAttempt = undefined;
    appLogger.info(`Manually retrying event`, { eventId });
    return true;
  }

  /**
   * Remove event from queue
   */
  public removeEvent(eventId: string): boolean {
    const removed = this.queue.delete(eventId);
    if (removed) {
      appLogger.info(`Removed event from queue`, { eventId });
    }
    return removed;
  }

  /**
   * Clear the entire queue
   */
  public clearQueue(): number {
    const size = this.queue.size;
    this.queue.clear();
    appLogger.warn(`Cleared event forwarder queue`, { removedCount: size });
    return size;
  }

  /**
   * Set configuration
   */
  public configure(config: {
    maxRetries?: number;
    retryDelayMs?: number;
    maxRetryDelayMs?: number;
    batchSize?: number;
  }): void {
    if (config.maxRetries !== undefined) this.maxRetries = config.maxRetries;
    if (config.retryDelayMs !== undefined) this.retryDelayMs = config.retryDelayMs;
    if (config.maxRetryDelayMs !== undefined) this.maxRetryDelayMs = config.maxRetryDelayMs;
    if (config.batchSize !== undefined) this.batchSize = config.batchSize;

    appLogger.info('Event forwarder configuration updated', config);
  }

  /**
   * Cleanup
   */
  public destroy(): void {
    this.stop();
    this.queue.clear();
    this.forwardAttempts = [];
    appLogger.info('Event forwarder destroyed');
  }
}
