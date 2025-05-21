// Test script for Cetus pools using CommonJS
const { initCetusSDK } = require('@cetusprotocol/cetus-sui-clmm-sdk');

async function main() {
  try {
    console.log('Initializing Cetus SDK...');
    const sdk = initCetusSDK({
      network: 'testnet',
      fullNodeUrl: 'https://fullnode.testnet.sui.io:443',
    });

    console.log('Fetching all pools...');
    // Use getPoolsWithPage with empty array to get all pools
    const allPools = await sdk.Pool.getPoolsWithPage([]);
    
    console.log(`Found ${allPools.length} pools total`);
    
    // Search for SUI/USDC pools with flexible coin type matching
    const SUI_PATTERNS = ['sui::SUI', '::sui::'];
    const USDC_PATTERNS = ['::usdc::', '::coin::COIN'];
    
    const suiUsdcPools = allPools.filter(pool => {
      const typeA = (pool.coinTypeA || '').toLowerCase();
      const typeB = (pool.coinTypeB || '').toLowerCase();
      
      const hasSui = SUI_PATTERNS.some(pattern => 
        typeA.includes(pattern.toLowerCase()) || 
        typeB.includes(pattern.toLowerCase())
      );
      
      const hasUsdc = USDC_PATTERNS.some(pattern => 
        typeA.includes(pattern.toLowerCase()) || 
        typeB.includes(pattern.toLowerCase())
      );
      
      return hasSui && hasUsdc;
    });
    
    console.log(`\nFound ${suiUsdcPools.length} SUI/USDC pools:`);
    
    // Print details of each SUI/USDC pool
    suiUsdcPools.forEach((pool, index) => {
      console.log(`\nPool #${index + 1}:`);
      console.log(`- Address: ${pool.poolAddress}`);
      console.log(`- Type: ${pool.poolType}`);
      console.log(`- Coin A: ${pool.coinTypeA}`);
      console.log(`- Coin B: ${pool.coinTypeB}`);
      console.log(`- Liquidity: ${pool.liquidity}`);
      console.log(`- Fee Rate: ${pool.fee_rate}`);
      console.log(`- Status: ${pool.is_pause ? 'Paused' : 'Active'}`);
    });
    
    // Find the best pool (most liquidity)
    if (suiUsdcPools.length > 0) {
      const activePools = suiUsdcPools.filter(pool => !pool.is_pause);
      
      if (activePools.length > 0) {
        const bestPool = activePools.reduce((best, current) => {
          const currentLiquidity = BigInt(String(current.liquidity || '0'));
          const bestLiquidity = BigInt(String(best.liquidity || '0'));
          return currentLiquidity > bestLiquidity ? current : best;
        }, activePools[0]);
        
        console.log('\n=== RECOMMENDED POOL ===');
        console.log(`- Address: ${bestPool.poolAddress}`);
        console.log(`- Liquidity: ${bestPool.liquidity}`);
        console.log(`- Fee Rate: ${bestPool.fee_rate}`);
      } else {
        console.log('\nNo active SUI/USDC pools found!');
      }
    }
  } catch (error) {
    console.error('Error fetching pools:', error);
  }
}

main();
