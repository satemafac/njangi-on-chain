import { NextApiRequest, NextApiResponse } from 'next';
import { WhatsAppService } from '../../../services/whatsapp.service';
import { validateWhatsAppConfig } from '../../../config/whatsapp.config';

const whatsappService = WhatsAppService.getInstance();

interface SendMessageRequest {
  phoneNumber: string;
  type: 'text' | 'interactive' | 'template';
  content: {
    text?: string;
    buttons?: Array<{ id: string; title: string }>;
    templateName?: string;
    parameters?: Array<{ type: 'text'; text: string }>;
    header?: string;
    footer?: string;
  };
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
    const { phoneNumber, type, content }: SendMessageRequest = req.body;

    if (!phoneNumber || !type || !content) {
      return res.status(400).json({ 
        error: 'Missing required fields: phoneNumber, type, content' 
      });
    }

    // Validate phone number format
    const phoneRegex = /^\+[1-9]\d{1,14}$/;
    if (!phoneRegex.test(phoneNumber)) {
      return res.status(400).json({ 
        error: 'Invalid phone number format. Use international format (+1234567890)' 
      });
    }

    let result;

    switch (type) {
      case 'text':
        if (!content.text) {
          return res.status(400).json({ error: 'Text content is required for text messages' });
        }
        result = await whatsappService.sendTextMessage(phoneNumber, content.text);
        break;

      case 'interactive':
        if (!content.text || !content.buttons) {
          return res.status(400).json({ 
            error: 'Text and buttons are required for interactive messages' 
          });
        }
        result = await whatsappService.sendInteractiveMessage(
          phoneNumber,
          content.text,
          content.buttons,
          content.header,
          content.footer
        );
        break;

      case 'template':
        if (!content.templateName) {
          return res.status(400).json({ 
            error: 'Template name is required for template messages' 
          });
        }
        result = await whatsappService.sendTemplateMessage(
          phoneNumber,
          content.templateName,
          'en', // Default to English
          content.parameters
        );
        break;

      default:
        return res.status(400).json({ 
          error: 'Invalid message type. Supported types: text, interactive, template' 
        });
    }

    if (!result) {
      return res.status(500).json({ error: 'Failed to send message' });
    }

    return res.status(200).json({
      success: true,
      messageId: result.messages[0]?.id,
      data: result,
    });

  } catch (error) {
    console.error('Error in send message API:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// Example usage in the response for documentation
export const exampleRequests = {
  textMessage: {
    phoneNumber: '+1234567890',
    type: 'text',
    content: {
      text: 'Hello from Njangi! Welcome to our savings circle platform.',
    },
  },
  interactiveMessage: {
    phoneNumber: '+1234567890',
    type: 'interactive',
    content: {
      text: 'What would you like to do?',
      header: 'Njangi Options',
      footer: 'Choose an option below',
      buttons: [
        { id: 'create_circle', title: 'Create Circle' },
        { id: 'join_circle', title: 'Join Circle' },
        { id: 'check_status', title: 'Check Status' },
      ],
    },
  },
  templateMessage: {
    phoneNumber: '+1234567890',
    type: 'template',
    content: {
      templateName: 'welcome_message',
      parameters: [
        { type: 'text', text: 'John Doe' },
      ],
    },
  },
}; 