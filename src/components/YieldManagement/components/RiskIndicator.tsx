// RiskIndicator.tsx - Visual risk level indicators for yield strategies

import React from 'react';
import { RiskLevel } from '../types/yield.types';

interface RiskIndicatorProps {
  level: RiskLevel;
  showText?: boolean;
  size?: 'small' | 'medium' | 'large';
  className?: string;
}

const RISK_CONFIG = {
  low: {
    color: 'green',
    bgColor: 'bg-green-50',
    borderColor: 'border-green-200',
    textColor: 'text-green-800',
    iconColor: 'text-green-600',
    emoji: '🟢',
    label: 'Low Risk',
    description: 'Your money is lent to verified borrowers',
    fullDescription: 'Very safe - like a high-yield savings account'
  },
  medium: {
    color: 'yellow',
    bgColor: 'bg-yellow-50',
    borderColor: 'border-yellow-200',
    textColor: 'text-yellow-800',
    iconColor: 'text-yellow-600',
    emoji: '🟡',
    label: 'Medium Risk',
    description: 'Mix of lending and trading for better returns',
    fullDescription: 'Balanced approach - some variation but higher returns'
  },
  higher: {
    color: 'orange',
    bgColor: 'bg-orange-50',
    borderColor: 'border-orange-200',
    textColor: 'text-orange-800',
    iconColor: 'text-orange-600',
    emoji: '🟠',
    label: 'Higher Risk',
    description: 'More trading activity for maximum returns',
    fullDescription: 'More variable but highest potential returns'
  }
};

const SIZE_CONFIG = {
  small: {
    container: 'px-2 py-1 text-xs',
    emoji: 'text-sm',
    text: 'text-xs'
  },
  medium: {
    container: 'px-3 py-2 text-sm',
    emoji: 'text-base',
    text: 'text-sm'
  },
  large: {
    container: 'px-4 py-3 text-base',
    emoji: 'text-lg',
    text: 'text-base'
  }
};

export const RiskIndicator: React.FC<RiskIndicatorProps> = ({
  level,
  showText = true,
  size = 'medium',
  className = ''
}) => {
  const riskConfig = RISK_CONFIG[level];
  const sizeConfig = SIZE_CONFIG[size];

  return (
    <div className={`
      inline-flex items-center rounded-full border
      ${riskConfig.bgColor} ${riskConfig.borderColor} ${riskConfig.textColor}
      ${sizeConfig.container}
      ${className}
    `}>
      <span className={`${sizeConfig.emoji} mr-1`}>
        {riskConfig.emoji}
      </span>
      {showText && (
        <span className={`font-medium ${sizeConfig.text}`}>
          {riskConfig.label}
        </span>
      )}
    </div>
  );
};

// Risk explanation component for detailed views
interface RiskExplanationProps {
  level: RiskLevel;
  showFullDescription?: boolean;
}

export const RiskExplanation: React.FC<RiskExplanationProps> = ({
  level,
  showFullDescription = false
}) => {
  const riskConfig = RISK_CONFIG[level];

  return (
    <div className={`p-3 rounded-lg border ${riskConfig.bgColor} ${riskConfig.borderColor}`}>
      <div className="flex items-center mb-2">
        <RiskIndicator level={level} size="small" />
        <span className={`ml-2 font-medium ${riskConfig.textColor}`}>
          {riskConfig.description}
        </span>
      </div>
      {showFullDescription && (
        <p className={`text-sm ${riskConfig.textColor} opacity-80`}>
          {riskConfig.fullDescription}
        </p>
      )}
    </div>
  );
};

// Risk comparison component
interface RiskComparisonProps {
  levels: RiskLevel[];
  selectedLevel?: RiskLevel;
}

export const RiskComparison: React.FC<RiskComparisonProps> = ({
  levels,
  selectedLevel
}) => {
  return (
    <div className="space-y-2">
      <h4 className="text-sm font-medium text-gray-700 mb-3">Risk Levels Explained</h4>
      {levels.map(level => {
        const isSelected = selectedLevel === level;
        return (
          <div 
            key={level}
            className={`p-3 rounded-lg border-2 transition-all ${
              isSelected 
                ? `${RISK_CONFIG[level].borderColor} bg-white shadow-md` 
                : 'border-gray-200 bg-gray-50'
            }`}
          >
            <RiskExplanation level={level} showFullDescription={isSelected} />
          </div>
        );
      })}
    </div>
  );
}; 