import React, { useState } from 'react';
import { toast } from 'react-hot-toast';
import { useAuth } from '../contexts/AuthContext';
import { swapService, SwapQuote } from '../services/swap-service';

interface SwapAndDepositFormProps {
  walletId: string;
  circleId: string;
  onComplete?: () => void;
}

/**
 * A component that performs a two-step process:
 * 1. Swap tokens using a DEX
 * 2. Deposit the resulting stablecoin to the custody wallet
 */
const SwapAndDepositForm: React.FC<SwapAndDepositFormProps> = ({
  walletId,
  circleId,
  onComplete,
}) => {
  const { account } = useAuth();
  const [amount, setAmount] = useState<string>('');
  const [swapQuote, setSwapQuote] = useState<SwapQuote | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [processingSwap, setProcessingSwap] = useState<boolean>(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);

  // Constants for this form
  const SUI_COIN_TYPE = '0x2::sui::SUI';
  const USDC_COIN_TYPE = '0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN';

  const getSwapEstimate = async () => {
    if (!amount || parseFloat(amount) <= 0) {
      toast.error('Please enter a valid amount');
      return;
    }

    if (!circleId) {
      toast.error('Circle ID is required for swap estimation');
      return;
    }

    setLoading(true);
    setQuoteError(null);
    
    try {
      const quote = await swapService.getSwapEstimate(
        SUI_COIN_TYPE,
        USDC_COIN_TYPE,
        parseFloat(amount),
        circleId
      );
      
      if (quote) {
        setSwapQuote(quote);
      } else {
        // If null is returned, an error toast was already shown by the service
        setQuoteError('Could not get a quote for this swap. Please try again later.');
      }
    } catch (error) {
      console.error('Error in getSwapEstimate:', error);
      setQuoteError(
        error instanceof Error 
          ? error.message 
          : 'An unexpected error occurred. Please try again.'
      );
    } finally {
      setLoading(false);
    }
  };

  const handleSwapAndDeposit = async () => {
    if (!swapQuote || !account || !walletId || !circleId) {
      toast.error('Missing required information for swap');
      return;
    }

    setProcessingSwap(true);
    
    try {
      // In a real implementation, this would execute the swap and then deposit
      // Here we'll just simulate success
      toast.loading('Processing swap and deposit...', { id: 'swap-deposit' });
      
      // Execute swap
      const swapResult = await swapService.executeSwap(
        SUI_COIN_TYPE,
        USDC_COIN_TYPE,
        parseFloat(amount),
        Math.floor(swapQuote.amountOut * 0.98), // 2% slippage
        circleId
      );
      
      if (!swapResult.success) {
        throw new Error(swapResult.error || 'Swap failed');
      }
      
      // Simulate network delay
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      toast.success('Swap and deposit successful!', { id: 'swap-deposit' });
      
      // Reset form
      setAmount('');
      setSwapQuote(null);
      
      // Notify parent component
      if (onComplete) {
        onComplete();
      }
    } catch (error) {
      console.error('Error in swap and deposit:', error);
      toast.error(
        error instanceof Error 
          ? `Swap failed: ${error.message}` 
          : 'Swap failed. Please try again.',
        { id: 'swap-deposit' }
      );
    } finally {
      setProcessingSwap(false);
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
      <h3 className="text-lg font-medium text-gray-900 mb-4">Swap SUI to USDC and Deposit</h3>
      
      <div className="space-y-4">
        {/* Amount input */}
        <div>
          <label htmlFor="swap-amount" className="block text-sm font-medium text-gray-700 mb-1">
            Amount (SUI)
          </label>
          <div className="relative rounded-md shadow-sm">
            <input
              type="number"
              id="swap-amount"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.0"
              min="0"
              step="0.01"
              className="block w-full px-4 py-3 rounded-md border border-gray-300 focus:ring-blue-500 focus:border-blue-500"
              disabled={loading || processingSwap}
            />
          </div>
        </div>

        {/* Quote button */}
        <button
          onClick={getSwapEstimate}
          disabled={loading || !amount || processingSwap}
          className={`w-full py-2 px-4 rounded text-white ${
            loading
              ? 'bg-gray-400'
              : 'bg-blue-600 hover:bg-blue-700'
          } transition-colors duration-200 font-medium`}
        >
          {loading ? 'Loading...' : 'Get Quote'}
        </button>

        {/* Error message */}
        {quoteError && (
          <div className="p-3 bg-red-50 border border-red-200 rounded-md">
            <p className="text-sm text-red-700">{quoteError}</p>
            <p className="text-xs text-red-500 mt-1">
              Pool data may be unavailable or incorrectly formatted. Try again later.
            </p>
          </div>
        )}

        {/* Quote result */}
        {swapQuote && !quoteError && (
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

        {/* Swap and deposit button */}
        {swapQuote && !quoteError && (
          <button
            onClick={handleSwapAndDeposit}
            disabled={processingSwap}
            className={`w-full py-3 px-4 rounded-lg shadow-sm text-white font-medium ${
              processingSwap 
                ? 'bg-gray-400 cursor-not-allowed' 
                : 'bg-gradient-to-r from-green-500 to-green-600 hover:from-green-600 hover:to-green-700'
            } transition-all`}
          >
            {processingSwap ? (
              <span className="flex items-center justify-center">
                <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                Processing...
              </span>
            ) : (
              'Swap and Deposit'
            )}
          </button>
        )}
        
        <p className="text-xs text-gray-500 mt-2">
          Note: This is a simulated swap. In production, this would interact with a real DEX on SUI.
        </p>
      </div>
    </div>
  );
};

export default SwapAndDepositForm; 