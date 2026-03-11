import { NextApiRequest, NextApiResponse } from 'next';
import { SuiClient } from '@mysten/sui.js/client';
import { TransactionBlock } from '@mysten/sui.js/transactions';
import { getCurrentNetworkConfig } from '@/services/network-config';

/**
 * ⏰ Circle Payout Status API
 * 
 * Checks if a circle has an overdue payout using blockchain time validation
 * Uses the smart contract's automation functions for accurate status
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({
      success: false,
      error: 'Method not allowed'
    });
  }

  try {
    const { id: circleId } = req.query;

    if (!circleId) {
      return res.status(400).json({
        success: false,
        error: 'Missing circleId'
      });
    }

    // Initialize Sui client
    const networkConfig = getCurrentNetworkConfig();
    const suiClient = new SuiClient({ url: networkConfig.rpcUrl });

    const packageId = networkConfig.packageId;

    // Create transaction to check payout status using smart contract
    const tx = new TransactionBlock();
    
    // Get clock object
    const [clock] = tx.moveCall({
      target: '0x6::clock::share',
      arguments: [],
    });

    // Call the smart contract function to check automation status
    tx.moveCall({
      target: `${packageId}::njangi_circles::get_automation_status`,
      arguments: [
        tx.object(circleId as string),
        clock,
      ],
    });

    // Execute the transaction as a read-only inspection
    const result = await suiClient.devInspectTransactionBlock({
      transactionBlock: tx,
      sender: '0x0000000000000000000000000000000000000000000000000000000000000000', // Dummy sender for inspection
    });

    if (result.effects.status.status !== 'success' || !result.results?.[0]?.returnValues?.[0]) {
      return res.status(400).json({
        success: false,
        error: 'Failed to get payout status from blockchain'
      });
    }

    // Parse the AutomationStatus struct returned from the smart contract
    const returnValue = result.results[0].returnValues[0];
    const bytes = Array.isArray(returnValue) ? returnValue[0] : returnValue;
    
    if (!Array.isArray(bytes) || bytes.length < 5) {
      return res.status(400).json({
        success: false,
        error: 'Invalid automation status format'
      });
    }

    // Parse AutomationStatus fields
    const automationStatus = {
      is_overdue: bytes[0] === 1,
      time_until_payout: bytes[1]?.toString() || '0',
      is_ready_for_payout: bytes[2] === 1,
      all_members_contributed: bytes[3] === 1,
      warning_level: bytes[4] || 0
    };

    // Calculate human-readable overdue time
    const timeUntilPayout = parseInt(automationStatus.time_until_payout);
    let overdueTime = 'Unknown';
    
    if (automationStatus.is_overdue && timeUntilPayout > 0) {
      const hoursOverdue = Math.floor(timeUntilPayout / (1000 * 60 * 60));
      const minutesOverdue = Math.floor((timeUntilPayout % (1000 * 60 * 60)) / (1000 * 60));
      
      if (hoursOverdue > 0) {
        overdueTime = `${hoursOverdue} hour${hoursOverdue > 1 ? 's' : ''}${minutesOverdue > 0 ? ` ${minutesOverdue}m` : ''}`;
      } else if (minutesOverdue > 0) {
        overdueTime = `${minutesOverdue} minute${minutesOverdue > 1 ? 's' : ''}`;
      } else {
        overdueTime = 'Just now';
      }
    }

    return res.status(200).json({
      success: true,
      isOverdue: automationStatus.is_overdue,
      isReadyForPayout: automationStatus.is_ready_for_payout,
      allMembersContributed: automationStatus.all_members_contributed,
      warningLevel: automationStatus.warning_level,
      timeUntilPayout: automationStatus.time_until_payout,
      overdueTime,
      message: automationStatus.is_overdue 
        ? `Payout is overdue by ${overdueTime}` 
        : 'Payout is not overdue'
    });

  } catch (error) {
    console.error('Error checking payout status:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to check payout status',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
} 
