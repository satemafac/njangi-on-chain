// YieldStrategySection.tsx - Main section for yield management in Circle Management interface

import React, { useState, useEffect } from 'react';
import { YieldStrategy } from './types/yield.types';
import { StrategySelector } from './components/StrategySelector';
import { STRATEGY_CONFIGS } from './config/strategies';

interface YieldStrategySectionProps {
  currentStrategy?: YieldStrategy;
  onStrategyChange?: (strategy: YieldStrategy) => void;
  totalSecurityDeposits?: number;
  isLoading?: boolean;
  disabled?: boolean;
}

export const YieldStrategySection: React.FC<YieldStrategySectionProps> = ({
  currentStrategy = 'conservative', // Default to conservative strategy
  onStrategyChange,
  totalSecurityDeposits = 0,
  isLoading = false,
  disabled = false
}) => {
  const [selectedStrategy, setSelectedStrategy] = useState<YieldStrategy>(currentStrategy);
  const [isChangingStrategy, setIsChangingStrategy] = useState(false);

  // Update local state when props change
  useEffect(() => {
    setSelectedStrategy(currentStrategy);
  }, [currentStrategy]);

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

  const calculatePotentialEarnings = (strategy: YieldStrategy, principal: number) => {
    const config = STRATEGY_CONFIGS[strategy];
    const apyNumber = parseFloat(config.apy.replace('%', '').replace('+', ''));
    const monthlyRate = apyNumber / 100 / 12;
    return principal * monthlyRate;
  };

  const currentConfig = STRATEGY_CONFIGS[selectedStrategy];
  const potentialMonthlyEarnings = calculatePotentialEarnings(selectedStrategy, totalSecurityDeposits);

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
              </ul>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}; 