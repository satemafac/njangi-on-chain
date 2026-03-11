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

  /**
   * Perform a swap and contribute in a single transaction using zkLogin
   */
  async swapAndContributeViaZkLogin(
    account: unknown,
    fromCoinType: string,
    amountIn: number | string,
    circleId: string,
    walletId: string,
    slippage = 150 // basis points (1.5%)
  ): Promise<{ success: boolean; digest?: string; status?: string; error?: string; requireRelogin?: boolean }> {
    try {
      const parsedAmount =
        typeof amountIn === 'string' ? Number.parseFloat(amountIn) : Number(amountIn);
      if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
        return { success: false, error: 'Invalid swap amount. Provide a positive SUI amount.' };
      }

      const slippageBps = slippage <= 10 ? Math.floor(slippage * 100) : Math.floor(slippage);

      const result = await fetch('/api/zkLogin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'swapAndDepositCetus',
          account,
          circleId,
          walletId,
          fromCoinType,
          suiAmount: parsedAmount,
          slippage: slippageBps,
          network: this.network,
        }),
      });

      const data = await result.json();
      
      if (!result.ok) {
        return { 
          success: false, 
          error: data.error || 'Failed to execute swap and contribution',
          requireRelogin: Boolean(data?.requireRelogin),
        };
      }

      return { 
        success: true, 
        digest: data.digest,
        status: data.status,
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
    const { SUI, USDC } = getCurrentCoinTypes();
    return [
      { symbol: 'SUI', address: SUI, decimals: 9 },
      { symbol: 'USDC', address: USDC, decimals: 6 },
    ];
  }
}

// Export a singleton instance
export const cetusService = new CetusService(); 
