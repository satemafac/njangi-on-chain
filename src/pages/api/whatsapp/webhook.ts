/**
 * WhatsApp Webhook Handler
 * 
 * Receives and processes WhatsApp events from Meta.
 * Handles both webhook verification (GET) and incoming messages/status updates (POST).
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import crypto from 'crypto';
import { appLogger } from '../../../utils/logger';
import { getActiveWhatsAppRegistries } from '../../../services/whatsapp-registry-service';
import { getCircleStatus, formatCircleStatusForWhatsAppWithNames } from '../../../services/circle-status.service';
import { getPooledSuiClient } from '../../../services/sui-rpc-failover';
import { fetchAndDecryptPII } from '../../../lib/walrus-pii';
import { lookupCirclesForPhone } from '../../../lib/whatsapp-link-index';
import { timingSafeEqualStrings } from '../../../lib/timing-safe';

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
 * Decode a Move `vector<u8>` field returned by the RPC layer. Sui clients
 * may surface byte vectors as either an array of numbers or a base64
 * string; this normalizes to a Uint8Array.
 */
function decodeBytesField(raw: unknown): Uint8Array {
  if (!raw) return new Uint8Array();
  if (raw instanceof Uint8Array) return raw;
  if (Array.isArray(raw)) return new Uint8Array(raw as number[]);
  if (typeof raw === 'string') {
    return /^[0-9a-fA-F]+$/.test(raw)
      ? new Uint8Array(Buffer.from(raw, 'hex'))
      : new Uint8Array(Buffer.from(raw, 'base64'));
  }
  return new Uint8Array();
}

/**
 * Resolves which circles are linked to the supplied phone number. The
 * Phase 2 Postgres HMAC index (`lookupCirclesForPhone`) gives O(1) lookup
 * for any link recorded since indexing was enabled. We still fall back to
 * the legacy O(N) on-chain scan + Walrus decrypt when the index is empty
 * (e.g. early dev environments or after a salt rotation), which keeps the
 * webhook functional even if Postgres is unavailable.
 */
async function getAllLinkedCirclesFromRegistry(phoneNumber: string): Promise<string[]> {
  try {
    const indexed = await lookupCirclesForPhone(phoneNumber);
    if (indexed.length > 0) {
      appLogger.info('Resolved linked circles via HMAC index', {
        phoneNumber: phoneNumber.replace(/^\+/, ''),
        count: indexed.length,
      });
      return indexed.map((row) => row.circleId);
    }
  } catch (error) {
    appLogger.warn('HMAC index lookup failed, falling back to on-chain scan', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return scanRegistryAndDecryptForPhone(phoneNumber);
}

async function scanRegistryAndDecryptForPhone(phoneNumber: string): Promise<string[]> {
  try {
    const network = getWhatsAppNetwork();
    const registries = getActiveWhatsAppRegistries(network);
    if (!registries || registries.length === 0) {
      appLogger.warn('No active WhatsApp registries configured', { network });
      return [];
    }

    const registry = registries[0];
    const rpcUrl = network === 'testnet'
      ? (process.env.NEXT_PUBLIC_TESTNET_RPC_URL || 'https://sui-testnet-rpc.publicnode.com')
      : (process.env.NEXT_PUBLIC_MAINNET_RPC_URL || 'https://sui-rpc.publicnode.com');
    const suiClient = getPooledSuiClient({ network, rpcUrl });

    const normalizedPhone = phoneNumber.replace(/^\+/, '');

    const registryObject = await suiClient.getObject({
      id: registry.registryObjectId,
      options: { showContent: true },
    });

    if (!registryObject.data?.content || registryObject.data.content.dataType !== 'moveObject') {
      return [];
    }

    const registryFields = (registryObject.data.content as { fields: { links?: unknown[] } }).fields;
    const links = registryFields?.links || [];

    type LinkFields = {
      walrus_blob_id?: unknown;
      circle_id?: string;
      enabled?: boolean;
    };
    type LinkEntry = { fields?: LinkFields } & LinkFields;

    const linkedCircles: string[] = [];

    for (const linkItem of links) {
      const link = linkItem as LinkEntry;
      const fields = link.fields || link;
      const circleId = fields.circle_id;
      const isEnabled = fields.enabled === true;
      if (!isEnabled || !circleId || !fields.walrus_blob_id) continue;

      const blobBytes = decodeBytesField(fields.walrus_blob_id);
      const walrusBlobId = new TextDecoder().decode(blobBytes);
      if (!walrusBlobId) continue;

      try {
        const payload = await fetchAndDecryptPII(walrusBlobId);
        const candidate = payload.phone_e164?.replace(/^\+/, '');
        if (candidate && candidate === normalizedPhone) {
          linkedCircles.push(circleId);
        }
      } catch (err) {
        appLogger.warn('Failed to decrypt WhatsApp PII envelope during webhook lookup', {
          error: err instanceof Error ? err.message : String(err),
          circleId,
        });
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

    const tokenMatches = timingSafeEqualStrings(token, process.env.WHATSAPP_VERIFY_TOKEN);

    appLogger.debug('Webhook verification request', {
      mode,
      hasChallenge: !!challenge,
      tokenMatches,
    });

    if (mode === 'subscribe' && tokenMatches) {
      appLogger.info('Webhook verified successfully');
      return res.status(200).send(challenge);
    }

    appLogger.warn('Invalid webhook verification attempt', {
      mode,
      tokenMatches,
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

      // Enforce Meta's HMAC signature. Fail closed: a missing app secret in
      // production is a deployment error (500), and a missing or invalid
      // signature is always rejected with 403 — no debug bypass.
      if (!appSecret) {
        if (process.env.NODE_ENV === 'production') {
          appLogger.error(
            'WHATSAPP_APP_SECRET is not configured — rejecting webhook (fail closed). ' +
            'Set WHATSAPP_APP_SECRET to the Meta app secret to enable signature verification.',
          );
          return res.status(500).json({
            success: false,
            error: 'Webhook signature verification is not configured',
          });
        }
        // Non-production only: tolerate a missing secret so local dev without
        // Meta credentials can exercise the handler.
        appLogger.warn('WHATSAPP_APP_SECRET not set — skipping signature verification (non-production only)');
      } else {
        let isValid = false;
        try {
          const hash = crypto
            .createHmac('sha256', appSecret)
            .update(rawBody)
            .digest('hex');

          const expectedSignature = `sha256=${hash}`;
          // Hash-then-compare keeps this constant-time even when the header
          // length differs from the expected digest.
          isValid = timingSafeEqualStrings(signature, expectedSignature);
        } catch (signatureError) {
          appLogger.warn('Webhook signature verification error', {
            error: signatureError instanceof Error ? signatureError.message : String(signatureError),
          });
          isValid = false;
        }

        if (!isValid) {
          appLogger.warn('Rejected webhook with missing or invalid signature', {
            hasSignature: !!signature,
            received: signature ? signature.substring(0, 20) : '<none>',
          });
          return res.status(403).json({
            success: false,
            error: 'Invalid webhook signature',
          });
        }

        appLogger.debug('Webhook signature verified');
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
