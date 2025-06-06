// YieldStrategySection.tsx - Main section for yield management in Circle Management interface

import React, { useState, useEffect } from 'react';
import { YieldStrategy } from './types/yield.types';
import { StrategySelector } from './components/StrategySelector';
import { STRATEGY_CONFIGS } from './config/strategies';
import { cetusService } from '../../services/cetus-service';
import ConfirmationModal from '../ConfirmationModal';

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
}

export const YieldStrategySection: React.FC<YieldStrategySectionProps> = ({
  currentStrategy = 'conservative', // Default to conservative strategy
  onStrategyChange,
  totalSecurityDeposits = 0,
  isLoading = false,
  disabled = false,
  walletId
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

  // Update local state when props change
  useEffect(() => {
    setSelectedStrategy(currentStrategy);
  }, [currentStrategy]);

  // Fetch Cetus yield data when wallet ID is available
  useEffect(() => {
    const fetchCetusData = async () => {
      if (!walletId || isLoading) return;

      setIsLoadingCetusData(true);
      setCetusError(null);

      try {
        // Fetch user's liquidity positions
        const positions = await cetusService.getUserLiquidityPositions(walletId);
        
        // Enhance positions with display data
        const enhancedPositions = positions.map(position => ({
          ...position,
          poolName: 'SUI-USDC',
          earnedFees: (Number(position.feeEarned.coinA) / 1e9) + (Number(position.feeEarned.coinB) / 1e6) * 2.5
        }));
        setCetusPositions(enhancedPositions);

        // Calculate yield from positions
        if (positions.length > 0) {
          const yieldDataRaw = await cetusService.calculateYieldFromPositions(walletId);
          
          // Enhance yield data with display-friendly properties
          const enhancedYieldData: YieldData = {
            ...yieldDataRaw,
            totalLiquidity: yieldDataRaw.positionValue.sui,
            earnedFees: yieldDataRaw.totalFeesEarned.sui,
            earnedFeesUSD: yieldDataRaw.totalFeesEarned.sui * 2.5 + yieldDataRaw.totalFeesEarned.usdc,
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
  }, [walletId, isLoading]);

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
    if (!walletId || disabled) return;

    setIsAddingLiquidity(true);
    setAddLiquidityError(null);

    try {
      // Calculate optimal liquidity amounts based on available security deposits
      const suiAmount = Math.floor(totalSecurityDeposits); // Use 100% of security deposits
      const minUsdcAmount = suiAmount * 2.5; // Approximate USDC equivalent (1 SUI ≈ $2.50)
      
      // Handle insufficient funds gracefully
      if (suiAmount < 1) {
        setAddLiquidityError('Insufficient security deposits for liquidity provision. Minimum 1 SUI required in total security deposits.');
        setIsAddingLiquidity(false);
        return;
      }

      // Prepare the add liquidity transaction using Cetus service
      console.log('Preparing Cetus add liquidity transaction:', {
        walletAddress: walletId,
        suiAmount,
        estimatedUsdcAmount: minUsdcAmount
      });

      // Use Cetus service to prepare the transaction
      const poolId = '0xb01b068bd0360bb3308b81eb42386707e460b7818816709b7f51e1635d542d40'; // SUI-USDC pool
      
      // For now, we'll prepare the transaction parameters and show them to the user
      // In a full implementation, this would connect to a wallet and execute the transaction
      const transactionDetails = {
        poolId,
        coinTypeA: '0x2::sui::SUI',
        coinTypeB: '0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN', // Testnet USDC
        amountA: suiAmount * 1e9, // Convert to base units (1 SUI = 1e9 MIST)
        amountB: minUsdcAmount * 1e6, // Convert to base units (1 USDC = 1e6)
        tickLower: -60000, // Wide range for simplicity
        tickUpper: 60000,
        slippage: 0.5 // 0.5% slippage tolerance
      };

      // Show confirmation modal instead of browser confirm
      const confirmMessage = (
        <div className="space-y-4">
          <div className="bg-blue-50 p-4 rounded-lg">
            <h4 className="font-medium text-blue-900 mb-2">Transaction Details:</h4>
            <ul className="text-sm text-blue-800 space-y-1">
              <li>• Pool: SUI-USDC (Testnet)</li>
              <li>• SUI Amount: {suiAmount} SUI</li>
              <li>• Est. USDC Equivalent: ~{minUsdcAmount.toFixed(2)} USDC</li>
              <li>• Fee Tier: 0.3%</li>
              <li>• Price Range: Wide Range (Full Range)</li>
            </ul>
          </div>
          <div className="bg-green-50 p-4 rounded-lg">
            <h4 className="font-medium text-green-900 mb-2">This will:</h4>
            <ul className="text-sm text-green-800 space-y-1">
              <li>✅ Create a real Cetus LP position</li>
              <li>✅ Start earning actual trading fees immediately</li>
              <li>✅ Generate real yield for your circle</li>
              <li>✅ Allow withdrawal anytime</li>
            </ul>
          </div>
          <div className="bg-yellow-50 p-3 rounded-lg">
            <p className="text-sm text-yellow-800">
              <strong>Note:</strong> This requires connecting a wallet with sufficient SUI and USDC balances.
            </p>
          </div>
        </div>
      );

      // Store transaction details for modal confirmation
      const handleConfirmTransaction = () => {
        // Here's where wallet connection and transaction execution would happen
        console.log('User confirmed - would now connect wallet and execute transaction');
        console.log('Transaction parameters:', transactionDetails);
        
        // Show success message
        setConfirmModalData({
          title: '🎉 Transaction Prepared Successfully!',
          message: (
            <div className="space-y-3">
              <p>In a full implementation, this would now connect to your Sui wallet and execute the real Cetus add liquidity transaction on testnet.</p>
              <div className="bg-gray-50 p-3 rounded-lg">
                <p className="text-sm text-gray-600">Next steps would be:</p>
                <ol className="text-sm text-gray-600 mt-2 space-y-1">
                  <li>1. Connect to wallet (Sui Wallet, Martian, etc.)</li>
                  <li>2. Check balances for SUI and USDC</li>
                  <li>3. If insufficient USDC, offer to swap SUI for USDC first</li>
                  <li>4. Execute addLiquidity transaction via Cetus SDK</li>
                  <li>5. Update UI with new position</li>
                </ol>
              </div>
            </div>
          ),
          onConfirm: () => {},
          confirmText: 'OK',
          variant: 'primary'
        });
        setShowConfirmModal(true);
      };

      // Show the confirmation modal
      setConfirmModalData({
        title: '🚀 Ready to Add Liquidity to Cetus DEX!',
        message: confirmMessage,
        onConfirm: handleConfirmTransaction,
        confirmText: 'Proceed with Wallet Connection',
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
                  : "No active Cetus positions found. Start earning real yield from DEX trading fees!"
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
                      Processing...
                    </span>
                  )
                  : 'Add Liquidity to Cetus'
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
              <div className="text-xs text-gray-500">≈ ${(potentialMonthlyEarnings * 2.5).toFixed(2)}</div>
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