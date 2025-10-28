/**
 * POST /api/messages/build
 * Build a single WhatsApp message with rendered template and tracking links
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { appLogger } from '../../../utils/logger';
import { asyncHandler } from '../../../middleware/errorHandler';
import { ValidationError, SuiError } from '../../../utils/errors';
import { notificationContextAggregator } from '../../../services/notification-context-aggregator.service';
import { messageRenderer } from '../../../services/message-renderer.service';
import { actionLinkManager } from '../../../services/action-link-manager.service';

interface BuildMessageRequest {
  eventType: string;
  circleId: string;
  recipientAddress?: string;
  eventData?: Record<string, any>;
  includeLinks?: boolean;
}

interface BuildMessageResponse {
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
  metrics?: {
    aggregationTime: number;
    renderTime: number;
    totalTime: number;
  };
}

const handler = asyncHandler(async (req: NextApiRequest, res: NextApiResponse<BuildMessageResponse>) => {
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
    const { eventType, circleId, recipientAddress, eventData, includeLinks = true } =
      req.body as BuildMessageRequest;

    if (!eventType || !circleId) {
      throw new ValidationError('Missing required fields: eventType, circleId');
    }

    appLogger.info('Building message', {
      eventType,
      circleId,
      recipientAddress,
    });

    // Step 1: Aggregate notification context
    const aggregationStart = Date.now();
    const contextResult = await notificationContextAggregator.aggregateNotificationContext(
      eventType,
      circleId,
      eventData
    );

    if (!contextResult.success || !contextResult.data) {
      throw new SuiError(`Failed to aggregate context: ${contextResult.error}`);
    }

    const aggregationTime = Date.now() - aggregationStart;

    // Get first recipient's context (or specific if provided)
    let recipientContext = contextResult.data.contexts[0];

    if (recipientAddress && contextResult.data.contexts.length > 1) {
      const found = contextResult.data.contexts.find(
        (c) => c.recipient.address === recipientAddress
      );
      if (found) {
        recipientContext = found;
      }
    }

    if (!recipientContext) {
      throw new ValidationError('No recipient context found');
    }

    // Step 2: Render message
    const renderStart = Date.now();
    const renderResult = messageRenderer.renderMessage(
      eventType,
      recipientContext.templateVariables
    );

    if (!renderResult.success || !renderResult.message) {
      throw new ValidationError(`Failed to render message: ${renderResult.error}`);
    }

    const renderTime = Date.now() - renderStart;

    // Step 3: Generate tracking links if requested
    let ctas = renderResult.message.ctas;

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

      ctas = trackedCTAs;
    }

    // Step 4: Validate rendered message
    const validation = messageRenderer.validateRenderedMessage(renderResult.message);

    const totalTime = Date.now() - totalStart;

    appLogger.info('Message built successfully', {
      eventType,
      circleId,
      characterCount: renderResult.message.characterCount,
      ctaCount: ctas.length,
      valid: validation.valid,
      totalTime,
    });

    return res.status(200).json({
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
      metrics: {
        aggregationTime,
        renderTime,
        totalTime,
      },
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    appLogger.error('Failed to build message', {
      error: errorMessage,
      body: req.body,
    });

    return res.status(500).json({
      success: false,
      error: errorMessage,
    });
  }
});

export default handler;
