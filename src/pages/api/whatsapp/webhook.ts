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

      // Verify webhook signature
      if (signature && process.env.WHATSAPP_APP_SECRET) {
        const hash = crypto
          .createHmac('sha256', process.env.WHATSAPP_APP_SECRET)
          .update(rawBody)
          .digest('hex');

        const expectedSignature = `sha256=${hash}`;

        try {
          const isValid = crypto.timingSafeEqual(
            Buffer.from(signature),
            Buffer.from(expectedSignature)
          );

          if (!isValid) {
            appLogger.warn('Invalid webhook signature');
            return res.status(403).json({
              success: false,
              error: 'Invalid signature',
            });
          }
        } catch {
          appLogger.warn('Webhook signature verification failed');
          return res.status(403).json({
            success: false,
            error: 'Signature verification failed',
          });
        }
      }

      appLogger.info('Webhook received', {
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

