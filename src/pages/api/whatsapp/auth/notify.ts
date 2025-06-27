import { NextApiRequest, NextApiResponse } from 'next';
import { WhatsAppService } from '../../../../services/whatsapp.service';
import { validateWhatsAppConfig } from '../../../../config/whatsapp.config';

interface NotifyAuthRequest {
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
    const { token, phone, success, message }: NotifyAuthRequest = req.body;

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

    // Get WhatsApp service instance
    const whatsAppService = WhatsAppService.getInstance();

    // Send notification message to user
    let notificationMessage: string;
    
    if (success) {
      notificationMessage = `✅ **Authentication Successful!**\n\n${message}\n\n🎉 You can now use all Njangi commands:\n• /create - Create a new savings circle\n• /join [circle-id] - Join an existing circle\n• /status - Check your account status\n• /circles - View your circles\n• /balance - Check your balances\n• /help - See all commands\n\nType any command to get started!`;
      
      // Update user session to mark as authenticated
      whatsAppService.updateSession(phone, {
        isAuthenticated: true,
        authenticatedAt: new Date(),
        tempAuthToken: undefined, // Clear temp token
      });
    } else {
      notificationMessage = `❌ **Authentication Failed**\n\n${message}\n\n🔄 To try again, type:\n/auth\n\nIf you continue having issues, please contact support.`;
    }

    // Send the notification via WhatsApp
    const sendResult = await whatsAppService.sendTextMessage(phone, notificationMessage);

    if (!sendResult) {
      console.error(`Failed to send WhatsApp notification to ${phone}`);
      return res.status(500).json({ 
        error: 'Failed to send WhatsApp notification' 
      });
    }

    console.log(`WhatsApp auth notification sent to ${phone}: ${success ? 'SUCCESS' : 'FAILURE'}`);

    return res.status(200).json({
      success: true,
      message: 'Notification sent successfully',
      messageSent: true,
    });

  } catch (error) {
    console.error('Error in WhatsApp auth notification API:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}