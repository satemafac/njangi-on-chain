/* eslint-disable */
import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useRouter } from 'next/router';
import { useAuth } from '../contexts/AuthContext';
import Image from 'next/image';
import { SuiClient } from '@mysten/sui/client';
import { Tab } from '@headlessui/react';
import * as Tooltip from '@radix-ui/react-tooltip';
import * as Dialog from '@radix-ui/react-dialog';
import { priceService } from '../services/price-service';
import { toast } from 'react-hot-toast';
import { Eye, EyeOff, Settings, Trash2, CreditCard, RefreshCw, Users, X, Copy, Link, AlertCircle, Send, Shield, Clock, CheckCircle, ExternalLink, ArrowRightLeft, ChevronDown, ChevronUp } from 'lucide-react';
import RampPicker from '@/components/RampPicker';
import NjangiRoundAlerts from '@/components/NjangiRoundAlerts';
import type { NetworkType } from '@/services/whatsapp-registry-service';
import {
  mapCurrencyCodeToIntent,
  normalizeOnrampProviderFlag,
} from '@/lib/onramp-provider';
import { RAMP_PROVIDER_LABELS, type RampProviderId } from '@/lib/ramp-geo';
import { resolveCircleLifecycleState } from '@/lib/circle-chain';
import { discoverMemberCircleIds } from '@/lib/membership-discovery';
import { readObjects } from '@/lib/sui-read';
import { cetusService } from '@/lib/cetus-service';
import { getCircleConfigFieldsByObjectId, getCircleConfigObjectId } from '@/lib/circle-config';
import { clearWalletBalanceCache, refreshWalletBalances } from '@/lib/wallet';
import type { CoinbaseAssetIntent } from '@/types/coinbase-onramp';
import {
  getPackageId,
  getPackageLookupIdsForCurrentNetwork,
  getUserPackageIds,
} from '../services/circle-service';
// Use alias path for the modal import
import ConfirmationModal from '@/components/ConfirmationModal';
import { useTranslation } from '@/hooks/useTranslation';
import { 
  getCurrentNetwork, 
  getCurrentNetworkConfig, 
  getNetworkConfig,
  type NetworkConfig,
  getCurrentRpcUrl, 
  getCurrentPackageId,
  setCurrentNetwork
} from '../services/network-config';
import {
  getSuiClientFromPool,
  clearSuiClientPool,
  batchFetchCircleObjects,
  batchFetchDynamicFields,
  batchQueryEvents,
  getCachedCircleObject,
  setCachedCircleObject,
  clearStaleCircleCache
} from '../services/circle-service';
import {
  getRpcCandidateUrls,
  getSuiRpcErrorMessage,
  isRateLimitedSuiRpcError,
} from '@/services/sui-rpc-failover';

// Global type declaration for network config
declare global {
  interface Window {
    CURRENT_NETWORK_CONFIG?: {
      rpcUrl: string;
      packageId: string;
      usdcAddress: string;
      networkName: string;
      enoki: {
        apiKey: string | undefined;
        baseUrl: string;
        graphqlUrl: string;
      };
    };
  }
}

// RPC endpoint blacklisting and rotation
interface BlacklistedEndpoint {
  url: string;
  blacklistedUntil: number;
  reason: string;
}

const blacklistedEndpoints = new Map<string, BlacklistedEndpoint>();
const BLACKLIST_DURATION = 10 * 60 * 1000; // 10 minutes

// Helper function to blacklist an RPC endpoint
const blacklistEndpoint = (url: string, reason: string) => {
  const blacklistedUntil = Date.now() + BLACKLIST_DURATION;
  blacklistedEndpoints.set(url, { url, blacklistedUntil, reason });
  console.warn(`🚫 Blacklisted RPC endpoint ${url} until ${new Date(blacklistedUntil).toLocaleTimeString()}: ${reason}`);
};

// Helper function to check if endpoint is blacklisted
const isEndpointBlacklisted = (url: string): boolean => {
  const blacklisted = blacklistedEndpoints.get(url);
  if (!blacklisted) return false;

  if (Date.now() > blacklisted.blacklistedUntil) {
    // Blacklist period expired, remove it
    blacklistedEndpoints.delete(url);
    console.log(`✅ RPC endpoint ${url} removed from blacklist`);
    return false;
  }

  return true;
};

// Enhanced helper function to get RPC URL with blacklisting and rotation
const getJsonRpcUrl = (fallbackIndex: number = 0, excludeBlacklisted: boolean = true): string => {
  const currentNetwork = getCurrentNetwork();
  let rpcUrls = getRpcCandidateUrls(currentNetwork);

  // Filter out blacklisted endpoints if requested
  if (excludeBlacklisted) {
    const originalLength = rpcUrls.length;
    rpcUrls = rpcUrls.filter(url => !isEndpointBlacklisted(url));

    if (rpcUrls.length === 0) {
      console.warn('⚠️ All RPC endpoints are blacklisted, using original list');
      rpcUrls = getRpcCandidateUrls(currentNetwork);
    } else if (rpcUrls.length < originalLength) {
      console.log(`📍 Filtered out ${originalLength - rpcUrls.length} blacklisted RPC endpoints`);
    }
  }

  const rpcUrl = rpcUrls[fallbackIndex % rpcUrls.length];

  // Validate URL format
  try {
    new URL(rpcUrl);
    return rpcUrl;
  } catch (error) {
    console.error('Invalid RPC URL:', rpcUrl);
    // Try next fallback
    if (fallbackIndex < rpcUrls.length - 1) {
      return getJsonRpcUrl(fallbackIndex + 1, excludeBlacklisted);
    }
    // Final fallback based on network
    return getRpcCandidateUrls(currentNetwork)[0];
  }
};

const isNetworkTransportError = (error: unknown): boolean => {
  const errorMessage = getSuiRpcErrorMessage(error);
  return (
    errorMessage.includes('Failed to fetch') ||
    errorMessage.includes('Network request failed') ||
    errorMessage.includes('fetch failed')
  );
};

const isObjectNotFoundError = (error: unknown): boolean => {
  const errorMessage = getSuiRpcErrorMessage(error);
  return (
    errorMessage.includes('not found') ||
    errorMessage.includes('does not exist') ||
    errorMessage.includes('Object does not exist') ||
    errorMessage.includes('404')
  );
};

const isCrossPackageQueryError = (error: unknown): boolean => {
  const errorMessage = getSuiRpcErrorMessage(error);
  return (
    errorMessage.includes('Could not find the referenced transaction events') ||
    errorMessage.includes('referenced transaction') ||
    (errorMessage.includes('TransactionDigest') && errorMessage.includes('not found'))
  );
};

// Some transactions in a user's history (e.g. system txs, or txs whose effects
// a given fullnode hasn't fully materialized) have empty effects. Asking that
// node for balance/object changes then fails with an InvalidParams error. This
// is a data condition, not a bug — degrade the affected page gracefully rather
// than surfacing it as a runtime error overlay.
const isEmptyEffectsError = (error: unknown): boolean => {
  const errorMessage = getSuiRpcErrorMessage(error).toLowerCase();
  return (
    errorMessage.includes('unable to derive balance/object changes because effect is empty') ||
    errorMessage.includes('effect is empty')
  );
};

const isGracefulDashboardQueryError = (error: unknown): boolean => (
  isRateLimitedSuiRpcError(error) ||
  isNetworkTransportError(error) ||
  isObjectNotFoundError(error) ||
  isCrossPackageQueryError(error) ||
  isEmptyEffectsError(error)
);

// Verify a receipt-discovered circle still reflects CURRENT membership. The
// soulbound CircleMembership receipt is only a discovery hint: it persists
// after an admin removes a member, so before trusting a receipt-only candidate
// we confirm the user is the admin or is present in the circle's live members
// table (removed members are deleted from that table). Bounded by the user's
// own memberships — O(user), not O(protocol). Mirrors the MemberRemoved
// filtering the event-discovery path already performs.
const userIsCurrentMemberOrAdmin = async (
  client: SuiClient,
  circleId: string,
  userAddress: string,
): Promise<boolean> => {
  try {
    const obj = await client.getObject({ id: circleId, options: { showContent: true } });
    const content = obj.data?.content;
    if (!content || !('fields' in content)) return false;
    const fields = content.fields as {
      admin?: string;
      members?: { fields?: { id?: { id?: string } } };
    };
    if (fields.admin === userAddress) return true;
    const membersTableId = fields.members?.fields?.id?.id;
    if (!membersTableId) return false;
    const memberField = await client.getDynamicFieldObject({
      parentId: membersTableId,
      name: { type: 'address', value: userAddress },
    });
    return Boolean(memberField.data?.content);
  } catch {
    // On a transient read failure, fail closed (don't surface an unverified
    // circle). The event path / next refresh will pick it up.
    return false;
  }
};

// Global request queue and rate limiting
interface QueuedRequest {
  apiCall: () => Promise<any>;
  operationName: string;
  priority: number; // Lower numbers = higher priority
  resolve: (value: any) => void;
  reject: (error: Error) => void;
}

class RateLimitedRequestQueue {
  private queue: QueuedRequest[] = [];
  private activeRequests = 0;
  private readonly maxConcurrent = 2; // Allow 2 concurrent requests with official RPC
  private readonly baseDelay = 1000; // 1 second delay - official RPC is more lenient
  private lastRequestTime = 0;
  private globalPauseUntil = 0; // Global pause timestamp
  private readonly GLOBAL_PAUSE_DURATION = 30000; // 30 second pause after 429
  
  async enqueue<T>(
    apiCall: () => Promise<T>,
    operationName: string,
    priority: number = 5
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push({
        apiCall,
        operationName,
        priority,
        resolve,
        reject
      });

      // Sort by priority (lower numbers first)
      this.queue.sort((a, b) => a.priority - b.priority);

      // Trigger queue processing - catch to prevent unhandled rejections
      this.processQueue().catch(e => console.error('Error starting queue processing:', e));
    });
  }
  
  // Method to trigger global pause when 429 occurs
  private triggerGlobalPause() {
    this.globalPauseUntil = Date.now() + this.GLOBAL_PAUSE_DURATION;
    console.warn(`🚫 Global API pause triggered for ${this.GLOBAL_PAUSE_DURATION / 1000} seconds due to 429 error`);
  }

  private async processQueue() {
    // Wrap entire method to ensure errors never escape to global handler
    try {
      // Check if we're in a global pause period
      const now = Date.now();
      if (now < this.globalPauseUntil) {
        const remainingPause = this.globalPauseUntil - now;
        console.log(`⏸️ Global pause active, waiting ${Math.ceil(remainingPause / 1000)}s before processing requests`);
        setTimeout(() => this.processQueue().catch(() => {}), Math.min(remainingPause, 5000));
        return;
      }

      if (this.activeRequests >= this.maxConcurrent || this.queue.length === 0) {
        return;
      }

      const request = this.queue.shift()!;
      this.activeRequests++;

      try {
        // Ensure minimum delay between requests
        const timeSinceLastRequest = Date.now() - this.lastRequestTime;
        const remainingDelay = this.baseDelay - timeSinceLastRequest;

        if (remainingDelay > 0) {
          await new Promise(resolve => setTimeout(resolve, remainingDelay));
        }

        this.lastRequestTime = Date.now();

        // Execute the API call - any error will be caught below
        const result = await request.apiCall();
        request.resolve(result);
      } catch (error) {
        // Check if this is a 429 error and trigger global pause
        if (isRateLimitedSuiRpcError(error)) {
          this.triggerGlobalPause();
        }

        // Reject the promise - caller's try-catch will handle it
        request.reject(error as Error);
      } finally {
        this.activeRequests--;
        // Process next request - wrap in catch to prevent unhandled rejections
        setTimeout(() => this.processQueue().catch(e => console.error('Queue processing error:', e)), 500);
      }
    } catch (outerError) {
      // Ultimate safety net - log but never throw
      console.error('CRITICAL: Unhandled error in processQueue:', outerError);
    }
  }
}

const globalRequestQueue = new RateLimitedRequestQueue();

// Cache for getUserPackageIds to avoid repeated expensive queries
const userPackageIdsCache = new Map<string, { 
  packageIds: string[], 
  timestamp: number 
}>();
const PACKAGE_IDS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes cache

// Cached version of getUserPackageIds
const getCachedUserPackageIds = async (userAddress: string): Promise<string[]> => {
  const cacheKey = userAddress;
  const cached = userPackageIdsCache.get(cacheKey);
  const now = Date.now();
  
  // Return cached result if still valid
  if (cached && (now - cached.timestamp < PACKAGE_IDS_CACHE_TTL)) {
    console.log(`🎯 Using cached package IDs for user ${userAddress.slice(0, 6)}...`);
    return cached.packageIds;
  }
  
  // Fetch fresh package IDs
  console.log(`🔍 Fetching fresh package IDs for user ${userAddress.slice(0, 6)}...`);
  try {
    const packageIds = await getUserPackageIds(userAddress);
    
    // Cache the result
    userPackageIdsCache.set(cacheKey, {
      packageIds,
      timestamp: now
    });
    
    return packageIds;
  } catch (error) {
    console.warn('Error getting user package IDs, using fallback:', error);
    // Fall back to the full current-network lineage, not just one package ID.
    return getPackageLookupIdsForCurrentNetwork(getPackageId());
  }
};

// Enhanced retry function with 429 rate limiting detection, RPC rotation, and blacklisting
const retryApiCall = async (
  apiCall: () => Promise<any>,
  maxRetries: number = 3,
  baseDelay: number = 1000,
  operationName: string = 'API call',
  priority: number = 5,
  currentRpcUrl?: string,
  gracefulFailure: boolean = false // If true, return null instead of throwing for expected errors
): Promise<any> => {
  let lastError: Error | null = null;
  let lastExpectedHandledError = false;
  let rpcRotationAttempted = false;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      console.log(`${operationName} attempt ${attempt + 1}/${maxRetries}`);

      // Use the rate-limited queue for all requests
      const result = await globalRequestQueue.enqueue(apiCall, operationName, priority);

      if (attempt > 0) {
        console.log(`${operationName} succeeded after ${attempt + 1} attempts`);
      }
      return result;
    } catch (error) {
      lastError = error as Error;
      const errorMessage = getSuiRpcErrorMessage(error);

      // Enhanced error categorization with 429 detection and multi-package support
      const isRateLimited = isRateLimitedSuiRpcError(error);
      const isNetworkError = isNetworkTransportError(error);
      const isObjectNotFound = isObjectNotFoundError(error);
      const isCrossPackageError = isCrossPackageQueryError(error);
      const isEmptyEffects = isEmptyEffectsError(error);
      const isExpectedHandledError =
        gracefulFailure || isRateLimited || isNetworkError || isObjectNotFound || isCrossPackageError || isEmptyEffects;
      lastExpectedHandledError = isExpectedHandledError;

      if (isExpectedHandledError) {
        console.warn(`${operationName} failed (attempt ${attempt + 1}): ${errorMessage}`);
      } else {
        console.error(`${operationName} failed (attempt ${attempt + 1}):`, error);
      }

      // Handle 429 errors with blacklisting and RPC rotation
      if (isRateLimited) {
        // Blacklist the current RPC endpoint if we know which one it is
        if (currentRpcUrl) {
          blacklistEndpoint(currentRpcUrl, '429 Rate Limited');
        }

        // On the first 429 error, try rotating to a different RPC endpoint
        if (!rpcRotationAttempted && attempt < maxRetries - 1) {
          rpcRotationAttempted = true;
          console.log(`🔄 ${operationName} - Attempting RPC rotation due to 429 error`);

          // Get a different RPC URL (blacklisted ones will be filtered out)
          const newRpcUrl = getJsonRpcUrl(1, true); // Start from index 1 to get different URL
          if (newRpcUrl !== currentRpcUrl) {
            console.log(`🌍 ${operationName} - Switching RPC from ${currentRpcUrl} to ${newRpcUrl}`);

            // Create new API call with different RPC URL
            // Note: This requires the apiCall to be re-created with new RPC URL
            // For now, we'll still apply the delay but this gives us the framework for RPC switching
          }
        }

        // Exponential backoff for rate limiting: 10s, 30s, 90s, 300s (5 min)
        if (attempt < maxRetries - 1) {
          const rateLimitDelays = [10000, 30000, 90000, 300000];
          const delay = rateLimitDelays[Math.min(attempt, rateLimitDelays.length - 1)];

          console.warn(`${operationName} - Rate limited (429). Waiting ${delay}ms before retry ${attempt + 2}/${maxRetries}`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
      }

      // Network mismatch detection - if object not found, it might be on different network
      if (isObjectNotFound) {
        console.warn(`${operationName} - Object not found, might be network mismatch. Skipping retries.`);
        throw new Error(`Network mismatch: Object not found on current network (${getCurrentNetwork()})`);
      }

      // Cross-package error detection - transaction events from different package deployment
      if (isCrossPackageError) {
        console.warn(`${operationName} - Cross-package error detected. This might be from a different package deployment. Skipping retries.`);
        throw new Error(`Cross-package error: Referenced transaction events not found with current package ID (this is expected for multi-package queries)`);
      }

      // Handle other network errors with standard exponential backoff
      if (attempt < maxRetries - 1 && (isNetworkError) && !isObjectNotFound && !isCrossPackageError) {
        const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 500; // Reduced jitter
        console.log(`Retrying ${operationName} in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      } else if (attempt === maxRetries - 1) {
        if (lastExpectedHandledError) {
          console.warn(`${operationName} failed after ${maxRetries} attempts`);
        } else {
          console.error(`${operationName} failed after ${maxRetries} attempts`);
        }
        break;
      } else {
        // Non-retryable error, don't retry
        console.log(`${operationName} - Non-retryable error, stopping attempts`);
        break;
      }
    }
  }

  // Handle graceful failure mode for cross-package queries
  if (gracefulFailure && lastError) {
    // These are expected errors for cross-package/cross-network queries and
    // supplementary lookups that should not break the whole dashboard load.
    if (isGracefulDashboardQueryError(lastError)) {
      console.log(`${operationName} - Graceful failure: returning empty result for expected cross-package error`);
      return { data: [] }; // Return empty result instead of throwing
    }
  }

  throw lastError || new Error(`${operationName} failed after ${maxRetries} attempts`);
};

// Circle type definition
interface Circle {
  id: string;
  name: string;
  admin: string;
  contributionAmount: number;
  contributionAmountUsd: number; // This will now represent local currency amount
  currencyType?: string; // Add currency type field
  securityDeposit: number;
  securityDepositUsd: number; // This will now represent local currency amount
  cycleLength: number;
  cycleDay: number;
  maxMembers: number;
  currentMembers: number;
  nextPayoutTime: number;
  memberStatus: 'active' | 'suspended' | 'exited';
  isAdmin: boolean;
  isActive: boolean;
  walletId?: string; // Add optional wallet ID
  createdAt?: number; // Add creation timestamp for better sorting
  transactionDigest?: string; // Add transaction digest for reference
  packageId?: string; // Package ID used to create this circle (for cross-version compatibility)
}

// Type definitions for SUI event payloads
interface CircleCreatedEvent {
  circle_id: string;
  admin: string;
  name: string;
  contribution_amount: string;
  currency_type?: string;                  // Currency code (e.g., "USD", "XAF", "NGN")
  contribution_amount_local?: string;      // Amount in local currency
  security_deposit_local?: string;         // Amount in local currency
  max_members: string;
  cycle_length: string;
}

// Enhanced MemberJoined event interface with comprehensive member information
interface MemberJoinedEvent {
  circle_id: string;
  member: string;
  position?: number;
  member_status?: number;                 // Optional on older deployments
  currency_type?: string;                 // Currency code (e.g., "USD", "XAF", "NGN")
  contribution_amount_local?: string;     // Contribution amount in local currency
  security_deposit_local?: string;        // Security deposit in local currency
  deposit_paid?: boolean;                 // Whether the member has paid their deposit
  joined_at?: string;                     // Timestamp when member joined (as string from blockchain)
}

// MemberRemoved event interface - emitted when admin removes a member
interface MemberRemovedEvent {
  circle_id: string;
  member: string;
  removed_by: string;
  deposit_returned: boolean;
  deposit_amount: string;
  timestamp: string;
}

// Member status constants for easy filtering
const MEMBER_STATUS = {
  ACTIVE: 0,
  PENDING: 1,
  SUSPENDED: 2,
  EXITED: 3
} as const;

const isDiscoverableMemberEvent = (event: MemberJoinedEvent): boolean => (
  event.member_status == null ||
  event.member_status === MEMBER_STATUS.ACTIVE ||
  event.member_status === MEMBER_STATUS.PENDING
);

const mergeDiscoveredCircleEvents = (primaryEvents: any[], supplementalEvents: any[]): any[] => {
  const mergedEvents = new Map<string, any>();

  const getEventKey = (event: any): string => {
    const txDigest = event?.id?.txDigest;
    const eventSeq = event?.id?.eventSeq;
    if (txDigest && eventSeq != null) {
      return `${txDigest}:${eventSeq}`;
    }

    const eventType = typeof event?.type === 'string' ? event.type : 'unknown';
    const circleId = (event?.parsedJson as { circle_id?: string } | undefined)?.circle_id ?? 'unknown';
    return `${eventType}:${circleId}:${event?.timestampMs ?? ''}`;
  };

  for (const event of [...primaryEvents, ...supplementalEvents]) {
    mergedEvents.set(getEventKey(event), event);
  }

  return Array.from(mergedEvents.values()).sort(
    (left, right) => Number(right?.timestampMs || 0) - Number(left?.timestampMs || 0),
  );
};

interface CustodyDepositedEvent {
  circle_id: string;
  member: string;
  amount: string;
  operation_type: number;
  wallet_id: string;
}

// Add these type definitions at the top of the file with other interfaces
interface TransactionBlock {
  transactions?: Array<{
    kind: string;
    target: string;
    arguments: Array<{
      kind: string;
      index: number;
      type: string;
      value: string;
    }>;
  }>;
  moveCall?: {
    packageObjectId: string;
    module: string;
    function: string;
    typeArguments: string[];
    arguments: string[];
  };
}

interface TransactionOptions {
  showEffects: boolean;
  showEvents: boolean;
}

interface TransactionBlockPayload {
  transactionBlock: TransactionBlock;
  options: TransactionOptions;
}

type HistoryDirection = 'received' | 'sent' | 'mixed' | 'neutral';

interface TransactionHistoryAmount {
  coinType: string;
  symbol: string;
  formattedAmount: string;
  rawAmount: bigint;
  direction: 'received' | 'sent';
}

interface TransactionHistoryItem {
  digest: string;
  timestamp: Date;
  type: string;
  direction: HistoryDirection;
  sentAmounts: TransactionHistoryAmount[];
  receivedAmounts: TransactionHistoryAmount[];
  status: 'Success' | 'Failed';
  gasFee: number;
  explorerUrl: string;
}

const HISTORY_FETCH_LIMIT = 60;

const getHistoryTokenMetadata = (
  coinType: string,
  networkConfig: NetworkConfig,
): { symbol: string; decimals: number } => {
  if (coinType === networkConfig.coinTypes.SUI) {
    return { symbol: 'SUI', decimals: 9 };
  }

  if (
    coinType === networkConfig.coinTypes.USDC ||
    coinType === networkConfig.tokens.USDC
  ) {
    return { symbol: 'USDC', decimals: 6 };
  }

  if (
    networkConfig.tokens.USDT &&
    coinType === networkConfig.tokens.USDT
  ) {
    return { symbol: 'USDT', decimals: 6 };
  }

  const fallbackSymbol = coinType.split('::').pop()?.toUpperCase() || 'TOKEN';
  return {
    symbol: fallbackSymbol,
    decimals: fallbackSymbol === 'SUI' ? 9 : 6,
  };
};

const formatHistoryTokenAmount = (rawAmount: bigint, decimals: number): string => {
  const fixed = (Number(rawAmount) / 10 ** decimals).toFixed(4);
  return fixed.replace(/\.?0+$/, '');
};

const getNetGasFeeMist = (tx: any): bigint => {
  const gasUsed = tx.effects?.gasUsed;
  if (!gasUsed) {
    return BigInt(0);
  }

  const computationCost = BigInt(gasUsed.computationCost || 0);
  const storageCost = BigInt(gasUsed.storageCost || 0);
  const storageRebate = BigInt(gasUsed.storageRebate || 0);

  return computationCost + storageCost - storageRebate;
};

const getHistoryExplorerUrl = (network: 'mainnet' | 'testnet', digest: string): string =>
  `https://explorer.sui.io/txblock/${digest}?network=${network}`;

const extractMoveCalls = (
  tx: any,
): Array<{ module: string; functionName: string; typeArguments: string[] }> => {
  const transactions = tx.transaction?.data?.transaction?.transactions ?? [];

  return transactions.flatMap((entry: any) => {
    const moveCall = entry?.MoveCall;
    if (!moveCall) {
      return [];
    }

    return [{
      module: moveCall.module,
      functionName: moveCall.function,
      typeArguments: moveCall.type_arguments || moveCall.typeArguments || [],
    }];
  });
};

const extractFallbackAmountsFromEvents = (
  tx: any,
  userAddress: string,
  networkConfig: NetworkConfig,
  moveCalls: Array<{ module: string; functionName: string; typeArguments: string[] }>,
): Array<{ coinType: string; rawAmount: bigint }> => {
  const fallbackAmounts: Array<{ coinType: string; rawAmount: bigint }> = [];
  const normalizedUserAddress = userAddress.toLowerCase();
  const primaryTypeArg = moveCalls.find((call) => call.typeArguments.length > 0)?.typeArguments[0];
  const usesStablecoinPath = moveCalls.some(
    (call) =>
      call.functionName.includes('stablecoin') ||
      call.typeArguments.some((typeArg) => typeArg === networkConfig.coinTypes.USDC),
  );
  const defaultCoinType = primaryTypeArg ||
    (usesStablecoinPath ? networkConfig.coinTypes.USDC : networkConfig.coinTypes.SUI);

  for (const event of tx.events || []) {
    const eventType = typeof event.type === 'string' ? event.type : '';
    const parsedJson = event.parsedJson as Record<string, unknown> | undefined;
    if (!parsedJson) {
      continue;
    }

    const eventMember = typeof parsedJson.member === 'string'
      ? parsedJson.member.toLowerCase()
      : null;
    const rawAmount = parsedJson.amount != null ? BigInt(String(parsedJson.amount)) : BigInt(0);
    if (rawAmount === BigInt(0)) {
      continue;
    }

    if (
      eventType.includes('SecurityDepositReturned') &&
      eventMember === normalizedUserAddress
    ) {
      fallbackAmounts.push({
        coinType: defaultCoinType,
        rawAmount,
      });
      continue;
    }

    if (
      eventType.includes('CustodyDeposited') &&
      eventMember === normalizedUserAddress
    ) {
      fallbackAmounts.push({
        coinType:
          parsedJson.coin_type === 'stablecoin'
            ? networkConfig.coinTypes.USDC
            : defaultCoinType,
        rawAmount: -rawAmount,
      });
    }
  }

  return fallbackAmounts;
};

const buildHistoryAmounts = (
  tx: any,
  userAddress: string,
  networkConfig: NetworkConfig,
): {
  sentAmounts: TransactionHistoryAmount[];
  receivedAmounts: TransactionHistoryAmount[];
} => {
  const normalizedUserAddress = userAddress.toLowerCase();
  const moveCalls = extractMoveCalls(tx);
  const userBalanceChanges = Array.isArray(tx.balanceChanges)
    ? tx.balanceChanges
        .filter((change: any) => change.owner?.AddressOwner?.toLowerCase() === normalizedUserAddress)
        .map((change: any) => ({
          coinType: change.coinType,
          rawAmount: BigInt(change.amount),
        }))
    : [];

  const netGasFeeMist = getNetGasFeeMist(tx);
  const adjustedBalanceChanges = [...userBalanceChanges];

  if (netGasFeeMist > BigInt(0)) {
    const negativeSuiIndex = adjustedBalanceChanges.findIndex(
      (change) =>
        change.coinType === networkConfig.coinTypes.SUI &&
        change.rawAmount < BigInt(0),
    );

    if (negativeSuiIndex >= 0) {
      adjustedBalanceChanges[negativeSuiIndex] = {
        ...adjustedBalanceChanges[negativeSuiIndex],
        rawAmount: adjustedBalanceChanges[negativeSuiIndex].rawAmount + netGasFeeMist,
      };
    }
  }

  const meaningfulChanges = adjustedBalanceChanges.filter(
    (change) => change.rawAmount !== BigInt(0),
  );

  const fallbackChanges =
    meaningfulChanges.length > 0
      ? meaningfulChanges
      : extractFallbackAmountsFromEvents(tx, userAddress, networkConfig, moveCalls);

  const sentAmounts = fallbackChanges
    .filter((change) => change.rawAmount < BigInt(0))
    .map((change) => {
      const metadata = getHistoryTokenMetadata(change.coinType, networkConfig);
      const absoluteAmount = change.rawAmount * BigInt(-1);

      return {
        coinType: change.coinType,
        symbol: metadata.symbol,
        formattedAmount: formatHistoryTokenAmount(absoluteAmount, metadata.decimals),
        rawAmount: absoluteAmount,
        direction: 'sent' as const,
      };
    });

  const receivedAmounts = fallbackChanges
    .filter((change) => change.rawAmount > BigInt(0))
    .map((change) => {
      const metadata = getHistoryTokenMetadata(change.coinType, networkConfig);

      return {
        coinType: change.coinType,
        symbol: metadata.symbol,
        formattedAmount: formatHistoryTokenAmount(change.rawAmount, metadata.decimals),
        rawAmount: change.rawAmount,
        direction: 'received' as const,
      };
    });

  return { sentAmounts, receivedAmounts };
};

const getTransactionHistoryLabel = (
  tx: any,
  direction: HistoryDirection,
): string => {
  const moveCalls = extractMoveCalls(tx);
  const functions = moveCalls.map(
    (call) => `${call.module}::${call.functionName}`,
  );
  const eventTypes: string[] = (tx.events || []).map(
    (event: any): string => String(event.type || ''),
  );

  if (functions.some((value) => value.endsWith('::member_deposit_security_deposit'))) {
    return 'Security Deposit';
  }

  if (
    functions.some(
      (value) =>
        value.endsWith('::contribute') ||
        value.endsWith('::contribute_stablecoin') ||
        value.endsWith('::contribute_to_circle'),
    )
  ) {
    return 'Contribution';
  }

  if (eventTypes.some((value) => value.includes('SecurityDepositReturned'))) {
    return 'Deposit Return';
  }

  if (
    functions.some(
      (value) =>
        value.endsWith('::trigger_payout') ||
        value.endsWith('::claim_payout'),
    )
  ) {
    return 'Payout';
  }

  if (functions.some((value) => value.endsWith('::create_circle'))) {
    return 'Create Circle';
  }

  if (
    functions.some(
      (value) =>
        value.endsWith('::join_circle') ||
        value.endsWith('::admin_approve_member') ||
        value.endsWith('::admin_approve_members'),
    )
  ) {
    return 'Join Circle';
  }

  if (functions.some((value) => value.endsWith('::delete_circle'))) {
    return 'Delete Circle';
  }

  if (functions.some((value) => value.endsWith('::activate_circle'))) {
    return 'Activate Circle';
  }

  if (
    functions.some(
      (value) =>
        value.includes('swap') ||
        value.endsWith('::deposit') ||
        value.endsWith('::swap_b2a'),
    )
  ) {
    return 'Swap';
  }

  if (functions.length > 0) {
    return 'Contract Interaction';
  }

  if (direction === 'received') {
    return 'Receive';
  }

  if (direction === 'sent') {
    return 'Send';
  }

  return 'Transaction';
};

// Declare global wallet type - updated to include all possible wallet objects
declare global {
  interface Window {
    suiWallet?: {
      // Original API methods
      constructTransaction?: (txData: {
        kind: string;
        data: {
          packageObjectId: string;
          module: string;
          function: string;
          typeArguments: string[];
          arguments: string[];
          gasBudget: number;
        }
      }) => unknown;
      
      signAndExecuteTransaction?: (tx: {
        transaction: unknown;
      }) => Promise<Record<string, unknown>>;
      
      // New API methods
      signAndExecuteTransactionBlock?: (tx: TransactionBlockPayload) => Promise<Record<string, unknown>>;
      
      signTransactionBlock?: (tx: {
        transactionBlock: TransactionBlock;
        options?: {
          showEffects?: boolean;
          showEvents?: boolean;
        };
      }) => Promise<unknown>;
      
      // General connection methods that might be required
      hasPermissions?: () => Promise<boolean>;
      requestPermissions?: () => Promise<boolean>;
      getAccounts?: () => Promise<string[]>;
    };
    
    // Alternative wallet object names used by different SUI wallet versions
    sui?: typeof Window.prototype.suiWallet;
    suix?: typeof Window.prototype.suiWallet;
    ethos?: typeof Window.prototype.suiWallet;
    suiet?: typeof Window.prototype.suiWallet;
    martian?: typeof Window.prototype.suiWallet;
  }
}

// Update the TokenIcon component to use existing SVG files for SUI and USDC
// Skeleton loading component for circle cards
const CircleCardSkeleton = () => (
  <div className="animate-pulse rounded-[28px] border border-stone-200 bg-white p-6 shadow-[0_18px_50px_-38px_rgba(15,23,42,0.35)]">
    <div className="flex items-start justify-between gap-4">
      <div className="space-y-3">
        <div className="h-4 w-20 rounded-full bg-stone-200"></div>
        <div className="h-7 w-48 rounded-full bg-stone-200"></div>
        <div className="h-4 w-32 rounded-full bg-stone-200"></div>
      </div>
      <div className="h-9 w-24 rounded-full bg-stone-200"></div>
    </div>
    <div className="mt-8 grid grid-cols-2 gap-4">
      {Array.from({ length: 4 }).map((_, index) => (
        <div key={index} className="rounded-2xl border border-stone-100 bg-stone-50 p-4">
          <div className="h-3 w-20 rounded-full bg-stone-200"></div>
          <div className="mt-3 h-5 w-28 rounded-full bg-stone-200"></div>
        </div>
      ))}
    </div>
    <div className="mt-6 flex gap-3">
      <div className="h-10 w-24 rounded-full bg-stone-200"></div>
      <div className="h-10 w-28 rounded-full bg-stone-200"></div>
    </div>
  </div>
);

const TokenIcon = ({ symbol }: { symbol: string }) => {
  // Define the path to each token icon
  const iconPath = (tokenSymbol: string): string => {
    const normalizedSymbol = tokenSymbol.toLowerCase();
    
    // Use existing SVG files for SUI and USDC
    if (normalizedSymbol === 'sui') {
      return '/images/sui-sui-logo.svg';
    }
    
    if (normalizedSymbol === 'usdc') {
      return '/images/usd-coin-usdc-logo.svg';
    }
    
    // For other tokens, use the assets/icons directory
    const supportedTokens = ['usdt', 'btc', 'eth'];
    if (supportedTokens.includes(normalizedSymbol)) {
      return `/assets/icons/${normalizedSymbol}.svg`;
    }
    
    // Return the unknown token icon for any unsupported token
    return '/assets/icons/unknown.svg';
  };
  
  return (
    <img 
      src={iconPath(symbol)}
      alt={`${symbol} icon`}
      className="h-5 w-5"
      loading="lazy"
      style={{ objectFit: 'contain' }}
      onError={(e) => {
        // Fallback if the image fails to load
        console.error(`Failed to load icon for ${symbol}`);
        (e.target as HTMLImageElement).src = '/assets/icons/unknown.svg';
      }}
    />
  );
};

// Define types for SUI object field values
type SuiValue = string | number | boolean | null | undefined | SuiValue[] | Record<string, unknown>;

// Define an interface for the object data structure
interface EnhancedObjectData {
  data?: {
    objectId?: string;
    content?: {
      fields: Record<string, SuiValue>;
      [key: string]: unknown;
    };
    dynamicFields?: Array<{
      name?: string;
      type?: string;
      objectId?: string;
      content?: {
        fields?: Record<string, SuiValue>;
      };
      value?: Record<string, SuiValue>;
    }>;
    [key: string]: unknown;
  };
  transactionInput?: {
    cycle_day?: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

// Define type for transaction input data
interface TransactionInputData {
  cycle_day?: number;
  [key: string]: unknown;
}

// Add transfer-related interfaces
interface TransferFormData {
  recipientAddress: string;
  amount: string;
  selectedToken: string;
  memo?: string;
}

interface TransferValidation {
  isValid: boolean;
  errors: {
    recipientAddress?: string;
    amount?: string;
    balance?: string;
    general?: string;
  };
  warnings: {
    highValue?: string;
    newAddress?: string;
    testnet?: string;
  };
}

interface RecentContact {
  address: string;
  name?: string;
  lastUsed: number;
  frequency: number;
}

type CircleViewKey = 'all' | 'admin' | 'member';

// Add caching interfaces and constants at the top after other interfaces
interface CachedData<T> {
  data: T;
  timestamp: number;
  version: string;
}


// Cache configuration - optimized for better user experience and network consistency
const CACHE_CONFIG = {
  CIRCLES_TTL: 10 * 60 * 1000, // 10 minutes for circles data (synchronized for consistency)
  EVENTS_TTL: 15 * 60 * 1000, // 15 minutes for events data (reduced for fresher data)
  API_RESPONSE_TTL: 10 * 60 * 1000, // 10 minutes for individual API responses (synchronized)
  VERSION: '1.0.3' // Increment when data structure changes - updated for lifecycle/package-lineage fixes
};

// Enhanced cache keys with network fingerprinting to prevent cross-network contamination
const getCacheKey = (userAddress: string, type: string, identifier?: string) => {
  const currentNetwork = getCurrentNetwork();
  const networkConfig = getCurrentNetworkConfig();
  // Create a network fingerprint using package ID and RPC URL hash
  const networkFingerprint = btoa(`${networkConfig.packageId}-${networkConfig.rpcUrl}`).slice(0, 8);
  const base = `njangi_cache_${currentNetwork}_${networkFingerprint}_${userAddress}_${type}`;
  return identifier ? `${base}_${identifier}` : base;
};

// Cache utilities
const setCacheItem = (key: string, data: any) => {
  try {
    const cacheItem: CachedData<any> = {
      data,
      timestamp: Date.now(),
      version: CACHE_CONFIG.VERSION
    };
    localStorage.setItem(key, JSON.stringify(cacheItem));
  } catch (error) {
    console.warn('Failed to cache data:', error);
  }
};

const getCacheItem = (key: string, ttl: number = CACHE_CONFIG.CIRCLES_TTL): any | null => {
  try {
    const cached = localStorage.getItem(key);
    if (!cached) return null;
    
    const cacheItem: CachedData<any> = JSON.parse(cached);
    
    // Check version compatibility
    if (cacheItem.version !== CACHE_CONFIG.VERSION) {
      console.log('Cache version mismatch, invalidating:', { expected: CACHE_CONFIG.VERSION, found: cacheItem.version });
      localStorage.removeItem(key);
      return null;
    }
    
    // Enhanced network validation - check if key matches current network context
    const currentNetwork = getCurrentNetwork();
    const networkConfig = getCurrentNetworkConfig();
    const expectedFingerprint = btoa(`${networkConfig.packageId}-${networkConfig.rpcUrl}`).slice(0, 8);
    
    if (!key.includes(`${currentNetwork}_${expectedFingerprint}`)) {
      console.log('Network fingerprint mismatch, invalidating cache:', { key: key.slice(0, 50) + '...', currentNetwork, expectedFingerprint });
      localStorage.removeItem(key);
      return null;
    }
    
    // Check if cache is still valid
    if (Date.now() - cacheItem.timestamp > ttl) {
      localStorage.removeItem(key);
      return null;
    }
    
    return cacheItem.data;
  } catch (error) {
    console.warn('Failed to retrieve cached data:', error);
    localStorage.removeItem(key);
    return null;
  }
};

const isCacheStale = (key: string, ttl: number = CACHE_CONFIG.CIRCLES_TTL): boolean => {
  try {
    const cached = localStorage.getItem(key);
    if (!cached) return true;
    
    const cacheItem: CachedData<any> = JSON.parse(cached);
    return Date.now() - cacheItem.timestamp > ttl;
  } catch (error) {
    return true;
  }
};

// Enhanced cache clearing with network fingerprint awareness
const clearUserCache = (userAddress: string, network?: string) => {
  const keysToRemove: string[] = [];
  const targetNetwork = network || getCurrentNetwork();
  
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.includes('njangi_cache_')) {
      // Clear all njangi cache for the user, including old fingerprint formats
      if (key.includes(`_${userAddress}_`) || key.includes(`${targetNetwork}_`)) {
        keysToRemove.push(key);
      }
    }
  }
  keysToRemove.forEach(key => localStorage.removeItem(key));
  console.log(`🗑️ Enhanced cache clear: Removed ${keysToRemove.length} cached items for ${targetNetwork} network`);
};
// New function to clear stale cache entries across all users and networks
const clearStaleCache = () => {
  const keysToRemove: string[] = [];
  const currentTime = Date.now();
  
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith('njangi_cache_')) {
      try {
        const cached = localStorage.getItem(key);
        if (cached) {
          const cacheItem: CachedData<any> = JSON.parse(cached);
          // Remove if version mismatch or very old (24 hours)
          if (cacheItem.version !== CACHE_CONFIG.VERSION || 
              currentTime - cacheItem.timestamp > 24 * 60 * 60 * 1000) {
            keysToRemove.push(key);
          }
        }
      } catch (error) {
        // If can't parse, remove it
        keysToRemove.push(key);
      }
    }
  }
  
  keysToRemove.forEach(key => localStorage.removeItem(key));
  if (keysToRemove.length > 0) {
    console.log(`🧹 Cleaned up ${keysToRemove.length} stale cache entries`);
  }
};

// Enhanced circuit breaker state management with 429-specific handling
const circuitBreakers = new Map<string, {
  failures: number;
  rateLimitFailures: number; // Track 429 errors separately
  lastFailureTime: number;
  lastRateLimitTime: number; // Track last 429 error
  state: 'closed' | 'open' | 'half-open' | 'rate_limited';
  consecutiveRateLimits: number;
}>();

const CIRCUIT_BREAKER_CONFIG = {
  failureThreshold: 3, // Reduced threshold for faster response
  rateLimitThreshold: 2, // Threshold for 429 errors
  timeoutWindow: 60000, // 1 minute
  retryDelay: 30000, // 30 seconds for regular errors
  rateLimitDelay: 120000, // 2 minutes for rate limit recovery
  rateLimitExtendedTtl: 30 * 60 * 1000 // 30 minutes cache TTL during rate limiting
};

// Enhanced API response caching with 429-aware circuit breaker
const cachedApiCall = async (
  cacheKey: string,
  apiCall: () => Promise<any>,
  ttl: number = CACHE_CONFIG.API_RESPONSE_TTL
): Promise<any> => {
  // Try to get from cache first
  const cached = getCacheItem(cacheKey, ttl);
  if (cached) {
    return cached;
  }
  
  // Check circuit breaker state
  const circuitKey = `circuit_${cacheKey.split('_')[0]}`; // Group by operation type
  const circuitState = circuitBreakers.get(circuitKey) || {
    failures: 0,
    rateLimitFailures: 0,
    lastFailureTime: 0,
    lastRateLimitTime: 0,
    state: 'closed' as const,
    consecutiveRateLimits: 0
  };
  
  const now = Date.now();
  
  // Enhanced circuit breaker logic with 429 handling
  if (circuitState.state === 'rate_limited') {
    if (now - circuitState.lastRateLimitTime < CIRCUIT_BREAKER_CONFIG.rateLimitDelay) {
      console.warn(`Circuit breaker RATE_LIMITED for ${circuitKey}, using extended cache if available`);
      // Use much longer TTL for rate-limited scenarios
      const staleCache = getCacheItem(cacheKey, CIRCUIT_BREAKER_CONFIG.rateLimitExtendedTtl);
      if (staleCache) {
        console.log(`Using extended cache data for rate-limited ${circuitKey}`);
        return staleCache;
      }
      throw new Error(`Rate limited: Service temporarily unavailable for ${circuitKey}. Try again in ${Math.ceil((CIRCUIT_BREAKER_CONFIG.rateLimitDelay - (now - circuitState.lastRateLimitTime)) / 1000)}s`);
    } else {
      // Move to half-open state
      circuitState.state = 'half-open';
      circuitState.consecutiveRateLimits = 0;
      console.log(`Rate limit recovery: Circuit breaker moving to HALF-OPEN state for ${circuitKey}`);
    }
  } else if (circuitState.state === 'open') {
    if (now - circuitState.lastFailureTime < CIRCUIT_BREAKER_CONFIG.retryDelay) {
      console.warn(`Circuit breaker OPEN for ${circuitKey}, using stale cache if available`);
      const staleCache = getCacheItem(cacheKey, ttl * 3);
      if (staleCache) {
        console.log(`Using stale cache data for ${circuitKey}`);
        return staleCache;
      }
      throw new Error(`Circuit breaker open: Service temporarily unavailable for ${circuitKey}`);
    } else {
      circuitState.state = 'half-open';
      console.log(`Circuit breaker moving to HALF-OPEN state for ${circuitKey}`);
    }
  }
  
  try {
    // Make API call
    const result = await apiCall();
    
    // Success - reset circuit breaker
    if (circuitState.failures > 0 || circuitState.rateLimitFailures > 0) {
      console.log(`Circuit breaker SUCCESS - resetting for ${circuitKey}`);
      circuitState.failures = 0;
      circuitState.rateLimitFailures = 0;
      circuitState.consecutiveRateLimits = 0;
      circuitState.state = 'closed';
      circuitBreakers.set(circuitKey, circuitState);
    }
    
    // Cache successful result
    setCacheItem(cacheKey, result);
    return result;
  } catch (error) {
    // Enhanced error categorization
    const isRateLimited = error instanceof Error && 
      (error.message.includes('429') || error.message.includes('Too Many Requests') || 
       error.message.includes('rate limit'));
    
    if (isRateLimited) {
      // Handle rate limiting separately
      circuitState.rateLimitFailures++;
      circuitState.consecutiveRateLimits++;
      circuitState.lastRateLimitTime = now;
      
      if (circuitState.rateLimitFailures >= CIRCUIT_BREAKER_CONFIG.rateLimitThreshold) {
        circuitState.state = 'rate_limited';
        console.warn(`Circuit breaker RATE_LIMITED for ${circuitKey} after ${circuitState.rateLimitFailures} 429 errors`);
      }
    } else {
      // Handle regular errors
      circuitState.failures++;
      circuitState.lastFailureTime = now;
      
      if (circuitState.failures >= CIRCUIT_BREAKER_CONFIG.failureThreshold) {
        circuitState.state = 'open';
        console.warn(`Circuit breaker OPENED for ${circuitKey} after ${circuitState.failures} failures`);
      }
    }
    
    circuitBreakers.set(circuitKey, circuitState);
    
    // Try to return stale cache as fallback
    const fallbackTtl = isRateLimited ? CIRCUIT_BREAKER_CONFIG.rateLimitExtendedTtl : ttl * 5;
    const staleCache = getCacheItem(cacheKey, fallbackTtl);
    if (staleCache) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.log(`Using ${isRateLimited ? 'extended' : 'emergency'} stale cache for ${circuitKey} due to ${isRateLimited ? '429' : 'error'}:`, errorMessage);
      return staleCache;
    }
    
    throw error;
  }
};

// Circle ID validation helper - checks if circle exists on current network
const validateCircleOnNetwork = async (circleId: string, client: SuiClient): Promise<boolean> => {
  try {
    // Use a more lightweight validation approach
    const response = await client.getObject({
      id: circleId,
      options: { 
        showType: true,
        showOwner: false,
        showContent: false,
        showDisplay: false
      }
    });
    
    // Check if object exists and has the right type
    return !!(response.data && 
             response.data.type && 
             response.data.type.includes('njangi_circles::Circle'));
  } catch (error) {
    // For any error, assume the circle doesn't exist on this network
    console.log(`Circle ${circleId} validation failed on ${getCurrentNetwork()}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    return false;
  }
};

// Batch validation for multiple circle IDs with rate limiting
const validateCirclesOnNetwork = async (circleIds: string[], client: SuiClient): Promise<string[]> => {
  console.log(`Validating ${circleIds.length} circles on ${getCurrentNetwork()} network...`);
  
  // Validate in smaller batches to avoid overwhelming the RPC
  const batchSize = 3;
  const validCircleIds: string[] = [];
  
  for (let i = 0; i < circleIds.length; i += batchSize) {
    const batch = circleIds.slice(i, i + batchSize);
    
    const validationPromises = batch.map(async (circleId, index) => {
      // Add small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, index * 100));
      
      try {
        const isValid = await validateCircleOnNetwork(circleId, client);
        return isValid ? circleId : null;
      } catch (error) {
        console.log(`Validation failed for circle ${circleId}:`, error);
        return null;
      }
    });
    
    const results = await Promise.allSettled(validationPromises);
    const batchValidIds = results
      .filter((result): result is PromiseFulfilledResult<string> => 
        result.status === 'fulfilled' && result.value !== null)
      .map(result => result.value);
    
    validCircleIds.push(...batchValidIds);
    
    // Add delay between batches
    if (i + batchSize < circleIds.length) {
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
  
  const filteredCount = circleIds.length - validCircleIds.length;
  if (filteredCount > 0) {
    console.log(`Filtered out ${filteredCount} circles not available on ${getCurrentNetwork()} network`);
  }
  
  return validCircleIds;
};

type DashboardOnrampStatus =
  | 'idle'
  | 'success'
  | 'pending'
  | 'failed'
  | 'cancelled';

interface ParsedOnrampResult {
  hasOnrampParams: boolean;
  provider: string;
  status: DashboardOnrampStatus;
  rawStatus?: string;
  transactionId?: string;
  assetIntent?: CoinbaseAssetIntent;
}

function readQueryValue(
  value: string | string[] | undefined,
): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function normalizeOnrampStatus(
  value: string | undefined,
): DashboardOnrampStatus {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return 'pending';
  }
  if (
    normalized === 'success' ||
    normalized === 'completed' ||
    normalized === 'complete'
  ) {
    return 'success';
  }
  if (normalized === 'failed' || normalized === 'error') {
    return 'failed';
  }
  if (normalized === 'cancelled' || normalized === 'canceled') {
    return 'cancelled';
  }
  if (normalized === 'pending' || normalized === 'processing') {
    return 'pending';
  }
  return 'pending';
}

function normalizeOnrampAssetIntent(
  value: string | undefined,
): CoinbaseAssetIntent | undefined {
  const normalized = value?.trim().toUpperCase();
  if (normalized === 'SUI') {
    return 'SUI';
  }
  if (normalized === 'USDC' || normalized === 'USDC_ON_SUI') {
    return 'USDC_ON_SUI';
  }
  return undefined;
}

function parseOnrampResultFromQuery(
  query: Record<string, string | string[] | undefined>,
): ParsedOnrampResult {
  const provider = readQueryValue(
    query.onrampProvider ?? query.provider,
  )?.trim().toLowerCase();
  const statusValue = readQueryValue(
    query.onrampStatus ?? query.status ?? query.result,
  );
  const transactionId = readQueryValue(
    query.onrampTxId ?? query.transactionId ?? query.transaction_id ?? query.txId,
  );
  const assetIntentValue = readQueryValue(
    query.onrampAssetIntent ?? query.assetIntent ?? query.asset,
  );

  const hasOnrampParams = Boolean(
    provider === 'coinbase' ||
      query.onrampProvider !== undefined ||
      query.onrampStatus !== undefined ||
      query.onrampTxId !== undefined ||
      query.assetIntent !== undefined ||
      query.transactionId !== undefined ||
      query.transaction_id !== undefined,
  );

  return {
    hasOnrampParams,
    provider: provider || 'coinbase',
    status: normalizeOnrampStatus(statusValue),
    rawStatus: statusValue,
    transactionId,
    assetIntent: normalizeOnrampAssetIntent(assetIntentValue),
  };
}

function stripOnrampQueryParams(
  query: Record<string, string | string[] | undefined>,
): Record<string, string | string[] | undefined> {
  const nextQuery = { ...query };
  const keysToRemove = [
    'onrampProvider',
    'onrampStatus',
    'onrampTxId',
    'onrampAssetIntent',
    'provider',
    'status',
    'result',
    'transactionId',
    'transaction_id',
    'txId',
    'assetIntent',
    'asset',
  ];
  for (const key of keysToRemove) {
    delete nextQuery[key];
  }
  return nextQuery;
}

const onrampProviderFlag = normalizeOnrampProviderFlag(
  process.env.NEXT_PUBLIC_ONRAMP_PROVIDER,
);

type SwapDirection = 'SUI_TO_USDC' | 'USDC_TO_SUI';

const MANUAL_SWAP_SLIPPAGE = 0.5;
const MANUAL_SWAP_SUI_GAS_BUFFER = 0.02;

const getManualSwapDecimals = (symbol: 'SUI' | 'USDC') => (symbol === 'SUI' ? 4 : 2);

const formatManualSwapAmount = (amount: number, symbol: 'SUI' | 'USDC') =>
  `${amount.toFixed(getManualSwapDecimals(symbol))} ${symbol}`;

const getManualSwapBalance = (
  coins: Array<{ coinType: string; symbol: string; balance: string }>,
  symbol: 'SUI' | 'USDC',
) => {
  const coin = coins.find((entry) => entry.symbol === symbol);
  if (!coin) {
    return 0;
  }

  const decimals = symbol === 'SUI' ? 1e9 : 1e6;
  return Number(coin.balance) / decimals;
};

const formatManualSwapPercent = (value: number) => `${value.toFixed(2)}%`;

export default function Dashboard() {
  console.log('🚨 DASHBOARD COMPONENT RENDERING');
  const router = useRouter();
  const { isAuthenticated, isLoading: isAuthLoading, userAddress, account, deleteCircle: authDeleteCircle, sendTokens } = useAuth();
  const { t } = useTranslation();
  console.log('🚨 DASHBOARD userAddress:', userAddress, 'isAuthenticated:', isAuthenticated);
  
  // Suppress "Failed to fetch" errors from deleted packages in Next.js error overlay
  useEffect(() => {
    const suppressPackageErrors = (event: PromiseRejectionEvent) => {
      const error = event.reason;
      const errorMsg = error instanceof Error ? error.message : String(error);
      
      // Suppress "Failed to fetch" errors from querying deleted package IDs
      // These are expected after package upgrades when old packages are deleted
      if (errorMsg.includes('Failed to fetch') || 
          errorMsg.includes('Network request failed')) {
        console.log('🔇 Suppressed expected error from deleted package query');
        event.preventDefault(); // Prevent Next.js error overlay from showing
        return;
      }
    };

    window.addEventListener('unhandledrejection', suppressPackageErrors);
    return () => window.removeEventListener('unhandledrejection', suppressPackageErrors);
  }, []);
  
  // Use centralized network configuration
  const currentNetworkConfig = getCurrentNetworkConfig();
  const [balance, setBalance] = useState<string>('0');
  const [allCoins, setAllCoins] = useState<{coinType: string, symbol: string, balance: string}[]>([]);
  const [showFullAddress, setShowFullAddress] = useState(false);
  const [showToast, setShowToast] = useState(false);
  
  // Enhanced circles state with caching
  const [circles, setCircles] = useState<Circle[]>(() => {
    if (typeof window !== 'undefined' && userAddress) {
      const cacheKey = getCacheKey(userAddress, 'circles');
      const cached = getCacheItem(cacheKey, CACHE_CONFIG.CIRCLES_TTL) as Circle[] | null;
      if (cached) {
        console.log('Loaded circles from cache on init:', cached.length);
        return cached;
      }
    }
    return [];
  });
  
  const [loading, setLoading] = useState(true);
  const [isBackgroundRefreshing, setIsBackgroundRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  // Enhanced error and loading states
  const [networkError, setNetworkError] = useState<{
    type: 'network_mismatch' | 'connection_failed' | 'service_unavailable' | null;
    message: string;
    canRetry: boolean;
    retryCount: number;
  }>({
    type: null,
    message: '',
    canRetry: false,
    retryCount: 0
  });
  
  const [loadingProgress, setLoadingProgress] = useState<{
    stage: 'network_validation' | 'fetching_events' | 'fetching_metadata' | 'validating_circles' | 'processing_circles' | 'completed';
    current: number;
    total: number;
    message: string;
  }>({
    stage: 'network_validation',
    current: 0,
    total: 0,
    message: 'Initializing...'
  });
  const [suiPrice, setSuiPrice] = useState<number | null>(null);
  const [isPriceLoading, setIsPriceLoading] = useState(true);
  const [deleteableCircles, setDeleteableCircles] = useState<Set<string>>(new Set());
  const [isDeleting, setIsDeleting] = useState<string | null>(null);
  const [isJoinDialogOpen, setIsJoinDialogOpen] = useState(false);
  const [circleIdInput, setCircleIdInput] = useState('');
  const [copiedCircleId, setCopiedCircleId] = useState<string | null>(null);
  const [showTestnetBanner, setShowTestnetBanner] = useState(() => getCurrentNetwork() === 'testnet');
  
  // Network configuration state - use centralized config
  const [network, setNetwork] = useState<'testnet' | 'mainnet'>(() => getCurrentNetwork());
  const [rpcUrl, setRpcUrl] = useState<string>(() => getCurrentRpcUrl());
  const [packageId, setPackageId] = useState<string>(() => getCurrentPackageId());

  // Progressive loading and pagination state
  const [displayedCirclesCount, setDisplayedCirclesCount] = useState(3); // For UI display - start small
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [circleSortOrder, setCircleSortOrder] = useState<'newest' | 'oldest'>('newest');
  const [circleViewIndex, setCircleViewIndex] = useState(0);
  const [circleJumpSelections, setCircleJumpSelections] = useState<Record<CircleViewKey, string>>({
    all: '',
    admin: '',
    member: '',
  });
  const [collapsedMobileCircleSections, setCollapsedMobileCircleSections] = useState<Record<CircleViewKey, boolean>>({
    all: true,
    admin: true,
    member: true,
  });
  const [pendingCircleJump, setPendingCircleJump] = useState<{
    viewKey: CircleViewKey;
    circleId: string;
  } | null>(null);
  const [highlightedCircleRefKey, setHighlightedCircleRefKey] = useState<string | null>(null);
  const [selectedMobileCircle, setSelectedMobileCircle] = useState<Circle | null>(null);
  const [isMobileWalletDetailsOpen, setIsMobileWalletDetailsOpen] = useState(false);
  const [isMobileWalletHoldingsOpen, setIsMobileWalletHoldingsOpen] = useState(false);
  const circleCardRefs = useRef(new Map<string, HTMLElement>());
  const circlePortfolioSectionRef = useRef<HTMLElement | null>(null);
  const CIRCLES_PER_PAGE = 6; // For UI display
  const INITIAL_LOAD_SIZE = 9999; // Fetch ALL circles across all packages (no artificial limit)
  const LOAD_MORE_SIZE = 3; // Load 3 more circles each time
  
  // Cursor state for real pagination
  const [paginationState, setPaginationState] = useState<{
    adminCursor?: string;
    memberCursor?: string;
    hasMoreAdmin: boolean;
    hasMoreMember: boolean;
    totalFetched: number;
  }>({
    hasMoreAdmin: false,
    hasMoreMember: false,
    totalFetched: 0
  });
  
  // Ref to track last validation toast timestamp (prevent duplicate toasts)
  const lastValidationToastRef = useRef<number>(0);
  const TOAST_DEBOUNCE_MS = 10000; // Only show validation toast once every 10 seconds

  // Geo-aware onramp dialog state (RampPicker handles provider selection)
  const [isCoinbaseLauncherOpen, setIsCoinbaseLauncherOpen] = useState(false);
  const [coinbaseAssetIntent, setCoinbaseAssetIntent] =
    useState<CoinbaseAssetIntent>('USDC_ON_SUI');
  const [onrampResultStatus, setOnrampResultStatus] =
    useState<DashboardOnrampStatus>('idle');
  const [onrampResultMessage, setOnrampResultMessage] = useState<string | null>(
    null,
  );
  const [isOnrampResultRefreshing, setIsOnrampResultRefreshing] = useState(false);
  const [swapDirection, setSwapDirection] = useState<SwapDirection>('SUI_TO_USDC');
  const [swapAmount, setSwapAmount] = useState('');
  const [swapQuote, setSwapQuote] = useState<{
    amountOut: number;
    priceImpact: number;
  } | null>(null);
  const [isSwapQuoteLoading, setIsSwapQuoteLoading] = useState(false);
  const [swapQuoteError, setSwapQuoteError] = useState<string | null>(null);
  const [isSwapSubmitting, setIsSwapSubmitting] = useState(false);
  const [lastSwapDigest, setLastSwapDigest] = useState<string | null>(null);
  const [isManualSwapOpen, setIsManualSwapOpen] = useState(false);

  // Keep the confirmation modal state
  const [isConfirmModalOpen, setIsConfirmModalOpen] = useState(false);
  const [confirmModalProps, setConfirmModalProps] = useState<{
    title: string;
    message: string | React.ReactNode;
    onConfirm: () => void;
    confirmText?: string;
    confirmButtonVariant?: 'primary' | 'danger' | 'warning';
  } | null>(null);

  // Add transfer-related state
  const [isTransferDialogOpen, setIsTransferDialogOpen] = useState(false);
  const [transferForm, setTransferForm] = useState<TransferFormData>({
    recipientAddress: '',
    amount: '',
    selectedToken: 'SUI',
    memo: ''
  });
  const [transferValidation, setTransferValidation] = useState<TransferValidation>({
    isValid: false,
    errors: {},
    warnings: {}
  });
  const [isTransferring, setIsTransferring] = useState(false);
  const [recentContacts, setRecentContacts] = useState<RecentContact[]>([]);
  const [showAdvancedOptions, setShowAdvancedOptions] = useState(false);
  const [transferStep, setTransferStep] = useState<'form' | 'review' | 'confirm' | 'success'>('form');
  const [transferResult, setTransferResult] = useState<{ digest?: string; error?: string } | null>(null);
  const [gasError, setGasError] = useState<string | null>(null);

  // Add transaction history state
  const [isTransactionHistoryOpen, setIsTransactionHistoryOpen] = useState(false);
  const [transactionHistory, setTransactionHistory] = useState<TransactionHistoryItem[]>([]);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);

  // Add currency selection state
  // Initialize selectedCurrency from localStorage or default to 'USD'
  const [selectedCurrency, setSelectedCurrency] = useState<string>(() => {
    if (typeof window !== 'undefined') {
      const storedCurrency = localStorage.getItem('selectedCurrency');
      if (storedCurrency) {
        return storedCurrency;
      }
    }
    return 'USD';
  });
  const [convertedBalances, setConvertedBalances] = useState<Record<string, number>>({});
  const [totalWalletLocalValue, setTotalWalletLocalValue] = useState<number>(0); // New state for total wallet value

  // Add balance visibility state
  const [balanceVisible, setBalanceVisible] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem('balanceVisible');
      return stored !== null ? JSON.parse(stored) : true; // Default to visible
    }
    return true;
  });

  // Toggle balance visibility and persist to localStorage
  const toggleBalanceVisibility = () => {
    const newVisibility = !balanceVisible;
    setBalanceVisible(newVisibility);
    if (typeof window !== 'undefined') {
      localStorage.setItem('balanceVisible', JSON.stringify(newVisibility));
    }
  };

  // Helper function to display balance or hidden text
  const formatBalanceDisplay = (balance: string | number, isMainBalance = false) => {
    if (balanceVisible) {
      return typeof balance === 'string' ? balance : balance.toString();
    }
    return isMainBalance ? '••••••' : '••••';
  };

  const activeSwapNetwork = network === 'mainnet' ? 'mainnet' : 'testnet';
  const swapNetworkConfig = getNetworkConfig(activeSwapNetwork);
  const sourceSymbol: 'SUI' | 'USDC' = swapDirection === 'SUI_TO_USDC' ? 'SUI' : 'USDC';
  const targetSymbol: 'SUI' | 'USDC' = swapDirection === 'SUI_TO_USDC' ? 'USDC' : 'SUI';
  const sourceCoinType =
    sourceSymbol === 'SUI' ? swapNetworkConfig.coinTypes.SUI : swapNetworkConfig.coinTypes.USDC;
  const targetCoinType =
    targetSymbol === 'SUI' ? swapNetworkConfig.coinTypes.SUI : swapNetworkConfig.coinTypes.USDC;
  const sourceBalance = getManualSwapBalance(allCoins, sourceSymbol);
  const targetBalance = getManualSwapBalance(allCoins, targetSymbol);
  const maxSwapAmount =
    sourceSymbol === 'SUI'
      ? Math.max(0, sourceBalance - MANUAL_SWAP_SUI_GAS_BUFFER)
      : sourceBalance;
  const parsedSwapAmount = Number.parseFloat(swapAmount);
  const hasValidSwapAmount = Number.isFinite(parsedSwapAmount) && parsedSwapAmount > 0;
  const hasEnoughSourceBalance = hasValidSwapAmount && parsedSwapAmount <= maxSwapAmount;

  // useEffect to calculate total wallet value when convertedBalances changes
  useEffect(() => {
    if (convertedBalances && Object.keys(convertedBalances).length > 0) {
      const totalValue = Object.values(convertedBalances).reduce((sum, value) => {
        return sum + (value || 0); // Ensure value is a number, default to 0 if undefined/null
      }, 0);
      setTotalWalletLocalValue(totalValue);
    } else {
      setTotalWalletLocalValue(0); // Default to 0 if no converted balances
    }
  }, [convertedBalances]);

  const closeCoinbaseLauncher = () => {
    setIsCoinbaseLauncherOpen(false);
  };

  // Opens the geo-aware onramp dialog. The RampPicker inside selects and
  // orders providers for the user's region (2026-06 GTM audit: no more
  // hardcoded Coinbase + country="US").
  const openBuyFlow = (currencyCode: string = 'usdc') => {
    const assetIntent = mapCurrencyCodeToIntent(currencyCode);

    if (!userAddress) {
      toast.error('Wallet address is unavailable. Please sign in and retry.');
      return;
    }

    console.log('Buy button clicked', { currencyCode, assetIntent });
    setCoinbaseAssetIntent(assetIntent);
    setIsCoinbaseLauncherOpen(true);
  };

  const handleRampLaunched = (provider: RampProviderId) => {
    toast.success(`Opening ${RAMP_PROVIDER_LABELS[provider]} checkout...`);
    closeCoinbaseLauncher();
  };

  const handleRampProviderError = (provider: RampProviderId, error: Error) => {
    // The picker promotes the next provider itself; this is observability.
    console.warn('[onramp][dashboard] provider unavailable', provider, error.message);
  };

  const handleCoinbaseCancel = () => {
    closeCoinbaseLauncher();
  };

  useEffect(() => {
    if (isAuthLoading) {
      console.log("Auth state is still hydrating, waiting before redirect check");
      return;
    }

    if (!isAuthenticated) {
      console.log("User not authenticated, redirecting to home");
      router.replace('/');
    } else {
      console.log("User is authenticated:", userAddress);
    }
  }, [isAuthenticated, isAuthLoading, router, userAddress]);

  // Initialize network preference from localStorage
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const savedNetwork = localStorage.getItem('sui-network') as 'testnet' | 'mainnet' | null;
      console.log('🌍 Dashboard: Initializing network configuration...', { savedNetwork, currentNetwork: network });
      
      if (savedNetwork && savedNetwork !== network) {
        // Update centralized network configuration
        console.log('🌍 Dashboard: Setting network from localStorage:', savedNetwork);
        setCurrentNetwork(savedNetwork);
        
        // Wait for network config to be updated then update local state
        const updatedConfig = getCurrentNetworkConfig();
        console.log('🌍 Dashboard: Updated network config:', { 
          network: savedNetwork, 
          rpcUrl: updatedConfig.rpcUrl,
          packageId: updatedConfig.packageId 
        });
        
        setNetwork(savedNetwork);
        setRpcUrl(updatedConfig.rpcUrl);
        setPackageId(updatedConfig.packageId);
        setShowTestnetBanner(savedNetwork === 'testnet');
        
        // Update global window configuration for consistency
        if (typeof window !== 'undefined') {
          window.CURRENT_NETWORK_CONFIG = {
            rpcUrl: updatedConfig.rpcUrl,
            packageId: updatedConfig.packageId,
            usdcAddress: updatedConfig.coinTypes.USDC,
            networkName: savedNetwork,
            enoki: {
              // The Enoki private key is server-only (used solely by
              // /api/zkLogin). Never expose it on the client — all Enoki
              // calls happen server-side, so the browser config carries an
              // empty key.
              apiKey: '',
              baseUrl: updatedConfig.enoki.network === 'mainnet' ? 'https://enoki.mystenlabs.com' : 'https://enoki.testnet.mystenlabs.com',
              graphqlUrl: updatedConfig.enoki.network === 'mainnet' ? 'https://enoki.mystenlabs.com/v1/graphql' : 'https://enoki.testnet.mystenlabs.com/v1/graphql'
            }
          };
        }
        
        console.log(`✅ Dashboard: Network configuration loaded: ${savedNetwork}`);
      } else {
        // Ensure centralized config is initialized with current network
        console.log('🌍 Dashboard: Using default network:', network);
        setCurrentNetwork(network);
        
        // Ensure local state matches centralized config
        const currentConfig = getCurrentNetworkConfig();
        setRpcUrl(currentConfig.rpcUrl);
        setPackageId(currentConfig.packageId);
        setShowTestnetBanner(getCurrentNetwork() === 'testnet');
        
        // Update global window configuration for consistency
        if (typeof window !== 'undefined') {
          window.CURRENT_NETWORK_CONFIG = {
            rpcUrl: currentConfig.rpcUrl,
            packageId: currentConfig.packageId,
            usdcAddress: currentConfig.coinTypes.USDC,
            networkName: getCurrentNetwork(),
            enoki: {
              // Server-only key — see the note above; never exposed client-side.
              apiKey: '',
              baseUrl: currentConfig.enoki.network === 'mainnet' ? 'https://enoki.mystenlabs.com' : 'https://enoki.testnet.mystenlabs.com',
              graphqlUrl: currentConfig.enoki.network === 'mainnet' ? 'https://enoki.mystenlabs.com/v1/graphql' : 'https://enoki.testnet.mystenlabs.com/v1/graphql'
            }
          };
        }
        
        console.log('✅ Dashboard: Default network configuration set:', { 
          network: getCurrentNetwork(), 
          rpcUrl: currentConfig.rpcUrl,
          packageId: currentConfig.packageId 
        });
      }
    }
  }, []); // Run only once on mount

  // Initialize cache cleanup on component mount
  useEffect(() => {
    if (typeof window !== 'undefined') {
      // Clean up stale cache entries on app start
      clearStaleCache();
    }
  }, []); // Run only once on mount

  // Network switch cleanup - clear connection pool when network changes
  useEffect(() => {
    return () => {
      clearSuiClientPool();
      clearStaleCircleCache();
    };
  }, [network]);

  // Network config is handled by centralized service - no need for manual updates

  // Add refresh balance state
  const [isRefreshingBalance, setIsRefreshingBalance] = useState(false);

  // Extract fetchBalance into a reusable function
  const fetchBalance = useCallback(async (showFailureToast: boolean = false) => {
    if (!userAddress) return false;

    const activeNetwork = getCurrentNetwork();
    const activeNetworkConfig = getCurrentNetworkConfig();
    const rpcCandidates = Array.from(new Set([
      activeNetworkConfig.rpcUrl,
      ...getRpcCandidateUrls(activeNetwork),
    ].filter(Boolean)));

    let lastErrorMessage = 'Unknown error';

    for (const activeRpcUrl of rpcCandidates) {
      try {
        const client = getSuiClientFromPool(activeRpcUrl);

        console.log(`🔍 Fetching wallet balances from ${activeNetwork} RPC...`, {
          rpcUrl: activeRpcUrl,
          packageId: activeNetworkConfig.packageId,
          network: activeNetwork,
        });

        const chainBalances = await client.getAllBalances({
          owner: userAddress,
        });

        const coinMap = new Map<string, {coinType: string, symbol: string, balance: string}>();

        chainBalances.forEach((coin: any) => {
          const typeStr = coin.coinType;
          const totalBalance = coin.totalBalance || '0';
          let symbol: string;

          if (typeStr === activeNetworkConfig.coinTypes.SUI) {
            symbol = 'SUI';
          } else if (typeStr === activeNetworkConfig.coinTypes.USDC) {
            symbol = 'USDC';
          } else {
            const typeMatch = typeStr.match(/::([^:]+)$/);
            symbol = typeMatch ? typeMatch[1] : typeStr;
          }

          if (coinMap.has(symbol)) {
            const existingCoin = coinMap.get(symbol)!;
            const newBalance = BigInt(existingCoin.balance) + BigInt(totalBalance);
            coinMap.set(symbol, {
              ...existingCoin,
              balance: newBalance.toString()
            });
          } else {
            coinMap.set(symbol, {
              coinType: typeStr,
              symbol,
              balance: totalBalance
            });
          }
        });

        const processedCoins = Array.from(coinMap.values());
        const suiBalance = chainBalances.find(
          (coin: any) => coin.coinType === activeNetworkConfig.coinTypes.SUI
        );

        setBalance(suiBalance?.totalBalance || '0');
        setAllCoins(processedCoins);
        console.log('Aggregated balances by symbol:', processedCoins);
        return true;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        lastErrorMessage = errorMessage;

        if (
          error instanceof TypeError ||
          errorMessage.includes('Failed to fetch') ||
          errorMessage.includes('Network request failed')
        ) {
          blacklistEndpoint(activeRpcUrl, `Balance fetch failed: ${errorMessage}`);
        }

        console.warn(`Balance fetch failed on ${activeRpcUrl}: ${errorMessage}`);
      }
    }

    console.warn(`Unable to fetch wallet balances on ${activeNetwork}: ${lastErrorMessage}`);
    if (showFailureToast) {
      toast.error(`Failed to refresh balance on ${activeNetwork}`);
    }
    return false;
  }, [userAddress]);

  // Handle manual balance refresh
  const handleRefreshBalance = async () => {
    setIsRefreshingBalance(true);
    try {
      if (userAddress) {
        clearWalletBalanceCache(userAddress);
      }
      const didRefresh = await fetchBalance(true);
      if (didRefresh) {
        toast.success('Balance refreshed successfully');
      }
    } catch (error) {
      console.error('Error refreshing balance:', error);
      toast.error('Failed to refresh balance');
    } finally {
      setIsRefreshingBalance(false);
    }
  };

  // In-app testnet gas drip. zkLogin users pay their own gas, so a 0-balance
  // new account stalls on every action; this drips test SUI to the session's
  // own address (server-verified, rate-limited; testnet-only — 404s on mainnet)
  // so onboarding can proceed without the captcha-gated external faucet.
  const [isDrippingFaucet, setIsDrippingFaucet] = useState(false);
  const requestTestSui = async () => {
    if (isDrippingFaucet) return;
    setIsDrippingFaucet(true);
    const pending = toast.loading('Requesting test SUI…');
    try {
      const res = await fetch('/api/faucet/drip', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) {
        toast.success('Test SUI sent — refreshing your balance…', { id: pending });
        if (userAddress) clearWalletBalanceCache(userAddress);
        // Faucet settlement isn't instant; refresh shortly after.
        setTimeout(() => { void fetchBalance(false); }, 4000);
      } else {
        toast.error(data.error || 'Faucet request failed. Try faucet.sui.io directly.', { id: pending });
      }
    } catch {
      toast.error('Could not reach the faucet. Try faucet.sui.io directly.', { id: pending });
    } finally {
      setIsDrippingFaucet(false);
    }
  };

  useEffect(() => {
    void fetchBalance(false);
  }, [userAddress, network, fetchBalance]);

  useEffect(() => {
    if (!userAddress || !hasValidSwapAmount) {
      setSwapQuote(null);
      setSwapQuoteError(null);
      setIsSwapQuoteLoading(false);
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setIsSwapQuoteLoading(true);
      setSwapQuoteError(null);

      try {
        cetusService.init(userAddress, activeSwapNetwork);
        const nextQuote = await cetusService.getSwapEstimate(
          sourceCoinType,
          targetCoinType,
          parsedSwapAmount,
        );

        if (!nextQuote) {
          throw new Error('No swap route is available right now.');
        }

        if (!cancelled) {
          setSwapQuote({
            amountOut: Number.parseFloat(nextQuote.amountOut),
            priceImpact: nextQuote.priceImpact,
          });
        }
      } catch (error) {
        if (!cancelled) {
          setSwapQuote(null);
          setSwapQuoteError(
            error instanceof Error ? error.message : 'Unable to calculate a live quote.',
          );
        }
      } finally {
        if (!cancelled) {
          setIsSwapQuoteLoading(false);
        }
      }
    }, 350);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    activeSwapNetwork,
    hasValidSwapAmount,
    parsedSwapAmount,
    sourceCoinType,
    targetCoinType,
    userAddress,
  ]);

  const applySwapQuickAmount = (ratio: number) => {
    if (maxSwapAmount <= 0) {
      setSwapAmount('');
      return;
    }

    const nextAmount = maxSwapAmount * ratio;
    setSwapAmount(nextAmount.toFixed(getManualSwapDecimals(sourceSymbol)));
  };

  const handleManualSwap = async () => {
    if (!account || !userAddress) {
      toast.error('Your session is not ready yet. Please try again.');
      return;
    }

    if (!hasValidSwapAmount) {
      toast.error('Enter an amount before swapping.');
      return;
    }

    if (!hasEnoughSourceBalance) {
      toast.error(`You need more ${sourceSymbol} to complete this swap.`);
      return;
    }

    setIsSwapSubmitting(true);

    try {
      cetusService.init(userAddress, activeSwapNetwork);
      const payload = await cetusService.getSwapTransactionPayload(
        sourceCoinType,
        targetCoinType,
        parsedSwapAmount,
        MANUAL_SWAP_SLIPPAGE,
      );

      if (!payload) {
        throw new Error('Unable to prepare the swap transaction.');
      }

      toast.loading(`Swapping ${sourceSymbol} to ${targetSymbol}...`, {
        id: 'dashboard-manual-swap',
      });

      const response = await fetch('/api/zkLogin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'executeSwap',
          account,
          txb: Array.from(payload),
          network: activeSwapNetwork,
        }),
      });

      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.error || 'Swap failed.');
      }

      setLastSwapDigest(result.digest || null);
      if (userAddress) {
        clearWalletBalanceCache(userAddress);
      }
      await fetchBalance();
      setSwapAmount('');
      setSwapQuote(null);
      setSwapQuoteError(null);

      toast.success(`Swap complete. ${targetSymbol} balance is refreshing.`, {
        id: 'dashboard-manual-swap',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Swap failed.';
      toast.error(message, { id: 'dashboard-manual-swap' });
    } finally {
      setIsSwapSubmitting(false);
    }
  };

  // Fetch SUI price - only on page load, no interval
  useEffect(() => {
    if (isAuthLoading || !isAuthenticated) {
      return;
    }

    const fetchPrice = async () => {
      setIsPriceLoading(true);
      try {
        // Force a refresh of the price to get the latest data
        const price = await priceService.forceRefreshPrice();
        setSuiPrice(price);
        
        // Only show an error if we truly failed to resolve any price.
        if (price === null || priceService.getFetchStatus() === 'error') {
          toast.error(
            'Unable to fetch latest SUI price. Some values may not be displayed accurately.',
            {
              duration: 4000,
              position: 'bottom-center',
              icon: '⚠️',
              style: {
                border: '1px solid #F87171',
                padding: '16px',
                color: '#991B1B',
              },
            }
          );
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.warn(`Error in price fetch flow: ${errorMessage}`);
        setSuiPrice(null);
      } finally {
        setIsPriceLoading(false);
      }
    };

    fetchPrice();
  }, [isAuthLoading, isAuthenticated]);

  // Save selectedCurrency to localStorage when it changes
  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('selectedCurrency', selectedCurrency);
    }
  }, [selectedCurrency]);

  // Update converted balances when currency or balances change
  useEffect(() => {
    const updateConvertedBalances = async () => {
      try {
        if (!suiPrice) return;

        const newConvertedBalances: Record<string, number> = {};
        
        // Convert SUI balance
        const suiBalance = Number(balance) / 1000000000;
        const suiPriceInCurrency = await priceService.getSUIPriceInCurrency(selectedCurrency);
        if (suiPriceInCurrency) {
          newConvertedBalances.SUI = suiBalance * suiPriceInCurrency;
        }

        // Convert other token balances
        for (const coin of allCoins) {
          const tokenBalance = Number(coin.balance) / getCoinDecimals(coin.coinType);

          if (coin.symbol === 'SUI') {
            newConvertedBalances[coin.symbol] = newConvertedBalances.SUI || 0;
          } else if (coin.symbol === 'USDC') {
            // USDC is pegged to USD, so we convert from USD to target currency
            const convertedValue = await priceService.convertFromUSD(tokenBalance, selectedCurrency);
            newConvertedBalances[coin.symbol] = convertedValue;
          }
        }

        setConvertedBalances(newConvertedBalances);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.warn(`Failed to update converted balances: ${errorMessage}`);
      }
    };

    updateConvertedBalances();
  }, [selectedCurrency, suiPrice, balance, allCoins]);
  // Convert SUI amount to selected currency using price service
  // Process circle data correctly after the contract restructuring
  const processCircleObject = async (objectData: EnhancedObjectData, userAddress: string, circleCreationData?: CircleCreatedEvent, client?: SuiClient, transactionTimestamp?: number, transactionDigest?: string) => {
    // Use optional chaining and nullish coalescing for safer access
    if (!objectData?.data?.content?.fields) { 
      console.warn('Invalid object data structure or missing fields', objectData);
      return null;
    }

    const fields = objectData.data.content.fields as Record<string, unknown>;
    console.log('Processing circle object fields:', fields);

    // Extract basic circle information safely
    const circleId = objectData.data.objectId ?? 'unknown-id'; // Provide fallback
    const name = (fields.name as string) ?? ''; // Type assertion with fallback
    const admin = (fields.admin as string) ?? ''; // Type assertion with fallback
    const currentMembers = Number(fields.current_members ?? 0); // Use nullish coalescing
    const nextPayoutTime = Number(fields.next_payout_time ?? 0); // Use nullish coalescing
    const lifecycle = resolveCircleLifecycleState(fields);
    
    // Initialize config values with default values
    const configValues = {
      contributionAmount: 0,
      contributionAmountUsd: 0,
      securityDeposit: 0,
      securityDepositUsd: 0,
      cycleLength: 0,
      cycleDay: 0,  // Default to day 0 (Monday)
      maxMembers: 3, // Default, will be overridden by config or event
    };

    // Extract from transaction inputs if available (check types safely)
    // Deprioritize creation event for max_members, as it can be updated
    if (circleCreationData) {
      console.log('Using creation event data for circle:', circleId);
      configValues.contributionAmount = Number(circleCreationData.contribution_amount ?? 0) / 1e9;
      configValues.contributionAmountUsd = Number(circleCreationData.contribution_amount_local ?? 0) / 100;
      configValues.securityDepositUsd = Number(circleCreationData.security_deposit_local ?? 0) / 100;
      configValues.cycleLength = Number(circleCreationData.cycle_length ?? 0);
      // DO NOT set maxMembers from creation event here, prioritize dynamic field
    }

    // Next, try to extract values from dynamic fields safely
    const dynamicFields = objectData.data.dynamicFields || [];
    console.log('Dynamic fields for circle:', dynamicFields);

    const configObjectId = getCircleConfigObjectId(dynamicFields);
    if (configObjectId && client) {
      console.log('Found CircleConfig field:', configObjectId);

      try {
        const configFields = await getCircleConfigFieldsByObjectId(client, configObjectId);

        if (configFields) {
          console.log('CircleConfig fields:', configFields);

          if ('max_members' in configFields) {
            configValues.maxMembers = Number(configFields.max_members);
            console.log('Successfully extracted max_members from fetched object:', configValues.maxMembers);
          }
          if ('contribution_amount' in configFields) {
            configValues.contributionAmount = Number(configFields.contribution_amount) / 1e9;
          }
          if ('contribution_amount_local' in configFields) {
            configValues.contributionAmountUsd = Number(configFields.contribution_amount_local) / 100;
          }
          if ('security_deposit' in configFields) {
            configValues.securityDeposit = Number(configFields.security_deposit) / 1e9;
          }
          if ('security_deposit_local' in configFields) {
            configValues.securityDepositUsd = Number(configFields.security_deposit_local) / 100;
          }
          if ('cycle_length' in configFields) {
            configValues.cycleLength = Number(configFields.cycle_length);
          }
          if ('cycle_day' in configFields) {
            configValues.cycleDay = Number(configFields.cycle_day);
            console.log('Found cycle_day in fetched object:', configValues.cycleDay);
          }
        }
      } catch (error) {
        console.error(`Error fetching CircleConfig object with ID ${configObjectId}:`, error);

        if (error instanceof Error && error.message.includes('Failed to fetch')) {
          console.warn(`Circle config object ${configObjectId} not found on current network. This might be from a different network.`);
        }
      }
    }
    
    // Direct field access with safe checks and type assertions (as fallbacks)
    configValues.contributionAmount = Number(fields.contribution_amount ?? configValues.contributionAmount * 1e9) / 1e9;
    configValues.securityDeposit = Number(fields.security_deposit ?? configValues.securityDeposit * 1e9) / 1e9;
    configValues.contributionAmountUsd = Number(fields.contribution_amount_local ?? configValues.contributionAmountUsd * 100) / 100;
    configValues.securityDepositUsd = Number(fields.security_deposit_local ?? configValues.securityDepositUsd * 100) / 100;
    configValues.cycleLength = Number(fields.cycle_length ?? configValues.cycleLength);
    // Only update cycleDay from direct field if it wasn't found elsewhere
    if (configValues.cycleDay === 0 && fields.cycle_day !== undefined) { 
        configValues.cycleDay = Number(fields.cycle_day ?? 0); 
        console.log('Found cycle_day in direct fields:', configValues.cycleDay);
    }
    // Ensure maxMembers is not overwritten by direct field if already set from config
    if (configValues.maxMembers === 3 && fields.max_members !== undefined) { // Check if it's still the default
        configValues.maxMembers = Number(fields.max_members ?? configValues.maxMembers);
        console.log('Updated maxMembers from direct field as fallback:', configValues.maxMembers);
    }
    // If CircleCreatedEvent had a value and dynamic field didn't, use it as a last resort (should be rare)
    else if (circleCreationData && circleCreationData.max_members && configValues.maxMembers === 3) {
        configValues.maxMembers = Number(circleCreationData.max_members);
        console.log('Updated maxMembers from CircleCreatedEvent as last resort:', configValues.maxMembers);
    }

    console.log('Final config values for circle:', circleId, configValues);
    
    // Ensure circleId is a string before returning
    const finalCircleId = typeof circleId === 'string' ? circleId : 'invalid-id';

    // Extract package ID from object type (format: 0x<packageId>::module::Type)
    let extractedPackageId: string | undefined;
    if (objectData?.data?.type && typeof objectData.data.type === 'string') {
      console.log(`🔍 Attempting to extract package ID from type: ${objectData.data.type}`);
      const typeMatch = objectData.data.type.match(/^(0x[a-fA-F0-9]+)::/);
      if (typeMatch) {
        extractedPackageId = typeMatch[1];
        console.log(`✅ Successfully extracted package ID ${extractedPackageId} from circle ${finalCircleId}`);
      } else {
        console.warn(`⚠️ Failed to match package ID pattern in type string: ${objectData.data.type}`);
      }
    } else {
      console.warn(`⚠️ Cannot extract package ID - type field missing or invalid for circle ${finalCircleId}`, {
        hasData: !!objectData?.data,
        hasType: !!objectData?.data?.type,
        typeOf: typeof objectData?.data?.type
      });
    }

    return {
      id: finalCircleId, // Use validated ID
      name: name,
      admin: admin,
      contributionAmount: configValues.contributionAmount,
      contributionAmountUsd: configValues.contributionAmountUsd,
      currencyType: circleCreationData?.currency_type || 'USD', // Add currency type with fallback
      securityDeposit: configValues.securityDeposit,
      securityDepositUsd: configValues.securityDepositUsd,
      cycleLength: configValues.cycleLength,
      cycleDay: configValues.cycleDay,
      maxMembers: configValues.maxMembers,
      currentMembers: currentMembers,
      nextPayoutTime: nextPayoutTime,
      memberStatus: 'active' as const,
      isAdmin: admin === userAddress,
      isActive: lifecycle.isActive,
      createdAt: transactionTimestamp, // Add creation timestamp
      transactionDigest: transactionDigest, // Add transaction digest for reference
      packageId: extractedPackageId // Store package ID for this circle
    };
  };

  // Event-driven circle fetching functions - much more efficient than transaction scanning
  
  // Progressive loading: Query initial user circles across all package IDs (fast load)
  const queryInitialUserCircles = useCallback(async (
    client: SuiClient,
    userAddress: string,
    defaultPackageId: string,
    limit: number = 5
  ): Promise<{
    circles: any[];
    adminCursor?: string;
    memberCursor?: string;
    hasMoreAdmin: boolean;
    hasMoreMember: boolean;
  }> => {
    // Wrap entire function to prevent any errors from escaping
    try {
      console.log(`🚀 Multi-package fast initial load: Querying ${limit} most recent circles for user...`);

      const results = {
        circles: [] as any[],
        adminCursor: undefined as string | undefined,
        memberCursor: undefined as string | undefined,
        hasMoreAdmin: false,
        hasMoreMember: false
      };

      try {
      // Always seed discovery with the current network's package lineage.
      const packageIdsToCheck = Array.from(new Set([
        ...getPackageLookupIdsForCurrentNetwork(defaultPackageId),
        ...(await getCachedUserPackageIds(userAddress)),
      ]));

      // Then expand with package IDs this user has interacted with.
      console.log('🔍 Getting user package IDs...');
      console.log(`Found ${packageIdsToCheck.length} package IDs for user/network:`, packageIdsToCheck);
      
      // Collect all admin events across all package IDs
      const allAdminEvents: any[] = [];
      const allMemberEvents: any[] = [];
      
      // Query admin events in parallel across all packages
      const adminEventsData = await batchQueryEvents(
        packageIdsToCheck,
        'CircleCreated',
        client,
        {
          maxConcurrent: 5,
          limit: 1000,
          order: 'descending',
          onProgress: (processed, total) => {
            console.log(`Admin events: ${processed}/${total} packages queried`);
          }
        }
      );

      // Filter for user's admin circles
      const userAdminEvents = adminEventsData.filter((event: any) => {
        const parsedEvent = event.parsedJson as CircleCreatedEvent;
        return parsedEvent?.admin === userAddress;
      });

      allAdminEvents.push(...userAdminEvents);
      console.log(`✅ Found ${userAdminEvents.length} admin circles across all packages`);
      
      // Query member events in parallel across all packages
      const memberEventsData = await batchQueryEvents(
        packageIdsToCheck,
        'MemberJoined',
        client,
        {
          maxConcurrent: 5,
          limit: 1000,
          order: 'descending'
        }
      );

      // Filter for user's member circles
      const userMemberEvents = memberEventsData.filter((event: any) => {
        const parsedEvent = event.parsedJson as MemberJoinedEvent;
        return parsedEvent?.member === userAddress;
      });

      console.log(`✅ Found ${userMemberEvents.length} member circles across all packages`);
      
      // 🔴 CRITICAL FIX: Query MemberRemoved events to filter out circles where user was removed
      console.log('🔍 Checking for MemberRemoved events to filter out removed members...');
      const memberRemovedEventsData = await batchQueryEvents(
        packageIdsToCheck,
        'MemberRemoved',
        client,
        {
          maxConcurrent: 5,
          limit: 1000,
          order: 'descending'
        }
      );

      // Filter for circles where THIS user was removed
      const userRemovedEvents = memberRemovedEventsData.filter((event: any) => {
        const parsedEvent = event.parsedJson as MemberRemovedEvent;
        return parsedEvent?.member === userAddress;
      });
      
      // Create a map of circle IDs to their LATEST removal timestamp
      // This allows us to check if user was re-added AFTER being removed
      const removedFromCircles = new Map<string, number>();
      for (const event of userRemovedEvents) {
        const parsedEvent = event.parsedJson as MemberRemovedEvent;
        const timestamp = Number(event.timestampMs || 0);
        if (parsedEvent?.circle_id) {
          const existingTimestamp = removedFromCircles.get(parsedEvent.circle_id) || 0;
          if (timestamp > existingTimestamp) {
            removedFromCircles.set(parsedEvent.circle_id, timestamp);
            console.log(`⛔ User was removed from circle: ${parsedEvent.circle_id} at ${new Date(timestamp).toISOString()}`);
          }
        }
      }
      console.log(`⛔ User has removal records from ${removedFromCircles.size} circles`);
      
      // Find the LATEST MemberJoined event for each circle (for re-add detection)
      const latestJoinTimestamp = new Map<string, number>();
      for (const event of userMemberEvents) {
        const parsedEvent = event.parsedJson as MemberJoinedEvent;
        const timestamp = Number(event.timestampMs || 0);
        if (parsedEvent?.circle_id) {
          const existingTimestamp = latestJoinTimestamp.get(parsedEvent.circle_id) || 0;
          if (timestamp > existingTimestamp) {
            latestJoinTimestamp.set(parsedEvent.circle_id, timestamp);
          }
        }
      }
      
      // Filter out circles where user was removed AND NOT re-added after
      // Note: We DON'T filter admin events - admins can remove themselves from the rotation but still own the circle
      const filteredMemberEvents = userMemberEvents.filter((event: any) => {
        const parsedEvent = event.parsedJson as MemberJoinedEvent;
        const circleId = parsedEvent?.circle_id;
        if (circleId && removedFromCircles.has(circleId)) {
          const removalTime = removedFromCircles.get(circleId) || 0;
          const latestJoinTime = latestJoinTimestamp.get(circleId) || 0;
          
          // If the most recent join is AFTER the most recent removal, user was re-added
          if (latestJoinTime > removalTime) {
            console.log(`✅ User was re-added to circle ${circleId} (joined: ${new Date(latestJoinTime).toISOString()}, removed: ${new Date(removalTime).toISOString()})`);
            return true; // Keep this circle - user was re-added
          }
          
          console.log(`🚫 Filtering out circle ${circleId} - user was removed and not re-added`);
          return false;
        }
        return true;
      });
      
      console.log(`✅ After filtering removed members: ${filteredMemberEvents.length} member circles (was ${userMemberEvents.length})`);
      allMemberEvents.push(...filteredMemberEvents);
      
      // Sort all admin events by timestamp (most recent first) and add ALL of them
      allAdminEvents.sort((a, b) => (b.timestampMs || 0) - (a.timestampMs || 0));
      results.circles.push(...allAdminEvents);
      results.hasMoreAdmin = false; // We're fetching all admin circles
      
      console.log(`🔍 Debug: Total admin events found: ${allAdminEvents.length}, adding ALL`);
      console.log(`🔍 Debug: INITIAL_LOAD_SIZE limit = ${limit}`);
      console.log(`🔍 Debug: Results.circles length after admin events: ${results.circles.length}`);

      // Sort all member events by timestamp and add ALL of them
      allMemberEvents.sort((a, b) => (b.timestampMs || 0) - (a.timestampMs || 0));
      results.circles.push(...allMemberEvents);
      results.hasMoreMember = false; // We're fetching all member circles
      
      console.log(`Total member events found: ${allMemberEvents.length}, adding ALL`);
      
      
      // Final sort of all circles by timestamp
      results.circles.sort((a, b) => (b.timestampMs || 0) - (a.timestampMs || 0));
      
      } catch (error) {
        console.error('Error in multi-package fast initial circle loading:', error);
        // Return empty results but don't throw - let the app handle gracefully
      }

      console.log(`🚀 Multi-package fast initial load completed: ${results.circles.length} circles found`);
      return results;
    } catch (outerError) {
      // Absolute final safety net - ensure function never throws
      console.error('CRITICAL: Unhandled error in queryInitialUserCircles:', outerError);
      return {
        circles: [],
        adminCursor: undefined,
        memberCursor: undefined,
        hasMoreAdmin: false,
        hasMoreMember: false
      };
    }
  }, []);
  // Progressive loading: Query more user circles across all packages (pagination)
  // Note: Simplified multi-package approach without cursors for now
  const queryMoreUserCircles = useCallback(async (
    client: SuiClient,
    userAddress: string,
    defaultPackageId: string,
    adminCursor?: string,
    memberCursor?: string,
    limit: number = 10
  ): Promise<{
    circles: any[];
    adminCursor?: string;
    memberCursor?: string;
    hasMoreAdmin: boolean;
    hasMoreMember: boolean;
  }> => {
    console.log(`📖 Multi-package loading more circles: limit=${limit}`);
    
    const results = {
      circles: [] as any[],
      adminCursor: undefined as string | undefined,
      memberCursor: undefined as string | undefined,
      hasMoreAdmin: false,
      hasMoreMember: false
    };
    
    try {
      const packageIdsToCheck = Array.from(new Set([
        ...getPackageLookupIdsForCurrentNetwork(defaultPackageId),
        ...(await getCachedUserPackageIds(userAddress)),
      ]));
      console.log(`Loading more circles across ${packageIdsToCheck.length} packages`);
      
      // Collect more events across all package IDs
      const allAdminEvents: any[] = [];
      const allMemberEvents: any[] = [];
      
      // Query each package ID for more admin events
      for (const packageId of packageIdsToCheck) {
        try {
          console.log(`Querying more admin events for package ${packageId}`);

          try {
            const adminResponse = await retryApiCall(
              // NOTE: Sui JSON-RPC `queryEvents` takes a SINGLE filter — there
              // is no AND-combinator to pair MoveEventType with Sender, so we
              // can't server-side-scope this to the user here. Admin-circle
              // discovery is instead handled scalably by getUserPackageIds via
              // `queryTransactionBlocks({ filter: { FromAddress } })`, which IS
              // server-side-filtered to the user's own transactions.
              () => client.queryEvents({
                query: { MoveEventType: `${packageId}::njangi_circles::CircleCreated` },
                limit: 1000,
                order: 'descending'
              }),
              1,
              500,
              `queryEvents CircleCreated more pkg ${packageId}`,
              2,
              undefined,
              true // gracefulFailure
            );

            if (adminResponse?.data && adminResponse.data.length > 0) {
              const userAdminEvents = adminResponse.data.filter((event: any) => {
                const parsedEvent = event.parsedJson as CircleCreatedEvent;
                return parsedEvent?.admin === userAddress;
              });

              // Add package info to each event
              userAdminEvents.forEach((event: any) => {
                event._packageId = packageId;
              });

              if (userAdminEvents.length > 0) {
                allAdminEvents.push(...userAdminEvents);
                console.log(`✅ Found ${userAdminEvents.length} more admin circles in package ${packageId}`);
              }
            }
          } catch (queryError) {
            const errorMsg = queryError instanceof Error ? queryError.message : String(queryError);
            if (!errorMsg.includes('Failed to fetch')) {
              console.warn(`⚠️ Query failed for package ${packageId}:`, errorMsg.substring(0, 100));
            }
          }
        } catch (outerError) {
          console.error(`❌ Unexpected error for package ${packageId}:`, outerError);
        }
      }
      
      // Query each package ID for more member events
      for (const packageId of packageIdsToCheck) {
        try {
          console.log(`Querying more member events for package ${packageId}`);

          try {
            const memberResponse = await retryApiCall(
              () => client.queryEvents({
                query: { MoveEventType: `${packageId}::njangi_circles::MemberJoined` },
                limit: 1000,
                order: 'descending'
              }),
              1,
              500,
              `queryEvents MemberJoined more pkg ${packageId}`,
              2,
              undefined,
              true // gracefulFailure
            );

            if (memberResponse?.data && memberResponse.data.length > 0) {
              const userMemberEvents = memberResponse.data.filter((event: any) => {
                const parsedEvent = event.parsedJson as MemberJoinedEvent;
                return parsedEvent?.member === userAddress;
              });

              // Add package info to each event
              userMemberEvents.forEach((event: any) => {
                event._packageId = packageId;
              });

              if (userMemberEvents.length > 0) {
                allMemberEvents.push(...userMemberEvents);
                console.log(`✅ Found ${userMemberEvents.length} more member circles in package ${packageId}`);
              }
            }
          } catch (queryError) {
            const errorMsg = queryError instanceof Error ? queryError.message : String(queryError);
            if (!errorMsg.includes('Failed to fetch')) {
              console.warn(`⚠️ Member query failed for package ${packageId}:`, errorMsg.substring(0, 100));
            }
          }
        } catch (outerError) {
          console.error(`❌ Unexpected error for package ${packageId}:`, outerError);
        }
      }
      
      // Combine and sort all events by timestamp
      const allEvents = [...allAdminEvents, ...allMemberEvents];
      allEvents.sort((a, b) => (b.timestampMs || 0) - (a.timestampMs || 0));
      
      // Return all events - no slicing limits with official Sui RPC
      results.circles = allEvents;
      
      // No artificial limits - always return false for hasMore since we fetch all
      results.hasMoreAdmin = false;
      results.hasMoreMember = false;
      
      console.log(`📖 Multi-package load more completed: ${results.circles.length} additional circles found across ${packageIdsToCheck.length} packages`);
      
    } catch (error) {
      console.error('Error in multi-package loading more circles:', error);
      // Don't throw, return what we have
    }
    
    return results;
  }, []);
  
  // Fast wallet events lookup across all packages (only for circles we've found)
  const queryWalletEventsForCircles = useCallback(async (
    client: SuiClient,
    defaultPackageId: string,
    circleIds: string[],
    userAddress: string
  ): Promise<any[]> => {
    // Wrap entire function to prevent any errors from escaping
    try {
      if (circleIds.length === 0) return [];

      console.log(`💰 Multi-package querying wallet events for ${circleIds.length} circles...`);

      try {
      const packageIdsToCheck = Array.from(new Set([
        ...getPackageLookupIdsForCurrentNetwork(defaultPackageId),
        ...(await getCachedUserPackageIds(userAddress)),
      ]));
      
      const allRelevantWalletEvents: any[] = [];
      
      // Query each package ID for wallet events (non-blocking)
      for (const packageId of packageIdsToCheck) {
        try {
          console.log(`💰 Querying wallet events for package ${packageId}`);

          // Simple query with comprehensive error handling - never throw
          let response;
          try {
            response = await retryApiCall(
              async () => {
                try {
                  return await client.queryEvents({
                    query: { MoveEventType: `${packageId}::njangi_custody::CustodyWalletCreated` },
                    limit: 1000,
                    order: 'descending'
                  });
                } catch (err) {
                  // Wallet event enrichment is supplementary, so expected RPC/network
                  // failures should degrade to empty results instead of surfacing.
                  if (isGracefulDashboardQueryError(err)) {
                    return { data: [] }; // Return empty result for deleted packages
                  }
                  throw err; // Re-throw other errors
                }
              },
              1, // Single retry for wallet events
              500,
              `queryEvents CustodyWalletCreated pkg ${packageId}`,
              1,
              undefined,
              true // gracefulFailure
            );
          } catch (queryError) {
            // Expected for packages not on current network or deleted circles
            const errorMsg = getSuiRpcErrorMessage(queryError);
            if (isGracefulDashboardQueryError(queryError)) {
              console.log(`💰 Package ${packageId} not accessible, skipping wallet events...`);
            } else {
              console.warn(`💰 Wallet events query failed for ${packageId}:`, errorMsg);
            }
            continue; // Skip to next package
          }

          if (response?.data) {
            // Filter only for circles we care about
            const relevantWalletEvents = response.data.filter((event: any) => {
              const eventJson = event.parsedJson as { circle_id?: string };
              return eventJson?.circle_id && circleIds.includes(eventJson.circle_id);
            });

            // Add package info to each event
            relevantWalletEvents.forEach((event: any) => {
              event._packageId = packageId;
            });

            allRelevantWalletEvents.push(...relevantWalletEvents);
            console.log(`💰 Found ${relevantWalletEvents.length} relevant wallet events in package ${packageId}`);
          }
        } catch (error) {
          // Final catch-all - handle deleted packages gracefully
          const errorMsg = getSuiRpcErrorMessage(error);
          if (isGracefulDashboardQueryError(error)) {
            console.log(`💰 Package ${packageId} deleted or not available (likely from package upgrade)`);
          } else {
            console.warn(`💰 Unexpected error for package ${packageId}:`, errorMsg.substring(0, 100));
          }
          // Continue with other packages - wallet events are supplementary data and deleted packages are expected
        }
      }
      
        console.log(`💰 Total relevant wallet events found: ${allRelevantWalletEvents.length} across ${packageIdsToCheck.length} packages`);
        return allRelevantWalletEvents;

      } catch (error) {
        console.warn('Wallet event enrichment failed, continuing without it:', error);
        return [];
      }
    } catch (outerError) {
      // Absolute final safety net - ensure function never throws
      console.warn('Wallet event enrichment hit an unexpected error, continuing without it:', outerError);
      return [];
    }
  }, []);
  
  // Batch validate circle objects with rate limiting
  const batchValidateCircles = useCallback(async (circleIds: string[], client: SuiClient): Promise<string[]> => {
    console.log(`Batch validating ${circleIds.length} circles on ${getCurrentNetwork()} network...`);
    
    const batchSize = 3; // Small batches to avoid overwhelming RPC
    const validCircleIds: string[] = [];
    
    for (let i = 0; i < circleIds.length; i += batchSize) {
      const batch = circleIds.slice(i, i + batchSize);
      
      const validationPromises = batch.map(async (circleId, index) => {
        // Stagger requests within batch to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, index * 150));
        
        try {
          const isValid = await validateCircleOnNetwork(circleId, client);
          return isValid ? circleId : null;
        } catch (error) {
          console.log(`Validation failed for circle ${circleId}:`, error);
          return null;
        }
      });
      
      const results = await Promise.allSettled(validationPromises);
      const batchValidIds = results
        .filter((result): result is PromiseFulfilledResult<string> => 
          result.status === 'fulfilled' && result.value !== null)
        .map(result => result.value);
      
      validCircleIds.push(...batchValidIds);
      
      // Delay between batches to ensure rate limiting compliance
      if (i + batchSize < circleIds.length) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    
    const filteredCount = circleIds.length - validCircleIds.length;
    if (filteredCount > 0) {
      console.log(`Filtered out ${filteredCount} circles not available on ${getCurrentNetwork()} network`);
    }
    
    return validCircleIds;
  }, []);
  // Fetch recent transaction history for display
  const fetchTransactionHistory = useCallback(async () => {
    if (!userAddress) return [];

    const currentHistoryNetwork = network === 'mainnet' ? 'mainnet' : 'testnet';
    const activeNetworkConfig = getCurrentNetworkConfig();
    const rpcCandidates = Array.from(new Set([
      getCurrentRpcUrl(),
      ...getRpcCandidateUrls(currentHistoryNetwork),
    ].filter(Boolean)));
    
    setIsLoadingHistory(true);
    setHistoryError(null);
    
    try {
      const queryHistoryWithFallback = async (
        filter: { FromAddress: string } | { ToAddress: string },
        operationName: string,
      ): Promise<{ data: any[]; failed: boolean }> => {
        let lastErrorMessage = 'Unknown error';

        for (const rpcUrl of rpcCandidates) {
          try {
            const client = getSuiClientFromPool(rpcUrl);
            const response = await retryApiCall(
              () => client.queryTransactionBlocks({
                filter,
                options: {
                  showInput: true,
                  showEvents: true,
                  showEffects: true,
                  showObjectChanges: false,
                  showBalanceChanges: true
                },
                limit: HISTORY_FETCH_LIMIT,
                order: 'descending'
              }),
              2,
              1000,
              operationName,
              5,
              rpcUrl,
              false,
            );

            return {
              data: response?.data ?? [],
              failed: false,
            };
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            lastErrorMessage = errorMessage;

            if (
              error instanceof TypeError ||
              errorMessage.includes('Failed to fetch') ||
              errorMessage.includes('Network request failed')
            ) {
              blacklistEndpoint(rpcUrl, `${operationName} failed: ${errorMessage}`);
            }

            console.warn(`${operationName} failed on ${rpcUrl}: ${errorMessage}`);
          }
        }

        console.warn(`${operationName} failed on all RPC endpoints: ${lastErrorMessage}`);
        return { data: [], failed: true };
      };

      const sentResponse = await queryHistoryWithFallback(
        { FromAddress: userAddress },
        'fetchSentTransactionHistory',
      );
      const receivedResponse = await queryHistoryWithFallback(
        { ToAddress: userAddress },
        'fetchReceivedTransactionHistory',
      );

      if (sentResponse.failed && receivedResponse.failed) {
        setTransactionHistory([]);
        setHistoryError(`Failed to load transaction history on ${currentHistoryNetwork}`);
        return [];
      }

      const mergedTransactions = new Map<string, any>();
      for (const tx of [...sentResponse.data, ...receivedResponse.data]) {
        if (!mergedTransactions.has(tx.digest)) {
          mergedTransactions.set(tx.digest, tx);
        }
      }

      const processedTransactions = Array.from(mergedTransactions.values())
        .sort((a, b) => Number(b.timestampMs || 0) - Number(a.timestampMs || 0))
        .slice(0, HISTORY_FETCH_LIMIT)
        .map((tx: any): TransactionHistoryItem => {
          const timestamp = tx.timestampMs ? new Date(Number(tx.timestampMs)) : new Date();
          const { sentAmounts, receivedAmounts } = buildHistoryAmounts(
            tx,
            userAddress,
            activeNetworkConfig,
          );

          const direction: HistoryDirection =
            sentAmounts.length > 0 && receivedAmounts.length > 0
              ? 'mixed'
              : receivedAmounts.length > 0
                ? 'received'
                : sentAmounts.length > 0
                  ? 'sent'
                  : 'neutral';

          return {
            digest: tx.digest,
            timestamp,
            type: getTransactionHistoryLabel(tx, direction),
            direction,
            sentAmounts,
            receivedAmounts,
            status: tx.effects?.status?.status === 'success' ? 'Success' : 'Failed',
            gasFee: Number(getNetGasFeeMist(tx)) / 1_000_000_000,
            explorerUrl: getHistoryExplorerUrl(currentHistoryNetwork, tx.digest),
          };
        });
      
      setTransactionHistory(processedTransactions);
      return processedTransactions;
    } catch (error) {
      console.error('Error fetching transaction history:', error);
      setTransactionHistory([]);
      setHistoryError('Failed to load transaction history');
      return [];
    } finally {
      setIsLoadingHistory(false);
    }
  }, [userAddress, network]);

  // Extract circle events from contract-specific transactions
  const extractCircleEventsFromTransactions = useCallback(async (transactions: any[], userAddress: string) => {
    const circleEvents: any[] = [];
    const memberEvents: any[] = [];
    const custodyDepositedEvents: any[] = [];
    const activationEvents: any[] = [];
    const walletEvents: any[] = [];
    
    console.log(`Extracting circle-related events from ${transactions.length} contract-specific transactions...`);
    
    for (const tx of transactions) {
      // Since we already filtered for contract-specific transactions, 
      // we can directly process the events without additional function checking
      if (tx.events && tx.events.length > 0) {
        for (const event of tx.events) {
          const eventWithTimestamp = {
            ...event,
            timestampMs: event.timestampMs ?? tx.timestampMs,
          };

          // Parse event types and filter for relevant ones
          if (event.type && event.parsedJson) {
            if (event.type.includes('CircleCreated')) {
              const eventData = event.parsedJson as CircleCreatedEvent;
              if (eventData.admin === userAddress) {
                circleEvents.push(eventWithTimestamp);
              }
            } else if (event.type.includes('MemberJoined')) {
              const eventData = event.parsedJson as MemberJoinedEvent;
              if (eventData.member === userAddress) {
                memberEvents.push(eventWithTimestamp);
              }
            } else if (event.type.includes('CustodyDeposited')) {
              const eventData = event.parsedJson as CustodyDepositedEvent;
              if (eventData.member === userAddress) {
                custodyDepositedEvents.push(eventWithTimestamp);
              }
            } else if (event.type.includes('CircleActivated')) {
              // CircleActivated events are relevant for all users to know activation status
              activationEvents.push(eventWithTimestamp);
            } else if (event.type.includes('CustodyWalletCreated')) {
              // Wallet creation events are useful for mapping circle IDs to wallet IDs
              walletEvents.push(eventWithTimestamp);
            }
          }
        }
      }
    }
    
    console.log(`Extracted events - CircleCreated: ${circleEvents.length}, MemberJoined: ${memberEvents.length}, CustodyDeposited: ${custodyDepositedEvents.length}, CircleActivated: ${activationEvents.length}, WalletCreated: ${walletEvents.length}`);
    
    return {
      circleEvents,
      memberEvents,
      custodyDepositedEvents,
      activationEvents,
      walletEvents
    };
  }, []);

  const queryUserCircleEventsFromTransactions = useCallback(async (
    client: SuiClient,
    userAddress: string
  ): Promise<any[]> => {
    const relevantTransactions: any[] = [];
    let cursor: string | undefined;
    let pageCount = 0;
    let hasNextPage = true;
    const maxPages = 10;

    while (hasNextPage && pageCount < maxPages) {
      const response = await retryApiCall(
        () => client.queryTransactionBlocks({
          filter: { FromAddress: userAddress },
          cursor,
          limit: 1000,
          order: 'descending',
          options: { showEvents: true }
        }),
        2,
        1000,
        `queryUserCircleTransactions page ${pageCount + 1}`,
        3,
        undefined,
        true
      );

      const transactions = response?.data ?? [];
      relevantTransactions.push(
        ...transactions.filter((tx: any) =>
          Array.isArray(tx?.events) &&
          tx.events.some((event: any) =>
            typeof event?.type === 'string' &&
            event.type.includes('::njangi_circles::')
          )
        )
      );

      pageCount += 1;
      hasNextPage = Boolean(response?.hasNextPage);
      cursor = response?.nextCursor ?? undefined;
    }

    if (hasNextPage) {
      console.warn(`Stopped transaction-based circle discovery after ${maxPages} pages for ${userAddress}`);
    }

    const { circleEvents, memberEvents } = await extractCircleEventsFromTransactions(
      relevantTransactions,
      userAddress,
    );

    return mergeDiscoveredCircleEvents(circleEvents, memberEvents);
  }, [extractCircleEventsFromTransactions]);
  // Helper function to get all user addresses (current implementation returns single address)
  // TODO: Extend this to support multiple addresses per user across different OAuth providers
  const getAllUserAddresses = useCallback(async (): Promise<string[]> => {
    // Current implementation only returns the single authenticated address
    // In the future, this could be extended to:
    // 1. Query a user profile service to get linked addresses
    // 2. Check for addresses generated from different OAuth providers
    // 3. Query transaction history to identify related addresses
    
    if (!userAddress) {
      return [];
    }
    
    // For now, return only the current user address
    // This can be extended to return multiple addresses when user profile linking is implemented
    return [userAddress];
  }, [userAddress]);

  const fetchUserCircles = useCallback(async (forceRefresh: boolean = false) => {
    console.log('🔍 DEBUG: fetchUserCircles starting...', { forceRefresh, userAddress: userAddress?.slice(0, 6) + '...' });
    console.log('🔍 DEBUG: Full userAddress =', userAddress);

    if (!userAddress) {
      console.log('No user address, skipping fetch');
      return;
    }

    const cacheKey = getCacheKey(userAddress, 'circles');
    const isInitialLoadWithCache = circles.length > 0;
    const cacheStale = isCacheStale(cacheKey, CACHE_CONFIG.CIRCLES_TTL);
    
    console.log('Cache status:', { 
      isInitialLoadWithCache, 
      cacheStale, 
      forceRefresh,
      circlesLength: circles.length 
    });
    
    // Early return if we have fresh cached data and not forcing refresh
    if (!forceRefresh && isInitialLoadWithCache && !cacheStale) {
      console.log('Using fresh cached data, skipping fetch');
      setLoading(false);
      return;
    }
    
    // If we have cached data but it's stale, show cached data and refresh in background
    if (!forceRefresh && isInitialLoadWithCache && cacheStale) {
      console.log('Cache is stale, refreshing in background...');
      setIsBackgroundRefreshing(true);
    } else if (!isInitialLoadWithCache) {
      // No cached data, show loading
      setLoading(true);
    }
    setError('');
    setNetworkError({ type: null, message: '', canRetry: false, retryCount: 0 });
    setLoadingProgress({ stage: 'network_validation', current: 0, total: 0, message: 'Validating network configuration...' });
    
    try {
      // Validate network configuration before proceeding
      const currentRpcUrl = getCurrentRpcUrl();
      const currentPackageId = getCurrentPackageId();
      const currentNetwork = getCurrentNetwork();
      
      console.log('🌍 fetchUserCircles: Network validation:', { 
        currentNetwork, 
        currentRpcUrl, 
        currentPackageId,
        localRpcUrl: rpcUrl 
      });
      
      // Ensure we have valid network configuration
      if (!currentRpcUrl || !currentPackageId) {
        throw new Error(`Invalid network configuration for ${currentNetwork}: missing RPC URL or package ID`);
      }
      
      // Use official Sui RPC for circle fetching to avoid rate limits
      const rpcCandidates = getRpcCandidateUrls(currentNetwork);
      console.log('🌍 fetchUserCircles: Using shared RPC candidates:', rpcCandidates);

      // Use the first shared candidate and let the pooled client transport fail over.
      const client = getSuiClientFromPool(rpcCandidates[0]);
      
      // Get all user addresses for comprehensive circle fetching
      const allUserAddresses = await getAllUserAddresses();
      console.log('Fetching circles for user addresses:', allUserAddresses);
      
      setLoadingProgress({ stage: 'fetching_events', current: 1, total: 3, message: 'Fast loading recent circles...' });
      
      // NEW PROGRESSIVE APPROACH: Fast initial load of 5 most recent circles!
      console.log(`🚀 Progressive loading: Fast initial load for ${getCurrentNetwork()} network...`);
      let initialResults = {
        circles: [] as any[],
        adminCursor: undefined as string | undefined,
        memberCursor: undefined as string | undefined,
        hasMoreAdmin: false,
        hasMoreMember: false
      };
      
      try {
        // The two discovery sources (event-based circle scan + the user's own
        // transaction-derived events) are independent, so run them concurrently
        // instead of one-after-the-other. Both are cached via cachedApiCall.
        const initialCacheKey = getCacheKey(userAddress, 'initialCircles');
        const transactionDiscoveryCacheKey = getCacheKey(userAddress, 'transactionCircleEvents');
        const [initialResultsFromScan, transactionDiscoveredEvents] = await Promise.all([
          cachedApiCall(
            initialCacheKey,
            () => queryInitialUserCircles(client, userAddress, currentPackageId, INITIAL_LOAD_SIZE),
            CACHE_CONFIG.CIRCLES_TTL / 2, // Shorter cache for initial load to keep it fresh
          ),
          cachedApiCall(
            transactionDiscoveryCacheKey,
            () => queryUserCircleEventsFromTransactions(client, userAddress),
            CACHE_CONFIG.CIRCLES_TTL / 2,
          ),
        ]);
        initialResults = initialResultsFromScan;

        if (transactionDiscoveredEvents.length > 0) {
          initialResults = {
            ...initialResults,
            circles: mergeDiscoveredCircleEvents(initialResults.circles, transactionDiscoveredEvents),
          };
          console.log(`🧾 Supplemented initial discovery with ${transactionDiscoveredEvents.length} transaction-derived circle events`);
        }
        
        console.log(`🚀 Fast initial load results:`, {
          circles: initialResults.circles.length,
          hasMoreAdmin: initialResults.hasMoreAdmin,
          hasMoreMember: initialResults.hasMoreMember
        });
        
        // Update pagination state
        setPaginationState({
          adminCursor: initialResults.adminCursor,
          memberCursor: initialResults.memberCursor,
          hasMoreAdmin: initialResults.hasMoreAdmin,
          hasMoreMember: initialResults.hasMoreMember,
          totalFetched: initialResults.circles.length
        });
        
      } catch (error) {
        console.error('Error in fast initial load:', error);
        
        // Set appropriate network error
        setNetworkError({
          type: 'connection_failed',
          message: 'Failed to load recent circles. Some circles may not be displayed.',
          canRetry: true,
          retryCount: networkError.retryCount + 1
        });
        
        // Try to use any cached data as fallback
        const cachedData = getCacheItem(getCacheKey(userAddress, 'initialCircles'), CACHE_CONFIG.CIRCLES_TTL * 3);
        if (cachedData && cachedData.circles) {
          console.log(`🔍 DEBUG: Using stale cached data with ${cachedData.circles.length} circles`);
          console.log(`🔍 DEBUG: This is why our fetchUserCircles debug logs don't show - using cache instead!`);
          initialResults = cachedData;
          setPaginationState({
            adminCursor: cachedData.adminCursor,
            memberCursor: cachedData.memberCursor,
            hasMoreAdmin: cachedData.hasMoreAdmin,
            hasMoreMember: cachedData.hasMoreMember,
            totalFetched: cachedData.circles.length
          });
        } else {
          console.warn('No cached initial data available, continuing with empty dataset');
          initialResults = { circles: [], adminCursor: undefined, memberCursor: undefined, hasMoreAdmin: false, hasMoreMember: false };
          setPaginationState({
            adminCursor: undefined,
            memberCursor: undefined,
            hasMoreAdmin: false,
            hasMoreMember: false,
            totalFetched: 0
          });
        }
      }
      
      // Process the initial circles efficiently
      console.log(`🎯 Processing ${initialResults.circles.length} initial circles...`);
      
      // Extract circle IDs from initial results
      const initialCircleIds = initialResults.circles.map(event => {
        const eventData = event.parsedJson as CircleCreatedEvent | MemberJoinedEvent;
        return eventData.circle_id;
      }).filter(Boolean);
      
      // Two independent wallet-id sources — targeted wallet events and the
      // circles' dynamic fields — feed separate maps that are merged below, so
      // fetch them concurrently instead of one-after-the-other. Both are
      // best-effort: on failure the page still renders without wallet ids.
      let walletEvents: any[] = [];
      let dynamicFieldsMap: Map<string, Array<Record<string, unknown>>> = new Map();
      if (initialCircleIds.length > 0) {
        setLoadingProgress({ stage: 'fetching_events', current: 2, total: 3, message: 'Loading wallet info...' });
        const [walletEventsResult, dynamicFieldsResult] = await Promise.all([
          queryWalletEventsForCircles(client, currentPackageId, initialCircleIds, userAddress).catch((error) => {
            console.warn('Wallet event enrichment failed, continuing without it:', error);
            return [] as any[];
          }),
          batchFetchDynamicFields(
            initialCircleIds.slice(0, 20), // Limit to first 20 for initial load
            client,
            {
              maxConcurrent: 2,
              onProgress: (fetched, total) => {
                setLoadingProgress({
                  stage: 'fetching_metadata',
                  current: fetched,
                  total,
                  message: `Loading wallet info: ${fetched}/${total}...`
                });
              }
            }
          ).catch((error) => {
            console.warn('Dynamic-field enrichment failed, continuing without it:', error);
            return new Map<string, Array<Record<string, unknown>>>();
          }),
        ]);
        walletEvents = walletEventsResult;
        dynamicFieldsMap = dynamicFieldsResult;
      }

      // Create a map of circle IDs to wallet IDs (from targeted wallet events)
      const circleWalletMap = new Map<string, string>();
      for (const event of walletEvents) {
        if (event.parsedJson && typeof event.parsedJson === 'object') {
          const eventJson = event.parsedJson as { circle_id?: string, wallet_id?: string };
          if (eventJson.circle_id && eventJson.wallet_id) {
            circleWalletMap.set(eventJson.circle_id, eventJson.wallet_id);
          }
        }
      }
      console.log('Circle to wallet ID mapping:', Object.fromEntries(circleWalletMap));

      // Resolve wallet-id dynamic fields in ONE batched read: collect every
      // matching field's object id, then fetch them all via readObjects
      // (chunked multiGetObjects + failover + cache) instead of awaiting a
      // getObject per field in a nested loop.
      const circleWalletMapFromDynamic = new Map<string, string>();
      const walletFieldRefs: Array<{ circleId: string; objectId: string }> = [];
      for (const [circleId, fields] of dynamicFieldsMap.entries()) {
        for (const field of fields) {
          const fieldName = field?.name && typeof field.name === 'object' && 'type' in field.name ? field.name.type : '';
          const fieldType = field?.type ?? '';
          if ((fieldName as string)?.includes?.('vector<u8>') && (fieldType as string)?.includes?.('wallet_id')) {
            if (field.objectId) {
              walletFieldRefs.push({ circleId, objectId: field.objectId as string });
            }
          }
        }
      }
      if (walletFieldRefs.length > 0) {
        try {
          const walletFieldObjects = await readObjects(
            walletFieldRefs.map((ref) => ref.objectId),
            { showContent: true },
            { network: currentNetwork },
          );
          walletFieldRefs.forEach((ref, idx) => {
            const content = walletFieldObjects[idx]?.data?.content;
            const contentFields = content && typeof content === 'object' && 'fields' in content
              ? (content.fields as { value?: string })
              : null;
            if (contentFields?.value) {
              circleWalletMapFromDynamic.set(ref.circleId, contentFields.value);
            }
          });
        } catch (e) {
          // Enrichment is best-effort; continue without dynamic-field wallet ids.
          console.warn('Batched wallet-field fetch failed, continuing without it:', e);
        }
      }

      // Merge with event-based wallet map
      const mergedCircleWalletMap = new Map([...circleWalletMap, ...circleWalletMapFromDynamic]);
      // Update the original circleWalletMap with merged data
      for (const [key, value] of mergedCircleWalletMap.entries()) {
        circleWalletMap.set(key, value);
      }
      
      // Create a member count map based on member events (used as fallback only)
      const memberCountMap = new Map<string, Set<string>>();
      
      // Add admins (circle creators) to member count for fallback
      console.log(`Processing ${initialResults.circles.length} circle creation events for fallback member count`);
      for (const event of initialResults.circles) {
        if (event.parsedJson && typeof event.parsedJson === 'object') {
          const eventJson = event.parsedJson as CircleCreatedEvent;
          if (eventJson.circle_id && eventJson.admin) {
            if (!memberCountMap.has(eventJson.circle_id)) {
              memberCountMap.set(eventJson.circle_id, new Set<string>());
            }
            memberCountMap.get(eventJson.circle_id)!.add(eventJson.admin);
          }
        }
      }
      
      // Add members from MemberJoined events for fallback
      const fallbackMemberEvents: any[] = []; // Empty array for now - member counts will be fetched per circle as needed
      console.log(`Processing ${fallbackMemberEvents.length} member join events for fallback member count`);
      for (const event of fallbackMemberEvents) {
        if (event.parsedJson && typeof event.parsedJson === 'object') {
          const eventJson = event.parsedJson as { circle_id?: string, member?: string };
          if (eventJson.circle_id && eventJson.member) {
            if (!memberCountMap.has(eventJson.circle_id)) {
              memberCountMap.set(eventJson.circle_id, new Set<string>());
            }
            memberCountMap.get(eventJson.circle_id)!.add(eventJson.member);
          }
        }
      }
      
      console.log(`Created fallback member count map for ${memberCountMap.size} circles`);
      
      // Create mapping from circle ID to creation event data
      const circleCreationDataMap = new Map<string, CircleCreatedEvent>();
      
      // Extract transaction input data directly from the transaction data we already have
      const transactionInputMap = new Map<string, TransactionInputData>();
      
      // Helper function to extract cycle_day from transaction inputs
      const extractCycleDayFromTransaction = (tx: any): number | undefined => {
        try {
          // Try to extract from the transaction data that we already have
          if (tx?.transaction?.data?.transaction?.kind === 'ProgrammableTransaction') {
            const txData = tx.transaction.data.transaction;
            const inputs = txData.inputs || [];
            
            // Try to find the cycle_day input (typically at index 6 for create_circle calls)
            if (inputs.length > 6 && inputs[6].type === 'pure' && inputs[6].valueType === 'u64') {
              const cycleDay = inputs[6].value;
              console.log(`Found cycle_day ${cycleDay} from transaction inputs`);
              return Number(cycleDay);
            }
          }
        } catch (error) {
          console.log('Could not extract cycle_day from transaction inputs:', error);
        }
        return undefined;
      };
      
      // Process initial circle events and extract data efficiently
      const allUserCircleIds = new Set<string>();
      const circleMetadata = new Map<string, { 
        isAdmin: boolean; 
        eventData: any; 
        createdAt?: number; 
        transactionDigest?: string; 
      }>();
      
      // Process each initial result event
      for (const event of initialResults.circles) {
        const eventType = event.type;
        
        if (eventType && eventType.includes('CircleCreated') && event.parsedJson) {
          // This is a CircleCreated event (user as admin)
          const parsedEvent = event.parsedJson as CircleCreatedEvent;
          if (parsedEvent.circle_id) {
            circleCreationDataMap.set(parsedEvent.circle_id, parsedEvent);
            allUserCircleIds.add(parsedEvent.circle_id);
            circleMetadata.set(parsedEvent.circle_id, { 
              isAdmin: true, 
              eventData: parsedEvent,
              createdAt: event.timestampMs ? Number(event.timestampMs) : undefined,
              transactionDigest: event.id?.txDigest
            });
          }
        } else if (eventType && eventType.includes('MemberJoined') && event.parsedJson) {
          // This is a MemberJoined event (user as member)
          const parsedEvent = event.parsedJson as MemberJoinedEvent;
          if (parsedEvent.circle_id) {
            allUserCircleIds.add(parsedEvent.circle_id);
            
            // Enhanced filtering with new MemberJoined event fields:
            // Only track as member-only if:
            // 1. Not already tracked as admin (prevents duplicate tracking)
            // 2. User is ACTIVE or PENDING member (exclude EXITED/SUSPENDED)
            const isActiveMember = isDiscoverableMemberEvent(parsedEvent);
            
            if (!circleMetadata.has(parsedEvent.circle_id) && isActiveMember) {
              circleMetadata.set(parsedEvent.circle_id, { 
                isAdmin: false, 
                eventData: parsedEvent,
                createdAt: event.timestampMs ? Number(event.timestampMs) : undefined,
                transactionDigest: event.id?.txDigest
              });
            }
          }
        }
      }
      
      // Scalable membership discovery (L3): owned soulbound CircleMembership
      // receipts. getOwnedObjects is server-side filtered by owner+type — cost
      // scales with the user's memberships, not the global MemberJoined stream
      // (which can't be filtered by member address server-side). Additive: only
      // surfaces circles the event scan missed.
      //
      // A receipt is a HINT, not proof of current membership: it's soulbound
      // and survives a removal, so each candidate the event scan didn't already
      // surface is VERIFIED against the circle's live members table before we
      // trust it — the receipt path's equivalent of the event path's
      // MemberRemoved filtering. Verification is O(the user's receipt circles).
      try {
        const receiptCircleIds = await discoverMemberCircleIds(userAddress, { network: currentNetwork });
        const undiscovered = receiptCircleIds.filter((cid) => !allUserCircleIds.has(cid));
        const verified = await Promise.all(
          undiscovered.map(async (cid) =>
            (await userIsCurrentMemberOrAdmin(client, cid, userAddress)) ? cid : null,
          ),
        );
        let surfaced = 0;
        for (const cid of verified) {
          if (!cid) continue;
          allUserCircleIds.add(cid);
          if (!circleMetadata.has(cid)) {
            // isAdmin is recomputed from the loaded object in processCircleObject
            // and the safeCircleData spread now uses processedCircle.isAdmin, so
            // this placeholder is never the displayed value.
            circleMetadata.set(cid, { isAdmin: false, eventData: undefined });
          }
          surfaced += 1;
        }
        if (surfaced > 0) {
          console.log(`🎟️ Membership receipts surfaced ${surfaced} verified circle(s) the event scan missed`);
        }
      } catch (membershipError) {
        console.warn('Membership receipt discovery failed (non-fatal, falling back to event scan):', membershipError);
      }

      console.log(`Found ${allUserCircleIds.size} unique circles for user:`, Array.from(allUserCircleIds));

      setLoadingProgress({ stage: 'validating_circles', current: 2, total: 4, message: `Processing ${allUserCircleIds.size} circles on ${getCurrentNetwork()}...` });

      // Skip strict validation - circles from events are already valid
      // Validation was incorrectly filtering out circles from multiple package IDs
      const allCircleIds = Array.from(allUserCircleIds);
      console.log(`✅ Processing ALL ${allCircleIds.length} circles found on ${getCurrentNetwork()} (skipping validation - circles from events are valid)`);
      
      const circleIds = allCircleIds;
      setLoadingProgress({ stage: 'processing_circles', current: 3, total: 4, message: `Processing ${circleIds.length} validated circles...` });

      console.log(`📦 OPTIMIZED: Batch fetching ${circleIds.length} circles using multiGetObjects...`);
      // 50 is Sui's multiGetObjects cap — one round-trip covers up to 50
      // circles. The failover transport (cooldown + RPC fallback) now handles
      // the reliability concern that previously forced this down to 10, so most
      // users load all their circles in a single batch with no inter-batch wait.
      const batchSize = 50;
      const allProcessedCircles: Circle[] = [];

      for (let i = 0; i < circleIds.length; i += batchSize) {
        const batch = circleIds.slice(i, i + batchSize);
        console.log(`📦 Fetching batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(circleIds.length / batchSize)} (${batch.length} circles)`);
        
        // **OPTIMIZATION 1**: Fetch ALL circles in this batch with ONE API call (with retry)
        let batchObjectsData;
        let retryCount = 0;
        const maxRetries = 3;
        
        while (retryCount < maxRetries) {
          try {
            batchObjectsData = await client.multiGetObjects({
              ids: batch,
              options: {
                showType: true,
                showOwner: true,
                showContent: true,
                showDisplay: false,
                showStorageRebate: false,
                showPreviousTransaction: false,
                showBcs: false
              }
            });
            console.log(`✅ Fetched ${batch.length} circles in one call`);
            break; // Success, exit retry loop
          } catch (error) {
            retryCount++;
            const errorMsg = error instanceof Error ? error.message : String(error);
            console.warn(`⚠️ Batch fetch attempt ${retryCount}/${maxRetries} failed: ${errorMsg}`);
            
            if (retryCount >= maxRetries) {
              console.warn(`⚠️ multiGetObjects failed after ${maxRetries} attempts. Falling back to per-object fetches for this batch.`);
              try {
                const fallbackObjects = await batchFetchCircleObjects(batch, client, {
                  maxConcurrent: 2,
                  showType: true,
                  showOwner: true,
                  showContent: true
                });

                batchObjectsData = batch.map((circleId) => {
                  const objectData = fallbackObjects.get(circleId);
                  return objectData && Object.keys(objectData).length > 0 ? objectData : null;
                });

                console.log(`✅ Fallback fetch completed for ${batch.length} circles`);
              } catch (fallbackError) {
                const fallbackErrorMsg = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
                console.warn(`⚠️ Fallback object fetch failed for batch: ${fallbackErrorMsg}`);
                batchObjectsData = null;
              }
              break;
            } else {
              // Exponential backoff: 1s, 2s, 4s
              const delayMs = Math.pow(2, retryCount - 1) * 1000;
              console.log(`⏳ Retrying in ${delayMs}ms...`);
              await new Promise(resolve => setTimeout(resolve, delayMs));
            }
          }
        }

        // Skip this batch if all retries failed
        if (!batchObjectsData) {
          console.warn(`⏭️ Skipping batch of ${batch.length} circles due to network errors`);
          continue;
        }
        
        // **OPTIMIZATION 2**: Process all circles in parallel (no delays)
        const batchPromises = batch.map(async (circleId, batchIndex) => {
          const metadata = circleMetadata.get(circleId);
          if (!metadata) return null;
          
          const objectData = batchObjectsData[batchIndex]; // Use pre-fetched data
          
          try {
            console.log(`⚡ Processing circle ${i + batchIndex + 1}/${circleIds.length}: ${circleId}`);
            
            // Skip if object doesn't exist
            if (!objectData?.data || objectData.error) {
              console.log(`Circle ${circleId} no longer exists, skipping...`);
              return null;
            }
            
            // Cache individual circle object data
            const objectCacheKey = getCacheKey(userAddress, 'circleObject', circleId);
            const circleData = await cachedApiCall(
              objectCacheKey,
              async () => {
                  // **OPTIMIZATION 3**: Get dynamic fields without delay (already rate-limited by batch processing)
                  let dynamicFieldsResult;
                  try {
                    dynamicFieldsResult = await client.getDynamicFields({
                      parentId: circleId
                    });
                    console.log(`📋 Dynamic fields for circle ${circleId}:`, dynamicFieldsResult.data.length, 'fields');
                  } catch (error) {
                    console.warn(`⚠️ No dynamic fields for circle ${circleId}`);
                    dynamicFieldsResult = { data: [] };
                  }
                  
                  // Add transaction input data if we have it
                  const transactionInput = transactionInputMap.get(circleId);
                  
                  // Add type assertions for the EnhancedObjectData
                  const enhancedObjectData = {
                    ...objectData,
                    data: {
                      ...objectData.data,
                      dynamicFields: dynamicFieldsResult.data,
                    },
                    transactionInput
                  };
                  
                  return enhancedObjectData;
                },
                CACHE_CONFIG.API_RESPONSE_TTL
              );
              
            if (!circleData) return null;
            
            // Process circle using the helper function with all data sources
            let processedCircle;
            try {
              processedCircle = await processCircleObject(
                circleData, 
                userAddress, 
                metadata.eventData, 
                client, 
                metadata.createdAt, 
                metadata.transactionDigest
              );
            } catch (error) {
              console.error(`Error processing circle ${circleId}:`, error);
              
              // If it's a fetch error, it might be due to network mismatch
              if (error instanceof Error && error.message.includes('Failed to fetch')) {
                console.warn(`Circle ${circleId} might be from a different network. Skipping...`);
                return null;
              }
              
              // For other errors, still skip but log more details
              console.error(`Unexpected error processing circle ${circleId}:`, error);
              return null;
            }
            
            if (processedCircle) {
              // Update with the actual member count from events
              const memberCount = memberCountMap.has(circleId) 
                ? memberCountMap.get(circleId)!.size 
                : 1; // Default to 1 (admin only)
              
              console.log(`Circle ${circleId}: Member count calculation:`, {
                hasCircleInMap: memberCountMap.has(circleId),
                memberSetSize: memberCountMap.has(circleId) ? memberCountMap.get(circleId)!.size : 0,
                finalMemberCount: memberCount,
                isAdmin: metadata.isAdmin,
                members: memberCountMap.has(circleId) ? Array.from(memberCountMap.get(circleId)!) : []
              });
              
                const safeCircleData = {
                  ...processedCircle,
                  id: processedCircle?.id ?? '',
                  name: typeof processedCircle?.name === 'string' ? processedCircle.name : '',
                  admin: typeof processedCircle?.admin === 'string' ? processedCircle.admin : '',
                  // Use the value recomputed from the loaded object (admin === userAddress).
                  // metadata.isAdmin is a placeholder (false) for receipt-only-discovered
                  // circles, so trusting it here would mis-label a receipt-discovered admin.
                  isAdmin: processedCircle?.isAdmin ?? metadata.isAdmin,
                  memberStatus: 'active' as const
                } as Circle;
                
                // Try to get wallet ID from map (already batch-fetched)
                const walletId = circleWalletMap.get(circleId);
                
                // Use blockchain's current_members field as primary source, with event-based count as fallback
                const finalMemberCount = safeCircleData.currentMembers > 0 
                  ? safeCircleData.currentMembers 
                  : memberCount;
                
                console.log(`Circle ${circleId}: Member count decision:`, {
                  blockchainCurrentMembers: safeCircleData.currentMembers,
                  eventBasedMemberCount: memberCount,
                  finalMemberCount: finalMemberCount,
                  source: safeCircleData.currentMembers > 0 ? 'blockchain' : 'events'
                });
                
                return {
                  ...safeCircleData,
                  currentMembers: finalMemberCount,
                  isActive: safeCircleData.isActive,
                  walletId: walletId || undefined
                };
              }
              return null;
          } catch (error) {
            console.error(`Error fetching circle details for ${circleId}:`, error);
            return null;
          }
        });
        
        // Wait for batch to complete
        const batchResults = await Promise.allSettled(batchPromises);
        
        // Process batch results
        batchResults.forEach(result => {
          if (result.status === 'fulfilled' && result.value) {
            allProcessedCircles.push(result.value);
          }
        });
        
        // Light spacer between batches (only reached by users with >50 circles).
        // The failover client already backs off on rate limits, so the previous
        // fixed 1s wait was the dominant wall-clock cost for no added safety.
        if (i + batchSize < circleIds.length) {
          console.log('Waiting between batches...');
          await new Promise(resolve => setTimeout(resolve, 200));
        }
      }
      
      // allProcessedCircles is already populated from batch processing above
      console.log(`Successfully processed ${allProcessedCircles.length} circles`);
      
      console.log(`Processed ${allProcessedCircles.length} circles before deduplication`);
      console.log('Circle IDs before deduplication:', allProcessedCircles.map(c => c.id));
      
      // Implement robust deduplication using Map to ensure no duplicates
      const uniqueCirclesMap = new Map<string, Circle>();
      
      allProcessedCircles.forEach(circle => {
        const existingCircle = uniqueCirclesMap.get(circle.id);
        
        if (!existingCircle) {
          // First time seeing this circle, add it
          uniqueCirclesMap.set(circle.id, circle);
        } else {
          // Circle already exists, prioritize admin status
          if (circle.isAdmin && !existingCircle.isAdmin) {
            // Replace member status with admin status
            uniqueCirclesMap.set(circle.id, { ...circle, isAdmin: true });
          }
          // If both are admin or both are member, keep the existing one
        }
      });
      
      // Convert to final array with no duplicates
      const freshCirclesArray = Array.from(uniqueCirclesMap.values());
      
      console.log(`Final circles array after deduplication: ${freshCirclesArray.length} circles`);
      console.log('Final circle IDs:', freshCirclesArray.map(c => c.id));

      // Always update the circles state with fresh data and cache it
      setCircles(freshCirclesArray);
      setCacheItem(cacheKey, freshCirclesArray);
      
      // Store admin circle IDs in localStorage for use by the Navbar component
      const adminCircleIds = freshCirclesArray
        .filter(circle => circle.isAdmin)
        .map(circle => circle.id);
        
      console.log('Storing admin circle IDs in localStorage:', adminCircleIds);
      localStorage.setItem('adminCircles', JSON.stringify(adminCircleIds));
      
      // Update progress to completed
      setLoadingProgress({ stage: 'completed', current: 3, total: 3, message: `Successfully loaded ${freshCirclesArray.length} circles` });
      
      // If this was a background refresh, show a subtle notification
      if (isBackgroundRefreshing) {
        toast.success(`${freshCirclesArray.length} circles updated`, { duration: 2000 });
      }
    } catch (error) {
      console.error('Error fetching circles:', error);
      
      // Enhanced error categorization and user feedback
      let errorType: 'network_mismatch' | 'connection_failed' | 'service_unavailable' = 'connection_failed';
      let userMessage = 'Failed to fetch circles. Please check your connection and try again.';
      let canRetry = true;
      
      if (error instanceof Error) {
        if (error.message.includes('Invalid network configuration')) {
          errorType = 'service_unavailable';
          userMessage = 'Network configuration error. Please refresh the page to reinitialize network settings.';
          canRetry = true;
        } else if (error.message.includes('Network mismatch') || error.message.includes('not found')) {
          errorType = 'network_mismatch';
          userMessage = `Some circles may not be available on ${getCurrentNetwork()} network. Try switching networks or refreshing.`;
          canRetry = true;
        } else if (error.message.includes('Circuit breaker open') || error.message.includes('Service temporarily unavailable')) {
          errorType = 'service_unavailable';
          userMessage = 'Service is temporarily unavailable due to high load. Please wait a moment and try again.';
          canRetry = true;
        } else if (error.message.includes('Failed to fetch') || error.message.includes('NetworkError') || error.message.includes('fetch')) {
          errorType = 'connection_failed';
          userMessage = 'Connection failed. This might be due to network configuration or connectivity issues. Please check your internet connection and try again.';
          canRetry = true;
        } else if (error.message.includes('timeout')) {
          errorType = 'connection_failed';
          userMessage = 'Request timeout. The network might be slow, please try again.';
          canRetry = true;
        } else {
          userMessage = `Error fetching circles: ${error.message}`;
        }
      } else {
        userMessage = 'An unexpected error occurred while fetching circles. Please try again later.';
      }
      
      const currentRetryCount = networkError.retryCount;
      setNetworkError({
        type: errorType,
        message: userMessage,
        canRetry,
        retryCount: currentRetryCount + 1
      });
      
      setError(userMessage);
      
      // If fetch fails but we have cached circles, keep them and show appropriate messaging
      if (circles.length > 0) {
        console.log('Keeping cached circles due to network error');
        if (errorType === 'network_mismatch') {
          toast(`⚠️ Showing cached circles. ${userMessage}`, { duration: 4000, icon: '⚠️' });
        } else {
          toast.error('Failed to refresh circles, showing cached data', { duration: 3000 });
        }
      } else {
        // No cached data, show error toast
        if (currentRetryCount < 3) {
          toast.error(userMessage, { duration: 4000 });
        } else {
          toast.error('Multiple failures detected. Please refresh the page.', { duration: 6000 });
        }
      }
    } finally {
      setLoading(false);
      setIsBackgroundRefreshing(false);
    }
  }, [userAddress, isBackgroundRefreshing, getAllUserAddresses, queryUserCircleEventsFromTransactions]); // Updated dependencies

  // Network switching function
  const switchNetwork = useCallback((newNetwork: 'testnet' | 'mainnet') => {
    const networkName = newNetwork === 'testnet' ? 'Testnet' : 'Mainnet';
    
    // Show confirmation modal for network switch
    setConfirmModalProps({
      title: `Switch to ${networkName}?`,
      message: (
        <div className="space-y-3">
          <p>Switching networks will:</p>
          <ul className="list-disc list-inside space-y-1 text-sm text-gray-600">
            <li>Generate a different wallet address for the same account</li>
            <li>Clear your current session and require re-authentication</li>
            <li>Show circles and balances from the selected network only</li>
          </ul>
          <p className="text-sm text-amber-600 font-medium">
            ⚠️ Your wallet address will be different on {networkName.toLowerCase()}
          </p>
        </div>
      ),
      onConfirm: () => {
        // Update centralized network configuration
        setCurrentNetwork(newNetwork);
        
        // Update local state
        setNetwork(newNetwork);
        setRpcUrl(getCurrentRpcUrl());
        setPackageId(getCurrentPackageId());
        
        // Persist network choice
        if (typeof window !== 'undefined') {
          localStorage.setItem('sui-network', newNetwork);
        }
        
        // Show appropriate banner based on network
        setShowTestnetBanner(newNetwork === 'testnet');
        
        // Atomic cache clearing for network switch
        if (typeof window !== 'undefined') {
          console.log(`🔄 Performing atomic cache clear for network switch: ${network} → ${newNetwork}`);
          const startTime = Date.now();
          
          // Clear ALL njangi-related cache (more comprehensive)
          const keysToRemove: string[] = [];
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && (
              key.startsWith('njangi_cache_') ||
              key.includes('zklogin') || 
              key.includes('enoki') ||
              key.includes('circle_') ||
              key.includes('transaction_') ||
              key.includes('wallet_')
            )) {
              keysToRemove.push(key);
            }
          }
          
          // Atomic removal
          keysToRemove.forEach(key => localStorage.removeItem(key));
          
          // Clean up any remaining stale cache
          clearStaleCache();
          
          const clearTime = Date.now() - startTime;
          console.log(`✅ Atomic cache clear completed: ${keysToRemove.length} items removed in ${clearTime}ms`);
        }
        
        // Reset all user state
        setCircles([]);
        setBalance('0');
        setAllCoins([]);
        setLoading(true);
        
        // Force page reload to re-initialize with new network
        // This ensures clean state and proper Enoki re-initialization
        toast.success(`Switching to ${networkName}...`, { duration: 2000 });
        setTimeout(() => {
          window.location.reload();
        }, 1000);
      },
      confirmText: `Switch to ${networkName}`,
      confirmButtonVariant: 'warning'
    });
    setIsConfirmModalOpen(true);
  }, [userAddress, setConfirmModalProps, setIsConfirmModalOpen]);

  // Enhanced utility function to sort circles chronologically (newest to oldest)
  const getSortedCircles = useCallback((circleList: Circle[]) => {
    const sorted = [...circleList].sort((a, b) => {
      // Priority 1: Use creation timestamp if available (most accurate)
      const createdAtA = a.createdAt || 0;
      const createdAtB = b.createdAt || 0;
      
      if (createdAtA && createdAtB) {
        return createdAtB - createdAtA; // Newest first (descending order)
      }
      
      // Priority 2: If one has creation timestamp and other doesn't, prioritize the one with timestamp
      if (createdAtA && !createdAtB) return -1; // a comes first
      if (!createdAtA && createdAtB) return 1;  // b comes first
      
      // Priority 3: Fallback to nextPayoutTime as proxy for creation order
      const timeA = a.nextPayoutTime || 0;
      const timeB = b.nextPayoutTime || 0;
      
      if (timeA !== timeB) {
        return timeB - timeA; // Newest first (descending order)
      }
      
      // Priority 4: Final fallback to alphabetical by name for consistency
      return a.name.localeCompare(b.name);
    });

    return circleSortOrder === 'oldest' ? sorted.reverse() : sorted;
  }, [circleSortOrder]);
  // Utility function to get paginated circles
  const getPaginatedCircles = useCallback((circleList: Circle[], count: number) => {
    const sortedCircles = getSortedCircles(circleList);
    return sortedCircles.slice(0, count);
  }, [getSortedCircles]);
  // Simplified function to load more circles - just increase display count or fetch if needed
  const loadMoreCircles = useCallback(async () => {
    if (isLoadingMore) return; // Prevent multiple simultaneous loads

    const totalCircles = getSortedCircles(circles).length;

    // If we have more circles in memory, just show more of them
    if (displayedCirclesCount < totalCircles) {
      const newDisplayCount = Math.min(displayedCirclesCount + LOAD_MORE_SIZE, totalCircles);
      setDisplayedCirclesCount(newDisplayCount);
      toast.success(`Showing ${LOAD_MORE_SIZE} more circles`, {
        duration: 2000,
        position: 'bottom-right'
      });
      return;
    }

    // Otherwise, check if we can fetch more from server
    if (!paginationState.hasMoreAdmin && !paginationState.hasMoreMember) {
      toast('No more circles to load', {
        duration: 2000,
        position: 'bottom-right'
      });
      return;
    }

    setIsLoadingMore(true);
    console.log('📖 Loading more circles from server...');

    try {
      const currentPackageId = getCurrentPackageId();
      // Use official Sui RPC for loading more circles to avoid rate limits
      const client = getSuiClientFromPool(getRpcCandidateUrls(getCurrentNetwork())[0]);

      // Load more circles using cursors
      const moreResults = await queryMoreUserCircles(
        client,
        userAddress!,
        currentPackageId,
        paginationState.adminCursor,
        paginationState.memberCursor,
        LOAD_MORE_SIZE
      );

      if (moreResults.circles.length > 0) {
        console.log(`📖 Found ${moreResults.circles.length} more circles from server`);

        // Process new circles (simplified - just get the basic info)
        const processedNewCircles: Circle[] = [];

        for (const event of moreResults.circles) {
          try {
            const eventType = event.type;
            let eventData: CircleCreatedEvent | MemberJoinedEvent;

            if (eventType && eventType.includes('CircleCreated')) {
              eventData = event.parsedJson as CircleCreatedEvent;
            } else if (eventType && eventType.includes('MemberJoined')) {
              eventData = event.parsedJson as MemberJoinedEvent;
            } else {
              continue;
            }

            if (eventData.circle_id) {
              // Get circle object
              const circleResponse = await client.getObject({
                id: eventData.circle_id,
                options: {
                  showContent: true,
                  showType: true
                }
              });

              if (circleResponse.data) {
                const processedCircle = await processCircleObject(
                  circleResponse as EnhancedObjectData,
                  userAddress!,
                  eventType.includes('CircleCreated') ? eventData as CircleCreatedEvent : undefined,
                  client,
                  event.timestampMs ? Number(event.timestampMs) : undefined,
                  event.id?.txDigest
                );

                if (processedCircle) {
                  processedNewCircles.push(processedCircle);
                }
              }
            }
          } catch (error) {
            console.error('Error processing new circle:', error);
            // Continue with other circles
          }
        }

        // Update state with new circles
        setCircles(prev => [...prev, ...processedNewCircles]);
        setDisplayedCirclesCount(prev => prev + processedNewCircles.length);

        // Update pagination state
        setPaginationState({
          adminCursor: moreResults.adminCursor,
          memberCursor: moreResults.memberCursor,
          hasMoreAdmin: moreResults.hasMoreAdmin,
          hasMoreMember: moreResults.hasMoreMember,
          totalFetched: paginationState.totalFetched + moreResults.circles.length
        });

        toast.success(`Loaded ${processedNewCircles.length} more circles`, {
          duration: 2000,
          position: 'bottom-right'
        });
      } else {
        toast('No more circles to load', {
          duration: 2000,
          position: 'bottom-right'
        });
      }

    } catch (error) {
      console.error('Error loading more circles:', error);
      toast.error('Failed to load more circles', {
        duration: 3000,
        position: 'bottom-right'
      });
    } finally {
      setIsLoadingMore(false);
    }
  }, [isLoadingMore, circles, displayedCirclesCount, paginationState, userAddress, LOAD_MORE_SIZE, getSortedCircles]);

  // Reset displayed count when circles change (after refresh)
  useEffect(() => {
    setDisplayedCirclesCount(3); // Reset to initial value
  }, [circles.length]);

  // Enhanced useEffect to handle initial load and cache validation
  useEffect(() => {
    if (!userAddress) return;
    
    // Ensure network configuration is properly initialized before fetching
    const currentRpcUrl = getCurrentRpcUrl();
    const currentPackageId = getCurrentPackageId();
    const currentNetwork = getCurrentNetwork();
    
    if (!currentRpcUrl || !currentPackageId) {
      console.log('⏳ Network configuration not ready, waiting...', { 
        currentNetwork, 
        currentRpcUrl: currentRpcUrl || 'MISSING', 
        currentPackageId: currentPackageId || 'MISSING' 
      });
      return;
    }
    
    console.log('✅ Network configuration ready, proceeding with circle fetch...', { 
      currentNetwork, 
      currentRpcUrl, 
      currentPackageId 
    });
    
    // Check if we're coming from create-circle page
    const shouldForceRefresh = router.query.refreshCircles === 'true';
    if (shouldForceRefresh) {
      // Clear URL parameter to avoid repeated refreshes
      router.replace('/dashboard', undefined, { shallow: true });
      
      // Force refresh with a small delay to ensure blockchain processing
      console.log('Detected redirect from create-circle, forcing refresh with delay...');
      setTimeout(() => {
        fetchUserCircles(true);
      }, 2000);
      return;
    }
    
    const cacheKey = getCacheKey(userAddress, 'circles');
    const hasCachedData = circles.length > 0;
    const cacheStale = isCacheStale(cacheKey, CACHE_CONFIG.CIRCLES_TTL);
    
    console.log('Cache check:', { 
      userAddress: userAddress.slice(0, 6) + '...', 
      hasCachedData, 
      cacheStale,
      circlesLength: circles.length 
    });
    
    // If we have cached data and it's fresh, don't fetch
    if (hasCachedData && !cacheStale) {
      console.log('Using fresh cached data, skipping fetch');
      setLoading(false);
      return;
    }
    
    // Only fetch if we don't have cached data or cache is stale
    console.log('Cache miss or stale, fetching circles...');
    fetchUserCircles(false);
  }, [userAddress, router, rpcUrl, packageId]); // Added network config dependencies

  useEffect(() => {
    if (!router.isReady || !userAddress) {
      return;
    }

    const parsedResult = parseOnrampResultFromQuery(
      router.query as Record<string, string | string[] | undefined>,
    );
    if (!parsedResult.hasOnrampParams || parsedResult.provider !== 'coinbase') {
      return;
    }

    const updateFromOnrampResult = async () => {
      setOnrampResultStatus(parsedResult.status);

      if (parsedResult.status === 'success') {
        toast.success('Coinbase purchase confirmed. Refreshing wallet balances...');
      } else if (parsedResult.status === 'pending') {
        toast('Coinbase purchase is pending. Checking your balances...', {
          icon: '⏳',
        });
      } else if (parsedResult.status === 'cancelled') {
        toast.error('Coinbase purchase was cancelled.');
      } else if (parsedResult.status === 'failed') {
        toast.error('Coinbase purchase failed.');
      }

      const shouldRefreshBalances =
        parsedResult.status === 'success' || parsedResult.status === 'pending';
      const txSuffix = parsedResult.transactionId
        ? ` Transaction: ${parsedResult.transactionId}.`
        : '';

      if (shouldRefreshBalances) {
        setIsOnrampResultRefreshing(true);
        try {
          clearWalletBalanceCache(userAddress);
          await refreshWalletBalances(userAddress, {
            forceRefresh: true,
            network: getCurrentNetwork(),
          });
          const didRefresh = await fetchBalance();
          if (!didRefresh) {
            throw new Error('Failed to load refreshed wallet balances.');
          }

          if (parsedResult.status === 'success') {
            setOnrampResultMessage(
              `Coinbase purchase completed and balances refreshed.${txSuffix}`,
            );
          } else {
            setOnrampResultMessage(
              `Coinbase purchase is pending. Latest balances loaded.${txSuffix}`,
            );
          }
        } catch (error) {
          console.error('Failed to refresh balances after Coinbase callback:', error);
          setOnrampResultMessage(
            `Coinbase update received, but balance refresh failed.${txSuffix}`,
          );
          toast.error('Could not refresh balances automatically. Try manual refresh.');
        } finally {
          setIsOnrampResultRefreshing(false);
        }
      } else if (parsedResult.status === 'cancelled') {
        setOnrampResultMessage('Coinbase purchase was cancelled before completion.');
      } else if (parsedResult.status === 'failed') {
        setOnrampResultMessage('Coinbase purchase failed. Please retry.');
      } else {
        setOnrampResultMessage('Coinbase update received.');
      }

      const nextQuery = stripOnrampQueryParams(
        router.query as Record<string, string | string[] | undefined>,
      );
      router.replace(
        {
          pathname: router.pathname,
          query: nextQuery,
        },
        undefined,
        { shallow: true },
      );
    };

    updateFromOnrampResult();
  }, [router.isReady, router.query, router.pathname, userAddress, fetchBalance]);

  // Add manual refresh function
  const handleManualRefresh = useCallback(() => {
    if (userAddress) {
      // Clear cache and force refresh
      clearUserCache(userAddress);
      fetchUserCircles(true);
      toast.success('Refreshing circles...', { duration: 2000 });
    }
  }, [userAddress, fetchUserCircles]);

  // Cache invalidation when user creates/joins circles
  const invalidateCirclesCache = useCallback(() => {
    if (userAddress) {
      console.log('🗑️ Invalidating all circle-related caches');
      
      // Clear main circles cache
      const cacheKey = getCacheKey(userAddress, 'circles');
      localStorage.removeItem(cacheKey);
      
      // Clear all circle-related caches comprehensively
      const keysToRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.includes(userAddress)) {
          // Clear any cache that contains this user's address and is circle-related
          if (key.includes('circles') || 
              key.includes('events') || 
              key.includes('wallet') || 
              key.includes('circleObject') || 
              key.includes('walletTransactions') ||
              key.includes('packageIds') ||
              key.includes('memberJoinedEvents') ||
              key.includes('transaction')) {
            keysToRemove.push(key);
          }
        }
      }
      
      // Remove all identified cache keys
      keysToRemove.forEach(key => {
        localStorage.removeItem(key);
        console.log(`🗑️ Removed cache key: ${key}`);
      });
      
      console.log(`🗑️ Invalidated ${keysToRemove.length} cache entries`);
    }
  }, [userAddress]);

  // Cache invalidation for a specific circle (more efficient than clearing all)
  const invalidateSpecificCircleCache = useCallback((circleId: string) => {
    if (userAddress) {
      console.log(`🗑️ Invalidating cache for specific circle: ${circleId}`);
      
      const keysToRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.includes(userAddress) && key.includes(circleId)) {
          keysToRemove.push(key);
        }
      }
      
      // Also clear main circles cache since it contains this circle
      const mainCacheKey = getCacheKey(userAddress, 'circles');
      keysToRemove.push(mainCacheKey);
      
      // Remove all identified cache keys
      keysToRemove.forEach(key => {
        localStorage.removeItem(key);
        console.log(`🗑️ Removed cache key for deleted circle: ${key}`);
      });
      
      console.log(`🗑️ Invalidated ${keysToRemove.length} cache entries for circle ${circleId}`);
    }
  }, [userAddress]);

  // Check which circles can be deleted - only for admin circles
  useEffect(() => {
    const checkDeleteableCircles = async () => {
      if (!userAddress || circles.length === 0) return;
      
      try {
        const deleteable = new Set<string>();
        
        // For each circle where user is admin, check if it can be deleted
        for (const circle of circles.filter(c => c.isAdmin)) {
          try {
            // For simplicity, we'll check if it meets the basic criteria:
            // 1. Is admin
            // 2. Has 0 or 1 members (only admin)
            if (circle.currentMembers <= 1) {
              deleteable.add(circle.id);
            }
          } catch (error) {
            console.error(`Error checking if circle ${circle.id} can be deleted:`, error);
          }
        }
        
        setDeleteableCircles(deleteable);
      } catch (error) {
        console.error('Error checking deleteable circles:', error);
      }
    };
    
    checkDeleteableCircles();
  }, [circles, userAddress]);
  
  // Check for wallet availability on component mount
  useEffect(() => {
    const checkWalletAvailability = async () => {
      // If using zkLogin, we don't need to check for wallet availability
      if (isAuthenticated && account) {
        console.log("Using zkLogin authentication, skipping wallet check");
        return;
      }

      // Check for wallet extensions
      const hasWallet = !!(
        window.suiWallet || 
        window.sui || 
        window.suix || 
        window.ethos || 
        window.suiet || 
        window.martian
      );
      
      if (!hasWallet) {
        console.log("No wallet extension detected");
        // We're primarily using zkLogin, so no need to show error about wallet extensions
        // Users will be directed to zkLogin flow instead
      }
    };
    
    checkWalletAvailability();
  }, [isAuthenticated, account]);

  // --- Updated deleteCircleWithZkLogin to handle wallet balance errors ---
  const deleteCircleWithZkLogin = async (circleId: string) => {
    // The actual deletion logic, to be called by the modal
    const performDeletion = async () => {
      try {
        console.log("Deleting circle with zkLogin:", circleId);
        setIsDeleting(circleId); // Keep track of which circle is being deleted

        // Find the circle to get its wallet ID and package ID
        const circle = circles.find(c => c.id === circleId);
        const walletId = circle?.walletId;
        const circlePackageId = circle?.packageId; // Get the package ID this circle was created with
        
        console.log("🔍 DELETE DIAGNOSTICS:");
        console.log("  Circle to delete:", circle);
        console.log("  Circle ID:", circleId);
        console.log("  Wallet ID:", walletId);
        console.log("  Circle Package ID:", circlePackageId);
        console.log("  Circle object keys:", circle ? Object.keys(circle) : 'circle not found');
        
        if (!circlePackageId) {
          console.warn("⚠️ WARNING: Circle package ID not found! This circle was loaded before the package ID extraction was implemented.");
          console.warn("   Please refresh the page to reload circles with package IDs.");
          
          // Show a helpful error to the user
          toast.error('Please refresh the page before deleting this circle. The system has been updated to handle package upgrades.');
          setIsDeleting(null);
          return;
        }

        // Use the AuthContext's deleteCircle method with circle-specific package ID
        const result = await authDeleteCircle(circleId, walletId, circlePackageId);
        
        // Check if deletion succeeded
        if (result.success) {
          console.log("Delete successful with digest:", result.digest);
          
          // Invalidate cache for this specific circle and refresh general cache
          invalidateSpecificCircleCache(circleId);
          
          // Update the UI immediately
          setCircles(prevCircles => prevCircles.filter(c => c.id !== circleId));
          
          // Fetch fresh data from blockchain to ensure consistency
          console.log("🔄 Fetching fresh circles data after deletion");
          setTimeout(() => {
            fetchUserCircles(true); // Force refresh from blockchain
          }, 1000); // Small delay to allow deletion to propagate
          
          toast.success("Circle has been deleted.");
        } else {
          // Handle wallet balance errors gracefully
          if (result.errorType === 'WALLET_HAS_BALANCE') {
            console.log("Circle has funds, cannot delete:", result.error);
            
            // Show a user-friendly modal instead of a toast
            setConfirmModalProps({
              title: "Cannot Delete Circle",
              message: "This circle cannot be deleted because it still has funds in its wallet. Please withdraw all funds first, then try deleting the circle again.",
              confirmText: "OK",
              confirmButtonVariant: "warning",
              onConfirm: () => setIsConfirmModalOpen(false)
            });
            setIsConfirmModalOpen(true);
          } else if (result.errorType === 'OBJECT_ALREADY_DELETED') {
            console.log("Circle already deleted:", result.error);
            
            // Remove the circle from UI since it's already deleted
            setCircles(prevCircles => prevCircles.filter(c => c.id !== circleId));
            
            // Invalidate cache to ensure fresh data on next load
            invalidateCirclesCache();
            
            // Show informational message
            toast.success("Circle has already been deleted. Updated the view.");
          } else {
            // Handle other types of failures
            toast.error(result.error || "Failed to delete circle");
          }
        }
        
        setIsDeleting(""); // Clear deleting status
      } catch (error) {
        console.error("Error deleting circle:", error);
        setIsDeleting(""); // Clear deleting status
        
        // Generic error handling for other cases
        setConfirmModalProps({
          title: "Error Deleting Circle",
          message: error instanceof Error ? error.message : "Failed to delete circle",
          confirmText: "OK",
          confirmButtonVariant: "danger",
          onConfirm: () => setIsConfirmModalOpen(false)
        });
        setIsConfirmModalOpen(true);
      }
    };

    // First check if we know the circle has a wallet with funds before attempting deletion
    try {
      // Get the wallet ID for the circle
      const circle = circles.find(c => c.id === circleId);
      const walletId = circle?.walletId;
      
      if (!walletId) {
        // Proceed with regular deletion confirmation if we don't know the wallet ID
        // Show confirmation dialog
        setIsConfirmModalOpen(true);
        setConfirmModalProps({
          title: "Delete Circle",
          message: "Are you sure you want to delete this circle? This action cannot be undone.",
          confirmText: "Delete",
          confirmButtonVariant: "danger",
          onConfirm: performDeletion
        });
        return;
      }
      
      // If we have a wallet ID, check if this circle was previously determined to be deletable
      if (deleteableCircles.has(circleId)) {
        // Show confirmation dialog
        setIsConfirmModalOpen(true);
        setConfirmModalProps({
          title: "Delete Circle",
          message: "Are you sure you want to delete this circle? This action cannot be undone.",
          confirmText: "Delete",
          confirmButtonVariant: "danger",
          onConfirm: performDeletion
        });
      } else {
        // If it's not in deleteableCircles, it might have funds - proceed with caution
        setIsConfirmModalOpen(true);
        setConfirmModalProps({
          title: "Delete Circle",
          message: "Are you sure you want to delete this circle? This action cannot be undone. Note that you'll need to withdraw any funds before it can be deleted.",
          confirmText: "Delete",
          confirmButtonVariant: "danger",
          onConfirm: performDeletion
        });
      }
    } catch (error) {
      console.error("Error checking circle status:", error);
      // Fallback to standard confirmation
      setIsConfirmModalOpen(true);
      setConfirmModalProps({
        title: "Delete Circle",
        message: "Are you sure you want to delete this circle? This action cannot be undone.",
        confirmText: "Delete",
        confirmButtonVariant: "danger",
        onConfirm: performDeletion
      });
    }
  };
  
  // --- Add function to withdraw funds from circle wallet ---
  const withdrawFunds = async (walletId: string) => {
    if (!walletId) {
      toast.error("Wallet ID is required to withdraw funds");
      return;
    }
    
    try {
      setIsDeleting(walletId); // Keep track of which wallet is being processed
      
      // Call API to withdraw funds and await the result
      const result = await authDeleteCircle(walletId);
      
      if (result.success) {
        toast.success("Funds have been withdrawn to your wallet");

        invalidateCirclesCache();
        if (userAddress) {
          clearWalletBalanceCache(userAddress);
        }
        await fetchBalance();
        fetchUserCircles(true);
      } else {
        toast.error(result.error || "Failed to withdraw funds");
      }
    } catch (error) {
      console.error("Error withdrawing funds:", error);
      
      toast.error(error instanceof Error ? error.message : "Failed to withdraw funds");
    } finally {
      setIsDeleting(""); // Clear processing status
    }
  };
  // --- Updated deleteCircle (non-zkLogin) to use the modal ---
  const deleteCircle = async (circleId: string) => {
    console.log("deleteCircle function called with circleId:", circleId);

    // The actual deletion logic (for wallet extension), to be called by the modal
    const performWalletDeletion = async () => {
      // Check for wallet availability - expanded to check multiple wallet objects
      const walletDetectionDetails = {
        suiWallet: !!window.suiWallet,
        sui: !!window.sui,
        suix: !!window.suix,
        ethos: !!window.ethos,
        suiet: !!window.suiet,
        martian: !!window.martian
      };
      console.log("Wallet detection results:", walletDetectionDetails);
      
      // Try to find an available wallet
      let wallet = null;
      if (window.suiWallet) wallet = window.suiWallet;
      else if (window.sui) wallet = window.sui;
      else if (window.suix) wallet = window.suix;
      else if (window.ethos) wallet = window.ethos;
      else if (window.suiet) wallet = window.suiet;
      else if (window.martian) wallet = window.martian;
      
      if (!wallet) {
        console.log("No compatible SUI wallet found");
        toast.error('No wallet detected. Please install a SUI wallet extension.');
        return;
      }
      
      console.log("Available wallet methods:", Object.keys(wallet));
      console.log("Using packageId:", packageId);
      
      setIsDeleting(circleId);
      console.log("Set isDeleting state to:", circleId);
      
      try {
        // Check for wallet features/capabilities
        const hasSignAndExecuteTransactionBlock = typeof wallet.signAndExecuteTransactionBlock === 'function';
        const hasSignTransactionBlock = typeof wallet.signTransactionBlock === 'function';
        const hasSignAndExecuteTransaction = typeof wallet.signAndExecuteTransaction === 'function';
        const hasConstructTransaction = typeof wallet.constructTransaction === 'function';
        const hasSignAndExecuteTransactionV2 = typeof wallet.signAndExecuteTransaction === 'function';
        
        console.log("Wallet capabilities:", {
          signAndExecuteTransactionBlock: hasSignAndExecuteTransactionBlock,
          signTransactionBlock: hasSignTransactionBlock,
          signAndExecuteTransaction: hasSignAndExecuteTransaction,
          constructTransaction: hasConstructTransaction,
          signAndExecuteTransactionV2: hasSignAndExecuteTransactionV2
        });
        
        let result: Record<string, unknown> | null = null;
        
        // Try newer wallet API first (preferred)
        if (hasSignAndExecuteTransactionBlock && wallet.signAndExecuteTransactionBlock) {
          console.log("Using signAndExecuteTransactionBlock API");
          
          // Create a transaction block for the newer API format
          const txb: TransactionBlockPayload = {
            transactionBlock: {
              // Modern format for transaction block
              transactions: [
                {
                  kind: 'MoveCall',
                  target: `${packageId}::njangi_circles::delete_circle`,
                  arguments: [
                    { kind: 'Input', index: 0, type: 'object', value: circleId }
                  ]
                }
              ]
            },
            options: {
              showEffects: true,
              showEvents: true,
            }
          };
          
          console.log("Transaction block created:", txb);
          result = await wallet.signAndExecuteTransactionBlock(txb);
        }
        // Try alternative format for signAndExecuteTransactionBlock
        else if (hasSignAndExecuteTransactionBlock && wallet.signAndExecuteTransactionBlock) {
          console.log("Using alternative signAndExecuteTransactionBlock format");
          
          const txb: TransactionBlockPayload = {
            transactionBlock: {
              // Alternative format
              moveCall: {
                packageObjectId: packageId,
                module: 'njangi_circle',
                function: 'delete_circle',
                typeArguments: [],
                arguments: [circleId]
              }
            },
            options: {
              showEffects: true,
              showEvents: true,
            }
          };
          
          console.log("Transaction block created (alternative format):", txb);
          result = await wallet.signAndExecuteTransactionBlock(txb);
        }
        // Fall back to older wallet API
        else if (hasConstructTransaction && hasSignAndExecuteTransaction && 
                 wallet.constructTransaction && wallet.signAndExecuteTransaction) {
          console.log("Using legacy transaction flow");
          const transaction = wallet.constructTransaction({
            kind: 'moveCall',
            data: {
              packageObjectId: packageId,
              module: 'njangi_circle',
              function: 'delete_circle',
              typeArguments: [],
              arguments: [circleId],
              gasBudget: 10000000,
            }
          });
          
          console.log("Transaction constructed:", transaction);
          result = await wallet.signAndExecuteTransaction({
            transaction: transaction,
          });
        }
        else {
          console.error("No compatible wallet API methods found");
          toast.error('Your wallet does not support the required transaction methods.');
          setIsDeleting(null);
          return;
        }

        console.log("Transaction execution result:", result);
        
        if (result) {
          toast.success('Circle deleted successfully');
          // Update the UI - remove the deleted circle
          setCircles(prevCircles => prevCircles.filter(c => c.id !== circleId));
          setDeleteableCircles(prev => {
            const updated = new Set(prev);
            updated.delete(circleId);
            return updated;
          });
        }
      } catch (error) {
        console.error('Error deleting circle with wallet:', error);
        // Show error toast with appropriate message
        if (error instanceof Error) {
          if (error.message.includes('ECircleHasActiveMembers')) {
            toast.error('Cannot delete: Circle has active members');
          } else if (error.message.includes('ECircleHasContributions')) {
            toast.error('Cannot delete: Circle has received contributions');
          } else {
            toast.error('Error deleting circle: ' + error.message);
          }
        } else {
          toast.error('Error deleting circle');
        }
      } finally {
        setIsDeleting(null);
      }
    };

    // Check if using zkLogin authentication
    if (isAuthenticated && account) {
      console.log("Using zkLogin authentication for deletion");
      // Call the zkLogin version which will handle the modal opening
      deleteCircleWithZkLogin(circleId);
    } else {
      // If using wallet extension, open the modal directly
      const circleToDelete = circles.find(c => c.id === circleId);
      setConfirmModalProps({
        title: `Delete Circle: ${circleToDelete?.name || 'Unknown'}`,
        message: "Are you absolutely sure you want to delete this circle? This action cannot be undone.",
        onConfirm: performWalletDeletion,
        confirmText: 'Delete Circle',
        confirmButtonVariant: 'danger',
      });
      setIsConfirmModalOpen(true);
    }
  };

  const shortenAddress = (address: string | null | undefined) => {
    if (!address) return '';
    return `${address.slice(0, 6)}...${address.slice(-6)}`;
  };

  const copyToClipboard = async (text: string | null, type: 'address' | 'circleId' = 'address') => {
    if (!text) return;
    
    try {
      await navigator.clipboard.writeText(text);
      
      if (type === 'address') {
        setShowToast(true);
        setTimeout(() => setShowToast(false), 2000);
      } else if (type === 'circleId') {
        setCopiedCircleId(text);
        toast.success('Circle ID copied to clipboard!');
        setTimeout(() => setCopiedCircleId(null), 2000);
      }
    } catch (err) {
      console.error(`Failed to copy ${type}:`, err);
      toast.error(`Failed to copy ${type === 'address' ? 'address' : 'circle ID'}`);
    }
  };

  const copyShareLink = async (circleId: string) => {
    try {
      const shareLink = `${window.location.origin}/circle/${circleId}/join`;
      await navigator.clipboard.writeText(shareLink);
      toast.success('Invite link copied to clipboard!');
    } catch (err) {
      console.error('Failed to copy share link:', err);
      toast.error('Failed to copy invite link');
    }
  };

  // Format cycle lengths and days for display
  const formatCycleInfo = (cycleLength: number, cycleDay: number) => {
    // Log the input values for debugging
    console.log('[formatCycleInfo] Received:', { cycleLength, cycleDay });
    
    // Cycle length: 0 = weekly, 1 = monthly, 2 = quarterly, 3 = bi-weekly
    let cyclePeriod = '';
    let dayFormat = '';
    
    // Validate inputs to avoid errors
    const validCycleLength = typeof cycleLength === 'number' ? cycleLength : 0;
    let validCycleDay = typeof cycleDay === 'number' ? cycleDay : 0;
    
    // Prepare weekdays array used in multiple cases
    const weekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

    // Ensure cycle day is in valid range based on the *actual* cycle length rules
    if ((validCycleLength === 0 || validCycleLength === 3) && validCycleDay > 6) validCycleDay = 0; // Weekly/Bi-Weekly (0-6)
    if ((validCycleLength === 1 || validCycleLength === 2) && (validCycleDay <= 0 || validCycleDay > 28)) validCycleDay = 1; // Monthly/Quarterly (1-28)
    
    switch (validCycleLength) {
      case 0: // Weekly
        cyclePeriod = 'Weekly';
        // For weekly, cycleDay is 0-6
        dayFormat = weekdays[validCycleDay] || weekdays[0]; // Default to Monday if out of range
        break;
      case 3: // Bi-Weekly (NEW)
        cyclePeriod = 'Bi-Weekly';
        // For bi-weekly, cycleDay is 0-6 (like weekly)
        dayFormat = weekdays[validCycleDay] || weekdays[0]; // Default to Monday if out of range
        break;
      case 1: // Monthly
        cyclePeriod = 'Monthly';
        // Ensure we have a valid day (1-28)
        dayFormat = getOrdinalSuffix(validCycleDay);
        break;
      case 2: // Quarterly
        cyclePeriod = 'Quarterly';
        // Ensure we have a valid day (1-28)
        dayFormat = getOrdinalSuffix(validCycleDay);
        break;
      default:
        cyclePeriod = 'Unknown';
        dayFormat = `Day ${validCycleDay === 0 ? 1 : validCycleDay}`;
    }
    
    return `${cyclePeriod} (${dayFormat})`;
  };
  // Helper to format dates with ordinal suffix
  const getOrdinalSuffix = (day: number) => {
    const suffixes = ['th', 'st', 'nd', 'rd'];
    const relevantDigits = (day % 100);
    
    // Special case for 11, 12, 13
    if (relevantDigits >= 11 && relevantDigits <= 13) {
      return `${day}th day`;
    }
    
    // For other numbers, use last digit
    const lastDigit = day % 10;
    const suffix = lastDigit >= 1 && lastDigit <= 3 ? suffixes[lastDigit] : suffixes[0];
    return `${day}${suffix} day`;
  };

  // Format timestamp to readable date
  const formatDate = (timestamp: number, useLocalTime = false) => {
    if (!timestamp) return 'Not set';
    return new Date(timestamp).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      timeZone: useLocalTime ? undefined : 'UTC' // Use local timezone when requested
    });
  };

  // Format currency value based on currency type
  const formatCurrency = (amount: number, currencyType: string = 'USD') => {
    // Map currency codes to their formatting options
    const currencyFormats: Record<string, { 
      symbol: string; 
      locale: string; 
      code: string; 
      customFormat?: boolean;
      position?: 'before' | 'after';
    }> = {
      'USD': { symbol: '$', locale: 'en-US', code: 'USD' },
      'XAF': { symbol: 'FCFA', locale: 'fr-CM', code: 'XAF', customFormat: true, position: 'after' },
      'NGN': { symbol: '₦', locale: 'en-NG', code: 'NGN' },
      'EUR': { symbol: '€', locale: 'de-DE', code: 'EUR' },
      'GBP': { symbol: '£', locale: 'en-GB', code: 'GBP' },
      'CAD': { symbol: 'C$', locale: 'en-CA', code: 'CAD', customFormat: true, position: 'before' },
      'ZAR': { symbol: 'R', locale: 'en-ZA', code: 'ZAR', customFormat: true, position: 'before' },
      'KES': { symbol: 'KSh', locale: 'en-KE', code: 'KES', customFormat: true, position: 'before' },
      'EGP': { symbol: 'E£', locale: 'en-US', code: 'EGP', customFormat: true, position: 'before' },
      'MAD': { symbol: 'MAD', locale: 'en-US', code: 'MAD', customFormat: true, position: 'before' },
      'GHS': { symbol: 'GH₵', locale: 'en-GH', code: 'GHS', customFormat: true, position: 'before' } // Added GHS
    };

    const format = currencyFormats[currencyType] || currencyFormats['USD'];
    
    // Format the number with proper decimals using a safe locale
    const formattedNumber = new Intl.NumberFormat('en-US', {
      minimumFractionDigits: 0,
      maximumFractionDigits: amount >= 1000 ? 0 : 2,
    }).format(amount);
    
    // For currencies that need custom formatting or have issues with Intl.NumberFormat
    if (format.customFormat) {
      if (format.position === 'after') {
        return `${formattedNumber} ${format.symbol}`;
      } else {
        return `${format.symbol} ${formattedNumber}`;
      }
    }
    
    // For standard currencies, try Intl.NumberFormat with currency style using en-US locale for consistency
    try {
      return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: format.code,
        minimumFractionDigits: 0,
        maximumFractionDigits: amount >= 1000 ? 0 : 2,
      }).format(amount);
    } catch (error) {
      // Fallback for unsupported locales
      console.warn(`Currency formatting failed for ${currencyType}, using fallback`);
      return `${format.symbol}${formattedNumber}`;
    }
  };

  // Currency display component
  const CurrencyDisplay = ({ 
    usd, 
    sui, 
    currencyType = 'USD', 
    className = "",
    respectVisibility = true // New prop to control if this should respect balance visibility
  }: { 
    usd?: number; 
    sui?: number; 
    currencyType?: string;
    className?: string;
    respectVisibility?: boolean; // Optional prop
  }) => {
    const isPriceUnavailable = suiPrice === null;
    
    console.log('CurrencyDisplay inputs:', { usd, sui, currencyType, suiPrice, isPriceUnavailable });
    
    // Debug logging
    if (usd === 0 || sui === 0) {
      console.log('Zero values detected in CurrencyDisplay:', { usd, sui, currencyType });
    }
    
    // Check for invalid inputs and provide defaults
    if ((usd === undefined || isNaN(usd)) && (sui === undefined || isNaN(sui))) {
      console.log('CurrencyDisplay: both usd and sui values are invalid, defaulting to 0');
      usd = 0;
      sui = 0;
    }
    
    // Use the provided values directly instead of converting between them
    // The local currency amount (usd parameter) and SUI amount (sui parameter) 
    // are already stored correctly from the circle creation
    let displayLocalAmount: number | null = null;
    let displaySuiAmount: number | null = null;
    
    if (usd !== undefined && !isNaN(usd)) {
      displayLocalAmount = usd; // This is actually the local currency amount
      console.log('CurrencyDisplay: using provided local currency amount:', { 
        local: displayLocalAmount, 
        currencyType
      });
    }
    
    if (sui !== undefined && !isNaN(sui)) {
      displaySuiAmount = sui; // This is the actual SUI amount stored in the contract
      console.log('CurrencyDisplay: using provided SUI amount:', { 
        sui: displaySuiAmount
      });
    }
    
    // Default values if neither is provided or values are invalid
    if (displayLocalAmount === null || displayLocalAmount === undefined) {
      displayLocalAmount = 0;
    }
    if (displaySuiAmount === null || displaySuiAmount === undefined) {
      displaySuiAmount = 0;
    }
    
    console.log('CurrencyDisplay: final display values:', { 
      local: displayLocalAmount, 
      sui: displaySuiAmount,
      currencyType 
    });
    
    // Special case for zero values - check if this is intentional or missing data
    if (displayLocalAmount === 0 && displaySuiAmount === 0) {
      // Just display as "N/A" or the zero amount in the correct currency
      return (
        <span className={`${className}`}>
          {isPriceUnavailable ? "Data unavailable" : `${formatCurrency(0, currencyType)} (0 SUI)`}
        </span>
      );
    }
    
    // Format SUI with appropriate precision if available
    const formattedSui = displaySuiAmount !== null ? (
      displaySuiAmount >= 1000 
        ? displaySuiAmount.toLocaleString(undefined, { maximumFractionDigits: 0 }) 
        : displaySuiAmount >= 100 
          ? displaySuiAmount.toFixed(1) 
          : displaySuiAmount.toFixed(3) // Show more precision for small amounts
    ) : '—';

    // Check if balance should be hidden
    if (respectVisibility && !balanceVisible) {
      return (
        <span className={`${className} flex items-center`}>
          {formatBalanceDisplay('', false)}
          <span className="text-gray-500 ml-1">({formatBalanceDisplay('', false)} SUI)</span>
        </span>
      );
    }
    
    return (
      <Tooltip.Provider>
        <Tooltip.Root>
          <Tooltip.Trigger asChild>
            <span className={`cursor-help ${className} flex items-center`}>
              {displayLocalAmount !== null ? formatCurrency(displayLocalAmount, currencyType) : `${formatCurrency(0, currencyType)}`}
              <span className="text-gray-500 ml-1">({formattedSui} SUI)</span>
              {isPriceLoading && <RefreshCw size={14} className="animate-spin ml-1 text-blue-500" />}
              {isPriceUnavailable && !isPriceLoading && <AlertCircle size={14} className="ml-1 text-amber-500" />}
            </span>
          </Tooltip.Trigger>
          <Tooltip.Portal>
            <Tooltip.Content
              className="bg-gray-900 text-white px-3 py-2 rounded text-sm"
              sideOffset={5}
            >
              <div className="space-y-1">
                <p>Current SUI Conversion Rate:</p>
                {suiPrice !== null ? (
                  <p>1 SUI = {formatCurrency(suiPrice, 'USD')}</p>
                ) : (
                  <p className="text-amber-400">SUI price unavailable</p>
                )}
                <p className="text-xs text-gray-400">
                  {isPriceLoading
                    ? "Loading latest price data..."
                    : isPriceUnavailable
                      ? "Unable to fetch price data"
                      : "Using latest price from CoinGecko"}
                </p>
                <p className="text-xs text-blue-300">
                  Currency: {currencyType}
                </p>
                <p className="text-xs text-gray-400">
                  Note: SUI amount was calculated at circle creation time
                </p>
              </div>
              <Tooltip.Arrow className="fill-gray-900" />
            </Tooltip.Content>
          </Tooltip.Portal>
        </Tooltip.Root>
      </Tooltip.Provider>
    );
  };

  const handleJoinCircle = (e: React.FormEvent) => {
    e.preventDefault();
    
    // Simple validation - make sure the input isn't empty
    if (!circleIdInput.trim()) {
      toast.error('Please enter a valid circle ID');
      return;
    }
    
    // Extract just the ID if the user pasted the full URL
    let circleId = circleIdInput.trim();
    
    // If the input contains a URL path, extract just the circle ID
    if (circleId.includes('/circle/')) {
      const match = circleId.match(/\/circle\/([^\/]+)/);
      if (match && match[1]) {
        circleId = match[1];
      }
    }
    
    // Navigate to the join page for this circle
    router.push(`/circle/${circleId}/join`);
    
    // Invalidate cache to ensure fresh data when user returns
    invalidateCirclesCache();
    
    // Reset the input and close the dialog
    setCircleIdInput('');
    setIsJoinDialogOpen(false);
  };

  const shortenId = (id: string) => {
    if (!id) return '';
    return `${id.slice(0, 10)}...${id.slice(-6)}`;
  };

  // Fix toast with the wallet balance warning to use proper entity escaping

  // Check if the testnet banner should be shown
  useEffect(() => {
    // Check session storage to see if banner was already dismissed
    const bannerDismissed = sessionStorage.getItem('testnetBannerDismissed');
    if (bannerDismissed === 'true') {
      setShowTestnetBanner(false);
    }
  }, []);

  // Function to dismiss the testnet banner
  const dismissTestnetBanner = () => {
    setShowTestnetBanner(false);
    // Save the dismissal to session storage
    sessionStorage.setItem('testnetBannerDismissed', 'true');
  };

  // Load recent contacts from localStorage
  useEffect(() => {
    try {
      const stored = localStorage.getItem('recentContacts');
      if (stored) {
        const contacts = JSON.parse(stored) as RecentContact[];
        // Sort by frequency and last used, limit to 10
        const sortedContacts = contacts
          .sort((a, b) => b.frequency - a.frequency || b.lastUsed - a.lastUsed)
          .slice(0, 10);
        setRecentContacts(sortedContacts);
      }
    } catch (error) {
      console.error('Error loading recent contacts:', error);
    }
  }, []);

  // Helper function to get decimals based on coin type
  const getCoinDecimals = (coinType: string): number => {
    if (coinType === currentNetworkConfig.coinTypes.SUI) {
      return 1000000000; // 9 decimals
    } else if (coinType === currentNetworkConfig.coinTypes.USDC) {
      return 1000000; // 6 decimals
    } else {
      // Default to 9 decimals for unknown coins
      return 1000000000;
    }
  };

  // Validate SUI address format
  const isValidSuiAddress = (address: string): boolean => {
    if (!address) return false;
    
    // Remove 0x prefix if present
    const cleanAddress = address.startsWith('0x') ? address.slice(2) : address;
    
    // Check if it's a valid hex string of correct length
    const hexRegex = /^[0-9a-fA-F]+$/;
    return hexRegex.test(cleanAddress) && (cleanAddress.length === 64 || cleanAddress.length === 40);
  };

  // Validate transfer form
  const validateTransferForm = (formData: TransferFormData): TransferValidation => {
    const errors: TransferValidation['errors'] = {};
    const warnings: TransferValidation['warnings'] = {};

    // Validate recipient address
    if (!formData.recipientAddress.trim()) {
      errors.recipientAddress = 'Recipient address is required';
    } else if (!isValidSuiAddress(formData.recipientAddress)) {
      errors.recipientAddress = 'Invalid SUI address format';
    } else if (formData.recipientAddress.toLowerCase() === userAddress?.toLowerCase()) {
      errors.recipientAddress = 'Cannot send to your own address';
    }

    // Validate amount
    if (!formData.amount.trim()) {
      errors.amount = 'Amount is required';
    } else {
      const amount = parseFloat(formData.amount);
      if (isNaN(amount) || amount <= 0) {
        errors.amount = 'Amount must be a positive number';
      } else {
        // Check balance
        const selectedCoin = allCoins.find(coin => coin.symbol === formData.selectedToken);
        if (selectedCoin) {
          const decimals = getCoinDecimals(selectedCoin.coinType);
          const availableBalance = Number(selectedCoin.balance) / decimals;
          
          if (amount > availableBalance) {
            errors.balance = `Insufficient balance. Available: ${availableBalance.toFixed(6)} ${formData.selectedToken}`;
          } else if (formData.selectedToken === 'SUI' && amount > availableBalance - 0.01) {
            errors.balance = 'Please leave at least 0.01 SUI for gas fees';
          }

          // High value warning (over $1000 USD equivalent)
          if (formData.selectedToken === 'SUI' && suiPrice && amount * suiPrice > 1000) {
            warnings.highValue = `High value transfer: ~$${(amount * suiPrice).toFixed(2)} USD`;
          } else if (formData.selectedToken === 'USDC' && amount > 1000) {
            warnings.highValue = `High value transfer: $${amount.toFixed(2)} USD`;
          }
        }
      }
    }

    // Check if address is new (not in recent contacts)
    if (formData.recipientAddress && !recentContacts.some(contact => 
      contact.address.toLowerCase() === formData.recipientAddress.toLowerCase()
    )) {
      warnings.newAddress = 'This is a new address. Please double-check before sending.';
    }

    // Network warning (only show for testnet)
    if (getCurrentNetwork() === 'testnet') {
      warnings.testnet = 'You are on Sui Testnet. These are test tokens with no real value.';
    }

    return {
      isValid: Object.keys(errors).length === 0,
      errors,
      warnings
    };
  };

  // Update validation when form changes
  useEffect(() => {
    const validation = validateTransferForm(transferForm);
    setTransferValidation(validation);
  }, [transferForm, allCoins, suiPrice, userAddress, recentContacts]);

  // Handle transfer form submission
  const handleTransferSubmit = async () => {
    if (!transferValidation.isValid || !userAddress) return;

    setIsTransferring(true);
    setTransferStep('confirm');

    try {
      // Prepare transaction data
      const amount = parseFloat(transferForm.amount);
      const selectedCoin = allCoins.find(coin => coin.symbol === transferForm.selectedToken);
      
      if (!selectedCoin) {
        throw new Error('Selected token not found');
      }

      const decimals = getCoinDecimals(selectedCoin.coinType);
      const amountInSmallestUnit = Math.floor(amount * decimals);

      // Normalize recipient address
      let recipientAddress = transferForm.recipientAddress.trim();
      if (!recipientAddress.startsWith('0x')) {
        recipientAddress = '0x' + recipientAddress;
      }

      // Use AuthContext sendTokens method instead of direct API call
      const result = await sendTokens({
        recipientAddress,
        amount: amountInSmallestUnit.toString(),
        coinType: selectedCoin.coinType,
        memo: transferForm.memo || undefined,
      });

      if (result.success) {
        setTransferResult({ digest: result.digest });
        setTransferStep('success');

        // Add to recent contacts
        const newContact: RecentContact = {
          address: recipientAddress,
          lastUsed: Date.now(),
          frequency: 1
        };

        const updatedContacts = [...recentContacts];
        const existingIndex = updatedContacts.findIndex(c => 
          c.address.toLowerCase() === recipientAddress.toLowerCase()
        );

        if (existingIndex >= 0) {
          updatedContacts[existingIndex].frequency += 1;
          updatedContacts[existingIndex].lastUsed = Date.now();
        } else {
          updatedContacts.push(newContact);
        }

        setRecentContacts(updatedContacts.slice(0, 10));
        localStorage.setItem('recentContacts', JSON.stringify(updatedContacts.slice(0, 10)));

        if (userAddress) {
          clearWalletBalanceCache(userAddress);
        }
        await fetchBalance();

        toast.success('Transfer completed successfully!');
      } else {
        throw new Error('Transfer failed');
      }
    } catch (error) {
      console.error('Transfer error:', error);
      setTransferResult({ error: error instanceof Error ? error.message : 'Transfer failed' });
      setTransferStep('form');
      toast.error(error instanceof Error ? error.message : 'Transfer failed');
    } finally {
      setIsTransferring(false);
    }
  };

  // Reset transfer dialog
  const resetTransferDialog = () => {
    setTransferForm({
      recipientAddress: '',
      amount: '',
      selectedToken: 'SUI',
      memo: ''
    });
    setTransferStep('form');
    setTransferResult(null);
    setShowAdvancedOptions(false);
    setIsTransferDialogOpen(false);
  };

  // Percentage-based quick amount options
  const getQuickPercentages = () => {
    return [25, 50, 75];
  };

  // Set percentage amount
  const setPercentageAmount = (percentage: number) => {
    const selectedCoin = allCoins.find(coin => coin.symbol === transferForm.selectedToken);
    if (selectedCoin) {
      const decimals = getCoinDecimals(selectedCoin.coinType);
      let totalBalance = Number(selectedCoin.balance) / decimals;
      
      // Clear any previous gas errors
      setGasError(null);
      
      // Reserve gas for SUI transfers
      if (transferForm.selectedToken === 'SUI') {
        const gasReserve = getCurrentNetwork() === 'mainnet' ? 0.015 : 0.01;
        totalBalance = Math.max(0, totalBalance - gasReserve);
        
        // Check if we have enough balance after gas reserve
        if (totalBalance <= 0) {
          setGasError(`Insufficient SUI balance for gas fees. Need at least ${gasReserve} SUI for transaction fees.`);
          return;
        }
      }
      
      // Calculate percentage amount
      const percentageAmount = (totalBalance * percentage) / 100;
      const roundedAmount = Math.floor(percentageAmount * 1000000) / 1000000;
      
      setTransferForm(prev => ({ ...prev, amount: roundedAmount.toString() }));
    }
  };
  // Set max amount with intelligent gas estimation
  const setMaxAmount = () => {
    const selectedCoin = allCoins.find(coin => coin.symbol === transferForm.selectedToken);
    if (selectedCoin) {
      const decimals = getCoinDecimals(selectedCoin.coinType);
      let maxAmount = Number(selectedCoin.balance) / decimals;
      
      // Clear any previous gas errors
      setGasError(null);
      
      // Reserve gas for SUI transfers with network-aware estimation
      if (transferForm.selectedToken === 'SUI') {
        // Current network gas estimation:
        // - Mainnet: Reserve 0.015 SUI (more conservative for higher fees)
        // - Testnet: Reserve 0.01 SUI (as before)
        const gasReserve = getCurrentNetwork() === 'mainnet' ? 0.015 : 0.01;
        maxAmount = Math.max(0, maxAmount - gasReserve);
        
        // Show custom error for insufficient balance
        if (maxAmount <= 0) {
          setGasError(`Insufficient SUI balance for gas fees. Need at least ${gasReserve} SUI for transaction fees.`);
          return;
        } else if (maxAmount < 0.001) {
          // Set a warning instead of error for very low balance
          setGasError(`Very low balance after gas reserve. ${gasReserve} SUI reserved for transaction fees.`);
        }
      }
      
      // Round to reasonable precision to avoid display issues
      const roundedAmount = Math.floor(maxAmount * 1000000) / 1000000;
      setTransferForm(prev => ({ ...prev, amount: roundedAmount.toString() }));
      
      // Show success message for successful max calculation
      if (transferForm.selectedToken === 'SUI' && maxAmount > 0.001) {
        const gasReserve = getCurrentNetwork() === 'mainnet' ? 0.015 : 0.01;
        toast.success(`Max amount set (${gasReserve} SUI reserved for gas)`, {
          duration: 2000
        });
      }
    }
  };

  const adminCircles = circles.filter((circle) => circle.isAdmin);
  const memberCircles = circles.filter((circle) => !circle.isAdmin);
  const activeCirclesCount = circles.filter((circle) => circle.isActive).length;
  const inactiveCirclesCount = Math.max(0, circles.length - activeCirclesCount);
  const fundedTokens = allCoins.filter((coin) => Number(coin.balance) > 0);
  const networkLabel = network === 'mainnet' ? 'Mainnet' : 'Testnet';
  const walletValueDisplay = balanceVisible
    ? formatCurrency(totalWalletLocalValue, selectedCurrency)
    : formatBalanceDisplay(totalWalletLocalValue, true);
  const walletAddressDisplay = showFullAddress ? userAddress : shortenAddress(userAddress);
  const walletPreviewSymbols = (fundedTokens.length > 0 ? fundedTokens : allCoins)
    .slice(0, 3)
    .map((coin) => coin.symbol)
    .join(', ');
  const walletHoldingsSummary = allCoins.length > 0
    ? `${allCoins.length} asset${allCoins.length === 1 ? '' : 's'} tracked${walletPreviewSymbols ? ` - ${walletPreviewSymbols}` : ''}`
    : 'Holdings will appear after the wallet is funded.';

  const openTransactionHistory = useCallback(() => {
    setIsTransactionHistoryOpen(true);
    void fetchTransactionHistory();
  }, [fetchTransactionHistory]);

  const getCircleListForView = useCallback((viewKey: CircleViewKey) => {
    if (viewKey === 'admin') {
      return adminCircles;
    }
    if (viewKey === 'member') {
      return memberCircles;
    }
    return circles;
  }, [adminCircles, memberCircles, circles]);

  const scrollToCirclePortfolio = useCallback((viewKey: CircleViewKey = 'all') => {
    const nextTabIndex = viewKey === 'admin' ? 1 : viewKey === 'member' ? 2 : 0;
    setCircleViewIndex(nextTabIndex);
    setCollapsedMobileCircleSections((current) => ({ ...current, [viewKey]: false }));

    window.requestAnimationFrame(() => {
      circlePortfolioSectionRef.current?.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      });
    });
  }, []);

  const getCirclePrimaryActionLabel = useCallback((circle: Circle) => {
    if (circle.isActive) {
      return 'Contribute';
    }

    if (circle.isAdmin) {
      return 'Manage';
    }

    return 'Open';
  }, []);

  const handleCirclePrimaryAction = useCallback((circle: Circle) => {
    if (circle.isActive) {
      setSelectedMobileCircle(null);
      router.push(`/circle/${circle.id}/contribute`);
      return;
    }

    if (circle.isAdmin) {
      setSelectedMobileCircle(null);
      router.push(`/circle/${circle.id}/manage`);
      return;
    }

    setSelectedMobileCircle(null);
    router.push(`/circle/${circle.id}`);
  }, [router]);

  const getCircleMobileSummary = useCallback((circle: Circle) => {
    if (circle.isActive) {
      return circle.nextPayoutTime
        ? `Next payout ${formatDate(circle.nextPayoutTime)}`
        : 'Circle is active and ready for contributions.';
    }

    if (circle.currentMembers < circle.maxMembers) {
      const membersNeeded = circle.maxMembers - circle.currentMembers;
      return `Waiting for ${membersNeeded} more member${membersNeeded === 1 ? '' : 's'} before the circle fills.`;
    }

    return 'Circle is inactive right now. Open details to manage or review it.';
  }, []);

  const handleCircleJump = useCallback((circleId: string, viewKey: CircleViewKey) => {
    if (!circleId) {
      return;
    }

    const targetCircleList = getCircleListForView(viewKey);
    const sortedCircles = getSortedCircles(targetCircleList);
    const targetIndex = sortedCircles.findIndex((circle) => circle.id === circleId);

    if (targetIndex === -1) {
      return;
    }

    const requiredVisibleCount = targetIndex + 1;
    if (displayedCirclesCount < requiredVisibleCount) {
      setDisplayedCirclesCount(requiredVisibleCount);
    }

    setCollapsedMobileCircleSections((current) => ({ ...current, [viewKey]: false }));
    setPendingCircleJump({ viewKey, circleId });
    setCircleJumpSelections((current) => ({ ...current, [viewKey]: '' }));
  }, [displayedCirclesCount, getCircleListForView, getSortedCircles]);

  useEffect(() => {
    if (!pendingCircleJump) {
      return;
    }

    const refKey = `${pendingCircleJump.viewKey}:${pendingCircleJump.circleId}`;
    const targetCard = circleCardRefs.current.get(refKey);

    if (!targetCard) {
      return;
    }

    const highlightedKey = refKey;
    window.requestAnimationFrame(() => {
      targetCard.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      });
      setHighlightedCircleRefKey(highlightedKey);
      setPendingCircleJump(null);

      window.setTimeout(() => {
        setHighlightedCircleRefKey((current) =>
          current === highlightedKey ? null : current
        );
      }, 1800);
    });
  }, [pendingCircleJump, displayedCirclesCount, circleViewIndex]);

  const primarySurfaceClass =
    'rounded-[32px] border border-stone-200 bg-white shadow-[0_24px_70px_-42px_rgba(15,23,42,0.32)]';
  const primaryActionClass =
    'inline-flex items-center justify-center rounded-full bg-slate-950 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-slate-400 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50';
  const secondaryActionClass =
    'inline-flex items-center justify-center rounded-full border border-stone-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 transition hover:border-stone-400 hover:bg-stone-50 focus:outline-none focus:ring-2 focus:ring-stone-300 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50';
  const subtleIconButtonClass =
    'inline-flex h-9 w-9 items-center justify-center rounded-full border border-stone-200 bg-white text-slate-500 transition hover:border-stone-300 hover:text-slate-900 focus:outline-none focus:ring-2 focus:ring-stone-300 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50';
  const dialogOverlayClass =
    'fixed inset-0 z-50 bg-slate-950/40 backdrop-blur-[2px]';
  const dialogContentClass =
    'fixed left-1/2 top-1/2 z-50 w-[min(calc(100vw-1.5rem),42rem)] max-h-[min(90vh,calc(100dvh-1.5rem))] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-[28px] border border-stone-200 bg-white shadow-[0_32px_90px_-45px_rgba(15,23,42,0.45)] focus:outline-none';
  const onrampDialogContentClass =
    'fixed left-1/2 top-1/2 z-50 flex w-[min(calc(100vw-1rem),40rem)] max-h-[min(92dvh,calc(100dvh-1rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-[28px] border border-[#ddd5c9] bg-[#fbfaf7] shadow-[0_32px_90px_-45px_rgba(15,23,42,0.45)] focus:outline-none sm:w-[min(calc(100vw-1.5rem),40rem)] sm:max-h-[min(90vh,calc(100dvh-1.5rem))] sm:rounded-[32px]';
  const mobileSheetContentClass =
    'fixed inset-x-0 bottom-0 z-50 max-h-[85dvh] overflow-hidden rounded-t-[32px] border border-stone-200 bg-white shadow-[0_-24px_70px_-42px_rgba(15,23,42,0.4)] focus:outline-none md:hidden';
  const mobileSheetBodyClass =
    'max-h-[calc(85dvh-112px)] overflow-y-auto px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]';
  const transferDialogContentClass =
    'fixed inset-x-3 top-[max(0.75rem,env(safe-area-inset-top))] bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-50 flex flex-col overflow-hidden rounded-[28px] border border-stone-200 bg-white shadow-[0_32px_90px_-45px_rgba(15,23,42,0.45)] focus:outline-none md:left-1/2 md:top-1/2 md:bottom-auto md:w-[min(calc(100vw-1.5rem),42rem)] md:max-h-[min(90vh,calc(100dvh-1.5rem))] md:-translate-x-1/2 md:-translate-y-1/2';
  const dialogHeaderClass =
    'flex items-start justify-between gap-4 border-b border-stone-200 px-5 py-5 sm:px-6';
  const dialogBodyClass =
    'min-h-0 overflow-y-auto overscroll-contain px-5 py-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:px-6';
  const dialogInputClass =
    'w-full rounded-2xl border border-stone-300 bg-white px-4 py-3 text-sm text-slate-900 shadow-sm outline-none transition focus:border-stone-400 focus:ring-2 focus:ring-stone-200';
  const dialogSelectTokenClass =
    'rounded-[20px] border px-4 py-3 text-left transition focus:outline-none focus:ring-2 focus:ring-stone-300 focus:ring-offset-2';
  const circleGhostActionClass =
    'inline-flex items-center justify-center rounded-full border border-stone-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:border-stone-400 hover:bg-stone-50 focus:outline-none focus:ring-2 focus:ring-stone-300 focus:ring-offset-2';
  const circlePrimaryActionClass =
    'inline-flex items-center justify-center rounded-full bg-slate-950 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-slate-400 focus:ring-offset-2';
  const circleDangerActionClass =
    'inline-flex items-center justify-center rounded-full border border-red-200 bg-red-50 px-4 py-2 text-sm font-medium text-red-700 transition hover:bg-red-100 focus:outline-none focus:ring-2 focus:ring-red-300 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50';

  const renderHoldingsList = (variant: 'desktop' | 'sheet' = 'desktop') => {
    if (allCoins.length === 0) {
      return (
        <p className={variant === 'desktop' ? 'mt-4 text-sm text-slate-500' : 'text-sm text-slate-500'}>
          Token balances will appear here after your wallet is funded.
        </p>
      );
    }

    return (
      <div className={variant === 'desktop' ? 'mt-4 space-y-3' : 'space-y-3'}>
        {allCoins.map((coin, index) => {
          const tokenBalance = Number(coin.balance) / getCoinDecimals(coin.coinType);
          const convertedValue = convertedBalances[coin.symbol] || 0;

          return (
            <div
              key={`${coin.coinType}-${index}`}
              className={`flex items-center justify-between gap-3 rounded-2xl border border-stone-200 bg-white ${
                variant === 'desktop' ? 'px-4 py-3' : 'px-4 py-3.5'
              }`}
            >
              <div className="flex min-w-0 items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-stone-100">
                  <TokenIcon symbol={coin.symbol} />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-slate-900">{coin.symbol}</p>
                  {(coin.symbol === 'SUI' || coin.symbol === 'USDC') && suiPrice && convertedValue > 0 && (
                    <p className="text-xs text-slate-500">
                      {balanceVisible
                        ? formatCurrency(convertedValue, selectedCurrency)
                        : formatBalanceDisplay(convertedValue)}
                    </p>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-3">
                <div className="text-right">
                  <div className="text-sm font-medium text-slate-900">
                    {balanceVisible
                      ? tokenBalance.toFixed(coin.symbol === 'USDC' ? 2 : 4)
                      : formatBalanceDisplay(tokenBalance)}
                  </div>
                </div>
                {(coin.symbol === 'USDC' || coin.symbol === 'SUI') && (
                  <button
                    type="button"
                    onClick={() => {
                      if (variant === 'sheet') {
                        setIsMobileWalletHoldingsOpen(false);
                      }
                      openBuyFlow(coin.symbol);
                    }}
                    className="inline-flex items-center rounded-full border border-stone-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 transition hover:border-stone-400 hover:bg-stone-50"
                    title={`Buy ${coin.symbol}`}
                  >
                    Buy
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  const renderCircleCard = (circle: Circle) => {
    return (
    <article
      key={circle.id}
      className="rounded-[28px] border border-stone-200 bg-white p-6 shadow-[0_18px_50px_-38px_rgba(15,23,42,0.32)]"
    >
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium ${
                  circle.isAdmin
                    ? 'bg-slate-950 text-white'
                    : 'bg-stone-100 text-slate-700'
                }`}
              >
                {circle.isAdmin ? 'Admin' : 'Member'}
              </span>
              <span
                className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium ${
                  circle.isActive
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                    : 'border-amber-200 bg-amber-50 text-amber-700'
                }`}
              >
                {circle.isActive ? 'Active' : 'Inactive'}
              </span>
            </div>
            <h3 className="mt-4 truncate text-xl font-semibold tracking-tight text-slate-950">
              {circle.name}
            </h3>
            <p className="mt-2 text-sm text-slate-500">
              {circle.currentMembers} of {circle.maxMembers} members
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => copyToClipboard(circle.id, 'circleId')}
              className={`inline-flex items-center rounded-full border px-3 py-2 text-xs font-medium transition ${
                copiedCircleId === circle.id
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                  : 'border-stone-300 bg-white text-slate-600 hover:border-stone-400 hover:bg-stone-50'
              }`}
            >
              <Copy className="mr-1.5 h-3.5 w-3.5" />
              {copiedCircleId === circle.id ? 'Copied' : 'Copy ID'}
            </button>
            {circle.isAdmin && (
              <button
                type="button"
                onClick={() => copyShareLink(circle.id)}
                className="inline-flex items-center rounded-full border border-stone-300 bg-white px-3 py-2 text-xs font-medium text-slate-600 transition hover:border-stone-400 hover:bg-stone-50"
              >
                <Link className="mr-1.5 h-3.5 w-3.5" />
                Invite link
              </button>
            )}
          </div>
        </div>

        <div className="rounded-[24px] border border-stone-200 bg-stone-50/80 p-5">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <p className="text-xs font-medium uppercase tracking-[0.18em] text-slate-500">
                Contribution
              </p>
              <p className="mt-2 text-sm font-medium text-slate-900">
                <CurrencyDisplay
                  usd={circle.contributionAmountUsd}
                  sui={circle.contributionAmount}
                  currencyType={circle.currencyType}
                />
              </p>
            </div>
            <div>
              <p className="text-xs font-medium uppercase tracking-[0.18em] text-slate-500">
                Cycle
              </p>
              <p className="mt-2 text-sm font-medium text-slate-900">
                {formatCycleInfo(circle.cycleLength, circle.cycleDay)}
              </p>
            </div>
            <div>
              <p className="text-xs font-medium uppercase tracking-[0.18em] text-slate-500">
                Security deposit
              </p>
              <p className="mt-2 text-sm font-medium text-slate-900">
                <CurrencyDisplay
                  usd={circle.securityDepositUsd}
                  sui={circle.securityDeposit}
                  currencyType={circle.currencyType}
                />
              </p>
            </div>
            <div>
              <p className="text-xs font-medium uppercase tracking-[0.18em] text-slate-500">
                Next payout
              </p>
              <p className="mt-2 text-sm font-medium text-slate-900">
                {circle.isActive ? formatDate(circle.nextPayoutTime) : 'Activate circle to start'}
              </p>
            </div>
          </div>
        </div>

        <div className="grid gap-2 border-t border-stone-200 pt-5 sm:flex sm:flex-wrap">
          <button
            type="button"
            onClick={() => router.push(`/circle/${circle.id}`)}
            className={`${circleGhostActionClass} w-full sm:w-auto`}
          >
            <Eye className="mr-2 h-4 w-4" />
            Open
          </button>
          {circle.isAdmin && (
            <button
              type="button"
              onClick={() => router.push(`/circle/${circle.id}/manage`)}
              className={`${circleGhostActionClass} w-full sm:w-auto`}
            >
              <Settings className="mr-2 h-4 w-4" />
              Manage
            </button>
          )}
          <button
            type="button"
            onClick={() => router.push(`/circle/${circle.id}/contribute`)}
            className={`${circlePrimaryActionClass} w-full sm:w-auto`}
          >
            <CreditCard className="mr-2 h-4 w-4" />
            Contribute
          </button>
          {circle.isAdmin && deleteableCircles.has(circle.id) && (
            <button
              type="button"
              onClick={() => {
                console.log("Delete button clicked for circle:", circle.id);
                try {
                  deleteCircle(circle.id);
                } catch (e) {
                  console.error("Error in delete button click handler:", e);
                  toast.error("Error processing delete request");
                }
              }}
              disabled={isDeleting === circle.id}
              className={`${circleDangerActionClass} w-full sm:w-auto`}
            >
              <Trash2 className="mr-2 h-4 w-4" />
              {isDeleting === circle.id ? 'Deleting' : 'Delete'}
            </button>
          )}
        </div>
      </div>
    </article>
    );
  };

  const renderMobileCircleRow = (circle: Circle, viewKey: CircleViewKey) => {
    const refKey = `${viewKey}:${circle.id}`;
    const contributionLabel = formatCurrency(
      circle.contributionAmountUsd,
      circle.currencyType || 'USD',
    );
    const primaryActionLabel = getCirclePrimaryActionLabel(circle);

    return (
      <article
        key={circle.id}
        ref={(node) => {
          if (node) {
            circleCardRefs.current.set(refKey, node);
          } else {
            circleCardRefs.current.delete(refKey);
          }
        }}
        className={`rounded-[24px] border bg-white p-4 shadow-[0_16px_45px_-36px_rgba(15,23,42,0.3)] transition-all duration-300 ${
          highlightedCircleRefKey === refKey
            ? 'border-slate-400 ring-2 ring-slate-200'
            : 'border-stone-200'
        }`}
      >
        <div className="flex items-start gap-3">
          <button
            type="button"
            onClick={() => setSelectedMobileCircle(circle)}
            className="min-w-0 flex-1 text-left"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-medium ${
                  circle.isAdmin
                    ? 'bg-slate-950 text-white'
                    : 'bg-stone-100 text-slate-700'
                }`}
              >
                {circle.isAdmin ? 'Admin' : 'Member'}
              </span>
              <span
                className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-medium ${
                  circle.isActive
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                    : 'border-amber-200 bg-amber-50 text-amber-700'
                }`}
              >
                {circle.isActive ? 'Active' : 'Inactive'}
              </span>
            </div>

            <h4 className="mt-3 truncate text-base font-semibold text-slate-950">
              {circle.name}
            </h4>

            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-slate-600">
              <span>{contributionLabel} contribution</span>
              <span>{circle.currentMembers}/{circle.maxMembers} members</span>
            </div>

            <p className="mt-2 text-sm text-slate-500">
              {getCircleMobileSummary(circle)}
            </p>
          </button>

          <button
            type="button"
            onClick={() => handleCirclePrimaryAction(circle)}
            className="shrink-0 rounded-full bg-slate-950 px-3 py-2 text-xs font-semibold text-white transition hover:bg-slate-800"
          >
            {primaryActionLabel}
          </button>
        </div>
      </article>
    );
  };

  const renderLoadMoreButton = (
    circleList: Circle[],
    options: { includeServerState?: boolean } = {},
  ) => {
    const totalCount = getSortedCircles(circleList).length;
    const remainingCount = Math.max(0, totalCount - displayedCirclesCount);
    const shouldShow =
      options.includeServerState
        ? displayedCirclesCount < totalCount ||
          paginationState.hasMoreAdmin ||
          paginationState.hasMoreMember
        : displayedCirclesCount < totalCount;

    if (!shouldShow) {
      return null;
    }

    const helperText =
      options.includeServerState &&
      (paginationState.hasMoreAdmin || paginationState.hasMoreMember)
        ? 'More circles are available from the network.'
        : `${remainingCount} more ${remainingCount === 1 ? 'circle' : 'circles'}`;

    return (
      <div className="flex flex-col items-center gap-3 pt-2">
        <button
          type="button"
          onClick={loadMoreCircles}
          disabled={isLoadingMore}
          className={secondaryActionClass}
        >
          {isLoadingMore ? (
            <>
              <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
              {t('dashboard.loadingMore')}
            </>
          ) : (
            t('dashboard.loadMore')
          )}
        </button>
        {!isLoadingMore && <p className="text-sm text-slate-500">{helperText}</p>}
      </div>
    );
  };

  const renderCirclePanel = (
    circleList: Circle[],
    viewKey: CircleViewKey,
    options: { includeServerState?: boolean; emptyMessage: string } = {
      emptyMessage: 'No circles in this view yet.',
    },
  ) => {
    if (circleList.length === 0) {
      return (
        <div className="rounded-[28px] border border-dashed border-stone-300 bg-stone-50/70 px-6 py-10 text-center">
          <p className="text-sm font-medium text-slate-900">{options.emptyMessage}</p>
          <p className="mt-2 text-sm text-slate-500">
            Switch views, create a new circle, or join an existing one.
          </p>
        </div>
      );
    }

    const sortedCircles = getSortedCircles(circleList);
    const visibleCircles = getPaginatedCircles(circleList, displayedCirclesCount);
    const mobilePrimaryCircles: Circle[] = [];

    for (const circle of visibleCircles) {
      if (circle.isActive && mobilePrimaryCircles.length < 4) {
        mobilePrimaryCircles.push(circle);
      }
    }

    for (const circle of visibleCircles) {
      if (
        mobilePrimaryCircles.length >= 4 ||
        mobilePrimaryCircles.some((entry) => entry.id === circle.id)
      ) {
        continue;
      }

      mobilePrimaryCircles.push(circle);
    }

    const mobilePrimaryCircleIds = new Set(mobilePrimaryCircles.map((circle) => circle.id));
    const mobileSecondaryCircles = visibleCircles.filter(
      (circle) => !mobilePrimaryCircleIds.has(circle.id),
    );
    const isMobileSecondaryCollapsed = collapsedMobileCircleSections[viewKey];

    return (
      <div className="space-y-8">
        <div className="rounded-[24px] border border-stone-200 bg-stone-50/80 p-4 md:hidden">
          <div className="grid gap-4">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                Mobile Navigation
              </p>
              <p className="mt-1 text-sm text-slate-600">
                Flip the order or jump straight to an older circle without scrolling through every card.
              </p>
            </div>

            <div className="grid gap-3 sm:grid-cols-[auto,minmax(0,1fr)] sm:items-end">
              <div>
                <label className="text-xs font-medium uppercase tracking-[0.16em] text-slate-500">
                  Card order
                </label>
                <div className="mt-2 inline-flex rounded-full border border-stone-200 bg-white p-1">
                  <button
                    type="button"
                    onClick={() => setCircleSortOrder('newest')}
                    className={`rounded-full px-3 py-2 text-sm font-medium transition ${
                      circleSortOrder === 'newest'
                        ? 'bg-slate-950 text-white'
                        : 'text-slate-500 hover:text-slate-900'
                    }`}
                  >
                    Newest first
                  </button>
                  <button
                    type="button"
                    onClick={() => setCircleSortOrder('oldest')}
                    className={`rounded-full px-3 py-2 text-sm font-medium transition ${
                      circleSortOrder === 'oldest'
                        ? 'bg-slate-950 text-white'
                        : 'text-slate-500 hover:text-slate-900'
                    }`}
                  >
                    Oldest first
                  </button>
                </div>
              </div>

              <div className="min-w-0">
                <label className="text-xs font-medium uppercase tracking-[0.16em] text-slate-500">
                  Jump to circle
                </label>
                <div className="relative mt-2">
                  <select
                    value={circleJumpSelections[viewKey]}
                    onChange={(event) => {
                      const selectedCircleId = event.target.value;
                      setCircleJumpSelections((current) => ({
                        ...current,
                        [viewKey]: selectedCircleId,
                      }));
                      handleCircleJump(selectedCircleId, viewKey);
                    }}
                    className="w-full appearance-none rounded-2xl border border-stone-300 bg-white px-4 py-3 pr-10 text-sm font-medium text-slate-700 outline-none transition focus:border-stone-400 focus:ring-2 focus:ring-stone-200"
                  >
                    <option value="">Choose a circle</option>
                    {sortedCircles.map((circle) => (
                      <option key={circle.id} value={circle.id}>
                        {circle.name}
                        {circle.isActive ? ' • Active' : ' • Inactive'}
                      </option>
                    ))}
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="space-y-4 md:hidden">
          {mobilePrimaryCircles.map((circle) => renderMobileCircleRow(circle, viewKey))}

          {mobileSecondaryCircles.length > 0 && (
            <div className="rounded-[24px] border border-stone-200 bg-stone-50/70 p-4">
              <button
                type="button"
                onClick={() =>
                  setCollapsedMobileCircleSections((current) => ({
                    ...current,
                    [viewKey]: !current[viewKey],
                  }))
                }
                className="flex w-full items-center justify-between gap-3 text-left"
              >
                <div>
                  <p className="text-xs font-medium uppercase tracking-[0.16em] text-slate-500">
                    Inactive / Older Circles
                  </p>
                  <p className="mt-1 text-sm text-slate-600">
                    {mobileSecondaryCircles.length} more circle{mobileSecondaryCircles.length === 1 ? '' : 's'}
                  </p>
                </div>
                {isMobileSecondaryCollapsed ? (
                  <ChevronDown className="h-4 w-4 text-slate-500" />
                ) : (
                  <ChevronUp className="h-4 w-4 text-slate-500" />
                )}
              </button>

              {!isMobileSecondaryCollapsed && (
                <div className="mt-4 space-y-3 border-t border-stone-200 pt-4">
                  {mobileSecondaryCircles.map((circle) => renderMobileCircleRow(circle, viewKey))}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="hidden gap-5 md:grid md:grid-cols-2 xl:grid-cols-3">
          {visibleCircles.map((circle) => renderCircleCard(circle))}
        </div>
        {renderLoadMoreButton(circleList, options)}
      </div>
    );
  };

  if (!isAuthenticated || !account) {
    return null;
  }
  const onrampAssetLabel =
    coinbaseAssetIntent === 'SUI' ? 'SUI' : 'USDC on Sui';
  return (
    <div className="min-h-screen bg-[#f6f3ee] text-slate-950 [background-image:radial-gradient(circle_at_top_left,_rgba(255,255,255,0.92),_transparent_30%),radial-gradient(circle_at_top_right,_rgba(226,232,240,0.7),_transparent_26%)]">
      {/* Toast Notification */}
      {showToast && (
        <div className="fixed right-6 top-6 z-50 flex items-center gap-2 rounded-full border border-slate-800 bg-slate-950 px-4 py-2 text-sm font-medium text-white shadow-lg shadow-slate-900/20">
          <svg className="h-4 w-4 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" />
          </svg>
          <span>Address copied</span>
        </div>
      )}

      {/* Testnet Banner */}
      {showTestnetBanner && (
        <div className="border-b border-amber-200/70 bg-amber-50/90 backdrop-blur-sm">
          <div className="mx-auto flex max-w-7xl items-start justify-between gap-4 px-4 py-3 sm:px-6 lg:px-8">
            <div className="flex min-w-0 items-start gap-3">
              <div className="mt-0.5 flex-shrink-0">
                <svg className="h-5 w-5 text-amber-500" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                  <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                </svg>
              </div>
              <div className="min-w-0">
                <p className="text-sm font-medium text-amber-900">
                  You are on Sui Testnet.
                </p>
                <p className="mt-1 text-sm text-amber-800">
                  Funds and transfers here are for testing only and do not settle on mainnet.
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={requestTestSui}
                disabled={isDrippingFaucet}
                className="inline-flex items-center rounded-full border border-amber-400 bg-amber-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-amber-600 disabled:opacity-60"
              >
                {isDrippingFaucet ? 'Sending…' : 'Get test SUI'}
              </button>
              <a
                href={`https://faucet.sui.io/?address=${userAddress || ''}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center rounded-full border border-amber-300 bg-white px-4 py-2 text-sm font-medium text-amber-900 transition hover:bg-amber-100"
              >
                <ExternalLink className="mr-2 h-4 w-4" />
                Open faucet
              </a>
              <button
                onClick={dismissTestnetBanner}
                className="inline-flex h-9 w-9 items-center justify-center rounded-full text-amber-700 transition hover:bg-amber-100 focus:outline-none focus:ring-2 focus:ring-amber-300"
              >
                <span className="sr-only">Dismiss</span>
                <svg className="h-5 w-5" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                  <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      )}

      <main className="mx-auto max-w-7xl px-4 pt-8 pb-[max(2rem,env(safe-area-inset-bottom))] sm:px-6 lg:px-8">
        <div className="space-y-8">
          {userAddress ? (
            <NjangiRoundAlerts
              circles={circles.map((c) => ({
                id: c.id,
                name: c.name,
                admin: c.admin,
              }))}
              userAddress={userAddress}
              network={network as NetworkType}
            />
          ) : null}
          <div className="grid gap-6 xl:grid-cols-[minmax(0,1.45fr),380px]">
            <section className={primarySurfaceClass}>
              <div className="p-6 sm:p-10">
                <div className="flex flex-col gap-7 sm:gap-10">
                  <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
                    <div className="max-w-2xl">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-slate-500">
                        {t('dashboard.eyebrow')}
                      </p>
                      <h1 className="mt-3 text-3xl font-semibold tracking-tight text-slate-950 sm:mt-4 sm:text-4xl">
                        {t('dashboard.welcome', { name: account.name ? `, ${account.name}` : '' })}
                      </h1>
                      <p className="mt-3 max-w-xl text-sm leading-7 text-slate-600 sm:mt-4 sm:text-base">
                        {t('dashboard.blurb')}
                      </p>
                    </div>

                    <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center lg:flex-col lg:items-end">
                      <div className="inline-flex items-center rounded-full border border-stone-200 bg-white px-4 py-2 text-sm font-medium text-slate-600">
                        <span
                          className={`mr-2 h-2.5 w-2.5 rounded-full ${
                            network === 'mainnet' ? 'bg-emerald-500' : 'bg-amber-500'
                          }`}
                        />
                        {networkLabel}
                      </div>
                      <div className="inline-flex rounded-full border border-stone-200 bg-stone-100 p-1">
                        <button
                          type="button"
                          onClick={() => switchNetwork('testnet')}
                          className={`rounded-full px-4 py-2 text-sm font-medium transition ${
                            network === 'testnet'
                              ? 'bg-white text-slate-950 shadow-sm'
                              : 'text-slate-500 hover:text-slate-900'
                          }`}
                        >
                          Testnet
                        </button>
                        <button
                          type="button"
                          onClick={() => switchNetwork('mainnet')}
                          className={`rounded-full px-4 py-2 text-sm font-medium transition ${
                            network === 'mainnet'
                              ? 'bg-white text-slate-950 shadow-sm'
                              : 'text-slate-500 hover:text-slate-900'
                          }`}
                        >
                          Mainnet
                        </button>
                      </div>
                    </div>
                  </div>

                  <div className="grid gap-3 md:hidden">
                    <div className="rounded-[24px] border border-stone-200 bg-stone-50/80 p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                            Circle Types
                          </p>
                          <p className="mt-1 text-sm text-slate-600">
                            Jump straight to the right circle view.
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => scrollToCirclePortfolio('all')}
                          className="text-sm font-medium text-slate-600 transition hover:text-slate-950"
                        >
                          Open list
                        </button>
                      </div>

                      <div className="mt-4 grid grid-cols-3 gap-2">
                        <button
                          type="button"
                          onClick={() => scrollToCirclePortfolio('all')}
                          className="rounded-[20px] border border-stone-200 bg-white px-3 py-3 text-left transition hover:border-stone-300 hover:bg-stone-50"
                        >
                          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                            All
                          </p>
                          <p className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">
                            {circles.length}
                          </p>
                        </button>
                        <button
                          type="button"
                          onClick={() => scrollToCirclePortfolio('admin')}
                          className="rounded-[20px] border border-stone-200 bg-white px-3 py-3 text-left transition hover:border-stone-300 hover:bg-stone-50"
                        >
                          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                            Admin
                          </p>
                          <p className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">
                            {adminCircles.length}
                          </p>
                        </button>
                        <button
                          type="button"
                          onClick={() => scrollToCirclePortfolio('member')}
                          className="rounded-[20px] border border-stone-200 bg-white px-3 py-3 text-left transition hover:border-stone-300 hover:bg-stone-50"
                        >
                          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                            Member
                          </p>
                          <p className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">
                            {memberCircles.length}
                          </p>
                        </button>
                      </div>

                      <div className="mt-3 flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => scrollToCirclePortfolio('all')}
                          className="inline-flex items-center rounded-full border border-stone-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 transition hover:border-stone-300 hover:bg-stone-50"
                        >
                          {activeCirclesCount} active
                        </button>
                        <button
                          type="button"
                          onClick={() => scrollToCirclePortfolio('all')}
                          className="inline-flex items-center rounded-full border border-stone-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 transition hover:border-stone-300 hover:bg-stone-50"
                        >
                          {inactiveCirclesCount} inactive
                        </button>
                      </div>
                    </div>
                  </div>

                  <div className="hidden gap-4 md:grid md:grid-cols-3">
                    <button
                      type="button"
                      onClick={() => scrollToCirclePortfolio('all')}
                      className="rounded-[24px] border border-stone-200 bg-stone-50/80 p-5 text-left transition hover:border-stone-300 hover:bg-stone-50"
                    >
                      <p className="text-xs font-medium uppercase tracking-[0.18em] text-slate-500">
                        Total circles
                      </p>
                      <p className="mt-3 text-3xl font-semibold tracking-tight text-slate-950">
                        {circles.length}
                      </p>
                      <p className="mt-2 text-sm text-slate-500">
                        {memberCircles.length > 0
                          ? `${memberCircles.length} member role${memberCircles.length === 1 ? '' : 's'}`
                          : 'No member-only roles yet'}
                      </p>
                    </button>
                    <button
                      type="button"
                      onClick={() => scrollToCirclePortfolio('admin')}
                      className="rounded-[24px] border border-stone-200 bg-stone-50/80 p-5 text-left transition hover:border-stone-300 hover:bg-stone-50"
                    >
                      <p className="text-xs font-medium uppercase tracking-[0.18em] text-slate-500">
                        Admin roles
                      </p>
                      <p className="mt-3 text-3xl font-semibold tracking-tight text-slate-950">
                        {adminCircles.length}
                      </p>
                      <p className="mt-2 text-sm text-slate-500">
                        {adminCircles.length > 0
                          ? 'You can manage members, links, and payout flow here.'
                          : 'Create a circle to become an admin.'}
                      </p>
                    </button>
                    <button
                      type="button"
                      onClick={() => scrollToCirclePortfolio('all')}
                      className="rounded-[24px] border border-stone-200 bg-stone-50/80 p-5 text-left transition hover:border-stone-300 hover:bg-stone-50"
                    >
                      <p className="text-xs font-medium uppercase tracking-[0.18em] text-slate-500">
                        Active circles
                      </p>
                      <p className="mt-3 text-3xl font-semibold tracking-tight text-slate-950">
                        {activeCirclesCount}
                      </p>
                      <p className="mt-2 text-sm text-slate-500">
                        {circles.length === 0
                          ? 'Your circle activity will appear once you join or create one.'
                          : `${inactiveCirclesCount} inactive circle${inactiveCirclesCount === 1 ? '' : 's'}`}
                      </p>
                    </button>
                  </div>

                  <div className="flex flex-wrap gap-3">
                    <button
                      type="button"
                      onClick={handleManualRefresh}
                      disabled={loading || isBackgroundRefreshing}
                      className={secondaryActionClass}
                    >
                      <RefreshCw className={`mr-2 h-4 w-4 ${(loading || isBackgroundRefreshing) ? 'animate-spin' : ''}`} />
                      {t('dashboard.refreshCircles')}
                    </button>
                    <button
                      type="button"
                      onClick={() => setIsJoinDialogOpen(true)}
                      className={secondaryActionClass}
                    >
                      <Users className="mr-2 h-4 w-4" />
                      {t('dashboard.joinCircle')}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        invalidateCirclesCache();
                        router.push('/create-circle');
                      }}
                      className={primaryActionClass}
                    >
                      <svg
                        className="mr-2 h-4 w-4"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth="2"
                          d="M12 4v16m8-8H4"
                        />
                      </svg>
                      {t('dashboard.newCircle')}
                    </button>
                  </div>

                  {isBackgroundRefreshing && (
                    <div className="inline-flex items-center rounded-full border border-blue-200 bg-blue-50 px-4 py-2 text-sm font-medium text-blue-700">
                      <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                      Updating your circle data
                    </div>
                  )}

                  <div className="hidden rounded-[24px] border border-stone-200 bg-stone-50/80 p-5 md:block xl:hidden">
                    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                      <div>
                        <p className="text-xs font-medium uppercase tracking-[0.18em] text-slate-500">
                          Wallet snapshot
                        </p>
                        <p className="mt-3 text-2xl font-semibold tracking-tight text-slate-950">
                          {walletValueDisplay}
                        </p>
                        <p className="mt-2 text-sm text-slate-500">
                          {fundedTokens.length} funded token{fundedTokens.length === 1 ? '' : 's'} tracked
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={handleRefreshBalance}
                        disabled={isRefreshingBalance}
                        className={secondaryActionClass}
                      >
                        <RefreshCw className={`mr-2 h-4 w-4 ${isRefreshingBalance ? 'animate-spin' : ''}`} />
                        Refresh balance
                      </button>
                    </div>

                    <div className="mt-5 grid gap-3 sm:grid-cols-2">
                      <button
                        type="button"
                        onClick={() => setIsTransferDialogOpen(true)}
                        className={primaryActionClass}
                      >
                        <Send className="mr-2 h-4 w-4" />
                        Send
                      </button>
                      <button
                        type="button"
                        onClick={() => openBuyFlow('usdc')}
                        className={secondaryActionClass}
                      >
                        <CreditCard className="mr-2 h-4 w-4" />
                        Buy crypto
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </section>

            <aside className={`${primarySurfaceClass} overflow-hidden`}>
              <div className="border-b border-stone-200 px-5 py-5 sm:px-6 sm:py-6">
                <div className="flex items-center gap-4">
                  <div className="relative h-14 w-14 overflow-hidden rounded-full bg-stone-200">
                    {account.picture ? (
                      <Image
                        src={account.picture}
                        alt="Profile"
                        width={56}
                        height={56}
                        className="h-full w-full object-cover"
                        priority={true}
                        onError={() => {
                          console.error('Error loading Google profile picture');
                        }}
                      />
                    ) : (
                      <Image
                        src={`https://api.dicebear.com/7.x/micah/svg?seed=${account.sub}`}
                        alt="Profile"
                        width={56}
                        height={56}
                        className="h-full w-full object-cover"
                        priority={true}
                        unoptimized={true}
                      />
                    )}
                  </div>
                  <div className="min-w-0">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">
                      Wallet Overview
                    </p>
                    <h2 className="mt-1 truncate text-xl font-semibold tracking-tight text-slate-950">
                      {account.name || 'Your account'}
                    </h2>
                    <p className="mt-1 text-sm text-slate-500">{networkLabel} wallet</p>
                  </div>
                </div>
              </div>

              <div className="px-5 py-5 sm:px-6 sm:py-6">
                <div className="grid gap-4 md:hidden">
                  <div className="rounded-[24px] border border-stone-200 bg-stone-50/80 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                          Wallet snapshot
                        </p>
                        <p className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">
                          {walletValueDisplay}
                        </p>
                        <p className="mt-2 text-sm text-slate-500">
                          {fundedTokens.length} funded token{fundedTokens.length === 1 ? '' : 's'} tracked
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={toggleBalanceVisibility}
                          className={subtleIconButtonClass}
                          aria-label={balanceVisible ? 'Hide balance' : 'Show balance'}
                        >
                          {balanceVisible ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                        </button>
                        <button
                          type="button"
                          onClick={handleRefreshBalance}
                          disabled={isRefreshingBalance}
                          className={subtleIconButtonClass}
                          aria-label="Refresh balance"
                        >
                          <RefreshCw className={`h-4 w-4 ${isRefreshingBalance ? 'animate-spin' : ''}`} />
                        </button>
                        <button
                          type="button"
                          onClick={() => copyToClipboard(userAddress)}
                          className={subtleIconButtonClass}
                          aria-label="Copy wallet address"
                        >
                          <Copy className="h-4 w-4" />
                        </button>
                      </div>
                    </div>

                    <div className="mt-4 rounded-[20px] border border-stone-200 bg-white px-4 py-3">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                        Wallet address
                      </p>
                      <p className="mt-2 font-mono text-sm text-slate-900">
                        {shortenAddress(userAddress)}
                      </p>
                    </div>

                    <div className="mt-3 flex flex-wrap gap-2">
                      <span className="inline-flex items-center rounded-full border border-stone-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600">
                        {selectedCurrency}
                      </span>
                      <span className="inline-flex items-center rounded-full border border-stone-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600">
                        {networkLabel}
                      </span>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <button
                      type="button"
                      onClick={() => setIsMobileWalletDetailsOpen(true)}
                      className="rounded-[20px] border border-stone-200 bg-white px-4 py-4 text-left transition hover:border-stone-300 hover:bg-stone-50"
                    >
                      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                        Wallet details
                      </p>
                      <p className="mt-2 text-sm font-medium text-slate-950">
                        Address and tools
                      </p>
                      <p className="mt-1 text-xs leading-5 text-slate-500">
                        Currency, history, and funding actions.
                      </p>
                    </button>

                    <button
                      type="button"
                      onClick={() => setIsMobileWalletHoldingsOpen(true)}
                      className="rounded-[20px] border border-stone-200 bg-white px-4 py-4 text-left transition hover:border-stone-300 hover:bg-stone-50"
                    >
                      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                        Holdings
                      </p>
                      <p className="mt-2 text-sm font-medium text-slate-950">
                        {allCoins.length} asset{allCoins.length === 1 ? '' : 's'}
                      </p>
                      <p className="mt-1 text-xs leading-5 text-slate-500">
                        {walletHoldingsSummary}
                      </p>
                    </button>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <button
                      type="button"
                      onClick={() => setIsTransferDialogOpen(true)}
                      className={primaryActionClass}
                    >
                      <Send className="mr-2 h-4 w-4" />
                      Send
                    </button>
                    <button
                      type="button"
                      onClick={() => openBuyFlow('usdc')}
                      className={secondaryActionClass}
                    >
                      <CreditCard className="mr-2 h-4 w-4" />
                      Buy crypto
                    </button>
                  </div>
                </div>

                <div className="hidden space-y-5 md:block">
                  <div className="rounded-[24px] border border-stone-200 bg-stone-50/80 p-5">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-xs font-medium uppercase tracking-[0.18em] text-slate-500">
                          Wallet address
                        </p>
                        <p className="mt-3 break-all font-mono text-sm text-slate-900">
                          {walletAddressDisplay}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => copyToClipboard(userAddress)}
                        className={subtleIconButtonClass}
                        aria-label="Copy wallet address"
                      >
                        <Copy className="h-4 w-4" />
                      </button>
                    </div>
                    <button
                      type="button"
                      onClick={() => setShowFullAddress(!showFullAddress)}
                      className="mt-3 text-sm font-medium text-slate-600 transition hover:text-slate-900"
                    >
                      {showFullAddress ? 'Show less' : 'Reveal full address'}
                    </button>
                  </div>

                  <div className="rounded-[24px] border border-stone-200 bg-white p-5">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <p className="text-xs font-medium uppercase tracking-[0.18em] text-slate-500">
                          Estimated wallet value
                        </p>
                        <p className="mt-3 text-3xl font-semibold tracking-tight text-slate-950">
                          {walletValueDisplay}
                        </p>
                        <p className="mt-2 text-sm text-slate-500">
                          {fundedTokens.length} funded token{fundedTokens.length === 1 ? '' : 's'} tracked
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <Tooltip.Provider>
                          <Tooltip.Root>
                            <Tooltip.Trigger asChild>
                              <button
                                type="button"
                                onClick={toggleBalanceVisibility}
                                className={subtleIconButtonClass}
                                aria-label={balanceVisible ? 'Hide balance' : 'Show balance'}
                              >
                                {balanceVisible ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                              </button>
                            </Tooltip.Trigger>
                            <Tooltip.Portal>
                              <Tooltip.Content className="rounded-lg bg-slate-900 px-2 py-1 text-xs text-white" sideOffset={5}>
                                {balanceVisible ? 'Hide balance' : 'Show balance'}
                                <Tooltip.Arrow className="fill-slate-900" />
                              </Tooltip.Content>
                            </Tooltip.Portal>
                          </Tooltip.Root>
                        </Tooltip.Provider>
                        <Tooltip.Provider>
                          <Tooltip.Root>
                            <Tooltip.Trigger asChild>
                              <button
                                type="button"
                                onClick={handleRefreshBalance}
                                disabled={isRefreshingBalance}
                                className={subtleIconButtonClass}
                                aria-label="Refresh balance"
                              >
                                <RefreshCw className={`h-4 w-4 ${isRefreshingBalance ? 'animate-spin' : ''}`} />
                              </button>
                            </Tooltip.Trigger>
                            <Tooltip.Portal>
                              <Tooltip.Content className="rounded-lg bg-slate-900 px-2 py-1 text-xs text-white" sideOffset={5}>
                                {isRefreshingBalance ? 'Refreshing...' : 'Refresh balance'}
                                <Tooltip.Arrow className="fill-slate-900" />
                              </Tooltip.Content>
                            </Tooltip.Portal>
                          </Tooltip.Root>
                        </Tooltip.Provider>
                        <Tooltip.Provider>
                          <Tooltip.Root>
                            <Tooltip.Trigger asChild>
                              <button
                                type="button"
                                onClick={openTransactionHistory}
                                className={subtleIconButtonClass}
                                aria-label="Open transaction history"
                              >
                                <Clock className="h-4 w-4" />
                              </button>
                            </Tooltip.Trigger>
                            <Tooltip.Portal>
                              <Tooltip.Content className="rounded-lg bg-slate-900 px-2 py-1 text-xs text-white" sideOffset={5}>
                                Transaction history
                                <Tooltip.Arrow className="fill-slate-900" />
                              </Tooltip.Content>
                            </Tooltip.Portal>
                          </Tooltip.Root>
                        </Tooltip.Provider>
                      </div>
                    </div>

                    <div className="mt-5">
                      <label className="text-xs font-medium uppercase tracking-[0.18em] text-slate-500">
                        Display currency
                      </label>
                      <div className="relative mt-2">
                        <select
                          value={selectedCurrency}
                          onChange={(e) => setSelectedCurrency(e.target.value)}
                          className="w-full appearance-none rounded-2xl border border-stone-300 bg-stone-50 px-4 py-3 pr-10 text-sm font-medium text-slate-700 outline-none transition focus:border-stone-400"
                        >
                          <option value="USD">USD ($)</option>
                          <option value="XAF">XAF (FCFA)</option>
                          <option value="NGN">NGN (₦)</option>
                          <option value="EUR">EUR (€)</option>
                          <option value="GBP">GBP (£)</option>
                          <option value="CAD">CAD (C$)</option>
                          <option value="ZAR">ZAR (R)</option>
                          <option value="KES">KES (KSh)</option>
                          <option value="EGP">EGP (E£)</option>
                          <option value="MAD">MAD</option>
                          <option value="GHS">GHS (GH₵)</option>
                        </select>
                        <ChevronDown className="pointer-events-none absolute right-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                      </div>
                    </div>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <button
                      type="button"
                      onClick={() => setIsTransferDialogOpen(true)}
                      className={primaryActionClass}
                    >
                      <Send className="mr-2 h-4 w-4" />
                      Send
                    </button>
                    <button
                      type="button"
                      onClick={() => openBuyFlow('usdc')}
                      className={secondaryActionClass}
                    >
                      <CreditCard className="mr-2 h-4 w-4" />
                      Buy crypto
                    </button>
                    {network === 'testnet' && (
                      <a
                        href={`https://faucet.sui.io/?address=${userAddress || ''}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={`sm:col-span-2 ${secondaryActionClass}`}
                      >
                        <ExternalLink className="mr-2 h-4 w-4" />
                        Open faucet
                      </a>
                    )}
                  </div>
                </div>

                {onrampResultStatus !== 'idle' && onrampResultMessage && (
                  <div
                    className={`mt-4 rounded-[24px] border px-4 py-3 text-sm ${
                      onrampResultStatus === 'success'
                        ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                        : onrampResultStatus === 'pending'
                          ? 'border-amber-200 bg-amber-50 text-amber-800'
                          : 'border-red-200 bg-red-50 text-red-800'
                    }`}
                  >
                    <p>{onrampResultMessage}</p>
                    {isOnrampResultRefreshing && (
                      <p className="mt-1 text-xs opacity-80">Updating on-chain balances...</p>
                    )}
                  </div>
                )}

                <div className="mt-4 hidden rounded-[24px] border border-stone-200 bg-stone-50/80 p-5 md:block">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-xs font-medium uppercase tracking-[0.18em] text-slate-500">
                        Holdings
                      </p>
                      <p className="mt-1 text-sm text-slate-500">
                        {allCoins.length} asset{allCoins.length === 1 ? '' : 's'} tracked
                      </p>
                    </div>
                  </div>

                  {renderHoldingsList('desktop')}
                </div>
              </div>
            </aside>
          </div>

          <div className={`${primarySurfaceClass} overflow-hidden`}>
            <div className="border-b border-stone-200 px-8 py-6">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h3 className="text-2xl font-semibold tracking-tight text-slate-950">
                    Manual swap
                  </h3>
                  <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
                    Convert between SUI and USDC from the same wallet when you need to rebalance or prepare for a contribution.
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <span className="inline-flex items-center rounded-full border border-stone-200 bg-stone-50 px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.18em] text-slate-600">
                    {activeSwapNetwork}
                  </span>
                  <button
                    type="button"
                    onClick={() => setIsManualSwapOpen((current) => !current)}
                    className={secondaryActionClass}
                    aria-expanded={isManualSwapOpen}
                    aria-label={isManualSwapOpen ? 'Collapse manual swap' : 'Expand manual swap'}
                  >
                    {isManualSwapOpen ? 'Hide swap' : 'Open swap'}
                    {isManualSwapOpen ? (
                      <ChevronUp className="ml-2 h-4 w-4" />
                    ) : (
                      <ChevronDown className="ml-2 h-4 w-4" />
                    )}
                  </button>
                </div>
              </div>
            </div>
            {!isManualSwapOpen ? (
              <div className="px-8 py-6">
                <div className="rounded-[24px] border border-dashed border-stone-300 bg-stone-50/80 px-5 py-5 text-sm text-slate-600">
                  Manual swap is hidden. Open it only when you need to convert between SUI and USDC.
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-6 px-8 py-8 xl:grid-cols-[minmax(0,1.7fr),minmax(300px,1fr)]">
                <div className="space-y-5">
                  <div className="rounded-[24px] border border-stone-200 bg-white p-5">
                    <p className="text-sm font-semibold text-slate-500">1. Pick what you are spending</p>
                    <div className="mt-3 inline-flex rounded-2xl bg-stone-100 p-1">
                      <button
                        type="button"
                        onClick={() => setSwapDirection('SUI_TO_USDC')}
                        className={`rounded-xl px-4 py-2 text-sm font-semibold transition ${
                          swapDirection === 'SUI_TO_USDC'
                            ? 'bg-white text-slate-950 shadow-sm'
                            : 'text-slate-500'
                        }`}
                      >
                        Spend SUI
                      </button>
                      <button
                        type="button"
                        onClick={() => setSwapDirection('USDC_TO_SUI')}
                        className={`rounded-xl px-4 py-2 text-sm font-semibold transition ${
                          swapDirection === 'USDC_TO_SUI'
                            ? 'bg-white text-slate-950 shadow-sm'
                            : 'text-slate-500'
                        }`}
                      >
                        Spend USDC
                      </button>
                    </div>
                    <p className="mt-3 text-sm text-slate-600">
                      The destination token is chosen automatically, so there is no routing setup.
                    </p>
                  </div>

                  <div className="rounded-[24px] border border-stone-200 bg-white p-5">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <p className="text-sm font-semibold text-slate-500">2. Enter one amount</p>
                        <p className="mt-1 text-xs text-slate-500">
                          Available now: {formatManualSwapAmount(sourceBalance, sourceSymbol)}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={handleRefreshBalance}
                        disabled={isRefreshingBalance}
                        className="inline-flex items-center justify-center rounded-full border border-stone-300 px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <RefreshCw className={`mr-2 h-4 w-4 ${isRefreshingBalance ? 'animate-spin' : ''}`} />
                        Refresh
                      </button>
                    </div>

                    <div className="mt-4 rounded-[20px] border border-stone-200 bg-stone-50/60 px-4 py-3">
                      <label className="block text-sm font-medium text-slate-700">
                        Amount in {sourceSymbol}
                      </label>
                      <input
                        type="number"
                        min="0"
                        step={sourceSymbol === 'SUI' ? '0.0001' : '0.01'}
                        value={swapAmount}
                        onChange={(event) => setSwapAmount(event.target.value)}
                        placeholder={sourceSymbol === 'SUI' ? '0.2500' : '10.00'}
                        className="mt-2 w-full border-0 bg-transparent p-0 text-3xl font-semibold text-slate-950 focus:outline-none focus:ring-0"
                      />
                    </div>

                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => applySwapQuickAmount(0.25)}
                        className="rounded-full border border-stone-300 px-3 py-1.5 text-xs font-semibold text-slate-600 transition hover:bg-stone-50"
                      >
                        25%
                      </button>
                      <button
                        type="button"
                        onClick={() => applySwapQuickAmount(0.5)}
                        className="rounded-full border border-stone-300 px-3 py-1.5 text-xs font-semibold text-slate-600 transition hover:bg-stone-50"
                      >
                        50%
                      </button>
                      <button
                        type="button"
                        onClick={() => applySwapQuickAmount(1)}
                        className="rounded-full border border-stone-300 px-3 py-1.5 text-xs font-semibold text-slate-600 transition hover:bg-stone-50"
                      >
                        Max
                      </button>
                    </div>

                    {sourceSymbol === 'SUI' && (
                      <p className="mt-3 text-xs text-slate-500">
                        Max keeps {MANUAL_SWAP_SUI_GAS_BUFFER.toFixed(2)} SUI available for gas.
                      </p>
                    )}
                  </div>

                  <div className="rounded-[24px] border border-stone-200 bg-white p-5">
                    <p className="text-sm font-semibold text-slate-500">3. Review and swap</p>

                    <div className="mt-4 rounded-[24px] bg-stone-50 p-4">
                      <div className="flex items-center justify-between text-sm text-slate-600">
                        <span>You pay</span>
                        <span className="font-semibold text-slate-950">
                          {hasValidSwapAmount
                            ? formatManualSwapAmount(parsedSwapAmount, sourceSymbol)
                            : `0.00 ${sourceSymbol}`}
                        </span>
                      </div>
                      <div className="mt-3 flex items-center justify-center text-slate-400">
                        <ArrowRightLeft className="h-4 w-4" />
                      </div>
                      <div className="mt-3 flex items-center justify-between text-sm text-slate-600">
                        <span>You receive</span>
                        <span className="font-semibold text-slate-950">
                          {!hasValidSwapAmount
                            ? `Enter an amount`
                            : swapQuote
                              ? `~${formatManualSwapAmount(swapQuote.amountOut, targetSymbol)}`
                              : 'Waiting for quote'}
                        </span>
                      </div>
                      <div className="mt-4 grid grid-cols-1 gap-3 text-xs sm:grid-cols-2">
                        <div className="rounded-xl border border-stone-200 bg-white px-3 py-2 text-slate-600">
                          Slippage protection: {MANUAL_SWAP_SLIPPAGE.toFixed(1)}%
                        </div>
                        <div className="rounded-xl border border-stone-200 bg-white px-3 py-2 text-slate-600">
                          Price impact: {swapQuote ? formatManualSwapPercent(swapQuote.priceImpact) : '--'}
                        </div>
                      </div>
                    </div>

                    {isSwapQuoteLoading && (
                      <p className="mt-3 text-sm text-slate-500">Updating live quote...</p>
                    )}

                    {swapQuoteError && (
                      <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                        {swapQuoteError}
                      </div>
                    )}

                    {hasValidSwapAmount && !hasEnoughSourceBalance && (
                      <div className="mt-4 rounded-xl border border-blue-200 bg-blue-50 px-4 py-4">
                        <p className="text-sm font-semibold text-blue-900">
                          You need more {sourceSymbol} for this swap.
                        </p>
                        <p className="mt-1 text-sm text-blue-800">
                          Buy the token you want to spend, then come back and keep the same amount.
                        </p>
                        <button
                          type="button"
                          onClick={() => openBuyFlow(sourceSymbol === 'SUI' ? 'sui' : 'usdc')}
                          className="mt-3 inline-flex items-center rounded-full bg-slate-950 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-800"
                        >
                          <CreditCard className="mr-2 h-4 w-4" />
                          Buy {sourceSymbol}
                        </button>
                      </div>
                    )}

                    <button
                      type="button"
                      onClick={() => void handleManualSwap()}
                      disabled={
                        isSwapSubmitting ||
                        !hasValidSwapAmount ||
                        !hasEnoughSourceBalance ||
                        isSwapQuoteLoading ||
                        !!swapQuoteError ||
                        !swapQuote
                      }
                      className="mt-5 inline-flex w-full items-center justify-center rounded-full bg-slate-950 px-4 py-3 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300"
                    >
                      {isSwapSubmitting
                        ? 'Swapping...'
                        : `Swap ${sourceSymbol} For ${targetSymbol}`}
                    </button>
                  </div>
                </div>

                <div className="space-y-5">
                  <div className="rounded-[24px] border border-stone-200 bg-white p-5">
                    <h4 className="text-base font-semibold text-slate-950">Wallet snapshot</h4>
                    <div className="mt-4 space-y-3">
                      <div className="rounded-xl border border-stone-200 bg-stone-50 px-4 py-3">
                        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">SUI</p>
                        <p className="mt-1 text-xl font-semibold text-slate-950">
                          {formatManualSwapAmount(getManualSwapBalance(allCoins, 'SUI'), 'SUI')}
                        </p>
                      </div>
                      <div className="rounded-xl border border-stone-200 bg-stone-50 px-4 py-3">
                        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">USDC</p>
                        <p className="mt-1 text-xl font-semibold text-slate-950">
                          {formatManualSwapAmount(getManualSwapBalance(allCoins, 'USDC'), 'USDC')}
                        </p>
                      </div>
                    </div>
                  </div>

                  <div className="rounded-[24px] border border-stone-200 bg-white p-5">
                    <h4 className="text-base font-semibold text-slate-950">How this works</h4>
                    <div className="mt-4 space-y-3 text-sm text-slate-600">
                      <p>1. Choose the token you already hold.</p>
                      <p>2. Enter one amount or use a quick amount button.</p>
                      <p>3. Review the quote and press the swap button once.</p>
                    </div>
                    <div className="mt-4 rounded-xl border border-stone-200 bg-stone-50 px-4 py-3 text-sm text-slate-600">
                      You currently hold {formatManualSwapAmount(targetBalance, targetSymbol)} on the receive side.
                    </div>
                  </div>

                  {lastSwapDigest && (
                    <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-5">
                      <p className="text-sm font-semibold text-emerald-900">Latest swap submitted</p>
                      <a
                        href={`https://explorer.sui.io/txblock/${lastSwapDigest}?network=${activeSwapNetwork}`}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-3 inline-flex items-center text-sm font-medium text-emerald-800 hover:text-emerald-900"
                      >
                        View transaction
                        <ExternalLink className="ml-2 h-4 w-4" />
                      </a>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Njangi Circles Section */}
          <section
            ref={circlePortfolioSectionRef}
            className={primarySurfaceClass}
          >
            <div className="p-8 sm:p-10">
              <div className="flex flex-col gap-8">
                <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-slate-500">
                      Circle Portfolio
                    </p>
                    <h3 className="mt-3 text-2xl font-semibold tracking-tight text-slate-950 sm:text-3xl">
                      My Njangi circles
                    </h3>
                    <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
                      Review membership, payouts, and required actions without hunting through separate views.
                    </p>
                  </div>

                  <div className="flex flex-wrap gap-3">
                    <div className="inline-flex items-center rounded-full border border-stone-200 bg-stone-50 px-4 py-2 text-sm font-medium text-slate-600">
                      {circles.length} total
                    </div>
                    <div className="inline-flex items-center rounded-full border border-stone-200 bg-stone-50 px-4 py-2 text-sm font-medium text-slate-600">
                      {adminCircles.length} admin
                    </div>
                    <div className="inline-flex items-center rounded-full border border-stone-200 bg-stone-50 px-4 py-2 text-sm font-medium text-slate-600">
                      {activeCirclesCount} active
                    </div>
                  </div>
                </div>

                {loading ? (
                  <div className="space-y-6">
                    <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
                      {Array.from({ length: 6 }, (_, i) => (
                        <CircleCardSkeleton key={i} />
                      ))}
                    </div>
                    <div className="max-w-xl">
                      <div className="flex items-center justify-between text-sm text-slate-500">
                        <span>{loadingProgress.message}</span>
                        <span>
                          {loadingProgress.total > 0
                            ? Math.round((loadingProgress.current / loadingProgress.total) * 100)
                            : 0}
                          %
                        </span>
                      </div>
                      <div className="mt-3 h-2 rounded-full bg-stone-200">
                        <div
                          className="h-2 rounded-full bg-slate-950 transition-all duration-300"
                          style={{
                            width: `${loadingProgress.total > 0 ? (loadingProgress.current / loadingProgress.total) * 100 : 0}%`,
                          }}
                        ></div>
                      </div>
                    </div>
                  </div>
                ) : error ? (
                  <div className="rounded-[28px] border border-red-200 bg-red-50 px-6 py-10 text-center">
                    <svg
                      className="mx-auto h-12 w-12 text-red-400"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      aria-hidden="true"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                      />
                    </svg>
                    <h3 className="mt-4 text-base font-semibold text-red-900">{error}</h3>
                    <p className="mt-2 text-sm text-red-700">Please try again in a moment.</p>
                    <div className="mt-6">
                      <button
                        type="button"
                        onClick={() => fetchUserCircles()}
                        className={circleDangerActionClass}
                      >
                        Try again
                      </button>
                    </div>
                  </div>
                ) : circles.length > 0 ? (
                  <Tab.Group
                    selectedIndex={circleViewIndex}
                    onChange={(index) => {
                      setCircleViewIndex(index);
                    }}
                  >
                    <Tab.List className="inline-flex w-full flex-col gap-2 rounded-[28px] border border-stone-200 bg-stone-50 p-2 sm:w-auto sm:flex-row">
                      <Tab
                        className={({ selected }) =>
                          `rounded-full px-4 py-2.5 text-sm font-medium transition ${
                            selected
                              ? 'bg-white text-slate-950 shadow-sm'
                              : 'text-slate-500 hover:text-slate-900'
                          }`
                        }
                      >
                        All circles ({circles.length})
                      </Tab>
                      <Tab
                        className={({ selected }) =>
                          `rounded-full px-4 py-2.5 text-sm font-medium transition ${
                            selected
                              ? 'bg-white text-slate-950 shadow-sm'
                              : 'text-slate-500 hover:text-slate-900'
                          }`
                        }
                      >
                        Administering ({adminCircles.length})
                      </Tab>
                      <Tab
                        className={({ selected }) =>
                          `rounded-full px-4 py-2.5 text-sm font-medium transition ${
                            selected
                              ? 'bg-white text-slate-950 shadow-sm'
                              : 'text-slate-500 hover:text-slate-900'
                          }`
                        }
                      >
                        Member only ({memberCircles.length})
                      </Tab>
                    </Tab.List>

                    <Tab.Panels className="mt-8">
                      <Tab.Panel>
                        {renderCirclePanel(circles, 'all', {
                          includeServerState: true,
                          emptyMessage: 'No circles match this view yet.',
                        })}
                      </Tab.Panel>
                      <Tab.Panel>
                        {renderCirclePanel(adminCircles, 'admin', {
                          emptyMessage: 'You are not administering any circles yet.',
                        })}
                      </Tab.Panel>
                      <Tab.Panel>
                        {renderCirclePanel(memberCircles, 'member', {
                          emptyMessage: 'You do not have member-only circles yet.',
                        })}
                      </Tab.Panel>
                    </Tab.Panels>
                  </Tab.Group>
                ) : (
                  <div className="rounded-[28px] border border-dashed border-stone-300 bg-stone-50/80 px-6 py-14 text-center">
                    <svg
                      className="mx-auto h-12 w-12 text-stone-400"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      aria-hidden="true"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0z"
                      />
                    </svg>
                    <h3 className="mt-4 text-base font-semibold text-slate-950">{t('dashboard.emptyTitle')}</h3>
                    <p className="mt-2 text-sm text-slate-500">
                      {t('dashboard.emptyBody')}
                    </p>
                    <div className="mt-6 flex flex-wrap justify-center gap-3">
                      <button
                        type="button"
                        onClick={() => setIsJoinDialogOpen(true)}
                        className={secondaryActionClass}
                      >
                        <Users className="mr-2 h-4 w-4" />
                        {t('dashboard.emptyJoin')}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          invalidateCirclesCache();
                          router.push('/create-circle');
                        }}
                        className={primaryActionClass}
                      >
                        <svg
                          className="mr-2 h-4 w-4"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth="2"
                            d="M12 4v16m8-8H4"
                          />
                        </svg>
                        {t('dashboard.emptyCreate')}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </section>
        </div>
      </main>

      <Dialog.Root
        open={!!selectedMobileCircle}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedMobileCircle(null);
          }
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className={`${dialogOverlayClass} md:hidden`} />
          <Dialog.Content className={mobileSheetContentClass}>
            {selectedMobileCircle && (
              <>
                <div className="flex justify-center pt-3">
                  <div className="h-1.5 w-12 rounded-full bg-stone-300" />
                </div>

                <div className="flex items-start justify-between gap-4 px-5 pb-4 pt-4">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium ${
                          selectedMobileCircle.isAdmin
                            ? 'bg-slate-950 text-white'
                            : 'bg-stone-100 text-slate-700'
                        }`}
                      >
                        {selectedMobileCircle.isAdmin ? 'Admin' : 'Member'}
                      </span>
                      <span
                        className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium ${
                          selectedMobileCircle.isActive
                            ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                            : 'border-amber-200 bg-amber-50 text-amber-700'
                        }`}
                      >
                        {selectedMobileCircle.isActive ? 'Active' : 'Inactive'}
                      </span>
                    </div>

                    <Dialog.Title className="mt-3 text-xl font-semibold tracking-tight text-slate-950">
                      {selectedMobileCircle.name}
                    </Dialog.Title>
                    <Dialog.Description className="mt-2 text-sm text-slate-500">
                      {getCircleMobileSummary(selectedMobileCircle)}
                    </Dialog.Description>
                  </div>

                  <Dialog.Close className={subtleIconButtonClass} aria-label="Close circle details">
                    <X className="h-4 w-4" />
                  </Dialog.Close>
                </div>

                <div className={mobileSheetBodyClass}>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="rounded-[20px] border border-stone-200 bg-stone-50/80 p-4">
                      <p className="text-xs font-medium uppercase tracking-[0.16em] text-slate-500">
                        Contribution
                      </p>
                      <p className="mt-2 text-sm font-semibold text-slate-950">
                        {formatCurrency(
                          selectedMobileCircle.contributionAmountUsd,
                          selectedMobileCircle.currencyType || 'USD',
                        )}
                      </p>
                    </div>

                    <div className="rounded-[20px] border border-stone-200 bg-stone-50/80 p-4">
                      <p className="text-xs font-medium uppercase tracking-[0.16em] text-slate-500">
                        Members
                      </p>
                      <p className="mt-2 text-sm font-semibold text-slate-950">
                        {selectedMobileCircle.currentMembers} / {selectedMobileCircle.maxMembers}
                      </p>
                    </div>

                    <div className="rounded-[20px] border border-stone-200 bg-stone-50/80 p-4">
                      <p className="text-xs font-medium uppercase tracking-[0.16em] text-slate-500">
                        Security deposit
                      </p>
                      <p className="mt-2 text-sm font-semibold text-slate-950">
                        {formatCurrency(
                          selectedMobileCircle.securityDepositUsd,
                          selectedMobileCircle.currencyType || 'USD',
                        )}
                      </p>
                    </div>

                    <div className="rounded-[20px] border border-stone-200 bg-stone-50/80 p-4">
                      <p className="text-xs font-medium uppercase tracking-[0.16em] text-slate-500">
                        Cycle
                      </p>
                      <p className="mt-2 text-sm font-semibold text-slate-950">
                        {formatCycleInfo(selectedMobileCircle.cycleLength, selectedMobileCircle.cycleDay)}
                      </p>
                    </div>
                  </div>

                  <div className="mt-3 rounded-[20px] border border-stone-200 bg-white p-4">
                    <p className="text-xs font-medium uppercase tracking-[0.16em] text-slate-500">
                      Next payout
                    </p>
                    <p className="mt-2 text-sm font-semibold text-slate-950">
                      {selectedMobileCircle.isActive
                        ? formatDate(selectedMobileCircle.nextPayoutTime)
                        : 'Activate circle to start'}
                    </p>
                  </div>

                  <div className="mt-5 grid gap-3">
                    <button
                      type="button"
                      onClick={() => handleCirclePrimaryAction(selectedMobileCircle)}
                      className={primaryActionClass}
                    >
                      {selectedMobileCircle.isActive ? (
                        <CreditCard className="mr-2 h-4 w-4" />
                      ) : selectedMobileCircle.isAdmin ? (
                        <Settings className="mr-2 h-4 w-4" />
                      ) : (
                        <Eye className="mr-2 h-4 w-4" />
                      )}
                      {getCirclePrimaryActionLabel(selectedMobileCircle)}
                    </button>

                    {getCirclePrimaryActionLabel(selectedMobileCircle) !== 'Open' && (
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedMobileCircle(null);
                          router.push(`/circle/${selectedMobileCircle.id}`);
                        }}
                        className={secondaryActionClass}
                      >
                        <Eye className="mr-2 h-4 w-4" />
                        Open circle
                      </button>
                    )}

                    {selectedMobileCircle.isAdmin && getCirclePrimaryActionLabel(selectedMobileCircle) !== 'Manage' && (
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedMobileCircle(null);
                          router.push(`/circle/${selectedMobileCircle.id}/manage`);
                        }}
                        className={secondaryActionClass}
                      >
                        <Settings className="mr-2 h-4 w-4" />
                        Manage circle
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={() => copyToClipboard(selectedMobileCircle.id, 'circleId')}
                      className={secondaryActionClass}
                    >
                      <Copy className="mr-2 h-4 w-4" />
                      Copy circle ID
                    </button>

                    {selectedMobileCircle.isAdmin && (
                      <button
                        type="button"
                        onClick={() => copyShareLink(selectedMobileCircle.id)}
                        className={secondaryActionClass}
                      >
                        <Link className="mr-2 h-4 w-4" />
                        Copy invite link
                      </button>
                    )}

                    {selectedMobileCircle.isAdmin && deleteableCircles.has(selectedMobileCircle.id) && (
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedMobileCircle(null);
                          void deleteCircle(selectedMobileCircle.id);
                        }}
                        className={circleDangerActionClass}
                      >
                        <Trash2 className="mr-2 h-4 w-4" />
                        Delete circle
                      </button>
                    )}
                  </div>
                </div>
              </>
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root open={isMobileWalletDetailsOpen} onOpenChange={setIsMobileWalletDetailsOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className={`${dialogOverlayClass} md:hidden`} />
          <Dialog.Content className={mobileSheetContentClass}>
            <div className="flex justify-center pt-3">
              <div className="h-1.5 w-12 rounded-full bg-stone-300" />
            </div>

            <div className="flex items-start justify-between gap-4 px-5 pb-4 pt-4">
              <div className="min-w-0">
                <Dialog.Title className="text-xl font-semibold tracking-tight text-slate-950">
                  Wallet details
                </Dialog.Title>
                <Dialog.Description className="mt-2 text-sm text-slate-500">
                  Address, display preferences, and wallet tools for your {networkLabel.toLowerCase()} wallet.
                </Dialog.Description>
              </div>

              <Dialog.Close className={subtleIconButtonClass} aria-label="Close wallet details">
                <X className="h-4 w-4" />
              </Dialog.Close>
            </div>

            <div className={mobileSheetBodyClass}>
              <div className="rounded-[20px] border border-stone-200 bg-stone-50/80 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs font-medium uppercase tracking-[0.16em] text-slate-500">
                      Wallet address
                    </p>
                    <p className="mt-2 break-all font-mono text-sm text-slate-900">
                      {walletAddressDisplay}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => copyToClipboard(userAddress)}
                    className={subtleIconButtonClass}
                    aria-label="Copy wallet address"
                  >
                    <Copy className="h-4 w-4" />
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => setShowFullAddress(!showFullAddress)}
                  className="mt-3 text-sm font-medium text-slate-600 transition hover:text-slate-900"
                >
                  {showFullAddress ? 'Show less' : 'Reveal full address'}
                </button>
              </div>

              <div className="mt-3 rounded-[20px] border border-stone-200 bg-white p-4">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-xs font-medium uppercase tracking-[0.16em] text-slate-500">
                      Estimated wallet value
                    </p>
                    <p className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">
                      {walletValueDisplay}
                    </p>
                    <p className="mt-2 text-sm text-slate-500">
                      {fundedTokens.length} funded token{fundedTokens.length === 1 ? '' : 's'} tracked
                    </p>
                  </div>
                </div>

                <div className="mt-4 grid grid-cols-3 gap-2">
                  <button
                    type="button"
                    onClick={toggleBalanceVisibility}
                    className="rounded-full border border-stone-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 transition hover:border-stone-400 hover:bg-stone-50"
                  >
                    {balanceVisible ? 'Hide' : 'Show'}
                  </button>
                  <button
                    type="button"
                    onClick={handleRefreshBalance}
                    disabled={isRefreshingBalance}
                    className="rounded-full border border-stone-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 transition hover:border-stone-400 hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {isRefreshingBalance ? 'Refreshing' : 'Refresh'}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setIsMobileWalletDetailsOpen(false);
                      openTransactionHistory();
                    }}
                    className="rounded-full border border-stone-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 transition hover:border-stone-400 hover:bg-stone-50"
                  >
                    History
                  </button>
                </div>

                <div className="mt-4">
                  <label className="text-xs font-medium uppercase tracking-[0.16em] text-slate-500">
                    Display currency
                  </label>
                  <div className="relative mt-2">
                    <select
                      value={selectedCurrency}
                      onChange={(e) => setSelectedCurrency(e.target.value)}
                      className="w-full appearance-none rounded-2xl border border-stone-300 bg-stone-50 px-4 py-3 pr-10 text-sm font-medium text-slate-700 outline-none transition focus:border-stone-400"
                    >
                      <option value="USD">USD ($)</option>
                      <option value="XAF">XAF (FCFA)</option>
                      <option value="NGN">NGN (₦)</option>
                      <option value="EUR">EUR (€)</option>
                      <option value="GBP">GBP (£)</option>
                      <option value="CAD">CAD (C$)</option>
                      <option value="ZAR">ZAR (R)</option>
                      <option value="KES">KES (KSh)</option>
                      <option value="EGP">EGP (E£)</option>
                      <option value="MAD">MAD</option>
                      <option value="GHS">GHS (GH₵)</option>
                    </select>
                    <ChevronDown className="pointer-events-none absolute right-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  </div>
                </div>
              </div>

              <div className="mt-3 rounded-[20px] border border-stone-200 bg-stone-50/80 p-4">
                <p className="text-xs font-medium uppercase tracking-[0.16em] text-slate-500">
                  Funding tools
                </p>
                <div className="mt-4 grid gap-3">
                  <button
                    type="button"
                    onClick={() => {
                      setIsMobileWalletDetailsOpen(false);
                      openBuyFlow('usdc');
                    }}
                    className={secondaryActionClass}
                  >
                    <CreditCard className="mr-2 h-4 w-4" />
                    Buy crypto
                  </button>
                  {network === 'testnet' && (
                    <a
                      href={`https://faucet.sui.io/?address=${userAddress || ''}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={secondaryActionClass}
                    >
                      <ExternalLink className="mr-2 h-4 w-4" />
                      Open faucet
                    </a>
                  )}
                </div>
              </div>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root open={isMobileWalletHoldingsOpen} onOpenChange={setIsMobileWalletHoldingsOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className={`${dialogOverlayClass} md:hidden`} />
          <Dialog.Content className={mobileSheetContentClass}>
            <div className="flex justify-center pt-3">
              <div className="h-1.5 w-12 rounded-full bg-stone-300" />
            </div>

            <div className="flex items-start justify-between gap-4 px-5 pb-4 pt-4">
              <div className="min-w-0">
                <Dialog.Title className="text-xl font-semibold tracking-tight text-slate-950">
                  Holdings
                </Dialog.Title>
                <Dialog.Description className="mt-2 text-sm text-slate-500">
                  {walletHoldingsSummary}
                </Dialog.Description>
              </div>

              <Dialog.Close className={subtleIconButtonClass} aria-label="Close holdings">
                <X className="h-4 w-4" />
              </Dialog.Close>
            </div>

            <div className={mobileSheetBodyClass}>
              <div className="rounded-[20px] border border-stone-200 bg-stone-50/80 p-4">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-xs font-medium uppercase tracking-[0.16em] text-slate-500">
                      Estimated wallet value
                    </p>
                    <p className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">
                      {walletValueDisplay}
                    </p>
                    <p className="mt-2 text-sm text-slate-500">
                      {fundedTokens.length} funded token{fundedTokens.length === 1 ? '' : 's'} tracked
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={handleRefreshBalance}
                    disabled={isRefreshingBalance}
                    className={subtleIconButtonClass}
                    aria-label="Refresh balance"
                  >
                    <RefreshCw className={`h-4 w-4 ${isRefreshingBalance ? 'animate-spin' : ''}`} />
                  </button>
                </div>
              </div>

              <div className="mt-4">
                {renderHoldingsList('sheet')}
              </div>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      
      {/* Join Circle Dialog */}
      <Dialog.Root open={isJoinDialogOpen} onOpenChange={setIsJoinDialogOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className={dialogOverlayClass} />
          <Dialog.Content className={`${dialogContentClass} max-w-md`}>
            <div className={dialogHeaderClass}>
              <div className="flex min-w-0 items-start gap-4">
                <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-stone-200 bg-stone-50 text-slate-700">
                  <Users className="h-5 w-5" />
                </div>
                <div className="min-w-0">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                    Circle Access
                  </p>
                  <Dialog.Title className="mt-1 text-xl font-semibold text-slate-950">
                    Join a circle
                  </Dialog.Title>
                  <Dialog.Description className="mt-1 text-sm text-slate-500">
                    Paste a circle ID or invite link to move directly into the join flow.
                  </Dialog.Description>
                </div>
              </div>
              <Dialog.Close className={subtleIconButtonClass} aria-label="Close join dialog">
                <X className="h-4 w-4" />
              </Dialog.Close>
            </div>

            <form onSubmit={handleJoinCircle} className={`${dialogBodyClass} space-y-5`}>
              <div className="rounded-[24px] border border-stone-200 bg-stone-50/70 p-4">
                <label htmlFor="circleId" className="block text-sm font-medium text-slate-700">
                  Enter circle ID or invite link
                </label>
                <input
                  type="text"
                  id="circleId"
                  value={circleIdInput}
                  onChange={(e) => setCircleIdInput(e.target.value)}
                  placeholder="0x123... or full invite link"
                  className={`${dialogInputClass} mt-3`}
                />
                <p className="mt-2 text-sm text-slate-500">
                  Share links work too. The dashboard will extract the circle ID automatically.
                </p>
              </div>

              <div className="rounded-[24px] border border-stone-200 bg-white px-4 py-3 text-sm text-slate-600">
                You will be taken to the circle’s join page to review details before completing membership.
              </div>

              <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
                <button
                  type="button"
                  onClick={() => setIsJoinDialogOpen(false)}
                  className={secondaryActionClass}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className={primaryActionClass}
                >
                  Join Circle
                </button>
              </div>
            </form>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {/* Render the Confirmation Modal */}
      {confirmModalProps && (
        <ConfirmationModal
          isOpen={isConfirmModalOpen}
          onClose={() => setIsConfirmModalOpen(false)}
          onConfirm={confirmModalProps.onConfirm}
          title={confirmModalProps.title}
          message={confirmModalProps.message}
          confirmText={confirmModalProps.confirmText}
          confirmButtonVariant={confirmModalProps.confirmButtonVariant}
        />
      )}
      {/* Transfer Dialog */}
      <Dialog.Root open={isTransferDialogOpen} onOpenChange={resetTransferDialog}>
        <Dialog.Portal>
          <Dialog.Overlay className={dialogOverlayClass} />
          <Dialog.Content className={`${transferDialogContentClass} max-w-lg`}>
            <div className={dialogHeaderClass}>
              <div className="flex min-w-0 items-start gap-4">
                <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-stone-200 bg-stone-50 text-slate-700">
                  <Send className="h-5 w-5" />
                </div>
                <div className="min-w-0">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                    Wallet Transfer
                  </p>
                  <Dialog.Title className="mt-1 text-xl font-semibold text-slate-950">
                    Send tokens
                  </Dialog.Title>
                  <Dialog.Description className="mt-1 text-sm text-slate-500">
                    {transferStep === 'form' && 'Enter transfer details'}
                    {transferStep === 'review' && 'Review your transfer'}
                    {transferStep === 'confirm' && 'Confirming transaction...'}
                    {transferStep === 'success' && 'Transfer completed'}
                  </Dialog.Description>
                </div>
              </div>
              <Dialog.Close className={subtleIconButtonClass} aria-label="Close transfer dialog">
                <X className="h-4 w-4" />
              </Dialog.Close>
            </div>

            <div className="shrink-0 border-b border-stone-200 bg-stone-50/70 px-5 py-4 sm:px-6">
              <div className="flex items-center justify-between gap-3">
                {['form', 'review', 'confirm', 'success'].map((step, index, steps) => {
                  const currentStepIndex = steps.indexOf(transferStep);
                  const isActive = transferStep === step;
                  const isComplete =
                    ['review', 'confirm', 'success'].includes(transferStep) &&
                    index < currentStepIndex;

                  return (
                    <div key={step} className="flex min-w-0 flex-1 items-center">
                      <div
                        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-medium ${
                          isActive
                            ? 'bg-slate-950 text-white'
                            : isComplete
                              ? 'bg-emerald-500 text-white'
                              : 'bg-stone-200 text-slate-500'
                        }`}
                      >
                        {isComplete ? <CheckCircle className="h-4 w-4" /> : index + 1}
                      </div>
                      {index < steps.length - 1 && (
                        <div
                          className={`mx-2 h-0.5 flex-1 ${
                            isComplete ? 'bg-emerald-500' : 'bg-stone-200'
                          }`}
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {transferStep === 'form' && (
              <div className={`${dialogBodyClass} flex-1 space-y-6`}>
                <div className="space-y-3">
                  <label className="block text-sm font-medium text-slate-700">
                    Select token
                  </label>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {allCoins.map((coin) => {
                      const decimals = getCoinDecimals(coin.coinType);
                      const balance = Number(coin.balance) / decimals;
                      return (
                        <button
                          key={coin.symbol}
                          type="button"
                          onClick={() => {
                            setGasError(null);
                            setTransferForm(prev => ({ ...prev, selectedToken: coin.symbol }));
                          }}
                          className={`${dialogSelectTokenClass} ${
                            transferForm.selectedToken === coin.symbol
                              ? 'border-slate-900 bg-stone-50 text-slate-950'
                              : 'border-stone-200 bg-white text-slate-700 hover:border-stone-300 hover:bg-stone-50'
                          }`}
                        >
                          <div className="flex items-center gap-3">
                            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-stone-100">
                              <TokenIcon symbol={coin.symbol} />
                            </div>
                            <div className="min-w-0 text-left">
                              <div className="text-sm font-medium">{coin.symbol}</div>
                              <div className="text-xs text-slate-500">
                                {balance.toFixed(coin.symbol === 'SUI' ? 4 : 2)}
                              </div>
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="space-y-3">
                  <label className="block text-sm font-medium text-slate-700">
                    Recipient address
                  </label>
                  <input
                    type="text"
                    value={transferForm.recipientAddress}
                    onChange={(e) => setTransferForm(prev => ({ ...prev, recipientAddress: e.target.value }))}
                    placeholder="0x... or paste full address"
                    className={`${dialogInputClass} ${
                      transferValidation.errors.recipientAddress
                        ? 'border-red-300 focus:border-red-400 focus:ring-red-100'
                        : ''
                    }`}
                  />
                  {transferValidation.errors.recipientAddress && (
                    <p className="flex items-center text-sm text-red-600">
                      <AlertCircle className="mr-1.5 h-4 w-4" />
                      {transferValidation.errors.recipientAddress}
                    </p>
                  )}

                  {recentContacts.length > 0 && (
                    <div className="rounded-[20px] border border-stone-200 bg-stone-50/70 p-4">
                      <p className="text-xs font-medium uppercase tracking-[0.16em] text-slate-500">
                        Recent contacts
                      </p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        {recentContacts.slice(0, 3).map((contact) => (
                          <button
                            key={contact.address}
                            type="button"
                            onClick={() => setTransferForm(prev => ({ ...prev, recipientAddress: contact.address }))}
                            className="rounded-full border border-stone-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 transition hover:border-stone-400 hover:bg-stone-50"
                          >
                            {contact.name || `${contact.address.slice(0, 6)}...${contact.address.slice(-4)}`}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                <div className="space-y-3">
                  <label className="block text-sm font-medium text-slate-700">
                    Amount
                  </label>
                  <div className="relative rounded-[24px] border border-stone-200 bg-stone-50/70 px-4 py-3">
                    <input
                      type="number"
                      step="any"
                      value={transferForm.amount}
                      onChange={(e) => {
                        setGasError(null);
                        setTransferForm(prev => ({ ...prev, amount: e.target.value }));
                      }}
                      placeholder="0.00"
                      className={`w-full border-0 bg-transparent p-0 pr-16 text-3xl font-semibold text-slate-950 focus:outline-none focus:ring-0 ${
                        transferValidation.errors.amount || transferValidation.errors.balance ? 'text-red-600' : ''
                      }`}
                    />
                    <div className="pointer-events-none absolute inset-y-0 right-4 flex items-center text-sm font-medium text-slate-500">
                      {transferForm.selectedToken}
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    {getQuickPercentages().map((percentage) => (
                      <button
                        key={percentage}
                        type="button"
                        onClick={() => setPercentageAmount(percentage)}
                        className="rounded-full border border-stone-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 transition hover:border-stone-400 hover:bg-stone-50"
                      >
                        {percentage}%
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={setMaxAmount}
                      className="rounded-full border border-stone-300 bg-stone-100 px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:border-stone-400 hover:bg-stone-200"
                    >
                      Max
                    </button>
                  </div>

                  {transferForm.selectedToken === 'SUI' && !gasError && (
                    <p className="text-xs text-slate-500">
                      Percentages are calculated after reserving {getCurrentNetwork() === 'mainnet' ? '0.015' : '0.01'} SUI for gas.
                    </p>
                  )}

                  {gasError && (
                    <div className="flex items-start gap-3 rounded-[20px] border border-red-200 bg-red-50 px-4 py-4">
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-red-100">
                        <AlertCircle className="h-4 w-4 text-red-600" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-red-800">Insufficient balance</p>
                        <p className="mt-1 text-sm text-red-700">{gasError}</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => setGasError(null)}
                        className="text-red-400 transition hover:text-red-600"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  )}

                  {transferForm.amount && !isNaN(parseFloat(transferForm.amount)) && (
                    <p className="text-sm text-slate-500">
                      {transferForm.selectedToken === 'SUI' && suiPrice && (
                        <>Approx. ${(parseFloat(transferForm.amount) * suiPrice).toFixed(2)} USD</>
                      )}
                      {transferForm.selectedToken === 'USDC' && (
                        <>Approx. ${parseFloat(transferForm.amount).toFixed(2)} USD</>
                      )}
                    </p>
                  )}

                  {(transferValidation.errors.amount || transferValidation.errors.balance) && (
                    <p className="flex items-center text-sm text-red-600">
                      <AlertCircle className="mr-1.5 h-4 w-4" />
                      {transferValidation.errors.amount || transferValidation.errors.balance}
                    </p>
                  )}
                </div>

                <div>
                  <button
                    type="button"
                    onClick={() => setShowAdvancedOptions(!showAdvancedOptions)}
                    className="inline-flex items-center text-sm font-medium text-slate-600 transition hover:text-slate-900"
                  >
                    Advanced options
                    <svg className={`ml-1 h-4 w-4 transition-transform ${showAdvancedOptions ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </button>

                  {showAdvancedOptions && (
                    <div className="mt-3 rounded-[20px] border border-stone-200 bg-stone-50/70 p-4">
                      <label className="block text-sm font-medium text-slate-700">
                        Memo (optional)
                      </label>
                      <input
                        type="text"
                        value={transferForm.memo || ''}
                        onChange={(e) => setTransferForm(prev => ({ ...prev, memo: e.target.value }))}
                        placeholder="Add a note for this transfer"
                        className={`${dialogInputClass} mt-3`}
                        maxLength={100}
                      />
                    </div>
                  )}
                </div>

                {Object.keys(transferValidation.warnings).length > 0 && (
                  <div className="space-y-2">
                    {Object.entries(transferValidation.warnings).map(([key, warning]) => (
                      <div key={key} className="flex items-start gap-3 rounded-[20px] border border-amber-200 bg-amber-50 px-4 py-3">
                        <Shield className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                        <p className="text-sm text-amber-800">{warning}</p>
                      </div>
                    ))}
                  </div>
                )}

                <div className="flex flex-col-reverse gap-3 border-t border-stone-200 pt-5 sm:flex-row">
                  <button
                    type="button"
                    onClick={resetTransferDialog}
                    className={`flex-1 ${secondaryActionClass}`}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => setTransferStep('review')}
                    disabled={!transferValidation.isValid}
                    className={`flex-1 ${primaryActionClass}`}
                  >
                    Review transfer
                  </button>
                </div>
              </div>
            )}

            {transferStep === 'review' && (
              <div className={`${dialogBodyClass} flex-1 space-y-6`}>
                <div className="rounded-[24px] border border-stone-200 bg-stone-50/70 p-4">
                  <h3 className="text-base font-semibold text-slate-950">Transfer summary</h3>
                  <div className="mt-4 space-y-3 text-sm">
                    <div className="flex items-start justify-between gap-4">
                      <span className="text-slate-500">From</span>
                      <span className="font-mono text-right text-slate-900">{shortenAddress(userAddress)}</span>
                    </div>
                    <div className="flex items-start justify-between gap-4">
                      <span className="text-slate-500">To</span>
                      <span className="font-mono text-right text-slate-900">{shortenAddress(transferForm.recipientAddress)}</span>
                    </div>
                    <div className="flex items-start justify-between gap-4">
                      <span className="text-slate-500">Amount</span>
                      <span className="font-medium text-right text-slate-950">
                        {transferForm.amount} {transferForm.selectedToken}
                      </span>
                    </div>
                    {transferForm.selectedToken === 'SUI' && suiPrice && (
                      <div className="flex items-start justify-between gap-4">
                        <span className="text-slate-500">USD value</span>
                        <span className="text-right text-slate-900">
                          ${(parseFloat(transferForm.amount) * suiPrice).toFixed(2)}
                        </span>
                      </div>
                    )}
                    {transferForm.selectedToken === 'USDC' && (
                      <div className="flex items-start justify-between gap-4">
                        <span className="text-slate-500">USD value</span>
                        <span className="text-right text-slate-900">
                          ${parseFloat(transferForm.amount).toFixed(2)}
                        </span>
                      </div>
                    )}
                    <div className="flex items-start justify-between gap-4">
                      <span className="text-slate-500">Network</span>
                      <span className="text-right text-slate-900">
                        Sui {getCurrentNetwork() === 'mainnet' ? 'Mainnet' : 'Testnet'}
                      </span>
                    </div>
                    {transferForm.memo && (
                      <div className="flex items-start justify-between gap-4">
                        <span className="text-slate-500">Memo</span>
                        <span className="max-w-40 truncate text-right text-slate-900">{transferForm.memo}</span>
                      </div>
                    )}
                  </div>
                </div>

                <div className="rounded-[24px] border border-stone-200 bg-white p-4">
                  <h4 className="flex items-center text-base font-semibold text-slate-950">
                    <Shield className="mr-2 h-4 w-4 text-slate-600" />
                    Security checklist
                  </h4>
                  <div className="mt-4 space-y-3 text-sm text-slate-600">
                    <div className="flex items-center">
                      <CheckCircle className="mr-2 h-4 w-4 text-emerald-600" />
                      Recipient address format is valid
                    </div>
                    <div className="flex items-center">
                      <CheckCircle className="mr-2 h-4 w-4 text-emerald-600" />
                      Sufficient balance is available
                    </div>
                    <div className="flex items-center">
                      <CheckCircle className="mr-2 h-4 w-4 text-emerald-600" />
                      Gas fees are reserved for the transaction
                    </div>
                  </div>
                </div>

                <div className="flex flex-col-reverse gap-3 border-t border-stone-200 pt-5 sm:flex-row">
                  <button
                    type="button"
                    onClick={() => setTransferStep('form')}
                    className={`flex-1 ${secondaryActionClass}`}
                  >
                    Back
                  </button>
                  <button
                    type="button"
                    onClick={handleTransferSubmit}
                    disabled={isTransferring}
                    className={`flex-1 ${primaryActionClass}`}
                  >
                    {isTransferring ? 'Confirming...' : 'Confirm transfer'}
                  </button>
                </div>
              </div>
            )}

            {transferStep === 'confirm' && (
              <div className={`${dialogBodyClass} flex-1 py-10 text-center`}>
                <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-stone-100">
                  <Clock className="h-8 w-8 animate-pulse text-slate-700" />
                </div>
                <h3 className="mt-5 text-lg font-medium text-slate-950">Processing transfer</h3>
                <p className="mt-2 text-sm text-slate-500">
                  Please wait while the transaction is submitted to the Sui network.
                </p>
              </div>
            )}

            {transferStep === 'success' && transferResult && (
              <div className={`${dialogBodyClass} flex-1 py-8 text-center`}>
                <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-emerald-100">
                  <CheckCircle className="h-8 w-8 text-emerald-600" />
                </div>
                <h3 className="mt-5 text-lg font-medium text-slate-950">Transfer successful</h3>
                <p className="mt-2 text-sm text-slate-500">
                  {transferForm.amount} {transferForm.selectedToken} has been sent successfully.
                </p>

                {transferResult.digest && (
                  <div className="mt-5 rounded-[24px] border border-stone-200 bg-stone-50/70 p-4 text-left">
                    <p className="text-xs font-medium uppercase tracking-[0.16em] text-slate-500">
                      Transaction hash
                    </p>
                    <div className="mt-3 flex items-start justify-between gap-3">
                      <span className="break-all font-mono text-xs text-slate-700">
                        {transferResult.digest}
                      </span>
                      <button
                        type="button"
                        onClick={() => copyToClipboard(transferResult.digest || '')}
                        className={subtleIconButtonClass}
                        aria-label="Copy transaction hash"
                      >
                        <Copy className="h-4 w-4" />
                      </button>
                    </div>
                    <a
                      href={`https://${getCurrentNetwork() === 'mainnet' ? '' : 'testnet.'}suivision.xyz/txblock/${transferResult.digest}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-4 inline-flex items-center text-sm font-medium text-slate-700 transition hover:text-slate-950"
                    >
                      View on explorer
                      <ExternalLink className="ml-2 h-4 w-4" />
                    </a>
                  </div>
                )}

                <button
                  type="button"
                  onClick={resetTransferDialog}
                  className={`mt-6 w-full ${primaryActionClass}`}
                >
                  Done
                </button>
              </div>
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {/* Transaction History Modal */}
      <Dialog.Root open={isTransactionHistoryOpen} onOpenChange={setIsTransactionHistoryOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className={dialogOverlayClass} />
          <Dialog.Content className={`${transferDialogContentClass} max-w-2xl`}>
            <div className={dialogHeaderClass}>
              <div className="flex min-w-0 items-start gap-4">
                <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-stone-200 bg-stone-50 text-slate-700">
                  <Clock className="h-5 w-5" />
                </div>
                <div className="min-w-0">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                    Wallet Activity
                  </p>
                  <Dialog.Title className="mt-1 text-xl font-semibold text-slate-950">
                    Transaction history
                  </Dialog.Title>
                  <Dialog.Description className="mt-1 text-sm text-slate-500">
                    Recent transactions from your wallet.
                  </Dialog.Description>
                </div>
              </div>
              <Dialog.Close className={subtleIconButtonClass} aria-label="Close transaction history">
                <X className="h-4 w-4" />
              </Dialog.Close>
            </div>

            <div className={`${dialogBodyClass} flex-1`}>
              {isLoadingHistory ? (
                <div className="flex items-center justify-center py-8">
                  <div className="flex items-center gap-3 text-slate-600">
                    <svg className="h-5 w-5 animate-spin text-slate-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                    <span>Loading transaction history...</span>
                  </div>
                </div>
              ) : historyError ? (
                <div className="flex items-center justify-center py-8">
                  <div className="text-center">
                    <svg className="mx-auto mb-4 h-12 w-12 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
                    </svg>
                    <p className="mb-2 text-slate-600">{historyError}</p>
                    <button
                      type="button"
                      onClick={() => {
                        void fetchTransactionHistory();
                      }}
                      className="text-sm font-medium text-slate-700 transition hover:text-slate-950"
                    >
                      Try again
                    </button>
                  </div>
                </div>
              ) : transactionHistory.length === 0 ? (
                <div className="flex items-center justify-center py-8">
                  <div className="text-center">
                    <svg className="mx-auto mb-4 h-12 w-12 text-stone-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                    </svg>
                    <p className="text-slate-500">No transactions found</p>
                    <p className="mt-1 text-sm text-slate-400">Your transaction history will appear here.</p>
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  {transactionHistory.map((tx) => {
                    const amountLines = [
                      ...tx.receivedAmounts.map((amount) => ({
                        ...amount,
                        prefix: '+',
                        className: 'text-green-600',
                      })),
                      ...tx.sentAmounts.map((amount) => ({
                        ...amount,
                        prefix: '-',
                        className: 'text-red-600',
                      })),
                    ];

                    return (
                      <div
                        key={tx.digest}
                        className="rounded-[24px] border border-stone-200 bg-stone-50/80 p-4 transition hover:bg-stone-100/80"
                      >
                        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                          <div className="flex items-start gap-3">
                            <div className={`flex h-9 w-9 items-center justify-center rounded-full ${
                              tx.direction === 'received' ? 'bg-green-100 text-green-600' :
                              tx.direction === 'sent' ? 'bg-red-100 text-red-600' :
                              'bg-blue-100 text-blue-600'
                            }`}>
                              {tx.direction === 'received' ? (
                                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4v16m8-8l-8 8-8-8" />
                                </svg>
                              ) : tx.direction === 'sent' ? (
                                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 20V4m8 8l-8-8-8 8" />
                                </svg>
                              ) : (
                                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 9l4-4 4 4m0 6l-4 4-4-4" />
                                </svg>
                              )}
                            </div>
                            <div className="min-w-0">
                              <p className="font-medium text-slate-900">{tx.type}</p>
                              <p className="text-sm text-slate-500">{tx.timestamp.toLocaleString()}</p>
                            </div>
                          </div>

                          <div className="text-left sm:text-right">
                            {amountLines.length > 0 ? (
                              <div className="space-y-1">
                                {amountLines.map((amount, index) => (
                                  <p
                                    key={`${tx.digest}-${amount.direction}-${amount.coinType}-${index}`}
                                    className={`font-semibold ${amount.className}`}
                                  >
                                    {amount.prefix}{amount.formattedAmount} {amount.symbol}
                                  </p>
                                ))}
                              </div>
                            ) : (
                              <p className="font-semibold text-slate-900">No balance change</p>
                            )}
                            <div className="mt-2 flex items-center gap-2 sm:justify-end">
                              <span className={`inline-flex rounded-full px-2 py-1 text-xs font-medium ${
                                tx.status === 'Success' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
                              }`}>
                                {tx.status}
                              </span>
                            </div>
                          </div>
                        </div>

                        <div className="mt-4 flex flex-col gap-2 border-t border-stone-200 pt-4 text-xs text-slate-500 sm:flex-row sm:items-center sm:justify-between">
                          <div className="flex flex-wrap items-center gap-3">
                            <span>Gas: {tx.gasFee.toFixed(6)} SUI</span>
                            <span className="font-mono">{tx.digest.slice(0, 8)}...{tx.digest.slice(-8)}</span>
                          </div>
                          <a
                            href={tx.explorerUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center font-medium text-slate-700 transition hover:text-slate-950"
                          >
                            View on explorer
                            <svg className="ml-1 h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                            </svg>
                          </a>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root
        open={isCoinbaseLauncherOpen}
        onOpenChange={(open) => {
          if (!open) {
            closeCoinbaseLauncher();
          }
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-slate-950/55 backdrop-blur-sm" />
          <Dialog.Content className={onrampDialogContentClass}>
            <div className="border-b border-[#e7dfd4] bg-[linear-gradient(135deg,rgba(243,246,251,0.96),rgba(251,250,247,0.94))] px-5 py-5 sm:px-7 sm:py-6">
              <div className="flex items-start justify-between gap-3 sm:gap-4">
                <div className="max-w-xl">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-[#717784]">
                    Instant onramp
                  </p>
                  <Dialog.Title className="mt-3 text-[1.75rem] font-semibold leading-[0.98] tracking-[-0.05em] text-[#171923] sm:text-[2rem] sm:leading-tight sm:tracking-[-0.04em]">
                    Buy {onrampAssetLabel}
                  </Dialog.Title>
                  <Dialog.Description className="mt-3 max-w-lg text-sm leading-6 text-[#5f6674]">
                    Secure checkout through a regulated partner with a clean
                    handoff back to your wallet. When the flow completes, the
                    dashboard can refresh balances and onramp status.
                  </Dialog.Description>

                  <div className="mt-5 flex flex-wrap gap-2 sm:gap-3">
                    <span className="inline-flex items-center gap-2 rounded-full border border-[#dde5ef] bg-white px-3 py-1.5 text-xs font-medium text-[#51627b] sm:py-2 sm:text-sm">
                      Local currency supported
                    </span>
                    <span className="inline-flex items-center gap-2 rounded-full border border-[#dde5ef] bg-white px-3 py-1.5 text-xs font-medium text-[#51627b] sm:py-2 sm:text-sm">
                      Opens in secure browser tab
                    </span>
                    <span className="inline-flex items-center gap-2 rounded-full border border-[#dde5ef] bg-white px-3 py-1.5 text-xs font-medium text-[#51627b] sm:py-2 sm:text-sm">
                      Asset: {onrampAssetLabel}
                    </span>
                  </div>
                </div>
                <Dialog.Close
                  className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-[#d7cec1] bg-white text-[#667085] transition-colors hover:bg-[#f6f3ee] hover:text-[#171923] focus:outline-none sm:h-10 sm:w-10"
                  aria-label="Close"
                >
                  <X className="h-4 w-4" />
                </Dialog.Close>
              </div>
            </div>

            <div className="min-h-0 overflow-y-auto overscroll-contain space-y-3 bg-[#f6f3ee]/65 px-5 py-5 sm:space-y-4 sm:px-7 sm:py-6">
              <div className="rounded-[22px] border border-[#e7dfd4] bg-white p-4 shadow-[0_24px_70px_-58px_rgba(15,23,42,0.3)] sm:rounded-[24px] sm:p-5">
                <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-[#717784]">
                  Choose a provider
                </p>
                <RampPicker
                  className="mt-3"
                  walletAddress={userAddress || ''}
                  preferredAssetIntent={coinbaseAssetIntent}
                  amountUsd={50}
                  coinbase={{
                    providerFlag: onrampProviderFlag,
                    disabled: !userAddress,
                    buttonLabel: 'Continue with Coinbase',
                    uiVariant: 'refined',
                    onCancel: handleCoinbaseCancel,
                  }}
                  onLaunched={handleRampLaunched}
                  onProviderError={handleRampProviderError}
                />
              </div>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
