// API route to proxy Cetus APR data and handle CORS issues
import type { NextApiRequest, NextApiResponse } from 'next';

interface CetusPoolResponse {
  swap_account?: string;
  pool_id?: string;
  coin_a_symbol?: string;
  coin_b_symbol?: string;
  apr_24h?: string | number;
  apr_7day?: string | number;
  apr_30day?: string | number;
  rewarder_apr?: string | number;
  tvl?: string | number;
  volume_24h?: string | number;
  fee_24h?: string | number;
}

interface CetusAPIResponse {
  data?: {
    pools?: CetusPoolResponse[];
  };
}

const CETUS_MAINNET_POOLS = 'https://api-sui.cetus.zone/v2/sui/swap/count';
const CETUS_TESTNET_POOLS = 'https://api-sui.devcetus.com/v2/sui/swap/count';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Always try mainnet first since testnet is often down
    // This gives us real live APR data from mainnet pools
    console.log('Trying mainnet Cetus API first for live APR data...');
    
    let response;
    let apiUrl = CETUS_MAINNET_POOLS;
    
    try {
      response = await fetch(apiUrl, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': 'Njangi-DeFi/1.0'
        },
        signal: AbortSignal.timeout(10000) // 10 second timeout
      });
      
      if (!response.ok) {
        throw new Error(`Mainnet API responded with ${response.status}`);
      }
      
      console.log('✅ Successfully fetched from mainnet Cetus API');
    } catch (mainnetError) {
      console.log('❌ Mainnet failed, trying testnet...', mainnetError);
      
      // Fallback to testnet
      apiUrl = CETUS_TESTNET_POOLS;
      response = await fetch(apiUrl, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': 'Njangi-DeFi/1.0'
        },
        signal: AbortSignal.timeout(10000)
      });
      
      if (!response.ok) {
        throw new Error(`Both mainnet and testnet APIs failed. Testnet: ${response.status}: ${response.statusText}`);
      }
      
      console.log('✅ Successfully fetched from testnet Cetus API');
    }

    const data: CetusAPIResponse = await response.json();

    // Filter for SUI pairs only to reduce payload size
    const filteredPools = data?.data?.pools?.filter((pool: CetusPoolResponse) => 
      pool.coin_a_symbol === 'SUI' || pool.coin_b_symbol === 'SUI'
    ) || [];

    res.status(200).json({
      success: true,
      data: {
        pools: filteredPools
      },
      timestamp: new Date().toISOString(),
      source: apiUrl,
      network: apiUrl.includes('devcetus') ? 'testnet' : 'mainnet',
      poolCount: filteredPools.length
    });

  } catch (error) {
    console.error('Error proxying Cetus APR data:', error);
    
    // Return fallback data with error indication
    res.status(200).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      data: {
        pools: [
          {
            pool_id: '0xb01b068bd0360bb3308b81eb42386707e460b7818816709b7f51e1635d542d40',
            coin_a_symbol: 'SUI',
            coin_b_symbol: 'USDC',
            apr_24h: 5.48,
            apr_7day: 5.48,
            apr_30day: 5.48,
            rewarder_apr: 0,
            tvl: 1500000,
            volume_24h: 75000,
            fee_24h: 225
          },
          {
            pool_id: '0x0254747f5ca059a1972cd7f6016485d51392a3fde608107b93bbaebea550f703',
            coin_a_symbol: 'SUI',
            coin_b_symbol: 'USDT',
            apr_24h: 4.2,
            apr_7day: 4.2,
            apr_30day: 4.2,
            rewarder_apr: 0,
            tvl: 1200000,
            volume_24h: 50000,
            fee_24h: 150
          }
        ]
      },
      timestamp: new Date().toISOString(),
      fallback: true
    });
  }
}