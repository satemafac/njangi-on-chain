/**
 * Sui Event Listener Service
 * Main service for listening to Sui blockchain events
 */

import { appLogger } from '../utils/logger';
import {
  EventSubscriptionConfig,
  EVENT_TYPES,
  SuiEvent,
  EventHandler,
  ParsedBlockchainEvent,
  EventFilterCriteria,
} from '../utils/sui-event-types';
import { getRpcPool, SuiRpcPoolService } from './sui-rpc-pool.service';
import { SuiEventParserService } from './sui-event-parser.service';

export class SuiEventListenerService {
  private rpcPool: SuiRpcPoolService;
  private parserService: SuiEventParserService;
  private isListening = false;
  private listeningTimer?: NodeJS.Timeout;
  private eventHandlers: Map<string, EventHandler[]> = new Map();
  private pollingIntervalMs = 3000; // 3 seconds
  private lastProcessedCursor: Map<string, string | null> = new Map();
  private eventBuffer: ParsedBlockchainEvent[] = [];
  private maxBufferSize = 1000;

  constructor(
    private packageId: string,
    private network: 'testnet' | 'mainnet',
    private maxEventsPerQuery: number = 100
  ) {
    this.rpcPool = getRpcPool();
    this.parserService = new SuiEventParserService(this.packageId);
    this.initializeEventTypes();
  }

  /**
   * Initialize event type tracking
   */
  private initializeEventTypes(): void {
    Object.values(EVENT_TYPES).forEach((eventType) => {
      this.eventHandlers.set(eventType, []);
      this.lastProcessedCursor.set(eventType, null);
    });
  }

  /**
   * Register an event handler for a specific event type
   */
  public on(eventType: string, handler: EventHandler): void {
    const handlers = this.eventHandlers.get(eventType) || [];
    handlers.push(handler);
    this.eventHandlers.set(eventType, handlers);

    appLogger.info(`Registered handler for event type: ${eventType}`, {
      handlerCount: handlers.length,
    });
  }

  /**
   * Unregister an event handler
   */
  public off(eventType: string, handler: EventHandler): void {
    const handlers = this.eventHandlers.get(eventType) || [];
    const index = handlers.indexOf(handler);
    if (index > -1) {
      handlers.splice(index, 1);
      this.eventHandlers.set(eventType, handlers);
      appLogger.info(`Unregistered handler for event type: ${eventType}`);
    }
  }

  /**
   * Start listening to events
   */
  public async start(): Promise<void> {
    if (this.isListening) {
      appLogger.warn('Event listener already running');
      return;
    }

    appLogger.info('Starting Sui event listener', {
      network: this.network,
      packageId: this.packageId,
      pollingInterval: this.pollingIntervalMs,
    });

    this.isListening = true;
    this.rpcPool.startHealthChecks();

    // Start polling loop
    this.listeningTimer = setInterval(() => {
      this.pollEvents().catch((error) => {
        appLogger.error('Error in event polling loop', { error: error.message });
      });
    }, this.pollingIntervalMs);

    // Poll immediately
    await this.pollEvents();
  }

  /**
   * Stop listening to events
   */
  public async stop(): Promise<void> {
    if (!this.isListening) {
      appLogger.warn('Event listener is not running');
      return;
    }

    appLogger.info('Stopping Sui event listener');
    this.isListening = false;

    if (this.listeningTimer) {
      clearInterval(this.listeningTimer);
      this.listeningTimer = undefined;
    }

    this.rpcPool.stopHealthChecks();
  }

  /**
   * Poll for new events
   */
  private async pollEvents(): Promise<void> {
    if (!this.isListening) {
      return;
    }

    const client = this.rpcPool.getClient(this.network);
    const eventTypes = Object.values(EVENT_TYPES);

    for (const eventType of eventTypes) {
      try {
        await this.pollEventType(client, eventType);
      } catch (error) {
        appLogger.error(`Failed to poll ${eventType}`, {
          error: (error as Error).message,
          network: this.network,
        });
      }
    }
  }

  /**
   * Poll for a specific event type
   */
  private async pollEventType(client: any, eventType: string): Promise<void> {
    const cursor = this.lastProcessedCursor.get(eventType);
    const startTime = Date.now();

    try {
      const response = await client.queryEvents({
        query: {
          MoveEventType: `${this.packageId}::whatsapp_integration::${eventType}`,
        },
        cursor,
        limit: this.maxEventsPerQuery,
        order: 'ascending',
      });

      const events = response.data || [];

      if (events.length > 0) {
        appLogger.debug(`Received ${events.length} ${eventType} events`, {
          cursor,
          newCursor: response.nextCursor,
        });

        // Parse and process events
        const parsedEvents = events
          .map((event: SuiEvent) => this.parserService.parseEvent(event, eventType))
          .filter((event): event is ParsedBlockchainEvent => event !== null);

        // Emit events to handlers
        for (const parsedEvent of parsedEvents) {
          await this.emitEvent(parsedEvent);
        }

        // Add to buffer for monitoring
        this.addToBuffer(parsedEvents);

        // Update cursor
        if (response.nextCursor) {
          this.lastProcessedCursor.set(eventType, response.nextCursor);
          this.rpcPool.updateCursor(response.nextCursor);
        }

        // Update metrics
        this.rpcPool.incrementEventsProcessed(parsedEvents.length);
      }

      const responseTime = Date.now() - startTime;
      this.rpcPool.recordSuccess(this.network, responseTime);
    } catch (error) {
      this.rpcPool.recordFailure(this.network, error as Error);
      throw error;
    }
  }

  /**
   * Emit an event to all registered handlers
   */
  private async emitEvent(event: ParsedBlockchainEvent): Promise<void> {
    const handlers = this.eventHandlers.get(event.type) || [];

    if (handlers.length === 0) {
      return;
    }

    const promises = handlers.map((handler) =>
      handler(event).catch((error) => {
        appLogger.error(`Error in event handler for ${event.type}`, {
          error: error.message,
          eventType: event.type,
          circleId: (event as any).circleId,
        });
      })
    );

    await Promise.allSettled(promises);
  }

  /**
   * Add events to buffer for monitoring
   */
  private addToBuffer(events: ParsedBlockchainEvent[]): void {
    this.eventBuffer.push(...events);
    if (this.eventBuffer.length > this.maxBufferSize) {
      this.eventBuffer = this.eventBuffer.slice(-this.maxBufferSize);
    }
  }

  /**
   * Get buffered events (for monitoring/debugging)
   */
  public getBufferedEvents(filter?: EventFilterCriteria): ParsedBlockchainEvent[] {
    let events = [...this.eventBuffer];

    if (filter) {
      if (filter.eventTypes) {
        events = events.filter((e) => filter.eventTypes!.includes(e.type));
      }
      if (filter.circleId) {
        events = events.filter((e) => (e as any).circleId === filter.circleId);
      }
      if (filter.fromTimestamp) {
        events = events.filter((e) => e.timestamp >= filter.fromTimestamp!);
      }
      if (filter.toTimestamp) {
        events = events.filter((e) => e.timestamp <= filter.toTimestamp!);
      }
    }

    return events;
  }

  /**
   * Get listener status
   */
  public getStatus(): {
    isListening: boolean;
    network: string;
    packageId: string;
    rpcPoolState: any;
    eventHandlers: Record<string, number>;
    bufferedEvents: number;
    uptime: number;
  } {
    return {
      isListening: this.isListening,
      network: this.network,
      packageId: this.packageId,
      rpcPoolState: this.rpcPool.getState(),
      eventHandlers: Object.fromEntries(
        Array.from(this.eventHandlers.entries()).map(([type, handlers]) => [
          type,
          handlers.length,
        ])
      ),
      bufferedEvents: this.eventBuffer.length,
      uptime: this.isListening
        ? Date.now() - (this.rpcPool.getState().lastEventTimestamp || Date.now())
        : 0,
    };
  }

  /**
   * Set polling interval
   */
  public setPollingInterval(intervalMs: number): void {
    if (intervalMs < 1000) {
      appLogger.warn('Polling interval too low, using 1000ms minimum');
      intervalMs = 1000;
    }

    this.pollingIntervalMs = intervalMs;

    if (this.isListening && this.listeningTimer) {
      clearInterval(this.listeningTimer);
      this.listeningTimer = setInterval(() => {
        this.pollEvents().catch((error) => {
          appLogger.error('Error in event polling loop', { error: error.message });
        });
      }, this.pollingIntervalMs);
    }

    appLogger.info('Polling interval updated', { intervalMs });
  }

  /**
   * Clear event buffer
   */
  public clearBuffer(): void {
    this.eventBuffer = [];
    appLogger.info('Event buffer cleared');
  }

  /**
   * Cleanup
   */
  public destroy(): void {
    if (this.isListening) {
      this.stop().catch((error) => {
        appLogger.error('Error stopping event listener', { error: error.message });
      });
    }
    this.eventHandlers.clear();
    this.eventBuffer = [];
  }
}
