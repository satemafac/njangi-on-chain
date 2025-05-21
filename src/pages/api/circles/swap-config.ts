import type { NextApiRequest, NextApiResponse } from 'next';

// Type definitions
type SwapConfig = {
  circleId: string;
  walletId: string;
  enabled: boolean;
  targetCoinType: string;
  fullCoinType: string;
  slippageTolerance: number;
  minimumSwapAmount: number;
  updatedBy: string;
  updatedAt: string;
};

// Pool data types
type PoolData = {
  id: string;
  coinTypeA: string;
  coinTypeB: string;
  reserves: {
    a: string;
    b: string;
  };
};

// Mock database - in production you would use Firebase/Firestore
const swapConfigs: Record<string, SwapConfig> = {};

// Mock pool data for testing - now with circle-specific pools
const mockPoolData: Record<string, Record<string, PoolData>> = {};

// Helper to create or get a mock pool for a circle
function getOrCreatePoolForCircle(circleId: string): PoolData {
  // Create an entry for this circle if it doesn't exist
  if (!mockPoolData[circleId]) {
    mockPoolData[circleId] = {};
  }

  // If there's no default pool yet, create one
  if (!mockPoolData[circleId]['default']) {
    mockPoolData[circleId]['default'] = {
      id: `pool-${circleId.substring(0, 8)}`,
      coinTypeA: "0x2::sui::SUI",
      coinTypeB: "0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN",
      reserves: {
        a: (1000000000 + Math.floor(Math.random() * 5000000)).toString(),
        b: (1000000000 + Math.floor(Math.random() * 5000000)).toString()
      }
    };
  }

  return mockPoolData[circleId]['default'];
}

/**
 * API endpoint to save and retrieve stablecoin swap configuration
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  // Handle GET requests - fetch configuration
  if (req.method === 'GET') {
    const { circleId } = req.query;
    
    if (!circleId || typeof circleId !== 'string') {
      return res.status(400).json({ error: 'Missing circle ID' });
    }
    
    // If this is a getQuote action, handle it differently
    if (req.query.action === 'getQuote') {
      return handleGetQuote(req, res);
    }
    
    // For now we're using an in-memory store
    // In production, you would retrieve this from Firestore
    const config = swapConfigs[circleId];
    
    return res.status(200).json({ 
      success: true,
      config: config || null
    });
  }
  
  // Handle POST requests - save configuration
  if (req.method === 'POST') {
    try {
      // Get the config data from request body
      const config = req.body as SwapConfig;
      
      // Basic validation
      if (!config.circleId || !config.walletId) {
        return res.status(400).json({ error: 'Missing required fields' });
      }
      
      // For now, we'll store in-memory
      // In production, you would save to Firestore
      swapConfigs[config.circleId] = {
        ...config,
        updatedAt: new Date().toISOString() // Ensure timestamp is current
      };
      
      // Return success response
      return res.status(200).json({ 
        success: true, 
        message: 'Swap configuration saved successfully'
      });
    } catch (error) {
      console.error('Error saving swap configuration:', error);
      return res.status(500).json({ 
        error: error instanceof Error ? error.message : 'Internal server error' 
      });
    }
  }
  
  // Handle other methods
  return res.status(405).json({ error: 'Method not allowed' });
}

/**
 * Helper function to handle swap quote requests
 */
function handleGetQuote(req: NextApiRequest, res: NextApiResponse) {
  try {
    const { fromCoin, toCoin, amount, circleId } = req.query;
    
    // Check that all required params are present
    if (!fromCoin || !toCoin || !amount) {
      return res.status(400).json({ 
        error: 'Missing required parameters: fromCoin, toCoin, amount' 
      });
    }
    
    // Validate circleId
    if (!circleId || typeof circleId !== 'string') {
      return res.status(400).json({ error: 'Missing circle ID' });
    }
    
    // Get or create a pool for this circle
    const poolData = getOrCreatePoolForCircle(circleId);
    
    // Validate pool structure to prevent the "Invalid pool data structure" error
    if (!poolData.coinTypeA || !poolData.coinTypeB || !poolData.reserves || 
        typeof poolData.reserves.a !== 'string' || typeof poolData.reserves.b !== 'string') {
      return res.status(500).json({ 
        error: 'Invalid pool data structure',
        details: 'The pool data retrieved does not match the expected format'
      });
    }
    
    // Parse the amount, handling potential NaN
    let amountIn = parseInt(amount as string);
    if (isNaN(amountIn) || amountIn <= 0) {
      amountIn = 1000000; // Default sensible value
    }
    
    // Get reserves, ensuring they're valid numbers
    const reserveIn = parseInt(poolData.coinTypeA === fromCoin ? poolData.reserves.a : poolData.reserves.b) || 1000000000;
    const reserveOut = parseInt(poolData.coinTypeA === fromCoin ? poolData.reserves.b : poolData.reserves.a) || 1000000000;
    
    // Simple constant product formula (x * y = k)
    const amountOut = (amountIn * reserveOut) / (reserveIn + amountIn);
    
    // Calculate price impact safely
    const priceImpact = reserveIn > 0 ? (amountIn / reserveIn) * 100 : 0.5;
    
    return res.status(200).json({
      success: true,
      quote: {
        amountIn,
        amountOut: Math.floor(amountOut),
        price: amountOut / Math.max(amountIn, 1), // Avoid division by zero
        priceImpact,
        poolId: poolData.id
      }
    });
  } catch (error) {
    console.error('Error getting swap quote:', error);
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Internal server error',
      details: 'Error occurred while calculating swap quote'
    });
  }
} 