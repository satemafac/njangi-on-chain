/**
 * Webhook Proxy for WhatsApp Events
 * 
 * This is a proxy endpoint that receives WhatsApp webhook events from Meta
 * and forwards them to the bot backend service for processing.
 * 
 * Flow: Meta → Frontend Webhook (this endpoint) → Bot Backend Webhook
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { appLogger } from '../../../utils/logger';

interface WebhookResponse {
  success?: boolean;
  error?: string;
  message?: string;
}

async function handler(
  req: NextApiRequest,
  res: NextApiResponse<WebhookResponse>
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

  // Handle POST - forward to bot backend
  if (req.method === 'POST') {
    try {
      const botBackendUrl = process.env.BOT_BACKEND_URL || 'https://njangi-on-chain.herokuapp.com';
      
      appLogger.debug('Forwarding webhook to bot backend', {
        botBackendUrl,
        bodySize: JSON.stringify(req.body).length,
      });

      // Forward the webhook request to the bot backend
      const response = await fetch(`${botBackendUrl}/api/whatsapp/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-hub-signature-256': (req.headers['x-hub-signature-256'] as string) || '',
        },
        body: JSON.stringify(req.body),
      });

      const responseData = await response.json();

      appLogger.info('Webhook forwarded to bot backend', {
        status: response.status,
        success: responseData.success,
      });

      // Forward the response from bot backend
      return res.status(response.status).json(responseData);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      appLogger.error('Error forwarding webhook to bot backend', {
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

