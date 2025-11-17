import { SuiClient } from '@mysten/sui/client';
import Redis from 'ioredis';
import { getConfig } from '../config';
import { appLogger } from '../utils/logger';
import { whatsappSender } from './whatsapp-sender.service';

// ============================================================================
// CIRCLE LINK LISTENER SERVICE
// ============================================================================

export class CircleLinkListenerService {
  private isRunning = false;
  private suiClient: SuiClient;
  private redis: Redis;
  private checkInterval = 5000; // Check every 5 seconds
  private processedEvents: Set<string> = new Set(); // Track events in current session only
  private sentMessages: Map<string, any> = new Map(); // Track recently sent messages and circle IDs
  private circleIdMap: Map<string, string> = new Map(); // Map phone numbers to circle IDs (local cache)
  private startTime: number = 0; // Track when listener started
  private redisKeyPrefix = 'whatsapp:circle:'; // Redis key prefix for circle mappings

  constructor() {
    const config = getConfig();
    const rpcUrl = config.sui.testnetRpcUrl;
    this.suiClient = new SuiClient({ url: rpcUrl });

    // Initialize Redis connection for shared state across dynos
    try {
      this.redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
        // Disable SSL verification for Heroku Redis (uses self-signed certs)
        tls: process.env.REDIS_URL ? { rejectUnauthorized: false } : undefined,
        retryStrategy: (times) => Math.min(times * 50, 2000),
        maxRetriesPerRequest: 3,
      });
      this.redis.on('error', (err) => {
        appLogger.warn('Redis connection error', { error: err.message });
      });
      this.redis.on('connect', () => {
        appLogger.debug('Redis connection established');
      });
      appLogger.debug('Redis client initialized for circle-phone mappings');
    } catch (error) {
      appLogger.warn('Failed to initialize Redis', {
        error: error instanceof Error ? error.message : String(error),
      });
      // Redis is optional, fall back to in-memory storage
      this.redis = null as any;
    }

    appLogger.info('CircleLinkListenerService initialized', {
      rpcUrl,
      note: 'Will only process events from startup onwards (skipping old events)',
    });
  }

  /**
   * Start listening for CircleLinked events
   * Only processes events that occur AFTER this method is called
   */
  public start(): void {
    if (this.isRunning) {
      appLogger.warn('CircleLinkListenerService is already running');
      return;
    }

    this.isRunning = true;
    this.startTime = Date.now(); // Record startup time to skip old events

    appLogger.info('CircleLinkListenerService started', {
      checkInterval: this.checkInterval,
      note: 'Listening for NEW events only (skipping historical events)',
    });

    this.listen();
  }

  /**
   * Stop listening for CircleLinked events
   */
  public stop(): void {
    this.isRunning = false;
    appLogger.info('CircleLinkListenerService stopped');
  }

  /**
   * Main listen loop
   */
  private async listen(): Promise<void> {
    while (this.isRunning) {
      try {
        await this.checkForCircleLinkedEvents();
        await new Promise((resolve) => setTimeout(resolve, this.checkInterval));
      } catch (error) {
        appLogger.error('Error in listen loop', {
          error: error instanceof Error ? error.message : String(error),
        });
        // Continue listening even on error
        await new Promise((resolve) => setTimeout(resolve, this.checkInterval));
      }
    }
  }

  /**
   * Check for CircleLinked events
   * Only processes events that occurred after the listener started
   */
  private async checkForCircleLinkedEvents(): Promise<void> {
    try {
      const events = await this.suiClient.queryEvents({
        query: {
          MoveEventType: '0xd0f586ee515a0289be671399c3a4550f96cd556592e10686b820cdba6a56ecdc::whatsapp_integration::CircleLinked',
        },
        limit: 50,
        order: 'descending',
      });

      if (!events.data || events.data.length === 0) {
        return;
      }

      for (const event of events.data) {
        const eventId = event.id.txDigest + ':' + event.id.eventSeq;
        const eventTimestampMs = parseInt(event.timestampMs || '0', 10);

        // Skip events that occurred before listener started
        if (eventTimestampMs < this.startTime) {
          continue;
        }

        // Skip if already processed in this session
        if (this.processedEvents.has(eventId)) {
          continue;
        }

        this.processedEvents.add(eventId);

        // Keep only last 1000 events in memory for this session
        if (this.processedEvents.size > 1000) {
          const processedArray = Array.from(this.processedEvents);
          this.processedEvents = new Set(processedArray.slice(-500));
        }

        await this.handleCircleLinkedEvent(event);
      }
    } catch (error) {
      appLogger.error('Error checking for CircleLinked events', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Handle a CircleLinked event
   */
  private async handleCircleLinkedEvent(event: any): Promise<void> {
    try {
      const parsedJson = event.parsedJson as any;

      if (!parsedJson) {
        appLogger.warn('CircleLinked event has no parsedJson');
        return;
      }

      const {
        circle_id,
        link_type,
        recipient,
        linked_at,
      } = parsedJson;

      // Check if we recently sent a message for this circle (within last 2 minutes)
      const messageKey = `${circle_id}:${recipient}`;
      const lastSentTime = this.sentMessages.get(messageKey);
      const now = Date.now();
      const twoMinutesAgo = now - (2 * 60 * 1000);

      if (lastSentTime && lastSentTime > twoMinutesAgo) {
        appLogger.info('Skipping duplicate message - recently sent', {
          circleId: circle_id.slice(0, 10),
          recipient: recipient.slice(0, 10),
          lastSent: new Date(lastSentTime).toISOString(),
        });
        return;
      }

      appLogger.info('CircleLinked event detected', {
        circleId: circle_id,
        recipient,
        linkType: link_type,
        linkedAt: linked_at,
      });

      // Send confirmation message to the linked phone number
      await this.sendLinkConfirmation(recipient, circle_id);

      // Send notification to all circle members
      await this.notifyCircleMembers(circle_id);
    } catch (error) {
      appLogger.error('Error handling CircleLinked event', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Send link confirmation message to admin using template
   * Note: Meta WhatsApp API requires template-based messages to initiate conversation
   */
  private async sendLinkConfirmation(
    phoneNumber: string,
    circleId: string
  ): Promise<void> {
    try {
      // Send the "circle_linked" template with circle ID as parameter
      // Template now includes: {{1}} = circle ID with link
      const result = await whatsappSender.sendMessage({
        to: phoneNumber,
        type: 'template',
        template: {
          name: 'circle_linked',
          language: {
            code: 'en_US',
          },
          components: [
            {
              type: 'body',
              parameters: [
                {
                  type: 'text',
                  text: circleId, // Pass circle ID for the link in the template
                },
              ],
            },
          ],
        },
      });
      
      if (result.success) {
        // Store circle ID and phone number pairing for later use
        this.circleIdMap.set(phoneNumber, circleId);
        
        // Also store in Redis for access across dynos
        if (this.redis) {
          try {
            const redisKey = `${this.redisKeyPrefix}${phoneNumber}`;
            // Store with 90-day expiration
            await this.redis.setex(redisKey, 7776000, circleId);
            appLogger.debug('Circle ID stored in Redis', {
              phoneNumber,
              circleId,
              redisKey,
            });
          } catch (error) {
            appLogger.warn('Failed to store circle ID in Redis', {
              error: error instanceof Error ? error.message : String(error),
              phoneNumber,
            });
          }
        }
        
        // Track message send time for deduplication
        const messageKey = `circle_id:${phoneNumber}`;
        this.sentMessages.set(messageKey, Date.now());

        // Clean up old entries to prevent memory bloat
        if (this.sentMessages.size > 100) {
          const entries = Array.from(this.sentMessages.entries());
          const sorted = entries.sort((a, b) => b[1] - a[1]);
          this.sentMessages = new Map(sorted.slice(0, 50));
        }

        appLogger.info('Link confirmation message sent', {
          to: phoneNumber,
          circleId,
          messageId: result.messageId,
        });
      } else {
        appLogger.warn('Failed to send link confirmation', {
          to: phoneNumber,
          error: result.error,
        });
      }
    } catch (error) {
      appLogger.error('Error sending link confirmation', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Notify all circle members about the WhatsApp link
   */
  private async notifyCircleMembers(
    circleId: string
  ): Promise<void> {
    try {
      // Note: In a real implementation, you'd fetch actual circle members
      // For now, we're logging the intent
      appLogger.info('Preparing to notify circle members', {
        circleId,
      });

      // TODO: Implement member notification in follow-up phase
    } catch (error) {
      appLogger.error('Error notifying circle members', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Send welcome message after user confirms circle link
   * Can be called via webhook when user replies
   */
  /**
   * Get the circle ID associated with a phone number
   * Handles both formats: +1234567890 and 1234567890
   * Checks Redis first (for cross-dyno access), then local cache
   */
  public async getCircleIdForPhone(phoneNumber: string): Promise<string | undefined> {
    // Normalize phone number by removing '+' prefix
    const normalizedPhone = phoneNumber.replace(/^\+/, '');
    
    // Try Redis first (for access across dynos)
    if (this.redis) {
      try {
        const redisKey = `${this.redisKeyPrefix}${normalizedPhone}`;
        const circleId = await this.redis.get(redisKey);
        if (circleId) {
          appLogger.debug('Circle ID found in Redis', {
            phoneNumber,
            redisKey,
            circleId,
          });
          return circleId;
        }
      } catch (error) {
        appLogger.warn('Error checking Redis for circle ID', {
          error: error instanceof Error ? error.message : String(error),
          phoneNumber,
        });
      }
    }

    // Fall back to local cache
    // Try exact match first
    let circleId = this.circleIdMap.get(phoneNumber);
    if (circleId) return circleId;

    // Try normalized version
    circleId = this.circleIdMap.get(normalizedPhone);
    if (circleId) return circleId;

    // Try with + prefix
    const phoneWithPlus = `+${normalizedPhone}`;
    circleId = this.circleIdMap.get(phoneWithPlus);
    if (circleId) return circleId;

    // Check all entries and try to match normalized versions
    for (const [storedPhone, id] of this.circleIdMap.entries()) {
      const storedNormalized = storedPhone.replace(/^\+/, '');
      if (storedNormalized === normalizedPhone) {
        appLogger.debug('Circle ID found in local cache after normalization', {
          original: phoneNumber,
          normalized: normalizedPhone,
          stored: storedPhone,
        });
        return id;
      }
    }

    appLogger.debug('No circle ID found for phone number', {
      phoneNumber,
      normalized: normalizedPhone,
      mappingCount: this.circleIdMap.size,
    });

    return undefined;
  }

  public async sendWelcomeMessage(
    phoneNumber: string,
    circleId: string
  ): Promise<void> {
    try {
      const welcomeMessage = `👋 *Welcome to Your Circle!*

Your WhatsApp is now connected to your circle. You'll receive updates about:

📅 *Cycles & Deadlines*
💰 *Member Contributions*
🎯 *Important Announcements*
💸 *Payout Notifications*

Type *help* anytime for available commands.

Ready to manage your circle! 🚀`;

      const result = await whatsappSender.sendMessage({
        to: phoneNumber,
        type: 'text',
        text: welcomeMessage,
      });

      if (result.success) {
        appLogger.info('Welcome message sent', {
          to: phoneNumber,
          circleId,
          messageId: result.messageId,
        });
      } else {
        appLogger.warn('Failed to send welcome message', {
          to: phoneNumber,
          error: result.error,
        });
      }
    } catch (error) {
      appLogger.error('Error sending welcome message', {
        error: error instanceof Error ? error.message : String(error),
        phoneNumber,
        circleId,
      });
    }
  }
}

/**
 * Export singleton instance
 */
export const circleLinkListener = new CircleLinkListenerService();
