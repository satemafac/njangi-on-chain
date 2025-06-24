import { NextApiRequest, NextApiResponse } from 'next';
import { WhatsAppAuthBridgeService } from '../../../../services/whatsapp-auth-bridge.service';
import { validateWhatsAppConfig } from '../../../../config/whatsapp.config';

const authBridge = WhatsAppAuthBridgeService.getInstance();

interface CompleteAuthRequest {
  token: string;
  phone: string;
  jwt: string;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    // Only allow POST requests
    if (req.method !== 'POST') {
      res.setHeader('Allow', ['POST']);
      return res.status(405).json({ error: `Method ${req.method} not allowed` });
    }

    // Validate WhatsApp configuration
    if (!validateWhatsAppConfig()) {
      console.error('WhatsApp configuration is invalid');
      return res.status(500).json({ error: 'WhatsApp configuration error' });
    }

    // Parse and validate request body
    const { token, phone, jwt }: CompleteAuthRequest = req.body;

    if (!token || !phone || !jwt) {
      return res.status(400).json({ 
        error: 'Missing required fields: token, phone, jwt' 
      });
    }

    // Validate phone number format
    const phoneRegex = /^\+[1-9]\d{1,14}$/;
    if (!phoneRegex.test(phone)) {
      return res.status(400).json({ 
        error: 'Invalid phone number format. Use international format (+1234567890)' 
      });
    }

    // Verify auth token
    if (!authBridge.verifyAuthToken(token, phone)) {
      return res.status(401).json({ 
        error: 'Invalid or expired authentication token' 
      });
    }

    // Complete authentication
    const result = await authBridge.completeAuthentication(token, phone, jwt);

    if (!result.success) {
      return res.status(400).json({ 
        error: result.error || 'Authentication completion failed' 
      });
    }

    // Return success response
    return res.status(200).json({
      success: true,
      message: 'Authentication completed successfully',
      suiAddress: result.suiAddress,
      account: {
        userAddr: result.account?.userAddr,
        provider: result.account?.provider,
        picture: result.account?.picture,
        name: result.account?.name,
      },
    });

  } catch (error) {
    console.error('Error in complete authentication API:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
} 