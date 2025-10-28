/**
 * Message Renderer Service
 * Renders WhatsApp templates with dynamic data substitution and formatting
 * Handles variable replacement, data transformation, and edge cases
 */

import { appLogger } from '../utils/logger';
import { whatsappTemplates, MessageTemplate } from './whatsapp-templates.service';
import { TemplateVariables } from './notification-context-aggregator.service';

/**
 * Rendered message result
 */
export interface RenderedMessage {
  eventType: string;
  header: string;
  body: string;
  footer?: string;
  ctas: Array<{
    text: string;
    action: string;
    url?: string;
  }>;
  characterCount: number;
  success: boolean;
  errors?: string[];
  warnings?: string[];
}

/**
 * Message rendering result with validation
 */
export interface RenderResult {
  success: boolean;
  message?: RenderedMessage;
  error?: string;
  duration: number;
}

export class MessageRendererService {
  private static instance: MessageRendererService;
  private renderCache: Map<string, { data: RenderedMessage; timestamp: number }> = new Map();
  private cacheTTL = 300000; // 5 minutes
  private readonly urlBasePattern = /https?:\/\/[^\s]+/;
  private renderMetrics = {
    totalRenders: 0,
    successfulRenders: 0,
    failedRenders: 0,
    averageRenderTime: 0,
    timings: [] as number[],
  };

  private constructor() {
    appLogger.info('Message Renderer Service initialized');
  }

  /**
   * Get singleton instance
   */
  public static getInstance(): MessageRendererService {
    if (!MessageRendererService.instance) {
      MessageRendererService.instance = new MessageRendererService();
    }
    return MessageRendererService.instance;
  }

  /**
   * Render a message template with variables
   */
  public renderMessage(
    eventType: string,
    variables: TemplateVariables
  ): RenderResult {
    const startTime = Date.now();
    const cacheKey = this.generateCacheKey(eventType, variables);

    // Check cache
    const cached = this.getFromCache(cacheKey);
    if (cached) {
      return {
        success: true,
        message: cached,
        duration: 0,
      };
    }

    try {
      const template = whatsappTemplates.getTemplate(eventType);
      if (!template) {
        throw new Error(`Template not found for event type: ${eventType}`);
      }

      // Validate required variables
      this.validateVariables(template, variables);

      // Render sections
      const header = this.renderText(template.header, variables);
      const body = this.renderText(template.body, variables);
      const footer = template.footer ? this.renderText(template.footer, variables) : undefined;

      // Render CTAs
      const ctas = this.renderCTAs(template, variables, eventType);

      // Build rendered message
      const message: RenderedMessage = {
        eventType,
        header,
        body,
        footer,
        ctas,
        characterCount: (header + body + (footer || '')).length,
        success: true,
        errors: [],
        warnings: [],
      };

      // Cache the result
      this.setCache(cacheKey, message);

      const duration = Date.now() - startTime;
      this.recordMetric(true, duration);

      appLogger.debug('Message rendered successfully', {
        eventType,
        characterCount: message.characterCount,
        duration,
      });

      return {
        success: true,
        message,
        duration,
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      this.recordMetric(false, duration);

      const errorMessage = error instanceof Error ? error.message : String(error);
      appLogger.error('Failed to render message', {
        eventType,
        error: errorMessage,
        duration,
      });

      return {
        success: false,
        error: errorMessage,
        duration,
      };
    }
  }

  /**
   * Render text with variable substitution
   */
  private renderText(template: string, variables: TemplateVariables): string {
    let result = template;

    // Replace all {{variable}} patterns
    const pattern = /\{\{\s*(\w+)\s*\}\}/g;
    const matches = template.matchAll(pattern);

    for (const match of matches) {
      const variableName = match[1];
      const value = variables[variableName as keyof TemplateVariables];

      if (value === undefined || value === null) {
        appLogger.warn('Variable not found in context', {
          variable: variableName,
        });
        // Replace with empty string for missing variables
        result = result.replace(`{{${variableName}}}`, '');
      } else {
        // Format value based on type
        const formatted = this.formatValue(variableName, value);
        result = result.replace(new RegExp(`\\{\\{\\s*${variableName}\\s*\\}\\}`, 'g'), formatted);
      }
    }

    // Clean up extra whitespace
    result = this.cleanupWhitespace(result);

    return result;
  }

  /**
   * Format value based on type and name
   */
  private formatValue(variableName: string, value: any): string {
    // Handle numbers - format as currency or count
    if (typeof value === 'number') {
      if (
        variableName.includes('Amount') ||
        variableName.includes('Contribution') ||
        variableName.includes('Total')
      ) {
        // Currency formatting
        return value.toFixed(2);
      } else if (
        variableName.includes('Count') ||
        variableName.includes('Days') ||
        variableName.includes('Member')
      ) {
        // Integer formatting
        return Math.floor(value).toString();
      }
      return value.toString();
    }

    // Handle dates
    if (variableName.includes('Date')) {
      if (value instanceof Date) {
        return value.toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        });
      }
      return String(value);
    }

    // Handle strings
    if (typeof value === 'string') {
      // Truncate very long strings
      const maxLength = 100;
      if (value.length > maxLength) {
        appLogger.warn('String truncated in message', {
          variable: variableName,
          originalLength: value.length,
        });
        return value.substring(0, maxLength) + '...';
      }
      return value;
    }

    return String(value);
  }

  /**
   * Render call-to-action buttons
   */
  private renderCTAs(
    template: MessageTemplate,
    variables: TemplateVariables,
    eventType: string
  ): Array<{ text: string; action: string; url?: string }> {
    if (!template.ctas) {
      return [];
    }

    return template.ctas.map((cta) => {
      const url = this.generateActionUrl(cta.action, variables, eventType);

      return {
        text: cta.text,
        action: cta.action,
        url,
      };
    });
  }

  /**
   * Generate action URL based on action type
   */
  private generateActionUrl(
    action: string,
    variables: TemplateVariables,
    eventType: string
  ): string {
    const baseUrl = 'https://app.njangi.com';
    const circleId = (variables.circleName as string)?.replace(/\s+/g, '_').toLowerCase() || 'circle';

    const utmParams = new URLSearchParams({
      utm_source: 'whatsapp',
      utm_medium: 'notification',
      utm_campaign: eventType,
    });

    switch (action) {
      case 'contribute':
        return `${baseUrl}/circle/${circleId}/quick-contribute?${utmParams}`;

      case 'approve':
        return `${baseUrl}/circle/${circleId}/approve-payout?${utmParams}`;

      case 'status':
        return `${baseUrl}/circle/${circleId}/quick-status?${utmParams}`;

      case 'view':
        return `${baseUrl}/circle/${circleId}?${utmParams}`;

      case 'join':
        return `${baseUrl}/circle/${circleId}/join?${utmParams}`;

      case 'leave':
        return `${baseUrl}/circle/${circleId}/leave?${utmParams}`;

      default:
        return `${baseUrl}/circle/${circleId}?${utmParams}`;
    }
  }

  /**
   * Validate that all required variables are present
   */
  private validateVariables(template: MessageTemplate, variables: TemplateVariables): void {
    const errors: string[] = [];
    const warnings: string[] = [];

    for (const placeholder of template.placeholders) {
      const value = variables[placeholder.name as keyof TemplateVariables];

      if (value === undefined || value === null) {
        warnings.push(`Missing variable: ${placeholder.name}`);
      } else if (typeof value === 'string' && value.length === 0) {
        warnings.push(`Empty string for: ${placeholder.name}`);
      }
    }

    if (errors.length > 0) {
      throw new Error(`Validation failed: ${errors.join(', ')}`);
    }

    if (warnings.length > 0) {
      appLogger.warn('Template validation warnings', {
        warnings,
      });
    }
  }

  /**
   * Clean up extra whitespace in text
   */
  private cleanupWhitespace(text: string): string {
    // Remove multiple consecutive spaces
    let result = text.replace(/  +/g, ' ');

    // Remove multiple consecutive newlines
    result = result.replace(/\n\n\n+/g, '\n\n');

    // Trim whitespace
    result = result.trim();

    return result;
  }

  /**
   * Preview a message without sending
   */
  public previewMessage(
    eventType: string,
    variables: TemplateVariables
  ): RenderResult {
    appLogger.debug('Previewing message', {
      eventType,
      hasVariables: Object.keys(variables).length > 0,
    });

    return this.renderMessage(eventType, variables);
  }

  /**
   * Get rendering metrics
   */
  public getMetrics(): {
    totalRenders: number;
    successfulRenders: number;
    failedRenders: number;
    successRate: number;
    averageRenderTime: number;
  } {
    return {
      totalRenders: this.renderMetrics.totalRenders,
      successfulRenders: this.renderMetrics.successfulRenders,
      failedRenders: this.renderMetrics.failedRenders,
      successRate:
        this.renderMetrics.totalRenders > 0
          ? (100 * this.renderMetrics.successfulRenders) / this.renderMetrics.totalRenders
          : 0,
      averageRenderTime: this.renderMetrics.averageRenderTime,
    };
  }

  /**
   * Validate rendered message against WhatsApp limits
   */
  public validateRenderedMessage(message: RenderedMessage): {
    valid: boolean;
    issues: string[];
  } {
    const issues: string[] = [];

    // Check character limit (4096 is WhatsApp limit)
    if (message.characterCount > 4096) {
      issues.push(`Message exceeds 4096 character limit: ${message.characterCount}`);
    }

    // Check header length
    if (message.header.length > 60) {
      issues.push(`Header exceeds 60 characters: ${message.header.length}`);
    }

    // Check for empty body
    if (!message.body || message.body.trim().length === 0) {
      issues.push('Message body is empty');
    }

    // Check CTA count
    if (message.ctas.length > 2) {
      issues.push(`Too many CTAs: ${message.ctas.length} (max 2)`);
    }

    // Check for invalid URLs
    for (const cta of message.ctas) {
      if (cta.url && !this.urlBasePattern.test(cta.url)) {
        issues.push(`Invalid URL in CTA: ${cta.url}`);
      }
    }

    return {
      valid: issues.length === 0,
      issues,
    };
  }

  /**
   * Get all rendered messages from cache
   */
  public getCachedMessages(): Array<{
    key: string;
    eventType: string;
    characterCount: number;
    age: number;
  }> {
    return Array.from(this.renderCache.entries()).map(([key, value]) => ({
      key,
      eventType: value.data.eventType,
      characterCount: value.data.characterCount,
      age: Date.now() - value.timestamp,
    }));
  }

  /**
   * Cache helpers
   */
  private generateCacheKey(eventType: string, variables: TemplateVariables): string {
    // Simple cache key based on event type and key variables
    const keyVars = [
      variables.circleName,
      variables.recipientName,
      variables.recipientRole,
    ]
      .filter(Boolean)
      .join('|');

    return `${eventType}:${keyVars}`;
  }

  private getFromCache(key: string): RenderedMessage | null {
    const cached = this.renderCache.get(key);
    if (!cached) return null;

    if (Date.now() - cached.timestamp > this.cacheTTL) {
      this.renderCache.delete(key);
      return null;
    }

    return cached.data;
  }

  private setCache(key: string, data: RenderedMessage): void {
    this.renderCache.set(key, {
      data,
      timestamp: Date.now(),
    });
  }

  /**
   * Record rendering metric
   */
  private recordMetric(success: boolean, duration: number): void {
    this.renderMetrics.totalRenders++;
    if (success) {
      this.renderMetrics.successfulRenders++;
    } else {
      this.renderMetrics.failedRenders++;
    }

    this.renderMetrics.timings.push(duration);

    // Keep only last 1000 timings
    if (this.renderMetrics.timings.length > 1000) {
      this.renderMetrics.timings = this.renderMetrics.timings.slice(-1000);
    }

    // Calculate average
    this.renderMetrics.averageRenderTime = Math.floor(
      this.renderMetrics.timings.reduce((a, b) => a + b, 0) / this.renderMetrics.timings.length
    );
  }

  /**
   * Clear cache and metrics
   */
  public clearCache(): void {
    this.renderCache.clear();
    appLogger.debug('Message renderer cache cleared');
  }

  /**
   * Reset metrics
   */
  public resetMetrics(): void {
    this.renderMetrics = {
      totalRenders: 0,
      successfulRenders: 0,
      failedRenders: 0,
      averageRenderTime: 0,
      timings: [],
    };
    appLogger.debug('Metrics reset');
  }
}

// Export singleton instance
export const messageRenderer = MessageRendererService.getInstance();
