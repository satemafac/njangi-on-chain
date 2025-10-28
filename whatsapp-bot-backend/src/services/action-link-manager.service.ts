/**
 * Action Link Manager Service
 * Manages secure, trackable action links with shortening, expiration, and analytics
 * Provides centralized link generation and click tracking for all WhatsApp CTAs
 */

import { appLogger } from '../utils/logger';
import { v4 as uuidv4 } from 'uuid';

/**
 * Action link metadata
 */
export interface ActionLink {
  id: string;
  originalUrl: string;
  shortUrl?: string;
  action: 'contribute' | 'approve' | 'status' | 'view' | 'join' | 'leave';
  circleId: string;
  eventType: string;
  recipientAddress?: string;
  createdAt: number;
  expiresAt?: number;
  maxClicks?: number;
  clicks: number;
  isActive: boolean;
}

/**
 * Link click event
 */
export interface LinkClickEvent {
  linkId: string;
  timestamp: number;
  userAgent?: string;
  referrer?: string;
  ipHash?: string;
}

/**
 * Link analytics data
 */
export interface LinkAnalytics {
  linkId: string;
  totalClicks: number;
  uniqueClicks: number;
  clickedAt: number[];
  conversionRate: number;
  lastClickedAt?: number;
}

/**
 * CTA configuration
 */
export interface CTAConfig {
  action: string;
  text: string;
  priority: 'primary' | 'secondary';
  trackingEnabled: boolean;
  expirationHours?: number;
  maxClicks?: number;
}

export class ActionLinkManagerService {
  private static instance: ActionLinkManagerService;
  private links: Map<string, ActionLink> = new Map();
  private analytics: Map<string, LinkClickEvent[]> = new Map();
  private shortUrlMap: Map<string, string> = new Map(); // shortUrl -> originalUrl
  private clickEvents: LinkClickEvent[] = [];
  private readonly maxClickHistory = 100000;
  private readonly baseUrl = 'https://app.njangi.com';
  private readonly shortBaseUrl = 'https://nj.link'; // Short domain
  private readonly expirationDefaults = {
    contribute: 24, // hours
    approve: 12,
    status: 72,
    view: 72,
    join: 30 * 24,
    leave: 12,
  };
  private readonly maxClicksDefaults = {
    contribute: 1, // One-time use after clicking
    approve: 3,
    status: 10,
    view: 100,
    join: 5,
    leave: 1,
  };
  private linkMetrics = {
    linksGenerated: 0,
    linksExpired: 0,
    linksClicked: 0,
    totalClicks: 0,
    averageClicksPerLink: 0,
  };

  private constructor() {
    appLogger.info('Action Link Manager Service initialized');
    // Start cleanup task
    this.startCleanupTask();
  }

  /**
   * Get singleton instance
   */
  public static getInstance(): ActionLinkManagerService {
    if (!ActionLinkManagerService.instance) {
      ActionLinkManagerService.instance = new ActionLinkManagerService();
    }
    return ActionLinkManagerService.instance;
  }

  /**
   * Generate an action link
   */
  public generateLink(
    action: string,
    circleId: string,
    eventType: string,
    recipientAddress?: string,
    expirationHours?: number,
    maxClicks?: number
  ): ActionLink {
    const linkId = uuidv4();
    const now = Date.now();

    // Build original URL
    const originalUrl = this.buildActionUrl(action, circleId, linkId, eventType);

    // Determine expiration
    const expHours = expirationHours || this.expirationDefaults[action as keyof typeof this.expirationDefaults] || 24;
    const expiresAt = now + expHours * 60 * 60 * 1000;

    // Determine max clicks
    const maxClks = maxClicks || this.maxClicksDefaults[action as keyof typeof this.maxClicksDefaults] || 10;

    const link: ActionLink = {
      id: linkId,
      originalUrl,
      action: action as any,
      circleId,
      eventType,
      recipientAddress,
      createdAt: now,
      expiresAt,
      maxClicks: maxClks,
      clicks: 0,
      isActive: true,
    };

    // Store link
    this.links.set(linkId, link);

    // Generate short URL
    link.shortUrl = this.generateShortUrl(linkId);
    this.shortUrlMap.set(link.shortUrl, originalUrl);

    // Initialize analytics
    this.analytics.set(linkId, []);

    // Update metrics
    this.linkMetrics.linksGenerated++;

    appLogger.debug('Action link generated', {
      linkId,
      action,
      circleId,
      expiresAt: new Date(expiresAt).toISOString(),
      maxClicks: maxClks,
    });

    return link;
  }

  /**
   * Generate multiple CTA links for a message
   */
  public generateCTALinks(
    circleId: string,
    eventType: string,
    ctas: CTAConfig[],
    recipientAddress?: string
  ): Array<{
    text: string;
    action: string;
    url: string;
    shortUrl: string;
    trackingId: string;
  }> {
    return ctas.map((cta) => {
      const link = this.generateLink(
        cta.action,
        circleId,
        eventType,
        recipientAddress,
        cta.expirationHours,
        cta.maxClicks
      );

      return {
        text: cta.text,
        action: cta.action,
        url: link.originalUrl,
        shortUrl: link.shortUrl || link.originalUrl,
        trackingId: link.id,
      };
    });
  }

  /**
   * Record a link click
   */
  public recordClick(
    linkId: string,
    userAgent?: string,
    referrer?: string,
    ipHash?: string
  ): boolean {
    const link = this.links.get(linkId);

    if (!link) {
      appLogger.warn('Click recorded for non-existent link', { linkId });
      return false;
    }

    // Check if link is expired
    if (link.expiresAt && Date.now() > link.expiresAt) {
      link.isActive = false;
      this.linkMetrics.linksExpired++;
      appLogger.warn('Click on expired link', { linkId });
      return false;
    }

    // Check if max clicks reached
    if (link.maxClicks && link.clicks >= link.maxClicks) {
      link.isActive = false;
      appLogger.warn('Link max clicks reached', { linkId, maxClicks: link.maxClicks });
      return false;
    }

    // Record click
    const clickEvent: LinkClickEvent = {
      linkId,
      timestamp: Date.now(),
      userAgent,
      referrer,
      ipHash,
    };

    link.clicks++;
    this.linkMetrics.totalClicks++;
    this.linkMetrics.linksClicked++;

    // Store click event
    const events = this.analytics.get(linkId) || [];
    events.push(clickEvent);
    this.analytics.set(linkId, events);

    // Store in global click history
    this.clickEvents.push(clickEvent);
    if (this.clickEvents.length > this.maxClickHistory) {
      this.clickEvents = this.clickEvents.slice(-this.maxClickHistory);
    }

    // Deactivate if max clicks reached
    if (link.maxClicks && link.clicks >= link.maxClicks) {
      link.isActive = false;
    }

    appLogger.debug('Link click recorded', {
      linkId,
      action: link.action,
      clicks: link.clicks,
      maxClicks: link.maxClicks,
    });

    return true;
  }

  /**
   * Resolve a short URL to original URL
   */
  public resolveShortUrl(shortUrl: string): string | null {
    return this.shortUrlMap.get(shortUrl) || null;
  }

  /**
   * Get link details
   */
  public getLink(linkId: string): ActionLink | null {
    const link = this.links.get(linkId);
    if (!link) {
      return null;
    }

    // Check expiration
    if (link.expiresAt && Date.now() > link.expiresAt) {
      link.isActive = false;
    }

    return link;
  }

  /**
   * Get link analytics
   */
  public getLinkAnalytics(linkId: string): LinkAnalytics | null {
    const link = this.links.get(linkId);
    if (!link) {
      return null;
    }

    const clicks = this.analytics.get(linkId) || [];
    const uniqueIPs = new Set(clicks.map((c) => c.ipHash).filter(Boolean)).size;

    return {
      linkId,
      totalClicks: link.clicks,
      uniqueClicks: uniqueIPs,
      clickedAt: clicks.map((c) => c.timestamp),
      conversionRate: link.clicks > 0 ? 100 : 0,
      lastClickedAt: clicks.length > 0 ? clicks[clicks.length - 1].timestamp : undefined,
    };
  }

  /**
   * Get circle link statistics
   */
  public getCircleStatistics(circleId: string): {
    totalLinks: number;
    activeLinks: number;
    totalClicks: number;
    averageClicksPerLink: number;
    byAction: Record<string, { count: number; clicks: number }>;
  } {
    const circleLinks = Array.from(this.links.values()).filter((l) => l.circleId === circleId);

    const byAction: Record<string, { count: number; clicks: number }> = {};
    let totalClicks = 0;

    for (const link of circleLinks) {
      if (!byAction[link.action]) {
        byAction[link.action] = { count: 0, clicks: 0 };
      }
      byAction[link.action].count++;
      byAction[link.action].clicks += link.clicks;
      totalClicks += link.clicks;
    }

    const activeLinks = circleLinks.filter((l) => l.isActive).length;

    return {
      totalLinks: circleLinks.length,
      activeLinks,
      totalClicks,
      averageClicksPerLink: circleLinks.length > 0 ? totalClicks / circleLinks.length : 0,
      byAction,
    };
  }

  /**
   * Get event type link statistics
   */
  public getEventTypeStatistics(eventType: string): {
    totalLinks: number;
    activeLinks: number;
    totalClicks: number;
    clickThroughRate: number;
  } {
    const eventLinks = Array.from(this.links.values()).filter((l) => l.eventType === eventType);

    const activeLinks = eventLinks.filter((l) => l.isActive).length;
    const totalClicks = eventLinks.reduce((sum, l) => sum + l.clicks, 0);

    return {
      totalLinks: eventLinks.length,
      activeLinks,
      totalClicks,
      clickThroughRate: eventLinks.length > 0 ? (totalClicks / eventLinks.length) * 100 : 0,
    };
  }

  /**
   * Validate link is active and not expired
   */
  public isLinkValid(linkId: string): boolean {
    const link = this.links.get(linkId);

    if (!link) {
      return false;
    }

    // Check expiration
    if (link.expiresAt && Date.now() > link.expiresAt) {
      link.isActive = false;
      return false;
    }

    // Check max clicks
    if (link.maxClicks && link.clicks >= link.maxClicks) {
      link.isActive = false;
      return false;
    }

    return link.isActive;
  }

  /**
   * Deactivate a link
   */
  public deactivateLink(linkId: string): boolean {
    const link = this.links.get(linkId);
    if (!link) {
      return false;
    }

    link.isActive = false;
    appLogger.debug('Link deactivated', { linkId, action: link.action });
    return true;
  }

  /**
   * Get all active links for a circle
   */
  public getCircleLinks(circleId: string): ActionLink[] {
    return Array.from(this.links.values())
      .filter((l) => l.circleId === circleId && l.isActive)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * Get metrics
   */
  public getMetrics(): {
    linksGenerated: number;
    linksExpired: number;
    linksClicked: number;
    totalClicks: number;
    averageClicksPerLink: number;
    activeLinks: number;
    activeShortUrls: number;
  } {
    let activeLinks = 0;
    let activeShortUrls = 0;
    for (const [, link] of this.links.entries()) {
      if (!link.isActive) {
        continue;
      }
      activeLinks++;
      activeShortUrls++;
    }

    return {
      linksGenerated: this.linkMetrics.linksGenerated,
      linksExpired: this.linkMetrics.linksExpired,
      linksClicked: this.linkMetrics.linksClicked,
      totalClicks: this.linkMetrics.totalClicks,
      averageClicksPerLink:
        this.linkMetrics.linksClicked > 0 ? this.linkMetrics.totalClicks / this.linkMetrics.linksClicked : 0,
      activeLinks,
      activeShortUrls,
    };
  }

  /**
   * Private helper: Build action URL
   */
  private buildActionUrl(
    action: string,
    circleId: string,
    linkId: string,
    eventType: string
  ): string {
    const slug = circleId.replace(/\s+/g, '_').toLowerCase();
    const params = new URLSearchParams({
      linkId,
      utm_source: 'whatsapp',
      utm_medium: 'notification',
      utm_campaign: eventType,
    });

    switch (action) {
      case 'contribute':
        return `${this.baseUrl}/circle/${slug}/quick-contribute?${params}`;
      case 'approve':
        return `${this.baseUrl}/circle/${slug}/approve-payout?${params}`;
      case 'status':
        return `${this.baseUrl}/circle/${slug}/quick-status?${params}`;
      case 'view':
        return `${this.baseUrl}/circle/${slug}?${params}`;
      case 'join':
        return `${this.baseUrl}/circle/${slug}/join?${params}`;
      case 'leave':
        return `${this.baseUrl}/circle/${slug}/leave?${params}`;
      default:
        return `${this.baseUrl}/circle/${slug}?${params}`;
    }
  }

  /**
   * Private helper: Generate short URL
   */
  private generateShortUrl(linkId: string): string {
    // Use first 6 chars of UUID for short code
    const shortCode = linkId.substring(0, 6).toUpperCase();
    return `${this.shortBaseUrl}/${shortCode}`;
  }

  /**
   * Start periodic cleanup task
   */
  private startCleanupTask(): void {
    // Run every hour
    setInterval(() => {
      this.cleanupExpiredLinks();
    }, 60 * 60 * 1000);
  }

  /**
   * Cleanup expired links
   */
  private cleanupExpiredLinks(): void {
    const now = Date.now();
    let expiredCount = 0;

    for (const [, link] of this.links.entries()) {
      if (link.expiresAt && now > link.expiresAt) {
        // Keep link for history but mark inactive
        link.isActive = false;
        expiredCount++;
      }
    }

    if (expiredCount > 0) {
      appLogger.info('Expired links cleaned up', {
        expiredCount,
        remainingLinks: this.links.size,
      });
    }
  }

  /**
   * Clear cache (testing only)
   */
  public clearCache(): void {
    this.links.clear();
    this.analytics.clear();
    this.shortUrlMap.clear();
    this.clickEvents = [];
    appLogger.debug('Link manager cache cleared');
  }

  /**
   * Reset metrics (testing only)
   */
  public resetMetrics(): void {
    this.linkMetrics = {
      linksGenerated: 0,
      linksExpired: 0,
      linksClicked: 0,
      totalClicks: 0,
      averageClicksPerLink: 0,
    };
    appLogger.debug('Metrics reset');
  }

  /**
   * Export link data for backup
   */
  public exportLinkData(): {
    links: Array<any>;
    analytics: Array<any>;
    metrics: any;
  } {
    return {
      links: Array.from(this.links.values()),
      analytics: Array.from(this.analytics.entries()).map(([linkId, events]) => ({
        linkId,
        events,
      })),
      metrics: this.linkMetrics,
    };
  }

  /**
   * Get top clicked links
   */
  public getTopClickedLinks(limit: number = 10): Array<ActionLink & { clicks: number }> {
    return Array.from(this.links.values())
      .sort((a, b) => b.clicks - a.clicks)
      .slice(0, limit)
      .map((l) => ({ ...l, clicks: l.clicks }));
  }

  /**
   * Get top clicked circles
   */
  public getTopClickedCircles(limit: number = 10): Array<{
    circleId: string;
    totalClicks: number;
    linkCount: number;
  }> {
    const circleStats = new Map<
      string,
      { totalClicks: number; linkCount: number }
    >();

    for (const link of this.links.values()) {
      if (!circleStats.has(link.circleId)) {
        circleStats.set(link.circleId, { totalClicks: 0, linkCount: 0 });
      }
      const stats = circleStats.get(link.circleId)!;
      stats.totalClicks += link.clicks;
      stats.linkCount++;
    }

    return Array.from(circleStats.entries())
      .map(([circleId, stats]) => ({ circleId, ...stats }))
      .sort((a, b) => b.totalClicks - a.totalClicks)
      .slice(0, limit);
  }
}

// Export singleton instance
export const actionLinkManager = ActionLinkManagerService.getInstance();
