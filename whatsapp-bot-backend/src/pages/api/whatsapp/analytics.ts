/**
 * GET /api/whatsapp/analytics
 * Analytics reporting and data API
 * Provides comprehensive metrics, reports, and trend analysis
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { appLogger } from '../../../utils/logger';
import { asyncHandler } from '../../../middleware/errorHandler';
import { analytics } from '../../../services/analytics.service';

interface AnalyticsResponse {
  success: boolean;
  data?: any;
  error?: string;
}

const handler = asyncHandler(
  async (req: NextApiRequest, res: NextApiResponse<AnalyticsResponse>) => {
    const { action = 'report' } = req.query as Record<string, string>;

    switch (action) {
      // GET comprehensive analytics report
      case 'report':
        if (req.method !== 'GET') {
          return res.status(405).json({ success: false, error: 'Method not allowed' });
        }

        try {
          const startTime = req.query.startTime
            ? parseInt(req.query.startTime as string, 10)
            : undefined;
          const endTime = req.query.endTime ? parseInt(req.query.endTime as string, 10) : undefined;

          const report = analytics.generateReport(startTime, endTime);

          return res.status(200).json({
            success: true,
            data: report,
          });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);

          appLogger.error('Failed to generate analytics report', { error: errorMessage });

          return res.status(500).json({
            success: false,
            error: errorMessage,
          });
        }

      // GET performance KPIs
      case 'kpis':
        if (req.method !== 'GET') {
          return res.status(405).json({ success: false, error: 'Method not allowed' });
        }

        const kpis = analytics.getPerformanceKPIs();

        return res.status(200).json({
          success: true,
          data: {
            kpis,
            summary: {
              excellentCount: kpis.filter((k) => k.status === 'excellent').length,
              goodCount: kpis.filter((k) => k.status === 'good').length,
              warningCount: kpis.filter((k) => k.status === 'warning').length,
              criticalCount: kpis.filter((k) => k.status === 'critical').length,
            },
          },
        });

      // GET delivery trends
      case 'trends': {
        if (req.method !== 'GET') {
          return res.status(405).json({ success: false, error: 'Method not allowed' });
        }

        const period = (req.query.period as string) || 'daily';
        const trend = analytics.getDeliveryTrend(
          period as 'hourly' | 'daily' | 'weekly' | 'monthly'
        );

        return res.status(200).json({
          success: true,
          data: trend,
        });
      }

      // GET pipeline stage metrics
      case 'pipeline':
        if (req.method !== 'GET') {
          return res.status(405).json({ success: false, error: 'Method not allowed' });
        }

        const pipelineMetrics = analytics.getPipelineMetrics();

        return res.status(200).json({
          success: true,
          data: {
            stages: pipelineMetrics,
            summary: {
              totalAttempts: pipelineMetrics.reduce((sum, m) => sum + m.totalAttempts, 0),
              totalSuccess: pipelineMetrics.reduce((sum, m) => sum + m.successCount, 0),
              totalFailure: pipelineMetrics.reduce((sum, m) => sum + m.failureCount, 0),
              overallSuccessRate: Math.round(
                (pipelineMetrics.reduce((sum, m) => sum + m.successCount, 0) /
                  pipelineMetrics.reduce((sum, m) => sum + m.totalAttempts, 0)) *
                  100
              ),
            },
          },
        });

      // GET recipient segment analytics
      case 'segments':
        if (req.method !== 'GET') {
          return res.status(405).json({ success: false, error: 'Method not allowed' });
        }

        const segments = analytics.getRecipientSegmentAnalytics();

        return res.status(200).json({
          success: true,
          data: segments,
        });

      // GET failure analysis
      case 'failures':
        if (req.method !== 'GET') {
          return res.status(405).json({ success: false, error: 'Method not allowed' });
        }

        const failureAnalysis = analytics.getFailureAnalysis();

        return res.status(200).json({
          success: true,
          data: failureAnalysis,
        });

      // GET link analytics
      case 'links':
        if (req.method !== 'GET') {
          return res.status(405).json({ success: false, error: 'Method not allowed' });
        }

        const linkAnalytics = analytics.getLinkAnalytics();

        return res.status(200).json({
          success: true,
          data: linkAnalytics,
        });

      // GET executive summary
      case 'summary':
        if (req.method !== 'GET') {
          return res.status(405).json({ success: false, error: 'Method not allowed' });
        }

        const report = analytics.generateReport();
        const kpis2 = analytics.getPerformanceKPIs();

        const summary = {
          timestamp: new Date().toISOString(),
          overview: report.overview,
          keyMetrics: {
            successRate: report.metrics.overallSuccessRate,
            deliveryRate: report.metrics.deliveryRate,
            readRate: report.metrics.readRate,
          },
          kpis: kpis2.map((k) => ({
            name: k.name,
            value: k.value,
            unit: k.unit,
            status: k.status,
          })),
          recommendations: report.recommendations.slice(0, 5),
          criticalAlerts: report.recommendations
            .filter((r) => r.includes('CRITICAL'))
            .slice(0, 3),
        };

        return res.status(200).json({
          success: true,
          data: summary,
        });

      // GET comparison (previous period vs current)
      case 'comparison': {
        if (req.method !== 'GET') {
          return res.status(405).json({ success: false, error: 'Method not allowed' });
        }

        const now = Date.now();
        const period = parseInt((req.query.period as string) || '86400000', 10); // Default 24h

        const currentReport = analytics.generateReport(now - period, now);
        const previousReport = analytics.generateReport(now - period * 2, now - period);

        const comparison = {
          current: currentReport.metrics,
          previous: previousReport.metrics,
          deltas: {
            successRate:
              currentReport.metrics.overallSuccessRate - previousReport.metrics.overallSuccessRate,
            deliveryRate:
              currentReport.metrics.deliveryRate - previousReport.metrics.deliveryRate,
            readRate: currentReport.metrics.readRate - previousReport.metrics.readRate,
            flowDuration:
              currentReport.metrics.averageFlowDuration - previousReport.metrics.averageFlowDuration,
            deliveryTime:
              currentReport.metrics.averageDeliveryTime - previousReport.metrics.averageDeliveryTime,
          },
          trends: {
            successRate:
              currentReport.metrics.overallSuccessRate > previousReport.metrics.overallSuccessRate
                ? 'improving'
                : 'degrading',
            deliveryRate:
              currentReport.metrics.deliveryRate > previousReport.metrics.deliveryRate
                ? 'improving'
                : 'degrading',
            readRate:
              currentReport.metrics.readRate > previousReport.metrics.readRate
                ? 'improving'
                : 'degrading',
          },
        };

        return res.status(200).json({
          success: true,
          data: comparison,
        });
      }

      // GET recommendations
      case 'recommendations':
        if (req.method !== 'GET') {
          return res.status(405).json({ success: false, error: 'Method not allowed' });
        }

        const reportWithRecs = analytics.generateReport();

        return res.status(200).json({
          success: true,
          data: {
            total: reportWithRecs.recommendations.length,
            recommendations: reportWithRecs.recommendations,
            criticalCount: reportWithRecs.recommendations.filter((r) => r.includes('CRITICAL'))
              .length,
            warningCount: reportWithRecs.recommendations.filter((r) => r.includes('⚠️')).length,
            infoCount: reportWithRecs.recommendations.filter((r) => r.includes('✅')).length,
          },
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
