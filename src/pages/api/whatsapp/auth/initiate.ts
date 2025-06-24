import { NextApiRequest, NextApiResponse } from 'next';
import { WhatsAppAuthBridgeService } from '../../../../services/whatsapp-auth-bridge.service';
import { OAuthProvider } from '../../../../services/zkLoginService';
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

    // Extract parameters
    const { phone, provider = 'Google' } = req.query;

    if (!phone || typeof phone !== 'string') {
      return res.status(400).json({ 
        error: 'Phone number is required' 
      });
    }

    // Validate phone number format
    const phoneRegex = /^\+[1-9]\d{1,14}$/;
    if (!phoneRegex.test(phone)) {
      return res.status(400).json({ 
        error: 'Invalid phone number format. Use international format (+1234567890)' 
      });
    }

    // Validate provider
    const validProviders: OAuthProvider[] = ['Google', 'Facebook', 'Apple'];
    const selectedProvider = validProviders.includes(provider as OAuthProvider) 
      ? (provider as OAuthProvider) 
      : 'Google';

    // Initiate authentication
    const result = await authBridge.initiateAuthentication(phone, selectedProvider);

    if (!result.success) {
      return res.status(500).json({ 
        error: result.error || 'Failed to initiate authentication' 
      });
    }

    // Redirect to auth URL
    if (result.authUrl) {
      return res.redirect(302, result.authUrl);
    }

    // If already authenticated, return success
    return res.status(200).json({
      success: true,
      message: 'Already authenticated',
      suiAddress: result.suiAddress,
    });

  } catch (error) {
    console.error('Error in initiate authentication API:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
} 