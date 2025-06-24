import { NextApiRequest, NextApiResponse } from 'next';
import { WhatsAppService } from '../../../services/whatsapp.service';
import { WhatsAppWebhookPayload } from '../../../types/whatsapp';
import { whatsappConfig, validateWhatsAppConfig } from '../../../config/whatsapp.config';

const whatsappService = WhatsAppService.getInstance();

// Helper function to read raw body
function getRawBody(req: NextApiRequest): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
    });
    req.on('end', () => {
      resolve(data);
    });
    req.on('error', err => {
      reject(err);
    });
  });
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    // Validate WhatsApp configuration
    if (!validateWhatsAppConfig()) {
      console.error('WhatsApp configuration is invalid');
      return res.status(500).json({ error: 'WhatsApp configuration error' });
    }

    if (req.method === 'GET') {
      // Handle webhook verification
      return handleWebhookVerification(req, res);
    } else if (req.method === 'POST') {
      // Handle incoming webhook messages
      return await handleWebhookMessage(req, res);
    } else {
      res.setHeader('Allow', ['GET', 'POST']);
      return res.status(405).json({ error: `Method ${req.method} not allowed` });
    }
  } catch (error) {
    console.error('Webhook handler error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * Handle webhook verification (GET request)
 * This is required by WhatsApp to verify the webhook URL
 */
function handleWebhookVerification(req: NextApiRequest, res: NextApiResponse) {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  // Check if mode and token are correct
  if (mode === 'subscribe' && token === whatsappConfig.verifyToken) {
    console.log('Webhook verified successfully');
    return res.status(200).send(challenge);
  } else {
    console.error('Webhook verification failed');
    return res.status(403).json({ error: 'Forbidden' });
  }
}

/**
 * Handle incoming webhook messages (POST request)
 */
async function handleWebhookMessage(req: NextApiRequest, res: NextApiResponse) {
  try {
    // Get the raw body for signature verification
    const rawBody = await getRawBody(req);
    const signature = req.headers['x-hub-signature-256'] as string;

    // Verify webhook signature for security
    if (!signature || !whatsappService.verifyWebhookSignature(rawBody, signature)) {
      console.error('Invalid webhook signature');
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Parse the JSON payload
    const payload: WhatsAppWebhookPayload = JSON.parse(rawBody);

    // Validate payload structure
    if (!payload.object || payload.object !== 'whatsapp_business_account') {
      console.error('Invalid webhook payload object');
      return res.status(400).json({ error: 'Invalid payload' });
    }

    if (!payload.entry || !Array.isArray(payload.entry)) {
      console.error('Invalid webhook payload entry');
      return res.status(400).json({ error: 'Invalid payload entry' });
    }

    // Process the webhook message
    await whatsappService.handleWebhookMessage(payload);

    // Return success response
    return res.status(200).json({ success: true });

  } catch (error) {
    console.error('Error processing webhook message:', error);
    return res.status(500).json({ error: 'Failed to process message' });
  }
}

/**
 * Configuration for Next.js API route
 * Disable body parser to get raw body for signature verification
 */
export const config = {
  api: {
    bodyParser: false,
  },
} 