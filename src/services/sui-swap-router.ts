import { Transaction } from '@mysten/sui/transactions';
import { SuiClient } from '@mysten/sui/client';
import { getCurrentNetworkConfig } from './network-config';

// Get network-aware constants
function getCetusPackageId(): string {
  return getCurrentNetworkConfig().cetus.packageId;
}

function getCetusGlobalConfigId(): string {
  return getCurrentNetworkConfig().cetus.globalConfig;
}

// Common token addresses
const SUI_TYPE = '0x2::sui::SUI';

// Get network-aware tokens
function getTokens(): Record<string, string> {
  return getCurrentNetworkConfig().tokens;
}

// Get network-aware pool IDs
function getPoolIds(): Record<string, string> {
  const cetusConfig = getCurrentNetworkConfig().cetus;
  return {
    'SUI_USDC': cetusConfig.pools.SUI_USDC,
    'SUI_USDT': cetusConfig.pools.SUI_USDT || cetusConfig.pools.SUI_USDC,
  };
}

interface SwapOptions {
  slippageTolerance: number; // in percentage (e.g., 0.5 for 0.5%)
  deadline?: number; // in seconds
  useAggregator?: boolean;
  refreshCoins?: boolean;
}

interface SwapQuote {
  inputAmount: bigint;
  outputAmount: bigint;
  priceImpact: number;
  route: string;
  inputToken: string;
  outputToken: string;
}

type Network = 'mainnet' | 'testnet';

/**
 * A service for performing swaps on SUI blockchain
 */
export class SuiSwapRouter {
  private suiClient: SuiClient;
  private network: Network;
  private userAddress: string;
  
  constructor(
    network: Network = 'testnet',
    userAddress: string = ''
  ) {
    // Use network-aware RPC URL
    const rpcUrl = getCurrentNetworkConfig().rpcUrl;
    
    this.suiClient = new SuiClient({ url: rpcUrl });
    this.network = network;
    this.userAddress = userAddress;
  }
  
  /**
   * Set the user address
   */
  setUserAddress(address: string): void {
    this.userAddress = address;
  }
  
  /**
   * Get token balance for the user
   */
  async getTokenBalance(tokenType: string): Promise<bigint> {
    if (!this.userAddress) {
      throw new Error('User address not set');
    }
    
    try {
      if (tokenType === SUI_TYPE) {
        // Get SUI balance
        const balance = await this.suiClient.getBalance({
          owner: this.userAddress,
          coinType: SUI_TYPE
        });
        
        return BigInt(balance.totalBalance);
      } else {
        // Get other token balance
        const coins = await this.suiClient.getCoins({
          owner: this.userAddress,
          coinType: tokenType
        });
        
        return coins.data.reduce((total, coin) => total + BigInt(coin.balance), BigInt(0));
      }
    } catch (error) {
      console.error('Error getting token balance:', error);
      return BigInt(0);
    }
  }
  
  /**
   * Get a swap quote without executing the swap
   */
  async getSwapQuote(
    fromToken: string,
    toToken: string,
    amount: string | number | bigint,
    byAmountIn = true
  ): Promise<SwapQuote | null> {
    try {
      // Convert amount to bigint
      const amountBigInt = typeof amount === 'bigint' 
        ? amount 
        : BigInt(Math.floor(Number(amount) * (fromToken === SUI_TYPE ? 1e9 : 1e6)));
      
      // Determine pool ID
      const networkTokens = getTokens();
      const fromSymbol = Object.entries(networkTokens)
        .find(([, addr]) => addr === fromToken)?.[0] || 'UNKNOWN';
      const toSymbol = Object.entries(networkTokens)
        .find(([, addr]) => addr === toToken)?.[0] || 'UNKNOWN';
      
      // Get the pool ID safely
      let poolId: string | undefined;
      const poolKey = `${fromSymbol}_${toSymbol}`;
      
      // Get network-aware pool IDs
      const networkPools = getPoolIds();
      
      if (poolKey in networkPools) {
        poolId = networkPools[poolKey as keyof typeof networkPools];
      } else {
        const reverseKey = `${toSymbol}_${fromSymbol}`;
        if (reverseKey in networkPools) {
          poolId = networkPools[reverseKey as keyof typeof networkPools];
        }
      }
      
      if (!poolId) {
        throw new Error(`No liquidity pool found for ${fromSymbol}-${toSymbol}`);
      }
      
      // Get pool information
      const poolObj = await this.suiClient.getObject({
        id: poolId,
        options: { showContent: true }
      });
      
      if (!poolObj.data?.content || !('fields' in poolObj.data.content)) {
        throw new Error('Invalid pool data structure');
      }
      
      // Calculate output differently based on byAmountIn
      let inputAmount = amountBigInt;
      let outputAmount;
      
      if (byAmountIn) {
        // If byAmountIn, we're swapping a fixed input amount for a variable output
        outputAmount = amountBigInt * BigInt(97) / BigInt(100); // 3% fee approximation
      } else {
        // If not byAmountIn, we're swapping a variable input for a fixed output
        outputAmount = amountBigInt;
        inputAmount = (amountBigInt * BigInt(103)) / BigInt(100); // 3% fee approximation plus some extra
      }
      
      const priceImpact = 0.5; // 0.5% price impact approximation
      
      return {
        inputAmount,
        outputAmount,
        priceImpact,
        route: `${fromSymbol} → ${toSymbol}`,
        inputToken: fromToken,
        outputToken: toToken
      };
    } catch (error) {
      console.error('Error getting swap quote:', error);
      return null;
    }
  }
  
  /**
   * Build a swap transaction
   */
  async buildSwapTransaction(
    fromToken: string,
    toToken: string,
    amount: string | number | bigint,
    options: SwapOptions = { slippageTolerance: 0.5, useAggregator: true, refreshCoins: true }
  ): Promise<{ transaction: Transaction, expectedOutput: bigint } | null> {
    try {
      if (!this.userAddress) {
        throw new Error('User address not set');
      }
      
      // Get quote first
      const quote = await this.getSwapQuote(fromToken, toToken, amount);
      if (!quote) {
        throw new Error('Failed to get swap quote');
      }
      
      // Calculate minimum output with slippage
      const minOutputAmount = quote.outputAmount * BigInt(Math.floor(10000 - options.slippageTolerance * 100)) / BigInt(10000);
      
      // Create transaction
      const tx = new Transaction();
      tx.setSender(this.userAddress);
      
      if (options.useAggregator) {
        // Add Cetus aggregator swap call
        await this.addCetusAggregatorSwapToTransaction(
          tx,
          fromToken,
          toToken,
          quote.inputAmount,
          minOutputAmount,
          options.refreshCoins || false,
          options.slippageTolerance
        );
      } else {
        // Add direct DEX swap (simple path)
        await this.addDirectSwapToTransaction(
          tx,
          fromToken,
          toToken,
          quote.inputAmount,
          minOutputAmount
        );
      }
      
      return {
        transaction: tx,
        expectedOutput: quote.outputAmount
      };
    } catch (error) {
      console.error('Error building swap transaction:', error);
      return null;
    }
  }
  
  /**
   * Add Cetus DEX aggregator swap to transaction
   */
  private async addCetusAggregatorSwapToTransaction(
    tx: Transaction,
    fromToken: string,
    toToken: string,
    inputAmount: bigint,
    minOutputAmount: bigint,
    refreshCoins: boolean,
    slippageTolerance: number
  ): Promise<void> {
    // First step: If refreshCoins is true, we need to merge all coins
    if (refreshCoins && fromToken !== SUI_TYPE) {
      const coins = await this.suiClient.getCoins({
        owner: this.userAddress,
        coinType: fromToken
      });
      
      if (coins.data.length > 1) {
        // We'll merge all coins of this type
        const primaryCoinId = coins.data[0].coinObjectId;
        const mergeCoins = coins.data.slice(1).map(coin => coin.coinObjectId);
        
        tx.mergeCoins(
          tx.object(primaryCoinId),
          mergeCoins.map(id => tx.object(id))
        );
      }
    }
    
    // Get the stablecoin symbol
    let stablecoinSymbol = 'USDC';
    const networkTokens = getTokens();
    if (toToken === networkTokens.USDT) {
      stablecoinSymbol = 'USDT';
    }
    
    // Get pool ID safely
    const networkPools = getPoolIds();
    const poolKey = `SUI_${stablecoinSymbol}` as keyof typeof networkPools;
    const poolId = networkPools[poolKey];
    
    if (!poolId) {
      throw new Error(`Pool not found for SUI to ${stablecoinSymbol}`);
    }
    
    // For SUI, we can use SplitCoins to get the exact amount
    if (fromToken === SUI_TYPE) {
      // Split coins
      const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(inputAmount)]);
      
      // Call Cetus router swap function (simplified)
      tx.moveCall({
        target: `${getCetusPackageId()}::router::swap_exact_sui_for_coin_with_affiliate`,
        arguments: [
          tx.object(getCetusGlobalConfigId()), // global config
          coin, // sui coin
          tx.pure.u64(minOutputAmount), // min amount out
          tx.object(poolId), // pool
          tx.pure.u8(9), // from coin decimals
          tx.pure.u8(6), // to coin decimals
          tx.pure.u64(BigInt(Math.floor(slippageTolerance * 10000))), // slippage in bps
        ],
        typeArguments: [toToken]
      });
    } else {
      // For other tokens, we need to first find the coin
      const coins = await this.suiClient.getCoins({
        owner: this.userAddress,
        coinType: fromToken
      });
      
      if (coins.data.length === 0) {
        throw new Error(`No coins found for token type ${fromToken}`);
      }
      
      // Get a coin with sufficient balance
      let coinToUse = null;
      for (const coin of coins.data) {
        if (BigInt(coin.balance) >= inputAmount) {
          coinToUse = coin.coinObjectId;
          break;
        }
      }
      
      if (!coinToUse) {
        throw new Error(`Insufficient balance for token type ${fromToken}`);
      }
      
      // If we need to split, do so
      if (BigInt(coins.data[0].balance) > inputAmount) {
        const [splitCoin] = tx.splitCoins(tx.object(coinToUse), [tx.pure.u64(inputAmount)]);
        coinToUse = splitCoin;
      } else {
        coinToUse = tx.object(coinToUse);
      }
      
      // Call Cetus router swap function (for non-SUI to SUI)
      tx.moveCall({
        target: `${getCetusPackageId()}::router::swap_exact_coin_for_sui_with_affiliate`,
        arguments: [
          tx.object(getCetusGlobalConfigId()), // global config
          coinToUse, // from coin
          tx.pure.u64(minOutputAmount), // min amount out
          tx.object(poolId), // pool
          tx.pure.u8(6), // from coin decimals
          tx.pure.u8(9), // to coin decimals
          tx.pure.u64(BigInt(Math.floor(slippageTolerance * 10000))), // slippage in bps
        ],
        typeArguments: [fromToken]
      });
    }
  }
  
  /**
   * Add direct DEX swap to transaction (simplified)
   */
  private async addDirectSwapToTransaction(
    tx: Transaction,
    fromToken: string,
    toToken: string,
    inputAmount: bigint,
    minOutputAmount: bigint
  ): Promise<void> {
    // This is a simplified implementation
    // In a real scenario, you would have specific logic for different DEXes
    
    // Get the stablecoin symbol
    let stablecoinSymbol = 'USDC';
    const networkTokens = getTokens();
    if (toToken === networkTokens.USDT) {
      stablecoinSymbol = 'USDT';
    }
    
    // Get pool ID safely
    const networkPools = getPoolIds();
    const poolKey = `SUI_${stablecoinSymbol}` as keyof typeof networkPools;
    const poolId = networkPools[poolKey];
    
    if (!poolId) {
      throw new Error(`Pool not found for SUI to ${stablecoinSymbol}`);
    }
    
    // For illustration, we'll use the router module instead of pool module since swap_sui doesn't exist in v1.26.0
    if (fromToken === SUI_TYPE) {
      const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(inputAmount)]);
      
      // Using router module with swap_exact_sui_for_coin instead of pool::swap_sui
      tx.moveCall({
        target: `${getCetusPackageId()}::router::swap_exact_sui_for_coin`,
        arguments: [
          tx.object(getCetusGlobalConfigId()),
          coin,
          tx.pure.u64(minOutputAmount),
          tx.object(poolId),
          tx.pure.u8(9), // SUI decimals
          tx.pure.u8(6), // USDC/USDT decimals
        ],
        typeArguments: [toToken]
      });
    }

    // For illustration, we'll use the pool module with flash_swap since router module doesn't exist in v1.26.0
    if (fromToken === SUI_TYPE) {
      const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(inputAmount)]);
      
      // Using pool::flash_swap for SUI to stablecoin swap
      const [, , receipt] = tx.moveCall({
        target: `${getCetusPackageId()}::pool::flash_swap`,
        arguments: [
          tx.object(getCetusGlobalConfigId()), // Global config ID
          tx.object(poolId), // Pool ID
          tx.pure.bool(false), // is_a_to_b (SUI → stablecoin is false in this pool)
          tx.pure.bool(true), // by_amount_in
          tx.pure.u64(inputAmount), // amount in (SUI)
          tx.pure.u128(BigInt(minOutputAmount)), // min amount out
          tx.object('0x6'), // Clock object
        ],
        typeArguments: [toToken, SUI_TYPE]
      });
      
      // Pay for the swap with the SUI we split earlier
      tx.moveCall({
        target: `${getCetusPackageId()}::pool::repay_flash_swap`,
        arguments: [
          receipt,
          coin
        ],
        typeArguments: [toToken, SUI_TYPE]
      });
    } else {
      // For non-SUI tokens, we use flash_swap in the opposite direction
      const coins = await this.suiClient.getCoins({
        owner: this.userAddress,
        coinType: fromToken
      });
      
      if (coins.data.length === 0) {
        throw new Error(`No coins found for token type ${fromToken}`);
      }
      
      // Get a coin with sufficient balance
      let coinToUse = null;
      for (const coin of coins.data) {
        if (BigInt(coin.balance) >= inputAmount) {
          coinToUse = coin.coinObjectId;
          break;
        }
      }
      
      if (!coinToUse) {
        throw new Error(`Insufficient balance for token type ${fromToken}`);
      }
      
      // If we need to split, do so
      let coinObject;
      if (BigInt(coins.data[0].balance) > inputAmount) {
        const [splitCoin] = tx.splitCoins(tx.object(coinToUse), [tx.pure.u64(inputAmount)]);
        coinObject = splitCoin;
      } else {
        coinObject = tx.object(coinToUse);
      }
      
      // Use pool::flash_swap for token to SUI swap
      const [, , receipt] = tx.moveCall({
        target: `${getCetusPackageId()}::pool::flash_swap`,
        arguments: [
          tx.object(getCetusGlobalConfigId()), // Global config ID
          tx.object(poolId), // Pool ID
          tx.pure.bool(true), // is_a_to_b (token → SUI is true in this pool)
          tx.pure.bool(true), // by_amount_in
          tx.pure.u64(inputAmount), // amount in (token)
          tx.pure.u128(BigInt(minOutputAmount)), // min amount out
          tx.object('0x6'), // Clock object
        ],
        typeArguments: [fromToken, SUI_TYPE]
      });
      
      // Repay with the token we have
      tx.moveCall({
        target: `${getCetusPackageId()}::pool::repay_flash_swap`,
        arguments: [
          receipt,
          coinObject
        ],
        typeArguments: [fromToken, SUI_TYPE]
      });
    }
  }
  
  /**
   * Generate the zkLogin transaction payload
   */
  async getZkLoginSwapPayload(
    fromToken: string,
    toToken: string,
    amount: string | number,
    options: SwapOptions = { slippageTolerance: 0.5 }
  ): Promise<Uint8Array | null> {
    try {
      const result = await this.buildSwapTransaction(
        fromToken,
        toToken,
        amount,
        options
      );
      
      if (!result) return null;
      
      // Build the transaction for zkLogin
      return result.transaction.build();
    } catch (error) {
      console.error('Error generating zkLogin payload:', error);
      return null;
    }
  }
  
  /**
   * Get list of supported tokens
   */
  getSupportedTokens(): Array<{ symbol: string; address: string; decimals: number }> {
    const networkTokens = getTokens();
    return Object.entries(networkTokens).map(([symbol, address]) => ({
      symbol,
      address,
      decimals: symbol === 'SUI' ? 9 : 6
    }));
  }
  
  /**
   * Format token amount for display
   */
  formatTokenAmount(amount: bigint, tokenType: string): string {
    const decimals = tokenType === SUI_TYPE ? 9 : 6;
    return (Number(amount) / Math.pow(10, decimals)).toFixed(decimals === 9 ? 4 : 2);
  }
}

// Create and export a singleton instance
export const suiSwapRouter = new SuiSwapRouter(); 