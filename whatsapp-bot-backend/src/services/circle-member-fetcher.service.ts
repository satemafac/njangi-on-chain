/**
 * Circle Member Fetcher Service
 * Advanced querying for circle membership data with caching and optimization
 * Builds on SuiDataFetcherService for specialized member operations
 */

import { appLogger } from '../utils/logger';
import { suiDataFetcher } from './sui-data-fetcher.service';

/**
 * Member with extended information
 */
export interface MemberWithStatus {
  address: string;
  role: 'admin' | 'member';
  hasContributed: boolean;
  contributionAmount: string;
  joinedAt?: number;
  lastContributedAt?: number;
  contributionCount: number;
  isActive: boolean;
  status: 'pending' | 'contributed' | 'defaulted';
}

/**
 * Member group statistics
 */
export interface MemberGroupStats {
  totalMembers: number;
  activeMembers: number;
  adminCount: number;
  memberCount: number;
  contributedCount: number;
  defaultedCount: number;
  averageContribution: string;
  totalContribution: string;
}

/**
 * Member role-based query result
 */
export interface MembersByRole {
  admins: MemberWithStatus[];
  members: MemberWithStatus[];
  stats: MemberGroupStats;
}

/**
 * Contribution history entry
 */
export interface ContributionHistory {
  address: string;
  amount: string;
  timestamp: number;
  cycle: number;
  txDigest: string;
}

/**
 * Member status for notifications
 */
export interface NotificationEligibility {
  address: string;
  name: string;
  shouldNotify: boolean;
  reason: string;
  role: 'admin' | 'member';
  priority: 'high' | 'medium' | 'low';
}

/**
 * Query result with pagination info
 */
interface PaginatedResult<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

export class CircleMemberFetcherService {
  private static instance: CircleMemberFetcherService;
  private memberCache: Map<string, { data: any; timestamp: number }> = new Map();
  private cacheTTL = 120000; // 120 seconds for member data
  private pageSize = 20;

  private constructor() {
    appLogger.info('Circle Member Fetcher Service initialized');
  }

  /**
   * Get singleton instance
   */
  public static getInstance(): CircleMemberFetcherService {
    if (!CircleMemberFetcherService.instance) {
      CircleMemberFetcherService.instance = new CircleMemberFetcherService();
    }
    return CircleMemberFetcherService.instance;
  }

  /**
   * Get all members with status information for a circle
   */
  public async getMembersWithStatus(circleId: string): Promise<MemberWithStatus[]> {
    const cacheKey = `members-status:${circleId}`;
    const cached = this.getFromCache(cacheKey);
    if (cached) return cached;

    try {
      // Get base member data from data fetcher
      const result = await suiDataFetcher.getCircleMembers(circleId);

      if (!result.success || !result.data) {
        appLogger.error('Failed to get members for status enrichment', { circleId });
        return [];
      }

      // Enrich with status information
      const membersWithStatus: MemberWithStatus[] = result.data.map((member) => ({
        ...member,
        lastContributedAt: member.joinedAt,
        contributionCount: member.hasContributed ? 1 : 0,
        isActive: member.hasContributed,
        status: member.hasContributed ? 'contributed' : 'pending',
      }));

      // Cache the result
      this.setCache(cacheKey, membersWithStatus);

      appLogger.debug('Members with status fetched', {
        circleId,
        count: membersWithStatus.length,
      });

      return membersWithStatus;
    } catch (error) {
      appLogger.error('Error fetching members with status', {
        circleId,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Get members organized by role
   */
  public async getMembersByRole(circleId: string): Promise<MembersByRole> {
    try {
      const members = await this.getMembersWithStatus(circleId);

      const admins = members.filter((m) => m.role === 'admin');
      const regularMembers = members.filter((m) => m.role === 'member');
      const contributed = members.filter((m) => m.hasContributed);
      const defaulted = members.filter((m) => !m.hasContributed);

      // Calculate statistics
      const stats = this.calculateMemberStats(members);

      const result: MembersByRole = {
        admins,
        members: regularMembers,
        stats,
      };

      appLogger.debug('Members by role fetched', {
        circleId,
        admins: admins.length,
        members: regularMembers.length,
        contributed: contributed.length,
        defaulted: defaulted.length,
      });

      return result;
    } catch (error) {
      appLogger.error('Error fetching members by role', {
        circleId,
        error: error instanceof Error ? error.message : String(error),
      });

      return {
        admins: [],
        members: [],
        stats: {
          totalMembers: 0,
          activeMembers: 0,
          adminCount: 0,
          memberCount: 0,
          contributedCount: 0,
          defaultedCount: 0,
          averageContribution: '0',
          totalContribution: '0',
        },
      };
    }
  }

  /**
   * Filter members who haven't contributed
   */
  public async getDefaultedMembers(circleId: string): Promise<MemberWithStatus[]> {
    try {
      const members = await this.getMembersWithStatus(circleId);
      const defaulted = members.filter((m) => !m.hasContributed);

      appLogger.debug('Defaulted members fetched', {
        circleId,
        count: defaulted.length,
      });

      return defaulted;
    } catch (error) {
      appLogger.error('Error fetching defaulted members', {
        circleId,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Get members for notifications (with eligibility info)
   */
  public async getNotificationEligibleMembers(
    circleId: string,
    eventType: string
  ): Promise<NotificationEligibility[]> {
    try {
      const membersByRole = await this.getMembersByRole(circleId);
      const cycleInfo = await suiDataFetcher.getCircleCycleInfo(circleId);

      if (!cycleInfo.success || !cycleInfo.data) {
        appLogger.warn('Could not get cycle info for eligibility', { circleId });
        return [];
      }

      const eligible: NotificationEligibility[] = [];

      // Determine eligibility based on event type
      switch (eventType) {
        case 'NewCycleStarted':
          // Notify all members
          eligible.push(
            ...membersByRole.admins.map((m) => this.createEligibility(m, true, 'high')),
            ...membersByRole.members.map((m) => this.createEligibility(m, true, 'medium'))
          );
          break;

        case 'MemberContributed':
          // Notify admins only
          eligible.push(
            ...membersByRole.admins.map((m) => this.createEligibility(m, true, 'high'))
          );
          break;

        case 'AllMembersContributed':
          // Notify all members
          eligible.push(
            ...membersByRole.admins.map((m) => this.createEligibility(m, true, 'high')),
            ...membersByRole.members.map((m) => this.createEligibility(m, true, 'low'))
          );
          break;

        case 'DeadlineApproaching':
          // Notify defaulted members and admins
          eligible.push(
            ...membersByRole.admins.map((m) => this.createEligibility(m, true, 'high'))
          );

          const defaulted = membersByRole.members.filter((m) => !m.hasContributed);
          eligible.push(
            ...defaulted.map((m) =>
              this.createEligibility(m, true, 'high', 'Contribution deadline approaching')
            )
          );
          break;

        case 'PayoutReminder':
          // Notify all members
          eligible.push(
            ...membersByRole.admins.map((m) => this.createEligibility(m, true, 'high')),
            ...membersByRole.members.map((m) => this.createEligibility(m, true, 'medium'))
          );
          break;

        case 'PayoutOverdue':
          // Notify admins and defaulted members
          eligible.push(
            ...membersByRole.admins.map((m) => this.createEligibility(m, true, 'high'))
          );
          const overdue = membersByRole.members.filter((m) => !m.hasContributed);
          eligible.push(
            ...overdue.map((m) =>
              this.createEligibility(m, true, 'high', 'Payout overdue - payment required')
            )
          );
          break;

        case 'ContributorOverdue':
          // Notify specific contributor
          const uncontributed = membersByRole.members.filter((m) => !m.hasContributed);
          eligible.push(
            ...uncontributed.map((m) =>
              this.createEligibility(m, true, 'high', 'Your contribution is overdue')
            )
          );
          break;

        default:
          appLogger.warn('Unknown event type for eligibility', { eventType });
          return [];
      }

      appLogger.debug('Notification eligible members fetched', {
        circleId,
        eventType,
        count: eligible.length,
      });

      return eligible;
    } catch (error) {
      appLogger.error('Error fetching notification eligible members', {
        circleId,
        eventType,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Get admins only
   */
  public async getAdmins(circleId: string): Promise<MemberWithStatus[]> {
    try {
      const members = await this.getMembersWithStatus(circleId);
      return members.filter((m) => m.role === 'admin');
    } catch (error) {
      appLogger.error('Error fetching admins', {
        circleId,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Get regular members only
   */
  public async getRegularMembers(circleId: string): Promise<MemberWithStatus[]> {
    try {
      const members = await this.getMembersWithStatus(circleId);
      return members.filter((m) => m.role === 'member');
    } catch (error) {
      appLogger.error('Error fetching regular members', {
        circleId,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Check if an address is an admin
   */
  public async isAdmin(circleId: string, address: string): Promise<boolean> {
    try {
      const admins = await this.getAdmins(circleId);
      return admins.some((a) => a.address === address);
    } catch (error) {
      appLogger.error('Error checking admin status', {
        circleId,
        address,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Get member by address
   */
  public async getMember(
    circleId: string,
    address: string
  ): Promise<MemberWithStatus | null> {
    try {
      const members = await this.getMembersWithStatus(circleId);
      return members.find((m) => m.address === address) || null;
    } catch (error) {
      appLogger.error('Error fetching member', {
        circleId,
        address,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Get paginated members
   */
  public async getPagedMembers(
    circleId: string,
    page: number = 1,
    pageSize: number = this.pageSize
  ): Promise<PaginatedResult<MemberWithStatus>> {
    try {
      const members = await this.getMembersWithStatus(circleId);
      const startIdx = (page - 1) * pageSize;
      const endIdx = startIdx + pageSize;
      const paged = members.slice(startIdx, endIdx);

      return {
        data: paged,
        total: members.length,
        page,
        pageSize,
        hasMore: endIdx < members.length,
      };
    } catch (error) {
      appLogger.error('Error fetching paged members', {
        circleId,
        page,
        pageSize,
        error: error instanceof Error ? error.message : String(error),
      });

      return {
        data: [],
        total: 0,
        page,
        pageSize,
        hasMore: false,
      };
    }
  }

  /**
   * Calculate member statistics
   */
  private calculateMemberStats(members: MemberWithStatus[]): MemberGroupStats {
    const admins = members.filter((m) => m.role === 'admin');
    const regularMembers = members.filter((m) => m.role === 'member');
    const contributed = members.filter((m) => m.hasContributed);
    const defaulted = members.filter((m) => !m.hasContributed);
    const activeMembers = members.filter((m) => m.isActive);

    const totalContributionAmount = contributed.reduce(
      (sum, m) => sum + parseInt(m.contributionAmount || '0'),
      0
    );

    return {
      totalMembers: members.length,
      activeMembers: activeMembers.length,
      adminCount: admins.length,
      memberCount: regularMembers.length,
      contributedCount: contributed.length,
      defaultedCount: defaulted.length,
      averageContribution:
        contributed.length > 0 ? Math.floor(totalContributionAmount / contributed.length).toString() : '0',
      totalContribution: totalContributionAmount.toString(),
    };
  }

  /**
   * Create notification eligibility object
   */
  private createEligibility(
    member: MemberWithStatus,
    shouldNotify: boolean,
    priority: 'high' | 'medium' | 'low',
    reason?: string
  ): NotificationEligibility {
    return {
      address: member.address,
      name: `Member ${member.address.substring(0, 6)}...`,
      shouldNotify,
      reason:
        reason ||
        (member.role === 'admin'
          ? 'Admin notification'
          : member.hasContributed
          ? 'Member notification'
          : 'Member notification - contribution pending'),
      role: member.role,
      priority,
    };
  }

  /**
   * Cache helpers
   */
  private getFromCache(key: string): any | null {
    const cached = this.memberCache.get(key);
    if (!cached) return null;

    if (Date.now() - cached.timestamp > this.cacheTTL) {
      this.memberCache.delete(key);
      return null;
    }

    return cached.data;
  }

  private setCache(key: string, data: any): void {
    this.memberCache.set(key, {
      data,
      timestamp: Date.now(),
    });
  }

  /**
   * Clear cache
   */
  public clearCache(): void {
    this.memberCache.clear();
    appLogger.debug('Circle member fetcher cache cleared');
  }

  /**
   * Get cache stats
   */
  public getCacheStats(): {
    size: number;
    entries: Array<{ key: string; age: number }>;
  } {
    const entries = Array.from(this.memberCache.entries()).map(([key, value]) => ({
      key,
      age: Date.now() - value.timestamp,
    }));

    return {
      size: this.memberCache.size,
      entries,
    };
  }
}

// Export singleton instance
export const circleMemberFetcher = CircleMemberFetcherService.getInstance();
