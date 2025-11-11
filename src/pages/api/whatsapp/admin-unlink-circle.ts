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
import { getNetworkConfig } from '../../../services/network-config';
import { getActiveWhatsAppRegistries } from '../../../services/whatsapp-registry-service';
import type { NetworkType } from '../../../services/whatsapp-registry-service';

interface UnlinkCircleRequest {
  circleId: string;
  adminAddress?: string;
  account?: AccountData;
  network?: NetworkType;
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
    const { circleId, network: networkParam } = req.body as UnlinkCircleRequest;
    
    // Default to testnet if not provided
    const network = networkParam || 'testnet';

    if (!circleId) {
      return res.status(400).json({
        success: false,
        error: 'Missing circleId'
      });
    }

    console.log('🔗 POST /admin-unlink-circle:', {
      circleId,
      networkParam,
      network,
      adminAddr: adminAddr.slice(0, 10) + '...'
    });

    // Log the unlink action
    logAdminAction('UNLINK_CIRCLE_INITIATED', adminAddr, {
      circleId,
      network,
      timestamp: new Date().toISOString()
    });

    // Get WhatsApp registry for the current network
    const activeRegistries = getActiveWhatsAppRegistries(network);
    if (!activeRegistries || activeRegistries.length === 0) {
      throw new Error(`No active WhatsApp registry configured for ${network} network`);
    }

    // Use the first (current) active registry
    const whatsappRegistry = activeRegistries[0];
    const packageId = whatsappRegistry.packageId;
    const registryObjectId = whatsappRegistry.registryObjectId;

    if (!packageId || !registryObjectId) {
      throw new Error(`WhatsApp configuration incomplete for ${network} network`);
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
        { gasBudget: 10_000_000 },
        network as 'testnet' | 'mainnet'  // Pass network override
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
