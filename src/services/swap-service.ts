import { toast } from 'react-hot-toast';

// Define types
export type SwapQuote = {
  amountIn: number;
  amountOut: number;
  price: number;
  priceImpact: number;
  poolId: string;
};

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