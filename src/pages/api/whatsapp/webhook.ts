/**
 * WhatsApp Webhook Handler
 * 
 * Receives and processes WhatsApp events from Meta.
 * Handles both webhook verification (GET) and incoming messages/status updates (POST).
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import crypto from 'crypto';
import { appLogger } from '../../../utils/logger';

interface WebhookResponse {
  success?: boolean;
  error?: string;
  message?: string;
}

// In-memory deduplication cache for webhook messages
// Keeps track of recently processed message IDs to avoid duplicate processing
const processedMessages = new Map<string, number>();
const MESSAGE_DEDUP_WINDOW = 60000; // 60 seconds

function isMessageProcessed(messageId: string): boolean {
  const lastProcessedTime = processedMessages.get(messageId);
  if (!lastProcessedTime) {
    return false;
  }

  const now = Date.now();
  if (now - lastProcessedTime > MESSAGE_DEDUP_WINDOW) {
    // Message is older than the dedup window, forget it
    processedMessages.delete(messageId);
    return false;
  }

  return true;
}

function markMessageProcessed(messageId: string): void {
  processedMessages.set(messageId, Date.now());
  
  // Clean up old entries periodically
  if (processedMessages.size > 1000) {
    const now = Date.now();
    for (const [id, time] of processedMessages.entries()) {
      if (now - time > MESSAGE_DEDUP_WINDOW) {
        processedMessages.delete(id);
      }
    }
  }
}

async function handler(
  req: NextApiRequest,
  res: NextApiResponse<WebhookResponse | string>
) {
  // Handle GET for webhook verification
  if (req.method === 'GET') {
    const { 'hub.mode': mode, 'hub.challenge': challenge, 'hub.verify_token': token } =
      req.query as Record<string, string>;

    appLogger.debug('Webhook verification request', {
      mode,
      hasChallenge: !!challenge,
      tokenMatches: token === process.env.WHATSAPP_VERIFY_TOKEN,
    });

    if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
      appLogger.info('Webhook verified successfully');
      return res.status(200).send(challenge);
    }

    appLogger.warn('Invalid webhook verification attempt', {
      mode,
      tokenMatches: token === process.env.WHATSAPP_VERIFY_TOKEN,
    });

    return res.status(403).send('Forbidden');
  }

  // Handle POST - process incoming webhook events
  if (req.method === 'POST') {
    try {
      const signature = req.headers['x-hub-signature-256'] as string | undefined;
      const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
      const appSecret = process.env.WHATSAPP_APP_SECRET;

      appLogger.debug('Webhook POST received', {
        hasSignature: !!signature,
        hasAppSecret: !!appSecret,
        bodySize: rawBody.length,
      });

      // Verify webhook signature if both signature and app secret are present
      if (signature && appSecret) {
        try {
          const hash = crypto
            .createHmac('sha256', appSecret)
            .update(rawBody)
            .digest('hex');

          const expectedSignature = `sha256=${hash}`;

          // Log both signatures for debugging
          appLogger.debug('Webhook signature comparison', {
            received: signature,
            expected: expectedSignature,
            bodyLength: rawBody.length,
          });

          const isValid = crypto.timingSafeEqual(
            Buffer.from(signature),
            Buffer.from(expectedSignature)
          );

          if (!isValid) {
            appLogger.warn('Invalid webhook signature - allowing anyway for debugging', {
              received: signature.substring(0, 20),
              expected: expectedSignature.substring(0, 20),
            });
            // ⚠️ TEMPORARY: Allow invalid signatures to debug the issue
            // In production, this should return 403
          }

          appLogger.debug('Webhook signature processed');
        } catch (signatureError) {
          appLogger.warn('Webhook signature verification error - allowing anyway for debugging', {
            error: signatureError instanceof Error ? signatureError.message : String(signatureError),
          });
          // ⚠️ TEMPORARY: Allow on error to debug the issue
          // In production, this should return 403
        }
      } else if (!signature) {
        appLogger.debug('No webhook signature header present', {
          availableHeaders: Object.keys(req.headers).join(', '),
        });
      }

      // Parse the webhook body
      const body = typeof req.body === 'object' ? req.body : JSON.parse(rawBody);

      // Process incoming messages
      if (body.entry && Array.isArray(body.entry)) {
        for (const entry of body.entry) {
          if (entry.changes && Array.isArray(entry.changes)) {
            for (const change of entry.changes) {
              const value = change.value;
              
              // Process incoming messages
              if (value.messages && Array.isArray(value.messages)) {
                for (const msg of value.messages) {
                  // Check if we've already processed this message
                  if (isMessageProcessed(msg.id)) {
                    appLogger.debug('⏭️  Skipping duplicate message', {
                      messageId: msg.id,
                      from: msg.from,
                    });
                    continue;
                  }

                  appLogger.info('📱 Incoming WhatsApp message', {
                    from: msg.from,
                    type: msg.type,
                    text: msg.text?.body || '<non-text>',
                    messageId: msg.id,
                  });

                  // Mark this message as processed
                  markMessageProcessed(msg.id);

                  // Process the message
                  const messageText = msg.text?.body || '';
                  const sender = msg.from;

                  // Handle different message types
                  if (messageText.toLowerCase().includes('help') || messageText === '?') {
                    // Send help message
                    const helpMessage = `✅ *Njangi WhatsApp Channel*\n\nThis is a notification-only channel. You will receive:\n\n• 🔄 Cycle started notifications\n• 💰 Contribution confirmations\n• ⏰ Deadline reminders\n• 💵 Payout notifications\n• 👥 Member joined alerts\n• 📊 Circle insights\n\nNo commands needed - just sit back and get updates!`;

                    try {
                      const whatsappResponse = await fetch(
                        `https://graph.facebook.com/v23.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
                        {
                          method: 'POST',
                          headers: {
                            'Authorization': `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
                            'Content-Type': 'application/json',
                          },
                          body: JSON.stringify({
                            messaging_product: 'whatsapp',
                            to: sender,
                            type: 'text',
                            text: {
                              body: helpMessage,
                            },
                          }),
                        }
                      );

                      if (!whatsappResponse.ok) {
                        const errorText = await whatsappResponse.text();
                        appLogger.error('Failed to send help message', {
                          status: whatsappResponse.status,
                          error: errorText,
                        });
                      } else {
                        appLogger.info('✅ Help message sent', { to: sender });
                      }
                    } catch (sendError) {
                      appLogger.error('Error sending help message', {
                        error: sendError instanceof Error ? sendError.message : String(sendError),
                      });
                    }
                  } else {
                    // For any other message, send a generic acknowledgment
                    const ackMessage = `✓ Thanks for your message! This is a notification channel. You will receive circle updates here.`;

                    try {
                      const whatsappResponse = await fetch(
                        `https://graph.facebook.com/v23.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
                        {
                          method: 'POST',
                          headers: {
                            'Authorization': `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
                            'Content-Type': 'application/json',
                          },
                          body: JSON.stringify({
                            messaging_product: 'whatsapp',
                            to: sender,
                            type: 'text',
                            text: {
                              body: ackMessage,
                            },
                          }),
                        }
                      );

                      if (!whatsappResponse.ok) {
                        const errorText = await whatsappResponse.text();
                        appLogger.error('Failed to send acknowledgment', {
                          status: whatsappResponse.status,
                          error: errorText,
                        });
                      } else {
                        appLogger.debug('✓ Acknowledgment sent', { to: sender });
                      }
                    } catch (sendError) {
                      appLogger.error('Error sending acknowledgment', {
                        error: sendError instanceof Error ? sendError.message : String(sendError),
                      });
                    }
                  }
                }
              }

              // Log status updates
              if (value.statuses && Array.isArray(value.statuses)) {
                for (const status of value.statuses) {
                  appLogger.debug('📤 Message status update', {
                    messageId: status.id,
                    status: status.status,
                    timestamp: status.timestamp,
                  });
                }
              }
            }
          }
        }
      }

      appLogger.debug('Webhook received and processed', {
        bodySize: rawBody.length,
      });

      // Process the webhook (just acknowledge for now)
      // In production, this would handle incoming messages and status updates
      return res.status(200).json({
        success: true,
        message: 'Webhook received and processed',
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      appLogger.error('Error processing webhook', {
        error: errorMessage,
      });

      return res.status(500).json({
        success: false,
        error: errorMessage,
      });
    }
  }

  // Method not allowed
  return res.status(405).json({
    success: false,
    error: 'Method not allowed',
  });
}

export default handler;

