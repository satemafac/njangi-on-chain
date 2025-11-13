/**
 * POST/GET /api/whatsapp/webhook
 * WhatsApp Cloud API Webhook Handler
 * 
 * GET: Verify webhook (called by WhatsApp during setup)
 * POST: Receive delivery status updates and incoming messages
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import crypto from 'crypto';
import { appLogger } from '../../../utils/logger';
import { asyncHandler } from '../../../middleware/errorHandler';
import { getConfig } from '../../../config';

interface WebhookMessage {
  object: string;
  entry: Array<{
    id: string;
    changes: Array<{
      value: {
        messaging_product: string;
        metadata: {
          display_phone_number: string;
          phone_number_id: string;
        };
        statuses?: Array<{
          id: string;
          status: 'sent' | 'delivered' | 'read' | 'failed';
          timestamp: string;
          recipient_id?: string;
          errors?: Array<{
            code: number;
            title: string;
            message: string;
            error_data: {
              messaging_product: string;
              details: string;
            };
          }>;
        }>;
        messages?: Array<{
          from: string;
          id: string;
          timestamp: string;
          text?: { body: string };
          type: 'text' | 'image' | 'document' | 'audio' | 'video' | 'button' | 'interactive';
        }>;
      };
      field: string;
    }>;
  }>;
}

/**
 * Verify webhook signature for security
 */
function verifyWebhookSignature(
  body: string,
  signature: string | string[] | undefined
): boolean {
  if (!signature || Array.isArray(signature)) {
    appLogger.warn('Invalid signature header');
    return false;
  }

  const hash = crypto
    .createHmac('sha256', getConfig().whatsapp.appSecret)
    .update(body)
    .digest('hex');

  const expectedSignature = `sha256=${hash}`;

  const isValid = crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature)
  );

  return isValid;
}

/**
 * Handle delivery status updates
 */
function handleStatusUpdate(
  status: 'sent' | 'delivered' | 'read' | 'failed',
  messageId: string,
  recipientId: string | undefined,
  errors?: Array<{ code: number; message: string }>
): void {
  appLogger.info('Message status update', {
    messageId,
    status,
    recipientId,
    errors: errors?.map((e) => `${e.code}: ${e.message}`),
  });

  // TODO: Update message status in database or cache
  // For now, just log the status
  switch (status) {
    case 'sent':
      appLogger.debug('Message sent to WhatsApp servers', { messageId });
      break;
    case 'delivered':
      appLogger.debug('Message delivered to recipient', { messageId });
      break;
    case 'read':
      appLogger.debug('Message read by recipient', { messageId });
      break;
    case 'failed':
      appLogger.error('Message delivery failed', { messageId, errors });
      break;
  }
}

/**
 * Handle incoming messages
 */
function handleIncomingMessage(
  from: string,
  messageId: string,
  timestamp: string,
  message: { body: string } | undefined
): void {
  appLogger.info('Incoming WhatsApp message', {
    from,
    messageId,
    timestamp,
    hasText: !!message?.body,
  });

  if (message?.body) {
    const content = message.body.trim().toLowerCase();
    
    appLogger.info('Message content', {
      from,
      content: message.body.substring(0, 100),
    });

    // Handle confirmation replies to circle_linked template
    if (content.includes('confirm') || content.includes('ok') || content === 'yes') {
      appLogger.info('User confirmed circle link', {
        from,
        messageId,
        timestamp,
      });

      // TODO: Store confirmation in database
      // This opens a 24-hour window for sending free-form messages
      // Can be used to:
      // 1. Send welcome message with instructions
      // 2. Send circle member list
      // 3. Send current cycle status
      // 4. Enable receiving user commands (help, status, etc.)
    }

    // Handle help requests
    if (content.includes('help') || content === '?') {
      appLogger.info('User requested help', {
        from,
        messageId,
      });

      // TODO: Send help message
      // Send instructions on available commands once confirmation is received
    }

    // Log any other messages for debugging
    appLogger.debug('Processing incoming message', {
      from,
      content,
      messageId,
    });
  }
}

/**
 * Main webhook handler
 */
export default asyncHandler(
  async (req: NextApiRequest, res: NextApiResponse) => {
    // Handle GET for webhook verification
    if (req.method === 'GET') {
      const { 'hub.mode': mode, 'hub.challenge': challenge, 'hub.verify_token': token } =
        req.query as Record<string, string>;

      appLogger.debug('Webhook verification request', {
        mode,
        hasChallenge: !!challenge,
        tokenMatches: token === getConfig().whatsapp.verifyToken,
      });

      if (mode === 'subscribe' && token === getConfig().whatsapp.verifyToken) {
        appLogger.info('Webhook verified successfully');
        return res.status(200).send(challenge);
      }

      appLogger.warn('Invalid webhook verification attempt', {
        mode,
        tokenMatches: token === getConfig().whatsapp.verifyToken,
      });

      return res.status(403).send('Forbidden');
    }

    // Handle POST for webhook events
    if (req.method === 'POST') {
      const signature = req.headers['x-hub-signature-256'] as string | undefined;
      const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);

      // Verify webhook signature
      if (!verifyWebhookSignature(rawBody, signature)) {
        appLogger.warn('Invalid webhook signature', {
          hasSignature: !!signature,
        });

        return res.status(403).json({
          success: false,
          error: 'Invalid signature',
        });
      }

      try {
        const webhook = req.body as WebhookMessage;

        appLogger.debug('Webhook payload received', {
          object: webhook.object,
          entryCount: webhook.entry?.length,
        });

        // Process each entry
        webhook.entry?.forEach((entry) => {
          entry.changes?.forEach((change) => {
            const value = change.value;

            // Handle status updates
            if (value.statuses) {
              appLogger.debug('Processing status updates', {
                count: value.statuses.length,
              });

              value.statuses.forEach((status) => {
                handleStatusUpdate(
                  status.status,
                  status.id,
                  status.recipient_id,
                  status.errors
                );
              });
            }

            // Handle incoming messages
            if (value.messages) {
              appLogger.debug('Processing incoming messages', {
                count: value.messages.length,
              });

              value.messages.forEach((message) => {
                handleIncomingMessage(
                  message.from,
                  message.id,
                  message.timestamp,
                  message.text
                );
              });
            }
          });
        });

        appLogger.info('Webhook processed successfully');

        return res.status(200).json({
          success: true,
          message: 'Webhook received',
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);

        appLogger.error('Error processing webhook', {
          error: errorMessage,
        });

        return res.status(500).json({
          success: false,
          error: errorMessage,
        });
      }
    }

    // Method not allowed
    return res.status(405).json({
      success: false,
      error: 'Method not allowed',
    });
  }
);
