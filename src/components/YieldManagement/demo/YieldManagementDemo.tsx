// YieldManagementDemo.tsx - Demo component to showcase the yield strategy selection interface

import React, { useState } from 'react';
import { YieldStrategySection } from '../YieldStrategySection';
import { YieldStrategy } from '../types/yield.types';

export const YieldManagementDemo: React.FC = () => {
  const [currentStrategy, setCurrentStrategy] = useState<YieldStrategy>('conservative');
  const [totalDeposits, setTotalDeposits] = useState(2.5);
  const [isLoading, setIsLoading] = useState(false);

  const handleStrategyChange = async (strategy: YieldStrategy) => {
    console.log('Strategy changed to:', strategy);
    
    // Simulate API call delay
    setIsLoading(true);
    await new Promise(resolve => setTimeout(resolve, 1500));
    setCurrentStrategy(strategy);
    setIsLoading(false);
    
    alert(`✅ Successfully switched to ${strategy.charAt(0).toUpperCase() + strategy.slice(1)} strategy!`);
  };

  return (
    <div className="min-h-screen bg-gray-50 py-8">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Demo Header */}
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-gray-900 mb-4">
            Yield Management Interface Demo
          </h1>
          <p className="text-gray-600 max-w-2xl mx-auto">
            This is a demonstration of the beginner-friendly yield strategy selection interface 
            designed for the Njangi Circle Management system.
          </p>
        </div>

        {/* Demo Controls */}
        <div className="bg-white rounded-lg border border-gray-300 p-6 mb-8">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Demo Controls</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Security Deposits Amount (SUI)
              </label>
              <input
                type="number"
                step="0.1"
                min="0"
                max="100"
                value={totalDeposits}
                onChange={(e) => setTotalDeposits(parseFloat(e.target.value) || 0)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <p className="text-xs text-gray-500 mt-1">
                Adjust this to see how earnings calculations change
              </p>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Current Strategy
              </label>
              <div className="px-3 py-2 bg-gray-100 border border-gray-300 rounded-md">
                <span className="capitalize font-medium">{currentStrategy}</span>
              </div>
              <p className="text-xs text-gray-500 mt-1">
                This will change when you select a new strategy
              </p>
            </div>
          </div>
        </div>

        {/* Main Component Demo */}
        <YieldStrategySection
          currentStrategy={currentStrategy}
          onStrategyChange={handleStrategyChange}
          totalSecurityDeposits={totalDeposits}
          isLoading={isLoading}
          disabled={false}
        />

        {/* Feature Highlights */}
        <div className="mt-8 bg-white rounded-lg border border-gray-200 p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Key Features Demonstrated</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            <div>
              <div className="flex items-center mb-2">
                <div className="w-2 h-2 bg-green-500 rounded-full mr-2"></div>
                <h3 className="font-medium text-gray-900">Beginner-Friendly</h3>
              </div>
              <ul className="text-sm text-gray-600 space-y-1">
                <li>• Simple language (APY → &quot;Yearly Earnings&quot;)</li>
                <li>• Clear risk indicators with emojis</li>
                <li>• Educational tooltips for all terms</li>
                <li>• Progressive disclosure design</li>
              </ul>
            </div>
            
            <div>
              <div className="flex items-center mb-2">
                <div className="w-2 h-2 bg-blue-500 rounded-full mr-2"></div>
                <h3 className="font-medium text-gray-900">Interactive Design</h3>
              </div>
              <ul className="text-sm text-gray-600 space-y-1">
                <li>• Hover effects on strategy cards</li>
                <li>• Confirmation dialogs for changes</li>
                <li>• Real-time earnings calculations</li>
                <li>• Responsive grid layout</li>
              </ul>
            </div>
            
            <div>
              <div className="flex items-center mb-2">
                <div className="w-2 h-2 bg-purple-500 rounded-full mr-2"></div>
                <h3 className="font-medium text-gray-900">Educational Content</h3>
              </div>
              <ul className="text-sm text-gray-600 space-y-1">
                <li>• Strategy comparison table</li>
                <li>• Risk/benefit explanations</li>
                <li>• &quot;Learn More&quot; expandable sections</li>
                <li>• Pro tips and guidance</li>
              </ul>
            </div>
          </div>
        </div>

        {/* Integration Note */}
        <div className="mt-8 bg-blue-50 border border-blue-200 rounded-lg p-6">
          <h2 className="text-lg font-semibold text-blue-900 mb-2">Ready for Integration</h2>
          <p className="text-blue-800">
            This yield strategy selection interface is ready to be integrated into the Circle Management page. 
            It will fit seamlessly between the &quot;Circle Management&quot; action buttons and the &quot;Stablecoin Auto-Swap Settings&quot; 
            section, as outlined in our comprehensive UI plan.
          </p>
        </div>
      </div>
    </div>
  );
}; 