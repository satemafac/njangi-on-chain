/**
 * Circle Status Service
 * 
 * Fetches on-chain circle data for WhatsApp status responses
 */

import { SuiClient } from '@mysten/sui/client';

export interface CircleStatusData {
  name: string;
  admin: string;
  isActive: boolean;
  currentCycle: number;
  maxMembers: number;
  currentMembers: number;
  contributionAmount: number; // in SUI
  contributionAmountUsd: number;
  securityDeposit: number; // in SUI
  securityDepositUsd: number;
  currencyType: string;
  cycleLength: number; // days
  cycleDay: number; // day of month
  nextPayoutTime: number; // timestamp
  members: {
    address: string;
    position?: number;
    depositPaid: boolean;
    isAdmin: boolean;
  }[];
  rotationOrder: string[];
  currentBeneficiary?: string;
  totalCollected?: number; // Estimated based on contributions
}

/**
 * Fetch comprehensive circle status from blockchain
 * @param circleId - The circle object ID
 * @param network - Optional network override. If not provided, uses getCurrentNetwork()
 */
export async function getCircleStatus(circleId: string, network?: 'testnet' | 'mainnet'): Promise<CircleStatusData | null> {
  // Use the provided network or fall back to the app's current network setting
  const targetNetwork = network || (process.env.NEXT_PUBLIC_SUI_NETWORK as 'testnet' | 'mainnet') || 'testnet';
  const rpcUrl = targetNetwork === 'testnet' 
    ? (process.env.NEXT_PUBLIC_TESTNET_RPC_URL || 'https://fullnode.testnet.sui.io:443')
    : (process.env.NEXT_PUBLIC_MAINNET_RPC_URL || 'https://fullnode.mainnet.sui.io:443');
  console.log('[CircleStatus] Fetching status for circle:', circleId, 'using RPC:', rpcUrl, 'network:', targetNetwork);
  
  try {
    const client = new SuiClient({ url: rpcUrl });
    
    // Get circle object
    console.log('[CircleStatus] Getting circle object...');
    const objectData = await client.getObject({
      id: circleId,
      options: { showContent: true, showType: true }
    });
    
    console.log('[CircleStatus] Object data received:', objectData.data ? 'found' : 'not found');
    
    if (!objectData.data?.content || !('fields' in objectData.data.content)) {
      console.error('[CircleStatus] Circle not found or invalid:', circleId, 'data:', JSON.stringify(objectData));
      return null;
    }
    
    const fields = objectData.data.content.fields as Record<string, unknown>;
    const adminStr = typeof fields.admin === 'string' ? fields.admin : '';
    console.log('[CircleStatus] Circle fields:', { 
      name: fields.name, 
      admin: adminStr.slice(0, 10), 
      hasRotationOrder: !!fields.rotation_order 
    });
    
    // Get package ID for this circle using the correct network client
    console.log('[CircleStatus] Getting package ID for network:', targetNetwork);
    
    // Instead of using getCirclePackageId which queries wrong network,
    // extract package ID directly from the circle object type
    // Fall back to env variable if extraction fails
    const defaultPackageId = process.env.NEXT_PUBLIC_PACKAGE_ID || '0xd0f586ee515a0289be671399c3a4550f96cd556592e10686b820cdba6a56ecdc';
    let packageId = defaultPackageId;
    
    if (objectData.data?.type) {
      const match = objectData.data.type.match(/^(0x[a-f0-9]+)::/);
      if (match && match[1]) {
        packageId = match[1];
        console.log('[CircleStatus] Extracted package ID from object type:', packageId?.slice(0, 15));
      }
    }
    
    console.log('[CircleStatus] Using package ID:', packageId?.slice(0, 15));
    
    // Get dynamic fields for config
    const dynamicFieldsResult = await client.getDynamicFields({ parentId: circleId });
    console.log('[CircleStatus] Dynamic fields count:', dynamicFieldsResult.data.length);
    
    // Initialize config values
    let contributionAmount = 0;
    let contributionAmountUsd = 0;
    let securityDeposit = 0;
    let securityDepositUsd = 0;
    let cycleLength = 30;
    let cycleDay = 1;
    let maxMembers = 10;
    let currencyType = 'USD';
    
    // Try to get config from dynamic fields
    for (const field of dynamicFieldsResult.data) {
      if (field.objectType && typeof field.objectType === 'string' && field.objectType.includes('::CircleConfig')) {
        if (field.objectId) {
          try {
            const configData = await client.getObject({
              id: field.objectId,
              options: { showContent: true }
            });
            
            if (configData.data?.content && 'fields' in configData.data.content) {
              const outerFields = configData.data.content.fields as { value?: { fields?: Record<string, unknown> } };
              if (outerFields?.value?.fields) {
                const configFields = outerFields.value.fields as Record<string, unknown>;
                if (configFields.contribution_amount) contributionAmount = Number(configFields.contribution_amount) / 1e9;
                if (configFields.contribution_amount_usd) contributionAmountUsd = Number(configFields.contribution_amount_usd) / 100;
                if (configFields.security_deposit) securityDeposit = Number(configFields.security_deposit) / 1e9;
                if (configFields.security_deposit_usd) securityDepositUsd = Number(configFields.security_deposit_usd) / 100;
                if (configFields.cycle_length !== undefined) cycleLength = Number(configFields.cycle_length);
                if (configFields.cycle_day !== undefined) cycleDay = Number(configFields.cycle_day);
                if (configFields.max_members !== undefined) maxMembers = Number(configFields.max_members);
              }
            }
          } catch (error) {
            console.error('Error fetching config object:', error);
          }
        }
      }
    }
    
    // Fallback to direct fields
    if (contributionAmount === 0 && fields.contribution_amount) contributionAmount = Number(fields.contribution_amount) / 1e9;
    if (contributionAmountUsd === 0 && fields.contribution_amount_usd) contributionAmountUsd = Number(fields.contribution_amount_usd) / 100;
    if (securityDeposit === 0 && fields.security_deposit) securityDeposit = Number(fields.security_deposit) / 1e9;
    if (securityDepositUsd === 0 && fields.security_deposit_usd) securityDepositUsd = Number(fields.security_deposit_usd) / 100;
    
    // Get creation event for currency type
    try {
      const circleEvents = await client.queryEvents({
        query: { MoveEventType: `${packageId}::njangi_circles::CircleCreated` },
        limit: 50
      });
      
      const createEvent = circleEvents.data.find(event => 
        (event.parsedJson as { circle_id?: string })?.circle_id === circleId
      );
      
      if (createEvent?.parsedJson) {
        const eventData = createEvent.parsedJson as { currency_type?: string };
        if (eventData.currency_type) currencyType = eventData.currency_type;
      }
    } catch {
      // Ignore errors fetching creation event
    }
    
    // Get members from blockchain
    const memberAddresses = new Set<string>();
    if (typeof fields.admin === 'string') memberAddresses.add(fields.admin);
    
    // Fetch member events as fallback
    try {
      const memberEvents = await client.queryEvents({
        query: { MoveEventType: `${packageId}::njangi_circles::MemberJoined` },
        limit: 100
      });
      
      memberEvents.data
        .filter(event => (event.parsedJson as { circle_id?: string })?.circle_id === circleId)
        .forEach(event => {
          const memberAddr = (event.parsedJson as { member?: string })?.member;
          if (memberAddr) memberAddresses.add(memberAddr);
        });
    } catch (error) {
      console.error('Error fetching member events:', error);
    }
    
    // Get rotation order
    const rotationOrder: string[] = [];
    console.log('[CircleStatus] Raw rotation_order from blockchain:', fields.rotation_order);
    if (fields.rotation_order && Array.isArray(fields.rotation_order)) {
      (fields.rotation_order as string[]).forEach((addr: string) => {
        console.log('[CircleStatus] Processing rotation address:', addr);
        if (addr && addr !== '0x0' && addr !== '0x0000000000000000000000000000000000000000000000000000000000000000') {
          rotationOrder.push(addr);
          // Also add to memberAddresses if not already there
          memberAddresses.add(addr);
        }
      });
    }
    console.log('[CircleStatus] Final rotation order:', rotationOrder);
    console.log('[CircleStatus] Total member addresses:', Array.from(memberAddresses));
    
    // Build members list with positions
    const members = Array.from(memberAddresses).map(address => {
      const position = rotationOrder.indexOf(address);
      return {
        address,
        position: position >= 0 ? position : undefined,
        depositPaid: true, // Simplified - would need more complex check
        isAdmin: address === fields.admin
      };
    });
    
    // Sort by position
    members.sort((a, b) => {
      if (a.position === undefined && b.position === undefined) return 0;
      if (a.position === undefined) return 1;
      if (b.position === undefined) return -1;
      return a.position - b.position;
    });
    
    // Determine current beneficiary (position = current_cycle - 1)
    const currentCycle = Number(fields.current_cycle || 0);
    const currentBeneficiaryIndex = currentCycle > 0 ? currentCycle - 1 : 0;
    const currentBeneficiary = rotationOrder[currentBeneficiaryIndex] || members[currentBeneficiaryIndex]?.address;
    
    // Calculate estimated total collected (simplified)
    const totalCollected = contributionAmountUsd * members.length * currentCycle;
    
    // Check if circle is active
    let isActive = false;
    try {
      const activationEvents = await client.queryEvents({
        query: { MoveEventType: `${packageId}::njangi_circles::CircleActivated` },
        limit: 50
      });
      isActive = activationEvents.data.some(event => 
        (event.parsedJson as { circle_id?: string })?.circle_id === circleId
      );
    } catch {
      // Default to checking fields
      isActive = fields.is_active === true;
    }
    
    return {
      name: typeof fields.name === 'string' ? fields.name : 'Unknown Circle',
      admin: typeof fields.admin === 'string' ? fields.admin : '',
      isActive,
      currentCycle,
      maxMembers,
      currentMembers: members.length,
      contributionAmount,
      contributionAmountUsd,
      securityDeposit,
      securityDepositUsd,
      currencyType,
      cycleLength,
      cycleDay,
      nextPayoutTime: Number(fields.next_payout_time || 0),
      members,
      rotationOrder,
      currentBeneficiary,
      totalCollected
    };
  } catch (error) {
    console.error('[CircleStatus] Error fetching circle status:', {
      circleId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });
    return null;
  }
}

/**
 * Format circle status for WhatsApp message with member names
 */
export async function formatCircleStatusForWhatsAppWithNames(status: CircleStatusData, circleId: string): Promise<string> {
  const shortenAddress = (addr: string) => `${addr.slice(0, 6)}...${addr.slice(-4)}`;
  
  // Look up member names from join requests database
  const memberNames = new Map<string, string>();
  
  try {
    // Fetch names for all members
    for (const member of status.members.slice(0, 10)) {
      try {
        const baseUrl = process.env.VERCEL_URL 
          ? `https://${process.env.VERCEL_URL}` 
          : (process.env.NODE_ENV === 'production' ? 'https://njangionchain.com' : 'http://localhost:3000');
        
        const response = await fetch(
          `${baseUrl}/api/join-requests/lookup-user?circleId=${encodeURIComponent(circleId)}&userAddress=${encodeURIComponent(member.address)}`
        );
        
        if (response.ok) {
          const data = await response.json();
          if (data.success && data.data?.userName) {
            memberNames.set(member.address, data.data.userName);
          }
        }
      } catch (err) {
        // Silently fail for individual lookups
        console.error('Error looking up member name:', err);
      }
    }
  } catch (error) {
    console.error('Error fetching member names:', error);
  }
  
  // Format currency
  const formatCurrency = (amount: number, currency: string = 'USD') => {
    if (currency === 'USD') return `$${amount.toFixed(2)}`;
    if (currency === 'XAF') return `${amount.toLocaleString()} XAF`;
    if (currency === 'NGN') return `₦${amount.toLocaleString()}`;
    if (currency === 'KES') return `KSh ${amount.toLocaleString()}`;
    if (currency === 'GHS') return `GH₵${amount.toFixed(2)}`;
    if (currency === 'ZAR') return `R${amount.toFixed(2)}`;
    return `${amount.toFixed(2)} ${currency}`;
  };
  
  // Format date
  const formatDate = (timestamp: number) => {
    if (!timestamp || timestamp === 0) return 'Not set';
    const date = new Date(timestamp);
    return date.toLocaleDateString('en-US', { 
      weekday: 'short', 
      month: 'short', 
      day: 'numeric',
      year: 'numeric'
    });
  };
  
  // Get cycle day suffix
  const getOrdinal = (n: number) => {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  };
  
  // Build member list with positions and names - SHOW ALL MEMBERS
  console.log('[WhatsApp] Building member list, total members:', status.members.length);
  
  const memberList = status.members
    .map((m, i) => {
      const positionNum = m.position !== undefined ? m.position + 1 : i + 1;
      const isBeneficiary = m.address === status.currentBeneficiary;
      const isAdmin = m.isAdmin;
      const name = memberNames.get(m.address);
      
      let label = `${positionNum}. `;
      if (name) {
        label += `${name} (${shortenAddress(m.address)})`;
      } else {
        label += shortenAddress(m.address);
      }
      
      if (isBeneficiary) label += ' 🎯';
      if (isAdmin) label += ' 👑';
      
      console.log('[WhatsApp] Member line:', label);
      return label;
    })
    .join('\n');
  
  console.log('[WhatsApp] Final member list:', memberList);
  const moreMembers = '';
  
  // Status emoji
  const statusEmoji = status.isActive ? '🟢' : '🟡';
  const statusText = status.isActive ? 'Active' : 'Pending Activation';
  
  // Build the message
  const message = `📊 *${status.name}* ${statusEmoji}

*Status:* ${statusText}
*Cycle:* ${status.currentCycle > 0 ? `Round ${status.currentCycle}` : 'Not started'}

━━━━━━━━━━━━━━━━━━
👥 *Members* (${status.currentMembers}/${status.maxMembers})
━━━━━━━━━━━━━━━━━━
${memberList}${moreMembers}

${status.currentBeneficiary ? `🎯 *Current Beneficiary:*\n   ${shortenAddress(status.currentBeneficiary)}` : ''}

━━━━━━━━━━━━━━━━━━
💰 *Financials*
━━━━━━━━━━━━━━━━━━
• Contribution: ${formatCurrency(status.contributionAmountUsd, status.currencyType)}
• Security Deposit: ${formatCurrency(status.securityDepositUsd, status.currencyType)}
${status.totalCollected && status.totalCollected > 0 ? `• Total Collected: ~${formatCurrency(status.totalCollected, status.currencyType)}` : ''}

━━━━━━━━━━━━━━━━━━
📅 *Schedule*
━━━━━━━━━━━━━━━━━━
• Cycle Length: ${status.cycleLength} days
• Payout Day: ${getOrdinal(status.cycleDay)} of each month
• Next Payout: ${formatDate(status.nextPayoutTime)}

🔗 *View Full Details:*
https://njangionchain.com/circle/${circleId}`;

  return message;
}

/**
 * Format circle status for WhatsApp message (synchronous version without member names)
 * Use this when you need a synchronous response or can't await
 */
export function formatCircleStatusForWhatsApp(status: CircleStatusData, circleId: string): string {
  const shortenAddress = (addr: string) => `${addr.slice(0, 6)}...${addr.slice(-4)}`;
  
  // Format currency
  const formatCurrency = (amount: number, currency: string = 'USD') => {
    if (currency === 'USD') return `$${amount.toFixed(2)}`;
    if (currency === 'XAF') return `${amount.toLocaleString()} XAF`;
    if (currency === 'NGN') return `₦${amount.toLocaleString()}`;
    if (currency === 'KES') return `KSh ${amount.toLocaleString()}`;
    if (currency === 'GHS') return `GH₵${amount.toFixed(2)}`;
    if (currency === 'ZAR') return `R${amount.toFixed(2)}`;
    return `${amount.toFixed(2)} ${currency}`;
  };
  
  // Format date
  const formatDate = (timestamp: number) => {
    if (!timestamp || timestamp === 0) return 'Not set';
    const date = new Date(timestamp);
    return date.toLocaleDateString('en-US', { 
      weekday: 'short', 
      month: 'short', 
      day: 'numeric',
      year: 'numeric'
    });
  };
  
  // Get cycle day suffix
  const getOrdinal = (n: number) => {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  };
  
  // Build member list with positions (addresses only) - SHOW ALL MEMBERS
  const memberList = status.members
    .map((m, i) => {
      const positionNum = m.position !== undefined ? m.position + 1 : i + 1;
      const isBeneficiary = m.address === status.currentBeneficiary;
      const isAdmin = m.isAdmin;
      let label = `${positionNum}. ${shortenAddress(m.address)}`;
      if (isBeneficiary) label += ' 🎯';
      if (isAdmin) label += ' 👑';
      return label;
    })
    .join('\n');
  
  const moreMembers = '';
  
  // Status emoji
  const statusEmoji = status.isActive ? '🟢' : '🟡';
  const statusText = status.isActive ? 'Active' : 'Pending Activation';
  
  // Build the message
  const message = `📊 *${status.name}* ${statusEmoji}

*Status:* ${statusText}
*Cycle:* ${status.currentCycle > 0 ? `Round ${status.currentCycle}` : 'Not started'}

━━━━━━━━━━━━━━━━━━
👥 *Members* (${status.currentMembers}/${status.maxMembers})
━━━━━━━━━━━━━━━━━━
${memberList}${moreMembers}

${status.currentBeneficiary ? `🎯 *Current Beneficiary:*\n   ${shortenAddress(status.currentBeneficiary)}` : ''}

━━━━━━━━━━━━━━━━━━
💰 *Financials*
━━━━━━━━━━━━━━━━━━
• Contribution: ${formatCurrency(status.contributionAmountUsd, status.currencyType)}
• Security Deposit: ${formatCurrency(status.securityDepositUsd, status.currencyType)}
${status.totalCollected && status.totalCollected > 0 ? `• Total Collected: ~${formatCurrency(status.totalCollected, status.currencyType)}` : ''}

━━━━━━━━━━━━━━━━━━
📅 *Schedule*
━━━━━━━━━━━━━━━━━━
• Cycle Length: ${status.cycleLength} days
• Payout Day: ${getOrdinal(status.cycleDay)} of each month
• Next Payout: ${formatDate(status.nextPayoutTime)}

🔗 *View Full Details:*
https://njangionchain.com/circle/${circleId}`;

  return message;
}

