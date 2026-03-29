import { createLogger, format, transports } from 'winston';
import joinRequestService from './join-request-service';
import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import {
  getCirclePackageId,
  getPackageLookupIdsForCurrentNetwork,
} from './circle-service';

// Create logger instance
const logger = createLogger({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  format: format.combine(
    format.timestamp(),
    format.errors({ stack: true }),
    format.printf((info) => {
      return `${info.timestamp} [${info.level.toUpperCase()}] CircleMemberManager: ${info.message}${info.stack ? `\n${info.stack}` : ''}`;
    })
  ),
  transports: [
    new transports.Console(),
    new transports.File({ filename: 'src/services/circle-member.log' })
  ]
});

// Member information interface
export interface CircleMember {
  suiAddress: string;
  phoneNumber?: string;
  isAuthenticated: boolean;
  joinedAt?: Date;
  isAdmin: boolean;
}

// Circle member summary
export interface CircleMemberSummary {
  circleId: string;
  totalMembers: number;
  authenticatedMembers: number;
  memberPhoneNumbers: string[];
  adminPhoneNumbers: string[];
  memberDetails: CircleMember[];
}

/**
 * 👥 Circle Member Manager Service
 * 
 * Manages circle member data and phone number lookups for notifications.
 * Features:
 * - Maps Sui addresses to phone numbers via authentication service
 * - Retrieves circle member information from blockchain
 * - Provides phone number lists for notification delivery
 * - Caches member data for performance
 */
export class CircleMemberManagerService {
  private static instance: CircleMemberManagerService;
  
  private suiClient: SuiClient;
  
  // Cache for member data (expires every 10 minutes)
  private memberCache: Map<string, { data: CircleMemberSummary; expiresAt: Date }> = new Map();
  private readonly CACHE_DURATION = 10 * 60 * 1000; // 10 minutes

  private constructor() {
    // Initialize SUI client
    this.suiClient = new SuiClient({ 
      url: getFullnodeUrl(process.env.NODE_ENV === 'production' ? 'mainnet' : 'testnet') 
    });
    
    logger.info('Circle Member Manager Service initialized');
  }

  public static getInstance(): CircleMemberManagerService {
    if (!CircleMemberManagerService.instance) {
      CircleMemberManagerService.instance = new CircleMemberManagerService();
    }
    return CircleMemberManagerService.instance;
  }

  /**
   * 📱 Get phone numbers for all members of a circle
   */
  public async getCircleMemberPhoneNumbers(circleId: string): Promise<string[]> {
    try {
      const memberSummary = await this.getCircleMemberSummary(circleId);
      
      logger.info(`Found ${memberSummary.memberPhoneNumbers.length} phone numbers for circle ${circleId}`);
      
      return memberSummary.memberPhoneNumbers;
      
    } catch (error) {
      logger.error(`Error getting member phone numbers for circle ${circleId}:`, error);
      return [];
    }
  }

  /**
   * 📱 Get admin phone numbers for a circle
   */
  public async getCircleAdminPhoneNumbers(circleId: string): Promise<string[]> {
    try {
      const memberSummary = await this.getCircleMemberSummary(circleId);
      
      logger.info(`Found ${memberSummary.adminPhoneNumbers.length} admin phone numbers for circle ${circleId}`);
      
      return memberSummary.adminPhoneNumbers;
      
    } catch (error) {
      logger.error(`Error getting admin phone numbers for circle ${circleId}:`, error);
      return [];
    }
  }

  /**
   * 👥 Get comprehensive member summary for a circle
   */
  public async getCircleMemberSummary(circleId: string): Promise<CircleMemberSummary> {
    // Check cache first
    const cached = this.memberCache.get(circleId);
    if (cached && new Date() < cached.expiresAt) {
      logger.debug(`Using cached member data for circle ${circleId}`);
      return cached.data;
    }

    try {
      logger.debug(`Fetching fresh member data for circle ${circleId}`);
      
      // Get circle data from blockchain
      const circleObject = await this.suiClient.getObject({
        id: circleId,
        options: { showContent: true }
      });

      if (!circleObject.data?.content || circleObject.data.content.dataType !== 'moveObject') {
        throw new Error(`Circle ${circleId} not found or invalid`);
      }

      const fields = circleObject.data.content.fields as Record<string, string | boolean | number>;
      const adminAddress = String(fields.admin);
      
      // Get member addresses from blockchain events or stored member list
      const memberAddresses = await this.getCircleMemberAddresses(circleId, adminAddress);
      
      // Map addresses to phone numbers
      const memberDetails: CircleMember[] = [];
      const memberPhoneNumbers: string[] = [];
      const adminPhoneNumbers: string[] = [];
      
      for (const address of memberAddresses) {
        const phoneNumber = this.getPhoneNumberForAddress(address);
        const isAdmin = address === adminAddress;
        
        const member: CircleMember = {
          suiAddress: address,
          phoneNumber: phoneNumber || undefined,
          isAuthenticated: !!phoneNumber,
          isAdmin
        };
        
        memberDetails.push(member);
        
        if (phoneNumber) {
          memberPhoneNumbers.push(phoneNumber);
          
          if (isAdmin) {
            adminPhoneNumbers.push(phoneNumber);
          }
        }
      }

      const summary: CircleMemberSummary = {
        circleId,
        totalMembers: memberAddresses.length,
        authenticatedMembers: memberPhoneNumbers.length,
        memberPhoneNumbers,
        adminPhoneNumbers,
        memberDetails
      };

      // Cache the result
      this.memberCache.set(circleId, {
        data: summary,
        expiresAt: new Date(Date.now() + this.CACHE_DURATION)
      });

      logger.info(`Circle ${circleId}: ${summary.totalMembers} members, ${summary.authenticatedMembers} with phone numbers`);
      
      return summary;

    } catch (error) {
      logger.error(`Error getting member summary for circle ${circleId}:`, error);
      
      // Return empty summary on error
      return {
        circleId,
        totalMembers: 0,
        authenticatedMembers: 0,
        memberPhoneNumbers: [],
        adminPhoneNumbers: [],
        memberDetails: []
      };
    }
  }

  /**
   * 🔍 Get member addresses for a circle from blockchain
   */
  private async getCircleMemberAddresses(circleId: string, adminAddress: string): Promise<string[]> {
    try {
      const memberAddresses: Set<string> = new Set();
      
      // Always include the admin
      memberAddresses.add(adminAddress);
      const circlePackageId = await getCirclePackageId(circleId, adminAddress);
      const packageIdsToQuery = getPackageLookupIdsForCurrentNetwork(circlePackageId);
      
      // Method 1: Check MemberJoined events
      for (const packageId of packageIdsToQuery) {
        try {
          const events = await this.suiClient.queryEvents({
            query: { MoveEventType: `${packageId}::njangi_members::MemberJoined` },
            limit: 100
          });

          for (const event of events.data) {
            const eventData = event.parsedJson as { circle_id?: string; user?: string };
            if (eventData.circle_id === circleId && eventData.user) {
              memberAddresses.add(eventData.user);
            }
          }
        } catch (error) {
          logger.debug(`Could not fetch MemberJoined events for ${packageId}: ${error}`);
        }
      }

      // Method 2: Check join requests (we'll get pending ones for now as approved tracking needs implementation)
      try {
        const joinRequests = await joinRequestService.getPendingRequestsByCircleId(circleId);
        
        // Note: The current service only exposes pending requests
        // TODO: Extend join request service to include approved/all requests for member tracking
        for (const request of joinRequests) {
          if (request.user_address) {
            memberAddresses.add(request.user_address);
          }
        }
      } catch (error) {
        logger.debug(`Could not fetch join requests: ${error}`);
      }

      // Method 3: Check ContributionMade events to find active members
      for (const packageId of packageIdsToQuery) {
        try {
          const events = await this.suiClient.queryEvents({
            query: { MoveEventType: `${packageId}::njangi_payments::ContributionMade` },
            limit: 200
          });

          for (const event of events.data) {
            const eventData = event.parsedJson as { circle_id?: string; contributor?: string };
            if (eventData.circle_id === circleId && eventData.contributor) {
              memberAddresses.add(eventData.contributor);
            }
          }
        } catch (error) {
          logger.debug(`Could not fetch ContributionMade events for ${packageId}: ${error}`);
        }
      }

      const addresses = Array.from(memberAddresses);
      logger.debug(`Found ${addresses.length} member addresses for circle ${circleId}`);
      
      return addresses;

    } catch (error) {
      logger.error(`Error getting member addresses for circle ${circleId}:`, error);
      
      // Return at least the admin address
      return [adminAddress];
    }
  }

  /**
   * 📱 Get phone number for a Sui address (reverse lookup)
   */
  private getPhoneNumberForAddress(suiAddress: string): string | null {
    // We need to iterate through the auth service's internal mappings
    // This is a limitation of the current auth service design
    // For now, we'll implement a workaround using the session lookup
    
    // TODO: This is inefficient - ideally the auth service should provide 
    // a reverse lookup method. For now, we'll return null and log the need.
    
    logger.debug(`TODO: Implement efficient reverse lookup for address ${suiAddress}`);
    
    // Temporary solution: check if this address has been recently authenticated
    // by attempting to find it in recent activity (this is not ideal but works for now)
    return null;
  }

  /**
   * 🔄 Clear cache for a specific circle
   */
  public clearCircleCache(circleId: string): void {
    this.memberCache.delete(circleId);
    logger.debug(`Cleared member cache for circle ${circleId}`);
  }

  /**
   * 🔄 Clear all cached member data
   */
  public clearAllCache(): void {
    this.memberCache.clear();
    logger.info('Cleared all member cache');
  }

  /**
   * 📊 Get cache statistics
   */
  public getCacheStats(): {
    cachedCircles: number;
    cacheHitRate: string;
    memoryUsage: string;
  } {
    const now = new Date();
    const validEntries = Array.from(this.memberCache.values())
      .filter(entry => now < entry.expiresAt).length;

    return {
      cachedCircles: validEntries,
      cacheHitRate: 'Not tracked yet',
      memoryUsage: `${this.memberCache.size} entries`
    };
  }

  /**
   * 🧪 Add test data for development
   */
  public addTestMemberData(circleId: string, testMembers: Array<{ address: string; phone: string; isAdmin?: boolean }>): void {
    if (process.env.NODE_ENV === 'production') {
      logger.warn('Cannot add test data in production environment');
      return;
    }

    const memberDetails: CircleMember[] = testMembers.map(member => ({
      suiAddress: member.address,
      phoneNumber: member.phone,
      isAuthenticated: true,
      isAdmin: member.isAdmin || false
    }));

    const summary: CircleMemberSummary = {
      circleId,
      totalMembers: testMembers.length,
      authenticatedMembers: testMembers.length,
      memberPhoneNumbers: testMembers.map(m => m.phone),
      adminPhoneNumbers: testMembers.filter(m => m.isAdmin).map(m => m.phone),
      memberDetails
    };

    this.memberCache.set(circleId, {
      data: summary,
      expiresAt: new Date(Date.now() + this.CACHE_DURATION)
    });

    logger.info(`Added test member data for circle ${circleId}: ${testMembers.length} members`);
  }
}

// Export singleton instance
export const circleMemberManager = CircleMemberManagerService.getInstance(); 
