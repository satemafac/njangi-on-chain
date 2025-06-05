// StrategySelector.tsx - Main component for selecting yield strategies

import React, { useState } from 'react';
import { YieldStrategy } from '../types/yield.types';
import { STRATEGY_CONFIGS } from '../config/strategies';
import { StrategyCard } from './StrategyCard';
import { EducationalTooltip, InfoIcon } from './EducationalTooltip';

interface StrategySelectorProps {
  selectedStrategy?: YieldStrategy;
  onStrategySelect?: (strategy: YieldStrategy) => void;
  disabled?: boolean;
  showDetailedInfo?: boolean;
  className?: string;
}

export const StrategySelector: React.FC<StrategySelectorProps> = ({
  selectedStrategy,
  onStrategySelect,
  disabled = false,
  showDetailedInfo = true,
  className = ''
}) => {
  const [isConfirming, setIsConfirming] = useState(false);
  const [pendingStrategy, setPendingStrategy] = useState<YieldStrategy | null>(null);

  const strategies = Object.values(STRATEGY_CONFIGS);

  const handleStrategySelect = (strategy: YieldStrategy) => {
    if (disabled) return;

    // If changing from an existing strategy, show confirmation
    if (selectedStrategy && selectedStrategy !== strategy) {
      setPendingStrategy(strategy);
      setIsConfirming(true);
    } else {
      // First time selection or same strategy
      onStrategySelect?.(strategy);
    }
  };

  const confirmStrategyChange = () => {
    if (pendingStrategy) {
      onStrategySelect?.(pendingStrategy);
      setIsConfirming(false);
      setPendingStrategy(null);
    }
  };

  const cancelStrategyChange = () => {
    setIsConfirming(false);
    setPendingStrategy(null);
  };

  return (
    <div className={`space-y-6 ${className}`}>
      {/* Header */}
      <div className="text-center space-y-2">
        <h3 className="text-xl font-bold text-gray-900 flex items-center justify-center">
          Circle Earnings Strategy
          <EducationalTooltip term="yield" position="right">
            <InfoIcon className="ml-2" />
          </EducationalTooltip>
        </h3>
        <p className="text-gray-600 max-w-2xl mx-auto">
          Generate additional income on member security deposits. Choose the strategy that matches your comfort level.
        </p>
      </div>

      {/* Strategy Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {strategies.map((strategy) => (
          <StrategyCard
            key={strategy.type}
            strategy={strategy}
            isSelected={selectedStrategy === strategy.type}
            onSelect={handleStrategySelect}
            disabled={disabled}
            showDetailedInfo={showDetailedInfo}
            className="h-full"
          />
        ))}
      </div>

      {/* Educational note */}
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <div className="flex items-start">
          <div className="flex-shrink-0">
            <svg className="w-5 h-5 text-blue-400 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
            </svg>
          </div>
          <div className="ml-3">
            <h4 className="text-sm font-medium text-blue-800">How it works</h4>
            <p className="text-sm text-blue-700 mt-1">
              Your circle&apos;s security deposits automatically earn additional income while remaining available for member payouts. 
              You can change strategies anytime, and all earnings are distributed back to the circle members.
            </p>
          </div>
        </div>
      </div>

      {/* Strategy Comparison Table - Hidden on mobile */}
      <div className="hidden lg:block bg-gray-50 rounded-lg p-6">
        <h4 className="text-lg font-semibold text-gray-900 mb-4">Strategy Comparison</h4>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-300">
                <th className="text-left py-2 font-medium text-gray-900">Strategy</th>
                <th className="text-center py-2 font-medium text-gray-900">Yearly Earnings</th>
                <th className="text-center py-2 font-medium text-gray-900">Risk Level</th>
                <th className="text-left py-2 font-medium text-gray-900">Best For</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {strategies.map((strategy) => (
                <tr key={strategy.type} className={selectedStrategy === strategy.type ? 'bg-blue-50' : ''}>
                  <td className="py-3 font-medium text-gray-900">{strategy.displayName}</td>
                  <td className="py-3 text-center">
                    <span className={`font-bold ${
                      strategy.color === 'green' ? 'text-green-600' :
                      strategy.color === 'yellow' ? 'text-yellow-600' : 'text-orange-600'
                    }`}>
                      {strategy.apy}
                    </span>
                  </td>
                  <td className="py-3 text-center">
                    <span className={`px-2 py-1 rounded-full text-xs ${
                      strategy.risk === 'low' ? 'bg-green-100 text-green-800' :
                      strategy.risk === 'medium' ? 'bg-yellow-100 text-yellow-800' :
                      'bg-orange-100 text-orange-800'
                    }`}>
                      {strategy.risk === 'higher' ? 'Higher' : strategy.risk.charAt(0).toUpperCase() + strategy.risk.slice(1)}
                    </span>
                  </td>
                  <td className="py-3 text-gray-600">
                    {strategy.risk === 'low' ? 'Beginners, stability seekers' :
                     strategy.risk === 'medium' ? 'Balanced investors' :
                     'Experienced users, growth focused'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Confirmation Modal */}
      {isConfirming && pendingStrategy && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg max-w-md w-full p-6">
            <h3 className="text-lg font-semibold text-gray-900 mb-4">
              Confirm Strategy Change
            </h3>
            <p className="text-gray-600 mb-6">
              Are you sure you want to change from <strong>{STRATEGY_CONFIGS[selectedStrategy!].displayName}</strong> to{' '}
              <strong>{STRATEGY_CONFIGS[pendingStrategy].displayName}</strong>? 
              This will affect how your circle&apos;s deposits earn income.
            </p>
            <div className="flex space-x-3">
              <button
                onClick={confirmStrategyChange}
                className="flex-1 bg-blue-500 hover:bg-blue-600 text-white font-medium py-2 px-4 rounded-lg transition-colors"
              >
                Yes, Change Strategy
              </button>
              <button
                onClick={cancelStrategyChange}
                className="flex-1 bg-gray-200 hover:bg-gray-300 text-gray-800 font-medium py-2 px-4 rounded-lg transition-colors"
              >
                Keep Current
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}; 