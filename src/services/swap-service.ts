import { toast } from 'react-hot-toast';
import { 
  SUI_COIN_TYPE, 
  USDC_COIN_TYPE, 
  DEEPBOOK_SUI_USDC_POOL as POOL_ID 
} from './constants';
import { priceService } from './price-service';

// Define types
export interface SwapQuote {
  amountIn: number;
  amountOut: number;
  price: number;
  priceImpact: number;
  poolId: string;
}

export type SwapError = {
  code: string;
  message: string;
  details?: string;
};

// Pool data interface matching the API's expected structure
export interface PoolData {
  id: string;
  coinTypeA: string;
  coinTypeB: string;
  reserves: {
    a: string;
    b: string;
  };
}

// SuiSwapRouter mock implementation with proper error handling
export class SuiSwapRouter {
  private validatePoolData(poolData: PoolData | unknown): boolean {
    if (!poolData) return false;
    
    // Type guard to check if the object matches our PoolData interface
    const isPoolData = (data: unknown): data is PoolData => {
      const candidate = data as PoolData;
      return (
        !!candidate &&
        typeof candidate.id === 'string' &&
        typeof candidate.coinTypeA === 'string' &&
        typeof candidate.coinTypeB === 'string' &&
        !!candidate.reserves &&
        typeof candidate.reserves === 'object' &&
        typeof candidate.reserves.a === 'string' &&
        typeof candidate.reserves.b === 'string'
      );
    };
    
    return isPoolData(poolData);
  }

  async getSwapQuote(fromCoin: string, toCoin: string, amount: number, circleId: string, poolId?: string): Promise<SwapQuote> {
    try {
      if (!circleId) {
        throw new Error('Missing circle ID');
      }
      
      // Use our API endpoint instead of direct pool access
      const queryParams = new URLSearchParams({
        action: 'getQuote',
        fromCoin,
        toCoin,
        amount: amount.toString(),
        circleId,
        ...(poolId ? { poolId } : {})
      });
      
      const response = await fetch(`/api/circles/swap-config?${queryParams}`);
      const data = await response.json();
      
      if (!response.ok) {
        throw new Error(data.error || 'Failed to get swap quote');
      }
      
      if (!data.success || !data.quote) {
        throw new Error('Invalid response format');
      }
      
      return data.quote;
    } catch (error) {
      console.error('Error in getSwapQuote:', error);
      
      // Specific error handling for pool data issues
      if (error instanceof Error && error.message.includes('pool data')) {
        throw new Error('Invalid pool data structure');
      }
      
      throw error;
    }
  }
}

// Swap service that uses the router
export class SwapService {
  private router: SuiSwapRouter;
  
  constructor() {
    this.router = new SuiSwapRouter();
  }
  
  async getSwapEstimate(
    fromCoin: string,
    toCoin: string,
    amount: number,
    circleId: string,
    poolId?: string
  ): Promise<SwapQuote | null> {
    try {
      if (!amount || amount <= 0) {
        toast.error('Please enter a valid amount');
        return null;
      }
      
      if (!circleId) {
        toast.error('Circle ID is required for swap estimation');
        return null;
      }
      
      // Get quote from router
      return await this.router.getSwapQuote(fromCoin, toCoin, amount, circleId, poolId);
    } catch (error) {
      console.error('Swap estimate error:', error);
      
      let errorMessage = 'Failed to get swap estimate';
      if (error instanceof Error) {
        // Handle specific error messages
        if (error.message.includes('Invalid pool data structure')) {
          errorMessage = 'The liquidity pool data is invalid or unavailable. Please try again later.';
        } else if (error.message.includes('Missing circle ID')) {
          errorMessage = 'Circle ID is required for swap estimation';
        }
      }
      
      toast.error(errorMessage);
      return null;
    }
  }
  
  // Method to execute swaps
  async executeSwap(
    fromCoin: string,
    toCoin: string,
    amountIn: number,
    minAmountOut: number,
    circleId: string
  ): Promise<{ success: boolean; txId?: string; error?: string }> {
    try {
      if (!circleId) {
        throw new Error('Missing circle ID');
      }
      
      // In a real implementation, this would call the blockchain
      // For now we'll just simulate success
      console.log('Executing swap:', { fromCoin, toCoin, amountIn, minAmountOut, circleId });
      
      // Simulate transaction
      return {
        success: true,
        txId: `0x${Math.random().toString(16).slice(2)}`,
      };
    } catch (error) {
      console.error('Swap execution error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error during swap',
      };
    }
  }
}

// Create singleton instance
export const swapService = new SwapService();

// Helper function for getting swap estimates
export async function getSwapEstimate(
  fromCoin: string,
  toCoin: string,
  amount: number,
  circleId: string,
  poolId?: string
): Promise<SwapQuote | null> {
  return swapService.getSwapEstimate(fromCoin, toCoin, amount, circleId, poolId);
}

/**
 * Get a swap estimate from DeepBook
 * @param fromCoin The source coin type
 * @param toCoin The destination coin type
 * @param amount The amount to swap
 * @returns SwapQuote or null if estimation fails
 */
export const getSwapEstimateFromCetus = async (
  fromCoin: string,
  toCoin: string,
  amount: number
): Promise<SwapQuote | null> => {
  try {
    // For small amounts or development testing, use the SUI price service for faster results
    if (amount < 0.1) {
      return getQuoteFromPriceService(fromCoin, toCoin, amount);
    }

    // Fetch pool data from DeepBook (Note: actually using price service as fallback)
    console.warn('Using price service as fallback for DeepBook swap estimation');
    return getQuoteFromPriceService(fromCoin, toCoin, amount);
  } catch (error) {
    console.error('Error getting DeepBook swap estimate:', error);
    // Fallback to using price service
    return getQuoteFromPriceService(fromCoin, toCoin, amount);
  }
};

/**
 * Fallback method to get quote from price service
 */
const getQuoteFromPriceService = async (
  fromCoin: string,
  toCoin: string,
  amount: number
): Promise<SwapQuote | null> => {
  try {
    // Get current SUI price
    const suiPrice = await priceService.getSUIPrice();
    if (!suiPrice) {
      return null;
    }
    
    // Only support SUI to USDC for simplicity
    if (fromCoin === SUI_COIN_TYPE && toCoin === USDC_COIN_TYPE) {
      // Calculate USDC amount (convert to micro USDC - 6 decimals)
      // Ensure we're using the correct scaling factor for USDC (1e6 not 1e9)
      const amountOut = amount * suiPrice * 1e6;
      
      console.log('DeepBook quote estimation:', {
        amount,
        suiPrice,
        calculatedUSDC: amount * suiPrice,
        microUSDC: amountOut,
        rounded: Math.floor(amountOut)
      });
      
      return {
        amountIn: amount,
        amountOut: Math.floor(amountOut), // Floor to ensure we don't overestimate
        price: suiPrice,
        priceImpact: 0.1, // Minimal price impact for this estimation
        poolId: POOL_ID
      };
    }
    
    return null;
  } catch (error) {
    console.error('Error getting price service quote:', error);
    return null;
  }
};

/**
 * Execute a swap transaction
 * Note: This is kept for backward compatibility but is no longer used directly
 * as we now use the zkLogin API for executing swaps
 * @returns A warning response indicating the method is deprecated
 */
export const executeSwapFromCetus = async (): Promise<{ success: boolean; error?: string; txId?: string }> => {
  console.warn('Direct swap execution is deprecated. Use zkLogin API for swaps.');
  return {
    success: false,
    error: 'Direct swap execution is deprecated. Use zkLogin API instead.'
  };
};

/**
 * Calculate minimum amount out with slippage
 */
export const calculateMinAmountOut = (
  amountOut: number,
  slippagePercentage: number
): number => {
  return Math.floor(amountOut * (1 - slippagePercentage / 100));
};

export const swapServiceCetus = {
  getSwapEstimate: getSwapEstimateFromCetus,
  executeSwap: executeSwapFromCetus,
  calculateMinAmountOut
}; 