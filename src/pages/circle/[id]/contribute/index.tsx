import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { useAuth } from '../../../../contexts/AuthContext';
import Image from 'next/image';
import { SuiClient } from '@mysten/sui/client';
import { toast } from 'react-hot-toast';
import { ArrowLeft } from 'lucide-react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { priceService } from '../../../../services/price-service';

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
}

// Define a type for the fields from the SUI object
interface CircleFields {
  name: string;
  admin: string;
  contribution_amount: string;
  security_deposit: string;
  contribution_amount_usd?: string;
  security_deposit_usd?: string;
  usd_amounts: {
    fields?: {
      contribution_amount: string;
      security_deposit: string;
      target_amount?: string;
    }
    contribution_amount?: string;
    security_deposit?: string;
    target_amount?: string;
  } | string;
  // Use unknown for index signature as a safer alternative to any
  [key: string]: string | number | boolean | object | unknown;
}

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

  // Add a debug log to check the security deposit value when showing the warning
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
        
        // Get the USD amounts (contribution and security deposit)
        let contributionAmountUsd = 0;
        let securityDepositUsd = 0;
        
        // Check for nested usd_amounts structure
        if (fields.usd_amounts) {
          if (typeof fields.usd_amounts === 'object') {
            let usdAmounts: {
              fields?: {
                contribution_amount: string;
                security_deposit: string;
                target_amount?: string;
              };
              contribution_amount?: string;
              security_deposit?: string;
              target_amount?: string;
            } = fields.usd_amounts;
            
            // If it has a fields property, use that
            if (usdAmounts.fields) {
              usdAmounts = usdAmounts.fields;
            }
            
            if (usdAmounts.contribution_amount) {
              contributionAmountUsd = Number(usdAmounts.contribution_amount) / 100;
            }
            
            if (usdAmounts.security_deposit) {
              securityDepositUsd = Number(usdAmounts.security_deposit) / 100;
            }
          }
        } 
        // Fallback to direct fields
        else if (fields.contribution_amount_usd) {
          contributionAmountUsd = Number(fields.contribution_amount_usd) / 100;
        }
        
        if (fields.security_deposit_usd) {
          securityDepositUsd = Number(fields.security_deposit_usd) / 100;
        }
        
        // Now we need to find the circle's custody wallet ID
        const walletCreatedEvents = await client.queryEvents({
          query: {
            MoveEventType: '0x3b99f14240784d346918641aebe91c97dc305badcf7fbacaffbc207e6dfad8c8::njangi_circle::CustodyWalletCreated'
          },
          limit: 50
        });
        
        let walletId = null;
        
        // Look for events related to this circle
        for (const event of walletCreatedEvents.data) {
          if (event.parsedJson && 
              typeof event.parsedJson === 'object' &&
              'circle_id' in event.parsedJson &&
              'wallet_id' in event.parsedJson &&
              event.parsedJson.circle_id === id) {
            walletId = event.parsedJson.wallet_id as string;
            console.log('Found wallet ID from events:', walletId);
            break;
          }
        }

        // Parse and validate the security deposit value
        // First try directly from the blockchain value
        let securityDepositAmount = Number(fields.security_deposit) / 1e9;
        
        // Check if the security deposit is unreasonably large or zero
        if (securityDepositAmount > 1000000 || securityDepositAmount === 0) {
          console.log('Invalid security deposit from blockchain, calculating from USD value');
          
          // If the blockchain value is invalid, calculate from USD value and price
          // Using non-nullable price with fallback
          const effectiveSuiPrice = suiPrice || 1.25; // Fallback to default price if suiPrice is 0
          securityDepositAmount = securityDepositUsd / effectiveSuiPrice;
          
          console.log('Calculated security deposit amount:', {
            securityDepositUsd,
            suiPrice: effectiveSuiPrice,
            calculatedSUI: securityDepositAmount
          });
        }
        
        // Ensure we have a reasonable value
        if (isNaN(securityDepositAmount) || securityDepositAmount <= 0) {
          console.warn('Still have invalid security deposit amount, using fallback');
          // If we still have an invalid amount, calculate from USD with a default conversion
          securityDepositAmount = securityDepositUsd / 2.3; // Fallback using a common SUI price
        }
        
        setCircle({
          id: id as string,
          name: fields.name,
          contributionAmount: Number(fields.contribution_amount) / 1e9,
          contributionAmountUsd: contributionAmountUsd,
          securityDeposit: securityDepositAmount,
          securityDepositUsd: securityDepositUsd,
          admin: fields.admin,
          walletId: walletId || '',
        });
      }
    } catch (error) {
      console.error('Error fetching circle details:', error);
      toast.error('Could not load circle information');
    } finally {
      setLoading(false);
    }
  };

  const fetchUserWalletInfo = async () => {
    if (!userAddress || !circle) return;
    
    setFetchingBalance(true);
    try {
      const client = new SuiClient({ url: 'https://fullnode.testnet.sui.io:443' });
      
      // 1. Get user's SUI coins to calculate balance
      const coins = await client.getCoins({
        owner: userAddress,
        coinType: '0x2::sui::SUI'
      });
      
      // Calculate total balance
      const totalBalance = coins.data.reduce((sum, coin) => sum + Number(coin.balance), 0) / 1e9;
      setUserBalance(totalBalance);
      
      // 2. Check if the user has already paid their security deposit
      let depositPaid = false;
      
      // First method: check if the user is in the members table with a deposit
      if (circle.id) {
        const circleData = await client.getObject({
          id: circle.id,
          options: { showContent: true, showDisplay: true }
        });
        
        if (circleData.data?.content && 'fields' in circleData.data.content) {
          // Check members table in circle
          const fields = circleData.data.content.fields as {
            members?: {
              fields?: {
                table?: {
                  fields?: {
                    contents?: Array<{
                      fields?: {
                        key: string;
                        value: {
                          fields: {
                            deposit_balance: string;
                            [key: string]: unknown;
                          }
                        }
                      }
                    }>
                  }
                }
              }
            }
          };
          
          // Look for the user in the members table
          if (fields.members?.fields?.table?.fields?.contents) {
            const memberEntries = fields.members.fields.table.fields.contents;
            
            for (const entry of memberEntries) {
              if (entry.fields && entry.fields.key === userAddress) {
                // Found the user in the members table, check their deposit status
                const memberData = entry.fields.value.fields;
                
                // If deposit_balance is greater than 0, they've paid their deposit
                const depositFromMember = Number(memberData.deposit_balance) > 0;
                if (depositFromMember) {
                  depositPaid = true;
                  console.log('User deposit found in member table:', depositFromMember ? 'Paid' : 'Not Paid');
                  break;
                }
              }
            }
          }
        }
      }
      
      // Second method: Check for custody wallet deposits if we haven't found a deposit yet
      if (!depositPaid && circle.walletId) {
        console.log('Checking custody wallet for deposits...');
        
        // Query events for deposits made by this user to the custody wallet
        const custodyDepositEvents = await client.queryEvents({
          query: {
            MoveEventType: '0x3b99f14240784d346918641aebe91c97dc305badcf7fbacaffbc207e6dfad8c8::njangi_circle::CustodyDeposited'
          },
          limit: 50
        });
        
        // Process events to find deposits by this user for this circle
        for (const event of custodyDepositEvents.data) {
          if (event.parsedJson && typeof event.parsedJson === 'object') {
            const eventData = event.parsedJson as {
              circle_id?: string;
              wallet_id?: string;
              member?: string;
              amount?: string;
            };
            
            console.log('Found custody deposit event:', eventData);
            
            // Check if this deposit was made by our user to our circle's wallet
            if (eventData.circle_id === circle.id && 
                eventData.wallet_id === circle.walletId && 
                eventData.member === userAddress && 
                eventData.amount) {
              // Check if the amount is at least the required security deposit (with some margin for gas)
              const depositAmount = Number(eventData.amount) / 1e9;
              if (depositAmount >= circle.securityDeposit * 0.95) { // 5% margin for gas
                depositPaid = true;
                console.log('User deposit found in custody events:', depositAmount, 'SUI');
                break;
              }
            }
          }
        }
      }
      
      // Set final deposit status
      setUserDepositPaid(depositPaid);
      console.log('Final user deposit status:', depositPaid ? 'Paid' : 'Not Paid');
    } catch (error) {
      console.error('Error fetching user wallet info:', error);
    } finally {
      setFetchingBalance(false);
    }
  };

  const handleContribute = async () => {
    if (!circle || !userAddress) return;
    
    setIsProcessing(true);
    try {
      if (!userDepositPaid) {
        toast.error('Security deposit required before contributing');
        return;
      }
      
      if (!account) {
        toast.error('User account not available. Please log in again.');
        return;
      }
      
      toast.loading('Processing contribution...', { id: 'contribute-tx' });
      
      // Check if we can contribute directly through the custody wallet
      if (circle.walletId) {
        // Execute contribution through the custody wallet
        const result = await fetch('/api/zkLogin', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'contributeFromCustody',
            account,
            circleId: circle.id,
            walletId: circle.walletId
          }),
        });
        
        const responseData = await result.json();
        
        if (!result.ok) {
          console.error('Contribution failed:', responseData);
          toast.error(responseData.error || 'Failed to process contribution', { id: 'contribute-tx' });
          return;
        }
        
        toast.success('Contribution successful!', { id: 'contribute-tx' });
        console.log('Contribution transaction digest:', responseData.digest);
        
        // Refresh user wallet info and circle data
        fetchUserWalletInfo();
        fetchCircleDetails();
      } else {
        // If no custody wallet ID (fallback to old method)
        toast.error('Custody wallet not found for this circle', { id: 'contribute-tx' });
      }
    } catch (error) {
      console.error('Error contributing:', error);
      toast.error('Failed to process contribution');
    } finally {
      setIsProcessing(false);
    }
  };

  const handlePaySecurityDeposit = async () => {
    if (!circle || !userAddress || !circle.walletId) {
      toast.error('Circle information incomplete. Cannot process deposit.');
      return;
    }
    
    // Check if wallet balance is sufficient
    if (userBalance !== null && userBalance < circle.securityDeposit) {
      toast.error('Insufficient wallet balance to pay security deposit.');
      return;
    }
    
    setIsPayingDeposit(true);
    
    try {
      console.log('Preparing to pay security deposit of', circle.securityDeposit, 'SUI to circle:', circle.id);
      
      if (!account) {
        toast.error('User account not available. Please log in again.');
        setIsPayingDeposit(false);
        return;
      }
      
      toast.loading('Processing security deposit payment...', { id: 'pay-security-deposit' });
      
      // Execute the transaction through the API
      const response = await fetch('/api/zkLogin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'paySecurityDeposit',
          account,
          walletId: circle.walletId,
          depositAmount: Math.floor(circle.securityDeposit * 1e9)
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
  const getValidContributionAmount = () => {
    // Make sure we have a valid, reasonable number
    const contributionAmount = typeof circle?.contributionAmount === 'number' 
      ? circle.contributionAmount : 0;
    
    // Validate the amount is reasonable (not millions)
    const isValidAmount = contributionAmount > 0 && contributionAmount < 1000;
    
    // If amount seems incorrect but we have USD value, calculate from USD
    if (!isValidAmount && circle?.contributionAmountUsd && suiPrice) {
      return circle.contributionAmountUsd / suiPrice;
    }
    
    return contributionAmount;
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
                      <div className="flex justify-between items-center">
                        <div>
                          <p className="text-sm text-gray-600 mb-1">Available Balance:</p>
                          {fetchingBalance ? (
                            <div className="animate-pulse h-6 w-32 bg-gray-200 rounded"></div>
                          ) : (
                            <p className="text-lg font-semibold text-blue-700">
                              {userBalance !== null ? (
                                <CurrencyDisplay sui={userBalance} />
                              ) : (
                                'Unable to fetch balance'
                              )}
                            </p>
                          )}
                        </div>
                        <div className="text-right">
                          <p className="text-sm text-gray-600 mb-1">Wallet Address:</p>
                          <p className="text-sm font-mono bg-white px-2 py-1 rounded border border-gray-200">
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
                    </div>
                  </div>
                  
                  {/* Contribution Form */}
                  <div className="pt-6 border-t border-gray-200 px-2">
                    <h3 className="text-lg font-medium text-gray-900 mb-4 border-l-4 border-blue-500 pl-3">Make Contribution</h3>
                    <div className="bg-gray-50 p-6 rounded-lg shadow-sm">
                      <div className="mb-6">
                        <p className="text-sm text-gray-600 mb-2">You are about to contribute:</p>
                        <div className="flex items-center">
                          <span className="bg-blue-100 text-blue-800 text-xl font-semibold rounded-lg py-2 px-4">
                            ${circle.contributionAmountUsd?.toFixed(2) || '0.00'} ({getValidContributionAmount().toFixed(4)} SUI)
                          </span>
                        </div>
                      </div>

                      {/* Debug the balance comparison by logging values */}
                      {userDepositPaid && userBalance !== null && (
                        <script dangerouslySetInnerHTML={{
                          __html: `
                            console.log("Balance check:", {
                              userBalance: ${userBalance},
                              contributionAmount: ${circle.contributionAmount},
                              hasEnough: ${userBalance >= circle.contributionAmount},
                              difference: ${userBalance - circle.contributionAmount}
                            });
                          `
                        }} />
                      )}

                      {/* Show warning if balance is insufficient - only when deposit is already paid */}
                      {(() => {
                        // Skip if deposit not paid or balance not loaded
                        if (!userDepositPaid || userBalance === null) return null;
                        
                        // Get valid contribution amount
                        const validContributionAmount = getValidContributionAmount();
                        
                        // Add small buffer for transaction fees
                        const requiredWithBuffer = validContributionAmount + 0.01;
                        
                        // Only show warning if balance is insufficient
                        if (userBalance >= requiredWithBuffer) return null;
                        
                        return (
                          <div className="mb-4 p-3 bg-red-50 text-red-700 rounded-lg border border-red-200">
                            <p className="text-sm font-medium">
                              ⚠️ Your wallet balance is insufficient for this contribution.
                            </p>
                            <p className="text-xs mt-1">
                              Required: {validContributionAmount.toFixed(4)} SUI (plus a small amount for transaction fees)<br/>
                              Available: {userBalance.toFixed(4)} SUI
                            </p>
                          </div>
                        );
                      })()}

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
                                    ${circle.securityDepositUsd.toFixed(2)}
                                    <br />
                                    {circle.securityDeposit.toFixed(2)} SUI
                                  </span>
                                )}{' '}
                                before contributing.
                              </p>
                            </div>
                            
                            {/* Show combined insufficient balance warning for both security deposit and contribution */}
                            {userBalance !== null && circle && userBalance < circle.securityDeposit && (
                              <div className="p-2 bg-red-50 text-red-700 rounded border border-red-200 text-sm">
                                <p className="font-medium">Insufficient funds for security deposit</p>
                                <p className="text-xs mt-1">
                                  You need {circle.securityDeposit.toFixed(2)} SUI for the security deposit, but your balance is only {userBalance.toFixed(2)} SUI.
                                </p>
                              </div>
                            )}
                            
                            <button
                              onClick={handlePaySecurityDeposit}
                              disabled={isPayingDeposit || !circle || circle.securityDeposit <= 0 || (userBalance !== null && userBalance < circle.securityDeposit)}
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
                    
                      <button
                        onClick={handleContribute}
                        disabled={isProcessing || (userBalance !== null && userBalance < getValidContributionAmount() + 0.01) || !userDepositPaid}
                        className={`w-full flex justify-center py-3 px-4 rounded-lg shadow-sm text-sm font-medium text-white bg-gradient-to-r from-blue-600 to-blue-700 hover:from-blue-700 hover:to-blue-800 transition-all ${(isProcessing || (userBalance !== null && userBalance < getValidContributionAmount() + 0.01) || !userDepositPaid) ? 'opacity-70 cursor-not-allowed' : ''}`}
                      >
                        {isProcessing ? 'Processing...' : 'Contribute Now'}
                      </button>
                      
                      <p className="mt-3 text-xs text-center text-gray-500">
                        By contributing, you agree to the circle&apos;s terms and conditions.
                      </p>
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