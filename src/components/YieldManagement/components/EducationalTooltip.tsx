// EducationalTooltip.tsx - Beginner-friendly tooltips for yield management

import React, { useState } from 'react';
import { EDUCATIONAL_CONTENT } from '../config/strategies';
import { YieldStrategy } from '../types/yield.types';

interface EducationalTooltipProps {
  content?: string;
  strategy?: YieldStrategy;
  term?: 'apy' | 'risk' | 'protocol' | 'yield';
  children: React.ReactNode;
  position?: 'top' | 'bottom' | 'left' | 'right';
}

const TERM_EXPLANATIONS = {
  apy: {
    title: 'Yearly Earnings (APY)',
    content: 'This shows how much extra money you earn per year. For example, 6.8% means if you put in $100, you\'d earn $6.80 extra in a year.'
  },
  risk: {
    title: 'Risk Level',
    content: 'This shows how much your earnings might go up or down. Low risk means steady returns, higher risk means returns can vary more but might be higher on average.'
  },
  protocol: {
    title: 'Earning Partners',
    content: 'These are trusted companies that help grow your money. They\'ve been tested and used by thousands of people safely.'
  },
  yield: {
    title: 'Smart Savings',
    content: 'This means automatically putting your money in the best places to earn more, just like a bank does with your savings account.'
  }
};

export const EducationalTooltip: React.FC<EducationalTooltipProps> = ({
  content,
  strategy,
  term,
  children,
  position = 'top'
}) => {
  const [isVisible, setIsVisible] = useState(false);
  
  const getTooltipContent = () => {
    if (content) return { title: '', content };
    if (strategy) return {
      title: EDUCATIONAL_CONTENT[strategy]?.title || '',
      content: EDUCATIONAL_CONTENT[strategy]?.shortDescription || ''
    };
    if (term) return TERM_EXPLANATIONS[term];
    return { title: '', content: '' };
  };

  const tooltipContent = getTooltipContent();
  
  const positionClasses = {
    top: 'bottom-full left-1/2 transform -translate-x-1/2 mb-2',
    bottom: 'top-full left-1/2 transform -translate-x-1/2 mt-2',
    left: 'right-full top-1/2 transform -translate-y-1/2 mr-2',
    right: 'left-full top-1/2 transform -translate-y-1/2 ml-2'
  };

  const arrowClasses = {
    top: 'top-full left-1/2 transform -translate-x-1/2 border-t-gray-900 border-t-8 border-x-transparent border-x-8 border-b-0',
    bottom: 'bottom-full left-1/2 transform -translate-x-1/2 border-b-gray-900 border-b-8 border-x-transparent border-x-8 border-t-0',
    left: 'left-full top-1/2 transform -translate-y-1/2 border-l-gray-900 border-l-8 border-y-transparent border-y-8 border-r-0',
    right: 'right-full top-1/2 transform -translate-y-1/2 border-r-gray-900 border-r-8 border-y-transparent border-y-8 border-l-0'
  };

  return (
    <div className="relative inline-block">
      <div
        onMouseEnter={() => setIsVisible(true)}
        onMouseLeave={() => setIsVisible(false)}
        className="cursor-help"
      >
        {children}
      </div>
      
      {isVisible && (
        <div
          className={`absolute z-50 ${positionClasses[position]} w-72 px-3 py-2 bg-gray-900 text-white text-sm rounded-lg shadow-lg`}
        >
          {tooltipContent.title && (
            <div className="font-semibold mb-1 text-white">
              {tooltipContent.title}
            </div>
          )}
          <div className="text-gray-100 leading-relaxed">
            {tooltipContent.content}
          </div>
          
          {/* Arrow */}
          <div className={`absolute ${arrowClasses[position]} w-0 h-0`} />
        </div>
      )}
    </div>
  );
};

// Simple info icon component for tooltips
export const InfoIcon: React.FC<{ className?: string }> = ({ className = "" }) => (
  <svg 
    className={`inline-block w-4 h-4 text-gray-400 hover:text-gray-600 transition-colors ${className}`}
    fill="currentColor" 
    viewBox="0 0 20 20"
  >
    <path 
      fillRule="evenodd" 
      d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" 
      clipRule="evenodd" 
    />
  </svg>
); 