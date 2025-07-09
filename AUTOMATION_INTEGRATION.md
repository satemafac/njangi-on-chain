# 🤖 Njangi Automation System Integration Guide

## Overview

The Njangi Automation System provides comprehensive cron-based blockchain time tracking and automatic payout triggering for Njangi savings circles. This system enhances existing manual processes while maintaining full compatibility and fallback mechanisms.

## 🏗️ System Architecture

### Core Components

1. **Smart Contract Enhancements** (`move/sources/njangi_circles.move`)
   - Time validation functions (`is_payout_overdue`, `get_automation_status`)
   - Warning level detection (24h, 6h, 1h, overdue)
   - Enhanced event emission for automation logging

2. **Automation Cron Service** (`src/services/automation-cron.service.ts`)
   - 5-minute payout monitoring cycle
   - 1-hour notification cycle
   - 24-hour health check cycle
   - Emergency stop and manual override capabilities

3. **Progressive Notification System**
   - WhatsApp integration with escalating urgency
   - Member phone number lookup via circle events
   - Automation-specific message templates

4. **Comprehensive Logging & Monitoring**
   - Structured audit trails with session tracking
   - Real-time metrics and performance monitoring
   - Admin alerting with escalation workflows

5. **Admin Alert System**
   - Multi-channel notifications (WhatsApp, email, webhook)
   - Configurable thresholds and escalation rules
   - Alert acknowledgment and resolution tracking

## 🔧 Integration Points

### Smart Contract Integration

```move
// New automation functions in njangi_circles.move
public fun is_circle_ready_for_automated_payout(
    circle: &Circle, 
    clock: &Clock
): bool

public fun get_automation_status(
    circle: &Circle, 
    clock: &Clock
): AutomationStatus

public fun should_send_warning(
    circle: &Circle, 
    clock: &Clock
): bool
```

**Compatibility**: Uses existing `admin_trigger_payout()` function - no new admin privileges required.

### Blockchain Event Integration

```typescript
// Circle discovery via events
const events = await suiClient.queryEvents({
  query: { MoveEventType: `${PACKAGE_ID}::njangi_circles::CircleCreated` },
  limit: 1000
});

// Custody wallet lookup
const custodyEvents = await suiClient.queryEvents({
  query: { MoveEventType: `${PACKAGE_ID}::njangi_custody::CustodyWalletCreated` },
  limit: 100
});
```

**Event-Driven Architecture**: All operations based on blockchain events, no hardcoded dependencies.

### API Integration

```typescript
// Automation Service API
import { automationService } from '@/services/automation-cron.service';

// Control automation
await automationService.start();
automationService.stop();
automationService.emergencyStopAll();

// Manual overrides
const result = await automationService.forceCheckCircle(circleId);

// Monitor status
const metrics = automationService.getMetrics();
const activeCircles = automationService.getActiveCircles();
```

### Admin Alert Integration

```typescript
// Admin alerts with WhatsApp integration
import { automationAdminAlertsService } from '@/services/automation-admin-alerts.service';

// Trigger alerts
const alertId = await automationAdminAlertsService.triggerAlert(
  'system_failure',
  'critical',
  'System Error',
  'Automation service has encountered critical errors',
  { details: errorData }
);

// Manage alerts
await automationAdminAlertsService.acknowledgeAlert(alertId, 'admin_user');
await automationAdminAlertsService.resolveAlert(alertId, 'admin_user', 'Fixed issue');
```

## 🚀 Usage Instructions

### 1. Environment Setup

```bash
# Required environment variables
ADMIN_PRIVATE_KEY=your_admin_private_key_hex
ANTHROPIC_API_KEY=your_anthropic_api_key  # For AI functions
OPENAI_API_KEY=your_openai_api_key        # Alternative AI provider
```

### 2. Service Initialization

```typescript
import { automationService } from '@/services/automation-cron.service';
import { automationAuditLogger } from '@/services/automation-audit-logger.service';
import { automationAdminAlertsService } from '@/services/automation-admin-alerts.service';

// Initialize services (done automatically via singletons)
const automation = automationService;
const logger = automationAuditLogger;
const alerts = automationAdminAlertsService;

// Start automation
await automation.start();
```

### 3. Monitoring Dashboard Integration

```typescript
// Get real-time metrics
const metrics = automation.getMetrics();
console.log({
  isRunning: metrics.isRunning,
  activeCircles: metrics.activeCircles,
  payoutsTriggered: metrics.payoutsTriggered,
  errorRate: (metrics.errors / metrics.totalCirclesProcessed) * 100
});

// Get audit logs
const logs = logger.queryLogs({
  eventType: 'payout_triggered',
  timeRange: { start: new Date(Date.now() - 24*60*60*1000), end: new Date() }
});

// Get active alerts
const activeAlerts = alerts.getActiveAlerts();
```

### 4. Manual Override Operations

```typescript
// Emergency stop (immediate halt)
automation.emergencyStopAll();

// Force check specific circle
const result = await automation.forceCheckCircle(circleId);
if (result.success) {
  console.log('Payout executed successfully');
} else {
  console.error('Force check failed:', result.message);
}

// Resume from emergency stop
await automation.resumeFromEmergencyStop();
```

## 🔄 Fallback Mechanisms

### 1. Emergency Stop

**Triggers:**
- Manual admin command
- High error rate (>20% failures)
- System health check failures
- Critical blockchain connectivity issues

**Actions:**
- Immediate halt of all automation
- Admin WhatsApp notifications
- Preserve retry queue for manual processing
- Manual override remains available

### 2. Retry Logic

**Strategy:** Exponential backoff with max 3 attempts
- Attempt 1: Immediate
- Attempt 2: 2 seconds delay
- Attempt 3: 4 seconds delay
- After 3 failures: Admin alert for manual intervention

### 3. Manual Intervention Points

**Circle Management UI**: `/circle/[id]/manage`
- Existing admin functions remain fully functional
- Manual payout triggering via UI (when implemented)
- Circle activation and member management

**Direct Smart Contract Calls**:
```move
// Still available for direct admin use
admin_trigger_payout(circle, wallet, clock)
admin_force_payout(circle, wallet, clock)
```

## 📊 Monitoring & Alerting

### Real-time Metrics

```typescript
interface AutomationMetrics {
  totalCirclesProcessed: number;
  payoutsTriggered: number;
  notificationsSent: number;
  errors: number;
  uptime: number;
  lastRunTime: Date | null;
  nextRunTime: Date | null;
  isRunning: boolean;
  emergencyStop: boolean;
  activeCircles: number;
  retryQueueSize: number;
}
```

### Alert Types

1. **System Alerts**
   - `system_failure`: Critical automation system errors
   - `automation_stopped`: When automation is halted
   - `high_error_rate`: Error rate exceeds 20%

2. **Performance Alerts**
   - `performance_degradation`: Operations taking >30 seconds
   - `manual_intervention_required`: Max retries exceeded

3. **Health Alerts**
   - `blockchain_connectivity`: Sui network issues
   - `configuration_issue`: Missing keys or invalid config

### Audit Logging

**Event Types:**
- `payout_triggered` / `payout_failed`
- `notification_sent` / `notification_failed`
- `circle_discovered` / `circle_status_changed`
- `health_check_passed` / `health_check_failed`
- `emergency_stop` / `system_started` / `system_stopped`

**Log Structure:**
```typescript
interface AuditLogEntry {
  id: string;
  timestamp: Date;
  eventType: AuditEventType;
  level: LogLevel;
  source: string;
  action: string;
  details: Record<string, unknown>;
  outcome: 'success' | 'failure' | 'warning' | 'info';
  performance?: { duration: number; memoryUsage: number; };
  circleId?: string;
  transactionHash?: string;
}
```

## 🔗 API Endpoints

### Automation Dashboard

```typescript
// GET /api/automation/dashboard
{
  metrics: AutomationMetrics,
  activeAlerts: Alert[],
  systemHealth: HealthStatus,
  recentActivity: AuditLogEntry[]
}

// GET /api/automation/logs
{
  logs: AuditLogEntry[],
  totalCount: number,
  filters: LogFilters
}
```

### Control Endpoints

```typescript
// POST /api/automation/control
{
  action: 'start' | 'stop' | 'emergency_stop' | 'resume',
  circleId?: string  // For force check operations
}

// POST /api/automation/alerts/acknowledge
{
  alertId: string,
  acknowledgedBy: string
}
```

## 🧪 Testing Strategy

### Unit Tests
- Smart contract function testing
- Service method validation
- Error handling verification

### Integration Tests
- End-to-end payout automation
- Notification delivery testing
- Fallback mechanism validation

### Production Testing
- Testnet validation with real circles
- Performance monitoring under load
- Disaster recovery testing

## 🔒 Security Considerations

### Private Key Management
- Admin private key stored in environment variables
- No private keys in code or logs
- Separate keys for different environments

### Transaction Security
- Proper transaction validation
- Result verification before marking success
- Error handling prevents partial states

### Access Control
- Admin functions restricted to authorized keypairs
- Emergency stop available to authorized users only
- Audit trails for all admin actions

## 📈 Performance Optimization

### Efficient Circle Discovery
- Event-based discovery (no full chain scanning)
- Cached active circle list with periodic refresh
- Filtered queries for active circles only

### Batch Processing
- Multiple circles processed in parallel
- Efficient retry queue management
- Rate limiting to prevent blockchain overload

### Resource Management
- Memory-efficient log rotation
- Cleanup of old performance metrics
- Configurable batch sizes and intervals

## 🔧 Configuration Options

### Environment Variables
```bash
# Core Configuration
ADMIN_PRIVATE_KEY=hex_private_key
NODE_ENV=production|development

# AI Services (for enhanced logging and alerts)
ANTHROPIC_API_KEY=your_key
OPENAI_API_KEY=your_key
PERPLEXITY_API_KEY=your_key

# Network Configuration  
NEXT_PUBLIC_SUI_RPC_URL=https://fullnode.mainnet.sui.io:443

# WhatsApp Integration
WHATSAPP_BUSINESS_ACCOUNT_ID=your_account_id
WHATSAPP_ACCESS_TOKEN=your_token
```

### Service Configuration
```typescript
// Customizable intervals
const PAYOUT_CHECK_INTERVAL = 5 * 60 * 1000;  // 5 minutes
const NOTIFICATION_INTERVAL = 60 * 60 * 1000; // 1 hour
const HEALTH_CHECK_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours

// Retry configuration
const MAX_RETRIES = 3;
const RETRY_DELAY_BASE = 2000; // 2 seconds

// Alert thresholds
const ERROR_RATE_THRESHOLD = 20; // Percent
const PERFORMANCE_THRESHOLD = 30000; // 30 seconds
```

## 🚨 Troubleshooting

### Common Issues

1. **Automation Not Starting**
   ```
   Error: Admin keypair not configured
   Solution: Set ADMIN_PRIVATE_KEY environment variable
   ```

2. **High Error Rate**
   ```
   Cause: Blockchain connectivity issues
   Solution: Check SUI RPC URL and network status
   ```

3. **Notifications Not Sending**
   ```
   Cause: WhatsApp configuration issues
   Solution: Verify WHATSAPP_ACCESS_TOKEN and member phone numbers
   ```

### Debug Commands

```typescript
// Check service status
console.log(automationService.getMetrics());

// View recent errors
const errorLogs = automationAuditLogger.queryLogs({ level: 'error', limit: 10 });

// Check retry queue
console.log(automationService.getRetryQueue());

// Test specific circle
const result = await automationService.forceCheckCircle('circle_id');
```

### Emergency Procedures

1. **System Failure**: Use `emergencyStopAll()` to halt automation
2. **Manual Intervention**: Use existing circle management UI
3. **Data Recovery**: Access audit logs for transaction history
4. **Service Recovery**: Restart service with `resumeFromEmergencyStop()`

## 📋 Deployment Checklist

- [ ] Environment variables configured
- [ ] Admin private key set and secured
- [ ] WhatsApp integration configured
- [ ] Smart contracts deployed with automation functions
- [ ] Monitoring dashboard accessible
- [ ] Alert notifications tested
- [ ] Fallback procedures documented
- [ ] Team trained on emergency procedures

---

## 🎯 Summary

The Njangi Automation System provides a **complete enhancement layer** that:

✅ **Enhances without replacing** existing manual processes  
✅ **Maintains full compatibility** with existing admin workflows  
✅ **Provides comprehensive monitoring** and alerting capabilities  
✅ **Ensures reliable operation** with robust error handling and fallback mechanisms  
✅ **Scales efficiently** with event-driven architecture and intelligent retry logic  

The system is **production-ready** and seamlessly integrates with all existing Njangi platform components while providing powerful automation capabilities for time-based payout management. 