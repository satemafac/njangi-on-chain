/**
 * 🔗 Admin Unlink Circle Endpoint
 *
 * Endpoint for admin to unlink circles from WhatsApp
 * Uses zkLogin credentials to sign the blockchain transaction
 *
 * Auth: requires the `session-id` cookie from /api/zkLogin to resolve to
 * the circle's on-chain admin (withCircleAdminAuth) — authorization runs
 * before the chain call and the Postgres deindex side effect, and the
 * handler operates on the middleware-verified `req.admin.circleId` /
 * `req.admin.network` so a diverging query string can never retarget the
 * unlink at a different circle.
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
import {
  logAdminAction,
  withCircleAdminAuth,
  type AuthenticatedRequest,
} from '../../../middleware/admin-auth.middleware';
import { enokiZkLoginService } from '../../../services/enokiZkLoginService';
import { AccountData } from '../../../services/zkLoginService';
import { getActiveWhatsAppRegistries } from '../../../services/whatsapp-registry-service';
import type { NetworkType } from '../../../services/whatsapp-registry-service';
import { deindexWhatsAppLinksForCircle } from '../../../lib/whatsapp-link-index';

interface UnlinkCircleRequest {
  circleId: string; // consumed by withCircleAdminAuth, not the handler
  adminAddress?: string; // must match the session (middleware-enforced)
  account?: AccountData;
  network?: NetworkType; // consumed by withCircleAdminAuth, not the handler
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({
      success: false,
      error: 'Method not allowed'
    });
  }

  // Authorization (session → on-chain admin) runs before the handler so no
  // chain call or index deletion can happen for an unverified caller.
  return withCircleAdminAuth(handlePost)(req, res);
}

async function handlePost(req: AuthenticatedRequest, res: NextApiResponse) {
  try {
    // Verified by withCircleAdminAuth: session address === on-chain admin.
    // Operate on the circle/network the authorization actually ran against —
    // never re-read them from the raw body, which could diverge from the
    // query string the middleware resolved.
    const adminAddr = req.admin!.suiAddress;
    const circleId = req.admin!.circleId;
    const network = req.admin!.network;
    const { account } = (req.body ?? {}) as UnlinkCircleRequest;

    console.log('🔗 POST /admin-unlink-circle:', {
      circleId,
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

      // Phase 2: drop the off-chain Postgres index entries so the webhook
      // stops routing inbound messages to the unlinked circle. Failures are
      // logged but non-fatal — on-chain state already reflects the unlink.
      try {
        await deindexWhatsAppLinksForCircle(circleId);
      } catch (indexError) {
        console.warn('[admin-unlink-circle] Failed to deindex WhatsApp link', indexError);
      }

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
    const suiAddress = req.admin?.suiAddress;
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
