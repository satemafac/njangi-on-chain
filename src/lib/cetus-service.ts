import { Transaction } from '@mysten/sui/transactions';
import { cetusService as protocolCetusService } from '../services/cetus-service';
import { getCurrentCoinTypes } from '../services/network-config';

/**
 * Service for SUI token swaps and aggregation
 * This wrapper keeps the existing frontend API but delegates to the real Cetus SDK service.
 */
class CetusService {
  private isInitialized = false;
  private userAddress = '';
  private network: 'testnet' | 'mainnet' = 'testnet';

  /**
   * Initialize the service with user address
   */
  init(userAddress: string, network: 'testnet' | 'mainnet' = 'testnet') {
    this.userAddress = userAddress;
    this.network = network;
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
      console.error('CetusService not initialized. Call init() first.');
      return null;
    }

    try {
      const quote = await protocolCetusService.getSwapEstimateForPair(
        fromCoinType,
        toCoinType,
        amountIn,
        byAmountIn
      );

      if (!quote) {
        return null;
      }

      return quote;
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
    slippage = 0.5, // 0.5% slippage by default
    byAmountIn = true
  ): Promise<{ txb: Transaction; expectedOutput: string } | null> {
    if (!this.isInitialized) {
      console.error('CetusService not initialized. Call init() first.');
      return null;
    }

    try {
      const result = await protocolCetusService.prepareSwapTransactionForPair(
        this.userAddress,
        fromCoinType,
        toCoinType,
        amountIn,
        slippage,
        byAmountIn
      );

      if (!result) {
        return null;
      }

      return { txb: result.tx, expectedOutput: result.expectedOutput };
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
    slippage = 0.5,
    byAmountIn = true
  ): Promise<Uint8Array | null> {
    if (!this.isInitialized) {
      console.error('CetusService not initialized. Call init() first.');
      return null;
    }

    try {
      return await protocolCetusService.getSwapTransactionBytesForPair(
        this.userAddress,
        fromCoinType,
        toCoinType,
        amountIn,
        slippage,
        byAmountIn
      );
    } catch (error) {
      console.error('Error preparing zkLogin swap payload:', error);
      return null;
    }
  }

  // Removed: `swapAndContributeViaZkLogin` had no callers and routed to the
  // server-signing `swapAndDepositCetus` action. Leaving an unused entry point
  // into a server signer would only have to be migrated later.

  /**
   * List all available tokens that can be swapped
   */
  async getSupportedTokens(): Promise<{ symbol: string; address: string; decimals: number }[]> {
    const { SUI, USDC } = getCurrentCoinTypes();
    return [
      { symbol: 'SUI', address: SUI, decimals: 9 },
      { symbol: 'USDC', address: USDC, decimals: 6 },
    ];
  }
}

// Export a singleton instance
export const cetusService = new CetusService(); 
