/**
 * Sui RPC Pool Service
 * Manages a pool of RPC connections with retry logic, health checks, and failover
 */

import { SuiClient, getFullnodeUrl } from '@mysten/sui.js/client';
import { appLogger } from '../utils/logger';
import { RpcConnectionConfig, EventListenerState } from '../utils/sui-event-types';

interface RpcNode {
  config: RpcConnectionConfig;
  client: SuiClient;
  isHealthy: boolean;
  consecutiveFailures: number;
  lastHealthCheck: number;
  responseTimes: number[]; // Track last 10 response times
}

export class SuiRpcPoolService {
  private nodes: Map<string, RpcNode> = new Map();
  private currentNodeIndex = 0;
  private healthCheckIntervalMs = 30000; // 30 seconds
  private healthCheckTimer?: NodeJS.Timeout;
  private state: EventListenerState = {
    isConnected: false,
    lastProcessedCursor: null,
    eventsProcessed: 0,
    lastEventTimestamp: 0,
    connectionRetries: 0,
  };

  constructor(
    private testnetRpcUrl: string,
    private mainnetRpcUrl: string,
    private testnetRpcAlt?: string,
    private mainnetRpcAlt?: string
  ) {
    this.initializeConnections();
  }

  /**
   * Initialize RPC connections for testnet and mainnet
   */
  private initializeConnections(): void {
    const configs: RpcConnectionConfig[] = [
      {
        url: this.testnetRpcUrl,
        name: 'Testnet Primary',
        maxRetries: 3,
        retryDelayMs: 1000,
        timeoutMs: 10000,
        priority: 0,
      },
      {
        url: this.mainnetRpcUrl,
        name: 'Mainnet Primary',
        maxRetries: 3,
        retryDelayMs: 1000,
        timeoutMs: 10000,
        priority: 1,
      },
    ];

    // Add alternate endpoints if provided
    if (this.testnetRpcAlt) {
      configs.push({
        url: this.testnetRpcAlt,
        name: 'Testnet Alternate',
        maxRetries: 3,
        retryDelayMs: 2000,
        timeoutMs: 10000,
        priority: 2,
      });
    }

    if (this.mainnetRpcAlt) {
      configs.push({
        url: this.mainnetRpcAlt,
        name: 'Mainnet Alternate',
        maxRetries: 3,
        retryDelayMs: 2000,
        timeoutMs: 10000,
        priority: 3,
      });
    }

    // Sort by priority (lower is higher priority)
    configs.sort((a, b) => (a.priority || 0) - (b.priority || 0));

    for (const config of configs) {
      const client = new SuiClient({ url: config.url });
      this.nodes.set(config.name, {
        config,
        client,
        isHealthy: true,
        consecutiveFailures: 0,
        lastHealthCheck: Date.now(),
        responseTimes: [],
      });
    }

    appLogger.info(`Initialized ${this.nodes.size} RPC node(s)`, {
      nodes: Array.from(this.nodes.keys()),
    });
  }

  /**
   * Get the best available RPC client (round-robin with health awareness)
   */
  public getClient(network: 'testnet' | 'mainnet'): SuiClient {
    const networkNodes = Array.from(this.nodes.entries())
      .filter(([name]) => {
        if (network === 'testnet') {
          return name.includes('Testnet');
        } else {
          return name.includes('Mainnet');
        }
      })
      .sort((a, b) => (a[1].config.priority || 0) - (b[1].config.priority || 0));

    if (networkNodes.length === 0) {
      throw new Error(`No RPC nodes available for ${network}`);
    }

    // Try to get a healthy node
    for (const [name, node] of networkNodes) {
      if (node.isHealthy) {
        appLogger.debug(`Using RPC node: ${name}`);
        return node.client;
      }
    }

    // If no healthy node, use the first one anyway
    appLogger.warn(
      `No healthy RPC nodes for ${network}, using fallback`,
      { networkNodes: networkNodes.map(([name]) => name) }
    );
    return networkNodes[0][1].client;
  }

  /**
   * Get all nodes for a network
   */
  public getNodesByNetwork(network: 'testnet' | 'mainnet'): SuiClient[] {
    return Array.from(this.nodes.values())
      .filter((node) => {
        if (network === 'testnet') {
          return node.config.name.includes('Testnet');
        } else {
          return node.config.name.includes('Mainnet');
        }
      })
      .map((node) => node.client);
  }

  /**
   * Record a successful call
   */
  public recordSuccess(nodeName: string, responseTimeMs: number): void {
    const node = this.nodes.get(nodeName);
    if (node) {
      node.consecutiveFailures = 0;
      node.responseTimes.push(responseTimeMs);
      if (node.responseTimes.length > 10) {
        node.responseTimes.shift();
      }
      if (!node.isHealthy) {
        node.isHealthy = true;
        appLogger.info(`RPC node recovered: ${nodeName}`);
      }
    }
  }

  /**
   * Record a failed call
   */
  public recordFailure(nodeName: string, error: Error): void {
    const node = this.nodes.get(nodeName);
    if (node) {
      node.consecutiveFailures++;
      appLogger.warn(`RPC call failed on ${nodeName}`, {
        attempt: node.consecutiveFailures,
        error: error.message,
      });

      // Mark unhealthy after 3 consecutive failures
      if (node.consecutiveFailures >= 3 && node.isHealthy) {
        node.isHealthy = false;
        appLogger.error(`Marked RPC node as unhealthy: ${nodeName}`);
      }
    }

    this.state.connectionRetries++;
    this.state.lastError = {
      message: error.message,
      timestamp: Date.now(),
      code: (error as any).code,
    };
  }

  /**
   * Start health checks
   */
  public startHealthChecks(): void {
    if (this.healthCheckTimer) {
      return;
    }

    appLogger.info('Starting RPC health checks', { intervalMs: this.healthCheckIntervalMs });

    this.healthCheckTimer = setInterval(() => {
      this.performHealthChecks();
    }, this.healthCheckIntervalMs);

    // Run immediately
    this.performHealthChecks();
  }

  /**
   * Stop health checks
   */
  public stopHealthChecks(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = undefined;
      appLogger.info('Stopped RPC health checks');
    }
  }

  /**
   * Perform health checks on all nodes
   */
  private async performHealthChecks(): Promise<void> {
    const checks = Array.from(this.nodes.entries()).map(async ([name, node]) => {
      try {
        const startTime = Date.now();
        await node.client.getLatestCheckpointSequenceNumber();
        const responseTime = Date.now() - startTime;

        this.recordSuccess(name, responseTime);
      } catch (error) {
        this.recordFailure(name, error as Error);
      }
    });

    await Promise.allSettled(checks);

    const healthStatus = Array.from(this.nodes.entries())
      .map(([name, node]) => ({
        name,
        healthy: node.isHealthy,
        failures: node.consecutiveFailures,
        avgResponseTime:
          node.responseTimes.length > 0
            ? Math.round(node.responseTimes.reduce((a, b) => a + b, 0) / node.responseTimes.length)
            : 0,
      }))
      .filter((n) => !n.healthy || n.failures > 0 || n.avgResponseTime > 5000);

    if (healthStatus.length > 0) {
      appLogger.debug('RPC health check results', { nodes: healthStatus });
    }

    this.updateConnectionState();
  }

  /**
   * Update connection state
   */
  private updateConnectionState(): void {
    const healthyNodes = Array.from(this.nodes.values()).filter((n) => n.isHealthy);
    this.state.isConnected = healthyNodes.length > 0;
  }

  /**
   * Get current state
   */
  public getState(): EventListenerState {
    return { ...this.state };
  }

  /**
   * Update cursor (for event polling)
   */
  public updateCursor(cursor: string): void {
    this.state.lastProcessedCursor = cursor;
  }

  /**
   * Increment events processed
   */
  public incrementEventsProcessed(count: number = 1): void {
    this.state.eventsProcessed += count;
    this.state.lastEventTimestamp = Date.now();
  }

  /**
   * Get average response time for a network
   */
  public getAverageResponseTime(network: 'testnet' | 'mainnet'): number {
    const nodes = Array.from(this.nodes.values()).filter((node) => {
      if (network === 'testnet') {
        return node.config.name.includes('Testnet');
      } else {
        return node.config.name.includes('Mainnet');
      }
    });

    const allTimes = nodes.flatMap((n) => n.responseTimes);
    if (allTimes.length === 0) {
      return 0;
    }

    return Math.round(allTimes.reduce((a, b) => a + b, 0) / allTimes.length);
  }

  /**
   * Cleanup
   */
  public destroy(): void {
    this.stopHealthChecks();
    appLogger.info('RPC Pool destroyed');
  }
}

// Singleton instance
let poolInstance: SuiRpcPoolService | null = null;

export function initializeRpcPool(
  testnetRpc: string,
  mainnetRpc: string,
  testnetRpcAlt?: string,
  mainnetRpcAlt?: string
): SuiRpcPoolService {
  if (!poolInstance) {
    poolInstance = new SuiRpcPoolService(testnetRpc, mainnetRpc, testnetRpcAlt, mainnetRpcAlt);
  }
  return poolInstance;
}

export function getRpcPool(): SuiRpcPoolService {
  if (!poolInstance) {
    throw new Error('RPC Pool not initialized. Call initializeRpcPool first.');
  }
  return poolInstance;
}
