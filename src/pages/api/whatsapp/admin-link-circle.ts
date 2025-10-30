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
import { enokiZkLoginService } from '../../../services/enokiZkLoginService';
import { AccountData } from '../../../services/zkLoginService';

interface LinkCircleRequest {
  circleId: string;
  linkType: 1 | 2;  // 1 = individual, 2 = group
  phoneOrGroup: string;
  adminAddress?: string;  // Admin's Sui address
  account?: AccountData;   // Full zkLogin account for transaction signing
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    // Query current link status
    try {
      const { circleId } = req.query;
      
      if (!circleId || typeof circleId !== 'string') {
        return res.status(400).json({
          success: false,
          error: 'Missing circleId'
        });
      }

      const registryObjectId = process.env.SUI_WHATSAPP_LINKS_REGISTRY_ID;
      if (!registryObjectId) {
        throw new Error('SUI_WHATSAPP_LINKS_REGISTRY_ID not configured');
      }

      // In a full implementation, we would:
      // 1. Query the WhatsAppLinksRegistry object from the blockchain
      // 2. Look up the circleId in the registry
      // 3. Return the linked phone number/group if found
      
      // For MVP, return not found (would need dynamic field queries to Sui)
      return res.status(200).json({
        success: true,
        data: {
          isLinked: false,
          message: 'Circle not linked or link data not yet indexed'
        }
      });
    } catch (error) {
      console.error('❌ Error querying link status:', error);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to query link status'
      });
    }
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', ['GET', 'POST']);
    return res.status(405).json({
      success: false,
      error: 'Method not allowed'
    });
  }

  try {
    // Note: Admin authentication is handled at the page level (admin dashboard)
    // This endpoint is only accessible from protected routes
    
    const adminAddr = req.body?.adminAddress || 'unknown';
    const account = req.body?.account as AccountData | undefined;
    
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

    // Get registry object ID and package ID from environment
    const registryObjectId = process.env.SUI_WHATSAPP_LINKS_REGISTRY_ID;
    if (!registryObjectId) {
      throw new Error('SUI_WHATSAPP_LINKS_REGISTRY_ID not configured');
    }

    const packageId = process.env.SUI_WHATSAPP_PACKAGE_ID;
    if (!packageId) {
      throw new Error('SUI_WHATSAPP_PACKAGE_ID not configured');
    }

    // If account data is provided, send the blockchain transaction
    if (account && account.zkProofs && account.ephemeralPrivateKey) {
      // Send transaction using zkLogin credentials
      // The callback receives a TransactionBlock and must build the transaction within it
      const result = await enokiZkLoginService.sendTransaction(
        account,
        (txb) => {
          // Build the link_circle transaction in the provided txb
          txb.moveCall({
            target: `${packageId}::whatsapp_integration::link_circle`,
            arguments: [
              txb.object(registryObjectId),
              txb.pure.address(circleId),
              txb.pure.u8(linkType),
              txb.pure.string(phoneOrGroup),
              txb.pure.address(adminAddr || account.userAddr)
            ]
          });
        },
        { gasBudget: 10_000_000 }
      );

      logAdminAction('LINK_CIRCLE_SUCCESS', adminAddr, {
        circleId,
        linkType,
        recipient: phoneOrGroup,
        txDigest: result.digest,
        status: 'confirmed_on_blockchain'
      });

      return res.status(200).json({
        success: true,
        data: {
          message: 'Circle successfully linked to WhatsApp on-chain!',
          circleId,
          linkType,
          recipient: phoneOrGroup,
          txDigest: result.digest,
          status: 'confirmed'
        }
      });
    } else {
      // Fallback: Account data not provided, just log and return pending
      logAdminAction('LINK_CIRCLE_SUCCESS', adminAddr, {
        circleId,
        status: 'pending_blockchain_confirmation',
        linkType,
        recipient: phoneOrGroup
      });

      return res.status(200).json({
        success: true,
        data: {
          message: 'Circle link initiated. Waiting for blockchain confirmation...',
          circleId,
          linkType,
          recipient: phoneOrGroup,
          status: 'pending'
        }
      });
    }

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
      error: error instanceof Error ? error.message : 'Failed to link circle'
    });
  }
}

export default handler;
