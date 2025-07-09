import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { Transaction as TransactionBlock } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { fromHEX } from '@mysten/sui/utils';
import { WhatsAppNotificationService } from './whatsapp-notification.service';
import { circleMemberManager } from './circle-member-manager.service';
import { automationAuditLogger } from './automation-audit-logger.service';
import { automationAdminAlertsService } from './automation-admin-alerts.service';
import { PACKAGE_ID } from './constants';

// Automation status and types
export interface AutomationStatus {
  is_overdue: boolean;
  time_until_payout: string; // bigint as string
  is_ready_for_payout: boolean;
  all_members_contributed: boolean;
  warning_level: number; // 0=none, 1=24h, 2=6h, 3=1h, 4=overdue
}

export interface CircleInfo {
  id: string;
  admin: string;
  is_active: boolean;
  next_payout_time: string; // bigint as string
  current_cycle: string; // bigint as string
  paused_after_cycle: boolean;
}

export interface AutomationMetrics {
  totalCirclesProcessed: number;
  payoutsTriggered: number;
  notificationsSent: number;
  errors: number;
  uptime: number;
  lastRunTime: Date | null;
  nextRunTime: Date | null;
}

/**
 * 🤖 Automation Cron Service
 * 
 * Automated blockchain time tracking and payout system that:
 * - Monitors all active Njangi circles every 5 minutes
 * - Triggers automatic payouts when deadlines pass
 * - Sends progressive WhatsApp notifications (24h, 6h, 1h warnings)
 * - Provides comprehensive error handling and retry logic
 * - Maintains audit trails and monitoring capabilities
 */
export class AutomationCronService {
  private static instance: AutomationCronService;
  
  // Core services
  private suiClient: SuiClient;
  private adminKeypair: Ed25519Keypair | null = null;
  private notificationService: WhatsAppNotificationService;
  
  // Cron intervals
  private payoutCheckInterval: NodeJS.Timeout | null = null;
  private notificationInterval: NodeJS.Timeout | null = null;
  private healthCheckInterval: NodeJS.Timeout | null = null;
  
  // Configuration
  private readonly PAYOUT_CHECK_INTERVAL = 5 * 60 * 1000; // 5 minutes
  private readonly NOTIFICATION_INTERVAL = 60 * 60 * 1000; // 1 hour  
  private readonly HEALTH_CHECK_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours
  private readonly MAX_RETRIES = 3;
  private readonly RETRY_DELAY_BASE = 2000; // 2 seconds base delay
  
  // State tracking
  private isRunning: boolean = false;
  private emergencyStop: boolean = false;
  private metrics: AutomationMetrics;
  private activeCircles: Map<string, CircleInfo> = new Map();
  private retryQueue: Map<string, { attempts: number; nextRetry: Date; error: string }> = new Map();
  
  private constructor() {
    // Initialize SUI client
    this.suiClient = new SuiClient({ 
      url: getFullnodeUrl(process.env.NODE_ENV === 'production' ? 'mainnet' : 'testnet') 
    });
    
    // Initialize notification service
    this.notificationService = WhatsAppNotificationService.getInstance();
    
    // Initialize metrics
    this.metrics = {
      totalCirclesProcessed: 0,
      payoutsTriggered: 0,
      notificationsSent: 0,
      errors: 0,
      uptime: 0,
      lastRunTime: null,
      nextRunTime: null
    };
    
    // Initialize admin keypair if available
    this.initializeAdminKeypair();
    
    automationAuditLogger.logEvent(
      'system_started',
      'info',
      'automation-cron',
      'AutomationCronService initialized',
      {
        payoutCheckInterval: this.PAYOUT_CHECK_INTERVAL,
        notificationInterval: this.NOTIFICATION_INTERVAL,
        healthCheckInterval: this.HEALTH_CHECK_INTERVAL
      }
    );
  }

  public static getInstance(): AutomationCronService {
    if (!AutomationCronService.instance) {
      AutomationCronService.instance = new AutomationCronService();
    }
    return AutomationCronService.instance;
  }

  /**
   * 🚀 START: Start all automation processes
   */
  public async start(): Promise<void> {
    if (this.isRunning) {
      automationAuditLogger.logEvent(
        'system_started',
        'warn',
        'automation-cron',
        'Automation service is already running',
        { isRunning: this.isRunning }
      );
      return;
    }

    if (!this.adminKeypair) {
      const error = new Error('Admin keypair not configured. Set ADMIN_PRIVATE_KEY environment variable.');
      automationAuditLogger.logEvent(
        'system_started',
        'error',
        'automation-cron',
        'Failed to start automation service',
        { reason: 'Missing admin keypair' },
        { error }
      );
      throw error;
    }

    automationAuditLogger.logEvent(
      'system_started',
      'info',
      'automation-cron',
      'Starting Automation Cron Service',
      {
        payoutInterval: this.PAYOUT_CHECK_INTERVAL,
        notificationInterval: this.NOTIFICATION_INTERVAL,
        healthInterval: this.HEALTH_CHECK_INTERVAL
      }
    );
    
    this.isRunning = true;
    this.emergencyStop = false;
    
    // Start main payout checking (every 5 minutes)
    this.payoutCheckInterval = setInterval(() => {
      this.checkAndExecutePayouts().catch(error => {
        automationAuditLogger.logEvent(
          'payout_failed',
          'error',
          'automation-cron',
          'Error in payout check cycle',
          { errorMessage: error instanceof Error ? error.message : String(error) },
          { error: error instanceof Error ? error : undefined }
        );
        this.metrics.errors++;
      });
    }, this.PAYOUT_CHECK_INTERVAL);

    // Start notification checking (every hour)
    this.notificationInterval = setInterval(() => {
      this.sendTimeBasedNotifications().catch(error => {
        automationAuditLogger.logEvent(
          'notification_failed',
          'error',
          'automation-cron',
          'Error in notification cycle',
          { errorMessage: error instanceof Error ? error.message : String(error) },
          { error: error instanceof Error ? error : undefined }
        );
        this.metrics.errors++;
      });
    }, this.NOTIFICATION_INTERVAL);

    // Start health checking (daily)
    this.healthCheckInterval = setInterval(() => {
      this.validateSystemHealth().catch(error => {
        automationAuditLogger.logEvent(
          'health_check_failed',
          'error',
          'automation-cron',
          'Error in health check',
          { errorMessage: error instanceof Error ? error.message : String(error) },
          { error: error instanceof Error ? error : undefined }
        );
        this.metrics.errors++;
      });
    }, this.HEALTH_CHECK_INTERVAL);

    // Set next run time
    this.metrics.nextRunTime = new Date(Date.now() + this.PAYOUT_CHECK_INTERVAL);
    
    // Run initial checks
    await this.discoverActiveCircles();
    await this.checkAndExecutePayouts();
    
    automationAuditLogger.logEvent(
      'system_started',
      'info',
      'automation-cron',
      'Automation Cron Service started successfully',
      {
        activeCircles: this.activeCircles.size,
        nextRunTime: this.metrics.nextRunTime,
        isRunning: this.isRunning
      }
    );
  }

  /**
   * 🛑 STOP: Stop all automation processes
   */
  public stop(): void {
    automationAuditLogger.logEvent(
      'system_stopped',
      'info',
      'automation-cron',
      'Stopping Automation Cron Service',
      { isRunning: this.isRunning }
    );
    
    this.isRunning = false;
    
    if (this.payoutCheckInterval) {
      clearInterval(this.payoutCheckInterval);
      this.payoutCheckInterval = null;
    }
    
    if (this.notificationInterval) {
      clearInterval(this.notificationInterval);
      this.notificationInterval = null;
    }
    
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
    
    automationAuditLogger.logEvent(
      'system_stopped',
      'info',
      'automation-cron',
      'Automation Cron Service stopped successfully',
      { 
        finalMetrics: this.metrics,
        activeCircles: this.activeCircles.size,
        retryQueue: this.retryQueue.size
      }
    );
  }

  /**
   * 🚨 EMERGENCY STOP: Immediately halt all automation
   */
  public emergencyStopAll(): void {
    automationAuditLogger.logEvent(
      'emergency_stop',
      'warn',
      'automation-cron',
      'EMERGENCY STOP ACTIVATED - Halting all automation',
      { 
        isRunning: this.isRunning,
        activeCircles: this.activeCircles.size,
        retryQueue: this.retryQueue.size 
      }
    );
    
    // Trigger admin alert for emergency stop
    automationAdminAlertsService.triggerAlert(
      'automation_stopped',
      'critical',
      'Emergency Stop Activated',
      'Automation system has been emergency stopped',
      { 
        timestamp: new Date().toISOString(),
        activeCircles: this.activeCircles.size,
        retryQueue: this.retryQueue.size 
      },
      { source: 'automation-cron' }
    );
    
    this.emergencyStop = true;
    this.stop();
    
    // Clear retry queue
    this.retryQueue.clear();
    
    automationAuditLogger.logEvent(
      'emergency_stop',
      'warn',
      'automation-cron',
      'Emergency stop complete - All automation halted',
      { emergencyStop: this.emergencyStop }
    );
  }

  /**
   * 💰 MAIN PAYOUT LOGIC: Check and execute overdue payouts
   */
  private async checkAndExecutePayouts(): Promise<void> {
    if (this.emergencyStop) {
      automationAuditLogger.logEvent(
        'payout_triggered',
        'info',
        'automation-cron',
        'Skipping payout check - emergency stop active',
        { emergencyStop: this.emergencyStop }
      );
      return;
    }

    const sessionId = `payout_check_${Date.now()}`;
    automationAuditLogger.startSession(sessionId, { operation: 'payout_check' });

    try {
      this.metrics.lastRunTime = new Date();
      this.metrics.nextRunTime = new Date(Date.now() + this.PAYOUT_CHECK_INTERVAL);
      
      // Discover/refresh active circles
      await this.discoverActiveCircles();
      
      // Check each circle for overdue payouts
      const overdueCircles = await this.identifyOverdueCircles();
      
      if (overdueCircles.length === 0) {
        automationAuditLogger.endSession(
          sessionId,
          'payout_triggered',
          'No overdue payouts found',
          'success',
          { circlesChecked: this.activeCircles.size }
        );
        return;
      }

      automationAuditLogger.logEvent(
        'payout_triggered',
        'info',
        'automation-cron',
        `Found ${overdueCircles.length} circles ready for automated payout`,
        { 
          overdueCircles: overdueCircles.length,
          totalCircles: this.activeCircles.size 
        }
      );

      // Process each overdue circle
      for (const circleId of overdueCircles) {
        await this.executeAutomatedPayout(circleId);
      }
      
      automationAuditLogger.endSession(
        sessionId,
        'payout_triggered',
        'Payout check cycle completed',
        'success',
        { overdueCircles: overdueCircles.length }
      );
      
    } catch (error) {
      this.metrics.errors++;
      
      automationAuditLogger.endSession(
        sessionId,
        'payout_failed',
        'Payout check cycle failed',
        'failure',
        { errorMessage: error instanceof Error ? error.message : String(error) }
      );
      
      // Trigger admin alert for critical payout errors
      if (this.metrics.errors > 5) {
        await automationAdminAlertsService.triggerAlert(
          'high_error_rate',
          'high',
          'High Error Rate in Automation',
          `Automation service has encountered ${this.metrics.errors} errors`,
          { errors: this.metrics.errors, lastError: error instanceof Error ? error.message : String(error) },
          { source: 'automation-cron' }
        );
      }
    }
  }

  /**
   * 🔔 NOTIFICATION LOGIC: Send time-based warnings
   */
  private async sendTimeBasedNotifications(): Promise<void> {
    if (this.emergencyStop) {
      automationAuditLogger.logEvent(
        'notification_sent',
        'info',
        'automation-cron',
        'Skipping notifications - emergency stop active',
        { emergencyStop: this.emergencyStop }
      );
      return;
    }

    const sessionId = `notification_cycle_${Date.now()}`;
    automationAuditLogger.startSession(sessionId, { operation: 'notification_cycle' });
    
    let notificationsSent = 0;
    
    try {
      for (const [circleId] of this.activeCircles) {
        const automationStatus = await this.getCircleAutomationStatus(circleId);
        
        if (!automationStatus) continue;

        // Send warnings based on warning level
        if (automationStatus.warning_level > 0 && automationStatus.warning_level < 4) {
          await this.sendPayoutWarning(circleId, automationStatus.warning_level);
          notificationsSent++;
        }
      }
      
      automationAuditLogger.endSession(
        sessionId,
        'notification_sent',
        'Notification cycle completed',
        'success',
        { notificationsSent }
      );
      
    } catch (error) {
      this.metrics.errors++;
      
      automationAuditLogger.endSession(
        sessionId,
        'notification_failed',
        'Notification cycle failed',
        'failure',
        { errorMessage: error instanceof Error ? error.message : String(error) }
      );
    }
  }

  /**
   * 🏥 HEALTH CHECK: Daily system validation
   */
  private async validateSystemHealth(): Promise<void> {
    const sessionId = `health_check_${Date.now()}`;
    automationAuditLogger.startSession(sessionId, { operation: 'health_check' });
    
    try {
      // Check blockchain connectivity
      const latestBlock = await this.suiClient.getLatestSuiSystemState();
      
      automationAuditLogger.logEvent(
        'health_check_passed',
        'info',
        'automation-cron',
        'Blockchain connectivity OK',
        { epoch: latestBlock.epoch }
      );
      
      // Check admin keypair
      if (!this.adminKeypair) {
        throw new Error('Admin keypair not available');
      }
      
      // Validate active circles
      await this.discoverActiveCircles();
      
      // Check retry queue health
      const retryCount = this.retryQueue.size;
      if (retryCount > 10) {
        automationAuditLogger.logEvent(
          'performance_warning',
          'warn',
          'automation-cron',
          'High retry queue count - may indicate systemic issues',
          { retryCount }
        );
        
        await automationAdminAlertsService.triggerAlert(
          'performance_degradation',
          'medium',
          'High Retry Queue Count',
          `Retry queue has ${retryCount} items, indicating potential systemic issues`,
          { retryCount },
          { source: 'automation-cron' }
        );
      }
      
      automationAuditLogger.endSession(
        sessionId,
        'health_check_passed',
        'Daily health check passed',
        'success',
        { 
          activeCircles: this.activeCircles.size,
          retryQueue: retryCount,
          metrics: this.metrics
        }
      );
      
    } catch (error) {
      automationAuditLogger.endSession(
        sessionId,
        'health_check_failed',
        'Health check failed',
        'failure',
        { errorMessage: error instanceof Error ? error.message : String(error) }
      );
      
      await automationAdminAlertsService.triggerAlert(
        'system_failure',
        'critical',
        'Health Check Failed',
        'Daily health check has failed',
        { error: error instanceof Error ? error.message : String(error) },
        { source: 'automation-cron' }
      );
      
      throw error;
    }
  }

  /**
   * 🔍 CIRCLE DISCOVERY: Find all active circles
   */
  private async discoverActiveCircles(): Promise<void> {
    try {
      automationAuditLogger.logEvent(
        'circle_discovered',
        'debug',
        'automation-cron',
        'Discovering active circles',
        {}
      );
      
      // Query CircleCreated events to find all circles
      const events = await this.suiClient.queryEvents({
        query: { MoveEventType: `${PACKAGE_ID}::njangi_circles::CircleCreated` },
        limit: 1000, // Adjust based on expected number of circles
        order: 'descending'
      });

      const circleIds = events.data.map(event => 
        (event.parsedJson as { circle_id?: string })?.circle_id
      ).filter(Boolean);

      automationAuditLogger.logEvent(
        'circle_discovered',
        'debug',
        'automation-cron',
        `Found ${circleIds.length} total circles`,
        { totalCircles: circleIds.length }
      );

      // Get current circle data and filter for active ones
      for (const circleId of circleIds) {
        try {
          const circleObject = await this.suiClient.getObject({
            id: circleId!,
            options: { showContent: true }
          });

          if (circleObject.data?.content?.dataType === 'moveObject') {
            const fields = circleObject.data.content.fields as Record<string, string | boolean | number>;
            
            const circleInfo: CircleInfo = {
              id: circleId!,
              admin: String(fields.admin),
              is_active: Boolean(fields.is_active),
              next_payout_time: String(fields.next_payout_time),
              current_cycle: String(fields.current_cycle),
              paused_after_cycle: Boolean(fields.paused_after_cycle)
            };

            // Only track active, non-paused circles
            if (circleInfo.is_active && !circleInfo.paused_after_cycle) {
              this.activeCircles.set(circleId!, circleInfo);
            } else if (this.activeCircles.has(circleId!)) {
              // Remove inactive circles from tracking
              this.activeCircles.delete(circleId!);
            }
          }
        } catch (error) {
          automationAuditLogger.logEvent(
            'circle_discovered',
            'warn',
            'automation-cron',
            `Failed to fetch circle ${circleId}`,
            { 
              circleId,
              errorMessage: error instanceof Error ? error.message : String(error)
            },
            { error: error instanceof Error ? error : undefined }
          );
        }
      }

      automationAuditLogger.logEvent(
        'circle_discovered',
        'info',
        'automation-cron',
        `Tracking ${this.activeCircles.size} active circles`,
        { activeCircles: this.activeCircles.size }
      );
      
    } catch (error) {
      automationAuditLogger.logEvent(
        'circle_discovered',
        'error',
        'automation-cron',
        'Error discovering active circles',
        { errorMessage: error instanceof Error ? error.message : String(error) },
        { error: error instanceof Error ? error : undefined }
      );
      throw error;
    }
  }

  /**
   * ⏰ OVERDUE DETECTION: Identify circles ready for payout
   */
  private async identifyOverdueCircles(): Promise<string[]> {
    const overdueCircles: string[] = [];
    
    for (const [circleId] of this.activeCircles) {
      try {
        const isReady = await this.isCircleReadyForAutomatedPayout(circleId);
        
        if (isReady) {
          // Check if we've already failed on this circle recently
          const retryInfo = this.retryQueue.get(circleId);
          if (retryInfo && retryInfo.nextRetry > new Date()) {
            automationAuditLogger.logEvent(
              'payout_triggered',
              'debug',
              'automation-cron',
              `Skipping circle ${circleId} - waiting for retry cooldown`,
              { circleId, nextRetry: retryInfo.nextRetry }
            );
            continue;
          }
          
          overdueCircles.push(circleId);
        }
        
      } catch (error) {
        automationAuditLogger.logEvent(
          'payout_failed',
          'warn',
          'automation-cron',
          `Error checking circle ${circleId} readiness`,
          { 
            circleId,
            errorMessage: error instanceof Error ? error.message : String(error)
          },
          { error: error instanceof Error ? error : undefined }
        );
      }
    }
    
    return overdueCircles;
  }

  /**
   * 🔔 PAYOUT APPROVAL REQUEST: Send approval request to circle admin instead of auto-executing
   */
  private async executeAutomatedPayout(circleId: string): Promise<void> {
    const circleInfo = this.activeCircles.get(circleId);
    if (!circleInfo) {
      automationAuditLogger.logEvent(
        'payout_failed',
        'warn',
        'automation-cron',
        `Circle ${circleId} not found in active circles`,
        { circleId }
      );
      return;
    }

    const sessionId = `payout_approval_${circleId}_${Date.now()}`;
    automationAuditLogger.startSession(sessionId, { operation: 'payout_approval_request', circleId });
    
        try {
      // Create simple approval link (no tokens needed!)
      const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000';
      const approvalLink = `${baseUrl}/circle/${circleId}/admin-payout`;
      
      // Get circle admin's phone number
      const adminPhoneNumber = await this.getCircleAdminPhoneNumber(circleId);
      
      if (adminPhoneNumber) {
        // Send WhatsApp notification with approval button to admin
        // Use existing payout warning method to send approval request
        await this.notificationService.sendPayoutWarning(
          adminPhoneNumber,
          circleId,
          4, // Warning level 4 = overdue/immediate action required
          {
            circleId,
            contributionAmount: 0, // TODO: Get actual contribution amount
            currency: 'USDC',
            timeRemaining: '0',
            allMembersContributed: true,
            approvalLink // Add approval link to warning data
          }
        );
        
        this.metrics.notificationsSent++;
        
        automationAuditLogger.endSession(
          sessionId,
          'notification_sent',
          'Payout approval request sent to admin',
          'success',
          { 
            circleId,
            adminPhoneNumber: adminPhoneNumber.replace(/(\d{3})\d{4}(\d{4})/, '$1****$2'), // Mask phone number
            approvalLink,
            notificationsSent: this.metrics.notificationsSent
          }
        );
        
      } else {
        throw new Error(`Admin phone number not found for circle ${circleId}`);
      }
      
    } catch (error) {
      this.metrics.errors++;
      
      // Add to retry queue
      const errorMessage = error instanceof Error ? error.message : String(error);
      await this.addToRetryQueue(circleId, errorMessage);
      
      automationAuditLogger.endSession(
        sessionId,
        'notification_failed',
        'Failed to send payout approval request',
        'failure',
        { 
          circleId,
          errorMessage,
          errors: this.metrics.errors
        }
      );
    }
  }



  /**
   * 📱 Get circle admin's phone number
   */
  private async getCircleAdminPhoneNumber(circleId: string): Promise<string | null> {
    try {
      const circleInfo = this.activeCircles.get(circleId);
      if (!circleInfo) return null;
      
      // Get all circle members phone numbers
      // Note: This is a simplified approach - in a real implementation,
      // you would need a method to specifically get the admin's phone number
      const memberPhoneNumbers = await circleMemberManager.getCircleMemberPhoneNumbers(circleId);
      
      // For now, return the first member's phone number as a placeholder
      // TODO: Implement proper admin phone number lookup
      return memberPhoneNumbers.length > 0 ? memberPhoneNumbers[0] : null;
      
    } catch (error) {
      automationAuditLogger.logEvent(
        'circle_status_changed',
        'error',
        'automation-cron',
        `Error getting admin phone number for circle ${circleId}`,
        { 
          circleId,
          errorMessage: error instanceof Error ? error.message : String(error)
        },
        { error: error instanceof Error ? error : undefined }
      );
      return null;
    }
  }

  // ===========================================
  // HELPER METHODS
  // ===========================================

  /**
   * Check if circle is ready for automated payout
   */
  private async isCircleReadyForAutomatedPayout(circleId: string): Promise<boolean> {
    try {
      const tx = new TransactionBlock();
      
      const [clock] = tx.moveCall({
        target: '0x6::clock::share',
        arguments: [],
      });

      // Call the smart contract function we implemented
      tx.moveCall({
        target: `${PACKAGE_ID}::njangi_circles::is_circle_ready_for_automated_payout`,
        arguments: [
          tx.object(circleId),
          clock,
        ],
      });

      // Simulate transaction to get result
      const result = await this.suiClient.devInspectTransactionBlock({
        transactionBlock: tx,
        sender: this.adminKeypair!.getPublicKey().toSuiAddress(),
      });

      // Parse result - checking if the transaction succeeded and has return values
      if (result.effects.status.status === 'success' && result.results?.[0]?.returnValues?.[0]) {
        const returnValue = result.results[0].returnValues[0];
        // The return value is a byte array where first element represents boolean
        const bytes = Array.isArray(returnValue) ? returnValue[0] : returnValue;
        const isReady = Array.isArray(bytes) ? bytes[0] === 1 : bytes === 1;
        return isReady;
      }
      
      return false;
      
    } catch (error) {
      automationAuditLogger.logEvent(
        'blockchain_interaction',
        'warn',
        'automation-cron',
        `Error checking if circle ${circleId} is ready for payout`,
        { 
          circleId,
          errorMessage: error instanceof Error ? error.message : String(error)
        },
        { error: error instanceof Error ? error : undefined }
      );
      return false;
    }
  }

  /**
   * Get automation status for a circle
   */
  private async getCircleAutomationStatus(circleId: string): Promise<AutomationStatus | null> {
    try {
      const tx = new TransactionBlock();
      
      const [clock] = tx.moveCall({
        target: '0x6::clock::share',
        arguments: [],
      });

      tx.moveCall({
        target: `${PACKAGE_ID}::njangi_circles::get_automation_status`,
        arguments: [
          tx.object(circleId),
          clock,
        ],
      });

      const result = await this.suiClient.devInspectTransactionBlock({
        transactionBlock: tx,
        sender: this.adminKeypair!.getPublicKey().toSuiAddress(),
      });

      if (result.effects.status.status === 'success' && result.results?.[0]?.returnValues?.[0]) {
        // Parse the AutomationStatus struct from byte array
        const returnValue = result.results[0].returnValues[0];
        
        // Handle the byte array structure returned by Sui
        const bytes = Array.isArray(returnValue) ? returnValue[0] : returnValue;
        
        if (Array.isArray(bytes) && bytes.length >= 5) {
          return {
            is_overdue: bytes[0] === 1,
            time_until_payout: bytes[1]?.toString() || '0',
            is_ready_for_payout: bytes[2] === 1,
            all_members_contributed: bytes[3] === 1,
            warning_level: bytes[4] || 0
          };
        }
      }
      
      return null;
      
    } catch (error) {
      automationAuditLogger.logEvent(
        'blockchain_interaction',
        'warn',
        'automation-cron',
        `Error getting automation status for circle ${circleId}`,
        { 
          circleId,
          errorMessage: error instanceof Error ? error.message : String(error)
        },
        { error: error instanceof Error ? error : undefined }
      );
      return null;
    }
  }

  /**
   * Find custody wallet for a circle
   */
  private async getCircleCustodyWallet(circleId: string): Promise<string | null> {
    try {
      // Query CustodyWalletCreated events for this circle
      const events = await this.suiClient.queryEvents({
        query: { MoveEventType: `${PACKAGE_ID}::njangi_custody::CustodyWalletCreated` },
        limit: 100
      });

      for (const event of events.data) {
        const eventData = event.parsedJson as { circle_id?: string; wallet_id?: string };
        if (eventData.circle_id === circleId) {
          return eventData.wallet_id || null;
        }
      }
      
      return null;
      
    } catch (error) {
      automationAuditLogger.logEvent(
        'blockchain_interaction',
        'warn',
        'automation-cron',
        `Error finding custody wallet for circle ${circleId}`,
        { 
          circleId,
          errorMessage: error instanceof Error ? error.message : String(error)
        },
        { error: error instanceof Error ? error : undefined }
      );
      return null;
    }
  }

  /**
   * Send payout warning notification
   */
  private async sendPayoutWarning(circleId: string, warningLevel: number): Promise<void> {
    try {
      const memberPhoneNumbers = await this.getCircleMemberPhoneNumbers(circleId);
      
      if (memberPhoneNumbers.length === 0) {
        automationAuditLogger.logEvent(
          'notification_failed',
          'warn',
          'automation-cron',
          `No phone numbers found for circle ${circleId} - skipping warning notifications`,
          { circleId, warningLevel }
        );
        return;
      }

      // Get automation status for additional context
      const automationStatus = await this.getCircleAutomationStatus(circleId);
      
      const warningData = {
        circleId,
        contributionAmount: 100, // TODO: Get actual contribution amount from circle data
        currency: 'USDC',
        timeRemaining: automationStatus?.time_until_payout || '0',
        allMembersContributed: automationStatus?.all_members_contributed || false
      };

      // Send warning to all members
      const promises = memberPhoneNumbers.map(phoneNumber =>
        this.notificationService.sendPayoutWarning(phoneNumber, circleId, warningLevel, warningData)
      );

      const results = await Promise.allSettled(promises);
      const successful = results.filter(r => r.status === 'fulfilled' && r.value).length;
      
      this.metrics.notificationsSent += successful;
      
      const warningLabels = ['', '24 hours', '6 hours', '1 hour'];
      const warningText = warningLabels[warningLevel] || 'unknown time';
      
      automationAuditLogger.logEvent(
        'notification_sent',
        'info',
        'automation-cron',
        `Sent ${warningText} warning to ${successful}/${memberPhoneNumbers.length} members of circle ${circleId}`,
        {
          circleId,
          warningLevel,
          warningText,
          successful,
          total: memberPhoneNumbers.length,
          notificationsSent: this.metrics.notificationsSent
        }
      );
      
    } catch (error) {
      automationAuditLogger.logEvent(
        'notification_failed',
        'error',
        'automation-cron',
        `Error sending warning for circle ${circleId}`,
        { 
          circleId,
          warningLevel,
          errorMessage: error instanceof Error ? error.message : String(error)
        },
        { error: error instanceof Error ? error : undefined }
      );
    }
  }

  /**
   * Notify members of successful payout
   */
  private async notifyPayoutSuccess(circleId: string, payoutAmount?: number, recipientAddress?: string, transactionHash?: string): Promise<void> {
    try {
      const memberPhoneNumbers = await this.getCircleMemberPhoneNumbers(circleId);
      
      if (memberPhoneNumbers.length === 0) {
        automationAuditLogger.logEvent(
          'notification_failed',
          'warn',
          'automation-cron',
          `No phone numbers found for circle ${circleId} - skipping success notifications`,
          { circleId, transactionHash }
        );
        return;
      }

      // Send success notification to all members
      const promises = memberPhoneNumbers.map(phoneNumber =>
        this.notificationService.sendAutomatedPayoutSuccess(
          phoneNumber,
          circleId,
          payoutAmount || 0, // TODO: Get actual payout amount from transaction
          'USDC',
          recipientAddress || 'Circle Member',
          transactionHash
        )
      );

      const results = await Promise.allSettled(promises);
      const successful = results.filter(r => r.status === 'fulfilled' && r.value).length;
      
      this.metrics.notificationsSent += successful;
      
      automationAuditLogger.logEvent(
        'notification_sent',
        'info',
        'automation-cron',
        `Sent payout success notification to ${successful}/${memberPhoneNumbers.length} members of circle ${circleId}`,
        {
          circleId,
          transactionHash,
          successful,
          total: memberPhoneNumbers.length,
          notificationsSent: this.metrics.notificationsSent
        }
      );
      
    } catch (error) {
      automationAuditLogger.logEvent(
        'notification_failed',
        'error',
        'automation-cron',
        `Error sending payout success notification for circle ${circleId}`,
        { 
          circleId,
          transactionHash,
          errorMessage: error instanceof Error ? error.message : String(error)
        },
        { error: error instanceof Error ? error : undefined }
      );
    }
  }

  /**
   * Get member phone numbers for a circle
   */
  private async getCircleMemberPhoneNumbers(circleId: string): Promise<string[]> {
    try {
      return await circleMemberManager.getCircleMemberPhoneNumbers(circleId);
    } catch (error) {
      automationAuditLogger.logEvent(
        'circle_status_changed',
        'error',
        'automation-cron',
        `Error getting member phone numbers for circle ${circleId}`,
        { 
          circleId,
          errorMessage: error instanceof Error ? error.message : String(error)
        },
        { error: error instanceof Error ? error : undefined }
      );
      return [];
    }
  }

  /**
   * Add circle to retry queue with exponential backoff
   */
  private async addToRetryQueue(circleId: string, error: string): Promise<void> {
    const existing = this.retryQueue.get(circleId) || { attempts: 0, nextRetry: new Date(), error: '' };
    
    existing.attempts++;
    existing.error = error;
    
    if (existing.attempts >= this.MAX_RETRIES) {
      // Max retries reached, remove from queue and alert admin
      this.retryQueue.delete(circleId);
      
      automationAuditLogger.logEvent(
        'retry_attempted',
        'error',
        'automation-cron',
        `Circle ${circleId} failed after ${this.MAX_RETRIES} attempts. Manual intervention required.`,
        { circleId, attempts: existing.attempts, error }
      );
      
      // Send admin alert for manual intervention
      await automationAdminAlertsService.triggerAlert(
        'manual_intervention_required',
        'high',
        'Circle Payout Failed - Manual Intervention Required',
        `Circle ${circleId} has failed after ${this.MAX_RETRIES} retry attempts and requires manual intervention`,
        { 
          circleId, 
          attempts: existing.attempts, 
          lastError: error,
          timestamp: new Date().toISOString()
        },
        { source: 'automation-cron', circleId }
      );
      
    } else {
      // Schedule next retry with exponential backoff
      const delayMs = this.RETRY_DELAY_BASE * Math.pow(2, existing.attempts - 1);
      existing.nextRetry = new Date(Date.now() + delayMs);
      
      this.retryQueue.set(circleId, existing);
      
      automationAuditLogger.logEvent(
        'retry_attempted',
        'warn',
        'automation-cron',
        `Circle ${circleId} added to retry queue (attempt ${existing.attempts}/${this.MAX_RETRIES})`,
        { 
          circleId, 
          attempts: existing.attempts, 
          maxRetries: this.MAX_RETRIES,
          nextRetry: existing.nextRetry,
          error
        }
      );
    }
  }

  /**
   * Initialize admin keypair from environment
   */
  private initializeAdminKeypair(): void {
    try {
      const privateKeyHex = process.env.ADMIN_PRIVATE_KEY;
      if (!privateKeyHex) {
        automationAuditLogger.logEvent(
          'configuration_changed',
          'warn',
          'automation-cron',
          'ADMIN_PRIVATE_KEY not set - automation service will not be able to execute transactions',
          { hasPrivateKey: false }
        );
        return;
      }

      const privateKeyBytes = fromHEX(privateKeyHex);
      this.adminKeypair = Ed25519Keypair.fromSecretKey(privateKeyBytes);
      
      automationAuditLogger.logEvent(
        'configuration_changed',
        'info',
        'automation-cron',
        'Admin keypair initialized successfully',
        { 
          adminAddress: this.adminKeypair.getPublicKey().toSuiAddress(),
          hasPrivateKey: true
        }
      );
      
    } catch (error) {
      this.adminKeypair = null;
      
      automationAuditLogger.logEvent(
        'configuration_changed',
        'error',
        'automation-cron',
        'Failed to initialize admin keypair',
        { 
          hasPrivateKey: !!process.env.ADMIN_PRIVATE_KEY,
          errorMessage: error instanceof Error ? error.message : String(error)
        },
        { error: error instanceof Error ? error : undefined }
      );
    }
  }

  // ===========================================
  // PUBLIC API
  // ===========================================

  /**
   * Get current metrics
   */
  public getMetrics(): AutomationMetrics & { 
    isRunning: boolean; 
    emergencyStop: boolean;
    activeCircles: number;
    retryQueueSize: number;
  } {
    return {
      ...this.metrics,
      uptime: this.isRunning ? Date.now() - (this.metrics.lastRunTime?.getTime() || Date.now()) : 0,
      isRunning: this.isRunning,
      emergencyStop: this.emergencyStop,
      activeCircles: this.activeCircles.size,
      retryQueueSize: this.retryQueue.size
    };
  }

  /**
   * Get active circles info
   */
  public getActiveCircles(): Map<string, CircleInfo> {
    return new Map(this.activeCircles);
  }

  /**
   * Get retry queue status
   */
  public getRetryQueue(): Array<{ circleId: string; attempts: number; nextRetry: Date; error: string }> {
    return Array.from(this.retryQueue.entries()).map(([circleId, info]) => ({
      circleId,
      ...info
    }));
  }

  /**
   * Force check a specific circle
   */
  public async forceCheckCircle(circleId: string): Promise<{ success: boolean; message: string }> {
    try {
      if (this.emergencyStop) {
        return { success: false, message: 'Emergency stop is active' };
      }

      const isReady = await this.isCircleReadyForAutomatedPayout(circleId);
      
      if (isReady) {
        await this.executeAutomatedPayout(circleId);
        return { success: true, message: 'Payout executed successfully' };
      } else {
        return { success: false, message: 'Circle is not ready for payout' };
      }
      
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      automationAuditLogger.logEvent(
        'admin_action',
        'error',
        'automation-cron',
        `Error in force check for circle ${circleId}`,
        { circleId, errorMessage },
        { error: error instanceof Error ? error : undefined }
      );
      
      return { success: false, message: errorMessage };
    }
  }

  /**
   * Resume from emergency stop
   */
  public async resumeFromEmergencyStop(): Promise<void> {
    if (!this.emergencyStop) {
      throw new Error('Emergency stop is not active');
    }

    automationAuditLogger.logEvent(
      'system_started',
      'info',
      'automation-cron',
      'Resuming from emergency stop',
      { previousEmergencyStop: this.emergencyStop }
    );
    
    this.emergencyStop = false;
    
    // Restart if it was running before
    if (!this.isRunning) {
      await this.start();
    }
    
    automationAuditLogger.logEvent(
      'system_started',
      'info',
      'automation-cron',
      'Successfully resumed from emergency stop',
      { 
        isRunning: this.isRunning,
        emergencyStop: this.emergencyStop,
        activeCircles: this.activeCircles.size
      }
    );
  }
}

// Export singleton instance
export const automationService = AutomationCronService.getInstance(); 