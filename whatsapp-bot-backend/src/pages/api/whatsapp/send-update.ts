import { NextApiRequest, NextApiResponse } from 'next';
import { whatsappSender } from '../../../services/whatsapp-sender.service';
import { appLogger } from '../../../utils/logger';

// ============================================================================
// SEND UPDATE ENDPOINT
// ============================================================================

interface SendUpdateRequest {
  phoneNumber: string;
  circleId: string;
  eventType: 'cycle_started' | 'contribution' | 'deadline' | 'payout' | 'member_joined' | 'custom';
  data?: Record<string, any>;
  customMessage?: string;
}

interface SendUpdateResponse {
  success: boolean;
  messageId?: string;
  message?: string;
  error?: string;
}

/**
 * Build message for different event types
 */
function buildEventMessage(
  eventType: string,
  circleId: string,
  data?: Record<string, any>,
  customMessage?: string
): string {
  switch (eventType) {
    case 'cycle_started':
      return `🔄 *New Cycle Started*

Your circle "${data?.circleName || circleId.slice(0, 10)}" has started a new cycle!

Cycle #${data?.cycleNumber || '1'}
Members: ${data?.memberCount || 'N/A'}
Start Date: ${data?.startDate || new Date().toLocaleDateString()}

${data?.details || ''}`;

    case 'contribution':
      return `💰 *Contribution Received*

A member has contributed to the current cycle!

Amount: ${data?.amount || 'N/A'}
Member: ${data?.memberName || 'Unknown'}
Timestamp: ${data?.timestamp || new Date().toLocaleString()}

Total Contributions: ${data?.totalContributions || 'N/A'}`;

    case 'deadline':
      return `⏰ *Deadline Reminder*

Reminder: Contribution deadline is approaching!

Deadline: ${data?.deadline || 'Today'}
Time Left: ${data?.timeLeft || 'N/A'}
Status: ${data?.status || 'Pending'}

Please ensure your contribution is submitted on time.`;

    case 'payout':
      return `💸 *Payout Notification*

A member has received their payout!

Amount: ${data?.amount || 'N/A'}
Recipient: ${data?.recipientName || 'Unknown'}
Date: ${data?.payoutDate || new Date().toLocaleDateString()}
Status: ${data?.status || 'Completed'}`;

    case 'member_joined':
      return `👋 *New Member Joined*

A new member has joined your circle!

Member: ${data?.memberName || 'Unknown'}
Joined: ${data?.joinDate || new Date().toLocaleDateString()}
Total Members: ${data?.totalMembers || 'N/A'}

Welcome to the circle!`;

    case 'custom':
      return customMessage || 'Update from your circle';

    default:
      return customMessage || `📢 *Circle Update*

Update from circle ${circleId.slice(0, 10)}...`;
  }
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<SendUpdateResponse>
) {
  // Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).json({
      success: false,
      error: 'Method not allowed. Use POST.',
    });
  }

  try {
    const { phoneNumber, circleId, eventType, data, customMessage } =
      req.body as SendUpdateRequest;

    // Validate required fields
    if (!phoneNumber || !circleId || !eventType) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: phoneNumber, circleId, eventType',
      });
    }

    appLogger.info('Sending circle update', {
      phoneNumber,
      circleId,
      eventType,
    });

    // Build message
    const message = buildEventMessage(eventType, circleId, data, customMessage);

    // Send via WhatsApp
    const result = await whatsappSender.sendMessage({
      to: phoneNumber,
      type: 'text',
      text: message,
    });

    if (result.success) {
      appLogger.info('Circle update sent', {
        phoneNumber,
        eventType,
        messageId: result.messageId,
      });

      return res.status(200).json({
        success: true,
        messageId: result.messageId,
        message: `${eventType} update sent to ${phoneNumber}`,
      });
    } else {
      appLogger.error('Failed to send circle update', {
        phoneNumber,
        eventType,
        error: result.error,
      });

      return res.status(500).json({
        success: false,
        error: result.error || 'Failed to send update',
      });
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    appLogger.error('Error sending circle update', {
      error: errorMessage,
    });

    return res.status(500).json({
      success: false,
      error: errorMessage,
    });
  }
}

