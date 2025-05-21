import { SuiClient } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import { suiSwapRouter } from '../services/sui-swap-router';

const SUI_TYPE = '0x2::sui::SUI';

// Define zkLogin account interface to match what's used in the application
interface ZkLoginAccount {
  userAddr: string;
  ephemeralPrivateKey: string;
  zkProofs: {
    proofPoints: {
      a: string[];
      b: string[][] | string[];
      c: string[];
    };
    issBase64Details: {
      value: string;
      indexMod4: number;
    } | string;
    headerBase64: string | {
      value: string;
      indexMod4: number;
    };
  };
  [key: string]: unknown;
}

/**
 * Service for SUI token swaps and aggregation
 * This implementation uses the suiSwapRouter under the hood
 */
class SwapService {
  private suiClient: SuiClient;
  private isInitialized = false;
  private userAddress = '';
  private network: 'testnet' | 'mainnet' = 'testnet';

  constructor() {
    // Initialize with default values
    this.suiClient = new SuiClient({ url: 'https://fullnode.testnet.sui.io:443' });
  }

  /**
   * Initialize the service with user address
   */
  init(userAddress: string, network: 'testnet' | 'mainnet' = 'testnet') {
    this.userAddress = userAddress;
    this.network = network;
    suiSwapRouter.setUserAddress(userAddress);
    this.isInitialized = true;
  }

  /**
   * Get estimated swap output amount for a given input
   */
  async getSwapEstimate(
    fromCoinType: string,
    toCoinType: string,
    amountIn: number | string,
    byAmountIn = true
  ): Promise<{ amountIn: string; amountOut: string; priceImpact: number } | null> {
    if (!this.isInitialized) {
      console.error('SwapService not initialized. Call init() first.');
      return null;
    }

    try {
      const quote = await suiSwapRouter.getSwapQuote(
        fromCoinType,
        toCoinType,
        amountIn,
        byAmountIn
      );

      if (!quote) {
        return null;
      }

      return {
        amountIn: suiSwapRouter.formatTokenAmount(quote.inputAmount, fromCoinType),
        amountOut: suiSwapRouter.formatTokenAmount(quote.outputAmount, toCoinType),
        priceImpact: quote.priceImpact,
      };
    } catch (error) {
      console.error('Error getting swap estimate:', error);
      return null;
    }
  }

  /**
   * Prepare a swap transaction without executing it
   * Returns a Transaction object that can be executed later
   */
  async prepareSwapTransaction(
    fromCoinType: string,
    toCoinType: string,
    amountIn: number | string,
    slippage = 0.5 // 0.5% slippage by default
  ): Promise<{ txb: Transaction; expectedOutput: string } | null> {
    if (!this.isInitialized) {
      console.error('SwapService not initialized. Call init() first.');
      return null;
    }

    try {
      const result = await suiSwapRouter.buildSwapTransaction(
        fromCoinType,
        toCoinType,
        amountIn,
        { slippageTolerance: slippage }
      );

      if (!result) {
        return null;
      }

      const expectedOutput = suiSwapRouter.formatTokenAmount(result.expectedOutput, toCoinType);

      return { txb: result.transaction, expectedOutput };
    } catch (error) {
      console.error('Error preparing swap transaction:', error);
      return null;
    }
  }

  /**
   * Get transaction payload for zkLogin integration
   * Returns the transaction payload that can be sent to the zkLogin API
   */
  async getSwapTransactionPayload(
    fromCoinType: string,
    toCoinType: string,
    amountIn: number | string,
    slippage = 0.5
  ): Promise<Uint8Array | null> {
    return suiSwapRouter.getZkLoginSwapPayload(
      fromCoinType,
      toCoinType,
      amountIn,
      { slippageTolerance: slippage }
    );
  }

  /**
   * Perform a swap and contribute in a single transaction using zkLogin
   */
  async swapAndContributeViaZkLogin(
    account: ZkLoginAccount,
    fromCoinType: string,
    amountIn: number | string,
    circleId: string,
    walletId: string,
    slippage = 0.5
  ): Promise<{ success: boolean; digest?: string; error?: string }> {
    try {
      // First generate swap transaction payload
      const swapPayload = await this.getSwapTransactionPayload(
        fromCoinType, 
        SUI_TYPE, // Always swap to SUI
        amountIn, 
        slippage
      );

      if (!swapPayload) {
        return { success: false, error: 'Failed to generate swap transaction' };
      }

      // Execute the swap through zkLogin API
      const result = await fetch('/api/zkLogin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'swapAndContribute',
          account,
          circleId,
          walletId,
          swapPayload
        }),
      });

      const data = await result.json();
      
      if (!result.ok) {
        return { 
          success: false, 
          error: data.error || 'Failed to execute swap and contribution' 
        };
      }

      return { 
        success: true, 
        digest: data.digest 
      };
    } catch (error) {
      console.error('Error performing swap and contribution:', error);
      return { 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      };
    }
  }

  /**
   * List all available tokens that can be swapped
   */
  async getSupportedTokens(): Promise<{ symbol: string; address: string; decimals: number }[]> {
    return suiSwapRouter.getSupportedTokens();
  }
}

// Export a singleton instance
export const swapService = new SwapService();

// Export an instance with the same name for backward compatibility
export const cetusService = swapService; 