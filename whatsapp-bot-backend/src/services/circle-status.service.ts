import { SuiClient } from '@mysten/sui/client';
import { getConfig } from '../config';
import { appLogger } from '../utils/logger';

/**
 * Circle Status Service
 * Fetches live circle data from the Sui blockchain
 */
export class CircleStatusService {
  private suiClient: SuiClient;

  constructor() {
    const config = getConfig();
    const rpcUrl = config.sui.currentRpcUrl;
    this.suiClient = new SuiClient({ url: rpcUrl });
  }

  /**
   * Get circle status and format as a WhatsApp message
   */
  async getCircleStatusMessage(circleId: string): Promise<string> {
    try {
      const circleData = await this.getCircleData(circleId);

      if (!circleData) {
        return `❌ Could not find circle data for ID: ${circleId}`;
      }

      // Extract key data
      const name = circleData.fields?.name || 'Unknown Circle';
      const currentMembers = circleData.fields?.current_members || 0;
      const currentCycle = circleData.fields?.current_cycle || 0;
      const isActive = circleData.fields?.is_active ?? false;
      const admin = circleData.fields?.admin || 'Unknown';
      const createdAt = circleData.fields?.created_at || 0;

      // Calculate days active
      const daysActive = Math.floor((Date.now() - createdAt) / (1000 * 60 * 60 * 24));

      // Format status message
      const statusMessage = `📊 *${name} - Circle Status*

✅ *Status:* ${isActive ? '🟢 Active' : '🔴 Inactive'}
👥 *Members:* ${currentMembers}
🔄 *Current Cycle:* ${currentCycle}
📅 *Days Active:* ${daysActive}
👤 *Admin:* ${this.shortenAddress(admin)}

_Last updated: ${new Date().toLocaleTimeString()}_`;

      return statusMessage;
    } catch (error) {
      appLogger.error('Error getting circle status', {
        circleId,
        error: error instanceof Error ? error.message : String(error),
      });
      return `❌ Error fetching circle status. Please try again later.`;
    }
  }

  /**
   * Get detailed circle data from the blockchain
   */
  private async getCircleData(circleId: string): Promise<any> {
    try {
      const response = await this.suiClient.getObject({
        id: circleId,
        options: {
          showContent: true,
          showType: true,
        },
      });

      if (response.error) {
        appLogger.warn('Error fetching circle object', {
          circleId,
          error: response.error,
        });
        return null;
      }

      // Handle different response formats
      if (response.data?.content?.dataType === 'moveObject') {
        return response.data.content;
      }

      return response.data;
    } catch (error) {
      appLogger.error('Error querying circle data', {
        circleId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Shorten address for display
   */
  private shortenAddress(address: string): string {
    if (!address || address.length < 10) {
      return address;
    }
    return `${address.substring(0, 6)}...${address.substring(address.length - 4)}`;
  }
}

// Export singleton instance
export const circleStatusService = new CircleStatusService();
