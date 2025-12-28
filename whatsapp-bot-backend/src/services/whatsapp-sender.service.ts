/**
 * WhatsApp Cloud API Integration Service
 * Handles message sending, API communication, and error management
 */

import axios, { AxiosInstance, AxiosError } from 'axios';
import { appLogger } from '../utils/logger';
import { ValidationError } from '../utils/errors';
import { getConfig } from '../config';

// ============================================================================
// TYPES & INTERFACES
// ============================================================================

export interface WhatsAppTemplate {
  name: string;
  language: {
    code: string;
  };
  components?: Array<{
    type: 'body' | 'header' | 'footer';
    parameters?: Array<{
      type: 'text' | 'image' | 'document' | 'video';
      text?: string;
      image?: { link: string };
      document?: { link: string };
      video?: { link: string };
    }>;
  }>;
}

export interface WhatsAppMessage {
  messaging_product: 'whatsapp';
  recipient_type: 'individual';
  to: string;
  type: 'template' | 'text' | 'image' | 'document' | 'video';
  template?: WhatsAppTemplate;
  text?: { preview_url: boolean; body: string };
  image?: { link: string; caption?: string };
  document?: { link: string; filename?: string };
  video?: { link: string; caption?: string };
}

export interface WhatsAppResponse {
  messages: Array<{
    id: string;
    message_status: string;
  }>;
  contacts: Array<{
    input: string;
    wa_id: string;
  }>;
}

export interface SendMessageRequest {
  to: string;
  type: 'template' | 'text' | 'image' | 'document' | 'video';
  template?: WhatsAppTemplate;
  text?: string;
  media?: {
    type: 'image' | 'document' | 'video';
    url: string;
    caption?: string;
  };
}

export interface SendResult {
  success: boolean;
  messageId?: string;
  to?: string;
  status?: string;
  error?: string;
  timestamp?: number;
  retryCount?: number;
}

export interface MessageMetrics {
  totalSent: number;
  totalFailed: number;
  totalQueued: number;
  successRate: number;
  averageResponseTime: number;
  lastError?: {
    message: string;
    timestamp: number;
  };
}

// ============================================================================
// WHATSAPP SENDER SERVICE
// ============================================================================

export class WhatsAppSenderService {
  private apiClient: AxiosInstance;
  private phoneNumberId: string;
  private accessToken: string;
  private apiVersion: string;
  private baseUrl: string;

  private metrics = {
    totalSent: 0,
    totalFailed: 0,
    totalQueued: 0,
    responseTimes: [] as number[],
    lastError: null as { message: string; timestamp: number } | null,
  };

  constructor() {
    const config = getConfig();
    this.phoneNumberId = config.whatsapp.phoneNumberId;
    this.accessToken = config.whatsapp.accessToken;
    this.apiVersion = config.whatsapp.apiVersion;

    // Validate credentials
    if (!this.phoneNumberId || !this.accessToken) {
      throw new ValidationError('Missing WhatsApp API credentials in configuration');
    }

    this.baseUrl = `https://graph.facebook.com/${this.apiVersion}/${this.phoneNumberId}`;

    // Initialize axios client
    this.apiClient = axios.create({
      baseURL: this.baseUrl,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    });

    appLogger.info('WhatsApp Sender Service initialized', {
      baseUrl: this.baseUrl,
      phoneNumberId: this.phoneNumberId.substring(0, 8) + '...',
    });
  }

  // ==================== SEND METHODS ====================

  /**
   * Send a single WhatsApp message
   */
  public async sendMessage(request: SendMessageRequest): Promise<SendResult> {
    const startTime = Date.now();

    try {
      // Validate request
      this.validateSendRequest(request);

      appLogger.debug('Sending WhatsApp message', {
        to: request.to,
        type: request.type,
      });

      // Build message payload
      const payload = this.buildMessagePayload(request);

      // Log the full payload for debugging template issues
      if (request.type === 'template') {
        console.log('📤 WhatsApp Template Payload:', JSON.stringify(payload, null, 2));
      }

      // Send via API
      const response = await this.apiClient.post<WhatsAppResponse>('/messages', payload);

      const duration = Date.now() - startTime;
      this.recordMetrics('success', duration);

      const messageId = response.data.messages[0]?.id;
      const waId = response.data.contacts[0]?.wa_id;

      appLogger.info('WhatsApp message sent successfully', {
        messageId,
        to: request.to,
        type: request.type,
        duration,
      });

      return {
        success: true,
        messageId,
        to: waId,
        status: 'sent',
        timestamp: Date.now(),
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      this.recordMetrics('failure', duration);

      const errorMessage = this.parseError(error);

      // Log detailed info for template errors
      if (request.type === 'template' && request.template) {
        appLogger.error('Failed to send WhatsApp template message', {
          to: request.to,
          templateName: request.template.name,
          language: request.template.language,
          parameterCount: request.template.components?.[0]?.parameters?.length || 0,
          error: errorMessage,
          duration,
        });
      } else {
        appLogger.error('Failed to send WhatsApp message', {
          to: request.to,
          type: request.type,
          error: errorMessage,
          duration,
        });
      }

      return {
        success: false,
        to: request.to,
        error: errorMessage,
        timestamp: Date.now(),
      };
    }
  }

  /**
   * Send multiple messages with error handling
   */
  public async sendBatch(requests: SendMessageRequest[]): Promise<SendResult[]> {
    appLogger.info('Starting batch send', { count: requests.length });

    const results = await Promise.allSettled(
      requests.map((req) => this.sendMessage(req))
    );

    return results.map((result, index) => {
      if (result.status === 'fulfilled') {
        return result.value;
      } else {
        return {
          success: false,
          to: requests[index].to,
          error: result.reason?.message || 'Unknown error',
          timestamp: Date.now(),
        };
      }
    });
  }

  /**
   * Send message with automatic retry on failure
   */
  public async sendWithRetry(
    request: SendMessageRequest,
    maxRetries: number = 3,
    backoffMs: number = 1000
  ): Promise<SendResult> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const result = await this.sendMessage(request);

        if (result.success) {
          return { ...result, retryCount: attempt };
        }

        lastError = new Error(result.error);

        // Only retry on retryable errors
        if (!this.isRetryableError(result.error)) {
          return result;
        }

        if (attempt < maxRetries - 1) {
          const waitTime = backoffMs * Math.pow(2, attempt);
          appLogger.debug('Retrying message send', {
            to: request.to,
            attempt: attempt + 1,
            waitTime,
          });

          await new Promise((resolve) => setTimeout(resolve, waitTime));
        }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (attempt < maxRetries - 1) {
          const waitTime = backoffMs * Math.pow(2, attempt);
          await new Promise((resolve) => setTimeout(resolve, waitTime));
        }
      }
    }

    appLogger.error('Message send failed after retries', {
      to: request.to,
      retries: maxRetries,
      lastError: lastError?.message,
    });

    return {
      success: false,
      to: request.to,
      error: lastError?.message || 'Max retries exceeded',
      timestamp: Date.now(),
      retryCount: maxRetries,
    };
  }

  // ==================== MESSAGE BUILDING ====================

  /**
   * Build WhatsApp API message payload
   */
  private buildMessagePayload(request: SendMessageRequest): WhatsAppMessage {
    const basePayload: WhatsAppMessage = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: request.to,
      type: request.type,
    };

    switch (request.type) {
      case 'template':
        if (!request.template) {
          throw new ValidationError('Template required for template type messages');
        }
        return {
          ...basePayload,
          template: request.template,
        };

      case 'text':
        if (!request.text) {
          throw new ValidationError('Text content required for text type messages');
        }
        return {
          ...basePayload,
          text: {
            preview_url: true,
            body: request.text,
          },
        };

      case 'image':
      case 'document':
      case 'video':
        if (!request.media) {
          throw new ValidationError(`Media required for ${request.type} type messages`);
        }
        const mediaKey = request.type as 'image' | 'document' | 'video';
        return {
          ...basePayload,
          [mediaKey]: {
            link: request.media.url,
            ...(request.media.caption && { caption: request.media.caption }),
          },
        };

      default:
        throw new ValidationError(`Unknown message type: ${request.type}`);
    }
  }

  // ==================== VALIDATION & ERROR HANDLING ====================

  /**
   * Validate send request
   */
  private validateSendRequest(request: SendMessageRequest): void {
    if (!request.to) {
      throw new ValidationError('Recipient phone number required');
    }

    // Validate phone number format (E.164)
    if (!/^\+?[1-9]\d{1,14}$/.test(request.to.replace(/[^\d+]/g, ''))) {
      throw new ValidationError(`Invalid phone number format: ${request.to}`);
    }

    if (!request.type) {
      throw new ValidationError('Message type required');
    }

    if (!['template', 'text', 'image', 'document', 'video'].includes(request.type)) {
      throw new ValidationError(`Unknown message type: ${request.type}`);
    }
  }

  /**
   * Parse error from API response or exception
   */
  private parseError(error: unknown): string {
    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError<{
        error: {
          message: string;
          type: string;
          code: number;
          error_subcode?: number;
          error_data?: {
            details: string;
          };
        };
      }>;

      // Log the FULL error response for debugging
      console.log('❌ Meta API Error Response:', JSON.stringify(axiosError.response?.data, null, 2));

      if (axiosError.response?.data?.error) {
        const apiError = axiosError.response.data.error;
        // Include subcode and details if available
        const subcode = apiError.error_subcode ? ` (subcode: ${apiError.error_subcode})` : '';
        const details = apiError.error_data?.details ? ` - ${apiError.error_data.details}` : '';
        return `${apiError.code}: ${apiError.message}${subcode}${details}`;
      }

      if (axiosError.response?.status === 401) {
        return '401: Unauthorized - Check WhatsApp API credentials';
      }

      if (axiosError.response?.status === 429) {
        return '429: Rate limited - Too many requests';
      }

      if (axiosError.message) {
        return axiosError.message;
      }
    }

    if (error instanceof Error) {
      return error.message;
    }

    return String(error);
  }

  /**
   * Determine if error is retryable
   */
  private isRetryableError(error: string | undefined): boolean {
    if (!error) return false;

    // Retryable errors
    const retryablePatterns = [
      '429', // Rate limit
      'ECONNRESET',
      'ETIMEDOUT',
      'ECONNREFUSED',
      'temporarily unavailable',
      'timeout',
    ];

    return retryablePatterns.some((pattern) =>
      error.toLowerCase().includes(pattern.toLowerCase())
    );
  }

  // ==================== METRICS & MONITORING ====================

  /**
   * Record metrics
   */
  private recordMetrics(result: 'success' | 'failure', duration: number): void {
    if (result === 'success') {
      this.metrics.totalSent++;
    } else {
      this.metrics.totalFailed++;
    }

    this.metrics.responseTimes.push(duration);

    // Keep only last 1000 response times
    if (this.metrics.responseTimes.length > 1000) {
      this.metrics.responseTimes = this.metrics.responseTimes.slice(-1000);
    }
  }

  /**
   * Get service metrics
   */
  public getMetrics(): MessageMetrics {
    const total = this.metrics.totalSent + this.metrics.totalFailed;
    const successRate =
      total > 0 ? Math.round((this.metrics.totalSent / total) * 100) : 0;

    const avgTime =
      this.metrics.responseTimes.length > 0
        ? Math.round(
            this.metrics.responseTimes.reduce((a, b) => a + b, 0) /
              this.metrics.responseTimes.length
          )
        : 0;

    return {
      totalSent: this.metrics.totalSent,
      totalFailed: this.metrics.totalFailed,
      totalQueued: this.metrics.totalQueued,
      successRate,
      averageResponseTime: avgTime,
      lastError: this.metrics.lastError || undefined,
    };
  }

  /**
   * Reset metrics
   */
  public resetMetrics(): void {
    this.metrics = {
      totalSent: 0,
      totalFailed: 0,
      totalQueued: 0,
      responseTimes: [],
      lastError: null,
    };

    appLogger.info('WhatsApp sender metrics reset');
  }

  /**
   * Health check
   */
  public async healthCheck(): Promise<boolean> {
    try {
      // Test API connection by making a simple API call
      await this.apiClient.get('/');
      return true;
    } catch (error) {
      appLogger.error('WhatsApp API health check failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }
}

// ============================================================================
// SINGLETON INSTANCE
// ============================================================================

let instance: WhatsAppSenderService | null = null;

export function getWhatsAppSender(): WhatsAppSenderService {
  if (!instance) {
    instance = new WhatsAppSenderService();
  }
  return instance;
}

export const whatsappSender = getWhatsAppSender();
