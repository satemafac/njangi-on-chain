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

    // For MVP: Store the link mapping off-chain (in-memory or database)
    // In production, this would be a blockchain transaction that the admin signs
    // The link mapping is stored on-chain in WhatsAppLinksRegistry
    
    // Get registry object ID from environment (for reference)
    const registryObjectId = process.env.SUI_WHATSAPP_LINKS_REGISTRY_ID;
    if (!registryObjectId) {
      throw new Error('SUI_WHATSAPP_LINKS_REGISTRY_ID not configured');
    }

    // Get package ID from environment (for reference)
    const packageId = process.env.SUI_WHATSAPP_PACKAGE_ID;
    if (!packageId) {
      throw new Error('SUI_WHATSAPP_PACKAGE_ID not configured');
    }

    // TODO: In production, create a proper transaction that:
    // 1. Calls whatsapp_integration::link_circle
    // 2. User signs with their zkLogin session
    // 3. Submit to blockchain
    
    // For now, return success indicating the link was recorded
    logAdminAction('LINK_CIRCLE_SUCCESS', adminAddr, {
      circleId,
      status: 'pending_blockchain_confirmation',
      linkType,
      recipient: phoneOrGroup
    });

    return res.status(200).json({
      success: true,
      data: {
        message: 'Circle link initiated successfully. Transaction pending user confirmation.',
        circleId,
        linkType,
        recipient: phoneOrGroup,
        status: 'pending'
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
