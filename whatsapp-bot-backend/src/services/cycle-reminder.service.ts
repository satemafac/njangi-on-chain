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
  contributionAmount?: number;
  memberCount?: number;
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
  private reminderWindowHours = 48; // Send contribution reminder 48 hours before payout
  private payoutGraceHours = 1; // Send admin reminder 1 hour after payout time
  private reminderCooldownHours = 6; // Don't send same reminder type within 6 hours
  private lastCheckTime = 0;

  constructor() {
    const config = getConfig();
    const rpcUrl = config.sui.currentRpcUrl;
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
      const registryId = getConfig().sui.currentWhatsAppRegistryId;

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
      appLogger.info('Skipping circle - no payout time set', {
        circleId: circleId.slice(0, 10),
        circleName: circleData.name,
      });
      return;
    }

    const hoursUntilPayout = (payoutTime - now) / (1000 * 60 * 60);
    const hoursSincePayout = (now - payoutTime) / (1000 * 60 * 60);

    // Log at INFO level so we can see what's happening
    appLogger.info('🔍 Checking reminders for circle', {
      circleId: circleId.slice(0, 10),
      circleName: circleData.name,
      nextPayoutTime: new Date(payoutTime).toISOString(),
      hoursUntilPayout: hoursUntilPayout.toFixed(1),
      hoursSincePayout: hoursSincePayout.toFixed(1),
      reminderWindowHours: this.reminderWindowHours,
      payoutGraceHours: this.payoutGraceHours,
    });

    // Check 1: Contribution reminder
    // - Before payout: within 48 hours of scheduled time
    // - After payout: continue sending late reminders for up to 72 hours (3 days)
    //   This ensures members who missed the deadline still get reminded to contribute
    const LATE_REMINDER_WINDOW_HOURS = 72; // 3 days of late reminders
    
    const shouldSendContributionReminder = 
      (hoursUntilPayout > 0 && hoursUntilPayout <= this.reminderWindowHours) || // Before payout
      (hoursSincePayout > 0 && hoursSincePayout <= LATE_REMINDER_WINDOW_HOURS); // Late reminder window
    
    if (shouldSendContributionReminder) {
      const reminderType = hoursUntilPayout > 0 
        ? 'before_payout' 
        : hoursSincePayout <= 4 
          ? 'grace_period' 
          : 'late_reminder';
      appLogger.info('📨 Will attempt contribution reminder', {
        circleId: circleId.slice(0, 10),
        reason: reminderType,
        hoursOverdue: hoursSincePayout > 0 ? hoursSincePayout.toFixed(1) : 'N/A',
      });
      await this.sendContributionReminders(circleId, phoneNumber, circleData);
    } else {
      appLogger.info('⏭️ Skipping contribution reminder', {
        circleId: circleId.slice(0, 10),
        reason: hoursUntilPayout > this.reminderWindowHours 
          ? 'too_early' 
          : hoursSincePayout > LATE_REMINDER_WINDOW_HOURS 
            ? `too_late_${Math.round(hoursSincePayout)}h_overdue` 
            : 'unknown',
      });
    }

    // Check 2: Payout upcoming notification (24 hours before payout)
    // This notifies the group who's scheduled to receive the next payout
    const PAYOUT_UPCOMING_WINDOW_HOURS = 24;
    if (hoursUntilPayout > 0 && hoursUntilPayout <= PAYOUT_UPCOMING_WINDOW_HOURS) {
      appLogger.info('📨 Will attempt payout upcoming notification', {
        circleId: circleId.slice(0, 10),
        hoursUntilPayout: hoursUntilPayout.toFixed(1),
      });
      await this.sendPayoutUpcomingReminder(circleId, phoneNumber, circleData);
    }

    // Check 3: Admin payout trigger reminder (after payout time passes)
    if (hoursSincePayout > this.payoutGraceHours) {
      appLogger.info('📨 Will attempt payout trigger reminder', {
        circleId: circleId.slice(0, 10),
        hoursSincePayout: hoursSincePayout.toFixed(1),
      });
      await this.sendPayoutTriggerReminder(circleId, phoneNumber, circleData);
    } else if (hoursSincePayout > 0) {
      appLogger.info('⏭️ Payout time passed but within grace period', {
        circleId: circleId.slice(0, 10),
        hoursSincePayout: hoursSincePayout.toFixed(1),
        graceHoursRemaining: (this.payoutGraceHours - hoursSincePayout).toFixed(1),
      });
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
      appLogger.info('⏰ Contribution reminder in cooldown', {
        circleId: circleId.slice(0, 10),
        cycle: circleData.currentCycle,
        cooldownHours: this.reminderCooldownHours,
      });
      return;
    }

    try {
      // Get members who haven't contributed
      appLogger.info('📊 Checking contribution status for members', {
        circleId: circleId.slice(0, 10),
        totalMembers: circleData.members.length,
        currentCycle: circleData.currentCycle,
      });
      
      const nonContributors = await this.getMembersWhoHaventContributed(circleId, circleData);

      appLogger.info('📊 Non-contributors found', {
        circleId: circleId.slice(0, 10),
        nonContributorCount: nonContributors.length,
      });

      if (nonContributors.length === 0) {
        appLogger.info('✅ All members have contributed, no reminder needed', {
          circleId: circleId.slice(0, 10),
          cycle: circleData.currentCycle,
        });
        return;
      }

      // Current recipient doesn't need to contribute
      const currentRecipient = circleData.rotationOrder[circleData.currentPosition];
      const membersNeedingReminder = nonContributors.filter(m => m.address !== currentRecipient);

      appLogger.info('📊 Members needing reminder (excluding recipient)', {
        circleId: circleId.slice(0, 10),
        membersNeedingReminder: membersNeedingReminder.length,
        currentRecipient: currentRecipient?.slice(0, 10),
      });

      if (membersNeedingReminder.length === 0) {
        appLogger.info('✅ Only non-contributor is the current recipient, no reminder needed', {
          circleId: circleId.slice(0, 10),
        });
        return;
      }

      const now = Date.now();
      const hoursLeft = Math.round((circleData.nextPayoutTime - now) / (1000 * 60 * 60));
      const hoursOverdue = Math.round((now - circleData.nextPayoutTime) / (1000 * 60 * 60));
      const isLate = hoursLeft < 0;
      
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

      const templateName = isLate ? 'contribution_overdue' : 'contribution_reminder_payout';
      const templateParams = isLate 
        ? [
            { type: 'text' as const, text: circleData.name },
            { type: 'text' as const, text: String(circleData.currentCycle) },
            { type: 'text' as const, text: String(hoursOverdue) },
            { type: 'text' as const, text: pendingList },
          ]
        : [
            { type: 'text' as const, text: circleData.name },
            { type: 'text' as const, text: String(circleData.currentCycle) },
            { type: 'text' as const, text: payoutDate },
            { type: 'text' as const, text: String(hoursLeft) },
            { type: 'text' as const, text: pendingList },
          ];

      const result = await whatsappSender.sendMessage({
        to: adminPhone,
        type: 'template',
        template: {
          name: templateName,
          language: { code: 'en' },
          components: [
            {
              type: 'body',
              parameters: templateParams,
            },
            {
              type: 'button',
              sub_type: 'url',
              index: '0',
              parameters: [
                { type: 'text', text: circleId },
              ],
            },
          ],
        },
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
      appLogger.info('⏰ Payout trigger reminder in cooldown', {
        circleId: circleId.slice(0, 10),
        cycle: circleData.currentCycle,
        cooldownHours: this.reminderCooldownHours,
      });
      return;
    }

    try {
      // Check if payout has already been processed for this cycle
      appLogger.info('🔍 Checking if payout already processed...', {
        circleId: circleId.slice(0, 10),
        cycle: circleData.currentCycle,
      });
      
      const payoutProcessed = await this.checkIfPayoutProcessed(circleId, circleData.currentCycle);

      if (payoutProcessed) {
        appLogger.info('✅ Payout already processed, no reminder needed', {
          circleId: circleId.slice(0, 10),
          cycle: circleData.currentCycle,
        });
        return;
      }
      
      appLogger.info('📨 Payout not yet processed, sending reminder...', {
        circleId: circleId.slice(0, 10),
        cycle: circleData.currentCycle,
        adminPhone: adminPhone?.slice(0, 6) + '***',
      });

      const hoursSincePayout = Math.round((Date.now() - circleData.nextPayoutTime) / (1000 * 60 * 60));

      // Get current beneficiary
      const beneficiary = circleData.rotationOrder[circleData.currentPosition];
      const shortBeneficiary = beneficiary 
        ? `${beneficiary.slice(0, 6)}...${beneficiary.slice(-4)}`
        : 'Unknown';

      // Calculate payout amount (contribution × member count)
      const memberCount = circleData.memberCount || circleData.rotationOrder.length || 1;
      const payoutAmount = circleData.contributionAmount 
        ? `${(Number(circleData.contributionAmount) * memberCount / 1e9).toFixed(4)} SUI`
        : 'N/A';

      const result = await whatsappSender.sendMessage({
        to: adminPhone,
        type: 'template',
        template: {
          name: 'payout_trigger_reminder',
          language: { code: 'en' },
          components: [
            {
              type: 'body',
              parameters: [
                { type: 'text', text: circleData.name },
                { type: 'text', text: String(circleData.currentCycle) },
                { type: 'text', text: String(hoursSincePayout) },
                { type: 'text', text: shortBeneficiary },
                { type: 'text', text: payoutAmount },
              ],
            },
            {
              type: 'button',
              sub_type: 'url',
              index: '0',
              parameters: [
                { type: 'text', text: circleId },
              ],
            },
          ],
        },
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
   * Send payout upcoming notification to group
   * Notifies who is scheduled to receive the next payout
   */
  private async sendPayoutUpcomingReminder(
    circleId: string,
    adminPhone: string,
    circleData: CircleData
  ): Promise<void> {
    // Check cooldown for this reminder type
    const reminderKey = `payout_upcoming:${circleId}:cycle${circleData.currentCycle}`;
    if (this.isInCooldown(reminderKey)) {
      appLogger.info('⏰ Payout upcoming reminder in cooldown', {
        circleId: circleId.slice(0, 10),
        cycle: circleData.currentCycle,
        cooldownHours: this.reminderCooldownHours,
      });
      return;
    }

    try {
      // Get current beneficiary (who will receive the payout)
      const beneficiaryAddress = circleData.rotationOrder[circleData.currentPosition];
      if (!beneficiaryAddress) {
        appLogger.warn('No beneficiary found for payout upcoming notification', {
          circleId: circleId.slice(0, 10),
          currentPosition: circleData.currentPosition,
        });
        return;
      }

      const shortBeneficiary = `${beneficiaryAddress.slice(0, 6)}...${beneficiaryAddress.slice(-4)}`;

      // Look up beneficiary name from join requests
      let beneficiaryName = shortBeneficiary;
      try {
        const apiUrl = process.env.FRONTEND_URL || 'https://njangionchain.com';
        const response = await fetch(
          `${apiUrl}/api/join-requests/lookup-user?circleId=${encodeURIComponent(circleId)}&userAddress=${encodeURIComponent(beneficiaryAddress)}`
        );
        if (response.ok) {
          const data = await response.json() as { success: boolean; data?: { userName: string | null } };
          if (data.success && data.data?.userName) {
            beneficiaryName = data.data.userName;
          }
        }
      } catch (e) {
        // Use short address if lookup fails
      }

      // Calculate payout amount (contribution × member count)
      const memberCount = circleData.memberCount || circleData.rotationOrder.length || 1;
      const payoutAmount = circleData.contributionAmount 
        ? `${(Number(circleData.contributionAmount) * memberCount / 1e9).toFixed(4)} SUI`
        : 'N/A';

      // Format payout date
      const payoutDate = new Date(circleData.nextPayoutTime).toLocaleDateString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });

      // Use WhatsApp template for sending outside 24-hour window
      const result = await whatsappSender.sendMessage({
        to: adminPhone,
        type: 'template',
        template: {
          name: 'payout_upcoming',
          language: { code: 'en' },
          components: [
            {
              type: 'body',
              parameters: [
                { type: 'text', text: circleData.name },
                { type: 'text', text: beneficiaryName },
                { type: 'text', text: shortBeneficiary },
                { type: 'text', text: String(circleData.currentCycle) },
                { type: 'text', text: payoutAmount },
                { type: 'text', text: payoutDate },
              ],
            },
            {
              type: 'button',
              sub_type: 'url',
              index: '0',
              parameters: [
                { type: 'text', text: circleId },
              ],
            },
          ],
        },
      });

      if (result.success) {
        appLogger.info('✅ Payout upcoming notification sent', {
          circleId: circleId.slice(0, 10),
          cycle: circleData.currentCycle,
          beneficiaryName,
          payoutDate,
          messageId: result.messageId,
        });
        this.markReminderSent(reminderKey);
      } else {
        appLogger.warn('Failed to send payout upcoming notification', {
          circleId: circleId.slice(0, 10),
          error: result.error,
        });
      }
    } catch (error) {
      appLogger.error('Error sending payout upcoming notification', {
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
      // Derive package ID from circle object type
      let packageId = getConfig().sui.currentPackageId;
      try {
        const circleObj = await this.suiClient.getObject({ id: circleId, options: { showType: true } });
        if (circleObj.data?.type) {
          const match = circleObj.data.type.match(/^(0x[a-fA-F0-9]+)::/);
          if (match) packageId = match[1];
        }
      } catch { /* use default */ }
      
      appLogger.info('🔍 Checking contribution events', {
        circleId: circleId.slice(0, 10),
        cycle: circleData.currentCycle,
        packageId: packageId.slice(0, 12),
      });
      
      const [suiContributionEvents, stablecoinContributionEvents] = await Promise.all([
        this.suiClient.queryEvents({
          query: { MoveEventType: `${packageId}::njangi_payments::ContributionMade` },
          limit: 200,
        }),
        this.suiClient.queryEvents({
          query: { MoveEventType: `${packageId}::njangi_circles::StablecoinContributionMade` },
          limit: 200,
        }),
      ]);

      const contributionEvents = [
        ...(suiContributionEvents.data || []),
        ...(stablecoinContributionEvents.data || []),
      ];
      
      appLogger.info('📊 Contribution events query result', {
        circleId: circleId.slice(0, 10),
        suiEventsFound: suiContributionEvents.data.length,
        stablecoinEventsFound: stablecoinContributionEvents.data.length,
        eventsFound: contributionEvents.length,
      });

      // Find who contributed for this circle and cycle
      const contributedAddresses = new Set<string>();

      for (const event of contributionEvents) {
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
      
      appLogger.info('📊 Members who contributed this cycle', {
        circleId: circleId.slice(0, 10),
        contributedCount: contributedAddresses.size,
        totalMembers: circleData.members.length,
      });

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
      // Derive package ID from the circle object type
      let packageId = getConfig().sui.currentPackageId;
      try {
        const circleObj = await this.suiClient.getObject({ id: circleId, options: { showType: true } });
        if (circleObj.data?.type) {
          const match = circleObj.data.type.match(/^(0x[a-fA-F0-9]+)::/);
          if (match) packageId = match[1];
        }
      } catch { /* use default */ }
      
      appLogger.info('🔍 Checking PayoutProcessed events', {
        circleId: circleId.slice(0, 10),
        cycle,
        packageId: packageId.slice(0, 12),
      });
      
      const payoutEvents = await this.suiClient.queryEvents({
        query: { MoveEventType: `${packageId}::njangi_payments::PayoutProcessed` },
        limit: 100,
      });
      
      appLogger.info('📊 Payout events query result', {
        circleId: circleId.slice(0, 10),
        eventsFound: payoutEvents.data.length,
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
            appLogger.info('✅ Payout already processed for this cycle', {
              circleId: circleId.slice(0, 10),
              cycle,
            });
            return true;
          }
        }
      }

      appLogger.info('❌ No payout found for cycle', {
        circleId: circleId.slice(0, 10),
        cycle,
      });
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
