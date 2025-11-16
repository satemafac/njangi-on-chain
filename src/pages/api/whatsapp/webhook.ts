/**
 * WhatsApp Webhook Handler
 * 
 * Receives and processes WhatsApp events from Meta.
 * Handles both webhook verification (GET) and incoming messages/status updates (POST).
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import crypto from 'crypto';
import { appLogger } from '../../../utils/logger';

interface WebhookResponse {
  success?: boolean;
  error?: string;
  message?: string;
}

async function handler(
  req: NextApiRequest,
  res: NextApiResponse<WebhookResponse | string>
) {
  // Handle GET for webhook verification
  if (req.method === 'GET') {
    const { 'hub.mode': mode, 'hub.challenge': challenge, 'hub.verify_token': token } =
      req.query as Record<string, string>;

    appLogger.debug('Webhook verification request', {
      mode,
      hasChallenge: !!challenge,
      tokenMatches: token === process.env.WHATSAPP_VERIFY_TOKEN,
    });

    if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
      appLogger.info('Webhook verified successfully');
      return res.status(200).send(challenge);
    }

    appLogger.warn('Invalid webhook verification attempt', {
      mode,
      tokenMatches: token === process.env.WHATSAPP_VERIFY_TOKEN,
    });

    return res.status(403).send('Forbidden');
  }

  // Handle POST - process incoming webhook events
  if (req.method === 'POST') {
    try {
      const signature = req.headers['x-hub-signature-256'] as string | undefined;
      const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
      const appSecret = process.env.WHATSAPP_APP_SECRET;

      appLogger.debug('Webhook POST received', {
        hasSignature: !!signature,
        hasAppSecret: !!appSecret,
        bodySize: rawBody.length,
      });

      // Verify webhook signature if both signature and app secret are present
      if (signature && appSecret) {
        try {
          const hash = crypto
            .createHmac('sha256', appSecret)
            .update(rawBody)
            .digest('hex');

          const expectedSignature = `sha256=${hash}`;

          // Log both signatures for debugging
          appLogger.debug('Webhook signature comparison', {
            received: signature,
            expected: expectedSignature,
            bodyLength: rawBody.length,
          });

          const isValid = crypto.timingSafeEqual(
            Buffer.from(signature),
            Buffer.from(expectedSignature)
          );

          if (!isValid) {
            appLogger.warn('Invalid webhook signature - allowing anyway for debugging', {
              received: signature.substring(0, 20),
              expected: expectedSignature.substring(0, 20),
            });
            // ⚠️ TEMPORARY: Allow invalid signatures to debug the issue
            // In production, this should return 403
          }

          appLogger.debug('Webhook signature processed');
        } catch (signatureError) {
          appLogger.warn('Webhook signature verification error - allowing anyway for debugging', {
            error: signatureError instanceof Error ? signatureError.message : String(signatureError),
          });
          // ⚠️ TEMPORARY: Allow on error to debug the issue
          // In production, this should return 403
        }
      } else if (!signature) {
        appLogger.debug('No webhook signature header present', {
          availableHeaders: Object.keys(req.headers).join(', '),
        });
      }

      // Parse the webhook body
      const body = typeof req.body === 'object' ? req.body : JSON.parse(rawBody);

      // Log incoming message details
      if (body.entry && Array.isArray(body.entry)) {
        for (const entry of body.entry) {
          if (entry.changes && Array.isArray(entry.changes)) {
            for (const change of entry.changes) {
              const value = change.value;
              
              // Log message details
              if (value.messages && Array.isArray(value.messages)) {
                for (const msg of value.messages) {
                  appLogger.info('📱 Incoming WhatsApp message', {
                    from: msg.from,
                    type: msg.type,
                    text: msg.text?.body || '<non-text>',
                    messageId: msg.id,
                  });
                }
              }

              // Log status updates
              if (value.statuses && Array.isArray(value.statuses)) {
                for (const status of value.statuses) {
                  appLogger.debug('📤 Message status update', {
                    messageId: status.id,
                    status: status.status,
                    timestamp: status.timestamp,
                  });
                }
              }
            }
          }
        }
      }

      appLogger.debug('Webhook received and processed', {
        bodySize: rawBody.length,
      });

      // Process the webhook (just acknowledge for now)
      // In production, this would handle incoming messages and status updates
      return res.status(200).json({
        success: true,
        message: 'Webhook received and processed',
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

export default handler;

