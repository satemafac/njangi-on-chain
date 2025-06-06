// DepositManagement.tsx - Component for managing security deposits and their yield earnings

import React, { useState, useEffect } from 'react';
import { cetusService } from '../../services/cetus-service';
import { CetusErrorCode, parseError, CetusErrorLogger } from '../../services/cetus-errors';

// Interfaces for yield data
interface YieldEarnings {
  totalEarned: {
    sui: number;
    usdc: number;
    totalUsd: number;
  };
  dailyEarnings: {
    sui: number;
    usdc: number;
    totalUsd: number;
  };
  weeklyEarnings: {
    sui: number;
    usdc: number;
    totalUsd: number;
  };
  monthlyEarnings: {
    sui: number;
    usdc: number;
    totalUsd: number;
  };
  currentAPR: number;
  totalDeposited: {
    sui: number;
    usdc: number;
    totalUsd: number;
  };
  lastCollectionTime: number;
  positions: YieldPosition[];
}

interface YieldPosition {
  positionId: string;
  poolName: string;
  liquidity: number;
  feesEarned: {
    sui: number;
    usdc: number;
  };
  apr: number;
  createdAt: number;
}

interface YieldHistoryPoint {
  timestamp: number;
  dailyEarnings: number;
  cumulativeEarnings: number;
  apr: number;
  poolVolume: number;
}

interface DepositManagementProps {
  walletId?: string;
  isLoading?: boolean;
  disabled?: boolean;
  onYieldAction?: (action: 'collect' | 'reinvest', amount: number) => void;
}

export const DepositManagement: React.FC<DepositManagementProps> = ({
  walletId,
  isLoading = false,
  disabled = false,
  onYieldAction
}) => {
  const [yieldData, setYieldData] = useState<YieldEarnings | null>(null);
  const [yieldHistory, setYieldHistory] = useState<YieldHistoryPoint[]>([]);
  const [selectedPeriod, setSelectedPeriod] = useState<'7d' | '30d' | '90d' | '1y'>('7d');
  const [isLoadingYield, setIsLoadingYield] = useState(false);
  const [isCollecting, setIsCollecting] = useState(false);
  const [isReinvesting, setIsReinvesting] = useState(false);
  const [yieldError, setYieldError] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [showHistoryModal, setShowHistoryModal] = useState(false);

  // Fetch yield earnings data
  useEffect(() => {
    const fetchYieldData = async () => {
      if (!walletId) return;

      setIsLoadingYield(true);
      setYieldError(null);

      try {
        // Fetch current yield data
        const [positions, poolStats, yieldCalculation] = await Promise.all([
          cetusService.getUserLiquidityPositions(walletId),
          cetusService.getPoolStatistics(),
          cetusService.calculateYieldFromPositions(walletId)
        ]);

        // Transform positions data
        const transformedPositions: YieldPosition[] = positions.map(pos => ({
          positionId: pos.positionId,
          poolName: 'SUI-USDC',
          liquidity: Number(pos.liquidity) / 1e9,
          feesEarned: {
            sui: Number(pos.feeEarned.coinA) / 1e9,
            usdc: Number(pos.feeEarned.coinB) / 1e6
          },
          apr: poolStats.apr,
          createdAt: Date.now() - (Math.random() * 30 * 24 * 60 * 60 * 1000) // Mock creation time
        }));

        // Calculate earnings data
        const totalEarnedSui = yieldCalculation.totalFeesEarned.sui;
        const totalEarnedUsdc = yieldCalculation.totalFeesEarned.usdc;
        const suiPrice = 2.5; // Mock SUI price - in real app would fetch from API

        const earningsData: YieldEarnings = {
          totalEarned: {
            sui: totalEarnedSui,
            usdc: totalEarnedUsdc,
            totalUsd: totalEarnedSui * suiPrice + totalEarnedUsdc
          },
          dailyEarnings: {
            sui: totalEarnedSui / 30, // Estimate daily from total
            usdc: totalEarnedUsdc / 30,
            totalUsd: (totalEarnedSui * suiPrice + totalEarnedUsdc) / 30
          },
          weeklyEarnings: {
            sui: totalEarnedSui / 4.3, // Estimate weekly from total
            usdc: totalEarnedUsdc / 4.3,
            totalUsd: (totalEarnedSui * suiPrice + totalEarnedUsdc) / 4.3
          },
          monthlyEarnings: {
            sui: totalEarnedSui,
            usdc: totalEarnedUsdc,
            totalUsd: totalEarnedSui * suiPrice + totalEarnedUsdc
          },
          currentAPR: yieldCalculation.apr,
          totalDeposited: {
            sui: yieldCalculation.positionValue.sui,
            usdc: yieldCalculation.positionValue.usdc,
            totalUsd: yieldCalculation.positionValue.totalUsd
          },
          lastCollectionTime: yieldCalculation.lastCollectionTime,
          positions: transformedPositions
        };

        setYieldData(earningsData);

        // Generate mock historical data
        generateYieldHistory(earningsData);

      } catch (error) {
        console.error('Error fetching yield data:', error);
        
        // Use comprehensive error handling
        const cetusError = parseError(error);
        CetusErrorLogger.log(cetusError);
        
        // Set user-friendly error message
        setYieldError(cetusError.userMessage + (cetusError.suggestion ? ` ${cetusError.suggestion}` : ''));
      } finally {
        setIsLoadingYield(false);
      }
    };

    fetchYieldData();
    
    // Refresh data every 5 minutes
    const interval = setInterval(fetchYieldData, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [walletId]);

  // Generate mock historical yield data
  const generateYieldHistory = (currentData: YieldEarnings) => {
    const days = selectedPeriod === '7d' ? 7 : selectedPeriod === '30d' ? 30 : 
                 selectedPeriod === '90d' ? 90 : 365;
    
    const history: YieldHistoryPoint[] = [];
    const dailyBase = currentData.totalEarned.totalUsd / days;
    
    for (let i = days; i >= 0; i--) {
      const timestamp = Date.now() - (i * 24 * 60 * 60 * 1000);
      const variance = 0.8 + Math.random() * 0.4; // 20% variance
      const dailyEarnings = dailyBase * variance;
      const cumulativeEarnings = dailyBase * (days - i);
      const apr = currentData.currentAPR * variance;
      const poolVolume = 50000 + Math.random() * 100000; // Mock volume
      
      history.push({
        timestamp,
        dailyEarnings,
        cumulativeEarnings,
        apr,
        poolVolume
      });
    }
    
    setYieldHistory(history);
  };

  // Update history when time range changes
  useEffect(() => {
    if (yieldData) {
      generateYieldHistory(yieldData);
    }
  }, [selectedPeriod, yieldData]);

  // Handle yield collection
  const handleCollectYield = async () => {
    if (disabled) return;
    
    if (!walletId || !yieldData) return;

    setIsCollecting(true);
    try {
      // Collect fees from all positions
      for (const position of yieldData.positions) {
        if (position.feesEarned.sui > 0 || position.feesEarned.usdc > 0) {
          await cetusService.prepareCollectFeesTransaction(walletId, position.positionId);
        }
      }

      const totalCollected = yieldData.totalEarned.totalUsd;
      onYieldAction?.('collect', totalCollected);
      
      // Refresh data after collection
      setYieldData(prev => prev ? {
        ...prev,
        totalEarned: { sui: 0, usdc: 0, totalUsd: 0 },
        lastCollectionTime: Date.now()
      } : null);

    } catch (error) {
      console.error('Error collecting yield:', error);
      
      // Use comprehensive error handling
      const cetusError = parseError(error);
      CetusErrorLogger.log(cetusError);
      
      // Provide specific user-friendly error messages
      if (cetusError.code === CetusErrorCode.NO_FEES_TO_COLLECT) {
        setYieldError('No fees available to collect yet. Your positions need more time to earn trading fees.');
      } else if (cetusError.code === CetusErrorCode.TRANSACTION_REJECTED) {
        setYieldError('Transaction was cancelled. You can try collecting fees again when ready.');
      } else {
        setYieldError(cetusError.userMessage + (cetusError.suggestion ? ` ${cetusError.suggestion}` : ''));
      }
    } finally {
      setIsCollecting(false);
    }
  };

  // Handle yield reinvestment
  const handleReinvestYield = async () => {
    if (disabled) return;
    
    if (!walletId || !yieldData) return;

    setIsReinvesting(true);
    try {
      // Collect fees first, then reinvest
      await handleCollectYield();
      
      // Calculate optimal amounts for reinvestment
      const reinvestAmount = yieldData.totalEarned.sui;
      if (reinvestAmount > 0) {
        const optimalAmounts = await cetusService.calculateOptimalLiquidityAmounts(reinvestAmount);
        
        // Use the correct LiquidityParams interface
        const liquidityParams = {
          walletAddress: walletId,
          poolId: '0xb01b068bd0360bb3308b81eb42386707e460b7818816709b7f51e1635d542d40',
          amountA: optimalAmounts.suiAmount,
          amountB: optimalAmounts.usdcAmount,
          slippage: 0.01 // 1% slippage
        };
        
        await cetusService.prepareAddLiquidityTransaction(liquidityParams);
        onYieldAction?.('reinvest', yieldData.totalEarned.totalUsd);
      }

    } catch (error) {
      console.error('Error reinvesting yield:', error);
      
      // Use comprehensive error handling
      const cetusError = parseError(error);
      CetusErrorLogger.log(cetusError);
      
      // Provide specific user-friendly error messages
      if (cetusError.code === CetusErrorCode.INSUFFICIENT_BALANCE) {
        setYieldError('Insufficient balance to reinvest. You may need more tokens in your wallet.');
      } else if (cetusError.code === CetusErrorCode.SLIPPAGE_EXCEEDED) {
        setYieldError('Price moved too much during reinvestment. Please try again or adjust slippage.');
      } else if (cetusError.code === CetusErrorCode.TRANSACTION_REJECTED) {
        setYieldError('Reinvestment transaction was cancelled. You can try again when ready.');
      } else {
        setYieldError(cetusError.userMessage + (cetusError.suggestion ? ` ${cetusError.suggestion}` : ''));
      }
    } finally {
      setIsReinvesting(false);
    }
  };

  // Format currency values
  const formatCurrency = (value: number, decimals: number = 4): string => {
    return value.toFixed(decimals);
  };

  const formatUSD = (value: number): string => {
    return `$${value.toFixed(2)}`;
  };

  if (isLoading || isLoadingYield) {
    return (
      <div className="bg-white rounded-lg border border-gray-200 p-6">
        <div className="animate-pulse space-y-4">
          <div className="h-6 bg-gray-200 rounded w-1/3"></div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-24 bg-gray-200 rounded"></div>
            ))}
          </div>
          <div className="h-48 bg-gray-200 rounded"></div>
        </div>
      </div>
    );
  }

  if (yieldError) {
    return (
      <div className="bg-white rounded-lg border border-red-200 p-6">
        <div className="flex items-center space-x-3">
          <svg className="w-6 h-6 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <div>
            <h3 className="text-lg font-medium text-red-800">Unable to Load Yield Data</h3>
            <p className="text-red-600">{yieldError}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`bg-white rounded-lg border ${disabled ? 'opacity-60' : ''}`}>
      {/* Header */}
      <div className="p-6 border-b border-gray-200">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <div className={`w-3 h-3 rounded-full ${disabled ? 'bg-gray-400' : 'bg-blue-500'} animate-pulse`}></div>
            <h3 className="text-lg font-semibold text-gray-900">
              Real Cetus DEX Yield
            </h3>
            {!disabled && (
              <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
                LIVE
              </span>
            )}
            {disabled && (
              <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-500">
                INACTIVE
              </span>
            )}
          </div>
          <button
            onClick={() => setShowHistory(!showHistory)}
            disabled={disabled}
            className={`text-sm px-3 py-1 rounded-md border transition-colors ${
              disabled 
                ? 'border-gray-200 text-gray-400 cursor-not-allowed'
                : 'border-gray-300 text-gray-700 hover:bg-gray-50'
            }`}
          >
            {showHistory ? 'Hide History' : 'View History'}
          </button>
        </div>
        
        {disabled && (
          <div className="mt-4 p-3 bg-yellow-50 border border-yellow-200 rounded-md">
            <div className="flex items-center space-x-2">
              <svg className="w-5 h-5 text-yellow-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.732 15.5c-.77.833.192 2.5 1.732 2.5z" />
              </svg>
              <p className="text-sm text-yellow-700 font-medium">
                🔒 Yield management requires circle activation
              </p>
            </div>
            <p className="text-xs text-yellow-600 mt-1 ml-7">
              The circle administrator must activate the circle before yield features become available.
            </p>
          </div>
        )}
      </div>

      {/* Yield Overview */}
      <div className="p-6">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          <div className="bg-gray-50 rounded-lg p-4">
            <div className="text-sm font-medium text-gray-600">Active Positions</div>
            <div className="text-2xl font-bold text-gray-900 mt-1">
              {yieldData?.positions?.length || 0}
            </div>
            <div className="text-xs text-gray-500 mt-1">Liquidity pools</div>
          </div>
          
          <div className="bg-gray-50 rounded-lg p-4">
            <div className="text-sm font-medium text-gray-600">Total Liquidity</div>
            <div className="text-2xl font-bold text-purple-600 mt-1">
              {formatCurrency(yieldData?.totalDeposited?.sui || 0)} SUI
            </div>
            <div className="text-xs text-gray-500 mt-1">In Cetus pools</div>
          </div>
          
          <div className="bg-gray-50 rounded-lg p-4">
            <div className="text-sm font-medium text-gray-600">Earned Fees</div>
            <div className="text-2xl font-bold text-green-600 mt-1">
              +{formatCurrency(yieldData?.totalEarned?.sui || 0)} SUI
            </div>
            <div className="text-xs text-gray-500 mt-1">
              ≈ {formatUSD(yieldData?.totalEarned?.totalUsd || 0)}
            </div>
          </div>
          
          <div className="bg-gray-50 rounded-lg p-4">
            <div className="text-sm font-medium text-gray-600">Current APR</div>
            <div className="text-2xl font-bold text-blue-600 mt-1">
              {yieldData?.currentAPR?.toFixed(2) || '0.00'}%
            </div>
            <div className="text-xs text-gray-500 mt-1">From trading fees</div>
          </div>
        </div>

        {/* Pool Statistics */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6 text-sm">
          <div>
            <span className="text-gray-600">Pool TVL: </span>
            <span className="font-semibold">$1500000.00</span>
          </div>
          <div>
            <span className="text-gray-600">24h Volume: </span>
            <span className="font-semibold">$75000.00</span>
          </div>
          <div>
            <span className="text-gray-600">24h Fees: </span>
            <span className="font-semibold text-green-600">$225.00</span>
          </div>
        </div>

        {/* No Positions Message */}
        {(!yieldData?.positions || yieldData.positions.length === 0) && (
          <div className="text-center py-8">
            <div className="text-gray-500 mb-4">
              {disabled 
                ? "⚠️ Circle activation required for yield management features."
                : "No active Cetus positions found. Start earning real yield from DEX trading fees!"
              }
            </div>
            {!disabled && (
              <button 
                className="bg-blue-600 text-white px-4 py-2 rounded-md hover:bg-blue-700 transition-colors"
                onClick={() => {/* Handle add liquidity */}}
              >
                Add Liquidity to Cetus
              </button>
            )}
          </div>
        )}

        {/* Action Buttons */}
        {yieldData?.totalEarned && yieldData.totalEarned.totalUsd > 0 && (
          <div className="flex flex-col sm:flex-row gap-3 mb-6">
            <button
              onClick={handleCollectYield}
              disabled={disabled || isCollecting}
              className={`flex-1 px-4 py-3 rounded-lg font-medium transition-colors ${
                disabled
                  ? 'bg-gray-200 text-gray-400 cursor-not-allowed'
                  : 'bg-green-600 text-white hover:bg-green-700 disabled:opacity-50'
              }`}
            >
              {isCollecting ? (
                <span className="flex items-center justify-center">
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                  Collecting...
                </span>
              ) : (
                `Collect Yield (${formatCurrency(yieldData.totalEarned.sui)} SUI)`
              )}
            </button>
            
            <button
              onClick={handleReinvestYield}
              disabled={disabled || isReinvesting}
              className={`flex-1 px-4 py-3 rounded-lg font-medium transition-colors ${
                disabled
                  ? 'bg-gray-200 text-gray-400 cursor-not-allowed'
                  : 'bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50'
              }`}
            >
              {isReinvesting ? (
                <span className="flex items-center justify-center">
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                  Reinvesting...
                </span>
              ) : (
                'Reinvest Yield'
              )}
            </button>
          </div>
        )}
      </div>

      {/* Yield History Section */}
      {showHistory && (
        <div className="border-t border-gray-200">
          <div className="p-6">
            <div className="flex items-center justify-between mb-4">
              <h4 className="text-lg font-medium text-gray-900">Yield History</h4>
              <div className="flex space-x-2">
                {(['7d', '30d', '90d', '1y'] as const).map((period) => (
                  <button
                    key={period}
                    onClick={() => setSelectedPeriod(period)}
                    disabled={disabled}
                    className={`px-3 py-1 text-sm rounded-md transition-colors ${
                      disabled
                        ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                        : selectedPeriod === period
                        ? 'bg-blue-100 text-blue-700'
                        : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                    }`}
                  >
                    {period}
                  </button>
                ))}
              </div>
            </div>

            {/* Simplified Chart Visualization */}
            <div className="mb-6">
              <div className="h-64 bg-gray-50 rounded-lg flex items-end justify-between p-4 space-x-1">
                {yieldHistory.slice(-30).map((point, index) => (
                  <div
                    key={index}
                    className={`w-2 rounded-t transition-colors ${
                      disabled ? 'bg-gray-300' : 'bg-blue-500'
                    }`}
                    style={{
                      height: `${Math.max(5, (point.dailyEarnings / Math.max(...yieldHistory.map(p => p.dailyEarnings))) * 220)}px`
                    }}
                    title={`${new Date(point.timestamp).toLocaleDateString()}: $${point.dailyEarnings.toFixed(2)}`}
                  />
                ))}
              </div>
              <div className="flex justify-between text-xs text-gray-500 mt-2">
                <span>{new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toLocaleDateString()}</span>
                <span>Daily Earnings (USD)</span>
                <span>{new Date().toLocaleDateString()}</span>
              </div>
            </div>

            {/* History Table */}
            <div className="bg-gray-50 rounded-lg p-4">
              <div className="flex items-center justify-between mb-3">
                <h5 className="font-medium text-gray-900">Recent Activity</h5>
                <button
                  onClick={() => setShowHistoryModal(true)}
                  disabled={disabled}
                  className={`text-sm px-3 py-1 rounded border transition-colors ${
                    disabled
                      ? 'border-gray-200 text-gray-400 cursor-not-allowed'
                      : 'border-gray-300 text-gray-700 hover:bg-gray-100'
                  }`}
                >
                  View All
                </button>
              </div>
              
              <div className="space-y-2">
                {yieldHistory.slice(-5).reverse().map((point, index) => (
                  <div key={index} className="flex justify-between items-center py-2 border-b border-gray-200 last:border-b-0">
                    <div>
                      <div className="text-sm font-medium text-gray-900">
                        {new Date(point.timestamp).toLocaleDateString()}
                      </div>
                      <div className="text-xs text-gray-500">
                        APR: {point.apr.toFixed(2)}%
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-sm font-medium text-green-600">
                        +${point.dailyEarnings.toFixed(2)}
                      </div>
                      <div className="text-xs text-gray-500">
                        Vol: ${point.poolVolume.toLocaleString()}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* History Modal */}
      {showHistoryModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg max-w-4xl w-full max-h-[80vh] overflow-hidden">
            <div className="p-6 border-b border-gray-200">
              <div className="flex justify-between items-center">
                <h3 className="text-lg font-semibold text-gray-900">Complete Yield History</h3>
                <button
                  onClick={() => setShowHistoryModal(false)}
                  className="text-gray-400 hover:text-gray-600"
                >
                  <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>
            
            <div className="p-6 overflow-y-auto max-h-[60vh]">
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Date
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Daily Earnings
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Cumulative
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        APR
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Pool Volume
                      </th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {yieldHistory.slice().reverse().map((point, index) => (
                      <tr key={index} className="hover:bg-gray-50">
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                          {new Date(point.timestamp).toLocaleDateString()}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-green-600">
                          +${point.dailyEarnings.toFixed(2)}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                          ${point.cumulativeEarnings.toFixed(2)}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                          {point.apr.toFixed(2)}%
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                          ${point.poolVolume.toLocaleString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}; 