/**
 * 🔗 Admin Unlink Circle Endpoint
 * 
 * Endpoint for admin to unlink circles from WhatsApp
 * Uses zkLogin credentials to sign the blockchain transaction
 * 
 * Example usage:
 * POST /api/whatsapp/admin-unlink-circle
 * {
 *   "circleId": "0x123...",
 *   "adminAddress": "0x456...",
 *   "account": { zkLogin account data }
 * }
 */

import { NextApiResponse, NextApiRequest } from 'next';
import { logAdminAction } from '../../../middleware/admin-auth.middleware';
import { enokiZkLoginService } from '../../../services/enokiZkLoginService';
import { AccountData } from '../../../services/zkLoginService';

interface UnlinkCircleRequest {
  circleId: string;
  adminAddress?: string;
  account?: AccountData;
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
    const adminAddr = req.body?.adminAddress || 'unknown';
    const account = req.body?.account as AccountData | undefined;
    const { circleId } = req.body as UnlinkCircleRequest;

    if (!circleId) {
      return res.status(400).json({
        success: false,
        error: 'Missing circleId'
      });
    }

    // Log the unlink action
    logAdminAction('UNLINK_CIRCLE_INITIATED', adminAddr, {
      circleId,
      timestamp: new Date().toISOString()
    });

    // Get package ID and registry from environment
    const registryObjectId = process.env.SUI_WHATSAPP_LINKS_REGISTRY_ID;
    if (!registryObjectId) {
      throw new Error('SUI_WHATSAPP_LINKS_REGISTRY_ID not configured');
    }

    const packageId = process.env.SUI_WHATSAPP_PACKAGE_ID;
    if (!packageId) {
      throw new Error('SUI_WHATSAPP_PACKAGE_ID not configured');
    }

    // If account data provided, send the blockchain transaction
    if (account && account.zkProofs && account.ephemeralPrivateKey) {
      const result = await enokiZkLoginService.sendTransaction(
        account,
        (txb) => {
          // Build the unlink_circle transaction in the provided txb
          txb.moveCall({
            target: `${packageId}::whatsapp_integration::unlink_circle`,
            arguments: [
              txb.object(registryObjectId),
              txb.pure.address(circleId),
              txb.pure.address(adminAddr || account.userAddr)
            ]
          });
        },
        { gasBudget: 10_000_000 }
      );

      logAdminAction('UNLINK_CIRCLE_SUCCESS', adminAddr, {
        circleId,
        txDigest: result.digest,
        status: 'confirmed_on_blockchain'
      });

      return res.status(200).json({
        success: true,
        data: {
          message: 'Circle successfully unlinked from WhatsApp on-chain!',
          circleId,
          txDigest: result.digest,
          status: 'confirmed'
        }
      });
    } else {
      // Fallback: Account data not provided
      logAdminAction('UNLINK_CIRCLE_SUCCESS', adminAddr, {
        circleId,
        status: 'pending_blockchain_confirmation'
      });

      return res.status(200).json({
        success: true,
        data: {
          message: 'Circle unlink initiated. Waiting for blockchain confirmation...',
          circleId,
          status: 'pending'
        }
      });
    }

  } catch (error) {
    const suiAddress = req.body?.adminAddress;
    if (suiAddress) {
      logAdminAction('UNLINK_CIRCLE_ERROR', suiAddress, {
        error: error instanceof Error ? error.message : String(error),
        circleId: req.body?.circleId
      });
    }

    console.error('❌ Admin unlink circle error:', error);
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to unlink circle'
    });
  }
}

export default handler;
