import { Transaction as TransactionBlock } from '@mysten/sui/transactions';
import { SuiClient } from '@mysten/sui/client';
import { bcs } from '@mysten/sui/bcs';
import type { CircleFormData, CycleLength, WeekDay } from '../types/circle';
import { getCurrentPackageId, getCurrentRpcUrl, getCurrentNetwork } from './network-config';

// Get package ID using network-aware configuration with fallbacks
export function getPackageId(): string {
  try {
    return getCurrentPackageId() || process.env.NEXT_PUBLIC_PACKAGE_ID || "0xd530bfd7511ac2d343646a8ca4e2e14ffb89e1ec69a38ff8fb99c415706d6154";
  } catch {
    // Fallback if network config is not available (e.g., during SSR)
    return process.env.NEXT_PUBLIC_PACKAGE_ID || "0xd530bfd7511ac2d343646a8ca4e2e14ffb89e1ec69a38ff8fb99c415706d6154";
  }
}

// Legacy constant for backward compatibility (will be dynamically resolved)
export const PACKAGE_ID = getPackageId();

// Constants from Move contract
const CIRCLE_TYPE_ROTATIONAL = 0;
const CIRCLE_TYPE_SMART_GOAL = 1;
const ROTATION_STYLE_FIXED = 0;
const GOAL_TYPE_AMOUNT = 0;
const GOAL_TYPE_TIME = 1;

// Type-safe mappings
const WEEKDAY_MAP: Record<WeekDay, number> = {
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
  sunday: 0, // Changed to 0 to match contract
};

const CYCLE_LENGTH_MAP: Record<CycleLength, number> = {
  weekly: 0,
  monthly: 1,
  quarterly: 2,
};

export class CircleService {
  constructor(private suiClient: SuiClient) {}

  async createCircle(formData: CircleFormData) {
    try {
      const tx = new TransactionBlock();
      
      // Get clock object
      const [clock] = tx.moveCall({
        target: '0x2::clock::clock',
        arguments: [],
      });
      
      // 1. Convert name to UTF-8 bytes
      const nameBytes = new TextEncoder().encode(formData.name);
      
      // 2. Convert amounts to MIST (1 SUI = 1e9 MIST)
      const contributionAmount = BigInt(Math.floor(formData.contributionAmount * 1e9));
      const securityDeposit = BigInt(Math.floor(formData.securityDeposit * 1e9));
      
      // 3. Convert currency type to UTF-8 bytes
      const currencyTypeBytes = new TextEncoder().encode(formData.selectedCurrency);
      
      // 4. Convert local currency amounts to appropriate format
      const contributionAmountLocal = BigInt(Math.floor(formData.contributionAmountLocal * 100));
      const securityDepositLocal = BigInt(Math.floor(formData.securityDepositLocal * 100));
      
      // 5. Convert cycle day to contract format
      const cycleDay = typeof formData.cycleDay === 'string' 
        ? WEEKDAY_MAP[formData.cycleDay as WeekDay]
        : formData.cycleDay;

      // 6. Prepare smart goal options
      const goalType = formData.cycleType === 'smart-goal' && formData.smartGoal
        ? [formData.smartGoal.goalType === 'amount' ? GOAL_TYPE_AMOUNT : GOAL_TYPE_TIME]
        : [];

      const targetAmount = formData.cycleType === 'smart-goal' && 
        formData.smartGoal?.goalType === 'amount' && 
        formData.smartGoal.targetAmount
          ? [BigInt(Math.floor(formData.smartGoal.targetAmount * 1e9))]
          : [];

      // 7. Convert target amount local currency
      const targetAmountLocal = formData.cycleType === 'smart-goal' && 
        formData.smartGoal?.goalType === 'amount' && 
        formData.smartGoal.targetAmountLocal
          ? [BigInt(Math.floor(formData.smartGoal.targetAmountLocal * 100))]
          : [];

      const targetDate = formData.cycleType === 'smart-goal' && 
        formData.smartGoal?.goalType === 'date' && 
        formData.smartGoal.targetDate
          ? [BigInt(Math.floor(new Date(formData.smartGoal.targetDate).getTime()))]
          : [];
      
      // 8. Build transaction with new currency-aware parameters
      tx.moveCall({
        target: `${getPackageId()}::njangi_circles::create_circle`,
        arguments: [
          tx.pure(nameBytes),                    // name: vector<u8>
          tx.pure.u64(contributionAmount),       // contribution_amount: u64
          tx.pure(currencyTypeBytes),            // currency_type: vector<u8>
          tx.pure.u64(contributionAmountLocal),  // contribution_amount_local: u64
          tx.pure.u64(securityDeposit),          // security_deposit: u64
          tx.pure.u64(securityDepositLocal),     // security_deposit_local: u64
          tx.pure.u64(CYCLE_LENGTH_MAP[formData.cycleLength]), // cycle_length: u64
          tx.pure.u64(cycleDay),                // cycle_day: u64
          tx.pure.u8(formData.cycleType === 'rotational' ? CIRCLE_TYPE_ROTATIONAL : CIRCLE_TYPE_SMART_GOAL), // circle_type: u8
          tx.pure.u64(formData.numberOfMembers), // max_members: u64
          tx.pure.u8(ROTATION_STYLE_FIXED),     // rotation_style: u8
          tx.pure(bcs.vector(bcs.bool()).serialize([
            formData.penaltyRules.latePayment,
            formData.penaltyRules.missedMeeting
          ])),                                  // penalty_rules: vector<bool>
          tx.pure(bcs.vector(bcs.u8()).serialize(goalType)),     // goal_type: Option<u8>
          tx.pure(bcs.vector(bcs.u64()).serialize(targetAmount)), // target_amount: Option<u64>
          tx.pure(bcs.vector(bcs.u64()).serialize(targetAmountLocal)), // target_amount_local: Option<u64>
          tx.pure(bcs.vector(bcs.u64()).serialize(targetDate)),   // target_date: Option<u64>
          tx.pure.bool(formData.smartGoal?.verificationRequired || false), // verification_required: bool
          clock,                               // clock: &Clock
        ],
      });

      return tx;
    } catch (error) {
      console.error('Error creating circle transaction:', error);
      throw error;
    }
  }

  async joinCircle(circleId: string, depositAmount: number) {
    try {
      const tx = new TransactionBlock();
      
      // Get clock object
      const [clock] = tx.moveCall({
        target: '0x2::clock::clock',
        arguments: [],
      });

      // Create deposit coin
      const [depositCoin] = tx.moveCall({
        target: '0x2::coin::mint_for_testing',
        typeArguments: ['0x2::sui::SUI'],
        arguments: [tx.pure.u64(BigInt(Math.floor(depositAmount * 1e9)))],
      });

      // Join the circle
      tx.moveCall({
        target: `${getPackageId()}::njangi_circles::join_circle`,
        arguments: [
          tx.object(circleId),    // circle: &mut Circle
          depositCoin,            // deposit: Coin<SUI>
          tx.pure(bcs.vector(bcs.u64()).serialize([])), // position: Option<u64>
          clock,                  // clock: &Clock
        ],
      });

      return tx;
    } catch (error) {
      console.error('Error creating join circle transaction:', error);
      throw error;
    }
  }

  // Helper function to invite members to the circle
  async inviteMembers(circleId: string, memberAddresses: string[]) {
    try {
      const tx = new TransactionBlock();
      
      for (const address of memberAddresses) {
        tx.moveCall({
          target: `${getPackageId()}::njangi_circles::invite_member`,
          typeArguments: [],
          arguments: [
            tx.object(circleId), // circle: &mut NjangiCircle
            tx.pure.address(address), // member_address: address
          ],
        });
      }

      return tx;
    } catch (error) {
      console.error('Error creating invite members transaction:', error);
      throw error;
    }
  }
}

// Standalone helper functions for multi-package support
// These can be imported and used directly without needing a CircleService instance

/**
 * Get the package ID that was used to create a specific circle
 * @param circleId The ID of the circle to look up
 * @param userAddress Optional user address to optimize the search
 * @returns Promise<string> The package ID used to create the circle
 */
export async function getCirclePackageId(circleId: string, userAddress?: string): Promise<string> {
  try {
    const client = new SuiClient({ url: getCurrentRpcUrl() });
    
    // First, try to get the circle object directly to extract package ID from its type
    try {
      const circleObject = await client.getObject({
        id: circleId,
        options: { showType: true }
      });
      
      if (circleObject.data?.type) {
        // Extract package ID from object type like "0xpackage::module::Type"
        const match = circleObject.data.type.match(/^(0x[a-f0-9]+)::/);
        if (match && match[1]) {
          console.log(`Found circle ${circleId} with package ${match[1]} from object type`);
          return match[1];
        }
      }
    } catch (error) {
      console.warn(`Error getting circle object ${circleId}:`, error);
    }
    
    // If we have a user address, get their package IDs first (more efficient)
    if (userAddress) {
      const userPackageIds = await getUserPackageIds(userAddress);
      
      // Search through each package ID for the circle
      for (const packageId of userPackageIds) {
        try {
          const events = await client.queryEvents({
            query: { MoveEventType: `${packageId}::njangi_circles::CircleCreated` },
            limit: 100
          });
          
          const foundEvent = events.data.find(event => 
            (event.parsedJson as { circle_id?: string })?.circle_id === circleId
          );
          
          if (foundEvent) {
            console.log(`Found circle ${circleId} created with package ${packageId}`);
            return packageId;
          }
        } catch (error) {
          console.warn(`Error querying events for package ${packageId}:`, error);
          continue;
        }
      }
    }
    
    // Fallback: try with the current default package ID
    try {
      const events = await client.queryEvents({
        query: { MoveEventType: `${getPackageId()}::njangi_circles::CircleCreated` },
        limit: 100
      });
      
      const foundEvent = events.data.find(event => 
        (event.parsedJson as { circle_id?: string })?.circle_id === circleId
      );
      
      if (foundEvent) {
        console.log(`Found circle ${circleId} created with default package ${getPackageId()}`);
        return getPackageId();
      }
    } catch (error) {
      console.warn('Error querying events for default package:', error);
    }
    
    // If not found anywhere, return the current package ID as fallback
    console.warn(`Could not find package ID for circle ${circleId}, using default ${getPackageId()}`);
    return getPackageId();
    
  } catch (error) {
    console.error('Error in getCirclePackageId:', error);
    return getPackageId(); // Return default as fallback
  }
}

/**
 * Known package IDs to always check for circles
 * This ensures users who are members-only (added by admin, never transacted) can still see their circles
 * Add old package IDs here after upgrades to maintain cross-version compatibility
 */
const KNOWN_PACKAGE_IDS: Record<'testnet' | 'mainnet', string[]> = {
  testnet: [
    '0x9f916ce4a0a4970e1d466a79ec2a916ec930feac10218e2b94c282a3906d7926', // Old testnet package (user requested)
    '0x8d44cd03809c95bd8b46c3f26cc9f7a62085d0f8b1bb22082b6ff768be0cb78f',
    '0x2ee55011e9d3c27a2743f83fb9f4498de8cdb6078cc175bec03362326f9ec1a1', // Previous testnet package
    // Note: Current package ID is automatically added from getPackageId()
    // Add more old package IDs here after future upgrades
  ],
  mainnet: [
    // Add mainnet package IDs here as needed after mainnet deployment
    '0xcec9cfc2bd69cd02e302433333142db502ab1566fab71d8489630b164927177b',
    '0x7bf5274804a6008ebfbd9bfe766defb7fd5aa5fe6777419c2b6531ec99120b55'

  ]
};

/**
 * Get all package IDs that a user has used to create circles
 * @param userAddress The user's address
 * @returns Promise<string[]> Array of package IDs used by the user
 */
export async function getUserPackageIds(userAddress: string): Promise<string[]> {
  try {
    // Use official Sui RPC to avoid rate limits during package discovery
    const currentNetwork = getCurrentNetwork();
    const officialRpcUrl = currentNetwork === 'mainnet'
      ? 'https://fullnode.mainnet.sui.io:443'
      : 'https://fullnode.testnet.sui.io:443';

    console.log(`🔍 getUserPackageIds: Using official RPC ${officialRpcUrl} for package discovery`);
    const client = new SuiClient({ url: officialRpcUrl });
    const packageIds = new Set<string>();
    
    // Always include the current default package ID
    packageIds.add(getPackageId());
    
    // Add all known package IDs for the current network
    const knownIds = KNOWN_PACKAGE_IDS[currentNetwork] || [];
    knownIds.forEach(id => packageIds.add(id));
    console.log(`📦 Added ${knownIds.length} known package IDs for ${currentNetwork}`);
    
    // Get user's transactions to find package IDs they've interacted with
    try {
      const response = await client.queryTransactionBlocks({
        filter: { FromAddress: userAddress },
        limit: 1000, // No artificial limits with official Sui RPC
        options: { showEvents: true, showObjectChanges: true }
      });
      
      for (const tx of response.data) {
        // Look through events for CircleCreated events
        if (tx.events) {
          for (const event of tx.events) {
            if (event.type.includes('::njangi_circles::CircleCreated')) {
              // Extract package ID from the event type
              const match = event.type.match(/^(0x[a-f0-9]+)::/);
              if (match && match[1]) {
                packageIds.add(match[1]);
              }
            }
          }
        }
        
        // Look through object changes for objects from different packages
        if (tx.objectChanges) {
          for (const change of tx.objectChanges) {
            if (change.type === 'created' && change.objectType?.includes('::njangi_circles::Circle')) {
              // Extract package ID from the object type
              const match = change.objectType.match(/^(0x[a-f0-9]+)::/);
              if (match && match[1]) {
                packageIds.add(match[1]);
              }
            }
          }
        }
      }
    } catch (error) {
      console.warn('Error querying user transactions:', error);
    }
    
    const result = Array.from(packageIds);
    console.log(`Found ${result.length} package IDs for user ${userAddress}:`, result);
    return result;
    
  } catch (error) {
    console.error('Error in getUserPackageIds:', error);
    return [getPackageId()]; // Return default package ID as fallback
  }
} 

/**
 * Performance optimization utilities for efficient circle fetching and processing
 */

// Connection pooling for SUI clients to avoid creating new instances repeatedly
const clientPool = new Map<string, SuiClient>();

/**
 * Get or create a cached SUI client for a given RPC URL
 * Reuses existing connections to reduce overhead
 */
export function getSuiClientFromPool(rpcUrl: string): SuiClient {
  if (!clientPool.has(rpcUrl)) {
    clientPool.set(rpcUrl, new SuiClient({ url: rpcUrl }));
  }
  return clientPool.get(rpcUrl)!;
}

/**
 * Clear the client pool (useful for testing or network switches)
 */
export function clearSuiClientPool(): void {
  clientPool.clear();
}

// Cache for processed circle objects to avoid redundant processing
interface CircleObjectCache {
  data: Record<string, unknown>;
  timestamp: number;
  processed: Record<string, unknown>;
}
const circleObjectCache = new Map<string, CircleObjectCache>();
const CIRCLE_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Get cached processed circle data if available and fresh
 */
export function getCachedCircleObject(circleId: string): Record<string, unknown> | null {
  const cached = circleObjectCache.get(circleId);
  if (cached && Date.now() - cached.timestamp < CIRCLE_CACHE_TTL) {
    return cached.processed;
  }
  return null;
}

/**
 * Cache processed circle data
 */
export function setCachedCircleObject(
  circleId: string,
  processedData: Record<string, unknown>,
  rawData: Record<string, unknown>
): void {
  circleObjectCache.set(circleId, {
    data: rawData,
    processed: processedData,
    timestamp: Date.now()
  });
}

/**
 * Clear stale entries from circle object cache
 */
export function clearStaleCircleCache(): void {
  const now = Date.now();
  for (const [key, value] of circleObjectCache.entries()) {
    if (now - value.timestamp >= CIRCLE_CACHE_TTL) {
      circleObjectCache.delete(key);
    }
  }
}

/**
 * Batch fetch circle objects with controlled concurrency
 * Prevents overwhelming the RPC endpoint while maximizing throughput
 */
export async function batchFetchCircleObjects(
  circleIds: string[],
  client: SuiClient,
  options: {
    maxConcurrent?: number;
    showContent?: boolean;
    showType?: boolean;
    onProgress?: (fetched: number, total: number) => void;
  } = {}
): Promise<Map<string, Record<string, unknown>>> {
  const { maxConcurrent = 3, showContent = true, showType = true, onProgress } = options;
  
  const results = new Map<string, Record<string, unknown>>();
  const queue = [...circleIds];
  const inProgress = new Set<Promise<void>>();
  
  console.log(`📦 Batch fetching ${circleIds.length} circle objects with max concurrency of ${maxConcurrent}`);
  
  while (queue.length > 0 || inProgress.size > 0) {
    // Fill up to max concurrent requests
    while (inProgress.size < maxConcurrent && queue.length > 0) {
      const circleId = queue.shift()!;
      
      const createPromise = async (): Promise<void> => {
        try {
          const obj = await client.getObject({
            id: circleId,
            options: { showContent, showType }
          });
          results.set(circleId, obj as Record<string, unknown>);
        } catch (error) {
          console.warn(`Failed to fetch circle ${circleId}:`, error);
          results.set(circleId, {});
        }
      };
      
      const promise = createPromise().finally(() => {
        inProgress.delete(promise);
        onProgress?.(results.size, circleIds.length);
      });
      
      inProgress.add(promise);
    }
    
    // Wait for at least one to complete
    if (inProgress.size > 0) {
      await Promise.race(inProgress);
    }
  }
  
  return results;
}

/**
 * Batch query events with automatic chunking to handle large result sets
 * Fetches in parallel across multiple packages
 */
export async function batchQueryEvents(
  packageIds: string[],
  eventType: string,
  client: SuiClient,
  options: {
    maxConcurrent?: number;
    limit?: number;
    order?: 'ascending' | 'descending';
    onProgress?: (processed: number, total: number) => void;
  } = {}
): Promise<Array<Record<string, unknown>>> {
  const { maxConcurrent = 5, limit = 1000, order = 'descending', onProgress } = options;
  
  const allEvents: Array<Record<string, unknown>> = [];
  const queue = [...packageIds];
  const inProgress = new Set<Promise<void>>();
  
  console.log(`🔍 Batch querying ${eventType} across ${packageIds.length} packages`);
  
  while (queue.length > 0 || inProgress.size > 0) {
    // Fill up to max concurrent requests
    while (inProgress.size < maxConcurrent && queue.length > 0) {
      const packageId = queue.shift()!;
      
      const createPromise = async (): Promise<void> => {
        let retryCount = 0;
        const maxRetries = 3;
        
        while (retryCount < maxRetries) {
          try {
            const response = await client.queryEvents({
              query: { MoveEventType: `${packageId}::njangi_circles::${eventType}` },
              limit,
              order
            });
            
            if (response?.data) {
              allEvents.push(...response.data.map(e => e as Record<string, unknown>));
            }
            break; // Success, exit retry loop
          } catch (error) {
            retryCount++;
            const errorMsg = error instanceof Error ? error.message : String(error);
            
            if (retryCount >= maxRetries) {
              console.warn(`Failed to query ${eventType} for package ${packageId} after ${maxRetries} retries:`, errorMsg);
              // Continue without throwing - graceful degradation
            } else {
              const delayMs = Math.pow(2, retryCount - 1) * 500; // 500ms, 1s, 2s backoff
              console.log(`⏳ Retrying query for ${packageId} in ${delayMs}ms...`);
              await new Promise(resolve => setTimeout(resolve, delayMs));
            }
          }
        }
      };
      
      const promise = createPromise().finally(() => {
        inProgress.delete(promise);
        onProgress?.(packageIds.length - queue.length - inProgress.size, packageIds.length);
      });
      
      inProgress.add(promise);
    }
    
    // Wait for at least one to complete
    if (inProgress.size > 0) {
      await Promise.race(inProgress);
    }
  }
  
  return allEvents;
}

/**
 * Optimized dynamic fields fetching with caching and concurrent limits
 * Prevents rate limiting from excessive dynamic field queries
 */
export async function batchFetchDynamicFields(
  circleIds: string[],
  client: SuiClient,
  options: {
    maxConcurrent?: number;
    onProgress?: (fetched: number, total: number) => void;
  } = {}
): Promise<Map<string, Array<Record<string, unknown>>>> {
  const { maxConcurrent = 2, onProgress } = options; // Lower concurrency for dynamic fields (rate limit sensitive)
  
  const results = new Map<string, Array<Record<string, unknown>>>();
  const queue = [...circleIds];
  const inProgress = new Set<Promise<void>>();
  
  console.log(`🔗 Batch fetching dynamic fields for ${circleIds.length} circles`);
  
  while (queue.length > 0 || inProgress.size > 0) {
    // Fill up to max concurrent requests
    while (inProgress.size < maxConcurrent && queue.length > 0) {
      const circleId = queue.shift()!;
      
      const createPromise = async (): Promise<void> => {
        let retryCount = 0;
        const maxRetries = 3;
        
        while (retryCount < maxRetries) {
          try {
            const fields = await client.getDynamicFields({
              parentId: circleId
            });
            results.set(circleId, fields?.data?.map(f => f as Record<string, unknown>) || []);
            break; // Success, exit retry loop
          } catch (error) {
            retryCount++;
            const errorMsg = error instanceof Error ? error.message : String(error);
            
            if (retryCount >= maxRetries) {
              console.warn(`Failed to fetch dynamic fields for circle ${circleId} after ${maxRetries} retries:`, errorMsg);
              results.set(circleId, []); // Set empty array on failure
            } else {
              const delayMs = Math.pow(2, retryCount - 1) * 500; // 500ms, 1s, 2s backoff
              console.log(`⏳ Retrying dynamic fields for ${circleId} in ${delayMs}ms...`);
              await new Promise(resolve => setTimeout(resolve, delayMs));
            }
          }
        }
      };
      
      const promise = createPromise().finally(() => {
        inProgress.delete(promise);
        onProgress?.(results.size, circleIds.length);
      });
      
      inProgress.add(promise);
    }
    
    // Wait for at least one to complete
    if (inProgress.size > 0) {
      await Promise.race(inProgress);
    }
  }
  
  return results;
}

/**
 * Process multiple circle objects efficiently with intelligent batching
 * Applies caching and avoids redundant processing
 */
export async function processCirclesInBatch(
  circleDataArray: Array<{
    objectData: Record<string, unknown>;
    creationEvent?: Record<string, unknown>;
    userAddress: string;
    client?: SuiClient;
    transactionDigest?: string;
  }>,
  processingFn: (
    objectData: Record<string, unknown>,
    userAddress: string,
    event?: Record<string, unknown>,
    client?: SuiClient,
    digest?: string
  ) => Promise<Record<string, unknown> | null>,
  options: {
    maxConcurrent?: number;
    onProgress?: (processed: number, total: number) => void;
  } = {}
): Promise<Map<string, Record<string, unknown> | null>> {
  const { maxConcurrent = 4, onProgress } = options;
  
  const results = new Map<string, Record<string, unknown> | null>();
  const queue = [...circleDataArray];
  const inProgress = new Set<Promise<void>>();
  
  console.log(`⚙️ Processing ${circleDataArray.length} circles in batch with max concurrency of ${maxConcurrent}`);
  
  while (queue.length > 0 || inProgress.size > 0) {
    // Fill up to max concurrent requests
    while (inProgress.size < maxConcurrent && queue.length > 0) {
      const item = queue.shift()!;
      
      const createPromise = async (): Promise<void> => {
        const circleId = (item.objectData?.data as Record<string, unknown>)?.objectId as string | undefined;
        
        try {
          // Check cache first
          const cached = getCachedCircleObject(circleId!);
          if (cached) {
            results.set(circleId!, cached);
            return;
          }
          
          // Process if not cached
          const processed = await processingFn(
            item.objectData,
            item.userAddress,
            item.creationEvent,
            item.client,
            item.transactionDigest
          );
          
          if (processed) {
            setCachedCircleObject(circleId!, processed, item.objectData);
            results.set(circleId!, processed);
          }
        } catch (error) {
          const circleId = (item.objectData?.data as Record<string, unknown>)?.objectId as string | undefined;
          console.warn(`Failed to process circle ${circleId}:`, error);
          results.set(circleId!, null);
        }
      };
      
      const promise = createPromise().finally(() => {
        inProgress.delete(promise);
        onProgress?.(results.size, circleDataArray.length);
      });
      
      inProgress.add(promise);
    }
    
    // Wait for at least one to complete
    if (inProgress.size > 0) {
      await Promise.race(inProgress);
    }
  }
  
  return results;
}

/**
 * Parallel package discovery for users with multiple package versions
 * Fetches package info across multiple endpoints simultaneously
 */
export async function discoverUserPackagesInParallel(
  userAddress: string,
  packageLists: { url: string; packageIds?: string[] }[],
  options: {
    timeout?: number;
  } = {}
): Promise<string[]> {
  const { timeout = 5000 } = options;
  const discoveredPackages = new Set<string>();
  
  // Create parallel queries for each package list
  const queries = packageLists.map(({ url }) =>
    Promise.race([
      (async () => {
        try {
          const client = getSuiClientFromPool(url);
          const response = await client.queryTransactionBlocks({
            filter: { FromAddress: userAddress },
            limit: 500,
            options: { showEvents: true, showObjectChanges: true }
          });
          
          for (const tx of response.data) {
            if (tx.events) {
              for (const event of tx.events) {
                if (event.type.includes('::njangi_circles::CircleCreated')) {
                  const match = event.type.match(/^(0x[a-f0-9]+)::/);
                  if (match?.[1]) discoveredPackages.add(match[1]);
                }
              }
            }
          }
        } catch (error) {
          console.warn(`Package discovery failed for ${url}:`, error);
        }
      })(),
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error('timeout')), timeout))
    ]).catch(() => {}) // Silently ignore timeouts
  );
  
  await Promise.all(queries);
  return Array.from(discoveredPackages);
} 

