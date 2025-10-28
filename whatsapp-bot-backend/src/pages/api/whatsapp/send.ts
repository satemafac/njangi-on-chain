/**
 * POST /api/whatsapp/send
 * Send a WhatsApp message using the WhatsApp Cloud API
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { appLogger } from '../../../utils/logger';
import { asyncHandler } from '../../../middleware/errorHandler';
import { ValidationError } from '../../../utils/errors';
import { whatsappSender, SendMessageRequest, SendResult } from '../../../services/whatsapp-sender.service';

interface SendWhatsAppRequest {
  to: string;
  eventType: string;
  circleId?: string;
  messageType?: 'template' | 'text';
  content?: string;
  useRetry?: boolean;
  maxRetries?: number;
}

interface SendWhatsAppResponse {
  success: boolean;
  result?: SendResult;
  error?: string;
  metrics?: {
    duration: number;
  };
}

const handler = asyncHandler(async (req: NextApiRequest, res: NextApiResponse<SendWhatsAppResponse>) => {
  // Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).json({
      success: false,
      error: 'Method not allowed. Use POST.',
    });
  }

  const startTime = Date.now();

  try {
    // Parse request body
    const { to, eventType, circleId, messageType = 'text', content, useRetry = true, maxRetries = 3 } =
      req.body as SendWhatsAppRequest;

    // Validate required fields
    if (!to) {
      throw new ValidationError('Recipient phone number (to) is required');
    }

    if (!eventType && !content) {
      throw new ValidationError('Either eventType or content is required');
    }

    appLogger.info('Sending WhatsApp message', {
      to,
      eventType,
      circleId,
      messageType,
      useRetry,
    });

    // Build the message request
    let sendRequest: SendMessageRequest;

    if (messageType === 'template' && eventType && circleId) {
      // Template-based message (from notification context)
      // This would typically come from Task 6's message builder API
      // For now, we'll use a simplified template format
      sendRequest = {
        to,
        type: 'template',
        template: {
          name: `njangi_${eventType.toLowerCase()}`,
          language: { code: 'en' },
        },
      };
    } else if (content) {
      // Text message with provided content
      sendRequest = {
        to,
        type: 'text',
        text: content,
      };
    } else {
      throw new ValidationError('Invalid message configuration');
    }

    // Send message (with or without retry)
    let result: SendResult;

    if (useRetry) {
      result = await whatsappSender.sendWithRetry(sendRequest, maxRetries);
    } else {
      result = await whatsappSender.sendMessage(sendRequest);
    }

    const duration = Date.now() - startTime;

    if (result.success) {
      appLogger.info('WhatsApp message sent successfully', {
        messageId: result.messageId,
        to,
        duration,
      });

      return res.status(200).json({
        success: true,
        result,
        metrics: { duration },
      });
    } else {
      appLogger.warn('WhatsApp message send failed', {
        to,
        error: result.error,
        duration,
      });

      return res.status(202).json({
        success: false,
        result,
        error: result.error,
        metrics: { duration },
      });
    }
  } catch (error) {
    const duration = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);

    appLogger.error('Failed to send WhatsApp message', {
      error: errorMessage,
      duration,
    });

    return res.status(500).json({
      success: false,
      error: errorMessage,
      metrics: { duration },
    });
  }
});

export default handler;
