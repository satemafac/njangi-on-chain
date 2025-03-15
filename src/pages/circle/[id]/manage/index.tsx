import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { useAuth } from '../../../../contexts/AuthContext';
import Image from 'next/image';
import { SuiClient } from '@mysten/sui/client';
import { toast } from 'react-hot-toast';
import { ArrowLeft, Copy, Link, Check, X } from 'lucide-react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { priceService } from '../../../../services/price-service';
import joinRequestService from '../../../../services/join-request-service';
import { JoinRequest } from '../../../../services/database-service';

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
        setSuiPrice(price);
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
        });
        
        // This would be a separate call to get members
        // For now, just create a placeholder with the admin
        setMembers([
          {
            address: fields.admin,
            joinDate: Date.now(), // This would be fetched from the chain
            status: 'active'
          }
        ]);
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

  const handleJoinRequest = async (request: JoinRequest, approve: boolean) => {
    try {
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
          // In a real implementation, we would add the user to the circle on the blockchain
          // For now, we'll just update the UI
          setMembers(prev => [
            ...prev,
            {
              address: request.userAddress,
              joinDate: Date.now(),
              status: 'active'
            }
          ]);
          
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

  const formatDate = (timestamp: number) => {
    if (!timestamp) return 'Not set';
    return new Date(timestamp).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
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
              className="inline-flex items-center text-sm text-gray-600 hover:text-gray-900"
            >
              <ArrowLeft className="w-4 h-4 mr-1" />
              Back to Dashboard
            </button>
          </div>

          <div className="bg-white shadow rounded-lg overflow-hidden">
            <div className="p-6 border-b border-gray-200">
              <div className="flex justify-between items-center">
                <h2 className="text-xl font-semibold text-gray-900">
                  Manage Circle
                </h2>
                {!loading && circle && (
                  <div className="flex items-center space-x-2 text-sm">
                    <span className="text-gray-500">ID: {shortenId(id as string)}</span>
                    <Tooltip.Provider>
                      <Tooltip.Root>
                        <Tooltip.Trigger asChild>
                          <button
                            onClick={() => copyToClipboard(id as string, 'id')}
                            className={`text-gray-400 hover:text-blue-600 p-1 rounded-full hover:bg-blue-50 transition-colors duration-200 ${copiedId ? 'text-green-500' : ''}`}
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
                    
                    <Tooltip.Provider>
                      <Tooltip.Root>
                        <Tooltip.Trigger asChild>
                          <button
                            onClick={() => copyToClipboard(id as string, 'link')}
                            className="text-gray-400 hover:text-blue-600 p-1 rounded-full hover:bg-blue-50 transition-colors duration-200"
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
                  <div>
                    <h3 className="text-lg font-medium text-gray-900 mb-4">Circle Details</h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      <div>
                        <p className="text-sm text-gray-500">Circle Name</p>
                        <p className="text-lg font-medium">{circle.name}</p>
                      </div>
                      
                      <div>
                        <p className="text-sm text-gray-500">Contribution Amount</p>
                        <CurrencyDisplay usd={circle.contributionAmountUsd} sui={circle.contributionAmount} />
                      </div>
                      
                      <div>
                        <p className="text-sm text-gray-500">Security Deposit</p>
                        <CurrencyDisplay usd={circle.securityDepositUsd} sui={circle.securityDeposit} />
                      </div>
                      
                      <div>
                        <p className="text-sm text-gray-500">Members</p>
                        <p className="text-lg font-medium">{circle.currentMembers} / {circle.maxMembers}</p>
                      </div>
                    </div>
                  </div>
                  
                  {/* Members Management */}
                  <div>
                    <h3 className="text-lg font-medium text-gray-900 mb-4">Members</h3>
                    <div className="overflow-hidden shadow ring-1 ring-black ring-opacity-5 md:rounded-lg">
                      <table className="min-w-full divide-y divide-gray-300">
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
                            <tr key={member.address}>
                              <td className="whitespace-nowrap py-4 pl-4 pr-3 text-sm font-medium text-gray-900 sm:pl-6">
                                {shortenAddress(member.address)} {member.address === circle.admin && <span className="text-xs text-purple-600 ml-2">(Admin)</span>}
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
                                    className="text-red-600 hover:text-red-900"
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
                  <div>
                    <h3 className="text-lg font-medium text-gray-900 mb-4">Invite New Members</h3>
                    <p className="mb-4 text-sm text-gray-500">Send the following link to people you&apos;d like to invite to your circle.</p>
                    
                    <div className="flex items-center space-x-2 bg-gray-50 p-3 rounded-md">
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
                        className="px-4 py-2 bg-blue-600 text-white rounded-md text-sm"
                      >
                        Copy
                      </button>
                    </div>
                  </div>
                  
                  {/* Pending Join Requests Section */}
                  {pendingRequests.length > 0 && (
                    <div className="mt-8">
                      <h3 className="text-lg font-medium text-gray-900 mb-4">Pending Join Requests</h3>
                      <div className="overflow-hidden shadow ring-1 ring-black ring-opacity-5 md:rounded-lg">
                        <table className="min-w-full divide-y divide-gray-300">
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
                              <tr key={`${request.circleId}-${request.userAddress}`}>
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
                                      className="text-green-600 hover:text-green-800 flex items-center"
                                    >
                                      <Check className="w-4 h-4 mr-1" />
                                      Approve
                                    </button>
                                    <button
                                      onClick={() => handleJoinRequest(request, false)}
                                      className="text-red-600 hover:text-red-800 flex items-center"
                                    >
                                      <X className="w-4 h-4 mr-1" />
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
                  <div className="pt-6 border-t border-gray-200">
                    <div className="flex flex-col space-y-4 sm:flex-row sm:space-x-4 sm:space-y-0">
                      <button
                        onClick={() => toast.success('This feature is coming soon')}
                        className="px-4 py-2 bg-yellow-500 text-white rounded-md text-sm hover:bg-yellow-600"
                      >
                        Pause Contributions
                      </button>
                      
                      <button
                        onClick={() => {
                          // Handle delete circle
                          toast.success('This feature is coming soon');
                        }}
                        className="px-4 py-2 bg-red-600 text-white rounded-md text-sm hover:bg-red-700"
                      >
                        Delete Circle
                      </button>
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