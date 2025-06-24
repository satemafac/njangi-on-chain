import { NextApiRequest, NextApiResponse } from 'next';
import { WhatsAppAuthBridgeService } from '../../../../services/whatsapp-auth-bridge.service';
import { validateWhatsAppConfig } from '../../../../config/whatsapp.config';

const authBridge = WhatsAppAuthBridgeService.getInstance();

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    // Only allow GET requests
    if (req.method !== 'GET') {
      res.setHeader('Allow', ['GET']);
      return res.status(405).json({ error: `Method ${req.method} not allowed` });
    }

    // Validate WhatsApp configuration
    if (!validateWhatsAppConfig()) {
      console.error('WhatsApp configuration is invalid');
      return res.status(500).json({ error: 'WhatsApp configuration error' });
    }

    // Extract phone number parameter
    const { phone } = req.query;

    if (!phone || typeof phone !== 'string') {
      return res.status(400).json({ 
        error: 'Phone number parameter is required' 
      });
    }

    // Validate phone number format
    const phoneRegex = /^\+[1-9]\d{1,14}$/;
    if (!phoneRegex.test(phone)) {
      return res.status(400).json({ 
        error: 'Invalid phone number format. Use international format (+1234567890)' 
      });
    }

    // Get authentication status
    const status = authBridge.getAuthenticationStatus(phone);

    return res.status(200).json({
      success: true,
      phoneNumber: phone,
      ...status,
    });

  } catch (error) {
    console.error('Error in authentication status API:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
} 