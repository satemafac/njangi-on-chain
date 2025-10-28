/**
 * Sui Data Fetcher Service
 * Queries on-chain WhatsAppLinksRegistry and circle membership data
 * for WhatsApp notification context
 */

import { SuiClient } from '@mysten/sui.js/client';
import { appLogger } from '../utils/logger';
import { getConfig } from '../config';

/**
 * WhatsApp Link data from WhatsAppLinksRegistry
 */
export interface WhatsAppLink {
  circleId: string;
  phoneNumber: string;
  type: 'individual' | 'group';
  isEnabled: boolean;
  lastNotificationSent?: number;
  linkId?: string;
}

/**
 * Circle member information
 */
export interface CircleMember {
  address: string;
  role: 'admin' | 'member';
  hasContributed: boolean;
  contributionAmount: string;
  joinedAt?: number;
}

/**
 * Circle cycle information
 */
export interface CycleFetched {
  currentCycle: number;
  startDate: number;
  deadline: number;
  daysUntilDeadline: number;
  totalContributionRequired: string;
}

/**
 * Payout information
 */
export interface PayoutInfo {
  nextPayoutDate: number;
  amountPerMember: string;
  status: 'pending' | 'approved' | 'completed';
  payoutId?: string;
}

/**
 * Complete notification context
 */
export interface NotificationContext {
  circleId: string;
  circleName: string;
  whatsappLink: WhatsAppLink;
  members: CircleMember[];
  cycle: CycleFetched;
  payoutInfo: PayoutInfo;
  fetchedAt: number;
}

/**
 * Query result with metadata
 */
interface QueryResult<T> {
  success: boolean;
  data?: T;
  error?: string;
  retryCount: number;
  duration: number;
}

export class SuiDataFetcherService {
  private static instance: SuiDataFetcherService;
  private rpcClients: Map<string, SuiClient> = new Map();
  private network: 'testnet' | 'mainnet' = 'testnet';
  private queryCache: Map<string, { data: any; timestamp: number }> = new Map();
  private cacheTTL = 60000; // 60 seconds

  private constructor() {
    this.initializeClients();
  }

  /**
   * Get singleton instance
   */
  public static getInstance(): SuiDataFetcherService {
    if (!SuiDataFetcherService.instance) {
      SuiDataFetcherService.instance = new SuiDataFetcherService();
    }
    return SuiDataFetcherService.instance;
  }

  /**
   * Initialize RPC clients
   */
  private initializeClients(): void {
    const config = getConfig();

    // Testnet client
    this.rpcClients.set(
      'testnet',
      new SuiClient({ url: config.sui.testnetRpcUrl })
    );

    // Mainnet client
    this.rpcClients.set(
      'mainnet',
      new SuiClient({ url: config.sui.mainnetRpcUrl })
    );

    appLogger.info('Sui Data Fetcher initialized with RPC clients', {
      testnetRpc: config.sui.testnetRpcUrl.substring(0, 30) + '...',
      mainnetRpc: config.sui.mainnetRpcUrl.substring(0, 30) + '...',
    });
  }

  /**
   * Set which network to query
   */
  public setNetwork(network: 'testnet' | 'mainnet'): void {
    this.network = network;
    appLogger.debug(`Switched to ${network}`);
  }

  /**
   * Get RPC client for current network
   */
  private getClient(): SuiClient {
    const client = this.rpcClients.get(this.network);
    if (!client) {
      throw new Error(`No RPC client configured for ${this.network}`);
    }
    return client;
  }

  /**
   * Query WhatsAppLinksRegistry for a circle
   */
  public async getWhatsAppLink(circleId: string): Promise<QueryResult<WhatsAppLink>> {
    const startTime = Date.now();
    const cacheKey = `whatsapp-link:${circleId}:${this.network}`;

    // Check cache
    const cached = this.getFromCache(cacheKey);
    if (cached) {
      return {
        success: true,
        data: cached,
        retryCount: 0,
        duration: Date.now() - startTime,
      };
    }

    try {
      const client = this.getClient();
      const config = getConfig();

      // Query the WhatsAppLinksRegistry shared object
      const registryId = config.sui.whatsappLinksRegistryId;
      const response = await client.getObject({
        id: registryId,
        options: { showContent: true },
      });

      if (!response.data || !response.data.content || response.data.content.dataType !== 'moveObject') {
        throw new Error('Invalid WhatsAppLinksRegistry response');
      }

      // Extract WhatsApp link for this circle
      const linkData = this.extractLinkFromRegistry(
        response.data.content.fields as any,
        circleId
      );

      if (!linkData) {
        return {
          success: false,
          error: `No WhatsApp link found for circle ${circleId}`,
          retryCount: 0,
          duration: Date.now() - startTime,
        };
      }

      // Cache the result
      this.setCache(cacheKey, linkData);

      appLogger.debug('WhatsApp link fetched', {
        circleId,
        phoneNumber: linkData.phoneNumber?.substring(0, 5) + '...',
      });

      return {
        success: true,
        data: linkData,
        retryCount: 0,
        duration: Date.now() - startTime,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appLogger.error('Failed to fetch WhatsApp link', {
        circleId,
        error: message,
      });

      return {
        success: false,
        error: message,
        retryCount: 0,
        duration: Date.now() - startTime,
      };
    }
  }

  /**
   * Extract WhatsApp link from registry object
   */
  private extractLinkFromRegistry(registryData: any, circleId: string): WhatsAppLink | null {
    try {
      // Parse the registry structure
      // This assumes the registry has a links vector or similar structure
      // Adapt based on actual Move contract structure

      if (registryData.links && Array.isArray(registryData.links)) {
        const link = registryData.links.find((l: any) => l.circle_id === circleId);
        if (link) {
          return {
            circleId: link.circle_id,
            phoneNumber: link.phone_number || link.group_id,
            type: link.is_group ? 'group' : 'individual',
            isEnabled: link.enabled !== false,
            lastNotificationSent: link.last_notification_sent,
            linkId: link.id,
          };
        }
      }

      return null;
    } catch (error) {
      appLogger.warn('Error parsing WhatsApp link from registry', {
        circleId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Get circle members for a circle
   */
  public async getCircleMembers(circleId: string): Promise<QueryResult<CircleMember[]>> {
    const startTime = Date.now();
    const cacheKey = `circle-members:${circleId}:${this.network}`;

    // Check cache
    const cached = this.getFromCache(cacheKey);
    if (cached) {
      return {
        success: true,
        data: cached,
        retryCount: 0,
        duration: Date.now() - startTime,
      };
    }

    try {
      const client = this.getClient();

      // Query circle members
      // This would typically use dynamic fields or a secondary index
      const response = await client.getDynamicFields({
        parentId: circleId,
        limit: 100,
      });

      const members: CircleMember[] = [];

      if (response.data) {
        for (const field of response.data) {
          const memberData = this.parseMemberField(field);
          if (memberData) {
            members.push(memberData);
          }
        }
      }

      // Cache the result
      this.setCache(cacheKey, members);

      appLogger.debug('Circle members fetched', {
        circleId,
        memberCount: members.length,
      });

      return {
        success: true,
        data: members,
        retryCount: 0,
        duration: Date.now() - startTime,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appLogger.error('Failed to fetch circle members', {
        circleId,
        error: message,
      });

      return {
        success: false,
        error: message,
        retryCount: 0,
        duration: Date.now() - startTime,
      };
    }
  }

  /**
   * Parse member data from dynamic field
   */
  private parseMemberField(field: any): CircleMember | null {
    try {
      if (!field.name || !field.objectId) return null;

      return {
        address: field.name.value || field.name,
        role: field.role === 'admin' ? 'admin' : 'member',
        hasContributed: field.hasContributed !== false,
        contributionAmount: field.amount || '0',
        joinedAt: field.joinedAt,
      };
    } catch (error) {
      return null;
    }
  }

  /**
   * Get circle cycle information
   */
  public async getCircleCycleInfo(circleId: string): Promise<QueryResult<CycleFetched>> {
    const startTime = Date.now();
    const cacheKey = `circle-cycle:${circleId}:${this.network}`;

    const cached = this.getFromCache(cacheKey);
    if (cached) {
      return {
        success: true,
        data: cached,
        retryCount: 0,
        duration: Date.now() - startTime,
      };
    }

    try {
      const client = this.getClient();

      // Query circle object for cycle info
      const response = await client.getObject({
        id: circleId,
        options: { showContent: true },
      });

      if (!response.data || !response.data.content || response.data.content.dataType !== 'moveObject') {
        throw new Error('Invalid circle object response');
      }

      const fields = response.data.content.fields as any;
      const now = Date.now();
      const deadline = parseInt(fields.deadline) * 1000;

      const cycleInfo: CycleFetched = {
        currentCycle: parseInt(fields.current_cycle) || 1,
        startDate: parseInt(fields.start_date) * 1000,
        deadline,
        daysUntilDeadline: Math.ceil((deadline - now) / (1000 * 60 * 60 * 24)),
        totalContributionRequired: fields.total_contribution || '0',
      };

      // Cache the result
      this.setCache(cacheKey, cycleInfo);

      return {
        success: true,
        data: cycleInfo,
        retryCount: 0,
        duration: Date.now() - startTime,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appLogger.error('Failed to fetch circle cycle info', {
        circleId,
        error: message,
      });

      return {
        success: false,
        error: message,
        retryCount: 0,
        duration: Date.now() - startTime,
      };
    }
  }

  /**
   * Get payout information for a circle
   */
  public async getPayoutInfo(circleId: string): Promise<QueryResult<PayoutInfo>> {
    const startTime = Date.now();
    const cacheKey = `payout-info:${circleId}:${this.network}`;

    const cached = this.getFromCache(cacheKey);
    if (cached) {
      return {
        success: true,
        data: cached,
        retryCount: 0,
        duration: Date.now() - startTime,
      };
    }

    try {
      const client = this.getClient();

      const response = await client.getObject({
        id: circleId,
        options: { showContent: true },
      });

      if (!response.data || !response.data.content || response.data.content.dataType !== 'moveObject') {
        throw new Error('Invalid circle object response');
      }

      const fields = response.data.content.fields as any;

      const payoutInfo: PayoutInfo = {
        nextPayoutDate: parseInt(fields.next_payout_date) * 1000,
        amountPerMember: fields.amount_per_member || '0',
        status: (fields.payout_status || 'pending') as 'pending' | 'approved' | 'completed',
        payoutId: fields.payout_id,
      };

      this.setCache(cacheKey, payoutInfo);

      return {
        success: true,
        data: payoutInfo,
        retryCount: 0,
        duration: Date.now() - startTime,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appLogger.error('Failed to fetch payout info', {
        circleId,
        error: message,
      });

      return {
        success: false,
        error: message,
        retryCount: 0,
        duration: Date.now() - startTime,
      };
    }
  }

  /**
   * Get complete notification context for a circle and event
   */
  public async getNotificationContext(circleId: string): Promise<QueryResult<NotificationContext>> {
    const startTime = Date.now();

    try {
      // Fetch all data in parallel
      const [linkResult, membersResult, cycleResult, payoutResult] = await Promise.all([
        this.getWhatsAppLink(circleId),
        this.getCircleMembers(circleId),
        this.getCircleCycleInfo(circleId),
        this.getPayoutInfo(circleId),
      ]);

      if (
        !linkResult.success ||
        !membersResult.success ||
        !cycleResult.success ||
        !payoutResult.success
      ) {
        const errors = [
          linkResult.success ? null : linkResult.error,
          membersResult.success ? null : membersResult.error,
          cycleResult.success ? null : cycleResult.error,
          payoutResult.success ? null : payoutResult.error,
        ].filter(Boolean);

        throw new Error(`Failed to fetch context: ${errors.join(', ')}`);
      }

      const context: NotificationContext = {
        circleId,
        circleName: `Circle ${circleId.substring(0, 8)}`,
        whatsappLink: linkResult.data!,
        members: membersResult.data!,
        cycle: cycleResult.data!,
        payoutInfo: payoutResult.data!,
        fetchedAt: Date.now(),
      };

      const duration = Date.now() - startTime;

      appLogger.info('Notification context fetched', {
        circleId,
        memberCount: context.members.length,
        duration,
      });

      return {
        success: true,
        data: context,
        retryCount: 0,
        duration,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appLogger.error('Failed to get notification context', {
        circleId,
        error: message,
        duration: Date.now() - startTime,
      });

      return {
        success: false,
        error: message,
        retryCount: 0,
        duration: Date.now() - startTime,
      };
    }
  }

  /**
   * Cache helpers
   */
  private getFromCache(key: string): any | null {
    const cached = this.queryCache.get(key);
    if (!cached) return null;

    if (Date.now() - cached.timestamp > this.cacheTTL) {
      this.queryCache.delete(key);
      return null;
    }

    return cached.data;
  }

  private setCache(key: string, data: any): void {
    this.queryCache.set(key, {
      data,
      timestamp: Date.now(),
    });
  }

  /**
   * Clear cache
   */
  public clearCache(): void {
    this.queryCache.clear();
    appLogger.debug('Data fetcher cache cleared');
  }

  /**
   * Get cache statistics
   */
  public getCacheStats(): {
    size: number;
    entries: Array<{ key: string; age: number }>;
  } {
    const entries = Array.from(this.queryCache.entries()).map(([key, value]) => ({
      key,
      age: Date.now() - value.timestamp,
    }));

    return {
      size: this.queryCache.size,
      entries,
    };
  }
}

// Export singleton instance
export const suiDataFetcher = SuiDataFetcherService.getInstance();
