/**
 * POST /api/whatsapp/webhook-handler
 * Webhook endpoint handler for delivery status updates and incoming messages
 * Parses WhatsApp webhook data and routes to appropriate handlers
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { appLogger } from '../../../utils/logger';
import { asyncHandler } from '../../../middleware/errorHandler';
import { webhookHandler, WhatsAppStatusUpdate, IncomingWhatsAppMessage } from '../../../services/webhook-handler.service';

interface WebhookResponse {
  success: boolean;
  data?: any;
  error?: string;
}

/**
 * Parse WhatsApp status update from webhook payload
 */
function parseStatusUpdate(entry: any): WhatsAppStatusUpdate | null {
  try {
    const change = entry.changes?.[0];
    if (!change || change.field !== 'message_status') {
      return null;
    }

    const value = change.value;
    if (!value.message_id || !value.status) {
      return null;
    }

    return {
      messageId: value.message_id,
      status: value.status,
      timestamp: new Date().toISOString(),
      recipientId: value.recipient_id,
      errors: value.errors || undefined,
    };
  } catch (error) {
    appLogger.warn('Failed to parse status update', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Parse incoming WhatsApp message from webhook payload
 */
function parseIncomingMessage(entry: any): IncomingWhatsAppMessage | null {
  try {
    const change = entry.changes?.[0];
    if (!change || change.field !== 'messages') {
      return null;
    }

    const value = change.value;
    const message = value.messages?.[0];

    if (!message || !value.metadata?.phone_number_id) {
      return null;
    }

    return {
      from: message.from,
      messageId: message.id,
      timestamp: new Date(parseInt(message.timestamp) * 1000).toISOString(),
      type: message.type,
      text: message.text,
      image: message.image,
      document: message.document,
      audio: message.audio,
      video: message.video,
    };
  } catch (error) {
    appLogger.warn('Failed to parse incoming message', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Main webhook handler
 */
const handler = asyncHandler(
  async (req: NextApiRequest, res: NextApiResponse<WebhookResponse>) => {
    const { action = 'process' } = req.query as Record<string, string>;

    switch (action) {
      // POST process webhook
      case 'process':
        if (req.method !== 'POST') {
          return res.status(405).json({ success: false, error: 'Method not allowed' });
        }

        try {
          const payload = req.body;
          const object = payload.object;

          if (object !== 'whatsapp_business_account') {
            appLogger.debug('Ignoring webhook for non-WhatsApp object', { object });
            return res.status(200).json({ success: true });
          }

          const entries = payload.entry || [];
          const statusUpdates: WhatsAppStatusUpdate[] = [];
          const incomingMessages: IncomingWhatsAppMessage[] = [];

          // Parse all entries
          for (const entry of entries) {
            // Parse status updates
            const statusUpdate = parseStatusUpdate(entry);
            if (statusUpdate) {
              statusUpdates.push(statusUpdate);
            }

            // Parse incoming messages
            const incomingMessage = parseIncomingMessage(entry);
            if (incomingMessage) {
              incomingMessages.push(incomingMessage);
            }
          }

          // Process in parallel
          const [statusResults, messageResults] = await Promise.allSettled([
            webhookHandler.handleStatusUpdateBatch(statusUpdates),
            webhookHandler.handleIncomingMessageBatch(incomingMessages),
          ]);

          appLogger.info('Webhook processed', {
            statusUpdates: statusUpdates.length,
            incomingMessages: incomingMessages.length,
            statusResult: statusResults.status,
            messageResult: messageResults.status,
          });

          return res.status(200).json({
            success: true,
            data: {
              processed: true,
              statusUpdates: statusUpdates.length,
              incomingMessages: incomingMessages.length,
            },
          });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);

          appLogger.error('Failed to process webhook', { error: errorMessage });

          return res.status(500).json({
            success: false,
            error: errorMessage,
          });
        }

      // GET delivery status
      case 'status': {
        const { messageId } = req.query as Record<string, string>;

        if (!messageId) {
          return res.status(400).json({
            success: false,
            error: 'messageId parameter required',
          });
        }

        const record = webhookHandler.getDeliveryRecord(messageId);

        if (!record) {
          return res.status(404).json({
            success: false,
            error: 'Message not found',
          });
        }

        return res.status(200).json({
          success: true,
          data: record,
        });
      }

      // GET delivery timeline
      case 'timeline': {
        const { messageId } = req.query as Record<string, string>;

        if (!messageId) {
          return res.status(400).json({
            success: false,
            error: 'messageId parameter required',
          });
        }

        const timeline = webhookHandler.getDeliveryTimeline(messageId);

        return res.status(200).json({
          success: true,
          data: timeline,
        });
      }

      // GET delivery records by status
      case 'records': {
        const { status } = req.query as Record<string, string>;

        if (!status || !['sent', 'delivered', 'read', 'failed'].includes(status)) {
          return res.status(400).json({
            success: false,
            error: 'Invalid status parameter',
          });
        }

        const records = webhookHandler.getRecordsByStatus(
          status as 'sent' | 'delivered' | 'read' | 'failed'
        );

        return res.status(200).json({
          success: true,
          data: {
            status,
            count: records.length,
            records,
          },
        });
      }

      // GET delivery metrics
      case 'metrics':
        if (req.method !== 'GET') {
          return res.status(405).json({ success: false, error: 'Method not allowed' });
        }

        const metrics = webhookHandler.getMetrics();
        const successRate = webhookHandler.getSuccessRate();

        return res.status(200).json({
          success: true,
          data: {
            ...metrics,
            successRate,
          },
        });

      // GET handler statistics
      case 'stats':
        if (req.method !== 'GET') {
          return res.status(405).json({ success: false, error: 'Method not allowed' });
        }

        const stats = webhookHandler.getStatistics();

        return res.status(200).json({
          success: true,
          data: stats,
        });

      // GET failed messages
      case 'failed':
        if (req.method !== 'GET') {
          return res.status(405).json({ success: false, error: 'Method not allowed' });
        }

        const limit = parseInt((req.query.limit as string) || '100', 10);
        const failed = webhookHandler.getFailedMessages(Math.min(limit, 1000));

        return res.status(200).json({
          success: true,
          data: {
            count: failed.length,
            failed,
          },
        });

      // GET all delivery records
      case 'all':
        if (req.method !== 'GET') {
          return res.status(405).json({ success: false, error: 'Method not allowed' });
        }

        const allRecords = webhookHandler.getAllDeliveryRecords();

        return res.status(200).json({
          success: true,
          data: {
            count: allRecords.length,
            records: allRecords,
          },
        });

      // POST cleanup old records
      case 'cleanup':
        if (req.method !== 'POST') {
          return res.status(405).json({ success: false, error: 'Method not allowed' });
        }

        const daysOld = parseInt((req.body?.daysOld as string) || '7', 10);
        const msOld = daysOld * 24 * 60 * 60 * 1000;
        const removed = webhookHandler.cleanupOldRecords(msOld);

        appLogger.info('Delivery records cleaned up', { removed, daysOld });

        return res.status(200).json({
          success: true,
          data: {
            removed,
            daysOld,
          },
        });

      // POST reset metrics
      case 'reset':
        if (req.method !== 'POST') {
          return res.status(405).json({ success: false, error: 'Method not allowed' });
        }

        webhookHandler.resetMetrics();

        appLogger.info('Webhook handler metrics reset');

        return res.status(200).json({
          success: true,
          data: { reset: true },
        });

      default:
        return res.status(400).json({
          success: false,
          error: `Unknown action: ${action}`,
        });
    }
  }
);

export default handler;
