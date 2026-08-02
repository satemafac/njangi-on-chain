import React, { useEffect, useState, useRef } from 'react';
import { useRouter } from 'next/router';
import { useAuth } from '../../../../contexts/AuthContext';
import { SuiClient } from '@mysten/sui/client';
import { toast } from 'react-hot-toast';
import { ArrowLeft } from 'lucide-react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { priceService } from '../../../../services/price-service';
import { PACKAGE_ID, getCirclePackageId, getSuiClientFromPool } from '../../../../services/circle-service';
import SimplifiedSwapUI from '../../../../components/SimplifiedSwapUI';
import { getCoinType } from '../../../../config/constants';
import {
  getCurrentRpcUrl,
  getCurrentNetwork,
  getCurrentCoinTypes,
  getCurrentTokens,
} from '../../../../services/network-config';
import { cetusService } from '../../../../lib/cetus-service';
import { ZkLoginClient } from '@/services/zkLoginClient';
import { isSwapsEnabled } from '@/config/feature-flags';
import RampPicker from '@/components/RampPicker';
import CycleEscrowPanel from '@/components/CycleEscrowPanel';
import { resolveCircleSettlementCoin } from '@/lib/circle-settlement';
import { getSuiRpcErrorMessage, isTransientSuiRpcError, logSuiReadError } from '@/services/sui-rpc-failover';
import { readObject, invalidateObject } from '@/lib/sui-read';
import type { NetworkType } from '@/services/whatsapp-registry-service';
import { lookupMemberNames } from '@/lib/member-name-lookup';
import { useTranslation } from '@/hooks/useTranslation';
import {
  mapCurrencyCodeToIntent,
  normalizeOnrampProviderFlag,
} from '@/lib/onramp-provider';
import { RAMP_PROVIDER_LABELS, type RampProviderId } from '@/lib/ramp-geo';
import { getCircleConfigFieldsFromDynamicFields } from '@/lib/circle-config';
import { resolveCircleLifecycleState } from '@/lib/circle-chain';
import type { CoinbaseAssetIntent } from '@/types/coinbase-onramp';

// Add this helper function at the top level
function getJsonRpcUrl(): string {
  return getCurrentRpcUrl();
}

// Constants for transaction calculations
const ESTIMATED_GAS_FEE = 0.00021; // Gas fee in SUI
const DEFAULT_SLIPPAGE = 0.5; // Default slippage percentage
const BUFFER_PERCENTAGE = 1.5; // Additional buffer percentage for swap rate fluctuations
const TOKEN_ASSIST_SWAP_GAS_RESERVE_SUI = 0.005;
const TOKEN_ASSIST_EXTRA_OUTPUT_BUFFER_PERCENT = 0.5;
// Requires BOTH its own opt-in and the global swaps capability, so the v1
// swap kill switch cannot be bypassed by leaving this legacy flag set.
const ENABLE_SWAP_AND_DEPOSIT_FORM =
  process.env.NEXT_PUBLIC_ENABLE_SWAP_AND_DEPOSIT_FORM === 'true' && isSwapsEnabled();
const ONE_CLICK_GAS_RESERVE_SUI = 0.005;
const onrampProviderFlag = normalizeOnrampProviderFlag(
  process.env.NEXT_PUBLIC_ONRAMP_PROVIDER,
);

// Helper function to format USD amounts - MOVED TO MODULE SCOPE
const formatUSD = (amount: number): string => {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(amount);
};

type PaymentCurrency = 'USDC' | 'SUI';

const formatUsdCentsAsUsdc = (usdCents: number): string => {
  const cents = Number.isFinite(usdCents) ? usdCents : 0;
  return `${formatUSD(cents / 100)} USDC`;
};

// Format currency value based on currency type - MOVED TO MODULE SCOPE
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
    'XAF': { symbol: 'FCFA', locale: 'fr-CM', code: 'XAF', customFormat: true, position: 'after' }, // XAF specific formatting
    'NGN': { symbol: '₦', locale: 'en-NG', code: 'NGN' },
    'EUR': { symbol: '€', locale: 'de-DE', code: 'EUR' },
    'GBP': { symbol: '£', locale: 'en-GB', code: 'GBP' },
    'CAD': { symbol: 'C$', locale: 'en-CA', code: 'CAD', customFormat: true, position: 'before' },
    'ZAR': { symbol: 'R', locale: 'en-ZA', code: 'ZAR', customFormat: true, position: 'before' },
    'KES': { symbol: 'KSh', locale: 'en-KE', code: 'KES', customFormat: true, position: 'before' },
    'EGP': { symbol: 'E£', locale: 'en-US', code: 'EGP', customFormat: true, position: 'before' }, // Using en-US for EGP to avoid potential right-to-left issues with symbol
    'MAD': { symbol: 'MAD', locale: 'en-US', code: 'MAD', customFormat: true, position: 'before' }, // Using en-US for MAD
    'GHS': { symbol: 'GH₵', locale: 'en-GH', code: 'GHS', customFormat: true, position: 'before' } // Added GHS
  };

  const format = currencyFormats[currencyType] || currencyFormats['USD'];
  
  try {
    return new Intl.NumberFormat(format.locale, {
      style: 'currency',
      currency: format.code,
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    // Fallback for unsupported locales
    return `${format.symbol}${amount.toFixed(2)}`;
  }
};

type ContributeSectionKey = 'wallet' | 'circle' | 'payment';

// IMPORTANT: The values in CircleConfig are stored as follows:
// - contribution_amount: SUI amount with 9 decimals (MIST)
// - contribution_amount_usd: USD amount in cents (e.g., 20 = $0.20)
// - security_deposit: SUI amount with 9 decimals (MIST)
// - security_deposit_usd: USD amount in cents (e.g., 20 = $0.20)
//
// For USDC deposits (6 decimals), the validation compares the USDC amount with 
// security_deposit_usd * 10000. For example:
// $0.20 USD (20 cents) should be exactly 200,000 microUSDC (0.2 USDC with 6 decimals).
// 
// For SUI deposits, the validation requires an EXACT match with the security_deposit
// value stored in the CircleConfig, which is in MIST (9 decimals). Frontend calculations 
// can sometimes lead to rounding differences, so it's safest to query the exact value
// from the CircleConfig and use that.
// 
// Do NOT double-convert values. The frontend should calculate and pass the exact 
// required amount, and the contract will not perform additional scaling.

// Define a proper Circle type to fix linter errors
interface Circle {
  id: string;
  name: string;
  admin: string;
  contributionAmount: number; // This is the SUI value
  contributionAmountUsd: number; // This will be the TRUE USD EQUIVALENT value
  contributionAmountLocal?: number; // NEW: Local currency value for display (e.g., XAF amount)
  currencyType?: string; 
  securityDeposit: number; // This is the SUI value
  securityDepositUsd: number; // This will be the TRUE USD EQUIVALENT value
  securityDepositLocal?: number; // NEW: Local currency value for display (e.g., XAF amount)
  walletId: string; 
  autoSwapEnabled?: boolean; 
  isActive?: boolean; 
  maxMembers?: number; 
  nextPayoutTime?: number; 
  cycleLength?: number; 
  pausedAfterCycle?: boolean; 
}

// Define a type for the fields from the SUI object
interface CircleFields {
  name: string;
  admin: string;
  contribution_amount: string;
  security_deposit: string;
  contribution_amount_usd?: string;
  security_deposit_usd?: string;
  usd_amounts?: {
    fields?: {
      contribution_amount: string;
      security_deposit: string;
      target_amount?: string;
    };
    contribution_amount?: string;
    security_deposit?: string;
    target_amount?: string;
  } | string; // Allow string for potential older structures
  wallet_id?: string; // Add wallet_id if it can be a direct field
  auto_swap_enabled?: boolean | string; // Allow string for potential older structures
  next_payout_time?: string; // Add next_payout_time field
  is_active?: boolean | string;
  paused_after_cycle?: boolean | string;
  current_cycle?: string | number;
  current_position?: string | number;
  rotation_order?: unknown[];
  // Use unknown for index signature as a safer alternative to any
  [key: string]: string | number | boolean | object | unknown;
}

// Add missing CircleCreatedEvent interface
interface CircleCreatedEvent {
  circle_id: string;
  admin: string;
  name: string;
  contribution_amount: string;
  currency_type?: string;                  // Currency code (e.g., "USD", "XAF", "NGN")
  contribution_amount_local?: string;      // Amount in local currency
  security_deposit_local?: string;         // Amount in local currency
  contribution_amount_usd: string;
  security_deposit_usd: string;
  max_members: string;
  cycle_length: string;
}

// Define types for SUI object field values
type SuiFieldValue = string | number | boolean | null | undefined | SuiFieldValue[] | Record<string, unknown>;

type DynamicFieldRef = {
  objectId: string;
  objectType?: string;
  name?: {
    type?: string;
    value?: unknown;
  };
};

const parseU64Like = (value: unknown): bigint => {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.max(0, Math.trunc(value)));
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  return 0n;
};

const normalizeMoveTypeKey = (value: string): string => value.trim().toLowerCase().replace(/^0x/, '');

const extractNestedBalance = (value: unknown): bigint => {
  if (value === null || typeof value === 'undefined') return 0n;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') {
    return parseU64Like(value);
  }

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if ('fields' in record && record.fields && typeof record.fields === 'object') {
      const fields = record.fields as Record<string, unknown>;
      if ('value' in fields) {
        return extractNestedBalance(fields.value);
      }
    }
    if ('value' in record) {
      return extractNestedBalance(record.value);
    }
  }

  return 0n;
};

const toDisplayAmount = (value: bigint, decimals: number): number => {
  if (value <= 0n) return 0;
  return Number(value) / 10 ** decimals;
};

const readCustodyCoinBalance = async (
  client: SuiClient,
  walletDynamicFields: DynamicFieldRef[],
  coinType: string
): Promise<bigint> => {
  if (!coinType) return 0n;

  const normalizedCoinType = normalizeMoveTypeKey(coinType);
  let total = 0n;

  const typedField = walletDynamicFields.find((field) => {
    const nameValue = field.name?.value;
    return typeof nameValue === 'string' && normalizeMoveTypeKey(nameValue) === normalizedCoinType;
  });

  if (typedField?.objectId) {
    try {
      const fieldObject = await client.getObject({
        id: typedField.objectId,
        options: { showContent: true }
      });

      if (fieldObject.data?.content && 'fields' in fieldObject.data.content) {
        const fieldContent = fieldObject.data.content.fields as Record<string, unknown>;
        total += extractNestedBalance(fieldContent.value);
      }
    } catch (error) {
      console.warn('[Contribute] Failed to read typed custody balance field:', { coinType, error });
    }
  }

  const legacyCoinFields = walletDynamicFields.filter(
    (field) =>
      typeof field.objectType === 'string' &&
      (
        field.objectType.toLowerCase().includes(`::coin::coin<0x${normalizedCoinType}>`) ||
        field.objectType.toLowerCase().includes(`::coin::coin<${normalizedCoinType}>`)
      )
  );

  if (legacyCoinFields.length > 0) {
    const legacyCoinObjects = await Promise.all(
      legacyCoinFields.map((field) =>
        client.getObject({
          id: field.objectId,
          options: { showContent: true }
        })
      )
    );

    for (const coinObject of legacyCoinObjects) {
      if (coinObject.data?.content && 'fields' in coinObject.data.content) {
        const coinFields = coinObject.data.content.fields as Record<string, unknown>;
        total += parseU64Like(coinFields.balance);
      }
    }
  }

  return total;
};

const resolveStablecoinMetadata = (
  targetCoinType?: string | null
): { coinType: string; decimals: number } => {
  const coinTypes = getCurrentCoinTypes();
  const tokens = getCurrentTokens();
  const normalizedTarget = (targetCoinType || '').trim();
  const normalizedUpper = normalizedTarget.toUpperCase();

  const usdcCoinType = coinTypes.USDC || tokens.USDC || normalizedTarget;
  const usdtCoinType = tokens.USDT || normalizedTarget;
  const suiUsdeCoinType = coinTypes.SUI_USDE || tokens.SUI_USDE || normalizedTarget;

  if (!normalizedTarget || normalizedUpper === 'USDC' || normalizedTarget === usdcCoinType || normalizedTarget === tokens.USDC) {
    return { coinType: usdcCoinType, decimals: 6 };
  }

  if (normalizedUpper === 'USDT' || normalizedTarget === usdtCoinType) {
    return { coinType: usdtCoinType, decimals: 6 };
  }

  if (normalizedUpper === 'SUI_USDE' || normalizedTarget === suiUsdeCoinType || normalizedTarget === tokens.SUI_USDE) {
    return { coinType: suiUsdeCoinType, decimals: 9 };
  }

  const lowerTarget = normalizedTarget.toLowerCase();
  if (lowerTarget.includes('usdt')) {
    return { coinType: normalizedTarget, decimals: 6 };
  }

  if (lowerTarget.includes('sui_usde') || lowerTarget.includes('usde')) {
    return { coinType: normalizedTarget, decimals: 9 };
  }

  return { coinType: normalizedTarget || usdcCoinType, decimals: 6 };
};

const readOutstandingSecurityDepositRaw = async (
  client: SuiClient,
  circleId: string
): Promise<bigint> => {
  const circleObject = await client.getObject({
    id: circleId,
    options: { showContent: true }
  });

  if (!circleObject.data?.content || !('fields' in circleObject.data.content)) {
    return 0n;
  }

  const circleFields = circleObject.data.content.fields as {
    members?: { fields?: { id?: { id?: string } } };
  };
  const membersTableId = circleFields.members?.fields?.id?.id;
  if (!membersTableId) {
    return 0n;
  }

  const members = await client.getDynamicFields({ parentId: membersTableId });
  let outstandingTotal = 0n;

  for (const memberEntry of members.data) {
    const memberAddress = memberEntry.name?.value;
    if (memberEntry.name?.type !== 'address' || typeof memberAddress !== 'string') {
      continue;
    }

    try {
      const memberField = await client.getDynamicFieldObject({
        parentId: membersTableId,
        name: { type: 'address', value: memberAddress }
      });

      if (memberField.data?.content && 'fields' in memberField.data.content) {
        const memberFields = memberField.data.content.fields as {
          value?: {
            fields?: {
              deposit_paid?: boolean;
              deposit_balance?: string | number;
            };
          };
        };

        if (memberFields.value?.fields?.deposit_paid) {
          outstandingTotal += parseU64Like(memberFields.value.fields.deposit_balance);
        }
      }
    } catch (error) {
      console.warn('[Contribute] Failed to read member deposit balance:', { memberAddress, error });
    }
  }

  return outstandingTotal;
};


export default function ContributeToCircle() {
  const router = useRouter();
  const { id } = router.query;
  const { isAuthenticated, isLoading: authLoading, userAddress, account } = useAuth();
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [circle, setCircle] = useState<Circle | null>(null);
  // Phase 6: display-name map keyed by lowercase address so the
  // CycleEscrowPanel can show "Aminata" instead of a hex address.
  const [memberNameMap, setMemberNameMap] = useState<Record<string, string>>({});
  // Setter retained-as-noop for legacy buttons that still reference it.
  // Read-only callers below keep using `isProcessing` as a disabled flag.
  const [isProcessing] = useState(false);
  const [suiPrice, setSuiPrice] = useState(1.25);
  const [isOneClickSwapProcessing, setIsOneClickSwapProcessing] = useState(false);
  const [oneClickSwapDigest, setOneClickSwapDigest] = useState<string | null>(null);
  const [oneClickSwapError, setOneClickSwapError] = useState<string | null>(null);
  const [oneClickSwapQuote, setOneClickSwapQuote] = useState<{
    suiIn: number;
    usdcOut: number;
    priceImpact: number;
  } | null>(null);
  const [isOneClickSwapQuoteLoading, setIsOneClickSwapQuoteLoading] = useState(false);
  const [oneClickSwapQuoteError, setOneClickSwapQuoteError] = useState<string | null>(null);
  const [isTokenAssistSwapProcessing, setIsTokenAssistSwapProcessing] = useState(false);
  const [tokenAssistSwapDigest, setTokenAssistSwapDigest] = useState<string | null>(null);
  const [tokenAssistSwapError, setTokenAssistSwapError] = useState<string | null>(null);
  const [tokenAssistQuote, setTokenAssistQuote] = useState<{
    usdcIn: number;
    suiOut: number;
    priceImpact: number;
  } | null>(null);
  const [isTokenAssistQuoteLoading, setIsTokenAssistQuoteLoading] = useState(false);
  const [tokenAssistQuoteError, setTokenAssistQuoteError] = useState<string | null>(null);
  const [showInlineOnrampLauncher, setShowInlineOnrampLauncher] = useState(false);
  const [coinbaseAssetIntent, setCoinbaseAssetIntent] =
    useState<CoinbaseAssetIntent>('USDC_ON_SUI');
  
  // New state variables
  const [userBalance, setUserBalance] = useState<number | null>(null);
  const [userDepositPaid, setUserDepositPaid] = useState(false);
  const [fetchingBalance, setFetchingBalance] = useState(false);
  const [isPayingDeposit, setIsPayingDeposit] = useState(false);

  // Add state to track custody wallet stablecoin balance
  const [custodyStablecoinBalance, setCustodyStablecoinBalance] = useState<number | null>(null);
  // Add separate states for security deposits and contribution funds
  const [securityDepositBalance, setSecurityDepositBalance] = useState<number | null>(null);
  const [contributionBalance, setContributionBalance] = useState<number | null>(null);
  const [loadingStablecoinBalance, setLoadingStablecoinBalance] = useState(false);
  const [isInitialBalanceLoad, setIsInitialBalanceLoad] = useState(true);
  
  // New state for user's USDC balance
  const [userUsdcBalance, setUserUsdcBalance] = useState<number | null>(null);
  const [showDirectDepositOption, setShowDirectDepositOption] = useState<boolean>(false);
  const [directDepositProcessing, setDirectDepositProcessing] = useState<boolean>(false);
  const [convertedUserUsdcBalanceDisplay, setConvertedUserUsdcBalanceDisplay] = useState<string | null>(null);
  const [totalSuiEquivalentDisplay, setTotalSuiEquivalentDisplay] = useState<string | null>(null);
  
  // State for local currency display of custody USDC balances
  const [custodyUsdcTotalLocalDisplay, setCustodyUsdcTotalLocalDisplay] = useState<string | null>(null);
  const [custodyUsdcSecurityDepositLocalDisplay, setCustodyUsdcSecurityDepositLocalDisplay] = useState<string | null>(null);
  const [custodyUsdcContributionLocalDisplay, setCustodyUsdcContributionLocalDisplay] = useState<string | null>(null);

  // USDC coin type - using constants to support different environments
  const USDC_COIN_TYPE = getCoinType('USDC');

  // Add these new state variables to track SUI balance
  const [custodySuiBalance, setCustodySuiBalance] = useState<number | null>(null);
  const [fetchingSuiBalance, setFetchingSuiBalance] = useState(false);
  // Add separate states for SUI security deposits and contribution funds
  const [suiSecurityDepositBalance, setSuiSecurityDepositBalance] = useState<number | null>(null);
  const [suiContributionBalance, setSuiContributionBalance] = useState<number | null>(null);

  // Add state for current cycle
  const [currentCycle, setCurrentCycle] = useState<number>(1);

  // Add a state to track if the user has already contributed for the current cycle
  const [userHasContributed, setUserHasContributed] = useState<boolean>(false);

  // Add a state for tracking if user is current recipient
  const [isCurrentRecipient, setIsCurrentRecipient] = useState<boolean>(false);

  // Add state for current cycle recipient address

  // New states for cycle position tracking
  const [currentPositionInCycle, setCurrentPositionInCycle] = useState<number | null>(null);
  const [totalMembersInRotation, setTotalMembersInRotation] = useState<number | null>(null);

  // Add a new state variable to track if a user has had their security deposit returned during the current paused cycle
  const [securityDepositReturnedDuringPause, setSecurityDepositReturnedDuringPause] = useState<boolean>(false);
  
  // Add dynamic package ID state
  const [circlePackageId, setCirclePackageId] = useState<string>(PACKAGE_ID);

  // Circle token mode tab index: 0 = USDC, 1 = SUI
  const [currencyTabIndex, setCurrencyTabIndex] = useState<number>(0);
  const contributeSectionRefs = useRef<Partial<Record<ContributeSectionKey, HTMLDivElement | null>>>({});

  const selectedPaymentCurrency: PaymentCurrency = currencyTabIndex === 0 ? 'USDC' : 'SUI';
  const isSuiCircleModeEnabled = Boolean(circle?.autoSwapEnabled);

  useEffect(() => {
    if (authLoading) {
      return;
    }

    if (!isAuthenticated) {
      router.replace('/');
      return;
    }
  }, [authLoading, isAuthenticated, router]);

  // Circle-wide token mode is admin-managed; force tab to match active mode.
  useEffect(() => {
    setCurrencyTabIndex(isSuiCircleModeEnabled ? 1 : 0);
  }, [isSuiCircleModeEnabled]);


  const getZkLoginEndpointWithCurrency = (currency: PaymentCurrency) =>
    currency === 'SUI' ? '/api/zkLogin?currency=SUI' : '/api/zkLogin';

  const requiredContributionUsdc = (circle?.contributionAmountUsd || 0) / 100;
  const requiredSecurityDepositUsdc = (circle?.securityDepositUsd || 0) / 100;

  const closeInlineOnrampLauncher = () => {
    setShowInlineOnrampLauncher(false);
  };

  // Opens the inline geo-aware onramp picker. Provider choice and ordering
  // live in RampPicker (2026-06 GTM audit: no more hardcoded Coinbase +
  // country="US").
  const openBuyFlow = (currencyCode: 'sui' | 'usdc' = 'usdc') => {
    const assetIntent = mapCurrencyCodeToIntent(currencyCode);

    if (!userAddress) {
      toast.error('Wallet address is unavailable. Please sign in and retry.');
      return;
    }

    setCoinbaseAssetIntent(assetIntent);
    setShowInlineOnrampLauncher(true);
  };

  const handleRampLaunched = (provider: RampProviderId) => {
    toast.success(`Opening ${RAMP_PROVIDER_LABELS[provider]} checkout...`);
    closeInlineOnrampLauncher();
  };

  const handleRampProviderError = (provider: RampProviderId, error: Error) => {
    // The picker promotes the next provider itself; this is observability.
    console.warn('[onramp][contribute] provider unavailable', provider, error.message);
  };

  const handleCoinbaseCancel = () => {
    closeInlineOnrampLauncher();
  };

  // Verify user membership before allowing access to contribute page
  const verifyMembership = async (): Promise<boolean | null> => {
    if (!id || !userAddress) return false;
    
    try {
      const client = getSuiClientFromPool(getCurrentRpcUrl());
      const determinedPackageId = await getCirclePackageId(id as string, userAddress);
      
      // First check if user is the admin. Deduped/cached read: the circle
      // object is fetched by several mount-time checks; they share one RPC.
      const objectData = await readObject(id as string, { showContent: true });
      
      if (objectData.data?.content && 'fields' in objectData.data.content) {
        const fields = objectData.data.content.fields as Record<string, unknown>;
        // Admin always has access
        if (fields.admin === userAddress) {
          console.log('[Membership] User is admin, access granted');
          return true;
        }
        
        // Check if user is in the members table
        const circleFields = fields as { members?: { fields?: { id?: { id: string } } } };
        if (circleFields.members?.fields?.id?.id) {
          const membersTableId = circleFields.members.fields.id.id;
          try {
            const memberField = await client.getDynamicFieldObject({
              parentId: membersTableId,
              name: { type: 'address', value: userAddress }
            });
            
            if (memberField.data?.content) {
              console.log('[Membership] User found in members table, access granted');
              return true;
            }
          } catch {
            // User not found in members table
            console.log('[Membership] User not found in members table');
          }
        }
      }
      
      // Check if user ever joined this circle and get their join events
      const joinEvents = await client.queryEvents({
        query: { MoveEventType: `${determinedPackageId}::njangi_circles::MemberJoined` },
        limit: 100
      });
      
      // Find the user's join events for this circle and get the latest timestamp
      const userJoinEvents = joinEvents.data.filter(event => {
        const parsed = event.parsedJson as { circle_id?: string; member?: string };
        return parsed?.circle_id === id && parsed?.member === userAddress;
      });
      
      if (userJoinEvents.length === 0) {
        console.log('[Membership] User never joined this circle');
        return false;
      }
      
      // Get the latest join timestamp
      const latestJoinTimestamp = Math.max(...userJoinEvents.map(e => Number(e.timestampMs || 0)));
      console.log(`[Membership] User's latest join timestamp: ${new Date(latestJoinTimestamp).toISOString()}`);
      
      // Check for MemberRemoved events to see if user was removed
      const removedEvents = await client.queryEvents({
        query: { MoveEventType: `${determinedPackageId}::njangi_circles::MemberRemoved` },
        limit: 100
      });
      
      // Find the user's removal events for this circle and get the latest timestamp
      const userRemovalEvents = removedEvents.data.filter(event => {
        const parsed = event.parsedJson as { circle_id?: string; member?: string };
        return parsed?.circle_id === id && parsed?.member === userAddress;
      });
      
      if (userRemovalEvents.length > 0) {
        const latestRemovalTimestamp = Math.max(...userRemovalEvents.map(e => Number(e.timestampMs || 0)));
        console.log(`[Membership] User's latest removal timestamp: ${new Date(latestRemovalTimestamp).toISOString()}`);
        
        // If the user joined AFTER they were last removed, they have rejoined - allow access
        if (latestJoinTimestamp > latestRemovalTimestamp) {
          console.log('[Membership] User rejoined after removal, access granted');
          return true;
        }
        
        // User was removed after their last join - deny access
        console.log('[Membership] User was removed after their last join, access denied');
        return false;
      }
      
      // User joined and was never removed - they should have access
      console.log('[Membership] User joined and was never removed, access granted');
      return true;
      
    } catch (error) {
      if (isTransientSuiRpcError(error)) {
        // RPC momentarily unavailable (rate-limit / failover cooldown).
        // Returning null signals "couldn't verify yet"; the caller retries.
        console.warn(
          '[Membership] Verification deferred (transient RPC):',
          getSuiRpcErrorMessage(error),
        );
        return null;
      }
      console.error('[Membership] Error verifying membership:', error);
      return null;
    }
  };

  useEffect(() => {
    // Fetch the current SUI price
    const fetchSuiPrice = async () => {
      try {
        const price = await priceService.getSUIPrice();
        if (price && !isNaN(price) && price > 0) {
          setSuiPrice(price);
          console.log('Fetched SUI price:', price);
        }
      } catch (error) {
        console.error('Error fetching SUI price:', error);
        // Keep using default price
      }
    };
    
    fetchSuiPrice();
  }, []);

  useEffect(() => {
    // Verify membership and fetch circle details when ID is available
    if (authLoading || !router.isReady || !id || !userAddress) {
      return;
    }

    if (id && userAddress) {
      verifyMembership().then(isMember => {
        if (isMember === false) {
          setLoading(false);
          toast.error('You are no longer a member of this circle');
          router.replace('/dashboard');
          return;
        }

        fetchCircleDetails();
      });
    }
    // `verifyMembership` and `fetchCircleDetails` are component-scoped
    // closures that would change on every render; including them would
    // refetch the circle on every re-render of the component.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, id, router, router.isReady, userAddress]);

  // Add effect to fetch user balance and deposit status when circle data is loaded
  useEffect(() => {
    if (circle && userAddress) {
      fetchUserWalletInfo();
    }
    // `fetchUserWalletInfo` closes over `circle`/`userAddress` already.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [circle, userAddress]);

  // First add console logs to debug the conditions for showing the button
  useEffect(() => {
    if (circle && userDepositPaid !== null) {
      console.log('Security deposit button conditions:', {
        userDepositPaid,
        hasCircle: !!circle,
        securityDepositAmount: circle.securityDeposit,
        shouldShowButton: !userDepositPaid && !!circle && circle.securityDeposit > 0
      });
    }
  }, [circle, userDepositPaid]);

  // Add debug log to check the security deposit value when showing the warning
  useEffect(() => {
    if (circle) {
      console.log('Security deposit values:', {
        rawValue: circle.securityDeposit,
        usdValue: circle.securityDepositUsd,
        formattedSUI: `${circle.securityDeposit} SUI`,
        formattedUSD: `$${circle.securityDepositUsd}`
      });
    }
  }, [circle]);

  // Add effect to fetch custody wallet stablecoin balance when circle data is loaded
  useEffect(() => {
    if (circle && circle.walletId) {
      fetchCustodyWalletBalance();
    }
    // fetchCustodyWalletBalance depends on circle but we don't need to
    // re-run it every time the entire circle object changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [circle?.id, circle?.walletId]);

  // Add effect to fetch SUI balance
  useEffect(() => {
    if (circle?.walletId) {
      fetchCustodyWalletSuiBalance();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [circle?.walletId]);

  useEffect(() => {
    if (circle) {
      fetchUserWalletInfo();
      fetchCustodyWalletSuiBalance();
      fetchCustodyWalletBalance();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [circle]);

  // Effect to convert USDC balance to local currency for display
  useEffect(() => {
    const convertBalance = async () => {
      if (userUsdcBalance !== null && circle?.currencyType && circle.currencyType !== 'USD') {
        try {
          const converted = await priceService.convertFromUSD(userUsdcBalance, circle.currencyType);
          setConvertedUserUsdcBalanceDisplay(formatCurrency(converted, circle.currencyType));
        } catch (error) {
          console.error('Error converting USDC balance to local currency:', error);
          setConvertedUserUsdcBalanceDisplay(null); // Reset or handle error display
        }
      } else if (userUsdcBalance !== null && circle?.currencyType === 'USD') {
        setConvertedUserUsdcBalanceDisplay(formatCurrency(userUsdcBalance, 'USD'));
      } else {
        setConvertedUserUsdcBalanceDisplay(null);
      }
    };
    convertBalance();
  }, [userUsdcBalance, circle?.currencyType]);

  // Effect to calculate and format total SUI equivalent balance for display
  useEffect(() => {
    const calculateTotalDisplay = async () => {
      if (userBalance !== null && suiPrice > 0) {
        let currentTotalSuiEquivalent = userBalance;
        if (userUsdcBalance !== null && userUsdcBalance > 0) {
          currentTotalSuiEquivalent += userUsdcBalance / suiPrice; // Convert USDC to SUI and add
        }

        let displayString = `${currentTotalSuiEquivalent.toFixed(4)} SUI`;
        const usdEquivalent = currentTotalSuiEquivalent * suiPrice;

        if (circle?.currencyType && circle.currencyType !== 'USD') {
          try {
            const localEquivalent = await priceService.convertFromUSD(usdEquivalent, circle.currencyType);
            // Ensure formatCurrency receives the amount in the primary unit of the currency, not cents
            displayString += ` (≈ ${formatCurrency(localEquivalent, circle.currencyType)})`;
          } catch (error) {
            console.error('Error converting total SUI equivalent to local currency:', error);
            displayString += ` (≈ ${formatUSD(usdEquivalent)})`; // Fallback to USD display
          }
        } else {
          displayString += ` (≈ ${formatUSD(usdEquivalent)})`; // Default to USD display
        }
        setTotalSuiEquivalentDisplay(displayString);

      } else if (userBalance !== null) {
        // Only SUI balance is available, or SUI price is missing
        let displayString = `${userBalance.toFixed(4)} SUI`;
        if (suiPrice > 0) {
          const usdEquivalent = userBalance * suiPrice;
          if (circle?.currencyType && circle.currencyType !== 'USD') {
            try {
              const localEquivalent = await priceService.convertFromUSD(usdEquivalent, circle.currencyType);
              displayString += ` (≈ ${formatCurrency(localEquivalent, circle.currencyType)})`;
            } catch (error) {
              console.error('Error converting SUI balance to local currency:', error);
              displayString += ` (≈ ${formatUSD(usdEquivalent)})`; // Fallback to USD
            }
          } else {
            displayString += ` (≈ ${formatUSD(usdEquivalent)})`; // Default to USD
          }
        } else {
          // SUI price is not available, only show SUI amount
        }
        setTotalSuiEquivalentDisplay(displayString);

      } else {
        setTotalSuiEquivalentDisplay(null); // No balance to display
      }
    };

    calculateTotalDisplay();
  }, [userBalance, userUsdcBalance, suiPrice, circle?.currencyType]);

  // Effect to convert custody USDC balances to local currency for display
  useEffect(() => {
    const convertCustodyUsdcBalances = async () => {
      if (!circle || !circle.currencyType) {
        // Reset if no circle or currency type
        setCustodyUsdcTotalLocalDisplay(custodyStablecoinBalance !== null ? formatUSD(custodyStablecoinBalance) + " USDC" : "-");
        setCustodyUsdcSecurityDepositLocalDisplay(securityDepositBalance !== null ? formatUSD(securityDepositBalance) + " USDC" : "-");
        setCustodyUsdcContributionLocalDisplay(contributionBalance !== null ? formatUSD(contributionBalance) + " USDC" : "-");
        return;
      }

      const { currencyType } = circle;

      // Helper to convert and format
      const getDisplayString = async (usdAmount: number | null, originalLabel: string) => {
        if (usdAmount === null) return "-";
        if (currencyType === 'USD') return formatCurrency(usdAmount, 'USD');
        try {
          const localAmount = await priceService.convertFromUSD(usdAmount, currencyType);
          return `${formatCurrency(localAmount, currencyType)} (approx. ${formatUSD(usdAmount)})`;
        } catch (error) {
          console.error(`Error converting ${originalLabel} to local currency:`, error);
          return `${formatCurrency(usdAmount, 'USD')} (Conversion Error)`; // Fallback to USD
        }
      };

      setCustodyUsdcTotalLocalDisplay(await getDisplayString(custodyStablecoinBalance, "total custody USDC"));
      setCustodyUsdcSecurityDepositLocalDisplay(await getDisplayString(securityDepositBalance, "custody security deposit USDC"));
      setCustodyUsdcContributionLocalDisplay(await getDisplayString(contributionBalance, "custody contribution USDC"));
    };

    convertCustodyUsdcBalances();
    // Only `circle?.currencyType` is read; we intentionally don't re-run on
    // unrelated `circle` field changes to avoid redundant FX conversions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [custodyStablecoinBalance, securityDepositBalance, contributionBalance, circle?.currencyType, suiPrice]);

  // Fix type assertion issues in the function
  const fetchCustodyWalletSuiBalance = async () => {
    if (!circle?.walletId) return;
    
    setFetchingSuiBalance(true);
    try {
      const rpcUrl = getJsonRpcUrl();
      console.log('[Balance Fetch] Using RPC URL:', rpcUrl);
      const client = getSuiClientFromPool(rpcUrl); // Use helper function for URL
      
      let mainSuiBalance = 0;
      let dynamicFieldSuiBalance = 0;

      // 1. Fetch the CustodyWallet object itself
      const walletData = await client.getObject({ 
        id: circle.walletId, 
        options: { showContent: true } 
      });

      if (walletData.data?.content && 'fields' in walletData.data.content) {
        const wf = walletData.data.content.fields as Record<string, unknown>; // Use unknown instead of any
        // Extract the main balance (contributions)
        if (wf.balance && typeof wf.balance === 'object' && 'fields' in wf.balance) {
          mainSuiBalance = Number((wf.balance.fields as Record<string, unknown>)?.value || 0) / 1e9;
        } else if (wf.balance) {
           // Handle case where balance might be a direct value (older structure?)
           mainSuiBalance = Number(wf.balance) / 1e9;
        }
        console.log(`[SUI Balance Fetch] Main Balance (Contributions): ${mainSuiBalance}`);
      } else {
         console.warn('[SUI Balance] Could not fetch main CustodyWallet object content.');
      }

      // 2. Fetch dynamic fields to find the SUI Coin object (security deposits)
      const dynamicFieldsResult = await client.getDynamicFields({ parentId: circle.walletId });
      console.log('[SUI Balance] Dynamic Fields:', dynamicFieldsResult.data);

      for (const field of dynamicFieldsResult.data) {
        if (field.objectType && field.objectType.includes('::coin::Coin<0x2::sui::SUI>')) {
          console.log(`[SUI Balance] Found SUI Coin dynamic field: ${field.objectId}`);
          const coinData = await client.getObject({
            id: field.objectId,
            options: { showContent: true }
          });
          if (coinData.data?.content && 'fields' in coinData.data.content) {
            const coinFields = coinData.data.content.fields as Record<string, unknown>;
            if (coinFields.balance) {
              dynamicFieldSuiBalance = Number(coinFields.balance) / 1e9;
              console.log(`[SUI Balance Fetch] Dynamic Field Balance (Security Deposits): ${dynamicFieldSuiBalance}`);
              // Assuming only one SUI coin dynamic field for security deposits
              break; 
            }
          }
        }
      }

      // 3. Fetch CustodyDeposited events (Optional: For logging/verification ONLY, not balance calculation)
      const custodyEvents = await client.queryEvents({
        query: { MoveEventType: `${circlePackageId}::njangi_custody::CustodyDeposited` },
        limit: 100 
      });
      
      let totalSecurityDepositsFromEvents = 0;
      for (const event of custodyEvents.data) {
          if (event.parsedJson && 
              typeof event.parsedJson === 'object' && 
              'circle_id' in event.parsedJson &&
              'operation_type' in event.parsedJson &&
              'amount' in event.parsedJson &&
              event.parsedJson.circle_id === circle.id) {
              
              const parsedEvent = event.parsedJson as {
                operation_type: number | string;
                amount: string;
                coin_type?: string; 
              };
              
              // Skip non-SUI events for this *SUI specific* cross-check
              if (parsedEvent.coin_type === 'stablecoin' || 
                 (parsedEvent.coin_type && parsedEvent.coin_type !== 'sui')) {
                 continue; 
              }
              
              const opType = typeof parsedEvent.operation_type === 'string' ? 
                parseInt(parsedEvent.operation_type) : parsedEvent.operation_type;
                
              if (opType === 3) { // Security Deposit
                  totalSecurityDepositsFromEvents += Number(parsedEvent.amount) / 1e9; // Use SUI decimals
              }
          }
      }
      console.log(`[SUI Balance Fetch] Total SUI Security Deposits from Events (for verification): ${totalSecurityDepositsFromEvents}`);
      
      // --- REMOVED FAULTY LOGIC --- 
      // Removed the block that overwrote dynamicFieldSuiBalance based on event totals.
      // We now strictly rely on the actual fetched dynamic field balance for SUI security deposits.
      // ----

      // 4. Calculate final balances (Based ONLY on direct object fetches)
      const securityDepositSui = dynamicFieldSuiBalance; // SUI Security deposits ARE the dynamic field balance
      const contributionSui = mainSuiBalance; // SUI Contributions ARE the main balance
      const totalSuiBalance = contributionSui + securityDepositSui; // Total is the sum

      // Set all balances
      console.log('[SUI Balance Fetch] Setting SUI state:', { totalSuiBalance, securityDepositSui, contributionSui });
      setCustodySuiBalance(totalSuiBalance);
      setSuiSecurityDepositBalance(securityDepositSui);
      setSuiContributionBalance(contributionSui);
      
      console.log('[SUI Balance] Final breakdown:', {
        total: totalSuiBalance,
        securityDeposit: securityDepositSui,
        contribution: contributionSui
      });

    } catch (error) {
      logSuiReadError('Error fetching custody wallet SUI balance:', error);
      setCustodySuiBalance(null);
      setSuiSecurityDepositBalance(null);
      setSuiContributionBalance(null);
    } finally {
      setFetchingSuiBalance(false);
    }
  };

  // Function to refresh all data
  const refreshData = () => {
    fetchUserWalletInfo();
    fetchCustodyWalletBalance();
    fetchCustodyWalletSuiBalance();
  };

  const fetchCircleDetails = async () => {
    if (!id || !userAddress) return;
    console.log('Contribute - Fetching circle details for:', id);
    
    setLoading(true);
    setCurrentPositionInCycle(null); // Reset before fetching
    setTotalMembersInRotation(null); // Reset before fetching
    try {
      // Determine package ID for this circle
      const determinedPackageId = await getCirclePackageId(id as string, userAddress);
      console.log('Contribute - Using package ID:', determinedPackageId);
      setCirclePackageId(determinedPackageId);
      
      const client = getSuiClientFromPool(getCurrentRpcUrl());

      // Get circle object with content (deduped/cached + failover via readObject;
      // shares the read with the other mount-time circle lookups).
      const objectData = await readObject(id as string, { showContent: true, showType: true });
      
      if (!objectData.data?.content || !('fields' in objectData.data.content)) {
        throw new Error('Invalid circle object data received');
      }
      
        const fields = objectData.data.content.fields as CircleFields;
      console.log('Contribute - Raw Circle Object Fields:', fields);
      
      let lifecycleState = resolveCircleLifecycleState(fields);
      console.log('Contribute - Initial lifecycle state from circle object:', lifecycleState);

      // Get current_position and rotation_order for cycle position display
      if (fields.current_position !== undefined && fields.rotation_order && Array.isArray(fields.rotation_order)) {
        const position = Number(fields.current_position);
        const rotationOrderArray = fields.rotation_order.filter(addr => typeof addr === 'string' && addr !== '0x0');
        if (!isNaN(position) && position >= 0 && rotationOrderArray.length > 0) {
          setCurrentPositionInCycle(position);
          setTotalMembersInRotation(rotationOrderArray.length);
          console.log(`Contribute - Fetched cycle position: ${position + 1} of ${rotationOrderArray.length}`);
          // Phase 6: hydrate the member-name map so the CycleEscrowPanel can
          // show "It's Aminata's turn" instead of a hex address. We fire-
          // and-forget because a missing name falls back to a shortened
          // address, which is still functional.
          void lookupMemberNames(id as string, rotationOrderArray as string[])
            .then((names) => setMemberNameMap(names))
            .catch((err) =>
              console.warn('[contribute] Failed to resolve member names', err),
            );
        }
      }
      
      // Get max_members from the circle object or dynamic fields
      let maxMembers = 10; // Default value
      
      if (lifecycleState.activeSource === 'default') {
        try {
          const activationEvents = await client.queryEvents({
            query: { MoveEventType: `${determinedPackageId}::njangi_circles::CircleActivated` },
            limit: 50
          });
          
          const activationForThisCircle = activationEvents.data.some(event => {
            const eventData = event.parsedJson as { circle_id?: string };
            return eventData?.circle_id === id;
          });

          lifecycleState = resolveCircleLifecycleState(fields, {
            activationEventFound: activationForThisCircle,
          });
          console.log('Contribute - Lifecycle state after activation event fallback:', lifecycleState);
        } catch (err) {
          logSuiReadError('Contribute - Error checking activation events:', err);
        }
      }

      const {
        isActive,
        isPausedAfterCycle,
        currentCycle: resolvedCurrentCycle,
      } = lifecycleState;
      setCurrentCycle(resolvedCurrentCycle);
        
      // Get dynamic fields
      const dynamicFieldsResult = await client.getDynamicFields({
        parentId: id as string
      });
      const dynamicFields = dynamicFieldsResult.data;
      console.log('Contribute - Dynamic Fields:', dynamicFields);

      // Fetch creation event and transaction inputs (similar to dashboard)
      let transactionInput: Record<string, unknown> | undefined;
      let circleCreationEventData: CircleCreatedEvent | undefined;
      let walletId = '';

      try {
        // 1. Fetch CircleCreated event
        const circleEvents = await client.queryEvents({
          query: { MoveEventType: `${determinedPackageId}::njangi_circles::CircleCreated` },
          limit: 50
        });
        const createEvent = circleEvents.data.find(event => 
          (event.parsedJson as { circle_id?: string })?.circle_id === id
        );
        console.log('Contribute - Found creation event:', !!createEvent);

        if (createEvent?.parsedJson) {
          circleCreationEventData = createEvent.parsedJson as CircleCreatedEvent;
          // Try extracting basic config from event
          transactionInput = {
            contribution_amount: circleCreationEventData.contribution_amount,
            contribution_amount_usd: circleCreationEventData.contribution_amount_usd,
            security_deposit_usd: circleCreationEventData.security_deposit_usd,
          };
          
          // Try to get local currency amounts if available (new format)
          if (circleCreationEventData.contribution_amount_local) {
            transactionInput.contribution_amount_local = circleCreationEventData.contribution_amount_local;
          }
          if (circleCreationEventData.security_deposit_local) {
            transactionInput.security_deposit_local = circleCreationEventData.security_deposit_local;
          }
          
          console.log('[CONTRIBUTE DEBUG] Extracted from creation event:', {
            contribution_amount: circleCreationEventData.contribution_amount,
            contribution_amount_usd: circleCreationEventData.contribution_amount_usd,
            contribution_amount_local: circleCreationEventData.contribution_amount_local,
            security_deposit_usd: circleCreationEventData.security_deposit_usd,
            security_deposit_local: circleCreationEventData.security_deposit_local,
            currency_type: circleCreationEventData.currency_type
          });
          
          // Extract max_members from the creation event
          if (circleCreationEventData.max_members) {
            maxMembers = parseInt(circleCreationEventData.max_members, 10);
            console.log('Contribute - Found max_members from creation event:', maxMembers);
          }
        }

        // 2. Fetch Transaction Block for inputs (like currency_type, potentially others)
        if (createEvent?.id?.txDigest) {
          const txData = await client.getTransactionBlock({
            digest: createEvent.id.txDigest,
            options: { showInput: true }
          });
          console.log('Contribute - Transaction data fetched:', !!txData);
          if (txData?.transaction?.data?.transaction?.kind === 'ProgrammableTransaction') {
            const inputs = txData.transaction.data.transaction.inputs || [];
            console.log('Contribute - Transaction inputs:', inputs);
            if (!transactionInput) transactionInput = {};
            // Extract relevant inputs based on expected positions (adjust if needed)
            if (inputs.length > 1 && inputs[1]?.type === 'pure') transactionInput.contribution_amount = inputs[1].value;
            if (inputs.length > 2 && inputs[2]?.type === 'pure') transactionInput.currency_type = inputs[2].value;
            if (inputs.length > 3 && inputs[3]?.type === 'pure') transactionInput.contribution_amount_local = inputs[3].value;
            if (inputs.length > 5 && inputs[5]?.type === 'pure') transactionInput.security_deposit_local = inputs[5].value;
            // Add any other inputs you stored this way
          }
        }
        
        // 3. Fetch CustodyWalletCreated event for walletId. Per-node indexer
        // gaps can throw "Could not find the referenced transaction events"
        // here even when the upstream try/catch is in place — isolate so a
        // failed wallet lookup doesn't surface as a runtime overlay.
        try {
          const custodyEvents = await client.queryEvents({
            query: { MoveEventType: `${determinedPackageId}::njangi_custody::CustodyWalletCreated` },
            limit: 100
          });
          const custodyEvent = custodyEvents.data.find(event =>
            event.parsedJson &&
                typeof event.parsedJson === 'object' &&
                'circle_id' in event.parsedJson &&
                'wallet_id' in event.parsedJson &&
            event.parsedJson.circle_id === id
          );
          if (custodyEvent?.parsedJson) {
            walletId = (custodyEvent.parsedJson as { wallet_id: string }).wallet_id;
            console.log('Contribute - Found wallet ID from events:', walletId);
          } else {
            console.warn('Contribute - No CustodyWalletCreated event found for circle:', id);
          }
        } catch (walletLookupErr) {
          console.warn('Contribute - CustodyWalletCreated lookup failed (non-fatal):', walletLookupErr);
        }

      } catch (error) {
        logSuiReadError('Contribute - Error fetching event/transaction data:', error);
        // Continue even if this fails, rely on other data sources
        }

      // --- Process Extracted Data (Prioritize sources) ---
      const configValues = {
        contributionAmount: 0, // SUI amount (MIST)
        contributionAmountUsd: 0, // True USD equivalent in cents
        contributionAmountLocal: 0, // Local currency amount (e.g., XAF in cents/smallest unit)
        securityDeposit: 0, // SUI amount (MIST)
        securityDepositUsd: 0, // True USD equivalent in cents
        securityDepositLocal: 0, // Local currency amount (e.g., XAF in cents/smallest unit)
        autoSwapEnabled: false,
      };

      // 1. Use values from CircleCreatedEvent first (most reliable for local vs USD distinction)
      if (circleCreationEventData) {
        if (circleCreationEventData.contribution_amount) configValues.contributionAmount = Number(circleCreationEventData.contribution_amount) / 1e9;
        
        // USD amounts from event
        if (circleCreationEventData.contribution_amount_usd) {
          configValues.contributionAmountUsd = Number(circleCreationEventData.contribution_amount_usd); // Already in cents
        }
        if (circleCreationEventData.security_deposit_usd) {
          configValues.securityDepositUsd = Number(circleCreationEventData.security_deposit_usd); // Already in cents
        }
        
        // Local currency amounts from event (these are the amounts in XAF, NGN etc, stored in their smallest unit)
        if (circleCreationEventData.contribution_amount_local) {
          configValues.contributionAmountLocal = Number(circleCreationEventData.contribution_amount_local);
        } else if (configValues.contributionAmountUsd > 0 && circleCreationEventData.currency_type !== 'USD') {
          // Fallback: If local not present but USD is, and currency is not USD, assume USD field was mistakenly local
          // This is a temporary patch for older data structures if any.
          // Ideally, event should always have both _local and _usd if not USD currency.
          console.warn("[CONTRIBUTE DEBUG] Event: contribution_amount_local missing, using contribution_amount_usd as local for non-USD circle. currency:", circleCreationEventData.currency_type);
          configValues.contributionAmountLocal = configValues.contributionAmountUsd; 
        }

        if (circleCreationEventData.security_deposit_local) {
          configValues.securityDepositLocal = Number(circleCreationEventData.security_deposit_local);
        } else if (configValues.securityDepositUsd > 0 && circleCreationEventData.currency_type !== 'USD') {
          // Similar fallback for security deposit
          console.warn("[CONTRIBUTE DEBUG] Event: security_deposit_local missing, using security_deposit_usd as local for non-USD circle. currency:", circleCreationEventData.currency_type);
          configValues.securityDepositLocal = configValues.securityDepositUsd;
        }
      }
      console.log('[CONTRIBUTE DEBUG] Config after CircleCreationEventData:', JSON.parse(JSON.stringify(configValues)));

      // 2. Augment with transactionInput if event data was incomplete (less reliable for local/USD distinction)
      if (transactionInput) {
        if (configValues.contributionAmount === 0 && transactionInput.contribution_amount) configValues.contributionAmount = Number(transactionInput.contribution_amount) / 1e9;
        
        // If USD amounts are still zero, try from transactionInput
        if (configValues.contributionAmountUsd === 0 && transactionInput.contribution_amount_usd) {
          configValues.contributionAmountUsd = Number(transactionInput.contribution_amount_usd); // Assume cents
        }
        if (configValues.securityDepositUsd === 0 && transactionInput.security_deposit_usd) {
          configValues.securityDepositUsd = Number(transactionInput.security_deposit_usd); // Assume cents
        }

        // If local amounts are still zero, try from transactionInput
        if (configValues.contributionAmountLocal === 0 && transactionInput.contribution_amount_local) {
          configValues.contributionAmountLocal = Number(transactionInput.contribution_amount_local);
        } else if (configValues.contributionAmountLocal === 0 && configValues.contributionAmountUsd > 0 && transactionInput.currency_type !== 'USD') {
            console.warn("[CONTRIBUTE DEBUG] TxInput: contribution_amount_local missing, using contribution_amount_usd as local for non-USD circle. currency:", transactionInput.currency_type);
            configValues.contributionAmountLocal = configValues.contributionAmountUsd;
        }

        if (configValues.securityDepositLocal === 0 && transactionInput.security_deposit_local) {
          configValues.securityDepositLocal = Number(transactionInput.security_deposit_local);
        } else if (configValues.securityDepositLocal === 0 && configValues.securityDepositUsd > 0 && transactionInput.currency_type !== 'USD'){
            console.warn("[CONTRIBUTE DEBUG] TxInput: security_deposit_local missing, using security_deposit_usd as local for non-USD circle. currency:", transactionInput.currency_type);
            configValues.securityDepositLocal = configValues.securityDepositUsd;
        }
      }
      console.log('[CONTRIBUTE DEBUG] Config after TransactionInput:', JSON.parse(JSON.stringify(configValues)));

      try {
        const configFields = await getCircleConfigFieldsFromDynamicFields(
          client,
          dynamicFields,
        );

        if (configFields) {
          const resolvedConfigFields = configFields as Record<string, SuiFieldValue>;
          console.log('Contribute - CircleConfig fields:', resolvedConfigFields);

          if (resolvedConfigFields.contribution_amount) {
            configValues.contributionAmount = Number(resolvedConfigFields.contribution_amount) / 1e9;
          }
          if (resolvedConfigFields.contribution_amount_usd) {
            configValues.contributionAmountUsd = Number(resolvedConfigFields.contribution_amount_usd);
          }
          if (resolvedConfigFields.security_deposit_usd) {
            configValues.securityDepositUsd = Number(resolvedConfigFields.security_deposit_usd);
          }
          if (resolvedConfigFields.contribution_amount_local) {
            configValues.contributionAmountLocal = Number(resolvedConfigFields.contribution_amount_local);
          }
          if (resolvedConfigFields.security_deposit_local) {
            configValues.securityDepositLocal = Number(resolvedConfigFields.security_deposit_local);
          }

          const currency =
            typeof resolvedConfigFields.currency_type === 'string'
              ? resolvedConfigFields.currency_type
              : ((transactionInput?.currency_type as string) || 'USD');

          if (
            configValues.contributionAmountLocal === 0 &&
            configValues.contributionAmountUsd > 0 &&
            currency !== 'USD'
          ) {
            console.warn(
              '[CONTRIBUTE DEBUG] CircleConfig: contribution_amount_local missing, using contribution_amount_usd as local. Currency:',
              currency,
            );
            configValues.contributionAmountLocal = configValues.contributionAmountUsd;
          }
          if (
            configValues.securityDepositLocal === 0 &&
            configValues.securityDepositUsd > 0 &&
            currency !== 'USD'
          ) {
            console.warn(
              '[CONTRIBUTE DEBUG] CircleConfig: security_deposit_local missing, using security_deposit_usd as local. Currency:',
              currency,
            );
            configValues.securityDepositLocal = configValues.securityDepositUsd;
          }

          if (resolvedConfigFields.security_deposit) {
            configValues.securityDeposit = Number(resolvedConfigFields.security_deposit) / 1e9;
          }
          if (resolvedConfigFields.auto_swap_enabled !== undefined) {
            const dynamicValue = Boolean(resolvedConfigFields.auto_swap_enabled);
            console.log(`Contribute - Found auto_swap_enabled (${dynamicValue}) in CircleConfig`);
            configValues.autoSwapEnabled = dynamicValue;
          }
          if (resolvedConfigFields.max_members) {
            maxMembers = Number(resolvedConfigFields.max_members);
            console.log(`Contribute - Found max_members (${maxMembers}) in CircleConfig`);
          }
        }
      } catch (error) {
        logSuiReadError('Contribute - Error fetching CircleConfig fields:', error);
      }
      console.log('[CONTRIBUTE DEBUG] Config after Dynamic Fields (CircleConfig):', JSON.parse(JSON.stringify(configValues)));

      // 4. Use direct fields from the circle object as a final fallback if values are still 0
      if (configValues.contributionAmount === 0 && fields.contribution_amount) configValues.contributionAmount = Number(fields.contribution_amount) / 1e9;
      if (configValues.securityDeposit === 0 && fields.security_deposit) configValues.securityDeposit = Number(fields.security_deposit) / 1e9;
      
      if (configValues.contributionAmountUsd === 0) {
        if (fields.contribution_amount_usd) {
          configValues.contributionAmountUsd = Number(fields.contribution_amount_usd); // Assume cents
        } else if (fields.usd_amounts && typeof fields.usd_amounts === 'object' && fields.usd_amounts !== null) {
          const usdData = fields.usd_amounts as { fields?: { contribution_amount?: string; }; contribution_amount?: string; };
          const usdFieldsData = usdData.fields || usdData;
          if (usdFieldsData?.contribution_amount) {
            configValues.contributionAmountUsd = Number(usdFieldsData.contribution_amount); // Assume cents
          }
        }
      }
      if (configValues.securityDepositUsd === 0) {
        if (fields.security_deposit_usd) {
          configValues.securityDepositUsd = Number(fields.security_deposit_usd); // Assume cents
        } else if (fields.usd_amounts && typeof fields.usd_amounts === 'object' && fields.usd_amounts !== null) {
          const usdData = fields.usd_amounts as { fields?: { security_deposit?: string; }; security_deposit?: string; };
          const usdFieldsData = usdData.fields || usdData;
          if (usdFieldsData?.security_deposit) {
            configValues.securityDepositUsd = Number(usdFieldsData.security_deposit); // Assume cents
          }
        }
      }
      // For local amounts from direct fields (less likely to be correctly structured here)
      if (configValues.contributionAmountLocal === 0 && fields.contribution_amount_local) {
        configValues.contributionAmountLocal = Number(fields.contribution_amount_local);
      }
      if (configValues.securityDepositLocal === 0 && fields.security_deposit_local) {
        configValues.securityDepositLocal = Number(fields.security_deposit_local);
      }
      console.log('[CONTRIBUTE DEBUG] Config after Direct Fields Fallback:', JSON.parse(JSON.stringify(configValues)));
      
      // 5. Calculate SUI amounts from TRUE USD if SUI amount is still zero (and price is available)
      // This should use the true USD equivalent for calculation
      if (configValues.contributionAmount === 0 && configValues.contributionAmountUsd > 0 && suiPrice > 0) {
          configValues.contributionAmount = (configValues.contributionAmountUsd / 100) / suiPrice;
          console.log(`Contribute - Calculated contribution SUI from USD: ${configValues.contributionAmount}`);
      }
      if (configValues.securityDeposit === 0 && configValues.securityDepositUsd > 0 && suiPrice > 0) {
          configValues.securityDeposit = (configValues.securityDepositUsd / 100) / suiPrice;
          console.log(`Contribute - Calculated security deposit SUI from USD: ${configValues.securityDeposit}`);
      }

      // Ensure walletId is set
      if (!walletId && typeof fields.wallet_id === 'string') {
          walletId = fields.wallet_id;
          console.log('Contribute - Using wallet ID from direct field:', walletId);
      }
        
      // Set the final circle state
      const finalCurrencyType = (transactionInput?.currency_type as string || circleCreationEventData?.currency_type || 'USD');
      
      // Final check: If local amounts are still 0, and it's a non-USD currency, populate from USD as a last resort.
      // This might happen if only USD values were stored everywhere for a non-USD circle.
      if (finalCurrencyType !== 'USD') {
          if (configValues.contributionAmountLocal === 0 && configValues.contributionAmountUsd > 0) {
              console.warn("[CONTRIBUTE DEBUG] Final Fallback: Setting contributionAmountLocal from contributionAmountUsd for non-USD circle. This might indicate a data issue.");
              configValues.contributionAmountLocal = configValues.contributionAmountUsd;
          }
          if (configValues.securityDepositLocal === 0 && configValues.securityDepositUsd > 0) {
              console.warn("[CONTRIBUTE DEBUG] Final Fallback: Setting securityDepositLocal from securityDepositUsd for non-USD circle. This might indicate a data issue.");
              configValues.securityDepositLocal = configValues.securityDepositUsd;
          }
      }
      
      // If it IS a USD circle, ensure local amounts match USD amounts if local is still 0
      if (finalCurrencyType === 'USD') {
          if (configValues.contributionAmountLocal === 0) configValues.contributionAmountLocal = configValues.contributionAmountUsd;
          if (configValues.securityDepositLocal === 0) configValues.securityDepositLocal = configValues.securityDepositUsd;
      }
      
      setCircle({
        id: id as string,
        name: typeof fields.name === 'string' ? fields.name : '',
        admin: typeof fields.admin === 'string' ? fields.admin : '',
        contributionAmount: configValues.contributionAmount, // SUI MIST
        contributionAmountUsd: configValues.contributionAmountUsd, // True USD cents
        contributionAmountLocal: configValues.contributionAmountLocal, // Local currency cents/smallest unit (e.g. XAF 40000 for 400 FCFA)
        currencyType: finalCurrencyType,
        securityDeposit: configValues.securityDeposit, // SUI MIST
        securityDepositUsd: configValues.securityDepositUsd, // True USD cents
        securityDepositLocal: configValues.securityDepositLocal, // Local currency cents/smallest unit
        walletId: walletId, 
        autoSwapEnabled: configValues.autoSwapEnabled,
        isActive: isActive, 
        maxMembers: maxMembers, 
        pausedAfterCycle: isPausedAfterCycle,
      });
      
      console.log('Contribute - Final walletId set in circle:', walletId);

      console.log('[CONTRIBUTE DEBUG] Final circle state set:', {
        id,
        name: typeof fields.name === 'string' ? fields.name : '',
        admin: typeof fields.admin === 'string' ? fields.admin : '',
        contributionAmount: configValues.contributionAmount,
        contributionAmountUsd: configValues.contributionAmountUsd,
        contributionAmountLocal: configValues.contributionAmountLocal,
        currencyType: finalCurrencyType,
        securityDeposit: configValues.securityDeposit,
        securityDepositUsd: configValues.securityDepositUsd,
        securityDepositLocal: configValues.securityDepositLocal,
        walletId,
        autoSwapEnabled: configValues.autoSwapEnabled,
        isActive,
        maxMembers,
        pausedAfterCycle: isPausedAfterCycle,
      });

    } catch (error) {
      if (isTransientSuiRpcError(error)) {
        // RPC momentarily in cooldown (rate-limit / failover). The page keeps
        // its current state and the next mount/refresh recovers — log quietly
        // instead of tripping the Next.js dev error overlay.
        console.warn('Contribute - Circle details fetch deferred (transient RPC):', getSuiRpcErrorMessage(error));
        return;
      }
      console.error('Contribute - Error fetching circle details:', error);
      toast.error('Could not load circle information');
    } finally {
      setLoading(false);
    }
  };

  const fetchUserWalletInfo = async () => {
    if (!userAddress || !circle || !circle.id) {
      console.log('[Balance Fetch] Skipping fetchUserWalletInfo - missing data:', { 
        hasUserAddress: !!userAddress, 
        userAddress,
        hasCircle: !!circle, 
        circleId: circle?.id 
      });
      return;
    }
    
    console.log('[Balance Fetch] Starting fetchUserWalletInfo for:', { userAddress, circleId: circle.id });
    setFetchingBalance(true);
    let depositPaid = false; // Default to false
    // When the user's Member struct is present in the circle's members table,
    // its `deposit_paid` field is the authoritative source of truth: removed
    // members are deleted from the table, so an in-table read already reflects
    // the current state. We only fall back to (expensive, rate-limit-prone)
    // event queries when the struct read can't answer.
    let memberFoundInTable = false;

    try {
      const client = getSuiClientFromPool(getJsonRpcUrl()); // Use helper function for URL
      
      // --- Get SUI Balance ---
      console.log('[Balance Fetch] Fetching SUI balance for address:', userAddress);
      const coins = await client.getCoins({ owner: userAddress, coinType: '0x2::sui::SUI' });
      console.log('[Balance Fetch] Found coins:', coins.data.length);
      console.log('[Balance Fetch] Coin details:', coins.data.map(coin => ({
        coinObjectId: coin.coinObjectId,
        balance: coin.balance
      })));
      const totalBalance = coins.data.reduce((sum, coin) => sum + Number(coin.balance), 0) / 1e9;
      console.log('[Balance Fetch] Total SUI balance:', totalBalance);
      setUserBalance(totalBalance);

      // --- Get USDC Balance (Remains the same) ---
      try {
        const usdcCoins = await client.getCoins({ owner: userAddress, coinType: USDC_COIN_TYPE });
        const totalUsdcBalance = usdcCoins.data.reduce((sum, coin) => sum + Number(coin.balance), 0) / 1e6; // This is in actual USDC units (dollars)
        setUserUsdcBalance(totalUsdcBalance);

        // --- Updated logic for showing direct deposit option --- 
        let showOption = false;
        // circle.securityDepositUsd and circle.contributionAmountUsd from circle state are in CENTS.
        // Convert them to dollars for comparison with totalUsdcBalance.
        const securityDepositInDollars = (circle.securityDepositUsd || 0) / 100;
        const contributionInDollars = (circle.contributionAmountUsd || 0) / 100;

        const hasEnoughForSecurity = totalUsdcBalance >= securityDepositInDollars;
        const hasEnoughForContribution = totalUsdcBalance >= contributionInDollars;
        const circleActive = Boolean(circle.isActive);
        const circlePaused = Boolean(circle.pausedAfterCycle);

        // Log intermediate values for debugging
        console.log('[Direct Deposit Check]', {
            userDepositPaid, 
            hasEnoughForSecurity,
            hasEnoughForContribution,
            circleActive,
            circlePaused,
            securityDepositRequiredUSD_ForCheck: securityDepositInDollars,
            contributionRequiredUSD_ForCheck: contributionInDollars,
            userUsdcBalance_InDollars: totalUsdcBalance,
            _rawCircleSecDepUsd_InCents: circle.securityDepositUsd,
            _rawCircleContrUsd_InCents: circle.contributionAmountUsd
        });

        // The legacy direct-deposit card now serves the SECURITY DEPOSIT only —
        // cycle contributions go through the CycleEscrowPanel. (The contribution
        // branch was removed so members don't get a second, out-of-sync pay
        // button; renderContributionOptions also returns null once the deposit
        // is paid.) circleActive/circlePaused stay computed for the logs above.
        if (!userDepositPaid && securityDepositInDollars > 0 && hasEnoughForSecurity) {
          showOption = true;
          console.log("Logic: Showing direct deposit for SECURITY DEPOSIT because it's > 0 and user has enough USDC.");
        }

        setShowDirectDepositOption(showOption);
        // --- End of updated logic ---

      } catch (error) {
        logSuiReadError('Error fetching USDC balance:', error);
        setUserUsdcBalance(null);
        setShowDirectDepositOption(false);
      }
      
      // --- Check Deposit Status ---
      console.log(`Checking deposit status for user ${userAddress} in circle ${circle.id}...`);
      
      // Method 1: Try fetching the Member object directly (Best Source of Truth)
      try {
        const circleObject = await readObject(circle.id, { showContent: true });
        
        if (circleObject.data?.content && 'fields' in circleObject.data.content) {
          const circleFields = circleObject.data.content.fields as {
            members?: { fields?: { id?: { id: string } } } // Check if members table exists
          };
          
          if (circleFields.members?.fields?.id?.id) {
            const membersTableId = circleFields.members.fields.id.id;
            console.log(`Attempting to fetch Member object using key ${userAddress} from table ${membersTableId}`);
            
            // Get the dynamic field representing the Member object within the Table
            const memberField = await client.getDynamicFieldObject({
              parentId: membersTableId,
              name: {
                type: 'address', // The key type for the members table is address
                value: userAddress
              }
            });
            
            if (memberField.data?.content && 'fields' in memberField.data.content) {
              const memberFields = memberField.data.content.fields as {
                value?: { fields?: { deposit_paid?: boolean, [key: string]: unknown } } // Access nested value.fields
              };

              if (memberFields.value?.fields?.deposit_paid !== undefined) {
                memberFoundInTable = true;
                depositPaid = Boolean(memberFields.value.fields.deposit_paid);
                console.log(`Deposit status found directly in Member struct: ${depositPaid}`);
              } else {
                 console.log('Member struct found, but deposit_paid field missing or undefined.');
              }
            } else {
               console.log('Could not find dynamic field object for this user in the members table.');
            }
          } else {
            console.log('Members table ID not found in Circle object.');
          }
        }
      } catch (error) {
        console.warn('Could not fetch Member object directly, falling back to event checks:', error);
      }
      
      // Method 2: Check MemberActivated Event (only when the struct read above
      // couldn't answer — i.e. the user isn't currently in the members table).
      if (!memberFoundInTable && !depositPaid) {
        console.log('Checking MemberActivated events...');
        try {
          const memberActivatedEvents = await client.queryEvents({
            // Correct module name is njangi_members
            query: { MoveEventType: `${circlePackageId}::njangi_members::MemberActivated` }, 
            limit: 50
          });
          
          depositPaid = memberActivatedEvents.data.some(event => {
            const parsed = event.parsedJson as { circle_id?: string; member?: string };
            return parsed?.circle_id === circle.id && parsed?.member === userAddress;
          });
          if (depositPaid) {
            console.log('Deposit status confirmed via MemberActivated event.');
          } else {
            console.log('No MemberActivated event found for this user/circle.');
          }
        } catch (eventError) {
          if (isTransientSuiRpcError(eventError)) {
            console.warn('MemberActivated events deferred (transient RPC):', getSuiRpcErrorMessage(eventError));
          } else {
            console.error('Error fetching MemberActivated events:', eventError);
          }
        }
      }

      // Method 3: Check Custody/Stablecoin Events (Further fallback)
      if (!memberFoundInTable && !depositPaid) {
        console.log('Checking deposit-related events as final fallback...');
        // Check CustodyDeposited events (operation_type 3)
        const custodyEvents = await client.queryEvents({
          query: { MoveEventType: `${circlePackageId}::njangi_custody::CustodyDeposited` }, limit: 50
        });
        const foundCustodyEvent = custodyEvents.data.some(e => {
           const p = e.parsedJson as { circle_id?: string; member?: string; operation_type?: number | string };
           return p?.circle_id === circle.id && p?.member === userAddress && (p?.operation_type === 3 || p?.operation_type === "3");
        });
        if(foundCustodyEvent) {
          depositPaid = true;
          console.log("Deposit status confirmed via CustodyDeposited event (type 3).");
        }
        // Add more event checks here if needed
      }

      // New Step: Check SecurityDepositReturned Event and compare timestamps with deposit events
      // This handles the case where a user was removed (deposit returned), then re-added.
      // We need to compare the MOST RECENT return event with the MOST RECENT deposit event.
      // Skipped when the member is in the table: the struct's deposit_paid is
      // already authoritative there, and a removed member is gone from the table.
      if (!memberFoundInTable) try {
        console.log(`[ContributePage] Checking SecurityDepositReturned events for ${userAddress} in circle ${circle.id}...`);
        const securityReturnedEvents = await client.queryEvents({
          query: { MoveEventType: `${circlePackageId}::njangi_payments::SecurityDepositReturned` }, 
          limit: 50
        });
        
        // Find all return events for this user/circle
        const relevantReturnEvents = securityReturnedEvents.data.filter(event => {
          const parsed = event.parsedJson as { circle_id?: string; member?: string };
          return parsed?.circle_id === circle.id && 
                 parsed?.member?.toLowerCase() === userAddress.toLowerCase();
        });

        if (relevantReturnEvents.length > 0) {
          // Get the most recent return event timestamp
          const mostRecentReturnTimestamp = Math.max(
            ...relevantReturnEvents.map(e => Number(e.timestampMs || 0))
          );
          console.log(`[ContributePage] Most recent SecurityDepositReturned at: ${new Date(mostRecentReturnTimestamp).toISOString()}`);
          
          // Now find the most recent deposit event (CustodyDeposited with operation_type 3)
          let mostRecentDepositTimestamp = 0;
          
          const custodyDepositEvents = await client.queryEvents({
            query: { MoveEventType: `${circlePackageId}::njangi_custody::CustodyDeposited` }, 
            limit: 100
          });
          
          for (const event of custodyDepositEvents.data) {
            const parsed = event.parsedJson as { 
              circle_id?: string; 
              member?: string; 
              operation_type?: number | string;
            };
            const opType = typeof parsed?.operation_type === 'string' 
              ? parseInt(parsed.operation_type) 
              : parsed?.operation_type;
            
            if (parsed?.circle_id === circle.id && 
                parsed?.member?.toLowerCase() === userAddress.toLowerCase() && 
                opType === 3) {
              const eventTimestamp = Number(event.timestampMs || 0);
              if (eventTimestamp > mostRecentDepositTimestamp) {
                mostRecentDepositTimestamp = eventTimestamp;
              }
            }
          }
          
          console.log(`[ContributePage] Most recent CustodyDeposited (type 3) at: ${
            mostRecentDepositTimestamp > 0 ? new Date(mostRecentDepositTimestamp).toISOString() : 'none found'
          }`);
          
          // If the most recent return is AFTER the most recent deposit (or no deposit found),
          // then the deposit is NOT paid
          if (mostRecentReturnTimestamp > mostRecentDepositTimestamp) {
            depositPaid = false;
            console.log(`[ContributePage] User ${userAddress} deposit status set to NOT PAID - return event (${new Date(mostRecentReturnTimestamp).toISOString()}) is more recent than any deposit event`);
          } else if (mostRecentDepositTimestamp > mostRecentReturnTimestamp) {
            // User made a new deposit AFTER the return - deposit IS paid
            depositPaid = true;
            console.log(`[ContributePage] User ${userAddress} deposit status confirmed PAID - deposit (${new Date(mostRecentDepositTimestamp).toISOString()}) is more recent than return (${new Date(mostRecentReturnTimestamp).toISOString()})`);
          }
        }
      } catch (eventError) {
        if (isTransientSuiRpcError(eventError)) {
          console.warn('[ContributePage] SecurityDepositReturned reconciliation deferred (transient RPC):', getSuiRpcErrorMessage(eventError));
        } else {
          console.warn(`[ContributePage] Error checking SecurityDepositReturned events:`, eventError);
        }
      }

      setUserDepositPaid(depositPaid);
      console.log('Final user deposit status:', depositPaid ? 'Paid' : 'Not Paid');

    } catch (error) {
      if (isTransientSuiRpcError(error)) {
        console.warn('User wallet info fetch deferred (transient RPC):', getSuiRpcErrorMessage(error));
      } else {
        console.error('Error fetching user wallet info:', error);
      }
    } finally {
      setFetchingBalance(false);
    }
  };

  // Add a function to check if the user has contributed for the current cycle
  const checkUserContribution = async () => {
    if (!circle || !circle.id || !userAddress) return;
    
    // If circle is paused after cycle, no contributions are allowed
    if (circle.pausedAfterCycle) {
      console.log(`[Contribution Check] Circle is paused after cycle - contributions not possible`);
      setUserHasContributed(false);
      return false;
    }
    
    console.log(`[Contribution Check] Starting check for user ${userAddress} in circle ${circle.id} for cycle ${currentCycle}`);

    try {
      const client = getSuiClientFromPool(getJsonRpcUrl());
      const circleObject = await readObject(circle.id, { showContent: true });

      if (!circleObject.data?.content || !('fields' in circleObject.data.content)) {
        setUserHasContributed(false);
        return false;
      }

      const circleFields = circleObject.data.content.fields as {
        current_position?: string | number;
        rotation_order?: unknown[];
        members?: { fields?: { id?: { id?: string } } };
      };

      const rotationOrder = Array.isArray(circleFields.rotation_order)
        ? circleFields.rotation_order.filter((value): value is string => typeof value === 'string' && value !== '0x0')
        : [];
      const currentPosition = typeof circleFields.current_position === 'string'
        ? parseInt(circleFields.current_position, 10)
        : typeof circleFields.current_position === 'number'
          ? circleFields.current_position
          : null;
      const currentRecipient = currentPosition !== null &&
        currentPosition >= 0 &&
        currentPosition < rotationOrder.length
          ? rotationOrder[currentPosition]
          : null;

      if (currentRecipient === userAddress) {
        console.log(`[Contribution Check] User ${userAddress} is the current recipient and does not need to contribute`);
        setUserHasContributed(false);
        return false;
      }

      const membersTableId = circleFields.members?.fields?.id?.id;
      if (!membersTableId) {
        setUserHasContributed(false);
        return false;
      }

      const memberField = await client.getDynamicFieldObject({
        parentId: membersTableId,
        name: { type: 'address', value: userAddress }
      });

      let hasContributed = false;
      if (memberField.data?.content && 'fields' in memberField.data.content) {
        const memberWrapper = memberField.data.content.fields as {
          value?: {
            fields?: {
              last_contribution?: string | number;
              status?: string | number;
              deposit_paid?: boolean;
            };
          };
        };

        const memberData = memberWrapper.value?.fields;
        const lastContributionRaw = parseU64Like(memberData?.last_contribution);
        const rawStatus = memberData?.status;
        const statusRaw = typeof rawStatus === 'string'
          ? parseInt(rawStatus, 10)
          : typeof rawStatus === 'number'
            ? rawStatus
            : null;
        const isActiveMember = statusRaw === null ? true : statusRaw === 0;

        hasContributed = Boolean(memberData?.deposit_paid) && isActiveMember && lastContributionRaw > 0n;
        console.log('[Contribution Check] Member snapshot result:', {
          userAddress,
          lastContributionRaw: lastContributionRaw.toString(),
          statusRaw,
          hasContributed
        });
      }
      
      console.log(`[Contribution Check] Final result for user ${userAddress}: ${hasContributed ? 'HAS contributed' : 'has NOT contributed'}`);
      setUserHasContributed(hasContributed);
      
      // Return the result for immediate use
      return hasContributed;
    } catch (error) {
      if (isTransientSuiRpcError(error)) {
        console.warn('Contribution check deferred (transient RPC):', getSuiRpcErrorMessage(error));
        return false;
      }
      console.error("Error checking user contributions:", error);
      return false;
    }
  };

  // Add new function to check if user is the current recipient
  const checkIfUserIsCurrentRecipient = async () => {
    if (!circle || !circle.id || !userAddress || !circle.isActive) {
      return false;
    }
    
    // If circle is paused after cycle, there is no current recipient
    if (circle.pausedAfterCycle) {
      console.log(`[Recipient Check] Circle is paused after cycle - no current recipient`);
      setIsCurrentRecipient(false);
      return false;
    }
    
    console.log(`[Recipient Check] Checking if user ${userAddress} is the current recipient in circle ${circle.id}`);

    try {
      const circleObject = await readObject(circle.id, { showContent: true });

      if (circleObject.data?.content && 'fields' in circleObject.data.content) {
        const circleFields = circleObject.data.content.fields as Record<string, unknown>;;
        const currentPosition = Number(circleFields.current_position || 0);
        const rotationOrder = (circleFields.rotation_order as string[] || []).filter(addr => typeof addr === 'string' && addr !== '0x0');
        
        // Also set these for the main display if not already set by fetchCircleDetails
        // This ensures they are updated if this function runs after initial load due to cycle changes
        if (currentPositionInCycle === null && rotationOrder.length > 0) {
            setCurrentPositionInCycle(currentPosition);
        }
        if (totalMembersInRotation === null && rotationOrder.length > 0) {
            setTotalMembersInRotation(rotationOrder.length);
    }

        console.log(`[Recipient Check] Current position: ${currentPosition}`);
        console.log(`[Recipient Check] Rotation order:`, rotationOrder);
        
        if (Array.isArray(rotationOrder) && 
            currentPosition >= 0 && 
            currentPosition < rotationOrder.length) {
          const recipientAddress = rotationOrder[currentPosition];
          const isRecipient = recipientAddress === userAddress;
          
          console.log(`[Recipient Check] Recipient address: ${recipientAddress}`);
          console.log(`[Recipient Check] Is user the recipient? ${isRecipient}`);
          
          setIsCurrentRecipient(isRecipient);
          return isRecipient;
        }
      }
      
      setIsCurrentRecipient(false);
      return false;
    } catch (error) {
      logSuiReadError('Error checking if user is current recipient:', error);
      setIsCurrentRecipient(false);
      return false;
    }
  };

  // Add a function to check if the user has received a security deposit payout
  const checkSecurityDepositReturned = async () => {
    if (!circle || !circle.id || !userAddress) return false;
    
    try {
      const client = getSuiClientFromPool(getJsonRpcUrl());
      console.log(`[SecurityDepositCheck] Checking if ${userAddress} has received security deposit payout in circle ${circle.id}`);
      
      // Look for SecurityDepositReturned events for this user and circle
      const securityReturnedEvents = await client.queryEvents({
        query: { MoveEventType: `${circlePackageId}::njangi_payments::SecurityDepositReturned` }, 
        limit: 50
      });
      
      // Filter events by circle and user
      const relevantEvents = securityReturnedEvents.data.filter(event => {
        const parsed = event.parsedJson as { circle_id?: string; member?: string; };
        return parsed?.circle_id === circle.id && 
               parsed?.member?.toLowerCase() === userAddress.toLowerCase();
      });
      
      if (relevantEvents.length === 0) {
        console.log(`[SecurityDepositCheck] No security deposit return events found for ${userAddress}`);
        setSecurityDepositReturnedDuringPause(false);
        return false;
      }
      
      // Find the most recent return event
      const mostRecentEvent = relevantEvents.sort((a, b) => {
        return (Number(b.timestampMs) || 0) - (Number(a.timestampMs) || 0);
      })[0];
      
      // Check if the event happened during the current cycle 
      // and after the most recent CycleResumed event (if any)
      const returnTimestamp = Number(mostRecentEvent.timestampMs);
      console.log(`[SecurityDepositCheck] Found security deposit return event at ${new Date(returnTimestamp).toISOString()}`);
      
      // Check for the most recent CycleResumed event
      const cycleResumedEvents = await client.queryEvents({
        query: { MoveEventType: `${circlePackageId}::njangi_circles::CycleResumed` },
        limit: 20
      });
      
      // Filter and sort to find the most recent resume event for this circle
      const circleResumeEvents = cycleResumedEvents.data
        .filter(event => {
          const parsedJson = event.parsedJson as { circle_id?: string };
          return parsedJson?.circle_id === circle.id;
        })
        .sort((a, b) => {
          return (Number(b.timestampMs) || 0) - (Number(a.timestampMs) || 0);
        });
      
      // If there's a resume event, check if the deposit return happened after it
      if (circleResumeEvents.length > 0) {
        const lastResumeTimestamp = Number(circleResumeEvents[0].timestampMs);
        console.log(`[SecurityDepositCheck] Last cycle resume was at ${new Date(lastResumeTimestamp).toISOString()}`);
        
        // If the return happened after the last resume, and the circle is currently paused,
        // then the user has received their deposit during the current pause period
        if (returnTimestamp > lastResumeTimestamp && circle.pausedAfterCycle) {
          console.log(`[SecurityDepositCheck] User received security deposit payout during current pause period`);
          setSecurityDepositReturnedDuringPause(true);
          return true;
        }
      } else if (circle.pausedAfterCycle) {
        // If there are no resume events but the circle is paused, assume the return
        // happened during the current pause (since there's no previous pause to compare with)
        console.log(`[SecurityDepositCheck] No resume events found, but circle is paused. Assuming security deposit was returned during current pause.`);
        setSecurityDepositReturnedDuringPause(true);
        return true;
      }
      
      console.log(`[SecurityDepositCheck] Security deposit was not returned during current pause period`);
      setSecurityDepositReturnedDuringPause(false);
      return false;
      
    } catch (error) {
      logSuiReadError('[SecurityDepositCheck] Error checking security deposit return status:', error);
      return false;
    }
  };

  // Update useEffect to call the new function
  useEffect(() => {
    if (circle && userAddress && circle.pausedAfterCycle) {
      checkSecurityDepositReturned();
    }
    // `checkSecurityDepositReturned` is a stable component closure; deps
    // captured via circle/userAddress already.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [circle, userAddress]);

  // Legacy custody contribute retired 2026-04-28. Members now contribute
  // through the CycleEscrowPanel rendered at the top of this page, which
  // calls njangi_cycle_escrow::contribute<T> with a frozen CycleSnapshot.
  // Any legacy callsite still wired to this function gets a toast pointer
  // instead of a Move call.
  const handleContribute = async () => {
    toast(
      'Contributions now run through the round panel above (per-cycle escrow). Pay your share there.',
      { icon: 'ℹ️' },
    );
  };

  // Add a helper function to get valid security deposit amount in SUI
  const getSecurityDepositInSui = (): number => {
    // Make sure we have a valid, reasonable number
    const securityDeposit = typeof circle?.securityDeposit === 'number' && !isNaN(circle.securityDeposit)
      ? circle.securityDeposit : 0;
    
    // Validate the amount is reasonable (not millions)
    const isValidAmount = securityDeposit > 0 && securityDeposit < 1000;
    
    // If amount seems incorrect but we have USD value, calculate from USD
    if (!isValidAmount && circle?.securityDepositUsd && 
        typeof circle.securityDepositUsd === 'number' && 
        !isNaN(circle.securityDepositUsd) && 
        typeof suiPrice === 'number' && 
        suiPrice > 0) {
      return circle.securityDepositUsd / suiPrice;
    }
    
    // Return the original amount if it's valid, or 0 as a safe default
    return isValidAmount ? securityDeposit : 0;
  };

  // New function to calculate total required amount including slippage and fees
  const calculateTotalRequiredAmount = (baseAmount: number): number => {
    if (!baseAmount || baseAmount <= 0) return 0;
    
    // Calculate slippage buffer (DEFAULT_SLIPPAGE% of the base amount)
    const slippageBuffer = baseAmount * (DEFAULT_SLIPPAGE / 100);
    
    // Add additional buffer for exchange rate fluctuations
    const rateFluctuationBuffer = baseAmount * (BUFFER_PERCENTAGE / 100);
    
    // Calculate total with all buffers and gas fee
    const total = baseAmount + slippageBuffer + rateFluctuationBuffer + ESTIMATED_GAS_FEE;
    
    return total;
  };

  // New function to calculate the deposit amount including all necessary buffers
  const getRequiredDepositAmount = (): number => {
    const baseAmount = getSecurityDepositInSui();
    return calculateTotalRequiredAmount(baseAmount);
  };

  // New function to calculate the contribution amount including all necessary buffers
  const getRequiredContributionAmount = (): number => {
    const baseAmount = getValidContributionAmount();
    return calculateTotalRequiredAmount(baseAmount);
  };

  const getCurrentUsdcPaymentAmount = (): number =>
    userDepositPaid ? requiredContributionUsdc : requiredSecurityDepositUsdc;

  const getCurrentSuiPaymentAmount = (): number =>
    userDepositPaid ? getRequiredContributionAmount() : getRequiredDepositAmount();

  const getCurrentSuiBasePaymentAmount = (): number =>
    userDepositPaid ? getValidContributionAmount() : getSecurityDepositInSui();

  const getSuiAmountShortfallForAssistSwap = (): number => {
    const requiredSuiForPayment = getCurrentSuiPaymentAmount();
    if (!requiredSuiForPayment) return 0;

    const executionBuffer = requiredSuiForPayment * (TOKEN_ASSIST_EXTRA_OUTPUT_BUFFER_PERCENT / 100);
    const totalSuiTarget =
      requiredSuiForPayment + TOKEN_ASSIST_SWAP_GAS_RESERVE_SUI + executionBuffer;

    return Math.max(0, totalSuiTarget - (userBalance || 0));
  };

  const getLegacyUsdcAmountNeededForSuiAssistSwap = (): number => {
    const requiredSui = getSuiAmountShortfallForAssistSwap();
    if (!requiredSui || suiPrice <= 0) return 0;

    const usdEquivalent = requiredSui * suiPrice;
    const swapBuffer = 1 + (DEFAULT_SLIPPAGE / 100) + (BUFFER_PERCENTAGE / 100);
    return usdEquivalent * swapBuffer;
  };

  const getUsdcAmountNeededForSuiAssistSwap = (): number => {
    if (tokenAssistQuote && tokenAssistQuote.usdcIn > 0) {
      return tokenAssistQuote.usdcIn;
    }

    return getLegacyUsdcAmountNeededForSuiAssistSwap();
  };

  const currentSuiAssistShortfall = getSuiAmountShortfallForAssistSwap();

  const getCurrentUsdcShortfallForOneClickSwap = (): number => {
    const requiredUsdc = getCurrentUsdcPaymentAmount();
    return Math.max(0, requiredUsdc - (userUsdcBalance || 0));
  };

  const getLegacySuiAmountNeededForOneClickSwap = (): number => {
    const usdcShortfall = getCurrentUsdcShortfallForOneClickSwap();
    if (!usdcShortfall || suiPrice <= 0) return 0;

    const estimatedSui = usdcShortfall / suiPrice;
    const swapBuffer = 1 + (DEFAULT_SLIPPAGE / 100) + (BUFFER_PERCENTAGE / 100);
    return estimatedSui * swapBuffer;
  };

  const getOneClickQuotedSuiInput = (): number => {
    if (oneClickSwapQuote && oneClickSwapQuote.suiIn > 0) {
      return oneClickSwapQuote.suiIn;
    }

    return getLegacySuiAmountNeededForOneClickSwap();
  };

  const currentUsdcShortfallForOneClickSwap = getCurrentUsdcShortfallForOneClickSwap();

  useEffect(() => {
    if (!userAddress || selectedPaymentCurrency !== 'SUI' || !isSuiCircleModeEnabled) {
      setTokenAssistQuote(null);
      setTokenAssistQuoteError(null);
      setIsTokenAssistQuoteLoading(false);
      return;
    }

    if (currentSuiAssistShortfall <= 0) {
      setTokenAssistQuote(null);
      setTokenAssistQuoteError(null);
      setIsTokenAssistQuoteLoading(false);
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setIsTokenAssistQuoteLoading(true);
      setTokenAssistQuoteError(null);

      try {
        cetusService.init(userAddress, getCurrentNetwork());
        const quote = await cetusService.getSwapEstimate(
          USDC_COIN_TYPE,
          getCoinType('SUI'),
          Number(currentSuiAssistShortfall.toFixed(9)),
          false
        );

        if (!quote) {
          throw new Error('No swap route is available right now.');
        }

        if (!cancelled) {
          setTokenAssistQuote({
            usdcIn: Number.parseFloat(quote.amountIn),
            suiOut: Number.parseFloat(quote.amountOut),
            priceImpact: quote.priceImpact,
          });
        }
      } catch (error) {
        if (!cancelled) {
          setTokenAssistQuote(null);
          setTokenAssistQuoteError(
            error instanceof Error ? error.message : 'Unable to calculate a live swap quote.'
          );
        }
      } finally {
        if (!cancelled) {
          setIsTokenAssistQuoteLoading(false);
        }
      }
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    USDC_COIN_TYPE,
    circle?.contributionAmount,
    circle?.contributionAmountUsd,
    circle?.id,
    circle?.securityDeposit,
    circle?.securityDepositUsd,
    currentSuiAssistShortfall,
    isSuiCircleModeEnabled,
    selectedPaymentCurrency,
    suiPrice,
    userAddress,
    userBalance,
    userDepositPaid,
  ]);

  useEffect(() => {
    if (!userAddress || selectedPaymentCurrency !== 'USDC') {
      setOneClickSwapQuote(null);
      setOneClickSwapQuoteError(null);
      setIsOneClickSwapQuoteLoading(false);
      return;
    }

    if (currentUsdcShortfallForOneClickSwap <= 0) {
      setOneClickSwapQuote(null);
      setOneClickSwapQuoteError(null);
      setIsOneClickSwapQuoteLoading(false);
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setIsOneClickSwapQuoteLoading(true);
      setOneClickSwapQuoteError(null);

      try {
        cetusService.init(userAddress, getCurrentNetwork());
        const quote = await cetusService.getSwapEstimate(
          getCoinType('SUI'),
          USDC_COIN_TYPE,
          Number(currentUsdcShortfallForOneClickSwap.toFixed(6)),
          false
        );

        if (!quote) {
          throw new Error('No swap route is available right now.');
        }

        if (!cancelled) {
          setOneClickSwapQuote({
            suiIn: Number.parseFloat(quote.amountIn),
            usdcOut: Number.parseFloat(quote.amountOut),
            priceImpact: quote.priceImpact,
          });
        }
      } catch (error) {
        if (!cancelled) {
          setOneClickSwapQuote(null);
          setOneClickSwapQuoteError(
            error instanceof Error ? error.message : 'Unable to calculate a live swap quote.'
          );
        }
      } finally {
        if (!cancelled) {
          setIsOneClickSwapQuoteLoading(false);
        }
      }
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    USDC_COIN_TYPE,
    currentUsdcShortfallForOneClickSwap,
    selectedPaymentCurrency,
    userAddress,
    userUsdcBalance,
  ]);

  const hasSufficientSuiForOneClickSwap = (): boolean => {
    if (userBalance === null) return false;
    const requiredSui = getOneClickQuotedSuiInput();
    return userBalance - ONE_CLICK_GAS_RESERVE_SUI >= requiredSui;
  };

  const getOneClickSwapAmountSui = (): number => {
    if (userBalance === null) return 0;
    const requiredSui = getOneClickQuotedSuiInput();
    if (requiredSui <= 0) return 0;

    const maxSpendable = Math.max(0, userBalance - ONE_CLICK_GAS_RESERVE_SUI);
    return Math.max(0, Math.min(requiredSui, maxSpendable));
  };

  const pollOneClickSwapTxStatus = async (digest: string): Promise<void> => {
    const client = getSuiClientFromPool(getCurrentRpcUrl());
    const maxAttempts = 15;
    const intervalMs = 2000;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const txData = await client.getTransactionBlock({
          digest,
          options: { showEffects: true },
        });

        const status = txData.effects?.status?.status;
        if (status === 'success') {
          return;
        }

        if (status === 'failure') {
          throw new Error(txData.effects?.status?.error || 'Swap + deposit transaction failed.');
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message.toLowerCase() : '';
        const txNotIndexedYet =
          errorMessage.includes('not found') ||
          errorMessage.includes('not exist') ||
          errorMessage.includes('could not find');

        if (!txNotIndexedYet) {
          throw error;
        }
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    throw new Error('Timed out waiting for transaction confirmation. Check your wallet history and retry.');
  };

  const handleOneClickSwapAndDeposit = async () => {
    if (!circle || !account || !userAddress) {
      toast.error('Missing circle or account information.');
      return;
    }

    if (!circle.walletId) {
      toast.error('Circle wallet is unavailable. Refresh the page and try again.');
      return;
    }

    if (selectedPaymentCurrency !== 'USDC') {
      toast.error('One-click conversion is only available in USDC circle mode.');
      return;
    }

    if (!userDepositPaid && (circle.securityDepositUsd || 0) <= 0) {
      toast.error('Security deposit amount is unavailable. Refresh the page and try again.');
      return;
    }

    if (
      userDepositPaid &&
      (!circle.isActive || circle.pausedAfterCycle || userHasContributed || isCurrentRecipient)
    ) {
      toast.error('You cannot contribute at this time.');
      return;
    }

    if (!userDepositPaid && circle.pausedAfterCycle && securityDepositReturnedDuringPause) {
      toast.error('Your prior security deposit was already returned for this paused cycle.');
      return;
    }

    const usdcShortfall = getCurrentUsdcShortfallForOneClickSwap();
    if (usdcShortfall <= 0) {
      toast.error('Your wallet already has enough USDC for this payment.');
      return;
    }

    if (isOneClickSwapQuoteLoading) {
      toast.error('Still calculating the live swap quote. Try again in a moment.');
      return;
    }

    if (oneClickSwapQuoteError) {
      toast.error(oneClickSwapQuoteError);
      return;
    }

    const quotedSuiInput = getOneClickQuotedSuiInput();
    if (!hasSufficientSuiForOneClickSwap()) {
      toast.error(
        `Insufficient SUI for conversion. Need about ${quotedSuiInput.toFixed(4)} SUI plus gas reserve.`
      );
      return;
    }

    if (quotedSuiInput <= 0) {
      toast.error('Invalid swap amount. Refresh balances and try again.');
      return;
    }

    setIsOneClickSwapProcessing(true);
    setOneClickSwapError(null);
    setOneClickSwapDigest(null);

    try {
      const paymentLabel = userDepositPaid ? 'contribution' : 'security deposit';
      toast.loading(`Submitting SUI -> USDC conversion for your ${paymentLabel}...`, {
        id: 'one-click-swap-deposit',
      });

      cetusService.init(userAddress, getCurrentNetwork());
      const liveQuote = await cetusService.getSwapEstimate(
        getCoinType('SUI'),
        USDC_COIN_TYPE,
        Number(usdcShortfall.toFixed(6)),
        false
      );

      if (!liveQuote) {
        throw new Error('Unable to find a valid SUI -> USDC route for this payment.');
      }

      const latestQuotedSuiInput = Number.parseFloat(liveQuote.amountIn);
      if (!Number.isFinite(latestQuotedSuiInput) || latestQuotedSuiInput <= 0) {
        throw new Error('Invalid quote returned for the SUI -> USDC conversion.');
      }

      if (userBalance === null || userBalance - ONE_CLICK_GAS_RESERVE_SUI < latestQuotedSuiInput) {
        throw new Error(
          `Insufficient SUI for conversion. Need about ${latestQuotedSuiInput.toFixed(4)} SUI plus gas reserve.`
        );
      }

      setOneClickSwapQuote({
        suiIn: latestQuotedSuiInput,
        usdcOut: Number.parseFloat(liveQuote.amountOut),
        priceImpact: liveQuote.priceImpact,
      });

      const payload = await cetusService.getSwapTransactionPayload(
        getCoinType('SUI'),
        USDC_COIN_TYPE,
        Number(usdcShortfall.toFixed(6)),
        DEFAULT_SLIPPAGE,
        false
      );

      if (!payload) {
        throw new Error('Failed to prepare the SUI -> USDC swap transaction.');
      }

      // Signed in the browser — the routing transaction is already built and
      // serialized here, so the swap is authorized entirely client-side.
      const swapResponseData = await new ZkLoginClient().sendPrebuiltTransactionBytes(
        account,
        payload,
        getCurrentNetwork(),
      );

      setOneClickSwapDigest(swapResponseData.digest || null);
      toast.loading('Transaction submitted. Waiting for on-chain confirmation...', {
        id: 'one-click-swap-deposit',
      });

      await pollOneClickSwapTxStatus(swapResponseData.digest);
      await fetchUserWalletInfo();

      toast.loading('Swap confirmed. Submitting the USDC payment...', {
        id: 'one-click-swap-deposit',
      });

      const requiredAmountInCents = userDepositPaid
        ? circle.contributionAmountUsd || 0
        : circle.securityDepositUsd || 0;

      const depositResponse = await fetch('/api/zkLogin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'depositUsdcDirect',
          account,
          circleId: circle.id,
          walletId: circle.walletId,
          usdcAmount: requiredAmountInCents,
          isSecurityDeposit: !userDepositPaid,
          network: getCurrentNetwork(),
        }),
      });

      const depositResponseData = await depositResponse.json();
      if (!depositResponse.ok) {
        throw new Error(
          depositResponseData.error ||
            'Swap succeeded, but the follow-up USDC payment could not be submitted.'
        );
      }

      toast.success(
        userDepositPaid
          ? 'Converted SUI to USDC, then deposited your contribution successfully.'
          : 'Converted SUI to USDC, then paid your security deposit successfully.',
        {
          id: 'one-click-swap-deposit',
        }
      );

      // The swap+deposit mutated on-chain state — drop cached circle reads so
      // the refreshers below reflect it rather than the pre-deposit snapshot.
      invalidateObject(circle.id);

      // Refresh key page state after confirmation.
      fetchUserWalletInfo();
      fetchCircleDetails();
      fetchCustodyWalletBalance();
      checkUserContribution();
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'One-click swap + deposit failed.';
      setOneClickSwapError(errorMessage);
      toast.error(errorMessage, { id: 'one-click-swap-deposit' });
    } finally {
      setIsOneClickSwapProcessing(false);
    }
  };

  const handleSwapUsdcToSuiForPayment = async () => {
    if (!circle || !account || !userAddress) {
      toast.error('Missing circle or account information.');
      return;
    }

    if (selectedPaymentCurrency !== 'SUI') {
      toast.error('This balance assist is only available for SUI circle mode.');
      return;
    }

    if (!isSuiCircleModeEnabled) {
      toast.error('This circle is not currently routing payments in SUI.');
      return;
    }

    const requiredSuiShortfall = getSuiAmountShortfallForAssistSwap();
    if (!requiredSuiShortfall || requiredSuiShortfall <= 0) {
      toast.error('Your wallet already has enough SUI for this payment.');
      return;
    }

    setIsTokenAssistSwapProcessing(true);
    setTokenAssistSwapError(null);
    setTokenAssistSwapDigest(null);

    try {
      toast.loading('Converting USDC to SUI for this payment...', {
        id: 'token-assist-swap',
      });

      cetusService.init(userAddress, getCurrentNetwork());
      const liveQuote = await cetusService.getSwapEstimate(
        USDC_COIN_TYPE,
        getCoinType('SUI'),
        Number(requiredSuiShortfall.toFixed(9)),
        false
      );

      if (!liveQuote) {
        throw new Error('Unable to estimate the USDC amount needed for this SUI payment.');
      }

      const quotedUsdcInput = Number.parseFloat(liveQuote.amountIn);
      if (!Number.isFinite(quotedUsdcInput) || quotedUsdcInput <= 0) {
        throw new Error('Invalid quote returned for the USDC -> SUI conversion.');
      }

      if (userUsdcBalance === null || userUsdcBalance < quotedUsdcInput) {
        throw new Error(
          `Insufficient USDC to convert. Need about ${formatUSD(quotedUsdcInput)} but only ${formatUSD(userUsdcBalance || 0)} is available.`
        );
      }

      setTokenAssistQuote({
        usdcIn: quotedUsdcInput,
        suiOut: Number.parseFloat(liveQuote.amountOut),
        priceImpact: liveQuote.priceImpact,
      });

      const payload = await cetusService.getSwapTransactionPayload(
        USDC_COIN_TYPE,
        getCoinType('SUI'),
        Number(requiredSuiShortfall.toFixed(9)),
        DEFAULT_SLIPPAGE,
        false
      );

      if (!payload) {
        throw new Error('Failed to prepare the USDC -> SUI swap transaction.');
      }

      // Signed in the browser — see the SUI -> USDC path above.
      const responseData = await new ZkLoginClient().sendPrebuiltTransactionBytes(
        account,
        payload,
        getCurrentNetwork(),
      );

      setTokenAssistSwapDigest(responseData.digest || null);
      toast.success('Converted USDC to SUI. Your SUI balance is refreshing now.', {
        id: 'token-assist-swap',
      });

      fetchUserWalletInfo();
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'USDC -> SUI conversion failed.';
      setTokenAssistSwapError(errorMessage);
      toast.error(errorMessage, { id: 'token-assist-swap' });
    } finally {
      setIsTokenAssistSwapProcessing(false);
    }
  };

  // Helper function to show the breakdown of a calculation
  const getAmountBreakdown = (baseAmount: number): { 
    baseAmount: number;
    slippageBuffer: number;
    rateBuffer: number;
    gasFee: number;
    total: number;
  } => {
    const slippageBuffer = baseAmount * (DEFAULT_SLIPPAGE / 100);
    const rateBuffer = baseAmount * (BUFFER_PERCENTAGE / 100);
    
    return {
      baseAmount,
      slippageBuffer,
      rateBuffer,
      gasFee: ESTIMATED_GAS_FEE,
      total: baseAmount + slippageBuffer + rateBuffer + ESTIMATED_GAS_FEE
    };
  };

  // Modify the handlePaySecurityDeposit function to check if deposit was returned during pause
  const handlePaySecurityDeposit = async () => {
    if (!circle || !userAddress || !circle.walletId) {
      toast.error('Circle information incomplete. Cannot process deposit.');
      return;
    }
    
    // Check if security deposit was already returned during the current pause
    if (circle.pausedAfterCycle && securityDepositReturnedDuringPause) {
      toast.error('You have already received your security deposit for this cycle. Please wait for the admin to resume the cycle before paying a new deposit.');
      return;
    }
    
    // Use the calculated amount that includes slippage and fees
    const requiredAmount = getRequiredDepositAmount();
    const isSuiFlow = selectedPaymentCurrency === 'SUI';

    if (isSuiFlow && !isSuiCircleModeEnabled) {
      toast.error('This circle is in USDC mode. Ask the admin to enable SUI mode first.');
      return;
    }

    if (isSuiFlow) {
      // SUI path requires enough native balance (including buffer)
      if (userBalance !== null && userBalance < requiredAmount) {
        toast.error('Insufficient SUI wallet balance to pay security deposit.');
        return;
      }
    } else if (userUsdcBalance !== null && userUsdcBalance < requiredSecurityDepositUsdc) {
      // USDC path checks required USDC amount directly
      toast.error(
        `Insufficient USDC balance. Need ${requiredSecurityDepositUsdc.toFixed(2)} USDC but you have ${userUsdcBalance.toFixed(2)} USDC.`
      );
      return;
    }
    
    setIsPayingDeposit(true);
    
    try {
      console.log('Preparing to pay security deposit:', {
        selectedPaymentCurrency,
        baseAmount: getSecurityDepositInSui(),
        requiredAmount,
        requiredSecurityDepositUsdc,
        userUsdcBalance,
        breakdown: getAmountBreakdown(getSecurityDepositInSui())
      });
      
      if (!account) {
        toast.error('User account not available. Please log in again.');
        setIsPayingDeposit(false);
        return;
      }
      
      toast.loading(
        isSuiFlow
          ? 'Processing security deposit payment in SUI...'
          : 'Processing security deposit payment in USDC...',
        { id: 'pay-security-deposit' }
      );
      
      // Signed in the browser. The deposit amount is derived from the
      // circle's on-chain config inside the builder, so the SUI figure below
      // is only a fallback for circles with no configured amount.
      const fallbackSui = isSuiFlow
        ? BigInt(Math.floor(getSecurityDepositInSui() * 1e9))
        : undefined;

      let responseData: { digest?: string; error?: string };
      try {
        const result = await new ZkLoginClient().paySecurityDeposit(
          account,
          circle.id,
          circle.walletId,
          {
            currency: selectedPaymentCurrency === 'USDC' ? 'USDC' : 'SUI',
            usdcCoinType: USDC_COIN_TYPE,
            suiCoinType: getCoinType('SUI'),
            fallbackSuiAmount: fallbackSui,
            network: getCurrentNetwork(),
          },
        );
        responseData = { digest: result.digest };
      } catch (depositErr) {
        responseData = {
          error:
            depositErr instanceof Error
              ? depositErr.message
              : 'Failed to process security deposit payment',
        };
      }
      const response = { ok: !responseData.error } as { ok: boolean };

      
      if (!response.ok) {
        console.error('Security deposit payment failed:', responseData);
        toast.error(responseData.error || 'Failed to process security deposit payment', { id: 'pay-security-deposit' });
      } else {
        toast.success(
          selectedPaymentCurrency === 'USDC'
            ? 'Security deposit paid successfully in USDC.'
            : 'Security deposit paid successfully in SUI.',
          { id: 'pay-security-deposit' }
        );
        // Deposit changed on-chain state — drop cached circle reads first.
        invalidateObject(circle.id);
        // Refresh user's wallet info and circle data
        fetchUserWalletInfo();
        fetchCircleDetails();
      }
    } catch (error) {
      console.error('Error paying security deposit:', error);
      toast.error('Failed to process security deposit payment');
    } finally {
      setIsPayingDeposit(false);
    }
  };

  // Helper function to get valid contribution amount
  function getValidContributionAmount(): number {
    // Make sure we have a valid, reasonable number
    const contributionAmount = typeof circle?.contributionAmount === 'number' && !isNaN(circle.contributionAmount)
      ? circle.contributionAmount : 0;
    
    // Validate the amount is reasonable (not millions)
    const isValidAmount = contributionAmount > 0 && contributionAmount < 1000;
    
    // If amount seems incorrect but we have USD value, calculate from USD
    if (!isValidAmount && circle?.contributionAmountUsd && 
        typeof circle.contributionAmountUsd === 'number' && 
        !isNaN(circle.contributionAmountUsd) && 
        typeof suiPrice === 'number' && 
        suiPrice > 0) {
      return circle.contributionAmountUsd / suiPrice;
    }
    
    // Return the original amount if it's valid, or 0 as a safe default
    return isValidAmount ? contributionAmount : 0;
  }

  // Currency display component
  const CurrencyDisplay = ({ 
    localAmount, 
    sui, 
    currencyType = 'USD', 
    className = '' 
  }: { 
    localAmount?: number; // Renamed from usd for clarity - this is the amount in local currency
    sui?: number; 
    currencyType?: string;
    className?: string;
  }) => {
    const isPriceUnavailable = suiPrice === null;
    const isPriceStale = priceService.isPriceStale();
    
    console.log('CurrencyDisplay inputs:', { localAmount, sui, currencyType, suiPrice, isPriceUnavailable });
    
    // Check for invalid inputs and provide defaults
    let effectiveLocalAmount = localAmount;
    let effectiveSui = sui;

    if ((effectiveLocalAmount === undefined || isNaN(effectiveLocalAmount)) && (effectiveSui === undefined || isNaN(effectiveSui))) {
      console.log('CurrencyDisplay: both localAmount and sui values are invalid, defaulting to 0');
      effectiveLocalAmount = 0;
      effectiveSui = 0;
    }
    
    // Use the provided values directly instead of converting between them
    let displayLocalAmount: number | null = null;
    let displaySuiAmount: number | null = null;
    
    if (effectiveLocalAmount !== undefined && !isNaN(effectiveLocalAmount)) {
      displayLocalAmount = effectiveLocalAmount; 
      console.log('CurrencyDisplay: using provided local currency amount:', { 
        local: displayLocalAmount, 
        currencyType
      });
    }
    
    if (effectiveSui !== undefined && !isNaN(effectiveSui)) {
      displaySuiAmount = effectiveSui; 
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
    
    // Special case for zero values
    if (displayLocalAmount === 0 && displaySuiAmount === 0) {
      return (
        <span className={`${className}`}>
          {formatCurrency(0, currencyType)} (0 SUI)
        </span>
      );
    }
    
    const formattedSui = displaySuiAmount !== null ? (
      displaySuiAmount >= 1000 
        ? displaySuiAmount.toLocaleString(undefined, { maximumFractionDigits: 0 }) 
        : displaySuiAmount >= 100 
          ? displaySuiAmount.toFixed(1) 
          : displaySuiAmount.toFixed(3) 
    ) : '—';
    
    const isInline = className.includes('inline');
    
    // IMPORTANT: Divide localAmount by 100 here because it's stored in cents/smallest unit
    const formattedLocalAmount = displayLocalAmount !== null ? formatCurrency(displayLocalAmount / 100, currencyType) : formatCurrency(0, currencyType);

    if (isInline) {
      return (
        <span className={className}>
          {formattedLocalAmount} ({formattedSui} SUI)
          {isPriceStale && <span title="Using cached price" className="text-xs text-amber-500 ml-1">⚠️</span>}
        </span>
      );
    }
    
    return (
      <Tooltip.Provider>
        <Tooltip.Root>
          <Tooltip.Trigger asChild>
            <div className={`flex flex-col ${className} cursor-help`}>
              <span className="font-medium">{formattedLocalAmount}</span>
              <span className="text-sm text-gray-500">{formattedSui} SUI</span>
              {isPriceStale && <span title="Using cached price" className="text-xs text-amber-500">⚠️ Cached price</span>}
            </div>
          </Tooltip.Trigger>
          <Tooltip.Portal>
            <Tooltip.Content
              className="bg-gray-900 text-white px-3 py-2 rounded text-sm"
              sideOffset={5}
            >
              <div className="space-y-1">
                <p>SUI Conversion Rate:</p>
                {suiPrice !== null ? (
                  <p>1 SUI = {formatUSD(suiPrice)}</p>
                ) : (
                  <p className="text-amber-400">SUI price unavailable</p>
                )}
                <p className="text-xs text-blue-300">
                  Currency: {currencyType}
                </p>
                <p className="text-xs text-gray-400">
                  {isPriceStale 
                    ? "Using cached price - service temporarily unavailable" 
                    : "Updated price data from CoinGecko"}
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

  // Add function to fetch custody wallet stablecoin balance
  const fetchCustodyWalletBalance = async () => {
    if (!circle || !circle.walletId) return;
    
    setLoadingStablecoinBalance(true);
    let toastId;
    const wasManualRefresh = !isInitialBalanceLoad;
    
    // Only show loading toast if this was triggered by a user clicking refresh (not initial load)
    if (wasManualRefresh) {
      toastId = toast.loading('Refreshing USDC balance...'); 
    }
    
    // Update initial load state for future refreshes
    setIsInitialBalanceLoad(false);
    
    try {
      const client = getSuiClientFromPool(getCurrentRpcUrl());
      const previousBalance = custodyStablecoinBalance;
      const [walletData, walletDynamicFields, outstandingDepositRaw] = await Promise.all([
        client.getObject({
          id: circle.walletId,
          options: { showContent: true }
        }),
        client.getDynamicFields({ parentId: circle.walletId }),
        readOutstandingSecurityDepositRaw(client, circle.id)
      ]);

      const walletFields = walletData.data?.content && 'fields' in walletData.data.content
        ? walletData.data.content.fields as Record<string, unknown>
        : null;
      const stablecoinConfigFields = walletFields?.stablecoin_config &&
        typeof walletFields.stablecoin_config === 'object' &&
        walletFields.stablecoin_config !== null &&
        'fields' in walletFields.stablecoin_config
          ? (walletFields.stablecoin_config as { fields: Record<string, unknown> }).fields
          : null;

      const stablecoinMeta = resolveStablecoinMetadata(
        typeof stablecoinConfigFields?.target_coin_type === 'string'
          ? stablecoinConfigFields.target_coin_type
          : USDC_COIN_TYPE
      );
      const dynamicFields = walletDynamicFields.data as unknown as DynamicFieldRef[];
      const liveStablecoinBalanceRaw = await readCustodyCoinBalance(
        client,
        dynamicFields,
        stablecoinMeta.coinType
      );

      const newBalance = toDisplayAmount(liveStablecoinBalanceRaw, stablecoinMeta.decimals);
      const newSecurityDepositBalance = Math.min(
        toDisplayAmount(outstandingDepositRaw, stablecoinMeta.decimals),
        newBalance
      );
      const newContributionBalance = Math.max(0, newBalance - newSecurityDepositBalance);

      setCustodyStablecoinBalance(newBalance);
      setSecurityDepositBalance(newSecurityDepositBalance);
      setContributionBalance(newContributionBalance);
      
      console.log('[USDC Balance Fetch] Setting stablecoin state:', {
        newBalance,
        newSecurityDepositBalance,
        newContributionBalance,
        coinType: stablecoinMeta.coinType
      });
      console.log('Custody stablecoin balances breakdown:', {
        total: newBalance,
        securityDeposits: newSecurityDepositBalance,
        contributionFunds: newContributionBalance,
        outstandingDepositRaw: outstandingDepositRaw.toString()
      });
      
      // Show success message if this was a manual refresh
      if (wasManualRefresh && toastId) {
        if (previousBalance !== newBalance) {
          toast.success(`Balance updated: $${newBalance.toFixed(2)} USDC`, { id: toastId });
        } else {
          toast.success('Balance refreshed', { id: toastId });
        }
      }
    } catch (error) {
      logSuiReadError('Error fetching custody wallet stablecoin balance:', error);
      if (wasManualRefresh && toastId) {
        toast.error('Failed to fetch balance', { id: toastId });
      }
    } finally {
      setLoadingStablecoinBalance(false);
    }
  };

  // New function to handle direct USDC deposit
  const handleDirectUsdcDeposit = async () => {
    if (!circle || !userAddress || !userUsdcBalance) return;

    const isSecurityDeposit = !userDepositPaid;
    // Legacy contribute path retired 2026-04-28: route members to the
    // CycleEscrowPanel for cycle contributions. Security deposits still
    // run through this handler since they happen before activation, not
    // per-cycle.
    if (!isSecurityDeposit) {
      toast(
        'Contributions now run through the round panel above (per-cycle escrow). Pay your share there.',
        { icon: 'ℹ️' },
      );
      return;
    }
    // Values from circle state are in CENTS
    const securityDepositUSDCents = circle.securityDepositUsd || 0;
    const contributionUSDCents = circle.contributionAmountUsd || 0;

    // If it's a security deposit, check if it was already returned during the current pause
    if (isSecurityDeposit && circle.pausedAfterCycle && securityDepositReturnedDuringPause) {
      toast.error('You have already received your security deposit for this cycle. Please wait for the admin to resume the cycle before paying a new deposit.');
      return;
    }
    
    // If it's a contribution, check if the circle is paused
    if (!isSecurityDeposit && circle.pausedAfterCycle) {
      toast.error('Contributions are disabled while the circle is paused. Please wait for the admin to resume the cycle.');
      return;
    }
    
    if (isCurrentRecipient) {
      toast.error('You are the current recipient for this cycle. You don&apos;t need to contribute.');
      return;
    }
    
    const alreadyContributed = await checkUserContribution();
    if (alreadyContributed) {
      toast.error('You have already contributed for this cycle.');
      return;
    }
    
    setDirectDepositProcessing(true);
    
    try {
      const toastId = toast.loading('Processing direct USDC deposit...');
      
      // Determine the required amount in CENTS from circle state
      const requiredAmountInCents = isSecurityDeposit ? securityDepositUSDCents : contributionUSDCents;
      // Convert to DOLLARS for comparison with userUsdcBalance (which is in dollars)
      const requiredAmountInDollars = requiredAmountInCents / 100;
      
      // Compare user's USDC balance (dollars) with the required amount (dollars)
      if (userUsdcBalance < requiredAmountInDollars) {
        toast.error(`Insufficient USDC balance. Need ${requiredAmountInDollars.toFixed(2)} USDC but you have ${userUsdcBalance.toFixed(2)} USDC.`, { id: toastId });
        setDirectDepositProcessing(false);
        return;
      }
      
      if (!account) {
        toast.error('User account not available. Please log in again.', { id: toastId });
        setDirectDepositProcessing(false);
        return;
      }
      
      console.log('Processing direct USDC deposit with parameters:', {
        circleId: circle.id,
        walletId: circle.walletId,
        usdcAmountInCents: requiredAmountInCents, // Log the amount in cents being sent
        isSecurityDeposit
      });
      
      const response = await fetch('/api/zkLogin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'depositUsdcDirect',
          account,
          circleId: circle.id,
          walletId: circle.walletId,
          usdcAmount: requiredAmountInCents, // Send amount in CENTS
          isSecurityDeposit,
          network: getCurrentNetwork() // Include current network selection
        }),
      });
      
      const responseData = await response.json();
      
      if (!response.ok) {
        console.error('Direct USDC deposit failed:', responseData);
        toast.error(responseData.error || 'Failed to process USDC deposit', { id: toastId });
        return;
      }
      
      // Success message
      if (isSecurityDeposit) {
        toast.success('Security deposit paid successfully with your USDC!', { id: toastId });
      } else {
        toast.success('Contribution made successfully with your USDC!', { id: toastId });
      }
      
      console.log('Direct USDC deposit transaction digest:', responseData.digest);

      // The deposit just mutated on-chain state; drop cached circle reads so
      // the refresh below reflects it rather than the pre-write snapshot.
      invalidateObject(circle.id);

      // Refresh user wallet info, circle data, and custody wallet balance
      fetchUserWalletInfo();
      fetchCircleDetails();
      fetchCustodyWalletBalance();
      checkUserContribution();
      
    } catch (error) {
      console.error('Error in direct USDC deposit:', error);
      toast.error('Failed to process USDC deposit');
    } finally {
      setDirectDepositProcessing(false);
    }
  };

  // Add the useEffect to call our functions when data changes
  useEffect(() => {
    if (circle && userAddress) {
      checkUserContribution();
      checkIfUserIsCurrentRecipient();
    }
    // Both callbacks close over circle/userAddress/currentCycle; they
    // are intentionally omitted from deps to avoid re-creation loops.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [circle, userAddress, currentCycle]);

  // Add this function to handle manual refresh
  const handleRefreshContributionStatus = async () => {
    toast.loading('Refreshing contribution status...', { id: 'refresh-status' });
    try {
      // Explicit user-initiated refresh: bypass the read cache so we re-read
      // the live circle state, not a recent snapshot.
      if (circle?.id) invalidateObject(circle.id);

      // Refresh the circle information first
      await fetchCircleDetails();
      
      // If circle is paused, just update UI and return
      if (circle?.pausedAfterCycle) {
        toast.success('Circle is paused after cycle completion', { id: 'refresh-status' });
        return;
      }
      
      // Refresh contribution status
      await checkUserContribution();
      
      // Refresh current recipient status
      await checkIfUserIsCurrentRecipient();
      
      toast.success('Contribution status refreshed', { id: 'refresh-status' });
    } catch (error) {
      console.error('Error refreshing status:', error);
      toast.error('Failed to refresh status', { id: 'refresh-status' });
    }
  };

  const setContributeSectionRef = (key: ContributeSectionKey, element: HTMLDivElement | null) => {
    contributeSectionRefs.current[key] = element;
  };

  const scrollToContributeSection = (key: ContributeSectionKey) => {
    const target = contributeSectionRefs.current[key];
    if (!target || typeof window === 'undefined') return;

    const top = target.getBoundingClientRect().top + window.scrollY - 88;
    window.scrollTo({ top: Math.max(top, 0), behavior: 'smooth' });
  };

  const pageSurfaceClass =
    'rounded-[28px] border border-stone-200 bg-white shadow-[0_24px_70px_-42px_rgba(15,23,42,0.32)] sm:rounded-[32px]';
  const sectionCardClass =
    'rounded-[24px] border border-stone-200 bg-white px-4 py-4 shadow-[0_18px_50px_-38px_rgba(15,23,42,0.24)] sm:rounded-[28px] sm:px-6 sm:py-6';
  const mutedPanelClass = 'rounded-[20px] border border-stone-200 bg-stone-50/80 p-3 sm:rounded-[24px] sm:p-5';
  const warningPanelClass = 'rounded-[20px] border border-amber-200 bg-amber-50/75 p-3 sm:rounded-[24px] sm:p-5';
  const successPanelClass = 'rounded-[20px] border border-emerald-200 bg-emerald-50/70 p-3 sm:rounded-[24px] sm:p-5';
  const infoPanelClass = 'rounded-[20px] border border-sky-200 bg-sky-50/65 p-3 sm:rounded-[24px] sm:p-5';
  const sectionTitleClass = 'text-xl font-semibold tracking-tight text-slate-950';
  const sectionEyebrowClass = 'text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-500';
  const primaryActionClass =
    'inline-flex items-center justify-center rounded-full bg-slate-950 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-slate-400 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50';
  const secondaryActionClass =
    'inline-flex items-center justify-center rounded-full border border-stone-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 transition hover:border-stone-400 hover:bg-stone-50 focus:outline-none focus:ring-2 focus:ring-stone-300 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50';
  const subtleTagClass =
    'inline-flex items-center rounded-full border border-stone-200 bg-stone-50 px-3 py-1.5 text-sm font-medium text-slate-600';
  const mobileWorkspaceButtonClass =
    'rounded-[18px] border border-stone-200 bg-white px-3 py-3 text-left transition hover:border-stone-300 hover:bg-stone-50 sm:rounded-[20px]';
  const circleStatusLabel = circle?.pausedAfterCycle ? 'Paused' : circle?.isActive ? 'Active' : 'Inactive';
  const paymentStatusLabel = !userDepositPaid
    ? 'Deposit required'
    : userHasContributed
      ? 'Contributed'
      : isCurrentRecipient
        ? 'Recipient'
        : 'Ready';
  const circleModeLabel = isSuiCircleModeEnabled ? 'SUI' : 'USDC';
  const walletSummaryLabel = fetchingBalance ? 'Refreshing' : userAddress ? 'Connected' : 'Not ready';
  const walletSummaryDetail = userAddress
    ? `${userAddress.substring(0, 6)}...${userAddress.substring(userAddress.length - 4)}`
    : 'Wallet unavailable';
  const cycleSummaryLabel = currentCycle > 0 ? `Cycle ${currentCycle}` : 'Setup';
  const cycleSummaryDetail = circle?.pausedAfterCycle
    ? 'Paused after payout'
    : circle?.isActive
      ? 'Payments open'
      : 'Waiting for activation';
  const mobilePaymentAmountLabel = !circle
    ? 'Unavailable'
    : selectedPaymentCurrency === 'SUI'
      ? `${(!userDepositPaid ? getSecurityDepositInSui() : getValidContributionAmount()).toFixed(4)} SUI`
      : formatUsdCentsAsUsdc(!userDepositPaid ? circle.securityDepositUsd || 0 : circle.contributionAmountUsd || 0);

  // Update the renderContributionOptions function to show a message when user is the current recipient
  const renderContributionOptions = () => {
    // Cycle contributions are handled EXCLUSIVELY by the CycleEscrowPanel at the
    // top of the page — it reads/writes the on-chain per-cycle escrow, which is
    // the source of truth for "who has paid this round". This legacy wallet-
    // payment card deposits via the older custody path and is retained ONLY for
    // the security-deposit step (which still uses that path). Once the deposit
    // is paid, suppress it: otherwise members see a second "contribute" button
    // that pays the wrong place and never reflects in the escrow tracker.
    if (userDepositPaid) {
      return null;
    }
    const paymentLabel = userDepositPaid ? 'Contribution' : 'Security Deposit';
    const currentUsdcPaymentAmount = getCurrentUsdcPaymentAmount();
    const currentUsdcShortfall = getCurrentUsdcShortfallForOneClickSwap();
    const currentSuiBasePaymentAmount = getCurrentSuiBasePaymentAmount();
    const currentSuiPaymentAmount = getCurrentSuiPaymentAmount();
    const estimatedUsdcNeededForSuiSwap = getUsdcAmountNeededForSuiAssistSwap();
    const quotedSuiOutputForAssistSwap = tokenAssistQuote?.suiOut || currentSuiAssistShortfall;
    const tokenAssistExecutionBufferSui =
      currentSuiPaymentAmount * (TOKEN_ASSIST_EXTRA_OUTPUT_BUFFER_PERCENT / 100);
    const hasEnoughSuiForCurrentPayment =
      userBalance !== null && userBalance >= currentSuiPaymentAmount;
    const hasEnoughUsdcForCurrentPayment =
      userUsdcBalance !== null && userUsdcBalance >= currentUsdcPaymentAmount;
    const hasEnoughUsdcForSuiAssistSwap =
      userUsdcBalance !== null && userUsdcBalance >= estimatedUsdcNeededForSuiSwap;
    const showSuiDirectPayCard = selectedPaymentCurrency === 'SUI' && userBalance !== null;
    const showUsdcDirectPayCard =
      showDirectDepositOption &&
      userUsdcBalance !== null &&
      selectedPaymentCurrency === 'USDC';
    const showPrimaryWalletActionCard = showSuiDirectPayCard || showUsdcDirectPayCard;
    const showUsdcSwapAssist =
      circle &&
      selectedPaymentCurrency === 'USDC' &&
      userUsdcBalance !== null &&
      !hasEnoughUsdcForCurrentPayment &&
      userBalance !== null &&
      userBalance > ONE_CLICK_GAS_RESERVE_SUI &&
      (
        userDepositPaid
          ? circle.isActive && !circle.pausedAfterCycle && !userHasContributed && !isCurrentRecipient
          : (!circle.pausedAfterCycle || !securityDepositReturnedDuringPause) &&
            (circle.securityDepositUsd || 0) > 0
      );
    const showSuiSwapAssist =
      circle &&
      selectedPaymentCurrency === 'SUI' &&
      userBalance !== null &&
      userUsdcBalance !== null &&
      !hasEnoughSuiForCurrentPayment &&
      hasEnoughUsdcForSuiAssistSwap &&
      (!userDepositPaid || (!userHasContributed && !isCurrentRecipient && circle.isActive && !circle.pausedAfterCycle));
    const lacksBothTokensForCurrentPayment =
      userBalance !== null &&
      userUsdcBalance !== null &&
      (
        selectedPaymentCurrency === 'SUI'
          ? !hasEnoughSuiForCurrentPayment && !hasEnoughUsdcForSuiAssistSwap
          : !hasEnoughUsdcForCurrentPayment && !hasSufficientSuiForOneClickSwap()
      );
    const onrampTargetCurrency: 'sui' | 'usdc' =
      selectedPaymentCurrency === 'SUI' ? 'sui' : 'usdc';
    const inlineOnrampAmountUsd = Math.max(
      10,
      Math.ceil(
        selectedPaymentCurrency === 'SUI'
          ? Math.max(estimatedUsdcNeededForSuiSwap, currentSuiPaymentAmount * Math.max(suiPrice, 1))
          : currentUsdcPaymentAmount
      )
    );

    return (
      <div className={sectionCardClass} ref={(element) => setContributeSectionRef('payment', element)}>
        <div className="mb-5 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className={sectionEyebrowClass}>Payment</p>
            <h3 className={`${sectionTitleClass} mt-2`}>Make Contribution</h3>
            <p className="mt-2 text-sm leading-6 text-slate-500">
              Review the current payment step, choose the allowed token mode, and complete this cycle&apos;s action.
            </p>
          </div>
          <button
            onClick={handleRefreshContributionStatus}
            className={`${secondaryActionClass} px-3 py-2 text-xs sm:text-sm`}
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="mr-2 h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            Refresh Status
          </button>
        </div>

        <div className={`${mutedPanelClass} mb-4`}>
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <p className={sectionEyebrowClass}>Token Mode</p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <span className={subtleTagClass}>Circle mode: {circleModeLabel}</span>
                <span className={subtleTagClass}>Selected payment: {selectedPaymentCurrency}</span>
              </div>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-500">
                Token mode is admin-managed. {isSuiCircleModeEnabled ? 'This circle currently routes active-cycle payments in SUI.' : 'This circle currently routes active-cycle payments in USDC.'}
              </p>
            </div>
            <div className="inline-flex w-full rounded-full border border-stone-200 bg-white p-1 shadow-sm sm:w-auto">
              <button
                type="button"
                onClick={() => {
                  if (isSuiCircleModeEnabled) {
                    toast.error('Circle is currently in SUI mode. USDC is unavailable while SUI mode is active.');
                    return;
                  }
                  setCurrencyTabIndex(0);
                }}
                disabled={isSuiCircleModeEnabled}
                className={`flex-1 rounded-full px-4 py-2 text-sm font-medium transition-colors sm:flex-none ${
                  currencyTabIndex === 0
                    ? 'bg-slate-950 text-white'
                    : isSuiCircleModeEnabled
                      ? 'cursor-not-allowed text-stone-400'
                      : 'text-slate-600 hover:bg-stone-100'
                }`}
              >
                USDC
              </button>
              <button
                type="button"
                onClick={() => {
                  if (!isSuiCircleModeEnabled) {
                    toast.error('SUI mode is disabled by the circle admin.');
                    return;
                  }
                  console.log(
                    '[analytics] sui_circle_mode_selected',
                    JSON.stringify({
                      circleId: circle?.id,
                      userAddress,
                      timestamp: new Date().toISOString(),
                    })
                  );
                  setCurrencyTabIndex(1);
                }}
                disabled={!isSuiCircleModeEnabled}
                className={`flex-1 rounded-full px-4 py-2 text-sm font-medium transition-colors sm:flex-none ${
                  currencyTabIndex === 1
                    ? 'bg-slate-950 text-white'
                    : isSuiCircleModeEnabled
                      ? 'text-slate-600 hover:bg-stone-100'
                      : 'cursor-not-allowed text-stone-400'
                }`}
              >
                SUI
              </button>
            </div>
          </div>
        </div>

        {/* Add prominent message for cycle paused state */}
        {circle?.pausedAfterCycle && (
          <div className={`${warningPanelClass} mb-4`}>
            <div className="flex items-start space-x-3">
              <div className="mt-0.5 flex-shrink-0 rounded-full bg-amber-100 p-1.5">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
              </div>
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-700">Cycle State</p>
                <h4 className="mt-2 text-lg font-semibold text-amber-950">Cycle Paused</h4>
                <p className="mt-2 text-sm leading-6 text-amber-900/80">
                  Cycle {currentCycle} has been completed, and the circle is now paused. New contributions are disabled until the admin resumes the circle to start the next cycle.
                </p>
                {!userDepositPaid && !securityDepositReturnedDuringPause && (
                  <p className="mt-3 text-sm font-medium text-amber-900">
                    You can still pay your security deposit while the circle is paused to prepare for the next cycle.
                  </p>
                )}
                {!userDepositPaid && securityDepositReturnedDuringPause && (
                  <p className="mt-3 text-sm font-medium text-amber-900">
                    Your security deposit has been returned. You&apos;ll need to wait for the admin to resume the cycle before paying a new deposit.
                  </p>
                )}
                <p className="mt-3 text-sm text-amber-800">
                  <span className="font-medium">Note:</span> When the admin resumes the circle, all members will need to pay a new security deposit for the next cycle.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Show message if user is current recipient - only show if not paused */}
        {isCurrentRecipient && !circle?.pausedAfterCycle && (
          <div className={`${successPanelClass} mb-4`}>
            <div className="flex flex-col sm:flex-row items-start space-y-2 sm:space-y-0 sm:space-x-3">
              <div className="self-start rounded-full bg-emerald-100 p-1.5">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <div className="flex-1">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-700">Current Role</p>
                <h4 className="mt-2 font-semibold text-emerald-950">You are the recipient for this cycle</h4>
                <p className="mt-2 text-sm leading-6 text-emerald-900/80">
                  You don&apos;t need to make a contribution for the current cycle because you are the member receiving the payout. Enjoy your payout!
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Show message if user has already contributed - only show if not paused */}
        {userHasContributed && !circle?.pausedAfterCycle && (
          <div className={`${successPanelClass} mb-4`}>
            <div className="flex flex-col sm:flex-row items-start space-y-2 sm:space-y-0 sm:space-x-3">
              <div className="self-start rounded-full bg-emerald-100 p-1.5">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <div className="flex-1">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-700">Current Role</p>
                <h4 className="mt-2 font-semibold text-emerald-950">You already contributed for this cycle</h4>
                <p className="mt-2 text-sm leading-6 text-emerald-900/80">
                  Your contribution for cycle {currentCycle} has been recorded. You&apos;ll be able to contribute again in the next cycle.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Show a dedicated SUI payment card when the circle is in SUI mode */}
        {showSuiDirectPayCard && (
          <div className={`${infoPanelClass} mb-4`}>
            <div className="flex flex-col sm:flex-row items-start space-y-2 sm:space-y-0 sm:space-x-3">
              <div className="self-start rounded-full bg-sky-100 p-1.5">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
              </div>
              <div className="flex-1">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-sky-700">Wallet Payment</p>
                <h4 className="mt-2 font-semibold text-sky-950">Pay in SUI from your wallet</h4>
                <p className="mt-2 text-sm leading-6 text-sky-900/80">
                  You have <span className="font-medium">{userBalance?.toFixed(4)} SUI</span> available.
                  This payment needs about <span className="font-medium">{currentSuiPaymentAmount.toFixed(4)} SUI</span> including slippage and gas.
                </p>
                <div className="mt-3">
                  <button
                    onClick={userDepositPaid ? handleContribute : handlePaySecurityDeposit}
                    disabled={
                      (userDepositPaid && (!circle?.isActive || circle?.pausedAfterCycle || userHasContributed || isCurrentRecipient)) ||
                      (!userDepositPaid && circle?.pausedAfterCycle && securityDepositReturnedDuringPause) ||
                      (!userDepositPaid && (circle?.securityDepositUsd || 0) <= 0) ||
                      !hasEnoughSuiForCurrentPayment ||
                      isProcessing ||
                      isPayingDeposit
                    }
                    className={`${primaryActionClass} w-full sm:w-auto`}
                  >
                    {(isProcessing || isPayingDeposit) ? (
                      <span className="flex items-center">
                        <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                        </svg>
                        Processing...
                      </span>
                    ) : !userDepositPaid ? (
                      `Pay ${currentSuiBasePaymentAmount.toFixed(4)} SUI as Security Deposit`
                    ) : userHasContributed ? (
                      'Already Contributed'
                    ) : isCurrentRecipient ? (
                      'You Are the Current Recipient'
                    ) : circle?.pausedAfterCycle ? (
                      'Circle is Paused After Cycle'
                    ) : (
                      `Contribute ${currentSuiBasePaymentAmount.toFixed(4)} SUI`
                    )}
                  </button>
                </div>
                {!hasEnoughSuiForCurrentPayment && (
                  <p className="mt-2 text-xs text-amber-700">
                    Your SUI balance is short for this payment. Use the assist option below to top up or convert before retrying.
                  </p>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Show direct USDC deposit option if user has sufficient USDC balance */}
        {showDirectDepositOption && userUsdcBalance !== null && selectedPaymentCurrency === 'USDC' && (
          <div className={`${successPanelClass} mb-4`}>
            <div className="flex flex-col sm:flex-row items-start space-y-2 sm:space-y-0 sm:space-x-3">
              <div className="self-start rounded-full bg-emerald-100 p-1.5">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <div className="flex-1">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-700">Wallet Payment</p>
                <h4 className="mt-2 font-semibold text-emerald-950">Use USDC from your wallet</h4>
                <p className="mt-2 text-sm leading-6 text-emerald-900/80">
                  You have <span className="font-medium">
                    {convertedUserUsdcBalanceDisplay ? `${convertedUserUsdcBalanceDisplay} (approx. ${formatUSD(userUsdcBalance)})` : `${formatUSD(userUsdcBalance)} USDC`}
                  </span> in your wallet.
                  You can directly deposit {!userDepositPaid ? 'security deposit' : 'contribution'} without swapping SUI.
                </p>
                <div className="mt-3">
                  <button
                    onClick={handleDirectUsdcDeposit}
                    disabled={userDepositPaid && (!circle?.isActive || circle?.pausedAfterCycle || userHasContributed || isCurrentRecipient) ||
                            (!userDepositPaid && circle?.pausedAfterCycle && securityDepositReturnedDuringPause) || 
                            (!userDepositPaid && (circle?.securityDepositUsd || 0) <= 0)}
                    className={`${primaryActionClass} w-full sm:w-auto`}
                  >
                    {directDepositProcessing ? (
                      <span className="flex items-center">
                        <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                        </svg>
                        Processing...
                      </span>
                    ) : !userDepositPaid ? (
                      `Deposit ${formatUsdCentsAsUsdc(circle?.securityDepositUsd || 0)} as Security Deposit`
                    ) : userHasContributed ? (
                      `Already Contributed`
                    ) : isCurrentRecipient ? (
                      `You Are the Current Recipient`
                    ) : circle?.pausedAfterCycle ? (
                      `Circle is Paused After Cycle`
                    ) : (
                      `Contribute ${formatUsdCentsAsUsdc(circle?.contributionAmountUsd || 0)} Directly`
                    )}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Auto-assist: convert SUI -> USDC and immediately submit the active USDC payment */}
        {showUsdcSwapAssist && (
            <div className={`${mutedPanelClass} mb-4`}>
              <div className="flex items-start space-x-3">
                <div className="mt-0.5 flex-shrink-0 rounded-full bg-stone-200 p-1.5">
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-indigo-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                  </svg>
                </div>
                <div className="flex-1">
                  <p className={sectionEyebrowClass}>Auto Assist</p>
                  <h4 className="mt-2 font-semibold text-slate-950">Convert SUI to USDC and pay</h4>
                  <p className="mt-2 text-sm leading-6 text-slate-600">
                    One click swaps only the missing USDC first, then submits your {paymentLabel.toLowerCase()} once the swap confirms.
                  </p>
                  <p className="mt-2 text-xs text-slate-600">
                    Estimated SUI input: <span className="font-semibold">{getOneClickSwapAmountSui().toFixed(4)} SUI</span> for{' '}
                    <span className="font-semibold">{formatUSD(currentUsdcShortfall)} USDC</span> shortfall.
                  </p>
                  {isOneClickSwapQuoteLoading && (
                    <p className="mt-2 text-xs text-slate-600">Refreshing live Cetus quote...</p>
                  )}
                  {oneClickSwapQuote && (
                    <p className="mt-2 text-xs text-slate-600">
                      Live quote price impact: <span className="font-semibold">{oneClickSwapQuote.priceImpact.toFixed(2)}%</span>
                    </p>
                  )}
                  {oneClickSwapQuoteError && (
                    <p className="mt-2 text-xs text-amber-700">{oneClickSwapQuoteError}</p>
                  )}
                  <button
                    type="button"
                    onClick={handleOneClickSwapAndDeposit}
                    disabled={
                      isOneClickSwapProcessing ||
                      isOneClickSwapQuoteLoading ||
                      !!oneClickSwapQuoteError ||
                      !hasSufficientSuiForOneClickSwap() ||
                      isProcessing
                    }
                    className={`${primaryActionClass} mt-3 w-full sm:w-auto`}
                  >
                    {isOneClickSwapProcessing ? 'Converting & Paying...' : `Convert SUI to USDC, Then Pay ${paymentLabel}`}
                  </button>

                  {!hasSufficientSuiForOneClickSwap() && (
                    <p className="mt-2 text-xs text-amber-700">
                      You need about {getOneClickQuotedSuiInput().toFixed(4)} SUI plus gas reserve to run this conversion.
                    </p>
                  )}

                  {oneClickSwapDigest && (
                    <p className="mt-2 break-all text-xs text-slate-600">
                      Tracking transaction: {oneClickSwapDigest}
                    </p>
                  )}

                  {oneClickSwapError && (
                    <p className="mt-2 text-xs text-red-600">{oneClickSwapError}</p>
                  )}
                </div>
              </div>
            </div>
          )}

        {/* Auto-assist: convert USDC -> SUI when the circle requires SUI and the wallet is short on native balance */}
        {showSuiSwapAssist && (
          <div className={`${mutedPanelClass} mb-4`}>
            <div className="flex items-start space-x-3">
              <div className="mt-0.5 flex-shrink-0 rounded-full bg-stone-200 p-1.5">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-cyan-700" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
              </div>
              <div className="flex-1">
                <p className={sectionEyebrowClass}>Auto Assist</p>
                <h4 className="mt-2 font-semibold text-slate-950">Convert USDC to SUI for this payment</h4>
                <p className="mt-2 text-sm leading-6 text-slate-600">
                  Your wallet is short on SUI. This conversion tops up the payment gap and keeps a small reserve for swap execution.
                </p>
                <p className="mt-2 text-xs text-slate-600">
                  Estimated conversion: <span className="font-semibold">{formatUSD(estimatedUsdcNeededForSuiSwap)} USDC</span> into
                  approximately <span className="font-semibold"> {quotedSuiOutputForAssistSwap.toFixed(4)} SUI</span>.
                </p>
                <p className="mt-2 text-xs text-slate-600">
                  This target includes <span className="font-semibold">{TOKEN_ASSIST_SWAP_GAS_RESERVE_SUI.toFixed(4)} SUI</span> reserved for swap gas
                  and <span className="font-semibold"> {tokenAssistExecutionBufferSui.toFixed(4)} SUI</span> as an execution buffer.
                </p>
                {isTokenAssistQuoteLoading && (
                  <p className="mt-2 text-xs text-slate-600">Refreshing live Cetus quote...</p>
                )}
                {tokenAssistQuote && (
                  <p className="mt-2 text-xs text-slate-600">
                    Live quote price impact: <span className="font-semibold">{tokenAssistQuote.priceImpact.toFixed(2)}%</span>
                  </p>
                )}
                {tokenAssistQuoteError && (
                  <p className="mt-2 text-xs text-amber-700">{tokenAssistQuoteError}</p>
                )}
                <button
                  type="button"
                  onClick={handleSwapUsdcToSuiForPayment}
                  disabled={
                    isTokenAssistSwapProcessing ||
                    isTokenAssistQuoteLoading ||
                    isProcessing ||
                    isPayingDeposit ||
                    !!tokenAssistQuoteError
                  }
                  className={`${primaryActionClass} mt-3 w-full sm:w-auto`}
                >
                  {isTokenAssistSwapProcessing ? 'Converting...' : 'Convert USDC to SUI'}
                </button>

                {tokenAssistSwapDigest && (
                  <p className="mt-2 break-all text-xs text-slate-600">
                    Swap submitted: {tokenAssistSwapDigest}
                  </p>
                )}

                {tokenAssistSwapError && (
                  <p className="mt-2 text-xs text-red-600">{tokenAssistSwapError}</p>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Buy assist: if neither token can cover the payment, reuse the dashboard onramp flow inline */}
        {circle && lacksBothTokensForCurrentPayment && (
          <div className={`${mutedPanelClass} mb-4`}>
            <div className="flex flex-col gap-3">
              <div>
                <p className={sectionEyebrowClass}>Top Up</p>
                <h4 className="mt-2 font-semibold text-slate-950">Top up your wallet to continue</h4>
                <p className="mt-2 text-sm leading-6 text-slate-600">
                  You do not have enough {selectedPaymentCurrency} or convertible balance to cover this {paymentLabel.toLowerCase()} right now.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => openBuyFlow(onrampTargetCurrency)}
                  className={primaryActionClass}
                >
                  Buy {selectedPaymentCurrency}
                </button>
                <button
                  type="button"
                  onClick={handleRefreshContributionStatus}
                  className={secondaryActionClass}
                >
                  Refresh Status
                </button>
              </div>

              {showInlineOnrampLauncher && (
                <div className="rounded-[18px] border border-slate-200 bg-white p-3 shadow-sm sm:p-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">
                        Instant Onramp
                      </p>
                      <p className="mt-1 text-sm text-slate-600">
                        Buy {coinbaseAssetIntent === 'SUI' ? 'SUI' : 'USDC on Sui'} without leaving this payment flow.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={closeInlineOnrampLauncher}
                      className="text-xs text-slate-500 hover:text-slate-700"
                    >
                      Close
                    </button>
                  </div>

                  <RampPicker
                    className="mt-4"
                    walletAddress={userAddress || ''}
                    preferredAssetIntent={coinbaseAssetIntent}
                    amountUsd={inlineOnrampAmountUsd}
                    coinbase={{
                      providerFlag: onrampProviderFlag,
                      disabled: !userAddress,
                      buttonLabel: `Continue with Coinbase to Buy ${coinbaseAssetIntent === 'SUI' ? 'SUI' : 'USDC'}`,
                      onCancel: handleCoinbaseCancel,
                    }}
                    onLaunched={handleRampLaunched}
                    onProviderError={handleRampProviderError}
                  />
                </div>
              )}
            </div>
          </div>
        )}

        {/* Advanced swap-and-deposit flow is behind feature flag; default path is the standard form below. */}
        {ENABLE_SWAP_AND_DEPOSIT_FORM && circle ? (
          <>
            {(!circle.isActive || circle.pausedAfterCycle) && (
              <div className={`${warningPanelClass} mb-4`}>
                <p className="text-sm text-amber-700 font-medium">
                  {!circle.isActive ? "This circle is not active yet" : "This circle is paused after cycle completion"}
                </p>
                <p className="text-xs text-amber-600 mt-1">
                  {!userDepositPaid 
                    ? "Security deposits can still be paid before activation or while paused."
                    : circle.pausedAfterCycle
                      ? "Regular contributions are disabled while the circle is paused. Please wait for the admin to resume the cycle."
                      : "Regular contributions are disabled until the admin activates the circle. Please check back later."}
                </p>
              </div>
            )}
            <SimplifiedSwapUI
              walletId={circle?.walletId || ''}
              circleId={circle?.id || ''}
              contributionAmount={getValidContributionAmount()}
              securityDepositPaid={userDepositPaid}
              securityDepositAmount={getSecurityDepositInSui()}
              onComplete={() => {
                fetchUserWalletInfo();
                fetchCircleDetails();
                // Check if user has contributed after completing a transaction
                checkUserContribution();
              }}
              disabled={userDepositPaid && (!circle?.isActive || circle?.pausedAfterCycle || userHasContributed || isCurrentRecipient) ||
                      (!userDepositPaid && circle?.pausedAfterCycle && securityDepositReturnedDuringPause) || 
                      (!userDepositPaid && (circle?.securityDepositUsd || 0) <= 0)}
              circleCurrencyType={circle?.currencyType || 'USD'} // Pass the circle's currency type
            />
          </>
        ) : (
          <>
          {!showPrimaryWalletActionCard && (
          <div className="rounded-[24px] border border-stone-200 bg-stone-50/80 p-4 sm:p-6">
            <div className="mb-6">
              <p className="mb-2 text-sm text-slate-600">You are about to contribute:</p>
              <div className="flex items-center">
                <span className="rounded-full border border-stone-200 bg-white px-4 py-2 text-xl font-semibold text-slate-950">
                  {formatUsdCentsAsUsdc(circle?.contributionAmountUsd || 0)} ({getValidContributionAmount().toFixed(4)} SUI)
                </span>
              </div>
            </div>

            {/* Debug the balance comparison by logging values */}
            {userDepositPaid && userBalance !== null && (
              <script dangerouslySetInnerHTML={{
                __html: `
                  console.log("Balance check:", {
                    userBalance: ${userBalance},
                    contributionAmount: ${circle?.contributionAmount},
                    hasEnough: ${userBalance >= (circle?.contributionAmount || 0)},
                    difference: ${userBalance - (circle?.contributionAmount || 0)}
                  });
                `
              }} />
            )}

            {/* Show warning if balance is insufficient - only when deposit is already paid */}
            {(() => {
              // Skip if deposit not paid or balance not loaded
              if (!userDepositPaid || userBalance === null || selectedPaymentCurrency !== 'SUI') return null;
              
              // Get required contribution amount with buffer
              const requiredAmount = getRequiredContributionAmount();
              
              // Only show warning if balance is insufficient
              if (userBalance >= requiredAmount) return null;
              
              return (
                <div className="mb-4 p-3 bg-red-50 text-red-700 rounded-lg border border-red-200">
                  <p className="text-sm font-medium">
                    ⚠️ Your wallet balance is insufficient for this contribution.
                  </p>
                  <p className="text-xs mt-1">
                    Required base amount: {getValidContributionAmount().toFixed(4)} SUI<br/>
                    With slippage & fees: {requiredAmount.toFixed(4)} SUI<br/>
                    Available: {userBalance.toFixed(4)} SUI
                  </p>
                </div>
              );
            })()}

            {/* Show detailed breakdown of contribution amount if deposit is paid */}
            {userDepositPaid && circle && getValidContributionAmount() > 0 && selectedPaymentCurrency === 'SUI' && (
              <div className="mb-4 p-3 bg-blue-50 rounded-lg border border-blue-200">
                <p className="text-sm font-medium text-blue-800">
                  Estimated amount needed for contribution:
                </p>
                <div className="text-blue-700 text-xs space-y-1 mt-2">
                  <p>Base contribution: {getValidContributionAmount().toFixed(4)} SUI</p>
                  <p>+ Slippage ({DEFAULT_SLIPPAGE}%): {(getValidContributionAmount() * DEFAULT_SLIPPAGE / 100).toFixed(4)} SUI</p>
                  <p>+ Rate buffer ({BUFFER_PERCENTAGE}%): {(getValidContributionAmount() * BUFFER_PERCENTAGE / 100).toFixed(4)} SUI</p>
                  <p>+ Network fee: {ESTIMATED_GAS_FEE.toFixed(6)} SUI</p>
                  <p className="font-semibold border-t border-blue-200 pt-1 mt-1">
                    Total required: {getRequiredContributionAmount().toFixed(4)} SUI
                  </p>
                </div>
              </div>
            )}

            {/* Show warning if security deposit is not paid */}
            {!userDepositPaid && (
                <div className="mb-4 rounded-lg border-2 border-amber-300 bg-amber-50 p-3 sm:p-4">
                  <div className="flex flex-col gap-4">
                  <div>
                    <p className="text-base font-medium text-amber-700 mb-1">
                      ⚠️ Security deposit required
                    </p>
                    <p className="text-sm text-amber-600">
                      You need to pay a security deposit of{' '}
                      {!circle ? (
                        'amount unavailable'
                      ) : (
                        <span className="font-semibold">
                          {formatUsdCentsAsUsdc(circle.securityDepositUsd || 0)}
                        </span>
                      )}{' '}
                      before contributing.
                    </p>
                    <p className="text-xs text-amber-500 mt-2 italic">
                      Note: A new security deposit is required for each cycle after the circle is reset. This ensures
                      continued commitment and participation from all members.
                    </p>
                  </div>
                  
                  {/* Show the required amount including slippage and fees */}
                  {selectedPaymentCurrency === 'SUI' && userBalance !== null && circle && circle.securityDeposit > 0 && (
                    <div className="rounded border border-blue-100 bg-blue-50 p-2 text-sm">
                      <p className="font-medium text-blue-800">Estimated amount needed:</p>
                      <div className="text-blue-700 text-xs space-y-1 mt-1">
                        <p>Base deposit: {getSecurityDepositInSui().toFixed(4)} SUI</p>
                        <p>+ Slippage ({DEFAULT_SLIPPAGE}%): {(getSecurityDepositInSui() * DEFAULT_SLIPPAGE / 100).toFixed(4)} SUI</p>
                        <p>+ Rate buffer ({BUFFER_PERCENTAGE}%): {(getSecurityDepositInSui() * BUFFER_PERCENTAGE / 100).toFixed(4)} SUI</p>
                        <p>+ Network fee: {ESTIMATED_GAS_FEE.toFixed(6)} SUI</p>
                        <p className="font-semibold border-t border-blue-200 pt-1 mt-1">
                          Total required: {getRequiredDepositAmount().toFixed(4)} SUI
                        </p>
                      </div>
                    </div>
                  )}
                  
                  {/* Show combined insufficient balance warning for both security deposit and contribution */}
                  {selectedPaymentCurrency === 'SUI' && userBalance !== null && circle && userBalance < getRequiredDepositAmount() && (
                    <div className="rounded border border-red-200 bg-red-50 p-2 text-sm text-red-700">
                      <p className="font-medium">Insufficient funds for security deposit</p>
                      <p className="text-xs mt-1">
                        You need {getRequiredDepositAmount().toFixed(4)} SUI for the security deposit (including slippage & fees), but your balance is only {userBalance.toFixed(4)} SUI.
                      </p>
                    </div>
                  )}
                  
                  <button
                    onClick={handlePaySecurityDeposit}
                    disabled={isPayingDeposit || !circle || (circle.securityDepositUsd || 0) <= 0 || 
                             (selectedPaymentCurrency === 'SUI' && !isSuiCircleModeEnabled) ||
                             (selectedPaymentCurrency === 'SUI' && userBalance !== null && userBalance < getRequiredDepositAmount()) ||
                             (selectedPaymentCurrency === 'USDC' && userUsdcBalance !== null && userUsdcBalance < requiredSecurityDepositUsdc) ||
                             (circle.pausedAfterCycle && securityDepositReturnedDuringPause)}
                    className={`${primaryActionClass} w-full`}
                  >
                    {isPayingDeposit ? (
                      <span className="flex items-center justify-center">
                        <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                        </svg>
                        Processing...
                      </span>
                    ) : (
                      `Pay Security Deposit in ${selectedPaymentCurrency}`
                    )}
                  </button>
                  
                  {/* Add note about payment sequence */}
                  <p className="text-xs text-gray-600">
                    Note: You must pay the security deposit before you can make contributions.
                    The deposit is refundable if you decide to leave the circle later.
                  </p>
                </div>
              </div>
            )}

            {/* Add info message explaining why security deposit button is disabled */}
              {!userDepositPaid && circle?.pausedAfterCycle && securityDepositReturnedDuringPause && (
              <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3">
                <p className="text-sm text-red-700 font-medium flex items-center">
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 mr-1.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                  </svg>
                  Security deposit already returned
                </p>
                <p className="text-xs text-red-600 mt-1">
                  You have already received your security deposit for this cycle. You must wait for the admin to resume the cycle before paying a new deposit.
                </p>
              </div>
            )}

            {/* Add contribution source indicator */}
            {userDepositPaid && (
              <div className="mb-4 rounded-lg border p-3">
                {selectedPaymentCurrency === 'USDC' ? (
                  <div className="flex flex-col items-start space-y-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 sm:flex-row sm:space-x-3 sm:space-y-0">
                    <div className="bg-green-100 rounded-full p-1 self-start">
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-green-600" viewBox="0 0 20 20" fill="currentColor">
                        <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                      </svg>
                    </div>
                    <div>
                      <p className="text-sm font-medium text-green-800">USDC selected (default)</p>
                      <p className="text-xs text-green-700 mt-1">
                        Required: {formatUsdCentsAsUsdc(circle?.contributionAmountUsd || 0)}.
                        Available in wallet: {userUsdcBalance !== null ? `${formatUSD(userUsdcBalance)} USDC` : 'loading...'}.
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-col items-start space-y-2 rounded-lg border border-blue-200 bg-blue-50 p-3 sm:flex-row sm:space-x-3 sm:space-y-0">
                    <div className="bg-blue-100 rounded-full p-1 self-start">
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-blue-600" viewBox="0 0 20 20" fill="currentColor">
                        <path fillRule="evenodd" d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4zm2 6a1 1 0 011-1h6a1 1 0 110 2H7a1 1 0 01-1-1zm1 3a1 1 0 100 2h6a1 1 0 100-2H7z" clipRule="evenodd" />
                      </svg>
                    </div>
                    <div>
                      <p className="text-sm font-medium text-blue-800">SUI opt-in selected</p>
                      <p className="text-xs text-blue-700 mt-1">
                        This contribution will require {getValidContributionAmount().toFixed(4)} SUI from your wallet.
                      </p>
                    </div>
                  </div>
                )}
              </div>
            )}
          
            {/* Legacy custody contribute button retired 2026-04-28.
                Members now contribute via the CycleEscrowPanel at the top of
                this page (which calls njangi_cycle_escrow::contribute<T>).
                The status block below is informational only. */}
            <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
              <p className="font-semibold">Contribute in the round panel above</p>
              <p className="mt-1 text-emerald-800/90">
                Pay your share through the green &ldquo;This round&rsquo;s pot&rdquo;
                panel at the top. It runs through the per-cycle escrow with a
                frozen snapshot, and the recipient claims their payout from the
                same panel when the round is full.
              </p>
            </div>
            
            {/* Add inactive or paused circle message */}
            {circle && (!circle.isActive || circle.pausedAfterCycle) && (
              <div className="mt-3 p-3 bg-amber-50 rounded-lg border border-amber-200">
                <p className="text-sm text-amber-700 font-medium">
                  {!circle.isActive 
                    ? "This circle is not active yet"
                    : "This circle is paused after cycle completion"}
                </p>
                <p className="text-xs text-amber-600 mt-1">
                  {!userDepositPaid 
                    ? "Security deposits can still be paid before activation or while paused."
                    : circle.pausedAfterCycle
                      ? "Regular contributions are disabled while the circle is paused. Please wait for the admin to resume the cycle."
                      : "Regular contributions are disabled until the admin activates the circle. Please check back later."}
                </p>
              </div>
            )}
          </div>
          )}

          {showPrimaryWalletActionCard && (
            <div className="space-y-3">
              {!userDepositPaid && circle?.pausedAfterCycle && securityDepositReturnedDuringPause && (
                <div className="rounded-lg border border-red-200 bg-red-50 p-3">
                  <p className="text-sm text-red-700 font-medium flex items-center">
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 mr-1.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                    </svg>
                    Security deposit already returned
                  </p>
                  <p className="text-xs text-red-600 mt-1">
                    You have already received your security deposit for this cycle. You must wait for the admin to resume the cycle before paying a new deposit.
                  </p>
                </div>
              )}

              {circle && (!circle.isActive || circle.pausedAfterCycle) && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
                  <p className="text-sm text-amber-700 font-medium">
                    {!circle.isActive
                      ? "This circle is not active yet"
                      : "This circle is paused after cycle completion"}
                  </p>
                  <p className="text-xs text-amber-600 mt-1">
                    {!userDepositPaid
                      ? "Security deposits can still be paid before activation or while paused."
                      : circle.pausedAfterCycle
                        ? "Regular contributions are disabled while the circle is paused. Please wait for the admin to resume the cycle."
                        : "Regular contributions are disabled until the admin activates the circle. Please check back later."}
                  </p>
                </div>
              )}
            </div>
          )}

          <p className="text-center text-xs text-slate-500">
            By contributing, you agree to the circle&apos;s terms and conditions.
          </p>
          </>
        )}
      </div>
    );
  };

  if (authLoading || !isAuthenticated || !account) {
    return null;
  }

  return (
    <div className="min-h-screen bg-[#f6f3ee] text-slate-950 [background-image:radial-gradient(circle_at_top_left,_rgba(255,255,255,0.92),_transparent_30%),radial-gradient(circle_at_top_right,_rgba(226,232,240,0.7),_transparent_26%)]">
      <main className="mx-auto max-w-7xl px-3 py-6 sm:px-6 lg:px-8">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <button
            onClick={() => router.push('/dashboard')}
            className={secondaryActionClass}
          >
            <ArrowLeft className="mr-2 h-4 w-4" />
            {t('contribute.backToDashboard')}
          </button>
          <div className="text-right">
            <p className={sectionEyebrowClass}>{t('contribute.eyebrow')}</p>
            <h1 className="mt-1 text-lg font-semibold text-slate-950 sm:text-xl">{t('contribute.title')}</h1>
          </div>
        </div>

        <div className={`${pageSurfaceClass} overflow-hidden`}>
          <div className="border-b border-stone-200 px-4 py-5 sm:px-8 sm:py-8">
            <div className="flex flex-col gap-6">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div>
                  <p className={sectionEyebrowClass}>{t('contribute.workspaceEyebrow')}</p>
                  <h2 className="mt-3 text-2xl font-semibold tracking-tight text-slate-950 sm:text-3xl">
                    {!loading && circle
                      ? t('contribute.headingWithCircle', { circle: circle.name })
                      : t('contribute.heading')}
                  </h2>
                  <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-600">
                    {t('contribute.blurb')}
                  </p>
                </div>
                {!loading && circle && (
                  <div className="flex flex-wrap items-center gap-2 text-xs sm:text-sm">
                    <span className={subtleTagClass}>{circleStatusLabel}</span>
                    <span className={subtleTagClass}>{paymentStatusLabel}</span>
                    <span className={subtleTagClass}>Mode {circleModeLabel}</span>
                  </div>
                )}
              </div>

              {!loading && circle && typeof id === 'string' ? (
                <CycleEscrowPanel
                  circleId={id}
                  network={getCurrentNetwork() as NetworkType}
                  circleName={circle.name}
                  isAdmin={!!userAddress && circle.admin === userAddress}
                  memberNames={memberNameMap}
                  {...resolveCircleSettlementCoin(circle.autoSwapEnabled)}
                />
              ) : null}

              {!loading && circle && (
                <div className="grid gap-3 md:hidden">
                  <div className="rounded-[24px] border border-stone-200 bg-stone-50/80 p-3 sm:p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className={sectionEyebrowClass}>Payment Snapshot</p>
                        <p className="mt-1 text-sm text-slate-600">
                          Jump to wallet, circle, or payment details without stepping through the whole page.
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => scrollToContributeSection('payment')}
                        className="text-sm font-medium text-slate-600 transition hover:text-slate-950"
                      >
                        Open payment
                      </button>
                    </div>

                    <div className="mt-4 grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={() => scrollToContributeSection('wallet')}
                        className={mobileWorkspaceButtonClass}
                      >
                        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                          Wallet
                        </p>
                        <p className="mt-2 text-sm font-semibold text-slate-950">{walletSummaryLabel}</p>
                        <p className="mt-1 truncate text-xs text-slate-500">{walletSummaryDetail}</p>
                      </button>
                      <button
                        type="button"
                        onClick={() => scrollToContributeSection('circle')}
                        className={mobileWorkspaceButtonClass}
                      >
                        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                          Circle
                        </p>
                        <p className="mt-2 text-sm font-semibold text-slate-950">{circleStatusLabel}</p>
                        <p className="mt-1 text-xs text-slate-500">Mode {circleModeLabel}</p>
                      </button>
                      <button
                        type="button"
                        onClick={() => scrollToContributeSection('circle')}
                        className={mobileWorkspaceButtonClass}
                      >
                        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                          Cycle
                        </p>
                        <p className="mt-2 text-sm font-semibold text-slate-950">{cycleSummaryLabel}</p>
                        <p className="mt-1 text-xs text-slate-500">{cycleSummaryDetail}</p>
                      </button>
                      <button
                        type="button"
                        onClick={() => scrollToContributeSection('payment')}
                        className={mobileWorkspaceButtonClass}
                      >
                        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                          Payment
                        </p>
                        <p className="mt-2 text-sm font-semibold text-slate-950">{paymentStatusLabel}</p>
                        <p className="mt-1 text-xs text-slate-500">{mobilePaymentAmountLabel}</p>
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {!loading && circle && (
                <div className="hidden gap-4 md:grid md:grid-cols-2 xl:grid-cols-4">
                  <div className={mutedPanelClass}>
                    <p className={sectionEyebrowClass}>Contribution</p>
                    <div className="mt-3 text-lg font-semibold text-slate-950">
                      <CurrencyDisplay
                        localAmount={circle.contributionAmountLocal}
                        sui={circle.contributionAmount}
                        currencyType={circle.currencyType}
                      />
                    </div>
                    <p className="mt-2 text-sm text-slate-500">Required per active cycle.</p>
                  </div>
                  <div className={mutedPanelClass}>
                    <p className={sectionEyebrowClass}>Deposit</p>
                    <div className="mt-3 text-lg font-semibold text-slate-950">
                      <CurrencyDisplay
                        localAmount={circle.securityDepositLocal}
                        sui={circle.securityDeposit}
                        currencyType={circle.currencyType}
                      />
                    </div>
                    <p className="mt-2 text-sm text-slate-500">
                      {userDepositPaid ? 'Security deposit already paid.' : 'Required before contributing.'}
                    </p>
                  </div>
                  <div className={mutedPanelClass}>
                    <p className={sectionEyebrowClass}>Cycle</p>
                    <p className="mt-3 text-2xl font-semibold tracking-tight text-slate-950">
                      {currentCycle > 0 ? `Cycle ${currentCycle}` : 'Setup'}
                    </p>
                    <p className="mt-2 text-sm text-slate-500">
                      {circle.pausedAfterCycle ? 'Cycle completed and awaiting resume.' : circle.isActive ? 'Payments are open for the current cycle.' : 'Waiting for activation.'}
                    </p>
                  </div>
                  <div className={mutedPanelClass}>
                    <p className={sectionEyebrowClass}>Selected Mode</p>
                    <p className="mt-3 text-2xl font-semibold tracking-tight text-slate-950">
                      {selectedPaymentCurrency}
                    </p>
                    <p className="mt-2 text-sm text-slate-500">You can only use modes allowed by the circle admin.</p>
                  </div>
                </div>
              )}
            </div>

            {loading ? (
              <div className="px-6 py-12 text-center sm:px-8">
                <svg className="mx-auto h-8 w-8 animate-spin text-slate-400" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
              </div>
            ) : circle ? (
              <div className="space-y-6 bg-stone-50/60 px-3 py-5 sm:px-6 sm:py-8">
                <div className={sectionCardClass} ref={(element) => setContributeSectionRef('wallet', element)}>
                  <div className="mb-5 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <p className={sectionEyebrowClass}>Wallet</p>
                      <h3 className={`${sectionTitleClass} mt-2`}>Your Wallet</h3>
                      <p className="mt-2 text-sm leading-6 text-slate-500">
                        Confirm available balance and the connected address before you submit a deposit or contribution.
                      </p>
                    </div>
                    <button
                      onClick={() => fetchUserWalletInfo()}
                      disabled={fetchingBalance}
                      className={`${secondaryActionClass} px-3 py-2 text-xs sm:text-sm`}
                    >
                      {fetchingBalance ? (
                        <span className="flex items-center">
                          <svg className="mr-2 h-3.5 w-3.5 animate-spin" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                          </svg>
                          Refreshing...
                        </span>
                      ) : (
                        <>
                          <svg xmlns="http://www.w3.org/2000/svg" className="mr-2 h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                          </svg>
                          Refresh Balance
                        </>
                      )}
                    </button>
                  </div>

                  <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                    <div className={mutedPanelClass}>
                      <p className={sectionEyebrowClass}>Available Balance</p>
                      {fetchingBalance || totalSuiEquivalentDisplay === null ? (
                        <div className="mt-3 h-7 w-44 animate-pulse rounded bg-stone-200"></div>
                      ) : (
                        <p className="mt-3 text-lg font-semibold text-slate-950">{totalSuiEquivalentDisplay}</p>
                      )}
                    </div>
                    <div className={mutedPanelClass}>
                      <p className={sectionEyebrowClass}>Wallet Address</p>
                      <p className="mt-3 break-all font-mono text-sm text-slate-700">
                        {userAddress ? `${userAddress.substring(0, 6)}...${userAddress.substring(userAddress.length - 4)}` : ''}
                      </p>
                    </div>
                    <div className={mutedPanelClass}>
                      <p className={sectionEyebrowClass}>Payment Readiness</p>
                      <p className="mt-3 text-lg font-semibold text-slate-950">{paymentStatusLabel}</p>
                      <p className="mt-2 text-sm text-slate-500">
                        {!userDepositPaid ? 'Deposit still required.' : userHasContributed ? 'This cycle is already complete for you.' : isCurrentRecipient ? 'No payment required this cycle.' : 'You can continue with payment.'}
                      </p>
                    </div>
                  </div>
                </div>

                <div className={sectionCardClass} ref={(element) => setContributeSectionRef('circle', element)}>
                  <div className="mb-5">
                    <p className={sectionEyebrowClass}>Circle Overview</p>
                    <h3 className={`${sectionTitleClass} mt-2`}>Circle Details</h3>
                    <p className="mt-2 text-sm leading-6 text-slate-500">
                      Contribution rules, current cycle progress, and live custody balances for this circle.
                    </p>
                  </div>

                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                    <div className={mutedPanelClass}>
                      <p className={sectionEyebrowClass}>Circle Name</p>
                      <p className="mt-3 text-lg font-semibold text-slate-950">{circle.name}</p>
                    </div>

                    <div className={mutedPanelClass}>
                      <p className={sectionEyebrowClass}>Contribution Amount</p>
                      <div className="mt-3 text-lg font-semibold text-slate-950">
                        <CurrencyDisplay localAmount={circle.contributionAmountLocal} sui={circle.contributionAmount} currencyType={circle.currencyType} />
                      </div>
                    </div>

                    <div className={mutedPanelClass}>
                      <p className={sectionEyebrowClass}>Security Deposit</p>
                      <div className="mt-3 text-lg font-semibold text-slate-950">
                        <CurrencyDisplay localAmount={circle.securityDepositLocal} sui={circle.securityDeposit} currencyType={circle.currencyType} />
                      </div>
                    </div>

                    <div className={mutedPanelClass}>
                      <p className={sectionEyebrowClass}>Deposit Status</p>
                      {fetchingBalance ? (
                        <div className="mt-3 h-6 w-28 animate-pulse rounded bg-stone-200"></div>
                      ) : (
                        <div className="mt-3 flex items-center gap-3">
                          <span className={`h-2.5 w-2.5 rounded-full ${userDepositPaid ? 'bg-emerald-500' : 'bg-amber-500'}`}></span>
                          <span className={`font-medium ${userDepositPaid ? 'text-emerald-700' : 'text-amber-700'}`}>
                            {userDepositPaid ? 'Paid' : 'Not Paid'}
                          </span>
                        </div>
                      )}
                    </div>

                    {/* Cycle Progress is now rendered by the CycleEscrowPanel
                        ("This round's pot") at the top of the page, which owns
                        the round ring + per-member status. The legacy
                        ContributionProgress card was removed to avoid showing
                        two trackers for the same data. */}

                    <div className={`${mutedPanelClass} md:col-span-2`}>
                      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                        <div>
                          <p className={sectionEyebrowClass}>Custody Balances</p>
                          <h4 className="mt-2 text-lg font-semibold text-slate-950">Custody Wallet Balances</h4>
                        </div>
                        <button
                          onClick={refreshData}
                          disabled={loadingStablecoinBalance || fetchingSuiBalance}
                          className={`${secondaryActionClass} px-3 py-2 text-xs sm:text-sm`}
                        >
                          {loadingStablecoinBalance || fetchingSuiBalance ? (
                            <span className="flex items-center">
                              <svg className="mr-2 h-3.5 w-3.5 animate-spin" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                              </svg>
                              Refreshing...
                            </span>
                          ) : (
                            <>
                              <svg xmlns="http://www.w3.org/2000/svg" className="mr-2 h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                              </svg>
                              Refresh All Balances
                            </>
                          )}
                        </button>
                      </div>

                      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                        {(fetchingSuiBalance || custodySuiBalance !== null) && (
                          <div className="rounded-[20px] border border-stone-200 bg-white p-3 sm:p-4">
                            <p className={sectionEyebrowClass}>SUI</p>
                            {fetchingSuiBalance ? (
                              <div className="mt-3 h-6 w-32 animate-pulse rounded bg-stone-200"></div>
                            ) : (
                              <div className="mt-3 flex items-center gap-2">
                                <span className="text-lg font-semibold text-slate-950">
                                  {custodySuiBalance !== null ? `${custodySuiBalance.toFixed(4)} SUI` : '-'}
                                </span>
                                <span className={subtleTagClass}>Total</span>
                              </div>
                            )}
                            {(custodySuiBalance !== null && custodySuiBalance > 0) && (
                              <div className="mt-4 space-y-2">
                                <div className="flex flex-wrap items-center gap-2 text-sm text-slate-700">
                                  <div className="h-3 w-3 rounded-sm bg-amber-300"></div>
                                  <span>{suiSecurityDepositBalance !== null ? suiSecurityDepositBalance.toFixed(6) : '0.00'} SUI</span>
                                  <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">Security Deposits</span>
                                </div>
                                <div className="flex flex-wrap items-center gap-2 text-sm text-slate-700">
                                  <div className="h-3 w-3 rounded-sm bg-emerald-300"></div>
                                  <span>{suiContributionBalance !== null ? suiContributionBalance.toFixed(6) : '0.00'} SUI</span>
                                  <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800">Available for Contributions</span>
                                </div>
                              </div>
                            )}
                          </div>
                        )}

                        {(loadingStablecoinBalance || custodyStablecoinBalance !== null) && (
                          <div className="rounded-[20px] border border-stone-200 bg-white p-3 sm:p-4">
                            <p className={sectionEyebrowClass}>USDC</p>
                            {loadingStablecoinBalance ? (
                              <div className="mt-3 h-6 w-32 animate-pulse rounded bg-stone-200"></div>
                            ) : (
                              <div className="mt-3 flex items-center gap-2">
                                <span className="text-lg font-semibold text-slate-950">
                                  {custodyUsdcTotalLocalDisplay !== null ? custodyUsdcTotalLocalDisplay : custodyStablecoinBalance !== null ? `${formatUSD(custodyStablecoinBalance)} USDC` : '-'}
                                </span>
                                <span className={subtleTagClass}>Total</span>
                              </div>
                            )}
                            {(custodyStablecoinBalance !== null && custodyStablecoinBalance > 0) && (
                              <div className="mt-4 space-y-2">
                                <div className="flex flex-wrap items-center gap-2 text-sm text-slate-700">
                                  <div className="h-3 w-3 rounded-sm bg-amber-300"></div>
                                  <span>{custodyUsdcSecurityDepositLocalDisplay !== null ? custodyUsdcSecurityDepositLocalDisplay : securityDepositBalance !== null ? `${formatUSD(securityDepositBalance)} USDC` : '-'}</span>
                                  <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">Security Deposits</span>
                                </div>
                                <div className="flex flex-wrap items-center gap-2 text-sm text-slate-700">
                                  <div className="h-3 w-3 rounded-sm bg-emerald-300"></div>
                                  <span>{custodyUsdcContributionLocalDisplay !== null ? custodyUsdcContributionLocalDisplay : contributionBalance !== null ? `${formatUSD(contributionBalance)} USDC` : '-'}</span>
                                  <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800">Available for Contributions</span>
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                      </div>

                      {!fetchingSuiBalance && custodySuiBalance === null && !loadingStablecoinBalance && custodyStablecoinBalance === null && (
                        <p className="py-4 text-center text-sm text-slate-500">Could not fetch custody wallet balances.</p>
                      )}
                    </div>
                  </div>
                </div>

                {renderContributionOptions()}
              </div>
            ) : (
              <div className="px-6 py-10 text-center sm:px-8">
                <p className="text-slate-500">Circle not found</p>
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
