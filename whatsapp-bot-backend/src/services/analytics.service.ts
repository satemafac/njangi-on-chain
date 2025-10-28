/**
 * Analytics Service
 * Comprehensive message delivery analytics and reporting
 * Aggregates metrics from all pipeline stages
 */

import { appLogger } from '../utils/logger';
import { backendMessageHandler } from './backend-message-handler.service';
import { messageQueue } from './message-queue.service';
import { webhookHandler } from './webhook-handler.service';
import { actionLinkManager } from './action-link-manager.service';

// ============================================================================
// TYPES & INTERFACES
// ============================================================================

export interface TimeSeriesDataPoint {
  timestamp: number;
  value: number;
}

export interface DeliveryTrend {
  period: string; // "hourly", "daily", "weekly", "monthly"
  dataPoints: TimeSeriesDataPoint[];
  average: number;
  min: number;
  max: number;
  trend: 'improving' | 'degrading' | 'stable';
}

export interface PerformanceKPI {
  name: string;
  value: number;
  unit: string;
  target: number;
  status: 'excellent' | 'good' | 'warning' | 'critical';
  percentageOfTarget: number;
}

export interface PipelineStageMetrics {
  stage: 'context-aggregation' | 'message-rendering' | 'enqueueing' | 'sending' | 'delivery-tracking';
  totalAttempts: number;
  successCount: number;
  failureCount: number;
  successRate: number;
  averageDuration: number;
  minDuration: number;
  maxDuration: number;
}

export interface RecipientSegmentAnalytics {
  segment: string; // "admin", "member", "all"
  totalTargeted: number;
  totalMessaged: number;
  totalDelivered: number;
  totalRead: number;
  deliveryRate: number;
  readRate: number;
  averageDeliveryTime: number;
  averageReadTime: number;
}

export interface AnalyticsReport {
  generatedAt: string;
  period: {
    startTime: number;
    endTime: number;
    durationMs: number;
  };
  overview: {
    eventsProcessed: number;
    recipientsTargeted: number;
    messagesQueued: number;
    messagesSent: number;
    messagesDelivered: number;
    messagesRead: number;
    messagesFailed: number;
  };
  metrics: {
    overallSuccessRate: number;
    deliveryRate: number;
    readRate: number;
    averageFlowDuration: number;
    averageDeliveryTime: number;
    averageReadTime: number;
    queueSuccessRate: number;
    webhookSuccessRate: number;
  };
  kpis: PerformanceKPI[];
  pipelineStages: PipelineStageMetrics[];
  recipientSegments: RecipientSegmentAnalytics[];
  topPerformingCircles: Array<{ circleId: string; successRate: number; messageCount: number }>;
  failureAnalysis: {
    totalFailures: number;
    commonFailureReasons: Array<{ reason: string; count: number; percentage: number }>;
    failureRate: number;
  };
  linkAnalytics: {
    totalLinksGenerated: number;
    totalClicks: number;
    averageClickRate: number;
    topActions: Array<{ action: string; clicks: number; percentage: number }>;
  };
  recommendations: string[];
}

// ============================================================================
// ANALYTICS SERVICE
// ============================================================================

export class AnalyticsService {
  private historicalData: Map<string, TimeSeriesDataPoint[]> = new Map();
  private pipelineMetrics: Map<string, PipelineStageMetrics> = new Map();
  private failureLog: Array<{ timestamp: number; reason: string; circleId?: string }> = [];
  private maxHistoryPoints = 1000;

  constructor() {
    appLogger.info('Analytics Service initialized');
    this.initializePipelineMetrics();
  }

  // ==================== INITIALIZATION ====================

  /**
   * Initialize pipeline stage metrics
   */
  private initializePipelineMetrics(): void {
    const stages = [
      'context-aggregation',
      'message-rendering',
      'enqueueing',
      'sending',
      'delivery-tracking',
    ] as const;

    for (const stage of stages) {
      this.pipelineMetrics.set(stage, {
        stage,
        totalAttempts: 0,
        successCount: 0,
        failureCount: 0,
        successRate: 0,
        averageDuration: 0,
        minDuration: Infinity,
        maxDuration: 0,
      });
    }
  }

  // ==================== DATA RECORDING ====================

  /**
   * Record stage execution
   */
  public recordStageExecution(
    stage: 'context-aggregation' | 'message-rendering' | 'enqueueing' | 'sending' | 'delivery-tracking',
    duration: number,
    success: boolean,
    metadata?: Record<string, any>
  ): void {
    const metrics = this.pipelineMetrics.get(stage);
    if (!metrics) return;

    metrics.totalAttempts++;
    if (success) {
      metrics.successCount++;
    } else {
      metrics.failureCount++;
      if (metadata?.error) {
        this.failureLog.push({
          timestamp: Date.now(),
          reason: metadata.error,
          circleId: metadata.circleId,
        });

        // Keep history size manageable
        if (this.failureLog.length > this.maxHistoryPoints) {
          this.failureLog.shift();
        }
      }
    }

    metrics.averageDuration =
      (metrics.averageDuration * (metrics.totalAttempts - 1) + duration) / metrics.totalAttempts;
    metrics.minDuration = Math.min(metrics.minDuration, duration);
    metrics.maxDuration = Math.max(metrics.maxDuration, duration);
    metrics.successRate = Math.round((metrics.successCount / metrics.totalAttempts) * 100);
  }

  /**
   * Record time series data point
   */
  public recordMetric(metricName: string, value: number): void {
    if (!this.historicalData.has(metricName)) {
      this.historicalData.set(metricName, []);
    }

    const dataPoints = this.historicalData.get(metricName)!;
    dataPoints.push({
      timestamp: Date.now(),
      value,
    });

    // Keep history manageable
    if (dataPoints.length > this.maxHistoryPoints) {
      dataPoints.shift();
    }
  }

  // ==================== TREND ANALYSIS ====================

  /**
   * Get delivery trend over period
   */
  public getDeliveryTrend(period: 'hourly' | 'daily' | 'weekly' | 'monthly'): DeliveryTrend {
    const dataPoints = this.historicalData.get('delivery_rate') || [];

    let average = 0;
    let min = 100;
    let max = 0;

    if (dataPoints.length > 0) {
      const values = dataPoints.map((p) => p.value);
      average = Math.round(values.reduce((a, b) => a + b, 0) / values.length);
      min = Math.round(Math.min(...values));
      max = Math.round(Math.max(...values));
    }

    // Determine trend
    let trend: 'improving' | 'degrading' | 'stable' = 'stable';
    if (dataPoints.length >= 2) {
      const recent = dataPoints.slice(-5);
      const older = dataPoints.slice(0, 5);

      if (recent.length > 0 && older.length > 0) {
        const recentAvg = recent.reduce((a, b) => a + b.value, 0) / recent.length;
        const olderAvg = older.reduce((a, b) => a + b.value, 0) / older.length;

        if (recentAvg > olderAvg + 5) trend = 'improving';
        else if (recentAvg < olderAvg - 5) trend = 'degrading';
      }
    }

    return {
      period,
      dataPoints,
      average,
      min,
      max,
      trend,
    };
  }

  /**
   * Get performance KPIs
   */
  public getPerformanceKPIs(): PerformanceKPI[] {
    const metrics = backendMessageHandler.getMetrics();
    const queueStats = messageQueue.getStats();
    const webhookStats = webhookHandler.getStatistics();

    const kpis: PerformanceKPI[] = [
      {
        name: 'Overall Success Rate',
        value: metrics.successRate,
        unit: '%',
        target: 95,
        status: this.getStatus(metrics.successRate, [90, 95, 98], false),
        percentageOfTarget: Math.round((metrics.successRate / 95) * 100),
      },
      {
        name: 'Queue Success Rate',
        value: queueStats.successRate,
        unit: '%',
        target: 95,
        status: this.getStatus(queueStats.successRate, [90, 95, 98], false),
        percentageOfTarget: Math.round((queueStats.successRate / 95) * 100),
      },
      {
        name: 'Webhook Success Rate',
        value: webhookStats.successRate,
        unit: '%',
        target: 98,
        status: this.getStatus(webhookStats.successRate, [95, 98, 99], false),
        percentageOfTarget: Math.round((webhookStats.successRate / 98) * 100),
      },
      {
        name: 'Average Flow Duration',
        value: metrics.averageFlowDuration,
        unit: 'ms',
        target: 5000,
        status: this.getStatus(metrics.averageFlowDuration, [5000, 10000, 20000], true),
        percentageOfTarget: Math.round((metrics.averageFlowDuration / 5000) * 100),
      },
      {
        name: 'Average Delivery Time',
        value: webhookStats.metrics.averageDeliveryTime,
        unit: 'ms',
        target: 3000,
        status: this.getStatus(
          webhookStats.metrics.averageDeliveryTime,
          [3000, 5000, 10000],
          true
        ),
        percentageOfTarget: Math.round(
          (webhookStats.metrics.averageDeliveryTime / 3000) * 100
        ),
      },
    ];

    return kpis;
  }

  /**
   * Get pipeline stage metrics
   */
  public getPipelineMetrics(): PipelineStageMetrics[] {
    return Array.from(this.pipelineMetrics.values());
  }

  /**
   * Get recipient segment analytics
   */
  public getRecipientSegmentAnalytics(): RecipientSegmentAnalytics[] {
    const metrics = backendMessageHandler.getMetrics();

    return [
      {
        segment: 'all',
        totalTargeted: metrics.recipientsProcessed,
        totalMessaged: metrics.messagesQueued,
        totalDelivered: 0,
        totalRead: 0,
        deliveryRate: 0,
        readRate: 0,
        averageDeliveryTime: 0,
        averageReadTime: 0,
      },
    ];
  }

  /**
   * Analyze failures
   */
  public getFailureAnalysis(): {
    totalFailures: number;
    commonFailureReasons: Array<{ reason: string; count: number; percentage: number }>;
    failureRate: number;
  } {
    const reasonCounts = new Map<string, number>();

    for (const entry of this.failureLog) {
      const count = reasonCounts.get(entry.reason) || 0;
      reasonCounts.set(entry.reason, count + 1);
    }

    const commonFailureReasons = Array.from(reasonCounts.entries())
      .map(([reason, count]) => ({
        reason,
        count,
        percentage: Math.round((count / this.failureLog.length) * 100),
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    const metrics = backendMessageHandler.getMetrics();
    const failureRate = metrics.messagesQueued > 0 
      ? Math.round((metrics.messagesFailed / metrics.messagesQueued) * 100)
      : 0;

    return {
      totalFailures: this.failureLog.length,
      commonFailureReasons,
      failureRate,
    };
  }

  /**
   * Get link analytics
   */
  public getLinkAnalytics(): {
    totalLinksGenerated: number;
    totalClicks: number;
    averageClickRate: number;
    topActions: Array<{ action: string; clicks: number; percentage: number }>;
  } {
    const linkMetrics = actionLinkManager.getMetrics();

    const averageClickRate =
      linkMetrics.linksGenerated > 0
        ? Math.round((linkMetrics.totalClicks / linkMetrics.linksGenerated) * 100)
        : 0;

    return {
      totalLinksGenerated: linkMetrics.linksGenerated,
      totalClicks: linkMetrics.totalClicks,
      averageClickRate,
      topActions: [],
    };
  }

  // ==================== REPORT GENERATION ====================

  /**
   * Generate comprehensive analytics report
   */
  public generateReport(startTime?: number, endTime?: number): AnalyticsReport {
    const now = Date.now();
    const start = startTime || now - 24 * 60 * 60 * 1000; // Default: last 24h
    const end = endTime || now;

    const metrics = backendMessageHandler.getMetrics();
    const queueStats = messageQueue.getStats();
    const webhookStats = webhookHandler.getStatistics();
    const failureAnalysis = this.getFailureAnalysis();
    const linkAnalytics = this.getLinkAnalytics();
    const kpis = this.getPerformanceKPIs();
    const pipelineStages = this.getPipelineMetrics();
    const recipientSegments = this.getRecipientSegmentAnalytics();

    const report: AnalyticsReport = {
      generatedAt: new Date().toISOString(),
      period: {
        startTime: start,
        endTime: end,
        durationMs: end - start,
      },
      overview: {
        eventsProcessed: metrics.eventsProcessed,
        recipientsTargeted: metrics.recipientsProcessed,
        messagesQueued: metrics.messagesQueued,
        messagesSent: metrics.messagesSent,
        messagesDelivered: webhookStats.metrics.delivered,
        messagesRead: webhookStats.metrics.read,
        messagesFailed: metrics.messagesFailed,
      },
      metrics: {
        overallSuccessRate: metrics.successRate,
        deliveryRate: Math.round(
          (webhookStats.metrics.delivered / metrics.messagesQueued) * 100 || 0
        ),
        readRate: Math.round((webhookStats.metrics.read / metrics.messagesQueued) * 100 || 0),
        averageFlowDuration: metrics.averageFlowDuration,
        averageDeliveryTime: webhookStats.metrics.averageDeliveryTime,
        averageReadTime: webhookStats.metrics.averageReadTime,
        queueSuccessRate: queueStats.successRate,
        webhookSuccessRate: webhookStats.successRate,
      },
      kpis,
      pipelineStages,
      recipientSegments,
      topPerformingCircles: [], // TODO: Implement circle tracking
      failureAnalysis,
      linkAnalytics,
      recommendations: this.generateRecommendations(metrics, queueStats, webhookStats, kpis),
    };

    appLogger.info('Analytics report generated', {
      eventsProcessed: report.overview.eventsProcessed,
      successRate: report.metrics.overallSuccessRate,
    });

    return report;
  }

  // ==================== HELPER METHODS ====================

  /**
   * Determine status based on value and thresholds
   */
  private getStatus(
    value: number,
    thresholds: [number, number, number],
    isInverse = false
  ): 'excellent' | 'good' | 'warning' | 'critical' {
    if (isInverse) {
      // For metrics where lower is better (time, duration)
      if (value <= thresholds[0]) return 'excellent';
      if (value <= thresholds[1]) return 'good';
      if (value <= thresholds[2]) return 'warning';
      return 'critical';
    } else {
      // For metrics where higher is better (success rate)
      if (value >= thresholds[2]) return 'excellent';
      if (value >= thresholds[1]) return 'good';
      if (value >= thresholds[0]) return 'warning';
      return 'critical';
    }
  }

  /**
   * Generate recommendations
   */
  private generateRecommendations(
    metrics: any,
    queueStats: any,
    webhookStats: any,
    kpis: PerformanceKPI[]
  ): string[] {
    const recommendations: string[] = [];

    // Check KPIs and generate recommendations
    for (const kpi of kpis) {
      if (kpi.status === 'critical') {
        recommendations.push(`⚠️ CRITICAL: ${kpi.name} is ${kpi.value}${kpi.unit} (target: ${kpi.target}${kpi.unit})`);
      } else if (kpi.status === 'warning') {
        recommendations.push(`⚠️ ${kpi.name} is below target (${kpi.value}${kpi.unit} vs ${kpi.target}${kpi.unit})`);
      }
    }

    // Queue recommendations
    if (queueStats.pending > 100) {
      recommendations.push('Consider increasing max concurrent queue processors to reduce backlog');
    }

    // Webhook recommendations
    if (webhookStats.metrics.averageReadTime > 300000) {
      recommendations.push('Consider implementing message read optimization strategies');
    }

    // Failure analysis recommendations
    if (metrics.messagesFailed > metrics.messagesSent * 0.05) {
      recommendations.push(
        `Review failure rate (${Math.round((metrics.messagesFailed / metrics.messagesQueued) * 100)}%) and improve error handling`
      );
    }

    // Link analytics recommendations
    const linkStats = this.getLinkAnalytics();
    if (linkStats.averageClickRate < 5) {
      recommendations.push('Low click-through rate detected. Consider improving action link visibility in messages');
    }

    if (recommendations.length === 0) {
      recommendations.push('✅ All systems operating within normal parameters');
    }

    return recommendations;
  }
}

// ============================================================================
// SINGLETON INSTANCE
// ============================================================================

let instance: AnalyticsService | null = null;

export function getAnalytics(): AnalyticsService {
  if (!instance) {
    instance = new AnalyticsService();
  }
  return instance;
}

export const analytics = getAnalytics();
