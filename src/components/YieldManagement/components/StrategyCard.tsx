// StrategyCard.tsx - Individual strategy selection cards with beginner-friendly design

import React, { useState } from 'react';
import { StrategyConfig, YieldStrategy } from '../types/yield.types';
import { RiskIndicator } from './RiskIndicator';
import { EducationalTooltip, InfoIcon } from './EducationalTooltip';
import { EDUCATIONAL_CONTENT } from '../config/strategies';

interface StrategyCardProps {
  strategy: StrategyConfig;
  isSelected?: boolean;
  onSelect?: (strategy: YieldStrategy) => void;
  disabled?: boolean;
  showDetailedInfo?: boolean;
  className?: string;
}

export const StrategyCard: React.FC<StrategyCardProps> = ({
  strategy,
  isSelected = false,
  onSelect,
  disabled = false,
  showDetailedInfo = false,
  className = ''
}) => {
  const [isHovered, setIsHovered] = useState(false);
  const [showLearnMore, setShowLearnMore] = useState(false);

  const colorConfig = {
    green: {
      border: isSelected ? 'border-green-500 border-2' : 'border-green-200',
      bg: isSelected ? 'bg-green-50' : 'bg-white hover:bg-green-25',
      accent: 'text-green-600',
      button: 'bg-green-500 hover:bg-green-600 text-white'
    },
    yellow: {
      border: isSelected ? 'border-yellow-500 border-2' : 'border-yellow-200',
      bg: isSelected ? 'bg-yellow-50' : 'bg-white hover:bg-yellow-25',
      accent: 'text-yellow-600',
      button: 'bg-yellow-500 hover:bg-yellow-600 text-white'
    },
    orange: {
      border: isSelected ? 'border-orange-500 border-2' : 'border-orange-200',
      bg: isSelected ? 'bg-orange-50' : 'bg-white hover:bg-orange-25',
      accent: 'text-orange-600',
      button: 'bg-orange-500 hover:bg-orange-600 text-white'
    }
  };

  const colors = colorConfig[strategy.color];
  const educationalContent = EDUCATIONAL_CONTENT[strategy.type];

  const handleSelect = () => {
    if (!disabled && onSelect) {
      onSelect(strategy.type);
    }
  };

  return (
    <div className={`relative ${className}`}>
      <div
        className={`
          relative p-6 rounded-xl border transition-all duration-200 cursor-pointer
          ${colors.border} ${colors.bg}
          ${disabled ? 'opacity-50 cursor-not-allowed' : ''}
          ${isHovered && !disabled ? 'shadow-lg transform scale-105' : 'shadow-md'}
        `}
        onClick={handleSelect}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        {/* Selection indicator */}
        {isSelected && (
          <div className="absolute -top-2 -right-2 w-6 h-6 bg-blue-500 rounded-full flex items-center justify-center">
            <svg className="w-4 h-4 text-white" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
            </svg>
          </div>
        )}

        {/* Header */}
        <div className="mb-4">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-lg font-bold text-gray-900">
              {strategy.displayName}
            </h3>
            <EducationalTooltip term="apy" position="left">
              <div className={`text-2xl font-bold ${colors.accent}`}>
                {strategy.apy}
                <InfoIcon className="ml-1" />
              </div>
            </EducationalTooltip>
          </div>
          
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-600">Yearly Earnings</span>
            <RiskIndicator level={strategy.risk} size="small" />
          </div>
        </div>

        {/* Description */}
        <p className="text-gray-700 text-sm mb-4 leading-relaxed">
          {strategy.detailedDescription}
        </p>

        {/* Protocol allocation */}
        <div className="mb-4">
          <div className="text-xs text-gray-500 mb-2">Your money goes to:</div>
          <div className="space-y-1">
            {strategy.protocols.map((protocol, index) => {
              const allocation = protocol.includes('NAVI') ? strategy.allocation.navi : strategy.allocation.cetus;
              return (
                <div key={index} className="flex items-center justify-between text-sm">
                  <span className="text-gray-600">{protocol}</span>
                  <span className={`font-medium ${colors.accent}`}>{allocation}%</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Detailed info toggle */}
        {showDetailedInfo && (
          <div className="mt-4 pt-4 border-t border-gray-200">
            <button
              onClick={(e) => {
                e.stopPropagation();
                setShowLearnMore(!showLearnMore);
              }}
              className="text-sm text-blue-600 hover:text-blue-800 flex items-center"
            >
              <span>Learn More</span>
              <svg 
                className={`ml-1 w-4 h-4 transition-transform ${showLearnMore ? 'rotate-180' : ''}`}
                fill="currentColor" 
                viewBox="0 0 20 20"
              >
                <path fillRule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clipRule="evenodd" />
              </svg>
            </button>
          </div>
        )}

        {/* Action button */}
        {!isSelected && (
          <button
            onClick={handleSelect}
            disabled={disabled}
            className={`
              w-full mt-4 py-2 px-4 rounded-lg font-medium text-sm transition-colors
              ${colors.button}
              ${disabled ? 'opacity-50 cursor-not-allowed' : ''}
            `}
          >
            Select This Strategy
          </button>
        )}

        {isSelected && (
          <div className="w-full mt-4 py-2 px-4 bg-gray-100 rounded-lg text-center text-sm text-gray-600">
            ✓ Currently Selected
          </div>
        )}
      </div>

      {/* Expandable detailed information */}
      {showLearnMore && showDetailedInfo && (
        <div className="mt-2 p-4 bg-gray-50 rounded-lg border border-gray-200">
          <div className="space-y-3">
            <div>
              <h4 className="font-medium text-gray-900 mb-1">Benefits:</h4>
              <ul className="text-sm text-gray-600 space-y-1">
                {educationalContent?.risksAndBenefits.benefits.map((benefit, index) => (
                  <li key={index} className="flex items-start">
                    <span className="text-green-500 mr-2">✓</span>
                    {benefit}
                  </li>
                ))}
              </ul>
            </div>
            
            <div>
              <h4 className="font-medium text-gray-900 mb-1">Things to Consider:</h4>
              <ul className="text-sm text-gray-600 space-y-1">
                {educationalContent?.risksAndBenefits.risks.map((risk, index) => (
                  <li key={index} className="flex items-start">
                    <span className="text-yellow-500 mr-2">!</span>
                    {risk}
                  </li>
                ))}
              </ul>
            </div>

            <div>
              <h4 className="font-medium text-gray-900 mb-1">Good For:</h4>
              <div className="flex flex-wrap gap-2">
                {educationalContent?.suitableFor.map((suitable, index) => (
                  <span 
                    key={index}
                    className="px-2 py-1 bg-blue-100 text-blue-800 text-xs rounded-full"
                  >
                    {suitable}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}; 