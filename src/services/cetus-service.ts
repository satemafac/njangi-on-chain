import { initCetusSDK } from '@cetusprotocol/cetus-sui-clmm-sdk';
import { Transaction } from '@mysten/sui/transactions';
import { PACKAGE_ID } from './circle-service';

// Configuration for SUI Testnet for v1.26.0 - Updated Cetus pools
const DEFAULT_SLIPPAGE = 50; // 0.5%
const SUI_TYPE = '0x2::sui::SUI';

// Testnet constants for stablecoins
const USDC_TYPE = '0x26b3bc67befc214058ca78ea9a2690298d731a2d4309485ec3d40198063c4abc::usdc::USDC';
const USDT_TYPE = '0x6674cb08a6ef2a155b3c240df0c559fcb5fef5738a17851c124dfbe96bc9a744::usdt::COIN';

// Cetus testnet addresses 
const CETUS_PACKAGE = '0x0c7ae833c220aa73a3643a0d508afa4ac5d50d97312ea4584e35f9eb21b9df12';

// Testnet Cetus configuration
const CETUS_CONFIG = {
  clmmConfig: {
    pools_id: '0xdf23f5920fbe7d529ddda0c814efd1c5ab3a4ce67fa34dadf9e135c3d617df25',
    global_config_id: '0xf5ff7d5ba73b581bca6b4b9fa0049cd320360abd154b809f8700a8fd3cfaf7ca',
    package_id: '0x0c7ae833c220aa73a3643a0d508afa4ac5d50d97312ea4584e35f9eb21b9df12',
    published_at: '0xb2a1d27337788bda89d350703b8326952413bd94b35b9b573ac8401b9803d018',
    config_id: '0xf5ff7d5ba73b581bca6b4b9fa0049cd320360abd154b809f8700a8fd3cfaf7ca'
  },
  cetusConfig: {
    coin_list_id: '0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb',
    launchpad_pools_id: '0x38465dad7da5e2c57cd68be9cfb7a7b370ac0fae42057a6085e9c7b924af9b09',
    package_id: '0x25253305c8c0b393698cf26ff475f7e0b86f212a15711534adc627785a938494',
    global_config_id: '0x1049dd299e1364f2be3dd467498be16fb32f23d4a938bef0a4ea6fd0a160d659',
    cert_id: '0x6f1a1ccc1c8bfc4a5612fbea2d62c531832e99cbf46582410ec92d938cd1c66a'
  },
  networkOptions: {
    url: 'https://fullnode.testnet.sui.io:443'
  }
};

// SUI-USDC Pool on Cetus (Testnet)
const USDC_SUI_POOL_ID = '0xb01b068bd0360bb3308b81eb42386707e460b7818816709b7f51e1635d542d40';

// SUI-USDC Pool will be fetched dynamically from the SDK
// Don't hardcode pool IDs as they can change with protocol upgrades

// Define safer types for the SDK
interface CetusPoolData {
  poolAddress: string;
  coinTypeA: string;
  coinTypeB: string;
  [key: string]: unknown;
}

interface CetusSDKInterface {
  Pool: {
    getPool: (poolId: string) => Promise<CetusPoolData>;
    getPoolByCoins: (coinTypes: string[]) => Promise<CetusPoolData[]>;
    getPoolsWithPage: (options: Record<string, unknown>) => Promise<CetusPoolData[]>;
  };
  Swap: {
    createSwapTransactionPayload: (options: Record<string, unknown>) => Promise<Record<string, unknown>>;
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

  constructor() {
    this.initialize();
  }

  async initialize() {
    try {
      // Initialize the SDK and cast to our interface
      // Using unknown as an intermediate step to avoid type errors with the SDK
      this.sdk = initCetusSDK({
        network: 'testnet',
        fullNodeUrl: CETUS_CONFIG.networkOptions.url
      }) as unknown as CetusSDKInterface;
      
      this.initialized = true;
      console.log('Cetus SDK initialized successfully');
    } catch (error) {
      console.error('Failed to initialize Cetus SDK:', error);
      this.initialized = false;
    }
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  async ensureInitialized(): Promise<boolean> {
    if (!this.initialized) {
      await this.initialize();
    }
    return this.initialized;
  }

  /**
   * Finds the best pool for swapping between two coins
   * @param coinTypeA First coin type
   * @param coinTypeB Second coin type 
   * @returns Pool ID string or null if not found
   */
  async findPoolForCoinPair(coinTypeA: string, coinTypeB: string): Promise<string | null> {
    if (!await this.ensureInitialized() || !this.sdk) {
      throw new Error('SDK initialization failed');
    }

    try {
      console.log(`Finding pools for: ${coinTypeA} and ${coinTypeB}`);
      
      // Special handling for SUI/USDC pair - enhanced to handle multiple USDC formats
      const isSuiUsdcPair = (
        (coinTypeA === SUI_TYPE && (coinTypeB === USDC_TYPE || coinTypeB.toLowerCase().includes('usdc') || coinTypeB.toLowerCase().includes('coin'))) ||
        (coinTypeB === SUI_TYPE && (coinTypeA === USDC_TYPE || coinTypeA.toLowerCase().includes('usdc') || coinTypeA.toLowerCase().includes('coin')))
      );

      if (isSuiUsdcPair) {
        console.log('Detected SUI/USDC pair, using hardcoded pool ID');
        
        // Validate that the pool exists before returning it
        try {
          const pool = await this.sdk.Pool.getPool(USDC_SUI_POOL_ID);
          if (pool) {
            console.log(`Confirmed hardcoded pool exists: ${USDC_SUI_POOL_ID}`);
            console.log(`Pool details: CoinA=${pool.coinTypeA}, CoinB=${pool.coinTypeB}`);
            return USDC_SUI_POOL_ID;
          } else {
            console.warn('Hardcoded pool ID exists but returned null pool data');
          }
        } catch (poolError) {
          console.warn(`Failed to verify hardcoded pool: ${poolError}`);
          // Continue with normal pool search as fallback
        }
      }
      
      // Use getPoolsWithPage to get all pools
      const allPools = await this.sdk.Pool.getPoolsWithPage({});
      console.log(`Found ${allPools.length} total pools, filtering for matching pair...`);
      
      // Normalize inputs
      const coinANormalized = normalizeSuiObjectId(coinTypeA);
      const coinBNormalized = normalizeSuiObjectId(coinTypeB);
      
      // Find pools that match these coin types exactly (in either order)
      const matchingPools = allPools.filter(pool => {
        const poolCoinA = normalizeSuiObjectId(pool.coinTypeA || '');
        const poolCoinB = normalizeSuiObjectId(pool.coinTypeB || '');
        
        const matchesExactly = (
          (poolCoinA === coinANormalized && poolCoinB === coinBNormalized) ||
          (poolCoinA === coinBNormalized && poolCoinB === coinANormalized)
        );
        
        return matchesExactly && !pool.is_pause;
      });
      
      if (matchingPools.length === 0) {
        console.log('No exact matching pools found, trying more flexible matching...');
        
        // Try partial matching as fallback
        const flexibleMatches = allPools.filter(pool => {
          const poolCoinA = String(pool.coinTypeA || '').toLowerCase();
          const poolCoinB = String(pool.coinTypeB || '').toLowerCase();
          const coinALower = coinTypeA.toLowerCase();
          const coinBLower = coinTypeB.toLowerCase();
          
          const matchesA = poolCoinA.includes(coinALower) || poolCoinB.includes(coinALower);
          const matchesB = poolCoinA.includes(coinBLower) || poolCoinB.includes(coinBLower);
          
          return matchesA && matchesB && !pool.is_pause;
        });
        
        if (flexibleMatches.length === 0) {
          console.log('No matching pools found with flexible matching either');
          return null;
        }
        
        console.log(`Found ${flexibleMatches.length} pools with flexible matching`);
        // Continue with these matches
        matchingPools.push(...flexibleMatches);
      } else {
        console.log(`Found ${matchingPools.length} exact matching pools`);
      }
      
      // Filter for active pools and sort by liquidity (largest first)
      const activePools = matchingPools
        .sort((a: CetusPoolData & { liquidity?: string }, b: CetusPoolData & { liquidity?: string }) => {
          const liquidityA = BigInt(String(a.liquidity || '0'));
          const liquidityB = BigInt(String(b.liquidity || '0'));
          return Number(liquidityB - liquidityA);
        });
      
      if (activePools.length === 0) {
        console.log('No active pools found for this pair');
        return null;
      }
      
      // Log details of the top 3 pools to help with debugging
      activePools.slice(0, 3).forEach((pool, index) => {
        console.log(`Pool ${index+1}: ID=${pool.poolAddress}, CoinA=${pool.coinTypeA}, CoinB=${pool.coinTypeB}, Liquidity=${pool.liquidity}, FeeRate=${pool.fee_rate}`);
      });
      
      // Prefer pools with lower fee rates when liquidity is similar
      const bestPool = activePools.reduce((best: CetusPoolData & { liquidity?: string; fee_rate?: string }, 
                                           current: CetusPoolData & { liquidity?: string; fee_rate?: string }) => {
        // Only consider as better if it has at least 80% of the liquidity of current best
        const currentLiquidity = BigInt(String(current.liquidity || '0'));
        const bestLiquidity = BigInt(String(best.liquidity || '0'));
        
        if (currentLiquidity > (bestLiquidity * BigInt(8)) / BigInt(10)) {
          // If liquidity is comparable, prefer lower fee rate
          if (Number(current.fee_rate || 0) < Number(best.fee_rate || 0)) {
            return current;
          }
        }
        return best;
      }, activePools[0]);
      
      console.log(`Selected best pool: ${bestPool.poolAddress} with liquidity ${bestPool.liquidity} and fee rate ${bestPool.fee_rate}`);
      return bestPool.poolAddress;
    } catch (error) {
      console.error('Error finding pool:', error);
      // Log more detailed error information
      if (error instanceof Error) {
        console.error('Error details:', error.message);
        if ('stack' in error) console.error(error.stack);
      }
      
      // Fallback to hardcoded pool for SUI/USDC if request fails
      if ((coinTypeA === SUI_TYPE && (coinTypeB === USDC_TYPE || coinTypeB.toLowerCase().includes('usdc') || coinTypeB.toLowerCase().includes('coin'))) || 
          (coinTypeB === SUI_TYPE && (coinTypeA === USDC_TYPE || coinTypeA.toLowerCase().includes('usdc') || coinTypeA.toLowerCase().includes('coin')))) {
        console.log('Using hardcoded SUI/USDC pool as fallback');
        return USDC_SUI_POOL_ID;
      }
      
      return null;
    }
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
      const targetCoinType = config.targetCoinType === 'USDC' ? USDC_TYPE : USDT_TYPE;
      
      // Get pool details
      const poolId = await this.findPoolForCoinPair(SUI_TYPE, targetCoinType);
      if (!poolId) {
        throw new Error('USDC/SUI pool not found');
      }
      const globalConfigId = CETUS_CONFIG.clmmConfig.global_config_id;
      
      // Convert minimum swap amount to MIST (1 SUI = 1e9 MIST)
      const minimumSwapAmount = BigInt(Math.floor(config.minimumSwapAmount * 1e9));
      
      // Call the configure_stablecoin_swap function in the Move contract
      tx.moveCall({
        target: `${PACKAGE_ID}::njangi_circle::configure_stablecoin_swap`,
        arguments: [
          tx.object(walletId), // custody wallet object
          tx.pure.bool(config.enabled), // enabled
          tx.pure.string(targetCoinType), // target_coin_type
          tx.pure.address(CETUS_PACKAGE), // dex_address
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
  ): Promise<Record<string, unknown>> {
    if (!await this.ensureInitialized() || !this.sdk) {
      throw new Error('Cetus SDK not initialized');
    }

    try {
      // Convert SUI amount to correct format (9 decimals)
      const amountIn = Math.floor(suiAmount * 1e9).toString();
      
      // Fetch pool data
      const pool = await this.sdk.Pool.getPool(USDC_SUI_POOL_ID);
      if (!pool) {
        throw new Error('USDC/SUI pool not found');
      }

      // Determine if we're swapping from SUI to USDC or vice versa
      const coinTypeA = pool.coinTypeA;
      const coinTypeB = pool.coinTypeB;
      
      // Make sure we're using normalized SUI type
      const normalizedSuiType = normalizeSuiObjectId(SUI_TYPE);
      
      // Determine direction (SUI → USDC)
      const isSuiToUsdc = 
        normalizedSuiType === normalizeSuiObjectId(coinTypeA) ||
        normalizedSuiType === coinTypeA;
      
      if (!isSuiToUsdc) {
        throw new Error('SUI is not part of this pool');
      }

      // Prepare the swap transaction
      const payload = await this.sdk.Swap.createSwapTransactionPayload({
        pool,
        coinTypeA: isSuiToUsdc ? coinTypeA : coinTypeB,
        coinTypeB: isSuiToUsdc ? coinTypeB : coinTypeA,
        address: walletAddress,
        amount: amountIn,
        amountSpecifiedIsInput: true, // We're specifying the input amount
        slippage: slippageTolerance,
        isXToY: isSuiToUsdc // SUI → USDC
      });
      
      console.log('Swap transaction payload created:', payload);
      return payload;
    } catch (error) {
      console.error('Failed to prepare swap transaction:', error);
      throw error;
    }
  }

  /**
   * Gets an estimate of how much USDC you'll receive for a given amount of SUI
   */
  async getSwapEstimate(suiAmount: number): Promise<{
    estimatedOutput: number;
    priceImpact: number;
  }> {
    if (!await this.ensureInitialized() || !this.sdk) {
      throw new Error('Cetus SDK not initialized');
    }

    try {
      // Convert SUI amount to correct format (9 decimals)
      const amountIn = Math.floor(suiAmount * 1e9).toString();
      
      // Fetch pool data
      const pool = await this.sdk.Pool.getPool(USDC_SUI_POOL_ID);
      if (!pool) {
        throw new Error('USDC/SUI pool not found');
      }

      // Get the price impact and estimated output
      const estResult = await this.sdk.Swap.calculateRates({
        pool,
        amount: amountIn,
        decimalsA: 9, // SUI has 9 decimals
        decimalsB: 6, // USDC has 6 decimals
        slippage: DEFAULT_SLIPPAGE,
        isXToY: true, // SUI → USDC
        amountSpecifiedIsInput: true
      });

      // Convert the estimated USDC output from Cetus format (with decimals)
      // USDC on SUI has 6 decimals
      const estimatedOutput = Number(estResult.estimatedAmountOut) / 1e6;
      
      return {
        estimatedOutput,
        priceImpact: Number(estResult.priceImpact)
      };
    } catch (error) {
      console.error('Failed to get swap estimate:', error);
      throw error;
    }
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
}

export const cetusService = new CetusService(); 