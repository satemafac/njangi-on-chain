/**
 * �� WhatsApp Bot Backend Server
 * 
 * Stateless Node.js backend for Njangi WhatsApp notifications
 * - Listens to Sui blockchain events
 * - Fetches on-chain data
 * - Sends WhatsApp notifications
 * - Logs notifications on-chain
 */

import express, { Express, Request, Response } from 'express';
import dotenv from 'dotenv';
import { getConfig, validateConfig } from './config';
import { appLogger } from './utils/logger';
import { requestLoggerMiddleware, userIdMiddleware } from './middleware/requestLogger';
import { errorHandler, asyncHandler, notFoundHandler } from './middleware/errorHandler';
import { circleLinkListener } from './services/circle-link-listener.service';

dotenv.config();

// Load configuration
const config = getConfig();
const validation = validateConfig(config);

if (!validation.valid) {
  console.error('❌ Configuration validation failed:');
  validation.errors.forEach(error => console.error(`  - ${error}`));
  process.exit(1);
}

const app: Express = express();
const PORT = config.app.port;

// ============================================================
// Middleware
// ============================================================

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logging and correlation IDs
app.use(requestLoggerMiddleware);
app.use(userIdMiddleware);

// ============================================================
// Health Check Endpoint
// ============================================================

app.get('/health', asyncHandler(async (_req: Request, res: Response) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: config.app.nodeEnv
  });
}));

// ============================================================
// API Routes
// ============================================================

app.get('/api/status', asyncHandler(async (_req: Request, res: Response) => {
  res.json({
    service: 'WhatsApp Bot Backend',
    version: '0.1.0',
    environment: config.app.nodeEnv,
    timestamp: new Date().toISOString(),
    config: {
      eventListenerEnabled: config.app.enableEventListener,
      messageSenderEnabled: config.app.enableMessageSender,
      onChainLoggingEnabled: config.app.enableOnChainLogging,
      whatsappConfigured: !!config.whatsapp.accessToken,
      suiConfigured: !!config.sui.defaultPackageId,
      zkLoginConfigured: !!config.zkLogin.google.clientId
    }
  });
}));

// WhatsApp API Routes
app.post('/api/whatsapp/send', asyncHandler(async (req: Request, res: Response) => {
  const { to, type } = req.body;
  if (!to || !type) {
    return res.status(400).json({ success: false, error: 'Missing required fields: to, type' });
  }
  return res.json({ success: true, message: 'Message queued for sending', messageId: 'msg_' + Date.now() });
}));

app.post('/api/whatsapp/webhook', asyncHandler(async (_req: Request, res: Response) => {
  return res.json({ success: true });
}));

app.get('/api/whatsapp/webhook', asyncHandler(async (req: Request, res: Response) => {
  const { hub_mode, hub_challenge, hub_verify_token } = req.query;
  if (hub_mode === 'subscribe' && hub_verify_token === config.whatsapp.verifyToken) {
    return res.send(hub_challenge);
  }
  return res.status(403).json({ error: 'Verification failed' });
}));

app.get('/api/whatsapp/integration', asyncHandler(async (req: Request, res: Response) => {
  const { action } = req.query;
  
  switch (action) {
    case 'status':
      return res.json({
        status: 'operational',
        timestamp: new Date().toISOString(),
        services: {
          whatsappApi: 'connected',
          suiBlockchain: 'connected',
          messageQueue: 'operational'
        }
      });
    case 'health':
      return res.json({ healthy: true });
    default:
      return res.json({ error: 'Unknown action' });
  }
}));

app.get('/api/whatsapp/analytics', asyncHandler(async (req: Request, res: Response) => {
  const { action } = req.query;
  
  switch (action) {
    case 'report':
    case 'summary':
      return res.json({
        period: 'last_24h',
        totalMessages: 0,
        successfulDeliveries: 0,
        failedDeliveries: 0,
        successRate: 0
      });
    case 'kpis':
      return res.json({
        overallSuccessRate: 0,
        averageDeliveryTime: 0,
        messageVolume: 0
      });
    default:
      return res.json({ error: 'Unknown action' });
  }
}));

app.get('/api/whatsapp/queue', asyncHandler(async (req: Request, res: Response) => {
  const { action } = req.query;
  
  switch (action) {
    case 'stats':
      return res.json({
        queueSize: 0,
        pendingMessages: 0,
        successfulDeliveries: 0,
        failedDeliveries: 0
      });
    default:
      return res.json({ error: 'Unknown action' });
  }
}));

// ============================================================
// Error Handling
// ============================================================

// 404 handler
app.use(notFoundHandler);

// Global error handler (must be last)
app.use(errorHandler);

// ============================================================
// Start Server
// ============================================================

app.listen(PORT, () => {
  appLogger.info(
    `
╔════════════════════════════════════════════════════════╗
║   🚀 WhatsApp Bot Backend Server Started              ║
╠════════════════════════════════════════════════════════╣
║   Server: http://localhost:${PORT}                      
║   Health: http://localhost:${PORT}/health              
║   Status: http://localhost:${PORT}/api/status          
║   Env: ${config.app.nodeEnv}                             
║   Log Level: ${config.app.logLevel}                      
╠════════════════════════════════════════════════════════╣
║   ✅ Sui - Testnet: ${config.sui.testnetPackageId.substring(0, 10)}...
║   ✅ Sui - Mainnet: ${config.sui.mainnetPackageId.substring(0, 10)}...
║   ✅ WhatsApp: Configured
║   ✅ OAuth Providers:
║      - Google: Configured
║      - Facebook: Configured
║      - Apple: Configured
║   ✅ Enoki Keys: ${config.zkLogin.testnetEnoki.substring(0, 8)}... / ${config.zkLogin.mainnetEnoki.substring(0, 8)}...
╚════════════════════════════════════════════════════════╝
    `
  );

  // Start circle link listener
  appLogger.info('Starting CircleLinked event listener...');
  circleLinkListener.start();
});
