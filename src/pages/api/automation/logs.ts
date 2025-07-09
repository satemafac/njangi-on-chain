import { NextApiRequest, NextApiResponse } from 'next';
import { automationAuditLogger, AuditEventType, LogLevel, AuditLogEntry } from '../../../services/automation-audit-logger.service';

interface LogsResponse {
  success: boolean;
  data?: {
    logs: AuditLogEntry[];
    total: number;
    filters: Record<string, unknown>;
    pagination: {
      page: number;
      limit: number;
      hasMore: boolean;
    };
  };
  error?: string;
  timestamp: string;
}

interface ExportResponse {
  success: boolean;
  data?: string;
  error?: string;
  timestamp: string;
  contentType?: string;
}

/**
 * 📋 Automation Logs API
 * 
 * Provides access to audit logs with filtering and export capabilities:
 * - GET: Query and filter audit logs
 * - POST: Export logs in various formats
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<LogsResponse | ExportResponse>
) {
  const timestamp = new Date().toISOString();

  try {
    switch (req.method) {
      case 'GET':
        await handleGetLogs(req, res, timestamp);
        break;
      
      case 'POST':
        await handleExportLogs(req, res, timestamp);
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
    console.error('Logs API error:', error);
    
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Internal server error',
      timestamp
    });
  }
}

/**
 * Handle GET request - Query audit logs
 */
async function handleGetLogs(
  req: NextApiRequest,
  res: NextApiResponse<LogsResponse>,
  timestamp: string
): Promise<void> {
  const {
    eventType,
    level,
    source,
    circleId,
    outcome,
    timeRange,
    hours,
    page = '1',
    limit = '50'
  } = req.query;

  // Parse pagination
  const pageNum = parseInt(page as string, 10) || 1;
  const limitNum = Math.min(parseInt(limit as string, 10) || 50, 500); // Max 500 logs per request
  
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
      // Invalid time range format, ignore
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

  // Build filters
  const filters: Parameters<typeof automationAuditLogger.queryLogs>[0] = {};
  
  if (eventType && typeof eventType === 'string') {
    filters.eventType = eventType as AuditEventType;
  }
  
  if (level && typeof level === 'string') {
    filters.level = level as LogLevel;
  }
  
  if (source && typeof source === 'string') {
    filters.source = source;
  }
  
  if (circleId && typeof circleId === 'string') {
    filters.circleId = circleId;
  }
  
  if (outcome && typeof outcome === 'string') {
    filters.outcome = outcome;
  }
  
  if (timeRangeFilter) {
    filters.timeRange = timeRangeFilter;
  }

  // Get total count (without pagination)
  const allLogs = automationAuditLogger.queryLogs(filters);
  const total = allLogs.length;

  // Apply pagination
  const startIndex = (pageNum - 1) * limitNum;
  const logs = allLogs.slice(startIndex, startIndex + limitNum);
  const hasMore = startIndex + limitNum < total;

  res.status(200).json({
    success: true,
    data: {
      logs,
      total,
      filters: {
        eventType,
        level,
        source,
        circleId,
        outcome,
        timeRange: timeRangeFilter,
        appliedFilters: Object.keys(filters).length
      },
      pagination: {
        page: pageNum,
        limit: limitNum,
        hasMore
      }
    },
    timestamp
  });
}

/**
 * Handle POST request - Export logs
 */
async function handleExportLogs(
  req: NextApiRequest,
  res: NextApiResponse<ExportResponse>,
  timestamp: string
): Promise<void> {
  const { format = 'json', filters = {} } = req.body;

  // Validate format
  if (!['json', 'csv'].includes(format)) {
    res.status(400).json({
      success: false,
      error: 'Invalid format. Supported formats: json, csv',
      timestamp
    });
    return;
  }

  // Export logs
  const exportData = automationAuditLogger.exportLogs(format, filters);
  
  // Set appropriate headers
  const contentType = format === 'csv' ? 'text/csv' : 'application/json';
  const filename = `automation-logs-${new Date().toISOString().slice(0, 10)}.${format}`;
  
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  
  res.status(200).json({
    success: true,
    data: exportData,
    timestamp,
    contentType
  });
} 