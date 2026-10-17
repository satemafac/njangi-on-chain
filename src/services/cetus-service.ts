import { initCetusSDK } from '@cetusprotocol/cetus-sui-clmm-sdk';
import { Transaction } from '@mysten/sui/transactions';
import { getPooledSuiClient, getRpcCandidateUrls } from './sui-rpc-failover';
import { normalizeCoinType, resolveSupportedCoin, toBaseUnitsTruncated } from '@/lib/supported-coins';
import { 
  CetusErrorCode, 
  createCetusError, 
  parseError, 
  CetusErrorLogger,
  CetusRecoveryManager 
} from './cetus-errors';

const DEFAULT_SLIPPAGE = 50; // 0.5%
const SUI_TYPE = '0x2::sui::SUI';

import {
  getCurrentCoinTypes,
  getCurrentCetusConfig,
  getCurrentRpcUrl,
  getCurrentNetwork,
} from './network-config';

function getCurrentUsdcType(): string {
  return getCurrentCoinTypes().USDC;
}

function getCetusSuiUsdcPoolId(): string {
  return getCurrentCetusConfig().pools.SUI_USDC;
}

/**
 * One spelling per type (`0x` + 64 hex digits), so the short and long forms
 * of SUI compare equal. Exact type only: this used to rewrite every
 * `::usdc::` type, from any package, to the network's USDC.
 */
function normalizeCoinTypeForNetwork(coinType: string): string {
  return normalizeCoinType(coinType) ?? coinType;
}

/**
 * SUI is 9 decimals and the network's USDC 6, by exact type. Any other coin
 * is refused: it used to be scaled at 6 decimals whatever it really had.
 */
function getCoinDecimals(coinType: string): number {
  const coin = resolveSupportedCoin(coinType, getCurrentNetwork());
  if (!coin) {
    throw new Error(`Swaps support SUI and USDC only, not ${coinType}`);
  }
  return coin.decimals;
}

function normalizeSlippageToBps(slippage: number): number {
  if (!Number.isFinite(slippage) || slippage < 0) {
    return DEFAULT_SLIPPAGE;
  }

  return slippage <= 10 ? Math.floor(slippage * 100) : Math.floor(slippage);
}

// Exact base units, cut (never rounded up) past the coin's decimals.
// Math.floor(amount * 10 ** decimals) asked a by-amount-out swap for a 0.29
// USDC share for 289,999 units.
function toAtomicAmount(amount: number | string, coinType: string): bigint {
  const atomic = toBaseUnitsTruncated(amount, getCoinDecimals(coinType));
  if (atomic === null || atomic <= 0n) {
    throw new Error('Invalid swap amount');
  }
  return atomic;
}

function fromAtomicAmount(amount: bigint | string, coinType: string): number {
  const normalizedAmount = typeof amount === 'string' ? Number.parseFloat(amount) : Number(amount);
  return normalizedAmount / Math.pow(10, getCoinDecimals(coinType));
}

// SUI-USDC Pool will be fetched dynamically from the SDK
// Don't hardcode pool IDs as they can change with protocol upgrades

// Define safer types for the SDK
interface CetusPoolData {
  poolAddress: string;
  coinTypeA: string;
  coinTypeB: string;
  current_sqrt_price: number;
  [key: string]: unknown;
}

interface CetusSDKInterface {
  senderAddress: string;
  Pool: {
    getPool: (poolId: string) => Promise<CetusPoolData>;
    getPoolByCoins: (coinTypes: string[]) => Promise<CetusPoolData[]>;
    getPoolsWithPage: (options: Record<string, unknown>) => Promise<CetusPoolData[]>;
  };
  Swap: {
    preswap: (options: Record<string, unknown>) => Promise<{
      estimatedAmountIn: string;
      estimatedAmountOut: string;
      priceImpactPct?: number;
      aToB: boolean;
      byAmountIn: boolean;
      [key: string]: unknown;
    } | null>;
    createSwapTransactionPayload: (
      options: Record<string, unknown>,
      gasEstimateArg?: Record<string, unknown>
    ) => Promise<Transaction>;
    calculateRates: (options: Record<string, unknown>) => Promise<{
      estimatedAmountOut: string;
      priceImpact: string;
      [key: string]: unknown;
    }>;
  };
  [key: string]: unknown;
}

// Add local normalizeSuiObjectId function
function normalizeSuiObjectId(id: string): string {
  if (!id) return id;
  return id.startsWith('0x') ? id : `0x${id}`;
}

class CetusService {
  private sdk: CetusSDKInterface | null = null;
  private initialized = false;
  private initializedNetwork: ReturnType<typeof getCurrentNetwork> | null = null;

  constructor() {
    this.initialize();
  }

  async initialize() {
    try {
      // Initialize the SDK and cast to our interface
      // Using unknown as an intermediate step to avoid type errors with the SDK
      // The SDK takes a URL, not a client, so it cannot fail over on its own.
      // Give it the first CANDIDATE rather than the raw configured URL: the
      // candidate list applies the rate-limited-endpoint ordering, so the SDK
      // starts on the endpoint least likely to 429.
      const preferredRpcUrl =
        getRpcCandidateUrls(getCurrentNetwork())[0] ?? getCurrentRpcUrl();
      this.sdk = initCetusSDK({
        network: getCurrentNetwork(),
        fullNodeUrl: preferredRpcUrl
      }) as unknown as CetusSDKInterface;
      
      this.initialized = true;
      this.initializedNetwork = getCurrentNetwork();
      console.log('Cetus SDK initialized successfully');
    } catch (error) {
      console.error('Failed to initialize Cetus SDK:', error);
      this.initialized = false;
      
      // Log the initialization error
      const cetusError = createCetusError(
        CetusErrorCode.SDK_INITIALIZATION_FAILED,
        error instanceof Error ? error.message : 'Unknown initialization error'
      );
      CetusErrorLogger.log(cetusError);
      throw cetusError;
    }
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  async ensureInitialized(): Promise<boolean> {
    if (!this.initialized || this.initializedNetwork !== getCurrentNetwork()) {
      try {
        await this.initialize();
      } catch (cetusError) {
        // Error already logged in initialize method
        console.error('Failed to ensure Cetus SDK initialization:', cetusError);
        return false;
      }
    }
    return this.initialized;
  }

  private resolveCoinType(coinType: string): string {
    return normalizeCoinTypeForNetwork(coinType);
  }

  private async getPoolOrThrow(poolId: string): Promise<CetusPoolData> {
    if (!await this.ensureInitialized() || !this.sdk) {
      throw createCetusError(CetusErrorCode.SDK_INITIALIZATION_FAILED);
    }

    const pool = await this.sdk.Pool.getPool(poolId);
    if (!pool) {
      throw createCetusError(CetusErrorCode.POOL_NOT_FOUND);
    }

    return pool;
  }

  private getSwapDirection(pool: CetusPoolData, fromCoinType: string, toCoinType: string): boolean {
    const normalizedPoolCoinA = this.resolveCoinType(pool.coinTypeA);
    const normalizedPoolCoinB = this.resolveCoinType(pool.coinTypeB);
    const normalizedFrom = this.resolveCoinType(fromCoinType);
    const normalizedTo = this.resolveCoinType(toCoinType);

    if (normalizedPoolCoinA === normalizedFrom && normalizedPoolCoinB === normalizedTo) {
      return true;
    }

    if (normalizedPoolCoinA === normalizedTo && normalizedPoolCoinB === normalizedFrom) {
      return false;
    }

    throw new Error(`Pool ${pool.poolAddress} does not support ${fromCoinType} -> ${toCoinType}`);
  }

  private async getPreSwapQuote(
    pool: CetusPoolData,
    fromCoinType: string,
    toCoinType: string,
    amountAtomic: bigint,
    byAmountIn: boolean = true
  ): Promise<{
    estimatedAmountIn: bigint;
    estimatedAmountOut: bigint;
    priceImpact: number;
    a2b: boolean;
    byAmountIn: boolean;
  }> {
    if (!await this.ensureInitialized() || !this.sdk) {
      throw createCetusError(CetusErrorCode.SDK_INITIALIZATION_FAILED);
    }

    const a2b = this.getSwapDirection(pool, fromCoinType, toCoinType);
    const preSwap = await this.sdk.Swap.preswap({
      pool,
      currentSqrtPrice: pool.current_sqrt_price,
      coinTypeA: pool.coinTypeA,
      coinTypeB: pool.coinTypeB,
      decimalsA: getCoinDecimals(pool.coinTypeA),
      decimalsB: getCoinDecimals(pool.coinTypeB),
      a2b,
      byAmountIn,
      amount: amountAtomic.toString(),
    });

    if (!preSwap) {
      throw new Error('Failed to get swap quote from Cetus');
    }

    return {
      estimatedAmountIn: BigInt(preSwap.estimatedAmountIn),
      estimatedAmountOut: BigInt(preSwap.estimatedAmountOut),
      priceImpact: typeof preSwap.priceImpactPct === 'number' ? preSwap.priceImpactPct : 0,
      a2b,
      byAmountIn: Boolean(preSwap.byAmountIn),
    };
  }

  async prepareSwapTransactionForPair(
    walletAddress: string,
    fromCoinType: string,
    toCoinType: string,
    amountIn: number | string,
    slippageTolerance: number = DEFAULT_SLIPPAGE,
    byAmountIn: boolean = true
  ): Promise<{ tx: Transaction; expectedOutput: string; expectedInput: string }> {
    if (!walletAddress) {
      throw new Error('Wallet address is required');
    }

    if (!await this.ensureInitialized() || !this.sdk) {
      throw new Error('Cetus SDK not initialized');
    }

    const resolvedFromCoin = this.resolveCoinType(fromCoinType);
    const resolvedToCoin = this.resolveCoinType(toCoinType);
    const amountAtomic = byAmountIn
      ? toAtomicAmount(amountIn, resolvedFromCoin)
      : toAtomicAmount(amountIn, resolvedToCoin);
    const poolId = await this.findPoolForCoinPair(resolvedFromCoin, resolvedToCoin);

    if (!poolId) {
      throw new Error(`No Cetus pool available for ${resolvedFromCoin} -> ${resolvedToCoin}`);
    }

    const pool = await this.getPoolOrThrow(poolId);
    const quote = await this.getPreSwapQuote(
      pool,
      resolvedFromCoin,
      resolvedToCoin,
      amountAtomic,
      byAmountIn
    );
    const slippageBps = normalizeSlippageToBps(slippageTolerance);
    const amountLimit = byAmountIn
      ? quote.estimatedAmountOut * BigInt(Math.max(0, 10_000 - slippageBps)) / 10_000n
      : (quote.estimatedAmountIn * BigInt(10_000 + slippageBps) + 9_999n) / 10_000n;

    this.sdk.senderAddress = walletAddress;

    const tx = await this.sdk.Swap.createSwapTransactionPayload({
      pool_id: poolId,
      coinTypeA: pool.coinTypeA,
      coinTypeB: pool.coinTypeB,
      a2b: quote.a2b,
      by_amount_in: byAmountIn,
      amount: amountAtomic.toString(),
      amount_limit: amountLimit.toString(),
    });

    return {
      tx,
      expectedOutput: fromAtomicAmount(quote.estimatedAmountOut, resolvedToCoin).toString(),
      expectedInput: fromAtomicAmount(quote.estimatedAmountIn, resolvedFromCoin).toString(),
    };
  }

  async getSwapTransactionBytesForPair(
    walletAddress: string,
    fromCoinType: string,
    toCoinType: string,
    amountIn: number | string,
    slippageTolerance: number = DEFAULT_SLIPPAGE,
    byAmountIn: boolean = true
  ): Promise<Uint8Array> {
    const { tx } = await this.prepareSwapTransactionForPair(
      walletAddress,
      fromCoinType,
      toCoinType,
      amountIn,
      slippageTolerance,
      byAmountIn
    );

    tx.setSender(walletAddress);

    return tx.build({
      // Pooled failover client, not a raw one on a single URL. Building a
      // swap needs several reads, and pinning them to one endpoint meant a
      // rate-limited RPC failed the whole swap with "Unable to prepare the
      // swap transaction" — no retry, no fallback, while every other read
      // path in the app was failing over normally. Observed live: blockvision
      // 429s made the swap unexecutable even though the quote had succeeded.
      client: getPooledSuiClient(),
    });
  }

  async getSwapEstimateForPair(
    fromCoinType: string,
    toCoinType: string,
    amountIn: number | string,
    byAmountIn: boolean = true
  ): Promise<{
    amountIn: string;
    amountOut: string;
    priceImpact: number;
  }> {
    if (!await this.ensureInitialized() || !this.sdk) {
      throw new Error('Cetus SDK not initialized');
    }

    const resolvedFromCoin = this.resolveCoinType(fromCoinType);
    const resolvedToCoin = this.resolveCoinType(toCoinType);
    const amountAtomic = byAmountIn
      ? toAtomicAmount(amountIn, resolvedFromCoin)
      : toAtomicAmount(amountIn, resolvedToCoin);
    const poolId = await this.findPoolForCoinPair(resolvedFromCoin, resolvedToCoin);

    if (!poolId) {
      throw new Error(`No Cetus pool available for ${resolvedFromCoin} -> ${resolvedToCoin}`);
    }

    const pool = await this.getPoolOrThrow(poolId);
    const quote = await this.getPreSwapQuote(
      pool,
      resolvedFromCoin,
      resolvedToCoin,
      amountAtomic,
      byAmountIn
    );

    return {
      amountIn: fromAtomicAmount(quote.estimatedAmountIn, resolvedFromCoin).toString(),
      amountOut: fromAtomicAmount(quote.estimatedAmountOut, resolvedToCoin).toString(),
      priceImpact: quote.priceImpact,
    };
  }

  /**
   * Finds the best pool for swapping between two coins
   * @param coinTypeA First coin type
   * @param coinTypeB Second coin type 
   * @returns Pool ID string or null if not found
   */
  async findPoolForCoinPair(coinTypeA: string, coinTypeB: string): Promise<string | null> {
    return await CetusRecoveryManager.withRetry(async () => {
      if (!await this.ensureInitialized() || !this.sdk) {
        throw createCetusError(CetusErrorCode.SDK_INITIALIZATION_FAILED);
      }

      try {
        const resolvedCoinA = this.resolveCoinType(coinTypeA);
        const resolvedCoinB = this.resolveCoinType(coinTypeB);
        console.log(`Finding pools for: ${resolvedCoinA} and ${resolvedCoinB}`);
      
        const suiType = normalizeCoinTypeForNetwork(SUI_TYPE);
        const currentUsdcType = normalizeCoinTypeForNetwork(getCurrentUsdcType());
        const isSuiUsdcPair = (
          (resolvedCoinA === suiType && resolvedCoinB === currentUsdcType) ||
          (resolvedCoinB === suiType && resolvedCoinA === currentUsdcType)
        );

        if (isSuiUsdcPair) {
          const hardcodedPoolId = getCetusSuiUsdcPoolId();
          console.log('Detected SUI/USDC pair, using network-configured pool ID');
        
          try {
            const pool = await this.sdk.Pool.getPool(hardcodedPoolId);
            if (pool) {
              console.log(`Confirmed pool exists: ${hardcodedPoolId}`);
              console.log(`Pool details: CoinA=${pool.coinTypeA}, CoinB=${pool.coinTypeB}`);
              return hardcodedPoolId;
            }
            console.warn('Configured pool ID returned no pool data');
          } catch (poolError) {
            console.warn(`Failed to verify configured pool: ${poolError}`);
          }
        }
      
        const allPools = await this.sdk.Pool.getPoolsWithPage({});
        console.log(`Found ${allPools.length} total pools, filtering for matching pair...`);
      
        const normalizedCoinA = normalizeSuiObjectId(resolvedCoinA);
        const normalizedCoinB = normalizeSuiObjectId(resolvedCoinB);
      
        const matchingPools = allPools.filter(pool => {
          const poolCoinA = normalizeSuiObjectId(this.resolveCoinType(pool.coinTypeA));
          const poolCoinB = normalizeSuiObjectId(this.resolveCoinType(pool.coinTypeB));
        
          return (
            (poolCoinA === normalizedCoinA && poolCoinB === normalizedCoinB) ||
            (poolCoinA === normalizedCoinB && poolCoinB === normalizedCoinA)
        );
      });
      
        if (matchingPools.length === 0) {
          console.warn(`No pools found for pair: ${resolvedCoinA} / ${resolvedCoinB}`);
          throw createCetusError(CetusErrorCode.POOL_NOT_FOUND);
        }
        
        // Return the first matching pool (could add logic for best pool selection)
        const selectedPool = matchingPools[0];
        console.log(`Selected pool: ${selectedPool.poolAddress}`);
        console.log(`Pool coin types: ${selectedPool.coinTypeA} / ${selectedPool.coinTypeB}`);
        
        return selectedPool.poolAddress;
        
      } catch (error) {
        const cetusError = parseError(error);
        CetusErrorLogger.log(cetusError);
        throw cetusError;
      }
    }, 3, (error) => {
      // Only retry network-related errors
      return error.code === CetusErrorCode.NETWORK_ERROR || 
             error.code === CetusErrorCode.RPC_ERROR ||
             error.code === CetusErrorCode.TIMEOUT_ERROR;
    });
  }

  // configureStablecoinSwap (removed 2026-10) built a call to
  // `njangi_circle::configure_stablecoin_swap`. The package has no module of
  // that name, so the transaction could never execute, and nothing called it.

  /**
   * Prepares a swap transaction without executing it
   * Returns transaction payload that can be executed with zkLogin
   */
  async prepareSwapTransaction(
    walletAddress: string,
    suiAmount: number,
    slippageTolerance: number = DEFAULT_SLIPPAGE
  ): Promise<Transaction> {
    const { tx } = await this.prepareSwapTransactionForPair(
      walletAddress,
      SUI_TYPE,
      getCurrentUsdcType(),
      suiAmount,
      slippageTolerance
    );
    return tx;
  }

  /**
   * Gets an estimate of how much USDC you'll receive for a given amount of SUI
   */
  async getSwapEstimate(suiAmount: number): Promise<{
    estimatedOutput: number;
    priceImpact: number;
  }> {
    const quote = await this.getSwapEstimateForPair(SUI_TYPE, getCurrentUsdcType(), suiAmount);
    return {
      estimatedOutput: Number.parseFloat(quote.amountOut),
      priceImpact: quote.priceImpact,
    };
  }
}

export const cetusService = new CetusService(); 
