import { NextApiRequest, NextApiResponse } from 'next';
import { automationMonitoringService } from '../../../services/automation-monitoring.service';
import { automationAuditLogger } from '../../../services/automation-audit-logger.service';

// API response types
interface DashboardResponse {
  success: boolean;
  data?: Record<string, unknown>;
  error?: string;
  timestamp: string;
}

/**
 * 📊 Automation Dashboard API
 * 
 * Provides real-time monitoring data for the automation dashboard:
 * - GET: Returns comprehensive dashboard metrics
 * - POST: Updates monitoring configuration
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<DashboardResponse>
) {
  const timestamp = new Date().toISOString();

  try {
    switch (req.method) {
      case 'GET':
        await handleGetDashboard(req, res, timestamp);
        break;
      
      case 'POST':
        await handleUpdateConfig(req, res, timestamp);
        break;
      
      default:
        res.setHeader('Allow', ['GET', 'POST']);
        res.status(405).json({
          success: false,
          error: 'Method not allowed',
          timestamp
        });
    }
  } catch (error) {
    console.error('Dashboard API error:', error);
    
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Internal server error',
      timestamp
    });
  }
}

/**
 * Handle GET request - Return dashboard data
 */
async function handleGetDashboard(
  req: NextApiRequest,
  res: NextApiResponse<DashboardResponse>,
  timestamp: string
): Promise<void> {
  const { timeRange, hours } = req.query;
  
  // Parse time range
  let timeRangeFilter: { start: Date; end: Date } | undefined;
  
  if (timeRange && typeof timeRange === 'string') {
    try {
      const parsed = JSON.parse(timeRange);
      timeRangeFilter = {
        start: new Date(parsed.start),
        end: new Date(parsed.end)
      };
    } catch {
      // Invalid time range format
    }
  } else if (hours && typeof hours === 'string') {
    const hoursNum = parseInt(hours, 10);
    if (!isNaN(hoursNum)) {
      timeRangeFilter = {
        start: new Date(Date.now() - hoursNum * 60 * 60 * 1000),
        end: new Date()
      };
    }
  }
  
  // Collect dashboard data
  const dashboardData = {
    // System health and status
    health: automationMonitoringService.getHealthStatus(),
    
    // Real-time metrics
    metrics: automationMonitoringService.getDashboardMetrics(timeRangeFilter),
    
    // Active alerts
    alerts: automationMonitoringService.getActiveAlerts(),
    
    // Audit summary
    audit: automationMonitoringService.getAuditSummary(
      timeRangeFilter ? 
        Math.ceil((timeRangeFilter.end.getTime() - timeRangeFilter.start.getTime()) / (1000 * 60 * 60)) : 
        24
    ),
    
    // Performance history
    performance: automationMonitoringService.getPerformanceHistory(
      timeRangeFilter ? 
        Math.ceil((timeRangeFilter.end.getTime() - timeRangeFilter.start.getTime()) / (1000 * 60 * 60)) : 
        24
    ),
    
    // System statistics
    statistics: automationMonitoringService.getSystemStatistics(),
    
    // Metadata
    metadata: {
      lastUpdated: timestamp,
      dataRange: timeRangeFilter || {
        start: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
        end: new Date().toISOString()
      }
    }
  };
  
  res.status(200).json({
    success: true,
    data: dashboardData,
    timestamp
  });
}

/**
 * Handle POST request - Update monitoring configuration
 */
async function handleUpdateConfig(
  req: NextApiRequest,
  res: NextApiResponse<DashboardResponse>,
  timestamp: string
): Promise<void> {
  const { alertConfig, action } = req.body;
  
  if (action === 'test_alert') {
    // Trigger test alert
    const { severity = 'medium' } = req.body;
    const success = await automationMonitoringService.triggerTestAlert(severity);
    
    res.status(200).json({
      success,
      data: { message: success ? 'Test alert sent successfully' : 'Failed to send test alert' },
      timestamp
    });
    return;
  }
  
  if (alertConfig) {
    // Update alert configuration
    automationMonitoringService.updateAlertConfiguration(alertConfig);
    
    // Log the configuration change
    automationAuditLogger.logEvent(
      'configuration_changed',
      'info',
      'dashboard-api',
      'Alert configuration updated via dashboard',
      { updatedConfig: alertConfig }
    );
    
    res.status(200).json({
      success: true,
      data: { message: 'Alert configuration updated successfully' },
      timestamp
    });
    return;
  }
  
  res.status(400).json({
    success: false,
    error: 'Invalid request body',
    timestamp
  });
} 