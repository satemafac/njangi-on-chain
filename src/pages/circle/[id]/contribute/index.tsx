import React, { useEffect, useState, useRef } from 'react';
import { useRouter } from 'next/router';
import { useAuth } from '../../../../contexts/AuthContext';
import { SuiClient } from '@mysten/sui/client';
import { toast } from 'react-hot-toast';
import { ArrowLeft } from 'lucide-react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { priceService } from '../../../../services/price-service';
import { PACKAGE_ID, getCirclePackageId } from '../../../../services/circle-service';
import SimplifiedSwapUI from '../../../../components/SimplifiedSwapUI';
import { getCoinType } from '../../../../config/constants';
import { getCurrentRpcUrl } from '../../../../services/network-config';

// Add this helper function at the top level
function getJsonRpcUrl(): string {
  return getCurrentRpcUrl();
}

// Constants for transaction calculations
const ESTIMATED_GAS_FEE = 0.00021; // Gas fee in SUI
const DEFAULT_SLIPPAGE = 0.5; // Default slippage percentage
const BUFFER_PERCENTAGE = 1.5; // Additional buffer percentage for swap rate fluctuations

// Helper function to format USD amounts - MOVED TO MODULE SCOPE
const formatUSD = (amount: number): string => {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(amount);
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

// Create a new interface for contribution progress data
interface ContributionProgressData {
  totalMembers: number;
  contributedMembers: Set<string>;
  currentCycle: number;
  memberList: string[]; // Store all members in order
  currentRecipientAddress?: string | null; // Add recipient address
}

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

// Add PayoutProcessedEvent interface for cycle tracking
interface PayoutProcessedEvent {
  circle_id: string;
  recipient: string;
  amount: string;
  cycle: string | number;
  payout_type: string | number;
}

// Define types for SUI object field values
type SuiFieldValue = string | number | boolean | null | undefined | SuiFieldValue[] | Record<string, unknown>;

// Add ContributionProgress component
const ContributionProgress: React.FC<{
  circleId: string;
  maxMembers: number; // This is the total capacity, might differ from active rotation
  currentCycle: number;
  className?: string;
  currentRecipientAddress?: string | null; // Add to props
  // currentPositionInCycle?: number | null; // REMOVED - No longer used here
  // totalMembersInRotation?: number | null; // REMOVED - No longer used here
  isPaused?: boolean; // Add isPaused prop
  circlePackageId: string; // Add circlePackageId prop
}> = ({ 
  circleId, 
  maxMembers, 
  currentCycle, 
  className = '', 
  currentRecipientAddress,
  isPaused = false, // Default to false
  circlePackageId // Add to destructured props
  // currentPositionInCycle, // REMOVED
  // totalMembersInRotation // REMOVED
}) => {
  const [progressData, setProgressData] = useState<ContributionProgressData>({
    totalMembers: maxMembers,
    contributedMembers: new Set<string>(),
    currentCycle: currentCycle,
    memberList: [],
    currentRecipientAddress: currentRecipientAddress, // Initialize from prop
  });
  const [isLoading, setIsLoading] = useState(true);
  const [currentPosition, setCurrentPosition] = useState<number | null>(null); // Internal state for fetched position, distinct from prop
  const [lastPayoutTime, setLastPayoutTime] = useState<number | null>(null);
  
  // Track if we've already fetched data for this cycle
  const alreadyFetchedForCycle = useRef<number | null>(null);
  
  // Check for payout events to detect cycle changes
  const checkForPayoutEvents = async () => {
    if (!circleId || !circlePackageId) return;

    try {
      const client = new SuiClient({ url: getJsonRpcUrl() });
      
      // Query PayoutProcessed events
      const payoutEvents = await client.queryEvents({
        query: { MoveEventType: `${circlePackageId}::njangi_payments::PayoutProcessed` },
        limit: 20
      });
      
      // Find the most recent payout event for this circle
      const circlePayoutEvents = payoutEvents.data
        .filter(event => {
          const parsedJson = event.parsedJson as PayoutProcessedEvent;
          return parsedJson?.circle_id === circleId;
        })
        .sort((a, b) => {
          // Sort by timestamp (newest first)
          return (Number(b.timestampMs) || 0) - (Number(a.timestampMs) || 0);
        });
      
      if (circlePayoutEvents.length > 0) {
        const latestEvent = circlePayoutEvents[0];
        
        // Set last payout time
        if (latestEvent.timestampMs) {
          const newPayoutTime = Number(latestEvent.timestampMs);
          
          // If we have a new payout time that's different from our last recorded one
          if (!lastPayoutTime || newPayoutTime > lastPayoutTime) {
            console.log(`[Progress] New payout detected at ${new Date(newPayoutTime).toISOString()}`);
            setLastPayoutTime(newPayoutTime);
                
            // Force a refetch of contribution data
            fetchTransactionHistory(true);
            }
          }
        }
      } catch (error) {
      console.error("Error checking for payout events:", error);
      }
  };
  
  const fetchTransactionHistory = async (forceRefresh = false) => {
    if (!circleId || currentCycle <= 0) {
      setIsLoading(false);
      return;
    }
    
    if (alreadyFetchedForCycle.current === currentCycle && !forceRefresh) {
      console.log(`[Progress] Already fetched data for cycle ${currentCycle}, skipping...`);
      setIsLoading(false);
      return;
    }
    
    setIsLoading(true);
    console.log(`[Progress] Fetching member contribution status for Cycle ${currentCycle} in circle ${circleId}`);

    try {
      const client = new SuiClient({ url: getJsonRpcUrl() });
      const contributedMembers = new Set<string>();
      let memberListFromRotation: string[] = [];
      let currentRecipient: string | null = null;
            
      // 1. Fetch the Circle object to get rotation_order and current_position
      const circleObject = await client.getObject({
        id: circleId,
        options: { showContent: true },
      });

      if (circleObject.data?.content && 'fields' in circleObject.data.content) {
        const circleFields = circleObject.data.content.fields as {
          rotation_order?: string[];
          current_position?: string | number;
          members?: { fields?: { id?: { id: string } } };
          paused_after_cycle?: boolean; // Add check for paused state
          [key: string]: unknown; // Allow other fields
        };        
        if (Array.isArray(circleFields.rotation_order)) {
          memberListFromRotation = circleFields.rotation_order.filter(addr => typeof addr === 'string' && addr !== '0x0');
        }
        
        // Only set current recipient if not paused
        if (!isPaused && !circleFields.paused_after_cycle) {
          const position = Number(circleFields.current_position);
          if (!isNaN(position) && position < memberListFromRotation.length) {
            currentRecipient = memberListFromRotation[position];
            setCurrentPosition(position); // Update internal currentPosition state
            console.log(`[Progress] Current recipient: ${currentRecipient} at position ${position}`);
          }
        } else {
          console.log(`[Progress] Circle is paused - no current recipient`);
          currentRecipient = null;
          setCurrentPosition(null);
        }
      } else {
        console.error('[Progress] Could not fetch Circle object content.');
        setIsLoading(false);
        return;
      }

      // 2. Fetch the members table ID
      let membersTableId: string | null = null;
      if (circleObject.data?.content && 'fields' in circleObject.data.content) {
        const circleFields = circleObject.data.content.fields as { 
          members?: { fields?: { id?: { id: string } } } 
        };
        if (circleFields.members?.fields?.id?.id) {
          membersTableId = circleFields.members.fields.id.id;
        }
      }

      if (!membersTableId) {
        console.error('[Progress] Could not find members table ID in Circle object.');
        setIsLoading(false);
        return;
      }
      
      // 3. Iterate through members in rotation_order and check their last_contribution
      for (const memberAddr of memberListFromRotation) {
        if (memberAddr === currentRecipient) {
          // Skip the current recipient as they don't contribute this cycle
          continue;
        }
        
      try {
          const memberField = await client.getDynamicFieldObject({
            parentId: membersTableId,
            name: { type: 'address', value: memberAddr },
          });

          if (memberField.data?.content && 'fields' in memberField.data.content) {
            const memberValue = (memberField.data.content.fields as {
              value?: { fields?: { last_contribution?: string | number; [key: string]: unknown } };
              [key: string]: unknown;
            }).value;
            if (memberValue?.fields?.last_contribution && Number(memberValue.fields.last_contribution) > 0) {
              // Consider contributed if last_contribution is non-zero
              // More sophisticated logic might compare this timestamp with the cycle start time
              contributedMembers.add(memberAddr);
              console.log(`[Progress] Member ${memberAddr} has contributed (last_contribution: ${memberValue.fields.last_contribution})`);
              } else {
              console.log(`[Progress] Member ${memberAddr} has NOT contributed (last_contribution: ${memberValue?.fields?.last_contribution})`);
          }
        }
      } catch (error) {
          console.warn(`[Progress] Error fetching member ${memberAddr}:`, error);
        }
      }
      
      console.log(`[Progress] Total unique contributors (excluding recipient): ${contributedMembers.size}`);
      console.log(`[Progress] Contributors:`, Array.from(contributedMembers));
      console.log(`[Progress] All members from rotation:`, memberListFromRotation);

      setProgressData({
        totalMembers: Number(maxMembers), // Use the prop value
        contributedMembers,
        currentCycle,
        memberList: memberListFromRotation, 
        currentRecipientAddress: currentRecipient, 
      });
      
      alreadyFetchedForCycle.current = currentCycle;
    } catch (error) {
      console.error('[Progress] Error fetching contribution status:', error);
    } finally {
      setIsLoading(false);
    }
  };

  // Set up polling to check for payouts every 10 seconds
  useEffect(() => {
    // Initial check only, no interval anymore
    checkForPayoutEvents();
    
    // Removed interval code here to stop auto-refresh

    // No need for cleanup function since we don't create an interval
  }, [circleId, circlePackageId]);

  useEffect(() => {
    if (circleId && maxMembers > 0 && currentCycle > 0) {
      console.log("[Progress] Required data available, fetching contribution events...");
      // Force a refresh when the cycle or recipient changes
      fetchTransactionHistory(currentRecipientAddress !== progressData.currentRecipientAddress);
    } else {
      console.log("[Progress] Waiting for required data:", { circleId, maxMembers, currentCycle });
    }
  // Add currentPosition (internal state), lastPayoutTime and currentRecipientAddress to dependency array
  }, [circleId, maxMembers, currentCycle, currentPosition, lastPayoutTime, currentRecipientAddress, isPaused]);

  // Calculate progress percentage
  const contributedCount = progressData.contributedMembers.size;
  const expectedContributors = progressData.currentRecipientAddress ? Math.max(0, progressData.totalMembers - 1) : progressData.totalMembers;
  
  const progressPercentage = expectedContributors > 0 
    ? (contributedCount / expectedContributors) * 100 
    : 0;
  
  // Determine status color based on progress
  const getStatusColor = () => {
    if (isPaused) return 'text-amber-500'; // Amber for paused state
    if (progressPercentage === 100) return 'text-green-500';
    if (progressPercentage > 60) return 'text-blue-500';
    if (progressPercentage > 30) return 'text-yellow-500';
    return 'text-gray-500';
  };
  
  // Helper to format wallet address for display
  const formatAddress = (address: string): string => {
    if (!address.startsWith('0x')) return address;
    if (address.length <= 10) return address;
    return `${address.substring(0, 6)}...${address.substring(address.length - 4)}`;
  };

  return (
    <div className={`flex flex-col items-center ${className}`}>
      {/* Title has been removed from here */}
      <div className="relative w-36 h-36">
        {/* Background circle (gray/inactive) */}
        <svg className="w-full h-full" viewBox="0 0 100 100">
          <circle
            cx="50"
            cy="50"
            r="45"
            fill="none"
            stroke="#e5e7eb"
            strokeWidth="8"
          />
          
          {/* Progress circle */}
          <circle
            cx="50"
            cy="50"
            r="45"
            fill="none"
            stroke={isPaused ? '#f59e0b' : progressPercentage === 100 ? '#10B981' : '#3B82F6'}
            strokeWidth="8"
            strokeDasharray={`${progressPercentage * 2.83} 283`}
            strokeDashoffset="0"
            transform="rotate(-90 50 50)"
            strokeLinecap="round"
            className="transition-all duration-500 ease-in-out"
          />
          
          {/* Center content - conditional rendering */}
          {isPaused ? (
            <>
              {/* Pause icon for paused state - move up slightly */}
              <g transform="translate(50, 42)" className="fill-amber-500">
                <rect x="-10" y="-15" width="7" height="30" rx="2" />
                <rect x="3" y="-15" width="7" height="30" rx="2" />
              </g>
              <text 
                x="50" 
                y="75" 
                textAnchor="middle" 
                dominantBaseline="middle"
                className="text-gray-500 text-xs fill-current"
              >
                Cycle
              </text>
            </>
          ) : (
            <>
              {/* Percentage text for normal state */}
              <text 
                x="50" 
                y="50" 
                textAnchor="middle" 
                dominantBaseline="middle"
                className={`${getStatusColor()} font-bold text-xl fill-current`}
              >
                {isLoading ? "..." : `${Math.round(progressPercentage)}%`}
              </text>
              <text 
                x="50" 
                y="65" 
                textAnchor="middle" 
                dominantBaseline="middle"
                className="text-gray-500 text-xs fill-current"
              >
                Complete
              </text>
            </>
          )}
        </svg>
        
        {/* Member sectors around the circle */}
        {(() => {
          // Filter out the recipient for dot visualization around the circle
          const membersForDots = progressData.currentRecipientAddress && !isPaused
            ? progressData.memberList.filter(member => member !== progressData.currentRecipientAddress)
            : progressData.memberList;
          const numDots = membersForDots.length;

          return membersForDots.map((memberAddr, index) => {
            const angle = numDots > 0 ? (index / numDots) * Math.PI * 2 - Math.PI / 2 : 0;
          const x = 50 + 55 * Math.cos(angle);
          const y = 50 + 55 * Math.sin(angle);
          const hasContributed = progressData.contributedMembers.has(memberAddr);
            // Recipient is filtered out, so dotColor is simpler
            const dotColor = isPaused 
              ? 'bg-amber-300' // Amber for paused state
              : hasContributed 
                ? 'bg-green-500' 
                : 'bg-gray-300';
          
          return (
              <div key={memberAddr} className="group"> {/* Use memberAddr for key due to filtering */}
              <div 
                className={`absolute w-3 h-3 rounded-full transform -translate-x-1/2 -translate-y-1/2 border border-white 
                    ${dotColor} 
                  hover:scale-125 transition-all duration-200`}
                style={{ 
                  left: `${x}%`, 
                  top: `${y}%`,
                }}
              />
              {/* Tooltip that appears on hover */}
              <div 
                className="absolute hidden group-hover:block bg-gray-900 text-white text-xs rounded p-2 z-10"
                style={{ 
                  left: `${x}%`, 
                  top: `${y}%`,
                  transform: 'translate(-50%, -100%)',
                  marginTop: '-10px',
                }}
              >
                <p className="whitespace-nowrap">
                  {formatAddress(memberAddr)}
                    {isPaused 
                      ? ' (Cycle Paused)' 
                      : hasContributed 
                        ? ' ✓' 
                        : ' ✘'}
                </p>
              </div>
            </div>
          );
          });
        })()}
      </div>
      
      <div className="mt-4 text-center">
        <p className="text-sm font-medium">
          {isLoading ? "Loading..." : `${contributedCount} of ${expectedContributors} expected contributors`}
        </p>
        <p className="text-xs text-gray-500">
          {isPaused ? `Cycle ${currentCycle} Completed - Pending Next Cycle` : `Current Cycle Contributions`}
        </p>
      </div>
      
      {/* Add legend to identify members */}
      <div className="mt-3 grid grid-cols-1 gap-2 text-xs w-full max-w-xs">
        {progressData.memberList.map((memberAddr, index) => {
          const hasContributed = progressData.contributedMembers.has(memberAddr);
          const isRecipient = !isPaused && memberAddr === progressData.currentRecipientAddress;
          
          const statusText = isPaused 
            ? 'Waiting for Next Cycle' 
            : isRecipient 
              ? 'Receiving Payout' 
              : hasContributed 
                ? 'Contributed' 
                : 'Pending';
                
          const statusColorClass = isPaused 
            ? 'text-amber-600 font-medium' 
            : isRecipient 
              ? 'text-blue-600 font-medium' 
              : hasContributed 
                ? 'text-green-600 font-medium' 
                : 'text-gray-500';
                
          const dotColorClass = isPaused 
            ? 'bg-amber-300' 
            : isRecipient 
              ? 'bg-blue-500' 
              : hasContributed 
                ? 'bg-green-500' 
                : 'bg-gray-300';

          return (
            <div key={index} className="flex items-center justify-between">
              <div className="flex items-center">
                <div className={`w-3 h-3 mr-2 rounded-full ${dotColorClass}`}></div>
                <span className="font-mono">{formatAddress(memberAddr)}</span>
              </div>
              <span className={`${statusColorClass} ml-4`}>
                {statusText}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default function ContributeToCircle() {
  const router = useRouter();
  const { id } = router.query;
  const { isAuthenticated, userAddress, account } = useAuth();
  const [loading, setLoading] = useState(true);
  const [circle, setCircle] = useState<Circle | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [suiPrice, setSuiPrice] = useState(1.25);
  
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
  const [cycleRecipientAddress, setCycleRecipientAddress] = useState<string | null>(null);

  // New states for cycle position tracking
  const [currentPositionInCycle, setCurrentPositionInCycle] = useState<number | null>(null);
  const [totalMembersInRotation, setTotalMembersInRotation] = useState<number | null>(null);

  // Add a new state variable to track if a user has had their security deposit returned during the current paused cycle
  const [securityDepositReturnedDuringPause, setSecurityDepositReturnedDuringPause] = useState<boolean>(false);
  
  // Add dynamic package ID state
  const [circlePackageId, setCirclePackageId] = useState<string>(PACKAGE_ID);

  useEffect(() => {
    if (!isAuthenticated) {
      router.push('/');
      return;
    }
  }, [isAuthenticated, router]);

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
    // Fetch circle details when ID is available
    if (id && userAddress) {
      fetchCircleDetails();
    }
  }, [id, userAddress]);

  // Add effect to fetch user balance and deposit status when circle data is loaded
  useEffect(() => {
    if (circle && userAddress) {
      fetchUserWalletInfo();
    }
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
  }, [custodyStablecoinBalance, securityDepositBalance, contributionBalance, circle?.currencyType, suiPrice]);

  // Fix type assertion issues in the function
  const fetchCustodyWalletSuiBalance = async () => {
    if (!circle?.walletId) return;
    
    setFetchingSuiBalance(true);
    try {
      const rpcUrl = getJsonRpcUrl();
      console.log('[Balance Fetch] Using RPC URL:', rpcUrl);
      const client = new SuiClient({ url: rpcUrl }); // Use helper function for URL
      
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
      console.error('Error fetching custody wallet SUI balance:', error);
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
      
      const client = new SuiClient({ url: getCurrentRpcUrl() });
      
      // Get circle object with content
      const objectData = await client.getObject({
        id: id as string,
        options: { showContent: true, showType: true }
      });
      
      if (!objectData.data?.content || !('fields' in objectData.data.content)) {
        throw new Error('Invalid circle object data received');
      }
      
        const fields = objectData.data.content.fields as CircleFields;
      console.log('Contribute - Raw Circle Object Fields:', fields);
      
      // Explicitly check for the is_active field in the circle object and log it
      let isActive = false;
      if ('is_active' in fields) {
        isActive = Boolean(fields.is_active);
        console.log('Contribute - Found is_active field in circle object:', isActive);
      }

      // Check for paused after cycle field
      let isPausedAfterCycle = false;
      if ('paused_after_cycle' in fields) {
        isPausedAfterCycle = Boolean(fields.paused_after_cycle);
        console.log('Contribute - Found paused_after_cycle field in circle object:', isPausedAfterCycle);
      }
      
      // Read current_cycle from the circle object
      let cycleNumber = 1; // Default to 1
      if ('current_cycle' in fields && typeof fields.current_cycle === 'string') {
        cycleNumber = parseInt(fields.current_cycle, 10);
        console.log('Contribute - Found current_cycle field:', cycleNumber);
      }
      setCurrentCycle(cycleNumber);

      // Get current_position and rotation_order for cycle position display
      if (fields.current_position !== undefined && fields.rotation_order && Array.isArray(fields.rotation_order)) {
        const position = Number(fields.current_position);
        const rotationOrderArray = fields.rotation_order.filter(addr => typeof addr === 'string' && addr !== '0x0');
        if (!isNaN(position) && position >= 0 && rotationOrderArray.length > 0) {
          setCurrentPositionInCycle(position);
          setTotalMembersInRotation(rotationOrderArray.length);
          console.log(`Contribute - Fetched cycle position: ${position + 1} of ${rotationOrderArray.length}`);
        }
      }
      
      // Get max_members from the circle object or dynamic fields
      let maxMembers = 10; // Default value
      
      // If is_active is not in the direct fields, also try to check activation events
      if (!isActive) {
        try {
          const activationEvents = await client.queryEvents({
            query: { MoveEventType: `${determinedPackageId}::njangi_circles::CircleActivated` },
            limit: 50
          });
          
          const activationForThisCircle = activationEvents.data.some(event => {
            const eventData = event.parsedJson as { circle_id?: string };
            return eventData?.circle_id === id;
          });
          
          if (activationForThisCircle) {
            isActive = true;
            console.log('Contribute - Circle is active based on CircleActivated event');
          }
        } catch (err) {
          console.error('Contribute - Error checking activation events:', err);
        }
      }
      
      // For specific circle with known ID, apply special override
      if (id === "0xa37e274f29ebc5a37b3f5c8acd3db61aac022739dc52973a0312ae3b19f18128") {
        console.log('Contribute - Special case: Known active circle detected. Forcing isActive to true.');
        isActive = true;
      }
        
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
        
        // 3. Fetch CustodyWalletCreated event for walletId
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

      } catch (error) {
        console.error('Contribute - Error fetching event/transaction data:', error);
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

      // 3. Look for config in dynamic fields
      for (const field of dynamicFields) {
        if (!field) continue;

        // CORRECTED CONDITION: Check the objectType property
        if (field.objectType && typeof field.objectType === 'string' && field.objectType.includes('::CircleConfig')) {
          console.log('Contribute - Found CircleConfig dynamic field by objectType:', field);
          if (field.objectId) {
            console.log('Contribute - Fetching CircleConfig dynamic field object:', field.objectId);
            try {
              const configData = await client.getObject({
                id: field.objectId,
                options: { showContent: true }
              });
              console.log('Contribute - Config object content:', configData);

              // Check if content and fields exist
              if (configData.data?.content && 'fields' in configData.data.content) {
                const outerFields = configData.data.content.fields;

                // TYPE GUARD: Safely check if outerFields is an object and has a 'value' property
                if (typeof outerFields === 'object' && outerFields !== null && 'value' in outerFields) {
                  const valueField = outerFields.value;

                  // TYPE GUARD: Safely check if valueField is an object and has a 'fields' property
                  if (typeof valueField === 'object' && valueField !== null && 'fields' in valueField) {
                    // Access the NESTED fields object safely
                    const configFields = valueField.fields as Record<string, SuiFieldValue>;
                    console.log('Contribute - Accessed nested configFields:', configFields);

                    // Override/set with values from the config object, prioritizing specific fields
                    if (configFields.contribution_amount) configValues.contributionAmount = Number(configFields.contribution_amount) / 1e9;
                    
                    // True USD equivalent from config
                    if (configFields.contribution_amount_usd) {
                      configValues.contributionAmountUsd = Number(configFields.contribution_amount_usd); // Expect cents
                    }
                    if (configFields.security_deposit_usd) {
                      configValues.securityDepositUsd = Number(configFields.security_deposit_usd); // Expect cents
                    }

                    // Local currency amounts from config (these are XAF, NGN etc in their smallest unit)
                    if (configFields.contribution_amount_local) {
                      configValues.contributionAmountLocal = Number(configFields.contribution_amount_local);
                    }
                    if (configFields.security_deposit_local) {
                      configValues.securityDepositLocal = Number(configFields.security_deposit_local);
                    }
                    
                    // Fallback for older config structures: if _local is missing but _usd is present and currency is not USD, assume _usd was intended as local
                    const currency = typeof configFields.currency_type === 'string' ? configFields.currency_type : (transactionInput?.currency_type as string || 'USD');
                    if (configValues.contributionAmountLocal === 0 && configValues.contributionAmountUsd > 0 && currency !== 'USD') {
                        console.warn("[CONTRIBUTE DEBUG] CircleConfig: contribution_amount_local missing, using contribution_amount_usd as local. Currency:", currency);
                        configValues.contributionAmountLocal = configValues.contributionAmountUsd;
                    }
                    if (configValues.securityDepositLocal === 0 && configValues.securityDepositUsd > 0 && currency !== 'USD') {
                        console.warn("[CONTRIBUTE DEBUG] CircleConfig: security_deposit_local missing, using security_deposit_usd as local. Currency:", currency);
                        configValues.securityDepositLocal = configValues.securityDepositUsd;
                    }

                    if (configFields.security_deposit) configValues.securityDeposit = Number(configFields.security_deposit) / 1e9;
                    
                    if (configFields.auto_swap_enabled !== undefined) {
                        const dynamicValue = Boolean(configFields.auto_swap_enabled);
                        console.log(`Contribute - Found auto_swap_enabled (${dynamicValue}) in dynamic field ${field.objectId}`);
                        configValues.autoSwapEnabled = dynamicValue;
                    }
                    if (configFields.max_members) {
                        maxMembers = Number(configFields.max_members);
                        console.log(`Contribute - Found max_members (${maxMembers}) in config field`);
                    }
                  } else {
                     console.warn('Contribute - Could not find nested fields in outerFields.value');
                  }
                } else {
                  console.warn("Contribute - Could not find 'value' property in outerFields");
                }
               } else {
                  console.warn('Contribute - Could not find fields in configData.data.content');
               }
            } catch (error) {
              console.error(`Contribute - Error fetching config object ${field.objectId}:`, error);
            }
            break; 
          }
        }
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
    
    try {
      const client = new SuiClient({ url: getJsonRpcUrl() }); // Use helper function for URL
      
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
        const autoSwapOn = Boolean(circle.autoSwapEnabled);
        const circleActive = Boolean(circle.isActive);
        const circlePaused = Boolean(circle.pausedAfterCycle);

        // Log intermediate values for debugging
        console.log('[Direct Deposit Check]', {
            userDepositPaid, 
            hasEnoughForSecurity,
            hasEnoughForContribution,
            autoSwapOn,
            circleActive,
            circlePaused,
            securityDepositRequiredUSD_ForCheck: securityDepositInDollars,
            contributionRequiredUSD_ForCheck: contributionInDollars,
            userUsdcBalance_InDollars: totalUsdcBalance,
            _rawCircleSecDepUsd_InCents: circle.securityDepositUsd,
            _rawCircleContrUsd_InCents: circle.contributionAmountUsd
        });

        // Condition 1: Paying Security Deposit (userDepositPaid state is false)
        if (!userDepositPaid && securityDepositInDollars > 0 && hasEnoughForSecurity && autoSwapOn) {
          showOption = true;
          console.log("Logic: Showing direct deposit for SECURITY DEPOSIT because it's > 0, user has enough, and autoswap is on.");
        }
        // Condition 2: Making Regular Contribution (userDepositPaid state is true)
        // Don't allow contributions if circle is paused after cycle
        else if (userDepositPaid && contributionInDollars > 0 && hasEnoughForContribution && autoSwapOn && circleActive && !circlePaused) {
           showOption = true;
           console.log("Logic: Showing direct deposit for CONTRIBUTION because it's > 0, user has enough, autoswap is on, circle active & not paused.");
        }
        
        setShowDirectDepositOption(showOption);
        // --- End of updated logic ---

      } catch (error) {
        console.error('Error fetching USDC balance:', error);
        setUserUsdcBalance(null);
        setShowDirectDepositOption(false);
      }
      
      // --- Check Deposit Status ---
      console.log(`Checking deposit status for user ${userAddress} in circle ${circle.id}...`);
      
      // Method 1: Try fetching the Member object directly (Best Source of Truth)
      try {
        const circleObject = await client.getObject({
          id: circle.id,
          options: { showContent: true }
        });
        
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
      
      // Method 2: Check MemberActivated Event (If direct fetch failed)
      if (!depositPaid) {
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
          console.error('Error fetching MemberActivated events:', eventError);
        }
      }

      // Method 3: Check Custody/Stablecoin Events (Further fallback)
      if (!depositPaid) {
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

      // New Step: Check SecurityDepositReturned Event to override depositPaid to false if applicable
      // This check should come *after* all checks that might set depositPaid to true,
      // as a returned deposit means it's no longer considered paid.
      if (depositPaid) { // Only check if we currently think it's paid
        try {
          console.log(`[ContributePage] Checking SecurityDepositReturned events for ${userAddress} in circle ${circle.id}...`);
          const securityReturnedEvents = await client.queryEvents({
            query: { MoveEventType: `${circlePackageId}::njangi_payments::SecurityDepositReturned` }, 
            limit: 50 // Adjust limit as needed
          });
          const hasReturnedEvent = securityReturnedEvents.data.some(event => {
            const parsed = event.parsedJson as { circle_id?: string; member?: string; };
            return parsed?.circle_id === circle.id && parsed?.member?.toLowerCase() === userAddress.toLowerCase();
          });

          if (hasReturnedEvent) {
            depositPaid = false; // Override: if a deposit was returned, it's no longer considered paid
            console.log(`[ContributePage] User ${userAddress} deposit status set to NOT PAID due to SecurityDepositReturned event.`);
          }
        } catch (eventError) {
          console.warn(`[ContributePage] Error fetching SecurityDepositReturned events:`, eventError);
        }
      }
      
      setUserDepositPaid(depositPaid);
      console.log('Final user deposit status:', depositPaid ? 'Paid' : 'Not Paid');
      
    } catch (error) {
      console.error('Error fetching user wallet info:', error);
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
      const client = new SuiClient({ url: getJsonRpcUrl() });
      let hasContributed = false;
      
      // First check for recent payout events to detect cycle/position changes
      const payoutEvents = await client.queryEvents({
        query: { MoveEventType: `${circlePackageId}::njangi_payments::PayoutProcessed` },
        limit: 20
      });
      
      // Find the most recent payout event for this circle
      const recentPayoutEvents = payoutEvents.data
        .filter(event => {
          const parsedJson = event.parsedJson as { circle_id?: string };
          return parsedJson?.circle_id === circle.id;
        })
        .sort((a, b) => {
          // Sort by timestamp (newest first)
          return (Number(b.timestampMs) || 0) - (Number(a.timestampMs) || 0);
        });
        
      const recentPayoutEvent = recentPayoutEvents.length > 0 ? recentPayoutEvents[0] : null;
      const payoutTimestamp = recentPayoutEvent ? Number(recentPayoutEvent.timestampMs) : 0;
      
      if (recentPayoutEvent) {
        console.log(`[Contribution Check] Found recent payout event at ${new Date(payoutTimestamp).toISOString()}`);
      }
      
      // 1. Check ContributionMade events
      const contributionEvents = await client.queryEvents({
        query: { MoveEventType: `${circlePackageId}::njangi_payments::ContributionMade` },
        limit: 100
      });
      
      console.log(`[Contribution Check] Found ${contributionEvents.data.length} ContributionMade events`);
      
      for (const event of contributionEvents.data) {
        if (event.parsedJson && typeof event.parsedJson === 'object') {
          const data = event.parsedJson as {
            circle_id?: string;
            member?: string;
            cycle?: string | number;
          };
          
          const eventCycle = typeof data.cycle === 'string' ? parseInt(data.cycle, 10) : data.cycle;
          const eventTimestamp = Number(event.timestampMs || 0);
          
          // Only count contributions that match the current cycle AND happened after the most recent payout
          if (data.circle_id === circle.id && 
              data.member === userAddress && 
              eventCycle === currentCycle &&
              (!payoutTimestamp || eventTimestamp > payoutTimestamp)) {
            
            hasContributed = true;
            console.log(`[Contribution Check] MATCH: Found ContributionMade for user ${userAddress} in cycle ${currentCycle} after latest payout`);
            break;
          }
        }
      }
      
      // 2. Check StablecoinContributionMade events
      if (!hasContributed) {
        const stablecoinEvents = await client.queryEvents({
          query: { MoveEventType: `${circlePackageId}::njangi_circles::StablecoinContributionMade` },
          limit: 100
        });
        
        console.log(`[Contribution Check] Found ${stablecoinEvents.data.length} StablecoinContributionMade events`);
        
        for (const event of stablecoinEvents.data) {
          if (event.parsedJson && typeof event.parsedJson === 'object') {
            const data = event.parsedJson as {
              circle_id?: string;
              member?: string;
              cycle?: string | number;
            };
            
            const eventCycle = typeof data.cycle === 'string' ? parseInt(data.cycle, 10) : data.cycle;
            const eventTimestamp = Number(event.timestampMs || 0);
            
            // Only count contributions that match the current cycle AND happened after the most recent payout
            if (data.circle_id === circle.id && 
                data.member === userAddress &&
                (!payoutTimestamp || eventTimestamp > payoutTimestamp)) {
                
              // If cycle is specified, check it matches current cycle
              if (eventCycle !== undefined) {
                if (eventCycle === currentCycle) {
                  hasContributed = true;
                  console.log(`[Contribution Check] MATCH: Found StablecoinContributionMade for user ${userAddress} in cycle ${currentCycle} after latest payout`);
                  break;
                }
              } else {
                // If cycle is not specified, assume it's for the current cycle if after payout
                hasContributed = true;
                console.log(`[Contribution Check] MATCH: Found StablecoinContributionMade for user ${userAddress} (cycle not specified) after latest payout`);
                break;
              }
            }
          }
        }
      }
      
      // 3. If not found in other events, try CustodyDeposited events
      if (!hasContributed) {
        const custodyEvents = await client.queryEvents({
          query: { MoveEventType: `${circlePackageId}::njangi_custody::CustodyDeposited` },
          limit: 100
        });
        
        console.log(`[Contribution Check] Found ${custodyEvents.data.length} CustodyDeposited events`);
        
        for (const event of custodyEvents.data) {
          if (event.parsedJson && typeof event.parsedJson === 'object') {
            const data = event.parsedJson as {
              circle_id?: string;
              member?: string;
              operation_type?: number | string;
              timestamp?: string;
            };
            
            const opType = typeof data.operation_type === 'string' 
              ? parseInt(data.operation_type, 10) 
              : data.operation_type;
              
            const eventTimestamp = Number(event.timestampMs || 0);
              
            if (data.circle_id === circle.id && 
                data.member === userAddress && 
                opType === 0 && // 0 = contribution
                (!payoutTimestamp || eventTimestamp > payoutTimestamp)) {
              
              // Check if we can determine which cycle this belongs to
              // For now, assume all contribution operations are for the current cycle
              hasContributed = true;
              console.log(`[Contribution Check] MATCH: Found CustodyDeposited with operation_type=0 for user ${userAddress} after latest payout`);
              break;
            }
          }
        }
      }
      
      // 4. Check CustodyTransaction events (for maximum coverage)
      if (!hasContributed) {
        const txEvents = await client.queryEvents({
          query: { MoveEventType: `${circlePackageId}::njangi_custody::CustodyTransaction` },
          limit: 100
        });
        
        console.log(`[Contribution Check] Found ${txEvents.data.length} CustodyTransaction events`);
        
        for (const event of txEvents.data) {
          if (event.parsedJson && typeof event.parsedJson === 'object') {
            const txData = event.parsedJson as {
              operation_type?: number | string;
              user?: string;
              circle_id?: string;
            };
            
            const opType = typeof txData.operation_type === 'string'
              ? parseInt(txData.operation_type, 10)
              : (typeof txData.operation_type === 'number' ? txData.operation_type : -1); // Default to -1 if undefined
            
            const eventTimestamp = Number(event.timestampMs || 0);
            
            // Check if this is a contribution transaction after the most recent payout
            if (txData.user === userAddress && 
                opType === 0 && 
                (!payoutTimestamp || eventTimestamp > payoutTimestamp)) {
                
              // If circle_id is present, check it matches, otherwise assume it does
              if (txData.circle_id === undefined || txData.circle_id === circle.id) {
                hasContributed = true;
                console.log(`[Contribution Check] MATCH: Found CustodyTransaction with operation_type=0 for user ${userAddress} after latest payout`);
                break;
              }
            }
          }
        }
      }
      
      console.log(`[Contribution Check] Final result for user ${userAddress}: ${hasContributed ? 'HAS contributed' : 'has NOT contributed'}`);
      setUserHasContributed(hasContributed);
      
      // Return the result for immediate use
      return hasContributed;
    } catch (error) {
      console.error("Error checking user contributions:", error);
      return false;
    }
  };

  // Add new function to check if user is the current recipient
  const checkIfUserIsCurrentRecipient = async () => {
    if (!circle || !circle.id || !userAddress || !circle.isActive) {
      setCycleRecipientAddress(null); // Reset if conditions not met
      return false;
    }
    
    // If circle is paused after cycle, there is no current recipient
    if (circle.pausedAfterCycle) {
      console.log(`[Recipient Check] Circle is paused after cycle - no current recipient`);
      setCycleRecipientAddress(null);
      setIsCurrentRecipient(false);
      return false;
    }
    
    console.log(`[Recipient Check] Checking if user ${userAddress} is the current recipient in circle ${circle.id}`);
    
    try {
      const client = new SuiClient({ url: getJsonRpcUrl() });
      const circleObject = await client.getObject({
        id: circle.id,
        options: { showContent: true }
      });
      
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
          setCycleRecipientAddress(recipientAddress); // Set the recipient for the whole cycle
          const isRecipient = recipientAddress === userAddress;
          
          console.log(`[Recipient Check] Recipient address: ${recipientAddress}`);
          console.log(`[Recipient Check] Is user the recipient? ${isRecipient}`);
          
          setIsCurrentRecipient(isRecipient);
          return isRecipient;
        }
      }
      
      setIsCurrentRecipient(false);
      setCycleRecipientAddress(null); // Reset on failure
      return false;
    } catch (error) {
      console.error("Error checking if user is current recipient:", error);
      setIsCurrentRecipient(false);
      setCycleRecipientAddress(null); // Reset on error
      return false;
    }
  };

  // Add a function to check if the user has received a security deposit payout
  const checkSecurityDepositReturned = async () => {
    if (!circle || !circle.id || !userAddress) return false;
    
    try {
      const client = new SuiClient({ url: getJsonRpcUrl() });
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
      console.error(`[SecurityDepositCheck] Error checking security deposit return status:`, error);
      return false;
    }
  };

  // Update useEffect to call the new function
  useEffect(() => {
    if (circle && userAddress && circle.pausedAfterCycle) {
      checkSecurityDepositReturned();
    }
  }, [circle, userAddress]);

  // Modify handleContribute to check if user is the current recipient
  const handleContribute = async () => {
    if (!circle || !userAddress) return;
    
    // Check if the circle is paused after cycle
    if (circle.pausedAfterCycle) {
      toast.error('Contributions are disabled while the cycle is paused. Please wait for the admin to resume the cycle.');
      return;
    }
    
    // Check if user is the current recipient and shouldn't contribute
    if (isCurrentRecipient) {
      toast.error('You are the current recipient for this cycle. You don\'t need to contribute.');
      return;
    }
    
    // Double-check if user has already contributed for this cycle
    const alreadyContributed = await checkUserContribution();
    if (alreadyContributed) {
      toast.error('You have already contributed for this cycle.');
      return;
    }
    
    setIsProcessing(true);
    try {
      if (!userDepositPaid) {
        toast.error('Security deposit required before contributing');
        setIsProcessing(false);
        return;
      }
      
      if (!account) {
        toast.error('User account not available. Please log in again.');
        setIsProcessing(false);
        return;
      }
      
      // Check if walletId is available
      if (!circle.walletId) {
        toast.error('Circle wallet information not available. Please refresh the page and try again.');
        setIsProcessing(false);
        return;
      }
      
      // Check if there's sufficient USDC balance in contribution funds (not security deposits)
      const hasEnoughUSDC = contributionBalance !== null && 
                           contributionBalance >= circle.contributionAmountUsd;

      // Log the contribution source decision with detailed breakdown
      console.log('Contribution source decision:', {
        totalBalance: custodyStablecoinBalance,
        securityDeposits: securityDepositBalance,
        contributionFunds: contributionBalance,
        requiredAmount: circle.contributionAmountUsd,
        hasEnoughUSDC,
        willUseUSDC: hasEnoughUSDC
      });
      
      // Show different toast message based on the source of funds
      if (hasEnoughUSDC) {
        toast.loading('Processing contribution from custody wallet USDC...', { id: 'contribute-tx' });
      } else {
        toast.loading('Processing contribution from SUI...', { id: 'contribute-tx' });
      }
      
      // Execute contribution through the custody wallet
      const result = await fetch('/api/zkLogin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'contributeFromCustody',
          account,
          circleId: circle.id,
          walletId: circle.walletId,
          useUSDC: hasEnoughUSDC // Tell backend to prefer USDC if available
        }),
      });
      
      const responseData = await result.json();
      
      if (!result.ok) {
        console.error('Contribution failed:', responseData);
        toast.error(responseData.error || 'Failed to process contribution', { id: 'contribute-tx' });
        return;
      }
      
      // Show success message based on source of funds
      if (hasEnoughUSDC) {
        toast.success('Contribution successful! Used USDC from custody wallet.', { id: 'contribute-tx' });
      } else {
        toast.success('Contribution successful!', { id: 'contribute-tx' });
      }
      
      console.log('Contribution transaction digest:', responseData.digest);
      
      // Refresh user wallet info, circle data, and custody wallet balance
      fetchUserWalletInfo();
      fetchCircleDetails();
      fetchCustodyWalletBalance();
    } catch (error) {
      console.error('Error contributing:', error);
      toast.error('Failed to process contribution');
    } finally {
      setIsProcessing(false);
    }
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
    
    // Check if wallet balance is sufficient for the total required amount
    if (userBalance !== null && userBalance < requiredAmount) {
      toast.error('Insufficient wallet balance to pay security deposit.');
      return;
    }
    
    setIsPayingDeposit(true);
    
    try {
      console.log('Preparing to pay security deposit:', {
        baseAmount: getSecurityDepositInSui(),
        requiredAmount,
        breakdown: getAmountBreakdown(getSecurityDepositInSui())
      });
      
      if (!account) {
        toast.error('User account not available. Please log in again.');
        setIsPayingDeposit(false);
        return;
      }
      
      toast.loading('Processing security deposit payment...', { id: 'pay-security-deposit' });
      
      // Use the original security deposit amount for the actual transaction
      // as the contract expects the exact amount, buffers are just for checking sufficient balance
      const depositAmount = getSecurityDepositInSui();
      
      // Execute the transaction through the API
      const response = await fetch('/api/zkLogin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'paySecurityDeposit',
          account,
          circleId: circle.id,
          walletId: circle.walletId,
          depositAmount: Math.floor(depositAmount * 1e9)
        }),
      });
      
      const responseData = await response.json();
      
      if (!response.ok) {
        console.error('Security deposit payment failed:', responseData);
        toast.error(responseData.error || 'Failed to process security deposit payment', { id: 'pay-security-deposit' });
      } else {
        toast.success('Security deposit paid successfully!', { id: 'pay-security-deposit' });
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
  const getValidContributionAmount = (): number => {
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
  };

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
    const isPriceStale = priceService.getFetchStatus() === 'error';
    
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
      const client = new SuiClient({ url: getCurrentRpcUrl() });
      const previousBalance = custodyStablecoinBalance;
      let newBalance = null;
      let newSecurityDepositBalance = 0;
      let newContributionBalance = 0;
      
      // First try to get the balance from CoinDeposited events with coin_type "stablecoin"
      const coinDepositedEvents = await client.queryEvents({
        query: {
          MoveEventType: `${circlePackageId}::njangi_custody::CoinDeposited`
        },
        limit: 20
      });
      
      console.log(`[USDC Balance] Found ${coinDepositedEvents.data.length} CoinDeposited events`);
      
      // Find the most recent event for this wallet to get total balance
      for (const event of coinDepositedEvents.data) {
        if (event.parsedJson && 
            typeof event.parsedJson === 'object' &&
            'wallet_id' in event.parsedJson &&
            'coin_type' in event.parsedJson &&
            'new_balance' in event.parsedJson) {
            
          const parsedEvent = event.parsedJson as {
            wallet_id: string;
            coin_type: string;
            new_balance: string;
            amount: string;
          };
          
          console.log(`[USDC Balance] Processing event with coin_type: ${parsedEvent.coin_type}, wallet_id: ${parsedEvent.wallet_id}`);
          
          if (parsedEvent.wallet_id === circle.walletId && 
              parsedEvent.coin_type === 'stablecoin') {
            // Get the total balance from the most recent event
            const balance = Number(parsedEvent.new_balance) / 1e6; // USDC has 6 decimals
            if (newBalance === null || balance > newBalance) {
              newBalance = balance;
              console.log('[USDC Balance Fetch] Found stablecoin balance from CoinDeposited event:', balance);
            }
          }
        }
      }
      
      // Fallback to checking StablecoinDeposited events
      if (newBalance === null) {
        const stablecoinEvents = await client.queryEvents({
        query: {
            MoveEventType: `${circlePackageId}::njangi_circles::StablecoinDeposited`
          },
          limit: 10
        });
        
        // Find the most recent event for this wallet to get total balance
        for (const event of stablecoinEvents.data) {
        if (event.parsedJson && 
            typeof event.parsedJson === 'object' &&
              'wallet_id' in event.parsedJson &&
              'new_balance' in event.parsedJson) {
              
            const eventData = event.parsedJson as {
              circle_id?: string;
              wallet_id?: string;
              member?: string;
              amount?: string;
              new_balance?: string;
              previous_balance?: string;
              coin_type?: string;
            };
            
            if (eventData.wallet_id === circle.walletId) {
              const balanceInMicroUnits = Number(eventData.new_balance);
              const balanceInDollars = balanceInMicroUnits / 1e6; // Convert from micro units to dollars
              newBalance = balanceInDollars;
              console.log('Found stablecoin balance from StablecoinDeposited event:', balanceInDollars, 'USDC');
              break;
            }
          }
        }
      }
      
      // Process CustodyDeposited events to identify security deposits in USDC
      const custodyEvents = await client.queryEvents({
        query: {
          MoveEventType: `${circlePackageId}::njangi_custody::CustodyDeposited`
        },
        limit: 50
      });
      
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
            coin_type?: string; // Add coin_type field
          };
          
          // Skip if this is NOT a stablecoin event
          // If coin_type exists and is 'sui', skip it
          if (parsedEvent.coin_type === 'sui') {
            console.log('Skipping SUI event in stablecoin balance calculation');
            continue;
          }
          
          // Operation type 3 indicates security deposit
          const opType = typeof parsedEvent.operation_type === 'string' ? 
            parseInt(parsedEvent.operation_type) : parsedEvent.operation_type;
            
          if (opType === 3) {
            // This is a security deposit in USDC (we're in the stablecoin balance function)
            const amount = Number(parsedEvent.amount) / 1e6; // Convert from micro units (USDC has 6 decimals)
            newSecurityDepositBalance += amount;
            console.log(`Found security deposit USDC: ${amount}`);
          }
        }
      }
      
      // Ensure security deposit is not larger than the total balance
      if (newBalance !== null) {
        newSecurityDepositBalance = Math.min(newSecurityDepositBalance, newBalance);
      
      // Calculate contribution balance (total minus security deposits)
        newContributionBalance = Math.max(0, newBalance - newSecurityDepositBalance);
      }
      
      // Set the balances if we found any
      if (newBalance !== null) {
        setCustodyStablecoinBalance(newBalance);
      setSecurityDepositBalance(newSecurityDepositBalance);
      setContributionBalance(newContributionBalance);
      
        console.log('[USDC Balance Fetch] Setting USDC state:', { newBalance, newSecurityDepositBalance, newContributionBalance });
        console.log('Custody stablecoin balances breakdown:', {
        total: newBalance,
        securityDeposits: newSecurityDepositBalance,
        contributionFunds: newContributionBalance
      });
      } else {
        // If we couldn't find any balance, default to zero but don't override existing values
              setCustodyStablecoinBalance(0);
              setSecurityDepositBalance(0);
              setContributionBalance(0);
        console.log('No stablecoin balance found, setting to zero');
      }
      
      // Show success message if this was a manual refresh
      if (wasManualRefresh && toastId) {
        if (newBalance !== null) {
          if (previousBalance !== newBalance) {
            toast.success(`Balance updated: $${newBalance.toFixed(2)} USDC`, { id: toastId });
            
            // If there was a security deposit transaction, show a specific message
            if (newSecurityDepositBalance > 0) {
              // Use a new toast ID to avoid conflicting with the first toast
              toast.success(`Security deposit detected: $${newSecurityDepositBalance.toFixed(2)} USDC`, { 
                id: 'security-deposit-toast',
                duration: 5000
              });
            }
          } else {
            toast.success('Balance refreshed', { id: toastId });
          }
        } else {
          toast.success('Balance check completed', { id: toastId });
        }
      }
    } catch (error) {
      console.error('Error fetching custody wallet stablecoin balance:', error);
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
          isSecurityDeposit
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
      
      // Refresh user wallet info, circle data, and custody wallet balance
      fetchUserWalletInfo();
      fetchCircleDetails();
      fetchCustodyWalletBalance();
      
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
  }, [circle, userAddress, currentCycle]);

  // Add this function to handle manual refresh
  const handleRefreshContributionStatus = async () => {
    toast.loading('Refreshing contribution status...', { id: 'refresh-status' });
    try {
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

  // Update the renderContributionOptions function to show a message when user is the current recipient
  const renderContributionOptions = () => {
    return (
      <div className="pt-6 border-t border-gray-200 px-2">
        <div className="flex justify-between items-center mb-4">
            <h3 className="text-lg font-medium text-gray-900 border-l-4 border-blue-500 pl-3">Make Contribution</h3>
           
           {/* Add refresh button */}
           <button
             onClick={handleRefreshContributionStatus}
             className="text-xs bg-blue-50 hover:bg-blue-100 text-blue-600 py-1 px-2 rounded flex items-center transition-colors"
           >
             <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
               <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
             </svg>
             Refresh Status
           </button>
         </div>
        
        {/* Show auto swap enabled notice if applicable */}
        {circle?.autoSwapEnabled && (
          <div className="mb-4 p-3 bg-blue-50 rounded border border-blue-200">
            <p className="text-sm text-blue-700">
              <strong>Auto-swap enabled:</strong> Your SUI contribution will automatically be swapped to USDC.
            </p>
          </div>
        )}

        {/* Add prominent message for cycle paused state */}
        {circle?.pausedAfterCycle && (
          <div className="mb-4 p-4 bg-amber-50 rounded-lg border-2 border-amber-300">
            <div className="flex items-start space-x-3">
              <div className="bg-amber-100 p-1.5 rounded-full flex-shrink-0 mt-0.5">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
              </div>
              <div>
                <h4 className="text-lg font-medium text-amber-800">Cycle Paused</h4>
                <p className="mt-1 text-amber-700">
                  Cycle {currentCycle} has been completed, and the circle is now paused. New contributions are disabled until the admin resumes the circle to start the next cycle.
                </p>
                {!userDepositPaid && !securityDepositReturnedDuringPause && (
                  <p className="mt-2 text-amber-700 font-medium">
                    You can still pay your security deposit while the circle is paused to prepare for the next cycle.
                  </p>
                )}
                {!userDepositPaid && securityDepositReturnedDuringPause && (
                  <p className="mt-2 text-amber-700 font-medium">
                    Your security deposit has been returned. You&apos;ll need to wait for the admin to resume the cycle before paying a new deposit.
                  </p>
                )}
                <p className="mt-2 text-sm text-amber-600">
                  <span className="font-medium">Note:</span> When the admin resumes the circle, all members will need to pay a new security deposit for the next cycle.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Show message if user is current recipient - only show if not paused */}
        {isCurrentRecipient && !circle?.pausedAfterCycle && (
          <div className="mb-4 p-4 bg-green-50 rounded-lg border-2 border-green-200">
            <div className="flex flex-col sm:flex-row items-start space-y-2 sm:space-y-0 sm:space-x-3">
              <div className="bg-green-100 p-1.5 rounded-full flex-shrink-0 self-start">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <div className="flex-1">
                <h4 className="font-medium text-green-800">You are the recipient for this cycle!</h4>
                <p className="text-sm text-green-700 mt-1">
                  You don&apos;t need to make a contribution for the current cycle because you are the member receiving the payout. Enjoy your payout!
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Show message if user has already contributed - only show if not paused */}
        {userHasContributed && !circle?.pausedAfterCycle && (
          <div className="mb-4 p-4 bg-green-50 rounded-lg border-2 border-green-200">
            <div className="flex flex-col sm:flex-row items-start space-y-2 sm:space-y-0 sm:space-x-3">
              <div className="bg-green-100 p-1.5 rounded-full flex-shrink-0 self-start">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <div className="flex-1">
                <h4 className="font-medium text-green-800">You already contributed for this cycle</h4>
                <p className="text-sm text-green-700 mt-1">
                  Your contribution for cycle {currentCycle} has been recorded. You&apos;ll be able to contribute again in the next cycle.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Show direct USDC deposit option if user has sufficient USDC balance and auto-swap is enabled */}
        {showDirectDepositOption && userUsdcBalance !== null && circle?.autoSwapEnabled && (
          <div className="mb-4 p-4 bg-emerald-50 rounded-lg border-2 border-emerald-200">
            <div className="flex flex-col sm:flex-row items-start space-y-2 sm:space-y-0 sm:space-x-3">
              <div className="bg-emerald-100 p-1.5 rounded-full flex-shrink-0 self-start">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <div className="flex-1">
                <h4 className="font-medium text-emerald-800">Use USDC from your wallet</h4>
                <p className="text-sm text-emerald-700 mt-1">
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
                    className="w-full sm:w-auto px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium rounded-md shadow-sm transition-colors disabled:opacity-70 disabled:cursor-not-allowed"
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
                      `Deposit ${formatCurrency((circle?.securityDepositLocal || 0) / 100, circle?.currencyType || 'USD')} as Security Deposit`
                    ) : userHasContributed ? (
                      `Already Contributed`
                    ) : isCurrentRecipient ? (
                      `You Are the Current Recipient`
                    ) : circle?.pausedAfterCycle ? (
                      `Circle is Paused After Cycle`
                    ) : (
                      `Contribute ${formatCurrency((circle?.contributionAmountLocal || 0) / 100, circle?.currencyType || 'USD')} Directly`
                    )}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Show the appropriate form based on auto-swap setting */}
        {circle?.autoSwapEnabled ? (
          <>
            {(!circle.isActive || circle.pausedAfterCycle) && (
              <div className="mb-4 p-3 bg-amber-50 rounded-lg border border-amber-200">
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
          <div className="bg-gray-50 p-6 rounded-lg shadow-sm">
            <div className="mb-6">
              <p className="text-sm text-gray-600 mb-2">You are about to contribute:</p>
              <div className="flex items-center">
                <span className="bg-blue-100 text-blue-800 text-xl font-semibold rounded-lg py-2 px-4">
                  {circle?.contributionAmountLocal ? formatCurrency(circle.contributionAmountLocal / 100, circle.currencyType) : formatCurrency(0, circle?.currencyType || 'USD')} ({getValidContributionAmount().toFixed(4)} SUI)
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
              if (!userDepositPaid || userBalance === null) return null;
              
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
            {userDepositPaid && circle && getValidContributionAmount() > 0 && (
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
              <div className="mb-4 p-4 bg-amber-50 rounded-lg border-2 border-amber-300">
                <div className="flex flex-col gap-4">
                  <div>
                    <p className="text-base font-medium text-amber-700 mb-1">
                      ⚠️ Security deposit required
                    </p>
                    <p className="text-sm text-amber-600">
                      You need to pay a security deposit of{' '}
                      {(!circle || isNaN(circle.securityDepositLocal || 0) || (circle.securityDepositLocal || 0) <= 0) ? (
                        'amount unavailable'
                      ) : (
                        <span className="font-semibold">
                          <CurrencyDisplay localAmount={circle.securityDepositLocal} className="inline" currencyType={circle.currencyType} />
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
                  {userBalance !== null && circle && circle.securityDeposit > 0 && (
                    <div className="bg-blue-50 p-2 rounded border border-blue-100 text-sm">
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
                  {userBalance !== null && circle && userBalance < getRequiredDepositAmount() && (
                    <div className="p-2 bg-red-50 text-red-700 rounded border border-red-200 text-sm">
                      <p className="font-medium">Insufficient funds for security deposit</p>
                      <p className="text-xs mt-1">
                        You need {getRequiredDepositAmount().toFixed(4)} SUI for the security deposit (including slippage & fees), but your balance is only {userBalance.toFixed(4)} SUI.
                      </p>
                    </div>
                  )}
                  
                  <button
                    onClick={handlePaySecurityDeposit}
                    disabled={isPayingDeposit || !circle || (circle.securityDepositUsd || 0) <= 0 || 
                             (userBalance !== null && userBalance < getRequiredDepositAmount()) ||
                             (circle.pausedAfterCycle && securityDepositReturnedDuringPause)}
                    className="w-full py-3 px-4 rounded-lg shadow-sm text-sm font-bold text-white bg-amber-500 hover:bg-amber-600 transition-all disabled:opacity-70 disabled:cursor-not-allowed"
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
                      'Pay Security Deposit'
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
              <div className="mt-3 p-3 bg-red-50 rounded-lg border border-red-200">
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
              <div className="mb-4 p-3 rounded-lg border">
                {userDepositPaid && contributionBalance !== null && circle?.contributionAmountUsd !== undefined && contributionBalance >= circle.contributionAmountUsd ? (
                  <div className="bg-green-50 border-green-200 p-3 rounded-lg flex flex-col sm:flex-row items-start space-y-2 sm:space-y-0 sm:space-x-3">
                    <div className="bg-green-100 rounded-full p-1 self-start">
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-green-600" viewBox="0 0 20 20" fill="currentColor">
                        <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                      </svg>
                    </div>
                    <div>
                      <p className="text-sm font-medium text-green-800">USDC available for contribution</p>
                      <p className="text-xs text-green-700 mt-1">
                        Your contribution will use ${contributionBalance.toFixed(2)} USDC from the contribution funds in the custody wallet.
                        No SUI will be taken from your wallet for this contribution.
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="bg-blue-50 border-blue-200 p-3 rounded-lg flex flex-col sm:flex-row items-start space-y-2 sm:space-y-0 sm:space-x-3">
                    <div className="bg-blue-100 rounded-full p-1 self-start">
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-blue-600" viewBox="0 0 20 20" fill="currentColor">
                        <path fillRule="evenodd" d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4zm2 6a1 1 0 011-1h6a1 1 0 110 2H7a1 1 0 01-1-1zm1 3a1 1 0 100 2h6a1 1 0 100-2H7z" clipRule="evenodd" />
                      </svg>
                    </div>
                    <div>
                      <p className="text-sm font-medium text-blue-800">Using SUI for contribution</p>
                      <p className="text-xs text-blue-700 mt-1">
                        This contribution will require {getValidContributionAmount().toFixed(4)} SUI from your wallet.
                        {contributionBalance !== null && contributionBalance > 0 && (
                          <span> The custody wallet has ${contributionBalance.toFixed(2)} USDC available for contributions, but it&apos;s not enough for this contribution.</span>
                        )}
                      </p>
                    </div>
                  </div>
                )}
              </div>
            )}
          
            <button
              onClick={handleContribute}
              disabled={isProcessing || 
                      (userBalance !== null && userBalance < getRequiredContributionAmount()) || 
                      !userDepositPaid || 
                      (!circle?.isActive && userDepositPaid) ||
                      (circle?.pausedAfterCycle && userDepositPaid) ||
                      userHasContributed ||
                      isCurrentRecipient} // Disable if user is current recipient or circle is paused
              className={`w-full flex justify-center py-3 px-4 rounded-lg shadow-sm text-sm font-medium text-white bg-gradient-to-r from-blue-600 to-blue-700 hover:from-blue-700 hover:to-blue-800 transition-all disabled:opacity-70 disabled:cursor-not-allowed`}
            >
              {isProcessing ? 'Processing...' : 
               isCurrentRecipient ? 'You Are the Current Recipient' : 
               userHasContributed ? 'Already Contributed' : 
               circle?.pausedAfterCycle ? 'Circle is Paused After Cycle' : 
               'Contribute Now'}
            </button>
            
            <p className="mt-3 text-xs text-center text-gray-500">
              By contributing, you agree to the circle&apos;s terms and conditions.
            </p>
            
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
      </div>
    );
  };

  if (!isAuthenticated || !account) {
    return null;
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <main className="max-w-7xl mx-auto py-6 sm:px-6 lg:px-8">
        <div className="px-4 py-6 sm:px-0">
          <div className="mb-6">
            <button
              onClick={() => router.push('/dashboard')}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-white border border-gray-200 hover:bg-gray-50 hover:border-gray-300 transition-all shadow-sm text-sm text-gray-700 font-medium"
            >
              <ArrowLeft className="w-4 h-4" />
              Back to Dashboard
            </button>
          </div>

          <div className="bg-white shadow-md rounded-xl overflow-hidden border border-gray-100">
            <div className="p-6 border-b border-gray-200 bg-gradient-to-r from-blue-50 to-indigo-50">
              <h2 className="text-2xl font-bold text-gray-900 mb-6">
                {!loading && circle ? `Contribute to ${circle.name}` : 'Contribute to Circle'}
              </h2>
              
              {loading ? (
                <div className="py-8 flex justify-center">
                  <svg className="animate-spin h-8 w-8 text-blue-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                </div>
              ) : circle ? (
                <div className="py-4 space-y-8">
                  {/* User Wallet Information */}
                  <div className="px-2">
                    <div className="flex justify-between items-center mb-4">
                      <h3 className="text-lg font-medium text-gray-900 border-l-4 border-green-500 pl-3">Your Wallet</h3>
                      <button
                        onClick={() => fetchUserWalletInfo()}
                        disabled={fetchingBalance}
                        className="text-xs bg-green-50 hover:bg-green-100 text-green-600 py-1 px-2 rounded flex items-center transition-colors disabled:opacity-50"
                      >
                        {fetchingBalance ? (
                          <span className="flex items-center">
                            <svg className="animate-spin -ml-1 mr-1 h-3 w-3 text-green-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                            </svg>
                            Refreshing...
                          </span>
                        ) : (
                          <span className="flex items-center">
                            <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                            </svg>
                            Refresh Balance
                          </span>
                        )}
                      </button>
                    </div>
                    <div className="bg-gradient-to-r from-blue-50 to-indigo-50 p-4 rounded-lg shadow-sm border border-blue-100">
                      <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center space-y-3 sm:space-y-0">
                        <div>
                          <p className="text-sm text-gray-600 mb-1">Available Balance:</p>
                          {fetchingBalance || totalSuiEquivalentDisplay === null ? (
                            <div className="animate-pulse h-6 w-48 bg-gray-200 rounded"></div>
                          ) : (
                            <div className="text-lg font-semibold text-blue-700">
                              {totalSuiEquivalentDisplay !== null ? totalSuiEquivalentDisplay : 'Unable to fetch balance'}
                            </div>
                          )}
                        </div>
                        <div className="sm:text-right">
                          <p className="text-sm text-gray-600 mb-1">Wallet Address:</p>
                          <p className="text-sm font-mono bg-white px-2 py-1 rounded border border-gray-200 break-all sm:break-normal">
                            {userAddress ? `${userAddress.substring(0, 6)}...${userAddress.substring(userAddress.length - 4)}` : ''}
                          </p>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Circle Details */}
                  <div className="px-2">
                    <h3 className="text-lg font-medium text-gray-900 mb-4 border-l-4 border-blue-500 pl-3">Circle Details</h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      <div className="bg-gray-50 p-4 rounded-lg shadow-sm">
                        <p className="text-sm text-gray-500 mb-1">Circle Name</p>
                        <p className="text-lg font-medium">{circle.name}</p>
                      </div>
                      
                      <div className="bg-gray-50 p-4 rounded-lg shadow-sm">
                        <p className="text-sm text-gray-500 mb-1">Contribution Amount</p>
                        <CurrencyDisplay localAmount={circle.contributionAmountLocal} sui={circle.contributionAmount} currencyType={circle.currencyType} />
                      </div>

                      <div className="bg-gray-50 p-4 rounded-lg shadow-sm">
                        <p className="text-sm text-gray-500 mb-1">Security Deposit Required</p>
                        <CurrencyDisplay localAmount={circle.securityDepositLocal} sui={circle.securityDeposit} currencyType={circle.currencyType} />
                      </div>

                      <div className="bg-gray-50 p-4 rounded-lg shadow-sm">
                        <p className="text-sm text-gray-500 mb-1">Security Deposit Status</p>
                        {fetchingBalance ? (
                          <div className="animate-pulse h-6 w-32 bg-gray-200 rounded"></div>
                        ) : (
                          <div className="flex items-center">
                            {userDepositPaid ? (
                              <>
                                <span className="h-4 w-4 rounded-full bg-green-500 mr-2"></span>
                                <span className="text-green-700 font-medium">Paid</span>
                              </>
                            ) : (
                              <>
                                <span className="h-4 w-4 rounded-full bg-amber-500 mr-2"></span>
                                <span className="text-amber-700 font-medium">Not Paid</span>
                              </>
                            )}
                          </div>
                        )}
                      </div>
                      
                      {/* Add Contribution Progress visualization here, above wallet balances */}
                      {circle && circle.isActive && (
                        <div className="bg-gray-50 p-4 rounded-lg shadow-sm md:col-span-2 mb-6">
                          <div className="flex justify-between items-center mb-4">
                            <h3 className="text-lg font-medium text-gray-800 text-center">
                              <div className="flex flex-col sm:flex-row sm:items-center">
                                <span>
                                  {circle?.pausedAfterCycle 
                                    ? `Cycle ${currentCycle} Completed - Pending Next Cycle`
                                    : `Contributions Made Cycle ${currentCycle}`}
                                </span>
                                {totalMembersInRotation && typeof currentPositionInCycle === 'number' && currentPositionInCycle >= 0 && !circle?.pausedAfterCycle && (
                                  <span className="text-sm text-gray-600 mt-1 sm:mt-0 sm:ml-1">
                                    (Position {currentPositionInCycle + 1} of {totalMembersInRotation})
                                  </span>
                                )}
                              </div>
                            </h3>
                            <button
                              onClick={() => {
                                // Refresh cycle data
                                fetchCircleDetails();
                                checkUserContribution();
                                checkIfUserIsCurrentRecipient();
                                // Add toast to show it's refreshing
                                toast.success("Refreshing contribution status...");
                              }}
                              className="text-xs bg-blue-50 hover:bg-blue-100 text-blue-600 py-1 px-2 rounded flex items-center transition-colors"
                            >
                              <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                              </svg>
                              Refresh Status
                            </button>
                          </div>
                          <div className="flex justify-center">
                            <ContributionProgress 
                              circleId={circle.id} 
                              maxMembers={circle.maxMembers || 5} 
                              currentCycle={currentCycle} 
                              currentRecipientAddress={cycleRecipientAddress} // Pass the recipient address
                              isPaused={circle.pausedAfterCycle} // Add isPaused prop
                              circlePackageId={circlePackageId} // Pass the circlePackageId prop
                            />
                          </div>
                        </div>
                      )}
                      
                      {/* Unified Custody Wallet Balance Display */}
                      <div className="bg-gray-50 p-4 rounded-lg shadow-sm md:col-span-2">
                        <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center space-y-2 sm:space-y-0 mb-3">
                          <p className="text-sm font-medium text-gray-700">Custody Wallet Balances</p>
                          <button 
                            onClick={refreshData}
                            disabled={loadingStablecoinBalance || fetchingSuiBalance}
                            className="text-xs bg-indigo-50 hover:bg-indigo-100 text-indigo-600 py-1 px-2 rounded flex items-center justify-center sm:justify-start transition-colors disabled:opacity-50"
                          >
                            {/* Refresh button content (unchanged) */}
                            {loadingStablecoinBalance || fetchingSuiBalance ? (
                              <span className="flex items-center">
                                <svg className="animate-spin -ml-1 mr-1 h-3 w-3 text-indigo-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                                </svg>
                                Refreshing...
                              </span>
                            ) : (
                              <span className="flex items-center">
                                <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                                </svg>
                                Refresh All Balances
                              </span>
                            )}
                          </button>
                        </div>

                        {/* SUI Balance Section */}
                        {(fetchingSuiBalance || custodySuiBalance !== null) && (
                        <div className="mb-4 border-b border-gray-200 pb-4">
                          <p className="text-xs text-gray-500 mb-1 font-medium">SUI</p>
                          {fetchingSuiBalance ? (
                            <div className="animate-pulse h-6 w-32 bg-gray-200 rounded mb-2"></div>
                          ) : (
                            <div className="flex items-center mb-2">
                              <span className="text-lg font-medium text-blue-700">
                                {custodySuiBalance !== null ? `${custodySuiBalance.toFixed(4)} SUI` : "-"}
                              </span>
                              <span className="ml-2 px-2 py-1 bg-gray-100 text-gray-600 text-xs font-medium rounded-full">
                                Total
                              </span>
                            </div>
                          )}
                          {(custodySuiBalance !== null && custodySuiBalance > 0) && (
                            <div className="space-y-1 pl-2">
                              <div className="flex flex-wrap items-center gap-1">
                                <div className="w-3 h-3 bg-amber-300 rounded-sm mr-1"></div>
                                <span className="text-sm text-gray-700">
                                  {suiSecurityDepositBalance !== null ? suiSecurityDepositBalance.toFixed(6) : '0.00'} SUI
                                </span>
                                <span className="px-1.5 py-0.5 bg-amber-100 text-amber-800 text-xs font-medium rounded-full">Security Deposits</span>
                              </div>
                              <div className="flex flex-wrap items-center gap-1">
                                <div className="w-3 h-3 bg-green-300 rounded-sm mr-1"></div>
                                <span className="text-sm text-gray-700">
                                  {suiContributionBalance !== null ? suiContributionBalance.toFixed(6) : '0.00'} SUI
                                </span>
                                <span className="px-1.5 py-0.5 bg-green-100 text-green-800 text-xs font-medium rounded-full">Available for Contributions</span>
                              </div>
                            </div>
                          )}
                        </div>
                        )}

                        {/* USDC Balance Section */}
                        {(loadingStablecoinBalance || custodyStablecoinBalance !== null) && (
                        <div className="mb-2">
                          <p className="text-xs text-gray-500 mb-1 font-medium">USDC</p>
                          {loadingStablecoinBalance ? (
                            <div className="animate-pulse h-6 w-32 bg-gray-200 rounded mb-2"></div>
                          ) : (
                            <div className="flex items-center mb-2">
                              <span className="text-lg font-medium text-indigo-700">
                                {custodyUsdcTotalLocalDisplay !== null ? custodyUsdcTotalLocalDisplay : custodyStablecoinBalance !== null ? `${formatUSD(custodyStablecoinBalance)} USDC` : "-"}
                              </span>
                              <span className="ml-2 px-2 py-1 bg-gray-100 text-gray-600 text-xs font-medium rounded-full">
                                Total
                              </span>
                            </div>
                          )}
                          {(custodyStablecoinBalance !== null && custodyStablecoinBalance > 0) && (
                            <div className="space-y-1 pl-2">
                              <div className="flex flex-wrap items-center gap-1">
                                <div className="w-3 h-3 bg-amber-300 rounded-sm mr-1"></div>
                                <span className="text-sm text-gray-700">
                                  {custodyUsdcSecurityDepositLocalDisplay !== null ? custodyUsdcSecurityDepositLocalDisplay : securityDepositBalance !== null ? `${formatUSD(securityDepositBalance)} USDC` : "-"}
                                </span>
                                <span className="px-1.5 py-0.5 bg-amber-100 text-amber-800 text-xs font-medium rounded-full">Security Deposits</span>
                              </div>
                              <div className="flex flex-wrap items-center gap-1">
                                <div className="w-3 h-3 bg-green-300 rounded-sm mr-1"></div>
                                <span className="text-sm text-gray-700">
                                  {custodyUsdcContributionLocalDisplay !== null ? custodyUsdcContributionLocalDisplay : contributionBalance !== null ? `${formatUSD(contributionBalance)} USDC` : "-"}
                                </span>
                                <span className="px-1.5 py-0.5 bg-green-100 text-green-800 text-xs font-medium rounded-full">Available for Contributions</span>
                              </div>
                            </div>
                          )}
                        </div>
                        )}

                        {/* Message if no balances found */} 
                        {!fetchingSuiBalance && custodySuiBalance === null && !loadingStablecoinBalance && custodyStablecoinBalance === null && (
                          <p className="text-sm text-gray-500 text-center py-4">Could not fetch custody wallet balances.</p>
                        )}
                      </div>
                    </div>
                  </div>
                  
                  {renderContributionOptions()}
                </div>
              ) : (
                <div className="py-8 text-center">
                  <p className="text-gray-500">Circle not found</p>
                </div>
              )}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
} 