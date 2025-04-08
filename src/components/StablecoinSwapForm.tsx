import React, { useState } from 'react';
import { toast } from 'react-hot-toast';
import { useAuth } from '../contexts/AuthContext';
import { swapService, SwapQuote } from '../services/swap-service';

interface StablecoinSwapFormProps {
  circleId: string;
  walletId: string;
  contributionAmount: number;
  onSwapComplete?: () => void;
}

const StablecoinSwapForm: React.FC<StablecoinSwapFormProps> = ({
  circleId,
  walletId,
  contributionAmount = 0, // Provide default value to prevent null
  onSwapComplete
}) => {
  const { account, userAddress } = useAuth();
  const [loading, setLoading] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [swapQuote, setSwapQuote] = useState<SwapQuote | null>(null);
  const [error, setError] = useState<string | null>(null);
  
  // Constants for this form
  const SUI_COIN_TYPE = '0x2::sui::SUI';
  const USDC_COIN_TYPE = '0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN';

  // Fetch swap quote when component mounts
  React.useEffect(() => {
    if (contributionAmount > 0) {
      getSwapEstimate();
    }
  }, [contributionAmount]);

  const getSwapEstimate = async () => {
    if (!contributionAmount || contributionAmount <= 0) {
      toast.error('Invalid contribution amount');
      return;
    }

    if (!circleId) {
      toast.error('Circle ID is required for swap estimation');
      return;
    }

    setLoading(true);
    setError(null);
    
    try {
      const quote = await swapService.getSwapEstimate(
        SUI_COIN_TYPE,
        USDC_COIN_TYPE,
        contributionAmount,
        circleId
      );
      
      if (quote) {
        setSwapQuote(quote);
      } else {
        // If null is returned, an error toast was already shown by the service
        setError('Could not get a quote for this swap. Please try again later.');
      }
    } catch (error) {
      console.error('Error getting swap estimate:', error);
      setError(
        error instanceof Error 
          ? error.message 
          : 'An unexpected error occurred. Please try again.'
      );
    } finally {
      setLoading(false);
    }
  };

  const handleSwap = async () => {
    if (!swapQuote || !account || !walletId || !userAddress || !circleId) {
      toast.error('Missing required information for swap');
      return;
    }

    setProcessing(true);
    try {
      // In a real implementation, this would execute the swap and configure it in the database
      // Here we're simulating both
      
      // 1. Execute the swap
      toast.loading('Processing swap...', { id: 'swap-tx' });
      
      // Simulate processing time
      await new Promise(resolve => setTimeout(resolve, 1500));
      
      // 2. Save the configuration
      const config = {
        circleId,
        walletId,
        enabled: true,
        targetCoinType: USDC_COIN_TYPE,
        fullCoinType: USDC_COIN_TYPE,
        slippageTolerance: 0.5, // 0.5%
        minimumSwapAmount: Math.floor(contributionAmount * 1e9 * 0.9), // 90% of contribution
        updatedBy: userAddress,
        updatedAt: new Date().toISOString()
      };
      
      const saveResult = await fetch('/api/circles/swap-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config)
      });
      
      if (!saveResult.ok) {
        throw new Error('Failed to save swap configuration');
      }
      
      toast.success('Swap configured successfully!', { id: 'swap-tx' });
      
      // Notify parent component
      if (onSwapComplete) {
        onSwapComplete();
      }
    } catch (error) {
      console.error('Error in swap process:', error);
      toast.error(
        error instanceof Error 
          ? `Swap failed: ${error.message}` 
          : 'Swap failed. Please try again.',
        { id: 'swap-tx' }
      );
    } finally {
      setProcessing(false);
    }
  };

  // Format numbers safely to prevent null reference errors
  const safeFormat = (value: number | null | undefined, decimals = 2): string => {
    if (value === null || value === undefined || isNaN(value)) {
      return '0.00';
    }
    return value.toFixed(decimals);
  };

  return (
    <div className="bg-white rounded-lg shadow-sm p-6 border border-gray-200">
      <h3 className="text-lg font-medium text-gray-900 mb-4">Configure Auto Stablecoin Swaps</h3>
      <p className="text-sm text-gray-600 mb-4">
        This simulated swap will configure your contribution to be automatically converted to USDC.
      </p>
      
      <div className="space-y-4">
        {/* Contribution amount display */}
        <div className="p-4 bg-blue-50 rounded-md border border-blue-100">
          <div className="flex justify-between items-center">
            <span className="text-blue-800 font-medium">Contribution Amount:</span>
            <span className="font-bold text-blue-700">{safeFormat(contributionAmount, 4)} SUI</span>
          </div>
        </div>
        
        {/* Loading state */}
        {loading && (
          <div className="flex justify-center py-4">
            <svg className="animate-spin h-6 w-6 text-blue-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
          </div>
        )}
        
        {/* Error message */}
        {error && (
          <div className="p-3 bg-red-50 border border-red-200 rounded-md">
            <p className="text-sm text-red-700">{error}</p>
            <button 
              onClick={getSwapEstimate}
              className="mt-2 text-xs font-medium text-red-700 hover:text-red-900"
            >
              Try Again
            </button>
          </div>
        )}
        
        {/* Quote result */}
        {swapQuote && !error && (
          <div className="bg-gray-50 p-4 rounded-md border border-gray-200">
            <div className="flex justify-between items-center mb-2">
              <span className="text-gray-600">You&apos;ll receive approximately:</span>
              <span className="font-medium">
                {swapQuote?.amountOut ? safeFormat(swapQuote.amountOut / 1e6, 2) : '0.00'} USDC
              </span>
            </div>
            <div className="flex justify-between items-center mb-2">
              <span className="text-gray-600">Exchange rate:</span>
              <span className="font-medium">1 SUI = {swapQuote?.price ? safeFormat(swapQuote.price, 4) : '0.00'} USDC</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-gray-600">Price impact:</span>
              <span className={`font-medium ${
                (swapQuote?.priceImpact || 0) > 1 ? 'text-amber-600' : 'text-green-600'
              }`}>
                {swapQuote?.priceImpact ? safeFormat(swapQuote.priceImpact, 2) : '0.00'}%
              </span>
            </div>
          </div>
        )}
        
        {/* Action buttons */}
        <div className="flex flex-col space-y-3">
          {swapQuote && !error && (
            <button
              onClick={handleSwap}
              disabled={processing}
              className={`w-full py-3 px-4 rounded-lg shadow-sm text-white font-medium ${
                processing 
                  ? 'bg-gray-400 cursor-not-allowed' 
                  : 'bg-gradient-to-r from-green-500 to-green-600 hover:from-green-600 hover:to-green-700'
              } transition-all`}
            >
              {processing ? (
                <span className="flex items-center justify-center">
                  <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                  Processing...
                </span>
              ) : (
                'Configure Auto Swap'
              )}
            </button>
          )}
          
          {(!swapQuote || error) && !loading && (
            <button
              onClick={getSwapEstimate}
              className="w-full py-2 px-4 rounded-lg shadow-sm text-blue-700 font-medium border border-blue-300 hover:bg-blue-50 transition-all"
            >
              Refresh Quote
            </button>
          )}
        </div>
        
        <p className="text-xs text-gray-500 mt-2">
          Note: This simulates enabling automatic stablecoin swaps for your contributions.
        </p>
      </div>
    </div>
  );
};

export default StablecoinSwapForm; 