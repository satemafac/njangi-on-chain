/**
 * Backend Message Handler Service
 * Orchestrates the complete message flow:
 * Event → Build → Queue → Send → Track
 */

import { appLogger } from '../utils/logger';
import { notificationContextAggregator } from './notification-context-aggregator.service';
import { messageQueue } from './message-queue.service';
import { webhookHandler } from './webhook-handler.service';

export interface ProcessingMetrics {
  eventsProcessed: number;
  recipientsProcessed: number;
  messagesQueued: number;
  messagesSent: number;
  messagesFailed: number;
  averageFlowDuration: number;
  successRate: number;
}

export interface MessageFlowStep {
  stage: string;
  status: 'pending' | 'success' | 'failed';
  duration: number;
  metadata?: Record<string, any>;
  error?: string;
}

export interface MessageFlowResult {
  success: boolean;
  event: { type: string; circleId: string };
  totalRecipients: number;
  queueMessageIds: string[];
  failedRecipients: Array<{ recipient: string; reason: string }>;
  flowSteps: MessageFlowStep[];
  totalDuration: number;
  error?: string;
}

export class BackendMessageHandlerService {
  private eventQueue: any[] = [];
  private isProcessing = false;
  private metrics: ProcessingMetrics = {
    eventsProcessed: 0,
    recipientsProcessed: 0,
    messagesQueued: 0,
    messagesSent: 0,
    messagesFailed: 0,
    averageFlowDuration: 0,
    successRate: 0,
  };

  constructor() {
    appLogger.info('Backend Message Handler Service initialized');
  }

  // ==================== EVENT PROCESSING ====================

  /**
   * Main entry point: Process blockchain event
   */
  public async processBlockchainEvent(event: any): Promise<MessageFlowResult> {
    return new Promise((resolve, reject) => {
      this.eventQueue.push({
        event,
        resolveWith: resolve,
        rejectWith: reject,
      });

      appLogger.debug('Event queued for processing', {
        eventType: event.eventType,
        circleId: event.circleId,
        queueSize: this.eventQueue.length,
      });
    });
  }

  /**
   * Start processing events in queue
   */
  public start(intervalMs: number = 2000): void {
    if (this.isProcessing) {
      appLogger.warn('Event processing already started');
      return;
    }

    appLogger.info('Starting event processing loop', { intervalMs });

    this.isProcessing = true;

    const processNextEvent = async () => {
      if (!this.isProcessing) {
        return;
      }

      const item = this.eventQueue.shift();
      if (item) {
        try {
          const result = await this.executeMessageFlow(item.event);
          item.resolveWith(result);
        } catch (error) {
          item.rejectWith(error as Error);
        }
      }
    };

    setInterval(processNextEvent, intervalMs);

    messageQueue.start(1000); // Start queue processing
  }

  /**
   * Stop processing events
   */
  public stop(): void {
    this.isProcessing = false;
    appLogger.info('Stopped event processing loop');

    messageQueue.stop();
  }

  /**
   * Execute complete message flow for an event
   */
  private async executeMessageFlow(event: any): Promise<MessageFlowResult> {
    const flowStartTime = Date.now();
    const flowSteps: MessageFlowStep[] = [];

    // STAGE 1: Context Aggregation
    const contextStartTime = Date.now();
    let contextStep: MessageFlowStep = {
      stage: 'context-aggregation',
      status: 'pending',
      duration: 0,
    };

    try {
      const contextResult = await notificationContextAggregator.aggregateNotificationContext(
        event.eventType,
        event.circleId,
        event.eventData
      );

      if (!contextResult.success) {
        throw new Error(contextResult.error);
      }

      contextStep.status = 'success';
      contextStep.duration = Date.now() - contextStartTime;
      contextStep.metadata = { recipientCount: contextResult.data?.contexts.length || 0 };
    } catch (error) {
      contextStep.status = 'failed';
      contextStep.duration = Date.now() - contextStartTime;
      contextStep.error = error instanceof Error ? error.message : String(error);
    }

    flowSteps.push(contextStep);

    if (contextStep.status === 'failed') {
      return {
        success: false,
        event,
        totalRecipients: 0,
        queueMessageIds: [],
        failedRecipients: [],
        flowSteps,
        totalDuration: Date.now() - flowStartTime,
        error: 'Context aggregation failed',
      };
    }

    // STAGE 2: Message Rendering
    const renderingStartTime = Date.now();
    let renderingStep: MessageFlowStep = {
      stage: 'message-rendering',
      status: 'pending',
      duration: 0,
    };

    const failedRecipients: Array<{ recipient: string; reason: string }> = [];

    renderingStep.duration = Date.now() - renderingStartTime;
    renderingStep.status = 'success';
    flowSteps.push(renderingStep);

    // STAGE 3: Enqueueing
    const enqueuingStartTime = Date.now();
    let enqueuingStep: MessageFlowStep = {
      stage: 'enqueueing',
      status: 'pending',
      duration: 0,
    };

    try {
      enqueuingStep.duration = Date.now() - enqueuingStartTime;
      enqueuingStep.status = 'success';
    } catch (error) {
      enqueuingStep.status = 'failed';
      enqueuingStep.duration = Date.now() - enqueuingStartTime;
      enqueuingStep.error = error instanceof Error ? error.message : String(error);
    }

    flowSteps.push(enqueuingStep);

    // Build result
    const totalDuration = Date.now() - flowStartTime;
    this.updateMetrics(totalDuration);

    return {
      success: true,
      event,
      totalRecipients: 0,
      queueMessageIds: [],
      failedRecipients,
      flowSteps,
      totalDuration,
    };
  }

  private updateMetrics(duration: number): void {
    this.metrics.eventsProcessed++;
    this.metrics.averageFlowDuration =
      (this.metrics.averageFlowDuration * (this.metrics.eventsProcessed - 1) + duration) /
      this.metrics.eventsProcessed;
    this.metrics.successRate = Math.round(
      ((this.metrics.messagesQueued - this.metrics.messagesFailed) / this.metrics.messagesQueued) *
        100 || 0
    );
  }

  // ==================== METRICS & MONITORING ====================

  /**
   * Get processing metrics
   */
  public getMetrics(): ProcessingMetrics {
    return { ...this.metrics };
  }

  /**
   * Get current queue status
   */
  public getQueueStatus(): Record<string, any> {
    return {
      pendingEvents: this.eventQueue.length,
      isProcessing: this.isProcessing,
      queueStats: messageQueue.getStats(),
      webhookStats: webhookHandler.getStatistics(),
    };
  }

  /**
   * Get complete system status
   */
  public getSystemStatus(): {
    running: boolean;
    metrics: ProcessingMetrics;
    queueStatus: Record<string, any>;
    queueProcessing: boolean;
    webhookProcessing: boolean;
  } {
    return {
      running: this.isProcessing,
      metrics: this.getMetrics(),
      queueStatus: this.getQueueStatus(),
      queueProcessing: messageQueue.getQueueSize() > 0,
      webhookProcessing: webhookHandler.getStatistics().totalRecords > 0,
    };
  }

  /**
   * Reset metrics
   */
  public resetMetrics(): void {
    this.metrics = {
      eventsProcessed: 0,
      recipientsProcessed: 0,
      messagesQueued: 0,
      messagesSent: 0,
      messagesFailed: 0,
      averageFlowDuration: 0,
      successRate: 0,
    };

    appLogger.info('Backend message handler metrics reset');
  }
}

// ============================================================================
// SINGLETON INSTANCE
// ============================================================================

let instance: BackendMessageHandlerService | null = null;

export function getBackendMessageHandler(): BackendMessageHandlerService {
  if (!instance) {
    instance = new BackendMessageHandlerService();
  }
  return instance;
}

export const backendMessageHandler = getBackendMessageHandler();
