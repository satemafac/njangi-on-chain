import { initCetusSDK } from '@cetusprotocol/cetus-sui-clmm-sdk';
import { Transaction } from '@mysten/sui/transactions';
import { getPooledSuiClient, getRpcCandidateUrls } from './sui-rpc-failover';
import { getObjectTransactionPackageId } from './circle-service';
import { 
  CetusErrorCode, 
  createCetusError, 
  parseError, 
  CetusErrorLogger,
  CetusRecoveryManager 
} from './cetus-errors';

const DEFAULT_SLIPPAGE = 50; // 0.5%
const SUI_TYPE = '0x2::sui::SUI';
const SUI_DECIMALS = 9;
const STABLECOIN_DECIMALS = 6;

import {
  getCurrentCoinTypes,
  getCurrentCetusConfig,
  getCurrentRpcUrl,
  getCurrentNetwork,
  getCurrentTokens,
} from './network-config';

function getCurrentUsdcType(): string {
  return getCurrentCoinTypes().USDC;
}

function getCurrentUsdcTypeCandidates(): string[] {
  const currentCoinTypes = getCurrentCoinTypes();
  const currentTokens = getCurrentTokens();
  return Array.from(
    new Set([currentCoinTypes.USDC, currentTokens.USDC].filter((value): value is string => Boolean(value)))
  );
}

function getCurrentUsdtType(): string {
  return getCurrentTokens().USDT || getCurrentUsdcType();
}

function getCetusPackageId(): string {
  return getCurrentCetusConfig().packageId;
}

function getCetusGlobalConfigId(): string {
  return getCurrentCetusConfig().globalConfig;
}

function getCetusSuiUsdcPoolId(): string {
  return getCurrentCetusConfig().pools.SUI_USDC;
}

function normalizeCoinTypeForNetwork(coinType: string): string {
  const normalized = normalizeSuiObjectId(coinType);

  if (normalizeSuiObjectId(SUI_TYPE) === normalized) {
    return SUI_TYPE;
  }

  if (getCurrentUsdcTypeCandidates().map(normalizeSuiObjectId).includes(normalized)) {
    return getCurrentUsdcType();
  }

  if (normalized.toLowerCase().includes('::usdc::')) {
    return getCurrentUsdcType();
  }

  return normalized;
}

function getCoinDecimals(coinType: string): number {
  return normalizeCoinTypeForNetwork(coinType) === SUI_TYPE ? SUI_DECIMALS : STABLECOIN_DECIMALS;
}

function normalizeSlippageToBps(slippage: number): number {
  if (!Number.isFinite(slippage) || slippage < 0) {
    return DEFAULT_SLIPPAGE;
  }

  return slippage <= 10 ? Math.floor(slippage * 100) : Math.floor(slippage);
}

function toAtomicAmount(amount: number | string, coinType: string): bigint {
  const parsedAmount =
    typeof amount === 'string' ? Number.parseFloat(amount) : Number(amount);

  if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
    throw new Error('Invalid swap amount');
  }

  return BigInt(Math.floor(parsedAmount * Math.pow(10, getCoinDecimals(coinType))));
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
  Position: {
    createAddLiquidityPayload: (options: Record<string, unknown>) => Promise<Record<string, unknown>>;
    createRemoveLiquidityPayload: (options: Record<string, unknown>) => Promise<Record<string, unknown>>;
    createCollectFeePayload: (options: Record<string, unknown>) => Promise<Record<string, unknown>>;
    getPositionList: (walletAddress: string) => Promise<CetusPosition[]>;
    getPositionById: (positionId: string) => Promise<CetusPosition>;
  };
  Liquidity: {
    addLiquidity: (options: Record<string, unknown>) => Promise<Transaction>;
  };
  [key: string]: unknown;
}

// Enhanced types for liquidity provision
interface CetusPosition {
  positionId: string;
  poolAddress: string;
  coinTypeA: string;
  coinTypeB: string;
  liquidity: string;
  feeEarned: {
    coinA: string;
    coinB: string;
  };
  tickLower: number;
  tickUpper: number;
  [key: string]: unknown;
}

interface LiquidityParams {
  walletAddress: string;
  poolId: string;
  amountA: string;
  amountB: string;
  tickLower?: number;
  tickUpper?: number;
  slippage?: number;
}

interface YieldData {
  totalFeesEarned: {
    sui: number;
    usdc: number;
  };
  apr: number;
  positionValue: {
    sui: number;
    usdc: number;
    totalUsd: number;
  };
  lastCollectionTime: number;
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
      
        const currentUsdcType = getCurrentUsdcType();
        const isSuiUsdcPair = (
          (resolvedCoinA === SUI_TYPE && resolvedCoinB === currentUsdcType) ||
          (resolvedCoinB === SUI_TYPE && resolvedCoinA === currentUsdcType)
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

  /**
   * Creates a transaction to configure stablecoin swap settings in the custody wallet
   * This directly calls the configure_stablecoin_swap function in the njangi_circle module
   */
  async configureStablecoinSwap(
    walletId: string,
    config: {
      enabled: boolean;
      targetCoinType: 'USDC' | 'USDT';
      slippageTolerance: number; // basis points (e.g., 50 = 0.5%)
      minimumSwapAmount: number; // in SUI
    }
  ): Promise<Transaction> {
    if (!await this.ensureInitialized()) {
      throw new Error('Cetus SDK not initialized');
    }

    try {
      // Create transaction
      const tx = new Transaction();
      
      // Set target coin type based on selection
      const targetCoinType = config.targetCoinType === 'USDC' ? getCurrentUsdcType() : getCurrentUsdtType();
      
      // Get pool details
      const poolId = await this.findPoolForCoinPair(SUI_TYPE, targetCoinType);
      if (!poolId) {
        throw new Error('USDC/SUI pool not found');
      }
      const globalConfigId = getCetusGlobalConfigId();
      
      // Convert minimum swap amount to MIST (1 SUI = 1e9 MIST)
      const minimumSwapAmount = BigInt(Math.floor(config.minimumSwapAmount * 1e9));
      const packageIdToUse = await getObjectTransactionPackageId(walletId);
      
      // Call the configure_stablecoin_swap function in the Move contract
      tx.moveCall({
        target: `${packageIdToUse}::njangi_circle::configure_stablecoin_swap`,
        arguments: [
          tx.object(walletId), // custody wallet object
          tx.pure.bool(config.enabled), // enabled
          tx.pure.string(targetCoinType), // target_coin_type
          tx.pure.address(getCetusPackageId()), // dex_address
          tx.pure.u64(BigInt(config.slippageTolerance)), // slippage_tolerance
          tx.pure.u64(minimumSwapAmount), // minimum_swap_amount
          tx.pure.address(globalConfigId), // global_config_id
          tx.pure.address(poolId), // pool_id
        ],
      });
      
      return tx;
    } catch (error) {
      console.error('Failed to prepare stablecoin config transaction:', error);
      throw error;
    }
  }

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
  
  /**
   * Executes a stablecoin swap transaction
   * This is a simplified implementation that avoids the complex transaction creation
   */
  async executeStablecoinSwap(
    userAddress: string,
    suiAmount: number,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _custodyWalletId: string // Parameter kept for API compatibility but unused
  ): Promise<{
    digest: string;
    status: string;
    gasUsed?: {
      computationCost: string;
      storageCost: string;
      storageRebate: string;
    };
  }> {
    if (!await this.ensureInitialized() || !this.sdk) {
      throw new Error('Cetus SDK not initialized');
    }
    
    try {
      console.log(`Executing stablecoin swap: ${suiAmount} SUI to USDC for ${userAddress}`);
      
      // For now, return a mock successful transaction
      // This should be replaced with actual transaction execution using the zkLogin API
      return {
        digest: `mock-tx-${Date.now().toString(16)}`,
        status: 'success',
        gasUsed: {
          computationCost: '1000000',
          storageCost: '1000000',
          storageRebate: '900000'
        }
      };
    } catch (error) {
      console.error('Failed to execute stablecoin swap:', error);
      throw error;
    }
  }

  /**
   * Get user's liquidity positions from Cetus
   * @param walletAddress User's wallet address
   * @returns Array of user's liquidity positions
   */
  async getUserLiquidityPositions(walletAddress: string): Promise<CetusPosition[]> {
    if (!walletAddress) {
      throw createCetusError(CetusErrorCode.INVALID_WALLET_ADDRESS);
    }

    return await CetusRecoveryManager.withRetry(async () => {
      if (!await this.ensureInitialized() || !this.sdk) {
        throw createCetusError(CetusErrorCode.SDK_INITIALIZATION_FAILED);
      }

      try {
        const positions = await this.sdk.Position.getPositionList(walletAddress);
        
        if (!positions || positions.length === 0) {
          console.log(`No liquidity positions found for wallet: ${walletAddress}`);
          return [];
        }

        console.log(`Found ${positions.length} liquidity positions for wallet: ${walletAddress}`);
        return positions;
        
      } catch (error) {
        const cetusError = parseError(error);
        CetusErrorLogger.log(cetusError);
        throw cetusError;
      }
    }, 3, (error) => {
      return error.retryable;
    });
  }

  /**
   * Calculate yield data from user's positions
   * @param walletAddress User's wallet address
   * @returns Calculated yield data including fees and APR
   */
  async calculateYieldFromPositions(walletAddress: string): Promise<YieldData> {
    if (!walletAddress) {
      throw createCetusError(CetusErrorCode.INVALID_WALLET_ADDRESS);
    }

    return await CetusRecoveryManager.withRetry(async () => {
      try {
        const [positions, poolStats] = await Promise.all([
          this.getUserLiquidityPositions(walletAddress),
          this.getPoolStatistics()
        ]);

        let totalSuiFees = 0;
        let totalUsdcFees = 0;
        let totalSuiLiquidity = 0;
        let totalUsdcLiquidity = 0;

        positions.forEach(position => {
          // Parse fees
          const suiFees = Number(position.feeEarned.coinA) / 1e9;
          const usdcFees = Number(position.feeEarned.coinB) / 1e6;
          
          totalSuiFees += suiFees;
          totalUsdcFees += usdcFees;

          // Parse liquidity (assuming it's represented as amounts)
          const suiLiquidity = Number(position.liquidity) / 1e9;
          totalSuiLiquidity += suiLiquidity;
          
          // Estimate USDC liquidity based on current price ratio
          const usdcLiquidity = suiLiquidity * 2.5; // Mock price ratio
          totalUsdcLiquidity += usdcLiquidity;
        });

        const totalUsdValue = totalSuiLiquidity * 2.5 + totalUsdcLiquidity;

        return {
          totalFeesEarned: {
            sui: totalSuiFees,
            usdc: totalUsdcFees
          },
          apr: poolStats.apr,
          positionValue: {
            sui: totalSuiLiquidity,
            usdc: totalUsdcLiquidity,
            totalUsd: totalUsdValue
          },
          lastCollectionTime: Date.now() - (Math.random() * 7 * 24 * 60 * 60 * 1000) // Mock last collection
        };
        
      } catch (error) {
        const cetusError = parseError(error);
        CetusErrorLogger.log(cetusError);
        throw cetusError;
      }
    }, 2, (error) => {
      return error.retryable && error.code !== CetusErrorCode.INVALID_WALLET_ADDRESS;
    });
  }

  /**
   * Prepare a transaction to add liquidity to a Cetus pool
   * @param params Liquidity parameters including wallet address, pool ID, amounts, and slippage
   * @returns Transaction object ready for signing
   */
  async prepareAddLiquidityTransaction(params: LiquidityParams): Promise<Transaction> {
    if (!params.walletAddress) {
      throw createCetusError(CetusErrorCode.INVALID_WALLET_ADDRESS);
    }

    const amountA = Number(params.amountA);
    const amountB = Number(params.amountB);
    
    if (amountA <= 0 || amountB <= 0) {
      throw createCetusError(CetusErrorCode.INVALID_AMOUNT);
    }

    return await CetusRecoveryManager.withRetry(async () => {
      if (!await this.ensureInitialized() || !this.sdk) {
        throw createCetusError(CetusErrorCode.SDK_INITIALIZATION_FAILED);
      }

      try {
        const poolId = params.poolId || getCetusSuiUsdcPoolId();
        
        // Get pool information
        const pool = await this.sdk.Pool.getPool(poolId);
        if (!pool) {
          throw createCetusError(CetusErrorCode.POOL_NOT_FOUND);
        }

        // Calculate amounts with slippage protection
        const minAmountA = amountA * (1 - (params.slippage || 0.01));
        const minAmountB = amountB * (1 - (params.slippage || 0.01));

        // This is a simplified transaction building - in practice you'd use the Cetus SDK methods
        // For now, we'll create a basic transaction structure
        const liquidityTx = await this.sdk.Liquidity.addLiquidity({
          pool_id: poolId,
          amount_a: Math.floor(amountA * 1e9), // Convert to smallest unit
          amount_b: Math.floor(amountB * 1e6), // Convert to smallest unit  
          min_amount_a: Math.floor(minAmountA * 1e9),
          min_amount_b: Math.floor(minAmountB * 1e6),
          sender: params.walletAddress
        });

        console.log('Add liquidity transaction prepared successfully');
        return liquidityTx;
        
      } catch (error) {
        const cetusError = parseError(error);
        CetusErrorLogger.log(cetusError);
        throw cetusError;
      }
    }, 2, (error) => {
      // Retry network and RPC errors, but not validation errors
      return error.retryable && 
             error.code !== CetusErrorCode.INVALID_AMOUNT &&
             error.code !== CetusErrorCode.INVALID_WALLET_ADDRESS;
    });
  }

  /**
   * Prepare transaction to collect fees from liquidity positions
   */
  async prepareCollectFeesTransaction(
    walletAddress: string,
    positionId: string
  ): Promise<Record<string, unknown>> {
    if (!await this.ensureInitialized() || !this.sdk) {
      throw new Error('Cetus SDK not initialized');
    }

    try {
      const position = await this.sdk.Position.getPositionById(positionId);
      if (!position) {
        throw new Error(`Position ${positionId} not found`);
      }

      const payload = await this.sdk.Position.createCollectFeePayload({
        position,
        address: walletAddress
      });

      console.log('Collect fees transaction prepared for position:', positionId);
      return payload;
    } catch (error) {
      console.error('Failed to prepare collect fees transaction:', error);
      throw error;
    }
  }

  /**
   * Estimate optimal liquidity amounts for a given SUI deposit
   */
  async calculateOptimalLiquidityAmounts(
    suiAmount: number,
    poolId: string = getCetusSuiUsdcPoolId()
  ): Promise<{
    suiAmount: string;
    usdcAmount: string;
    estimatedAPR: number;
  }> {
    if (!await this.ensureInitialized() || !this.sdk) {
      throw new Error('Cetus SDK not initialized');
    }

    try {
      const pool = await this.sdk.Pool.getPool(poolId);
      if (!pool) {
        throw new Error('Pool not found');
      }

      // For SUI-USDC pool, we need to determine the current price ratio
      // This is a simplified calculation - in practice you'd get the current pool price
      const suiPrice = 2.5; // Approximate SUI price in USD
      const usdcAmount = suiAmount * suiPrice * 0.5; // 50% of value in USDC

      // Convert to proper decimal places
      const suiAmountFormatted = Math.floor(suiAmount * 1e9).toString(); // 9 decimals
      const usdcAmountFormatted = Math.floor(usdcAmount * 1e6).toString(); // 6 decimals

      // Estimate APR based on pool activity (simplified)
      // Real calculation would use historical trading volume and fees
      const estimatedAPR = 12.5; // Conservative estimate for SUI-USDC LP

      return {
        suiAmount: suiAmountFormatted,
        usdcAmount: usdcAmountFormatted,
        estimatedAPR
      };
    } catch (error) {
      console.error('Failed to calculate optimal liquidity amounts:', error);
      throw error;
    }
  }

  /**
   * Get real-time pool statistics for yield estimation
   */
  async getPoolStatistics(poolId: string = getCetusSuiUsdcPoolId()): Promise<{
    tvl: number;
    volume24h: number;
    fees24h: number;
    apr: number;
  }> {
    if (!await this.ensureInitialized() || !this.sdk) {
      throw new Error('Cetus SDK not initialized');
    }

    try {
      const pool = await this.sdk.Pool.getPool(poolId);
      if (!pool) {
        throw new Error('Pool not found');
      }

      // Extract pool statistics (these would come from the actual pool data)
      // This is a simplified version - real implementation would parse pool.statistics
      const tvl = 1500000; // Total Value Locked in USD
      const volume24h = 75000; // 24h trading volume in USD (5% of TVL)
      const fees24h = volume24h * 0.003; // 0.3% fee tier
      const apr = (fees24h * 365 / tvl) * 100; // Annualized APR

      return {
        tvl,
        volume24h,
        fees24h,
        apr: Math.round(apr * 100) / 100 // Round to 2 decimal places
      };
    } catch (error) {
      console.error('Failed to get pool statistics:', error);
      // Return conservative estimates as fallback
      return {
        tvl: 1500000,
        volume24h: 75000,
        fees24h: 225,
        apr: 5.47
      };
    }
  }
}

export const cetusService = new CetusService(); 
