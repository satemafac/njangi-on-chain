/**
 * WhatsApp Templates Service
 * Defines standardized message templates for all 7 notification types
 * Following WhatsApp Cloud API format with dynamic placeholders
 */

import { appLogger } from '../utils/logger';

/**
 * Template placeholder definition
 */
export interface TemplatePlaceholder {
  name: string;
  description: string;
  example: string;
}

/**
 * WhatsApp message template
 */
export interface MessageTemplate {
  eventType: string;
  name: string;
  description: string;
  header: string;
  body: string;
  footer?: string;
  ctas?: Array<{
    text: string;
    action: 'contribute' | 'approve' | 'status' | 'view' | 'join' | 'leave';
    priority: 'primary' | 'secondary';
  }>;
  placeholders: TemplatePlaceholder[];
  characterCount: number;
  supportedLanguages: string[];
}

export class WhatsAppTemplatesService {
  private static instance: WhatsAppTemplatesService;
  private templates: Map<string, MessageTemplate> = new Map();

  private constructor() {
    this.initializeTemplates();
    appLogger.info('WhatsApp Templates Service initialized with 7 templates');
  }

  /**
   * Get singleton instance
   */
  public static getInstance(): WhatsAppTemplatesService {
    if (!WhatsAppTemplatesService.instance) {
      WhatsAppTemplatesService.instance = new WhatsAppTemplatesService();
    }
    return WhatsAppTemplatesService.instance;
  }

  /**
   * Initialize all templates
   */
  private initializeTemplates(): void {
    // Template 1: New Cycle Started
    this.templates.set('NewCycleStarted', {
      eventType: 'NewCycleStarted',
      name: 'New Cycle Started',
      description: 'Notification when a new savings cycle begins',
      header: '🎉 New Cycle Started!',
      body:
        'Hey {{recipientName}},\n\n' +
        'A new savings cycle has started for {{circleName}}!\n\n' +
        '📊 *Cycle Details:*\n' +
        '• Members: {{memberCount}}\n' +
        '• Target Amount: {{amountPerMember}}\n' +
        '• Deadline: {{deadlineDate}}\n\n' +
        'Get ready to contribute and help your circle achieve its goals.',
      footer: 'Njangi - Community Savings Made Simple',
      ctas: [
        { text: 'View Details', action: 'view', priority: 'primary' },
        { text: 'Contribute', action: 'contribute', priority: 'secondary' },
      ],
      placeholders: [
        { name: 'recipientName', description: 'Member name', example: 'John' },
        { name: 'circleName', description: 'Circle name', example: 'Circle Alpha' },
        { name: 'memberCount', description: 'Number of members', example: '5' },
        { name: 'amountPerMember', description: 'Contribution amount', example: '100.00' },
        { name: 'deadlineDate', description: 'Deadline date', example: 'Jan 15, 2025' },
      ],
      characterCount: 0, // Calculated
      supportedLanguages: ['en', 'es', 'fr'],
    });

    // Template 2: Member Contributed
    this.templates.set('MemberContributed', {
      eventType: 'MemberContributed',
      name: 'Member Contributed',
      description: 'Notification when a member makes a contribution',
      header: '✅ Member Contributed',
      body:
        'Great news {{recipientName}}!\n\n' +
        'A member of {{circleName}} has contributed.\n\n' +
        '📈 *Progress:*\n' +
        '• Contributed: {{contributedCount}}/{{memberCount}} members\n' +
        '• Total Collected: {{totalContribution}}\n' +
        '• Target: {{amountPerMember}} per member\n\n' +
        'Keep the momentum going!',
      footer: 'Njangi - Community Savings Made Simple',
      ctas: [
        { text: 'View Details', action: 'view', priority: 'primary' },
        { text: 'Contribute', action: 'contribute', priority: 'secondary' },
      ],
      placeholders: [
        { name: 'recipientName', description: 'Recipient name', example: 'Admin' },
        { name: 'circleName', description: 'Circle name', example: 'Circle Alpha' },
        { name: 'contributedCount', description: 'Members who contributed', example: '3' },
        { name: 'memberCount', description: 'Total members', example: '5' },
        { name: 'totalContribution', description: 'Total amount collected', example: '300.00' },
        { name: 'amountPerMember', description: 'Target per member', example: '100.00' },
      ],
      characterCount: 0,
      supportedLanguages: ['en', 'es', 'fr'],
    });

    // Template 3: All Members Contributed
    this.templates.set('AllMembersContributed', {
      eventType: 'AllMembersContributed',
      name: 'All Members Contributed',
      description: 'Notification when all members have contributed',
      header: '🎊 All Members Contributed!',
      body:
        'Excellent {{recipientName}}!\n\n' +
        'All {{memberCount}} members of {{circleName}} have contributed!\n\n' +
        '💰 *Collection Complete:*\n' +
        '• Total Collected: {{totalContribution}}\n' +
        '• Per Member: {{amountPerMember}}\n' +
        '• Status: Ready for payout\n\n' +
        'Time to distribute the funds!',
      footer: 'Njangi - Community Savings Made Simple',
      ctas: [
        { text: 'Approve Payout', action: 'approve', priority: 'primary' },
        { text: 'View Details', action: 'view', priority: 'secondary' },
      ],
      placeholders: [
        { name: 'recipientName', description: 'Recipient name', example: 'Admin' },
        { name: 'memberCount', description: 'Total members', example: '5' },
        { name: 'circleName', description: 'Circle name', example: 'Circle Alpha' },
        { name: 'totalContribution', description: 'Total amount', example: '500.00' },
        { name: 'amountPerMember', description: 'Per member amount', example: '100.00' },
      ],
      characterCount: 0,
      supportedLanguages: ['en', 'es', 'fr'],
    });

    // Template 4: Deadline Approaching
    this.templates.set('DeadlineApproaching', {
      eventType: 'DeadlineApproaching',
      name: 'Deadline Approaching',
      description: 'Reminder when contribution deadline is approaching',
      header: '⏰ Deadline Approaching!',
      body:
        'Hi {{recipientName}},\n\n' +
        'The contribution deadline for {{circleName}} is approaching!\n\n' +
        '⚠️ *Urgent:*\n' +
        '• Days remaining: {{daysUntilDeadline}}\n' +
        '• Deadline: {{deadlineDate}}\n' +
        '• Your status: Contribution {{contributionAmount}} needed\n\n' +
        'Don\'t miss the deadline! Contribute now.',
      footer: 'Njangi - Community Savings Made Simple',
      ctas: [
        { text: 'Contribute Now', action: 'contribute', priority: 'primary' },
        { text: 'Check Status', action: 'status', priority: 'secondary' },
      ],
      placeholders: [
        { name: 'recipientName', description: 'Member name', example: 'John' },
        { name: 'circleName', description: 'Circle name', example: 'Circle Alpha' },
        { name: 'daysUntilDeadline', description: 'Days remaining', example: '3' },
        { name: 'deadlineDate', description: 'Deadline date', example: 'Jan 15, 2025' },
        { name: 'contributionAmount', description: 'Amount needed', example: '100.00' },
      ],
      characterCount: 0,
      supportedLanguages: ['en', 'es', 'fr'],
    });

    // Template 5: Payout Reminder
    this.templates.set('PayoutReminder', {
      eventType: 'PayoutReminder',
      name: 'Payout Reminder',
      description: 'Reminder to admin for payout approval',
      header: '💳 Payout Ready',
      body:
        'Hello {{recipientName}},\n\n' +
        'The {{circleName}} payout is ready for distribution!\n\n' +
        '📋 *Payout Details:*\n' +
        '• Total Amount: {{totalContribution}}\n' +
        '• Members: {{memberCount}}\n' +
        '• Per Member: {{amountPerMember}}\n' +
        '• Scheduled: {{payoutDate}}\n\n' +
        'Please review and approve the payout.',
      footer: 'Njangi - Community Savings Made Simple',
      ctas: [
        { text: 'Approve Payout', action: 'approve', priority: 'primary' },
        { text: 'View Details', action: 'view', priority: 'secondary' },
      ],
      placeholders: [
        { name: 'recipientName', description: 'Admin name', example: 'Admin' },
        { name: 'circleName', description: 'Circle name', example: 'Circle Alpha' },
        { name: 'totalContribution', description: 'Total amount', example: '500.00' },
        { name: 'memberCount', description: 'Number of members', example: '5' },
        { name: 'amountPerMember', description: 'Per member amount', example: '100.00' },
        { name: 'payoutDate', description: 'Scheduled payout date', example: 'Jan 20, 2025' },
      ],
      characterCount: 0,
      supportedLanguages: ['en', 'es', 'fr'],
    });

    // Template 6: Payout Overdue
    this.templates.set('PayoutOverdue', {
      eventType: 'PayoutOverdue',
      name: 'Payout Overdue',
      description: 'Alert when payout approval is overdue',
      header: '🚨 Payout Overdue',
      body:
        'Alert {{recipientName}}!\n\n' +
        'The {{circleName}} payout is overdue for approval.\n\n' +
        '⚠️ *Action Required:*\n' +
        '• Total Amount: {{totalContribution}}\n' +
        '• Pending Members: {{pendingCount}}\n' +
        '• Status: OVERDUE\n\n' +
        'Please approve the payout immediately.',
      footer: 'Njangi - Community Savings Made Simple',
      ctas: [
        { text: 'Approve Now', action: 'approve', priority: 'primary' },
        { text: 'Contact Support', action: 'view', priority: 'secondary' },
      ],
      placeholders: [
        { name: 'recipientName', description: 'Admin name', example: 'Admin' },
        { name: 'circleName', description: 'Circle name', example: 'Circle Alpha' },
        { name: 'totalContribution', description: 'Total amount', example: '500.00' },
        { name: 'pendingCount', description: 'Members awaiting payout', example: '5' },
      ],
      characterCount: 0,
      supportedLanguages: ['en', 'es', 'fr'],
    });

    // Template 7: Contributor Overdue
    this.templates.set('ContributorOverdue', {
      eventType: 'ContributorOverdue',
      name: 'Contributor Overdue',
      description: 'Alert when contributor is overdue on payment',
      header: '⏱️ Contribution Overdue',
      body:
        'Hi {{recipientName}},\n\n' +
        'Your contribution to {{circleName}} is overdue!\n\n' +
        '⚠️ *Action Needed:*\n' +
        '• Amount Due: {{contributionAmount}}\n' +
        '• Circle: {{circleName}}\n' +
        '• Status: OVERDUE\n\n' +
        'Please contribute immediately to stay in good standing.',
      footer: 'Njangi - Community Savings Made Simple',
      ctas: [
        { text: 'Contribute Now', action: 'contribute', priority: 'primary' },
        { text: 'Get Help', action: 'view', priority: 'secondary' },
      ],
      placeholders: [
        { name: 'recipientName', description: 'Member name', example: 'John' },
        { name: 'circleName', description: 'Circle name', example: 'Circle Alpha' },
        { name: 'contributionAmount', description: 'Amount owed', example: '100.00' },
      ],
      characterCount: 0,
      supportedLanguages: ['en', 'es', 'fr'],
    });

    // Calculate character counts
    this.templates.forEach((template) => {
      template.characterCount = (template.header + template.body + (template.footer || '')).length;
    });
  }

  /**
   * Get template by event type
   */
  public getTemplate(eventType: string): MessageTemplate | null {
    const template = this.templates.get(eventType);
    if (!template) {
      appLogger.warn('Template not found', { eventType });
      return null;
    }
    return template;
  }

  /**
   * Get all templates
   */
  public getAllTemplates(): MessageTemplate[] {
    return Array.from(this.templates.values());
  }

  /**
   * Get template list for admin
   */
  public getTemplateList(): Array<{
    eventType: string;
    name: string;
    description: string;
    characterCount: number;
  }> {
    return Array.from(this.templates.values()).map((t) => ({
      eventType: t.eventType,
      name: t.name,
      description: t.description,
      characterCount: t.characterCount,
    }));
  }

  /**
   * Validate template exists and has required placeholders
   */
  public validateTemplate(eventType: string, requiredPlaceholders: string[]): boolean {
    const template = this.templates.get(eventType);
    if (!template) {
      return false;
    }

    const templatePlaceholderNames = template.placeholders.map((p) => p.name);
    for (const required of requiredPlaceholders) {
      if (!templatePlaceholderNames.includes(required)) {
        appLogger.warn('Missing required placeholder', {
          eventType,
          placeholder: required,
        });
        return false;
      }
    }

    return true;
  }

  /**
   * Get CTA actions for a template
   */
  public getCTAsForTemplate(eventType: string): Array<{
    text: string;
    action: string;
    priority: string;
  }> | null {
    const template = this.templates.get(eventType);
    if (!template || !template.ctas) {
      return null;
    }

    return template.ctas.map((cta) => ({
      text: cta.text,
      action: cta.action,
      priority: cta.priority,
    }));
  }

  /**
   * Get placeholders for a template
   */
  public getPlaceholdersForTemplate(eventType: string): TemplatePlaceholder[] | null {
    const template = this.templates.get(eventType);
    if (!template) {
      return null;
    }

    return template.placeholders;
  }

  /**
   * Check if template supports language
   */
  public supportsLanguage(eventType: string, language: string): boolean {
    const template = this.templates.get(eventType);
    if (!template) {
      return false;
    }

    return template.supportedLanguages.includes(language);
  }

  /**
   * Get template statistics
   */
  public getStatistics(): {
    totalTemplates: number;
    averageCharacters: number;
    minCharacters: number;
    maxCharacters: number;
    totalPlaceholders: number;
  } {
    const templates = Array.from(this.templates.values());
    if (templates.length === 0) {
      return {
        totalTemplates: 0,
        averageCharacters: 0,
        minCharacters: 0,
        maxCharacters: 0,
        totalPlaceholders: 0,
      };
    }

    const characterCounts = templates.map((t) => t.characterCount);
    const placeholderCounts = templates.map((t) => t.placeholders.length);

    return {
      totalTemplates: templates.length,
      averageCharacters: Math.floor(
        characterCounts.reduce((a, b) => a + b, 0) / characterCounts.length
      ),
      minCharacters: Math.min(...characterCounts),
      maxCharacters: Math.max(...characterCounts),
      totalPlaceholders: placeholderCounts.reduce((a, b) => a + b, 0),
    };
  }

  /**
   * Log template details
   */
  public logTemplateDetails(eventType: string): void {
    const template = this.templates.get(eventType);
    if (!template) {
      appLogger.warn('Template not found for logging', { eventType });
      return;
    }

    appLogger.info('Template Details', {
      eventType: template.eventType,
      name: template.name,
      header: template.header.substring(0, 50) + '...',
      bodyLength: template.body.length,
      characterCount: template.characterCount,
      placeholderCount: template.placeholders.length,
      ctaCount: template.ctas?.length || 0,
      languages: template.supportedLanguages.join(', '),
    });
  }
}

// Export singleton instance
export const whatsappTemplates = WhatsAppTemplatesService.getInstance();
