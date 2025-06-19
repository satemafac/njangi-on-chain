// YieldTracker.tsx - Component to track and display real yield positions

import React, { useState, useEffect } from 'react';
import { yieldTrackingService, TrackedYieldData } from '../../services/yield-tracking-service';
import { priceService } from '../../services/price-service';

interface YieldTrackerProps {
  userAddress: string;
  yieldReceiptId?: string; // If specific receipt to track
  refreshTrigger?: number; // To trigger refreshes
  custodyWalletId?: string; // Add custody wallet ID for proper filtering
  circleId?: string; // Add circle ID for proper filtering
}

export const YieldTracker: React.FC<YieldTrackerProps> = ({
  userAddress,
  yieldReceiptId,
  refreshTrigger,
  custodyWalletId,
  circleId
}) => {
  const [trackedYields, setTrackedYields] = useState<TrackedYieldData[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [suiPrice, setSuiPrice] = useState<number>(2.5);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  // Fetch SUI price
  useEffect(() => {
    const fetchPrice = async () => {
      try {
        const price = await priceService.getSUIPrice();
        if (price) setSuiPrice(price);
      } catch (error) {
        console.error('Error fetching SUI price:', error);
      }
    };
    fetchPrice();
  }, []);

  // Fetch yield data
  useEffect(() => {
    const fetchYieldData = async () => {
      if (!userAddress) return;

      setIsLoading(true);
      setError(null);

      try {
        let yieldData: TrackedYieldData[];

        if (yieldReceiptId) {
          // Fetch specific receipt data
          const specificData = await yieldTrackingService.getTrackedYieldData(yieldReceiptId, userAddress);
          yieldData = specificData ? [specificData] : [];
          console.log('Specific receipt data:', specificData);
        } else {
          // Use the new dynamic method with custody wallet and circle filtering
          console.log('Searching for yield data with filters:', {
            userAddress,
            custodyWalletId,
            circleId
          });
          
          yieldData = await yieldTrackingService.getAllUserYieldData(userAddress, custodyWalletId, circleId);
          console.log('Dynamic yield data found:', yieldData);
        }

        setTrackedYields(yieldData);
        setLastUpdated(new Date());
        console.log('Final tracked yields set:', yieldData);
      } catch (err) {
        console.error('Error fetching yield data:', err);
        setError(err instanceof Error ? err.message : 'Failed to load yield data');
      } finally {
        setIsLoading(false);
      }
    };

    fetchYieldData();
  }, [userAddress, yieldReceiptId, refreshTrigger, custodyWalletId, circleId]);

  const formatSUI = (amount: number): string => {
    return amount.toFixed(6);
  };

  const formatUSD = (suiAmount: number): string => {
    return `$${(suiAmount * suiPrice).toFixed(2)}`;
  };

  const formatPercent = (percent: number): string => {
    return `${percent.toFixed(2)}%`;
  };

  const getStrategyName = (strategy: number): string => {
    switch (strategy) {
      case 0: return 'Conservative';
      case 1: return 'Balanced';
      case 2: return 'Aggressive';
      default: return 'Unknown';
    }
  };

  const getStatusColor = (status: string): string => {
    switch (status) {
      case 'active': return 'text-green-600 bg-green-100';
      case 'matured': return 'text-blue-600 bg-blue-100';
      case 'withdrawn': return 'text-gray-600 bg-gray-100';
      default: return 'text-gray-600 bg-gray-100';
    }
  };

  if (isLoading) {
    return (
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
    );
  }

  if (error) {
    return (
      <div className="bg-white rounded-lg border border-gray-200 p-6">
        <div className="text-center">
          <div className="text-red-500 mb-2">
            <svg className="mx-auto h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <h3 className="text-lg font-medium text-gray-900 mb-2">Error Loading Yield Data</h3>
          <p className="text-gray-600 text-sm">{error}</p>
        </div>
      </div>
    );
  }

  if (trackedYields.length === 0) {
    return (
      <div className="bg-white rounded-lg border border-gray-200 p-6">
        <div className="text-center">
          <div className="text-gray-400 mb-2">
            <svg className="mx-auto h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
            </svg>
          </div>
          <h3 className="text-lg font-medium text-gray-900 mb-2">No Yield Positions Found</h3>
          <p className="text-gray-600 text-sm">
            You don&apos;t have any active yield positions yet. Start earning by creating a yield configuration.
          </p>
        </div>
      </div>
    );
  }

  const totalValue = trackedYields.reduce((sum, data) => sum + data.positionValue.current, 0);
  const totalEarnings = trackedYields.reduce((sum, data) => sum + data.earnings.totalEarned, 0);
  const totalInitial = trackedYields.reduce((sum, data) => sum + data.positionValue.initial, 0);
  const averageAPR = trackedYields.length > 0 
    ? trackedYields.reduce((sum, data) => sum + data.earnings.currentAPR, 0) / trackedYields.length
    : 0;

  return (
    <div className="bg-white rounded-2xl sm:rounded-lg border border-gray-200 p-4 sm:p-6 space-y-6 sm:space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-2">
          <div className="w-8 h-8 bg-gradient-to-r from-green-500 to-blue-500 rounded-full flex items-center justify-center">
            <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
            </svg>
          </div>
          <h3 className="text-lg font-semibold text-gray-900">Your Yield Positions</h3>
          <span className="px-2 py-1 text-xs font-medium bg-green-100 text-green-800 rounded-full">
            {trackedYields.length} Active
          </span>
        </div>
        {lastUpdated && (
          <div className="text-xs text-gray-500">
            Updated: {lastUpdated.toLocaleTimeString()}
          </div>
        )}
      </div>

      {/* Summary Cards - Mobile Optimized */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6">
        <div className="bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-200 rounded-2xl p-5 sm:p-4 text-center">
          <div className="text-sm sm:text-xs text-gray-600 mb-2 sm:mb-1">Total Value</div>
          <div className="font-bold text-2xl sm:text-xl text-blue-600 mb-1">{formatSUI(totalValue)} SUI</div>
          <div className="text-sm sm:text-xs text-gray-500">{formatUSD(totalValue)}</div>
        </div>
        
        <div className="bg-gradient-to-r from-green-50 to-emerald-50 border border-green-200 rounded-2xl p-5 sm:p-4 text-center">
          <div className="text-sm sm:text-xs text-gray-600 mb-2 sm:mb-1">Total Earnings</div>
          <div className="font-bold text-2xl sm:text-xl text-green-600 mb-1">+{formatSUI(totalEarnings)} SUI</div>
          <div className="text-sm sm:text-xs text-gray-500">{formatUSD(totalEarnings)}</div>
        </div>
        
        <div className="bg-gradient-to-r from-purple-50 to-pink-50 border border-purple-200 rounded-2xl p-5 sm:p-4 text-center">
          <div className="text-sm sm:text-xs text-gray-600 mb-2 sm:mb-1">Growth</div>
          <div className="font-bold text-2xl sm:text-xl text-purple-600 mb-1">
            {formatPercent(totalInitial > 0 ? (totalEarnings / totalInitial) * 100 : 0)}
          </div>
          <div className="text-sm sm:text-xs text-gray-500">Total return</div>
        </div>
        
        <div className="bg-gradient-to-r from-orange-50 to-red-50 border border-orange-200 rounded-2xl p-5 sm:p-4 text-center">
          <div className="text-sm sm:text-xs text-gray-600 mb-2 sm:mb-1">Avg APR</div>
          <div className="font-bold text-2xl sm:text-xl text-orange-600 mb-1">{formatPercent(averageAPR)}</div>
          <div className="text-sm sm:text-xs text-gray-500">Current rate</div>
        </div>
      </div>

      {/* Individual Positions - Mobile Optimized */}
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
                    {getStrategyName(yieldData.position.strategy)} Strategy
                  </div>
                  <div className="text-sm sm:text-xs text-gray-500 truncate">
                    Receipt: {yieldData.position.yieldReceiptId.slice(0, 12)}...
                  </div>
                </div>
              </div>
              <span className={`px-3 py-1.5 sm:px-2 sm:py-1 text-sm sm:text-xs font-medium rounded-full flex-shrink-0 ${getStatusColor(yieldData.status)}`}>
                {yieldData.status.toUpperCase()}
              </span>
            </div>

            {/* Key Metrics - Mobile Stack */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-3 mb-5 sm:mb-4">
              <div className="bg-white rounded-xl p-4 sm:p-3 border border-gray-100">
                <div className="text-sm sm:text-xs text-gray-600 mb-1">Initial Deposit</div>
                <div className="font-bold text-lg sm:text-base text-gray-900">{formatSUI(yieldData.position.totalDeposit)} SUI</div>
                <div className="text-sm sm:text-xs text-gray-500">{formatUSD(yieldData.position.totalDeposit)}</div>
              </div>
              
              <div className="bg-white rounded-xl p-4 sm:p-3 border border-gray-100">
                <div className="text-sm sm:text-xs text-gray-600 mb-1">Current Value</div>
                <div className="font-bold text-lg sm:text-base text-blue-600">{formatSUI(yieldData.positionValue.current)} SUI</div>
                <div className="text-sm sm:text-xs text-gray-500">{formatUSD(yieldData.positionValue.current)}</div>
              </div>
              
              <div className="bg-white rounded-xl p-4 sm:p-3 border border-gray-100">
                <div className="text-sm sm:text-xs text-gray-600 mb-1">Earnings</div>
                <div className="font-bold text-lg sm:text-base text-green-600">+{formatSUI(yieldData.earnings.totalEarned)} SUI</div>
                <div className="text-sm sm:text-xs text-gray-500">
                  C: {yieldData.earnings.cetusEarnings.toFixed(4)} | N: {yieldData.earnings.naviEarnings.toFixed(4)}
                </div>
              </div>
              
              <div className="bg-white rounded-xl p-4 sm:p-3 border border-gray-100">
                <div className="text-sm sm:text-xs text-gray-600 mb-1">APR</div>
                <div className="font-bold text-lg sm:text-base text-orange-600">{formatPercent(yieldData.earnings.currentAPR)}</div>
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
                        <span className="font-medium">{formatSUI(yieldData.position.cetusAmount)} SUI ({formatPercent((yieldData.position.cetusAmount / yieldData.position.totalDeposit) * 100)})</span>
                      </div>
                      <div className="flex justify-between">
                        <span>NAVI:</span>
                        <span className="font-medium">{formatSUI(yieldData.position.naviAmount)} SUI ({formatPercent((yieldData.position.naviAmount / yieldData.position.totalDeposit) * 100)})</span>
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
  );
}; 