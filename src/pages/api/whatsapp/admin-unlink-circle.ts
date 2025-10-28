/**
 * 🔗 Admin Unlink Circle Endpoint
 * 
 * Protected endpoint for admin to unlink circles from WhatsApp
 * 
 * Example usage:
 * POST /api/whatsapp/admin-unlink-circle
 * Authorization: Bearer <token>
 * {
 *   "circleId": "0x123..."
 * }
 */

import { NextApiResponse } from 'next';
import {
  AuthenticatedRequest,
  withAdminAuth,
  logAdminAction
} from '../../../middleware/admin-auth.middleware';

async function handler(req: AuthenticatedRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({
      success: false,
      error: 'Method not allowed'
    });
  }

  try {
    const { circleId } = req.body;

    if (!circleId) {
      return res.status(400).json({
        success: false,
        error: 'Missing circleId'
      });
    }

    if (!req.admin) {
      return res.status(401).json({
        success: false,
        error: 'Admin authentication required'
      });
    }

    // Log the unlink action
    logAdminAction('UNLINK_CIRCLE', req.admin.suiAddress, {
      circleId,
      timestamp: new Date().toISOString()
    });

    // In production, you would:
    // 1. Call Move contract to unlink the circle
    // 2. Verify admin ownership of circle on-chain
    // 3. Log the event on blockchain

    return res.status(200).json({
      success: true,
      data: {
        message: 'Circle unlinked from WhatsApp successfully',
        circleId
      }
    });
  } catch (error) {
    console.error('❌ Admin unlink circle error:', error);
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Internal server error'
    });
  }
}

export default withAdminAuth({
  requiredPermission: 'unlink_circle',
  circleIdParam: 'circleId',
  logging: true
})(handler);
