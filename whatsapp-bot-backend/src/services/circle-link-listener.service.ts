import { SuiClient } from '@mysten/sui/client';
import { getConfig } from '../config';
import { appLogger } from '../utils/logger';
import { whatsappSender } from './whatsapp-sender.service';

// ============================================================================
// CIRCLE LINK LISTENER SERVICE
// ============================================================================

// Get package ID from environment variable with fallback to default testnet package
const PACKAGE_ID = process.env.NEXT_PUBLIC_PACKAGE_ID || '0xd0f586ee515a0289be671399c3a4550f96cd556592e10686b820cdba6a56ecdc';

export class CircleLinkListenerService {
  private isRunning = false;
  private suiClient: SuiClient;
  private checkInterval = 5000; // Check every 5 seconds
  private processedEvents: Set<string> = new Set(); // Track events in current session only
  private sentMessages: Map<string, number> = new Map(); // Track recently sent messages for deduplication (stores timestamps)
  private startTime: number = 0; // Track when listener started

  constructor() {
    const config = getConfig();
    const rpcUrl = config.sui.testnetRpcUrl;
    this.suiClient = new SuiClient({ url: rpcUrl });

    appLogger.info('CircleLinkListenerService initialized', {
      rpcUrl,
      packageId: PACKAGE_ID.slice(0, 15) + '...',
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
        await this.checkForMemberJoinedEvents();
        await this.checkForDepositEvents();
        await this.checkForContributionEvents();
        await this.checkForMemberRemovedEvents();
        await this.checkForRotationOrderChangedEvents();
        await this.checkForCircleActivatedEvents();
        await this.checkForPayoutProcessedEvents();
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
          MoveEventType: `${PACKAGE_ID}::whatsapp_integration::CircleLinked`,
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
          MoveEventType: `${PACKAGE_ID}::whatsapp_integration::CircleUnlinked`,
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
      const registryId = process.env.SUI_WHATSAPP_LINKS_REGISTRY_ID || '0x9e203f7dd2d56b058d82fb4f1fafe135133245fef347d8de4967e2c1c78b9459';

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
   * Check for MemberJoined events (when admin approves a new member)
   */
  private async checkForMemberJoinedEvents(): Promise<void> {
    try {
      const events = await this.suiClient.queryEvents({
        query: {
          MoveEventType: `${PACKAGE_ID}::njangi_circles::MemberJoined`,
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

        await this.handleMemberJoinedEvent(event);
      }
    } catch (error) {
      appLogger.error('Error checking for MemberJoined events', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Handle a MemberJoined event - notify admin when a new member is approved
   */
  private async handleMemberJoinedEvent(event: any): Promise<void> {
    try {
      const parsedJson = event.parsedJson as any;

      if (!parsedJson) {
        appLogger.warn('MemberJoined event has no parsedJson');
        return;
      }

      const {
        circle_id,
        member,
        contribution_amount_local,
        currency_type,
        joined_at,
      } = parsedJson;

      appLogger.info('MemberJoined event detected', {
        circleId: circle_id?.slice(0, 10),
        member: member?.slice(0, 10),
        currencyType: currency_type,
        joinedAt: joined_at,
      });

      // Look up the phone number for this circle
      const phoneNumber = await this.getPhoneNumberForCircle(circle_id);

      if (!phoneNumber) {
        appLogger.debug('Circle not linked to WhatsApp, skipping member notification', {
          circleId: circle_id?.slice(0, 10),
        });
        return;
      }

      // Check if we recently sent a message for this member (within last 2 minutes)
      const messageKey = `member:${circle_id}:${member}`;
      const lastSentTime = this.sentMessages.get(messageKey);
      const now = Date.now();
      const twoMinutesAgo = now - (2 * 60 * 1000);

      if (lastSentTime && lastSentTime > twoMinutesAgo) {
        appLogger.info('Skipping duplicate member notification - recently sent', {
          circleId: circle_id?.slice(0, 10),
          member: member?.slice(0, 10),
          lastSent: new Date(lastSentTime).toISOString(),
        });
        return;
      }

      // Format contribution amount
      const contributionFormatted = contribution_amount_local 
        ? (Number(contribution_amount_local) / 100).toFixed(2)
        : 'N/A';

      // Look up the member's name from the join requests database
      const memberInfo = await this.lookupMemberName(circle_id, member);
      const memberName = memberInfo?.userName || null;
      const circleName = memberInfo?.circleName || null;

      appLogger.info('Member info lookup result', {
        memberAddress: member?.slice(0, 10),
        memberName,
        circleName,
      });

      // Send member joined notification
      await this.sendMemberJoinedNotification(
        phoneNumber, 
        circle_id, 
        member, 
        contributionFormatted, 
        currency_type,
        memberName,
        circleName
      );

      // Track message send time for deduplication
      this.sentMessages.set(messageKey, Date.now());
    } catch (error) {
      appLogger.error('Error handling MemberJoined event', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Look up member name from the join requests database via API
   */
  private async lookupMemberName(circleId: string, memberAddress: string): Promise<{ userName: string | null; circleName: string | null } | null> {
    try {
      const apiUrl = process.env.FRONTEND_URL || 'https://njangionchain.com';
      const response = await fetch(
        `${apiUrl}/api/join-requests/lookup-user?circleId=${encodeURIComponent(circleId)}&userAddress=${encodeURIComponent(memberAddress)}`
      );

      if (!response.ok) {
        appLogger.warn('Failed to lookup member name', {
          status: response.status,
          circleId: circleId?.slice(0, 10),
          memberAddress: memberAddress?.slice(0, 10),
        });
        return null;
      }

      const data = await response.json() as { 
        success: boolean; 
        data?: { userName: string | null; circleName: string | null } 
      };
      if (data.success && data.data) {
        return {
          userName: data.data.userName,
          circleName: data.data.circleName,
        };
      }

      return null;
    } catch (error) {
      appLogger.error('Error looking up member name', {
        error: error instanceof Error ? error.message : String(error),
        circleId: circleId?.slice(0, 10),
        memberAddress: memberAddress?.slice(0, 10),
      });
      return null;
    }
  }

  /**
   * Send notification when a new member joins the circle
   */
  private async sendMemberJoinedNotification(
    phoneNumber: string,
    circleId: string,
    memberAddress: string,
    _contribution: string,  // Prefixed with _ to indicate intentionally unused
    _currency: string,      // Prefixed with _ to indicate intentionally unused
    memberName?: string | null,
    circleName?: string | null
  ): Promise<void> {
    try {
      const shortMember = `${memberAddress.slice(0, 6)}...${memberAddress.slice(-4)}`;
      
      // Use WhatsApp template for sending outside 24-hour window
      const circleUrl = `https://njangionchain.com/circle/${circleId}`;
      const joinDate = new Date().toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      });

      const result = await whatsappSender.sendMessage({
        to: phoneNumber,
        type: 'template',
        template: {
          name: 'member_joined',
          language: { code: 'en' },
          components: [
            {
              type: 'body',
              parameters: [
                { type: 'text', parameter_name: 'circle_name', text: circleName || 'Your Circle' },
                { type: 'text', parameter_name: 'member_name', text: memberName || 'New Member' },
                { type: 'text', parameter_name: 'member_address', text: shortMember },
                { type: 'text', parameter_name: 'join_date', text: joinDate },
                { type: 'text', parameter_name: 'circle_url', text: circleUrl },
              ],
            },
          ],
        },
      });

      if (result.success) {
        appLogger.info('✅ Member joined notification sent', {
          phoneNumber: phoneNumber.replace(/./g, '*').slice(0, 5) + '...',
          circleId: circleId.slice(0, 10) + '...',
          member: memberAddress.slice(0, 10) + '...',
          memberName: memberName || 'N/A',
          messageId: result.messageId,
        });
      } else {
        appLogger.warn('Failed to send member joined notification', {
          to: phoneNumber,
          error: result.error,
        });
      }
    } catch (error) {
      appLogger.error('Error sending member joined notification', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Check for CustodyDeposited events (security deposits)
   */
  private async checkForDepositEvents(): Promise<void> {
    try {
      const events = await this.suiClient.queryEvents({
        query: {
          MoveEventType: `${PACKAGE_ID}::njangi_custody::CustodyDeposited`,
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

        await this.handleDepositEvent(event);
      }
    } catch (error) {
      appLogger.error('Error checking for CustodyDeposited events', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Handle a CustodyDeposited event - notify admin when member makes a deposit
   */
  private async handleDepositEvent(event: any): Promise<void> {
    try {
      const parsedJson = event.parsedJson as any;

      if (!parsedJson) {
        appLogger.warn('CustodyDeposited event has no parsedJson');
        return;
      }

      const {
        circle_id,
        member,
        amount,
        operation_type,
      } = parsedJson;

      // operation_type: 3 = security deposit, 0 = contribution (but contributions use different event)
      const isSecurityDeposit = operation_type === 3;

      appLogger.info('CustodyDeposited event detected', {
        circleId: circle_id?.slice(0, 10),
        member: member?.slice(0, 10),
        amount,
        operationType: operation_type,
        isSecurityDeposit,
      });

      // Look up the phone number for this circle
      const phoneNumber = await this.getPhoneNumberForCircle(circle_id);

      if (!phoneNumber) {
        appLogger.debug('Circle not linked to WhatsApp, skipping deposit notification', {
          circleId: circle_id?.slice(0, 10),
        });
        return;
      }

      // Check if we recently sent a message for this deposit (within last 2 minutes)
      const messageKey = `deposit:${circle_id}:${member}:${amount}`;
      const lastSentTime = this.sentMessages.get(messageKey);
      const now = Date.now();
      const twoMinutesAgo = now - (2 * 60 * 1000);

      if (lastSentTime && lastSentTime > twoMinutesAgo) {
        appLogger.info('Skipping duplicate deposit notification - recently sent', {
          circleId: circle_id?.slice(0, 10),
          member: member?.slice(0, 10),
          lastSent: new Date(lastSentTime).toISOString(),
        });
        return;
      }

      // Format amount (assuming it's in smallest units, need to divide by 1e9 for SUI)
      const amountFormatted = (Number(amount) / 1e9).toFixed(4);

      // Look up the member's name from the join requests database
      const memberInfo = await this.lookupMemberName(circle_id, member);
      const memberName = memberInfo?.userName || null;

      // Send deposit notification
      await this.sendDepositNotification(
        phoneNumber,
        circle_id,
        member,
        amountFormatted,
        memberName,
        isSecurityDeposit
      );

      // Track message send time for deduplication
      this.sentMessages.set(messageKey, Date.now());
    } catch (error) {
      appLogger.error('Error handling CustodyDeposited event', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Send notification when a member makes a deposit
   */
  private async sendDepositNotification(
    phoneNumber: string,
    circleId: string,
    memberAddress: string,
    amount: string,
    memberName?: string | null,
    isSecurityDeposit?: boolean
  ): Promise<void> {
    try {
      const shortMember = `${memberAddress.slice(0, 6)}...${memberAddress.slice(-4)}`;
      const memberDisplay = memberName 
        ? `${memberName} (${shortMember})`
        : shortMember;

      const depositType = isSecurityDeposit ? 'Security Deposit' : 'Deposit';
      const emoji = isSecurityDeposit ? '🔒' : '💰';
      
      const depositMessage = `${emoji} *${depositType} Received!*

A member has made a deposit:

👤 *Member:* ${memberDisplay}
💎 *Amount:* ${amount} SUI

The funds are now safely held in the circle's custody wallet.

🔗 View circle: https://njangionchain.com/circle/${circleId}`;

      const result = await whatsappSender.sendMessage({
        to: phoneNumber,
        type: 'text',
        text: depositMessage,
      });

      if (result.success) {
        appLogger.info('✅ Deposit notification sent', {
          phoneNumber: phoneNumber.replace(/./g, '*').slice(0, 5) + '...',
          circleId: circleId.slice(0, 10) + '...',
          member: memberAddress.slice(0, 10) + '...',
          amount,
          depositType,
          messageId: result.messageId,
        });
      } else {
        appLogger.warn('Failed to send deposit notification', {
          to: phoneNumber,
          error: result.error,
        });
      }
    } catch (error) {
      appLogger.error('Error sending deposit notification', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Check for ContributionMade events (cycle contributions)
   */
  private async checkForContributionEvents(): Promise<void> {
    try {
      const events = await this.suiClient.queryEvents({
        query: {
          MoveEventType: `${PACKAGE_ID}::njangi_payments::ContributionMade`,
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

        await this.handleContributionEvent(event);
      }
    } catch (error) {
      appLogger.error('Error checking for ContributionMade events', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Handle a ContributionMade event - notify admin when member makes a cycle contribution
   */
  private async handleContributionEvent(event: any): Promise<void> {
    try {
      const parsedJson = event.parsedJson as any;

      if (!parsedJson) {
        appLogger.warn('ContributionMade event has no parsedJson');
        return;
      }

      const {
        circle_id,
        member,
        amount,
        cycle,
      } = parsedJson;

      appLogger.info('ContributionMade event detected', {
        circleId: circle_id?.slice(0, 10),
        member: member?.slice(0, 10),
        amount,
        cycle,
      });

      // Look up the phone number for this circle
      const phoneNumber = await this.getPhoneNumberForCircle(circle_id);

      if (!phoneNumber) {
        appLogger.debug('Circle not linked to WhatsApp, skipping contribution notification', {
          circleId: circle_id?.slice(0, 10),
        });
        return;
      }

      // Check if we recently sent a message for this contribution (within last 2 minutes)
      const messageKey = `contribution:${circle_id}:${member}:${cycle}`;
      const lastSentTime = this.sentMessages.get(messageKey);
      const now = Date.now();
      const twoMinutesAgo = now - (2 * 60 * 1000);

      if (lastSentTime && lastSentTime > twoMinutesAgo) {
        appLogger.info('Skipping duplicate contribution notification - recently sent', {
          circleId: circle_id?.slice(0, 10),
          member: member?.slice(0, 10),
          cycle,
          lastSent: new Date(lastSentTime).toISOString(),
        });
        return;
      }

      // Format amount (assuming it's in smallest units, need to divide by 1e9 for SUI)
      const amountFormatted = (Number(amount) / 1e9).toFixed(4);

      // Look up the member's name from the join requests database
      const memberInfo = await this.lookupMemberName(circle_id, member);
      const memberName = memberInfo?.userName || null;

      // Send contribution notification
      await this.sendContributionNotification(
        phoneNumber,
        circle_id,
        member,
        amountFormatted,
        cycle,
        memberName
      );

      // Track message send time for deduplication
      this.sentMessages.set(messageKey, Date.now());
    } catch (error) {
      appLogger.error('Error handling ContributionMade event', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Send notification when a member makes a cycle contribution
   */
  private async sendContributionNotification(
    phoneNumber: string,
    circleId: string,
    memberAddress: string,
    amount: string,
    cycle: string,
    memberName?: string | null
  ): Promise<void> {
    try {
      const shortMember = `${memberAddress.slice(0, 6)}...${memberAddress.slice(-4)}`;
      const memberDisplay = memberName 
        ? `${memberName} (${shortMember})`
        : shortMember;
      
      // Use WhatsApp template for sending outside 24-hour window
      const circleUrl = `https://njangionchain.com/circle/${circleId}`;
      const contribDate = new Date().toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      });

      // Fetch circle data for template parameters
      let circleName = 'Your Circle';
      let paidCount = '1';
      let totalMembers = '1';
      
      try {
        const circleObj = await this.suiClient.getObject({ 
          id: circleId, 
          options: { showContent: true } 
        });
        
        if (circleObj.data?.content?.dataType === 'moveObject') {
          const fields = (circleObj.data.content as any).fields;
          circleName = fields.name || 'Your Circle';
          totalMembers = String(fields.member_count || fields.rotation_order?.length || 1);
          // We don't have exact paid count here, use a placeholder
          paidCount = '1+';
        }
      } catch (e) {
        appLogger.warn('Could not fetch circle data for contribution notification', { circleId });
      }

      // Ensure all parameters are non-null strings
      const params = {
        circle_name: circleName || 'Circle',
        cycle_number: String(cycle || '1'),
        contributor_name: memberName || memberDisplay || 'Member',
        contrib_amount: `${amount} SUI`,
        contrib_date: contribDate,
        paid_count: paidCount || '1',
        total_members: totalMembers || '1',
        circle_url: circleUrl,
      };

      // Log the parameters we're sending for debugging
      appLogger.info('📤 Sending contribution_received template', params);

      const result = await whatsappSender.sendMessage({
        to: phoneNumber,
        type: 'template',
        template: {
          name: 'contribution_received',
          language: { code: 'en' },
          components: [
            {
              type: 'body',
              parameters: [
                { type: 'text', parameter_name: 'circle_name', text: params.circle_name },
                { type: 'text', parameter_name: 'cycle_number', text: params.cycle_number },
                { type: 'text', parameter_name: 'contributor_name', text: params.contributor_name },
                { type: 'text', parameter_name: 'contrib_amount', text: params.contrib_amount },
                { type: 'text', parameter_name: 'contrib_date', text: params.contrib_date },
                { type: 'text', parameter_name: 'paid_count', text: params.paid_count },
                { type: 'text', parameter_name: 'total_members', text: params.total_members },
                { type: 'text', parameter_name: 'circle_url', text: params.circle_url },
              ],
            },
          ],
        },
      });

      if (result.success) {
        appLogger.info('✅ Contribution notification sent', {
          phoneNumber: phoneNumber.replace(/./g, '*').slice(0, 5) + '...',
          circleId: circleId.slice(0, 10) + '...',
          member: memberAddress.slice(0, 10) + '...',
          amount,
          cycle,
          messageId: result.messageId,
        });
      } else {
        appLogger.warn('Failed to send contribution notification', {
          to: phoneNumber,
          error: result.error,
        });
      }
    } catch (error) {
      appLogger.error('Error sending contribution notification', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Check for MemberRemoved events (when admin removes a member)
   */
  private async checkForMemberRemovedEvents(): Promise<void> {
    try {
      const events = await this.suiClient.queryEvents({
        query: {
          MoveEventType: `${PACKAGE_ID}::njangi_circles::MemberRemoved`,
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

        await this.handleMemberRemovedEvent(event);
      }
    } catch (error) {
      appLogger.error('Error checking for MemberRemoved events', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Handle a MemberRemoved event - notify admin when a member is removed
   */
  private async handleMemberRemovedEvent(event: any): Promise<void> {
    try {
      const parsedJson = event.parsedJson as any;

      if (!parsedJson) {
        appLogger.warn('MemberRemoved event has no parsedJson');
        return;
      }

      const {
        circle_id,
        member,
        removed_by,
        deposit_returned,
        deposit_amount,
      } = parsedJson;

      appLogger.info('MemberRemoved event detected', {
        circleId: circle_id?.slice(0, 10),
        member: member?.slice(0, 10),
        removedBy: removed_by?.slice(0, 10),
        depositReturned: deposit_returned,
      });

      // Look up the phone number for this circle
      const phoneNumber = await this.getPhoneNumberForCircle(circle_id);

      if (!phoneNumber) {
        appLogger.debug('Circle not linked to WhatsApp, skipping removal notification', {
          circleId: circle_id?.slice(0, 10),
        });
        return;
      }

      // Check if we recently sent a message for this removal (within last 2 minutes)
      const messageKey = `removed:${circle_id}:${member}`;
      const lastSentTime = this.sentMessages.get(messageKey);
      const now = Date.now();
      const twoMinutesAgo = now - (2 * 60 * 1000);

      if (lastSentTime && lastSentTime > twoMinutesAgo) {
        appLogger.info('Skipping duplicate removal notification - recently sent', {
          circleId: circle_id?.slice(0, 10),
          member: member?.slice(0, 10),
          lastSent: new Date(lastSentTime).toISOString(),
        });
        return;
      }

      // Look up the member's name from the join requests database
      const memberInfo = await this.lookupMemberName(circle_id, member);
      const memberName = memberInfo?.userName || null;

      // Send removal notification
      await this.sendMemberRemovedNotification(
        phoneNumber,
        circle_id,
        member,
        memberName,
        deposit_returned,
        deposit_amount
      );

      // Track message send time for deduplication
      this.sentMessages.set(messageKey, Date.now());
    } catch (error) {
      appLogger.error('Error handling MemberRemoved event', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Send notification when a member is removed from the circle
   */
  private async sendMemberRemovedNotification(
    phoneNumber: string,
    circleId: string,
    memberAddress: string,
    memberName?: string | null,
    _depositReturned?: boolean,  // Prefixed with _ to indicate intentionally unused in template
    _depositAmount?: string      // Prefixed with _ to indicate intentionally unused in template
  ): Promise<void> {
    try {
      const shortMember = `${memberAddress.slice(0, 6)}...${memberAddress.slice(-4)}`;
      
      // Use WhatsApp template for sending outside 24-hour window
      const circleUrl = `https://njangionchain.com/circle/${circleId}`;
      const removalDate = new Date().toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      });

      // Get circle name from cache or use default
      const circleName = 'Your Circle'; // We don't have circle name in this context

      const result = await whatsappSender.sendMessage({
        to: phoneNumber,
        type: 'template',
        template: {
          name: 'member_removed',
          language: { code: 'en' },
          components: [
            {
              type: 'body',
              parameters: [
                { type: 'text', parameter_name: 'circle_name', text: circleName },
                { type: 'text', parameter_name: 'member_name', text: memberName || 'Member' },
                { type: 'text', parameter_name: 'member_address', text: shortMember },
                { type: 'text', parameter_name: 'removal_date', text: removalDate },
                { type: 'text', parameter_name: 'circle_url', text: circleUrl },
              ],
            },
          ],
        },
      });

      if (result.success) {
        appLogger.info('✅ Member removal notification sent', {
          phoneNumber: phoneNumber.replace(/./g, '*').slice(0, 5) + '...',
          circleId: circleId.slice(0, 10) + '...',
          member: memberAddress.slice(0, 10) + '...',
          memberName: memberName || 'N/A',
          messageId: result.messageId,
        });
      } else {
        appLogger.warn('Failed to send member removal notification', {
          to: phoneNumber,
          error: result.error,
        });
      }
    } catch (error) {
      appLogger.error('Error sending member removal notification', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Check for RotationOrderChanged events (when admin reorders members)
   */
  private async checkForRotationOrderChangedEvents(): Promise<void> {
    try {
      const events = await this.suiClient.queryEvents({
        query: {
          MoveEventType: `${PACKAGE_ID}::njangi_circles::RotationOrderChanged`,
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

        await this.handleRotationOrderChangedEvent(event);
      }
    } catch (error) {
      appLogger.error('Error checking for RotationOrderChanged events', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Handle a RotationOrderChanged event - notify admin when rotation order is changed
   */
  private async handleRotationOrderChangedEvent(event: any): Promise<void> {
    try {
      const parsedJson = event.parsedJson as any;

      if (!parsedJson) {
        appLogger.warn('RotationOrderChanged event has no parsedJson');
        return;
      }

      const {
        circle_id,
        admin,
        member_count,
      } = parsedJson;

      appLogger.info('RotationOrderChanged event detected', {
        circleId: circle_id?.slice(0, 10),
        admin: admin?.slice(0, 10),
        memberCount: member_count,
      });

      // Look up the phone number for this circle
      const phoneNumber = await this.getPhoneNumberForCircle(circle_id);

      if (!phoneNumber) {
        appLogger.debug('Circle not linked to WhatsApp, skipping rotation order notification', {
          circleId: circle_id?.slice(0, 10),
        });
        return;
      }

      // Check if we recently sent a message for this reorder (within last 2 minutes)
      const messageKey = `reorder:${circle_id}:${member_count}`;
      const lastSentTime = this.sentMessages.get(messageKey);
      const now = Date.now();
      const twoMinutesAgo = now - (2 * 60 * 1000);

      if (lastSentTime && lastSentTime > twoMinutesAgo) {
        appLogger.info('Skipping duplicate rotation order notification - recently sent', {
          circleId: circle_id?.slice(0, 10),
          lastSent: new Date(lastSentTime).toISOString(),
        });
        return;
      }

      // Fetch the rotation order from the circle object
      const rotationOrder = await this.getCircleRotationOrder(circle_id);
      
      // Look up names for each member in the rotation order
      const memberList: Array<{ address: string; name: string | null; position: number }> = [];
      
      if (rotationOrder && rotationOrder.length > 0) {
        for (let i = 0; i < rotationOrder.length; i++) {
          const address = rotationOrder[i];
          // Skip zero addresses
          if (address === '0x0000000000000000000000000000000000000000000000000000000000000000') {
            continue;
          }
          const memberInfo = await this.lookupMemberName(circle_id, address);
          memberList.push({
            address,
            name: memberInfo?.userName || null,
            position: i + 1,
          });
        }
      }

      // Send rotation order changed notification
      await this.sendRotationOrderChangedNotification(
        phoneNumber,
        circle_id,
        member_count,
        memberList
      );

      // Track message send time for deduplication
      this.sentMessages.set(messageKey, Date.now());
    } catch (error) {
      appLogger.error('Error handling RotationOrderChanged event', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Fetch the rotation order from a circle object
   */
  private async getCircleRotationOrder(circleId: string): Promise<string[] | null> {
    try {
      const circleObject = await this.suiClient.getObject({
        id: circleId,
        options: { showContent: true },
      });

      if (!circleObject.data?.content || circleObject.data.content.dataType !== 'moveObject') {
        appLogger.warn('Circle object not found or invalid', { circleId: circleId.slice(0, 10) });
        return null;
      }

      const fields = (circleObject.data.content as any).fields;
      const rotationOrder = fields?.rotation_order || [];

      appLogger.info('Fetched rotation order', {
        circleId: circleId.slice(0, 10),
        memberCount: rotationOrder.length,
      });

      return rotationOrder;
    } catch (error) {
      appLogger.error('Error fetching circle rotation order', {
        error: error instanceof Error ? error.message : String(error),
        circleId: circleId.slice(0, 10),
      });
      return null;
    }
  }

  /**
   * Send notification when rotation order is changed
   */
  private async sendRotationOrderChangedNotification(
    phoneNumber: string,
    circleId: string,
    memberCount: string,
    memberList?: Array<{ address: string; name: string | null; position: number }>
  ): Promise<void> {
    try {
      // Format the member list with positions and names
      let memberListText = '';
      if (memberList && memberList.length > 0) {
        memberListText = '\n\n📋 *New Rotation Order:*\n' + memberList.map(m => {
          const shortAddr = `${m.address.slice(0, 6)}...${m.address.slice(-4)}`;
          const displayName = m.name ? `${m.name} (${shortAddr})` : shortAddr;
          return `${m.position}. ${displayName}`;
        }).join('\n');
      }

      const shortCircleId = `${circleId.slice(0, 6)}...${circleId.slice(-4)}`;
      
      const reorderMessage = `🔄 *Rotation Order Updated*

The member rotation order has been changed by the admin.

🆔 *Circle:* ${shortCircleId}
👥 *Total Members:* ${memberCount}${memberListText}

The rotation order determines who receives payouts and when.

🔗 View circle: https://njangionchain.com/circle/${circleId}`;

      const result = await whatsappSender.sendMessage({
        to: phoneNumber,
        type: 'text',
        text: reorderMessage,
      });

      if (result.success) {
        appLogger.info('✅ Rotation order notification sent', {
          phoneNumber: phoneNumber.replace(/./g, '*').slice(0, 5) + '...',
          circleId: circleId.slice(0, 10) + '...',
          memberCount,
          memberListLength: memberList?.length || 0,
          messageId: result.messageId,
        });
      } else {
        appLogger.warn('Failed to send rotation order notification', {
          to: phoneNumber,
          error: result.error,
        });
      }
    } catch (error) {
      appLogger.error('Error sending rotation order notification', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Check for CircleActivated events (when admin activates the circle)
   */
  private async checkForCircleActivatedEvents(): Promise<void> {
    try {
      const events = await this.suiClient.queryEvents({
        query: {
          MoveEventType: `${PACKAGE_ID}::njangi_circles::CircleActivated`,
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

        await this.handleCircleActivatedEvent(event);
      }
    } catch (error) {
      appLogger.error('Error checking for CircleActivated events', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Handle a CircleActivated event - notify admin when circle is activated
   */
  private async handleCircleActivatedEvent(event: any): Promise<void> {
    try {
      const parsedJson = event.parsedJson as any;

      if (!parsedJson) {
        appLogger.warn('CircleActivated event has no parsedJson');
        return;
      }

      const {
        circle_id,
        activated_by,
      } = parsedJson;

      appLogger.info('CircleActivated event detected', {
        circleId: circle_id?.slice(0, 10),
        activatedBy: activated_by?.slice(0, 10),
      });

      // Look up the phone number for this circle
      const phoneNumber = await this.getPhoneNumberForCircle(circle_id);

      if (!phoneNumber) {
        appLogger.debug('Circle not linked to WhatsApp, skipping activation notification', {
          circleId: circle_id?.slice(0, 10),
        });
        return;
      }

      // Check if we recently sent a message for this activation (within last 2 minutes)
      const messageKey = `activated:${circle_id}`;
      const lastSentTime = this.sentMessages.get(messageKey);
      const now = Date.now();
      const twoMinutesAgo = now - (2 * 60 * 1000);

      if (lastSentTime && lastSentTime > twoMinutesAgo) {
        appLogger.info('Skipping duplicate activation notification - recently sent', {
          circleId: circle_id?.slice(0, 10),
          lastSent: new Date(lastSentTime).toISOString(),
        });
        return;
      }

      // Send activation notification
      await this.sendCircleActivatedNotification(phoneNumber, circle_id);

      // Track message send time for deduplication
      this.sentMessages.set(messageKey, Date.now());
    } catch (error) {
      appLogger.error('Error handling CircleActivated event', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Send notification when circle is activated
   */
  private async sendCircleActivatedNotification(
    phoneNumber: string,
    circleId: string
  ): Promise<void> {
    try {
      // Fetch circle data for template parameters
      let circleName = 'Your Circle';
      let memberCount = '0';
      let contributionAmount = 'N/A';
      let firstPayoutDate = 'TBD';
      
      try {
        const circleObj = await this.suiClient.getObject({ 
          id: circleId, 
          options: { showContent: true } 
        });
        
        if (circleObj.data?.content?.dataType === 'moveObject') {
          const fields = (circleObj.data.content as any).fields;
          circleName = fields.name || 'Your Circle';
          memberCount = String(fields.member_count || fields.rotation_order?.length || 0);
          
          if (fields.contribution_amount) {
            contributionAmount = `${(Number(fields.contribution_amount) / 1e9).toFixed(4)} SUI`;
          }
          
          if (fields.next_payout_time && Number(fields.next_payout_time) > 0) {
            firstPayoutDate = new Date(Number(fields.next_payout_time)).toLocaleDateString('en-US', {
              weekday: 'short',
              month: 'short',
              day: 'numeric',
              year: 'numeric',
            });
          }
        }
      } catch (e) {
        appLogger.warn('Could not fetch circle data for activation notification', { circleId });
      }

      const circleUrl = `https://njangionchain.com/circle/${circleId}`;

      // Use WhatsApp template for sending outside 24-hour window
      const result = await whatsappSender.sendMessage({
        to: phoneNumber,
        type: 'template',
        template: {
          name: 'circle_activated',
          language: { code: 'en' },
          components: [
            {
              type: 'body',
              parameters: [
                { type: 'text', parameter_name: 'circle_name', text: circleName },
                { type: 'text', parameter_name: 'member_count', text: memberCount },
                { type: 'text', parameter_name: 'contribution_amount', text: contributionAmount },
                { type: 'text', parameter_name: 'first_payout_date', text: firstPayoutDate },
                { type: 'text', parameter_name: 'circle_url', text: circleUrl },
              ],
            },
          ],
        },
      });

      if (result.success) {
        appLogger.info('✅ Circle activation notification sent', {
          phoneNumber: phoneNumber.replace(/./g, '*').slice(0, 5) + '...',
          circleId: circleId.slice(0, 10) + '...',
          messageId: result.messageId,
        });
      } else {
        appLogger.warn('Failed to send activation notification', {
          to: phoneNumber,
          error: result.error,
        });
      }
    } catch (error) {
      appLogger.error('Error sending activation notification', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Check for PayoutProcessed events
   */
  private async checkForPayoutProcessedEvents(): Promise<void> {
    try {
      const events = await this.suiClient.queryEvents({
        query: {
          MoveEventType: `${PACKAGE_ID}::njangi_payments::PayoutProcessed`,
        },
        limit: 50,
        order: 'descending',
      });

      for (const event of events.data) {
        // Skip events that occurred before the listener started
        if (Number(event.timestampMs) < this.startTime) {
          continue;
        }

        await this.handlePayoutProcessedEvent(event);
      }
    } catch (error) {
      appLogger.error('Error checking for PayoutProcessed events', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Handle a PayoutProcessed event
   */
  private async handlePayoutProcessedEvent(event: any): Promise<void> {
    try {
      const parsedJson = event.parsedJson as any;

      if (!parsedJson) {
        appLogger.warn('PayoutProcessed event has no parsedJson');
        return;
      }

      const {
        circle_id,
        recipient,
        amount,
        cycle,
      } = parsedJson;

      appLogger.info('PayoutProcessed event detected', {
        circleId: circle_id?.slice(0, 10),
        recipient: recipient?.slice(0, 10),
        amount,
        cycle,
      });

      // Look up the phone number for this circle
      const phoneNumber = await this.getPhoneNumberForCircle(circle_id);

      if (!phoneNumber) {
        appLogger.debug('Circle not linked to WhatsApp, skipping payout notification', {
          circleId: circle_id?.slice(0, 10),
        });
        return;
      }

      // Check if we recently sent a message for this payout (within last 5 minutes)
      const messageKey = `payout:${circle_id}:${cycle}:${recipient}`;
      const lastSentTime = this.sentMessages.get(messageKey);
      const now = Date.now();
      const fiveMinutesAgo = now - (5 * 60 * 1000);

      if (lastSentTime && lastSentTime > fiveMinutesAgo) {
        appLogger.info('Skipping duplicate payout notification - recently sent', {
          circleId: circle_id?.slice(0, 10),
          lastSent: new Date(lastSentTime).toISOString(),
        });
        return;
      }

      // Look up the recipient's name from the join requests database
      const memberInfo = await this.lookupMemberName(circle_id, recipient);
      const recipientName = memberInfo?.userName || null;

      // Send payout notification
      await this.sendPayoutProcessedNotification(
        phoneNumber,
        circle_id,
        recipient,
        amount,
        cycle,
        recipientName
      );

      // Track message send time for deduplication
      this.sentMessages.set(messageKey, Date.now());
    } catch (error) {
      appLogger.error('Error handling PayoutProcessed event', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Send notification when a payout is processed
   */
  private async sendPayoutProcessedNotification(
    phoneNumber: string,
    circleId: string,
    recipientAddress: string,
    amount: string,
    cycle: string,
    recipientName?: string | null
  ): Promise<void> {
    try {
      const shortRecipient = `${recipientAddress.slice(0, 6)}...${recipientAddress.slice(-4)}`;
      const amountFormatted = `${(Number(amount) / 1e9).toFixed(4)} SUI`;
      const payoutDate = new Date().toLocaleDateString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      });
      const circleUrl = `https://njangionchain.com/circle/${circleId}`;

      // Fetch circle name
      let circleName = 'Your Circle';
      try {
        const circleObj = await this.suiClient.getObject({ 
          id: circleId, 
          options: { showContent: true } 
        });
        
        if (circleObj.data?.content?.dataType === 'moveObject') {
          const fields = (circleObj.data.content as any).fields;
          circleName = fields.name || 'Your Circle';
        }
      } catch (e) {
        appLogger.warn('Could not fetch circle name for payout notification', { circleId });
      }

      // Use WhatsApp template for sending outside 24-hour window
      const result = await whatsappSender.sendMessage({
        to: phoneNumber,
        type: 'template',
        template: {
          name: 'payout_processed',
          language: { code: 'en' },
          components: [
            {
              type: 'body',
              parameters: [
                { type: 'text', parameter_name: 'circle_name', text: circleName },
                { type: 'text', parameter_name: 'recipient_name', text: recipientName || shortRecipient },
                { type: 'text', parameter_name: 'payout_amount', text: amountFormatted },
                { type: 'text', parameter_name: 'cycle_number', text: cycle },
                { type: 'text', parameter_name: 'payout_date', text: payoutDate },
                { type: 'text', parameter_name: 'circle_url', text: circleUrl },
              ],
            },
          ],
        },
      });

      if (result.success) {
        appLogger.info('✅ Payout processed notification sent', {
          phoneNumber: phoneNumber.replace(/./g, '*').slice(0, 5) + '...',
          circleId: circleId.slice(0, 10) + '...',
          recipient: recipientAddress.slice(0, 10) + '...',
          amount: amountFormatted,
          cycle,
          messageId: result.messageId,
        });
      } else {
        appLogger.warn('Failed to send payout processed notification', {
          to: phoneNumber,
          error: result.error,
        });
      }
    } catch (error) {
      appLogger.error('Error sending payout processed notification', {
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
      // Build the circle URL to pass to the template
      const circleUrl = `https://njangionchain.com/circle/${circleId}`;
      
      // Send the "circle_linked" template with circle URL as parameter
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
                  parameter_name: 'circle_url',
                  text: circleUrl,
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
