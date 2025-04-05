import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { useAuth } from '../../../contexts/AuthContext';
import Image from 'next/image';
import { SuiClient } from '@mysten/sui/client';
import { toast } from 'react-hot-toast';
import { ArrowLeft, Copy, Link } from 'lucide-react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { priceService } from '../../../services/price-service';

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
}

export default function CircleDetails() {
  const router = useRouter();
  const { id } = router.query;
  const { isAuthenticated, userAddress, account } = useAuth();
  const [loading, setLoading] = useState(true);
  const [circle, setCircle] = useState<Circle | null>(null);
  const [suiPrice, setSuiPrice] = useState(1.25); // Default price until we fetch real price
  const [copiedId, setCopiedId] = useState(false);

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

  const fetchCircleDetails = async () => {
    console.log('Fetching circle details:', id);
    const client = new SuiClient({ url: 'https://fullnode.testnet.sui.io:443' });
    
    try {
      const objectData = await client.getObject({
        id: id as string,
        options: { showContent: true }
      });
      
      console.log('Circle data:', objectData);
      
      if (objectData.data?.content && 'fields' in objectData.data.content) {
        const fields = objectData.data.content.fields as {
          name: string;
          admin: string;
          contribution_amount: string;
          security_deposit: string;
          cycle_length: string;
          cycle_day: string;
          max_members: string;
          current_members: string;
          next_payout_time: string;
          usd_amounts?: {
            contribution_amount?: string;
            security_deposit?: string;
          };
        };
        
        // Check for circle activation events
        let isActive = false;
        try {
          const activationEvents = await client.queryEvents({
            query: {
              MoveEventType: `0x6b6dabded31921f627c3571197e31433e2b312700ff07ef394daa5cdcb3abd1c::njangi_circle::CircleActivated`
            },
            limit: 50
          });
          
          // Check if any activation event matches this circle
          isActive = activationEvents.data.some(event => {
            if (event.parsedJson && typeof event.parsedJson === 'object') {
              const eventJson = event.parsedJson as { circle_id?: string };
              return eventJson.circle_id === id;
            }
            return false;
          });
          
          console.log('Circle activation status:', isActive);
        } catch (error) {
          console.error('Error checking circle activation:', error);
        }
        
        // Get the USD amounts
        let contributionAmountUsd = 0;
        let securityDepositUsd = 0;
        
        if (fields.usd_amounts) {
          contributionAmountUsd = Number(fields.usd_amounts.contribution_amount || 0) / 100;
          securityDepositUsd = Number(fields.usd_amounts.security_deposit || 0) / 100;
        }
        
        // Accurately calculate member count from events
        let actualMemberCount = 1; // Default to 1 (admin)
        try {
          // Fetch all MemberJoined events and filter for this circle
          const memberEvents = await client.queryEvents({
            query: {
              MoveEventType: `0x6b6dabded31921f627c3571197e31433e2b312700ff07ef394daa5cdcb3abd1c::njangi_circle::MemberJoined`
            },
            limit: 1000 // Increased limit to capture more events
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
              }
            }
          }
          
          // Add admin to the member count
          if (fields.admin) {
            memberAddresses.add(fields.admin);
          }
          
          actualMemberCount = memberAddresses.size;
          console.log(`Found ${actualMemberCount} members for circle ${id}`);
        } catch (error) {
          console.error('Error calculating member count:', error);
          // Use fallback member count from the object
          actualMemberCount = Number(fields.current_members);
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
          currentMembers: actualMemberCount,
          nextPayoutTime: Number(fields.next_payout_time),
          isActive: isActive,
        });
      }
    } catch (error) {
      console.error('Error fetching circle details:', error);
      toast.error('Error loading circle details');
    } finally {
      setLoading(false);
    }
  };

  const formatDate = (timestamp: number, useLocalTime = false) => {
    if (!timestamp) return 'Not set';
    return new Date(timestamp).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      timeZone: useLocalTime ? undefined : 'UTC' // Use local timezone when requested
    });
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
    
    // Check for invalid inputs and provide defaults
    if ((usd === undefined || isNaN(usd)) && (sui === undefined || isNaN(sui))) {
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
    } else if (sui !== undefined && !isNaN(sui)) {
      // If SUI is provided and valid, calculate USD
      calculatedSui = sui;
      calculatedUsd = suiPrice !== null ? sui * suiPrice : null;
    } else {
      // Default values if neither is provided or values are invalid
      calculatedSui = 0;
      calculatedUsd = 0;
    }
    
    // Format SUI with appropriate precision if available
    const formattedSui = calculatedSui !== null ? (
      calculatedSui >= 1000 
        ? calculatedSui.toLocaleString(undefined, { maximumFractionDigits: 0 }) 
        : calculatedSui >= 100 
          ? calculatedSui.toFixed(1) 
          : calculatedSui.toFixed(2)
    ) : '—';
    
    return (
      <Tooltip.Provider>
        <Tooltip.Root>
          <Tooltip.Trigger asChild>
            <span className={`cursor-help ${className} flex items-center`}>
              {calculatedUsd !== null ? formatUSD(calculatedUsd) : '$—.—'} 
              <span className="text-gray-500 mr-1">({formattedSui} SUI)</span>
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
                <h2 className="text-2xl font-bold text-gray-900">
                  {!loading && circle ? circle.name : 'Circle Details'}
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
                            <Copy size={16} />
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
                    
                    {!loading && circle && circle.admin === userAddress && (
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
                    )}
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
                        <p className="text-sm text-gray-500 mb-1">Admin</p>
                        <p className="text-sm font-medium text-gray-700 truncate">{circle.admin}</p>
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
                        <p className="text-sm text-gray-500 mb-1">Members</p>
                        <p className="text-lg font-medium">{circle.currentMembers} / {circle.maxMembers}</p>
                      </div>
                      
                      <div className="bg-gray-50 p-4 rounded-lg shadow-sm">
                        <p className="text-sm text-gray-500 mb-1">
                          {circle.isActive ? 'Next Payout' : 'Potential Next Payout'}
                        </p>
                        <p className="text-lg font-medium">
                          {circle.isActive ? formatDate(circle.nextPayoutTime) : "Activate Circle to Start"}
                        </p>
                      </div>
                    </div>
                  </div>
                  
                  {/* Actions */}
                  <div className="pt-6 border-t border-gray-200 px-2">
                    <h3 className="text-lg font-medium text-gray-900 mb-4 border-l-4 border-blue-500 pl-3">Actions</h3>
                    <div className="flex flex-col space-y-4 sm:flex-row sm:space-x-4 sm:space-y-0">
                      <button
                        onClick={() => router.push(`/circle/${circle.id}/contribute`)}
                        className="px-5 py-3 bg-gradient-to-r from-blue-600 to-blue-700 text-white rounded-lg text-sm hover:from-blue-700 hover:to-blue-800 transition-all shadow-md font-medium flex items-center justify-center"
                      >
                        Contribute
                      </button>
                      
                      {circle.admin === userAddress && (
                        <button
                          onClick={() => router.push(`/circle/${circle.id}/manage`)}
                          className="px-5 py-3 bg-gradient-to-r from-purple-600 to-purple-700 text-white rounded-lg text-sm hover:from-purple-700 hover:to-purple-800 transition-all shadow-md font-medium flex items-center justify-center"
                        >
                          Manage Circle
                        </button>
                      )}
                    </div>
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