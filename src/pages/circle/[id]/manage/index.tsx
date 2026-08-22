import React, { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { useRouter } from 'next/router';
import { useAuth } from '@/contexts/AuthContext';
import { SuiClient, SuiEvent } from '@mysten/sui/client';
import { toast } from 'react-hot-toast';
import { ArrowLeft, Copy, Link, Check, X, Pause, ListOrdered, CheckCircle, AlertTriangle, Edit3, Users, Crown, RefreshCw } from 'lucide-react';
import * as Tooltip from '@radix-ui/react-tooltip';
import * as Dialog from '@radix-ui/react-dialog';
import { RecoveryRefundTable } from '@/components/recovery/RecoveryRefundTable';
import { RecoveryStateBadge } from '@/components/recovery/RecoveryStateBadge';
import { getCircleConfigFieldsFromDynamicFields } from '@/lib/circle-config';
import {
  getMigrationLedgerFromDynamicFields,
  resolveMigrationRatification,
  type MigrationLedger,
} from '@/lib/circle-migration';
import {
  getRecoveryAutoReleaseUiState,
  parseRecoveryStatus,
  type RecoveryStatusSnapshot,
} from '@/lib/recovery-liveness';
import {
  getRecoveryDelegateValidationError,
  normalizeRecoveryDelegateAddress,
} from '@/lib/recovery-delegate';
import {
  loadRecoveryExecutionStatus,
  type RecoveryExecutionStatus,
} from '@/lib/recovery-execution';
import { getRecoveryProposalUiState, getRecoveryDelegateCardCopy } from '@/lib/recovery-ui';
import { resolveCustodyWalletId } from '@/lib/custody-wallet-discovery';
import { resolveStablecoinMetadata } from '@/lib/stablecoin-metadata';
import { priceService } from '../../../../services/price-service';
import { JoinRequest } from '../../../../services/database-service';
import { getCirclePackageId, getSuiClientFromPool } from '../../../../services/circle-service';
import {
  getCurrentRpcUrl,
  getCurrentNetwork,
} from '../../../../services/network-config';
import RotationOrderList from '../../../../components/RotationOrderList';
import CircleMigrationPanel from '../../../../components/CircleMigrationPanel';
import ConfirmationModal from '../../../../components/ConfirmationModal';
import BillingUpsellModal, {
  parseUpgradeRequired,
  type UpgradeRequiredDetails,
} from '@/components/BillingUpsellModal';
import { humanizeErrorMessage } from '@/lib/user-error-messages';
import {
  ZkLoginClient,
  ZkLoginError,
} from '../../../../services/zkLoginClient';
import WhatsAppCircleIntegration from '../../../../components/WhatsAppCircleIntegration';
import CycleEscrowPanel from '@/components/CycleEscrowPanel';
import MilestonesManageCard from '@/components/milestones/MilestonesManageCard';
import { resolveCircleSettlementCoin } from '@/lib/circle-settlement';
import { readObject, queryEventsCached, invalidateObject, invalidateSuiRead } from '@/lib/sui-read';
import { logSuiReadError } from '@/services/sui-rpc-failover';
import type { NetworkType } from '@/services/whatsapp-registry-service';

// Define a proper Circle type to fix linter errors
interface Circle {
  id: string;
  name: string;
  admin: string;
  contributionAmount: number;
  contributionAmountUsd: number;
  currencyType?: string; // Add currency type field
  securityDeposit: number;
  securityDepositUsd: number;
  cycleLength: number;
  cycleDay: number;
  maxMembers: number;
  currentMembers: number;
  currentCycle: number; // Add currentCycle property
  nextPayoutTime: number;
  isActive: boolean;
  autoSwapEnabled: boolean;
  paused: boolean; // Added paused state flag
  custody?: {
    walletId: string;
    stablecoinEnabled: boolean;
    stablecoinType: string;
    stablecoinCoinType?: string;
    stablecoinBalance: number;
    suiBalance: number;
    securityDeposits?: number;
  };
}

// Assuming we'll need a Member type as well
interface Member {
  address: string;
  memberObjectId?: string;
  joinDate?: number;
  status: 'active' | 'suspended' | 'exited';
  position?: number; // Add position field
  depositPaid?: boolean; // Add depositPaid field
  depositBalanceRaw?: bigint;
  lastContributionRaw?: bigint;
}

type ManageSectionKey = 'overview' | 'recovery' | 'members' | 'approvals' | 'invite' | 'actions' | 'tools';

// Debug logging utility
const DEBUG = process.env.NODE_ENV === 'development';
const debugLog = (message: string, data?: unknown) => {
  if (DEBUG) {
    console.log(`[CircleManage] ${message}`, data || '');
  }
};

// Utility function to get shortened address for logs
const shortenAddress = (address: string) => {
  if (!address) return '';
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
};

const normalizeAddress = (value: string | null | undefined): string | null =>
  typeof value === 'string' && value.length > 0 ? value.toLowerCase() : null;

type DynamicFieldRef = {
  objectId: string;
  objectType?: string;
  name?: {
    type?: string;
    value?: unknown;
  };
};

const parseU64Like = (value: unknown): bigint => {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.max(0, Math.trunc(value)));
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  return 0n;
};

const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
};

const extractNestedBalance = (value: unknown): bigint => {
  if (value === null || typeof value === 'undefined') return 0n;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') {
    return parseU64Like(value);
  }

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if ('fields' in record && record.fields && typeof record.fields === 'object') {
      const fields = record.fields as Record<string, unknown>;
      if ('value' in fields) {
        return extractNestedBalance(fields.value);
      }
    }
    if ('value' in record) {
      return extractNestedBalance(record.value);
    }
  }

  return 0n;
};

const toDisplayAmount = (value: bigint, decimals: number): number => {
  if (value <= 0n) return 0;
  return Number(value) / 10 ** decimals;
};

const formatTokenAmount = (value: number, maxFractionDigits: number): string => {
  if (!Number.isFinite(value)) return '0';
  const fixed = value.toFixed(maxFractionDigits);
  return fixed.replace(/\.?0+$/, '');
};

const normalizeMoveTypeKey = (value: string): string => value.trim().toLowerCase().replace(/^0x/, '');

const readCustodyCoinBalance = async (
  client: SuiClient,
  walletDynamicFields: DynamicFieldRef[],
  coinType: string
): Promise<bigint> => {
  if (!coinType) return 0n;

  const normalizedCoinType = normalizeMoveTypeKey(coinType);
  let total = 0n;

  const typedField = walletDynamicFields.find((field) => {
    const nameValue = field.name?.value;
    return typeof nameValue === 'string' && normalizeMoveTypeKey(nameValue) === normalizedCoinType;
  });

  if (typedField?.objectId) {
    try {
      const fieldObject = await client.getObject({
        id: typedField.objectId,
        options: { showContent: true }
      });

      if (fieldObject.data?.content && 'fields' in fieldObject.data.content) {
        const fieldContent = fieldObject.data.content.fields as Record<string, unknown>;
        total += extractNestedBalance(fieldContent.value);
      }
    } catch (error) {
      debugLog('Failed to read typed custody balance field', { coinType, error });
    }
  }

  const legacyCoinFields = walletDynamicFields.filter(
    (field) =>
      typeof field.objectType === 'string' &&
      (
        field.objectType.toLowerCase().includes(`::coin::coin<0x${normalizedCoinType}>`) ||
        field.objectType.toLowerCase().includes(`::coin::coin<${normalizedCoinType}>`)
      )
  );

  if (legacyCoinFields.length > 0) {
    const legacyCoinObjects = await Promise.all(
      legacyCoinFields.map((field) =>
        client.getObject({
          id: field.objectId,
          options: { showContent: true }
        })
      )
    );

    for (const coinObject of legacyCoinObjects) {
      if (coinObject.data?.content && 'fields' in coinObject.data.content) {
        const coinFields = coinObject.data.content.fields as Record<string, unknown>;
        total += parseU64Like(coinFields.balance);
      }
    }
  }

  return total;
};

// Utility function to extract configuration from transaction inputs
const extractConfigFromTransactionInputs = (inputs: { type?: string; value?: unknown }[]): Record<string, unknown> => {
  const transactionInput: Record<string, unknown> = {};
  
  if (inputs.length > 1 && inputs[1]?.type === 'pure') transactionInput.contribution_amount = inputs[1].value;
  if (inputs.length > 2 && inputs[2]?.type === 'pure') transactionInput.currency_type = inputs[2].value;
  if (inputs.length > 3 && inputs[3]?.type === 'pure') transactionInput.contribution_amount_local = inputs[3].value;
  if (inputs.length > 4 && inputs[4]?.type === 'pure') transactionInput.security_deposit = inputs[4].value;
  if (inputs.length > 5 && inputs[5]?.type === 'pure') transactionInput.security_deposit_local = inputs[5].value;
  if (inputs.length > 6 && inputs[6]?.type === 'pure') transactionInput.cycle_day = inputs[6].value;
  
  return transactionInput;
};

// Utility function to process configuration values
const processConfigValues = (
  transactionInput: Record<string, unknown> | undefined,
  circleCreationEventData: CircleCreatedEvent | undefined
) => {
  const configValues = {
    contributionAmount: 0,
    contributionAmountUsd: 0,
    securityDeposit: 0,
    securityDepositUsd: 0,
    cycleLength: 0,
    cycleDay: 1,
    maxMembers: 3,
    autoSwapEnabled: false,
  };

  // Use values from transaction/event first (most reliable for creation)
  if (transactionInput) {
    if (transactionInput.contribution_amount) configValues.contributionAmount = Number(transactionInput.contribution_amount) / 1e9;
    if (transactionInput.security_deposit) configValues.securityDeposit = Number(transactionInput.security_deposit) / 1e9;
    if (transactionInput.cycle_day) configValues.cycleDay = Number(transactionInput.cycle_day);
    
    // Handle local currency amounts (new format)
    if (transactionInput.contribution_amount_local) {
      configValues.contributionAmountUsd = Number(transactionInput.contribution_amount_local) / 100;
    } else if (transactionInput.contribution_amount_usd) {
      configValues.contributionAmountUsd = Number(transactionInput.contribution_amount_usd) / 100;
    }
    
    if (transactionInput.security_deposit_local) {
      configValues.securityDepositUsd = Number(transactionInput.security_deposit_local) / 100;
    } else if (transactionInput.security_deposit_usd) {
      configValues.securityDepositUsd = Number(transactionInput.security_deposit_usd) / 100;
    }
  }
  
  if (circleCreationEventData) {
    if (circleCreationEventData.cycle_length) configValues.cycleLength = Number(circleCreationEventData.cycle_length);
    if (circleCreationEventData.max_members) configValues.maxMembers = Number(circleCreationEventData.max_members);
    
    // Use local currency amounts if available (new format)
    if (circleCreationEventData.contribution_amount_local) {
      configValues.contributionAmountUsd = Number(circleCreationEventData.contribution_amount_local) / 100;
    }
    if (circleCreationEventData.security_deposit_local) {
      configValues.securityDepositUsd = Number(circleCreationEventData.security_deposit_local) / 100;
    }
  }
  
  return configValues;
};

// Utility function to check member deposit status using multiple methods
const checkMemberDepositStatus = async (
  client: SuiClient,
  circleId: string,
  membersTableId: string | undefined,
  address: string,
  memberActivatedEvents: SuiEvent[],
  custodyEvents: SuiEvent[],
  securityReturnedEvents: SuiEvent[]
): Promise<{ hasPaid: boolean; position?: number; depositBalanceRaw: bigint; lastContributionRaw: bigint; memberObjectId: string | null }> => {
  let hasPaid = false;
  let position: number | undefined = undefined;
  let depositBalanceRaw = 0n;
  let lastContributionRaw = 0n;
  let memberObjectId: string | null = null;
  let resolvedFromStruct = false;
  
  try {
    // Method 1: Try fetching the Member struct directly for the deposit_paid flag
    if (membersTableId) {
      const memberField = await client.getDynamicFieldObject({
        parentId: membersTableId,
        name: { type: 'address', value: address }
      });

      const candidateObjectId = (memberField.data as { objectId?: string } | undefined)?.objectId;
      if (typeof candidateObjectId === 'string' && candidateObjectId.length > 0) {
        memberObjectId = candidateObjectId;
      }
      
      if (memberField.data?.content && 'fields' in memberField.data.content) {
        const memberFields = memberField.data.content.fields as {
          value?: {
            fields?: {
              deposit_paid?: boolean,
              deposit_balance?: string | number,
              last_contribution?: string | number,
              payout_position?: { fields?: { vec?: string[] } }
            }
          }
        };
        
        if (memberFields.value?.fields?.deposit_paid !== undefined) {
          resolvedFromStruct = true;
          hasPaid = Boolean(memberFields.value.fields.deposit_paid);
          depositBalanceRaw = parseU64Like(memberFields.value.fields.deposit_balance);
          lastContributionRaw = parseU64Like(memberFields.value.fields.last_contribution);
          debugLog(`Deposit status from Member struct`, { address: shortenAddress(address), hasPaid });
          
          // Also try to get position if available
          if (memberFields.value.fields.payout_position?.fields?.vec?.length) {
            try {
               position = parseInt(memberFields.value.fields.payout_position.fields.vec[0], 10);
            } catch (parseErr) { 
              debugLog('Failed to parse position from struct', parseErr);
            }
          }
        }
      }
    }
  } catch {
    debugLog(`Could not fetch Member struct directly for ${shortenAddress(address)}, using events`, null);
  }
  
  // Method 2: Fallback to MemberActivated Event (using pre-fetched data)
  if (!resolvedFromStruct && !hasPaid) {
     hasPaid = memberActivatedEvents.some(event => {
       const parsed = event.parsedJson as { circle_id?: string; member?: string };
       return parsed?.circle_id === circleId && parsed?.member === address;
     });
     if(hasPaid) debugLog(`Deposit status from MemberActivated event`, { address: shortenAddress(address), hasPaid });
  }

  // Method 3: Fallback to CustodyDeposited Event (Type 3, using pre-fetched data)
  if (!resolvedFromStruct && !hasPaid) {
    hasPaid = custodyEvents.some(e => {
       const p = e.parsedJson as { circle_id?: string; member?: string; operation_type?: number | string };
       return p?.circle_id === circleId && p?.member === address && (p?.operation_type === 3 || p?.operation_type === "3");
    });
    if(hasPaid) debugLog(`Deposit status from CustodyDeposited event`, { address: shortenAddress(address), hasPaid });
  }

  // Check SecurityDepositReturned Event to override hasPaid (using pre-fetched data)
  try {
    if (resolvedFromStruct) {
      return { hasPaid, position, depositBalanceRaw, lastContributionRaw, memberObjectId };
    }

    const hasReturnedEvent = securityReturnedEvents.some(event => {
      const parsed = event.parsedJson as { circle_id?: string; member?: string; };
      return parsed?.circle_id === circleId && parsed?.member?.toLowerCase() === address.toLowerCase();
    });

    if (hasReturnedEvent) {
      hasPaid = false; // Override: if a deposit was returned, it's no longer considered paid
      depositBalanceRaw = 0n;
      debugLog(`Deposit marked as UNPAID due to SecurityDepositReturned event`, { address: shortenAddress(address) });
    }
  } catch (eventError) {
    debugLog(`Error checking SecurityDepositReturned events`, { address: shortenAddress(address), error: eventError });
  }
  
  return { hasPaid, position, depositBalanceRaw, lastContributionRaw, memberObjectId };
};

// Constants for time calculations
const MS_PER_DAY = 86400000; // 24 * 60 * 60 * 1000
// Define types for SUI object field values
type SuiFieldValue = string | number | boolean | null | undefined | SuiFieldValue[] | Record<string, unknown>;

// Refine the parseMoveError function with a new regex and more logging
const parseMoveError = (error: string): { code: number; message: string } => {
  // **Revised Regex:** Try a simpler pattern to capture the code after MoveAbort
  const moveAbortMatch = error.match(/MoveAbort\(MoveLocation \{ module: ModuleId \{ address: [0-9a-fA-Fx]+, name: Identifier\("([^\"]+)"\) \}, function: \d+, instruction: \d+, function_name: Some\("([^\"]+)"\) \}, (\d+)\)/);

  if (moveAbortMatch && moveAbortMatch[1] && moveAbortMatch[2] && moveAbortMatch[3]) { 
    const moduleName = moveAbortMatch[1];
    const functionName = moveAbortMatch[2];
    const codeString = moveAbortMatch[3];
    console.log(`[parseMoveError] MoveAbort matched. Module: ${moduleName}, Function: ${functionName}, Raw code string: "${codeString}"`); 
    try {
      const code = parseInt(codeString, 10);
      console.log(`[parseMoveError] Parsed code: ${code}`); 

      if (isNaN(code)) {
         console.error("[parseMoveError] Failed to parse code number.");
         // Fall through to generic error if parsing fails
      } else {
        // Specific error mapping based on module/function and code
        if (moduleName === 'njangi_circles' && (functionName === 'admin_approve_member' || functionName === 'admin_approve_members')) {
            switch (code) {
                case 7: return { code, message: 'Only the circle admin can perform this action.' };
                case 5: // ECircleFull in the context of approve_member means already a member
                    return { code, message: 'Member approval failed: This user is already a member of the circle.' };
                case 29: // ECircleCapacityReached
                    return { code, message: 'Cannot add more members: Circle has reached its maximum member limit.' };
                case 58: // ECircleNotPausedForConfigChange
                    return { code, message: 'New members can only be added before the circle starts, or while it is paused between rounds. A member added mid-round has no place in the payout order and could never be paid.' };
                default:
                    return { code, message: `Circle Error ${code}: Member approval failed.` };
            }
        }
        
        if (moduleName === 'njangi_circles' && functionName === 'activate_circle') {
            switch (code) {
                case 7: return { code, message: 'Only the circle admin can perform this action.' };
                case 21: return { code, message: 'Circle activation failed: Some members have not paid their security deposits yet.' };
                case 22: return { code, message: 'Circle activation failed: The circle needs to have at least 3 members before activation.' }; // Updated based on Move code
                case 54: return { code, message: 'Circle activation failed: The circle is already active.' }; // ECircleNotActive
                case 55: return { code, message: 'Circle activation failed: The circle is already active.' }; // ECircleIsActive
                case 71: return { code, message: 'Circle activation failed: Next in command must be an active non-admin member before the circle goes live.' };
                case 79: return { code, message: 'Circle activation failed: Every member must confirm where this circle currently stands before it can start.' };
                default: return { code, message: `Activation Error ${code}: Operation failed.` };
            }
        }
        
        if (
          moduleName === 'njangi_circles'
          && (
            functionName === 'declare_migration_state'
            || functionName === 'acknowledge_migration_state'
            || functionName === 'clear_migration_state'
          )
        ) {
            switch (code) {
                case 7: return { code, message: "Only the circle admin can record where the circle stands" };
                case 8: return { code, message: "Only members in the payout order can confirm this" };
                case 29: return { code, message: "That position is outside this circle's payout order" };
                case 55: return { code, message: "The circle has already started, so its history can no longer be changed" };
                case 76: return { code, message: "This circle has no recorded history to confirm" };
                case 77: return { code, message: "The details changed since you opened this page. Reload and confirm again." };
                case 78: return { code, message: "You have already confirmed this" };
                case 80: return { code, message: "Give every member a place in the payout order first" };
                case 81: return { code, message: "There is nothing to record — this is an ordinary new circle" };
                default: return { code, message: `Migration Error ${code}: Operation failed.` };
            }
        }

        if (moduleName === 'njangi_circles' && (functionName === 'set_rotation_position' || functionName === 'reorder_rotation_positions')) {
            switch(code) {
                case 7: return { code, message: "Only the circle admin can set rotation positions" };
                case 8: return { code, message: "Member is not part of this circle" };
                case 29: // EInvalidRotationPosition or EInvalidRotationLength depending on function
                    return { code, message: "Position/Order Error: Invalid position or order length provided." }; 
                case 30: return { code, message: "Position is already taken by another member" };
                default: return { code, message: `Rotation Error ${code}: Operation failed.` };
            }
        }

        if (
          moduleName === 'njangi_circles' &&
          (
            functionName === 'propose_emergency_stop'
            || functionName === 'vote_emergency_stop'
            || functionName === 'execute_recovery'
            || functionName === 'trigger_auto_release'
          )
        ) {
          switch (code) {
            case 7: return { code, message: 'Only the circle admin can propose an emergency stop.' };
            case 62: return { code, message: 'No eligible active members are available to vote on an emergency stop.' };
            case 63: return { code, message: 'This wallet is not eligible to vote on the current emergency stop proposal.' };
            case 64: return { code, message: 'This wallet has already voted on the current emergency stop proposal.' };
            case 65: return { code, message: 'The emergency stop proposal has expired and needs to be proposed again.' };
            case 66: return { code, message: 'Voting is already closed for this emergency stop proposal.' };
            case 67: return { code, message: 'No emergency stop proposal is currently active for this circle.' };
            case 68: return { code, message: 'Recovery execution is not ready yet. Wait for majority approval or the auto-release deadline.' };
            case 69: return { code, message: 'The custody wallet does not hold enough funds to complete recovery refunds.' };
            case 70: return { code, message: 'Recovery member snapshot is inconsistent with the circle roster. Refresh and try again.' };
            case 71: return { code, message: 'The next in command must be a different wallet from the admin.' };
            case 72: return { code, message: 'Delegate updates are locked once recovery has left the active state.' };
            case 73: return { code, message: 'This wallet is not currently authorized to trigger auto-release. The delegate keeps exclusive authority for the first 24 hours after heartbeat expiry.' };
            default: return { code, message: `Emergency stop error ${code}: Operation failed.` };
          }
        }

        if (moduleName === 'njangi_circle_config') {
          switch (code) {
            case 64: return { code, message: 'An emergency stop proposal is already active for this circle.' };
            case 65: return { code, message: 'Recovery proposal data is missing for this circle.' };
            case 66: return { code, message: 'The recovery deadline is invalid.' };
            case 67: return { code, message: 'This recovery state transition is not allowed.' };
            case 68: return { code, message: 'Auto-release circles need a next-in-command before activation and while active.' };
            default:
              break;
          }
        }
        
        // Fallback for other known codes (adjust module/function if needed)
        switch (code) {
          case 1: return { code, message: 'Invalid contribution amount.' };
          case 2: return { code, message: 'Incorrect security deposit amount.' };
          case 100: return { code, message: 'Switching to stablecoin payout. SUI balance insufficient but stablecoins are available.' };
          // Add more generic mappings if needed
          default:
             return { code, message: `Error code ${code}: Operation failed. Please check details or contact support.` };
        }
      }
    } catch (parseError) {
       console.error("[parseMoveError] Error during code parsing:", parseError);
       // Fall through if parsing throws error
    }
  } else {
     console.log("[parseMoveError] MoveAbort pattern did not match."); 
  }

  // --- Fallback Logic --- (keep as is)
  if (error.includes('authentication') || error.includes('expired') ||
      error.includes('session') || error.includes('login')) {
    console.log("[parseMoveError] Matched authentication error."); 
    return { code: 401, message: 'Your session has expired. Please log in again to continue.' };
  }

  // Final fallback: never surface machine codes (UPGRADE_REQUIRED, raw
  // MoveAbort dumps) to the user — humanizeErrorMessage maps known codes
  // and collapses unknown ones to a generic message. The raw string is
  // already in the console via the call sites' console.error.
  const cleanedMessage = error.replace('zkLogin signature error: ', '').split(' in command')[0] || 'An unknown error occurred.';
  console.log("[parseMoveError] Using final fallback message:", cleanedMessage);
  return { code: 0, message: humanizeErrorMessage(cleanedMessage) };
};

// Define an error code mapping for rotation position errors
const rotationErrorCodes: Record<number, string> = {
  7: "Only the circle admin can set rotation positions",
  8: "Member is not part of this circle",
  29: "Position is outside of maximum members range",
  30: "Position is already taken by another member"
};

// Define CircleCreatedEvent interface
interface CircleCreatedEvent {
  circle_id: string;
  admin: string;
  name: string;
  contribution_amount: string;
  currency_type?: string;                  // Currency code (e.g., "USD", "XAF", "NGN")
  contribution_amount_local?: string;      // Amount in local currency
  security_deposit_local?: string;         // Amount in local currency
  contribution_amount_usd: string;
  security_deposit_usd: string;
  max_members: string;
  cycle_length: string;
}

// Skeleton component for loading state
const ManageCircleSkeleton = () => (
  <div className="animate-pulse space-y-6">
    <div className="rounded-[32px] border border-stone-200 bg-white px-8 py-8 shadow-[0_24px_70px_-42px_rgba(15,23,42,0.32)]">
      <div className="h-4 w-28 rounded-full bg-stone-200"></div>
      <div className="mt-4 h-10 w-72 rounded-full bg-stone-200"></div>
      <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="rounded-[24px] border border-stone-200 bg-stone-50 p-5">
            <div className="h-3 w-20 rounded-full bg-stone-200"></div>
            <div className="mt-3 h-6 w-28 rounded-full bg-stone-200"></div>
          </div>
        ))}
      </div>
    </div>
    {Array.from({ length: 3 }).map((_, index) => (
      <div
        key={index}
        className="rounded-[28px] border border-stone-200 bg-white px-6 py-6 shadow-[0_18px_50px_-38px_rgba(15,23,42,0.24)]"
      >
        <div className="h-5 w-36 rounded-full bg-stone-200"></div>
        <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="h-24 rounded-[24px] bg-stone-100"></div>
          <div className="h-24 rounded-[24px] bg-stone-100"></div>
        </div>
      </div>
    ))}
  </div>
);

// Add getJsonRpcUrl helper if not already present globally
const getJsonRpcUrl = (): string => {
  return getCurrentRpcUrl();
};

/**
 * Runs a client-signed transaction and shapes the outcome like the
 * `fetch` + `response.json()` pair these call sites were written against.
 *
 * These actions used to POST to /api/zkLogin and be signed with the
 * server-held ephemeral key. That key is gone, so they began returning 409
 * and the whole manage page stopped working. Preserving the response/result
 * shape keeps the surrounding error handling — including the 401 re-login
 * branch — untouched, so this migration cannot quietly change how failures
 * surface to the admin.
 */
async function runSignedTx(
  fn: () => Promise<{ digest: string }>,
): Promise<{
  response: { ok: boolean; status: number };
  // `status` and `details` appear on some server error bodies these sites
  // already destructure; kept so their handling still compiles and reads.
  result: { digest?: string; error?: string; status?: string; details?: string };
}> {
  try {
    const r = await fn();
    return { response: { ok: true, status: 200 }, result: { digest: r.digest } };
  } catch (err) {
    const requireRelogin = err instanceof ZkLoginError && err.requireRelogin;
    return {
      response: { ok: false, status: requireRelogin ? 401 : 500 },
      result: {
        error: err instanceof Error ? err.message : 'Transaction failed',
      },
    };
  }
}

export default function ManageCircle() {
  const router = useRouter();
  const { id } = router.query;
  const { isAuthenticated, isLoading: authLoading, userAddress, account } = useAuth();
  const [loading, setLoading] = useState(true);
  const [circle, setCircle] = useState<Circle | null>(null);
  const [circlePackageId, setCirclePackageId] = useState<string | null>(null);
  const [recoveryStatus, setRecoveryStatus] = useState<RecoveryStatusSnapshot | null>(null);
  // Starts true. A null snapshot is indistinguishable from "auto-release is
  // disabled" once it reaches getRecoveryAutoReleaseUiState, so treating the
  // pre-fetch frame as loaded made the page announce a settled state it had
  // not read yet — and after the delegate-copy fix that would have been a
  // false all-clear on a safety control rather than a harmless over-warning.
  const [loadingRecoveryStatus, setLoadingRecoveryStatus] = useState(true);
  // Distinguishes "read failed" from "still loading"; the catch below used to
  // leave both looking identical to a successfully-loaded disabled circle.
  const [recoveryStatusError, setRecoveryStatusError] = useState(false);
  const [recoveryExecution, setRecoveryExecution] = useState<RecoveryExecutionStatus | null>(null);
  const [loadingRecoveryExecution, setLoadingRecoveryExecution] = useState(false);
  const [isSubmittingRecoveryAction, setIsSubmittingRecoveryAction] = useState(false);
  const [isEditingRecoveryDelegate, setIsEditingRecoveryDelegate] = useState(false);
  const [recoveryDelegateDraft, setRecoveryDelegateDraft] = useState('');
  const [isUpdatingRecoveryDelegate, setIsUpdatingRecoveryDelegate] = useState(false);
  const [members, setMembers] = useState<Member[]>([]);
  const [pendingRequests, setPendingRequests] = useState<JoinRequest[]>([]);
  const [suiPrice, setSuiPrice] = useState(1.25);
  const [copiedId, setCopiedId] = useState(false);
  const [isApproving, setIsApproving] = useState(false);
  const [isEditingRotation, setIsEditingRotation] = useState(false);
  // Mid-cycle migration: where a circle that was already running elsewhere
  // stands, and who has confirmed it. Null for an ordinary new circle.
  const [migrationLedger, setMigrationLedger] = useState<MigrationLedger | null>(null);
  const [isMigrationBusy, setIsMigrationBusy] = useState(false);
  const [confirmationModal, setConfirmationModal] = useState({
    isOpen: false,
    title: '',
    message: '' as string | React.ReactNode,
    onConfirm: () => {},
    confirmText: 'Confirm',
    cancelText: 'Cancel',
    confirmButtonVariant: 'primary' as 'primary' | 'danger' | 'warning',
  });
  const [allDepositsPaid, setAllDepositsPaid] = useState(false);
  const [suiSecurityDepositBalance, setSuiSecurityDepositBalance] = useState<number | null>(null);
  const [suiContributionBalance, setSuiContributionBalance] = useState<number | null>(null);
  const [usdcSecurityDepositBalance, setUsdcSecurityDepositBalance] = useState<number | null>(null);
  const [usdcContributionBalance, setUsdcContributionBalance] = useState<number | null>(null);
  const [fetchingUsdcBalance, setFetchingUsdcBalance] = useState(false);
  const [fetchingSuiBalance, setFetchingSuiBalance] = useState(false);
  const [paidOutInCurrentSessionMembers, setPaidOutInCurrentSessionMembers] = useState<Set<string>>(new Set());

  // State for local currency display of custody USDC balances in manage page
  const [manageCustodyUsdcTotalLocalDisplay, setManageCustodyUsdcTotalLocalDisplay] = useState<string | null>(null);
  const [manageCustodyUsdcSecurityDepositLocalDisplay, setManageCustodyUsdcSecurityDepositLocalDisplay] = useState<string | null>(null);
  const [manageCustodyUsdcContributionLocalDisplay, setManageCustodyUsdcContributionLocalDisplay] = useState<string | null>(null);

  // State for contribution tracking
  const [contributionStatus, setContributionStatus] = useState<{
    contributedMembers: Set<string>;
    activeMembersInRotation: string[];
    currentCycle: number;
    totalActiveInRotation: number;
    currentPosition?: number | null;
  }>({
    contributedMembers: new Set<string>(),
    activeMembersInRotation: [],
    currentCycle: 0,
    totalActiveInRotation: 0,
  });
  const [loadingContributions, setLoadingContributions] = useState(false);

  // Phase 12 UX chain: when the admin successfully activates the circle,
  // we set this flag so the CycleEscrowPanel automatically opens the
  // first contribution round once it sees `isActive=true`. Cleared by
  // the panel's `onAutoOpenFired` callback after firing once.
  const [autoOpenFirstRound, setAutoOpenFirstRound] = useState(false);
  // The Member type on this page is address-only; the panel falls back
  // to shortened addresses when no display name is mapped.
  const memberNameMap = useMemo<Record<string, string>>(() => ({}), []);

  // Add state variables for max members editing
  const [isEditingMaxMembers, setIsEditingMaxMembers] = useState(false);
  const [newMaxMembersValue, setNewMaxMembersValue] = useState<number | string>('');
  const [isSavingMaxMembers, setIsSavingMaxMembers] = useState(false);
  // Entitlement 402s (e.g. member cap above the free plan) render the
  // upsell modal instead of a raw error toast.
  const [upsell, setUpsell] = useState<UpgradeRequiredDetails | null>(null);

  // Add state for member count visual animation
  const [animateMembers, setAnimateMembers] = useState(false);
  const recommendedRanges = {
    small: { min: 3, max: 5, label: 'Small circle (3-5 members)', description: 'Faster payout cycles, easier to manage' },
    medium: { min: 6, max: 10, label: 'Medium circle (6-10 members)', description: 'Balanced payout frequency and total pool size' },
    large: { min: 11, max: 20, label: 'Large circle (11-20 members)', description: 'Larger pool, longer wait for payouts' }
  };

  // Add state for security deposit payout modal
  const [showPayoutDepositModal, setShowPayoutDepositModal] = useState(false);
  const [selectedMembersForPayout, setSelectedMembersForPayout] = useState<Set<string>>(new Set());
  const [isProcessingPayout, setIsProcessingPayout] = useState(false);
  const [payoutProgress, setPayoutProgress] = useState<{current: number, total: number}>({current: 0, total: 0});
  const [isMobileOverviewSheetOpen, setIsMobileOverviewSheetOpen] = useState(false);
  const [selectedMobileMember, setSelectedMobileMember] = useState<Member | null>(null);
  const manageSectionRefs = useRef<Record<ManageSectionKey, HTMLElement | null>>({
    overview: null,
    recovery: null,
    members: null,
    approvals: null,
    invite: null,
    actions: null,
    tools: null,
  });

  useEffect(() => {
    if (authLoading) {
      return;
    }

    if (!isAuthenticated) {
      router.replace('/');
      return;
    }
  }, [authLoading, isAuthenticated, router]);

  useEffect(() => {
    setLoading(true);
    if (id && userAddress) {
      fetchCircleDetails();
    }
    // `fetchCircleDetails` closes over id/userAddress already.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, userAddress]);

  useEffect(() => {
    const fetchPrice = async () => {
      try {
        const price = await priceService.getSUIPrice();
        if (price !== null) {
          setSuiPrice(price);
        }
      } catch (error) {
        console.error('Error fetching SUI price:', error);
      }
    };
    fetchPrice();
  }, []);

  useEffect(() => {
    if (id && userAddress) {
      fetchPendingRequests();
    }
    // `fetchPendingRequests` closes over id/userAddress already.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, userAddress]);

  // Initialize newMaxMembersValue when circle data is loaded
  useEffect(() => {
    if (circle) {
      setNewMaxMembersValue(circle.maxMembers);
    }
  }, [circle]);

  // Add request deduplication
  const [isFetching, setIsFetching] = useState(false);
  
  const fetchCircleDetails = async () => {
    if (!id || !userAddress || isFetching) return;
    
    debugLog('Fetching circle details', { circleId: id });
    setIsFetching(true);
    setLoading(true);

    // This is the single refresh entry point (also called after every admin
    // write), so drop cached reads for this circle first — a refetch must
    // reflect the latest chain state. Same-mount dedup still works: the first
    // read below repopulates the cache for the rest of the burst.
    invalidateObject(id as string);
    invalidateSuiRead('events:');

    try {
      const client = getSuiClientFromPool(getJsonRpcUrl());
      
      // Determine package ID for this circle
      const determinedPackageId = await getCirclePackageId(id as string, userAddress);
      setCirclePackageId(determinedPackageId);
      debugLog('Using package ID', determinedPackageId);
      
      // Parallel fetch: Get circle object and dynamic fields simultaneously
      const [objectData, dynamicFieldsResult] = await Promise.all([
        readObject(id as string, { showContent: true, showType: true }),
        client.getDynamicFields({ parentId: id as string })
      ]);
      
      debugLog('Circle object loaded', { hasContent: !!objectData.data?.content });
        
      if (!objectData.data?.content || !('fields' in objectData.data.content)) {
        console.error('Invalid circle object data received');
        // Don't set loading to false here, let it be handled in the finally block
        return;
      }
        
      const fields = objectData.data.content.fields as Record<string, SuiFieldValue>;
        
      if (fields.admin !== userAddress) {
          toast.error('Only the admin can manage this circle');
          router.push(`/circle/${id}`);
          return;
        }
        
      debugLog('Dynamic fields loaded', { count: dynamicFieldsResult.data.length });
      
      let transactionInput: Record<string, unknown> | undefined;
      let creationTimestamp: number | null = fields.created_at ? Number(fields.created_at) : null;
      let circleCreationEventData: CircleCreatedEvent | undefined;
      
      try {
        // Parallel fetch: Get circle events and activation status
        const [circleEvents] = await Promise.all([
          queryEventsCached({
            query: { MoveEventType: `${determinedPackageId}::njangi_circles::CircleCreated` },
            limit: 50
          })
        ]);
        
        const createEvent = circleEvents.data.find(event => 
          (event.parsedJson as { circle_id?: string })?.circle_id === id
        );
        
        debugLog('Creation event found', !!createEvent);
        
        if (createEvent?.parsedJson) {
          circleCreationEventData = createEvent.parsedJson as CircleCreatedEvent;
          creationTimestamp = Number(createEvent.timestampMs);
          
          // Extract initial amounts from event data
          transactionInput = {
            contribution_amount: circleCreationEventData.contribution_amount,
            contribution_amount_usd: circleCreationEventData.contribution_amount_usd,
            security_deposit_usd: circleCreationEventData.security_deposit_usd,
          };
          
          // Try to get local currency amounts if available (new format)
          if (circleCreationEventData.contribution_amount_local) {
            transactionInput.contribution_amount_local = circleCreationEventData.contribution_amount_local;
          }
          if (circleCreationEventData.security_deposit_local) {
            transactionInput.security_deposit_local = circleCreationEventData.security_deposit_local;
          }
          
          debugLog('Creation event data extracted', {
            hasContribution: !!circleCreationEventData.contribution_amount,
            hasLocalCurrency: !!circleCreationEventData.contribution_amount_local,
            currencyType: circleCreationEventData.currency_type
          });
        }

        if (createEvent?.id?.txDigest) {
          const txData = await client.getTransactionBlock({
            digest: createEvent.id.txDigest,
            options: { showInput: true }
          });
          
          debugLog('Transaction data fetched', !!txData);
          
          if (txData?.transaction?.data?.transaction?.kind === 'ProgrammableTransaction') {
            const tx = txData.transaction.data.transaction;
            const inputs = tx.inputs || [];

            // Ensure transactionInput is initialized
            if (!transactionInput) transactionInput = {};

            // Extract transaction inputs using utility function
            const extractedInputs = extractConfigFromTransactionInputs(inputs);
            Object.assign(transactionInput, extractedInputs);
            
            debugLog('Transaction inputs extracted', { inputCount: inputs.length });
        }
            }
          } catch (error) {
        debugLog('Error fetching transaction data', error);
      }
      
      // Process configuration values using utility function
      const configValues = processConfigValues(transactionInput, circleCreationEventData);
      debugLog('Config after transaction/event processing', configValues);
        
      let foundInDynamicField = false;
      try {
        const configFields = await getCircleConfigFieldsFromDynamicFields(
          client,
          dynamicFieldsResult.data,
        );

        if (configFields) {
          const resolvedConfigFields = configFields as Record<string, SuiFieldValue>;
          console.log('Manage - CircleConfig fields:', resolvedConfigFields);
          setRecoveryStatus(parseRecoveryStatus(resolvedConfigFields as Record<string, unknown>));
          setMigrationLedger(await getMigrationLedgerFromDynamicFields(client, dynamicFieldsResult.data));

          if (resolvedConfigFields.contribution_amount) {
            configValues.contributionAmount = Number(resolvedConfigFields.contribution_amount) / 1e9;
          }
          if (resolvedConfigFields.contribution_amount_usd) {
            configValues.contributionAmountUsd = Number(resolvedConfigFields.contribution_amount_usd) / 100;
          }
          if (resolvedConfigFields.security_deposit) {
            configValues.securityDeposit = Number(resolvedConfigFields.security_deposit) / 1e9;
          }
          if (resolvedConfigFields.security_deposit_usd) {
            configValues.securityDepositUsd = Number(resolvedConfigFields.security_deposit_usd) / 100;
          }
          if (resolvedConfigFields.cycle_length !== undefined) {
            configValues.cycleLength = Number(resolvedConfigFields.cycle_length);
          }
          if (resolvedConfigFields.cycle_day !== undefined) {
            configValues.cycleDay = Number(resolvedConfigFields.cycle_day);
          }
          if (resolvedConfigFields.max_members !== undefined) {
            configValues.maxMembers = Number(resolvedConfigFields.max_members);
          }
          if (resolvedConfigFields.auto_swap_enabled !== undefined) {
            const dynamicValue = Boolean(resolvedConfigFields.auto_swap_enabled);
            console.log(`[fetchCircleDetails] Found auto_swap_enabled (${dynamicValue}) in CircleConfig`);
            configValues.autoSwapEnabled = dynamicValue;
          }

          foundInDynamicField = true;
        } else {
          setRecoveryStatus(null);
        }
      } catch (error) {
        logSuiReadError('Manage - Error fetching CircleConfig fields:', error);
        setRecoveryStatus(null);
      }
      debugLog('Config after dynamic fields', { foundInDynamicField, configValues });

      // 3. Use direct fields from the circle object as a final fallback (less reliable for config)
      // Keep fallbacks for other fields if needed
      if (configValues.contributionAmount === 0 && fields.contribution_amount) configValues.contributionAmount = Number(fields.contribution_amount) / 1e9;
      if (configValues.contributionAmountUsd === 0 && fields.contribution_amount_usd) configValues.contributionAmountUsd = Number(fields.contribution_amount_usd) / 100;
      if (configValues.securityDeposit === 0 && fields.security_deposit) configValues.securityDeposit = Number(fields.security_deposit) / 1e9;
      if (configValues.securityDepositUsd === 0 && fields.security_deposit_usd) configValues.securityDepositUsd = Number(fields.security_deposit_usd) / 100;
      // Cycle info is usually more reliable from event/tx/dynamic fields

      debugLog('Final config values', configValues);
      
      debugLog('Currency configuration', {
        currencyType: circleCreationEventData?.currency_type,
        hasLocalAmounts: !!(circleCreationEventData?.contribution_amount_local || circleCreationEventData?.security_deposit_local),
        finalCurrencyType: (typeof transactionInput?.currency_type === 'string' ? transactionInput.currency_type : undefined) || circleCreationEventData?.currency_type || 'USD'
      });
      
      // Check for circle activation status
      let isActive = false;
      if (typeof fields.is_active === 'boolean') {
        isActive = fields.is_active;
      } else if (typeof fields.is_active === 'string') {
        isActive = fields.is_active.toLowerCase() === 'true';
      } else {
        try {
          const activationEvents = await queryEventsCached({
            query: { MoveEventType: `${determinedPackageId}::njangi_circles::CircleActivated` },
            limit: 50
          });
          isActive = activationEvents.data.some(event => 
            (event.parsedJson as { circle_id?: string })?.circle_id === id
          );
          debugLog('Circle activation status', isActive);
        } catch (error) {
          logSuiReadError('Error checking circle activation:', error);
        }
      }

      // Check for paused status - safely get the boolean value
      let isPaused = false;
      if (typeof fields.paused_after_cycle === 'boolean') {
        isPaused = fields.paused_after_cycle;
      } else if (fields.paused_after_cycle) {
        // Handle the case where it might be any other truthy value
        isPaused = true;
      }
      debugLog('Circle paused status', isPaused);

      // Fetch members and their addresses
      // Get member count from blockchain first (primary source)
      const blockchainMemberCount = Number(fields.current_members || 0);
      
      // Get members table ID for member discovery
      const membersTableId = fields.members && typeof fields.members === 'object' && fields.members !== null && 
        'fields' in fields.members && fields.members.fields && typeof fields.members.fields === 'object' &&
        fields.members.fields !== null && 'id' in fields.members.fields &&
        fields.members.fields.id && typeof fields.members.fields.id === 'object' &&
        fields.members.fields.id !== null && 'id' in fields.members.fields.id
        ? (fields.members.fields.id as { id: string }).id : undefined;
      
      // Get member addresses directly from blockchain members table (primary method)
      let memberAddresses = new Set<string>();
      let blockchainMemberList: string[] = [];
      const memberObjectIds = new Map<string, string>();
      
      if (membersTableId) {
        try {
          debugLog('Fetching all members from blockchain members table', membersTableId);
          const allMemberFields = await client.getDynamicFields({ 
            parentId: membersTableId 
          });

          blockchainMemberList = allMemberFields.data
            .filter((field) => field.name?.type === 'address' && typeof field.name.value === 'string')
            .map((field) => {
              const memberAddress = field.name.value as string;
              if (field.objectId && memberAddress && memberAddress !== '0x0') {
                memberObjectIds.set(memberAddress, field.objectId);
              }
              return memberAddress;
            })
            .filter((addr) => addr && addr !== '0x0');
          
          memberAddresses = new Set(blockchainMemberList);
          debugLog('Members from blockchain table', { 
            count: blockchainMemberList.length, 
            addresses: blockchainMemberList.map(addr => `${addr.slice(0, 6)}...${addr.slice(-4)}`)
          });
        } catch (error) {
          logSuiReadError('Error fetching members from blockchain table:', error);
        }
      }
      
      // Fallback: Build event-based member list if blockchain method failed
      let eventBasedMemberCount = 1; // Start with admin
      let memberEvents: { data: SuiEvent[] } = { data: [] };
      let custodyEvents: { data: SuiEvent[] } = { data: [] };
      let memberActivatedEvents: { data: SuiEvent[] } = { data: [] };
      let securityReturnedEvents: { data: SuiEvent[] } = { data: [] };
      
      if (memberAddresses.size === 0) {
        // Only fetch events if blockchain method failed
        debugLog('Falling back to event-based member discovery');
        if (typeof fields.admin === 'string') memberAddresses.add(fields.admin);
        
        try {
          [memberEvents, custodyEvents, memberActivatedEvents, securityReturnedEvents] = await Promise.all([
            queryEventsCached({
              query: { MoveEventType: `${determinedPackageId}::njangi_circles::MemberJoined` },
              limit: 1000
            }),
            queryEventsCached({
              query: { MoveEventType: `${determinedPackageId}::njangi_custody::CustodyDeposited` },
              limit: 100
            }),
            queryEventsCached({
              query: { MoveEventType: `${determinedPackageId}::njangi_members::MemberActivated` },
              limit: 100
            }),
            queryEventsCached({
              query: { MoveEventType: `${determinedPackageId}::njangi_payments::SecurityDepositReturned` },
              limit: 100
            })
          ]);
          
          const circleMemberEvents = memberEvents.data.filter((event: SuiEvent) => 
            (event.parsedJson as { circle_id?: string })?.circle_id === id
          );
          circleMemberEvents.forEach((event: SuiEvent) => {
            const memberAddr = (event.parsedJson as { member?: string })?.member;
            if (memberAddr) memberAddresses.add(memberAddr);
          });
          
          eventBasedMemberCount = memberAddresses.size;
          debugLog('Event-based member discovery', { 
            count: eventBasedMemberCount, 
            addresses: Array.from(memberAddresses).map(addr => `${addr.slice(0, 6)}...${addr.slice(-4)}`)
          });
        } catch (error) {
          logSuiReadError('Error with event-based member discovery:', error);
          eventBasedMemberCount = 1; // Default fallback
        }
      } else {
        // Still fetch events for deposit status checking, but with smaller limits since we don't need them for member discovery
        try {
          [memberEvents, custodyEvents, memberActivatedEvents, securityReturnedEvents] = await Promise.all([
            queryEventsCached({
              query: { MoveEventType: `${determinedPackageId}::njangi_circles::MemberJoined` },
              limit: 100 // Reduced limit since only used for join dates
            }),
            queryEventsCached({
              query: { MoveEventType: `${determinedPackageId}::njangi_custody::CustodyDeposited` },
              limit: 100
            }),
            queryEventsCached({
              query: { MoveEventType: `${determinedPackageId}::njangi_members::MemberActivated` },
              limit: 100
            }),
            queryEventsCached({
              query: { MoveEventType: `${determinedPackageId}::njangi_payments::SecurityDepositReturned` },
              limit: 100
            })
          ]);
        } catch (error) {
          logSuiReadError('Error fetching events for member details:', error);
          // Initialize empty arrays if event fetching fails
          memberEvents = { data: [] };
          custodyEvents = { data: [] };
          memberActivatedEvents = { data: [] };
          securityReturnedEvents = { data: [] };
        }
      }
      
      // Use blockchain count as primary, event-based as fallback
      const actualMemberCount = blockchainMemberCount > 0 ? blockchainMemberCount : eventBasedMemberCount;
      
      debugLog('Member count decision for circle management', {
        blockchainMemberCount,
        eventBasedMemberCount, 
        actualMemberCount,
        source: blockchainMemberCount > 0 ? 'blockchain' : 'events'
      });
      
      // --- Fetch Members and Deposit Status (Updated Logic) ---
      const membersList: Member[] = [];
      
      debugLog('Building member list from addresses', {
        addressCount: memberAddresses.size,
        source: blockchainMemberList.length > 0 ? 'blockchain' : 'events'
      });
      
      const depositStatusPromises = Array.from(memberAddresses).map(async (address) => {
        let joinTimestamp = creationTimestamp ?? Date.now(); // Default join time
        
        try {
          // Use utility function to check deposit status
          const { hasPaid, position, depositBalanceRaw, lastContributionRaw, memberObjectId } = await checkMemberDepositStatus(
            client,
            id as string,
            membersTableId,
            address,
            memberActivatedEvents.data,
            custodyEvents.data,
            securityReturnedEvents.data
          );

          // Find join date from MemberJoined event if possible
          const joinEvent = memberEvents.data.find((e: SuiEvent) => 
              (e.parsedJson as { member?: string })?.member === address && 
              (e.parsedJson as { circle_id?: string })?.circle_id === id
          );
          if (joinEvent?.timestampMs) {
             joinTimestamp = Number(joinEvent.timestampMs);
          }
          
          // If position wasn't found in struct, try from event (less reliable)
          const finalPosition = position ?? (
            memberEvents.data.find((e: SuiEvent) => 
              (e.parsedJson as { member?: string })?.member === address && 
              (e.parsedJson as { circle_id?: string })?.circle_id === id
            )?.parsedJson as { position?: number }
          )?.position;

          membersList.push({
            address, 
            memberObjectId: memberObjectIds.get(address) ?? memberObjectId ?? undefined,
            depositPaid: hasPaid,
            depositBalanceRaw,
            lastContributionRaw,
            status: 'active', 
            joinDate: joinTimestamp,
            position: finalPosition
          });
        } catch (error) {
          logSuiReadError(`Manage - Error fetching deposit status for ${address}:`, error);
          membersList.push({
            address,
            memberObjectId: memberObjectIds.get(address),
            depositPaid: false,
            depositBalanceRaw: 0n,
            lastContributionRaw: 0n,
            status: 'active',
            joinDate: creationTimestamp ?? Date.now(),
            position: undefined,
          });
        }
      });
      await Promise.all(depositStatusPromises);
      // --- End of Member Fetch --- 

      // Fetch rotation order from fields
      const rotationOrder: string[] = [];
      if (fields.rotation_order && Array.isArray(fields.rotation_order)) {
        (fields.rotation_order as string[]).forEach((addr: string) => {
          if (addr !== '0x0') rotationOrder.push(addr);
        });
      }

      // Set positions based on rotation order if available
      if (rotationOrder.length > 0) {
        membersList.forEach(member => { member.position = undefined; }); // Reset first
        rotationOrder.forEach((address, index) => {
          const memberIndex = membersList.findIndex(m => m.address === address);
          if (memberIndex > -1) membersList[memberIndex].position = index;
        });
      }
          
      // Sort members by position
      const sortedMembers = [...membersList].sort((a, b) => {
        if (a.position === undefined && b.position === undefined) return 0;
        if (a.position === undefined) return 1;
        if (b.position === undefined) return -1;
        return a.position - b.position;
      });
      const outstandingSecurityDepositRaw = sortedMembers.reduce((total, member) => {
        if (!member.depositPaid) return total;
        return total + (member.depositBalanceRaw || 0n);
      }, 0n);
      setMembers(sortedMembers);
          
      // Correctly calculate allDepositsPaid based on the fetched flag
      const allPaid = sortedMembers.length > 0 && sortedMembers.every(m => m.depositPaid);
      setAllDepositsPaid(allPaid);
      console.log('Manage - All deposits paid status (based on depositPaid flag): ', allPaid);
          
      // Set final circle state
      const finalAutoSwapValue = configValues.autoSwapEnabled;
      console.log(`[fetchCircleDetails] Setting circle state with autoSwapEnabled: ${finalAutoSwapValue}`);
      setCircle({
        id: id as string,
        name: typeof fields.name === 'string' ? fields.name : '',
        admin: typeof fields.admin === 'string' ? fields.admin : '',
        contributionAmount: configValues.contributionAmount,
        contributionAmountUsd: configValues.contributionAmountUsd,
        currencyType: (typeof transactionInput?.currency_type === 'string' ? transactionInput.currency_type : undefined) || circleCreationEventData?.currency_type || 'USD', // Get currency type from transaction input or creation event
        securityDeposit: configValues.securityDeposit,
        securityDepositUsd: configValues.securityDepositUsd,
        cycleLength: configValues.cycleLength,
        cycleDay: configValues.cycleDay,
        maxMembers: configValues.maxMembers,
        currentMembers: actualMemberCount, // Use calculated count
        currentCycle: Number(fields.current_cycle || 0), // Add current cycle
        nextPayoutTime: Number(fields.next_payout_time || 0),
        isActive: isActive,
        autoSwapEnabled: finalAutoSwapValue,
        paused: isPaused, // Set the paused state
        custody: undefined // Reset custody, will be set later if found
      });

      // Fetch custody wallet info in parallel with other operations
        try {
          // Three-tier discovery (dynamic field -> events -> own tx history).
          // The event-only lookup this replaces broke the moment the
          // wallet-created event aged out of RPC retention — with a PASSED
          // emergency stop waiting on exactly this id to execute.
          const custodyResolution = await resolveCustodyWalletId({
            client,
            circleId: id as string,
            packageId: determinedPackageId,
            userAddress,
            queryEvents: (params) => queryEventsCached(params),
          });
          const walletId = custodyResolution?.walletId;

          if (walletId) {
              // Parallel fetch: wallet data and dynamic fields
              const [walletData, walletDynamicFields] = await Promise.all([
                client.getObject({ id: walletId, options: { showContent: true } }),
                client.getDynamicFields({ parentId: walletId })
              ]);
            if (walletData.data?.content && 'fields' in walletData.data.content) {
                  const wf = walletData.data.content.fields as Record<string, SuiFieldValue>; 
                  // Access nested fields safely
                  const stablecoinConfigFields = wf.stablecoin_config && typeof wf.stablecoin_config === 'object' && wf.stablecoin_config !== null && 'fields' in wf.stablecoin_config ? wf.stablecoin_config.fields as Record<string, unknown> : null;
                  const balanceFields = wf.balance && typeof wf.balance === 'object' && wf.balance !== null && 'fields' in wf.balance ? wf.balance.fields as Record<string, unknown> : null;
                  const dynamicFields = walletDynamicFields.data as unknown as DynamicFieldRef[];
                  const stablecoinMeta = resolveStablecoinMetadata(
                    typeof stablecoinConfigFields?.target_coin_type === 'string'
                      ? stablecoinConfigFields.target_coin_type
                      : null
                  );
                  
                  // Get the main balance - this represents contributions
                  const contributionsBalance = balanceFields?.value ? Number(balanceFields.value) / 1e9 : 0;
                  
                  // Look for security deposits in dynamic fields (coin_objects)
                  let securityDeposits = 0;
                  
                  // Process security deposits from dynamic fields (using pre-fetched data)
                  try {
                    debugLog('Custody wallet dynamic fields', { count: dynamicFields.length });
                    
                    // Look for coin objects in the dynamic fields
                    for (const field of dynamicFields) {
                      if (field.objectType && typeof field.objectType === 'string' && 
                          field.objectType.includes('::coin::Coin<0x2::sui::SUI>')) {
                        
                        // Found a potential SUI coin object, get its balance
                        const coinData = await client.getObject({
                          id: field.objectId,
                          options: { showContent: true }
                        });
                        
                        if (coinData.data?.content && 'fields' in coinData.data.content) {
                          const coinFields = coinData.data.content.fields as Record<string, unknown>;
                          // For Coin objects, the balance is in the 'balance' field
                          if (coinFields.balance) {
                            securityDeposits += Number(coinFields.balance) / 1e9;
                          }
                        }
                      }
                    }
                  } catch (error) {
                    debugLog('Dynamic fields error, using fallback', error);
                    securityDeposits = 0;
                  }

                  const stablecoinBalanceRaw = await readCustodyCoinBalance(
                    client,
                    dynamicFields,
                    stablecoinMeta.coinType
                  );
                  const stablecoinBalance = toDisplayAmount(
                    stablecoinBalanceRaw,
                    stablecoinMeta.decimals
                  );
                  const stablecoinSecurityDeposits = Math.min(
                    toDisplayAmount(outstandingSecurityDepositRaw, stablecoinMeta.decimals),
                    stablecoinBalance
                  );
                  const stablecoinContributionBalance = Math.max(
                    0,
                    stablecoinBalance - stablecoinSecurityDeposits
                  );

                  debugLog('Custody wallet info', {
                    walletId: shortenAddress(walletId),
                    contributionsBalance,
                    securityDeposits,
                    stablecoinBalance,
                    stablecoinSecurityDeposits,
                    stablecoinContributionBalance,
                    hasMainBalance: !!balanceFields?.value
                  });

                  setSuiSecurityDepositBalance(securityDeposits);
                  setSuiContributionBalance(contributionsBalance);
                  setUsdcSecurityDepositBalance(stablecoinSecurityDeposits);
                  setUsdcContributionBalance(stablecoinContributionBalance);
                  
                  setCircle(prev => prev ? {
                    ...prev,
                    custody: {
                      walletId,
                      stablecoinEnabled: !!(stablecoinConfigFields?.enabled),
                      stablecoinType: stablecoinMeta.label,
                      stablecoinCoinType: stablecoinMeta.coinType,
                      stablecoinBalance,
                      suiBalance: contributionsBalance, // This is for regular contributions
                      securityDeposits: securityDeposits > 0 ? securityDeposits : stablecoinSecurityDeposits,
                    }
                  } : prev);
            }
          }
        } catch (error) {
          logSuiReadError('Error fetching custody wallet info:', error);
        }

    } catch (error) {
      // Transient cooldowns log quietly and skip the toast (self-heals on
      // refresh); only genuine failures surface to the user.
      if (!logSuiReadError('Manage - Error fetching circle details:', error)) {
        toast.error('Could not load circle information');
      }
    } finally {
      setLoading(false);
      setIsFetching(false);
    }
  };

  const fetchPendingRequests = useCallback(async () => {
    if (!id) return;
    
    try {
      // setLoading(true); // Removed
      debugLog('Fetching pending join requests', { circleId: id });
      
      const response = await fetch(`/api/join-requests/pending/${id}`);
      
      if (!response.ok) {
        debugLog('API error response', { status: response.status, statusText: response.statusText });
        return;
      }
      
      const data = await response.json();
      debugLog('Pending requests loaded', { count: data?.data?.length || 0 });
      
      if (data.success && Array.isArray(data.data)) {
        console.log(`[ManagePage] Received ${data.data.length} pending requests`);
        setPendingRequests(data.data);
      } else {
        console.error('[ManagePage] Invalid response format:', data);
        setPendingRequests([]);
      }
    } catch (error) {
      console.error('[ManagePage] Failed to fetch pending requests:', error);
      setPendingRequests([]);
    }
    // finally { // Removed
    //   setLoading(false);
    // }
  }, [id]);

  // Call the admin_approve_member function on the blockchain
  const callAdminApproveMember = async (circleId: string, memberAddress: string): Promise<boolean> => {
    try {
      setIsApproving(true);
      
      // Show a toast notification that we're working on a blockchain transaction
      toast.loading('Preparing blockchain transaction...', { id: 'blockchain-tx' });
      
      if (!account) {
        toast.error('Not logged in. Please login first', { id: 'blockchain-tx' });
        return false;
      }
      
      // Call the API directly like in create-circle.tsx
      const { response: response, result: result } = await runSignedTx(() =>
        new ZkLoginClient().adminApproveMember(account, circleId, memberAddress));
      
      if (!response.ok) {
        if (response.status === 401) {
          toast.error('Authentication failed. Please login again.', { id: 'blockchain-tx' });
          return false;
        }
        
        // Parse the error for a more specific message
        const errorDetail = parseMoveError(result.error || '');
        
        // Display specific error messages from the server
        toast.error(
          <div>
            <p className="font-bold">{errorDetail.message}</p>
            {errorDetail.code === 27 && (
              <p className="text-sm mt-1">The circle has reached its maximum number of members.</p>
            )}
            {errorDetail.code === 401 && (
              <button 
                onClick={() => window.location.href = '/'} 
                className="mt-2 bg-blue-500 hover:bg-blue-600 text-white px-2 py-1 rounded text-sm"
              >
                Re-authenticate
              </button>
            )}
          </div>,
          { id: 'blockchain-tx', duration: 6000 }
        );
        throw new Error(errorDetail.message);
      }
      
      // Update toast on success
      toast.success('Successfully approved member on blockchain', { id: 'blockchain-tx' });
      console.log(`Successfully approved member. Transaction digest: ${result.digest}`);
      
      return true;
    } catch (error: unknown) {
      console.error('Error approving member on blockchain:', error);
      
      // Make sure we don't show duplicate error toasts
      if (error instanceof Error && !error.message.includes('failed') && !error.message.includes('Failed')) {
        toast.error(error instanceof Error ? error.message : 'Failed to approve member on blockchain', { id: 'blockchain-tx' });
      }
      
      return false;
    } finally {
      setIsApproving(false);
    }
  };

  // Function to call admin_approve_members for bulk approval
  const callAdminApproveMembers = async (circleId: string, memberAddresses: string[]): Promise<boolean> => {
    try {
      setIsApproving(true);
      
      // Show a toast notification that we're working on a blockchain transaction
      toast.loading('Approving multiple members...', { id: 'blockchain-tx-bulk' });
      
      if (!account) {
        toast.error('Not logged in. Please login first', { id: 'blockchain-tx-bulk' });
        return false;
      }
      
      // Call the API endpoint for bulk approval
      const { response: response, result: result } = await runSignedTx(() =>
        new ZkLoginClient().adminApproveMembers(account, circleId, memberAddresses));
      
      if (!response.ok) {
        if (response.status === 401) {
          toast.error('Authentication failed. Please login again.', { id: 'blockchain-tx-bulk' });
          return false;
        }
        
        // Parse the error for a more specific message
        const errorDetail = parseMoveError(result.error || '');
        
        // Display specific error messages from the server
        toast.error(
          <div>
            <p className="font-bold">{errorDetail.message}</p>
            {errorDetail.code === 27 && (
              <p className="text-sm mt-1">The circle has reached its maximum number of members.</p>
            )}
            {errorDetail.code === 401 && (
              <button 
                onClick={() => window.location.href = '/'} 
                className="mt-2 bg-blue-500 hover:bg-blue-600 text-white px-2 py-1 rounded text-sm"
              >
                Re-authenticate
              </button>
            )}
          </div>,
          { id: 'blockchain-tx-bulk', duration: 6000 }
        );
        throw new Error(errorDetail.message);
      }
      
      // Update toast on success
      toast.success(`Successfully approved ${memberAddresses.length} members on blockchain`, { id: 'blockchain-tx-bulk' });
      console.log(`Successfully approved ${memberAddresses.length} members. Transaction digest: ${result.digest}`);
      
      return true;
    } catch (error: unknown) {
      console.error('Error approving multiple members on blockchain:', error);
      
      // Make sure we don't show duplicate error toasts
      if (error instanceof Error && !error.message.includes('failed') && !error.message.includes('Failed')) {
        toast.error(error instanceof Error ? error.message : 'Failed to approve multiple members on blockchain', { id: 'blockchain-tx-bulk' });
      }
      
      return false;
    } finally {
      setIsApproving(false);
    }
  };

  // Function to call admin_remove_member
  const callAdminRemoveMember = async (circleId: string, memberAddress: string): Promise<void> => {
    setIsApproving(true);
    
    try {
      if (!account) {
        throw new Error('Authentication required');
      }

      const { response: response, result: result } = await runSignedTx(() =>
        new ZkLoginClient().adminRemoveMember(
            account, circleId, memberAddress, circle?.custody?.walletId ?? ''));

      if (!response.ok) {
        throw new Error(result.error || 'Failed to remove member');
      }

      if (result.status === 'failure') {
        console.error('Transaction failed:', result);
        throw new Error(result.error || result.details || 'Transaction failed on blockchain');
      }

      console.log('Member removed successfully:', result);
      await fetchCircleDetails();
    } finally {
      setIsApproving(false);
    }
  };

  // Handler for removing a member with confirmation
  const handleRemoveMember = async (memberAddress: string) => {
    if (!circle || !id) return;
    const member = members.find((entry) => entry.address === memberAddress);
    const hasDeposit = Boolean(member?.depositPaid);
    const actionTitle = hasDeposit ? 'Return Deposit & Remove Member' : 'Remove Member';
    const confirmText = hasDeposit ? 'Return Deposit & Remove' : 'Remove Member';
    const progressMessage = hasDeposit
      ? `Returning deposit and removing ${shortenAddress(memberAddress)}...`
      : `Removing ${shortenAddress(memberAddress)}...`;
    const successMessage = hasDeposit
      ? `Returned deposit and removed ${shortenAddress(memberAddress)}`
      : `Member ${shortenAddress(memberAddress)} removed successfully`;

    // Show confirmation modal
    setConfirmationModal({
      isOpen: true,
      title: actionTitle,
      message: (
        <div className="space-y-3">
          <p>
            {hasDeposit ? (
              <>
                Are you sure you want to return the security deposit for <strong>{shortenAddress(memberAddress)}</strong> and remove them from this circle?
              </>
            ) : (
              <>
                Are you sure you want to remove <strong>{shortenAddress(memberAddress)}</strong> from this circle?
              </>
            )}
          </p>
          <p className="text-sm text-gray-600">
            {hasDeposit
              ? 'This action can only be performed when the circle is inactive. Any paid security deposit will be returned before the member is removed.'
              : 'This action can only be performed when the circle is inactive.'}
          </p>
          <p className="text-sm text-red-600 font-medium">
            This action cannot be undone.
          </p>
        </div>
      ),
      onConfirm: async () => {
        const toastId = 'remove-member';
        toast.loading(progressMessage, { id: toastId });

        try {
          await callAdminRemoveMember(id as string, memberAddress);
          toast.success(successMessage, { id: toastId });
        } catch (error) {
          console.error('Error removing member on blockchain:', error);
          toast.error(
            error instanceof Error ? error.message : `Failed to remove member ${shortenAddress(memberAddress)}`,
            { id: toastId }
          );
        }
      },
      confirmText,
      cancelText: 'Cancel',
      confirmButtonVariant: 'danger',
    });
  };

  // Handler for returning security deposit to a member
  const handleReturnSecurityDeposit = async (memberAddress: string) => {
    if (!circle || !id) return;
    const canReturnSecurityDeposit = !circle.isActive || circle.paused;

    if (!canReturnSecurityDeposit) {
      toast.error('Security deposits can only be returned when the circle is inactive or paused after a cycle.');
      return;
    }

    // Show confirmation modal
    setConfirmationModal({
      isOpen: true,
      title: 'Return Security Deposit',
      message: (
        <div className="space-y-3">
          <p>
            Are you sure you want to return the security deposit to <strong>{shortenAddress(memberAddress)}</strong>?
          </p>
          <p className="text-sm text-gray-600">
            This will withdraw their security deposit from the circle&apos;s wallet and send it back to their address. Deposits can be returned when the circle is inactive or paused after a cycle.
          </p>
          <p className="text-sm text-amber-600 font-medium">
            Make sure the member has completed their obligations in the circle before returning their deposit.
          </p>
        </div>
      ),
      onConfirm: async () => {
        if (!circle.custody?.walletId) {
          toast.error('Circle wallet not found');
          return;
        }

        const toastId = 'return-deposit';
        toast.loading(`Returning security deposit to ${shortenAddress(memberAddress)}...`, { id: toastId });
        
        try {
          // Use a direct API call to return security deposit to the specific member
          const response = await fetch('/api/zkLogin', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'returnSecurityDeposit',
              account,
              circleId: id,
              walletId: circle.custody.walletId,
              memberAddress: memberAddress,
              network: getCurrentNetwork()
            })
          });
          
          const responseData = await response.json();
          
          // Check HTTP response status
          if (!response.ok) {
            throw new Error(responseData.error || 'Failed to return security deposit');
          }
          
          // Also check transaction status in response body
          if (responseData.status === 'failure') {
            console.error('Transaction failed:', responseData);
            throw new Error(responseData.error || responseData.details || 'Transaction failed on blockchain');
          }
          
          toast.success(`Security deposit returned to ${shortenAddress(memberAddress)}`, { id: toastId });
          
          // Refresh circle data to reflect the updated wallet balance
          await fetchCircleDetails();
          
        } catch (error) {
          console.error('Error returning security deposit:', error);
          toast.error(`Failed to return security deposit: ${error instanceof Error ? error.message : String(error)}`, { id: toastId });
        }
      },
      confirmText: 'Return Deposit',
      cancelText: 'Cancel',
      confirmButtonVariant: 'warning',
    });
  };

  const getMemberManagementAction = (member: Member) => {
    if (!circle || userAddress !== circle.admin) {
      return null;
    }

    const isAdminMember = member.address === circle.admin;
    const canReturnDeposit = !circle.isActive || circle.paused;

    if (isAdminMember) {
      if (!member.depositPaid) {
        return null;
      }

      return {
        buttonText: 'Manage',
        helperText: canReturnDeposit ? 'Return deposit' : 'Available when inactive or paused',
        isDisabled: !canReturnDeposit,
        onClick: () => handleReturnSecurityDeposit(member.address),
      };
    }

    const canRemoveMember = !circle.isActive;

    return {
      buttonText: 'Manage',
      helperText: canRemoveMember
        ? member.depositPaid
          ? 'Return deposit and remove'
          : 'Remove member'
        : 'Available when inactive',
      isDisabled: !canRemoveMember,
      onClick: () => handleRemoveMember(member.address),
    };
  };

  const getMemberContributionState = useCallback((member: Member): {
    label: string;
    tone: 'stone' | 'amber' | 'emerald' | 'sky';
    detail: string;
    isRecipient: boolean;
  } => {
    if (!circle || !circle.isActive || contributionStatus.currentCycle <= 0) {
      return {
        label: member.depositPaid ? 'Waiting for cycle' : 'Deposit pending',
        tone: member.depositPaid ? 'stone' : 'amber',
        detail: member.depositPaid ? 'Contribution tracking starts after activation.' : 'Member must settle the deposit first.',
        isRecipient: false,
      };
    }

    const currentRecipient = contributionStatus.currentPosition !== null && contributionStatus.currentPosition !== undefined
      ? contributionStatus.activeMembersInRotation[contributionStatus.currentPosition] || null
      : null;

    if (currentRecipient === member.address) {
      return {
        label: `Receiving payout`,
        tone: 'sky',
        detail: `Current cycle ${contributionStatus.currentCycle} recipient.`,
        isRecipient: true,
      };
    }

    if (contributionStatus.contributedMembers.has(member.address)) {
      return {
        label: 'Contributed',
        tone: 'emerald',
        detail: `Contribution recorded for cycle ${contributionStatus.currentCycle}.`,
        isRecipient: false,
      };
    }

    if (contributionStatus.activeMembersInRotation.includes(member.address)) {
      return {
        label: 'Pending contribution',
        tone: 'amber',
        detail: `Still expected to contribute in cycle ${contributionStatus.currentCycle}.`,
        isRecipient: false,
      };
    }

    return {
      label: member.depositPaid ? 'Out of rotation' : 'Deposit pending',
      tone: member.depositPaid ? 'stone' : 'amber',
      detail: member.depositPaid ? 'Not participating in the active rotation yet.' : 'Member must settle the deposit first.',
      isRecipient: false,
    };
  }, [circle, contributionStatus]);

  const getContributionToneClasses = useCallback((tone: 'stone' | 'amber' | 'emerald' | 'sky') => {
    if (tone === 'emerald') {
      return 'border-emerald-200 bg-emerald-50 text-emerald-700';
    }
    if (tone === 'amber') {
      return 'border-amber-200 bg-amber-50 text-amber-700';
    }
    if (tone === 'sky') {
      return 'border-sky-200 bg-sky-50 text-sky-700';
    }
    return 'border-stone-200 bg-stone-100 text-slate-600';
  }, []);

  const handleJoinRequest = async (request: JoinRequest, approve: boolean) => {
    try {
      console.log(`[ManagePage] ${approve ? 'Approving' : 'Rejecting'} join request for user ${request.user_address} in circle ${request.circle_id}`);
      
      // If approving, check if we would exceed max members
      if (approve && circle) {
        const currentActiveMembers = members.filter(m => m.status === 'active').length;
        const wouldExceedLimit = currentActiveMembers >= circle.maxMembers;
        
        if (wouldExceedLimit) {
          // Show modal asking admin if they want to increase max members first
          setConfirmationModal({
            isOpen: true,
            title: 'Maximum Members Limit Reached',
            message: (
              <div className="space-y-3">
                <p>
                  Approving <strong>{shortenAddress(request.user_address)}</strong> would exceed 
                  the current maximum member limit of <strong>{circle.maxMembers}</strong>.
                </p>
                <p className="text-sm text-gray-600">
                  Current active members: <strong>{currentActiveMembers}</strong>
                </p>
                <p className="text-sm text-blue-600">
                  Would you like to increase the maximum members to <strong>{currentActiveMembers + 1}</strong> 
                  and then approve this member?
                </p>
              </div>
            ),
            onConfirm: async () => {
              // First increase max members, then approve
              await increaseMaxMembersAndApprove([request], currentActiveMembers + 1);
            },
            confirmText: `Increase Limit & Approve`,
            cancelText: 'Cancel',
            confirmButtonVariant: 'primary',
          });
          return;
        }
      }
      
      // If rejecting, first try to approve on blockchain
      if (approve) {
        const blockchainToastId = 'blockchain-approve-member';
        toast.loading(`Approving ${shortenAddress(request.user_address)} on blockchain...`, { id: blockchainToastId });
        
        const blockchainSuccess = await callAdminApproveMember(
          request.circle_id,
          request.user_address
        );
        
        if (!blockchainSuccess) {
          console.error(`[ManagePage] Failed to approve member ${request.user_address} on blockchain`);
          toast.error('Failed to approve member on blockchain. Please try again.', { id: blockchainToastId, duration: 5000 });
          return;
        }
        toast.success(`Member approved on blockchain!`, { id: blockchainToastId });
      }
      
      // Update request status using the API
      console.log(`[ManagePage] Updating join request status in database to ${approve ? 'approved' : 'rejected'}`);
      const databaseToastId = 'database-update-request';
      toast.loading(`Updating request status...`, { id: databaseToastId });
      
      const response = await fetch(`/api/join-requests/${request.circle_id}/update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userAddress: request.user_address,
          status: approve ? 'approved' : 'rejected'
        })
      });
      
      const result = await response.json();
      
      if (!response.ok || !result.success) {
        console.error(`[ManagePage] Failed to update request status in database:`, result);
        toast.error('Failed to update request in database. Please try again.', { id: databaseToastId, duration: 5000 });
        return;
      }
      
      toast.success(`Request ${approve ? 'approved' : 'rejected'} successfully!`, { id: databaseToastId });
      
      // Update UI to remove the request
      console.log(`[ManagePage] Updating UI to remove the request`);
      setPendingRequests(prev => 
        prev.filter(req => 
          !(req.circle_id === request.circle_id && 
            req.user_address === request.user_address)
        )
      );
      
      // If approved, add to members list
      if (approve) {
        // Use current timestamp from blockchain transaction for join date
        const currentTimestamp = Date.now(); // Get the current time as a fallback
        
        setMembers(prev => [
          ...prev,
          {
            address: request.user_address,
            joinDate: currentTimestamp, // We would ideally get this from the blockchain event
            status: 'active'
          }
        ]);
        
        // Also update current members count
        if (circle) {
          setCircle({
            ...circle,
            currentMembers: circle.currentMembers + 1
          });
        }
        
        toast.success(`Approved ${shortenAddress(request.user_address)} to join the circle`);

        // The member was added on-chain (members table mutated + receipt
        // minted), so the optimistic local-state update above isn't enough:
        // drop cached circle reads so the contribution panel / dashboard
        // reflect the new member instead of a 5s-stale snapshot.
        invalidateObject(request.circle_id);
      } else {
        toast.success(`Rejected join request from ${shortenAddress(request.user_address)}`);
      }

      // Refresh the pending requests
      fetchPendingRequests();
      // Re-read authoritative circle state after an approval (matches the
      // invalidate-then-refetch pattern used by the other admin writes).
      if (approve) {
        fetchCircleDetails();
      }

    } catch (error: unknown) {
      console.error('Error handling join request:', error);
      toast.error('Failed to process join request');
    }
  };

  // New function to handle increasing max members and then approving requests
  const increaseMaxMembersAndApprove = async (requests: JoinRequest[], newMaxMembers: number) => {
    if (!circle || !account) return;
    
    const toastId = 'increase-and-approve';
    
    try {
      toast.loading('Increasing maximum members...', { id: toastId });
      
      // First, increase the max members
      const { response: maxMembersResponse, result: maxMembersResult } = await runSignedTx(() =>
        new ZkLoginClient().adminSetMaxMembers(account, circle.id, newMaxMembers));
      
      if (!maxMembersResponse.ok) {
        console.error('Failed to update max members:', maxMembersResult);
        const upgrade = parseUpgradeRequired(maxMembersResult);
        if (upgrade) {
          toast.dismiss(toastId);
          setUpsell(upgrade);
          return;
        }
        const errorDetail = parseMoveError(maxMembersResult.error || '');
        toast.error(`Failed to increase max members: ${errorDetail.message}`, { id: toastId });
        return;
      }
      
      // Update local state
      setCircle(prevCircle => prevCircle ? { ...prevCircle, maxMembers: newMaxMembers } : null);
      
      toast.loading('Approving members...', { id: toastId });
      
      // Now approve the members
      if (requests.length === 1) {
        // Single approval
        const request = requests[0];
        const blockchainSuccess = await callAdminApproveMember(
          request.circle_id,
          request.user_address
        );
        
        if (!blockchainSuccess) {
          toast.error('Failed to approve member on blockchain', { id: toastId });
          return;
        }
        
        // Update database
        const response = await fetch(`/api/join-requests/${request.circle_id}/update`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            userAddress: request.user_address,
            status: 'approved'
          })
        });
        
        const result = await response.json();
        
        if (!response.ok || !result.success) {
          toast.error('Failed to update request in database', { id: toastId });
          return;
        }
        
        // Update UI
        setPendingRequests(prev => 
          prev.filter(req => 
            !(req.circle_id === request.circle_id && 
              req.user_address === request.user_address)
          )
        );
        
        setMembers(prev => [
          ...prev,
          {
            address: request.user_address,
            joinDate: Date.now(),
            status: 'active'
          }
        ]);
        
        setCircle(prevCircle => prevCircle ? { 
          ...prevCircle, 
          currentMembers: prevCircle.currentMembers + 1 
        } : null);
        
        toast.success(`Maximum members increased to ${newMaxMembers} and member approved!`, { id: toastId });
        
      } else {
        // Bulk approval
        const memberAddresses = requests.map(req => req.user_address);
        
        const blockchainSuccess = await callAdminApproveMembers(
          requests[0].circle_id,
          memberAddresses
        );
        
        if (!blockchainSuccess) {
          toast.error('Failed to approve members on blockchain', { id: toastId });
          return;
        }
        
        // Update database for all requests
        let allDbUpdatesSuccessful = true;
        for (const request of requests) {
          try {
            const response = await fetch(`/api/join-requests/${request.circle_id}/update`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                userAddress: request.user_address,
                status: 'approved'
              })
            });
            
            const result = await response.json();
            
            if (!response.ok || !result.success) {
              allDbUpdatesSuccessful = false;
            }
          } catch {
            allDbUpdatesSuccessful = false;
          }
        }
        
        if (allDbUpdatesSuccessful) {
          // Update UI
          const currentTimestamp = Date.now();
          const newMembers = requests.map(req => ({
            address: req.user_address,
            joinDate: currentTimestamp,
            status: 'active' as const
          }));
          
          setMembers(prev => [...prev, ...newMembers]);
          
          setCircle(prevCircle => prevCircle ? { 
            ...prevCircle, 
            currentMembers: prevCircle.currentMembers + requests.length 
          } : null);
          
          // Remove approved requests from pending list
          const approvedAddresses = new Set(requests.map(req => req.user_address));
          setPendingRequests(prev => 
            prev.filter(req => !approvedAddresses.has(req.user_address))
          );
          
          toast.success(`Maximum members increased to ${newMaxMembers} and ${requests.length} members approved!`, { id: toastId });
        } else {
          toast.error('Some requests could not be updated. Please refresh and try again.', { id: toastId });
          await fetchPendingRequests();
        }
      }
      
      // Refresh circle details
      await fetchCircleDetails();
      
    } catch (error) {
      console.error('Error in increaseMaxMembersAndApprove:', error);
      toast.error('Failed to increase max members and approve', { id: toastId });
    }
  };

  // New function to handle bulk approval of join requests
  const handleBulkApprove = async () => {
    if (pendingRequests.length === 0) return;
    
    // Check if bulk approval would exceed max members
    if (circle) {
      const currentActiveMembers = members.filter(m => m.status === 'active').length;
      const wouldExceedLimit = currentActiveMembers + pendingRequests.length > circle.maxMembers;
      
      if (wouldExceedLimit) {
        const newMaxMembers = currentActiveMembers + pendingRequests.length;
        
        // Show modal asking admin if they want to increase max members first
        setConfirmationModal({
          isOpen: true,
          title: 'Maximum Members Limit Would Be Exceeded',
          message: (
            <div className="space-y-3">
              <p>
                Approving all <strong>{pendingRequests.length}</strong> pending requests would exceed 
                the current maximum member limit of <strong>{circle.maxMembers}</strong>.
              </p>
              <p className="text-sm text-gray-600">
                Current active members: <strong>{currentActiveMembers}</strong><br/>
                After approval: <strong>{currentActiveMembers + pendingRequests.length}</strong>
              </p>
              <p className="text-sm text-blue-600">
                Would you like to increase the maximum members to <strong>{newMaxMembers}</strong> 
                and then approve all pending requests?
              </p>
            </div>
          ),
          onConfirm: async () => {
            await increaseMaxMembersAndApprove(pendingRequests, newMaxMembers);
          },
          confirmText: `Increase Limit & Approve All`,
          cancelText: 'Cancel',
          confirmButtonVariant: 'primary',
        });
        return;
      }
    }
    
    // Show confirmation modal for normal bulk approval
    setConfirmationModal({
      isOpen: true,
      title: 'Approve All Pending Requests',
      message: `Are you sure you want to approve all ${pendingRequests.length} pending join requests? This will add all these members to your circle.`,
      onConfirm: async () => {
        const bulkApproveToastId = 'bulk-approve-toast';
        try {
          toast.loading('Processing bulk approval...', { id: bulkApproveToastId });
          // Extract all the member addresses from pending requests
          const memberAddresses = pendingRequests.map(req => req.user_address);
          
          // Call the bulk approval method on the blockchain
          console.log(`[ManagePage] Calling blockchain bulk approve for ${memberAddresses.length} members`);
          const blockchainSuccess = await callAdminApproveMembers(
            pendingRequests[0].circle_id, // All requests are for the same circle
            memberAddresses
          );
          
          if (!blockchainSuccess) {
            console.error('[ManagePage] Blockchain bulk approval failed');
            toast.error('Failed to approve members on blockchain. Please try again.', { id: bulkApproveToastId });
            return;
          }
          console.log('[ManagePage] Blockchain bulk approval successful');
          
          // Update all requests in the database via API
          let allDbUpdatesSuccessful = true;
          console.log(`[ManagePage] Starting database updates for ${pendingRequests.length} requests`);
          for (const request of pendingRequests) {
            console.log(`[ManagePage] Updating status for user ${request.user_address} to 'approved'`);
            try {
              // *** USE API CALL INSTEAD OF SERVICE ***
              const response = await fetch(`/api/join-requests/${request.circle_id}/update`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  userAddress: request.user_address,
                  status: 'approved'
                })
              });
              
              const result = await response.json();
              
              if (!response.ok || !result.success) {
                console.error(`[ManagePage] Failed DB update for ${request.user_address}:`, result);
                allDbUpdatesSuccessful = false;
                // Continue trying other requests even if one fails
              } else {
                console.log(`[ManagePage] Successfully updated DB status for ${request.user_address}`);
              }
            } catch (apiError) {
              console.error(`[ManagePage] API error updating status for ${request.user_address}:`, apiError);
              allDbUpdatesSuccessful = false;
            }
          }
          
          if (allDbUpdatesSuccessful) {
            console.log('[ManagePage] All database updates successful. Updating UI.');
            // Add all members to the UI
            const currentTimestamp = Date.now();
            const newMembers = pendingRequests.map(req => ({
              address: req.user_address,
              joinDate: currentTimestamp,
              status: 'active' as const
            }));
            
            setMembers(prev => [...prev, ...newMembers]);
            
            // Update current members count
            if (circle) {
              setCircle({
                ...circle,
                currentMembers: circle.currentMembers + pendingRequests.length
              });
            }
            
            // Clear all pending requests from UI
            setPendingRequests([]);
            
            toast.success(`Successfully approved all ${pendingRequests.length} member requests`, { id: bulkApproveToastId });
          } else {
            console.warn('[ManagePage] Some DB updates failed. Refreshing pending list.');
            // Refresh the pending requests to get the current state
            await fetchPendingRequests();
            toast.error('Some requests could not be updated. Please check the list.', { id: bulkApproveToastId, duration: 5000 });
          }
        } catch (error: unknown) {
          console.error('[ManagePage] Error handling bulk approval:', error);
          toast.error('Failed to process bulk approval', { id: bulkApproveToastId });
        }
      },
      confirmText: 'Approve All',
      cancelText: 'Cancel',
      confirmButtonVariant: 'primary',
    });
  };

  // Format timestamp to readable date
  const formatDate = (timestamp: number | Date) => {
    if (!timestamp) return 'Not set';
    
    const date = typeof timestamp === 'number' 
      ? new Date(timestamp) 
      : timestamp instanceof Date ? timestamp : new Date();
    
    // For display purposes, always show in local timezone but format differently
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      timeZoneName: 'short'
    });
  };

  const formatRelativeDuration = (milliseconds: number) => {
    if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
      return 'Ready now';
    }

    const totalSeconds = Math.ceil(milliseconds / 1000);
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);

    if (days > 0) {
      return `${days}d ${hours}h`;
    }
    if (hours > 0) {
      return `${hours}h ${minutes}m`;
    }
    if (minutes > 0) {
      return `${minutes}m`;
    }

    return `${totalSeconds}s`;
  };

  // Format date more cleanly for next payout (to match dashboard)
  const formatNextPayoutDate = (timestamp: number) => {
    if (!timestamp) return 'Not set';
    
    const date = new Date(timestamp);
    
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'UTC'
    });
  };

  // Calculate potential next payout date for non-activated circles
  const calculatePotentialNextPayoutDate = (cycleLength: number, cycleDay: number): number => {
    try {
      const MS_PER_DAY = 86400000;
      // Remove MS_PER_WEEK and MS_PER_BI_WEEK from here

      const currentTime = Date.now();
      const currentDate = new Date(currentTime);
      const year = currentDate.getFullYear();
      const month = currentDate.getMonth(); // JS months 0-11
      const day = currentDate.getDate();
      const dayMs = currentTime % MS_PER_DAY;
      const currentWeekdayJS = currentDate.getDay(); // JS Sunday=0, Monday=1, ... Saturday=6
      
      // Convert JS weekday to our 0-indexed (Monday=0, Sunday=6)
      const currentWeekday = (currentWeekdayJS === 0) ? 6 : currentWeekdayJS - 1;

      console.log('Calculating potential payout date:', {
        currentDate: currentDate.toISOString(),
        year, month: month + 1, day,
        cycleLength, cycleDay,
        currentWeekdayJS, // Log JS weekday for debugging
        currentWeekday // Log our Monday=0 index
      });

      // Validate inputs - ensure they are within reasonable bounds
      // Clamp cycleDay to valid range based on cycle type
      let targetDay: number;
      if (cycleLength === 0 || cycleLength === 3) {
        targetDay = Math.min(Math.max(0, cycleDay), 6); // 0-6 for weekly/bi-weekly
      } else {
        targetDay = Math.min(Math.max(1, cycleDay), 28); // 1-28 for monthly/quarterly
      }
      
      let nextPayoutTime: number;
      // Define weekdays array here so it's accessible in switch cases
      const weekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

      switch (cycleLength) {
        case 0: // Weekly
          {
            const MS_PER_WEEK = 604800000; // Define inside case
            let daysUntil = 0;
            if (targetDay > currentWeekday) { 
              daysUntil = targetDay - currentWeekday;
            } else if (targetDay < currentWeekday || (targetDay === currentWeekday && dayMs > 0)) { 
              daysUntil = 7 - currentWeekday + targetDay;
            } 
            
            let nextOccurrenceStartTs = (currentTime - dayMs) + (daysUntil * MS_PER_DAY);
            
            // If it's today but time has passed, advance by 7 days
            if (daysUntil === 0 && dayMs > 0) {
              console.log('Weekly: Target day is today but passed, adding 7 days');
              nextOccurrenceStartTs += MS_PER_WEEK; 
            }

            const nextPayoutDate = new Date(nextOccurrenceStartTs);
            nextPayoutDate.setUTCHours(0, 0, 0, 0); // Set to Midnight UTC
            nextPayoutTime = nextPayoutDate.getTime();
          }
          break;
          
        case 3: // Bi-Weekly (Revised Logic)
          {
            const MS_PER_BI_WEEK = 1209600000; // Define inside case
            let daysUntilNextTarget = 0;
            if (targetDay > currentWeekday) { // Target is later this week
              daysUntilNextTarget = targetDay - currentWeekday;
            } else { // Target is today or earlier this week
              daysUntilNextTarget = 7 - currentWeekday + targetDay; // Days until target occurs next week
            }
            
            // Timestamp for the very next occurrence of the target day (start of day UTC)
            let nextOccurrenceTs = (currentTime - dayMs) + (daysUntilNextTarget * MS_PER_DAY);
            const nextOccurrenceDate = new Date(nextOccurrenceTs);
            nextOccurrenceDate.setUTCHours(0, 0, 0, 0);
            nextOccurrenceTs = nextOccurrenceDate.getTime(); // Get timestamp for midnight UTC

            // Timestamp for 14 days after that next occurrence
            const occurrencePlus14DaysTs = nextOccurrenceTs + MS_PER_BI_WEEK;

            // The *potential* next payout is the later of these two dates.
            // This ensures the estimate is always at least 14 days after the *next* time the target day comes around.
            // However, for a simple estimate before activation, perhaps just the next occurrence + 14 days is sufficient?
            // Let's try the simplest approach first: schedule it 14 days after the *next* occurrence.
            // This avoids needing complex logic about the *last* payout before activation.
            
            // Calculate date 14 days after the *next* time the target day occurs.
            nextPayoutTime = occurrencePlus14DaysTs; 
            
            console.log(`Bi-Weekly: Next ${weekdays[targetDay]} is ${new Date(nextOccurrenceTs).toISOString()}. Potential payout estimate: ${new Date(nextPayoutTime).toISOString()}`);
          }
          break;
          
        case 1: // Monthly
        case 2: // Quarterly
          {
            // No need for MS_PER_WEEK or MS_PER_BI_WEEK here
            let targetMonth = month;
            let targetYear = year;
            const monthsToAdd = (cycleLength === 1) ? 1 : 3; 
            
            if (day > targetDay || (day === targetDay && dayMs > 0)) {
              targetMonth += monthsToAdd;
              if (targetMonth > 11) { 
                targetYear += Math.floor(targetMonth / 12);
                targetMonth = targetMonth % 12;
              }
            }
            
            let lastDayOfMonth;
            try {
              const nextMonthDate = new Date(Date.UTC(targetYear, targetMonth + 1, 1));
              nextMonthDate.setUTCDate(0);
              lastDayOfMonth = nextMonthDate.getUTCDate();
            } catch { // Remove variable declaration
              lastDayOfMonth = 28; // Fallback
            }
            const actualTargetDay = Math.min(targetDay, lastDayOfMonth);
            
            console.log(`${cycleLength === 1 ? 'Monthly' : 'Quarterly'} cycle - target date:`, {
              targetYear, targetMonth: targetMonth + 1, actualTargetDay
            });
            
            try {
              const payoutDate = new Date(Date.UTC(targetYear, targetMonth, actualTargetDay));
              if (isNaN(payoutDate.getTime())) throw new Error('Invalid date');
              nextPayoutTime = payoutDate.getTime();
            } catch { // Remove variable declaration
              nextPayoutTime = currentTime + (monthsToAdd * 30 * MS_PER_DAY);
            }
          }
          break;
          
        default:
          console.error('Invalid cycle length:', cycleLength);
          nextPayoutTime = currentTime + (7 * MS_PER_DAY); // Fallback to 1 week
      }

      console.log('Calculated next potential payout timestamp:', nextPayoutTime, new Date(nextPayoutTime).toISOString());
      return nextPayoutTime;
    } catch (error) {
      console.error('Error in calculatePotentialNextPayoutDate:', error);
      return Date.now() + (7 * MS_PER_DAY);
    }
  };

  const shortenAddress = (address: string) => {
    if (!address) return '';
    return `${address.slice(0, 6)}...${address.slice(-6)}`;
  };

  // Format USD value
  const formatUSD = (amount: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
    }).format(amount);
  };

  // Format currency value based on currency type
  const formatCurrency = (amount: number, currencyType: string = 'USD') => {
    // Map currency codes to their formatting options
    const currencyFormats: Record<string, { 
      symbol: string; 
      locale: string; 
      code: string; 
      customFormat?: boolean;
      position?: 'before' | 'after';
    }> = {
      'USD': { symbol: '$', locale: 'en-US', code: 'USD' },
      'XAF': { symbol: 'FCFA', locale: 'fr-CM', code: 'XAF', customFormat: true, position: 'after' }, // XAF specific formatting
      'NGN': { symbol: '₦', locale: 'en-NG', code: 'NGN' },
      'EUR': { symbol: '€', locale: 'de-DE', code: 'EUR' },
      'GBP': { symbol: '£', locale: 'en-GB', code: 'GBP' },
      'CAD': { symbol: 'C$', locale: 'en-CA', code: 'CAD', customFormat: true, position: 'before' },
      'ZAR': { symbol: 'R', locale: 'en-ZA', code: 'ZAR', customFormat: true, position: 'before' },
      'KES': { symbol: 'KSh', locale: 'en-KE', code: 'KES', customFormat: true, position: 'before' },
      'EGP': { symbol: 'E£', locale: 'en-US', code: 'EGP', customFormat: true, position: 'before' }, // Using en-US for EGP to avoid potential right-to-left issues with symbol
      'MAD': { symbol: 'MAD', locale: 'en-US', code: 'MAD', customFormat: true, position: 'before' }, // Using en-US for MAD
      'GHS': { symbol: 'GH₵', locale: 'en-GH', code: 'GHS', customFormat: true, position: 'before' } // Added GHS
    };

    const format = currencyFormats[currencyType] || currencyFormats['USD'];
    
    try {
      return new Intl.NumberFormat(format.locale, {
        style: 'currency',
        currency: format.code,
        minimumFractionDigits: 0,
        maximumFractionDigits: 2,
      }).format(amount);
    } catch {
      // Fallback for unsupported locales
      return `${format.symbol}${amount.toFixed(2)}`;
    }
  };

  const CurrencyDisplay = ({ 
    usd, 
    sui, 
    currencyType = 'USD', 
    className = "" 
  }: { 
    usd?: number; 
    sui?: number; 
    currencyType?: string;
    className?: string;
  }) => {
    const isPriceStale = priceService.isPriceStale();
    
    console.log('CurrencyDisplay received values:', { usd, sui, currencyType });
    
    // Debug logging for manage page
    console.log('[MANAGE CURRENCY DEBUG] CurrencyDisplay called with:', {
      usd, sui, currencyType,
      usdType: typeof usd,
      suiType: typeof sui,
      currencyTypeType: typeof currencyType
    });
    
    // Check for invalid inputs and provide defaults
    if ((usd === undefined || isNaN(usd)) && (sui === undefined || isNaN(sui))) {
      console.log('CurrencyDisplay: both usd and sui values are invalid, defaulting to 0');
      usd = 0;
      sui = 0;
    }
    
    // Use the provided values directly instead of converting between them
    // The local currency amount (usd parameter) and SUI amount (sui parameter) 
    // are already stored correctly from the circle creation
    let displayLocalAmount: number | null = null;
    let displaySuiAmount: number | null = null;
    
    if (usd !== undefined && !isNaN(usd)) {
      displayLocalAmount = usd; // This is actually the local currency amount
      console.log('CurrencyDisplay: using provided local currency amount:', { 
        local: displayLocalAmount, 
        currencyType
      });
    }
    
    if (sui !== undefined && !isNaN(sui)) {
      displaySuiAmount = sui; // This is the actual SUI amount stored in the contract
      console.log('CurrencyDisplay: using provided SUI amount:', { 
        sui: displaySuiAmount
      });
    }
    
    // Default values if neither is provided or values are invalid
    if (displayLocalAmount === null || displayLocalAmount === undefined) {
      displayLocalAmount = 0;
    }
    if (displaySuiAmount === null || displaySuiAmount === undefined) {
      displaySuiAmount = 0;
    }
    
    console.log('CurrencyDisplay: final display values:', { 
      local: displayLocalAmount, 
      sui: displaySuiAmount,
      currencyType 
    });
    
    // Special case for zero values
    if (displayLocalAmount === 0 && displaySuiAmount === 0) {
      return (
        <span className={`${className}`}>
          {formatCurrency(0, currencyType)} (0 SUI)
        </span>
      );
    }
    
    // Format SUI with appropriate precision if available
    const formattedSui = displaySuiAmount !== null ? (
      displaySuiAmount >= 1000 
        ? displaySuiAmount.toLocaleString(undefined, { maximumFractionDigits: 0 }) 
        : displaySuiAmount >= 100 
          ? displaySuiAmount.toFixed(1) 
          : displaySuiAmount.toFixed(3) // Show more precision for small amounts
    ) : '—';
    
    return (
      <Tooltip.Provider>
        <Tooltip.Root>
          <Tooltip.Trigger asChild>
            <span className={`cursor-help ${className} flex items-center`}>
              {displayLocalAmount !== null ? formatCurrency(displayLocalAmount, currencyType) : `${formatCurrency(0, currencyType)}`} 
              <span className="text-gray-500 mr-1">({formattedSui} SUI)</span>
              {isPriceStale && <span title="Using cached price">⚠️</span>}
            </span>
          </Tooltip.Trigger>
          <Tooltip.Portal>
            <Tooltip.Content
              className="bg-gray-900 text-white px-3 py-2 rounded text-sm"
              sideOffset={5}
            >
              <div className="space-y-1">
                <p>Current SUI Conversion Rate:</p>
                <p>1 SUI = {formatUSD(suiPrice)}</p>
                <p className="text-xs text-gray-400">
                  {isPriceStale 
                    ? "Using cached price - service temporarily unavailable" 
                    : "Updated price data from CoinGecko"}
                </p>
                <p className="text-xs text-blue-300">
                  Currency: {currencyType}
                </p>
                <p className="text-xs text-gray-400">
                  Note: SUI amount was calculated at circle creation time
                </p>
              </div>
              <Tooltip.Arrow className="fill-gray-900" />
            </Tooltip.Content>
          </Tooltip.Portal>
        </Tooltip.Root>
      </Tooltip.Provider>
    );
  };

  const copyToClipboard = async (text: string, type: 'id' | 'link') => {
    try {
      if (type === 'id') {
        await navigator.clipboard.writeText(text);
        setCopiedId(true);
        toast.success('Circle ID copied to clipboard!');
        setTimeout(() => setCopiedId(false), 2000);
      } else if (type === 'link') {
        const shareLink = `${window.location.origin}/circle/${text}/join`;
        await navigator.clipboard.writeText(shareLink);
        toast.success('Invite link copied to clipboard!');
      }
    } catch (err: unknown) {
      console.error('Failed to copy:', err);
      toast.error('Failed to copy to clipboard');
    }
  };

  const copyPlainText = useCallback(async (text: string, successMessage: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(successMessage);
    } catch (err: unknown) {
      console.error('Failed to copy:', err);
      toast.error('Failed to copy to clipboard');
    }
  }, []);

  const shortenId = (id: string) => {
    if (!id) return '';
    return `${id.slice(0, 10)}...${id.slice(-8)}`;
  };

  const setManageSectionRef = useCallback((key: ManageSectionKey, element: HTMLElement | null) => {
    manageSectionRefs.current[key] = element;
  }, []);

  const scrollToManageSection = useCallback((key: ManageSectionKey) => {
    window.requestAnimationFrame(() => {
      manageSectionRefs.current[key]?.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      });
    });
  }, []);

  // Circle-level routing policy toggle persisted on-chain.
  // We currently reuse the existing `toggleAutoSwap` endpoint for this flag.
  const toggleNativeSuiOptIn = async (enabled: boolean) => {
    try {
      if (!account || !circle) {
        toast.error('Account or circle information not available');
        return false;
      }

      // Lock token mode changes while the current cycle is active.
      if (circle.isActive && !circle.paused) {
        toast.error('Token mode is locked during an active cycle. Wait until the cycle is completed and payouts are finished.');
        return false;
      }
      
      toast.loading('Updating circle token mode...', { id: 'toggle-native-sui-optin' });
      
      // Reuse existing API action that persists the underlying config flag.
      const { response: response, result: result } = await runSignedTx(() =>
        new ZkLoginClient().toggleAutoSwap(account, circle.id, enabled));
      
      if (!response.ok) {
        console.error('Failed to update circle token mode:', result);
        toast.error(result.error || 'Failed to update circle token mode', { id: 'toggle-native-sui-optin' });
        return false;
      }
      
      console.log(
        '[analytics] native_sui_opt_in_toggled',
        JSON.stringify({
          circleId: circle.id,
          enabled,
          toggledBy: account.userAddr,
          timestamp: new Date().toISOString(),
        })
      );

      toast.success(
        enabled
          ? 'SUI mode enabled. Once the circle is active, contributions and payouts will run in SUI for all members.'
          : 'USDC mode restored. Contributions and payouts will run in USDC.',
        { id: 'toggle-native-sui-optin' }
      );
      
      // Update local state
      setCircle(prevCircle => prevCircle ? { ...prevCircle, autoSwapEnabled: enabled } : null);
      
      return true;
    } catch (error) {
      console.error('Error updating circle token mode:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to update circle token mode', { id: 'toggle-native-sui-optin' });
      return false;
    }
  };

  // Function to fetch custody wallet SUI balance (separating security deposits and contributions)
  const fetchCustodyWalletSuiBalance = async () => {
    if (!circle?.custody?.walletId) return;
    
    setFetchingSuiBalance(true);
    try {
      const client = getSuiClientFromPool(getCurrentRpcUrl());
      
      let mainSuiBalance = 0;
      let dynamicFieldSuiBalance = 0;

      // 1. Fetch the CustodyWallet object itself
      const walletData = await client.getObject({ 
        id: circle.custody.walletId, 
        options: { showContent: true } 
      });

      if (walletData.data?.content && 'fields' in walletData.data.content) {
        const wf = walletData.data.content.fields as Record<string, unknown>; 
        // Extract the main balance (contributions)
        if (wf.balance && typeof wf.balance === 'object' && 'fields' in wf.balance) {
          mainSuiBalance = Number((wf.balance.fields as Record<string, unknown>)?.value || 0) / 1e9;
        } else if (wf.balance) {
           // Handle case where balance might be a direct value
           mainSuiBalance = Number(wf.balance) / 1e9;
        }
        console.log(`[SUI Balance Fetch] Main Balance (Contributions): ${mainSuiBalance}`);
      } else {
         console.warn('[SUI Balance] Could not fetch main CustodyWallet object content.');
      }

      // 2. Fetch dynamic fields to find the SUI Coin object (security deposits)
      const dynamicFieldsResult = await client.getDynamicFields({ parentId: circle.custody.walletId });

      for (const field of dynamicFieldsResult.data) {
        if (field.objectType && field.objectType.includes('::coin::Coin<0x2::sui::SUI>')) {
          console.log(`[SUI Balance] Found SUI Coin dynamic field: ${field.objectId}`);
          const coinData = await client.getObject({
            id: field.objectId,
            options: { showContent: true }
          });
          if (coinData.data?.content && 'fields' in coinData.data.content) {
            const coinFields = coinData.data.content.fields as Record<string, unknown>;
            if (coinFields.balance) {
              dynamicFieldSuiBalance = Number(coinFields.balance) / 1e9;
              console.log(`[SUI Balance Fetch] Dynamic Field Balance (Security Deposits): ${dynamicFieldSuiBalance}`);
              break; // Assuming only one SUI coin dynamic field for security deposits
            }
          }
        }

      }

      // Calculate final balances
      const securityDepositSui = dynamicFieldSuiBalance;
      const contributionSui = mainSuiBalance;
      const totalSuiBalance = contributionSui + securityDepositSui;

      // Set state
      setCircle(prev => prev ? {
        ...prev,
        custody: {
          ...prev.custody!,
          suiBalance: totalSuiBalance,
          securityDeposits: securityDepositSui
        }
      } : prev);
      
      setSuiSecurityDepositBalance(securityDepositSui);
      setSuiContributionBalance(contributionSui);
      
      console.log('[SUI Balance] Final breakdown:', {
        total: totalSuiBalance,
        securityDeposit: securityDepositSui,
        contribution: contributionSui
      });

    } catch (error) {
      logSuiReadError('Error fetching custody wallet SUI balance:', error);
    } finally {
      setFetchingSuiBalance(false);
    }
  };

  // Function to fetch custody wallet USDC balance
  const fetchCustodyWalletUsdcBalance = async () => {
    if (!circle?.custody?.walletId) return;
    
    setFetchingUsdcBalance(true);
    try {
      const client = getSuiClientFromPool(getCurrentRpcUrl());
      const [walletData, walletDynamicFields] = await Promise.all([
        client.getObject({
          id: circle.custody.walletId,
          options: { showContent: true }
        }),
        client.getDynamicFields({ parentId: circle.custody.walletId })
      ]);

      const walletFields = walletData.data?.content && 'fields' in walletData.data.content
        ? walletData.data.content.fields as Record<string, unknown>
        : null;
      const stablecoinConfigFields = walletFields?.stablecoin_config &&
        typeof walletFields.stablecoin_config === 'object' &&
        walletFields.stablecoin_config !== null &&
        'fields' in walletFields.stablecoin_config
          ? (walletFields.stablecoin_config as { fields: Record<string, unknown> }).fields
          : null;

      const stablecoinMeta = resolveStablecoinMetadata(
        typeof stablecoinConfigFields?.target_coin_type === 'string'
          ? stablecoinConfigFields.target_coin_type
          : circle.custody.stablecoinCoinType || circle.custody.stablecoinType
      );
      const dynamicFields = walletDynamicFields.data as unknown as DynamicFieldRef[];
      const liveStablecoinBalanceRaw = await readCustodyCoinBalance(
        client,
        dynamicFields,
        stablecoinMeta.coinType
      );
      const outstandingDepositRaw = members.reduce((total, member) => {
        if (!member.depositPaid) return total;
        return total + (member.depositBalanceRaw || 0n);
      }, 0n);

      const newBalance = toDisplayAmount(liveStablecoinBalanceRaw, stablecoinMeta.decimals);
      const newSecurityDepositBalance = Math.min(
        toDisplayAmount(outstandingDepositRaw, stablecoinMeta.decimals),
        newBalance
      );
      const newContributionBalance = Math.max(0, newBalance - newSecurityDepositBalance);

      setUsdcSecurityDepositBalance(newSecurityDepositBalance);
      setUsdcContributionBalance(newContributionBalance);
      
      setCircle(prev => prev ? {
        ...prev,
        custody: {
          ...prev.custody!,
          stablecoinType: stablecoinMeta.label,
          stablecoinCoinType: stablecoinMeta.coinType,
          stablecoinBalance: newBalance,
          securityDeposits: newSecurityDepositBalance
        }
      } : prev);
      
      console.log('Custody stablecoin balances breakdown:', {
        total: newBalance,
        securityDeposits: newSecurityDepositBalance,
        contributionFunds: newContributionBalance,
        coinType: stablecoinMeta.coinType
      });
    } catch (error) {
      logSuiReadError('Error fetching custody wallet USDC balance:', error);
    } finally {
      setFetchingUsdcBalance(false);
    }
  };

  useEffect(() => {
    if (circle?.custody?.walletId) {
      fetchCustodyWalletSuiBalance();
      fetchCustodyWalletUsdcBalance();
    }
    // Balance fetchers are stable component closures.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [circle?.custody?.walletId]);

  // useEffect to convert custody USDC balances to local currency for display
  useEffect(() => {
    const convertAndSetDisplays = async () => {
      if (circle && circle.currencyType && circle.currencyType !== 'USD') {
        // Total USDC
        if (circle.custody?.stablecoinBalance && circle.custody.stablecoinBalance > 0) {
          try {
            const localEquivalent = await priceService.convertFromUSD(circle.custody.stablecoinBalance, circle.currencyType);
            setManageCustodyUsdcTotalLocalDisplay(formatCurrency(localEquivalent, circle.currencyType));
          } catch (error) {
            console.warn('Failed to convert total custody USDC to local currency:', error);
            setManageCustodyUsdcTotalLocalDisplay(null);
          }
        } else {
          setManageCustodyUsdcTotalLocalDisplay(null);
        }

        // USDC Security Deposits
        if (usdcSecurityDepositBalance && usdcSecurityDepositBalance > 0) {
          try {
            const localEquivalent = await priceService.convertFromUSD(usdcSecurityDepositBalance, circle.currencyType);
            setManageCustodyUsdcSecurityDepositLocalDisplay(formatCurrency(localEquivalent, circle.currencyType));
          } catch (error) {
            console.warn('Failed to convert security deposit USDC to local currency:', error);
            setManageCustodyUsdcSecurityDepositLocalDisplay(null);
          }
        } else {
          setManageCustodyUsdcSecurityDepositLocalDisplay(null);
        }

        // USDC Contributions
        if (usdcContributionBalance && usdcContributionBalance > 0) {
          try {
            const localEquivalent = await priceService.convertFromUSD(usdcContributionBalance, circle.currencyType);
            setManageCustodyUsdcContributionLocalDisplay(formatCurrency(localEquivalent, circle.currencyType));
          } catch (error) {
            console.warn('Failed to convert contribution USDC to local currency:', error);
            setManageCustodyUsdcContributionLocalDisplay(null);
          }
        } else {
          setManageCustodyUsdcContributionLocalDisplay(null);
        }
      } else {
        // If currency is USD or not set, clear local displays
        setManageCustodyUsdcTotalLocalDisplay(null);
        setManageCustodyUsdcSecurityDepositLocalDisplay(null);
        setManageCustodyUsdcContributionLocalDisplay(null);
      }
    };

    if (circle) {
      convertAndSetDisplays();
    }
  }, [circle, usdcSecurityDepositBalance, usdcContributionBalance, suiPrice]); // suiPrice is a dependency for priceService

  // Circle routing configuration card
  const CircleRoutingSettings = ({ 
    circle, 
    totalLocalDisplay,
    securityDepositLocalDisplay,
    contributionLocalDisplay
  }: { 
    circle: Circle, 
    totalLocalDisplay: string | null,
    securityDepositLocalDisplay: string | null,
    contributionLocalDisplay: string | null
  }) => {
    const [allowNativeSui, setAllowNativeSui] = useState(circle.autoSwapEnabled);
    const [isConfiguring, setIsConfiguring] = useState(false);
    const isTokenModeLockedForActiveCycle = circle.isActive && !circle.paused;
    
    // Keep local toggle state synchronized with on-chain circle config.
    useEffect(() => {
      if (circle.autoSwapEnabled !== allowNativeSui) {
        console.log(`CircleRoutingSettings: Syncing internal state (${allowNativeSui}) with prop (${circle.autoSwapEnabled})`);
        setAllowNativeSui(circle.autoSwapEnabled);
      }
    }, [circle.autoSwapEnabled, allowNativeSui]);
    
    const handleToggleNativeSuiOptIn = async () => {
      if (isTokenModeLockedForActiveCycle) {
        toast.error('Token mode is locked during an active cycle. Wait until the cycle is completed and payouts are finished.');
        return;
      }

      const newState = !allowNativeSui;
      const actionText = newState ? 'enable' : 'disable';
      
      setConfirmationModal({
        isOpen: true,
        title: `${newState ? 'Enable' : 'Disable'} SUI Circle Mode`,
        message: (
          <div>
            <p>Are you sure you want to {actionText} SUI circle mode for this circle?</p>
            {newState ? (
              <div className="mt-2 text-sm">
                <p>When enabled:</p>
                <ul className="list-disc pl-5 mt-1">
                  <li>Once the circle is active, all member contributions run in SUI</li>
                  <li>Payouts for active cycles are processed in SUI</li>
                  <li>This is a circle-wide mode (no per-member token override)</li>
                </ul>
              </div>
            ) : (
              <div className="mt-2 text-sm text-amber-700">
                <p className="font-semibold">When disabled:</p>
                <ul className="list-disc pl-5 mt-1">
                  <li>Circle contributions and payouts return to USDC routing</li>
                  <li>Members will not be able to contribute in SUI</li>
                  <li>This is recommended for stable-value accounting</li>
                </ul>
              </div>
            )}
          </div>
        ),
        confirmText: newState ? 'Enable SUI Mode' : 'Disable SUI Mode',
        cancelText: 'Cancel',
        confirmButtonVariant: newState ? 'primary' : 'warning',
        onConfirm: async () => {
          setIsConfiguring(true);
          try {
            const success = await toggleNativeSuiOptIn(newState);
            if (success) {
              setAllowNativeSui(newState);
            }
          } finally {
            setIsConfiguring(false);
          }
        },
      });
    };

    // Function to refresh all balances
    const refreshAllBalances = () => {
      fetchCustodyWalletSuiBalance();
      fetchCustodyWalletUsdcBalance();
    };

    const usdcTotalBalance = circle.custody?.stablecoinBalance && circle.custody.stablecoinBalance > 0
      ? circle.custody.stablecoinBalance
      : 0;
    const suiTotalBalance = circle.custody?.suiBalance && circle.custody.suiBalance > 0
      ? circle.custody.suiBalance
      : 0;
    const suiUsdEquivalent = suiTotalBalance * suiPrice;
    const treasuryUsdTotal = usdcTotalBalance + suiUsdEquivalent;
    const usdcTreasuryShare = treasuryUsdTotal > 0 ? (usdcTotalBalance / treasuryUsdTotal) * 100 : 0;
    const usdcToSuiValueRatio = suiUsdEquivalent > 0 ? usdcTotalBalance / suiUsdEquivalent : null;
    const activeMembersCount = contributionStatus.totalActiveInRotation > 0
      ? contributionStatus.totalActiveInRotation
      : members.filter((member) => member.status === 'active').length;
    const expectedCycleUsdcContributions = activeMembersCount > 0 && circle.contributionAmountUsd > 0
      ? activeMembersCount * circle.contributionAmountUsd
      : 0;
    const usdcContributedThisCycle = usdcContributionBalance ?? 0;
    const usdcContributionProgress = expectedCycleUsdcContributions > 0
      ? Math.min((usdcContributedThisCycle / expectedCycleUsdcContributions) * 100, 100)
      : 0;
    const treasuryHealth = usdcTreasuryShare >= 70
      ? { label: 'Stable (USDC-heavy)', className: 'bg-emerald-100 text-emerald-700' }
      : usdcTreasuryShare >= 40
        ? { label: 'Balanced', className: 'bg-amber-100 text-amber-700' }
        : { label: 'Volatile (SUI-heavy)', className: 'bg-rose-100 text-rose-700' };


    
    return (
      <div className="space-y-4">
        <div className="rounded-[20px] border border-blue-100 bg-blue-50 px-3 py-3 sm:px-4 sm:py-4">
          <h3 className="text-lg font-semibold text-blue-800">Circle Token Routing Settings</h3>
          <p className="text-sm text-blue-600">Set one circle-wide token mode for active-cycle contributions and payouts. Once a cycle is active, this mode is locked until cycle completion and payouts finish.</p>
        </div>

        <div className="space-y-4">
          {!circle.custody?.walletId ? (
            <div className="rounded-[20px] border border-stone-200 bg-stone-50/80 p-4 text-center text-gray-500">
              <p>Custody wallet information not available</p>
            </div>
          ) : (
            <div className="space-y-4 sm:space-y-5">
              <div className="space-y-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <h4 className="font-medium text-gray-800">Use SUI For Active Circle</h4>
                    <p className="text-sm text-gray-500">If enabled, all active-cycle contributions and payouts run in SUI for all members. This setting cannot be changed mid-cycle.</p>
                  </div>
                  <div className="flex items-center">
                    <button
                      type="button"
                      onClick={handleToggleNativeSuiOptIn}
                      disabled={isConfiguring || isTokenModeLockedForActiveCycle}
                      className={`relative inline-flex h-6 w-11 items-center rounded-full ${allowNativeSui ? 'bg-blue-600' : 'bg-gray-200'} ${(isConfiguring || isTokenModeLockedForActiveCycle) ? 'opacity-50 cursor-not-allowed' : ''}`}
                    >
                      <span className="sr-only">Enable SUI circle mode</span>
                      <span 
                        className={`inline-block h-4 w-4 transform rounded-full bg-white transition ${allowNativeSui ? 'translate-x-6' : 'translate-x-1'}`} 
                      />
                    </button>
                  </div>
                </div>

                {isTokenModeLockedForActiveCycle && (
                  <div className="rounded-[18px] border border-amber-200 bg-amber-50 p-3">
                    <p className="text-sm text-amber-700">
                      <strong>Locked:</strong> Token mode cannot be changed while cycle {circle.currentCycle} is active. Update it after the cycle completes and payouts are done.
                    </p>
                  </div>
                )}
                
                <div className="rounded-[18px] border border-yellow-200 bg-yellow-50 p-3">
                  <p className="text-sm text-yellow-700">
                    <strong>Note:</strong> This setting applies to every member in the circle.
                    Enabling SUI mode increases exposure to token price volatility.
                  </p>
                </div>
                
                {circle.custody && (
                  <div className="rounded-[20px] border border-stone-200 bg-stone-50/60 p-3 sm:rounded-[22px] sm:p-4">
                    <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <h5 className="font-medium text-gray-700">Wallet Balances</h5>
                      <button 
                        onClick={refreshAllBalances}
                        disabled={fetchingSuiBalance || fetchingUsdcBalance}
                        className="inline-flex w-full items-center justify-center rounded-lg bg-indigo-50 px-3 py-2 text-xs text-indigo-600 transition-colors hover:bg-indigo-100 disabled:opacity-50 sm:w-auto"
                      >
                        {fetchingSuiBalance || fetchingUsdcBalance ? (
                          <span className="flex items-center">
                            <svg className="animate-spin -ml-1 mr-1 h-3 w-3 text-indigo-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                            </svg>
                            Refreshing...
                          </span>
                        ) : (
                          <span className="flex items-center">
                            <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                            </svg>
                            Refresh Balances
                          </span>
                        )}
                      </button>
                    </div>

                    <div className="space-y-3">
                      <div className="grid grid-cols-1 gap-2 sm:gap-3 md:grid-cols-2">
                        <div className="rounded-[18px] border border-stone-200 bg-white p-3">
                          <p className="text-xs text-gray-500 mb-1">USDC/SUI Value Ratio</p>
                          <p className="text-sm font-semibold text-gray-800">
                            {usdcToSuiValueRatio !== null ? `${usdcToSuiValueRatio.toFixed(2)}x` : 'USDC-only treasury'}
                          </p>
                          <p className="text-xs text-gray-500 mt-1">USDC share: {usdcTreasuryShare.toFixed(1)}%</p>
                        </div>
                        <div className="rounded-[18px] border border-stone-200 bg-white p-3">
                          <p className="text-xs text-gray-500 mb-1">Treasury Health</p>
                          <div className="flex items-center gap-2">
                            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${treasuryHealth.className}`}>
                              {treasuryHealth.label}
                            </span>
                          </div>
                          <p className="text-xs text-gray-500 mt-1">USDC value is prioritized for payout stability.</p>
                        </div>
                      </div>

                      {/* USDC Balance Section (Primary) */}
                      <div className="rounded-[20px] border border-blue-200 bg-blue-50 p-3 sm:p-4">
                        <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                          <div className="min-w-0">
                            <p className="text-xs font-semibold text-blue-700 tracking-wide">USDC (PRIMARY)</p>
                            <p className="text-3xl font-bold text-blue-900 leading-tight">
                              {formatUSD(usdcTotalBalance)}
                            </p>
                            <p className="text-xs text-blue-700">
                              USD equivalent (1 USDC ~= $1.00)
                              {totalLocalDisplay && ` | Local ~= ${totalLocalDisplay}`}
                            </p>
                          </div>
                          {fetchingUsdcBalance ? (
                            <span className="text-xs text-gray-400">Updating...</span>
                          ) : (
                            <span className="text-xs bg-white text-blue-700 px-2 py-0.5 rounded-full border border-blue-200">
                              Total: {formatUSD(usdcTotalBalance)}
                            </span>
                          )}
                        </div>

                        {!fetchingUsdcBalance && ((usdcContributionBalance !== null && usdcContributionBalance > 0) ||
                                               (usdcSecurityDepositBalance !== null && usdcSecurityDepositBalance > 0)) && (
                          <div className="space-y-2">
                            {usdcContributionBalance !== null && usdcContributionBalance > 0 && (
                              <div className="flex flex-wrap items-center gap-2">
                                <div className="w-3 h-3 bg-green-300 rounded-sm mr-2"></div>
                                <span className="text-sm text-gray-700">
                                  {formatUSD(usdcContributionBalance)}
                                  {contributionLocalDisplay && ` (~= ${contributionLocalDisplay})`}
                                </span>
                                <span className="rounded-full bg-green-100 px-1.5 py-0.5 text-xs font-medium text-green-800">
                                  Contributions
                                </span>
                              </div>
                            )}

                            {usdcSecurityDepositBalance !== null && usdcSecurityDepositBalance > 0 && (
                              <div className="flex flex-wrap items-center gap-2">
                                <div className="w-3 h-3 bg-amber-300 rounded-sm mr-2"></div>
                                <span className="text-sm text-gray-700">
                                  {formatUSD(usdcSecurityDepositBalance)}
                                  {securityDepositLocalDisplay && ` (~= ${securityDepositLocalDisplay})`}
                                </span>
                                <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-800">
                                  Security Deposits
                                </span>
                              </div>
                            )}
                          </div>
                        )}

                        {!fetchingUsdcBalance && (usdcContributionBalance === null || usdcContributionBalance === 0) &&
                          (usdcSecurityDepositBalance === null || usdcSecurityDepositBalance === 0) && (
                          <p className="text-sm text-gray-500 mt-1">No USDC balances available</p>
                        )}

                        <div className="mt-3 border-t border-blue-200 pt-3 sm:rounded-[18px] sm:border sm:border-blue-100 sm:bg-white sm:p-3 sm:border-t-0">
                          <div className="flex justify-between items-center mb-2">
                            <p className="text-xs font-semibold text-blue-700">USDC Contribution Trend</p>
                            <p className="text-xs text-blue-700">{usdcContributionProgress.toFixed(1)}%</p>
                          </div>
                          <div className="h-2 bg-blue-100 rounded-full overflow-hidden">
                            <div
                              className="h-full bg-blue-600 rounded-full transition-all duration-500"
                              style={{ width: `${usdcContributionProgress}%` }}
                            />
                          </div>
                          <div className="mt-2 flex flex-col gap-1 text-xs text-gray-500 sm:flex-row sm:items-center sm:justify-between">
                            <span>{formatUSD(usdcContributedThisCycle)} tracked</span>
                            <span>
                              {expectedCycleUsdcContributions > 0
                                ? `Target ${formatUSD(expectedCycleUsdcContributions)}`
                                : 'Target unavailable'}
                            </span>
                          </div>
                        </div>
                      </div>

                      {/* SUI Balance Section */}
                      <div className="rounded-[20px] border border-stone-200 bg-white p-3">
                        <div className="mb-2 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                          <div className="min-w-0">
                            <p className="text-xs text-gray-500 font-medium">SUI</p>
                            <p className="text-xs text-gray-500">
                              USD equivalent at {formatUSD(suiPrice)} / SUI: {formatUSD(suiUsdEquivalent)}
                            </p>
                          </div>
                          {fetchingSuiBalance ? (
                            <span className="text-xs text-gray-400">Updating...</span>
                          ) : (
                            <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">
                              Total: {suiTotalBalance > 0 ? suiTotalBalance.toFixed(6) : '0'} SUI
                            </span>
                          )}
                        </div>

                        {!fetchingSuiBalance && ((suiContributionBalance !== null && suiContributionBalance > 0) ||
                                               (suiSecurityDepositBalance !== null && suiSecurityDepositBalance > 0)) && (
                          <div className="space-y-2">
                            {suiContributionBalance !== null && suiContributionBalance > 0 && (
                              <div className="flex flex-wrap items-center gap-2">
                                <div className="w-3 h-3 bg-green-300 rounded-sm mr-2"></div>
                                <span className="text-sm text-gray-700">
                                  {suiContributionBalance.toFixed(6)} SUI
                                </span>
                                <span className="rounded-full bg-green-100 px-1.5 py-0.5 text-xs font-medium text-green-800">
                                  Contributions
                                </span>
                              </div>
                            )}

                            {suiSecurityDepositBalance !== null && suiSecurityDepositBalance > 0 && (
                              <div className="flex flex-wrap items-center gap-2">
                                <div className="w-3 h-3 bg-amber-300 rounded-sm mr-2"></div>
                                <span className="text-sm text-gray-700">
                                  {suiSecurityDepositBalance.toFixed(6)} SUI
                                </span>
                                <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-800">
                                  Security Deposits
                                </span>
                              </div>
                            )}
                          </div>
                        )}

                        {!fetchingSuiBalance && (suiContributionBalance === null || suiContributionBalance === 0) &&
                          (suiSecurityDepositBalance === null || suiSecurityDepositBalance === 0) && (
                          <div>
                            <p className="text-sm text-gray-500 mt-1">No SUI balances available</p>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    );
  };

  // Modify the handleActivateCircle function to use a confirmation modal
  const handleActivateCircle = async () => {
    if (!circle) return;
    
    // Show confirmation modal first
    setConfirmationModal({
      isOpen: true,
      title: 'Activate Circle',
      message: (
        <div>
          <p>Are you sure you want to activate this circle?</p>
          <p className="mt-2">Once activated:</p>
          <ul className="mt-1 list-disc pl-5 text-sm">
            <li>Members will be locked to the current rotation order</li>
            <li>Contribution schedule will begin based on your settings</li>
            <li>Members will need to make their contributions on time</li>
          </ul>
        </div>
      ),
      confirmText: 'Activate',
      cancelText: 'Cancel',
      confirmButtonVariant: 'primary',
      onConfirm: async () => {
        // Execute the actual activation process
        const toastId = 'activate-circle'; // Define toast ID
        
        try {
          // Show loading toast
          toast.loading('Activating circle...', { id: toastId });
          
          if (!account) {
            toast.error('User account not available. Please log in again.', { id: toastId });
            return;
          }
          
          // Call the backend API
          const { response: response, result: result } = await runSignedTx(() =>
            new ZkLoginClient().activateCircle(account, circle.id));
          
          // Dismiss loading toast regardless of outcome
          toast.dismiss(toastId);
          
          if (!response.ok) {
            console.error('Failed to activate circle (API Response):', result);
            
            // **Log 1: Raw error from backend**
            const rawError = result.error || 'No error message received';
            console.log('Raw error received:', rawError);
            
            // Parse the error for a more specific message
            const errorDetail = parseMoveError(rawError);
            
            // **Log 2: Parsed error detail**
            console.log('Parsed error detail:', errorDetail);
            
            // Show a specific error message to the user
            let displayMessage = errorDetail.message;
            if (errorDetail.code === 22) {
              displayMessage += " Please ensure all members have paid their security deposits.";
            }
            
            // **Log 3: Final message for toast**
            console.log('Final display message:', displayMessage);
            
            toast.error(displayMessage, { 
              id: toastId + '-error', 
              duration: 8000 // Increase duration for important errors
            });
            
            // Optionally, handle re-authentication separately if needed
            if (errorDetail.code === 401) {
              console.log("Authentication error detected, suggest re-login");
            }
            return;
          }
          
          // Invalidate BEFORE setCircle: the state update synchronously fires
          // the contribution-status effect, which reads the cached circle —
          // must miss the pre-activation snapshot. (fetchCircleDetails below
          // also invalidates, but it's async and would lose the race.)
          invalidateObject(id as string);

          // Update local state
          setCircle(prevCircle => prevCircle ? { ...prevCircle, isActive: true } : null);
          // Chain into "Open the first round" automatically — the panel
          // fires onStartRound once it detects circleIsActive=true.
          setAutoOpenFirstRound(true);

          // Show success message with the transaction digest
          toast.success(`Circle activated! Opening the first round now…`, { id: toastId + '-success' });

          // Refresh circle details
          fetchCircleDetails();
        } catch (error) {
          // **Log 4: Error caught in final catch block**
          console.error('Error activating circle (Caught in final catch):', error);
          toast.dismiss(toastId);
          
          // Attempt to parse error in catch block as well
          const rawCaughtError = error instanceof Error ? error.message : String(error);
          console.log('Raw caught error message:', rawCaughtError);
          
          const errorDetail = parseMoveError(rawCaughtError);
          console.log('Parsed caught error detail:', errorDetail);
          
          toast.error(errorDetail.message || 'An unexpected error occurred while activating the circle', { 
            id: toastId + '-error', 
            duration: 8000 
          });
        }
      },
    });
  };

  // Update the saveRotationOrder function to allow editing when circle is paused after a cycle
  const saveRotationOrder = async (newOrder: string[]) => {
    if (!id || !userAddress || !circle) return;
    
    // Allow editing rotation order if circle is paused, but prevent if just active
    if (circle.isActive && !circle.paused) {
      toast.error('Cannot modify rotation order for active circles');
      setIsEditingRotation(false);
      return;
    }
    
    // First, check if we have enough addresses in the order
    if (newOrder.length !== members.length) {
      toast.error(`Rotation order must include all ${members.length} members`);
      return;
    }
    
    // Ensure all addresses have 0x prefix and match the case on the blockchain
    const normalizedOrder = newOrder.map(addr => 
      addr.toLowerCase().startsWith('0x') ? addr.toLowerCase() : `0x${addr.toLowerCase()}`
    );
    
    // Debug log the order being saved
    console.log('Saving rotation order:', normalizedOrder);
    
    setConfirmationModal({
      isOpen: true,
      title: 'Confirm Rotation Order Change',
      message: 'Are you sure you want to save this new rotation order? This will determine who receives payouts in which order.',
      onConfirm: async () => {
        try {
          setLoading(true);
          
          // Make sure we have actual members to set positions for
          if (!members || members.length === 0) {
            toast.error("No members to set positions for");
            setLoading(false);
            return;
          }
          
          // Initialize the ZkLoginClient
          const zkLoginClient = new ZkLoginClient();
          
          // Create a lookup set of valid member addresses with consistent format
          const memberAddresses = new Set(members.map(m => {
            const addr = m.address.toLowerCase();
            return addr.startsWith('0x') ? addr : `0x${addr}`;
          }));
          
          // Verify all addresses in the order are valid members
          let hasInvalidMembers = false;
          normalizedOrder.forEach(addr => {
            if (!memberAddresses.has(addr)) {
              console.error(`Address ${addr} is not a member of the circle`);
              toast.error(`${shortenAddress(addr)} is not a member of the circle`);
              hasInvalidMembers = true;
            }
          });
          
          if (hasInvalidMembers) {
            setLoading(false);
            return;
          }
          
          // Make sure admin is included in the rotation order
          const normalizedAdmin = circle.admin.toLowerCase().startsWith('0x') ? 
            circle.admin.toLowerCase() : 
            `0x${circle.admin.toLowerCase()}`;
          
          if (!normalizedOrder.includes(normalizedAdmin)) {
            toast.error("Admin must be included in the rotation order");
            setLoading(false);
            return;
          }
          
          // Use the new bulk reorder method
          try {
            toast.loading('Updating rotation order...', { id: 'rotation-order' });
            
            await zkLoginClient.reorderRotationPositions(
              account!,
              id as string,
              normalizedOrder,
              getCurrentNetwork() // Include current network to ensure correct chain targeting
            );
            
            toast.success('Rotation order updated successfully!', { id: 'rotation-order' });
            
            // Refresh circle details
            await fetchCircleDetails();
            setIsEditingRotation(false);
            
            // Log the new status
            logRotationOrderStatus();
          } catch (error) {
            console.error('Error reordering rotation positions:', error);
            
            // Check if this is a session expiration error
            if (error instanceof Error && 
                (error.message.includes('login again') || 
                 error.message.includes('session expired'))) {
              toast.error('Your session has expired. Please log in again.', { id: 'rotation-order' });
              router.push('/login');
              return;
            }
            
            // Check if this is a Move abort error
            const moveAbortMatch = error instanceof Error ? 
              error.message.match(/MoveAbort\(.*,\s*(\d+)\)/) : null;
            
            if (moveAbortMatch && moveAbortMatch[1]) {
              const errorCode = parseInt(moveAbortMatch[1], 10);
              const errorMessage = rotationErrorCodes[errorCode] || 
                `Error code ${errorCode}: Could not reorder rotation positions`;
              
              toast.error(errorMessage, { id: 'rotation-order' });
            } else {
              const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
              toast.error(errorMessage, { id: 'rotation-order' });
            }
          }
        } catch (error) {
          console.error('Error saving rotation order:', error);
          toast.error('Failed to update rotation order');
        } finally {
          setLoading(false);
        }
      },
      confirmText: 'Save Order',
      cancelText: 'Cancel',
      confirmButtonVariant: 'primary',
    });
  };

  // ------------------------------------------------------------------
  // Mid-cycle migration
  //
  // Records where a circle that has been running elsewhere already stands.
  // The contract refuses this once the circle is live, and refuses to start
  // the circle until every member has confirmed it.
  // ------------------------------------------------------------------
  const handleDeclareMigrationState = (priorRoundsCompleted: number, startPosition: number) => {
    if (!id || !circle || !account) return;

    const rotation = members
      .filter((member) => typeof member.position === 'number')
      .slice()
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    const nextRecipient = rotation[startPosition];
    const alreadyCollected = rotation.slice(0, startPosition);

    setConfirmationModal({
      isOpen: true,
      title: 'Confirm your circle\'s current position',
      message: (
        <div className="space-y-3">
          <p>
            You are recording that this circle has already been running, and that{' '}
            {nextRecipient ? shortenAddress(nextRecipient.address) : 'the next member'} is
            next to collect.
          </p>
          {alreadyCollected.length > 0 && (
            <div className="rounded-[16px] border border-stone-200 bg-stone-50 p-3 text-sm text-slate-700">
              <p className="font-medium text-slate-900">
                Recorded as already collected, off this platform
              </p>
              <ul className="mt-2 list-disc pl-5">
                {alreadyCollected.map((member) => (
                  <li key={member.address}>{shortenAddress(member.address)}</li>
                ))}
              </ul>
              <p className="mt-2">
                They keep contributing each round, and collect again when the next
                round comes back to them.
              </p>
            </div>
          )}
          <p>
            Every member is asked to confirm this before the circle starts. Nothing
            takes effect until they all have.
          </p>
        </div>
      ),
      confirmText: 'Record it',
      cancelText: 'Cancel',
      confirmButtonVariant: 'primary',
      onConfirm: async () => {
        const toastId = 'declare-migration';
        try {
          setIsMigrationBusy(true);
          toast.loading('Recording your circle\'s position...', { id: toastId });

          await new ZkLoginClient().declareMigrationState(
            account,
            id as string,
            priorRoundsCompleted,
            startPosition,
            getCurrentNetwork(),
          );

          toast.success('Recorded. Members can now confirm it.', { id: toastId });
          await fetchCircleDetails();
        } catch (error) {
          console.error('Error declaring migration state:', error);
          toast.error(parseMoveError(error instanceof Error ? error.message : String(error)).message, {
            id: toastId,
          });
        } finally {
          setIsMigrationBusy(false);
        }
      },
    });
  };

  const handleClearMigrationState = () => {
    if (!id || !circle || !account) return;

    setConfirmationModal({
      isOpen: true,
      title: 'Start this circle from the beginning?',
      message: (
        <div className="space-y-2">
          <p>
            This removes the recorded history. The circle will start a fresh
            rotation with whoever is first in the payout order.
          </p>
          <p>Any confirmations members have already given are discarded.</p>
        </div>
      ),
      confirmText: 'Remove the history',
      cancelText: 'Keep it',
      confirmButtonVariant: 'warning',
      onConfirm: async () => {
        const toastId = 'clear-migration';
        try {
          setIsMigrationBusy(true);
          toast.loading('Removing the recorded history...', { id: toastId });

          await new ZkLoginClient().clearMigrationState(
            account,
            id as string,
            getCurrentNetwork(),
          );

          toast.success('Removed. This circle will start from the beginning.', { id: toastId });
          await fetchCircleDetails();
        } catch (error) {
          console.error('Error clearing migration state:', error);
          toast.error(parseMoveError(error instanceof Error ? error.message : String(error)).message, {
            id: toastId,
          });
        } finally {
          setIsMigrationBusy(false);
        }
      },
    });
  };

  // Add this helper function to check if rotation order is properly set
  const isRotationOrderSet = (members: Member[]): boolean => {
    if (members.length === 0) return false;
    
    // Check if all members have a defined position
    if (!members.every(member => member.position !== undefined)) {
      return false;
    }
    
    // Check for duplicate positions (excluding undefined positions)
    const positions = members
      .filter(member => member.position !== undefined)
      .map(member => member.position);
    
    // If we don't have as many unique positions as we have members, return false
    const uniquePositions = new Set(positions);
    if (uniquePositions.size !== members.length) {
      return false;
    }
    
    // Ensure each position is valid (0 to members.length-1)
    for (const pos of positions) {
      if (pos !== undefined && (pos < 0 || pos >= members.length)) {
        return false;
      }
    }
    
    return true;
  };

  // Add a debug function to log the rotation order status to the console
  const logRotationOrderStatus = () => {
    console.log("Members:", members);
    console.log("Is rotation order set:", isRotationOrderSet(members));
    console.log("Positions:", members.map(m => m.position));
    console.log("Unique positions:", new Set(members.map(m => m.position)).size);
  };

  // Add to useEffect when members state is updated to debug
  useEffect(() => {
    if (members.length > 0) {
      logRotationOrderStatus();
    }
    // Debug-only logger; no additional deps needed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [members]);

  // Add this shuffle function after the saveRotationOrder function

  // Mirrors the contract's is_migration_ratified: every seat in the rotation,
  // at the ledger's current version. Null when the circle never migrated.
  const migrationRatification = useMemo(() => {
    if (!migrationLedger) return null;

    const rotationOrder = members
      .filter((member) => typeof member.position === 'number')
      .slice()
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
      .map((member) => member.address);

    return resolveMigrationRatification(migrationLedger, rotationOrder);
  }, [migrationLedger, members]);

  // Update the Activate Circle button disabled logic
  const canActivate = useMemo(() => {
    // 1. Check if we have a circle object
    if (!circle) return false;

    if (loadingRecoveryStatus || !recoveryStatus) {
      return false;
    }
    
    // 2. Check if all members have paid their security deposits
    const depositsPaid = allDepositsPaid === true;
    
    // 3. Check if rotation order is properly set for all members
    const rotationSet = isRotationOrderSet(members);
    
    // 4. Circle should have at least the minimum required members (3 according to Move contract)
    const hasMinimumMembers = circle.currentMembers >= 3;

    const normalizedConfiguredDelegate = normalizeRecoveryDelegateAddress(recoveryStatus.nextInCommand ?? null);
    const hasEligibleRecoveryDelegate =
      !recoveryStatus.autoReleaseEnabled || members.some((member) =>
        member.status === 'active'
          && normalizeAddress(member.address) === normalizedConfiguredDelegate
          && normalizeAddress(member.address) !== normalizeAddress(circle.admin),
      );
    
    // 5. Circle should not already be active
    const notAlreadyActive = !circle.isActive;

    // 6. A circle that declared where it already stands cannot start until
    // every member has confirmed that picture, AND the payout order still
    // matches the one they confirmed. The contract refuses both
    // (EMigrationNotRatified / EMigrationRotationChanged); this keeps the
    // button honest about why.
    const migrationSettled =
      !migrationRatification
      || (migrationRatification.isRatified && migrationRatification.matchesRotation);
    
    // Log conditions for debugging
    console.log('Circle activation conditions:', {
      depositsPaid,
      rotationSet,
      hasMinimumMembers,
      hasEligibleRecoveryDelegate,
      notAlreadyActive,
      migrationSettled,
      currentMembers: circle.currentMembers,
    });
    
    // All conditions must be true
    return depositsPaid && rotationSet && hasMinimumMembers && hasEligibleRecoveryDelegate && notAlreadyActive && migrationSettled;
  }, [circle, allDepositsPaid, loadingRecoveryStatus, members, recoveryStatus, migrationRatification]);

  // Add this function to debug member deposit status
  const debugMemberDeposits = () => {
    if (!members.length) return;
    
    console.log('🔍 DEPOSIT STATUS DEBUGGING:');
    console.log('Circle ID:', id);
    console.log('Total members:', members.length);
    console.log('allDepositsPaid state value:', allDepositsPaid);
    
    // Check which members don't have deposits
    const unpaidMembers = members.filter(m => !m.depositPaid);
    console.log('Members without deposits:', unpaidMembers.length);
    
    // Log details of each unpaid member
    unpaidMembers.forEach((member, index) => {
      console.log(`Unpaid member #${index + 1}:`, {
        address: member.address,
        depositPaid: member.depositPaid,
        position: member.position,
        status: member.status
      });
    });
    
    // Check if there's any inconsistency in the members array
    const depositPaidCheck = members.every(m => m.depositPaid === true);
    console.log('Rechecked depositPaid for all members:', depositPaidCheck);
    
    return unpaidMembers;
  };

  // Add this to modify fetchCircleDetails to better detect deposits
  useEffect(() => {
    if (members.length > 0) {
      logRotationOrderStatus();
      
      // Add this line to debug deposit status
      const unpaidMembers = debugMemberDeposits();
      
      // Force update allDepositsPaid if needed based on the transaction proof shown by user
      if (unpaidMembers && unpaidMembers.length === 0 && !allDepositsPaid) {
        console.log("⚠️ Detected inconsistency - all members appear to have paid but allDepositsPaid is false. Updating state...");
        setAllDepositsPaid(true);
      }
      
      // Add this additional check for specific error 21 cases
      if (circle?.id && members.length >= 3 && !allDepositsPaid) {
        // Check if actually all deposits are paid based on multiple methods
        const depositStatuses = members.map(m => m.depositPaid);
        const allPaidAccordingToUI = depositStatuses.every(status => status === true);
        
        if (allPaidAccordingToUI) {
          console.log("🔄 All deposits show as paid in UI, but allDepositsPaid state is false. Forcing update...");
          setAllDepositsPaid(true);
          
          // Trigger a refresh of circle details to ensure we have the latest data
          fetchCircleDetails();
        } else {
          console.log("⚠️ Deposit issue detected. Not all deposits are paid according to UI:", depositStatuses);
          console.log("Members without deposits:", members.filter(m => !m.depositPaid).map(m => m.address));
        }
      }
    }
    // Debug helpers close over the same dependencies already listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [members, allDepositsPaid, circle]);

  // Get the current circle size category
  const getCircleSizeCategory = (size: number) => {
    if (size <= recommendedRanges.small.max) return 'small';
    if (size <= recommendedRanges.medium.max) return 'medium';
    return 'large';
  };

  // Add function to handle saving max members
  const handleSaveMaxMembers = async () => {
    if (!circle || isSavingMaxMembers) return;
    
    const maxMembersNum = Number(newMaxMembersValue);
    if (isNaN(maxMembersNum) || maxMembersNum < 3) {
      toast.error("Maximum members must be a number and at least 3");
      return;
    }
    
    if (maxMembersNum < circle.currentMembers) {
      toast.error(`Maximum members cannot be less than the current number of members (${circle.currentMembers})`);
      return;
    }
    
    if (maxMembersNum === circle.maxMembers) {
      setIsEditingMaxMembers(false);
      return; 
    }
    
    setConfirmationModal({
      isOpen: true,
      title: 'Update Maximum Members',
      message: (
        <div>
          <p>Are you sure you want to change the maximum members from {circle.maxMembers} to {maxMembersNum}?</p>
          <p className="mt-2 text-sm text-gray-600">This will determine the maximum number of people who can join this circle.</p>
          {maxMembersNum > 15 && (
            <p className="mt-2 text-sm text-amber-600">
              <AlertTriangle className="inline-block mr-1 h-4 w-4" />
              Large circles may take longer to complete all rotation cycles.
            </p>
          )}
        </div>
      ),
      onConfirm: async () => {
        setIsSavingMaxMembers(true);
        const toastId = 'max-members-update';
        
        try {
          toast.loading('Updating maximum members...', { id: toastId });
          
          if (!account) {
            toast.error('User account not available. Please log in again.', { id: toastId });
            setIsSavingMaxMembers(false); // Reset saving state
            return;
          }
          
          const { response: response, result: result } = await runSignedTx(() =>
            new ZkLoginClient().adminSetMaxMembers(account, circle.id, maxMembersNum));
          
          if (!response.ok) {
            console.error('Failed to update max members:', result);
            const upgrade = parseUpgradeRequired(result);
            if (upgrade) {
              toast.dismiss(toastId);
              setUpsell(upgrade);
              return;
            }
            const errorDetail = parseMoveError(result.error || '');
            toast.error(errorDetail.message, { id: toastId });
            return;
          }
          
          setCircle(prevCircle => prevCircle ? { ...prevCircle, maxMembers: maxMembersNum } : null);
          setIsEditingMaxMembers(false);
          toast.success(`Maximum members updated to ${maxMembersNum}`, { id: toastId });
          fetchCircleDetails();
          
        } catch (error) {
          console.error('Error updating max members:', error);
          toast.error('Failed to update maximum members', { id: toastId });
        } finally {
          setIsSavingMaxMembers(false);
        }
      },
      confirmText: 'Update',
      cancelText: 'Cancel',
      confirmButtonVariant: 'primary',
    });
  };

  const fetchContributionStatus = useCallback(async () => {
    if (!circle || !circle.id || !circle.isActive) {
      setContributionStatus({ contributedMembers: new Set(), activeMembersInRotation: [], currentCycle: 0, totalActiveInRotation: 0, currentPosition: null });
      setLoadingContributions(false);
      return;
    }

    console.log('[ContributionStatus] Fetching for circle:', circle.id);
    setLoadingContributions(true);
    const client = getSuiClientFromPool(getJsonRpcUrl());
    let currentCycleFromServer = 0;
    let determinedActiveMembersInRotation: string[] = [];
    let currentPositionInRotation: number | null = null;
    let memberAtCurrentPosition: string | null = null;
    const uniqueContributors = new Set<string>();

    try {
      const circleObjectData = await readObject(circle.id, { showContent: true });
      if (circleObjectData.data?.content && 'fields' in circleObjectData.data.content) {
        const cFields = circleObjectData.data.content.fields as Record<string, SuiFieldValue>;
        const membersField = cFields.members && typeof cFields.members === 'object' && cFields.members !== null
          ? cFields.members as { fields?: Record<string, unknown> }
          : null;
        const membersFieldId = membersField?.fields?.id;
        const membersTableId = membersFieldId && typeof membersFieldId === 'object' && membersFieldId !== null
          ? (membersFieldId as { id?: string }).id
          : undefined;
        currentCycleFromServer = cFields.current_cycle ? Number(cFields.current_cycle) : 0;
        currentPositionInRotation = cFields.current_position ? Number(cFields.current_position) : null;
        console.log('[ContributionStatus] Current cycle from server:', currentCycleFromServer);
        console.log('[ContributionStatus] Current position in rotation:', currentPositionInRotation);

        const rotationOrderFromFields = cFields.rotation_order as string[];
        if (Array.isArray(rotationOrderFromFields) && rotationOrderFromFields.length > 0) {
          const membersMap = new Map(members.map(m => [m.address, m]));
          if (currentPositionInRotation !== null && 
              currentPositionInRotation >= 0 && 
              currentPositionInRotation < rotationOrderFromFields.length) {
            memberAtCurrentPosition = rotationOrderFromFields[currentPositionInRotation];
            console.log('[ContributionStatus] Member at current position:', memberAtCurrentPosition);
          }

          if (membersTableId) {
            const memberSnapshots = await Promise.all(
              rotationOrderFromFields
                .filter((addr): addr is string => typeof addr === 'string' && addr !== '0x0')
                .map(async (address) => {
                  try {
                    const memberField = await client.getDynamicFieldObject({
                      parentId: membersTableId,
                      name: { type: 'address', value: address }
                    });

                    if (!memberField.data?.content || !('fields' in memberField.data.content)) {
                      return null;
                    }

                    const memberWrapper = memberField.data.content.fields as {
                      value?: {
                        fields?: {
                          deposit_paid?: boolean;
                          last_contribution?: string | number;
                          status?: string | number;
                        };
                      };
                    };

                    const memberData = memberWrapper.value?.fields;
                    const rawStatus = memberData?.status;
                    const statusRaw = typeof rawStatus === 'string'
                      ? parseInt(rawStatus, 10)
                      : typeof rawStatus === 'number'
                        ? rawStatus
                        : null;

                    return {
                      address,
                      depositPaid: Boolean(memberData?.deposit_paid),
                      lastContributionRaw: parseU64Like(memberData?.last_contribution),
                      statusRaw
                    };
                  } catch (error) {
                    console.warn('[ContributionStatus] Failed to read member contribution snapshot:', { address, error });
                    return null;
                  }
                })
            );

            const activeSnapshots = memberSnapshots.filter((snapshot): snapshot is NonNullable<typeof snapshot> => {
              if (!snapshot || !snapshot.depositPaid) return false;
              if (snapshot.statusRaw !== null) {
                return snapshot.statusRaw === 0;
              }
              const fallbackMember = membersMap.get(snapshot.address);
              return fallbackMember?.status === 'active';
            });

            determinedActiveMembersInRotation = activeSnapshots.map(snapshot => snapshot.address);

            activeSnapshots.forEach((snapshot) => {
              if (snapshot.address === memberAtCurrentPosition) {
                return;
              }
              if (snapshot.lastContributionRaw > 0n) {
                uniqueContributors.add(snapshot.address);
              }
            });
          } else {
            determinedActiveMembersInRotation = rotationOrderFromFields.filter(addr => {
              if (addr && addr !== '0x0') {
                const memberDetail = membersMap.get(addr);
                return memberDetail && memberDetail.status === 'active' && memberDetail.depositPaid;
              }
              return false;
            });

            determinedActiveMembersInRotation.forEach((address) => {
              if (address === memberAtCurrentPosition) {
                return;
              }
              const memberDetail = membersMap.get(address);
              if ((memberDetail?.lastContributionRaw || 0n) > 0n) {
                uniqueContributors.add(address);
              }
            });
          }

          console.log('[ContributionStatus] Active members from rotation_order:', determinedActiveMembersInRotation);
        }
      }

      // Fallback if rotation order processing didn't yield results but we have members
      if (determinedActiveMembersInRotation.length === 0 && members.length > 0) {
        determinedActiveMembersInRotation = members
          .filter(m => m.status === 'active' && m.depositPaid)
          .map(m => m.address);
        console.log('[ContributionStatus] Active members from members list (fallback):', determinedActiveMembersInRotation);

        determinedActiveMembersInRotation.forEach((address) => {
          if (address === memberAtCurrentPosition) {
            return;
          }
          const memberDetail = members.find((member) => member.address === address);
          if ((memberDetail?.lastContributionRaw || 0n) > 0n) {
            uniqueContributors.add(address);
          }
        });
      }
      
      if (determinedActiveMembersInRotation.length === 0 && circle.currentMembers > 0) {
        console.warn("[ContributionStatus] Could not determine active members in rotation. Payout trigger UI might be inaccurate.");
      }
      
      setContributionStatus({
        contributedMembers: uniqueContributors,
        activeMembersInRotation: determinedActiveMembersInRotation,
        currentCycle: currentCycleFromServer,
        totalActiveInRotation: determinedActiveMembersInRotation.length,
        currentPosition: currentPositionInRotation,
      });

    } catch (error) {
      console.error("[ContributionStatus] Error fetching contribution status:", error);
      setContributionStatus({ contributedMembers: new Set(), activeMembersInRotation: [], currentCycle: 0, totalActiveInRotation: 0, currentPosition: null });
    } finally {
      setLoadingContributions(false);
    }
  }, [circle, members]);

  useEffect(() => {
    if (circle && circle.isActive && members.length > 0) {
      fetchContributionStatus();
    }
  }, [circle, members, fetchContributionStatus]); // Ensure members is a dependency too

  const fetchRecoveryStatus = useCallback(async () => {
    if (!id) {
      setRecoveryStatus(null);
      return;
    }

    setLoadingRecoveryStatus(true);
    setRecoveryStatusError(false);
    try {
      const client = getSuiClientFromPool(getJsonRpcUrl());
      const dynamicFieldsResult = await client.getDynamicFields({ parentId: id as string });
      const configFields = await getCircleConfigFieldsFromDynamicFields(client, dynamicFieldsResult.data);
      setRecoveryStatus(parseRecoveryStatus(configFields));
      setMigrationLedger(await getMigrationLedgerFromDynamicFields(client, dynamicFieldsResult.data));
      setRecoveryStatusError(false);
    } catch (error) {
      logSuiReadError('Failed to refresh recovery status:', error);
      // Record the failure. Previously this branch left state untouched, so a
      // failed read was permanently indistinguishable from a loaded circle
      // with auto-release off.
      setRecoveryStatusError(true);
    } finally {
      setLoadingRecoveryStatus(false);
    }
  }, [id]);

  const fetchRecoveryExecutionState = useCallback(async (packageIdOverride?: string) => {
    if (!id) {
      setRecoveryExecution(null);
      return;
    }

    setLoadingRecoveryExecution(true);
    try {
      const resolvedPackageId =
        packageIdOverride ||
        circlePackageId ||
        (userAddress ? await getCirclePackageId(id as string, userAddress) : null);

      if (!resolvedPackageId) {
        setRecoveryExecution(null);
        return;
      }

      if (!circlePackageId) {
        setCirclePackageId(resolvedPackageId);
      }

      const client = getSuiClientFromPool(getJsonRpcUrl());
      setRecoveryExecution(
        await loadRecoveryExecutionStatus({
          client,
          packageId: resolvedPackageId,
          circleId: id as string,
        }),
      );
    } catch (error) {
      logSuiReadError('Failed to refresh recovery execution state:', error);
    } finally {
      setLoadingRecoveryExecution(false);
    }
  }, [circlePackageId, id, userAddress]);

  useEffect(() => {
    if (!id || !userAddress) {
      return;
    }

    void fetchRecoveryStatus();
    void fetchRecoveryExecutionState();
    // Recovery is a slow-moving safety status (liveness/grace windows are hours),
    // not a live feed — poll gently and skip while the tab is backgrounded. The
    // old 15s cadence was a top contributor to RPC rate-limit cooldowns.
    const intervalId = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      void fetchRecoveryStatus();
      void fetchRecoveryExecutionState();
    }, 60000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [fetchRecoveryExecutionState, fetchRecoveryStatus, id, userAddress]);

  useEffect(() => {
    if (!circlePackageId || !id) {
      return;
    }

    let isActive = true;
    let unsubscribe: (() => void) | null = null;
    const rpcUrl = getJsonRpcUrl();
    const subscriptionClient = getSuiClientFromPool(rpcUrl);

    subscriptionClient.subscribeEvent({
      filter: {
        MoveModule: {
          package: circlePackageId,
          module: 'njangi_circles',
        },
      },
      onMessage: (event) => {
        const parsed = asRecord(event.parsedJson);
        if (
          typeof parsed?.circle_id !== 'string' ||
          parsed.circle_id.toLowerCase() !== (id as string).toLowerCase()
        ) {
          return;
        }

        if (!event.type.includes('EmergencyStop') && !event.type.includes('Recovery')) {
          return;
        }

        void fetchRecoveryStatus();
        void fetchRecoveryExecutionState(circlePackageId);
      },
    }).then((cleanup) => {
      if (!isActive) {
        cleanup();
        return;
      }

      unsubscribe = cleanup;
    }).catch((error) => {
      console.warn('Recovery event subscription unavailable, continuing with polling:', error);
    });

    return () => {
      isActive = false;
      if (unsubscribe) {
        unsubscribe();
      }
    };
  }, [circlePackageId, fetchRecoveryExecutionState, fetchRecoveryStatus, id]);

  useEffect(() => {
    if (isEditingRecoveryDelegate) {
      return;
    }

    setRecoveryDelegateDraft(recoveryStatus?.nextInCommand ?? '');
  }, [isEditingRecoveryDelegate, recoveryStatus?.nextInCommand]);

  const postRecoveryAction = async (
    action: 'proposeEmergencyStop' | 'voteEmergencyStop' | 'executeRecovery' | 'triggerAutoRelease',
    extraBody: Record<string, unknown>,
    messages: { loading: string; success: string },
  ) => {
    if (!circle || !account) {
      toast.error('Circle or account information is unavailable.');
      return false;
    }

    setIsSubmittingRecoveryAction(true);
    const toastId = `recovery-${action}`;

    try {
      toast.loading(messages.loading, { id: toastId });
      const zkLoginClient = ZkLoginClient.getInstance();

      switch (action) {
        case 'proposeEmergencyStop':
          await zkLoginClient.proposeEmergencyStop(account, {
            circleId: circle.id,
            network: getCurrentNetwork(),
          });
          break;
        case 'voteEmergencyStop':
          await zkLoginClient.voteEmergencyStop(account, {
            circleId: circle.id,
            yesVote: Boolean(extraBody.yesVote),
            network: getCurrentNetwork(),
          });
          break;
        case 'executeRecovery':
          await zkLoginClient.executeRecovery(account, {
            circleId: circle.id,
            walletId: String(extraBody.walletId || ''),
            stablecoinType: String(extraBody.stablecoinType || recoveryStablecoinMeta.coinType),
            network: getCurrentNetwork(),
          });
          break;
        case 'triggerAutoRelease':
          await zkLoginClient.triggerAutoRelease(account, {
            circleId: circle.id,
            walletId: String(extraBody.walletId || ''),
            stablecoinType: String(extraBody.stablecoinType || recoveryStablecoinMeta.coinType),
            network: getCurrentNetwork(),
          });
          break;
        default:
          throw new Error(`Unsupported recovery action: ${action}`);
      }

      toast.success(messages.success, { id: toastId });
      await Promise.all([
        fetchCircleDetails(),
        fetchRecoveryStatus(),
        fetchRecoveryExecutionState(circlePackageId || undefined),
      ]);
      return true;
    } catch (error) {
      console.error(`Recovery action ${action} failed:`, error);
      const parsedError = parseMoveError(error instanceof Error ? error.message : String(error));
      toast.error(parsedError.message, { id: toastId });

      if (error instanceof ZkLoginError && error.requireRelogin) {
        router.push('/');
      }

      return false;
    } finally {
      setIsSubmittingRecoveryAction(false);
    }
  };

  const handleProposeEmergencyStop = () => {
    if (!circle) return;

    setConfirmationModal({
      isOpen: true,
      title: 'Propose Emergency Stop',
      message: (
        <div className="space-y-3">
          <p>
            This will open a member vote to stop the circle and return every tracked contribution and security deposit
            from the custody wallet.
          </p>
          <p className="rounded-[16px] border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            Use this only for worst-case recovery. Once the proposal passes and recovery is executed, the current cycle
            ends and refunds are sent back to each owner.
          </p>
        </div>
      ),
      onConfirm: async () => {
        await postRecoveryAction(
          'proposeEmergencyStop',
          {},
          {
            loading: 'Creating emergency stop proposal...',
            success: 'Emergency stop proposal created.',
          },
        );
      },
      confirmText: 'Create Proposal',
      cancelText: 'Cancel',
      confirmButtonVariant: 'danger',
    });
  };

  const handleVoteEmergencyStop = (yesVote: boolean) => {
    setConfirmationModal({
      isOpen: true,
      title: yesVote ? 'Approve Emergency Stop' : 'Reject Emergency Stop',
      message: (
        <div className="space-y-3">
          <p>
            You are about to {yesVote ? 'approve' : 'reject'} the current emergency stop proposal.
          </p>
          <p className="text-sm text-slate-600">
            Your vote is recorded onchain and cannot be changed after submission.
          </p>
        </div>
      ),
      onConfirm: async () => {
        await postRecoveryAction(
          'voteEmergencyStop',
          { yesVote },
          {
            loading: yesVote ? 'Submitting approval vote...' : 'Submitting rejection vote...',
            success: yesVote ? 'Approval vote recorded.' : 'Rejection vote recorded.',
          },
        );
      },
      confirmText: yesVote ? 'Vote Yes' : 'Vote No',
      cancelText: 'Cancel',
      confirmButtonVariant: yesVote ? 'warning' : 'primary',
    });
  };

  const handleExecuteRecovery = () => {
    if (!circle?.custody?.walletId) {
      toast.error('Custody wallet information is unavailable.');
      return;
    }
    const recoveryWalletId = circle.custody.walletId;

    setConfirmationModal({
      isOpen: true,
      title: 'Execute Emergency Stop',
      message: (
        <div className="space-y-3">
          <p>
            Majority approval has been reached. Executing recovery will stop the circle and return all tracked
            contributions and security deposits from custody.
          </p>
          <p className="rounded-[16px] border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            This is irreversible. Once submitted, the circle enters terminal recovery and the current cycle ends.
          </p>
        </div>
      ),
      onConfirm: async () => {
        await postRecoveryAction(
          'executeRecovery',
          { walletId: recoveryWalletId },
          {
            loading: 'Executing emergency recovery...',
            success: 'Emergency recovery executed.',
          },
        );
      },
      confirmText: 'Execute Recovery',
      cancelText: 'Cancel',
      confirmButtonVariant: 'danger',
    });
  };

  const submitRecoveryDelegateUpdate = async (nextInCommand: string) => {
    if (!circle || !account) {
      toast.error('Circle or account information is unavailable.');
      return false;
    }

    setIsUpdatingRecoveryDelegate(true);
    const toastId = 'update-recovery-delegate';

    try {
      toast.loading('Updating next in command...', { id: toastId });

      const zkLoginClient = ZkLoginClient.getInstance();
      await zkLoginClient.updateNextInCommand(account, {
        circleId: circle.id,
        nextInCommand,
        network: getCurrentNetwork(),
      });

      toast.success('Next in command updated.', { id: toastId });

      setRecoveryStatus((previous) => previous
        ? { ...previous, nextInCommand }
        : previous);
      setIsEditingRecoveryDelegate(false);
      await Promise.all([
        fetchCircleDetails(),
        fetchRecoveryStatus(),
      ]);
      return true;
    } catch (error) {
      console.error('Failed to update next in command:', error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      const parsedError = errorMessage.includes('MoveAbort(')
        ? parseMoveError(errorMessage)
        : { code: 0, message: errorMessage };
      toast.error(parsedError.message, { id: toastId });

      if (error instanceof ZkLoginError && error.requireRelogin) {
        router.push('/');
      }

      return false;
    } finally {
      setIsUpdatingRecoveryDelegate(false);
    }
  };

  const handleUpdateRecoveryDelegate = () => {
    if (!circle) {
      return;
    }

    const validationError = getRecoveryDelegateValidationError({
      value: recoveryDelegateDraft,
      adminAddress: circle.admin,
      // A delegate is only mandatory where the contract makes it mandatory:
      // activate_circle enforces one solely when auto-release is enabled.
      required: recoveryStatus?.autoReleaseEnabled === true,
    });
    if (validationError) {
      toast.error(validationError);
      return;
    }

    const normalizedNextInCommand = normalizeRecoveryDelegateAddress(recoveryDelegateDraft);
    if (!normalizedNextInCommand) {
      toast.error('A valid next-in-command wallet is required for auto-release circles.');
      return;
    }

    setConfirmationModal({
      isOpen: true,
      title: 'Update Next in Command',
      message: (
        <div className="space-y-3">
          <p>
            This will replace the designated next in command for admin-liveness recovery.
          </p>
          <div className="rounded-[16px] border border-stone-200 bg-stone-50 p-3 text-sm text-slate-700">
            <p className="font-medium text-slate-900">New recovery trigger order</p>
            <p className="mt-2">Next in command: {normalizedNextInCommand}</p>
            <p className="mt-2">
              If your heartbeat expires, this wallet gets the first 24 hours of exclusive trigger authority before eligible active members inherit fallback rights.
            </p>
          </div>
          <p className="rounded-[16px] border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            This only works while the circle is healthy. Once recovery is pending or active, delegate updates are locked.
          </p>
        </div>
      ),
      onConfirm: async () => {
        await submitRecoveryDelegateUpdate(normalizedNextInCommand);
      },
      confirmText: 'Save Delegate',
      cancelText: 'Cancel',
      confirmButtonVariant: 'primary',
    });
  };

  const allContributionsMadeThisCycle = useMemo(() => {
    if (loadingContributions || !circle || !circle.isActive) {
      return false;
    }
    const { contributedMembers, totalActiveInRotation, activeMembersInRotation, currentPosition, currentCycle } = contributionStatus;
    if (totalActiveInRotation === 0 || currentCycle === 0) return false; // Avoid division by zero or incorrect true for empty rotation
    
    // Get the recipient member who doesn't need to contribute
    let recipientMember: string | null = null;
    if (currentPosition !== null && currentPosition !== undefined) {
      recipientMember = activeMembersInRotation[currentPosition] || null;
    }
    
    // How many members should contribute = total active members - 1 (recipient)
    const requiredContributions = recipientMember ? totalActiveInRotation - 1 : totalActiveInRotation;
    
    // Count how many non-recipient members have contributed
    let validContributions = 0;
    contributedMembers.forEach(member => {
      // Don't count recipient's contribution
      if (member !== recipientMember) {
        validContributions++;
      }
    });
    
    const made = validContributions >= requiredContributions;
    console.log('[ContributionStatus] All contributions made check:', {
        made,
        contributedSize: contributedMembers.size,
        validContributions,
        requiredContributions,
        totalActive: totalActiveInRotation,
        recipientMember,
        currentPosition,
        currentCycle: contributionStatus.currentCycle
    });
    return made;
  }, [contributionStatus, circle, loadingContributions]);

  const paidDepositMembers = useMemo(
    () => members.filter((member) => member.depositPaid),
    [members],
  );
  const eligibleRecoveryDelegateMembers = useMemo(
    () => members.filter((member) =>
      member.status === 'active'
      && normalizeAddress(member.address) !== normalizeAddress(circle?.admin),
    ),
    [circle?.admin, members],
  );

  const now = Date.now();
  const recoveryProposal = recoveryStatus?.proposal ?? null;
  const recoveryProposalUi = recoveryProposal
    ? getRecoveryProposalUiState({
        proposal: recoveryProposal,
        userAddress,
        now,
      })
    : null;
  const recoveryEligibleVoterCount = recoveryProposalUi?.eligibleVoterCount ?? 0;
  const recoveryVoteCount = recoveryProposalUi?.voteCount ?? 0;
  const recoveryProposalPassed = recoveryProposalUi?.isPassed ?? false;
  const recoveryProposalFailed = recoveryProposalUi?.isFailed ?? false;
  const recoveryDeadlinePassed = recoveryProposalUi?.isDeadlinePassed ?? false;
  const currentUserVote = recoveryProposalUi?.currentUserVote ?? null;
  const canCurrentUserVote = recoveryProposalUi?.canVote ?? false;
  const recoveryVoteProgress = recoveryProposalUi?.progressPercent ?? 0;
  const recoveryStablecoinMeta = resolveStablecoinMetadata(
    circle?.custody?.stablecoinCoinType || circle?.custody?.stablecoinType || null,
  );
  const configuredRecoveryDelegate = normalizeRecoveryDelegateAddress(recoveryStatus?.nextInCommand ?? null);
  const recoveryDelegateMember = configuredRecoveryDelegate
    ? members.find((member) => normalizeAddress(member.address) === configuredRecoveryDelegate) ?? null
    : null;
  const recoveryDelegateIsEligibleActiveMember = Boolean(
    recoveryDelegateMember && recoveryDelegateMember.status === 'active',
  );
  const autoReleaseUi = getRecoveryAutoReleaseUiState({
    recoveryStatus,
    adminAddress: circle?.admin,
    userAddress,
    viewerIsEligibleActiveMember: false,
    delegateIsEligibleActiveMember: recoveryDelegateIsEligibleActiveMember,
    now,
  });
  const autoReleaseRemainingMs = autoReleaseUi.remainingMs;
  const autoReleaseReady = autoReleaseUi.ready;
  // Single source of truth for the admin-liveness card's wording. `statusKnown`
  // is what stops an unread snapshot from being reported as a settled state —
  // see getRecoveryDelegateCardCopy for why that mattered more after the fix
  // than before it.
  const recoveryStatusKnown = recoveryStatus !== null;
  const delegateCopy = getRecoveryDelegateCardCopy({
    statusKnown: recoveryStatusKnown,
    loadError: recoveryStatusError,
    autoReleaseEnabled: autoReleaseUi.enabled,
    delegateStatus: autoReleaseUi.delegateStatus,
    authorityMode: autoReleaseUi.authorityMode,
    circleIsActive: Boolean(circle?.isActive),
  });
  const canExecuteRecovery = Boolean(
    recoveryProposalPassed
      && recoveryStatus
      && recoveryStatus.rawState !== 2
      && recoveryStatus.rawState !== 3,
  );
  const canManageRecoveryDelegate = Boolean(
    recoveryStatus?.autoReleaseEnabled && recoveryStatus.rawState === 0,
  );
  const recoveryDelegateValidationError = getRecoveryDelegateValidationError({
    value: recoveryDelegateDraft,
    adminAddress: circle?.admin,
    required: recoveryStatus?.autoReleaseEnabled === true,
  });
  const normalizedRecoveryDelegateDraft = normalizeRecoveryDelegateAddress(recoveryDelegateDraft);
  const recoveryDelegateDraftIsEligibleMember = Boolean(
    normalizedRecoveryDelegateDraft
    && eligibleRecoveryDelegateMembers.some(
      (member) => normalizeAddress(member.address) === normalizedRecoveryDelegateDraft,
    ),
  );
  const showIneligibleRecoveryDelegateOption = Boolean(
    normalizedRecoveryDelegateDraft && !recoveryDelegateDraftIsEligibleMember,
  );
  const hasRecoveryDelegateDraftChanges =
    (normalizedRecoveryDelegateDraft ?? null) !== (autoReleaseUi.configuredDelegate ?? null);
  const recoveryDelegateFormDisabledReason =
    // `!recoveryStatus?.autoReleaseEnabled` is also true while the snapshot is
    // still null, so this used to assert "not configured at creation" about a
    // circle it had not read yet. Check that the status is known first.
    !recoveryStatus
      ? delegateCopy.delegateHint
      : !recoveryStatus.autoReleaseEnabled
        ? 'Auto-release was not configured for this circle at creation.'
        : recoveryStatus.rawState !== 0
          ? 'Delegate updates are locked once emergency recovery leaves the active state.'
          : null;
  const recoveryExecutionStarted = Boolean(recoveryExecution?.startedAt);
  const recoveryExecutionCompleted = Boolean(recoveryExecution?.completedAt) || recoveryStatus?.rawState === 3;
  const recoveryExecutionProgress = recoveryExecution
    ? Math.min(100, (recoveryExecution.refundedMembers / Math.max(recoveryExecution.totalMembers, 1)) * 100)
    : recoveryStatus?.rawState === 3
      ? 100
      : 0;
  const formatRecoveryAssetAmount = (rawAmount: bigint, decimals: number, label: string) =>
    `${formatTokenAmount(toDisplayAmount(rawAmount, decimals), decimals === 9 ? 4 : 2)} ${label}`;

  if (authLoading || !isAuthenticated || !account) {
    return null;
  }

  // Helper to get activation requirement message
  const getActivationRequirementMessage = () => {
    if (!circle) return "Circle data not loaded.";

    if (loadingRecoveryStatus) {
      return 'Recovery configuration is still loading.';
    }

    if (!recoveryStatus) {
      return 'Recovery configuration could not be loaded. Refresh and try again.';
    }
    
    if (circle.isActive) {
      return "Circle is already active.";
    }
    
    if (circle.currentMembers < 3) {
      return `Need at least 3 members to activate (currently have ${circle.currentMembers}).`;
    }

    if (recoveryStatus.autoReleaseEnabled) {
      const normalizedConfiguredDelegate = normalizeRecoveryDelegateAddress(recoveryStatus.nextInCommand ?? null);
      const delegateIsEligibleMember = eligibleRecoveryDelegateMembers.some((member) =>
        normalizeAddress(member.address) === normalizedConfiguredDelegate,
      );

      if (!normalizedConfiguredDelegate) {
        return 'Admin liveness fallback is enabled. Set a next in command before activation.';
      }

      if (!delegateIsEligibleMember) {
        return (
          <div>
            <p>The next in command must be an active non-admin member before activation.</p>
            {eligibleRecoveryDelegateMembers.length > 0 ? (
              <>
                <p className="mt-2 font-medium">Eligible members:</p>
                <ul className="mt-1 list-disc pl-5 text-xs">
                  {eligibleRecoveryDelegateMembers.map((member) => (
                    <li key={member.address}>{shortenAddress(member.address)}</li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="mt-2 text-xs">Approve members first, then assign one as next in command.</p>
            )}
          </div>
        );
      }
    }
    
    if (!allDepositsPaid) {
      // Create a list of members who haven't paid their security deposit
      const unpaidMembers = members.filter(m => !m.depositPaid);
      
      return (
        <div>
          <p>All members must pay their security deposit before activation.</p>
          <p className="mt-2 font-medium">Members missing security deposit:</p>
          <ul className="mt-1 list-disc pl-5 text-xs">
            {unpaidMembers.map(member => (
              <li key={member.address}>{shortenAddress(member.address)}</li>
            ))}
          </ul>
        </div>
      );
    }
    
    if (!isRotationOrderSet(members)) {
      // Find members without rotation positions assigned
      const unpositionedMembers = members.filter(m => m.position === undefined);
      
      return (
        <div>
          <p>You must set the rotation order for all members before activating.</p>
          {unpositionedMembers.length > 0 && (
            <>
              <p className="mt-2 font-medium">Members without position:</p>
              <ul className="mt-1 list-disc pl-5 text-xs">
                {unpositionedMembers.map(member => (
                  <li key={member.address}>{shortenAddress(member.address)}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      );
    }
    
    if (migrationRatification && !migrationRatification.matchesRotation) {
      return (
        <div>
          <p>
            The payout order changed after this circle&apos;s history was recorded.
            Members confirmed a different queue, so the record has to be made
            again with the order as it stands now.
          </p>
          <p className="mt-2 text-xs">
            Open Circle history above, start again, and members will be asked to
            confirm the new order.
          </p>
        </div>
      );
    }

    if (migrationRatification && !migrationRatification.isRatified) {
      return (
        <div>
          <p>
            Every member must confirm where this circle currently stands before it
            can start.
          </p>
          <p className="mt-2 font-medium">Still to confirm:</p>
          <ul className="mt-1 list-disc pl-5 text-xs">
            {migrationRatification.pending.map((address) => (
              <li key={address}>{shortenAddress(address)}</li>
            ))}
          </ul>
          <p className="mt-2 text-xs">
            Members confirm on their own contribution page, in the same step as
            their security deposit.
          </p>
        </div>
      );
    }

    return "All requirements met! Circle can be activated.";
  };

  // Add a function to resume the cycle
  /**
   * Resumes the circle into the next round.
   *
   * Runs the transaction directly rather than opening a second dialog. The
   * button that reaches here already confirms, with strictly more detail (it
   * spells out the deposit reset); the dialog this used to chain only
   * restated it. Chaining was also what broke it: a dialog opened from inside
   * another dialog's confirm handler is closed again by the dialog that is
   * dismissing itself, so the transaction was never built and every circle
   * stayed stranded paused at the end of a round.
   */
  const handleResumeCycle = async () => {
    if (!circle || !circle.paused) return;

    const toastId = 'resume-cycle';
    try {
      toast.loading('Resuming cycle...', { id: toastId });

      if (!account) {
        toast.error('User account not available. Please log in again.', { id: toastId });
        return;
      }

      const { response, result } = await runSignedTx(() =>
        new ZkLoginClient().resumeCycle(account, circle.id));

      if (!response.ok) {
        console.error('Failed to resume cycle:', result);
        const errorDetail = parseMoveError(result.error || '');
        toast.error(errorDetail.message, { id: toastId });
        return;
      }

      setCircle(prevCircle => prevCircle ? { ...prevCircle, paused: false } : null);
      await fetchCircleDetails();

      toast.success('Successfully resumed to the next cycle', { id: toastId });
    } catch (error) {
      console.error('Error resuming cycle:', error);
      toast.error('Failed to resume cycle', { id: toastId });
    }
  };

  const openReturnAllDepositsModal = () => {
    if (!circle) return;

    const canReturnSecurityDeposit = !circle.isActive || circle.paused;
    if (!canReturnSecurityDeposit) {
      toast.error('Security deposits can only be returned when the circle is inactive or paused after a cycle.');
      return;
    }

    const eligibleAddresses = paidDepositMembers.map(member => member.address);

    if (eligibleAddresses.length === 0) {
      toast.error('No paid security deposits are available to return.');
      return;
    }

    setPaidOutInCurrentSessionMembers(new Set());
    setSelectedMembersForPayout(new Set(eligibleAddresses));
    setShowPayoutDepositModal(true);
  };

  // Function to handle security deposit returns for multiple members
  const handleSecurityDepositPayout = async (memberAddresses: string[]) => {
    if (!circle || !circle.id || !account) {
      toast.error('Missing circle information or account.');
      return;
    }

    if (!circle.custody?.walletId) {
      toast.error('Custody wallet information is not available.');
      return;
    }

    if (circle.isActive && !circle.paused) {
      toast.error('Security deposits can only be returned when the circle is inactive or paused after a cycle.');
      return;
    }

    if (memberAddresses.length === 0) {
      toast.error('No members selected for deposit return.');
      return;
    }

    setIsProcessingPayout(true);
    const toastId = 'security-deposit-payout';
    
    try {
      toast.loading(`Returning security deposits for ${memberAddresses.length} member(s)...`, { id: toastId });
      setPayoutProgress({current: 0, total: memberAddresses.length});
      
      // Track actual successful payouts
      let successCount = 0;
      
      // Process each member sequentially
      for (let i = 0; i < memberAddresses.length; i++) {
        const memberAddress = memberAddresses[i];
        setPayoutProgress({current: i + 1, total: memberAddresses.length});
        
        try {
          // Check if wallet ID is available
          if (!circle.custody?.walletId) {
            throw new Error('Wallet ID is required but not available');
          }
          
          // Ensure address has proper format
          const normalizedAddress = memberAddress.startsWith('0x') ? memberAddress : `0x${memberAddress}`;
          
          const response = await fetch('/api/zkLogin', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'returnSecurityDeposit',
              account,
              circleId: circle.id,
              walletId: circle.custody.walletId,
              memberAddress: normalizedAddress,
              network: getCurrentNetwork()
            })
          });

          const responseData = await response.json();

          if (!response.ok) {
            if (response.status === 401 || responseData.requireRelogin) {
              throw new ZkLoginError(
                responseData.error || 'Authentication failed. Please login again.',
                true
              );
            }
            throw new Error(responseData.error || 'Failed to return security deposit');
          }

          if (responseData.status === 'failure') {
            throw new Error(responseData.error || responseData.details || 'Transaction failed on blockchain');
          }
          
          console.log(`Security deposit return executed for ${shortenAddress(memberAddress)}. Digest: ${responseData.digest}`);
          
          // Add to paid out set for immediate UI update in modal
          setPaidOutInCurrentSessionMembers(prev => new Set(prev).add(memberAddress));
          
          // Increment success counter
          successCount++;
          
        } catch (memberError) {
          console.error(`Error returning security deposit for ${shortenAddress(memberAddress)}:`, memberError);
          toast.error(`Failed to return deposit for ${shortenAddress(memberAddress)}: ${memberError instanceof Error ? memberError.message : 'Unknown error'}`, 
            { id: `${toastId}-error-${i}`, duration: 5000 });
          
          // Continue with next member even if one fails
          if (memberError instanceof ZkLoginError && memberError.requireRelogin) {
            router.push('/');
            break;
          }
        }
      }
      
      // Update the UI - refresh circle data and member status
      await fetchCircleDetails();
      
      // Show success message with actual success count
      toast.success(`Completed security deposit returns: ${successCount}/${memberAddresses.length} successful`, { id: toastId });
      
      // Close the modal and reset selections
      setShowPayoutDepositModal(false);
      setSelectedMembersForPayout(new Set());
      // setPaidOutInCurrentSessionMembers(new Set()); // Clear for next modal opening if desired, or let fetchCircleDetails handle it
      
    } catch (error) {
      console.error('Error processing multiple security deposit returns:', error);
      
      // Parse the error for a more specific message
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      toast.error(errorMessage, { id: toastId });
      
      if (error instanceof ZkLoginError && error.requireRelogin) {
        router.push('/');
      }
    } finally {
      setIsProcessingPayout(false);
      setPayoutProgress({current: 0, total: 0});
    }
  };

  // Replace the SecurityDepositPayoutModal component with the updated version
  const SecurityDepositPayoutModal = () => {
    // Safely get security deposit amount
    const securityDepositAmount = circle?.securityDeposit?.toFixed(4) || '0.0000';
    
    // Early return if modal should not be shown
    if (!showPayoutDepositModal) return null;
    
    // Filter to only show members with paid deposits AND not paid out in current session
    const eligibleMembers = members.filter(member => member.depositPaid && !paidOutInCurrentSessionMembers.has(member.address));
    const alreadyPaidMembers = members.filter(member => !member.depositPaid || paidOutInCurrentSessionMembers.has(member.address));
    
    // Function to handle member selection
    const handleMemberSelection = (memberAddress: string) => {
      const newSelected = new Set(selectedMembersForPayout);
      if (newSelected.has(memberAddress)) {
        newSelected.delete(memberAddress);
      } else {
        newSelected.add(memberAddress);
      }
      setSelectedMembersForPayout(newSelected);
    };
    
    // Function to check if button should be disabled
    const isPayoutButtonDisabled = () => {
      return (
        selectedMembersForPayout.size === 0 || 
        isProcessingPayout || 
        (selectedMembersForPayout.size > 0 && Array.from(selectedMembersForPayout).every(addr => 
          paidOutInCurrentSessionMembers.has(addr) || 
          !members.find(m => m.address === addr)?.depositPaid
        ))
      );
    };
    
    return (
      <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 md:items-center md:p-4">
        <div className="flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-t-[28px] bg-white shadow-xl md:max-h-[90vh] md:max-w-2xl md:rounded-xl">
          <div className="bg-blue-600 px-5 py-4 text-white md:px-6">
            <h2 className="text-xl font-semibold">Manage Deposits</h2>
            <p className="text-blue-100 text-sm mt-1">
              Return paid deposits in one batch. Member removals stay in the Members table.
            </p>
          </div>
          
          <div className="flex-grow overflow-y-auto px-5 py-4 md:px-6">
            {eligibleMembers.length === 0 ? (
              <div className="text-center py-8">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-12 w-12 mx-auto text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <p className="mt-4 text-gray-600">No members with paid security deposits found.</p>
              </div>
            ) : (
              <div className="space-y-4">
                <p className="text-gray-700 mb-4">
                  Select the members whose deposits should be returned. This action cannot be undone.
                </p>
                
                <div className="flex justify-between items-center mb-2">
                  <span className="text-sm font-medium text-gray-500">
                    {selectedMembersForPayout.size} member(s) selected
                  </span>
                  <div className="flex space-x-2">
                    <button 
                      onClick={() => setSelectedMembersForPayout(new Set())}
                      className="text-xs bg-gray-100 hover:bg-gray-200 text-gray-600 py-1 px-2 rounded transition-colors"
                    >
                      Clear All
                    </button>
                    <button 
                      onClick={() => {
                        const allEligibleMemberAddresses = new Set(eligibleMembers.map(member => member.address));
                        setSelectedMembersForPayout(allEligibleMemberAddresses);
                      }}
                      className="text-xs bg-blue-50 hover:bg-blue-100 text-blue-600 py-1 px-2 rounded transition-colors"
                    >
                      Select All
                    </button>
                  </div>
                </div>
                
                <div className="space-y-2 max-h-64 overflow-y-auto pr-2">
                  {eligibleMembers.map(member => {
                    const isSelected = selectedMembersForPayout.has(member.address);
                    return (
                      <div 
                        key={member.address}
                        className={`border rounded-lg p-3 cursor-pointer transition-colors ${
                          isSelected 
                            ? 'border-blue-500 bg-blue-50' 
                            : 'border-gray-200 hover:border-blue-300 hover:bg-blue-50'
                        }`}
                        onClick={() => handleMemberSelection(member.address)}
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center">
                            <div className={`w-4 h-4 rounded-full flex-shrink-0 flex items-center justify-center ${
                              isSelected 
                                ? 'bg-blue-500 ring-2 ring-blue-300' 
                                : 'border border-gray-300'
                            }`}>
                              {isSelected && (
                                <Check className="w-3 h-3 text-white" />
                              )}
                            </div>
                            <div className="ml-3">
                              <p className="font-medium text-gray-900">{shortenAddress(member.address)}</p>
                              <p className="text-xs text-gray-500">
                                {circle && member.address === circle.admin ? 'Admin' : `Position: ${member.position !== undefined ? member.position + 1 : 'Not set'}`}
                              </p>
                            </div>
                          </div>
                          <div className="text-sm font-medium text-gray-900">
                            {securityDepositAmount} SUI
                          </div>
                        </div>
                      </div>
                    );
                  })}
                  {/* Display members who have already been paid out or whose deposit is not marked as paid */}
                  {alreadyPaidMembers.map(member => (
                    <div 
                      key={member.address}
                      className="border rounded-lg p-3 cursor-not-allowed bg-gray-100 border-gray-200 opacity-70"
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center">
                          <div className={`w-4 h-4 rounded-full flex-shrink-0 flex items-center justify-center bg-green-500 ring-2 ring-green-300`}>
                            <Check className="w-3 h-3 text-white" />
                          </div>
                          <div className="ml-3">
                            <p className="font-medium text-gray-600">{shortenAddress(member.address)}</p>
                            <p className="text-xs text-gray-400">
                              {circle && member.address === circle.admin ? 'Admin' : `Position: ${member.position !== undefined ? member.position + 1 : 'Not set'}`}
                            </p>
                          </div>
                        </div>
                        <div className="text-sm font-medium text-green-600">
                          {paidOutInCurrentSessionMembers.has(member.address) ? 'Returned' : 'No Deposit'}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
                
                {/* Progress indicator for multi-return */}
                {isProcessingPayout && payoutProgress.total > 0 && (
                  <div className="mt-4 border-t border-gray-200 pt-4">
                    <div className="space-y-2">
                      <div className="flex justify-between items-center">
                        <span className="text-sm font-medium text-gray-700">
                          Returning deposits: {payoutProgress.current}/{payoutProgress.total}
                        </span>
                        <span className="text-xs font-medium text-gray-500">
                          {Math.round((payoutProgress.current / payoutProgress.total) * 100)}%
                        </span>
                      </div>
                      <div className="w-full bg-gray-200 rounded-full h-2.5">
                        <div 
                          className="bg-blue-600 h-2.5 rounded-full" 
                          style={{ 
                            width: `${(payoutProgress.current / payoutProgress.total) * 100}%` 
                          }}
                        ></div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
          
          <div className="flex justify-end space-x-3 border-t border-gray-200 bg-gray-50 px-5 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] md:px-6">
            <button
              className="px-4 py-2 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50"
              onClick={() => {
                setShowPayoutDepositModal(false);
                setSelectedMembersForPayout(new Set());
                setPaidOutInCurrentSessionMembers(new Set()); // Clear when modal is cancelled/closed
              }}
            >
              Cancel
            </button>
            <button
              className={`px-4 py-2 rounded-md text-white ${
                isPayoutButtonDisabled()
                  ? 'bg-gray-400 cursor-not-allowed' 
                  : 'bg-blue-600 hover:bg-blue-700'
              }`}
              disabled={isPayoutButtonDisabled()}
              onClick={() => {
                const selectedAddresses = Array.from(selectedMembersForPayout).filter(
                  addr => !(paidOutInCurrentSessionMembers.has(addr) || !members.find(m => m.address === addr)?.depositPaid)
                );
                if (selectedAddresses.length > 0) {
                  handleSecurityDepositPayout(selectedAddresses);
                }
              }}
            >
              {isProcessingPayout ? (
                <div className="flex items-center">
                  <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                  Processing...
                </div>
              ) : selectedMembersForPayout.size > 1 ? (
                `Return ${selectedMembersForPayout.size} Deposits`
              ) : (
                'Return Deposit'
              )}
            </button>
          </div>
        </div>
      </div>
    );
  };

  const pageSurfaceClass =
    'rounded-[28px] border border-stone-200 bg-white shadow-[0_24px_70px_-42px_rgba(15,23,42,0.32)] sm:rounded-[32px]';
  const sectionCardClass =
    'rounded-[24px] border border-stone-200 bg-white px-4 py-4 shadow-[0_18px_50px_-38px_rgba(15,23,42,0.24)] sm:rounded-[28px] sm:px-6 sm:py-6';
  const mutedPanelClass = 'rounded-[20px] border border-stone-200 bg-stone-50/80 p-3 sm:rounded-[24px] sm:p-5';
  const panelCardClass = 'rounded-[20px] border border-stone-200 bg-stone-50/85 p-3 sm:rounded-[24px] sm:p-5';
  const tableCardClass =
    'overflow-hidden rounded-[20px] border border-stone-200 bg-white shadow-[0_14px_34px_-26px_rgba(15,23,42,0.22)] sm:rounded-[24px]';
  const sectionTitleClass = 'text-xl font-semibold tracking-tight text-slate-950';
  const sectionEyebrowClass = 'text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-500';
  const primaryActionClass =
    'inline-flex items-center justify-center rounded-full bg-slate-950 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-slate-400 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50';
  const secondaryActionClass =
    'inline-flex items-center justify-center rounded-full border border-stone-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 transition hover:border-stone-400 hover:bg-stone-50 focus:outline-none focus:ring-2 focus:ring-stone-300 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50';
  const successActionClass =
    'inline-flex items-center justify-center rounded-full bg-emerald-600 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-emerald-700 focus:outline-none focus:ring-2 focus:ring-emerald-300 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50';
  const warningActionClass =
    'inline-flex items-center justify-center rounded-full bg-amber-500 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-amber-600 focus:outline-none focus:ring-2 focus:ring-amber-300 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50';
  const infoActionClass =
    'inline-flex items-center justify-center rounded-full bg-sky-600 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-sky-700 focus:outline-none focus:ring-2 focus:ring-sky-300 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50';
  const dangerActionClass =
    'inline-flex items-center justify-center rounded-full bg-red-600 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-red-300 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50';
  const subtleTagClass =
    'inline-flex items-center rounded-full border border-stone-200 bg-stone-50 px-3 py-1.5 text-sm font-medium text-slate-600';
  const subtleIconButtonClass =
    'inline-flex h-10 w-10 items-center justify-center rounded-full border border-stone-200 bg-white text-slate-500 transition hover:border-stone-300 hover:text-slate-900 focus:outline-none focus:ring-2 focus:ring-stone-300 focus:ring-offset-2';
  const dialogOverlayClass =
    'fixed inset-0 z-50 bg-slate-950/40 backdrop-blur-[2px]';
  const mobileSheetContentClass =
    'fixed inset-x-0 bottom-0 z-50 max-h-[85dvh] overflow-hidden rounded-t-[32px] border border-stone-200 bg-white shadow-[0_-24px_70px_-42px_rgba(15,23,42,0.4)] focus:outline-none md:hidden';
  const mobileSheetBodyClass =
    'max-h-[calc(85dvh-112px)] overflow-y-auto px-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:px-5';
  const mobileWorkspaceButtonClass =
    'rounded-[18px] border border-stone-200 bg-white px-3 py-3 text-left transition hover:border-stone-300 hover:bg-stone-50 sm:rounded-[20px]';
  const activeMembersCount = members.filter((member) => member.status === 'active').length;
  const circleStatusLabel = circle?.paused ? 'Paused' : circle?.isActive ? 'Active' : 'Inactive';

  return (
    <div className="min-h-screen bg-[#f6f3ee] text-slate-950 [background-image:radial-gradient(circle_at_top_left,_rgba(255,255,255,0.92),_transparent_30%),radial-gradient(circle_at_top_right,_rgba(226,232,240,0.7),_transparent_26%)]">
      <main className="mx-auto max-w-7xl px-3 py-6 sm:px-6 lg:px-8">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <button
            onClick={() => router.push('/dashboard')}
            className={secondaryActionClass}
          >
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Dashboard
          </button>
          <div className="text-right">
            <p className={sectionEyebrowClass}>Circle Admin</p>
            <h1 className="mt-1 text-lg font-semibold text-slate-950 sm:text-xl">Manage Circle</h1>
          </div>
        </div>

        <div className={`${pageSurfaceClass} overflow-hidden`}>
          <div className="border-b border-stone-200 px-4 py-5 sm:px-8 sm:py-8">
            <div className="flex flex-col gap-6">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div>
                  <p className={sectionEyebrowClass}>Admin Workspace</p>
                  <h2 className="mt-3 flex flex-wrap items-center gap-3 text-2xl font-semibold tracking-tight text-slate-950 sm:text-3xl">
                {!loading && circle ? circle.name : 'Manage Circle'}
                {!loading && circle && (
                      <span className={subtleTagClass}>
                    {circle.currentMembers}/{circle.maxMembers} Members
                  </span>
                )}
              </h2>
                  <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-600">
                    Control membership, deposits, payout flow, and token routing from one place.
                  </p>
                </div>
              {!loading && circle && (
                  <div className="flex flex-wrap items-center gap-2 text-xs sm:text-sm">
                    <span className={subtleTagClass}>{circleStatusLabel}</span>
                    <span className={subtleTagClass}>{shortenId(id as string)}</span>
                  <Tooltip.Provider>
                    <Tooltip.Root>
                      <Tooltip.Trigger asChild>
                        <button
                          onClick={() => copyToClipboard(id as string, 'id')}
                            className={`inline-flex h-10 w-10 items-center justify-center rounded-full border transition ${
                              copiedId
                                ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                                : 'border-stone-300 bg-white text-slate-600 hover:border-stone-400 hover:bg-stone-50'
                            }`}
                        >
                          {copiedId ? <Check size={16} /> : <Copy size={16} />}
                        </button>
                      </Tooltip.Trigger>
                      <Tooltip.Portal>
                        <Tooltip.Content
                          className="bg-gray-800 text-white px-2 py-1 rounded text-xs"
                          sideOffset={5}
                        >
                          {copiedId ? 'Copied!' : 'Copy Circle ID'}
                          <Tooltip.Arrow className="fill-gray-800" />
                        </Tooltip.Content>
                      </Tooltip.Portal>
                    </Tooltip.Root>
                  </Tooltip.Provider>
                  
                  <Tooltip.Provider>
                    <Tooltip.Root>
                      <Tooltip.Trigger asChild>
                        <button
                          onClick={() => copyToClipboard(id as string, 'link')}
                            className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-stone-300 bg-white text-slate-600 transition hover:border-stone-400 hover:bg-stone-50"
                        >
                          <Link size={16} />
                        </button>
                      </Tooltip.Trigger>
                      <Tooltip.Portal>
                        <Tooltip.Content
                          className="bg-gray-800 text-white px-2 py-1 rounded text-xs"
                          sideOffset={5}
                        >
                          Copy Invite Link
                          <Tooltip.Arrow className="fill-gray-800" />
                        </Tooltip.Content>
                      </Tooltip.Portal>
                    </Tooltip.Root>
                  </Tooltip.Provider>
                </div>
              )}
            </div>
              {!loading && circle && (
                <>
                  <div className="grid gap-3 md:hidden">
                    <div className="rounded-[24px] border border-stone-200 bg-stone-50/80 p-3 sm:p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className={sectionEyebrowClass}>Manage Sections</p>
                          <p className="mt-1 text-sm text-slate-600">
                            Jump straight to the task you need without walking the whole page.
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => scrollToManageSection('members')}
                          className="text-sm font-medium text-slate-600 transition hover:text-slate-950"
                        >
                          Open roster
                        </button>
                      </div>

                      <div className="mt-4 grid grid-cols-2 gap-2">
                        <button
                          type="button"
                          onClick={() => scrollToManageSection('overview')}
                          className={mobileWorkspaceButtonClass}
                        >
                          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                            Overview
                          </p>
                          <p className="mt-2 text-sm font-semibold text-slate-950">{circleStatusLabel}</p>
                          <p className="mt-1 text-xs text-slate-500">
                            {circle.currentMembers}/{circle.maxMembers} members
                          </p>
                        </button>
                        <button
                          type="button"
                          onClick={() => scrollToManageSection('recovery')}
                          className={mobileWorkspaceButtonClass}
                        >
                          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                            Recovery
                          </p>
                          <p className="mt-2 text-sm font-semibold text-slate-950">
                            {recoveryStatus?.stateLabel || 'Active'}
                          </p>
                          <p className="mt-1 text-xs text-slate-500">
                            {recoveryProposal ? `${recoveryProposal.yesVotes}/${recoveryProposal.majorityThreshold} approvals` : 'Emergency stop controls'}
                          </p>
                        </button>
                        <button
                          type="button"
                          onClick={() => scrollToManageSection('members')}
                          className={mobileWorkspaceButtonClass}
                        >
                          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                            Members
                          </p>
                          <p className="mt-2 text-sm font-semibold text-slate-950">{activeMembersCount} active</p>
                          <p className="mt-1 text-xs text-slate-500">
                            {paidDepositMembers.length} deposits settled
                          </p>
                        </button>
                        <button
                          type="button"
                          onClick={() => scrollToManageSection(pendingRequests.length > 0 ? 'approvals' : 'invite')}
                          className={mobileWorkspaceButtonClass}
                        >
                          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                            Approvals
                          </p>
                          <p className="mt-2 text-sm font-semibold text-slate-950">{pendingRequests.length}</p>
                          <p className="mt-1 text-xs text-slate-500">
                            {pendingRequests.length > 0 ? 'Requests waiting' : 'No pending requests'}
                          </p>
                        </button>
                        <button
                          type="button"
                          onClick={() => scrollToManageSection('actions')}
                          className={mobileWorkspaceButtonClass}
                        >
                          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                            Actions
                          </p>
                          <p className="mt-2 text-sm font-semibold text-slate-950">
                            {circle.isActive ? 'Payout flow' : 'Activation setup'}
                          </p>
                          <p className="mt-1 text-xs text-slate-500">Open admin controls</p>
                        </button>
                        <button
                          type="button"
                          onClick={() => scrollToManageSection('invite')}
                          className={mobileWorkspaceButtonClass}
                        >
                          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                            Invite
                          </p>
                          <p className="mt-2 text-sm font-semibold text-slate-950">Share join link</p>
                          <p className="mt-1 text-xs text-slate-500">Bring new members in</p>
                        </button>
                        <button
                          type="button"
                          onClick={() => scrollToManageSection('tools')}
                          className={mobileWorkspaceButtonClass}
                        >
                          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                            Tools
                          </p>
                          <p className="mt-2 text-sm font-semibold text-slate-950">Token routing</p>
                          <p className="mt-1 text-xs text-slate-500">Advanced admin setup</p>
                        </button>
                      </div>
                    </div>
                  </div>

                  <div className="hidden gap-4 md:grid md:grid-cols-2 xl:grid-cols-4">
                    <div className={mutedPanelClass}>
                      <p className={sectionEyebrowClass}>Members</p>
                      <p className="mt-3 text-2xl font-semibold tracking-tight text-slate-950">
                        {circle.currentMembers}/{circle.maxMembers}
                      </p>
                      <p className="mt-2 text-sm text-slate-500">Current capacity</p>
                    </div>
                    <div className={mutedPanelClass}>
                      <p className={sectionEyebrowClass}>Status</p>
                      <p className="mt-3 text-2xl font-semibold tracking-tight text-slate-950">
                        {circleStatusLabel}
                      </p>
                      <p className="mt-2 text-sm text-slate-500">
                        {circle.paused ? 'Cycle completed and awaiting admin action' : circle.isActive ? 'Contributions and payouts are live' : 'Setup is still in progress'}
                      </p>
                    </div>
                    <div className={mutedPanelClass}>
                      <p className={sectionEyebrowClass}>Contribution</p>
                      <div className="mt-3 text-lg font-semibold text-slate-950">
                        <CurrencyDisplay
                          usd={circle.contributionAmountUsd}
                          sui={circle.contributionAmount}
                          currencyType={circle.currencyType}
                          className="font-semibold"
                        />
                      </div>
                      <p className="mt-2 text-sm text-slate-500">Per member, per cycle</p>
                    </div>
                    <div className={mutedPanelClass}>
                      <p className={sectionEyebrowClass}>Next payout</p>
                      <p className="mt-3 text-lg font-semibold text-slate-950">
                        {circle.isActive
                          ? formatNextPayoutDate(circle.nextPayoutTime)
                          : formatNextPayoutDate(calculatePotentialNextPayoutDate(circle.cycleLength, circle.cycleDay))}
                      </p>
                      <p className="mt-2 text-sm text-slate-500">
                        {circle.isActive ? 'Scheduled cycle payout' : 'Estimated if activated now'}
                      </p>
                    </div>
                  </div>
                </>
              )}
            </div>
            {loading ? (
              <ManageCircleSkeleton />
            ) : circle ? (
              <div className="space-y-6 bg-stone-50/60 px-3 py-5 sm:px-6 sm:py-8">
                {/* Circle Details */}
                <div className={sectionCardClass} ref={(element) => setManageSectionRef('overview', element)}>
                  <div className="mb-5 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <p className={sectionEyebrowClass}>Overview</p>
                      <h3 className={`${sectionTitleClass} mt-2`}>Circle Details</h3>
                      <p className="mt-2 text-sm leading-6 text-slate-500">
                        A concise operational view of this circle&apos;s cadence, contribution settings, and capacity.
                      </p>
                    </div>
                    {circle.isActive && (
                      <button
                        onClick={() => fetchContributionStatus()}
                        disabled={loadingContributions}
                        className={`${secondaryActionClass} px-3 py-2 text-xs sm:text-sm`}
                      >
                        {loadingContributions ? (
                          <svg className="-ml-0.5 mr-2 h-3.5 w-3.5 animate-spin" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                          </svg>
                        ) : (
                          <RefreshCw className="mr-2 h-3.5 w-3.5" />
                        )}
                        {loadingContributions ? 'Refreshing...' : 'Refresh Status'}
                      </button>
                    )}
                  </div>

                  <div className="md:hidden">
                    <div className="rounded-[24px] border border-stone-200 bg-stone-50/80 p-3 sm:p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className={sectionEyebrowClass}>Circle snapshot</p>
                          <p className="mt-2 text-xl font-semibold tracking-tight text-slate-950">
                            {circleStatusLabel}
                          </p>
                          <p className="mt-1 text-sm text-slate-500">
                            {circle.currentMembers}/{circle.maxMembers} members
                          </p>
                        </div>
                        {circle.isActive && (
                          <button
                            type="button"
                            onClick={() => fetchContributionStatus()}
                            disabled={loadingContributions}
                            className={subtleIconButtonClass}
                            aria-label="Refresh contribution status"
                          >
                            <RefreshCw className={`h-4 w-4 ${loadingContributions ? 'animate-spin' : ''}`} />
                          </button>
                        )}
                      </div>

                      <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
                        <div className="rounded-[18px] border border-stone-200 bg-white px-3 py-3">
                          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                            Contribution
                          </p>
                          <div className="mt-2 text-sm font-semibold text-slate-950">
                            <CurrencyDisplay
                              usd={circle.contributionAmountUsd}
                              sui={circle.contributionAmount}
                              currencyType={circle.currencyType}
                              className="font-semibold"
                            />
                          </div>
                        </div>
                        <div className="rounded-[18px] border border-stone-200 bg-white px-3 py-3">
                          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                            Deposit
                          </p>
                          <div className="mt-2 text-sm font-semibold text-slate-950">
                            <CurrencyDisplay
                              usd={circle.securityDepositUsd}
                              sui={circle.securityDeposit}
                              currencyType={circle.currencyType}
                              className="font-semibold"
                            />
                          </div>
                        </div>
                        <div className="rounded-[18px] border border-stone-200 bg-white px-3 py-3">
                          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                            Next payout
                          </p>
                          <p className="mt-2 text-sm font-semibold text-slate-950">
                            {circle.isActive
                              ? formatNextPayoutDate(circle.nextPayoutTime)
                              : formatNextPayoutDate(calculatePotentialNextPayoutDate(circle.cycleLength, circle.cycleDay))}
                          </p>
                        </div>
                        <div className="rounded-[18px] border border-stone-200 bg-white px-3 py-3">
                          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                            Capacity
                          </p>
                          <p className="mt-2 text-sm font-semibold text-slate-950">
                            {circle.currentMembers}/{circle.maxMembers}
                          </p>
                        </div>
                      </div>

                      <button
                        type="button"
                        onClick={() => setIsMobileOverviewSheetOpen(true)}
                        className={`${secondaryActionClass} mt-4 w-full`}
                      >
                        View full setup
                      </button>
                    </div>
                  </div>

                  <div className="hidden grid-cols-1 gap-4 md:grid md:grid-cols-2">
                    <div className={panelCardClass}>
                      <p className={sectionEyebrowClass}>Circle Name</p>
                      <p className="mt-3 text-lg font-semibold tracking-tight text-slate-950">{circle.name}</p>
                    </div>

                    <div className={panelCardClass}>
                      <p className={sectionEyebrowClass}>Status</p>
                      <div className="mt-3 flex items-center gap-3">
                        <span className={`h-2.5 w-2.5 rounded-full ${circle.isActive ? 'bg-emerald-500' : 'bg-amber-500'}`}></span>
                        <p className="text-lg font-semibold tracking-tight text-slate-950">
                          {circle.isActive ? 'Active' : 'Inactive'}
                        </p>
                      </div>
                    </div>

                    {circle.isActive && (
                      <div className={`${panelCardClass} md:col-span-2`}>
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                          <div className="flex-1">
                            <p className={sectionEyebrowClass}>Contribution Progress</p>
                            <div className="mt-3 flex items-center justify-between gap-4">
                              <p className="text-sm font-medium text-slate-700">
                                Cycle {contributionStatus.currentCycle}
                                {typeof contributionStatus.currentPosition === 'number' && contributionStatus.totalActiveInRotation > 0 && (
                                  <span className="ml-1 text-slate-500">
                                    (Position {contributionStatus.currentPosition + 1} of {contributionStatus.totalActiveInRotation})
                                  </span>
                                )}
                              </p>
                              <p className="text-xs font-medium text-slate-500">
                                {loadingContributions
                                  ? 'Loading...'
                                  : contributionStatus.contributedMembers.size > 0
                                    ? `${contributionStatus.contributedMembers.size}/${contributionStatus.totalActiveInRotation - 1} contributed`
                                    : 'No contributions yet'}
                              </p>
                            </div>
                            <div className="mt-3 h-2.5 w-full rounded-full bg-stone-200">
                              <div
                                className={`${allContributionsMadeThisCycle ? 'bg-emerald-500' : 'bg-slate-900'} h-2.5 rounded-full transition-all duration-500`}
                                style={{
                                  width: `${loadingContributions
                                    ? '0'
                                    : contributionStatus.totalActiveInRotation <= 1
                                      ? '0'
                                      : `${(contributionStatus.contributedMembers.size / (contributionStatus.totalActiveInRotation - 1)) * 100}%`}`,
                                }}
                              ></div>
                            </div>
                          </div>

                          <div className="min-w-[160px] rounded-[18px] border border-stone-200 bg-white px-4 py-3">
                            <p className="text-xs font-medium uppercase tracking-[0.18em] text-slate-500">Next payout</p>
                            <p className="mt-2 text-sm font-semibold text-slate-950">
                              {formatNextPayoutDate(circle.nextPayoutTime)}
                            </p>
                          </div>
                        </div>
                      </div>
                    )}

                    <div className={panelCardClass}>
                      <p className={sectionEyebrowClass}>Contribution Amount</p>
                      <div className="mt-3 text-lg font-semibold text-slate-950">
                        <CurrencyDisplay
                          usd={circle.contributionAmountUsd}
                          sui={circle.contributionAmount}
                          currencyType={circle.currencyType}
                          className="font-semibold"
                        />
                      </div>
                    </div>

                    <div className={panelCardClass}>
                      <p className={sectionEyebrowClass}>Security Deposit</p>
                      <div className="mt-3 text-lg font-semibold text-slate-950">
                        <CurrencyDisplay
                          usd={circle.securityDepositUsd}
                          sui={circle.securityDeposit}
                          currencyType={circle.currencyType}
                          className="font-semibold"
                        />
                      </div>
                    </div>

                    <div className={panelCardClass}>
                      <p className={sectionEyebrowClass}>
                        {circle.isActive ? 'Next Payout' : 'Potential Next Payout'}
                      </p>
                      <p className="mt-3 text-base font-semibold text-slate-950 sm:text-lg">
                        {circle.isActive
                          ? formatNextPayoutDate(circle.nextPayoutTime)
                          : formatNextPayoutDate(calculatePotentialNextPayoutDate(circle.cycleLength, circle.cycleDay))}
                      </p>
                      {!circle.isActive && (
                        <p className="mt-2 text-xs text-slate-500">Estimated if the circle is activated now.</p>
                      )}
                    </div>

                    <div className={`${panelCardClass} md:col-span-2`}>
                      <div className="flex flex-col gap-4">
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                          <div>
                            <p className={sectionEyebrowClass}>Capacity</p>
                            <div className="mt-3 flex flex-wrap items-center gap-3">
                              <p className="text-lg font-semibold text-slate-950">
                                {circle.currentMembers} / {circle.maxMembers} members
                              </p>
                              <span className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium ${
                                getCircleSizeCategory(isEditingMaxMembers ? Number(newMaxMembersValue) : circle.maxMembers) === 'small'
                                  ? 'bg-emerald-100 text-emerald-800'
                                  : getCircleSizeCategory(isEditingMaxMembers ? Number(newMaxMembersValue) : circle.maxMembers) === 'medium'
                                    ? 'bg-sky-100 text-sky-800'
                                    : 'bg-violet-100 text-violet-800'
                              }`}>
                                {getCircleSizeCategory(isEditingMaxMembers ? Number(newMaxMembersValue) : circle.maxMembers) === 'small'
                                  ? 'Small Circle'
                                  : getCircleSizeCategory(isEditingMaxMembers ? Number(newMaxMembersValue) : circle.maxMembers) === 'medium'
                                    ? 'Medium Circle'
                                    : 'Large Circle'}
                              </span>
                            </div>
                          </div>
                          {!circle.isActive && !isEditingMaxMembers && (
                            <button
                              onClick={() => setIsEditingMaxMembers(true)}
                              className={`${secondaryActionClass} px-3 py-2 text-xs sm:text-sm`}
                            >
                              <Edit3 size={14} className="mr-2" />
                              Edit Max Capacity
                            </button>
                          )}
                        </div>

                        {isEditingMaxMembers ? (
                          <div className="space-y-5">
                            <div className={`flex flex-wrap gap-2 transition-opacity duration-300 ${animateMembers ? 'animate-pulse' : ''}`}>
                              {[...Array(Number(newMaxMembersValue))].map((_, i) => (
                                <div
                                  key={i}
                                  className={`flex h-8 w-8 items-center justify-center rounded-full ${
                                    i < circle.currentMembers
                                      ? 'border-2 border-slate-300 bg-white text-slate-700'
                                      : 'border border-stone-200 bg-stone-100 text-stone-400'
                                  } ${animateMembers ? 'animate-bounce' : ''}`}
                                  style={{ animationDelay: `${i * 50}ms` }}
                                >
                                  <Users size={14} />
                                </div>
                              ))}
                            </div>

                            <div className="space-y-3">
                              <div className="flex flex-wrap items-center justify-between gap-3">
                                <span className="text-sm font-medium text-slate-700">
                                  {newMaxMembersValue} members maximum
                                </span>
                                <span className="text-xs text-slate-500">
                                  Min {Math.max(3, circle.currentMembers)} / Max 20
                                </span>
                              </div>
                              <input
                                type="range"
                                min={Math.max(3, circle.currentMembers)}
                                max={20}
                                value={newMaxMembersValue}
                                onChange={(e) => {
                                  setNewMaxMembersValue(e.target.value);
                                  setAnimateMembers(true);
                                  setTimeout(() => setAnimateMembers(false), 600);
                                }}
                                className="h-2 w-full cursor-pointer appearance-none rounded-lg bg-stone-200 accent-slate-900"
                              />
                            </div>

                            <div className={`rounded-[18px] border p-3 text-sm ${
                              getCircleSizeCategory(Number(newMaxMembersValue)) === 'small'
                                ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                                : getCircleSizeCategory(Number(newMaxMembersValue)) === 'medium'
                                  ? 'border-sky-200 bg-sky-50 text-sky-800'
                                  : 'border-violet-200 bg-violet-50 text-violet-800'
                            }`}>
                              <p className="font-medium">
                                {recommendedRanges[getCircleSizeCategory(Number(newMaxMembersValue))].label}
                              </p>
                              <p className="mt-1">
                                {recommendedRanges[getCircleSizeCategory(Number(newMaxMembersValue))].description}
                              </p>
                            </div>

                            <div className="flex flex-wrap justify-end gap-3">
                              <button
                                onClick={() => {
                                  setIsEditingMaxMembers(false);
                                  setNewMaxMembersValue(circle.maxMembers);
                                }}
                                disabled={isSavingMaxMembers}
                                className={`${secondaryActionClass} px-4 py-2`}
                              >
                                Cancel
                              </button>
                              <button
                                onClick={handleSaveMaxMembers}
                                disabled={isSavingMaxMembers || Number(newMaxMembersValue) === circle.maxMembers}
                                className={`${primaryActionClass} px-4 py-2`}
                              >
                                {isSavingMaxMembers ? (
                                  <span className="flex items-center">
                                    <svg className="mr-2 h-4 w-4 animate-spin" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                                    </svg>
                                    Saving...
                                  </span>
                                ) : 'Save Changes'}
                              </button>
                            </div>
                          </div>
                        ) : (
                          circle.isActive && (
                            <p className="text-xs text-slate-500">Capacity cannot be changed while the circle is active.</p>
                          )
                        )}
                      </div>
                    </div>
                  </div>
                </div>
                
                {/* Add the paused status banner */}
                {circle.paused && (
                  <div className="rounded-[28px] border border-amber-200 bg-amber-50/80 px-5 py-5 sm:px-6 sm:py-6">
                    <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
                      <div className="flex-1">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-amber-700">Cycle State</p>
                        <h3 className="mt-2 flex items-center text-xl font-semibold tracking-tight text-amber-950">
                          <Pause className="mr-2 h-5 w-5" />
                          Circle Paused After Cycle Completion
                        </h3>
                        <p className="mt-3 text-sm leading-6 text-amber-900/80">
                          The circle has been paused after completing cycle {circle.currentCycle}. As the admin, you can:
                        </p>
                        <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-amber-800/90">
                          <li>Pay out remaining security deposits to members who want to leave</li>
                          <li>Edit rotation order for the next cycle</li>
                          <li>Resume the circle to start the next cycle</li>
                        </ul>
                        <p className="mt-4 flex items-start rounded-[18px] border border-amber-200 bg-white/70 p-3 text-sm font-medium text-amber-900">
                          <AlertTriangle className="mr-2 h-4 w-4 flex-shrink-0 mt-0.5" />
                          <span>
                            When you resume the circle, all members will need to pay a new security deposit for the next cycle.
                            Their deposit status will be reset, requiring them to make a new deposit before they can contribute.
                          </span>
                        </p>
                      </div>
                      <div className="flex flex-col gap-3 w-full sm:w-auto">
                        <button
                          onClick={() => {
                            setConfirmationModal({
                              isOpen: true,
                              title: 'Resume Circle & Reset Deposits',
                              message: (
                                <div>
                                  <p className="mb-2">Are you sure you want to resume the circle for the next cycle?</p>
                                  <p className="text-amber-600 font-medium">This will reset all members&apos; deposit status, requiring them to pay a new security deposit before they can contribute to the next cycle.</p>
                                </div>
                              ),
                              onConfirm: () => handleResumeCycle(), // Use the existing handleResumeCycle function
                              confirmText: 'Yes, Resume Circle',
                              cancelText: 'Cancel',
                              confirmButtonVariant: 'warning',
                            });
                          }}
                          className={`${warningActionClass} w-full`}
                        >
                          <CheckCircle className="mr-2 h-4 w-4" />
                          Resume Cycle
                        </button>
                        <button
                          onClick={openReturnAllDepositsModal}
                          className={`${infoActionClass} w-full`}
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                          </svg>
                          Manage Deposits
                        </button>
                        <button
                          onClick={fetchCircleDetails}
                          className={`${secondaryActionClass} w-full`}
                        >
                          <RefreshCw className="mr-2 h-4 w-4" />
                          Refresh
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {!circle.isActive && !circle.paused && paidDepositMembers.length > 0 && (
                  <div className="rounded-[28px] border border-sky-200 bg-sky-50/80 px-5 py-5 sm:px-6 sm:py-6">
                    <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
                      <div className="flex-1">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-sky-700">Deposits</p>
                        <h3 className="mt-2 flex items-center text-xl font-semibold tracking-tight text-sky-950">
                          <AlertTriangle className="mr-2 h-5 w-5" />
                          Deposit Management
                        </h3>
                        <p className="mt-3 text-sm leading-6 text-sky-900/80">
                          This circle is inactive. Manage individual member actions from the Members table, or use the deposit manager to return all {paidDepositMembers.length} paid deposit{paidDepositMembers.length === 1 ? '' : 's'} in one batch.
                        </p>
                      </div>
                      <div className="flex flex-col gap-3 w-full sm:w-auto">
                        <button
                          onClick={openReturnAllDepositsModal}
                          className={`${infoActionClass} w-full`}
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                          </svg>
                          Manage Deposits
                        </button>
                        <button
                          onClick={fetchCircleDetails}
                          className={`${secondaryActionClass} w-full`}
                        >
                          <RefreshCw className="mr-2 h-4 w-4" />
                          Refresh
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                <div className={sectionCardClass} ref={(element) => setManageSectionRef('recovery', element)}>
                  <div className="mb-5 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                    <div>
                      <p className={sectionEyebrowClass}>Recovery</p>
                      <h3 className={`${sectionTitleClass} mt-2`}>Emergency Stop</h3>
                      <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-500">
                        Use this flow only for worst-case recovery. A member-majority vote can stop the circle and prepare
                        funds for return to their recorded owners.
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <RecoveryStateBadge
                        rawState={recoveryStatus?.rawState}
                        stateLabel={recoveryStatus?.stateLabel || (loadingRecoveryStatus ? 'Loading' : 'Active')}
                      />
                      <button
                        type="button"
                        onClick={() => {
                          void fetchRecoveryStatus();
                          void fetchRecoveryExecutionState();
                        }}
                        disabled={loadingRecoveryStatus || loadingRecoveryExecution}
                        className={secondaryActionClass}
                      >
                        <RefreshCw className={`mr-2 h-4 w-4 ${(loadingRecoveryStatus || loadingRecoveryExecution) ? 'animate-spin' : ''}`} />
                        {loadingRecoveryStatus || loadingRecoveryExecution ? 'Refreshing...' : 'Refresh Recovery'}
                      </button>
                    </div>
                  </div>

                  {(recoveryStatus?.rawState === 2 || recoveryStatus?.rawState === 3) && (
                    <div className={`mb-4 rounded-[18px] border p-4 text-sm ${
                      recoveryStatus.rawState === 3
                        ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
                        : 'border-amber-200 bg-amber-50 text-amber-900'
                    }`}>
                      <p className="font-medium">
                        {recoveryStatus.rawState === 3 ? 'Recovery completed.' : 'Recovery execution is in progress.'}
                      </p>
                      <p className="mt-2 leading-6">
                        {recoveryStatus.rawState === 3
                          ? 'The circle is in a terminal refunded state and recorded recovery balances have been unwound.'
                          : 'The circle has been stopped for recovery and refund processing details are shown below.'}
                      </p>
                    </div>
                  )}

                  <div className="grid gap-4 xl:grid-cols-[1.7fr,1fr]">
                    <div className={panelCardClass}>
                      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                        <div>
                          <p className={sectionEyebrowClass}>Proposal</p>
                          <h4 className="mt-2 text-lg font-semibold text-slate-950">
                            {recoveryProposal ? 'Member vote in progress' : 'No emergency stop proposal'}
                          </h4>
                          <p className="mt-2 text-sm leading-6 text-slate-500">
                            {recoveryProposal
                              ? 'Eligible members vote yes or no. Recovery can proceed only after majority approval.'
                              : 'Creating a proposal snapshots eligible voters and opens a seven-day voting window.'}
                          </p>
                        </div>
                        {!recoveryProposal && recoveryStatus?.rawState === 0 && (
                          <button
                            type="button"
                            onClick={handleProposeEmergencyStop}
                            disabled={isSubmittingRecoveryAction || loadingRecoveryStatus}
                            className={dangerActionClass}
                          >
                            <AlertTriangle className="mr-2 h-4 w-4" />
                            Propose Emergency Stop
                          </button>
                        )}
                      </div>

                      {recoveryProposal ? (
                        <div className="mt-5 space-y-4">
                          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                            <div className={mutedPanelClass}>
                              <p className={sectionEyebrowClass}>Yes votes</p>
                              <p className="mt-2 text-2xl font-semibold text-slate-950">{recoveryProposal.yesVotes}</p>
                              <p className="mt-1 text-xs text-slate-500">Need {recoveryProposal.majorityThreshold} to pass</p>
                            </div>
                            <div className={mutedPanelClass}>
                              <p className={sectionEyebrowClass}>No votes</p>
                              <p className="mt-2 text-2xl font-semibold text-slate-950">{recoveryProposal.noVotes}</p>
                              <p className="mt-1 text-xs text-slate-500">{recoveryVoteCount} votes recorded</p>
                            </div>
                            <div className={mutedPanelClass}>
                              <p className={sectionEyebrowClass}>Eligible voters</p>
                              <p className="mt-2 text-2xl font-semibold text-slate-950">{recoveryEligibleVoterCount}</p>
                              <p className="mt-1 text-xs text-slate-500">{recoveryProposalUi?.pendingVoteCount ?? 0} votes still pending</p>
                            </div>
                            <div className={mutedPanelClass}>
                              <p className={sectionEyebrowClass}>Deadline</p>
                              <p className="mt-2 text-sm font-semibold text-slate-950">
                                {formatDate(recoveryProposal.deadline)}
                              </p>
                              <p className="mt-1 text-xs text-slate-500">
                                {recoveryProposalUi?.deadlineSummary
                                  ? recoveryProposalUi.deadlineSummary
                                  : recoveryDeadlinePassed
                                    ? 'Voting window expired'
                                    : `${formatRelativeDuration(recoveryProposal.deadline - now)} remaining`}
                              </p>
                            </div>
                          </div>

                          <div>
                            <div className="mb-2 flex items-center justify-between gap-3">
                              <p className="text-sm font-medium text-slate-700">Approval progress</p>
                              <p className="text-xs text-slate-500">
                                {recoveryProposal.yesVotes} / {recoveryProposal.majorityThreshold} yes votes
                              </p>
                            </div>
                            <div className="h-3 rounded-full bg-stone-200">
                              <div
                                className={`h-3 rounded-full transition-all duration-500 ${
                                  recoveryProposalPassed
                                    ? 'bg-emerald-500'
                                    : recoveryProposalFailed
                                      ? 'bg-red-500'
                                      : 'bg-amber-500'
                                }`}
                                style={{ width: `${recoveryVoteProgress}%` }}
                              />
                            </div>
                          </div>

                          <div className="flex flex-wrap items-center gap-2">
                            <span className={subtleTagClass}>Proposed by {shortenAddress(recoveryProposal.proposer)}</span>
                            {recoveryProposalPassed && (
                              <span className="inline-flex items-center rounded-full bg-emerald-100 px-3 py-1 text-xs font-medium text-emerald-800">
                                <CheckCircle className="mr-1.5 h-3.5 w-3.5" />
                                Majority reached
                              </span>
                            )}
                            {recoveryProposalFailed && (
                              <span className="inline-flex items-center rounded-full bg-red-100 px-3 py-1 text-xs font-medium text-red-800">
                                <AlertTriangle className="mr-1.5 h-3.5 w-3.5" />
                                Proposal failed
                              </span>
                            )}
                            {currentUserVote && (
                              <span className="inline-flex items-center rounded-full bg-sky-100 px-3 py-1 text-xs font-medium text-sky-800">
                                You voted {currentUserVote.approved ? 'yes' : 'no'}
                              </span>
                            )}
                          </div>

                          {recoveryProposalUi?.resultBannerTone && (
                            <div className={`rounded-[18px] border p-4 ${
                              recoveryProposalUi.resultBannerTone === 'success'
                                ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
                                : 'border-red-200 bg-red-50 text-red-900'
                            }`}>
                              <p className="text-sm font-medium">
                                {recoveryProposalUi.resultBannerTitle}
                              </p>
                              <p className="mt-2 text-sm leading-6">
                                {recoveryProposalUi.resultBannerMessage}
                              </p>
                            </div>
                          )}

                          {canCurrentUserVote && (
                            <div className="rounded-[18px] border border-stone-200 bg-white p-4">
                              <p className="text-sm font-medium text-slate-900">Your vote</p>
                              <p className="mt-1 text-sm text-slate-500">
                                Each eligible member must submit their own onchain vote. Your vote cannot be changed after it is recorded.
                              </p>
                              <div className="mt-4 flex flex-wrap gap-3">
                                <button
                                  type="button"
                                  onClick={() => handleVoteEmergencyStop(true)}
                                  disabled={isSubmittingRecoveryAction}
                                  className={warningActionClass}
                                >
                                  Vote Yes
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleVoteEmergencyStop(false)}
                                  disabled={isSubmittingRecoveryAction}
                                  className={secondaryActionClass}
                                >
                                  Vote No
                                </button>
                              </div>
                            </div>
                          )}

                          {!canCurrentUserVote && (
                            <div className={`rounded-[18px] border p-4 text-sm leading-6 ${
                              recoveryProposalUi?.closedVoteTone === 'success'
                                ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
                                : recoveryProposalUi?.closedVoteTone === 'danger'
                                  ? 'border-red-200 bg-red-50 text-red-900'
                                  : 'border-stone-200 bg-white text-slate-600'
                            }`}>
                              {recoveryProposalUi?.closedVoteMessage}
                            </div>
                          )}

                          {canExecuteRecovery && (
                            <div className="rounded-[18px] border border-red-200 bg-red-50 p-4">
                              <p className="text-sm font-medium text-red-900">Execute recovery</p>
                              <p className="mt-1 text-sm leading-6 text-red-800">
                                Majority approval is locked in. Executing recovery will halt the circle and return all
                                tracked funds from custody to their recorded owners.
                              </p>
                              <button
                                type="button"
                                onClick={handleExecuteRecovery}
                                // Also gated on the custody wallet having
                                // resolved: the handler builds the refund
                                // transaction against it and bails without it.
                                // An enabled button that always bails is how
                                // this failure hid — the click "worked" and
                                // nothing happened.
                                disabled={
                                  isSubmittingRecoveryAction ||
                                  loadingRecoveryExecution ||
                                  !circle?.custody?.walletId
                                }
                                className={`${dangerActionClass} mt-4`}
                              >
                                <AlertTriangle className="mr-2 h-4 w-4" />
                                {isSubmittingRecoveryAction ? 'Executing...' : 'Execute Emergency Stop'}
                              </button>
                              {!circle?.custody?.walletId && (
                                <p className="mt-2 text-xs text-red-700/80">
                                  Waiting for the circle&rsquo;s custody wallet to resolve —
                                  the refund transaction is built against it. Refresh if this
                                  persists.
                                </p>
                              )}
                            </div>
                          )}

                          {recoveryProposal.votes.length > 0 && (
                            <div className={tableCardClass}>
                              <div className="border-b border-stone-200 px-4 py-3 sm:px-5">
                                <p className="text-sm font-medium text-slate-900">Recorded votes</p>
                              </div>
                              <div className="divide-y divide-stone-200">
                                {recoveryProposal.votes
                                  .slice()
                                  .sort((left, right) => right.votedAt - left.votedAt)
                                  .slice(0, 6)
                                  .map((vote) => (
                                    <div key={`${vote.voter}-${vote.votedAt}`} className="flex items-center justify-between gap-3 px-4 py-3 sm:px-5">
                                      <div>
                                        <p className="font-mono text-sm font-medium text-slate-950">{shortenAddress(vote.voter)}</p>
                                        <p className="mt-1 text-xs text-slate-500">{formatDate(vote.votedAt)}</p>
                                      </div>
                                      <span className={`inline-flex rounded-full px-3 py-1 text-xs font-medium ${
                                        vote.approved ? 'bg-emerald-100 text-emerald-800' : 'bg-stone-100 text-slate-700'
                                      }`}>
                                        {vote.approved ? 'Approved' : 'Rejected'}
                                      </span>
                                    </div>
                                  ))}
                              </div>
                            </div>
                          )}
                        </div>
                      ) : (
                        <div className="mt-5 rounded-[18px] border border-stone-200 bg-white p-4 text-sm leading-6 text-slate-600">
                          No proposal is active. The admin can create one when the circle needs to be halted and refunded.
                        </div>
                      )}
                    </div>

                    <div className={panelCardClass}>
                      <p className={sectionEyebrowClass}>Admin liveness fallback</p>
                      <h4 className="mt-2 text-lg font-semibold text-slate-950">
                        {recoveryStatus?.autoReleaseEnabled ? 'Heartbeat-based recovery enabled' : 'Auto-release disabled'}
                      </h4>
                      <p className="mt-2 text-sm leading-6 text-slate-500">
                        The heartbeat timer refreshes whenever you sign meaningful circle actions. If it expires, the
                        designated next in command gets 24 hours of exclusive recovery authority before eligible active
                        non-admin members can step in.
                      </p>

                      <div className="mt-5 grid gap-3 sm:grid-cols-2">
                        <div className={mutedPanelClass}>
                          <p className={sectionEyebrowClass}>Last admin heartbeat</p>
                          <p className="mt-2 text-sm font-semibold text-slate-950">
                            {recoveryStatus?.autoReleaseEnabled ? formatDate(recoveryStatus.lastAdminHeartbeatAt) : 'Not configured'}
                          </p>
                          <p className="mt-1 text-xs text-slate-500">
                            {recoveryStatus?.autoReleaseEnabled
                              ? autoReleaseReady
                                ? 'The configured liveness window has expired.'
                                : `${formatRelativeDuration(autoReleaseRemainingMs)} until expiry`
                              : 'This circle does not have an admin-liveness timer.'}
                          </p>
                        </div>
                        <div className={mutedPanelClass}>
                          <p className={sectionEyebrowClass}>Delegate window starts</p>
                          <p className="mt-2 text-sm font-semibold text-slate-950">
                            {recoveryStatus?.autoReleaseTriggerTime ? formatDate(recoveryStatus.autoReleaseTriggerTime) : 'Not configured'}
                          </p>
                          <p className="mt-1 text-xs text-slate-500">
                            {recoveryStatus?.autoReleaseEnabled
                              ? autoReleaseReady
                                ? 'The delegate-exclusive recovery window is now open onchain.'
                                : `${formatRelativeDuration(autoReleaseRemainingMs)} remaining`
                              : 'This fallback was not configured for the circle.'}
                          </p>
                        </div>
                        <div className={mutedPanelClass}>
                          <p className={sectionEyebrowClass}>Trigger authority</p>
                          <p className="mt-2 text-sm font-semibold text-slate-950">
                            {delegateCopy.authorityModeLabel}
                          </p>
                          <p className="mt-1 text-xs text-slate-500">
                            {autoReleaseUi.delegateStatus === 'valid'
                              ? autoReleaseUi.memberFallbackReady
                                ? `Eligible active members can now trigger. The delegate-exclusive window ended ${autoReleaseUi.memberFallbackUnlockTime ? formatDate(autoReleaseUi.memberFallbackUnlockTime) : 'recently'}.`
                                : `Next in command ${shortenAddress(autoReleaseUi.validDelegate || '')} has exclusive trigger rights until ${autoReleaseUi.memberFallbackUnlockTime ? formatDate(autoReleaseUi.memberFallbackUnlockTime) : 'the 24-hour grace deadline'}.`
                              : autoReleaseUi.delegateStatus === 'invalid'
                                ? 'The configured delegate is no longer an eligible active member, so active members become the fallback as soon as the heartbeat expires.'
                                : delegateCopy.authorityModeHint}
                          </p>
                        </div>
                        <div className={mutedPanelClass}>
                          <p className={sectionEyebrowClass}>Your role</p>
                          <p className="mt-2 text-sm font-semibold text-slate-950">Admin heartbeat owner</p>
                          <p className="mt-1 text-xs text-slate-500">
                            Admins refresh the timer through signed circle actions, but admins cannot use the
                            auto-release trigger themselves.
                          </p>
                        </div>
                      </div>

                      <div className="mt-5 space-y-3">
                        <div className={`rounded-[18px] border p-4 text-sm ${
                          autoReleaseReady
                            ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
                            : 'border-stone-200 bg-white text-slate-600'
                        }`}>
                          <p className="font-medium">
                            {autoReleaseReady ? 'Heartbeat window expired.' : 'Heartbeat is still healthy.'}
                          </p>
                          <p className="mt-2 leading-6">
                            {recoveryStatus?.rawState === 2 || recoveryStatus?.rawState === 3
                                ? 'This circle is already in a terminal recovery state.'
                                : recoveryProposalPassed
                                ? 'Majority approval already exists. You can execute vote-based recovery, while the fallback path still follows the delegate-first 24-hour grace window if the heartbeat expires.'
                                : autoReleaseReady
                                  ? autoReleaseUi.delegateStatus === 'valid' && !autoReleaseUi.memberFallbackReady
                                    ? 'If you remain unavailable, the designated delegate now has 24 hours of exclusive authority to trigger the stop-and-refund path before eligible active members inherit fallback rights.'
                                    : 'If you remain unavailable, eligible active members can now trigger the stop-and-refund path without waiting for a vote.'
                                  : 'Your next signed admin action will refresh this timer. If you go missing, the delegate window opens automatically when the expiry timestamp is reached.'}
                          </p>
                        </div>

                        <div className="rounded-[18px] border border-stone-200 bg-white p-4">
                          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                            <div>
                              <p className={sectionEyebrowClass}>Next in command</p>
                              <p className="mt-2 text-sm font-semibold text-slate-950">
                                {autoReleaseUi.configuredDelegate
                                  ? shortenAddress(autoReleaseUi.configuredDelegate)
                                  : delegateCopy.delegateValueFallback}
                              </p>
                              <p className="mt-1 text-xs text-slate-500">
                                {recoveryDelegateFormDisabledReason
                                  ? recoveryDelegateFormDisabledReason
                                  : autoReleaseUi.delegateStatus === 'valid'
                                    ? 'This wallet gets a 24-hour exclusive response window after heartbeat expiry before member fallback opens.'
                                    : autoReleaseUi.delegateStatus === 'invalid'
                                      ? 'This wallet is configured but is no longer an eligible active member.'
                                      : circle?.isActive
                                        ? 'Active auto-release circles must keep a valid next-in-command wallet configured.'
                                        : 'Set a valid next-in-command before activating the circle.'}
                              </p>
                            </div>
                            {!isEditingRecoveryDelegate && (
                              <button
                                type="button"
                                onClick={() => setIsEditingRecoveryDelegate(true)}
                                disabled={!canManageRecoveryDelegate || isUpdatingRecoveryDelegate}
                                className={secondaryActionClass}
                              >
                                <Edit3 className="mr-2 h-4 w-4" />
                                {autoReleaseUi.configuredDelegate ? 'Edit Delegate' : 'Set Delegate'}
                              </button>
                            )}
                          </div>

                          {isEditingRecoveryDelegate ? (
                            <div className="mt-4 space-y-3">
                              <div>
                                <label
                                  htmlFor="manage-recovery-delegate"
                                  className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500"
                                >
                                  Delegate wallet
                                </label>
                                <select
                                  id="manage-recovery-delegate"
                                  value={recoveryDelegateDraft}
                                  onChange={(event) => setRecoveryDelegateDraft(event.target.value)}
                                  disabled={!canManageRecoveryDelegate || isUpdatingRecoveryDelegate}
                                  className="mt-2 w-full rounded-[18px] border border-stone-300 bg-white px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-stone-400 focus:ring-2 focus:ring-stone-200 disabled:cursor-not-allowed disabled:bg-stone-100 disabled:text-stone-400"
                                >
                                  <option value="">
                                    {eligibleRecoveryDelegateMembers.length > 0
                                      ? 'Select an active member wallet'
                                      : 'No eligible member wallets yet'}
                                  </option>
                                  {showIneligibleRecoveryDelegateOption && normalizedRecoveryDelegateDraft && (
                                    <option value={normalizedRecoveryDelegateDraft}>
                                      {`Currently configured (not eligible): ${normalizedRecoveryDelegateDraft}`}
                                    </option>
                                  )}
                                  {eligibleRecoveryDelegateMembers.map((member) => (
                                    <option key={member.address} value={member.address}>
                                      {member.address}
                                    </option>
                                  ))}
                                </select>
                                <p className={`mt-2 text-xs ${
                                  recoveryDelegateValidationError ? 'text-red-600' : 'text-slate-500'
                                }`}>
                                  {recoveryDelegateValidationError
                                    ? recoveryDelegateValidationError
                                    : normalizedRecoveryDelegateDraft
                                      ? recoveryDelegateDraftIsEligibleMember
                                        ? `Selected member wallet: ${normalizedRecoveryDelegateDraft}`
                                        : `Currently configured wallet: ${normalizedRecoveryDelegateDraft}`
                                      : circle?.isActive
                                        ? 'Required: active auto-release circles must keep a valid next-in-command wallet configured.'
                                        : delegateCopy.formHint}
                                </p>
                              </div>

                              <div className="flex flex-wrap gap-2">
                                <button
                                  type="button"
                                  onClick={handleUpdateRecoveryDelegate}
                                  disabled={
                                    !canManageRecoveryDelegate
                                    || isUpdatingRecoveryDelegate
                                    || Boolean(recoveryDelegateValidationError)
                                    || !hasRecoveryDelegateDraftChanges
                                  }
                                  className={primaryActionClass}
                                >
                                  {isUpdatingRecoveryDelegate ? 'Saving...' : 'Save Delegate'}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setIsEditingRecoveryDelegate(false);
                                    setRecoveryDelegateDraft(recoveryStatus?.nextInCommand ?? '');
                                  }}
                                  disabled={isUpdatingRecoveryDelegate}
                                  className={secondaryActionClass}
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                          ) : (
                            <div className="mt-4 rounded-[18px] border border-stone-200 bg-stone-50/80 p-4 text-sm text-slate-600">
                              <p className="font-medium text-slate-900">
                                {delegateCopy.summaryTitle}
                              </p>
                              <p className="mt-2 leading-6">
                                {autoReleaseUi.configuredDelegate
                                  ? autoReleaseUi.delegateStatus === 'valid'
                                    ? 'If your heartbeat expires, this wallet gets a 24-hour exclusive recovery window before eligible active members can trigger.'
                                    : 'Because this delegate is no longer eligible, active non-admin members will become the fallback once the heartbeat expires.'
                                  : delegateCopy.summaryBody}
                              </p>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>

                  {(recoveryExecutionStarted || recoveryStatus?.rawState === 3) && (
                    <div className={`${panelCardClass} mt-4`}>
                      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                        <div>
                          <p className={sectionEyebrowClass}>Execution</p>
                          <h4 className="mt-2 text-lg font-semibold text-slate-950">Refund progress</h4>
                          <p className="mt-2 text-sm leading-6 text-slate-500">
                            Recovery execution emits one event per refunded member plus a completion summary when the
                            unwind finishes.
                          </p>
                        </div>
                        <span className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium ${
                          recoveryExecutionCompleted
                            ? 'bg-emerald-100 text-emerald-800'
                            : 'bg-amber-100 text-amber-800'
                        }`}>
                          {loadingRecoveryExecution
                            ? 'Refreshing execution...'
                            : recoveryExecutionCompleted
                              ? 'Completed'
                              : 'In progress'}
                        </span>
                      </div>

                      {recoveryExecution ? (
                        <>
                          <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                            <div className={mutedPanelClass}>
                              <p className={sectionEyebrowClass}>Started</p>
                              <p className="mt-2 text-sm font-semibold text-slate-950">
                                {formatDate(recoveryExecution.startedAt)}
                              </p>
                              <p className="mt-1 text-xs text-slate-500">
                                by {shortenAddress(recoveryExecution.executor)}
                              </p>
                            </div>
                            <div className={mutedPanelClass}>
                              <p className={sectionEyebrowClass}>Path</p>
                              <p className="mt-2 text-sm font-semibold text-slate-950">
                                {recoveryExecution.usedAutoRelease ? 'Auto-release fallback' : 'Member-vote execution'}
                              </p>
                              <p className="mt-1 text-xs text-slate-500">
                                {recoveryExecutionCompleted ? 'Execution finalized onchain' : 'Awaiting completion signal'}
                              </p>
                            </div>
                            <div className={mutedPanelClass}>
                              <p className={sectionEyebrowClass}>Members refunded</p>
                              <p className="mt-2 text-2xl font-semibold text-slate-950">
                                {recoveryExecution.refundedMembers} / {recoveryExecution.totalMembers}
                              </p>
                              <p className="mt-1 text-xs text-slate-500">Members with non-zero refunds processed</p>
                            </div>
                            <div className={mutedPanelClass}>
                              <p className={sectionEyebrowClass}>Completed</p>
                              <p className="mt-2 text-sm font-semibold text-slate-950">
                                {recoveryExecution.completedAt ? formatDate(recoveryExecution.completedAt) : 'Pending'}
                              </p>
                              <p className="mt-1 text-xs text-slate-500">
                                {recoveryStatus?.stateLabel || 'Recovery state unavailable'}
                              </p>
                            </div>
                          </div>

                          <div className="mt-5">
                            <div className="mb-2 flex items-center justify-between gap-3">
                              <p className="text-sm font-medium text-slate-700">Execution progress</p>
                              <p className="text-xs text-slate-500">
                                {recoveryExecution.refundedMembers} / {Math.max(recoveryExecution.totalMembers, 1)} members
                              </p>
                            </div>
                            <div className="h-3 rounded-full bg-stone-200">
                              <div
                                className={`h-3 rounded-full transition-all duration-500 ${
                                  recoveryExecutionCompleted ? 'bg-emerald-500' : 'bg-amber-500'
                                }`}
                                style={{ width: `${recoveryExecutionProgress}%` }}
                              />
                            </div>
                          </div>

                          <div className="mt-5 grid gap-3 sm:grid-cols-2">
                            <div className={mutedPanelClass}>
                              <p className={sectionEyebrowClass}>Total SUI refund</p>
                              <p className="mt-2 text-sm font-semibold text-slate-950">
                                {formatRecoveryAssetAmount(recoveryExecution.totalSuiRefundRaw, 9, 'SUI')}
                              </p>
                            </div>
                            <div className={mutedPanelClass}>
                              <p className={sectionEyebrowClass}>Total stablecoin refund</p>
                              <p className="mt-2 text-sm font-semibold text-slate-950">
                                {formatRecoveryAssetAmount(
                                  recoveryExecution.totalStablecoinRefundRaw,
                                  recoveryStablecoinMeta.decimals,
                                  recoveryStablecoinMeta.label,
                                )}
                              </p>
                            </div>
                          </div>

                          <RecoveryRefundTable
                            refunds={recoveryExecution.memberRefunds}
                            formatDate={formatDate}
                            formatSuiAmount={(rawAmount) => formatRecoveryAssetAmount(rawAmount, 9, 'SUI')}
                            formatStablecoinAmount={(rawAmount) =>
                              formatRecoveryAssetAmount(
                                rawAmount,
                                recoveryStablecoinMeta.decimals,
                                recoveryStablecoinMeta.label,
                              )
                            }
                            title="Recent refund events"
                            emptyMessage="No member refund events have been emitted yet."
                            maxItems={6}
                            className="mt-5"
                          />
                        </>
                      ) : (
                        <div className="mt-5 rounded-[18px] border border-stone-200 bg-white p-4 text-sm leading-6 text-slate-600">
                          The circle is in a terminal recovery state. Event details have not been loaded yet from the
                          current RPC response.
                        </div>
                      )}
                    </div>
                  )}
                </div>
                
                {/* Members Management */}
                <div className={sectionCardClass} ref={(element) => setManageSectionRef('members', element)}>
                  <div className="mb-5 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                    <div>
                      <p className={sectionEyebrowClass}>Roster</p>
                      <h3 className={`${sectionTitleClass} mt-2`}>Members</h3>
                      {!circle.isActive && paidDepositMembers.length > 0 && (
                        <p className="mt-2 text-sm leading-6 text-slate-500">
                          Use member-level actions for individual cases, or manage deposits above for a batch return.
                        </p>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {circle && circle.isActive && contributionStatus.currentCycle > 0 && (
                        <div className="rounded-full border border-stone-200 bg-stone-50 px-4 py-2">
                          <p className="mb-1 text-[11px] font-medium uppercase tracking-[0.18em] text-slate-500">
                            Contribution Progress (Cycle {contributionStatus.currentCycle})
                          </p>
                          <div className="flex items-center gap-2">
                            <div className="h-2.5 w-32 rounded-full bg-stone-200">
                              <div
                                className="h-2.5 rounded-full bg-slate-900"
                                style={{ width: `${contributionStatus.totalActiveInRotation > 0 
                                  ? (
                                      (() => {
                                        const recipient = contributionStatus.currentPosition !== null && contributionStatus.currentPosition !== undefined ? contributionStatus.activeMembersInRotation[contributionStatus.currentPosition] : null;
                                        const expected = recipient ? Math.max(0, contributionStatus.totalActiveInRotation -1) : contributionStatus.totalActiveInRotation;
                                        let validContributed = 0;
                                        contributionStatus.contributedMembers.forEach(cm => {
                                          if (cm !== recipient) validContributed++;
                                        });
                                        return expected > 0 ? (validContributed / expected) * 100 : 0;
                                      })()
                                    ) 
                                  : 0}%` }}
                              ></div>
                            </div>
                            <span className="text-xs font-medium text-slate-700">
                              {(() => {
                                const recipient = contributionStatus.currentPosition !== null && contributionStatus.currentPosition !== undefined ? contributionStatus.activeMembersInRotation[contributionStatus.currentPosition] : null;
                                let validContributed = 0;
                                contributionStatus.contributedMembers.forEach(cm => {
                                  if (cm !== recipient) validContributed++;
                                });
                                const expected = recipient ? Math.max(0, contributionStatus.totalActiveInRotation - 1) : contributionStatus.totalActiveInRotation;
                                return `${validContributed}/${expected}`;
                              })()}
                            </span>
                            {allContributionsMadeThisCycle && (
                              <div className="flex items-center rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800">
                                <CheckCircle size={12} className="mr-1" />
                                Complete
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                      {!isEditingRotation && (
                        <Tooltip.Provider>
                          <Tooltip.Root>
                            <Tooltip.Trigger asChild>
                              <div>
                                <button
                                  onClick={() => setIsEditingRotation(true)}
                                  className={`inline-flex items-center justify-center rounded-full px-4 py-2 text-xs font-medium transition ${
                                      circle?.isActive && !circle?.paused 
                                      ? 'cursor-not-allowed border border-stone-200 bg-stone-100 text-stone-400'
                                      : 'border border-stone-300 bg-white text-slate-700 hover:border-stone-400 hover:bg-stone-50'
                                  }`}
                                  disabled={circle?.isActive && !circle?.paused}
                                >
                                  <ListOrdered size={16} className="mr-1.5" />
                                  Edit Rotation Order
                                </button>
                              </div>
                            </Tooltip.Trigger>
                            {(circle?.isActive && !circle?.paused) && (
                              <Tooltip.Portal>
                                <Tooltip.Content
                                  className="bg-gray-800 text-white px-3 py-2 rounded text-xs max-w-xs"
                                  sideOffset={5}
                                >
                                  <p>Rotation order cannot be modified while the circle is active.</p>
                                  <p className="mt-1 text-gray-300">
                                    The order can only be edited before activation or when the circle is paused between cycles.
                                  </p>
                                  <Tooltip.Arrow className="fill-gray-800" />
                                </Tooltip.Content>
                              </Tooltip.Portal>
                            )}
                            {(circle?.paused) && (
                              <Tooltip.Portal>
                                <Tooltip.Content
                                  className="bg-gray-800 text-white px-3 py-2 rounded text-xs max-w-xs"
                                  sideOffset={5}
                                >
                                  <p>You can now edit the rotation order for the next cycle.</p>
                                  <p className="mt-1 text-gray-300">
                                    After you finish editing, click Resume Cycle to continue to the next cycle with the new order.
                                  </p>
                                  <Tooltip.Arrow className="fill-gray-800" />
                                </Tooltip.Content>
                              </Tooltip.Portal>
                            )}
                          </Tooltip.Root>
                        </Tooltip.Provider>
                      )}
                    </div>
                  </div>
                  
                  {/* Add warning message for rotation order when not in edit mode */}
                  {!isEditingRotation && !isRotationOrderSet(members) && (
                    <div className="mb-4 rounded-[18px] border border-amber-200 bg-amber-50/80 p-3 text-amber-900">
                      <p className="font-medium flex items-center text-sm">
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 mr-2" viewBox="0 0 20 20" fill="currentColor">
                          <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
                        </svg>
                        Warning: Rotation order is not properly set
                      </p>
                      <p className="text-xs mt-1">You must set the rotation order for all members before activating the circle. Click &quot;Edit Rotation Order&quot; to fix this issue.</p>
                    </div>
                  )}
                  
                  {isEditingRotation ? (
                    <div>
                      {!isRotationOrderSet(members) && (
                        <div className="mb-4 rounded-[18px] border border-amber-200 bg-amber-50/80 p-3 text-amber-900">
                          <p className="font-medium flex items-center text-sm">
                            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 mr-2" viewBox="0 0 20 20" fill="currentColor">
                              <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
                            </svg>
                            Setting rotation order is required before circle activation
                          </p>
                          <p className="text-xs mt-1">The rotation order determines who receives payouts in which order.</p>
                        </div>
                      )}
                      <RotationOrderList 
                        members={members}
                        adminAddress={circle.admin}
                        currentUserAddress={userAddress || ''}
                        shortenAddress={shortenAddress}
                        onSaveOrder={saveRotationOrder}
                        onCancelEdit={() => setIsEditingRotation(false)}
                      />
                    </div>
                  ) : (
                    <>
                    <div className="space-y-3 md:hidden">
                      {members.map((member) => {
                        const contributionState = getMemberContributionState(member);
                        const memberManagementAction = getMemberManagementAction(member);

                        return (
                          <div
                            key={member.address}
                            className="rounded-[22px] border border-stone-200 bg-white p-3 sm:p-4 shadow-[0_12px_30px_-24px_rgba(15,23,42,0.24)]"
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-2">
                                  <p className="font-mono text-sm font-medium text-slate-950">
                                    {shortenAddress(member.address)}
                                  </p>
                                  {member.address === circle?.admin && (
                                    <span className="inline-flex rounded-full bg-violet-100 px-2 py-0.5 text-xs font-medium text-violet-700">
                                      Admin
                                    </span>
                                  )}
                                </div>
                                <p className="mt-1 text-xs text-slate-500">
                                  Joined {member.joinDate ? formatDate(member.joinDate) : 'Unknown'}
                                </p>
                              </div>

                              <div className="flex h-9 min-w-[2.25rem] items-center justify-center rounded-full bg-slate-950 px-3 text-sm font-semibold text-white">
                                {member.position !== undefined ? member.position + 1 : '?'}
                              </div>
                            </div>

                            <div className="mt-3 flex flex-wrap gap-2">
                              <span className={`inline-flex rounded-full px-3 py-1 text-xs font-medium ${
                                member.status === 'active'
                                  ? 'bg-emerald-100 text-emerald-800'
                                  : member.status === 'suspended'
                                    ? 'bg-amber-100 text-amber-800'
                                    : 'bg-red-100 text-red-800'
                              }`}>
                                {member.status.charAt(0).toUpperCase() + member.status.slice(1)}
                              </span>
                              <span className={`inline-flex rounded-full px-3 py-1 text-xs font-medium ${
                                member.depositPaid
                                  ? 'bg-emerald-100 text-emerald-800'
                                  : 'bg-amber-100 text-amber-800'
                              }`}>
                                {member.depositPaid ? 'Deposit paid' : 'Deposit pending'}
                              </span>
                              <span className={`inline-flex rounded-full border px-3 py-1 text-xs font-medium ${getContributionToneClasses(contributionState.tone)}`}>
                                {contributionState.label}
                              </span>
                            </div>

                            <div className="mt-4 grid grid-cols-2 gap-2">
                              <button
                                type="button"
                                onClick={() => setSelectedMobileMember(member)}
                                className={secondaryActionClass}
                              >
                                Details
                              </button>
                              {memberManagementAction ? (
                                <button
                                  type="button"
                                  onClick={memberManagementAction.onClick}
                                  disabled={memberManagementAction.isDisabled}
                                  className={`inline-flex items-center justify-center rounded-full border px-4 py-2.5 text-sm font-medium transition ${
                                    memberManagementAction.isDisabled
                                      ? 'cursor-not-allowed border-stone-200 bg-stone-100 text-stone-400'
                                      : 'border-stone-300 bg-white text-slate-700 hover:border-stone-400 hover:bg-stone-50'
                                  }`}
                                >
                                  {memberManagementAction.buttonText}
                                </button>
                              ) : (
                                <div className="inline-flex items-center justify-center rounded-full border border-stone-200 bg-stone-50 px-4 py-2.5 text-sm font-medium text-slate-400">
                                  No action
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    <div className="hidden overflow-x-auto -mx-4 md:block sm:mx-0">
                      <div className="inline-block min-w-full align-middle">
                        <div className={tableCardClass}>
                          <table className="min-w-full divide-y divide-stone-200">
                            <thead className="bg-stone-50/80">
                              <tr>
                                <th scope="col" className="py-3.5 pl-4 pr-3 text-left text-xs font-semibold text-slate-900 sm:pl-6 sm:text-sm">
                                  Address
                                </th>
                                <th scope="col" className="hidden px-3 py-3.5 text-left text-xs font-semibold text-slate-900 sm:table-cell sm:text-sm">
                                  Status
                                </th>
                                <th scope="col" className="px-3 py-3.5 text-left text-xs font-semibold text-slate-900 sm:text-sm">
                                  Deposit
                                </th>
                                {circle && circle.isActive && contributionStatus.currentCycle > 0 && (
                                  <th scope="col" className="px-3 py-3.5 text-left text-xs font-semibold text-slate-900 sm:text-sm">
                                    Contribution
                                  </th>
                                )}
                                <th scope="col" className="hidden px-3 py-3.5 text-left text-xs font-semibold text-slate-900 sm:table-cell sm:text-sm">
                                  Joined
                                </th>
                                <th scope="col" className="px-3 py-3.5 text-left text-xs font-semibold text-slate-900 sm:text-sm">
                                  Position
                                </th>
                                <th scope="col" className="py-3.5 pl-3 pr-4 text-right text-xs font-semibold text-slate-900 sm:pr-6 sm:text-sm">
                                  Actions
                                </th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-stone-200 bg-white">
                              {members.map((member) => {
                                const isRecipientThisCycle = contributionStatus.currentPosition !== null &&
                                                             contributionStatus.currentPosition !== undefined &&
                                                             contributionStatus.activeMembersInRotation[contributionStatus.currentPosition] === member.address &&
                                                             contributionStatus.currentCycle > 0;
                                const memberManagementAction = getMemberManagementAction(member);

                                return (
                                  <tr key={member.address} className="transition-colors hover:bg-stone-50/70">
                                    <td className="whitespace-nowrap py-3 pl-4 pr-3 text-xs font-medium text-slate-900 sm:pl-6 sm:text-sm">
                                      <span className="flex flex-col">
                                        <span className="flex flex-col sm:flex-row sm:items-center">
                                          <span className="font-mono text-xs truncate max-w-[100px] sm:max-w-none">{shortenAddress(member.address)}</span>
                                          {member.address === circle?.admin && (
                                            <span className="ml-0 mt-1 inline-block rounded-full bg-violet-100 px-2 py-0.5 text-xs text-violet-700 sm:ml-2 sm:mt-0">Admin</span>
                                          )}
                                        </span>
                                        {member.memberObjectId && (
                                          <button
                                            type="button"
                                            onClick={() => {
                                              if (!member.memberObjectId) {
                                                return;
                                              }
                                              void copyPlainText(member.memberObjectId, 'Member contract address copied to clipboard!');
                                            }}
                                            className="mt-1 inline-flex items-center gap-1 text-[11px] font-medium text-slate-500 transition hover:text-slate-900"
                                          >
                                            <Copy className="h-3.5 w-3.5" />
                                            <span className="font-mono">{`Contract ${shortenId(member.memberObjectId)}`}</span>
                                          </button>
                                        )}
                                      </span>
                                    </td>
                                    <td className="hidden whitespace-nowrap px-3 py-3 text-xs sm:table-cell">
                                      <span className={`inline-flex rounded-full px-2 py-1 text-xs font-semibold ${
                                        member.status === 'active' ? 'bg-emerald-100 text-emerald-800' :
                                        member.status === 'suspended' ? 'bg-amber-100 text-amber-800' : 'bg-red-100 text-red-800'
                                      }`}>
                                        {member.status.charAt(0).toUpperCase() + member.status.slice(1)}
                                      </span>
                                    </td>
                                    <td className="whitespace-nowrap px-3 py-3 text-xs">
                                      <Tooltip.Provider>
                                        <Tooltip.Root>
                                          <Tooltip.Trigger asChild>
                                            <span className={`inline-flex items-center rounded-full p-1 ${member.depositPaid ? 'bg-emerald-100' : 'bg-amber-100'}`}>
                                              {member.depositPaid ?
                                                <CheckCircle size={16} className="text-emerald-600" /> :
                                                <AlertTriangle size={16} className="text-amber-600" />
                                              }
                                            </span>
                                          </Tooltip.Trigger>
                                          <Tooltip.Portal>
                                            <Tooltip.Content
                                              className="bg-gray-800 text-white px-2 py-1 rounded text-xs"
                                              sideOffset={5}
                                            >
                                              {member.depositPaid ? 'Security Deposit Paid' : 'Security Deposit Pending'}
                                              <Tooltip.Arrow className="fill-gray-800" />
                                            </Tooltip.Content>
                                          </Tooltip.Portal>
                                        </Tooltip.Root>
                                      </Tooltip.Provider>
                                    </td>

                                    {circle && circle.isActive && contributionStatus.currentCycle > 0 && (
                                      <td className="whitespace-nowrap px-3 py-3 text-xs">
                                        <Tooltip.Provider>
                                          <Tooltip.Root>
                                            <Tooltip.Trigger asChild>
                                              <span className={`inline-flex items-center p-1 rounded-full ${
                                                isRecipientThisCycle
                                                  ? 'bg-sky-100'
                                                  : contributionStatus.contributedMembers.has(member.address)
                                                    ? 'bg-emerald-100'
                                                    : contributionStatus.activeMembersInRotation.includes(member.address)
                                                      ? 'bg-amber-100'
                                                      : 'bg-stone-100'
                                              }`}>
                                                {isRecipientThisCycle ? (
                                                  <Crown size={16} className="text-sky-600" />
                                                ) : contributionStatus.contributedMembers.has(member.address) ? (
                                                  <CheckCircle size={16} className="text-emerald-600" />
                                                ) : contributionStatus.activeMembersInRotation.includes(member.address) ? (
                                                  <AlertTriangle size={16} className="text-amber-600" />
                                                ) : (
                                                  <X size={16} className="text-stone-400" />
                                                )}
                                              </span>
                                            </Tooltip.Trigger>
                                            <Tooltip.Portal>
                                              <Tooltip.Content
                                                className="bg-gray-800 text-white px-2 py-1 rounded text-xs z-10"
                                                sideOffset={5}
                                              >
                                                {isRecipientThisCycle
                                                  ? `Receiving Payout (Cycle ${contributionStatus.currentCycle})`
                                                  : contributionStatus.contributedMembers.has(member.address)
                                                    ? `Contribution made for cycle ${contributionStatus.currentCycle}`
                                                    : contributionStatus.activeMembersInRotation.includes(member.address)
                                                      ? `Contribution pending for cycle ${contributionStatus.currentCycle}`
                                                      : 'Member not in active rotation or deposit not paid'
                                                }
                                                <Tooltip.Arrow className="fill-gray-800" />
                                              </Tooltip.Content>
                                            </Tooltip.Portal>
                                          </Tooltip.Root>
                                        </Tooltip.Provider>
                                      </td>
                                    )}

                                    <td className="hidden whitespace-nowrap px-3 py-3 text-xs text-slate-500 sm:table-cell">
                                      {member.joinDate ? formatDate(member.joinDate) : 'Unknown'}
                                    </td>
                                    <td className="whitespace-nowrap px-3 py-3 text-xs">
                                      <div className="flex items-center">
                                        {!isRotationOrderSet(members) ? (
                                          <div className="flex items-center">
                                            <div className="mr-2 flex h-6 w-6 items-center justify-center rounded-full bg-stone-100 text-stone-400 sm:h-8 sm:w-8">
                                              <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3 sm:h-4 sm:w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                                              </svg>
                                            </div>
                                            <span className="text-amber-600 text-xs">Not set</span>
                                          </div>
                                        ) : (
                                          <div className="flex items-center">
                                            <div className="mr-2 flex h-6 w-6 items-center justify-center rounded-full bg-stone-900 text-white sm:h-8 sm:w-8">
                                              {member.position !== undefined ? member.position + 1 : '?'}
                                            </div>
                                          </div>
                                        )}
                                      </div>
                                    </td>
                                    <td className="relative whitespace-nowrap py-3 pl-3 pr-4 text-right text-xs font-medium sm:pr-6">
                                      {memberManagementAction ? (
                                        <div className="flex flex-col items-end gap-1">
                                          <button
                                            onClick={memberManagementAction.onClick}
                                            disabled={memberManagementAction.isDisabled}
                                            title={memberManagementAction.helperText}
                                            className={`inline-flex items-center justify-center rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${
                                              memberManagementAction.isDisabled
                                                ? 'cursor-not-allowed border-slate-200 bg-slate-100 text-slate-400'
                                                : 'border-stone-300 bg-white text-slate-700 hover:border-stone-400 hover:bg-stone-50'
                                            }`}
                                          >
                                            {memberManagementAction.buttonText}
                                          </button>
                                          <span
                                            className={`hidden sm:block text-[11px] ${
                                              memberManagementAction.isDisabled ? 'text-slate-400' : 'text-slate-500'
                                            }`}
                                          >
                                            {memberManagementAction.helperText}
                                          </span>
                                        </div>
                                      ) : (
                                        <span className="text-xs text-slate-400">No action</span>
                                      )}
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    </div>
                    </>
                  )}
                </div>
                
                {/* Invite Members */}
                <div className={sectionCardClass} ref={(element) => setManageSectionRef('invite', element)}>
                  <p className={sectionEyebrowClass}>Invitations</p>
                  <h3 className={`${sectionTitleClass} mt-2`}>Invite New Members</h3>
                  <p className="mt-2 text-sm text-slate-500">
                    Send this link to anyone you want to bring into the circle.
                  </p>
                  
                  <div className="mt-5 flex flex-col items-center rounded-[24px] border border-stone-200 bg-stone-50/80 p-3 sm:flex-row sm:space-x-2 sm:space-y-0">
                    <input
                      type="text"
                      readOnly
                      value={`${window.location.origin}/circle/${circle.id}/join`}
                      className="flex-1 truncate border-0 bg-transparent p-2 text-xs text-slate-800 focus:ring-0 sm:text-sm"
                    />
                    <button
                      onClick={() => {
                        navigator.clipboard.writeText(`${window.location.origin}/circle/${circle.id}/join`);
                        toast.success('Invite link copied to clipboard');
                      }}
                      className={`${primaryActionClass} w-full px-4 py-2 sm:w-auto`}
                    >
                      <Copy className="w-4 h-4 mr-2" />
                      Copy
                    </button>
                  </div>
                </div>
                
                {/* Pending Join Requests Section */}
                {pendingRequests.length > 0 && (
                  <div className={sectionCardClass} ref={(element) => setManageSectionRef('approvals', element)}>
                    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                      <div>
                          <p className={sectionEyebrowClass}>Approvals</p>
                          <h3 className={`${sectionTitleClass} mt-2 flex items-center gap-2`}>
                            Pending Join Requests
                            <span className="inline-flex rounded-full bg-slate-900 px-2.5 py-0.5 text-xs font-medium text-white">
                              {pendingRequests.length}
                            </span>
                          </h3>
                          <p className="mt-2 text-sm text-slate-500">These users are waiting for admin approval.</p>
                      </div>
                        <button
                          onClick={handleBulkApprove}
                          disabled={isApproving || pendingRequests.length === 0}
                          className={`${successActionClass} px-4 py-2 ${
                            isApproving || pendingRequests.length === 0
                              ? 'bg-gray-400'
                              : ''
                          }`}
                        >
                          <Check className="w-3.5 h-3.5 sm:w-4 sm:h-4 mr-1" />
                          Approve All ({pendingRequests.length})
                        </button>
                    </div>
                      <div className="mt-5 space-y-3 md:hidden">
                        {pendingRequests.map((request) => (
                          <div
                            key={`${request.circle_id}-${request.user_address}`}
                            className="rounded-[22px] border border-stone-200 bg-white p-4 shadow-[0_12px_30px_-24px_rgba(15,23,42,0.24)]"
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <p className="text-sm font-semibold text-slate-950">
                                  {request.user_name || 'Unknown User'}
                                </p>
                                <p className="mt-1 font-mono text-xs text-slate-500">
                                  {shortenAddress(request.user_address)}
                                </p>
                              </div>
                              <span className="rounded-full border border-stone-200 bg-stone-50 px-3 py-1 text-xs font-medium text-slate-600">
                                {formatDate(request.created_at || new Date())}
                              </span>
                            </div>

                            <div className="mt-4 grid grid-cols-2 gap-2">
                              <button
                                onClick={() => handleJoinRequest(request, true)}
                                className={`${successActionClass} ${isApproving ? 'cursor-not-allowed opacity-50' : ''}`}
                                disabled={isApproving}
                              >
                                {isApproving ? (
                                  <svg className="animate-spin h-3 w-3 mr-1.5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                                  </svg>
                                ) : (
                                  <Check className="mr-1.5 h-3 w-3" />
                                )}
                                Approve
                              </button>
                              <button
                                onClick={() => handleJoinRequest(request, false)}
                                className={dangerActionClass}
                                disabled={isApproving}
                              >
                                <X className="mr-1.5 h-3 w-3" />
                                Reject
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>

                      <div className="mt-5 hidden overflow-x-auto -mx-3 md:block sm:mx-0">
                        <div className="inline-block min-w-full align-middle">
                          <div className={tableCardClass}>
                            <table className="min-w-full divide-y divide-stone-200">
                              <thead className="bg-stone-50/80">
                                <tr>
                                  <th scope="col" className="py-3 pl-4 pr-3 text-left text-xs font-semibold text-slate-900 sm:pl-6 sm:text-sm">
                                    User
                                  </th>
                                  <th scope="col" className="hidden px-3 py-3 text-left text-xs font-semibold text-slate-900 sm:table-cell sm:text-sm">
                                    Requested On
                                  </th>
                                  <th scope="col" className="relative py-3 pl-3 pr-4 sm:pr-6">
                                    <span className="sr-only">Actions</span>
                                  </th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-stone-200 bg-white">
                                {pendingRequests.map((request) => (
                                  <tr key={`${request.circle_id}-${request.user_address}`} className="transition-colors hover:bg-stone-50/70">
                                    <td className="px-4 sm:px-6 py-3 sm:py-4 whitespace-nowrap">
                                      <div className="flex flex-col sm:flex-row sm:items-center gap-1">
                                        <div className="text-xs font-medium text-slate-900 sm:text-sm">{request.user_name || 'Unknown User'}</div>
                                        <span className="font-mono text-xs text-slate-500">{shortenAddress(request.user_address)}</span>
                                      </div>
                                    </td>
                                    <td className="hidden whitespace-nowrap px-3 py-3 text-xs text-slate-500 sm:table-cell">
                                      {formatDate(request.created_at || new Date())}
                                    </td>
                                    <td className="relative whitespace-nowrap py-3 pl-3 pr-4 text-right text-xs font-medium sm:pr-6">
                                      <div className="flex justify-end space-x-2">
                                        <button
                                          onClick={() => handleJoinRequest(request, true)}
                                          className={`${successActionClass} px-3 py-2 text-xs ${isApproving ? 'cursor-not-allowed opacity-50' : ''}`}
                                          disabled={isApproving}
                                        >
                                          {isApproving ? (
                                            <svg className="animate-spin h-3 w-3 sm:h-4 sm:w-4 mr-1.5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                                              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                                            </svg>
                                          ) : (
                                            <Check className="w-3 h-3 sm:w-4 sm:h-4 mr-1.5" />
                                          )}
                                          <span className="hidden sm:inline">Approve</span>
                                        </button>
                                        <button
                                          onClick={() => handleJoinRequest(request, false)}
                                          className={`${dangerActionClass} px-3 py-2 text-xs`}
                                          disabled={isApproving}
                                        >
                                          <X className="w-3 h-3 sm:w-4 sm:h-4 mr-1.5" />
                                          <span className="hidden sm:inline">Reject</span>
                                        </button>
                                      </div>
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      </div>
                  </div>
                )}
                
                {/* Round Controls — admin-only "Open this round" + KYC gate */}
                {!loading && circle && typeof id === 'string' && userAddress && circle.admin === userAddress ? (
                  <div className={sectionCardClass}>
                    <div className="mb-5">
                      <p className={sectionEyebrowClass}>Operations</p>
                      <h3 className={`${sectionTitleClass} mt-2`}>Round controls</h3>
                      <p className="mt-2 text-sm leading-6 text-slate-500">
                        Open the next contribution round once the circle is active. Members
                        pay and collect on their own contribute page; this card is the
                        admin&rsquo;s lifecycle handle.
                      </p>
                    </div>
                    {!circle.isActive ? (
                      <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                        <p className="font-semibold">Circle is not active yet.</p>
                        <div className="mt-1 text-amber-800/90">
                          {getActivationRequirementMessage()}
                        </div>
                        <p className="mt-2 text-xs text-amber-800/70">
                          Use <span className="font-semibold">Activate Circle</span> in
                          the Circle Management section below once the conditions above
                          are met.
                        </p>
                      </div>
                    ) : null}
                    <CycleEscrowPanel
                      circleId={id}
                      network={getCurrentNetwork() as NetworkType}
                      circleName={circle.name}
                      isAdmin
                      memberNames={memberNameMap}
                      showAdminOpenButton
                      circleIsActive={circle.isActive && allDepositsPaid}
                      autoOpenWhenReady={autoOpenFirstRound}
                      onAutoOpenFired={() => setAutoOpenFirstRound(false)}
                      {...resolveCircleSettlementCoin(circle.autoSwapEnabled)}
                    />
                  </div>
                ) : null}

                {/* Already-running circles: record where the rotation stands
                    before activation, and collect every member's confirmation.
                    Hidden once the circle is live — the contract refuses these
                    calls then, because they move the payout pointer. */}
                {!circle.isActive ? (
                  <div className={sectionCardClass}>
                    <div className="mb-5">
                      <p className={sectionEyebrowClass}>Before you start</p>
                      <h3 className={`${sectionTitleClass} mt-2`}>Circle history</h3>
                      <p className="mt-2 text-sm leading-6 text-slate-500">
                        Moving a group that is already part-way through its rotation?
                        Record where it stands so it carries on from there instead of
                        starting over.
                      </p>
                    </div>
                    <CircleMigrationPanel
                      members={members}
                      adminAddress={circle.admin}
                      memberNames={memberNameMap}
                      shortenAddress={shortenAddress}
                      ratification={migrationRatification}
                      isBusy={isMigrationBusy || loading}
                      onDeclare={handleDeclareMigrationState}
                      onClear={handleClearMigrationState}
                    />
                  </div>
                ) : null}

                {/* Circle Management Actions */}
                <div className={sectionCardClass} ref={(element) => setManageSectionRef('actions', element)}>
                  <div className="mb-5">
                    <p className={sectionEyebrowClass}>Operations</p>
                    <h3 className={`${sectionTitleClass} mt-2`}>Circle Management</h3>
                    <p className="mt-2 text-sm leading-6 text-slate-500">
                      Core admin actions for activation, verification, payouts, and lifecycle control.
                    </p>
                  </div>
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
                    <Tooltip.Provider>
                      <Tooltip.Root>
                        <Tooltip.Trigger asChild>
                          <div>
                            <button
                              onClick={handleActivateCircle}
                              className={`w-full ${
                                !canActivate
                                  ? 'inline-flex cursor-not-allowed items-center justify-center rounded-full bg-stone-300 px-4 py-2.5 text-sm font-medium text-white/90'
                                  : successActionClass
                              }`}
                              disabled={!canActivate}
                            >
                              <Check className="w-3.5 h-3.5 sm:w-4 sm:h-4 mr-1.5" />
                              Activate Circle
                            </button>
                          </div>
                        </Tooltip.Trigger>
                        {circle && !canActivate && (
                          <Tooltip.Portal>
                            <Tooltip.Content
                              className="bg-gray-800 text-white px-3 py-2 rounded text-xs max-w-xs"
                              sideOffset={5}
                            >
                              {getActivationRequirementMessage()}
                              <p className="mt-1 text-gray-300">Current: {circle.currentMembers}/{circle.maxMembers} members</p>
                              <Tooltip.Arrow className="fill-gray-800" />
                            </Tooltip.Content>
                          </Tooltip.Portal>
                        )}
                      </Tooltip.Root>
                    </Tooltip.Provider>
                    
                  </div>
                </div>

                {/* Circle Token Routing Configuration */}
                <div className={sectionCardClass} ref={(element) => setManageSectionRef('tools', element)}>
                  {circle && <CircleRoutingSettings 
                    circle={circle} 
                    totalLocalDisplay={manageCustodyUsdcTotalLocalDisplay}
                    securityDepositLocalDisplay={manageCustodyUsdcSecurityDepositLocalDisplay}
                    contributionLocalDisplay={manageCustodyUsdcContributionLocalDisplay}
                  />}
                </div>

                {/* Smart Goals Section */}
                {circle && typeof id === 'string' && (
                  <div className={sectionCardClass}>
                    <MilestonesManageCard
                      circleId={id}
                      network={getCurrentNetwork() as NetworkType}
                      isAdmin={Boolean(userAddress && circle.admin === userAddress)}
                    />
                  </div>
                )}

                {/* WhatsApp Integration Section */}
                <div className={sectionCardClass}>
                  {circle && account && (
                    <WhatsAppCircleIntegration
                      circleId={id as string}
                      adminAddress={userAddress || ''}
                      account={account}
                      onLinked={(status) => {
                        if (status) {
                          toast.success('Circle linked to WhatsApp!');
                        }
                      }}
                    />
                  )}
                </div>

              </div>
            ) : (
              <div className="py-4 text-center">
                <p className="text-gray-500">Circle not found</p>
              </div>
            )}
          </div>
        </div>
      </main>

      <Dialog.Root open={isMobileOverviewSheetOpen} onOpenChange={setIsMobileOverviewSheetOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className={`${dialogOverlayClass} md:hidden`} />
          <Dialog.Content className={mobileSheetContentClass}>
            {circle && (
              <>
                <div className="flex justify-center pt-3">
                  <div className="h-1.5 w-12 rounded-full bg-stone-300" />
                </div>

                <div className="flex items-start justify-between gap-4 px-5 pb-4 pt-4">
                  <div className="min-w-0">
                    <Dialog.Title className="text-xl font-semibold tracking-tight text-slate-950">
                      Circle setup
                    </Dialog.Title>
                    <Dialog.Description className="mt-2 text-sm text-slate-500">
                      Review cadence, contribution settings, and capacity without keeping the full section open.
                    </Dialog.Description>
                  </div>

                  <Dialog.Close className={subtleIconButtonClass} aria-label="Close circle setup">
                    <X className="h-4 w-4" />
                  </Dialog.Close>
                </div>

                <div className={mobileSheetBodyClass}>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div className="rounded-[20px] border border-stone-200 bg-stone-50/80 p-4 sm:col-span-2">
                      <p className={sectionEyebrowClass}>Circle Name</p>
                      <p className="mt-2 text-lg font-semibold tracking-tight text-slate-950">{circle.name}</p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <span className={`inline-flex rounded-full px-3 py-1 text-xs font-medium ${
                          circleStatusLabel === 'Active'
                            ? 'bg-emerald-100 text-emerald-800'
                            : circleStatusLabel === 'Paused'
                              ? 'bg-amber-100 text-amber-800'
                              : 'bg-stone-100 text-slate-700'
                        }`}>
                          {circleStatusLabel}
                        </span>
                        <span className="inline-flex rounded-full border border-stone-200 bg-white px-3 py-1 text-xs font-medium text-slate-600">
                          {circle.currentMembers}/{circle.maxMembers} members
                        </span>
                      </div>
                    </div>

                    {circle.isActive && (
                      <div className="rounded-[20px] border border-stone-200 bg-white p-4 sm:col-span-2">
                        <div className="flex items-center justify-between gap-3">
                          <p className={sectionEyebrowClass}>Contribution Progress</p>
                          <button
                            type="button"
                            onClick={() => fetchContributionStatus()}
                            disabled={loadingContributions}
                            className="text-xs font-medium text-slate-600 transition hover:text-slate-950 disabled:text-stone-400"
                          >
                            {loadingContributions ? 'Refreshing...' : 'Refresh'}
                          </button>
                        </div>
                        <p className="mt-3 text-sm font-medium text-slate-700">
                          Cycle {contributionStatus.currentCycle || 0}
                        </p>
                        <div className="mt-3 h-2.5 w-full rounded-full bg-stone-200">
                          <div
                            className={`${allContributionsMadeThisCycle ? 'bg-emerald-500' : 'bg-slate-900'} h-2.5 rounded-full transition-all duration-500`}
                            style={{
                              width: `${loadingContributions
                                ? '0'
                                : contributionStatus.totalActiveInRotation <= 1
                                  ? '0'
                                  : `${(contributionStatus.contributedMembers.size / (contributionStatus.totalActiveInRotation - 1)) * 100}%`}`,
                            }}
                          ></div>
                        </div>
                        <p className="mt-2 text-xs text-slate-500">
                          {loadingContributions
                            ? 'Loading contribution status...'
                            : contributionStatus.totalActiveInRotation > 1
                              ? `${contributionStatus.contributedMembers.size}/${contributionStatus.totalActiveInRotation - 1} contributors recorded`
                              : 'Waiting for more active members in the rotation.'}
                        </p>
                      </div>
                    )}

                    <div className="rounded-[20px] border border-stone-200 bg-white p-4">
                      <p className={sectionEyebrowClass}>Contribution</p>
                      <div className="mt-2 text-sm font-semibold text-slate-950">
                        <CurrencyDisplay
                          usd={circle.contributionAmountUsd}
                          sui={circle.contributionAmount}
                          currencyType={circle.currencyType}
                          className="font-semibold"
                        />
                      </div>
                    </div>

                    <div className="rounded-[20px] border border-stone-200 bg-white p-4">
                      <p className={sectionEyebrowClass}>Security Deposit</p>
                      <div className="mt-2 text-sm font-semibold text-slate-950">
                        <CurrencyDisplay
                          usd={circle.securityDepositUsd}
                          sui={circle.securityDeposit}
                          currencyType={circle.currencyType}
                          className="font-semibold"
                        />
                      </div>
                    </div>

                    <div className="rounded-[20px] border border-stone-200 bg-white p-4 sm:col-span-2">
                      <p className={sectionEyebrowClass}>
                        {circle.isActive ? 'Next payout' : 'Potential next payout'}
                      </p>
                      <p className="mt-2 text-sm font-semibold text-slate-950">
                        {circle.isActive
                          ? formatNextPayoutDate(circle.nextPayoutTime)
                          : formatNextPayoutDate(calculatePotentialNextPayoutDate(circle.cycleLength, circle.cycleDay))}
                      </p>
                    </div>

                    <div className="rounded-[20px] border border-stone-200 bg-stone-50/80 p-4 sm:col-span-2">
                      <div className="flex flex-col gap-3">
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                          <div>
                            <p className={sectionEyebrowClass}>Capacity</p>
                            <div className="mt-2 flex flex-wrap items-center gap-2">
                              <p className="text-sm font-semibold text-slate-950">
                                {circle.currentMembers} / {circle.maxMembers} members
                              </p>
                              <span className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium ${
                                getCircleSizeCategory(isEditingMaxMembers ? Number(newMaxMembersValue) : circle.maxMembers) === 'small'
                                  ? 'bg-emerald-100 text-emerald-800'
                                  : getCircleSizeCategory(isEditingMaxMembers ? Number(newMaxMembersValue) : circle.maxMembers) === 'medium'
                                    ? 'bg-sky-100 text-sky-800'
                                    : 'bg-violet-100 text-violet-800'
                              }`}>
                                {getCircleSizeCategory(isEditingMaxMembers ? Number(newMaxMembersValue) : circle.maxMembers) === 'small'
                                  ? 'Small Circle'
                                  : getCircleSizeCategory(isEditingMaxMembers ? Number(newMaxMembersValue) : circle.maxMembers) === 'medium'
                                    ? 'Medium Circle'
                                    : 'Large Circle'}
                              </span>
                            </div>
                          </div>

                          {!circle.isActive && !isEditingMaxMembers && (
                            <button
                              type="button"
                              onClick={() => setIsEditingMaxMembers(true)}
                              className={`${secondaryActionClass} w-full sm:w-auto`}
                            >
                              <Edit3 className="mr-2 h-4 w-4" />
                              Edit Max Capacity
                            </button>
                          )}
                        </div>

                        {isEditingMaxMembers ? (
                          <div className="space-y-4">
                            <div className={`flex flex-wrap gap-2 transition-opacity duration-300 ${animateMembers ? 'animate-pulse' : ''}`}>
                              {[...Array(Number(newMaxMembersValue))].map((_, i) => (
                                <div
                                  key={i}
                                  className={`flex h-8 w-8 items-center justify-center rounded-full ${
                                    i < circle.currentMembers
                                      ? 'border-2 border-slate-300 bg-white text-slate-700'
                                      : 'border border-stone-200 bg-stone-100 text-stone-400'
                                  } ${animateMembers ? 'animate-bounce' : ''}`}
                                  style={{ animationDelay: `${i * 50}ms` }}
                                >
                                  <Users size={14} />
                                </div>
                              ))}
                            </div>

                            <div className="space-y-3">
                              <div className="flex flex-wrap items-center justify-between gap-3">
                                <span className="text-sm font-medium text-slate-700">
                                  {newMaxMembersValue} members maximum
                                </span>
                                <span className="text-xs text-slate-500">
                                  Min {Math.max(3, circle.currentMembers)} · Max 20
                                </span>
                              </div>
                              <input
                                type="range"
                                min={Math.max(3, circle.currentMembers)}
                                max={20}
                                value={newMaxMembersValue}
                                onChange={(e) => {
                                  setNewMaxMembersValue(e.target.value);
                                  setAnimateMembers(true);
                                  setTimeout(() => setAnimateMembers(false), 600);
                                }}
                                className="h-2 w-full cursor-pointer appearance-none rounded-lg bg-stone-200 accent-slate-900"
                              />
                            </div>

                            <div className={`rounded-[18px] border p-3 text-sm ${
                              getCircleSizeCategory(Number(newMaxMembersValue)) === 'small'
                                ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                                : getCircleSizeCategory(Number(newMaxMembersValue)) === 'medium'
                                  ? 'border-sky-200 bg-sky-50 text-sky-800'
                                  : 'border-violet-200 bg-violet-50 text-violet-800'
                            }`}>
                              <p className="font-medium">
                                {recommendedRanges[getCircleSizeCategory(Number(newMaxMembersValue))].label}
                              </p>
                              <p className="mt-1">
                                {recommendedRanges[getCircleSizeCategory(Number(newMaxMembersValue))].description}
                              </p>
                            </div>

                            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                              <button
                                type="button"
                                onClick={() => {
                                  setIsEditingMaxMembers(false);
                                  setNewMaxMembersValue(circle.maxMembers);
                                }}
                                disabled={isSavingMaxMembers}
                                className={secondaryActionClass}
                              >
                                Cancel
                              </button>
                              <button
                                type="button"
                                onClick={handleSaveMaxMembers}
                                disabled={isSavingMaxMembers || Number(newMaxMembersValue) === circle.maxMembers}
                                className={primaryActionClass}
                              >
                                {isSavingMaxMembers ? 'Saving...' : 'Save'}
                              </button>
                            </div>
                          </div>
                        ) : (
                          circle.isActive && (
                            <p className="text-xs text-slate-500">
                              Capacity cannot be changed while the circle is active.
                            </p>
                          )
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </>
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root
        open={!!selectedMobileMember}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedMobileMember(null);
          }
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className={`${dialogOverlayClass} md:hidden`} />
          <Dialog.Content className={mobileSheetContentClass}>
            {selectedMobileMember && (
              <>
                <div className="flex justify-center pt-3">
                  <div className="h-1.5 w-12 rounded-full bg-stone-300" />
                </div>

                <div className="flex items-start justify-between gap-4 px-5 pb-4 pt-4">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      {selectedMobileMember.address === circle?.admin && (
                        <span className="inline-flex rounded-full bg-violet-100 px-3 py-1 text-xs font-medium text-violet-700">
                          Admin
                        </span>
                      )}
                      <span className={`inline-flex rounded-full px-3 py-1 text-xs font-medium ${
                        selectedMobileMember.status === 'active'
                          ? 'bg-emerald-100 text-emerald-800'
                          : selectedMobileMember.status === 'suspended'
                            ? 'bg-amber-100 text-amber-800'
                            : 'bg-red-100 text-red-800'
                      }`}>
                        {selectedMobileMember.status.charAt(0).toUpperCase() + selectedMobileMember.status.slice(1)}
                      </span>
                    </div>
                    <Dialog.Title className="mt-3 font-mono text-base font-semibold tracking-tight text-slate-950">
                      {shortenAddress(selectedMobileMember.address)}
                    </Dialog.Title>
                    <Dialog.Description className="mt-2 text-sm text-slate-500">
                      Member details, contribution state, and available admin action.
                    </Dialog.Description>
                  </div>

                  <Dialog.Close className={subtleIconButtonClass} aria-label="Close member details">
                    <X className="h-4 w-4" />
                  </Dialog.Close>
                </div>

                <div className={mobileSheetBodyClass}>
                  <div className="rounded-[20px] border border-stone-200 bg-stone-50/80 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className={sectionEyebrowClass}>Member Address</p>
                        <p className="mt-2 break-all font-mono text-sm text-slate-950">
                          {selectedMobileMember.address}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => copyPlainText(selectedMobileMember.address, 'Member address copied to clipboard!')}
                        className={subtleIconButtonClass}
                        aria-label="Copy member address"
                      >
                        <Copy className="h-4 w-4" />
                      </button>
                    </div>
                  </div>

                  <div className="mt-3 rounded-[20px] border border-stone-200 bg-stone-50/80 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className={sectionEyebrowClass}>Member Contract Address</p>
                        <p className="mt-2 break-all font-mono text-sm text-slate-950">
                          {selectedMobileMember.memberObjectId ?? 'Unavailable'}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => selectedMobileMember.memberObjectId
                          ? copyPlainText(selectedMobileMember.memberObjectId, 'Member contract address copied to clipboard!')
                          : undefined}
                        disabled={!selectedMobileMember.memberObjectId}
                        className={subtleIconButtonClass}
                        aria-label="Copy member contract address"
                      >
                        <Copy className="h-4 w-4" />
                      </button>
                    </div>
                  </div>

                  <div className="mt-3 grid grid-cols-2 gap-3">
                    <div className="rounded-[20px] border border-stone-200 bg-white p-4">
                      <p className={sectionEyebrowClass}>Deposit</p>
                      <p className="mt-2 text-sm font-semibold text-slate-950">
                        {selectedMobileMember.depositPaid ? 'Paid' : 'Pending'}
                      </p>
                    </div>
                    <div className="rounded-[20px] border border-stone-200 bg-white p-4">
                      <p className={sectionEyebrowClass}>Position</p>
                      <p className="mt-2 text-sm font-semibold text-slate-950">
                        {selectedMobileMember.position !== undefined ? selectedMobileMember.position + 1 : 'Not set'}
                      </p>
                    </div>
                    <div className="col-span-2 rounded-[20px] border border-stone-200 bg-white p-4">
                      <p className={sectionEyebrowClass}>Contribution</p>
                      {(() => {
                        const contributionState = getMemberContributionState(selectedMobileMember);
                        return (
                          <>
                            <span className={`mt-2 inline-flex rounded-full border px-3 py-1 text-xs font-medium ${getContributionToneClasses(contributionState.tone)}`}>
                              {contributionState.label}
                            </span>
                            <p className="mt-3 text-sm text-slate-600">
                              {contributionState.detail}
                            </p>
                          </>
                        );
                      })()}
                    </div>
                    <div className="col-span-2 rounded-[20px] border border-stone-200 bg-white p-4">
                      <p className={sectionEyebrowClass}>Joined</p>
                      <p className="mt-2 text-sm font-semibold text-slate-950">
                        {selectedMobileMember.joinDate ? formatDate(selectedMobileMember.joinDate) : 'Unknown'}
                      </p>
                    </div>
                  </div>

                  {(() => {
                    const memberManagementAction = getMemberManagementAction(selectedMobileMember);

                    if (!memberManagementAction) {
                      return (
                        <div className="mt-4 rounded-[20px] border border-stone-200 bg-stone-50/80 p-4 text-sm text-slate-500">
                          No member action is currently available for this record.
                        </div>
                      );
                    }

                    return (
                      <div className="mt-4 rounded-[20px] border border-stone-200 bg-stone-50/80 p-4">
                        <p className={sectionEyebrowClass}>Admin Action</p>
                        <p className="mt-2 text-sm text-slate-600">
                          {memberManagementAction.helperText}
                        </p>
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedMobileMember(null);
                            memberManagementAction.onClick();
                          }}
                          disabled={memberManagementAction.isDisabled}
                          className={`mt-4 w-full ${
                            memberManagementAction.isDisabled
                              ? 'inline-flex cursor-not-allowed items-center justify-center rounded-full bg-stone-300 px-4 py-2.5 text-sm font-medium text-white/90'
                              : primaryActionClass
                          }`}
                        >
                          {memberManagementAction.buttonText}
                        </button>
                      </div>
                    );
                  })()}
                </div>
              </>
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {/* Add the confirmation modal at the end of the component */}
      <ConfirmationModal
        isOpen={confirmationModal.isOpen}
        onClose={() => setConfirmationModal(prev => ({ ...prev, isOpen: false }))}
        onConfirm={() => {
          // Close FIRST, then run the action.
          //
          // Some handlers chain a second confirmation — handleResumeCycle
          // opens one to spell out that resuming resets every member's
          // deposit. Closing afterwards clobbered it: the close ran against
          // the state the handler had just set, so the second dialog opened
          // and shut in the same tick and its transaction was never sent.
          // Resume Cycle therefore did nothing at all, stranding every circle
          // paused at the end of every round.
          //
          // Ordering it this way makes the queued close land first and any
          // dialog the handler opens win, while a handler that opens nothing
          // still just closes.
          setConfirmationModal(prev => ({ ...prev, isOpen: false }));
          confirmationModal.onConfirm();
        }}
        title={confirmationModal.title}
        message={confirmationModal.message}
        confirmText={confirmationModal.confirmText}
        cancelText="Cancel"
        confirmButtonVariant={confirmationModal.confirmButtonVariant}
      />
      <SecurityDepositPayoutModal />

      {/* Premium upsell when a member-cap change exceeds the caller's plan */}
      <BillingUpsellModal
        open={!!upsell}
        onClose={() => setUpsell(null)}
        feature={upsell?.feature ?? 'maxMembers'}
        message={upsell?.message}
      />
    </div>
  );
}
