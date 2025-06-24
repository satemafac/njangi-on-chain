import { NextApiRequest, NextApiResponse } from 'next';
import { WhatsAppService } from '../../../../services/whatsapp.service';
import { WhatsAppAuthBridgeService } from '../../../../services/whatsapp-auth-bridge.service';
import { validateWhatsAppConfig } from '../../../../config/whatsapp.config';

const whatsAppService = WhatsAppService.getInstance();
const authBridge = WhatsAppAuthBridgeService.getInstance();

interface NotifyRequest {
  token: string;
  phone: string;
  success: boolean;
  message: string;
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
    const { token, phone, success, message }: NotifyRequest = req.body;

    if (!token || !phone || typeof success !== 'boolean' || !message) {
      return res.status(400).json({ 
        error: 'Missing required fields: token, phone, success, message' 
      });
    }

    // Validate phone number format
    const phoneRegex = /^\+[1-9]\d{1,14}$/;
    if (!phoneRegex.test(phone)) {
      return res.status(400).json({ 
        error: 'Invalid phone number format. Use international format (+1234567890)' 
      });
    }

    // Verify that the auth token is valid (but don't require it to be unused)
    const tokenExists = authBridge.verifyAuthToken(token, phone) || 
                       authBridge.getSuiAddressForPhone(phone); // Check if already authenticated

    if (!tokenExists) {
      return res.status(401).json({ 
        error: 'Invalid authentication token or phone number' 
      });
    }

    // Send success or failure message to WhatsApp
    if (success) {
      const userAddress = authBridge.getSuiAddressForPhone(phone);
      const successMessage = `🎉 **Authentication Successful!**

✅ Your phone number is now linked to your Sui blockchain address!

📱 Phone: ${phone}
🏦 Sui Address: ${userAddress}

You can now use all Njangi commands:
• /circles - View your circles
• /balance - Check balances  
• /create - Start a new circle
• /status - View your account status

Welcome to Njangi! 🚀`;

      await whatsAppService.sendTextMessage(phone, successMessage);
    } else {
      const errorMessage = `❌ **Authentication Failed**

${message}

Please try again by typing /auth

If you continue to have issues, please contact support.`;

      await whatsAppService.sendTextMessage(phone, errorMessage);
    }

    return res.status(200).json({
      success: true,
      message: 'Notification sent to WhatsApp successfully',
    });

  } catch (error) {
    console.error('Error in auth notification API:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}