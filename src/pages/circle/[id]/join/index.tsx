import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { useAuth } from '../../../../contexts/AuthContext';
import Image from 'next/image';
import { SuiClient } from '@mysten/sui/client';
import { toast } from 'react-hot-toast';
import { ArrowLeft, AlertCircle } from 'lucide-react';
import { priceService } from '../../../../services/price-service';
import joinRequestService from '../../../../services/join-request-service';

// Define a proper Circle type to fix linter errors
interface Circle {
  id: string;
  name: string;
  admin: string;
  contributionAmount: number; // Raw SUI amount from blockchain
  contributionAmountUsd: number; // USD amount (cents/100)
  securityDeposit: number; // Raw SUI amount from blockchain
  securityDepositUsd: number; // USD amount (cents/100)
  cycleLength: number;
  cycleDay: number;
  maxMembers: number;
  currentMembers: number;
  nextPayoutTime: number;
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
    contribution_amount?: string;
    security_deposit?: string;
    target_amount?: string;
  } | string; // Can be an object with fields or a string reference
  // Use unknown for index signature as a safer alternative to any
  [key: string]: string | number | boolean | object | unknown;
}

export default function JoinCircle() {
  const router = useRouter();
  const { id } = router.query;
  const { isAuthenticated, userAddress, account } = useAuth();
  const [loading, setLoading] = useState(true);
  const [circle, setCircle] = useState<Circle | null>(null);
  const [isJoining, setIsJoining] = useState(false);
  const [isMember, setIsMember] = useState(false);
  const [requestSent, setRequestSent] = useState(false);
  const [suiPrice, setSuiPrice] = useState(1.25); // Default price until we fetch real price

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

  useEffect(() => {
    // Check if this user already has a pending request for this circle
    if (id && userAddress) {
      checkPendingRequest();
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
        
        // Check if user is already a member (simplified check)
        const isAdmin = fields.admin === userAddress;
        
        // This is a simplified check - in reality you'd check members array from the contract
        const checkMembership = isAdmin; // For now, only admin is confirmed to be a member
        setIsMember(checkMembership);
        
        // If already a member, redirect to circle view
        if (checkMembership) {
          toast('You are already a member of this circle');
          router.push(`/circle/${id}`);
          return;
        }
        
        // Get the USD amounts, checking both direct fields and potentially nested usd_amounts
        let contributionAmountUsd = 0;
        let securityDepositUsd = 0;
        
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
        
        // Get accurate member count from MemberJoined events
        let memberCount = 1; // Start with 1 for admin
        try {
          // Fetch all MemberJoined events and filter for this circle
          const memberEvents = await client.queryEvents({
            query: {
              MoveEventType: `0x3b99f14240784d346918641aebe91c97dc305badcf7fbacaffbc207e6dfad8c8::njangi_circle::MemberJoined`
            },
            limit: 1000
          });
          
          console.log(`Found ${memberEvents.data.length} total MemberJoined events, filtering for circle ${id}`);
          
          // Count unique member addresses for this specific circle
          const memberAddresses = new Set<string>();
          
          // Filter events for the specific circle
          const circleEvents = memberEvents.data.filter(event => {
            if (event.parsedJson && typeof event.parsedJson === 'object') {
              const eventJson = event.parsedJson as { circle_id?: string };
              return eventJson.circle_id === id;
            }
            return false;
          });
          
          console.log(`Filtered down to ${circleEvents.length} events for circle ${id}`);
          
          // Process the filtered events
          for (const event of circleEvents) {
            if (event.parsedJson && typeof event.parsedJson === 'object') {
              const eventJson = event.parsedJson as { circle_id?: string, member?: string };
              
              if (eventJson.member) {
                memberAddresses.add(eventJson.member);
                console.log(`Added member ${eventJson.member} to count`);
              }
            }
          }
          
          // Add admin to the set
          memberAddresses.add(fields.admin);
          console.log(`Added admin ${fields.admin} as member for circle ${id} (${fields.name || 'unnamed'})`);
          
          memberCount = memberAddresses.size;
          console.log(`Final count: Found ${memberCount} members for circle ${id}`);
        } catch (error) {
          console.error(`Error fetching member count for circle ${id}:`, error);
          // Fall back to contract stored count if event fetch fails
          memberCount = Number(fields.current_members);
          console.log(`Falling back to contract-stored count: ${memberCount}`);
        }
        
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
          currentMembers: memberCount,
          nextPayoutTime: Number(fields.next_payout_time),
        });
      }
    } catch (error) {
      console.error('Error fetching circle details:', error);
      toast.error('Could not load circle information');
    } finally {
      setLoading(false);
    }
  };

  const checkPendingRequest = async () => {
    if (!id || !userAddress) return;
    
    try {
      // Check if this user has a pending request for this circle using the service
      const hasRequest = await joinRequestService.checkPendingRequest(id as string, userAddress);
      setRequestSent(hasRequest);
    } catch (error: unknown) {
      console.error('Error checking pending requests:', error);
    }
  };

  const handleJoinCircle = async () => {
    if (!circle || !userAddress) return;
    
    setIsJoining(true);
    try {
      // Send join request using the service
      const result = await joinRequestService.createJoinRequest(
        circle.id,
        circle.name,
        userAddress,
        account?.name || 'Unknown User'
      );
      
      if (result) {
        // Update UI to show request was sent
        setRequestSent(true);
        toast.success('Your request to join has been sent to the admin!');
      } else {
        toast.error('Failed to send join request');
      }
    } catch (error: unknown) {
      console.error('Error sending join request:', error);
      toast.error('Failed to send join request');
    } finally {
      setIsJoining(false);
    }
  };

  // Format cycle info
  const formatCycleInfo = (cycleLength: number, cycleDay: number) => {
    // Cycle length: 0 = weekly, 1 = monthly, 2 = quarterly
    let cyclePeriod = '';
    let dayFormat = '';
    
    switch (cycleLength) {
      case 0: // Weekly
        cyclePeriod = 'Weekly';
        // The Move contract uses 0 = Sunday, 1 = Monday, etc.
        const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        dayFormat = weekdays[cycleDay % 7]; // Ensure we don't go out of bounds
        break;
      case 1: // Monthly
        cyclePeriod = 'Monthly';
        // In your specific case, default to 1st day when we see 0
        const adjustedDay = cycleDay === 0 ? 1 : cycleDay;
        dayFormat = getOrdinalSuffix(adjustedDay);
        break;
      case 2: // Quarterly
        cyclePeriod = 'Quarterly';
        // Same fix for quarterly
        const adjustedQuarterlyDay = cycleDay === 0 ? 1 : cycleDay;
        dayFormat = getOrdinalSuffix(adjustedQuarterlyDay);
        break;
      default:
        cyclePeriod = 'Unknown';
        dayFormat = `Day ${cycleDay === 0 ? 1 : cycleDay}`;
    }
    
    return `${cyclePeriod} (${dayFormat})`;
  };

  // Helper to format dates with ordinal suffix
  const getOrdinalSuffix = (day: number) => {
    const suffixes = ['th', 'st', 'nd', 'rd'];
    const relevantDigits = (day % 100);
    const suffix = (relevantDigits >= 11 && relevantDigits <= 13) ? 'th' : suffixes[Math.min(relevantDigits % 10, 3)];
    return `${day}${suffix} day`;
  };

  // Helper function to calculate SUI amount from USD value
  const calculateSuiAmount = (usdValue: number): number => {
    if (!usdValue || !suiPrice || suiPrice <= 0) return 0;
    return usdValue / suiPrice;
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

  // Helper component to display both USD and SUI amounts
  const CurrencyDisplay = ({ usd, sui, className = '' }: { usd?: number, sui?: number, className?: string }) => {
    // Ensure we have valid numbers
    const usdValue = usd !== undefined && !isNaN(usd) ? usd : 0;
    
    // For SUI, check if the value is unreasonably large (blockchain raw value)
    // If so, calculate it from USD instead
    let displaySuiValue: number;
    if (sui !== undefined && !isNaN(sui) && sui < 1_000_000) { // If SUI value is reasonable
      displaySuiValue = sui;
    } else if (usdValue && suiPrice > 0) { // Otherwise calculate from USD
      // Calculate SUI based on USD value and current price
      displaySuiValue = usdValue / suiPrice;
    } else {
      displaySuiValue = 0;
    }
    
    // Format the SUI value based on its magnitude
    const formattedSui = displaySuiValue >= 1000 
      ? displaySuiValue.toLocaleString('en-US', { maximumFractionDigits: 0 })
      : displaySuiValue.toLocaleString('en-US', { maximumFractionDigits: 2 });
    
    return (
      <div className={`flex flex-col ${className}`}>
        <span className="font-medium">{formatUSD(usdValue)}</span>
        <span className="text-sm text-gray-500">{formattedSui} SUI</span>
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
              <h2 className="text-2xl font-bold text-gray-900">
                Join Circle
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
                        <p className="text-sm text-gray-500 mb-1">Security Deposit</p>
                        <CurrencyDisplay usd={circle.securityDepositUsd} sui={circle.securityDeposit} />
                      </div>
                      
                      <div className="bg-gray-50 p-4 rounded-lg shadow-sm">
                        <p className="text-sm text-gray-500 mb-1">Contribution Schedule</p>
                        <p className="text-lg font-medium">{formatCycleInfo(circle.cycleLength, circle.cycleDay)}</p>
                      </div>
                      
                      <div className="bg-gray-50 p-4 rounded-lg shadow-sm">
                        <p className="text-sm text-gray-500 mb-1">Members</p>
                        <p className="text-lg font-medium">{circle.currentMembers} / {circle.maxMembers}</p>
                      </div>
                    </div>
                  </div>
                  
                  <div className="pt-6 border-t border-gray-200 px-2">
                    <h3 className="text-lg font-medium text-gray-900 mb-4 border-l-4 border-blue-500 pl-3">Join Request</h3>
                    <div className="bg-yellow-50 p-4 rounded-md mb-6">
                      <p className="text-sm text-yellow-800">
                        By joining this circle, you agree to contribute {formatUSD(circle.contributionAmountUsd)} ({calculateSuiAmount(circle.contributionAmountUsd).toLocaleString()} SUI) {formatCycleInfo(circle.cycleLength, circle.cycleDay).toLowerCase()}. You will also need to pay a security deposit of {formatUSD(circle.securityDepositUsd)} ({calculateSuiAmount(circle.securityDepositUsd).toLocaleString()} SUI).
                      </p>
                    </div>
                    
                    {requestSent ? (
                      <div className="bg-blue-50 p-4 rounded-md mb-6 flex items-start">
                        <AlertCircle className="w-5 h-5 text-blue-500 mr-2 flex-shrink-0 mt-0.5" />
                        <div>
                          <h4 className="text-sm font-medium text-blue-800">Request Sent</h4>
                          <p className="text-sm text-blue-700 mt-1">
                            Your request to join this circle has been sent to the admin. 
                            You&apos;ll be notified when your request is approved.
                          </p>
                        </div>
                      </div>
                    ) : (
                      <button
                        onClick={handleJoinCircle}
                        disabled={isJoining || isMember || requestSent}
                        className={`w-full flex justify-center py-3 px-4 rounded-lg shadow-sm text-sm font-medium text-white bg-gradient-to-r from-blue-600 to-blue-700 hover:from-blue-700 hover:to-blue-800 transition-all ${(isJoining || isMember || requestSent) ? 'opacity-70 cursor-not-allowed' : ''}`}
                      >
                        {isJoining ? 'Sending Request...' : isMember ? 'Already a Member' : 'Request to Join Circle'}
                      </button>
                    )}
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