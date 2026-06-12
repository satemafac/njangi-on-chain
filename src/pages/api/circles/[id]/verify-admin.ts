import { NextApiRequest, NextApiResponse } from 'next';
import { getCurrentNetworkConfig } from '@/services/network-config';
import { getPooledSuiClient } from '@/services/sui-rpc-failover';

/**
 * 🔐 Circle Admin Verification API
 * 
 * Verifies if a given wallet address is the admin of a specific circle
 * Uses blockchain state as source of truth
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({
      success: false,
      error: 'Method not allowed'
    });
  }

  try {
    const { id: circleId } = req.query;
    const { userAddress } = req.body;

    if (!circleId || !userAddress) {
      return res.status(400).json({
        success: false,
        error: 'Missing circleId or userAddress'
      });
    }

    // Initialize Sui client
    const suiClient = getPooledSuiClient({
      rpcUrl: getCurrentNetworkConfig().rpcUrl,
    });

    // Get circle object from blockchain
    const circleObject = await suiClient.getObject({
      id: circleId as string,
      options: {
        showContent: true,
        showType: true,
      },
    });

    if (!circleObject.data) {
      return res.status(404).json({
        success: false,
        error: 'Circle not found'
      });
    }

    // Extract admin from circle object
    const circleContent = circleObject.data.content;
    if (circleContent?.dataType !== 'moveObject') {
      return res.status(400).json({
        success: false,
        error: 'Invalid circle object'
      });
    }

    // Parse circle fields to get admin address
    const fields = (circleContent as { fields: { admin?: string } }).fields;
    const adminAddress = fields?.admin;

    if (!adminAddress) {
      return res.status(400).json({
        success: false,
        error: 'Admin address not found in circle'
      });
    }

    // Compare addresses (normalize to handle potential formatting differences)
    const normalizedUserAddress = userAddress.toLowerCase().replace(/^0x/, '');
    const normalizedAdminAddress = adminAddress.toLowerCase().replace(/^0x/, '');
    
    const isAdmin = normalizedUserAddress === normalizedAdminAddress;

    return res.status(200).json({
      success: true,
      isAdmin,
      adminAddress,
      userAddress,
      message: isAdmin 
        ? 'User is verified as circle admin' 
        : 'User is not the admin of this circle'
    });

  } catch (error) {
    console.error('Error verifying circle admin:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to verify admin status',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
} 
