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
import { Eye, EyeOff, Settings, Trash2, CreditCard, RefreshCw, Users, X, Copy, Link, AlertCircle, Send, Shield, Clock, CheckCircle, ExternalLink } from 'lucide-react';
import MoonPayWrapper from '@/components/MoonPayWrapper';
import { getPackageId, getUserPackageIds } from '../services/circle-service';
// Use alias path for the modal import
import ConfirmationModal from '@/components/ConfirmationModal';
import { 
  getCurrentNetwork, 
  getCurrentNetworkConfig, 
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

  // Network-specific RPC URLs - prioritize official Sui RPC endpoints
  const testnetUrls = [
    'https://fullnode.testnet.sui.io:443', // Official Sui RPC first
    'https://sui-testnet.nodeinfra.com',   // Alternative reliable endpoint
    process.env.NEXT_PUBLIC_TESTNET_RPC_URL || 'https://sui-testnet-endpoint.blockvision.org', // BlockVision as fallback
    'https://sui-testnet-endpoint.blockvision.org'
  ];

  const mainnetUrls = [
    'https://fullnode.mainnet.sui.io:443', // Official Sui RPC first
    'https://sui-mainnet.nodeinfra.com',   // Alternative reliable endpoint
    process.env.NEXT_PUBLIC_MAINNET_RPC_URL || 'https://sui-mainnet-endpoint.blockvision.org', // BlockVision as fallback
    'https://sui-mainnet-endpoint.blockvision.org'
  ];

  let rpcUrls = currentNetwork === 'mainnet' ? mainnetUrls : testnetUrls;

  // Filter out blacklisted endpoints if requested
  if (excludeBlacklisted) {
    const originalLength = rpcUrls.length;
    rpcUrls = rpcUrls.filter(url => !isEndpointBlacklisted(url));

    if (rpcUrls.length === 0) {
      console.warn('⚠️ All RPC endpoints are blacklisted, using original list');
      rpcUrls = currentNetwork === 'mainnet' ? mainnetUrls : testnetUrls;
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
    return currentNetwork === 'mainnet'
      ? 'https://fullnode.mainnet.sui.io:443'
      : 'https://fullnode.testnet.sui.io:443';
  }
};

// Helper function to create SuiClient with retries
const createSuiClientWithRetry = (customRpcUrl?: string, retryCount = 0): SuiClient => {
  const maxRetries = 3;
  const rpcUrl = customRpcUrl || getJsonRpcUrl();
  
  try {
    console.log(`Creating SuiClient with URL: ${rpcUrl} (attempt ${retryCount + 1})`);
    return getSuiClientFromPool(rpcUrl);
  } catch (error) {
    console.error(`Failed to create SuiClient (attempt ${retryCount + 1}):`, error);
    
    if (retryCount < maxRetries) {
      console.log(`Retrying SuiClient creation...`);
      return createSuiClientWithRetry(customRpcUrl, retryCount + 1);
    }
    
    throw new Error(`Failed to create SuiClient after ${maxRetries} attempts: ${error}`);
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
        if (error instanceof Error &&
            (error.message.includes('429') || error.message.includes('Too Many Requests') ||
             error.message.includes('rate limit'))) {
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
    // Return current package ID as fallback
    return [getPackageId()];
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
      console.error(`${operationName} failed (attempt ${attempt + 1}):`, error);

      // Enhanced error categorization with 429 detection and multi-package support
      const isRateLimited = error instanceof Error &&
        (error.message.includes('429') || error.message.includes('Too Many Requests') ||
         error.message.includes('rate limit'));

      const isNetworkError = error instanceof TypeError &&
        (error.message.includes('Failed to fetch') || error.message.includes('Network request failed'));

      const isObjectNotFound = error instanceof Error &&
        (error.message.includes('not found') || error.message.includes('does not exist') ||
         error.message.includes('Object does not exist') || error.message.includes('404'));

      // Multi-package specific error: transaction events from different package deployment
      const isCrossPackageError = error instanceof Error &&
        (error.message.includes('Could not find the referenced transaction events') ||
         error.message.includes('referenced transaction') ||
         error.message.includes('TransactionDigest') && error.message.includes('not found'));

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
        console.error(`${operationName} failed after ${maxRetries} attempts`);
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
    const errorMsg = lastError.message || '';

    // These are expected errors for cross-package/cross-network queries
    if (errorMsg.includes('Failed to fetch') ||
        errorMsg.includes('Network request failed') ||
        errorMsg.includes('not found') ||
        errorMsg.includes('does not exist')) {
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
  member_status: number;                  // Member status (0=active, 1=pending, 2=suspended, 3=exited)
  currency_type: string;                  // Currency code (e.g., "USD", "XAF", "NGN")
  contribution_amount_local: string;      // Contribution amount in local currency
  security_deposit_local: string;         // Security deposit in local currency
  deposit_paid: boolean;                  // Whether the member has paid their deposit
  joined_at: string;                      // Timestamp when member joined (as string from blockchain)
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
  <div className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 animate-pulse">
    <div className="flex justify-between items-start mb-4">
      <div className="h-6 bg-gray-200 dark:bg-gray-600 rounded w-3/4"></div>
      <div className="h-5 bg-gray-200 dark:bg-gray-600 rounded w-16"></div>
    </div>
    <div className="space-y-3">
      <div className="h-4 bg-gray-200 dark:bg-gray-600 rounded w-1/2"></div>
      <div className="h-4 bg-gray-200 dark:bg-gray-600 rounded w-2/3"></div>
      <div className="h-4 bg-gray-200 dark:bg-gray-600 rounded w-1/3"></div>
    </div>
    <div className="mt-4 flex justify-between items-center">
      <div className="h-4 bg-gray-200 dark:bg-gray-600 rounded w-1/4"></div>
      <div className="h-8 bg-gray-200 dark:bg-gray-600 rounded w-20"></div>
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
      className="w-5 h-5 mr-2"
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
  VERSION: '1.0.2' // Increment when data structure changes - updated for network fingerprinting
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

export default function Dashboard() {
  console.log('🚨 DASHBOARD COMPONENT RENDERING');
  const router = useRouter();
  const { isAuthenticated, userAddress, account, deleteCircle: authDeleteCircle, sendTokens } = useAuth();
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

  // Add MoonPay state for the React widget
  const [isMoonPayVisible, setIsMoonPayVisible] = useState(false);
  const [moonPayCurrency, setMoonPayCurrency] = useState('usdc');

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
  const [transactionHistory, setTransactionHistory] = useState<any[]>([]);
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

  // MoonPay React components handle SDK loading automatically

  // Open MoonPay widget using React components
  const openMoonPayWidget = (currencyCode: string = 'usdc') => {
    console.log("Buy button clicked", { currencyCode });
    setMoonPayCurrency(currencyCode);
    setIsMoonPayVisible(true);
    toast.success('Opening MoonPay widget...');
  };

  // Close MoonPay widget
  const closeMoonPayWidget = () => {
    setIsMoonPayVisible(false);
  };

  useEffect(() => {
    if (!isAuthenticated) {
      console.log("User not authenticated, redirecting to home");
      router.push('/');
    } else {
      console.log("User is authenticated:", userAddress);
    }
  }, [isAuthenticated, router]);

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
              apiKey: updatedConfig.enoki.apiKey,
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
              apiKey: currentConfig.enoki.apiKey,
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
  const fetchBalance = useCallback(async () => {
    if (!userAddress) return;

    try {
      // Use official Sui RPC for balance checks - no rate limiting needed for simple reads
      const officialRpcUrl = getCurrentNetwork() === 'mainnet'
        ? 'https://fullnode.mainnet.sui.io:443'
        : 'https://fullnode.testnet.sui.io:443';

      const client = getSuiClientFromPool(officialRpcUrl);

      // Simple balance check - no need for rate limiting queue
      console.log('🔍 Fetching SUI balance directly from official Sui RPC...');
      const suiBalance = await client.getBalance({
        owner: userAddress,
        coinType: '0x2::sui::SUI'
      });
      setBalance(suiBalance.totalBalance);

      // Fetch all coins - also simple read operation
      try {
        console.log('🔍 Fetching all coins directly from official Sui RPC...');
        const allCoinsData = await client.getAllCoins({
          owner: userAddress
        });
        
        // Create a map to aggregate coins by symbol
        const coinMap = new Map<string, {coinType: string, symbol: string, balance: string}>();
        
        // Process the coins
        allCoinsData.data.forEach((coin: any) => {
          // Extract coin symbol from the type string with network-aware mapping
          const typeStr = coin.coinType;
          let symbol: string;
          
          // Map known coin types to proper symbols
          if (typeStr === currentNetworkConfig.coinTypes.SUI) {
            symbol = 'SUI';
          } else if (typeStr === currentNetworkConfig.coinTypes.USDC) {
            symbol = 'USDC';
          } else {
            // For unknown types, extract from the end of the type string
            const typeMatch = typeStr.match(/::([^:]+)$/);
            symbol = typeMatch ? typeMatch[1] : typeStr;
          }
          
          // If this symbol already exists in our map, add to its balance
          if (coinMap.has(symbol)) {
            const existingCoin = coinMap.get(symbol)!;
            const newBalance = BigInt(existingCoin.balance) + BigInt(coin.balance);
            coinMap.set(symbol, {
              ...existingCoin,
              balance: newBalance.toString()
            });
          } else {
            // Otherwise, add it as a new entry
            coinMap.set(symbol, {
              coinType: coin.coinType,
              symbol: symbol,
              balance: coin.balance
            });
          }
        });
        
        // Convert the map back to an array
        const processedCoins = Array.from(coinMap.values());
        
        console.log('Aggregated coins by symbol:', processedCoins);
        setAllCoins(processedCoins);
      } catch (error) {
        console.error('Error fetching all coins:', error);
      }
    } catch (error) {
      console.error('Error fetching balance:', error);
      toast.error('Failed to refresh balance');
    }
  }, [userAddress]);

  // Handle manual balance refresh
  const handleRefreshBalance = async () => {
    setIsRefreshingBalance(true);
    try {
      await fetchBalance();
      toast.success('Balance refreshed successfully');
    } catch (error) {
      console.error('Error refreshing balance:', error);
      toast.error('Failed to refresh balance');
    } finally {
      setIsRefreshingBalance(false);
    }
  };

  useEffect(() => {
    fetchBalance();
  }, [userAddress, fetchBalance]);

  // Fetch SUI price - only on page load, no interval
  useEffect(() => {
    const fetchPrice = async () => {
      setIsPriceLoading(true);
      try {
        // Force a refresh of the price to get the latest data
        const price = await priceService.forceRefreshPrice();
        setSuiPrice(price);
        
        // Show error toast if price fetching failed
        if (priceService.getFetchStatus() === 'error') {
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
        console.error('Error in price fetch flow:', error);
        setSuiPrice(null);
      } finally {
        setIsPriceLoading(false);
      }
    };

    fetchPrice();
  }, []);

  // Save selectedCurrency to localStorage when it changes
  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('selectedCurrency', selectedCurrency);
    }
  }, [selectedCurrency]);

  // Update converted balances when currency or balances change
  useEffect(() => {
    const updateConvertedBalances = async () => {
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
    // Ensure boolean conversion is safe
    const isActive = fields.is_active === true || String(fields.is_active).toLowerCase() === 'true'; 
    
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

    // Find the CircleConfig field first
    const circleConfigField = dynamicFields.find(field => 
      field && typeof field === 'object' && 
      (('objectType' in field && typeof field.objectType === 'string' && 
        field.objectType.includes('::njangi_circle_config::CircleConfig')) ||
       ('type' in field && typeof field.type === 'string' && 
        field.type.includes('::njangi_circle_config::CircleConfig')))
    );

    // If we found a CircleConfig field, fetch its details using its objectId
    if (circleConfigField && client) {
      console.log('Found CircleConfig field:', circleConfigField);
      
      // Extract the objectId to fetch the complete CircleConfig object
      const configObjectId = circleConfigField.objectId;
      if (configObjectId && typeof configObjectId === 'string') {
        try {
          console.log(`Fetching complete CircleConfig object with ID: ${configObjectId}`);
          
          // Fetch the complete CircleConfig object
          let configObjectResponse;
          try {
            configObjectResponse = await client.getObject({
              id: configObjectId,
              options: { 
                showContent: true,
                showDisplay: false,
                showType: true
              }
            });
          } catch (error) {
            console.log(`CircleConfig object ${configObjectId} not accessible on ${getCurrentNetwork()}, using fallback values...`);
            // Continue without the config object - we'll use fallback values
            configObjectResponse = { data: null };
          }
          
          if (configObjectResponse.data && configObjectResponse.data.content) {
            console.log('Fetched CircleConfig object:', configObjectResponse.data);
            
            // Access the fields in the fetched object
            if ('fields' in configObjectResponse.data.content) {
              const contentFields = configObjectResponse.data.content.fields;
              console.log('CircleConfig content fields:', contentFields);
              
              // Now try to access the value.fields path
              if (contentFields && typeof contentFields === 'object' && 'value' in contentFields) {
                const valueObj = contentFields.value as Record<string, unknown>;
                
                if (valueObj && typeof valueObj === 'object' && 'fields' in valueObj) {
                  const configFields = valueObj.fields as Record<string, unknown>;
                  console.log('CircleConfig nested fields:', configFields);
                  
                  // Extract max_members value
                  if ('max_members' in configFields) {
                    configValues.maxMembers = Number(configFields.max_members);
                    console.log('Successfully extracted max_members from fetched object:', configValues.maxMembers);
                  }
                  
                  // Extract other config values
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
              }
            }
          }
        } catch (error) {
          console.error(`Error fetching CircleConfig object with ID ${configObjectId}:`, error);
          
          // If the error is a fetch error, it might be due to network mismatch
          if (error instanceof Error && error.message.includes('Failed to fetch')) {
            console.warn(`Circle config object ${configObjectId} not found on current network. This might be from a different network.`);
          }
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
      isActive: isActive,
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
      // First get all package IDs this user has interacted with (cached)
      console.log('🔍 Getting user package IDs...');
      const userPackageIds = await getCachedUserPackageIds(userAddress);
      console.log(`Found ${userPackageIds.length} package IDs for user:`, userPackageIds);
      
      // Collect all admin events across all package IDs
      const allAdminEvents: any[] = [];
      const allMemberEvents: any[] = [];
      
      // Query admin events in parallel across all packages
      const adminEventsData = await batchQueryEvents(
        userPackageIds,
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
        userPackageIds,
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
      // BUT allow circles where user REJOINED after being removed (compare timestamps)
      console.log('🔍 Checking for MemberRemoved events to filter out removed members...');
      const memberRemovedEventsData = await batchQueryEvents(
        userPackageIds,
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
      // This allows us to check if user rejoined AFTER being removed
      const latestRemovalByCircle = new Map<string, number>();
      for (const event of userRemovedEvents) {
        const parsedEvent = event.parsedJson as MemberRemovedEvent;
        const circleId = parsedEvent?.circle_id;
        const removalTimestamp = Number(event.timestampMs || 0);
        
        if (circleId) {
          const existingTimestamp = latestRemovalByCircle.get(circleId) || 0;
          if (removalTimestamp > existingTimestamp) {
            latestRemovalByCircle.set(circleId, removalTimestamp);
            console.log(`⛔ User was removed from circle: ${circleId} at ${new Date(removalTimestamp).toISOString()}`);
          }
        }
      }
      console.log(`⛔ User has been removed from ${latestRemovalByCircle.size} circles`);
      
      // Filter out circles where user was removed BUT allow if they rejoined after removal
      // Note: We DON'T filter admin events - admins can remove themselves from the rotation but still own the circle
      const filteredMemberEvents = userMemberEvents.filter((event: any) => {
        const parsedEvent = event.parsedJson as MemberJoinedEvent;
        const circleId = parsedEvent?.circle_id;
        const joinTimestamp = Number(event.timestampMs || 0);
        
        if (circleId && latestRemovalByCircle.has(circleId)) {
          const latestRemovalTimestamp = latestRemovalByCircle.get(circleId)!;
          
          // If the user joined AFTER they were last removed, they have rejoined - keep this event
          if (joinTimestamp > latestRemovalTimestamp) {
            console.log(`✅ User rejoined circle ${circleId} after removal - keeping (joined: ${new Date(joinTimestamp).toISOString()}, removed: ${new Date(latestRemovalTimestamp).toISOString()})`);
            return true;
          }
          
          // User was removed after this join event - filter it out
          console.log(`🚫 Filtering out circle ${circleId} - user was removed after this join event`);
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
      // Get all package IDs this user has interacted with (cached)
      const userPackageIds = await getCachedUserPackageIds(userAddress);
      console.log(`Loading more circles across ${userPackageIds.length} packages`);
      
      // Collect more events across all package IDs
      const allAdminEvents: any[] = [];
      const allMemberEvents: any[] = [];
      
      // Query each package ID for more admin events
      for (const packageId of userPackageIds) {
        try {
          console.log(`Querying more admin events for package ${packageId}`);

          try {
            const adminResponse = await retryApiCall(
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
      for (const packageId of userPackageIds) {
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
      
      console.log(`📖 Multi-package load more completed: ${results.circles.length} additional circles found across ${userPackageIds.length} packages`);
      
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
    circleIds: string[]
  ): Promise<any[]> => {
    // Wrap entire function to prevent any errors from escaping
    try {
      if (circleIds.length === 0) return [];

      console.log(`💰 Multi-package querying wallet events for ${circleIds.length} circles...`);

      try {
      // Get package IDs that are likely to have wallet events
      // For efficiency, use a cached set of common package IDs
      const packageIdsToCheck = [
        defaultPackageId, // Current package ID
        // Add other known package IDs if needed
      ];
      
      // Try to infer additional package IDs from the circles themselves
      // Each circle event has a _packageId field that we added earlier
      const additionalPackageIds = new Set<string>();
      circleIds.forEach(circleId => {
        // Note: We could extract package info from circle events if available
        // For now, we'll rely on the default and getUserPackageIds
      });
      
      // Get user package IDs as a fallback (though this requires userAddress)
      // For now, focus on the default package and known packages
      
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
                  // Immediately catch and suppress "Failed to fetch" for deleted packages
                  const errorMsg = err instanceof Error ? err.message : String(err);
                  if (errorMsg.includes('Failed to fetch')) {
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
            const errorMsg = queryError instanceof Error ? queryError.message : String(queryError);
            if (errorMsg.includes('Failed to fetch') || errorMsg.includes('not found')) {
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
          const errorMsg = error instanceof Error ? error.message : String(error);
          if (errorMsg.includes('Failed to fetch')) {
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
        console.error('Error in multi-package wallet events query:', error);
        return [];
      }
    } catch (outerError) {
      // Absolute final safety net - ensure function never throws
      console.error('CRITICAL: Unhandled error in queryWalletEventsForCircles:', outerError);
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
    
    const rpcUrl = getCurrentRpcUrl();
    const client = getSuiClientFromPool(rpcUrl);
    
    setIsLoadingHistory(true);
    setHistoryError(null);
    
    try {
      const response = await retryApiCall(
        () => client.queryTransactionBlocks({
          filter: { FromAddress: userAddress },
          options: {
            showInput: true,
            showEvents: true,
            showEffects: true,
            showObjectChanges: false,
            showBalanceChanges: true
          },
          limit: 1000, // No artificial limits with official Sui RPC
          order: 'descending'
        }),
        3,
        1000,
        'fetchTransactionHistory'
      );
      
      const processedTransactions = response.data.map((tx: any) => {
        // Process transaction data for display
        const txData = tx.transaction?.data?.transaction;
        const balanceChanges = tx.balanceChanges || [];
        const timestamp = tx.timestampMs ? new Date(parseInt(tx.timestampMs)) : new Date();
        
        // Determine transaction type and amount
        let type = 'Unknown';
        let amount = '0';
        let tokenType = 'SUI';
        let direction = 'neutral';
        
        // Check balance changes to determine direction and amount
        const userBalanceChange = balanceChanges.find((change: any) => 
          change.owner?.AddressOwner === userAddress
        );
        
        if (userBalanceChange) {
          amount = Math.abs(parseFloat(userBalanceChange.amount) / 1_000_000_000).toFixed(4);
          tokenType = userBalanceChange.coinType?.split('::').pop() || 'SUI';
          direction = parseFloat(userBalanceChange.amount) > 0 ? 'received' : 'sent';
        }
        
        // Determine transaction type from function calls
        if (txData?.transactions) {
          for (const t of txData.transactions) {
            if ('MoveCall' in t) {
              const moveCall = t.MoveCall;
              if (moveCall.module === 'njangi_circles') {
                if (moveCall.function === 'create_circle') type = 'Create Circle';
                else if (moveCall.function === 'join_circle') type = 'Join Circle';
                else if (moveCall.function === 'contribute_to_circle') type = 'Contribute';
                else if (moveCall.function === 'claim_payout') type = 'Claim Payout';
                else if (moveCall.function === 'delete_circle') {
                  type = 'Delete Circle';
                  // For delete_circle, override direction since storage rebate shows as "received"
                  // but it's actually a refund from deleting, not receiving tokens
                  direction = 'neutral';
                }
                else type = 'Circle Action';
              } else if (moveCall.module === 'pay' || moveCall.module === 'transfer') {
                type = direction === 'sent' ? 'Send Tokens' : 'Receive Tokens';
              }
            } else if ('TransferObjects' in t) {
              type = 'Transfer';
            }
          }
        }
        
        return {
          digest: tx.digest,
          timestamp,
          type,
          amount,
          tokenType,
          direction,
          status: tx.effects?.status?.status === 'success' ? 'Success' : 'Failed',
          gasFee: tx.effects?.gasUsed ? 
            (parseFloat(tx.effects.gasUsed.computationCost) + parseFloat(tx.effects.gasUsed.storageCost)) / 1_000_000_000 
            : 0
        };
      });
      
      setTransactionHistory(processedTransactions);
      return processedTransactions;
    } catch (error) {
      console.error('Error fetching transaction history:', error);
      setHistoryError('Failed to load transaction history');
      return [];
    } finally {
      setIsLoadingHistory(false);
    }
  }, [userAddress]);

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
          // Parse event types and filter for relevant ones
          if (event.type && event.parsedJson) {
            if (event.type.includes('CircleCreated')) {
              const eventData = event.parsedJson as CircleCreatedEvent;
              if (eventData.admin === userAddress) {
                circleEvents.push(event);
              }
            } else if (event.type.includes('MemberJoined')) {
              const eventData = event.parsedJson as MemberJoinedEvent;
              if (eventData.member === userAddress) {
                memberEvents.push(event);
              }
            } else if (event.type.includes('CustodyDeposited')) {
              const eventData = event.parsedJson as CustodyDepositedEvent;
              if (eventData.member === userAddress) {
                custodyDepositedEvents.push(event);
              }
            } else if (event.type.includes('CircleActivated')) {
              // CircleActivated events are relevant for all users to know activation status
              activationEvents.push(event);
            } else if (event.type.includes('CustodyWalletCreated')) {
              // Wallet creation events are useful for mapping circle IDs to wallet IDs
              walletEvents.push(event);
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

    // FORCE CLEAR ALL CACHE FOR DEBUGGING
    console.log('🔍 DEBUG: Force clearing all cache for debugging...');
    clearUserCache(userAddress);
    forceRefresh = true;
    
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
      const officialRpcUrl = currentNetwork === 'mainnet'
        ? 'https://fullnode.mainnet.sui.io:443'
        : 'https://fullnode.testnet.sui.io:443';
      console.log('🌍 fetchUserCircles: Using official Sui RPC:', officialRpcUrl);

      // Create the Sui client with official RPC (no retry wrapper needed for simple operations)
      const client = getSuiClientFromPool(officialRpcUrl);
      
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
        // Use cache for initial load if available
        const initialCacheKey = getCacheKey(userAddress, 'initialCircles');
        initialResults = await cachedApiCall(
          initialCacheKey,
          () => queryInitialUserCircles(client, userAddress, currentPackageId, INITIAL_LOAD_SIZE),
          CACHE_CONFIG.CIRCLES_TTL / 2 // Shorter cache for initial load to keep it fresh
        );
        
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
      
      // Get wallet events only for the circles we found (much more efficient)
      let walletEvents: any[] = [];
      if (initialCircleIds.length > 0) {
        setLoadingProgress({ stage: 'fetching_events', current: 2, total: 3, message: 'Loading wallet info...' });
        try {
          walletEvents = await queryWalletEventsForCircles(client, currentPackageId, initialCircleIds);
        } catch (error) {
          console.error('Error fetching wallet events:', error);
          // Continue without wallet events
        }
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
      
      // Batch fetch all dynamic fields at once (2 concurrent max for rate limiting)
      const dynamicFieldsMap = await batchFetchDynamicFields(
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
      );

      // Create wallet map from batched results
      const circleWalletMapFromDynamic = new Map<string, string>();
      for (const [circleId, fields] of dynamicFieldsMap.entries()) {
        for (const field of fields) {
          const fieldName = field?.name && typeof field.name === 'object' && 'type' in field.name ? field.name.type : '';
          const fieldType = field?.type ?? '';
          if ((fieldName as string)?.includes?.('vector<u8>') && (fieldType as string)?.includes?.('wallet_id')) {
            if (field.objectId) {
              try {
                const walletField = await client.getObject({
                  id: field.objectId as string,
                  options: { showContent: true }
                });
                const contentFields = walletField.data?.content && 
                                      typeof walletField.data.content === 'object' && 
                                      'fields' in walletField.data.content ? 
                                      walletField.data.content.fields as { value?: string } : null;
                if (contentFields?.value) {
                  circleWalletMapFromDynamic.set(circleId, contentFields.value);
                }
              } catch (e) {
                // Continue if wallet field fetch fails
              }
            }
          }
        }
      }

      // Merge with event-based wallet map
      const mergedCircleWalletMap = new Map([...circleWalletMap, ...circleWalletMapFromDynamic]);
      // Update the original circleWalletMap with merged data
      for (const [key, value] of mergedCircleWalletMap.entries()) {
        circleWalletMap.set(key, value);
      }
      
      // Create a set of activated circle IDs for quick lookup (empty for now since event-driven approach doesn't fetch activation events separately)
      const activatedCircleIds = new Set<string>();
      // Note: We'll determine activation status from the circle object itself during processing
      console.log('Activated circle IDs from events:', Array.from(activatedCircleIds));
      
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
            const isActiveMember = parsedEvent.member_status === MEMBER_STATUS.ACTIVE || 
                                   parsedEvent.member_status === MEMBER_STATUS.PENDING;
            
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
      
      console.log(`Found ${allUserCircleIds.size} unique circles for user:`, Array.from(allUserCircleIds));

      setLoadingProgress({ stage: 'validating_circles', current: 2, total: 4, message: `Processing ${allUserCircleIds.size} circles on ${getCurrentNetwork()}...` });

      // Skip strict validation - circles from events are already valid
      // Validation was incorrectly filtering out circles from multiple package IDs
      const allCircleIds = Array.from(allUserCircleIds);
      console.log(`✅ Processing ALL ${allCircleIds.length} circles found on ${getCurrentNetwork()} (skipping validation - circles from events are valid)`);
      
      const circleIds = allCircleIds;
      setLoadingProgress({ stage: 'processing_circles', current: 3, total: 4, message: `Processing ${circleIds.length} validated circles...` });

      console.log(`📦 OPTIMIZED: Batch fetching ${circleIds.length} circles using multiGetObjects...`);
      const batchSize = 10; // Reduced from 50 to 10 for better reliability
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
              console.error(`❌ Failed to fetch batch after ${maxRetries} retries:`, error);
              // Continue to next batch instead of failing completely
              batchObjectsData = null;
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
              
              // Check if the circle has been activated
              const isActive = activatedCircleIds.has(circleId);
                
                const safeCircleData = {
                  ...processedCircle,
                  id: processedCircle?.id ?? '',
                  name: typeof processedCircle?.name === 'string' ? processedCircle.name : '',
                  admin: typeof processedCircle?.admin === 'string' ? processedCircle.admin : '',
                  isAdmin: metadata.isAdmin, // Use the metadata to determine if user is admin
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
                  isActive: isActive,
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
        
        // Add delay between batches to avoid overwhelming RPC
        if (i + batchSize < circleIds.length) {
          console.log('Waiting between batches...');
          await new Promise(resolve => setTimeout(resolve, 1000));
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
  }, [userAddress, isBackgroundRefreshing, extractCircleEventsFromTransactions, getAllUserAddresses]); // Updated dependencies

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
    return [...circleList].sort((a, b) => {
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
  }, []);
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
      const officialRpcUrl = getCurrentNetwork() === 'mainnet'
        ? 'https://fullnode.mainnet.sui.io:443'
        : 'https://fullnode.testnet.sui.io:443';
      const client = getSuiClientFromPool(officialRpcUrl);

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
        
        // Refresh the page to update balances
        setTimeout(() => {
          window.location.reload();
        }, 3000);
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

        // Refresh balances after successful transfer
        setTimeout(() => {
          window.location.reload();
        }, 3000);

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

  if (!isAuthenticated || !account) {
    return null;
  }
  return (
    <div className="min-h-screen bg-gray-50">
      {/* Toast Notification */}
      {showToast && (
        <div className="fixed top-4 right-4 bg-gray-900 text-white px-4 py-2 rounded-lg shadow-lg transition-opacity duration-200 flex items-center space-x-2 z-50">
          <svg className="w-5 h-5 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" />
          </svg>
          <span>Address copied to clipboard!</span>
        </div>
      )}

      {/* Testnet Banner */}
      {showTestnetBanner && (
        <div className="bg-amber-50 border-b border-amber-200">
          <div className="max-w-7xl mx-auto py-2 px-3 sm:px-6 lg:px-8">
            <div className="flex items-center justify-between">
              <div className="flex items-center">
                <div className="flex-shrink-0">
                  <svg className="h-5 w-5 text-amber-400" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                    <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                  </svg>
                </div>
                <div className="ml-3 flex-1">
                  <p className="text-sm text-amber-700">
                    You are currently using the Sui Testnet. Funds and transactions are not on the main network.
                  </p>
                </div>
                <div className="ml-4">
                  <a
                    href={`https://faucet.sui.io/?address=${userAddress || ''}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center px-3 py-1.5 border border-amber-300 text-xs font-medium rounded-md text-amber-700 bg-amber-100 hover:bg-amber-200 focus:outline-none focus:ring-2 focus:ring-amber-500 transition-colors duration-200"
                  >
                    <svg className="w-4 h-4 mr-1.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                    </svg>
                    Get Test Tokens
                  </a>
                </div>
              </div>
              <button 
                onClick={dismissTestnetBanner}
                className="rounded-md p-1.5 text-amber-500 hover:bg-amber-100 focus:outline-none focus:ring-2 focus:ring-amber-600"
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

      {/* Network Toggle */}
      <div className="bg-white border-b border-gray-200">
        <div className="max-w-7xl mx-auto py-3 px-3 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-3">
              <span className="text-sm font-medium text-gray-700">Network:</span>
              <div className="flex bg-gray-100 rounded-lg p-1">
                <button
                  onClick={() => switchNetwork('testnet')}
                  className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors duration-200 ${
                    network === 'testnet' 
                      ? 'bg-blue-500 text-white shadow-sm' 
                      : 'text-gray-600 hover:text-gray-900 hover:bg-gray-50'
                  }`}
                >
                  Testnet
                </button>
                <button
                  onClick={() => switchNetwork('mainnet')}
                  className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors duration-200 ${
                    network === 'mainnet' 
                      ? 'bg-green-500 text-white shadow-sm' 
                      : 'text-gray-600 hover:text-gray-900 hover:bg-gray-50'
                  }`}
                >
                  Mainnet
                </button>
              </div>
            </div>
            
            {/* Network Status Indicator */}
            <div className={`inline-flex items-center px-3 py-1.5 rounded-full text-xs font-medium ${
              network === 'mainnet' 
                ? 'bg-green-100 text-green-800' 
                : 'bg-blue-100 text-blue-800'
            }`}>
              <div className={`w-2 h-2 rounded-full mr-2 ${
                network === 'mainnet' ? 'bg-green-400' : 'bg-blue-400'
              }`} />
              {network === 'testnet' ? 'Testnet' : 'Mainnet'}
            </div>
          </div>
        </div>
      </div>

      <main className="max-w-7xl mx-auto py-6 sm:px-6 lg:px-8">
        <div className="px-4 py-6 sm:px-0">
          {/* Profile and Balance Card */}
          <div className="bg-white shadow rounded-lg overflow-hidden">
            <div className="p-6">
              <div className="flex items-center space-x-4">
                <div className="h-16 w-16 rounded-full overflow-hidden bg-gray-200 flex-shrink-0 relative">
                  {account.picture ? (
                    // Use Next.js Image for Google profile pictures
                    <Image
                      src={account.picture}
                      alt="Profile"
                      width={64}
                      height={64}
                      className="object-cover"
                      priority={true}
                      onError={() => {
                        console.error('Error loading Google profile picture');
                      }}
                    />
                  ) : (
                    // Use Next.js Image for fallback avatar
                    <Image
                      src={`https://api.dicebear.com/7.x/micah/svg?seed=${account.sub}`}
                      alt="Profile"
                      width={64}
                      height={64}
                      className="object-cover"
                      priority={true}
                      unoptimized={true} // Required for SVGs
                    />
                  )}
                </div>
                <div className="flex-grow">
                  <h2 className="text-xl font-semibold text-gray-900">
                    Welcome Back{account.name ? `, ${account.name}` : ''}!
                  </h2>
                </div>
              </div>
            </div>
            
            <div className="border-t border-gray-200">
              <div className="grid grid-cols-1 sm:grid-cols-2 divide-y sm:divide-y-0 sm:divide-x divide-gray-200">
                <div className="p-6">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-sm font-medium text-gray-500">Wallet Address</p>
                    <button
                      onClick={() => copyToClipboard(userAddress)}
                      className="text-blue-600 hover:text-blue-700 p-1 rounded-full hover:bg-blue-50 transition-colors duration-200"
                      title="Copy address"
                    >
                      <svg
                        className="w-5 h-5"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth="2"
                          d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3"
                        />
                      </svg>
                    </button>
                  </div>
                  <div className="group relative">
                    <p className="mt-1 text-sm text-gray-900 break-all font-mono">
                      {showFullAddress ? userAddress : shortenAddress(userAddress)}
                    </p>
                    <button
                      onClick={() => setShowFullAddress(!showFullAddress)}
                      className="mt-1 text-xs text-blue-600 hover:text-blue-700"
                    >
                      {showFullAddress ? 'Show less' : 'Show more'}
                    </button>
                  </div>
                </div>
                <div className="p-6">
                  {/* Balance Header - Mobile First Design */}
                  <div className="flex flex-col space-y-3 sm:flex-row sm:items-center sm:justify-between sm:space-y-0 mb-4">
                    <div className="flex items-center space-x-2">
                      <p className="text-sm font-medium text-gray-500">Balance</p>
                      <Tooltip.Provider>
                        <Tooltip.Root>
                          <Tooltip.Trigger asChild>
                            <button
                              onClick={toggleBalanceVisibility}
                              className="p-1 text-gray-400 hover:text-gray-600 rounded-full hover:bg-gray-100 transition-colors duration-200"
                              aria-label={balanceVisible ? 'Hide balance' : 'Show balance'}
                            >
                              {balanceVisible ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
                            </button>
                          </Tooltip.Trigger>
                          <Tooltip.Portal>
                            <Tooltip.Content
                              className="bg-gray-800 text-white px-2 py-1 rounded text-xs"
                              sideOffset={5}
                            >
                              {balanceVisible ? 'Hide balance' : 'Show balance'}
                              <Tooltip.Arrow className="fill-gray-800" />
                            </Tooltip.Content>
                          </Tooltip.Portal>
                        </Tooltip.Root>
                      </Tooltip.Provider>
                      
                      {/* Add Refresh Balance Button */}
                      <Tooltip.Provider>
                        <Tooltip.Root>
                          <Tooltip.Trigger asChild>
                            <button
                              onClick={handleRefreshBalance}
                              disabled={isRefreshingBalance}
                              className={`p-1 text-gray-400 hover:text-gray-600 rounded-full hover:bg-gray-100 transition-colors duration-200 ${
                                isRefreshingBalance ? 'opacity-50 cursor-not-allowed' : ''
                              }`}
                              aria-label="Refresh balance"
                            >
                              <RefreshCw className={`w-4 h-4 ${isRefreshingBalance ? 'animate-spin' : ''}`} />
                            </button>
                          </Tooltip.Trigger>
                          <Tooltip.Portal>
                            <Tooltip.Content
                              className="bg-gray-800 text-white px-2 py-1 rounded text-xs"
                              sideOffset={5}
                            >
                              {isRefreshingBalance ? 'Refreshing...' : 'Refresh balance'}
                              <Tooltip.Arrow className="fill-gray-800" />
                            </Tooltip.Content>
                          </Tooltip.Portal>
                        </Tooltip.Root>
                      </Tooltip.Provider>
                      
                      {/* Transaction History Button */}
                      <Tooltip.Provider>
                        <Tooltip.Root>
                          <Tooltip.Trigger asChild>
                            <button
                              onClick={() => {
                                setIsTransactionHistoryOpen(true);
                                fetchTransactionHistory();
                              }}
                              className="p-1 text-gray-400 hover:text-gray-600 rounded-full hover:bg-gray-100 transition-colors duration-200"
                              aria-label="View transaction history"
                            >
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5H7a2 2 0 00-2 2v10a2 2 0 002 2h8a2 2 0 002-2V7a2 2 0 00-2-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
                              </svg>
                            </button>
                          </Tooltip.Trigger>
                          <Tooltip.Portal>
                            <Tooltip.Content
                              className="bg-gray-800 text-white px-2 py-1 rounded text-xs"
                              sideOffset={5}
                            >
                              Transaction History
                              <Tooltip.Arrow className="fill-gray-800" />
                            </Tooltip.Content>
                          </Tooltip.Portal>
                        </Tooltip.Root>
                      </Tooltip.Provider>
                    </div>
                    
                    {/* Currency Selector - Better Mobile Styling */}
                    <div className="relative w-full sm:w-auto">
                      <select
                        value={selectedCurrency}
                        onChange={(e) => setSelectedCurrency(e.target.value)}
                        className="w-full sm:w-auto text-xs bg-white border border-gray-300 rounded-lg pl-3 pr-8 py-2 shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 appearance-none cursor-pointer"
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
                      {/* Custom dropdown arrow */}
                      <div className="absolute inset-y-0 right-0 flex items-center pr-3 pointer-events-none">
                        <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                        </svg>
                      </div>
                    </div>
                  </div>
                  
                  <div className="space-y-1">
                    <p className="text-2xl font-semibold text-blue-600"> {/* Changed from text-3xl to text-2xl */}
                      {/* Display total wallet value here, formatted with balance visibility */}
                      {balanceVisible 
                        ? formatCurrency(totalWalletLocalValue, selectedCurrency)
                        : formatBalanceDisplay(totalWalletLocalValue, true)
                      }
                    </p>
                    <p className="text-sm text-gray-500 mt-1"> {/* New sub-text */}
                      Total Estimated Value
                    </p>
                  </div>
                  
                  {/* Add Send and Buy buttons */}
                  <div className="mt-4 flex space-x-3">
                    <button
                      onClick={() => setIsTransferDialogOpen(true)}
                      className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 transition-colors duration-200"
                    >
                      <Send className="w-4 h-4 mr-2" />
                      Send
                    </button>
                    <button
                      onClick={() => openMoonPayWidget('usdc')}
                      className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-gradient-to-r from-purple-600 to-blue-600 hover:from-purple-700 hover:to-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-purple-500 transition-all duration-200"
                    >
                      <CreditCard className="w-4 h-4 mr-2" />
                      Buy Crypto
                    </button>
                    {getCurrentNetwork() === 'testnet' && (
                      <a
                        href={`https://faucet.sui.io/?address=${userAddress || ''}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 transition-colors duration-200"
                      >
                        <ExternalLink className="w-4 h-4 mr-2" />
                        Faucet
                      </a>
                    )}
                  </div>
                  
                  {/* Display all coins */}
                  {allCoins.length > 0 && ( // Changed from > 1 to > 0 to always show if any coins exist
                    <div className="mt-6">
                      <p className="text-xs font-medium text-gray-500 mb-2">All Tokens</p>
                      <div className="space-y-3 max-h-60 overflow-y-auto pr-2"> {/* Increased max-h slightly */}
                        {allCoins.map((coin, index) => {
                          const tokenBalance = Number(coin.balance) / getCoinDecimals(coin.coinType); 
                          
                          const convertedValue = convertedBalances[coin.symbol] || 0;
                          
                          return (
                            <div key={index} className="flex items-center justify-between py-2 border-b border-gray-100 last:border-b-0">
                              <div className="flex items-center space-x-3"> {/* Added space-x-3 for icon and name */}
                                <TokenIcon symbol={coin.symbol} />
                                <span className="font-medium text-sm">{coin.symbol}</span>
                              </div>
                              <div className="flex items-center space-x-4"> {/* Added space-x-4 for amounts and button */}
                                <div className="text-right">
                                  <div className="text-sm font-medium text-gray-800">
                                    {balanceVisible 
                                      ? tokenBalance.toFixed(coin.symbol === 'USDC' ? 2 : 4)
                                      : formatBalanceDisplay(tokenBalance)
                                    }
                                  </div>
                                  {(coin.symbol === 'SUI' || coin.symbol === 'USDC') && suiPrice && convertedValue > 0 && (
                                    <div className="text-xs text-gray-500">
                                      {balanceVisible 
                                        ? formatCurrency(convertedValue, selectedCurrency)
                                        : formatBalanceDisplay(convertedValue)
                                      }
                                    </div>
                                  )}
                                </div>
                                {(coin.symbol === 'USDC' || coin.symbol === 'SUI') && (
                                  <button
                                    onClick={() => {
                                      console.log(`Buy ${coin.symbol} button clicked`);
                                      openMoonPayWidget(coin.symbol.toLowerCase());
                                    }}
                                    className="text-xs bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700 text-white px-3 py-1.5 rounded-lg font-medium shadow-sm hover:shadow-md transition-all duration-200 flex items-center space-x-1"
                                    title={`Buy ${coin.symbol} with MoonPay`}
                                  >
                                    <CreditCard className="w-3 h-3" />
                                    <span>Buy</span>
                                  </button>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
          {/* Njangi Circles Section */}
          <div className="mt-8">
                          <div className="bg-white shadow rounded-lg p-6">
                <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center space-y-4 sm:space-y-0 mb-6">
                  <div className="flex items-center space-x-3">
                    <h3 className="text-lg font-medium text-gray-900 text-center sm:text-left">My Njangi Circles</h3>
                    {(isBackgroundRefreshing) && (
                      <div className="flex items-center space-x-2 text-sm text-blue-600">
                        <RefreshCw className="w-4 h-4 animate-spin" />
                        <span>Updating...</span>
                      </div>
                    )}
                  </div>
                  <div className="flex flex-col sm:flex-row space-y-3 sm:space-y-0 sm:space-x-3 w-full sm:w-auto">
                    <button
                      type="button"
                      onClick={handleManualRefresh}
                      disabled={loading || isBackgroundRefreshing}
                      className="w-full sm:w-auto inline-flex items-center justify-center px-3 py-2 border border-gray-300 text-sm font-medium rounded-md shadow-sm text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors duration-200"
                      title="Refresh circles"
                    >
                      <RefreshCw className={`w-4 h-4 mr-2 ${(loading || isBackgroundRefreshing) ? 'animate-spin' : ''}`} />
                      Refresh
                    </button>
                    <button
                      type="button"
                      onClick={() => setIsJoinDialogOpen(true)}
                      className="w-full sm:w-auto inline-flex items-center justify-center px-4 py-2 border border-blue-600 text-sm font-medium rounded-md shadow-sm text-blue-600 bg-white hover:bg-blue-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 transition-colors duration-200"
                    >
                      <Users className="w-5 h-5 mr-2" />
                      Join Circle
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        invalidateCirclesCache();
                        router.push('/create-circle');
                      }}
                      className="w-full sm:w-auto inline-flex items-center justify-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 transition-colors duration-200"
                    >
                      <svg
                        className="w-5 h-5 mr-2"
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
                      Create New Circle
                    </button>
                  </div>
                </div>

              {loading ? (
                <div className="space-y-6">
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                    {Array.from({ length: 6 }, (_, i) => (
                      <CircleCardSkeleton key={i} />
                    ))}
                  </div>
                  <div className="text-center py-4">
                    <div className="text-sm text-gray-500 dark:text-gray-400">
                      {loadingProgress.message}
                    </div>
                    <div className="mt-2 w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2">
                      <div 
                        className="bg-blue-600 h-2 rounded-full transition-all duration-300" 
                        style={{ 
                          width: `${loadingProgress.total > 0 ? (loadingProgress.current / loadingProgress.total) * 100 : 0}%` 
                        }}
                      ></div>
                    </div>
                  </div>
                </div>
              ) : error ? (
                <div className="bg-red-50 rounded-lg p-8 text-center">
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
                  <h3 className="mt-2 text-sm font-medium text-red-900">{error}</h3>
                  <p className="mt-1 text-sm text-red-500">Please try again later.</p>
                  <div className="mt-6">
                    <button
                      type="button"
                      onClick={() => fetchUserCircles()}
                      className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-red-600 hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500 transition-colors duration-200"
                    >
                      Try Again
                    </button>
                  </div>
                </div>
              ) : circles.length > 0 ? (
                <div>
                  <Tab.Group>
                    <Tab.List className="flex space-x-1 rounded-xl bg-blue-50 p-1 mb-6">
                      <Tab
                        className={({ selected }) =>
                          `w-full rounded-lg py-2.5 text-sm font-medium leading-5 transition-colors duration-200
                           ${selected
                            ? 'bg-white text-blue-700 shadow'
                            : 'text-blue-600 hover:bg-white/[0.12] hover:text-blue-700'
                          }`
                        }
                      >
                        All Circles ({circles.length})
                      </Tab>
                      <Tab
                        className={({ selected }) =>
                          `w-full rounded-lg py-2.5 text-sm font-medium leading-5 transition-colors duration-200
                           ${selected
                            ? 'bg-white text-blue-700 shadow'
                            : 'text-blue-600 hover:bg-white/[0.12] hover:text-blue-700'
                          }`
                        }
                      >
                        Administering ({circles.filter(c => c.isAdmin).length})
                      </Tab>
                      <Tab
                        className={({ selected }) =>
                          `w-full rounded-lg py-2.5 text-sm font-medium leading-5 transition-colors duration-200
                           ${selected
                            ? 'bg-white text-blue-700 shadow'
                            : 'text-blue-600 hover:bg-white/[0.12] hover:text-blue-700'
                          }`
                        }
                      >
                        Member Only ({circles.filter(c => !c.isAdmin).length})
                      </Tab>
                    </Tab.List>
                    <Tab.Panels>
                      <Tab.Panel>
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                          {getPaginatedCircles(circles, displayedCirclesCount).map((circle) => (
                            <div key={circle.id} className="bg-white border border-gray-200 rounded-xl overflow-hidden shadow-sm hover:shadow-md transition-shadow duration-200">
                              <div className="p-5 border-b border-gray-100">
                                <div className="flex justify-between items-start">
                                  <h3 className="text-lg font-semibold text-gray-900 line-clamp-1">{circle.name}</h3>
                                  <div className="flex space-x-1">
                                    <span className={`text-xs font-medium px-2 py-1 rounded-full ${circle.isAdmin ? "bg-purple-100 text-purple-800" : "bg-blue-100 text-blue-800"}`}>
                                      {circle.isAdmin ? "Admin" : "Member"}
                                    </span>
                                    <span className={`text-xs font-medium px-2 py-1 rounded-full ${circle.isActive ? "bg-green-100 text-green-800" : "bg-amber-100 text-amber-800"}`}>
                                      {circle.isActive ? "Active" : "Inactive"}
                                    </span>
                                  </div>
                                </div>
                                <div className="mt-2 flex items-center text-sm text-gray-500">
                                  <svg className="mr-1.5 h-4 w-4 flex-shrink-0 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                                  </svg>
                                  {circle.currentMembers} / {circle.maxMembers} members
                                </div>
                                
                                {/* Add circle ID with copy functionality */}
                                <div className="mt-2 flex items-center space-x-1 text-xs text-gray-500">
                                  <span>ID: {shortenId(circle.id)}</span>
                                  <Tooltip.Provider>
                                    <Tooltip.Root>
                                      <Tooltip.Trigger asChild>
                                        <button
                                          onClick={() => copyToClipboard(circle.id, 'circleId')}
                                          className={`text-gray-400 hover:text-blue-600 p-1 rounded-full hover:bg-blue-50 transition-colors duration-200 ${copiedCircleId === circle.id ? 'text-green-500' : ''}`}
                                          aria-label="Copy Circle ID"
                                        >
                                          <Copy size={14} />
                                        </button>
                                      </Tooltip.Trigger>
                                      <Tooltip.Portal>
                                        <Tooltip.Content
                                          className="bg-gray-800 text-white px-2 py-1 rounded text-xs"
                                          sideOffset={5}
                                        >
                                          {copiedCircleId === circle.id ? 'Copied!' : 'Copy Circle ID'}
                                          <Tooltip.Arrow className="fill-gray-800" />
                                        </Tooltip.Content>
                                      </Tooltip.Portal>
                                    </Tooltip.Root>
                                  </Tooltip.Provider>
                                  
                                  {circle.isAdmin && (
                                    <Tooltip.Provider>
                                      <Tooltip.Root>
                                        <Tooltip.Trigger asChild>
                                          <button
                                            onClick={() => copyShareLink(circle.id)}
                                            className="text-gray-400 hover:text-blue-600 p-1 rounded-full hover:bg-blue-50 transition-colors duration-200"
                                            aria-label="Copy Invite Link"
                                          >
                                            <Link size={14} />
                                          </button>
                                        </Tooltip.Trigger>
                                        <Tooltip.Portal>
                                          <Tooltip.Content
                                            className="bg-gray-800 text-white px-2 py-1 rounded text-xs"
                                            sideOffset={5}
                                          >
                                            Copy Invite Link
                                            <Tooltip.Arrow className="fill-gray-800" />
                                          </Tooltip.Content>
                                        </Tooltip.Portal>
                                      </Tooltip.Root>
                                    </Tooltip.Provider>
                                  )}
                                </div>
                              </div>
                              
                              <div className="px-5 py-3 bg-gray-50 text-sm">
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2">
                                  <div>
                                    <p className="text-gray-500">Contribution</p>
                                    <p className="font-medium text-gray-900">
                                      <CurrencyDisplay 
                                        usd={circle.contributionAmountUsd} 
                                        sui={circle.contributionAmount}
                                        currencyType={circle.currencyType} 
                                      />
                                    </p>
                                  </div>
                                  <div>
                                    <p className="text-gray-500">Cycle</p>
                                    <p className="font-medium text-gray-900">{formatCycleInfo(circle.cycleLength, circle.cycleDay)}</p>
                                  </div>
                                  <div>
                                    <p className="text-gray-500">Security Deposit</p>
                                    <p className="font-medium text-gray-900">
                                      <CurrencyDisplay 
                                        usd={circle.securityDepositUsd} 
                                        sui={circle.securityDeposit}
                                        currencyType={circle.currencyType} 
                                      />
                                    </p>
                                  </div>
                                  <div>
                                    <p className="text-gray-500">Next Payout</p>
                                    <p className="font-medium text-gray-900">
                                      {circle.isActive ? formatDate(circle.nextPayoutTime) : "Activate Circle to Start"}
                                    </p>
                                  </div>
                                </div>
                              </div>
                              
                              <div className="p-4 flex justify-between bg-white border-t border-gray-100">
                                <Tooltip.Provider>
                                  <Tooltip.Root>
                                    <Tooltip.Trigger asChild>
                                      <button
                                        onClick={() => router.push(`/circle/${circle.id}`)}
                                        className="text-blue-600 hover:text-blue-800 font-medium p-2 hover:bg-blue-50 rounded-full transition-colors"
                                        aria-label="View Details"
                                      >
                                        <Eye size={18} />
                                      </button>
                                    </Tooltip.Trigger>
                                    <Tooltip.Portal>
                                      <Tooltip.Content
                                        className="bg-gray-800 text-white px-2 py-1 rounded text-xs"
                                        sideOffset={5}
                                      >
                                        View Details
                                        <Tooltip.Arrow className="fill-gray-800" />
                                      </Tooltip.Content>
                                    </Tooltip.Portal>
                                  </Tooltip.Root>
                                </Tooltip.Provider>
                                
                                <div className="flex items-center space-x-2">
                                  {circle.isAdmin && (
                                    <Tooltip.Provider>
                                      <Tooltip.Root>
                                        <Tooltip.Trigger asChild>
                                          <button
                                            onClick={() => router.push(`/circle/${circle.id}/manage`)}
                                            className="text-purple-600 hover:text-purple-800 font-medium p-2 hover:bg-purple-50 rounded-full transition-colors"
                                            aria-label="Manage Circle"
                                          >
                                            <Settings size={18} />
                                          </button>
                                        </Tooltip.Trigger>
                                        <Tooltip.Portal>
                                          <Tooltip.Content
                                            className="bg-gray-800 text-white px-2 py-1 rounded text-xs"
                                            sideOffset={5}
                                          >
                                            Manage
                                            <Tooltip.Arrow className="fill-gray-800" />
                                          </Tooltip.Content>
                                        </Tooltip.Portal>
                                      </Tooltip.Root>
                                    </Tooltip.Provider>
                                  )}
                                  
                                  {circle.isAdmin && deleteableCircles.has(circle.id) && (
                                    <Tooltip.Provider>
                                      <Tooltip.Root>
                                        <Tooltip.Trigger asChild>
                                          <button
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
                                            className={`text-red-600 hover:text-red-800 font-medium p-2 hover:bg-red-50 rounded-full transition-colors ${
                                              isDeleting === circle.id ? 'opacity-50 cursor-not-allowed' : ''
                                            }`}
                                            aria-label="Delete Circle"
                                          >
                                            <Trash2 size={18} />
                                          </button>
                                        </Tooltip.Trigger>
                                        <Tooltip.Portal>
                                          <Tooltip.Content
                                            className="bg-gray-800 text-white px-2 py-1 rounded text-xs"
                                            sideOffset={5}
                                          >
                                            {isDeleting === circle.id ? 'Deleting...' : 'Delete'}
                                            <Tooltip.Arrow className="fill-gray-800" />
                                          </Tooltip.Content>
                                        </Tooltip.Portal>
                                      </Tooltip.Root>
                                    </Tooltip.Provider>
                                  )}
                                  
                                  <Tooltip.Provider>
                                    <Tooltip.Root>
                                      <Tooltip.Trigger asChild>
                                        <button
                                          onClick={() => router.push(`/circle/${circle.id}/contribute`)}
                                          className="text-green-600 hover:text-green-800 font-medium p-2 hover:bg-green-50 rounded-full transition-colors"
                                          aria-label="Contribute"
                                        >
                                          <CreditCard size={18} />
                                        </button>
                                      </Tooltip.Trigger>
                                      <Tooltip.Portal>
                                        <Tooltip.Content
                                          className="bg-gray-800 text-white px-2 py-1 rounded text-xs"
                                          sideOffset={5}
                                        >
                                          Contribute
                                          <Tooltip.Arrow className="fill-gray-800" />
                                        </Tooltip.Content>
                                      </Tooltip.Portal>
                                    </Tooltip.Root>
                                  </Tooltip.Provider>
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                        
                        {/* Load More Button */}
                        {(displayedCirclesCount < getSortedCircles(circles).length || paginationState.hasMoreAdmin || paginationState.hasMoreMember) && (
                          <div className="mt-8 text-center">
                            <button
                              onClick={loadMoreCircles}
                              disabled={isLoadingMore}
                              className="inline-flex items-center px-6 py-3 border border-gray-300 shadow-sm text-base font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors duration-200"
                            >
                              {isLoadingMore ? (
                                <>
                                  <RefreshCw className="animate-spin -ml-1 mr-3 h-5 w-5" />
                                  Loading...
                                </>
                              ) : (
                                <>
                                  Load More Circles
                                  <span className="ml-2 text-sm text-gray-500">
                                    {paginationState.hasMoreAdmin || paginationState.hasMoreMember 
                                      ? '(from server)' 
                                      : `(${getSortedCircles(circles).length - displayedCirclesCount} remaining)`}
                                  </span>
                                </>
                              )}
                            </button>
                          </div>
                        )}
                      </Tab.Panel>
                      
                      <Tab.Panel>
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                          {getPaginatedCircles(circles.filter(c => c.isAdmin), displayedCirclesCount).map((circle) => (
                            <div key={circle.id} className="bg-white border border-gray-200 rounded-xl overflow-hidden shadow-sm hover:shadow-md transition-shadow duration-200">
                              <div className="p-5 border-b border-gray-100">
                                <div className="flex justify-between items-start">
                                  <h3 className="text-lg font-semibold text-gray-900 line-clamp-1">{circle.name}</h3>
                                  <div className="flex space-x-1">
                                    <span className="text-xs font-medium px-2 py-1 rounded-full bg-purple-100 text-purple-800">
                                      Admin
                                    </span>
                                    <span className={`text-xs font-medium px-2 py-1 rounded-full ${circle.isActive ? "bg-green-100 text-green-800" : "bg-amber-100 text-amber-800"}`}>
                                      {circle.isActive ? "Active" : "Inactive"}
                                    </span>
                                  </div>
                                </div>
                                <div className="mt-2 flex items-center text-sm text-gray-500">
                                  <svg className="mr-1.5 h-4 w-4 flex-shrink-0 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                                  </svg>
                                  {circle.currentMembers} / {circle.maxMembers} members
                                </div>
                                
                                {/* Add circle ID with copy functionality */}
                                <div className="mt-2 flex items-center space-x-1 text-xs text-gray-500">
                                  <span>ID: {shortenId(circle.id)}</span>
                                  <Tooltip.Provider>
                                    <Tooltip.Root>
                                      <Tooltip.Trigger asChild>
                                        <button
                                          onClick={() => copyToClipboard(circle.id, 'circleId')}
                                          className={`text-gray-400 hover:text-blue-600 p-1 rounded-full hover:bg-blue-50 transition-colors duration-200 ${copiedCircleId === circle.id ? 'text-green-500' : ''}`}
                                          aria-label="Copy Circle ID"
                                        >
                                          <Copy size={14} />
                                        </button>
                                      </Tooltip.Trigger>
                                      <Tooltip.Portal>
                                        <Tooltip.Content
                                          className="bg-gray-800 text-white px-2 py-1 rounded text-xs"
                                          sideOffset={5}
                                        >
                                          {copiedCircleId === circle.id ? 'Copied!' : 'Copy Circle ID'}
                                          <Tooltip.Arrow className="fill-gray-800" />
                                        </Tooltip.Content>
                                      </Tooltip.Portal>
                                    </Tooltip.Root>
                                  </Tooltip.Provider>
                                  
                                  <Tooltip.Provider>
                                    <Tooltip.Root>
                                      <Tooltip.Trigger asChild>
                                        <button
                                          onClick={() => copyShareLink(circle.id)}
                                          className="text-gray-400 hover:text-blue-600 p-1 rounded-full hover:bg-blue-50 transition-colors duration-200"
                                          aria-label="Copy Invite Link"
                                        >
                                          <Link size={14} />
                                        </button>
                                      </Tooltip.Trigger>
                                      <Tooltip.Portal>
                                        <Tooltip.Content
                                          className="bg-gray-800 text-white px-2 py-1 rounded text-xs"
                                          sideOffset={5}
                                        >
                                          Copy Invite Link
                                          <Tooltip.Arrow className="fill-gray-800" />
                                        </Tooltip.Content>
                                      </Tooltip.Portal>
                                    </Tooltip.Root>
                                  </Tooltip.Provider>
                                </div>
                              </div>
                              
                              <div className="px-5 py-3 bg-gray-50 text-sm">
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2">
                                  <div>
                                    <p className="text-gray-500">Contribution</p>
                                    <p className="font-medium text-gray-900">
                                      <CurrencyDisplay 
                                        usd={circle.contributionAmountUsd} 
                                        sui={circle.contributionAmount}
                                        currencyType={circle.currencyType} 
                                      />
                                    </p>
                                  </div>
                                  <div>
                                    <p className="text-gray-500">Cycle</p>
                                    <p className="font-medium text-gray-900">{formatCycleInfo(circle.cycleLength, circle.cycleDay)}</p>
                                  </div>
                                  <div>
                                    <p className="text-gray-500">Security Deposit</p>
                                    <p className="font-medium text-gray-900">
                                      <CurrencyDisplay 
                                        usd={circle.securityDepositUsd} 
                                        sui={circle.securityDeposit}
                                        currencyType={circle.currencyType} 
                                      />
                                    </p>
                                  </div>
                                  <div>
                                    <p className="text-gray-500">Next Payout</p>
                                    <p className="font-medium text-gray-900">
                                      {circle.isActive ? formatDate(circle.nextPayoutTime) : "Activate Circle to Start"}
                                    </p>
                                  </div>
                                </div>
                              </div>
                              
                              <div className="p-4 flex justify-between bg-white border-t border-gray-100">
                                <Tooltip.Provider>
                                  <Tooltip.Root>
                                    <Tooltip.Trigger asChild>
                                      <button
                                        onClick={() => router.push(`/circle/${circle.id}`)}
                                        className="text-blue-600 hover:text-blue-800 font-medium p-2 hover:bg-blue-50 rounded-full transition-colors"
                                        aria-label="View Details"
                                      >
                                        <Eye size={18} />
                                      </button>
                                    </Tooltip.Trigger>
                                    <Tooltip.Portal>
                                      <Tooltip.Content
                                        className="bg-gray-800 text-white px-2 py-1 rounded text-xs"
                                        sideOffset={5}
                                      >
                                        View Details
                                        <Tooltip.Arrow className="fill-gray-800" />
                                      </Tooltip.Content>
                                    </Tooltip.Portal>
                                  </Tooltip.Root>
                                </Tooltip.Provider>
                                
                                <div className="flex items-center space-x-2">
                                  {circle.isAdmin && (
                                    <Tooltip.Provider>
                                      <Tooltip.Root>
                                        <Tooltip.Trigger asChild>
                                          <button
                                            onClick={() => router.push(`/circle/${circle.id}/manage`)}
                                            className="text-purple-600 hover:text-purple-800 font-medium p-2 hover:bg-purple-50 rounded-full transition-colors"
                                            aria-label="Manage Circle"
                                          >
                                            <Settings size={18} />
                                          </button>
                                        </Tooltip.Trigger>
                                        <Tooltip.Portal>
                                          <Tooltip.Content
                                            className="bg-gray-800 text-white px-2 py-1 rounded text-xs"
                                            sideOffset={5}
                                          >
                                            Manage
                                            <Tooltip.Arrow className="fill-gray-800" />
                                          </Tooltip.Content>
                                        </Tooltip.Portal>
                                      </Tooltip.Root>
                                    </Tooltip.Provider>
                                  )}
                                  
                                  {circle.isAdmin && deleteableCircles.has(circle.id) && (
                                    <Tooltip.Provider>
                                      <Tooltip.Root>
                                        <Tooltip.Trigger asChild>
                                          <button
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
                                            className={`text-red-600 hover:text-red-800 font-medium p-2 hover:bg-red-50 rounded-full transition-colors ${
                                              isDeleting === circle.id ? 'opacity-50 cursor-not-allowed' : ''
                                            }`}
                                            aria-label="Delete Circle"
                                          >
                                            <Trash2 size={18} />
                                          </button>
                                        </Tooltip.Trigger>
                                        <Tooltip.Portal>
                                          <Tooltip.Content
                                            className="bg-gray-800 text-white px-2 py-1 rounded text-xs"
                                            sideOffset={5}
                                          >
                                            {isDeleting === circle.id ? 'Deleting...' : 'Delete'}
                                            <Tooltip.Arrow className="fill-gray-800" />
                                          </Tooltip.Content>
                                        </Tooltip.Portal>
                                      </Tooltip.Root>
                                    </Tooltip.Provider>
                                  )}
                                  
                                  <Tooltip.Provider>
                                    <Tooltip.Root>
                                      <Tooltip.Trigger asChild>
                                        <button
                                          onClick={() => router.push(`/circle/${circle.id}/contribute`)}
                                          className="text-green-600 hover:text-green-800 font-medium p-2 hover:bg-green-50 rounded-full transition-colors"
                                          aria-label="Contribute"
                                        >
                                          <CreditCard size={18} />
                                        </button>
                                      </Tooltip.Trigger>
                                      <Tooltip.Portal>
                                        <Tooltip.Content
                                          className="bg-gray-800 text-white px-2 py-1 rounded text-xs"
                                          sideOffset={5}
                                        >
                                          Contribute
                                          <Tooltip.Arrow className="fill-gray-800" />
                                        </Tooltip.Content>
                                      </Tooltip.Portal>
                                    </Tooltip.Root>
                                  </Tooltip.Provider>
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                        
                        {/* Load More Button for Admin Tab */}
                        {displayedCirclesCount < getSortedCircles(circles.filter(c => c.isAdmin)).length && (
                          <div className="mt-8 text-center">
                            <button
                              onClick={loadMoreCircles}
                              disabled={isLoadingMore}
                              className="inline-flex items-center px-6 py-3 border border-gray-300 shadow-sm text-base font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors duration-200"
                            >
                              {isLoadingMore ? (
                                <>
                                  <RefreshCw className="animate-spin -ml-1 mr-3 h-5 w-5" />
                                  Loading...
                                </>
                              ) : (
                                <>
                                  Load More Circles
                                  <span className="ml-2 text-sm text-gray-500">
                                    ({getSortedCircles(circles.filter(c => c.isAdmin)).length - displayedCirclesCount} remaining)
                                  </span>
                                </>
                              )}
                            </button>
                          </div>
                        )}
                      </Tab.Panel>
                      <Tab.Panel>
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                          {getPaginatedCircles(circles.filter(c => !c.isAdmin), displayedCirclesCount).map((circle) => (
                            <div key={circle.id} className="bg-white border border-gray-200 rounded-xl overflow-hidden shadow-sm hover:shadow-md transition-shadow duration-200">
                              <div className="p-5 border-b border-gray-100">
                                <div className="flex justify-between items-start">
                                  <h3 className="text-lg font-semibold text-gray-900 line-clamp-1">{circle.name}</h3>
                                  <div className="flex space-x-1">
                                    <span className="text-xs font-medium px-2 py-1 rounded-full bg-blue-100 text-blue-800">
                                      Member
                                    </span>
                                    <span className={`text-xs font-medium px-2 py-1 rounded-full ${circle.isActive ? "bg-green-100 text-green-800" : "bg-amber-100 text-amber-800"}`}>
                                      {circle.isActive ? "Active" : "Inactive"}
                                    </span>
                                  </div>
                                </div>
                                <div className="mt-2 flex items-center text-sm text-gray-500">
                                  <svg className="mr-1.5 h-4 w-4 flex-shrink-0 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                                  </svg>
                                  {circle.currentMembers} / {circle.maxMembers} members
                                </div>
                                
                                {/* Add circle ID with copy functionality */}
                                <div className="mt-2 flex items-center space-x-1 text-xs text-gray-500">
                                  <span>ID: {shortenId(circle.id)}</span>
                                  <Tooltip.Provider>
                                    <Tooltip.Root>
                                      <Tooltip.Trigger asChild>
                                        <button
                                          onClick={() => copyToClipboard(circle.id, 'circleId')}
                                          className={`text-gray-400 hover:text-blue-600 p-1 rounded-full hover:bg-blue-50 transition-colors duration-200 ${copiedCircleId === circle.id ? 'text-green-500' : ''}`}
                                          aria-label="Copy Circle ID"
                                        >
                                          <Copy size={14} />
                                        </button>
                                      </Tooltip.Trigger>
                                      <Tooltip.Portal>
                                        <Tooltip.Content
                                          className="bg-gray-800 text-white px-2 py-1 rounded text-xs"
                                          sideOffset={5}
                                        >
                                          {copiedCircleId === circle.id ? 'Copied!' : 'Copy Circle ID'}
                                          <Tooltip.Arrow className="fill-gray-800" />
                                        </Tooltip.Content>
                                      </Tooltip.Portal>
                                    </Tooltip.Root>
                                  </Tooltip.Provider>
                                </div>
                              </div>
                              
                              <div className="px-5 py-3 bg-gray-50 text-sm">
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2">
                                  <div>
                                    <p className="text-gray-500">Contribution</p>
                                    <p className="font-medium text-gray-900">
                                      <CurrencyDisplay 
                                        usd={circle.contributionAmountUsd} 
                                        sui={circle.contributionAmount}
                                        currencyType={circle.currencyType} 
                                      />
                                    </p>
                                  </div>
                                  <div>
                                    <p className="text-gray-500">Cycle</p>
                                    <p className="font-medium text-gray-900">{formatCycleInfo(circle.cycleLength, circle.cycleDay)}</p>
                                  </div>
                                  <div>
                                    <p className="text-gray-500">Security Deposit</p>
                                    <p className="font-medium text-gray-900">
                                      <CurrencyDisplay 
                                        usd={circle.securityDepositUsd} 
                                        sui={circle.securityDeposit}
                                        currencyType={circle.currencyType} 
                                      />
                                    </p>
                                  </div>
                                  <div>
                                    <p className="text-gray-500">Next Payout</p>
                                    <p className="font-medium text-gray-900">
                                      {circle.isActive ? formatDate(circle.nextPayoutTime) : "Activate Circle to Start"}
                                    </p>
                                  </div>
                                </div>
                              </div>
                              
                              <div className="p-4 flex justify-between bg-white border-t border-gray-100">
                                <Tooltip.Provider>
                                  <Tooltip.Root>
                                    <Tooltip.Trigger asChild>
                                      <button
                                        onClick={() => router.push(`/circle/${circle.id}`)}
                                        className="text-blue-600 hover:text-blue-800 font-medium p-2 hover:bg-blue-50 rounded-full transition-colors"
                                        aria-label="View Details"
                                      >
                                        <Eye size={18} />
                                      </button>
                                    </Tooltip.Trigger>
                                    <Tooltip.Portal>
                                      <Tooltip.Content
                                        className="bg-gray-800 text-white px-2 py-1 rounded text-xs"
                                        sideOffset={5}
                                      >
                                        View Details
                                        <Tooltip.Arrow className="fill-gray-800" />
                                      </Tooltip.Content>
                                    </Tooltip.Portal>
                                  </Tooltip.Root>
                                </Tooltip.Provider>
                                
                                <div className="flex items-center space-x-2">
                                  {circle.isAdmin && (
                                    <Tooltip.Provider>
                                      <Tooltip.Root>
                                        <Tooltip.Trigger asChild>
                                          <button
                                            onClick={() => router.push(`/circle/${circle.id}/manage`)}
                                            className="text-purple-600 hover:text-purple-800 font-medium p-2 hover:bg-purple-50 rounded-full transition-colors"
                                            aria-label="Manage Circle"
                                          >
                                            <Settings size={18} />
                                          </button>
                                        </Tooltip.Trigger>
                                        <Tooltip.Portal>
                                          <Tooltip.Content
                                            className="bg-gray-800 text-white px-2 py-1 rounded text-xs"
                                            sideOffset={5}
                                          >
                                            Manage
                                            <Tooltip.Arrow className="fill-gray-800" />
                                          </Tooltip.Content>
                                        </Tooltip.Portal>
                                      </Tooltip.Root>
                                    </Tooltip.Provider>
                                  )}
                                  
                                  {circle.isAdmin && deleteableCircles.has(circle.id) && (
                                    <Tooltip.Provider>
                                      <Tooltip.Root>
                                        <Tooltip.Trigger asChild>
                                          <button
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
                                            className={`text-red-600 hover:text-red-800 font-medium p-2 hover:bg-red-50 rounded-full transition-colors ${
                                              isDeleting === circle.id ? 'opacity-50 cursor-not-allowed' : ''
                                            }`}
                                            aria-label="Delete Circle"
                                          >
                                            <Trash2 size={18} />
                                          </button>
                                        </Tooltip.Trigger>
                                        <Tooltip.Portal>
                                          <Tooltip.Content
                                            className="bg-gray-800 text-white px-2 py-1 rounded text-xs"
                                            sideOffset={5}
                                          >
                                            {isDeleting === circle.id ? 'Deleting...' : 'Delete'}
                                            <Tooltip.Arrow className="fill-gray-800" />
                                          </Tooltip.Content>
                                        </Tooltip.Portal>
                                      </Tooltip.Root>
                                    </Tooltip.Provider>
                                  )}
                                  
                                  <Tooltip.Provider>
                                    <Tooltip.Root>
                                      <Tooltip.Trigger asChild>
                                        <button
                                          onClick={() => router.push(`/circle/${circle.id}/contribute`)}
                                          className="text-green-600 hover:text-green-800 font-medium p-2 hover:bg-green-50 rounded-full transition-colors"
                                          aria-label="Contribute"
                                        >
                                          <CreditCard size={18} />
                                        </button>
                                      </Tooltip.Trigger>
                                      <Tooltip.Portal>
                                        <Tooltip.Content
                                          className="bg-gray-800 text-white px-2 py-1 rounded text-xs"
                                          sideOffset={5}
                                        >
                                          Contribute
                                          <Tooltip.Arrow className="fill-gray-800" />
                                        </Tooltip.Content>
                                      </Tooltip.Portal>
                                    </Tooltip.Root>
                                  </Tooltip.Provider>
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                        
                        {/* Load More Button for Member Only Tab */}
                        {displayedCirclesCount < getSortedCircles(circles.filter(c => !c.isAdmin)).length && (
                          <div className="mt-8 text-center">
                            <button
                              onClick={loadMoreCircles}
                              disabled={isLoadingMore}
                              className="inline-flex items-center px-6 py-3 border border-gray-300 shadow-sm text-base font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors duration-200"
                            >
                              {isLoadingMore ? (
                                <>
                                  <RefreshCw className="animate-spin -ml-1 mr-3 h-5 w-5" />
                                  Loading...
                                </>
                              ) : (
                                <>
                                  Load More Circles
                                  <span className="ml-2 text-sm text-gray-500">
                                    ({getSortedCircles(circles.filter(c => !c.isAdmin)).length - displayedCirclesCount} remaining)
                                  </span>
                                </>
                              )}
                            </button>
                          </div>
                        )}
                      </Tab.Panel>
                    </Tab.Panels>
                  </Tab.Group>
                </div>
              ) : (
              <div className="bg-gray-50 rounded-lg p-8 text-center">
                <svg
                  className="mx-auto h-12 w-12 text-gray-400"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"
                  />
                </svg>
                <h3 className="mt-2 text-sm font-medium text-gray-900">No circles yet</h3>
                <p className="mt-1 text-sm text-gray-500">Get started by creating a new circle or joining an existing one.</p>
                <div className="mt-6 flex justify-center space-x-4">
                  <button
                    type="button"
                    onClick={() => setIsJoinDialogOpen(true)}
                    className="inline-flex items-center justify-center p-3 rounded-full text-blue-600 bg-white border border-blue-600 hover:bg-blue-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 transition-colors duration-200"
                    title="Join Existing Circle"
                  >
                    <Users className="w-6 h-6" />
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      invalidateCirclesCache();
                      router.push('/create-circle');
                    }}
                    className="inline-flex items-center justify-center p-3 rounded-full text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 transition-colors duration-200"
                    title="Create New Circle"
                  >
                    <svg
                      className="w-6 h-6"
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
                  </button>
                </div>
              </div>
              )}
            </div>
          </div>
        </div>
      </main>
      
      {/* Join Circle Dialog */}
      <Dialog.Root open={isJoinDialogOpen} onOpenChange={setIsJoinDialogOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/30 z-50" />
          <Dialog.Content className="fixed top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 bg-white rounded-lg shadow-lg p-6 w-full max-w-md focus:outline-none z-50">
            <div className="flex justify-between items-center mb-4">
              <Dialog.Title className="text-lg font-medium text-gray-900">
                Join a Circle
              </Dialog.Title>
              <Dialog.Close className="text-gray-400 hover:text-gray-500">
                <X className="w-5 h-5" />
              </Dialog.Close>
            </div>
            
            <form onSubmit={handleJoinCircle}>
              <div className="mt-2">
                <label htmlFor="circleId" className="block text-sm font-medium text-gray-700 mb-1">
                  Enter Circle ID or Invite Link
                </label>
                <input
                  type="text"
                  id="circleId"
                  value={circleIdInput}
                  onChange={(e) => setCircleIdInput(e.target.value)}
                  placeholder="0x123... or full invite link"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                />
                <p className="mt-1 text-sm text-gray-500">
                  Paste the circle ID or the complete invite link to join
                </p>
              </div>
              
              <div className="mt-6 flex justify-end space-x-3">
                <button
                  type="button"
                  onClick={() => setIsJoinDialogOpen(false)}
                  className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 text-sm font-medium text-white bg-blue-600 border border-transparent rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
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
          <Dialog.Overlay className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50" />
          <Dialog.Content className="fixed top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 bg-white rounded-xl shadow-2xl w-full max-w-md max-h-[90vh] overflow-y-auto focus:outline-none z-50">
            
            {/* Header */}
            <div className="flex justify-between items-center p-6 border-b border-gray-200">
              <div className="flex items-center space-x-3">
                <div className="p-2 bg-blue-100 rounded-lg">
                  <Send className="w-5 h-5 text-blue-600" />
                </div>
                <div>
                  <Dialog.Title className="text-lg font-semibold text-gray-900">
                    Send Tokens
                  </Dialog.Title>
                  <p className="text-sm text-gray-500">
                    {transferStep === 'form' && 'Enter transfer details'}
                    {transferStep === 'review' && 'Review your transfer'}
                    {transferStep === 'confirm' && 'Confirming transaction...'}
                    {transferStep === 'success' && 'Transfer completed!'}
                  </p>
                </div>
              </div>
              <Dialog.Close className="text-gray-400 hover:text-gray-500 p-1 rounded-full hover:bg-gray-100 transition-colors">
                <X className="w-5 h-5" />
              </Dialog.Close>
            </div>

            {/* Progress Steps */}
            <div className="px-6 py-4 bg-gray-50">
              <div className="flex items-center justify-between">
                {['form', 'review', 'confirm', 'success'].map((step, index) => (
                  <div key={step} className="flex items-center">
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium ${
                      transferStep === step 
                        ? 'bg-blue-600 text-white' 
                        : ['review', 'confirm', 'success'].includes(transferStep) && index < ['form', 'review', 'confirm', 'success'].indexOf(transferStep)
                          ? 'bg-green-500 text-white'
                          : 'bg-gray-200 text-gray-500'
                    }`}>
                      {['review', 'confirm', 'success'].includes(transferStep) && index < ['form', 'review', 'confirm', 'success'].indexOf(transferStep) 
                        ? <CheckCircle className="w-4 h-4" />
                        : index + 1
                      }
                    </div>
                    {index < 3 && (
                      <div className={`w-12 h-0.5 mx-2 ${
                        ['review', 'confirm', 'success'].includes(transferStep) && index < ['form', 'review', 'confirm', 'success'].indexOf(transferStep)
                          ? 'bg-green-500'
                          : 'bg-gray-200'
                      }`} />
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* Form Step */}
            {transferStep === 'form' && (
              <div className="p-6 space-y-6">
                {/* Token Selection */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Select Token
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    {allCoins.map((coin) => {
                      const decimals = getCoinDecimals(coin.coinType);
                      const balance = Number(coin.balance) / decimals;
                      return (
                        <button
                          key={coin.symbol}
                          onClick={() => {
                            setGasError(null); // Clear gas error when switching tokens
                            setTransferForm(prev => ({ ...prev, selectedToken: coin.symbol }));
                          }}
                          className={`p-3 rounded-lg border-2 transition-all ${
                            transferForm.selectedToken === coin.symbol
                              ? 'border-blue-500 bg-blue-50'
                              : 'border-gray-200 hover:border-gray-300'
                          }`}
                        >
                          <div className="flex items-center space-x-2">
                            <TokenIcon symbol={coin.symbol} />
                            <div className="text-left">
                              <div className="font-medium text-sm">{coin.symbol}</div>
                              <div className="text-xs text-gray-500">
                                {balance.toFixed(coin.symbol === 'SUI' ? 4 : 2)}
                              </div>
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Recipient Address */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Recipient Address
                  </label>
                  <div className="space-y-2">
                    <input
                      type="text"
                      value={transferForm.recipientAddress}
                      onChange={(e) => setTransferForm(prev => ({ ...prev, recipientAddress: e.target.value }))}
                      placeholder="0x... or paste full address"
                      className={`w-full px-3 py-2 border rounded-lg shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                        transferValidation.errors.recipientAddress 
                          ? 'border-red-300 focus:border-red-500 focus:ring-red-500' 
                          : 'border-gray-300 focus:border-blue-500'
                      }`}
                    />
                    {transferValidation.errors.recipientAddress && (
                      <p className="text-sm text-red-600 flex items-center">
                        <AlertCircle className="w-4 h-4 mr-1" />
                        {transferValidation.errors.recipientAddress}
                      </p>
                    )}
                  </div>

                  {/* Recent Contacts */}
                  {recentContacts.length > 0 && (
                    <div className="mt-3">
                      <p className="text-xs font-medium text-gray-500 mb-2">Recent Contacts</p>
                      <div className="flex flex-wrap gap-1">
                        {recentContacts.slice(0, 3).map((contact) => (
                          <button
                            key={contact.address}
                            onClick={() => setTransferForm(prev => ({ ...prev, recipientAddress: contact.address }))}
                            className="px-2 py-1 text-xs bg-gray-100 hover:bg-gray-200 rounded-md transition-colors"
                          >
                            {contact.name || `${contact.address.slice(0, 6)}...${contact.address.slice(-4)}`}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                {/* Amount */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Amount
                  </label>
                  <div className="space-y-2">
                    <div className="relative">
                      <input
                        type="number"
                        step="any"
                        value={transferForm.amount}
                        onChange={(e) => {
                          setGasError(null); // Clear gas error when user types
                          setTransferForm(prev => ({ ...prev, amount: e.target.value }));
                        }}
                        placeholder="0.00"
                        className={`w-full px-3 py-2 pr-16 border rounded-lg shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                          transferValidation.errors.amount || transferValidation.errors.balance
                            ? 'border-red-300 focus:border-red-500 focus:ring-red-500' 
                            : 'border-gray-300 focus:border-blue-500'
                        }`}
                      />
                      <div className="absolute inset-y-0 right-0 flex items-center pr-3">
                        <span className="text-sm text-gray-500">{transferForm.selectedToken}</span>
                      </div>
                    </div>
                    
                    {/* Quick Amount Buttons */}
                    <div className="space-y-2">
                      <div className="flex space-x-2">
                        {getQuickPercentages().map((percentage) => (
                          <button
                            key={percentage}
                            onClick={() => setPercentageAmount(percentage)}
                            className="px-2 py-1 text-xs bg-gray-100 hover:bg-gray-200 rounded transition-colors"
                          >
                            {percentage}%
                          </button>
                        ))}
                        <button
                          onClick={setMaxAmount}
                          className="px-2 py-1 text-xs bg-blue-100 hover:bg-blue-200 text-blue-700 rounded transition-colors"
                        >
                          Max
                        </button>
                      </div>
                      
                      {/* Gas Information for SUI transfers */}
                      {transferForm.selectedToken === 'SUI' && !gasError && (
                        <div className="text-xs text-gray-500 flex items-center space-x-1">
                          <span>ⓘ</span>
                          <span>
                            Percentages calculated after reserving {getCurrentNetwork() === 'mainnet' ? '0.015' : '0.01'} SUI for gas
                          </span>
                        </div>
                      )}
                      
                      {/* Modern Gas Error Component */}
                      {gasError && (
                        <div className="flex items-start space-x-3 p-4 bg-red-50 border border-red-200 rounded-xl">
                          <div className="flex-shrink-0">
                            <div className="w-6 h-6 bg-red-100 rounded-full flex items-center justify-center">
                              <AlertCircle className="w-4 h-4 text-red-600" />
                            </div>
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-red-800">
                              Insufficient Balance
                            </p>
                            <p className="text-sm text-red-700 mt-1">
                              {gasError}
                            </p>
                          </div>
                          <button
                            onClick={() => setGasError(null)}
                            className="flex-shrink-0 text-red-400 hover:text-red-600 transition-colors"
                          >
                            <X className="w-4 h-4" />
                          </button>
                        </div>
                      )}
                    </div>

                    {/* USD Value Display */}
                    {transferForm.amount && !isNaN(parseFloat(transferForm.amount)) && (
                      <div className="text-sm text-gray-500">
                        {transferForm.selectedToken === 'SUI' && suiPrice && (
                          <>≈ ${(parseFloat(transferForm.amount) * suiPrice).toFixed(2)} USD</>
                        )}
                        {transferForm.selectedToken === 'USDC' && (
                          <>≈ ${parseFloat(transferForm.amount).toFixed(2)} USD</>
                        )}
                      </div>
                    )}

                    {(transferValidation.errors.amount || transferValidation.errors.balance) && (
                      <p className="text-sm text-red-600 flex items-center">
                        <AlertCircle className="w-4 h-4 mr-1" />
                        {transferValidation.errors.amount || transferValidation.errors.balance}
                      </p>
                    )}
                  </div>
                </div>

                {/* Advanced Options */}
                <div>
                  <button
                    onClick={() => setShowAdvancedOptions(!showAdvancedOptions)}
                    className="flex items-center text-sm text-blue-600 hover:text-blue-700"
                  >
                    Advanced Options
                    <svg className={`w-4 h-4 ml-1 transition-transform ${showAdvancedOptions ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </button>
                  
                  {showAdvancedOptions && (
                    <div className="mt-3 space-y-3">
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          Memo (Optional)
                        </label>
                        <input
                          type="text"
                          value={transferForm.memo || ''}
                          onChange={(e) => setTransferForm(prev => ({ ...prev, memo: e.target.value }))}
                          placeholder="Add a note for this transfer"
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                          maxLength={100}
                        />
                      </div>
                    </div>
                  )}
                </div>

                {/* Warnings */}
                {Object.keys(transferValidation.warnings).length > 0 && (
                  <div className="space-y-2">
                    {Object.entries(transferValidation.warnings).map(([key, warning]) => (
                      <div key={key} className="flex items-start p-3 bg-amber-50 border border-amber-200 rounded-lg">
                        <Shield className="w-4 h-4 text-amber-600 mr-2 mt-0.5 flex-shrink-0" />
                        <p className="text-sm text-amber-800">{warning}</p>
                      </div>
                    ))}
                  </div>
                )}

                {/* Action Buttons */}
                <div className="flex space-x-3 pt-4">
                  <button
                    onClick={resetTransferDialog}
                    className="flex-1 px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => setTransferStep('review')}
                    disabled={!transferValidation.isValid}
                    className="flex-1 px-4 py-2 text-sm font-medium text-white bg-blue-600 border border-transparent rounded-lg hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    Review Transfer
                  </button>
                </div>
              </div>
            )}

            {/* Review Step */}
            {transferStep === 'review' && (
              <div className="p-6 space-y-6">
                <div className="bg-gray-50 rounded-lg p-4 space-y-3">
                  <h3 className="font-medium text-gray-900">Transfer Summary</h3>
                  
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span className="text-gray-500">From:</span>
                      <span className="font-mono">{shortenAddress(userAddress)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500">To:</span>
                      <span className="font-mono">{shortenAddress(transferForm.recipientAddress)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500">Amount:</span>
                      <span className="font-medium">{transferForm.amount} {transferForm.selectedToken}</span>
                    </div>
                    {transferForm.selectedToken === 'SUI' && suiPrice && (
                      <div className="flex justify-between">
                        <span className="text-gray-500">USD Value:</span>
                        <span>≈ ${(parseFloat(transferForm.amount) * suiPrice).toFixed(2)}</span>
                      </div>
                    )}
                    {transferForm.selectedToken === 'USDC' && (
                      <div className="flex justify-between">
                        <span className="text-gray-500">USD Value:</span>
                        <span>≈ ${parseFloat(transferForm.amount).toFixed(2)}</span>
                      </div>
                    )}
                    <div className="flex justify-between">
                      <span className="text-gray-500">Network:</span>
                      <span>Sui {getCurrentNetwork() === 'mainnet' ? 'Mainnet' : 'Testnet'}</span>
                    </div>
                    {transferForm.memo && (
                      <div className="flex justify-between">
                        <span className="text-gray-500">Memo:</span>
                        <span className="text-right max-w-32 truncate">{transferForm.memo}</span>
                      </div>
                    )}
                  </div>
                </div>

                {/* Security Checklist */}
                <div className="bg-blue-50 rounded-lg p-4">
                  <h4 className="font-medium text-blue-900 mb-2 flex items-center">
                    <Shield className="w-4 h-4 mr-2" />
                    Security Checklist
                  </h4>
                  <div className="space-y-2 text-sm text-blue-800">
                    <div className="flex items-center">
                      <CheckCircle className="w-4 h-4 mr-2 text-green-600" />
                      Recipient address format is valid
                    </div>
                    <div className="flex items-center">
                      <CheckCircle className="w-4 h-4 mr-2 text-green-600" />
                      Sufficient balance available
                    </div>
                    <div className="flex items-center">
                      <CheckCircle className="w-4 h-4 mr-2 text-green-600" />
                      Gas fees reserved (SUI transfers)
                    </div>
                  </div>
                </div>

                <div className="flex space-x-3">
                  <button
                    onClick={() => setTransferStep('form')}
                    className="flex-1 px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 transition-colors"
                  >
                    Back
                  </button>
                  <button
                    onClick={handleTransferSubmit}
                    disabled={isTransferring}
                    className="flex-1 px-4 py-2 text-sm font-medium text-white bg-blue-600 border border-transparent rounded-lg hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {isTransferring ? 'Confirming...' : 'Confirm Transfer'}
                  </button>
                </div>
              </div>
            )}

            {/* Confirm Step */}
            {transferStep === 'confirm' && (
              <div className="p-6 text-center space-y-4">
                <div className="w-16 h-16 mx-auto bg-blue-100 rounded-full flex items-center justify-center">
                  <Clock className="w-8 h-8 text-blue-600 animate-pulse" />
                </div>
                <div>
                  <h3 className="text-lg font-medium text-gray-900">Processing Transfer</h3>
                  <p className="text-sm text-gray-500 mt-1">
                    Please wait while we process your transaction on the Sui network...
                  </p>
                </div>
              </div>
            )}

            {/* Success Step */}
            {transferStep === 'success' && transferResult && (
              <div className="p-6 text-center space-y-4">
                <div className="w-16 h-16 mx-auto bg-green-100 rounded-full flex items-center justify-center">
                  <CheckCircle className="w-8 h-8 text-green-600" />
                </div>
                <div>
                  <h3 className="text-lg font-medium text-gray-900">Transfer Successful!</h3>
                  <p className="text-sm text-gray-500 mt-1">
                    Your {transferForm.amount} {transferForm.selectedToken} has been sent successfully.
                  </p>
                </div>

                {transferResult.digest && (
                  <div className="bg-gray-50 rounded-lg p-3">
                    <p className="text-xs text-gray-500 mb-1">Transaction Hash:</p>
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-xs text-gray-700">
                        {transferResult.digest.slice(0, 20)}...{transferResult.digest.slice(-10)}
                      </span>
                      <button
                        onClick={() => copyToClipboard(transferResult.digest || '')}
                        className="text-blue-600 hover:text-blue-700 p-1"
                      >
                        <Copy className="w-4 h-4" />
                      </button>
                    </div>
                    <a
                      href={`https://testnet.suivision.xyz/txblock/${transferResult.digest}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center text-xs text-blue-600 hover:text-blue-700 mt-2"
                    >
                      View on Explorer
                      <ExternalLink className="w-3 h-3 ml-1" />
                    </a>
                  </div>
                )}

                <button
                  onClick={resetTransferDialog}
                  className="w-full px-4 py-2 text-sm font-medium text-white bg-blue-600 border border-transparent rounded-lg hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 transition-colors"
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
          <Dialog.Overlay className="fixed inset-0 bg-black bg-opacity-50 z-40" />
          <Dialog.Content className="fixed left-1/2 top-1/2 transform -translate-x-1/2 -translate-y-1/2 bg-white rounded-lg shadow-xl z-50 w-full max-w-2xl mx-4 max-h-[90vh] overflow-hidden">
            <div className="flex items-center justify-between p-6 border-b border-gray-200">
              <div>
                <Dialog.Title className="text-lg font-semibold text-gray-900">Transaction History</Dialog.Title>
                <Dialog.Description className="text-sm text-gray-500 mt-1">
                  Recent transactions from your wallet
                </Dialog.Description>
              </div>
              <Dialog.Close className="text-gray-400 hover:text-gray-600 focus:outline-none">
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </Dialog.Close>
            </div>
            
            <div className="p-6 overflow-y-auto max-h-[calc(90vh-120px)]">
              {isLoadingHistory ? (
                <div className="flex items-center justify-center py-8">
                  <div className="flex items-center space-x-3">
                    <svg className="animate-spin h-5 w-5 text-blue-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                    <span className="text-gray-600">Loading transaction history...</span>
                  </div>
                </div>
              ) : historyError ? (
                <div className="flex items-center justify-center py-8">
                  <div className="text-center">
                    <svg className="w-12 h-12 text-red-400 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
                    </svg>
                    <p className="text-gray-600 mb-2">{historyError}</p>
                    <button
                      onClick={fetchTransactionHistory}
                      className="text-blue-600 hover:text-blue-700 text-sm font-medium"
                    >
                      Try again
                    </button>
                  </div>
                </div>
              ) : transactionHistory.length === 0 ? (
                <div className="flex items-center justify-center py-8">
                  <div className="text-center">
                    <svg className="w-12 h-12 text-gray-300 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                    </svg>
                    <p className="text-gray-500">No transactions found</p>
                    <p className="text-sm text-gray-400 mt-1">Your transaction history will appear here</p>
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  {transactionHistory.map((tx) => (
                    <div key={tx.digest} className="bg-gray-50 rounded-lg p-4 hover:bg-gray-100 transition-colors">
                      <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center space-x-3">
                          <div className={`w-8 h-8 rounded-full flex items-center justify-center ${
                            tx.direction === 'received' ? 'bg-green-100 text-green-600' :
                            tx.direction === 'sent' ? 'bg-red-100 text-red-600' :
                            'bg-blue-100 text-blue-600'
                          }`}>
                            {tx.direction === 'received' ? (
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4v16m8-8l-8 8-8-8" />
                              </svg>
                            ) : tx.direction === 'sent' ? (
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 20V4m8 8l-8-8-8 8" />
                              </svg>
                            ) : (
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 9l4-4 4 4m0 6l-4 4-4-4" />
                              </svg>
                            )}
                          </div>
                          <div>
                            <p className="font-medium text-gray-900">{tx.type}</p>
                            <p className="text-sm text-gray-500">{tx.timestamp.toLocaleString()}</p>
                          </div>
                        </div>
                        <div className="text-right">
                          <p className={`font-semibold ${
                            tx.direction === 'received' ? 'text-green-600' :
                            tx.direction === 'sent' ? 'text-red-600' :
                            'text-gray-900'
                          }`}>
                            {tx.direction === 'received' ? '+' : tx.direction === 'sent' ? '-' : ''}{tx.amount} {tx.tokenType}
                          </p>
                          <div className="flex items-center justify-end space-x-2 mt-1">
                            <span className={`inline-flex px-2 py-1 text-xs font-medium rounded-full ${
                              tx.status === 'Success' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
                            }`}>
                              {tx.status}
                            </span>
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center justify-between text-xs text-gray-500">
                        <div className="flex items-center space-x-4">
                          <span>Gas: {tx.gasFee.toFixed(6)} SUI</span>
                          <a
                            href={`https://${getCurrentNetwork() === 'mainnet' ? 'suiscan.xyz' : 'testnet.suivision.xyz'}/tx/${tx.digest}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-blue-600 hover:text-blue-700 inline-flex items-center"
                          >
                            View on explorer
                            <svg className="w-3 h-3 ml-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                            </svg>
                          </a>
                        </div>
                        <span className="font-mono">{tx.digest.slice(0, 8)}...{tx.digest.slice(-8)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {/* MoonPay Buy Widget */}
      <MoonPayWrapper
        variant="overlay"
        baseCurrencyCode="usd"
        baseCurrencyAmount="50"
        defaultCurrencyCode={moonPayCurrency}
        walletAddress={userAddress || undefined}
        visible={isMoonPayVisible}
        onClose={async () => closeMoonPayWidget()}
      />
    </div>
  );
} 