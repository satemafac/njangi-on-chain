// YieldStrategySection.tsx - Main section for yield management in Circle Management interface

import React, { useState, useEffect } from 'react';
import { YieldStrategy } from './types/yield.types';
import { StrategySelector } from './components/StrategySelector';
import { STRATEGY_CONFIGS } from './config/strategies';

import ConfirmationModal from '../ConfirmationModal';
import { priceService } from '../../services/price-service';
import { yieldTrackingService, TrackedYieldData } from '../../services/yield-tracking-service';
import { getCurrentCetusConfig } from '../../services/network-config';



interface YieldStrategySectionProps {
  currentStrategy?: YieldStrategy;
  onStrategyChange?: (strategy: YieldStrategy) => void;
  totalSecurityDeposits?: number;
  isLoading?: boolean;
  disabled?: boolean;
  walletId?: string; // Add wallet ID for fetching real yield data
  circleId?: string; // Add circle ID for contract calls
  userAddress?: string; // Add user address for yield tracking
  onYieldConfigCreated?: () => void; // Add callback for when yield config is successfully created
  packageId?: string; // Add package ID for multi-package support
}

// Type definitions for API responses
interface YieldConfigResult {
  txHash: string;
  digest: string;
  status: string;
  yieldStrategy?: string;
  nextStep?: string;
  configId?: string;
  details?: {
    expectedAPY?: string;
    autoCompound?: boolean;
    naviAllocation?: string;
  };
}

export const YieldStrategySection: React.FC<YieldStrategySectionProps> = ({
  currentStrategy = 'conservative', // Default to conservative strategy
  onStrategyChange,
  totalSecurityDeposits = 0,
  isLoading = false,
  disabled = false,
  walletId,
  circleId,
  userAddress,
  onYieldConfigCreated,
  packageId
}) => {
  const [selectedStrategy, setSelectedStrategy] = useState<YieldStrategy>(currentStrategy);
  const [isChangingStrategy, setIsChangingStrategy] = useState(false);
  
  // Add states for yield tracking
  const [trackedYields, setTrackedYields] = useState<TrackedYieldData[]>([]);
  const [isLoadingYieldData, setIsLoadingYieldData] = useState(true);
  const [yieldDataError, setYieldDataError] = useState<string | null>(null);
  const [lastYieldUpdate, setLastYieldUpdate] = useState<Date | null>(null);
  
  // Add states for liquidity management
  const [isAddingLiquidity, setIsAddingLiquidity] = useState(false);
  const [addLiquidityError, setAddLiquidityError] = useState<string | null>(null);
  
  // Add modal states for confirmation
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [confirmModalData, setConfirmModalData] = useState<{
    title: string;
    message: string | React.ReactNode;
    onConfirm: () => void;
    confirmText?: string;
    variant?: 'primary' | 'danger' | 'warning';
  } | null>(null);
  
  // Add state for live SUI price
  const [currentSuiPrice, setCurrentSuiPrice] = useState<number>(2.5); // Default fallback

  // Add state for strategy selection during creation
  const [selectedStrategyForCreation, setSelectedStrategyForCreation] = useState<YieldStrategy>('conservative');

  // Update local state when props change
  useEffect(() => {
    setSelectedStrategy(currentStrategy);
  }, [currentStrategy]);

  // Fetch live SUI price on component mount
  useEffect(() => {
    const fetchSuiPrice = async () => {
      try {
        const price = await priceService.getSUIPrice();
        if (price) {
          setCurrentSuiPrice(price);
        }
      } catch (error) {
        console.error('Error fetching SUI price:', error);
        // Keep default fallback price of 2.5
      }
    };

    fetchSuiPrice();
  }, []);

  // Fetch yield data
  useEffect(() => {
    const fetchYieldData = async () => {
      if (!userAddress) {
        setIsLoadingYieldData(false);
        return;
      }

      setIsLoadingYieldData(true);
      setYieldDataError(null);

      try {
        // Use the new dynamic method with custody wallet and circle filtering
        console.log('Fetching yield data with parameters:', {
          userAddress,
          custodyWalletId: walletId,
          circleId
        });
        
        const allYieldData = await yieldTrackingService.getAllUserYieldData(userAddress, walletId, circleId);
        console.log('Yield data found for circle:', allYieldData);
        
        setTrackedYields(allYieldData);
        setLastYieldUpdate(new Date());
      } catch (err) {
        console.error('Error fetching yield data:', err);
        setYieldDataError(err instanceof Error ? err.message : 'Failed to load yield data');
      } finally {
        setIsLoadingYieldData(false);
      }
    };

    fetchYieldData();
  }, [userAddress, walletId, circleId]);



  const handleStrategySelect = async (strategy: YieldStrategy) => {
    if (disabled || isChangingStrategy) return;

    try {
      setIsChangingStrategy(true);
      setSelectedStrategy(strategy);
      
      // Call the parent callback to handle the actual strategy change
      if (onStrategyChange) {
        await onStrategyChange(strategy);
      }
    } catch (error) {
      console.error('Failed to change yield strategy:', error);
      // Revert selection on error
      setSelectedStrategy(currentStrategy);
    } finally {
      setIsChangingStrategy(false);
    }
  };

  // Handler for adding liquidity to Cetus with strategy selection
  const handleAddLiquidityToCetus = async () => {
    if (!walletId || !circleId || disabled) return;

    setIsAddingLiquidity(true);
    setAddLiquidityError(null);

    try {
      // Calculate optimal liquidity amounts based on available security deposits
      const suiAmount = Math.floor(totalSecurityDeposits); // Use 100% of security deposits
      
      // Use current SUI price from state (already fetched and kept updated)
      const minUsdcAmount = suiAmount * currentSuiPrice; // Use live price for USDC equivalent
      
      // Handle insufficient funds gracefully
      if (suiAmount < 1) {
        setAddLiquidityError('Insufficient security deposits for yield configuration. Circle needs active members with security deposits.');
        setIsAddingLiquidity(false);
        return;
      }

      // Get strategy configuration for display
      const strategyConfig = STRATEGY_CONFIGS[selectedStrategyForCreation];

      // Prepare the yield configuration transaction
      console.log('Preparing yield configuration transaction:', {
        circleId: circleId,
        custodyWalletId: walletId,
        suiAmount,
        estimatedUsdcAmount: minUsdcAmount,
        suiPriceUsed: currentSuiPrice,
        selectedStrategy: selectedStrategyForCreation
      });

      // Use Cetus service to prepare the transaction
      const poolId = getCurrentCetusConfig().pools.SUI_USDC; // SUI-USDC pool
      
      // Store transaction details for modal confirmation
      const handleConfirmTransaction = async () => {
        try {
          setIsAddingLiquidity(true);
          setShowConfirmModal(false); // Close the confirmation modal
          
          // Get the current user session and account data
          const account = JSON.parse(localStorage.getItem('account') || '{}');
          if (!account.userAddr) {
            throw new Error('No authenticated user found. Please log in first.');
          }

          console.log('Initiating yield configuration transaction:', {
            userAddress: account.userAddr,
            circleId: circleId,
            custodyWalletId: walletId,
            suiAmount,
            estimatedUsdcAmount: minUsdcAmount,
            suiPrice: currentSuiPrice,
            strategy: selectedStrategyForCreation
          });

          // Prepare the yield integration transaction
          const transactionData = {
            action: 'addCetusLiquidity',
            account,
            packageId: packageId, // Include the circle's package ID
            yieldData: {
              sui_amount: (suiAmount * 1e9).toString(), // Convert to MIST (base units)
              usdc_amount: (minUsdcAmount * 1e6).toString(), // Convert to base units
              pool_id: poolId,
              circle_id: circleId, // Use the actual Circle object ID
              custody_wallet_id: walletId, // Use the custody wallet ID from props
              tick_lower: -60000, // Wide range
              tick_upper: 60000,   // Wide range
              slippage_tolerance: 50, // 0.5% in basis points
              total_security_deposits: totalSecurityDeposits, // Pass the actual total
              strategy: selectedStrategyForCreation, // Include selected strategy
              package_id: packageId // Also include in yieldData for backward compatibility
            }
          };

          // Send transaction via zkLogin API
          const response = await fetch('/api/zkLogin', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(transactionData)
          });

          const result = await response.json();

          if (!response.ok) {
            throw new Error(result.error || 'Transaction failed');
          }

          // Success! Show success modal
          setConfirmModalData({
            title: '🎉 Yield Configuration Created Successfully!',
            message: (
              <div className="space-y-3">
                <p className="text-green-700">Your yield integration foundation has been established!</p>
                <div className="bg-green-50 p-3 rounded-lg">
                  <h4 className="font-medium text-green-900 mb-2">Configuration Details:</h4>
                  <ul className="text-sm text-green-800 space-y-1">
                    <li>• Strategy: {strategyConfig.displayName} ({result.yieldStrategy || strategyConfig.apy})</li>
                    <li>• Expected APY: {result.details?.expectedAPY || strategyConfig.apy}</li>
                    <li>• Auto-Compound: {result.details?.autoCompound ? 'Enabled' : 'Disabled'}</li>
                    <li>• NAVI Allocation: {result.details?.naviAllocation || strategyConfig.allocation.navi + '%'}</li>
                    <li>• Cetus Allocation: {strategyConfig.allocation.cetus}%</li>
                    <li>• Configuration ID: {result.configId || 'Generated'}</li>
                  </ul>
                </div>
                <div className="bg-blue-50 p-3 rounded-lg">
                  <h4 className="font-medium text-blue-900 mb-2">Next Step:</h4>
                  <p className="text-sm text-blue-800">
                    {result.nextStep || 'Processing security deposits for yield generation...'}
                  </p>
                </div>
                <div className="text-xs text-gray-500">
                  <strong>Transaction Hash:</strong> {result.txHash}
                </div>
              </div>
            ),
            confirmText: 'Process Security Deposits',
            onConfirm: async () => {
              // Step 2: Process the actual security deposits
              await processSecurityDeposits(result);
            }
          });
          setShowConfirmModal(true);

        } catch (error) {
          console.error('Transaction failed:', error);
          setAddLiquidityError(error instanceof Error ? error.message : 'Failed to add liquidity');
          
          // Check if it's an insufficient balance error
          const isInsufficientBalance = error instanceof Error && 
            (error.message.includes('InsufficientCoinBalance') || 
             error.message.includes('Insufficient SUI balance'));
          
          // Show error modal
          setConfirmModalData({
            title: '❌ Transaction Failed',
            message: (
              <div className="space-y-3">
                <p className="text-red-700">
                  {isInsufficientBalance 
                    ? 'Transaction failed due to insufficient SUI balance.' 
                    : 'Failed to add liquidity to Cetus pool.'}
                </p>
                <div className="bg-red-50 p-3 rounded-lg">
                  <p className="text-sm text-red-800">
                    <strong>Error:</strong> {error instanceof Error ? error.message : 'Unknown error occurred'}
                  </p>
                </div>
                {isInsufficientBalance ? (
                  <div className="bg-yellow-50 p-3 rounded-lg">
                    <h4 className="font-medium text-yellow-900 mb-2">💡 How to fix this:</h4>
                    <ul className="text-sm text-yellow-800 space-y-1">
                      <li>• Get SUI from the testnet faucet: <a href="https://discord.gg/sui" target="_blank" rel="noopener noreferrer" className="underline">Sui Discord #devnet-faucet</a></li>
                      <li>• You need at least 0.2 SUI total (for gas + demonstration)</li>
                      <li>• Current demonstration uses only 0.1 SUI + gas fees</li>
                      <li>• In production, this would use your full security deposit balance</li>
                    </ul>
                  </div>
                ) : (
                  <p className="text-sm text-gray-600">
                    Please check your account status and try again. Make sure you&apos;re connected to testnet.
                  </p>
                )}
              </div>
            ),
            onConfirm: () => {},
            confirmText: isInsufficientBalance ? 'Get Testnet SUI' : 'Try Again',
            variant: 'danger'
          });
          setShowConfirmModal(true);
        } finally {
          setIsAddingLiquidity(false);
        }
      };

      // Show the confirmation modal with strategy selection
      setConfirmModalData({
        title: '🚀 Create Yield Configuration for Circle',
        message: (
          <div className="space-y-4">
            <div className="bg-blue-50 p-4 rounded-lg">
              <h4 className="font-medium text-blue-900 mb-2">Yield Configuration Setup:</h4>
              <ul className="text-sm text-blue-800 space-y-1">
                <li>• Strategy: {strategyConfig.displayName} ({strategyConfig.apy})</li>
                <li>• Risk Level: {strategyConfig.risk}</li>
                <li>• Auto-Compound: Enabled</li>
                <li>• Available Security Deposits: {totalSecurityDeposits.toFixed(2)} SUI</li>
                <li>• NAVI Allocation: {strategyConfig.allocation.navi}%</li>
                <li>• Cetus Allocation: {strategyConfig.allocation.cetus}%</li>
              </ul>
            </div>
            <div className="bg-green-50 p-4 rounded-lg">
              <h4 className="font-medium text-green-900 mb-2">This will:</h4>
              <ul className="text-sm text-green-800 space-y-1">
                <li>✅ Create the yield configuration for your circle</li>
                <li>✅ Enable security deposits to start earning real yield</li>
                <li>✅ Set up automated compound earnings</li>
                <li>✅ Prepare the foundation for DeFi integration</li>
              </ul>
            </div>
            <div className="bg-yellow-50 p-3 rounded-lg">
              <p className="text-sm text-yellow-800">
                <strong>Note:</strong> This creates the configuration foundation. Once members join and pay security deposits, 
                those deposits will automatically start generating yield through the selected strategy.
              </p>
            </div>
          </div>
        ),
        onConfirm: handleConfirmTransaction,
        confirmText: 'Proceed with zkLogin Transaction',
        variant: 'primary'
      });
      setShowConfirmModal(true);
      
    } catch (error) {
      console.error('Error preparing add liquidity:', error);
      setAddLiquidityError(error instanceof Error ? error.message : 'Failed to prepare liquidity addition');
    } finally {
      setIsAddingLiquidity(false);
    }
  };

  const calculatePotentialEarnings = (strategy: YieldStrategy, principal: number) => {
    const config = STRATEGY_CONFIGS[strategy];
    const apyNumber = parseFloat(config.apy.replace('%', '').replace('+', ''));
    const monthlyRate = apyNumber / 100 / 12;
    return principal * monthlyRate;
  };

  const currentConfig = STRATEGY_CONFIGS[selectedStrategy];
  const potentialMonthlyEarnings = calculatePotentialEarnings(selectedStrategy, totalSecurityDeposits);

  const processSecurityDeposits = async (configResult: YieldConfigResult) => {
    try {
      setIsAddingLiquidity(true);
      setAddLiquidityError(null);
      
      console.log('Processing security deposits for yield generation...');
      console.log('Config result from previous step:', configResult);
      
      // Extract the real YieldConfig ID from the transaction result
      const configId = await findYieldConfigId(configResult.txHash);
      
      if (!configId) {
        throw new Error('Could not find YieldConfig ID from transaction. Please try again.');
      }
      
      console.log('Found YieldConfig ID:', configId);
      
      // Calculate deposit amount - use ALL available security deposits for maximum yield
      const depositAmountSui = totalSecurityDeposits || 0.1; // Use full security deposit amount
      const depositAmountMist = Math.floor(depositAmountSui * 1e9); // Convert to MIST
      
      console.log(`Processing ALL security deposits for yield: ${depositAmountSui} SUI (${depositAmountMist} MIST)`);
      
      // Prepare security deposit processing transaction
      const processTransactionData = {
        action: 'processSecurityDeposits',
        account: JSON.parse(localStorage.getItem('account') || '{}'),
        packageId: packageId, // Include the circle's package ID
        yieldData: {
          config_id: configId,
          circle_id: circleId,
          custody_wallet_id: walletId,
          deposit_amount: depositAmountMist.toString(),
          total_security_deposits: totalSecurityDeposits,
          expected_apy: '12-18%',
          strategy: 'Cetus Liquidity Provision',
          package_id: packageId // Also include in yieldData for backward compatibility
        }
      };

      console.log('Sending security deposit processing request:', processTransactionData);

      const response = await fetch('/api/zkLogin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(processTransactionData),
      });

      const processResult = await response.json();

      if (response.ok && processResult.status === 'success') {
        // Success! Security deposits are now earning yield
        
        // Trigger the refresh callback immediately upon success
        if (onYieldConfigCreated) {
          console.log('Triggering yield config created callback for refresh...');
          onYieldConfigCreated();
        }
        
        setConfirmModalData({
          title: '🎉 Security Deposits Now Earning Yield!',
          message: (
            <div className="space-y-3">
              <p className="text-green-700">Your security deposits are now generating real yield!</p>
              <div className="bg-green-50 p-3 rounded-lg">
                <h4 className="font-medium text-green-900 mb-2">Yield Generation Active:</h4>
                <ul className="text-sm text-green-800 space-y-1">
                  <li>• Deposit Amount: {depositAmountSui} SUI</li>
                  <li>• Strategy: {processResult.yieldDetails?.strategy || 'Cetus Liquidity Provision'}</li>
                  <li>• Expected APY: {processResult.yieldDetails?.expectedAPY || '12-18%'}</li>
                  <li>• Pool Type: {processResult.yieldDetails?.poolType || 'SUI/USDC LP'}</li>
                  <li>• Status: {processResult.yieldDetails?.startedEarning ? '✅ Earning' : '⏳ Setting up'}</li>
                </ul>
              </div>
              <div className="bg-blue-50 p-3 rounded-lg">
                <h4 className="font-medium text-blue-900 mb-2">What&apos;s Happening:</h4>
                <p className="text-sm text-blue-800">
                  Your SUI has been deposited into yield-generating protocols and will start earning returns immediately. 
                  Yield will compound automatically according to your strategy.
                </p>
              </div>
              <div className="text-xs text-gray-500">
                <strong>Transaction Hash:</strong> {processResult.txHash}
              </div>
            </div>
          ),
          confirmText: 'Done',
          onConfirm: () => {
            setConfirmModalData(null);
          }
        });
      } else {
        throw new Error(processResult.error || 'Failed to process security deposits');
      }

    } catch (error) {
      console.error('Security deposit processing error:', error);
      setAddLiquidityError(
        error instanceof Error 
          ? `Security deposit processing failed: ${error.message}` 
          : 'Failed to process security deposits for yield generation'
      );
      setConfirmModalData(null);
    } finally {
      setIsAddingLiquidity(false);
    }
  };

  // Helper function to find YieldConfig ID from transaction events
  const findYieldConfigId = async (txHash: string): Promise<string | null> => {
    try {
      console.log('[findYieldConfigId] Starting search for YieldConfig ID in transaction:', txHash);
      console.log('[findYieldConfigId] Using packageId:', packageId);
      
      // Query the transaction to get the created objects
      const response = await fetch(`https://fullnode.testnet.sui.io:443`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'sui_getTransactionBlock',
          params: [
            txHash,
            {
              showEvents: true,
              showObjectChanges: true
            }
          ]
        })
      });

      const data = await response.json();
      console.log('[findYieldConfigId] Transaction data received:', JSON.stringify(data, null, 2));
      
      // Look for YieldConfig creation in events
      if (data.result?.events) {
        console.log('[findYieldConfigId] Found events:', data.result.events.length);
        
        const expectedEventType = packageId 
          ? `${packageId}::njangi_yield_integration::YieldConfigCreated`
          : 'YieldConfigCreated';
        
        console.log('[findYieldConfigId] Looking for event type:', expectedEventType);
        
        // Log all event types for debugging
        data.result.events.forEach((event: { type?: string; parsedJson?: unknown }, index: number) => {
          console.log(`[findYieldConfigId] Event ${index}:`, {
            type: event.type,
            parsedJson: event.parsedJson
          });
        });
        
        const yieldConfigEvent = data.result.events.find((event: {
          type?: string;
          parsedJson?: { config_id?: string };
        }) => 
          packageId 
            ? event.type === expectedEventType
            : event.type?.includes('YieldConfigCreated')
        );
        
        if (yieldConfigEvent?.parsedJson?.config_id) {
          console.log('[findYieldConfigId] Found YieldConfig ID in events:', yieldConfigEvent.parsedJson.config_id);
          return yieldConfigEvent.parsedJson.config_id;
        } else {
          console.log('[findYieldConfigId] No matching YieldConfigCreated event found');
        }
      } else {
        console.log('[findYieldConfigId] No events found in transaction');
      }

      // Look for YieldConfig creation in object changes
      if (data.result?.objectChanges) {
        console.log('[findYieldConfigId] Found object changes:', data.result.objectChanges.length);
        
        const expectedObjectType = packageId 
          ? `${packageId}::njangi_yield_integration::YieldConfig`
          : 'YieldConfig';
        
        console.log('[findYieldConfigId] Looking for object type:', expectedObjectType);
        
        // Log all object changes for debugging
        data.result.objectChanges.forEach((change: { type?: string; objectType?: string; objectId?: string }, index: number) => {
          console.log(`[findYieldConfigId] Object change ${index}:`, {
            type: change.type,
            objectType: change.objectType,
            objectId: change.objectId
          });
        });
        
        const yieldConfigObject = data.result.objectChanges.find((change: {
          type?: string;
          objectType?: string;
          objectId?: string;
        }) => 
          change.type === 'created' && (
            packageId 
              ? change.objectType === expectedObjectType
              : change.objectType?.includes('YieldConfig')
          )
        );
        
        if (yieldConfigObject?.objectId) {
          console.log('[findYieldConfigId] Found YieldConfig ID in object changes:', yieldConfigObject.objectId);
          return yieldConfigObject.objectId;
        } else {
          console.log('[findYieldConfigId] No matching YieldConfig object change found');
        }
      } else {
        console.log('[findYieldConfigId] No object changes found in transaction');
      }

      console.log('[findYieldConfigId] YieldConfig ID not found, returning null');
      return null;
    } catch (error) {
      console.error('[findYieldConfigId] Error finding YieldConfig ID:', error);
      return null;
    }
  };

  if (isLoading) {
    return (
      <div className="bg-white rounded-lg border border-gray-200 p-6">
        <div className="animate-pulse">
          <div className="h-6 bg-gray-200 rounded w-1/3 mb-4"></div>
          <div className="h-4 bg-gray-200 rounded w-2/3 mb-6"></div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-64 bg-gray-200 rounded-lg"></div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-2xl sm:rounded-lg border border-gray-200 p-4 sm:p-6 space-y-6 sm:space-y-6">
      {/* Pro Tips - Mobile Friendly */}
      <div className="bg-gradient-to-r from-yellow-50 to-orange-50 border border-yellow-200 rounded-xl p-4 md:p-6">
        <div className="flex items-start space-x-3">
          <div className="flex-shrink-0 mt-1">
            <div className="w-8 h-8 md:w-6 md:h-6 bg-gradient-to-r from-yellow-400 to-orange-400 rounded-full flex items-center justify-center">
              <svg className="w-4 h-4 md:w-3 md:h-3 text-white font-bold" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-8-3a1 1 0 00-.867.5 1 1 0 11-1.731-1A3 3 0 0113 8a3.001 3.001 0 01-2 2.83V11a1 1 0 11-2 0v-1a1 1 0 011-1 1 1 0 100-2zm0 8a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
              </svg>
            </div>
          </div>
          <div className="flex-1 min-w-0">
            <h4 className="text-base md:text-sm font-semibold text-yellow-800 mb-3 md:mb-2">💡 Yield Strategy Tips</h4>
            <div className="space-y-2 text-sm md:text-xs text-yellow-700">
              <div className="flex items-start space-x-2">
                <span className="text-yellow-500 mt-1">•</span>
                                 <span>Start with Conservative strategy if you&apos;re new to DeFi</span>
              </div>
              <div className="flex items-start space-x-2">
                <span className="text-yellow-500 mt-1">•</span>
                <span><strong>Real-time APR:</strong> Rates from live Cetus DEX analytics</span>
                </div>
              <div className="flex items-start space-x-2">
                <span className="text-yellow-500 mt-1">•</span>
                <span>Change strategies anytime without penalties</span>
              </div>
              <div className="flex items-start space-x-2">
                <span className="text-yellow-500 mt-1">•</span>
                <span>All earnings distributed to circle members automatically</span>
            </div>
            </div>
          </div>
        </div>
      </div>

      {/* Combined Yield Tracking and Configuration Section */}
      {walletId && userAddress && (
        <div className="space-y-6">
          {/* Show Active Yield Positions if they exist */}
          {!isLoadingYieldData && trackedYields.length > 0 && (
            <div className="bg-white rounded-lg border border-gray-200 p-6 space-y-6">
              {/* Header */}
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-2">
                  <div className="w-8 h-8 bg-gradient-to-r from-green-500 to-blue-500 rounded-full flex items-center justify-center">
                    <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
                    </svg>
                  </div>
                  <h3 className="text-lg font-semibold text-gray-900">Your Active Yield Positions</h3>
                  <span className="px-2 py-1 text-xs font-medium bg-green-100 text-green-800 rounded-full">
                    {trackedYields.length} Active
                  </span>
                </div>
                {lastYieldUpdate && (
                  <div className="text-xs text-gray-500">
                    Updated: {lastYieldUpdate.toLocaleTimeString()}
                  </div>
                )}
              </div>

              {/* Summary Cards - Mobile Optimized */}
              {(() => {
                const totalValue = trackedYields.reduce((sum, data) => sum + data.positionValue.current, 0);
                const totalEarnings = trackedYields.reduce((sum, data) => sum + data.earnings.totalEarned, 0);
                const totalInitial = trackedYields.reduce((sum, data) => sum + data.positionValue.initial, 0);
                const averageAPR = trackedYields.length > 0 
                  ? trackedYields.reduce((sum, data) => sum + data.earnings.currentAPR, 0) / trackedYields.length
                  : 0;

                return (
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6">
                    <div className="bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-200 rounded-2xl p-5 sm:p-4 text-center">
                      <div className="text-sm sm:text-xs text-gray-600 mb-2 sm:mb-1">Total Value</div>
                      <div className="font-bold text-2xl sm:text-xl text-blue-600 mb-1">{totalValue.toFixed(6)} SUI</div>
                      <div className="text-sm sm:text-xs text-gray-500">${(totalValue * currentSuiPrice).toFixed(2)}</div>
                    </div>
                    
                    <div className="bg-gradient-to-r from-green-50 to-emerald-50 border border-green-200 rounded-2xl p-5 sm:p-4 text-center">
                      <div className="text-sm sm:text-xs text-gray-600 mb-2 sm:mb-1">Total Earnings</div>
                      <div className="font-bold text-2xl sm:text-xl text-green-600 mb-1">+{totalEarnings.toFixed(6)} SUI</div>
                      <div className="text-sm sm:text-xs text-gray-500">${(totalEarnings * currentSuiPrice).toFixed(2)}</div>
                    </div>
                    
                    <div className="bg-gradient-to-r from-purple-50 to-pink-50 border border-purple-200 rounded-2xl p-5 sm:p-4 text-center">
                      <div className="text-sm sm:text-xs text-gray-600 mb-2 sm:mb-1">Growth</div>
                      <div className="font-bold text-2xl sm:text-xl text-purple-600 mb-1">
                        {(totalInitial > 0 ? (totalEarnings / totalInitial) * 100 : 0).toFixed(2)}%
                      </div>
                      <div className="text-sm sm:text-xs text-gray-500">Total return</div>
                    </div>
                    
                    <div className="bg-gradient-to-r from-orange-50 to-red-50 border border-orange-200 rounded-2xl p-5 sm:p-4 text-center">
                      <div className="text-sm sm:text-xs text-gray-600 mb-2 sm:mb-1">Avg APR</div>
                      <div className="font-bold text-2xl sm:text-xl text-orange-600 mb-1">{averageAPR.toFixed(2)}%</div>
                      <div className="text-sm sm:text-xs text-gray-500">Current rate</div>
                    </div>
                  </div>
                );
              })()}

              {/* Individual Position Details - Mobile Optimized */}
              <div className="space-y-4 sm:space-y-6">
                <h4 className="text-lg sm:text-md font-semibold text-gray-900">Position Details</h4>
                {trackedYields.map((yieldData, index) => (
                  <div key={yieldData.position.yieldReceiptId} className="border border-gray-200 rounded-2xl p-5 sm:p-4 bg-gray-50/30">
                    {/* Header - Mobile Optimized */}
                    <div className="flex items-start justify-between mb-4 sm:mb-3">
                      <div className="flex items-start space-x-3">
                        <div className="w-8 h-8 sm:w-6 sm:h-6 bg-gradient-to-r from-blue-500 to-purple-500 rounded-full flex items-center justify-center flex-shrink-0 mt-1 sm:mt-0">
                          <span className="text-sm sm:text-xs font-medium text-white">{index + 1}</span>
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="font-semibold text-base sm:text-sm text-gray-900">
                            {yieldData.position.strategy === 0 ? 'Conservative' : 
                             yieldData.position.strategy === 1 ? 'Balanced' : 'Aggressive'} Strategy
                          </div>
                          <div className="text-sm sm:text-xs text-gray-500 truncate">
                            Receipt: {yieldData.position.yieldReceiptId.slice(0, 12)}...
                          </div>
                        </div>
                      </div>
                      <span className="px-3 py-1.5 sm:px-2 sm:py-1 text-sm sm:text-xs font-medium rounded-full bg-green-100 text-green-800 flex-shrink-0">
                        ACTIVE
                      </span>
                    </div>

                    {/* Key Metrics - Mobile Stack */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-3 mb-5 sm:mb-4">
                      <div className="bg-white rounded-xl p-4 sm:p-3 border border-gray-100">
                        <div className="text-sm sm:text-xs text-gray-600 mb-1">Initial Deposit</div>
                        <div className="font-bold text-lg sm:text-base text-gray-900">{yieldData.position.totalDeposit.toFixed(6)} SUI</div>
                        <div className="text-sm sm:text-xs text-gray-500">${(yieldData.position.totalDeposit * currentSuiPrice).toFixed(2)}</div>
                      </div>
                      
                      <div className="bg-white rounded-xl p-4 sm:p-3 border border-gray-100">
                        <div className="text-sm sm:text-xs text-gray-600 mb-1">Current Value</div>
                        <div className="font-bold text-lg sm:text-base text-blue-600">{yieldData.positionValue.current.toFixed(6)} SUI</div>
                        <div className="text-sm sm:text-xs text-gray-500">${(yieldData.positionValue.current * currentSuiPrice).toFixed(2)}</div>
                      </div>
                      
                      <div className="bg-white rounded-xl p-4 sm:p-3 border border-gray-100">
                        <div className="text-sm sm:text-xs text-gray-600 mb-1">Earnings</div>
                        <div className="font-bold text-lg sm:text-base text-green-600">+{yieldData.earnings.totalEarned.toFixed(6)} SUI</div>
                        <div className="text-sm sm:text-xs text-gray-500">
                          C: {yieldData.earnings.cetusEarnings.toFixed(4)} | N: {yieldData.earnings.naviEarnings.toFixed(4)}
                        </div>
                      </div>
                      
                      <div className="bg-white rounded-xl p-4 sm:p-3 border border-gray-100">
                        <div className="text-sm sm:text-xs text-gray-600 mb-1">APR</div>
                        <div className="font-bold text-lg sm:text-base text-orange-600">{yieldData.earnings.currentAPR.toFixed(2)}%</div>
                        <div className="text-sm sm:text-xs text-gray-500">
                          +{yieldData.earnings.projectedMonthly.toFixed(4)} SUI/mo
                        </div>
                      </div>
                    </div>

                    {/* Detailed Info - Collapsible on Mobile */}
                    <details className="group">
                      <summary className="flex items-center justify-between cursor-pointer list-none p-3 sm:p-2 bg-white rounded-xl border border-gray-100 hover:bg-gray-50 transition-colors">
                        <span className="text-sm sm:text-xs font-medium text-gray-700">Strategy & Position Details</span>
                        <svg className="w-5 h-5 sm:w-4 sm:h-4 text-gray-400 group-open:rotate-180 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                        </svg>
                      </summary>
                      <div className="mt-3 p-4 sm:p-3 bg-white rounded-xl border border-gray-100 space-y-4 sm:space-y-3">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-3">
                        <div>
                            <span className="text-sm sm:text-xs font-medium text-gray-700 block mb-2">Strategy Allocation:</span>
                            <div className="space-y-1 text-sm sm:text-xs text-gray-600">
                              <div className="flex justify-between">
                                <span>Cetus:</span>
                                <span className="font-medium">{yieldData.position.cetusAmount.toFixed(6)} SUI ({((yieldData.position.cetusAmount / yieldData.position.totalDeposit) * 100).toFixed(1)}%)</span>
                          </div>
                              <div className="flex justify-between">
                                <span>NAVI:</span>
                                <span className="font-medium">{yieldData.position.naviAmount.toFixed(6)} SUI ({((yieldData.position.naviAmount / yieldData.position.totalDeposit) * 100).toFixed(1)}%)</span>
                          </div>
                        </div>
                          </div>
                          <div>
                            <span className="text-sm sm:text-xs font-medium text-gray-700 block mb-2">Position Info:</span>
                            <div className="space-y-1 text-sm sm:text-xs text-gray-600">
                              <div className="flex justify-between">
                                <span>Auto-compound:</span>
                                <span className="font-medium">{yieldData.position.autoCompound ? 'Yes' : 'No'}</span>
                          </div>
                              <div className="flex justify-between">
                                <span>Created:</span>
                                <span className="font-medium">{new Date(yieldData.position.timestamp).toLocaleDateString()}</span>
                        </div>
                      </div>
                    </div>
                        </div>
                      </div>
                    </details>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Configuration Setup - Mobile Optimized */}
          {!isLoadingYieldData && (
            <div className="bg-gradient-to-r from-blue-50 to-purple-50 border border-blue-200 rounded-2xl p-6 sm:p-8">
              <div className="text-center">
                <div className="text-gray-600 text-base sm:text-sm mb-6 sm:mb-4 leading-relaxed">
                  {disabled 
                    ? "Yield management will be available once the circle administrator activates the circle."
                    : totalSecurityDeposits === 0
                    ? trackedYields.length > 0
                      ? "Waiting for new security deposits. Your existing positions continue earning yield!"
                      : "No security deposits available. Circle members need to join and pay security deposits before yield generation can begin."
                    : trackedYields.length > 0
                    ? "Create additional yield configurations or modify existing strategies for your security deposits."
                    : "No yield configuration found. Set up real DeFi yield generation for your security deposits!"
                  }
                </div>
                
                {/* Strategy Selection - Mobile Optimized */}
                {!disabled && totalSecurityDeposits > 0 && trackedYields.length === 0 && (
                  <div className="mb-8 sm:mb-6">
                    <h4 className="text-lg sm:text-sm font-semibold sm:font-medium text-gray-700 mb-4 sm:mb-3">Select Your Yield Strategy</h4>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 sm:gap-3">
                      {Object.entries(STRATEGY_CONFIGS).map(([key, config]) => (
                        <button
                          key={key}
                          onClick={() => setSelectedStrategyForCreation(key as YieldStrategy)}
                          className={`p-5 sm:p-3 rounded-2xl sm:rounded-lg border-2 transition-all duration-200 ${
                            selectedStrategyForCreation === key
                              ? 'border-blue-500 bg-blue-50 text-blue-700 shadow-lg sm:shadow-none'
                              : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300 hover:shadow-md'
                          }`}
                        >
                          <div className="text-base sm:text-sm font-semibold sm:font-medium">{config.displayName}</div>
                          <div className="text-sm sm:text-xs text-gray-500 mt-2 sm:mt-1 font-medium">{config.apy}</div>
                          <div className="text-sm sm:text-xs mt-2 sm:mt-1 capitalize font-medium">{config.risk} risk</div>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                
                {/* Show error if any */}
                {addLiquidityError && (
                  <div className="mb-4 sm:mb-2 text-sm sm:text-xs text-red-600 bg-red-50 p-4 sm:p-2 rounded-xl sm:rounded">
                    {addLiquidityError}
                  </div>
                )}
                
                <button 
                  onClick={() => (disabled || totalSecurityDeposits === 0) ? null : handleAddLiquidityToCetus()}
                  disabled={disabled || isAddingLiquidity || totalSecurityDeposits === 0}
                  className={`w-full sm:w-auto px-8 sm:px-4 py-4 sm:py-2 text-base sm:text-sm font-semibold sm:font-medium rounded-2xl sm:rounded-lg transition-all duration-200 ${
                    disabled || totalSecurityDeposits === 0
                      ? 'bg-gradient-to-r from-blue-500 to-purple-500 text-white opacity-50 cursor-not-allowed'
                      : isAddingLiquidity
                      ? 'bg-gradient-to-r from-blue-400 to-purple-400 text-white cursor-wait'
                      : 'bg-gradient-to-r from-blue-500 to-purple-500 text-white hover:from-blue-600 hover:to-purple-600 hover:shadow-lg transform hover:scale-105 sm:hover:scale-100 active:scale-95'
                  }`}
                >
                  {isAddingLiquidity ? (
                    <span className="flex items-center justify-center">
                      <div className="animate-spin rounded-full h-5 w-5 sm:h-4 sm:w-4 border-b-2 border-white mr-3 sm:mr-2"></div>
                      Creating Configuration...
                    </span>
                  ) : (
                    trackedYields.length > 0
                      ? 'Create Additional Yield Configuration'
                      : 'Create Yield Configuration'
                  )}
                </button>
              </div>
            </div>
          )}

          {/* Loading state */}
          {isLoadingYieldData && (
            <div className="bg-white rounded-lg border border-gray-200 p-6">
              <div className="animate-pulse">
                <div className="h-6 bg-gray-200 rounded w-1/3 mb-4"></div>
                <div className="space-y-3">
                  {[1, 2, 3].map((i) => (
                    <div key={i} className="h-20 bg-gray-200 rounded"></div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Error state */}
          {yieldDataError && (
            <div className="bg-white rounded-lg border border-gray-200 p-6">
              <div className="text-center">
                <div className="text-red-500 mb-2">
                  <svg className="mx-auto h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </div>
                <h3 className="text-lg font-medium text-gray-900 mb-2">Error Loading Yield Data</h3>
                <p className="text-gray-600 text-sm">{yieldDataError}</p>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Current Status Summary - Mobile Optimized */}
      {totalSecurityDeposits > 0 && (
        <div className="bg-gradient-to-r from-green-50 to-blue-50 border border-green-200 rounded-2xl p-5 sm:p-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-5 sm:gap-4 text-center">
            <div className="bg-white/70 rounded-xl p-4 sm:p-3">
              <div className="text-sm text-gray-600 mb-2 sm:mb-1">Current Strategy</div>
              <div className="font-bold text-lg sm:text-base text-gray-900">{currentConfig.displayName}</div>
              <div className="text-sm sm:text-xs text-gray-500 mt-1">({currentConfig.apy} yearly)</div>
            </div>
            <div className="bg-white/70 rounded-xl p-4 sm:p-3">
              <div className="text-sm text-gray-600 mb-2 sm:mb-1">Security Deposits</div>
              <div className="font-bold text-lg sm:text-base text-gray-900">
                {totalSecurityDeposits.toFixed(2)} SUI
              </div>
              <div className="text-sm sm:text-xs text-gray-500 mt-1">Earning income</div>
            </div>
            <div className="bg-white/70 rounded-xl p-4 sm:p-3">
              <div className="text-sm text-gray-600 mb-2 sm:mb-1">Est. Monthly Earnings</div>
              <div className="font-bold text-lg sm:text-base text-green-600">
                +{potentialMonthlyEarnings.toFixed(4)} SUI
              </div>
              <div className="text-sm sm:text-xs text-gray-500 mt-1">≈ ${(potentialMonthlyEarnings * currentSuiPrice).toFixed(2)}</div>
            </div>
          </div>
        </div>
      )}

      {/* Strategy Selector - Only show when there are existing yield configurations */}
      {trackedYields.length > 0 && (
        <div>
          <h4 className="text-lg font-semibold text-gray-900 mb-4">Modify Strategy</h4>
          <p className="text-sm text-gray-600 mb-4">
            You can change your yield strategy at any time. Changes will apply to future earnings.
          </p>
          <StrategySelector
            selectedStrategy={selectedStrategy}
            onStrategySelect={handleStrategySelect}
            disabled={disabled || isChangingStrategy}
            showDetailedInfo={true}
            totalDeposits={totalSecurityDeposits}
          />
        </div>
      )}

      {/* Loading state during strategy change */}
      {isChangingStrategy && (
        <div className="fixed inset-0 bg-black bg-opacity-25 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 shadow-lg">
            <div className="flex items-center space-x-3">
              <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-500"></div>
              <span className="text-gray-700">Updating yield strategy...</span>
            </div>
          </div>
        </div>
      )}





      {/* Confirmation Modal */}
      {showConfirmModal && confirmModalData && (
        <ConfirmationModal
          isOpen={showConfirmModal}
          title={confirmModalData.title}
          message={confirmModalData.message}
          onConfirm={confirmModalData.onConfirm}
          onClose={() => setShowConfirmModal(false)}
          confirmText={confirmModalData.confirmText}
          confirmButtonVariant={confirmModalData.variant}
        />
      )}
    </div>
  );
}; 