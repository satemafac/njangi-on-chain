import { SuiClient } from '@mysten/sui/client';
import { getConfig } from '../config';
import { appLogger } from '../utils/logger';
import { whatsappSender } from './whatsapp-sender.service';

// ============================================================================
// CIRCLE LINK LISTENER SERVICE
// ============================================================================

export class CircleLinkListenerService {
  private isRunning = false;
  private suiClient: SuiClient;
  private checkInterval = 5000; // Check every 5 seconds
  private processedEvents: Set<string> = new Set(); // Track events in current session only
  private sentMessages: Map<string, any> = new Map(); // Track recently sent messages for deduplication
  private startTime: number = 0; // Track when listener started

  constructor() {
    const config = getConfig();
    const rpcUrl = config.sui.testnetRpcUrl;
    this.suiClient = new SuiClient({ url: rpcUrl });

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
        await this.checkForCircleUnlinkedEvents();
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
        appLogger.debug('No CircleLinked events found', {
          startTime: this.startTime,
          now: Date.now(),
        });
        return;
      }

      appLogger.info('Found CircleLinked events', {
        count: events.data.length,
        startTime: new Date(this.startTime).toISOString(),
        now: new Date().toISOString(),
        timeSinceStart: Date.now() - this.startTime,
      });

      for (const event of events.data) {
        const eventId = event.id.txDigest + ':' + event.id.eventSeq;
        const eventTimestampMs = parseInt(event.timestampMs || '0', 10);

        appLogger.debug('Checking CircleLinked event', {
          eventId,
          eventTimestampMs,
          startTime: this.startTime,
          isAfterStart: eventTimestampMs >= this.startTime,
          recipient: (event.parsedJson as any)?.recipient,
          circleId: (event.parsedJson as any)?.circle_id?.slice(0, 10),
        });

        // Skip events that occurred before listener started
        if (eventTimestampMs < this.startTime) {
          appLogger.debug('Skipping event - occurred before listener started', {
            eventTimestampMs,
            startTime: this.startTime,
          });
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
   * Check for CircleUnlinked events
   * Only processes events that occurred after the listener started
   */
  private async checkForCircleUnlinkedEvents(): Promise<void> {
    try {
      const events = await this.suiClient.queryEvents({
        query: {
          MoveEventType: '0xd0f586ee515a0289be671399c3a4550f96cd556592e10686b820cdba6a56ecdc::whatsapp_integration::CircleUnlinked',
        },
        limit: 50,
        order: 'descending',
      });

      if (!events.data || events.data.length === 0) {
        return;
      }

      appLogger.info('Found CircleUnlinked events', {
        count: events.data.length,
        startTime: new Date(this.startTime).toISOString(),
        now: new Date().toISOString(),
        timeSinceStart: Date.now() - this.startTime,
      });

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

        await this.handleCircleUnlinkedEvent(event);
      }
    } catch (error) {
      appLogger.error('Error checking for CircleUnlinked events', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Handle a CircleUnlinked event
   * Note: CircleUnlinked event only has circle_id and admin_address, not phone number
   * We need to look up the phone number from the registry (the link is now disabled)
   */
  private async handleCircleUnlinkedEvent(event: any): Promise<void> {
    try {
      const parsedJson = event.parsedJson as any;

      if (!parsedJson) {
        appLogger.warn('CircleUnlinked event has no parsedJson');
        return;
      }

      const {
        circle_id,
        admin_address,
        unlinked_at,
      } = parsedJson;

      appLogger.info('CircleUnlinked event detected', {
        circleId: circle_id,
        adminAddress: admin_address,
        unlinkedAt: unlinked_at,
      });

      // Look up the phone number from the registry
      // The link should still exist but with enabled=false
      const phoneNumber = await this.getPhoneNumberForCircle(circle_id);

      if (!phoneNumber) {
        appLogger.warn('Could not find phone number for unlinked circle', {
          circleId: circle_id,
          adminAddress: admin_address,
        });
        return;
      }

      // Check if we recently sent a message for this circle (within last 2 minutes)
      const messageKey = `unlink:${circle_id}:${phoneNumber}`;
      const lastSentTime = this.sentMessages.get(messageKey);
      const now = Date.now();
      const twoMinutesAgo = now - (2 * 60 * 1000);

      if (lastSentTime && lastSentTime > twoMinutesAgo) {
        appLogger.info('Skipping duplicate unlink message - recently sent', {
          circleId: circle_id?.slice(0, 10),
          phoneNumber: phoneNumber?.slice(0, 5) + '...',
          lastSent: new Date(lastSentTime).toISOString(),
        });
        return;
      }

      // Send unlink confirmation message
      await this.sendUnlinkConfirmation(phoneNumber, circle_id);

      // Track message send time for deduplication
      this.sentMessages.set(messageKey, Date.now());
    } catch (error) {
      appLogger.error('Error handling CircleUnlinked event', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Look up the phone number associated with a circle from the registry
   * This works even for disabled links (after unlink)
   */
  private async getPhoneNumberForCircle(circleId: string): Promise<string | null> {
    try {
      const registryId = '0x9e203f7dd2d56b058d82fb4f1fafe135133245fef347d8de4967e2c1c78b9459';

      const registryObject = await this.suiClient.getObject({
        id: registryId,
        options: { showContent: true },
      });

      if (!registryObject.data?.content || registryObject.data.content.dataType !== 'moveObject') {
        appLogger.warn('Registry object not found');
        return null;
      }

      const registryFields = (registryObject.data.content as any).fields;
      const links = registryFields?.links || [];

      // Find the link for this circle (may be enabled or disabled)
      for (const link of links) {
        const fields = link.fields || link;
        const linkCircleId = fields.circle_id;
        const adminPhoneNumber = fields.admin_phone_number;

        if (linkCircleId === circleId && adminPhoneNumber) {
          appLogger.info('Found phone number for circle', {
            circleId: circleId.slice(0, 10),
            phoneNumber: adminPhoneNumber.slice(0, 5) + '...',
            enabled: fields.enabled,
          });
          return adminPhoneNumber;
        }
      }

      appLogger.warn('No link found for circle in registry', {
        circleId: circleId.slice(0, 10),
        totalLinks: links.length,
      });
      return null;
    } catch (error) {
      appLogger.error('Error looking up phone number for circle', {
        error: error instanceof Error ? error.message : String(error),
        circleId,
      });
      return null;
    }
  }

  /**
   * Send unlink confirmation message to admin
   */
  private async sendUnlinkConfirmation(
    phoneNumber: string,
    circleId: string
  ): Promise<void> {
    try {
      const unlinkMessage = `🔓 *Circle Unlinked*

Your WhatsApp has been disconnected from the circle.

You will no longer receive notifications for this circle.

If you'd like to reconnect, visit the circle management page in the Njangi app and link your WhatsApp again.

📱 Circle ID: ${circleId.slice(0, 10)}...${circleId.slice(-6)}`;

      const result = await whatsappSender.sendMessage({
        to: phoneNumber,
        type: 'text',
        text: unlinkMessage,
      });

      if (result.success) {
        appLogger.info('✅ Unlink confirmation message sent', {
          phoneNumber: phoneNumber.replace(/./g, '*').slice(0, 5) + '...',
          circleId: circleId.slice(0, 10) + '...',
          messageId: result.messageId,
        });
      } else {
        appLogger.warn('Failed to send unlink confirmation', {
          to: phoneNumber,
          error: result.error,
        });
      }
    } catch (error) {
      appLogger.error('Error sending unlink confirmation', {
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
        appLogger.info('✅ CircleLinked event processed and message sent', {
          phoneNumber: phoneNumber.replace(/./g, '*').slice(0, 5) + '...',
          circleId: circleId.slice(0, 10) + '...',
          note: 'Circle linkage is queried from on-chain registry when needed',
        });
        
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
