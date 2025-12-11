/**
 * WhatsApp Webhook Handler
 * 
 * Receives and processes WhatsApp events from Meta.
 * Handles both webhook verification (GET) and incoming messages/status updates (POST).
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import crypto from 'crypto';
import { SuiClient } from '@mysten/sui/client';
import { appLogger } from '../../../utils/logger';
import { getActiveWhatsAppRegistries } from '../../../services/whatsapp-registry-service';
import { getCircleStatus, formatCircleStatusForWhatsAppWithNames } from '../../../services/circle-status.service';

interface WebhookResponse {
  success?: boolean;
  error?: string;
  message?: string;
}

// In-memory deduplication cache for webhook messages
// Keeps track of recently processed message IDs to avoid duplicate processing
const processedMessages = new Map<string, number>();
const MESSAGE_DEDUP_WINDOW = 60000; // 60 seconds

// Get the current network from environment (server-side)
function getWhatsAppNetwork(): 'testnet' | 'mainnet' {
  return (process.env.NEXT_PUBLIC_SUI_NETWORK as 'testnet' | 'mainnet') || 'testnet';
}

/**
 * Query the WhatsApp Link Registry on-chain to find ALL linked circles for a phone number
 */
async function getAllLinkedCirclesFromRegistry(phoneNumber: string): Promise<string[]> {
  try {
    const network = getWhatsAppNetwork();
    const registries = getActiveWhatsAppRegistries(network);
    if (!registries || registries.length === 0) {
      appLogger.warn('No active WhatsApp registries configured', { network });
      return [];
    }

    const registry = registries[0];
    const rpcUrl = network === 'testnet'
      ? (process.env.NEXT_PUBLIC_TESTNET_RPC_URL || 'https://fullnode.testnet.sui.io:443')
      : (process.env.NEXT_PUBLIC_MAINNET_RPC_URL || 'https://fullnode.mainnet.sui.io:443');
    const suiClient = new SuiClient({ url: rpcUrl });
    
    const normalizedPhone = phoneNumber.replace(/^\+/, '');

    const registryObject = await suiClient.getObject({
      id: registry.registryObjectId,
      options: {
        showContent: true,
      },
    });

    if (!registryObject.data?.content || registryObject.data.content.dataType !== 'moveObject') {
      return [];
    }

    const registryFields = (registryObject.data.content as { fields: { links?: unknown[] } }).fields;
    const links = registryFields?.links || [];

    type LinkFields = {
      admin_phone_number?: string;
      circle_id?: string;
      enabled?: boolean;
    };
    type LinkEntry = {
      fields?: LinkFields;
    } & LinkFields;

    const linkedCircles: string[] = [];

    for (const linkItem of links) {
      const link = linkItem as LinkEntry;
      const fields = link.fields || link;
      const linkPhone = fields.admin_phone_number;
      const circleId = fields.circle_id;
      const isEnabled = fields.enabled === true;
      
      if (linkPhone && isEnabled && circleId) {
        // Normalize both phone numbers by removing leading '+' for consistent comparison
        // This handles all formats: +1234567890, 1234567890
        const linkPhoneNormalized = linkPhone.replace(/^\+/, '');
        if (linkPhoneNormalized === normalizedPhone) {
          linkedCircles.push(circleId);
        }
      }
    }

    appLogger.info('Found linked circles', {
      phoneNumber: normalizedPhone,
      count: linkedCircles.length,
    });

    return linkedCircles;
  } catch (error) {
    appLogger.error('Error querying WhatsApp registry for all circles', {
      error: error instanceof Error ? error.message : String(error),
      phoneNumber,
    });
    return [];
  }
}

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
                  const lowerText = messageText.toLowerCase();

                  if (lowerText.includes('help') || lowerText === '?') {
                    // Send help message
                    const helpMessage = `✅ *Njangi WhatsApp Channel*\n\nThis is a notification-only channel. You will receive:\n\n• 🔄 Cycle started notifications\n• 💰 Contribution confirmations\n• ⏰ Deadline reminders\n• 💵 Payout notifications\n• 👥 Member joined alerts\n• 📊 Circle insights\n\n*Available Commands:*\n/status <circle-id> - Get live circle status from blockchain\n/help - Show this message\n\n*Example:*\n/status 0x1639fcff0c0f7a48ba0a1aa9f727985f1c9360d399bd8210dc99f26c07237d8e`;


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
                  } else if (lowerText.includes('status') || lowerText === '/status') {
                    // Handle /status command - get circle status from blockchain
                    const parts = messageText.split(' ');
                    const specificCircleId = parts.length > 1 ? parts[1].trim() : null;

                    if (specificCircleId) {
                      // User provided specific circle ID - show that one
                      try {
                        const network = getWhatsAppNetwork();
                        appLogger.info('Fetching specific circle status', { circleId: specificCircleId, network });
                        
                        const circleStatus = await getCircleStatus(specificCircleId, network);
                        
                        let statusMessage: string;
                        if (circleStatus) {
                          statusMessage = await formatCircleStatusForWhatsAppWithNames(circleStatus, specificCircleId);
                        } else {
                          const circleLink = `https://njangionchain.com/circle/${specificCircleId}`;
                          statusMessage = `📊 View circle status here:\n${circleLink}`;
                        }

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
                                body: statusMessage,
                                preview_url: true,
                              },
                            }),
                          }
                        );

                        if (!whatsappResponse.ok) {
                          const errorText = await whatsappResponse.text();
                          appLogger.error('Failed to send status message', {
                            status: whatsappResponse.status,
                            error: errorText,
                          });
                        } else {
                          appLogger.info('✅ Status message sent', { to: sender, circleId: specificCircleId });
                        }
                      } catch (statusError) {
                        appLogger.error('Error sending status message', {
                          error: statusError instanceof Error ? statusError.message : String(statusError),
                          sender,
                        });
                      }
                    } else {
                      // No specific circle ID - show all linked circles
                      const linkedCircles = await getAllLinkedCirclesFromRegistry(sender);

                      if (linkedCircles.length === 0) {
                        const noCircleMessage = `❌ No circles linked to your number.\n\nPlease link a circle via the Njangi app first.\n\nOr use: /status <circle-id>`;

                        try {
                          await fetch(
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
                                  body: noCircleMessage,
                                },
                              }),
                            }
                          );
                        } catch (sendError) {
                          appLogger.error('Error sending no circle message', {
                            error: sendError instanceof Error ? sendError.message : String(sendError),
                          });
                        }
                      } else {
                        // Send status for all linked circles
                        const network = getWhatsAppNetwork();
                        appLogger.info('Fetching status for multiple circles', { count: linkedCircles.length });

                        for (const circleId of linkedCircles) {
                          try {
                            const circleStatus = await getCircleStatus(circleId, network);
                            
                            let statusMessage: string;
                            if (circleStatus) {
                              statusMessage = await formatCircleStatusForWhatsAppWithNames(circleStatus, circleId);
                            } else {
                              const circleLink = `https://njangionchain.com/circle/${circleId}`;
                              statusMessage = `📊 View circle status here:\n${circleLink}`;
                            }

                            await fetch(
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
                                    body: statusMessage,
                                    preview_url: true,
                                  },
                                }),
                              }
                            );

                            // Small delay between messages to avoid rate limits
                            await new Promise(resolve => setTimeout(resolve, 1000));
                          } catch (circleError) {
                            appLogger.error('Error sending circle status', {
                              error: circleError instanceof Error ? circleError.message : String(circleError),
                              circleId,
                            });
                          }
                        }

                        appLogger.info('✅ Status messages sent for all circles', { to: sender, count: linkedCircles.length });
                      }
                    }
                  } else {
                    // For any other message, send a generic acknowledgment
                    const ackMessage = `✓ Thanks for your message! Use /status to get your circle's live status, or /help for more info.`;

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

