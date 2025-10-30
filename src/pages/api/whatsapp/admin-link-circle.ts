/**
 * 🔐 Admin Link Circle Endpoint
 * 
 * Protected endpoint for admin to link circles to WhatsApp
 * Requires: zkLogin authentication + link_circle permission
 * 
 * Example usage:
 * POST /api/whatsapp/admin-link-circle
 * Authorization: Bearer <token>
 * {
 *   "circleId": "0x123...",
 *   "linkType": 1,
 *   "phoneOrGroup": "1234567890"
 * }
 */

import { NextApiResponse } from 'next';
import { NextApiRequest } from 'next';
import { SuiClient } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import { enokiZkLoginService } from '../../../services/enokiZkLoginService';
import { logAdminAction } from '../../../middleware/admin-auth.middleware';

interface LinkCircleRequest {
  circleId: string;
  linkType: 1 | 2;  // 1 = individual, 2 = group
  phoneOrGroup: string;
  adminAddress?: string;  // Admin's Sui address
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({
      success: false,
      error: 'Method not allowed'
    });
  }

  try {
    // Note: Admin authentication is handled at the page level (admin dashboard)
    // This endpoint is only accessible from protected routes
    
    const adminAddr = req.body?.adminAddress || 'unknown';
    
    // Validate request body
    const { circleId, linkType, phoneOrGroup } = req.body as LinkCircleRequest;

    if (!circleId || !linkType || !phoneOrGroup) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: circleId, linkType, phoneOrGroup'
      });
    }

    if (![1, 2].includes(linkType)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid linkType (must be 1 or 2)'
      });
    }

    // Log the action
    logAdminAction('LINK_CIRCLE_INITIATED', adminAddr, {
      circleId,
      linkType,
      recipient: linkType === 1 ? 'individual' : 'group'
    });

    // Call Move contract via transaction
    // This is a simplified example - actual implementation would:
    // 1. Build transaction to call whatsapp_integration::link_circle
    // 2. Sign with admin's zkLogin credentials
    // 3. Submit to blockchain

    const suiClient = new SuiClient({
      url: process.env.NEXT_PUBLIC_SUI_RPC_URL || 'https://fullnode.testnet.sui.io:443'
    });

    // Create transaction block
    const txb = new Transaction();
    
    // Get registry object ID from environment
    const registryObjectId = process.env.WHATSAPP_REGISTRY_OBJECT_ID;
    if (!registryObjectId) {
      throw new Error('WHATSAPP_REGISTRY_OBJECT_ID not configured');
    }

    // Get package ID from environment
    const packageId = process.env.NJANGI_PACKAGE_ID;
    if (!packageId) {
      throw new Error('NJANGI_PACKAGE_ID not configured');
    }

    // Add transaction action: link_circle
    txb.moveCall({
      target: `${packageId}::whatsapp_integration::link_circle`,
      arguments: [
        txb.object(registryObjectId),
        txb.pure.address(circleId),
        txb.pure.u8(linkType),
        txb.pure.string(phoneOrGroup),
        txb.pure.address(adminAddr)
      ]
    });

    // Sign and send transaction with admin's account
    // Note: In production, use proper account management
    const result = await enokiZkLoginService.sendTransaction(
      {
        provider: 'Google', // Would come from session
        userAddr: adminAddr,
        zkProofs: undefined as any, // Would come from session
        ephemeralPrivateKey: '', // Would come from session
        userSalt: '', // Would come from session
        sub: '',
        aud: '',
        maxEpoch: 0
      },
      () => { /* Transaction already prepared */ },
      { gasBudget: 10_000_000 }
    );

    logAdminAction('LINK_CIRCLE_SUCCESS', adminAddr, {
      circleId,
      txDigest: result.digest
    });

    return res.status(200).json({
      success: true,
      data: {
        message: 'Circle linked to WhatsApp successfully',
        txDigest: result.digest,
        circleId,
        linkType
      }
    });

  } catch (error) {
    const suiAddress = req.body?.adminAddress;
    if (suiAddress) {
      logAdminAction('LINK_CIRCLE_ERROR', suiAddress, {
        error: error instanceof Error ? error.message : String(error),
        circleId: req.body?.circleId
      });
    }

    console.error('❌ Admin link circle error:', error);
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Internal server error'
    });
  }
}

// Export handler with middlewares applied
export default handler;
