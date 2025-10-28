/**
 * POST /api/messages/batch-build
 * Build multiple WhatsApp messages in a single request
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { appLogger } from '../../../utils/logger';
import { asyncHandler } from '../../../middleware/errorHandler';
import { ValidationError } from '../../../utils/errors';
import { notificationContextAggregator } from '../../../services/notification-context-aggregator.service';
import { messageRenderer } from '../../../services/message-renderer.service';
import { actionLinkManager } from '../../../services/action-link-manager.service';

interface BatchBuildRequest {
  eventType: string;
  circleIds: string[];
  eventData?: Record<string, any>;
  includeLinks?: boolean;
  timeout?: number;
}

interface BuiltMessage {
  circleId: string;
  success: boolean;
  message?: {
    eventType: string;
    header: string;
    body: string;
    footer?: string;
    ctas: Array<{
      text: string;
      action: string;
      url: string;
      shortUrl: string;
      trackingId: string;
    }>;
    characterCount: number;
    validation: {
      valid: boolean;
      issues: string[];
    };
  };
  error?: string;
  buildTime?: number;
}

interface BatchBuildResponse {
  success: boolean;
  results?: BuiltMessage[];
  summary?: {
    requested: number;
    successful: number;
    failed: number;
    averageBuildTime: number;
    totalTime: number;
  };
  error?: string;
}

const handler = asyncHandler(async (req: NextApiRequest, res: NextApiResponse<BatchBuildResponse>) => {
  // Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).json({
      success: false,
      error: 'Method not allowed. Use POST.',
    });
  }

  const totalStart = Date.now();

  try {
    // Validate request body
    const { eventType, circleIds, eventData, includeLinks = true, timeout = 30000 } =
      req.body as BatchBuildRequest;

    if (!eventType || !circleIds || circleIds.length === 0) {
      throw new ValidationError('Missing required fields: eventType, circleIds');
    }

    if (circleIds.length > 100) {
      throw new ValidationError('Too many circles in batch. Max 100 allowed.');
    }

    appLogger.info('Building batch messages', {
      eventType,
      circleCount: circleIds.length,
      timeout,
    });

    // Build messages in parallel with timeout
    const buildPromises = circleIds.map(async (circleId): Promise<BuiltMessage> => {
      const circleStart = Date.now();

      try {
        // Aggregate context
        const contextResult = await notificationContextAggregator.aggregateNotificationContext(
          eventType,
          circleId,
          eventData
        );

        if (!contextResult.success || !contextResult.data) {
          return {
            circleId,
            success: false,
            error: `Context aggregation failed: ${contextResult.error}`,
            buildTime: Date.now() - circleStart,
          };
        }

        // Get first recipient context
        const recipientContext = contextResult.data.contexts[0];

        if (!recipientContext) {
          return {
            circleId,
            success: false,
            error: 'No recipient context found',
            buildTime: Date.now() - circleStart,
          };
        }

        // Render message
        const renderResult = messageRenderer.renderMessage(
          eventType,
          recipientContext.templateVariables
        );

        if (!renderResult.success || !renderResult.message) {
          return {
            circleId,
            success: false,
            error: `Message rendering failed: ${renderResult.error}`,
            buildTime: Date.now() - circleStart,
          };
        }

        // Generate tracking links
        if (includeLinks && renderResult.message.ctas.length > 0) {
          const trackedCTAs = actionLinkManager.generateCTALinks(
            circleId,
            eventType,
            renderResult.message.ctas.map((cta) => ({
              action: cta.action,
              text: cta.text,
              priority: 'primary' as const,
              trackingEnabled: true,
            })),
            recipientContext.recipient.address
          );

          renderResult.message.ctas = trackedCTAs;
        }

        // Validate
        const validation = messageRenderer.validateRenderedMessage(renderResult.message);

        return {
          circleId,
          success: true,
          message: {
            eventType: renderResult.message.eventType,
            header: renderResult.message.header,
            body: renderResult.message.body,
            footer: renderResult.message.footer,
            ctas: renderResult.message.ctas?.map((cta) => ({
              text: cta.text,
              action: cta.action,
              url: cta.url || '#',
              shortUrl: cta.url || '#',
              trackingId: `${circleId}-${Date.now()}`,
            })) || [],
            characterCount: renderResult.message.characterCount,
            validation,
          },
          buildTime: Date.now() - circleStart,
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          circleId,
          success: false,
          error: errorMessage,
          buildTime: Date.now() - circleStart,
        };
      }
    });

    // Race with timeout
    const results = await Promise.allSettled(buildPromises);

    const builtMessages: BuiltMessage[] = results.map((result, index) => {
      if (result.status === 'fulfilled') {
        return result.value;
      } else {
        return {
          circleId: circleIds[index],
          success: false,
          error: `Promise rejected: ${result.reason?.message || String(result.reason)}`,
        };
      }
    });

    const successful = builtMessages.filter((m) => m.success).length;
    const failed = builtMessages.filter((m) => !m.success).length;
    const totalTime = Date.now() - totalStart;
    const avgTime =
      builtMessages.reduce((sum, m) => sum + (m.buildTime || 0), 0) / builtMessages.length;

    appLogger.info('Batch messages built', {
      eventType,
      requested: circleIds.length,
      successful,
      failed,
      averageTime: Math.round(avgTime),
      totalTime,
    });

    return res.status(200).json({
      success: failed === 0,
      results: builtMessages,
      summary: {
        requested: circleIds.length,
        successful,
        failed,
        averageBuildTime: Math.round(avgTime),
        totalTime,
      },
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    appLogger.error('Failed to build batch messages', {
      error: errorMessage,
    });

    return res.status(500).json({
      success: false,
      error: errorMessage,
    });
  }
});

export default handler;
