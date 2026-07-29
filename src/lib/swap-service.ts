import { SuiClient } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import { suiSwapRouter } from '../services/sui-swap-router';

// `SUI_TYPE` and the local `ZkLoginAccount` shape were only used by
// `swapAndContributeViaZkLogin`, removed below.

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

  // Removed: `swapAndContributeViaZkLogin` POSTed `action: 'swapAndContribute'`
  // to /api/zkLogin, which has had no such case for some time — every call
  // fell through to the dispatcher default and returned 400. It had no callers.

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