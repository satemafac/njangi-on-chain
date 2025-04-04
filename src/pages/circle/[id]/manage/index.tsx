import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { useAuth } from '../../../../contexts/AuthContext';
import Image from 'next/image';
import { SuiClient } from '@mysten/sui/client';
import { toast } from 'react-hot-toast';
import { ArrowLeft, Copy, Link, Check, X, Pause } from 'lucide-react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { priceService } from '../../../../services/price-service';
import joinRequestService from '../../../../services/join-request-service';
import { JoinRequest } from '../../../../services/database-service';
import { PACKAGE_ID } from '../../../../services/circle-service';

// Define a proper Circle type to fix linter errors
interface Circle {
  id: string;
  name: string;
  admin: string;
  contributionAmount: number;
  contributionAmountUsd: number;
  securityDeposit: number;
  securityDepositUsd: number;
  cycleLength: number;
  cycleDay: number;
  maxMembers: number;
  currentMembers: number;
  nextPayoutTime: number;
  isActive: boolean;
  custody?: {
    walletId: string;
    stablecoinEnabled: boolean;
    stablecoinType: string;
    stablecoinBalance: number;
    suiBalance: number;
  };
}

// Define a type for the fields from the SUI object
interface CircleFields {
  name: string;
  admin: string;
  contribution_amount: string;
  contribution_amount_usd?: string; // Now optional since it might be in usd_amounts
  security_deposit: string;
  security_deposit_usd?: string; // Now optional since it might be in usd_amounts
  cycle_length: string;
  cycle_day: string;
  max_members: string;
  current_members: string;
  next_payout_time: string;
  usd_amounts: {
    fields?: {
      contribution_amount: string;
      security_deposit: string;
      target_amount?: string;
    }
  } | string; // Can be an object with fields or a string reference
  // Use unknown for index signature as a safer alternative to any
  [key: string]: string | number | boolean | object | unknown;
}

// Assuming we'll need a Member type as well
interface Member {
  address: string;
  joinDate?: number;
  status: 'active' | 'suspended' | 'exited';
}

// Constants for time calculations
const MS_PER_DAY = 86400000; // 24 * 60 * 60 * 1000
const DAYS_IN_WEEK = 7;

export default function ManageCircle() {
  const router = useRouter();
  const { id } = router.query;
  const { isAuthenticated, userAddress, account } = useAuth();
  const [loading, setLoading] = useState(true);
  const [circle, setCircle] = useState<Circle | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [pendingRequests, setPendingRequests] = useState<JoinRequest[]>([]);
  const [suiPrice, setSuiPrice] = useState(1.25); // Default price until we fetch real price
  const [copiedId, setCopiedId] = useState(false);
  const [isApproving, setIsApproving] = useState(false);

  useEffect(() => {
    if (!isAuthenticated) {
      router.push('/');
      return;
    }
  }, [isAuthenticated, router]);

  useEffect(() => {
    // Fetch circle details when ID is available
    if (id && userAddress) {
      fetchCircleDetails();
    }
  }, [id, userAddress]);

  useEffect(() => {
    // Fetch SUI price
    const fetchPrice = async () => {
      try {
        const price = await priceService.getSUIPrice();
        if (price !== null) {
          setSuiPrice(price);
        }
      } catch (error) {
        console.error('Error fetching SUI price:', error);
        // Keep using the default price
      }
    };
    fetchPrice();
  }, []);

  useEffect(() => {
    // Fetch pending join requests from database
    if (id && userAddress) {
      fetchPendingRequests();
    }
  }, [id, userAddress]);

  const fetchCircleDetails = async () => {
    if (!id) return;
    
    setLoading(true);
    try {
      const client = new SuiClient({ url: 'https://fullnode.testnet.sui.io:443' });
      
      // Get circle object
      const objectData = await client.getObject({
        id: id as string,
        options: { showContent: true }
      });
      
      if (objectData.data?.content && 'fields' in objectData.data.content) {
        const fields = objectData.data.content.fields as CircleFields;
        
        console.log('Circle data from blockchain:', fields);
        
        const adminAddress = fields.admin;
        
        // If not admin, redirect to view-only page
        if (adminAddress !== userAddress) {
          toast.error('Only the admin can manage this circle');
          router.push(`/circle/${id}`);
          return;
        }
        
        // Get the USD amounts, checking both direct fields and potentially nested usd_amounts
        let contributionAmountUsd = 0;
        let securityDepositUsd = 0;
        
        console.log('USD fields check:', {
          direct_contribution: fields.contribution_amount_usd,
          direct_security: fields.security_deposit_usd,
          nested: fields.usd_amounts
        });
        
        // Check for nested usd_amounts structure (this is the new structure)
        if (fields.usd_amounts) {
          if (typeof fields.usd_amounts === 'object') {
            // It could have a nested 'fields' property or direct properties
            const usdAmountsObj = fields.usd_amounts as {
              contribution_amount?: string; 
              security_deposit?: string; 
              target_amount?: string;
              fields?: {
                contribution_amount: string;
                security_deposit: string;
                target_amount?: string;
              }
            };
            
            // Create a local variable we can modify
            let usdAmounts = usdAmountsObj;
            
            // If it has a fields property, use that
            if (usdAmounts.fields) {
              usdAmounts = usdAmounts.fields;
            }
            
            if (usdAmounts.contribution_amount) {
              contributionAmountUsd = Number(usdAmounts.contribution_amount) / 100;
              console.log('Using nested contribution amount USD:', contributionAmountUsd);
            }
            
            if (usdAmounts.security_deposit) {
              securityDepositUsd = Number(usdAmounts.security_deposit) / 100;
              console.log('Using nested security deposit USD:', securityDepositUsd);
            }
          } else if (typeof fields.usd_amounts === 'string') {
            // If it's a string reference to another object, we need to handle differently
            console.log('usd_amounts is a string reference:', fields.usd_amounts);
          }
        } 
        // Fallback to direct fields if nested structure not available or empty
        else if (fields.contribution_amount_usd) {
          contributionAmountUsd = Number(fields.contribution_amount_usd) / 100;
          console.log('Using direct contribution amount USD:', contributionAmountUsd);
        }
        
        if (!fields.usd_amounts && fields.security_deposit_usd) {
          securityDepositUsd = Number(fields.security_deposit_usd) / 100;
          console.log('Using direct security deposit USD:', securityDepositUsd);
        }
        
        console.log('Final USD values:', {
          contributionAmountUsd,
          securityDepositUsd
        });
        
        setCircle({
          id: id as string,
          name: fields.name,
          admin: fields.admin,
          contributionAmount: Number(fields.contribution_amount) / 1e9,
          contributionAmountUsd: contributionAmountUsd,
          securityDeposit: Number(fields.security_deposit) / 1e9,
          securityDepositUsd: securityDepositUsd,
          cycleLength: Number(fields.cycle_length),
          cycleDay: Number(fields.cycle_day),
          maxMembers: Number(fields.max_members),
          currentMembers: Number(fields.current_members),
          nextPayoutTime: Number(fields.next_payout_time),
          isActive: false,
        });
        
        // Fetch the circle creation event to get the actual creation timestamp
        let creationTimestamp = fields.created_at ? Number(fields.created_at) : null;
        
        if (!creationTimestamp) {
          // If created_at is not available in the object, try to find it from events
          try {
            // Look for CircleCreated event with this circle ID
            const events = await client.queryEvents({
              query: {
                MoveEventType: `${PACKAGE_ID}::njangi_circle::CircleCreated`
              },
              limit: 100
            });
            
            // Find the matching event for this circle
            const creationEvent = events.data.find(event => {
              if (event.parsedJson && typeof event.parsedJson === 'object') {
                const eventJson = event.parsedJson as { circle_id?: string };
                return eventJson.circle_id === id;
              }
              return false;
            });
            
            if (creationEvent && creationEvent.timestampMs) {
              // Use the event timestamp
              creationTimestamp = Number(creationEvent.timestampMs);
              console.log('Found creation timestamp from events:', creationTimestamp);
            }
          } catch (error) {
            console.error('Error fetching circle creation event:', error);
          }
        } else {
          console.log('Using created_at from object:', creationTimestamp);
        }
        
        // If no timestamp was found, use a reasonable fallback
        if (!creationTimestamp) {
          // Just use current time as fallback if we couldn't determine the actual timestamp
          creationTimestamp = Date.now();
          console.log('Using fallback timestamp (current time):', creationTimestamp);
        }
        
        // Initialize members list with admin
        const membersList: Member[] = [
          {
            address: fields.admin,
            joinDate: creationTimestamp,
            status: 'active'
          }
        ];
        
        // Fetch all MemberJoined and MemberApproved events for this circle
        try {
          // Fetch MemberJoined events
          const joinedEvents = await client.queryEvents({
            query: {
              MoveEventType: `${PACKAGE_ID}::njangi_circle::MemberJoined`
            },
            limit: 100
          });
          
          // Fetch MemberApproved events
          const approvedEvents = await client.queryEvents({
            query: {
              MoveEventType: `${PACKAGE_ID}::njangi_circle::MemberApproved`
            },
            limit: 100
          });
          
          console.log('Found MemberJoined events:', joinedEvents.data.length);
          console.log('Found MemberApproved events:', approvedEvents.data.length);
          
          // Process joined events for this circle
          const joinedMembersMap = new Map<string, { address: string, timestamp: number }>();
          
          // Add members from join events
          for (const event of joinedEvents.data) {
            if (event.parsedJson && typeof event.parsedJson === 'object') {
              const eventJson = event.parsedJson as { circle_id?: string, member?: string };
              
              if (eventJson.circle_id === id && eventJson.member && event.timestampMs) {
                const memberAddress = eventJson.member;
                // Skip admin, already added
                if (memberAddress !== fields.admin) {
                  joinedMembersMap.set(memberAddress, {
                    address: memberAddress,
                    timestamp: Number(event.timestampMs)
                  });
                }
              }
            }
          }
          
          // Add each non-admin member
          joinedMembersMap.forEach((memberData) => {
            if (memberData.address !== fields.admin) {
              membersList.push({
                address: memberData.address,
                joinDate: memberData.timestamp,
                status: 'active'
              });
            }
          });
          
          console.log('Total members found:', membersList.length);
        } catch (error) {
          console.error('Error fetching member events:', error);
        }
        
        // Update members state
        setMembers(membersList);
        
        // Also update the circle object with the actual member count
        if (membersList.length !== Number(fields.current_members)) {
          console.log('Updating circle member count from', Number(fields.current_members), 'to', membersList.length);
          setCircle(prevCircle => {
            if (prevCircle) {
              return {
                ...prevCircle,
                currentMembers: membersList.length
              };
            }
            return prevCircle;
          });
        }

        // Look for custody wallet for this circle
        try {
          const custodyEvents = await client.queryEvents({
            query: {
              MoveEventType: `${PACKAGE_ID}::njangi_circle::CustodyWalletCreated`
            },
            limit: 50
          });
          
          // Find custody wallet for this circle
          let walletId = null;
          for (const event of custodyEvents.data) {
            if (event.parsedJson && typeof event.parsedJson === 'object') {
              const eventJson = event.parsedJson as { circle_id?: string, wallet_id?: string };
              if (eventJson.circle_id === id && eventJson.wallet_id) {
                walletId = eventJson.wallet_id;
                break;
              }
            }
          }
          
          if (walletId) {
            // Get custody wallet details
            const walletData = await client.getObject({
              id: walletId,
              options: { showContent: true }
            });
            
            if (walletData.data?.content && 'fields' in walletData.data.content) {
              const walletFields = walletData.data.content.fields as {
                balance: { fields: { value: string } };
                stablecoin_config?: {
                  fields: {
                    enabled: boolean;
                    target_coin_type: string;
                    slippage_tolerance: string;
                    minimum_swap_amount: string;
                    last_swap_time: string;
                  }
                };
                stablecoin_balance?: string;
              };
              
              // Update circle with custody wallet info
              setCircle(prevCircle => {
                if (prevCircle) {
                  return {
                    ...prevCircle,
                    custody: {
                      walletId,
                      stablecoinEnabled: walletFields.stablecoin_config?.fields.enabled || false,
                      stablecoinType: walletFields.stablecoin_config?.fields.target_coin_type || 'USDC',
                      stablecoinBalance: walletFields.stablecoin_balance ? Number(walletFields.stablecoin_balance) / 1e8 : 0,
                      suiBalance: walletFields.balance?.fields?.value ? Number(walletFields.balance.fields.value) / 1e9 : 0
                    }
                  };
                }
                return prevCircle;
              });
            }
          }
        } catch (error) {
          console.error('Error fetching custody wallet info:', error);
        }
      }
    } catch (error) {
      console.error('Error fetching circle details:', error);
      toast.error('Could not load circle information');
    } finally {
      setLoading(false);
    }
  };

  const fetchPendingRequests = async () => {
    try {
      // Get pending requests from the service
      if (!id) return;
      const requests = await joinRequestService.getPendingRequestsByCircleId(id as string);
      setPendingRequests(requests);
    } catch (error: unknown) {
      console.error('Error fetching pending requests:', error);
      toast.error('Failed to load join requests');
    }
  };

  // Call the admin_approve_member function on the blockchain
  const callAdminApproveMember = async (circleId: string, memberAddress: string): Promise<boolean> => {
    try {
      setIsApproving(true);
      
      // Show a toast notification that we're working on a blockchain transaction
      toast.loading('Preparing blockchain transaction...', { id: 'blockchain-tx' });
      
      if (!account) {
        toast.error('Not logged in. Please login first', { id: 'blockchain-tx' });
        return false;
      }
      
      // Call the API directly like in create-circle.tsx
      const response = await fetch('/api/zkLogin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'adminApproveMember',
          account,
          circleId,
          memberAddress
        }),
      });
      
      const result = await response.json();
      
      if (!response.ok) {
        if (response.status === 401) {
          toast.error('Authentication failed. Please login again.', { id: 'blockchain-tx' });
          return false;
        }
        
        // Display specific error messages from the server
        const errorMsg = result.error || 'Transaction failed.';
        console.error('Server error details:', result);
        toast.error(errorMsg, { id: 'blockchain-tx' });
        throw new Error(errorMsg);
      }
      
      // Update toast on success
      toast.success('Successfully approved member on blockchain', { id: 'blockchain-tx' });
      console.log(`Successfully approved member. Transaction digest: ${result.digest}`);
      
      return true;
    } catch (error: unknown) {
      console.error('Error approving member on blockchain:', error);
      
      // Make sure we don't show duplicate error toasts
      if (error instanceof Error && !error.message.includes('Transaction failed')) {
        toast.error(error instanceof Error ? error.message : 'Failed to approve member on blockchain', { id: 'blockchain-tx' });
      }
      
      return false;
    } finally {
      setIsApproving(false);
    }
  };

  const handleJoinRequest = async (request: JoinRequest, approve: boolean) => {
    try {
      // If approving, first try to approve on blockchain
      if (approve) {
        const blockchainSuccess = await callAdminApproveMember(
          request.circleId,
          request.userAddress
        );
        
        if (!blockchainSuccess) {
          toast.error('Failed to approve member on blockchain. Please try again.');
          return;
        }
      }
      
      // Update request status using the service
      const success = await joinRequestService.updateJoinRequestStatus(
        request.circleId,
        request.userAddress,
        approve ? 'approved' : 'rejected'
      );
      
      if (success) {
        // Update UI to remove the request
        setPendingRequests(prev => 
          prev.filter(req => 
            !(req.circleId === request.circleId && 
              req.userAddress === request.userAddress)
          )
        );
        
        // If approved, add to members list
        if (approve) {
          // Use current timestamp from blockchain transaction for join date
          const currentTimestamp = Date.now(); // Get the current time as a fallback
          
          setMembers(prev => [
            ...prev,
            {
              address: request.userAddress,
              joinDate: currentTimestamp, // We would ideally get this from the blockchain event
              status: 'active'
            }
          ]);
          
          // Also update current members count
          if (circle) {
            setCircle({
              ...circle,
              currentMembers: circle.currentMembers + 1
            });
          }
          
          toast.success(`Approved ${shortenAddress(request.userAddress)} to join the circle`);
        } else {
          toast.success(`Rejected join request from ${shortenAddress(request.userAddress)}`);
        }
      } else {
        toast.error('Failed to process join request');
      }
    } catch (error: unknown) {
      console.error('Error handling join request:', error);
      toast.error('Failed to process join request');
    }
  };

  // Format timestamp to readable date
  const formatDate = (timestamp: number) => {
    if (!timestamp) return 'Not set';
    
    const date = new Date(timestamp);
    
    // For display purposes, always show in local timezone but format differently
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      timeZoneName: 'short'
    });
  };

  // Format date more cleanly for next payout (to match dashboard)
  const formatNextPayoutDate = (timestamp: number) => {
    if (!timestamp) return 'Not set';
    
    const date = new Date(timestamp);
    
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'UTC'
    });
  };

  // Calculate potential next payout date for non-activated circles
  const calculatePotentialNextPayoutDate = (cycleLength: number, cycleDay: number): number => {
    const currentTime = Date.now();
    
    // Extract year, month, day from the current time
    const currentDate = new Date(currentTime);
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth(); // JS months are 0-indexed (0-11)
    const day = currentDate.getDate();
    
    // Get time of day in ms (since midnight)
    const dayMs = currentTime % MS_PER_DAY;
    
    // Get current weekday (0-6, with 0 being Monday in our system)
    const weekday = (currentDate.getDay() + 6) % 7; // Convert Sunday=0 to Monday=0
    
    console.log('Calculating potential payout date:', {
      currentDate: currentDate.toISOString(),
      year, month: month + 1, day,
      cycleLength, cycleDay,
      weekday
    });
    
    if (cycleLength === 0) {
      // Weekly payouts
      let daysUntil = 0;
      
      if (cycleDay > weekday) {
        // Selected day is later this week
        daysUntil = cycleDay - weekday;
      } else if (cycleDay < weekday || (cycleDay === weekday && dayMs > 0)) {
        // Selected day is earlier than today, or it's today but time has passed
        daysUntil = DAYS_IN_WEEK - weekday + cycleDay;
      }
      
      console.log('Weekly cycle - days until next payout:', daysUntil);
      
      // Calculate timestamp for next payout
      const nextPayoutTime = currentTime + (daysUntil * MS_PER_DAY);
      
      // Reset to midnight UTC
      const nextPayoutDate = new Date(nextPayoutTime);
      nextPayoutDate.setUTCHours(0, 0, 0, 0);
      
      // Log the result for debugging
      console.log('Calculated next payout date (weekly):', nextPayoutDate.toISOString());
      
      return nextPayoutDate.getTime();
    } else if (cycleLength === 1) {
      // Monthly payouts
      
      // If today's date is greater than the selected day, move to next month
      let targetMonth = month;
      let targetYear = year;
      
      if (day > cycleDay || (day === cycleDay && dayMs > 0)) {
        // Move to next month
        targetMonth += 1;
        
        // Handle year rollover
        if (targetMonth > 11) { // JS months are 0-11
          targetMonth = 0;
          targetYear += 1;
        }
      }
      
      console.log('Monthly cycle - target date:', {
        targetYear, targetMonth: targetMonth + 1, cycleDay
      });
      
      // Create date for the target payout day (at midnight UTC)
      const nextPayoutDate = new Date(Date.UTC(targetYear, targetMonth, cycleDay));
      
      // Log the result for debugging
      console.log('Calculated next payout date:', nextPayoutDate.toISOString());
      
      return nextPayoutDate.getTime();
    } else {
      // Quarterly payouts (cycle_length = 2)
      
      // If today's date is greater than the selected day, move to next quarter
      let targetMonth = month;
      let targetYear = year;
      
      if (day > cycleDay || (day === cycleDay && dayMs > 0)) {
        // Move 3 months forward for quarterly
        targetMonth += 3;
        
        // Handle year rollover
        if (targetMonth > 11) { // JS months are 0-11
          targetMonth -= 12;
          targetYear += 1;
        }
      }
      
      console.log('Quarterly cycle - target date:', {
        targetYear, targetMonth: targetMonth + 1, cycleDay
      });
      
      // Create date for the target payout day (at midnight UTC)
      const nextPayoutDate = new Date(Date.UTC(targetYear, targetMonth, cycleDay));
      
      // Log the result for debugging
      console.log('Calculated next payout date (quarterly):', nextPayoutDate.toISOString());
      
      return nextPayoutDate.getTime();
    }
  };

  const shortenAddress = (address: string) => {
    if (!address) return '';
    return `${address.slice(0, 6)}...${address.slice(-6)}`;
  };

  // Format USD value
  const formatUSD = (amount: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
    }).format(amount);
  };

  // Currency display component
  const CurrencyDisplay = ({ usd, sui, className = "" }: { usd?: number; sui?: number; className?: string }) => {
    const isPriceStale = priceService.getFetchStatus() === 'error';
    
    console.log('CurrencyDisplay received values:', { usd, sui, type: typeof usd });
    
    // Check for invalid inputs and provide defaults with more logging
    if ((usd === undefined || isNaN(usd)) && (sui === undefined || isNaN(sui))) {
      console.log('Both USD and SUI values are invalid, defaulting to 0');
      usd = 0;
      sui = 0;
    }
    
    // Calculate values based on which parameter is provided
    let calculatedSui: number;
    let calculatedUsd: number;
    
    if (usd !== undefined && !isNaN(usd)) {
      // If USD is provided and valid, calculate SUI based on current price
      calculatedUsd = usd;
      calculatedSui = suiPrice > 0 ? usd / suiPrice : 0;
      console.log('Calculated from USD:', { calculatedUsd, calculatedSui, suiPrice });
    } else if (sui !== undefined && !isNaN(sui)) {
      // If SUI is provided and valid, calculate USD
      calculatedSui = sui;
      calculatedUsd = sui * suiPrice;
      console.log('Calculated from SUI:', { calculatedUsd, calculatedSui, suiPrice });
    } else {
      // Default values if neither is provided or values are invalid
      calculatedSui = 0;
      calculatedUsd = 0;
      console.log('Using default values:', { calculatedUsd, calculatedSui });
    }
    
    // Format SUI with appropriate precision
    const formattedSui = calculatedSui >= 1000 
      ? calculatedSui.toLocaleString(undefined, { maximumFractionDigits: 0 }) 
      : calculatedSui >= 100 
        ? calculatedSui.toFixed(1) 
        : calculatedSui.toFixed(2);
    
    return (
      <Tooltip.Provider>
        <Tooltip.Root>
          <Tooltip.Trigger asChild>
            <span className={`cursor-help ${className} flex items-center`}>
              {formatUSD(calculatedUsd)} <span className="text-gray-500 mr-1">({formattedSui} SUI)</span>
              {isPriceStale && <span title="Using cached price">⚠️</span>}
            </span>
          </Tooltip.Trigger>
          <Tooltip.Portal>
            <Tooltip.Content
              className="bg-gray-900 text-white px-3 py-2 rounded text-sm"
              sideOffset={5}
            >
              <div className="space-y-1">
                <p>SUI Conversion Rate:</p>
                <p>1 SUI = {formatUSD(suiPrice)}</p>
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

  const copyToClipboard = async (text: string, type: 'id' | 'link') => {
    try {
      if (type === 'id') {
        await navigator.clipboard.writeText(text);
        setCopiedId(true);
        toast.success('Circle ID copied to clipboard!');
        setTimeout(() => setCopiedId(false), 2000);
      } else if (type === 'link') {
        const shareLink = `${window.location.origin}/circle/${text}/join`;
        await navigator.clipboard.writeText(shareLink);
        toast.success('Invite link copied to clipboard!');
      }
    } catch (err: unknown) {
      console.error('Failed to copy:', err);
      toast.error('Failed to copy to clipboard');
    }
  };

  const shortenId = (id: string) => {
    if (!id) return '';
    return `${id.slice(0, 10)}...${id.slice(-8)}`;
  };

  // Add this new handler function before the return statement
  const handleStablecoinConfigUpdate = async (enabled: boolean, coinType: string, slippage: number, minAmount: number) => {
    if (!circle || !circle.custody?.walletId) {
      toast.error('Custody wallet information not available');
      return;
    }
    
    try {
      toast.loading('Updating stablecoin configuration...', { id: 'stablecoin-config' });
      
      if (!account) {
        toast.error('Not logged in. Please login first', { id: 'stablecoin-config' });
        return;
      }
      
      // Convert minimum amount to SUI with 9 decimals
      const minAmountInSui = Math.floor(minAmount * 1e9);
      
      // Call the API directly
      const response = await fetch('/api/zkLogin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'configureStablecoinSwap',
          account,
          walletId: circle.custody.walletId,
          enabled,
          targetCoinType: coinType,
          slippageTolerance: Math.floor(slippage * 100), // Convert percent to basis points
          minimumSwapAmount: minAmountInSui,
          dexAddress: '0x9083c89c2735b4167bd0ed7decdb7ae0a04f35cd3bf10b17a96719b1be62bde6' // Example DEX address
        }),
      });
      
      const result = await response.json();
      
      if (!response.ok) {
        if (response.status === 401) {
          toast.error('Authentication failed. Please login again.', { id: 'stablecoin-config' });
          return;
        }
        
        // Display specific error messages from the server
        const errorMsg = result.error || 'Transaction failed.';
        console.error('Server error details:', result);
        toast.error(errorMsg, { id: 'stablecoin-config' });
        throw new Error(errorMsg);
      }
      
      // Update toast on success
      toast.success('Successfully updated stablecoin configuration', { id: 'stablecoin-config' });
      console.log(`Successfully updated config. Transaction digest: ${result.digest}`);
      
      // Update local state
      setCircle(prevCircle => {
        if (prevCircle && prevCircle.custody) {
          return {
            ...prevCircle,
            custody: {
              ...prevCircle.custody,
              stablecoinEnabled: enabled,
              stablecoinType: coinType
            }
          };
        }
        return prevCircle;
      });
      
    } catch (error) {
      console.error('Error updating stablecoin config:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to update configuration', { id: 'stablecoin-config' });
    }
  };

  // Add this new component before the return statement
  const StablecoinSettings = ({ circle }: { circle: Circle }) => {
    const [isEnabled, setIsEnabled] = useState(circle.custody?.stablecoinEnabled || false);
    const [coinType, setCoinType] = useState(circle.custody?.stablecoinType || 'USDC');
    const [slippage, setSlippage] = useState(0.5); // Default 0.5%
    const [minAmount, setMinAmount] = useState(1); // Default 1 SUI
    const [isConfiguring, setIsConfiguring] = useState(false);
    
    const handleSubmit = async (e: React.FormEvent) => {
      e.preventDefault();
      setIsConfiguring(true);
      
      try {
        await handleStablecoinConfigUpdate(isEnabled, coinType, slippage, minAmount);
      } finally {
        setIsConfiguring(false);
      }
    };
    
    return (
      <div className="bg-white rounded-lg shadow-md overflow-hidden">
        <div className="bg-blue-50 px-4 py-3 border-b border-blue-100">
          <h3 className="text-lg font-semibold text-blue-800">Stablecoin Auto-Swap Settings</h3>
          <p className="text-sm text-blue-600">Configure automatic conversion of SUI to stablecoins to protect from market volatility</p>
        </div>
        
        <div className="p-4">
          {!circle.custody?.walletId ? (
            <div className="text-center p-4 text-gray-500">
              <p>Custody wallet information not available</p>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h4 className="font-medium text-gray-800">Auto-Swap Funds</h4>
                  <p className="text-sm text-gray-500">Automatically convert SUI to stablecoins when received</p>
                </div>
                <div className="flex items-center">
                  <button
                    type="button"
                    onClick={() => setIsEnabled(!isEnabled)}
                    className={`relative inline-flex h-6 w-11 items-center rounded-full ${isEnabled ? 'bg-blue-600' : 'bg-gray-200'}`}
                  >
                    <span className="sr-only">Enable auto-swap</span>
                    <span 
                      className={`inline-block h-4 w-4 transform rounded-full bg-white transition ${isEnabled ? 'translate-x-6' : 'translate-x-1'}`} 
                    />
                  </button>
                </div>
              </div>
              
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label htmlFor="stablecoin-type" className="block text-sm font-medium text-gray-700">Stablecoin Type</label>
                  <select 
                    id="stablecoin-type"
                    value={coinType}
                    onChange={(e) => setCoinType(e.target.value)}
                    className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
                    disabled={!isEnabled}
                  >
                    <option value="USDC">USDC</option>
                    <option value="USDT">USDT</option>
                    <option value="DAI">DAI</option>
                  </select>
                </div>
                
                <div>
                  <label htmlFor="slippage" className="block text-sm font-medium text-gray-700">Slippage Tolerance (%)</label>
                  <input 
                    type="number" 
                    id="slippage"
                    value={slippage}
                    onChange={(e) => setSlippage(Number(e.target.value))}
                    min="0.1"
                    max="5"
                    step="0.1"
                    className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
                    disabled={!isEnabled}
                  />
                </div>
                
                <div>
                  <label htmlFor="min-amount" className="block text-sm font-medium text-gray-700">Minimum Swap Amount (SUI)</label>
                  <input 
                    type="number" 
                    id="min-amount"
                    value={minAmount}
                    onChange={(e) => setMinAmount(Number(e.target.value))}
                    min="0.1"
                    step="0.1"
                    className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
                    disabled={!isEnabled}
                  />
                </div>
                
                {circle.custody && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700">Wallet Balances</label>
                    <div className="mt-1 text-sm">
                      <p><span className="font-medium">SUI:</span> {circle.custody.suiBalance.toFixed(2)} SUI</p>
                      <p><span className="font-medium">{circle.custody.stablecoinType}:</span> {formatUSD(circle.custody.stablecoinBalance)}</p>
                    </div>
                  </div>
                )}
              </div>
              
              <div className="pt-3">
                <button
                  type="submit"
                  className={`w-full py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 ${isConfiguring ? 'opacity-75 cursor-not-allowed' : ''}`}
                  disabled={isConfiguring}
                >
                  {isConfiguring ? 'Updating...' : 'Update Configuration'}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    );
  };

  if (!isAuthenticated || !account) {
    return null;
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <nav className="bg-white shadow-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between h-16">
            <div className="flex items-center">
              <Image
                src="/njangi-on-chain-logo.png"
                alt="Njangi on-chain"
                width={48}
                height={48}
                className="mr-3"
                priority
              />
              <h1 className="text-xl font-semibold text-blue-600">Njangi on-chain</h1>
            </div>
          </div>
        </div>
      </nav>

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
              <div className="flex justify-between items-center">
                <h2 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
                  {!loading && circle ? circle.name : 'Manage Circle'}
                  {!loading && circle && (
                    <span className="text-sm font-normal bg-blue-100 text-blue-800 py-0.5 px-2 rounded-full">
                      {circle.currentMembers}/{circle.maxMembers} Members
                    </span>
                  )}
                </h2>
                {!loading && circle && (
                  <div className="flex items-center space-x-2 text-sm">
                    <span className="text-gray-500 bg-gray-100 py-1 px-2 rounded-md">{shortenId(id as string)}</span>
                    <Tooltip.Provider>
                      <Tooltip.Root>
                        <Tooltip.Trigger asChild>
                          <button
                            onClick={() => copyToClipboard(id as string, 'id')}
                            className={`text-gray-500 hover:text-blue-600 p-1.5 rounded-full hover:bg-blue-50 transition-colors duration-200 ${copiedId ? 'text-green-500 bg-green-50' : ''}`}
                          >
                            {copiedId ? <Check size={16} /> : <Copy size={16} />}
                          </button>
                        </Tooltip.Trigger>
                        <Tooltip.Portal>
                          <Tooltip.Content
                            className="bg-gray-800 text-white px-2 py-1 rounded text-xs"
                            sideOffset={5}
                          >
                            {copiedId ? 'Copied!' : 'Copy Circle ID'}
                            <Tooltip.Arrow className="fill-gray-800" />
                          </Tooltip.Content>
                        </Tooltip.Portal>
                      </Tooltip.Root>
                    </Tooltip.Provider>
                    
                    <Tooltip.Provider>
                      <Tooltip.Root>
                        <Tooltip.Trigger asChild>
                          <button
                            onClick={() => copyToClipboard(id as string, 'link')}
                            className="text-gray-500 hover:text-blue-600 p-1.5 rounded-full hover:bg-blue-50 transition-colors duration-200"
                          >
                            <Link size={16} />
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
                )}
              </div>
              {loading ? (
                <div className="py-8 flex justify-center">
                  <svg className="animate-spin h-8 w-8 text-blue-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                </div>
              ) : circle ? (
                <div className="py-4 space-y-8">
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
                        <CurrencyDisplay usd={circle.contributionAmountUsd} sui={circle.contributionAmount} className="font-medium" />
                      </div>
                      
                      <div className="bg-gray-50 p-4 rounded-lg shadow-sm">
                        <p className="text-sm text-gray-500 mb-1">Security Deposit</p>
                        <CurrencyDisplay usd={circle.securityDepositUsd} sui={circle.securityDeposit} className="font-medium" />
                      </div>
                      
                      <div className="bg-gray-50 p-4 rounded-lg shadow-sm">
                        <p className="text-sm text-gray-500 mb-1">
                          {circle.isActive ? 'Next Payout' : 'Potential Next Payout'}
                        </p>
                        <p className="text-lg font-medium">
                          {circle.isActive 
                            ? formatNextPayoutDate(circle.nextPayoutTime)
                            : formatNextPayoutDate(calculatePotentialNextPayoutDate(circle.cycleLength, circle.cycleDay))}
                        </p>
                        {!circle.isActive && (
                          <p className="text-xs text-blue-600 mt-1">
                            <span className="font-bold">Estimate</span> if circle activated now
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                  
                  {/* Members Management */}
                  <div className="px-2">
                    <h3 className="text-lg font-medium text-gray-900 mb-4 border-l-4 border-blue-500 pl-3">Members</h3>
                    <div className="overflow-hidden shadow-sm rounded-xl border border-gray-200">
                      <table className="min-w-full divide-y divide-gray-200">
                        <thead className="bg-gray-50">
                          <tr>
                            <th scope="col" className="py-3.5 pl-4 pr-3 text-left text-sm font-semibold text-gray-900 sm:pl-6">
                              Address
                            </th>
                            <th scope="col" className="px-3 py-3.5 text-left text-sm font-semibold text-gray-900">
                              Status
                            </th>
                            <th scope="col" className="px-3 py-3.5 text-left text-sm font-semibold text-gray-900">
                              Joined
                            </th>
                            <th scope="col" className="relative py-3.5 pl-3 pr-4 sm:pr-6">
                              <span className="sr-only">Actions</span>
                            </th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-200 bg-white">
                          {members.map((member) => (
                            <tr key={member.address} className="hover:bg-gray-50 transition-colors">
                              <td className="whitespace-nowrap py-4 pl-4 pr-3 text-sm font-medium text-gray-900 sm:pl-6">
                                {shortenAddress(member.address)} 
                                {member.address === circle.admin && 
                                  <span className="text-xs bg-purple-100 text-purple-700 rounded-full px-2 py-0.5 ml-2">Admin</span>
                                }
                              </td>
                              <td className="whitespace-nowrap px-3 py-4 text-sm">
                                <span className={`px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${
                                  member.status === 'active' ? 'bg-green-100 text-green-800' : 
                                  member.status === 'suspended' ? 'bg-yellow-100 text-yellow-800' : 'bg-red-100 text-red-800'
                                }`}>
                                  {member.status.charAt(0).toUpperCase() + member.status.slice(1)}
                                </span>
                              </td>
                              <td className="whitespace-nowrap px-3 py-4 text-sm text-gray-500">
                                {member.joinDate ? formatDate(member.joinDate) : 'Unknown'}
                              </td>
                              <td className="relative whitespace-nowrap py-4 pl-3 pr-4 text-right text-sm font-medium sm:pr-6">
                                {/* No actions for admin */}
                                {member.address !== circle.admin && (
                                  <button
                                    className="text-red-600 hover:text-red-900 px-2 py-1 rounded hover:bg-red-50"
                                    onClick={() => toast.success('Member removal coming soon')}
                                  >
                                    Remove
                                  </button>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                  
                  {/* Invite Members */}
                  <div className="px-2">
                    <h3 className="text-lg font-medium text-gray-900 mb-4 border-l-4 border-blue-500 pl-3">Invite New Members</h3>
                    <p className="mb-4 text-sm text-gray-500">Send the following link to people you&apos;d like to invite to your circle.</p>
                    
                    <div className="flex items-center space-x-2 bg-gray-50 p-3 rounded-xl border border-gray-200">
                      <input
                        type="text"
                        readOnly
                        value={`${window.location.origin}/circle/${circle.id}/join`}
                        className="flex-1 p-2 bg-transparent text-gray-800 border-0 focus:ring-0"
                      />
                      <button
                        onClick={() => {
                          navigator.clipboard.writeText(`${window.location.origin}/circle/${circle.id}/join`);
                          toast.success('Invite link copied to clipboard');
                        }}
                        className="px-4 py-2 bg-gradient-to-r from-blue-600 to-blue-700 text-white rounded-lg text-sm hover:from-blue-700 hover:to-blue-800 transition-all shadow-sm font-medium flex items-center"
                      >
                        <Copy className="w-4 h-4 mr-2" />
                        Copy
                      </button>
                    </div>
                  </div>
                  
                  {/* Pending Join Requests Section */}
                  {pendingRequests.length > 0 && (
                    <div className="mt-8 px-2">
                      <h3 className="text-lg font-medium text-gray-900 mb-4 border-l-4 border-blue-500 pl-3">
                        Pending Join Requests 
                        <span className="ml-2 bg-blue-100 text-blue-800 text-xs font-medium px-2.5 py-0.5 rounded-full">
                          {pendingRequests.length}
                        </span>
                      </h3>
                      <div className="overflow-hidden shadow-sm rounded-xl border border-gray-200">
                        <table className="min-w-full divide-y divide-gray-200">
                          <thead className="bg-gray-50">
                            <tr>
                              <th scope="col" className="py-3.5 pl-4 pr-3 text-left text-sm font-semibold text-gray-900 sm:pl-6">
                                User
                              </th>
                              <th scope="col" className="px-3 py-3.5 text-left text-sm font-semibold text-gray-900">
                                Requested On
                              </th>
                              <th scope="col" className="relative py-3.5 pl-3 pr-4 sm:pr-6">
                                <span className="sr-only">Actions</span>
                              </th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-gray-200 bg-white">
                            {pendingRequests.map((request) => (
                              <tr key={`${request.circleId}-${request.userAddress}`} className="hover:bg-gray-50 transition-colors">
                                <td className="whitespace-nowrap py-4 pl-4 pr-3 text-sm sm:pl-6">
                                  <div className="font-medium text-gray-900">{request.userName || 'Unknown User'}</div>
                                  <div className="text-gray-500">{shortenAddress(request.userAddress)}</div>
                                </td>
                                <td className="whitespace-nowrap px-3 py-4 text-sm text-gray-500">
                                  {formatDate(request.requestDate)}
                                </td>
                                <td className="relative whitespace-nowrap py-4 pl-3 pr-4 text-right text-sm font-medium sm:pr-6">
                                  <div className="flex justify-end space-x-3">
                                    <button
                                      onClick={() => handleJoinRequest(request, true)}
                                      className={`${isApproving ? 'opacity-50 cursor-not-allowed' : ''} text-white bg-gradient-to-r from-green-500 to-emerald-600 hover:from-green-600 hover:to-emerald-700 transition-all flex items-center px-4 py-2 rounded-lg shadow-sm font-medium`}
                                      disabled={isApproving}
                                    >
                                      {isApproving ? (
                                        <svg className="animate-spin h-4 w-4 mr-2" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                                        </svg>
                                      ) : (
                                        <Check className="w-4 h-4 mr-2" />
                                      )}
                                      Approve
                                    </button>
                                    <button
                                      onClick={() => handleJoinRequest(request, false)}
                                      className="text-white bg-gradient-to-r from-red-500 to-red-600 hover:from-red-600 hover:to-red-700 transition-all flex items-center px-4 py-2 rounded-lg shadow-sm font-medium"
                                      disabled={isApproving}
                                    >
                                      <X className="w-4 h-4 mr-2" />
                                      Reject
                                    </button>
                                  </div>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                  
                  {/* Circle Management Actions */}
                  <div className="pt-6 border-t border-gray-200 px-2">
                    <h3 className="text-lg font-medium text-gray-900 mb-4 border-l-4 border-blue-500 pl-3">Circle Management</h3>
                    <div className="flex flex-col space-y-4 sm:flex-row sm:space-x-4 sm:space-y-0">
                      <Tooltip.Provider>
                        <Tooltip.Root>
                          <Tooltip.Trigger asChild>
                            <div>
                              <button
                                onClick={() => toast.success('This feature is coming soon')}
                                className={`px-5 py-3 text-white rounded-lg text-sm transition-all flex items-center justify-center shadow-md font-medium ${
                                  circle && circle.currentMembers < circle.maxMembers 
                                    ? 'bg-gray-400 opacity-60 cursor-not-allowed'
                                    : 'bg-gradient-to-r from-green-500 to-emerald-600 hover:from-green-600 hover:to-emerald-700'
                                }`}
                                disabled={circle && circle.currentMembers < circle.maxMembers}
                              >
                                <Check className="w-4 h-4 mr-2" />
                                Activate Circle
                              </button>
                            </div>
                          </Tooltip.Trigger>
                          {circle && circle.currentMembers < circle.maxMembers && (
                            <Tooltip.Portal>
                              <Tooltip.Content
                                className="bg-gray-800 text-white px-3 py-2 rounded text-xs max-w-xs"
                                sideOffset={5}
                              >
                                <p>You need {circle.maxMembers - circle.currentMembers} more member(s) to activate the circle.</p>
                                <p className="mt-1 text-gray-300">Current: {circle.currentMembers}/{circle.maxMembers} members</p>
                                <Tooltip.Arrow className="fill-gray-800" />
                              </Tooltip.Content>
                            </Tooltip.Portal>
                          )}
                        </Tooltip.Root>
                      </Tooltip.Provider>
                      
                      <Tooltip.Provider>
                        <Tooltip.Root>
                          <Tooltip.Trigger asChild>
                            <div>
                              <button
                                onClick={() => toast.success('This feature is coming soon')}
                                className={`px-5 py-3 text-white rounded-lg text-sm transition-all flex items-center justify-center shadow-md font-medium ${
                                  !circle || !circle.isActive
                                    ? 'bg-gray-400 opacity-60 cursor-not-allowed'
                                    : 'bg-gradient-to-r from-amber-500 to-yellow-600 hover:from-amber-600 hover:to-yellow-700'
                                }`}
                                disabled={!circle || !circle.isActive}
                              >
                                <Pause className="w-4 h-4 mr-2" />
                                Pause Contributions
                              </button>
                            </div>
                          </Tooltip.Trigger>
                          {circle && !circle.isActive && (
                            <Tooltip.Portal>
                              <Tooltip.Content
                                className="bg-gray-800 text-white px-3 py-2 rounded text-xs max-w-xs"
                                sideOffset={5}
                              >
                                <p>Cannot pause contributions: The circle is not active yet.</p>
                                <p className="mt-1 text-gray-300">Activate the circle first before pausing contributions.</p>
                                <Tooltip.Arrow className="fill-gray-800" />
                              </Tooltip.Content>
                            </Tooltip.Portal>
                          )}
                        </Tooltip.Root>
                      </Tooltip.Provider>
                      
                      <Tooltip.Provider>
                        <Tooltip.Root>
                          <Tooltip.Trigger asChild>
                            <div>
                              <button
                                onClick={() => toast.success('This feature is coming soon')}
                                className={`px-5 py-3 text-white rounded-lg text-sm transition-all flex items-center justify-center shadow-md font-medium ${
                                  circle && circle.currentMembers > 1 
                                    ? 'bg-gray-400 opacity-60 cursor-not-allowed'
                                    : 'bg-gradient-to-r from-red-500 to-red-600 hover:from-red-600 hover:to-red-700'
                                }`}
                                disabled={circle && circle.currentMembers > 1}
                              >
                                <X className="w-4 h-4 mr-2" />
                                Delete Circle
                              </button>
                            </div>
                          </Tooltip.Trigger>
                          {circle && circle.currentMembers > 1 && (
                            <Tooltip.Portal>
                              <Tooltip.Content
                                className="bg-gray-800 text-white px-3 py-2 rounded text-xs max-w-xs"
                                sideOffset={5}
                              >
                                <p>Cannot delete: The circle has {circle.currentMembers - 1} member(s) besides the admin.</p>
                                <p className="mt-1 text-gray-300">Remove all members first before deleting.</p>
                                <Tooltip.Arrow className="fill-gray-800" />
                              </Tooltip.Content>
                            </Tooltip.Portal>
                          )}
                        </Tooltip.Root>
                      </Tooltip.Provider>
                    </div>
                  </div>
                  
                  {/* Stablecoin Auto-Swap Configuration */}
                  <div className="pt-6 border-t border-gray-200 px-2 mt-6">
                    {circle && <StablecoinSettings circle={circle} />}
                  </div>
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