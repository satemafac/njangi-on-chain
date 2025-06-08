// YieldStrategySection.tsx - Main section for yield management in Circle Management interface

import React, { useState, useEffect } from 'react';
import { YieldStrategy } from './types/yield.types';
import { StrategySelector } from './components/StrategySelector';
import { STRATEGY_CONFIGS } from './config/strategies';
import { cetusService } from '../../services/cetus-service';
import ConfirmationModal from '../ConfirmationModal';
import { priceService } from '../../services/price-service';

// Define interfaces locally since they're not exported from cetus-service
interface CetusPosition {
  positionId: string;
  poolAddress: string;
  coinTypeA: string;
  coinTypeB: string;
  liquidity: string;
  poolName?: string; // Add for display
  feeEarned: {
    coinA: string;
    coinB: string;
  };
  tickLower: number;
  tickUpper: number;
  earnedFees?: number; // Add for display
  [key: string]: unknown;
}

interface YieldData {
  totalFeesEarned: {
    sui: number;
    usdc: number;
  };
  apr: number;
  positionValue: {
    sui: number;
    usdc: number;
    totalUsd: number;
  };
  lastCollectionTime: number;
  // Add display-friendly properties
  totalLiquidity?: number;
  earnedFees?: number;
  earnedFeesUSD?: number;
  currentAPR?: number;
}

interface PoolStatistics {
  tvl: number;
  volume24h: number;
  fees24h: number;
  apr: number;
}

interface YieldStrategySectionProps {
  currentStrategy?: YieldStrategy;
  onStrategyChange?: (strategy: YieldStrategy) => void;
  totalSecurityDeposits?: number;
  isLoading?: boolean;
  disabled?: boolean;
  walletId?: string; // Add wallet ID for fetching real yield data
  circleId?: string; // Add circle ID for contract calls
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
  circleId
}) => {
  const [selectedStrategy, setSelectedStrategy] = useState<YieldStrategy>(currentStrategy);
  const [isChangingStrategy, setIsChangingStrategy] = useState(false);
  
  // New state for Cetus yield data
  const [cetusPositions, setCetusPositions] = useState<CetusPosition[]>([]);
  const [cetusYieldData, setCetusYieldData] = useState<YieldData | null>(null);
  const [poolStats, setPoolStats] = useState<PoolStatistics | null>(null);
  const [isLoadingCetusData, setIsLoadingCetusData] = useState(false);
  const [cetusError, setCetusError] = useState<string | null>(null);
  
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

  // Fetch Cetus yield data when wallet ID is available
  useEffect(() => {
    const fetchCetusData = async () => {
      if (!walletId || isLoading) return;

      setIsLoadingCetusData(true);
      setCetusError(null);

      try {
        // Fetch user's liquidity positions
        const positions = await cetusService.getUserLiquidityPositions(walletId);
        
        // Enhance positions with display data using live price
        const enhancedPositions = positions.map(position => ({
          ...position,
          poolName: 'SUI-USDC',
          earnedFees: (Number(position.feeEarned.coinA) / 1e9) + (Number(position.feeEarned.coinB) / 1e6) * currentSuiPrice
        }));
        setCetusPositions(enhancedPositions);

        // Calculate yield from positions
        if (positions.length > 0) {
          const yieldDataRaw = await cetusService.calculateYieldFromPositions(walletId);
          
          // Enhance yield data with display-friendly properties using live price
          const enhancedYieldData: YieldData = {
            ...yieldDataRaw,
            totalLiquidity: yieldDataRaw.positionValue.sui,
            earnedFees: yieldDataRaw.totalFeesEarned.sui,
            earnedFeesUSD: yieldDataRaw.totalFeesEarned.sui * currentSuiPrice + yieldDataRaw.totalFeesEarned.usdc,
            currentAPR: yieldDataRaw.apr
          };
          setCetusYieldData(enhancedYieldData);
        }

        // Fetch pool statistics for the main SUI-USDC pool
        const poolId = '0xb01b068bd0360bb3308b81eb42386707e460b7818816709b7f51e1635d542d40';
        const stats = await cetusService.getPoolStatistics(poolId);
        setPoolStats(stats);

      } catch (error) {
        console.error('Error fetching Cetus data:', error);
        setCetusError(error instanceof Error ? error.message : 'Failed to load Cetus yield data');
      } finally {
        setIsLoadingCetusData(false);
      }
    };

    fetchCetusData();
  }, [walletId, isLoading, currentSuiPrice]); // Add currentSuiPrice as dependency

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

  // Handler for adding liquidity to Cetus
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

      // Prepare the yield configuration transaction
      console.log('Preparing yield configuration transaction:', {
        circleId: circleId,
        custodyWalletId: walletId,
        suiAmount,
        estimatedUsdcAmount: minUsdcAmount,
        suiPriceUsed: currentSuiPrice
      });

      // Use Cetus service to prepare the transaction
      const poolId = '0xb01b068bd0360bb3308b81eb42386707e460b7818816709b7f51e1635d542d40'; // SUI-USDC pool
      
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
            suiPrice: currentSuiPrice
          });

          // Prepare the yield integration transaction
          const transactionData = {
            action: 'addCetusLiquidity',
            account,
            yieldData: {
              sui_amount: (suiAmount * 1e9).toString(), // Convert to MIST (base units)
              usdc_amount: (minUsdcAmount * 1e6).toString(), // Convert to base units
              pool_id: poolId,
              circle_id: circleId, // Use the actual Circle object ID
              custody_wallet_id: walletId, // Use the custody wallet ID from props
              tick_lower: -60000, // Wide range
              tick_upper: 60000,   // Wide range
              slippage_tolerance: 50, // 0.5% in basis points
              total_security_deposits: totalSecurityDeposits // Pass the actual total
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
                    <li>• Strategy: {result.yieldStrategy || 'Conservative (100% NAVI Protocol)'}</li>
                    <li>• Expected APY: {result.details?.expectedAPY || '6.81%'}</li>
                    <li>• Auto-Compound: {result.details?.autoCompound ? 'Enabled' : 'Disabled'}</li>
                    <li>• NAVI Allocation: {result.details?.naviAllocation || '100%'}</li>
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

      // Show the confirmation modal
      setConfirmModalData({
        title: '🚀 Create Yield Configuration for Circle',
        message: (
          <div className="space-y-4">
            <div className="bg-blue-50 p-4 rounded-lg">
              <h4 className="font-medium text-blue-900 mb-2">Yield Configuration Setup:</h4>
              <ul className="text-sm text-blue-800 space-y-1">
                <li>• Strategy: Conservative (100% NAVI Protocol)</li>
                <li>• Expected APY: 6.81% annually</li>
                <li>• Auto-Compound: Enabled</li>
                <li>• Available Security Deposits: {totalSecurityDeposits.toFixed(2)} SUI</li>
                <li>• Target Protocols: NAVI Protocol</li>
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
                those deposits will automatically start generating yield through NAVI Protocol&apos;s 6.81% APY.
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

  // Format yield values for display
  const formatYieldValue = (value: number | undefined, decimals: number = 4): string => {
    return (value ?? 0).toFixed(decimals);
  };

  // Format USD value for display
  const formatUSDValue = (value: number | undefined): string => {
    return `$${(value ?? 0).toFixed(2)}`;
  };

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
        yieldData: {
          config_id: configId,
          circle_id: circleId,
          custody_wallet_id: walletId,
          deposit_amount: depositAmountMist.toString(),
          total_security_deposits: totalSecurityDeposits,
          expected_apy: '12-18%',
          strategy: 'Cetus Liquidity Provision'
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
      
      // Look for YieldConfig creation in events
      if (data.result?.events) {
        const yieldConfigEvent = data.result.events.find((event: {
          type?: string;
          parsedJson?: { config_id?: string };
        }) => 
          event.type?.includes('YieldConfigCreated')
        );
        
        if (yieldConfigEvent?.parsedJson?.config_id) {
          return yieldConfigEvent.parsedJson.config_id;
        }
      }

      // Look for YieldConfig creation in object changes
      if (data.result?.objectChanges) {
        const yieldConfigObject = data.result.objectChanges.find((change: {
          type?: string;
          objectType?: string;
          objectId?: string;
        }) => 
          change.type === 'created' && 
          change.objectType?.includes('YieldConfig')
        );
        
        if (yieldConfigObject?.objectId) {
          return yieldConfigObject.objectId;
        }
      }

      return null;
    } catch (error) {
      console.error('Error finding YieldConfig ID:', error);
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
    <div className="bg-white rounded-lg border border-gray-200 p-6 space-y-6">
      {/* Real Cetus Yield Display Section */}
      {walletId && (
        <div className="bg-gradient-to-r from-blue-50 to-purple-50 border border-blue-200 rounded-lg p-6">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center space-x-2">
              <div className="w-8 h-8 bg-gradient-to-r from-blue-500 to-purple-500 rounded-full flex items-center justify-center">
                <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
                </svg>
              </div>
              <h3 className="text-lg font-semibold text-gray-900">Real Cetus DEX Yield</h3>
              <span className="px-2 py-1 text-xs font-medium bg-green-100 text-green-800 rounded-full">
                LIVE
              </span>
            </div>
            {isLoadingCetusData && (
              <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-blue-500"></div>
            )}
          </div>

          {cetusError ? (
            <div className="bg-red-50 border border-red-200 rounded-lg p-4">
              <div className="flex items-center space-x-2">
                <svg className="w-5 h-5 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <span className="text-red-700 text-sm">{cetusError}</span>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              {/* Active Positions */}
              <div className="text-center">
                <div className="text-sm text-gray-600">Active Positions</div>
                <div className="font-bold text-2xl text-blue-600">
                  {isLoadingCetusData ? '...' : cetusPositions.length}
                </div>
                <div className="text-xs text-gray-500">Liquidity pools</div>
              </div>

              {/* Total Liquidity Provided */}
              <div className="text-center">
                <div className="text-sm text-gray-600">Total Liquidity</div>
                <div className="font-bold text-2xl text-purple-600">
                  {isLoadingCetusData ? '...' : 
                    cetusYieldData ? formatYieldValue(cetusYieldData.totalLiquidity) : '0.0000'} SUI
                </div>
                <div className="text-xs text-gray-500">In Cetus pools</div>
              </div>

              {/* Earned Fees */}
              <div className="text-center">
                <div className="text-sm text-gray-600">Earned Fees</div>
                <div className="font-bold text-2xl text-green-600">
                  +{isLoadingCetusData ? '...' : 
                    cetusYieldData ? formatYieldValue(cetusYieldData.earnedFees) : '0.0000'} SUI
                </div>
                <div className="text-xs text-gray-500">
                  ≈ {isLoadingCetusData ? '...' : 
                    cetusYieldData ? formatUSDValue(cetusYieldData.earnedFeesUSD) : '$0.00'}
                </div>
              </div>

              {/* Current APR */}
              <div className="text-center">
                <div className="text-sm text-gray-600">Current APR</div>
                <div className="font-bold text-2xl text-indigo-600">
                  {isLoadingCetusData ? '...' : 
                    cetusYieldData ? formatYieldValue(cetusYieldData.currentAPR, 2) : '0.00'}%
                </div>
                <div className="text-xs text-gray-500">From trading fees</div>
              </div>
            </div>
          )}

          {/* Pool Statistics */}
          {poolStats && !cetusError && (
            <div className="mt-4 pt-4 border-t border-blue-200">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
                <div>
                  <span className="text-gray-600">Pool TVL:</span>
                  <span className="ml-2 font-medium">{formatUSDValue(poolStats.tvl)}</span>
                </div>
                <div>
                  <span className="text-gray-600">24h Volume:</span>
                  <span className="ml-2 font-medium">{formatUSDValue(poolStats.volume24h)}</span>
                </div>
                <div>
                  <span className="text-gray-600">24h Fees:</span>
                  <span className="ml-2 font-medium text-green-600">{formatUSDValue(poolStats.fees24h)}</span>
                </div>
              </div>
            </div>
          )}

          {/* Position Details */}
          {cetusPositions.length > 0 && !cetusError && (
            <div className="mt-4 pt-4 border-t border-blue-200">
              <h4 className="text-sm font-medium text-gray-900 mb-3">Your Liquidity Positions</h4>
              <div className="space-y-2">
                {cetusPositions.slice(0, 3).map((position, index) => (
                  <div key={position.positionId} className="flex justify-between items-center bg-white bg-opacity-60 rounded-lg p-3">
                    <div className="flex items-center space-x-3">
                      <div className="w-6 h-6 bg-blue-100 rounded-full flex items-center justify-center">
                        <span className="text-xs font-medium text-blue-600">{index + 1}</span>
                      </div>
                      <div>
                        <div className="text-sm font-medium">{position.poolName}</div>
                        <div className="text-xs text-gray-500">Position #{position.positionId.slice(0, 8)}...</div>
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-sm font-medium">{formatYieldValue(Number(position.liquidity) / 1e9)} SUI</div>
                      <div className="text-xs text-green-600">+{formatYieldValue(position.earnedFees)} fees</div>
                    </div>
                  </div>
                ))}
                {cetusPositions.length > 3 && (
                  <div className="text-center text-sm text-gray-500 py-2">
                    +{cetusPositions.length - 3} more positions
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Call to Action for No Positions */}
          {cetusPositions.length === 0 && !cetusError && !isLoadingCetusData && (
            <div className="mt-4 pt-4 border-t border-blue-200 text-center">
              <div className="text-gray-600 text-sm mb-2">
                {disabled 
                  ? "Yield management will be available once the circle administrator activates the circle."
                  : "No yield configuration found. Set up real DeFi yield generation for your security deposits!"
                }
              </div>
              
              {/* Show error if any */}
              {addLiquidityError && (
                <div className="mb-2 text-xs text-red-600 bg-red-50 p-2 rounded">
                  {addLiquidityError}
                </div>
              )}
              
              <button 
                onClick={() => disabled ? null : handleAddLiquidityToCetus()}
                disabled={disabled || isAddingLiquidity}
                className={`px-4 py-2 text-sm rounded-lg transition-colors ${
                  disabled
                    ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
                    : isAddingLiquidity
                    ? 'bg-blue-400 text-white cursor-wait'
                    : 'bg-gradient-to-r from-blue-500 to-purple-500 text-white hover:from-blue-600 hover:to-purple-600'
                }`}
              >
                {disabled 
                  ? 'Circle Not Active' 
                  : isAddingLiquidity 
                  ? (
                    <span className="flex items-center">
                      <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                      Creating Configuration...
                    </span>
                  )
                  : 'Create Yield Configuration'
                }
              </button>
            </div>
          )}
        </div>
      )}

      {/* Current Status Summary */}
      {totalSecurityDeposits > 0 && (
        <div className="bg-gradient-to-r from-green-50 to-blue-50 border border-green-200 rounded-lg p-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-center">
            <div>
              <div className="text-sm text-gray-600">Current Strategy</div>
              <div className="font-semibold text-gray-900">{currentConfig.displayName}</div>
              <div className="text-xs text-gray-500">({currentConfig.apy} yearly)</div>
            </div>
            <div>
              <div className="text-sm text-gray-600">Security Deposits</div>
              <div className="font-semibold text-gray-900">
                {totalSecurityDeposits.toFixed(2)} SUI
              </div>
              <div className="text-xs text-gray-500">Earning income</div>
            </div>
            <div>
              <div className="text-sm text-gray-600">Est. Monthly Earnings</div>
              <div className="font-semibold text-green-600">
                +{potentialMonthlyEarnings.toFixed(4)} SUI
              </div>
              <div className="text-xs text-gray-500">≈ ${(potentialMonthlyEarnings * currentSuiPrice).toFixed(2)}</div>
            </div>
          </div>
        </div>
      )}

      {/* Strategy Selector */}
      <StrategySelector
        selectedStrategy={selectedStrategy}
        onStrategySelect={handleStrategySelect}
        disabled={disabled || isChangingStrategy}
        showDetailedInfo={true}
        totalDeposits={totalSecurityDeposits}
      />

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

      {/* No deposits message */}
      {totalSecurityDeposits === 0 && (
        <div className="text-center py-8 border-2 border-dashed border-gray-300 rounded-lg">
          <div className="text-gray-400 mb-2">
            <svg className="mx-auto h-12 w-12" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1" />
            </svg>
          </div>
          <h3 className="text-lg font-medium text-gray-900 mb-1">No Security Deposits Yet</h3>
          <p className="text-gray-500 text-sm">
            Once members join and pay security deposits, you can start earning additional income with these strategies.
          </p>
        </div>
      )}

      {/* Quick Tips */}
      <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
        <div className="flex">
          <div className="flex-shrink-0">
            <svg className="h-5 w-5 text-yellow-400" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
            </svg>
          </div>
          <div className="ml-3">
            <h4 className="text-sm font-medium text-yellow-800">Pro Tips</h4>
            <div className="mt-1 text-sm text-yellow-700">
              <ul className="list-disc space-y-1 ml-4">
                <li>Start with Conservative strategy if you&apos;re new to DeFi</li>
                <li>You can change strategies anytime without penalties</li>
                <li>All earnings are automatically distributed to circle members</li>
                <li>Security deposits remain available for emergency withdrawals</li>
                <li><strong>NEW:</strong> Real Cetus yield shows actual earnings from DEX trading fees</li>
              </ul>
            </div>
          </div>
        </div>
      </div>

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