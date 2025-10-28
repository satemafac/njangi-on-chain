/**
 * GET/POST /api/whatsapp/integration
 * Integration monitoring and control API
 * Exposes complete system status and controls
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { appLogger } from '../../../utils/logger';
import { asyncHandler } from '../../../middleware/errorHandler';
import { backendMessageHandler } from '../../../services/backend-message-handler.service';
import { messageQueue } from '../../../services/message-queue.service';
import { webhookHandler } from '../../../services/webhook-handler.service';

interface IntegrationResponse {
  success: boolean;
  data?: any;
  error?: string;
}

const handler = asyncHandler(
  async (req: NextApiRequest, res: NextApiResponse<IntegrationResponse>) => {
    const { action = 'status' } = req.query as Record<string, string>;
    const queueStatsGlobal = messageQueue.getStats();
    const webhookStatsGlobal = webhookHandler.getStatistics();

    switch (action) {
      // GET system status
      case 'status':
        if (req.method !== 'GET') {
          return res.status(405).json({ success: false, error: 'Method not allowed' });
        }

        const systemStatus = backendMessageHandler.getSystemStatus();

        return res.status(200).json({
          success: true,
          data: systemStatus,
        });

      // GET metrics
      case 'metrics':
        if (req.method !== 'GET') {
          return res.status(405).json({ success: false, error: 'Method not allowed' });
        }

        const metrics = backendMessageHandler.getMetrics();

        return res.status(200).json({
          success: true,
          data: metrics,
        });

      // GET queue status
      case 'queue':
        if (req.method !== 'GET') {
          return res.status(405).json({ success: false, error: 'Method not allowed' });
        }

        const queueStatus = backendMessageHandler.getQueueStatus();

        return res.status(200).json({
          success: true,
          data: {
            pendingEvents: queueStatus.pendingEvents,
            isProcessing: queueStatus.isProcessing,
            queue: {
              size: queueStatus.queueStats?.pending || 0,
              processing: queueStatus.queueStats?.processing || 0,
            },
            alerts:
              queueStatus.queueStats?.pending > 1000 ? ['High queue backlog detected'] : [],
          },
        });

      // GET comprehensive health check
      case 'health':
        if (req.method !== 'GET') {
          return res.status(405).json({ success: false, error: 'Method not allowed' });
        }

        const systemStatus2 = backendMessageHandler.getSystemStatus();
        const queueStatus2 = backendMessageHandler.getQueueStatus();

        const health = {
          success: true,
          data: {
            healthy: queueStatsGlobal.successRate > 90 && webhookStatsGlobal.successRate > 90,
            timestamp: new Date().toISOString(),
            components: {
              backendMessageHandler: {
                running: systemStatus2.running,
                eventsProcessed: systemStatus2.metrics.eventsProcessed,
                averageFlowDuration: systemStatus2.metrics.averageFlowDuration,
              },
              messageQueue: {
                size: queueStatus2.queueStats?.pending || 0,
                processing: queueStatus2.queueStats?.processing || 0,
                successRate: queueStatsGlobal.successRate,
              },
              webhookHandler: {
                totalRecords: webhookStatsGlobal.totalRecords,
                successRate: webhookStatsGlobal.successRate,
                deliveryTime: webhookStatsGlobal.metrics.averageDeliveryTime,
              },
            },
            alerts: [] as string[],
          },
        };

        // Check for issues
        if (queueStatsGlobal.successRate < 90) {
          health.data.alerts.push('Queue success rate below 90%');
        }
        if (webhookStatsGlobal.successRate < 90) {
          health.data.alerts.push('Webhook success rate below 90%');
        }
        if (queueStatus2.queueStats?.pending > 1000) {
          health.data.alerts.push('Queue has over 1000 pending messages');
        }

        const statusCode = health.data.healthy ? 200 : 503;

        return res.status(statusCode).json(health);

      // POST start processing
      case 'start':
        if (req.method !== 'POST') {
          return res.status(405).json({ success: false, error: 'Method not allowed' });
        }

        try {
          backendMessageHandler.start(2000);
          appLogger.info('Integration processing started');

          return res.status(200).json({
            success: true,
            data: { started: true, message: 'Integration processing started' },
          });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);

          appLogger.error('Failed to start integration processing', { error: errorMessage });

          return res.status(500).json({
            success: false,
            error: errorMessage,
          });
        }

      // POST stop processing
      case 'stop':
        if (req.method !== 'POST') {
          return res.status(405).json({ success: false, error: 'Method not allowed' });
        }

        try {
          backendMessageHandler.stop();
          appLogger.info('Integration processing stopped');

          return res.status(200).json({
            success: true,
            data: { stopped: true, message: 'Integration processing stopped' },
          });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);

          appLogger.error('Failed to stop integration processing', { error: errorMessage });

          return res.status(500).json({
            success: false,
            error: errorMessage,
          });
        }

      // POST reset metrics
      case 'reset':
        if (req.method !== 'POST') {
          return res.status(405).json({ success: false, error: 'Method not allowed' });
        }

        backendMessageHandler.resetMetrics();
        messageQueue.resetStats();
        webhookHandler.resetMetrics();

        appLogger.info('All integration metrics reset');

        return res.status(200).json({
          success: true,
          data: { reset: true, message: 'All metrics reset' },
        });

      // GET detailed flow analysis
      case 'flow-analysis':
        if (req.method !== 'GET') {
          return res.status(405).json({ success: false, error: 'Method not allowed' });
        }

        const metrics2 = backendMessageHandler.getMetrics();
        const queueStats2 = messageQueue.getStats();
        const webhookStats2 = webhookHandler.getStatistics();

        const flowAnalysis = {
          pipeline: {
            events: {
              processed: metrics2.eventsProcessed,
              avgProcessTime: metrics2.averageFlowDuration,
            },
            recipients: {
              targeted: metrics2.recipientsProcessed,
              messages: metrics2.messagesQueued,
            },
            queue: {
              pending: queueStats2.pending,
              processing: queueStats2.processing,
              sent: queueStats2.sent,
              failed: queueStats2.failed,
              successRate: queueStats2.successRate,
            },
            webhook: {
              received: webhookStats2.metrics.totalReceived,
              processed: webhookStats2.metrics.totalProcessed,
              delivered: webhookStats2.metrics.delivered,
              read: webhookStats2.metrics.read,
              failed: webhookStats2.metrics.failed,
              avgDeliveryTime: webhookStats2.metrics.averageDeliveryTime,
              avgReadTime: webhookStats2.metrics.averageReadTime,
            },
          },
          bottlenecks: [] as string[],
          recommendations: [] as string[],
        };

        // Identify bottlenecks
        if (queueStats2.pending > 100) {
          flowAnalysis.bottlenecks.push(`Queue backlog: ${queueStats2.pending} pending messages`);
        }
        if (metrics2.averageFlowDuration > 10000) {
          flowAnalysis.bottlenecks.push(`Slow flow processing: ${metrics2.averageFlowDuration}ms average`);
        }
        if (queueStats2.successRate < 95) {
          flowAnalysis.bottlenecks.push(`Low queue success rate: ${queueStats2.successRate}%`);
        }

        // Recommendations
        if (flowAnalysis.bottlenecks.length > 0) {
          flowAnalysis.recommendations.push('Consider increasing max concurrent queue processors');
        }
        if (webhookStats2.metrics.averageReadTime > 300000) {
          flowAnalysis.recommendations.push('Consider implementing read-time optimizations');
        }

        return res.status(200).json({
          success: true,
          data: flowAnalysis,
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
