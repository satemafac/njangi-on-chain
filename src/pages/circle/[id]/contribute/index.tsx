import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { useAuth } from '../../../../contexts/AuthContext';
import { SuiClient } from '@mysten/sui/client';
import { toast } from 'react-hot-toast';
import { ArrowLeft } from 'lucide-react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { priceService } from '../../../../services/price-service';
import { PACKAGE_ID } from '../../../../services/circle-service';
import SimplifiedSwapUI from '../../../../components/SimplifiedSwapUI';
import { getCoinType } from '../../../../config/constants';

// Add this helper function at the top level
function getJsonRpcUrl(): string {
  return process.env.NEXT_PUBLIC_SUI_RPC_URL || 'https://fullnode.testnet.sui.io:443';
}

// Constants for transaction calculations
const ESTIMATED_GAS_FEE = 0.00021; // Gas fee in SUI
const DEFAULT_SLIPPAGE = 0.5; // Default slippage percentage
const BUFFER_PERCENTAGE = 1.5; // Additional buffer percentage for swap rate fluctuations

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
  contributionAmount: number;
  contributionAmountUsd: number;
  securityDeposit: number;
  securityDepositUsd: number;
  walletId: string; // Custody wallet ID
  autoSwapEnabled?: boolean; // Add this field
  isActive?: boolean; // Add isActive field
  maxMembers?: number; // Add maxMembers field
  nextPayoutTime?: number; // Add nextPayoutTime field
  cycleLength?: number; // Add cycleLength field
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
  contribution_amount_usd: string;
  security_deposit_usd: string;
  max_members: string;
  cycle_length: string;
}

// Define types for SUI object field values
type SuiFieldValue = string | number | boolean | null | undefined | SuiFieldValue[] | Record<string, unknown>;

// Add ContributionProgress component
const ContributionProgress: React.FC<{
  circleId: string;
  maxMembers: number;
  currentCycle: number;
  className?: string;
  currentRecipientAddress?: string | null; // Add to props
}> = ({ circleId, maxMembers, currentCycle, className = '', currentRecipientAddress }) => {
  const [progressData, setProgressData] = useState<ContributionProgressData>({
    totalMembers: maxMembers,
    contributedMembers: new Set<string>(),
    currentCycle: currentCycle,
    memberList: [],
    currentRecipientAddress: currentRecipientAddress, // Initialize from prop
  });
  const [isLoading, setIsLoading] = useState(true);
  
  const fetchTransactionHistory = async () => {
    if (!circleId || currentCycle <= 0) {
      setIsLoading(false);
      return;
    }
    
    setIsLoading(true);
    console.log(`[Progress] Fetching contributions for Cycle ${currentCycle} in circle ${circleId}`);

    try {
      const client = new SuiClient({ url: getJsonRpcUrl() });
      
      // Track unique contributors
      const contributedMembers = new Set<string>();
      const allMembers: string[] = [];
      
      // Try to fetch all members for this circle to get the complete list
      try {
        // Try to get all members associated with this circle
        const circleData = await client.getObject({
          id: circleId,
          options: { showContent: true }
        });
        
        if (circleData.data?.content && 'fields' in circleData.data.content) {
          // Try to extract rotation_order if present
          const circleFields = circleData.data.content.fields as {
            // Replace any[] with string[] for better type safety
            rotation_order?: { fields?: { id?: string } } | string[];
          };
          
          if (circleFields.rotation_order && Array.isArray(circleFields.rotation_order)) {
            // If we have the rotation order, use it (addresses already in the right order)
            for (const memberAddr of circleFields.rotation_order) {
              if (typeof memberAddr === 'string' && memberAddr !== '0x0') {
                allMembers.push(memberAddr);
              }
            }
            console.log(`[Progress] Found ${allMembers.length} members in rotation_order`);
          }
        }
      } catch (error) {
        console.error('Error fetching circle members:', error);
      }
      
      // 1. Try with ContributionMade events (specific event for contributions)
      try {
        const contributionMadeEvents = await client.queryEvents({
          query: { MoveEventType: `${PACKAGE_ID}::njangi_payments::ContributionMade` },
          limit: 200
        });
        
        console.log(`[Progress] Fetched ${contributionMadeEvents.data.length} ContributionMade events`);
        
        for (const event of contributionMadeEvents.data) {
          if (event.parsedJson && typeof event.parsedJson === 'object') {
            const contributionData = event.parsedJson as {
              circle_id?: string;
              member?: string;
              cycle?: string | number;
            };
            
            if (contributionData.circle_id === circleId && 
                contributionData.member &&
                contributionData.cycle !== undefined) {
              
              // Convert cycle to number for comparison
              const eventCycle = typeof contributionData.cycle === 'string'
                ? parseInt(contributionData.cycle, 10)
                : contributionData.cycle;
              
              if (!isNaN(eventCycle) && eventCycle === currentCycle) {
                console.log(`[Progress] Found contribution from ContributionMade for user ${contributionData.member} in cycle ${currentCycle}`);
                contributedMembers.add(contributionData.member);
                
                // Add to all members list if not already there
                if (!allMembers.includes(contributionData.member)) {
                  allMembers.push(contributionData.member);
                }
              }
            }
          }
        }
      } catch (error) {
        console.error('Error fetching ContributionMade events:', error);
      }
      
      // 2. Try CustodyDeposited events (which capture wallet contributions)
      try {
        const custodyDepositedEvents = await client.queryEvents({
          query: { MoveEventType: `${PACKAGE_ID}::njangi_custody::CustodyDeposited` },
          limit: 200
        });
        
        console.log(`[Progress] Fetched ${custodyDepositedEvents.data.length} CustodyDeposited events`);
        
        for (const event of custodyDepositedEvents.data) {
          if (event.parsedJson && typeof event.parsedJson === 'object') {
            const depositData = event.parsedJson as {
              circle_id?: string;
              member?: string;
              operation_type?: number | string;
            };
            
            // Check if this is a contribution event (operation_type=0) for this circle
            const opType = typeof depositData.operation_type === 'string'
              ? parseInt(depositData.operation_type, 10)
              : depositData.operation_type;
            
            if (depositData.circle_id === circleId && 
                depositData.member && 
                opType === 0) { // operation_type 0 = contribution
              
              console.log(`[Progress] Found contribution from CustodyDeposited for user ${depositData.member}`);
              contributedMembers.add(depositData.member);
              
              // Add to all members list if not already there
              if (!allMembers.includes(depositData.member)) {
                allMembers.push(depositData.member);
              }
            }
          }
        }
      } catch (error) {
        console.error('Error fetching CustodyDeposited events:', error);
      }
      
      // 3. Also try regular CustodyTransaction events as fallback
      try {
        const txEvents = await client.queryEvents({
          query: { MoveEventType: `${PACKAGE_ID}::njangi_custody::CustodyTransaction` },
          limit: 200
        });
        
        console.log(`[Progress] Fetched ${txEvents.data.length} CustodyTransaction events`);
        
        for (const event of txEvents.data) {
          if (event.parsedJson && typeof event.parsedJson === 'object') {
            // Check directly in parsedJson - the txData seems to be directly here
            const txData = event.parsedJson as {
              operation_type?: number | string;
              user?: string;
              circle_id?: string;
            };
            
            // For these events, we need to check the operation_type and ensure it belongs to this circle
            const opType = typeof txData.operation_type === 'string'
              ? parseInt(txData.operation_type, 10)
              : txData.operation_type;
            
            // Debug to see what values we're finding
            if (opType === 0) {
              console.log(`[Progress] Found CustodyTransaction with operation_type=0:`, {
                user: txData.user,
                circleId: txData.circle_id ? txData.circle_id : 'not present'
              });
            }
            
            if (txData.user && opType === 0) {
              // If circle_id is present, check it matches
              if (txData.circle_id && txData.circle_id !== circleId) {
                continue; // Skip if this belongs to a different circle
              }
              
              // If we got here, count it as a contribution
              console.log(`[Progress] Found contribution from CustodyTransaction for user ${txData.user}`);
              contributedMembers.add(txData.user);
              
              // Add to all members list if not already there
              if (!allMembers.includes(txData.user)) {
                allMembers.push(txData.user);
              }
            }
          }
        }
      } catch (error) {
        console.error('Error fetching CustodyTransaction events:', error);
      }
      
      // 4. Try StablecoinContributionMade events
      try {
        const stablecoinEvents = await client.queryEvents({
          query: { MoveEventType: `${PACKAGE_ID}::njangi_circles::StablecoinContributionMade` },
          limit: 100
        });
        
        console.log(`[Progress] Fetched ${stablecoinEvents.data.length} StablecoinContributionMade events`);
        
        for (const event of stablecoinEvents.data) {
          if (event.parsedJson && typeof event.parsedJson === 'object') {
            const stablecoinData = event.parsedJson as {
              circle_id?: string;
              member?: string;
              cycle?: string | number;
            };
            
            if (stablecoinData.circle_id === circleId && stablecoinData.member) {
              if (stablecoinData.cycle !== undefined) {
                const eventCycle = typeof stablecoinData.cycle === 'string'
                  ? parseInt(stablecoinData.cycle, 10)
                  : stablecoinData.cycle;
                
                if (!isNaN(eventCycle) && eventCycle === currentCycle) {
                  console.log(`[Progress] Found contribution from StablecoinContributionMade for user ${stablecoinData.member}`);
                  contributedMembers.add(stablecoinData.member);
                  
                  // Add to all members list if not already there
                  if (!allMembers.includes(stablecoinData.member)) {
                    allMembers.push(stablecoinData.member);
                  }
                }
              } else {
                // If cycle not specified, assume it's for the current cycle
                contributedMembers.add(stablecoinData.member);
                
                // Add to all members list if not already there
                if (!allMembers.includes(stablecoinData.member)) {
                  allMembers.push(stablecoinData.member);
                }
              }
            }
          }
        }
      } catch (error) {
        console.error('Error fetching StablecoinContributionMade events:', error);
      }
      
      // If we don't have enough members, fill in with placeholder addresses up to maxMembers
      while (allMembers.length < maxMembers) {
        allMembers.push(`Member-${allMembers.length + 1}`);
      }
      
      // If we have too many members, trim the list
      if (allMembers.length > maxMembers) {
        allMembers.splice(maxMembers);
      }
      
      console.log(`[Progress] Total unique contributors: ${contributedMembers.size}/${maxMembers}`);
      console.log(`[Progress] Contributors:`, Array.from(contributedMembers));
      console.log(`[Progress] All members:`, allMembers);

      // Sort members: Contributors first, then non-contributors
      const sortedMemberList = [
        ...allMembers.filter(member => contributedMembers.has(member)),
        ...allMembers.filter(member => !contributedMembers.has(member))
      ];
      console.log(`[Progress] Sorted members:`, sortedMemberList);

      setProgressData({
        totalMembers: maxMembers,
        contributedMembers,
        currentCycle,
        memberList: sortedMemberList, // Use the sorted list
        currentRecipientAddress: currentRecipientAddress, // Ensure it's set here
      });
    } catch (error) {
      console.error('Error fetching contribution events:', error);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (circleId && maxMembers > 0 && currentCycle > 0) {
      console.log("[Progress] Required data available, fetching contribution events...");
      fetchTransactionHistory();
    } else {
      console.log("[Progress] Waiting for required data:", { circleId, maxMembers, currentCycle });
    }
  // Add currentRecipientAddress to dependency array if it can change and trigger re-fetch
  }, [circleId, maxMembers, currentCycle, currentRecipientAddress]);

  // Calculate progress percentage
  const contributedCount = progressData.contributedMembers.size;
  const expectedContributors = progressData.currentRecipientAddress ? Math.max(0, progressData.totalMembers - 1) : progressData.totalMembers;
  
  const progressPercentage = expectedContributors > 0 
    ? (contributedCount / expectedContributors) * 100 
    : 0;
  
  // Determine status color based on progress
  const getStatusColor = () => {
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
            stroke={progressPercentage === 100 ? '#10B981' : '#3B82F6'}
            strokeWidth="8"
            strokeDasharray={`${progressPercentage * 2.83} 283`}
            strokeDashoffset="0"
            transform="rotate(-90 50 50)"
            strokeLinecap="round"
            className="transition-all duration-500 ease-in-out"
          />
          
          {/* Center text */}
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
        </svg>
        
        {/* Member sectors around the circle */}
        {(() => {
          // Filter out the recipient for dot visualization around the circle
          const membersForDots = progressData.currentRecipientAddress
            ? progressData.memberList.filter(member => member !== progressData.currentRecipientAddress)
            : progressData.memberList;
          const numDots = membersForDots.length;

          return membersForDots.map((memberAddr, index) => {
            const angle = numDots > 0 ? (index / numDots) * Math.PI * 2 - Math.PI / 2 : 0;
            const x = 50 + 55 * Math.cos(angle);
            const y = 50 + 55 * Math.sin(angle);
            const hasContributed = progressData.contributedMembers.has(memberAddr);
            // Recipient is filtered out, so dotColor is simpler
            const dotColor = hasContributed ? 'bg-green-500' : 'bg-gray-300';
            
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
                    {hasContributed ? ' ✓' : ' ✘'} {/* Recipient is not in this list */}
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
          Cycle {progressData.currentCycle} Contributions
        </p>
      </div>
      
      {/* Add legend to identify members */}
      <div className="mt-3 grid grid-cols-1 gap-2 text-xs w-full max-w-xs">
        {progressData.memberList.map((memberAddr, index) => {
          const hasContributed = progressData.contributedMembers.has(memberAddr);
          const isRecipient = memberAddr === progressData.currentRecipientAddress;
          
          let statusText = 'Pending';
          let statusColorClass = 'text-gray-500';
          let dotColorClass = 'bg-gray-300';

          if (isRecipient) {
            statusText = 'Receiving Payout';
            statusColorClass = 'text-blue-600 font-medium';
            dotColorClass = 'bg-blue-500';
          } else if (hasContributed) {
            statusText = 'Contributed';
            statusColorClass = 'text-green-600 font-medium';
            dotColorClass = 'bg-green-500';
          }

          return (
            <div key={index} className="flex items-center justify-between">
              <div className="flex items-center">
                <div className={`w-3 h-3 mr-2 rounded-full ${dotColorClass}`}></div>
                <span className="font-mono">{formatAddress(memberAddr)}</span>
              </div>
              <span className={statusColorClass}>
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

  // Fix type assertion issues in the function
  const fetchCustodyWalletSuiBalance = async () => {
    if (!circle?.walletId) return;
    
    setFetchingSuiBalance(true);
    try {
      const client = new SuiClient({ url: 'https://fullnode.testnet.sui.io:443' });
      
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
        query: { MoveEventType: `${PACKAGE_ID}::njangi_custody::CustodyDeposited` },
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
    if (!id) return;
    console.log('Contribute - Fetching circle details for:', id);
    
    setLoading(true);
    try {
      const client = new SuiClient({ url: 'https://fullnode.testnet.sui.io:443' });
      
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
      
      // Read current_cycle from the circle object
      let cycleNumber = 1; // Default to 1
      if ('current_cycle' in fields && typeof fields.current_cycle === 'string') {
        cycleNumber = parseInt(fields.current_cycle, 10);
        console.log('Contribute - Found current_cycle field:', cycleNumber);
      }
      setCurrentCycle(cycleNumber);
      
      // Get max_members from the circle object or dynamic fields
      let maxMembers = 10; // Default value
      
      // If is_active is not in the direct fields, also try to check activation events
      if (!isActive) {
        try {
          const activationEvents = await client.queryEvents({
            query: { MoveEventType: `${PACKAGE_ID}::njangi_circles::CircleActivated` },
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
          query: { MoveEventType: `${PACKAGE_ID}::njangi_circles::CircleCreated` },
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
          
          // Extract max_members from the creation event
          if (circleCreationEventData.max_members) {
            maxMembers = parseInt(circleCreationEventData.max_members, 10);
            console.log('Contribute - Found max_members from creation event:', maxMembers);
          }
        }

        // 2. Fetch Transaction Block for inputs (like cycle_day, potentially others)
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
            if (inputs.length > 2 && inputs[2]?.type === 'pure') transactionInput.contribution_amount_usd = inputs[2].value;
            if (inputs.length > 4 && inputs[4]?.type === 'pure') transactionInput.security_deposit_usd = inputs[4].value;
            // Add any other inputs you stored this way
          }
        }
        
        // 3. Fetch CustodyWalletCreated event for walletId
        const custodyEvents = await client.queryEvents({
          query: { MoveEventType: `${PACKAGE_ID}::njangi_custody::CustodyWalletCreated` },
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
        }

      } catch (error) {
        console.error('Contribute - Error fetching event/transaction data:', error);
        // Continue even if this fails, rely on other data sources
        }

      // --- Process Extracted Data (Prioritize sources) ---
      const configValues = {
        contributionAmount: 0,
        contributionAmountUsd: 0,
        securityDeposit: 0, // SUI amount
        securityDepositUsd: 0,
        autoSwapEnabled: false,
      };

      // 1. Use values from transaction/event first
      if (transactionInput) {
        if (transactionInput.contribution_amount) configValues.contributionAmount = Number(transactionInput.contribution_amount) / 1e9;
        if (transactionInput.contribution_amount_usd) configValues.contributionAmountUsd = Number(transactionInput.contribution_amount_usd) / 100;
        if (transactionInput.security_deposit_usd) configValues.securityDepositUsd = Number(transactionInput.security_deposit_usd) / 100;
      }
      // Note: CircleCreatedEvent doesn't hold SUI amounts directly, rely on other sources or calculation
      console.log('Contribute - Config after Tx/Event:', configValues);

      // 2. Look for config in dynamic fields
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

                    // Override with values from the config object
                    if (configFields.contribution_amount) configValues.contributionAmount = Number(configFields.contribution_amount) / 1e9;
                    if (configFields.contribution_amount_usd) configValues.contributionAmountUsd = Number(configFields.contribution_amount_usd) / 100;
                    if (configFields.security_deposit) configValues.securityDeposit = Number(configFields.security_deposit) / 1e9;
                    if (configFields.security_deposit_usd) configValues.securityDepositUsd = Number(configFields.security_deposit_usd) / 100;
                    if (configFields.auto_swap_enabled !== undefined) {
                        const dynamicValue = Boolean(configFields.auto_swap_enabled);
                        console.log(`Contribute - Found auto_swap_enabled (${dynamicValue}) in dynamic field ${field.objectId}`);
                        configValues.autoSwapEnabled = dynamicValue;
                    }
                    // Get max_members from config if available
                    if (configFields.max_members) {
                        maxMembers = Number(configFields.max_members);
                        console.log(`Contribute - Found max_members (${maxMembers}) in config field`);
                    }
                    // Add other config fields if needed
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
            break; // Assuming only one config object
          }
        }
      }
      console.log('Contribute - Config after Dynamic Fields:', configValues);

      // 3. Use direct fields from the circle object as a fallback
      // Only update if the value hasn't been set yet (is 0 or false)
      if (configValues.contributionAmount === 0 && fields.contribution_amount) configValues.contributionAmount = Number(fields.contribution_amount) / 1e9;
      if (configValues.contributionAmountUsd === 0) {
          if (fields.contribution_amount_usd) {
              configValues.contributionAmountUsd = Number(fields.contribution_amount_usd) / 100;
          } else if (fields.usd_amounts && typeof fields.usd_amounts === 'object' && fields.usd_amounts !== null) {
              // Refined type assertion for usd_amounts
              const usdData = fields.usd_amounts as {
                 fields?: { contribution_amount?: string; security_deposit?: string };
                 contribution_amount?: string;
                 security_deposit?: string;
              };
              const usdFields = usdData.fields || usdData;
              if (usdFields?.contribution_amount) {
                  configValues.contributionAmountUsd = Number(usdFields.contribution_amount) / 100;
        }
          }
      }
      if (configValues.securityDeposit === 0 && fields.security_deposit) configValues.securityDeposit = Number(fields.security_deposit) / 1e9;
      if (configValues.securityDepositUsd === 0) {
          if (fields.security_deposit_usd) {
              configValues.securityDepositUsd = Number(fields.security_deposit_usd) / 100;
          } else if (fields.usd_amounts && typeof fields.usd_amounts === 'object' && fields.usd_amounts !== null) {
              // Refined type assertion for usd_amounts
              const usdData = fields.usd_amounts as {
                 fields?: { contribution_amount?: string; security_deposit?: string };
                 contribution_amount?: string;
                 security_deposit?: string;
              };
              const usdFields = usdData.fields || usdData;
              if (usdFields?.security_deposit) {
                  configValues.securityDepositUsd = Number(usdFields.security_deposit) / 100;
              }
          }
      }
      console.log('Contribute - Config after Direct Fields Fallback:', configValues);
      
      // 4. Calculate SUI amounts from USD if SUI amount is still zero (and price is available)
      if (configValues.contributionAmount === 0 && configValues.contributionAmountUsd > 0 && suiPrice > 0) {
          configValues.contributionAmount = configValues.contributionAmountUsd / suiPrice;
          console.log(`Contribute - Calculated contribution SUI from USD: ${configValues.contributionAmount}`);
      }
      if (configValues.securityDeposit === 0 && configValues.securityDepositUsd > 0 && suiPrice > 0) {
          configValues.securityDeposit = configValues.securityDepositUsd / suiPrice;
          console.log(`Contribute - Calculated security deposit SUI from USD: ${configValues.securityDeposit}`);
      }

      // Ensure walletId is set, even if event fetch failed, try direct field (less reliable)
      if (!walletId && typeof fields.wallet_id === 'string') {
          walletId = fields.wallet_id;
          console.log('Contribute - Using wallet ID from direct field:', walletId);
      }
        
      // Set the final circle state
      setCircle({
        id: id as string,
        name: typeof fields.name === 'string' ? fields.name : '',
        admin: typeof fields.admin === 'string' ? fields.admin : '',
        contributionAmount: configValues.contributionAmount,
        contributionAmountUsd: configValues.contributionAmountUsd,
        securityDeposit: configValues.securityDeposit,
        securityDepositUsd: configValues.securityDepositUsd,
        walletId: walletId, // Use the reliably fetched walletId
        autoSwapEnabled: configValues.autoSwapEnabled,
        isActive: isActive, // Use our correctly determined isActive value
        maxMembers: maxMembers, // Add max members to circle object
        // Remove nextPayoutTime and cycleLength if only used for progress component
        // nextPayoutTime: nextPayoutTime,
        // cycleLength: cycleLength 
      });

      console.log('Contribute - Final circle state:', {
        id,
        name: typeof fields.name === 'string' ? fields.name : '',
        admin: typeof fields.admin === 'string' ? fields.admin : '',
        contributionAmount: configValues.contributionAmount,
        contributionAmountUsd: configValues.contributionAmountUsd,
        securityDeposit: configValues.securityDeposit,
        securityDepositUsd: configValues.securityDepositUsd,
        walletId,
        autoSwapEnabled: configValues.autoSwapEnabled,
        isActive,
        maxMembers,
        // Remove from log if removed from state
        // nextPayoutTime,
        // cycleLength
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
      console.log('Skipping fetchUserWalletInfo: Missing userAddress or circle info.');
      return;
    }
    
    setFetchingBalance(true);
    let depositPaid = false; // Default to false
    
    try {
      const client = new SuiClient({ url: getJsonRpcUrl() }); // Use helper function for URL
      
      // --- Get SUI Balance (Remains the same) ---
      const coins = await client.getCoins({ owner: userAddress, coinType: '0x2::sui::SUI' });
      const totalBalance = coins.data.reduce((sum, coin) => sum + Number(coin.balance), 0) / 1e9;
      setUserBalance(totalBalance);

      // --- Get USDC Balance (Remains the same) ---
      try {
        const usdcCoins = await client.getCoins({ owner: userAddress, coinType: USDC_COIN_TYPE });
        const totalUsdcBalance = usdcCoins.data.reduce((sum, coin) => sum + Number(coin.balance), 0) / 1e6;
        setUserUsdcBalance(totalUsdcBalance);

        // --- Updated logic for showing direct deposit option --- 
        let showOption = false;
        const hasEnoughForSecurity = totalUsdcBalance >= circle.securityDepositUsd;
        const hasEnoughForContribution = totalUsdcBalance >= circle.contributionAmountUsd;
        const autoSwapOn = Boolean(circle.autoSwapEnabled);
        const circleActive = Boolean(circle.isActive);

        // Log intermediate values for debugging
        console.log('[Direct Deposit Check]', {
            userDepositPaid, // Use the state variable directly
            hasEnoughForSecurity,
            hasEnoughForContribution,
            autoSwapOn,
            circleActive,
            securityDepositUsd: circle.securityDepositUsd,
            contributionAmountUsd: circle.contributionAmountUsd,
            totalUsdcBalance
        });

        // Condition 1: Paying Security Deposit (userDepositPaid state is false)
        if (!userDepositPaid && hasEnoughForSecurity && autoSwapOn) {
          showOption = true;
          console.log("Showing direct deposit for SECURITY DEPOSIT (Circle active status ignored)");
        }
        // Condition 2: Making Regular Contribution (userDepositPaid state is true)
        else if (userDepositPaid && hasEnoughForContribution && autoSwapOn && circleActive) {
           showOption = true;
           console.log("Showing direct deposit for CONTRIBUTION (Circle must be active)");
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
            query: { MoveEventType: `${PACKAGE_ID}::njangi_members::MemberActivated` }, 
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
          query: { MoveEventType: `${PACKAGE_ID}::njangi_custody::CustodyDeposited` }, limit: 50
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
    
    console.log(`[Contribution Check] Starting check for user ${userAddress} in circle ${circle.id} for cycle ${currentCycle}`);
    
    try {
      const client = new SuiClient({ url: getJsonRpcUrl() });
      let hasContributed = false;
      
      // 1. Check ContributionMade events
      const contributionEvents = await client.queryEvents({
        query: { MoveEventType: `${PACKAGE_ID}::njangi_payments::ContributionMade` },
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
          
          if (data.circle_id === circle.id && 
              data.member === userAddress && 
              eventCycle === currentCycle) {
            hasContributed = true;
            console.log(`[Contribution Check] MATCH: Found ContributionMade for user ${userAddress} in cycle ${currentCycle}`);
            break;
          }
        }
      }
      
      // 2. Check StablecoinContributionMade events
      if (!hasContributed) {
        const stablecoinEvents = await client.queryEvents({
          query: { MoveEventType: `${PACKAGE_ID}::njangi_circles::StablecoinContributionMade` },
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
            
            if (data.circle_id === circle.id && 
                data.member === userAddress) {
              // If cycle is specified, check it matches current cycle
              if (eventCycle !== undefined) {
                if (eventCycle === currentCycle) {
                  hasContributed = true;
                  console.log(`[Contribution Check] MATCH: Found StablecoinContributionMade for user ${userAddress} in cycle ${currentCycle}`);
                  break;
                }
              } else {
                // If cycle is not specified, assume it's for the current cycle
                hasContributed = true;
                console.log(`[Contribution Check] MATCH: Found StablecoinContributionMade for user ${userAddress} (cycle not specified)`);
                break;
              }
            }
          }
        }
      }
      
      // 3. If not found in other events, try CustodyDeposited events
      if (!hasContributed) {
        const custodyEvents = await client.queryEvents({
          query: { MoveEventType: `${PACKAGE_ID}::njangi_custody::CustodyDeposited` },
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
              
            if (data.circle_id === circle.id && 
                data.member === userAddress && 
                opType === 0) { // 0 = contribution
              
              // Check if we can determine which cycle this belongs to
              // For now, assume all contribution operations are for the current cycle
              hasContributed = true;
              console.log(`[Contribution Check] MATCH: Found CustodyDeposited with operation_type=0 for user ${userAddress}`);
              break;
            }
          }
        }
      }
      
      // 4. Check CustodyTransaction events (for maximum coverage)
      if (!hasContributed) {
        const txEvents = await client.queryEvents({
          query: { MoveEventType: `${PACKAGE_ID}::njangi_custody::CustodyTransaction` },
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
              : txData.operation_type;
            
            // Check if this is a contribution transaction
            if (txData.user === userAddress && opType === 0) {
              // If circle_id is present, check it matches, otherwise assume it does
              if (txData.circle_id === undefined || txData.circle_id === circle.id) {
                hasContributed = true;
                console.log(`[Contribution Check] MATCH: Found CustodyTransaction with operation_type=0 for user ${userAddress}`);
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
    
    console.log(`[Recipient Check] Checking if user ${userAddress} is the current recipient in circle ${circle.id}`);
    
    try {
      const client = new SuiClient({ url: getJsonRpcUrl() });
      const circleObject = await client.getObject({
        id: circle.id,
        options: { showContent: true }
      });
      
      if (circleObject.data?.content && 'fields' in circleObject.data.content) {
        const circleFields = circleObject.data.content.fields as Record<string, unknown>;
        const currentPosition = Number(circleFields.current_position || 0);
        const rotationOrder = circleFields.rotation_order as string[];
        
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

  // Modify handleContribute to check if user is the current recipient
  const handleContribute = async () => {
    if (!circle || !userAddress) return;
    
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

  // Add a helper function to calculate live security deposit amount in SUI
  const getSecurityDepositInSui = (): number => {
    if (!circle || !circle.securityDepositUsd || typeof suiPrice !== 'number' || suiPrice <= 0) {
      return circle?.securityDeposit || 0;
    }
    
    // Calculate based on the latest SUI price
    return circle.securityDepositUsd / suiPrice;
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

  const handlePaySecurityDeposit = async () => {
    if (!circle || !userAddress || !circle.walletId) {
      toast.error('Circle information incomplete. Cannot process deposit.');
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

  // Helper function to format USD amounts
  const formatUSD = (amount: number): string => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(amount);
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
  const CurrencyDisplay = ({ usd, sui, className = '' }: { usd?: number, sui?: number, className?: string }) => {
    const isPriceUnavailable = suiPrice === null;
    const isPriceStale = priceService.getFetchStatus() === 'error';
    
    console.log('CurrencyDisplay inputs:', { usd, sui, suiPrice, isPriceUnavailable });
    
    // Check for invalid inputs and provide defaults
    if ((usd === undefined || isNaN(usd)) && (sui === undefined || isNaN(sui))) {
      console.log('CurrencyDisplay: both usd and sui values are invalid, defaulting to 0');
      usd = 0;
      sui = 0;
    }
    
    // Calculate values based on which parameter is provided
    let calculatedSui: number | null = null;
    let calculatedUsd: number | null = null;
    
    if (usd !== undefined && !isNaN(usd)) {
      // If USD is provided and valid, calculate SUI based on current price
      calculatedUsd = usd;
      calculatedSui = suiPrice !== null && suiPrice > 0 ? usd / suiPrice : null;
      console.log('CurrencyDisplay: using USD value to calculate SUI:', { 
        usd: calculatedUsd, 
        sui: calculatedSui,
        suiPrice 
      });
    } else if (sui !== undefined && !isNaN(sui)) {
      // If SUI is provided and valid, calculate USD
      calculatedSui = sui;
      calculatedUsd = suiPrice !== null ? sui * suiPrice : null;
      console.log('CurrencyDisplay: using SUI value to calculate SUI:', { 
        sui: calculatedSui, 
        usd: calculatedUsd,
        suiPrice 
      });
    } else {
      // Default values if neither is provided or values are invalid
      calculatedSui = 0;
      calculatedUsd = 0;
      console.log('CurrencyDisplay: using default values:', { 
        sui: calculatedSui, 
        usd: calculatedUsd 
      });
    }
    
    // Format SUI with appropriate precision if available
    const formattedSui = calculatedSui !== null ? (
      calculatedSui >= 1000 
        ? calculatedSui.toLocaleString(undefined, { maximumFractionDigits: 0 }) 
        : calculatedSui >= 100 
          ? calculatedSui.toFixed(1) 
          : calculatedSui.toFixed(2)
    ) : '—';
    
    // Check if the component is being used inline
    const isInline = className.includes('inline');
    
    if (isInline) {
      return (
        <span className={className}>
          {calculatedUsd !== null ? formatUSD(calculatedUsd) : '$—.—'} ({formattedSui} SUI)
          {isPriceStale && <span title="Using cached price" className="text-xs text-amber-500 ml-1">⚠️</span>}
        </span>
      );
    }
    
    return (
      <Tooltip.Provider>
        <Tooltip.Root>
          <Tooltip.Trigger asChild>
            <div className={`flex flex-col ${className} cursor-help`}>
              <span className="font-medium">{calculatedUsd !== null ? formatUSD(calculatedUsd) : '$—.—'}</span>
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
                <p className="text-xs text-gray-400">
                  {isPriceStale 
                    ? "Using cached price - service temporarily unavailable" 
                    : "Updated price data from CoinGecko"}
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
      const client = new SuiClient({ url: 'https://fullnode.testnet.sui.io:443' });
      const previousBalance = custodyStablecoinBalance;
      let newBalance = null;
      let newSecurityDepositBalance = 0;
      let newContributionBalance = 0;
      
      // First try to get the balance from CoinDeposited events with coin_type "stablecoin"
      const coinDepositedEvents = await client.queryEvents({
        query: {
          MoveEventType: `${PACKAGE_ID}::njangi_custody::CoinDeposited`
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
            MoveEventType: `${PACKAGE_ID}::njangi_circles::StablecoinDeposited`
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
          MoveEventType: `${PACKAGE_ID}::njangi_custody::CustodyDeposited`
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
    
    // Check if user is current recipient
    if (isCurrentRecipient) {
      toast.error('You are the current recipient for this cycle. You don&apos;t need to contribute.');
      return;
    }
    
    // Double-check if user has already contributed for this cycle
    const alreadyContributed = await checkUserContribution();
    if (alreadyContributed) {
      toast.error('You have already contributed for this cycle.');
      return;
    }
    
    setDirectDepositProcessing(true);
    
    try {
      const toastId = toast.loading('Processing direct USDC deposit...');
      
      // Determine amount and type based on whether security deposit is already paid
      const isSecurityDeposit = !userDepositPaid;
      const requiredAmount = isSecurityDeposit ? circle.securityDepositUsd : circle.contributionAmountUsd;
      
      if (userUsdcBalance < requiredAmount) {
        toast.error(`Insufficient USDC balance. Need ${requiredAmount.toFixed(2)} USDC but you have ${userUsdcBalance.toFixed(2)} USDC.`, { id: toastId });
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
        usdcAmount: requiredAmount,
        isSecurityDeposit
      });
      
      // Call API to transfer USDC directly
      const response = await fetch('/api/zkLogin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'depositUsdcDirect',
          account,
          circleId: circle.id,
          walletId: circle.walletId,
          usdcAmount: Math.floor(requiredAmount * 1e6), // Convert to micro USDC (6 decimals)
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

  // Modify the renderContributionOptions function to show a message when user is the current recipient
  const renderContributionOptions = () => {
    return (
      <div className="pt-6 border-t border-gray-200 px-2">
        <h3 className="text-lg font-medium text-gray-900 mb-4 border-l-4 border-blue-500 pl-3">Make Contribution</h3>
        
        {/* Show auto swap enabled notice if applicable */}
        {circle?.autoSwapEnabled && (
          <div className="mb-4 p-3 bg-blue-50 rounded border border-blue-200">
            <p className="text-sm text-blue-700">
              <strong>Auto-swap enabled:</strong> Your SUI contribution will automatically be swapped to USDC.
            </p>
          </div>
        )}

        {/* Show message if user is current recipient */}
        {isCurrentRecipient && (
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

        {/* Show message if user has already contributed */}
        {userHasContributed && (
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
                  You have <span className="font-medium">${userUsdcBalance.toFixed(2)} USDC</span> in your wallet.
                  You can directly deposit {!userDepositPaid ? 'security deposit' : 'contribution'} without swapping SUI.
                </p>
                <div className="mt-3">
                  <button
                    onClick={handleDirectUsdcDeposit}
                    disabled={directDepositProcessing || 
                            (userDepositPaid && !circle?.isActive) || 
                            userHasContributed ||
                            isCurrentRecipient}
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
                      `Deposit ${circle?.securityDepositUsd?.toFixed(2)} USDC as Security Deposit`
                    ) : userHasContributed ? (
                      `Already Contributed`
                    ) : isCurrentRecipient ? (
                      `You Are the Current Recipient`
                    ) : (
                      `Contribute ${circle?.contributionAmountUsd?.toFixed(2)} USDC Directly`
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
            {!circle.isActive && (
              <div className="mb-4 p-3 bg-amber-50 rounded-lg border border-amber-200">
                <p className="text-sm text-amber-700 font-medium">
                  This circle is not active yet
                </p>
                <p className="text-xs text-amber-600 mt-1">
                  {!userDepositPaid 
                    ? "Security deposits can still be paid before activation."
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
              disabled={userDepositPaid && (!circle?.isActive || userHasContributed || isCurrentRecipient)}
            />
          </>
        ) : (
          <div className="bg-gray-50 p-6 rounded-lg shadow-sm">
            <div className="mb-6">
              <p className="text-sm text-gray-600 mb-2">You are about to contribute:</p>
              <div className="flex items-center">
                <span className="bg-blue-100 text-blue-800 text-xl font-semibold rounded-lg py-2 px-4">
                  ${circle?.contributionAmountUsd?.toFixed(2) || '0.00'} ({getValidContributionAmount().toFixed(4)} SUI)
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
                      {(!circle || isNaN(circle.securityDeposit) || circle.securityDeposit <= 0) ? (
                        'amount unavailable'
                      ) : (
                        <span className="font-semibold">
                          <CurrencyDisplay usd={circle.securityDepositUsd} className="inline" />
                        </span>
                      )}{' '}
                      before contributing.
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
                    disabled={isPayingDeposit || !circle || circle.securityDepositUsd <= 0 || (userBalance !== null && userBalance < getRequiredDepositAmount())}
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
                      userHasContributed ||
                      isCurrentRecipient} // Disable if user is current recipient
              className={`w-full flex justify-center py-3 px-4 rounded-lg shadow-sm text-sm font-medium text-white bg-gradient-to-r from-blue-600 to-blue-700 hover:from-blue-700 hover:to-blue-800 transition-all disabled:opacity-70 disabled:cursor-not-allowed`}
            >
              {isProcessing ? 'Processing...' : 
               isCurrentRecipient ? 'You Are the Current Recipient' : 
               userHasContributed ? 'Already Contributed' : 
               'Contribute Now'}
            </button>
            
            <p className="mt-3 text-xs text-center text-gray-500">
              By contributing, you agree to the circle&apos;s terms and conditions.
            </p>
            
            {/* Add inactive circle message */}
            {circle && !circle.isActive && (
              <div className="mt-3 p-3 bg-amber-50 rounded-lg border border-amber-200">
                <p className="text-sm text-amber-700 font-medium">
                  This circle is not active yet
                </p>
                <p className="text-xs text-amber-600 mt-1">
                  {!userDepositPaid 
                    ? "Security deposits can still be paid before activation."
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
                    <h3 className="text-lg font-medium text-gray-900 mb-4 border-l-4 border-green-500 pl-3">Your Wallet</h3>
                    <div className="bg-gradient-to-r from-blue-50 to-indigo-50 p-4 rounded-lg shadow-sm border border-blue-100">
                      <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center space-y-3 sm:space-y-0">
                        <div>
                          <p className="text-sm text-gray-600 mb-1">Available Balance:</p>
                          {fetchingBalance ? (
                            <div className="animate-pulse h-6 w-32 bg-gray-200 rounded"></div>
                          ) : (
                            <div className="text-lg font-semibold text-blue-700">
                              {userBalance !== null ? (
                                <CurrencyDisplay sui={userBalance} />
                              ) : (
                                'Unable to fetch balance'
                              )}
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
                        <CurrencyDisplay usd={circle.contributionAmountUsd} sui={circle.contributionAmount} />
                      </div>

                      <div className="bg-gray-50 p-4 rounded-lg shadow-sm">
                        <p className="text-sm text-gray-500 mb-1">Security Deposit Required</p>
                        <CurrencyDisplay usd={circle.securityDepositUsd} sui={circle.securityDeposit} />
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
                          <h3 className="text-lg font-medium text-gray-800 mb-4 text-center">
                            Contributions Made Cycle {currentCycle}
                          </h3>
                          <div className="flex justify-center">
                            <ContributionProgress 
                              circleId={circle.id} 
                              maxMembers={circle.maxMembers || 5} 
                              currentCycle={currentCycle}
                              currentRecipientAddress={cycleRecipientAddress} // Pass the recipient address
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
                                {custodySuiBalance !== null ? `${custodySuiBalance.toFixed(6)} SUI` : "-"}
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
                                {custodyStablecoinBalance !== null ? `$${custodyStablecoinBalance.toFixed(2)} USDC` : "-"}
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
                                  ${securityDepositBalance?.toFixed(2) || '0.00'} USDC
                                </span>
                                <span className="px-1.5 py-0.5 bg-amber-100 text-amber-800 text-xs font-medium rounded-full">Security Deposits</span>
                              </div>
                              <div className="flex flex-wrap items-center gap-1">
                                <div className="w-3 h-3 bg-green-300 rounded-sm mr-1"></div>
                                <span className="text-sm text-gray-700">
                                  ${contributionBalance?.toFixed(2) || '0.00'} USDC
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