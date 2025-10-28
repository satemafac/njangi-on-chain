/**
 * GET/POST /api/whatsapp/queue
 * Message Queue Management and Monitoring API
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { appLogger } from '../../../utils/logger';
import { asyncHandler } from '../../../middleware/errorHandler';
import { ValidationError } from '../../../utils/errors';
import { messageQueue } from '../../../services/message-queue.service';
import { SendMessageRequest } from '../../../services/whatsapp-sender.service';

interface EnqueueRequest {
  to: string;
  type: 'template' | 'text' | 'image' | 'document' | 'video';
  priority?: 'high' | 'normal' | 'low';
  template?: { name: string; language: { code: string } };
  text?: string;
  media?: { type: 'image' | 'document' | 'video'; url: string; caption?: string };
}

interface QueueResponse {
  success: boolean;
  data?: any;
  error?: string;
}

const handler = asyncHandler(async (req: NextApiRequest, res: NextApiResponse<QueueResponse>) => {
  const { action = 'stats' } = req.query as Record<string, string>;

  switch (action) {
    // GET stats
    case 'stats':
      if (req.method !== 'GET') {
        return res.status(405).json({ success: false, error: 'Method not allowed' });
      }

      const stats = messageQueue.getStats();
      appLogger.debug('Queue stats retrieved');

      return res.status(200).json({
        success: true,
        data: stats,
      });

    // POST enqueue single message
    case 'enqueue':
      if (req.method !== 'POST') {
        return res.status(405).json({ success: false, error: 'Method not allowed' });
      }

      try {
        const { to, type, priority = 'normal', template, text, media } =
          req.body as EnqueueRequest;

        if (!to) {
          throw new ValidationError('Recipient (to) is required');
        }

        // Build send request
        const sendRequest: SendMessageRequest = { to, type } as SendMessageRequest;

        if (type === 'template' && template) {
          (sendRequest as any).template = template;
        } else if (type === 'text' && text) {
          (sendRequest as any).text = text;
        } else if (['image', 'document', 'video'].includes(type) && media) {
          (sendRequest as any).media = media;
        } else {
          throw new ValidationError(`Invalid content for message type: ${type}`);
        }

        const queuedMessage = await messageQueue.enqueue(sendRequest, priority, 5);

        appLogger.info('Message enqueued via API', {
          messageId: queuedMessage.id,
          to,
          priority,
        });

        return res.status(200).json({
          success: true,
          data: queuedMessage,
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);

        appLogger.error('Failed to enqueue message', { error: errorMessage });

        return res.status(400).json({
          success: false,
          error: errorMessage,
        });
      }

    // GET queue status
    case 'status':
      if (req.method !== 'GET') {
        return res.status(405).json({ success: false, error: 'Method not allowed' });
      }

      const queueSize = messageQueue.getQueueSize();
      const queueStats = messageQueue.getStats();

      return res.status(200).json({
        success: true,
        data: {
          queueSize,
          ...queueStats,
        },
      });

    // GET specific message
    case 'message': {
      if (req.method !== 'GET') {
        return res.status(405).json({ success: false, error: 'Method not allowed' });
      }

      const { messageId } = req.query as Record<string, string>;

      if (!messageId) {
        return res.status(400).json({
          success: false,
          error: 'messageId parameter required',
        });
      }

      const message = messageQueue.getMessage(messageId);

      if (!message) {
        return res.status(404).json({
          success: false,
          error: 'Message not found',
        });
      }

      return res.status(200).json({
        success: true,
        data: message,
      });
    }

    // DELETE/Clear specific message
    case 'clear': {
      if (req.method !== 'DELETE') {
        return res.status(405).json({ success: false, error: 'Method not allowed' });
      }

      const { messageId } = req.query as Record<string, string>;

      if (!messageId) {
        return res.status(400).json({
          success: false,
          error: 'messageId parameter required',
        });
      }

      const removed = messageQueue.removeMessage(messageId);

      if (!removed) {
        return res.status(404).json({
          success: false,
          error: 'Message not found',
        });
      }

      appLogger.info('Message removed from queue', { messageId });

      return res.status(200).json({
        success: true,
        data: { messageId, removed: true },
      });
    }

    // POST batch enqueue
    case 'batch':
      if (req.method !== 'POST') {
        return res.status(405).json({ success: false, error: 'Method not allowed' });
      }

      try {
        const { messages } = req.body as {
          messages: Array<EnqueueRequest>;
        };

        if (!Array.isArray(messages) || messages.length === 0) {
          throw new ValidationError('messages array is required and must not be empty');
        }

        if (messages.length > 100) {
          throw new ValidationError('Maximum 100 messages per batch');
        }

        const requests = messages.map((msg) => {
          const sendRequest: SendMessageRequest = { to: msg.to, type: msg.type } as any;

          if (msg.type === 'template' && msg.template) {
            (sendRequest as any).template = msg.template;
          } else if (msg.type === 'text' && msg.text) {
            (sendRequest as any).text = msg.text;
          } else if (['image', 'document', 'video'].includes(msg.type) && msg.media) {
            (sendRequest as any).media = msg.media;
          }

          return {
            request: sendRequest,
            priority: msg.priority || 'normal',
          };
        });

        const queuedMessages = await messageQueue.enqueueBatch(requests);

        appLogger.info('Batch enqueued via API', { count: queuedMessages.length });

        return res.status(200).json({
          success: true,
          data: {
            count: queuedMessages.length,
            messages: queuedMessages,
          },
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);

        appLogger.error('Failed to enqueue batch', { error: errorMessage });

        return res.status(400).json({
          success: false,
          error: errorMessage,
        });
      }

    default:
      return res.status(400).json({
        success: false,
        error: `Unknown action: ${action}`,
      });
  }
});

export default handler;
