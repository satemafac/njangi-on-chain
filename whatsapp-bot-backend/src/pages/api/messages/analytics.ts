/**
 * GET /api/messages/analytics
 * Retrieve analytics for links and engagement metrics
 * Query parameters:
 *   - type: 'link' | 'circle' | 'event' | 'top' | 'metrics'
 *   - linkId: for 'link' type
 *   - circleId: for 'circle' type
 *   - eventType: for 'event' type
 *   - limit: for 'top' type (default 10)
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { appLogger } from '../../../utils/logger';
import { asyncHandler } from '../../../middleware/errorHandler';
import { ValidationError } from '../../../utils/errors';
import { actionLinkManager } from '../../../services/action-link-manager.service';

interface AnalyticsResponse {
  success: boolean;
  data?: any;
  error?: string;
}

const handler = asyncHandler(async (req: NextApiRequest, res: NextApiResponse<AnalyticsResponse>) => {
  // Only allow GET
  if (req.method !== 'GET') {
    return res.status(405).json({
      success: false,
      error: 'Method not allowed. Use GET.',
    });
  }

  try {
    const { type = 'metrics', linkId, circleId, eventType, limit = '10' } = req.query as Record<
      string,
      string
    >;
    const limitNum = Math.min(parseInt(limit), 100);

    appLogger.debug('Fetching analytics', { type, linkId, circleId, eventType });

    switch (type) {
      // Link-specific analytics
      case 'link': {
        if (!linkId) {
          throw new ValidationError('linkId required for link analytics');
        }

        const link = actionLinkManager.getLink(linkId);
        if (!link) {
          return res.status(404).json({
            success: false,
            error: 'Link not found',
          });
        }

        const analytics = actionLinkManager.getLinkAnalytics(linkId);

        appLogger.info('Link analytics retrieved', { linkId, clicks: analytics?.totalClicks });

        return res.status(200).json({
          success: true,
          data: {
            link,
            analytics,
          },
        });
      }

      // Circle-specific analytics
      case 'circle': {
        if (!circleId) {
          throw new ValidationError('circleId required for circle analytics');
        }

        const stats = actionLinkManager.getCircleStatistics(circleId);
        const links = actionLinkManager.getCircleLinks(circleId);

        appLogger.info('Circle analytics retrieved', {
          circleId,
          totalLinks: stats.totalLinks,
          totalClicks: stats.totalClicks,
        });

        return res.status(200).json({
          success: true,
          data: {
            statistics: stats,
            activeLinks: links,
          },
        });
      }

      // Event type analytics
      case 'event': {
        if (!eventType) {
          throw new ValidationError('eventType required for event analytics');
        }

        const stats = actionLinkManager.getEventTypeStatistics(eventType);

        appLogger.info('Event analytics retrieved', {
          eventType,
          totalLinks: stats.totalLinks,
          ctr: stats.clickThroughRate,
        });

        return res.status(200).json({
          success: true,
          data: stats,
        });
      }

      // Top performers
      case 'top': {
        const topLinks = actionLinkManager.getTopClickedLinks(limitNum);
        const topCircles = actionLinkManager.getTopClickedCircles(limitNum);

        appLogger.info('Top performers retrieved', {
          topLinksCount: topLinks.length,
          topCirclesCount: topCircles.length,
        });

        return res.status(200).json({
          success: true,
          data: {
            topLinks,
            topCircles,
          },
        });
      }

      // Overall metrics
      case 'metrics':
      default: {
        const metrics = actionLinkManager.getMetrics();

        appLogger.info('System metrics retrieved', {
          linksGenerated: metrics.linksGenerated,
          totalClicks: metrics.totalClicks,
        });

        return res.status(200).json({
          success: true,
          data: metrics,
        });
      }
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    appLogger.error('Failed to fetch analytics', {
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
