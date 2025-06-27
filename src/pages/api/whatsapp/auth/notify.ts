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
    console.log('📨 WhatsApp Auth Notify API called:', req.method);
    console.log('📝 Request body:', JSON.stringify(req.body, null, 2));
    
    // Debug WhatsApp configuration
    const hasAccessToken = !!process.env.WHATSAPP_ACCESS_TOKEN;
    const hasPhoneNumberId = !!process.env.WHATSAPP_PHONE_NUMBER_ID;
    console.log('🔧 WhatsApp Config:', { 
      hasAccessToken, 
      hasPhoneNumberId,
      phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID ? `${process.env.WHATSAPP_PHONE_NUMBER_ID.substring(0, 8)}...` : 'missing'
    });

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

    // For the simplified flow, we accept a simple token since auth happens through standard zkLogin
    // Just verify the token is not empty
    if (!token || token.length < 5) { // Basic sanity check
      return res.status(401).json({ 
        error: 'Invalid authentication token format' 
      });
    }

    // Send success or failure message to WhatsApp
    let messageResult;
    
    if (success) {
      // Register direct mapping from frontend authentication
      // Note: In a real implementation, you'd want to validate the account data
      // For now, we're trusting the frontend authentication since it went through zkLogin
      console.log(`Registering successful authentication for phone: ${phone}`);

      // Try to get the user address from auth bridge, but don't fail if not found
      const userAddress = authBridge.getSuiAddressForPhone(phone);
      
      let successMessage = `🎉 **Authentication Successful!**

✅ Your account has been authenticated successfully!

📱 Phone: ${phone}`;

      if (userAddress) {
        successMessage += `
🏦 Sui Address: ${userAddress}`;
      }

      successMessage += `

You can now use all Njangi commands:
• /circles - View your circles
• /balance - Check balances  
• /create - Start a new circle
• /status - View your account status

Welcome to Njangi! 🚀`;

      messageResult = await whatsAppService.sendTextMessage(phone, successMessage);
    } else {
      const errorMessage = `❌ **Authentication Failed**

${message}

Please try again by typing /auth

If you continue to have issues, please contact support.`;

      messageResult = await whatsAppService.sendTextMessage(phone, errorMessage);
    }

    // Check if the WhatsApp message was actually sent
    if (!messageResult) {
      console.error(`❌ Failed to send WhatsApp notification to ${phone}. This could be due to:`);
      console.error('  - Invalid or expired WhatsApp access token');
      console.error('  - Phone number not opted in to receive messages');
      console.error('  - WhatsApp Business API rate limits');
      console.error('  - Network connectivity issues');
      console.error('  - Invalid phone number format or permissions');
      
      return res.status(500).json({ 
        error: 'Failed to send WhatsApp notification. Please check server logs for details.',
        success: false,
        details: 'WhatsApp service returned null - message was not delivered'
      });
    }

    const messageId = messageResult.messages?.[0]?.id;
    console.log(`✅ Successfully sent WhatsApp notification to ${phone}`);
    if (messageId) {
      console.log(`📱 WhatsApp Message ID: ${messageId}`);
    }
    
    return res.status(200).json({
      success: true,
      message: 'Notification sent to WhatsApp successfully',
      messageId: messageId
    });

  } catch (error) {
    console.error('Error in auth notification API:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}