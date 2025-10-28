/**
 * GET /api/messages/track/:linkId
 * Track a link click and redirect to the original URL
 * Query parameters:
 *   - linkId: Link tracking ID
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { appLogger } from '../../../utils/logger';
import { asyncHandler } from '../../../middleware/errorHandler';
import { ValidationError } from '../../../utils/errors';
import { actionLinkManager } from '../../../services/action-link-manager.service';

interface TrackResponse {
  success: boolean;
  message?: string;
  redirectUrl?: string;
  error?: string;
}

const handler = asyncHandler(async (req: NextApiRequest, res: NextApiResponse<TrackResponse>) => {
  // Only allow GET
  if (req.method !== 'GET') {
    return res.status(405).json({
      success: false,
      error: 'Method not allowed. Use GET.',
    });
  }

  try {
    const { linkId } = req.query as Record<string, string>;

    if (!linkId) {
      throw new ValidationError('linkId required');
    }

    appLogger.debug('Tracking link click', { linkId });

    // Validate link exists and is active
    if (!actionLinkManager.isLinkValid(linkId)) {
      appLogger.warn('Invalid or expired link', { linkId });

      return res.status(410).json({
        success: false,
        error: 'Link has expired or reached max clicks',
      });
    }

    // Extract metadata from request
    const userAgent = req.headers['user-agent'] || undefined;
    const referrer = req.headers['referer'] || undefined;

    // Hash IP for privacy (simple approach)
    let ipHash: string | undefined;
    const ip = (req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress;
    if (ip) {
      const crypto = await import('crypto');
      ipHash = crypto.createHash('sha256').update(ip).digest('hex').substring(0, 16);
    }

    // Record click
    const recorded = actionLinkManager.recordClick(linkId, userAgent, referrer, ipHash);

    if (!recorded) {
      appLogger.warn('Failed to record click', { linkId });

      return res.status(410).json({
        success: false,
        error: 'Failed to record click',
      });
    }

    // Get link details
    const link = actionLinkManager.getLink(linkId);

    if (!link) {
      appLogger.error('Link disappeared after validation', { linkId });

      return res.status(500).json({
        success: false,
        error: 'Internal error',
      });
    }

    appLogger.info('Link click recorded', {
      linkId,
      action: link.action,
      circleId: link.circleId,
      clicks: link.clicks,
      maxClicks: link.maxClicks,
    });

    // Redirect to original URL
    res.redirect(302, link.originalUrl);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    appLogger.error('Failed to track link', {
      error: errorMessage,
      query: req.query,
    });

    return res.status(500).json({
      success: false,
      error: errorMessage,
    });
  }
});

export default handler;
