import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { useAuth } from '../../../contexts/AuthContext';
import Image from 'next/image';
import { SuiClient } from '@mysten/sui/client';
import { toast } from 'react-hot-toast';
import { ArrowLeft } from 'lucide-react';
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

export default function CircleDetails() {
  const router = useRouter();
  const { id } = router.query;
  const { isAuthenticated, userAddress, account } = useAuth();
  const [loading, setLoading] = useState(true);
  const [circle, setCircle] = useState<Circle | null>(null);
  const [suiPrice, setSuiPrice] = useState(1.25); // Default price until we fetch real price

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
        
        // Get the USD amounts, checking both direct fields and potentially nested usd_amounts
        let contributionAmountUsd = 0;
        let securityDepositUsd = 0;
        
        // Check for nested usd_amounts structure (this is the new structure)
        if (fields.usd_amounts) {
          if (typeof fields.usd_amounts === 'object') {
            // It could have a nested 'fields' property or direct properties
            let usdAmounts = fields.usd_amounts as any;
            
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
      }
    } catch (error) {
      console.error('Error fetching circle details:', error);
      toast.error('Could not load circle information');
    } finally {
      setLoading(false);
    }
  };

  const formatDate = (timestamp: number) => {
    if (!timestamp) return 'Not set';
    return new Date(timestamp).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
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
    let calculatedSui: number;
    let calculatedUsd: number;
    
    if (usd !== undefined && !isNaN(usd)) {
      // If USD is provided and valid, calculate SUI based on current price
      calculatedUsd = usd;
      calculatedSui = suiPrice > 0 ? usd / suiPrice : 0;
    } else if (sui !== undefined && !isNaN(sui)) {
      // If SUI is provided and valid, calculate USD
      calculatedSui = sui;
      calculatedUsd = sui * suiPrice;
    } else {
      // Default values if neither is provided or values are invalid
      calculatedSui = 0;
      calculatedUsd = 0;
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
              <h2 className="text-xl font-semibold text-gray-900">
                Circle Details
              </h2>
              {loading ? (
                <div className="py-8 flex justify-center">
                  <svg className="animate-spin h-8 w-8 text-blue-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                </div>
              ) : circle ? (
                <div className="py-4 grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div>
                    <p className="text-sm text-gray-500">Circle Name</p>
                    <p className="text-lg font-medium">{circle.name}</p>
                  </div>
                  
                  <div>
                    <p className="text-sm text-gray-500">Admin</p>
                    <p className="text-sm font-medium text-gray-700 truncate">{circle.admin}</p>
                  </div>
                  
                  <div>
                    <p className="text-sm text-gray-500">Contribution Amount</p>
                    <p className="text-lg font-medium">
                      <CurrencyDisplay usd={circle.contributionAmountUsd} sui={circle.contributionAmount} />
                    </p>
                  </div>
                  
                  <div>
                    <p className="text-sm text-gray-500">Security Deposit</p>
                    <p className="text-lg font-medium">
                      <CurrencyDisplay usd={circle.securityDepositUsd} sui={circle.securityDeposit} />
                    </p>
                  </div>
                  
                  <div>
                    <p className="text-sm text-gray-500">Members</p>
                    <p className="text-lg font-medium">{circle.currentMembers} / {circle.maxMembers}</p>
                  </div>
                  
                  <div>
                    <p className="text-sm text-gray-500">Next Payout</p>
                    <p className="text-lg font-medium">{formatDate(circle.nextPayoutTime)}</p>
                  </div>
                  
                  <div className="md:col-span-2 pt-4">
                    <div className="flex space-x-4">
                      <button
                        onClick={() => router.push(`/circle/${circle.id}/contribute`)}
                        className="flex-1 py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
                      >
                        Contribute
                      </button>
                      
                      {circle.admin === userAddress && (
                        <button
                          onClick={() => router.push(`/circle/${circle.id}/manage`)}
                          className="flex-1 py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-purple-600 hover:bg-purple-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-purple-500"
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