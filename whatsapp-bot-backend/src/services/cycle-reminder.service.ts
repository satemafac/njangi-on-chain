import { SuiClient } from '@mysten/sui/client';
import { getConfig } from '../config';
import { appLogger } from '../utils/logger';
import { whatsappSender } from './whatsapp-sender.service';

// ============================================================================
// CYCLE REMINDER SERVICE
// ============================================================================
// Sends automated reminders for:
// 1. Members who haven't contributed before payout date
// 2. Admins to trigger payouts if they haven't after payout date

const PACKAGE_ID = process.env.NEXT_PUBLIC_PACKAGE_ID || '0xd0f586ee515a0289be671399c3a4550f96cd556592e10686b820cdba6a56ecdc';

interface LinkedCircle {
  circleId: string;
  phoneNumber: string;
  adminAddress: string;
  enabled: boolean;
}

interface CircleData {
  name: string;
  admin: string;
  nextPayoutTime: number;
  currentCycle: number;
  isActive: boolean;
  pausedAfterCycle: boolean;
  members: string[];
  rotationOrder: string[];
  currentPosition: number;
}

interface MemberContributionStatus {
  address: string;
  hasContributed: boolean;
  userName?: string;
}

export class CycleReminderService {
  private suiClient: SuiClient;
  private sentReminders: Map<string, number> = new Map(); // Track sent reminders with timestamps
  private checkIntervalMs = 60 * 60 * 1000; // Check every hour
  private reminderWindowHours = 24; // Send contribution reminder 24 hours before payout
  private payoutGraceHours = 2; // Send admin reminder 2 hours after payout time
  private reminderCooldownHours = 12; // Don't send same reminder type within 12 hours
  private lastCheckTime = 0;

  constructor() {
    const config = getConfig();
    const rpcUrl = config.sui.testnetRpcUrl;
    this.suiClient = new SuiClient({ url: rpcUrl });

    appLogger.info('CycleReminderService initialized', {
      reminderWindowHours: this.reminderWindowHours,
      payoutGraceHours: this.payoutGraceHours,
      reminderCooldownHours: this.reminderCooldownHours,
    });
  }

  /**
   * Check if it's time to run reminder checks (runs hourly)
   */
  public shouldRunCheck(): boolean {
    const now = Date.now();
    if (now - this.lastCheckTime >= this.checkIntervalMs) {
      this.lastCheckTime = now;
      return true;
    }
    return false;
  }

  /**
   * Main method to check all linked circles and send reminders
   */
  public async checkAndSendReminders(): Promise<void> {
    if (!this.shouldRunCheck()) {
      return;
    }

    appLogger.info('Starting cycle reminder check...');

    try {
      // Get all linked circles
      const linkedCircles = await this.getAllLinkedCircles();

      if (linkedCircles.length === 0) {
        appLogger.debug('No linked circles found for reminder check');
        return;
      }

      appLogger.info(`Checking ${linkedCircles.length} linked circles for reminders`);

      for (const circle of linkedCircles) {
        if (!circle.enabled) {
          continue; // Skip disabled links
        }

        try {
          await this.checkCircleReminders(circle);
        } catch (error) {
          appLogger.error('Error checking reminders for circle', {
            circleId: circle.circleId.slice(0, 10),
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      appLogger.info('Cycle reminder check completed');
    } catch (error) {
      appLogger.error('Error in checkAndSendReminders', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Get all linked circles from the WhatsApp Links Registry
   */
  private async getAllLinkedCircles(): Promise<LinkedCircle[]> {
    try {
      const registryId = process.env.SUI_WHATSAPP_LINKS_REGISTRY_ID || 
        '0x9e203f7dd2d56b058d82fb4f1fafe135133245fef347d8de4967e2c1c78b9459';

      const registryObject = await this.suiClient.getObject({
        id: registryId,
        options: { showContent: true },
      });

      if (!registryObject.data?.content || registryObject.data.content.dataType !== 'moveObject') {
        appLogger.warn('Registry object not found');
        return [];
      }

      const registryFields = (registryObject.data.content as { fields?: { links?: unknown[] } }).fields;
      const links = registryFields?.links || [];

      const linkedCircles: LinkedCircle[] = [];

      for (const link of links) {
        const fields = (link as { fields?: Record<string, unknown> }).fields || link as Record<string, unknown>;
        const circleId = fields.circle_id as string;
        const phoneNumber = fields.admin_phone_number as string;
        const adminAddress = fields.admin_address as string;
        const enabled = fields.enabled as boolean;

        if (circleId && phoneNumber) {
          linkedCircles.push({
            circleId,
            phoneNumber,
            adminAddress: adminAddress || '',
            enabled: enabled !== false, // Default to true if not specified
          });
        }
      }

      return linkedCircles;
    } catch (error) {
      appLogger.error('Error getting linked circles from registry', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Check and send reminders for a specific circle
   */
  private async checkCircleReminders(linkedCircle: LinkedCircle): Promise<void> {
    const { circleId, phoneNumber } = linkedCircle;

    // Fetch circle data
    const circleData = await this.getCircleData(circleId);

    if (!circleData) {
      appLogger.debug('Could not fetch circle data for reminder check', {
        circleId: circleId.slice(0, 10),
      });
      return;
    }

    // Skip if circle is not active or is paused
    if (!circleData.isActive || circleData.pausedAfterCycle) {
      appLogger.debug('Circle is not active or paused, skipping reminders', {
        circleId: circleId.slice(0, 10),
        isActive: circleData.isActive,
        pausedAfterCycle: circleData.pausedAfterCycle,
      });
      return;
    }

    const now = Date.now();
    const payoutTime = circleData.nextPayoutTime;

    // Skip if no payout time set
    if (!payoutTime || payoutTime === 0) {
      return;
    }

    const hoursUntilPayout = (payoutTime - now) / (1000 * 60 * 60);
    const hoursSincePayout = (now - payoutTime) / (1000 * 60 * 60);

    appLogger.debug('Checking reminders for circle', {
      circleId: circleId.slice(0, 10),
      circleName: circleData.name,
      nextPayoutTime: new Date(payoutTime).toISOString(),
      hoursUntilPayout: hoursUntilPayout.toFixed(1),
      hoursSincePayout: hoursSincePayout.toFixed(1),
    });

    // Check 1: Contribution reminder (24 hours before payout)
    if (hoursUntilPayout > 0 && hoursUntilPayout <= this.reminderWindowHours) {
      await this.sendContributionReminders(circleId, phoneNumber, circleData);
    }

    // Check 2: Admin payout trigger reminder (after payout time)
    if (hoursSincePayout > this.payoutGraceHours) {
      await this.sendPayoutTriggerReminder(circleId, phoneNumber, circleData);
    }
  }

  /**
   * Get circle data from blockchain
   */
  private async getCircleData(circleId: string): Promise<CircleData | null> {
    try {
      const objectData = await this.suiClient.getObject({
        id: circleId,
        options: { showContent: true },
      });

      if (!objectData.data?.content || !('fields' in objectData.data.content)) {
        return null;
      }

      const fields = objectData.data.content.fields as Record<string, unknown>;

      // Get rotation order and filter out zero addresses
      const rotationOrder: string[] = [];
      if (fields.rotation_order && Array.isArray(fields.rotation_order)) {
        (fields.rotation_order as string[]).forEach((addr: string) => {
          if (addr && addr !== '0x0' && addr !== '0x0000000000000000000000000000000000000000000000000000000000000000') {
            rotationOrder.push(addr);
          }
        });
      }

      return {
        name: typeof fields.name === 'string' ? fields.name : 'Unknown Circle',
        admin: typeof fields.admin === 'string' ? fields.admin : '',
        nextPayoutTime: Number(fields.next_payout_time || 0),
        currentCycle: Number(fields.current_cycle || 0),
        isActive: fields.is_active === true,
        pausedAfterCycle: fields.paused_after_cycle === true,
        members: rotationOrder, // Use rotation order as member list
        rotationOrder,
        currentPosition: Number(fields.current_position || 0),
      };
    } catch (error) {
      appLogger.error('Error fetching circle data', {
        circleId: circleId.slice(0, 10),
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Send contribution reminders to members who haven't contributed
   */
  private async sendContributionReminders(
    circleId: string,
    adminPhone: string,
    circleData: CircleData
  ): Promise<void> {
    // Check cooldown for this reminder type
    const reminderKey = `contribution:${circleId}:cycle${circleData.currentCycle}`;
    if (this.isInCooldown(reminderKey)) {
      appLogger.debug('Contribution reminder in cooldown', {
        circleId: circleId.slice(0, 10),
        cycle: circleData.currentCycle,
      });
      return;
    }

    try {
      // Get members who haven't contributed
      const nonContributors = await this.getMembersWhoHaventContributed(circleId, circleData);

      if (nonContributors.length === 0) {
        appLogger.debug('All members have contributed, no reminder needed', {
          circleId: circleId.slice(0, 10),
        });
        return;
      }

      // Current recipient doesn't need to contribute
      const currentRecipient = circleData.rotationOrder[circleData.currentPosition];
      const membersNeedingReminder = nonContributors.filter(m => m.address !== currentRecipient);

      if (membersNeedingReminder.length === 0) {
        return;
      }

      const hoursLeft = Math.round((circleData.nextPayoutTime - Date.now()) / (1000 * 60 * 60));
      const payoutDate = new Date(circleData.nextPayoutTime).toLocaleDateString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });

      // Build list of pending members
      const pendingList = membersNeedingReminder
        .map((m, i) => {
          const shortAddr = `${m.address.slice(0, 6)}...${m.address.slice(-4)}`;
          return `${i + 1}. ${m.userName ? `${m.userName} (${shortAddr})` : shortAddr}`;
        })
        .join('\n');

      const reminderMessage = `⏰ *Contribution Reminder*

*${circleData.name}* - Cycle ${circleData.currentCycle}

📅 Payout scheduled: ${payoutDate}
⏳ Time remaining: ~${hoursLeft} hours

The following members haven't contributed yet:

${pendingList}

Please ensure all contributions are made before the payout time to keep the circle running smoothly!

💡 _Members can contribute via the Njangi app._

🔗 View circle: https://njangionchain.com/circle/${circleId}`;

      const result = await whatsappSender.sendMessage({
        to: adminPhone,
        type: 'text',
        text: reminderMessage,
      });

      if (result.success) {
        appLogger.info('✅ Contribution reminder sent', {
          circleId: circleId.slice(0, 10),
          cycle: circleData.currentCycle,
          pendingMembers: membersNeedingReminder.length,
          messageId: result.messageId,
        });
        this.markReminderSent(reminderKey);
      } else {
        appLogger.warn('Failed to send contribution reminder', {
          circleId: circleId.slice(0, 10),
          error: result.error,
        });
      }
    } catch (error) {
      appLogger.error('Error sending contribution reminders', {
        circleId: circleId.slice(0, 10),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Send payout trigger reminder to admin
   */
  private async sendPayoutTriggerReminder(
    circleId: string,
    adminPhone: string,
    circleData: CircleData
  ): Promise<void> {
    // Check cooldown for this reminder type
    const reminderKey = `payout:${circleId}:cycle${circleData.currentCycle}`;
    if (this.isInCooldown(reminderKey)) {
      appLogger.debug('Payout trigger reminder in cooldown', {
        circleId: circleId.slice(0, 10),
        cycle: circleData.currentCycle,
      });
      return;
    }

    try {
      // Check if payout has already been processed for this cycle
      const payoutProcessed = await this.checkIfPayoutProcessed(circleId, circleData.currentCycle);

      if (payoutProcessed) {
        appLogger.debug('Payout already processed, no reminder needed', {
          circleId: circleId.slice(0, 10),
          cycle: circleData.currentCycle,
        });
        return;
      }

      const hoursSincePayout = Math.round((Date.now() - circleData.nextPayoutTime) / (1000 * 60 * 60));
      const scheduledDate = new Date(circleData.nextPayoutTime).toLocaleDateString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });

      // Get current beneficiary
      const beneficiary = circleData.rotationOrder[circleData.currentPosition];
      const shortBeneficiary = beneficiary 
        ? `${beneficiary.slice(0, 6)}...${beneficiary.slice(-4)}`
        : 'Unknown';

      const reminderMessage = `🚨 *Payout Action Required*

*${circleData.name}* - Cycle ${circleData.currentCycle}

The scheduled payout time has passed!

📅 Scheduled: ${scheduledDate}
⏰ Overdue by: ~${hoursSincePayout} hours

🎯 *Current Beneficiary:*
${shortBeneficiary}

Please trigger the payout to distribute funds to the beneficiary.

⚠️ Delaying payouts affects member trust and circle health.

🔗 Manage circle: https://njangionchain.com/circle/${circleId}/manage`;

      const result = await whatsappSender.sendMessage({
        to: adminPhone,
        type: 'text',
        text: reminderMessage,
      });

      if (result.success) {
        appLogger.info('✅ Payout trigger reminder sent', {
          circleId: circleId.slice(0, 10),
          cycle: circleData.currentCycle,
          hoursSincePayout,
          messageId: result.messageId,
        });
        this.markReminderSent(reminderKey);
      } else {
        appLogger.warn('Failed to send payout trigger reminder', {
          circleId: circleId.slice(0, 10),
          error: result.error,
        });
      }
    } catch (error) {
      appLogger.error('Error sending payout trigger reminder', {
        circleId: circleId.slice(0, 10),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Get members who haven't contributed for the current cycle
   */
  private async getMembersWhoHaventContributed(
    circleId: string,
    circleData: CircleData
  ): Promise<MemberContributionStatus[]> {
    const nonContributors: MemberContributionStatus[] = [];

    try {
      // Get contribution events for current cycle
      const contributionEvents = await this.suiClient.queryEvents({
        query: { MoveEventType: `${PACKAGE_ID}::njangi_payments::ContributionMade` },
        limit: 200,
      });

      // Find who contributed for this circle and cycle
      const contributedAddresses = new Set<string>();

      for (const event of contributionEvents.data) {
        const parsed = event.parsedJson as {
          circle_id?: string;
          member?: string;
          cycle?: string | number;
        };

        if (parsed?.circle_id === circleId) {
          const eventCycle = typeof parsed.cycle === 'string' 
            ? parseInt(parsed.cycle, 10) 
            : parsed.cycle;

          if (eventCycle === circleData.currentCycle && parsed.member) {
            contributedAddresses.add(parsed.member);
          }
        }
      }

      // Check each member
      for (const memberAddress of circleData.members) {
        if (!contributedAddresses.has(memberAddress)) {
          // Look up member name (optional)
          const userName = await this.lookupMemberName(circleId, memberAddress);
          nonContributors.push({
            address: memberAddress,
            hasContributed: false,
            userName,
          });
        }
      }
    } catch (error) {
      appLogger.error('Error getting non-contributors', {
        circleId: circleId.slice(0, 10),
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return nonContributors;
  }

  /**
   * Check if payout has been processed for a specific cycle
   */
  private async checkIfPayoutProcessed(circleId: string, cycle: number): Promise<boolean> {
    try {
      const payoutEvents = await this.suiClient.queryEvents({
        query: { MoveEventType: `${PACKAGE_ID}::njangi_payments::PayoutProcessed` },
        limit: 100,
      });

      for (const event of payoutEvents.data) {
        const parsed = event.parsedJson as {
          circle_id?: string;
          cycle?: string | number;
        };

        if (parsed?.circle_id === circleId) {
          const eventCycle = typeof parsed.cycle === 'string'
            ? parseInt(parsed.cycle, 10)
            : parsed.cycle;

          if (eventCycle === cycle) {
            return true;
          }
        }
      }

      return false;
    } catch (error) {
      appLogger.error('Error checking payout status', {
        circleId: circleId.slice(0, 10),
        error: error instanceof Error ? error.message : String(error),
      });
      return false; // Assume not processed on error
    }
  }

  /**
   * Look up member name from join requests API
   */
  private async lookupMemberName(circleId: string, memberAddress: string): Promise<string | undefined> {
    try {
      const baseUrl = process.env.VERCEL_URL
        ? `https://${process.env.VERCEL_URL}`
        : (process.env.NODE_ENV === 'production' ? 'https://njangionchain.com' : 'http://localhost:3000');

      const response = await fetch(
        `${baseUrl}/api/join-requests/lookup-user?circleId=${encodeURIComponent(circleId)}&userAddress=${encodeURIComponent(memberAddress)}`
      );

      if (response.ok) {
        const data = await response.json() as {
          success?: boolean;
          data?: { userName?: string };
        };
        if (data.success && data.data?.userName) {
          return data.data.userName;
        }
      }
    } catch {
      // Silently fail - name lookup is optional
    }
    return undefined;
  }

  /**
   * Check if a reminder is in cooldown period
   */
  private isInCooldown(reminderKey: string): boolean {
    const lastSent = this.sentReminders.get(reminderKey);
    if (!lastSent) return false;

    const cooldownMs = this.reminderCooldownHours * 60 * 60 * 1000;
    return Date.now() - lastSent < cooldownMs;
  }

  /**
   * Mark a reminder as sent
   */
  private markReminderSent(reminderKey: string): void {
    this.sentReminders.set(reminderKey, Date.now());

    // Clean up old entries (older than 24 hours)
    const cutoffTime = Date.now() - (24 * 60 * 60 * 1000);
    for (const [key, time] of this.sentReminders.entries()) {
      if (time < cutoffTime) {
        this.sentReminders.delete(key);
      }
    }
  }
}

// Export singleton instance
export const cycleReminderService = new CycleReminderService();

