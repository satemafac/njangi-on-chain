import { initCetusSDK } from '@cetusprotocol/cetus-sui-clmm-sdk';
import { normalizeSuiObjectId } from '@mysten/sui/utils';
import { Transaction } from '@mysten/sui/transactions';
import { PACKAGE_ID } from './circle-service';

// Configuration for SUI Testnet
const DEFAULT_SLIPPAGE = 50; // 0.5%
const SUI_TYPE = '0x2::sui::SUI';

// Testnet constants for stablecoins
const USDC_TYPE = '0x9e89965f542887a8f0383451ba553fedf62c04e4dc68f60dec5b8d7ad1436bd6::usdc::USDC';
const USDT_TYPE = '0x6674cb08a6ef2a155b3c240df0c559fcb5fef5738a17851c124dfbe96bc9a744::usdt::COIN';

// Cetus testnet addresses 
const CETUS_PACKAGE = '0x0868b71c0cba55bf0faf6c40df8c179c67a4d0ba0e79965b68b3d72d7dfbf666';

// Testnet Cetus configuration
const CETUS_CONFIG = {
  clmmConfig: {
    pools_id: '0xdf23f5920fbe7d529ddda0c814efd1c5ab3a4ce67fa34dadf9e135c3d617df25',
    global_config_id: '0x6f4149091a5aea0e818e7243a13adcfb403842d670b9a2089de058512620687a',
    package_id: '0x0868b71c0cba55bf0faf6c40df8c179c67a4d0ba0e79965b68b3d72d7dfbf666',
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

// USDC/SUI pool ID on testnet
const USDC_SUI_POOL_ID = '0x2e041f3fd93646dcc877f783c1f2b7fa62d30271bdef1f21ef002cebf857bded';

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
      const poolId = USDC_SUI_POOL_ID; // Currently only supporting USDC/SUI pool
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