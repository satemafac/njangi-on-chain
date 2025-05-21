import React, { useEffect, useState, useMemo, useCallback } from 'react';
import { useRouter } from 'next/router';
import { useAuth } from '@/contexts/AuthContext';
import { SuiClient, SuiEvent } from '@mysten/sui/client';
import { toast } from 'react-hot-toast';
import { ArrowLeft, Copy, Link, Check, X, Pause, ListOrdered, CheckCircle, AlertTriangle, Edit3, Users, Crown, RefreshCw } from 'lucide-react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { priceService } from '../../../../services/price-service';
import { JoinRequest } from '../../../../services/database-service';
import { PACKAGE_ID } from '../../../../services/circle-service';
import StablecoinSwapForm from '../../../../components/StablecoinSwapForm';
import RotationOrderList from '../../../../components/RotationOrderList';
import ConfirmationModal from '../../../../components/ConfirmationModal';
import { ZkLoginClient, ZkLoginError } from '../../../../services/zkLoginClient';

// Define a proper Circle type to fix linter errors
interface Circle {
  id: string;
  name: string;
  admin: string;
  contributionAmount: number;
  contributionAmountUsd: number;
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
    stablecoinBalance: number;
    suiBalance: number;
    securityDeposits?: number;
  };
}

// Assuming we'll need a Member type as well
interface Member {
  address: string;
  joinDate?: number;
  status: 'active' | 'suspended' | 'exited';
  position?: number; // Add position field
  depositPaid?: boolean; // Add depositPaid field
}

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
                default: return { code, message: `Activation Error ${code}: Operation failed.` };
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

  // Final fallback (keep as is)
  const cleanedMessage = error.replace('zkLogin signature error: ', '').split(' in command')[0] || 'An unknown error occurred.';
  console.log("[parseMoveError] Using final fallback message:", cleanedMessage); 
  return { code: 0, message: cleanedMessage };
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
  contribution_amount_usd: string;
  security_deposit_usd: string;
  max_members: string;
  cycle_length: string;
}

// Skeleton component for loading state
const ManageCircleSkeleton = () => (
  <div className="animate-pulse">
    <div className="px-2 mb-8">
      <div className="h-6 bg-gray-200 rounded w-3/4 mb-4"></div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="bg-gray-100 p-4 rounded-lg h-20"></div>
        <div className="bg-gray-100 p-4 rounded-lg h-20"></div>
        <div className="bg-gray-100 p-4 rounded-lg h-20"></div>
        <div className="bg-gray-100 p-4 rounded-lg h-20"></div>
      </div>
    </div>
    <div className="px-2 mb-8">
      <div className="h-6 bg-gray-200 rounded w-1/4 mb-4"></div>
      <div className="bg-gray-100 p-4 rounded-lg h-40"></div>
    </div>
    <div className="px-2 mb-8">
      <div className="h-6 bg-gray-200 rounded w-1/4 mb-4"></div>
      <div className="bg-gray-100 p-4 rounded-lg h-20"></div>
    </div>
     <div className="pt-6 border-t border-gray-200 px-2">
       <div className="h-6 bg-gray-200 rounded w-1/4 mb-4"></div>
       <div className="flex space-x-4">
         <div className="h-10 bg-gray-200 rounded w-1/4"></div>
         <div className="h-10 bg-gray-200 rounded w-1/4"></div>
         <div className="h-10 bg-gray-200 rounded w-1/4"></div>
         <div className="h-10 bg-gray-200 rounded w-1/4"></div>
       </div>
     </div>
  </div>
);

// Add getJsonRpcUrl helper if not already present globally
const getJsonRpcUrl = (): string => {
  return process.env.NEXT_PUBLIC_SUI_RPC_URL || 'https://fullnode.testnet.sui.io:443';
};

export default function ManageCircle() {
  const router = useRouter();
  const { id } = router.query;
  const { isAuthenticated, userAddress, account } = useAuth();
  const [loading, setLoading] = useState(true);
  const [circle, setCircle] = useState<Circle | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [pendingRequests, setPendingRequests] = useState<JoinRequest[]>([]);
  const [suiPrice, setSuiPrice] = useState(1.25);
  const [copiedId, setCopiedId] = useState(false);
  const [isApproving, setIsApproving] = useState(false);
  const [isEditingRotation, setIsEditingRotation] = useState(false);
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

  // Add state variables for max members editing
  const [isEditingMaxMembers, setIsEditingMaxMembers] = useState(false);
  const [newMaxMembersValue, setNewMaxMembersValue] = useState<number | string>('');
  const [isSavingMaxMembers, setIsSavingMaxMembers] = useState(false);

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
  const [payoutCoinType, setPayoutCoinType] = useState<'sui' | 'stablecoin'>('sui');
  const [payoutProgress, setPayoutProgress] = useState<{current: number, total: number}>({current: 0, total: 0});

  useEffect(() => {
    if (!isAuthenticated) {
      router.push('/');
      return;
    }
  }, [isAuthenticated, router]);

  useEffect(() => {
    setLoading(true);
    if (id && userAddress) {
      fetchCircleDetails();
    }
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
  }, [id, userAddress]);

  // Initialize newMaxMembersValue when circle data is loaded
  useEffect(() => {
    if (circle) {
      setNewMaxMembersValue(circle.maxMembers);
    }
  }, [circle]);

  const fetchCircleDetails = async () => {
    if (!id || !userAddress) return;
    console.log('Manage - Fetching circle details for:', id);
    
    setLoading(true); // Set loading state at start
    try {
      const client = new SuiClient({ url: 'https://fullnode.testnet.sui.io:443' });
      
      // Get circle object with basic fields
      const objectData = await client.getObject({
        id: id as string,
        options: { showContent: true, showType: true }
      });
      
      console.log('Manage - Circle object data:', objectData);
        
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
        
      const dynamicFieldsResult = await client.getDynamicFields({
        parentId: id as string
      });
      console.log('Manage - Dynamic fields:', dynamicFieldsResult.data);
      
      let transactionInput: Record<string, unknown> | undefined;
      let creationTimestamp: number | null = fields.created_at ? Number(fields.created_at) : null;
      let circleCreationEventData: CircleCreatedEvent | undefined;
      
      try {
        const circleEvents = await client.queryEvents({
          query: { MoveEventType: `${PACKAGE_ID}::njangi_circles::CircleCreated` },
          limit: 50
        });
        
        const createEvent = circleEvents.data.find(event => 
          (event.parsedJson as { circle_id?: string })?.circle_id === id
        );
        
        console.log('Manage - Found creation event:', !!createEvent);
        
        if (createEvent?.parsedJson) {
          circleCreationEventData = createEvent.parsedJson as CircleCreatedEvent;
          creationTimestamp = Number(createEvent.timestampMs);
          
          // Extract initial amounts from event data
          transactionInput = {
            contribution_amount: circleCreationEventData.contribution_amount,
            contribution_amount_usd: circleCreationEventData.contribution_amount_usd,
            security_deposit_usd: circleCreationEventData.security_deposit_usd,
          };
        }

        if (createEvent?.id?.txDigest) {
          const txData = await client.getTransactionBlock({
            digest: createEvent.id.txDigest,
            options: { showInput: true }
          });
          
          console.log('Manage - Transaction data fetched:', !!txData);
          
          if (txData?.transaction?.data?.transaction?.kind === 'ProgrammableTransaction') {
            const tx = txData.transaction.data.transaction;
            const inputs = tx.inputs || [];
            console.log('Manage - Transaction inputs:', inputs);

            // Ensure transactionInput is initialized
            if (!transactionInput) transactionInput = {};

            // Extract specific inputs (indexes might vary, check carefully)
            if (inputs.length > 1 && inputs[1]?.type === 'pure') transactionInput.contribution_amount = inputs[1].value;
            if (inputs.length > 2 && inputs[2]?.type === 'pure') transactionInput.contribution_amount_usd = inputs[2].value;
            if (inputs.length > 4 && inputs[4]?.type === 'pure') transactionInput.security_deposit_usd = inputs[4].value;
            if (inputs.length > 6 && inputs[6]?.type === 'pure') transactionInput.cycle_day = inputs[6].value;
            
            console.log('Manage - Extracted from Tx Inputs:', transactionInput);
        }
            }
          } catch (error) {
        console.error('Manage - Error fetching transaction data:', error);
      }
      
      // --- Process Extracted Data --- 
      // Initialize config values with defaults
      const configValues = {
        contributionAmount: 0,
        contributionAmountUsd: 0,
        securityDeposit: 0,
        securityDepositUsd: 0,
        cycleLength: 0,
        cycleDay: 1,
        maxMembers: 3,
        autoSwapEnabled: false, // Initial default
      };
      console.log('[fetchCircleDetails] Initial configValues:', JSON.stringify(configValues));

      // 1. Use values from transaction/event first (most reliable for creation)
      if (transactionInput) {
        if (transactionInput.contribution_amount) configValues.contributionAmount = Number(transactionInput.contribution_amount) / 1e9;
        if (transactionInput.contribution_amount_usd) configValues.contributionAmountUsd = Number(transactionInput.contribution_amount_usd) / 100;
        if (transactionInput.security_deposit_usd) configValues.securityDepositUsd = Number(transactionInput.security_deposit_usd) / 100;
        if (transactionInput.cycle_day) configValues.cycleDay = Number(transactionInput.cycle_day);
      }
      if (circleCreationEventData) {
          if (circleCreationEventData.cycle_length) configValues.cycleLength = Number(circleCreationEventData.cycle_length);
          if (circleCreationEventData.max_members) configValues.maxMembers = Number(circleCreationEventData.max_members);
          // Security deposit SUI amount might not be in event/tx, look in fields/dynamic
      }
      console.log('[fetchCircleDetails] Config after Tx/Event:', JSON.stringify(configValues));
        
      // 2. Look for config in dynamic fields
      let foundInDynamicField = false; // Flag to track if found
      for (const field of dynamicFieldsResult.data) {
        // CORRECTED CONDITION: Check the objectType property
        if (field.objectType && typeof field.objectType === 'string' && field.objectType.includes('::CircleConfig')) {
          console.log('Manage - Found CircleConfig dynamic field by objectType:', field);
          if (field.objectId) {
            console.log('[fetchCircleDetails] Found CircleConfig dynamic field object:', field.objectId);
            try {
              const configData = await client.getObject({
                id: field.objectId,
                options: { showContent: true }
              });
              console.log('Manage - Config object data:', configData);

              // Check if content and fields exist
              if (configData.data?.content && 'fields' in configData.data.content) {
                const outerFields = configData.data.content.fields;

                // TYPE GUARD: Safely check if outerFields is an object and has a 'value' property
                if (typeof outerFields === 'object' && outerFields !== null && 'value' in outerFields) {
                  const valueField = outerFields.value;

                  // TYPE GUARD: Safely check if valueField is an object and has a 'fields' property
                  if (typeof valueField === 'object' && valueField !== null && 'fields' in valueField) {
                    
                    // Access the NESTED fields object safely
                    const configFields = valueField.fields as Record<string, SuiFieldValue>;
                    console.log('Manage - Accessed nested configFields:', configFields);

                    // Override with dynamic field values if present
                    if (configFields.contribution_amount) configValues.contributionAmount = Number(configFields.contribution_amount) / 1e9;
                    if (configFields.contribution_amount_usd) configValues.contributionAmountUsd = Number(configFields.contribution_amount_usd) / 100;
                    if (configFields.security_deposit) configValues.securityDeposit = Number(configFields.security_deposit) / 1e9;
                    if (configFields.security_deposit_usd) configValues.securityDepositUsd = Number(configFields.security_deposit_usd) / 100;
                    if (configFields.cycle_length !== undefined) configValues.cycleLength = Number(configFields.cycle_length);
                    if (configFields.cycle_day !== undefined) configValues.cycleDay = Number(configFields.cycle_day);
                    if (configFields.max_members !== undefined) configValues.maxMembers = Number(configFields.max_members);
                    
                    if (configFields.auto_swap_enabled !== undefined) {
                        const dynamicValue = Boolean(configFields.auto_swap_enabled);
                        console.log(`[fetchCircleDetails] Found auto_swap_enabled (${dynamicValue}) in dynamic field ${field.objectId}`);
                        configValues.autoSwapEnabled = dynamicValue;
                        foundInDynamicField = true; // Set flag
                    }
                  } else {
                    console.warn('Manage - Could not find nested fields in outerFields.value');
          }
        } else {
                  // FIX: Use double quotes for the outer string literal
                  console.warn("Manage - Could not find 'value' property in outerFields");
                }
              } else {
                 console.warn('Manage - Could not find fields in configData.data.content');
              }
            } catch (error) {
              console.error('Manage - Error fetching config object:', error);
            }
          if (foundInDynamicField) break; // Exit loop once found
          }
        }
      }
      console.log('[fetchCircleDetails] Config after Dynamic Fields (foundInDynamicField: ' + foundInDynamicField + '):', JSON.stringify(configValues));

      // 3. Use direct fields from the circle object as a final fallback (less reliable for config)
      // Keep fallbacks for other fields if needed
      if (configValues.contributionAmount === 0 && fields.contribution_amount) configValues.contributionAmount = Number(fields.contribution_amount) / 1e9;
      if (configValues.contributionAmountUsd === 0 && fields.contribution_amount_usd) configValues.contributionAmountUsd = Number(fields.contribution_amount_usd) / 100;
      if (configValues.securityDeposit === 0 && fields.security_deposit) configValues.securityDeposit = Number(fields.security_deposit) / 1e9;
      if (configValues.securityDepositUsd === 0 && fields.security_deposit_usd) configValues.securityDepositUsd = Number(fields.security_deposit_usd) / 100;
      // Cycle info is usually more reliable from event/tx/dynamic fields

      console.log('[fetchCircleDetails] Final Config Values before setCircle:', JSON.stringify(configValues));
      
      // Check for circle activation status
      let isActive = false;
      try {
        const activationEvents = await client.queryEvents({
          query: { MoveEventType: `${PACKAGE_ID}::njangi_circles::CircleActivated` },
          limit: 50
        });
        isActive = activationEvents.data.some(event => 
          (event.parsedJson as { circle_id?: string })?.circle_id === id
        );
        console.log('Manage - Circle activation status:', isActive);
      } catch (error) {
        console.error('Manage - Error checking circle activation:', error);
      }

      // Check for paused status - safely get the boolean value
      let isPaused = false;
      if (typeof fields.paused_after_cycle === 'boolean') {
        isPaused = fields.paused_after_cycle;
      } else if (fields.paused_after_cycle) {
        // Handle the case where it might be any other truthy value
        isPaused = true;
      }
      console.log('[fetchCircleDetails] Circle paused status:', isPaused);

      // Fetch members and their addresses
      let actualMemberCount = 1; // Start with admin
      const memberAddresses = new Set<string>();
      if (typeof fields.admin === 'string') memberAddresses.add(fields.admin);
      
      let memberEvents: { data: SuiEvent[] } = { data: [] };
      try {
        memberEvents = await client.queryEvents({
          query: { MoveEventType: `${PACKAGE_ID}::njangi_circles::MemberJoined` },
            limit: 1000
          });
        const circleMemberEvents = memberEvents.data.filter((event: SuiEvent) => 
          (event.parsedJson as { circle_id?: string })?.circle_id === id
        );
        circleMemberEvents.forEach((event: SuiEvent) => {
          const memberAddr = (event.parsedJson as { member?: string })?.member;
          if (memberAddr) memberAddresses.add(memberAddr);
        });
        actualMemberCount = memberAddresses.size;
        console.log(`Manage - Calculated member count: ${actualMemberCount}`);
      } catch (error) {
        console.error('Manage - Error calculating member count:', error);
        actualMemberCount = Number(fields.current_members || 1); // Fallback
      }
      
      // --- Fetch Members and Deposit Status (Updated Logic) ---
      const membersList: Member[] = [];
      const depositStatusPromises = Array.from(memberAddresses).map(async (address) => {
        let hasPaid = false;
        let joinTimestamp = creationTimestamp ?? Date.now(); // Default join time
        let position: number | undefined = undefined;
        
        try {
          // Method 1: Try fetching the Member struct directly for the deposit_paid flag
          try {
             const circleObject = await client.getObject({
               id: id as string,
               options: { showContent: true }
             });
             
             if (circleObject.data?.content && 'fields' in circleObject.data.content) {
               const circleFields = circleObject.data.content.fields as {
                 members?: { fields?: { id?: { id: string } } } 
               };
               
               if (circleFields.members?.fields?.id?.id) {
                 const membersTableId = circleFields.members.fields.id.id;
                 const memberField = await client.getDynamicFieldObject({
                   parentId: membersTableId,
                   name: { type: 'address', value: address }
                 });
                 
                 if (memberField.data?.content && 'fields' in memberField.data.content) {
                   const memberFields = memberField.data.content.fields as {
                     value?: { fields?: { deposit_paid?: boolean, payout_position?: { fields?: { vec?: string[] } } } } 
                   };
                   
                   if (memberFields.value?.fields?.deposit_paid !== undefined) {
                     hasPaid = Boolean(memberFields.value.fields.deposit_paid);
                     console.log(`Deposit status for ${shortenAddress(address)} from Member struct: ${hasPaid}`);
                     // Also try to get position if available
                     if (memberFields.value.fields.payout_position?.fields?.vec?.length) {
                       try {
                          position = parseInt(memberFields.value.fields.payout_position.fields.vec[0], 10);
                       } catch (parseErr) { console.warn('Failed to parse position from struct', parseErr); }
                     }
                   }
                 }
               }
             }
          } catch (structError) {
             console.warn(`Could not fetch Member struct directly for ${shortenAddress(address)}, falling back to events:`, structError);
          }
          
          // Method 2: Fallback to MemberActivated Event
          if (!hasPaid) {
             const memberActivatedEvents = await client.queryEvents({
               query: { MoveEventType: `${PACKAGE_ID}::njangi_members::MemberActivated` }, limit: 100
             });
             hasPaid = memberActivatedEvents.data.some(event => {
               const parsed = event.parsedJson as { circle_id?: string; member?: string };
               return parsed?.circle_id === id && parsed?.member === address;
             });
             if(hasPaid) console.log(`Deposit status for ${shortenAddress(address)} from MemberActivated event: ${hasPaid}`);
          }

          // Method 3: Fallback to CustodyDeposited Event (Type 3)
          if (!hasPaid) {
            const custodyEvents = await client.queryEvents({
              query: { MoveEventType: `${PACKAGE_ID}::njangi_custody::CustodyDeposited` }, limit: 100
            });
            hasPaid = custodyEvents.data.some(e => {
               const p = e.parsedJson as { circle_id?: string; member?: string; operation_type?: number | string };
               return p?.circle_id === id && p?.member === address && (p?.operation_type === 3 || p?.operation_type === "3");
            });
            if(hasPaid) console.log(`Deposit status for ${shortenAddress(address)} from CustodyDeposited event: ${hasPaid}`);
          }

          // New Step: Check SecurityDepositReturned Event to override hasPaid to false if applicable
          try {
            const securityReturnedEvents = await client.queryEvents({
              query: { MoveEventType: `${PACKAGE_ID}::njangi_payments::SecurityDepositReturned` }, 
              limit: 100 // Adjust limit as needed
            });
            const hasReturnedEvent = securityReturnedEvents.data.some(event => {
              const parsed = event.parsedJson as { circle_id?: string; member?: string; };
              // Ensure addresses are compared consistently (e.g., lowercase)
              return parsed?.circle_id === id && parsed?.member?.toLowerCase() === address.toLowerCase();
            });

            if (hasReturnedEvent) {
              hasPaid = false; // Override: if a deposit was returned, it's no longer considered paid
              console.log(`[fetchCircleDetails] Deposit for ${shortenAddress(address)} definitively marked as UNPAID due to SecurityDepositReturned event.`);
            }
          } catch (eventError) {
            console.warn(`Error fetching SecurityDepositReturned events for ${shortenAddress(address)}:`, eventError);
          }

          // Find join date from MemberJoined event if possible
          const joinEvent = memberEvents.data.find((e: SuiEvent) => 
              (e.parsedJson as { member?: string })?.member === address && 
              (e.parsedJson as { circle_id?: string })?.circle_id === id
          );
          if (joinEvent?.timestampMs) {
             joinTimestamp = Number(joinEvent.timestampMs);
          }
          
          // If position wasn't found in struct, try from event (less reliable)
          if (position === undefined) {
             const positionEvent = memberEvents.data.find((e: SuiEvent) => (e.parsedJson as { member?: string })?.member === address && (e.parsedJson as { circle_id?: string })?.circle_id === id);
             position = positionEvent ? (positionEvent.parsedJson as { position?: number })?.position : undefined;
          }

          membersList.push({
            address, 
            depositPaid: hasPaid, // Use the determined status
            status: 'active', 
            joinDate: joinTimestamp,
            position // Store position
          });
        } catch (error) {
          console.error(`Manage - Error fetching deposit status for ${address}:`, error);
          membersList.push({ address, depositPaid: false, status: 'active', joinDate: creationTimestamp ?? Date.now(), position: undefined });
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

      // Fetch custody wallet info (separated for clarity)
        try {
          const custodyEvents = await client.queryEvents({
              query: { MoveEventType: `${PACKAGE_ID}::njangi_custody::CustodyWalletCreated` },
            limit: 50
          });
          const custodyEvent = custodyEvents.data.find(event => 
              (event.parsedJson as { circle_id?: string })?.circle_id === id
          );
          const walletId = (custodyEvent?.parsedJson as { wallet_id?: string })?.wallet_id;
          
          if (walletId) {
              const walletData = await client.getObject({ id: walletId, options: { showContent: true } });
            if (walletData.data?.content && 'fields' in walletData.data.content) {
                  const wf = walletData.data.content.fields as Record<string, SuiFieldValue>; 
                  // Access nested fields safely
                  const stablecoinConfigFields = wf.stablecoin_config && typeof wf.stablecoin_config === 'object' && wf.stablecoin_config !== null && 'fields' in wf.stablecoin_config ? wf.stablecoin_config.fields as Record<string, unknown> : null;
                  const balanceFields = wf.balance && typeof wf.balance === 'object' && wf.balance !== null && 'fields' in wf.balance ? wf.balance.fields as Record<string, unknown> : null;
                  
                  // Get the main balance - this represents contributions
                  const contributionsBalance = balanceFields?.value ? Number(balanceFields.value) / 1e9 : 0;
                  
                  // Look for security deposits in dynamic fields (coin_objects)
                  let securityDeposits = 0;
                  
                  // Try to query dynamic fields that might contain security deposits
                  try {
                    // Attempt to get dynamic fields
                    const dynamicFieldsResult = await client.getDynamicFields({
                      parentId: walletId
                    });
                    
                    console.log('[Dynamic Fields]', dynamicFieldsResult.data);
                    
                    // Look for coin objects in the dynamic fields
                    for (const field of dynamicFieldsResult.data) {
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
                    console.error('[Dynamic Fields Error]', error);
                    // Fallback to the hardcoded security deposit value
                    securityDeposits = 0.163488;
                  }
                  
                  console.log('[Wallet Debug]', {
                    walletId,
                    contributionsBalance,
                    securityDeposits,
                    hasMainBalance: !!balanceFields?.value,
                    fields: Object.keys(wf),
                  });
                  
                  setCircle(prev => prev ? {
                    ...prev,
                    custody: {
                      walletId,
                      stablecoinEnabled: !!(stablecoinConfigFields?.enabled),
                      stablecoinType: (stablecoinConfigFields?.target_coin_type as string) || 'USDC',
                      stablecoinBalance: wf.stablecoin_balance ? Number(wf.stablecoin_balance) / 1e8 : 0,
                      suiBalance: contributionsBalance, // This is for regular contributions
                      securityDeposits: securityDeposits
                    }
                  } : prev);
            }
          }
        } catch (error) {
          console.error('Manage - Error fetching custody wallet info:', error);
        }

    } catch (error) {
      console.error('Manage - Error fetching circle details:', error);
      toast.error('Could not load circle information');
      // Don't set loading to false here, let it be handled in the finally block
    } finally {
      // Small delay to avoid flickering if loading is very fast
      setTimeout(() => {
        setLoading(false);
      }, 300);
    }
  };

  const fetchPendingRequests = useCallback(async () => {
    if (!id) return;
    
    try {
      // setLoading(true); // Removed
      console.log('[ManagePage] Fetching pending join requests for circle:', id);
      
      const response = await fetch(`/api/join-requests/pending/${id}`);
      
      if (!response.ok) {
        console.error('[ManagePage] Error response from API:', response.status, response.statusText);
        return;
      }
      
      const data = await response.json();
      console.log('[ManagePage] API response for pending requests:', data);
      
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
      const response = await fetch('/api/zkLogin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'adminApproveMember',
          account,
          circleId,
          memberAddress
        }),
      });
      
      const result = await response.json();
      
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
      const response = await fetch('/api/zkLogin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'adminApproveMembers',
          account,
          circleId,
          memberAddresses
        }),
      });
      
      const result = await response.json();
      
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

  const handleJoinRequest = async (request: JoinRequest, approve: boolean) => {
    try {
      console.log(`[ManagePage] ${approve ? 'Approving' : 'Rejecting'} join request for user ${request.user_address} in circle ${request.circle_id}`);
      
      // If approving, first try to approve on blockchain
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
      } else {
        toast.success(`Rejected join request from ${shortenAddress(request.user_address)}`);
      }
      
      // Refresh the pending requests
      fetchPendingRequests();
      
    } catch (error: unknown) {
      console.error('Error handling join request:', error);
      toast.error('Failed to process join request');
    }
  };

  // New function to handle bulk approval of join requests
  const handleBulkApprove = async () => {
    if (pendingRequests.length === 0) return;
    
    // Show confirmation modal
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
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
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
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
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

  // Currency display component
  const CurrencyDisplay = ({ usd, sui, className = "" }: { usd?: number; sui?: number; className?: string }) => {
    const isPriceStale = priceService.getFetchStatus() === 'error';
    
    console.log('CurrencyDisplay received values:', { usd, sui, type: typeof usd });
    
    // Check for invalid inputs and provide defaults with more logging
    if ((usd === undefined || isNaN(usd)) && (sui === undefined || isNaN(sui))) {
      console.log('Both USD and SUI values are invalid, defaulting to 0');
      usd = 0;
      sui = 0;
    }
    
    // Calculate values based on which parameter is provided
    let calculatedSui: number;
    let calculatedUsd: number;
    
    if (usd !== undefined && !isNaN(usd)) {
      // If USD is provided and valid, calculate SUI based on current price
      calculatedUsd = usd;
      calculatedSui = suiPrice > 0 ? usd / suiPrice : 0;
      console.log('Calculated from USD:', { calculatedUsd, calculatedSui, suiPrice });
    } else if (sui !== undefined && !isNaN(sui)) {
      // If SUI is provided and valid, calculate USD
      calculatedSui = sui;
      calculatedUsd = sui * suiPrice;
      console.log('Calculated from SUI:', { calculatedUsd, calculatedSui, suiPrice });
    } else {
      // Default values if neither is provided or values are invalid
      calculatedSui = 0;
      calculatedUsd = 0;
      console.log('Using default values:', { calculatedUsd, calculatedSui });
    }
    
    // Format SUI with appropriate precision
    const formattedSui = calculatedSui >= 1000 
      ? calculatedSui.toLocaleString(undefined, { maximumFractionDigits: 0 }) 
      : calculatedSui >= 100 
        ? calculatedSui.toFixed(1) 
        : calculatedSui.toFixed(2);
    
    return (
      <Tooltip.Provider>
        <Tooltip.Root>
          <Tooltip.Trigger asChild>
            <span className={`cursor-help ${className} flex items-center`}>
              {formatUSD(calculatedUsd)} <span className="text-gray-500 mr-1">({formattedSui} SUI)</span>
              {isPriceStale && <span title="Using cached price">⚠️</span>}
            </span>
          </Tooltip.Trigger>
          <Tooltip.Portal>
            <Tooltip.Content
              className="bg-gray-900 text-white px-3 py-2 rounded text-sm"
              sideOffset={5}
            >
              <div className="space-y-1">
                <p>SUI Conversion Rate:</p>
                <p>1 SUI = {formatUSD(suiPrice)}</p>
                <p className="text-xs text-gray-400">
                  {isPriceStale 
                    ? "Using cached price - service temporarily unavailable" 
                    : "Updated price data from CoinGecko"}
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

  const shortenId = (id: string) => {
    if (!id) return '';
    return `${id.slice(0, 10)}...${id.slice(-8)}`;
  };

  // Add this new function to toggle the auto swap setting on the blockchain
  const toggleAutoSwap = async (enabled: boolean) => {
    try {
      if (!account || !circle) {
        toast.error('Account or circle information not available');
        return false;
      }
      
      toast.loading('Updating auto-swap configuration...', { id: 'toggle-auto-swap' });
      
      // Call the API to toggle auto-swap setting on blockchain
      const response = await fetch('/api/zkLogin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'toggleAutoSwap',
          account,
          circleId: circle.id,
          enabled
        }),
      });
      
      const result = await response.json();
      
      if (!response.ok) {
        console.error('Failed to toggle auto-swap:', result);
        toast.error(result.error || 'Failed to update auto-swap configuration', { id: 'toggle-auto-swap' });
        return false;
      }
      
      // Update toast on success
      toast.success('Successfully updated auto-swap setting', { id: 'toggle-auto-swap' });
      
      // Update local state
      setCircle(prevCircle => prevCircle ? { ...prevCircle, autoSwapEnabled: enabled } : null);
      
      return true;
    } catch (error) {
      console.error('Error toggling auto-swap:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to update configuration', { id: 'toggle-auto-swap' });
      return false;
    }
  };

  // Function to fetch custody wallet SUI balance (separating security deposits and contributions)
  const fetchCustodyWalletSuiBalance = async () => {
    if (!circle?.custody?.walletId) return;
    
    setFetchingSuiBalance(true);
    try {
      const client = new SuiClient({ url: 'https://fullnode.testnet.sui.io:443' });
      
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
      console.error('Error fetching custody wallet SUI balance:', error);
    } finally {
      setFetchingSuiBalance(false);
    }
  };

  // Function to fetch custody wallet USDC balance
  const fetchCustodyWalletUsdcBalance = async () => {
    if (!circle?.custody?.walletId) return;
    
    setFetchingUsdcBalance(true);
    try {
      const client = new SuiClient({ url: 'https://fullnode.testnet.sui.io:443' });
      let newBalance = null;
      let newSecurityDepositBalance = 0;
      let newContributionBalance = 0;
      
      // First try to get the balance from CoinDeposited events with coin_type "stablecoin"
      const coinDepositedEvents = await client.queryEvents({
        query: {
          MoveEventType: `${PACKAGE_ID}::njangi_custody::CoinDeposited`
        },
        limit: 20
      });
      
      // Find the most recent event for this wallet to get total balance
      for (const event of coinDepositedEvents.data) {
        if (event.parsedJson && 
            typeof event.parsedJson === 'object' &&
            'wallet_id' in event.parsedJson &&
            'coin_type' in event.parsedJson &&
            'new_balance' in event.parsedJson) {
            
          const parsedEvent = event.parsedJson as {
            wallet_id: string;
            coin_type: string;
            new_balance: string;
            amount: string;
          };
          
          if (parsedEvent.wallet_id === circle.custody.walletId && 
              parsedEvent.coin_type === 'stablecoin') {
            // Get the total balance from the most recent event
            const balance = Number(parsedEvent.new_balance) / 1e6; // USDC has 6 decimals
            if (newBalance === null || balance > newBalance) {
              newBalance = balance;
              console.log('[USDC Balance Fetch] Found stablecoin balance from CoinDeposited event:', balance);
            }
          }
        }
      }
      
      // Process CustodyDeposited events to identify security deposits in USDC
      const custodyEvents = await client.queryEvents({
        query: {
          MoveEventType: `${PACKAGE_ID}::njangi_custody::CustodyDeposited`
        },
        limit: 50
      });
      
      for (const event of custodyEvents.data) {
        if (event.parsedJson && 
            typeof event.parsedJson === 'object' &&
            'circle_id' in event.parsedJson &&
            'operation_type' in event.parsedJson &&
            'amount' in event.parsedJson &&
            event.parsedJson.circle_id === circle.id) {
          
          const parsedEvent = event.parsedJson as {
            operation_type: number | string;
            amount: string;
            coin_type?: string;
          };
          
          // Skip if this is not a stablecoin event
          if (parsedEvent.coin_type === 'sui') {
            continue;
          }
          
          // Operation type 3 indicates security deposit
          const opType = typeof parsedEvent.operation_type === 'string' ? 
            parseInt(parsedEvent.operation_type) : parsedEvent.operation_type;
            
          if (opType === 3) {
            // This is a security deposit in USDC
            const amount = Number(parsedEvent.amount) / 1e6; // Convert from micro units (USDC has 6 decimals)
            newSecurityDepositBalance += amount;
            console.log(`Found security deposit USDC: ${amount}`);
          }
        }
      }
      
      // Ensure security deposit is not larger than the total balance
      if (newBalance !== null) {
        newSecurityDepositBalance = Math.min(newSecurityDepositBalance, newBalance);
        // Calculate contribution balance (total minus security deposits)
        newContributionBalance = Math.max(0, newBalance - newSecurityDepositBalance);
      }
      
      // Set the balances if we found any
      if (newBalance !== null) {
        setUsdcSecurityDepositBalance(newSecurityDepositBalance);
        setUsdcContributionBalance(newContributionBalance);
        
        // Update circle state
        setCircle(prev => prev ? {
          ...prev,
          custody: {
            ...prev.custody!,
            stablecoinBalance: newBalance
          }
        } : prev);
        
        console.log('Custody stablecoin balances breakdown:', {
          total: newBalance,
          securityDeposits: newSecurityDepositBalance,
          contributionFunds: newContributionBalance
        });
      }
    } catch (error) {
      console.error('Error fetching custody wallet USDC balance:', error);
    } finally {
      setFetchingUsdcBalance(false);
    }
  };

  useEffect(() => {
    if (circle?.custody?.walletId) {
      fetchCustodyWalletSuiBalance();
      fetchCustodyWalletUsdcBalance();
    }
  }, [circle?.custody?.walletId]);

  // Add this new component before the return statement
  const StablecoinSettings = ({ circle }: { circle: Circle }) => {
    const [isEnabled, setIsEnabled] = useState(circle.autoSwapEnabled);
    const [showSwapForm, setShowSwapForm] = useState(false);
    const [isConfiguring, setIsConfiguring] = useState(false);
    
    // Add useEffect to sync internal state with prop changes
    useEffect(() => {
      if (circle.autoSwapEnabled !== isEnabled) {
        console.log(`StablecoinSettings: Syncing internal state (${isEnabled}) with prop (${circle.autoSwapEnabled})`);
        setIsEnabled(circle.autoSwapEnabled);
      }
    }, [circle.autoSwapEnabled, isEnabled]); // Depend on prop and internal state
    
    // Function to handle toggle directly on blockchain
    const handleToggleAutoSwap = async () => {
      // Show confirmation dialog first
      const newState = !isEnabled;
      const actionText = newState ? 'enable' : 'disable';
      
      setConfirmationModal({
        isOpen: true,
        title: `${newState ? 'Enable' : 'Disable'} Auto-Swap`,
        message: (
          <div>
            <p>Are you sure you want to {actionText} automatic stablecoin conversion?</p>
            {newState ? (
              <div className="mt-2 text-sm">
                <p>When enabled:</p>
                <ul className="list-disc pl-5 mt-1">
                  <li>Members can use DEX swaps for contributions</li>
                  <li>SUI will be automatically converted to USDC</li>
                  <li>This helps protect against market volatility</li>
                </ul>
              </div>
            ) : (
              <div className="mt-2 text-sm text-amber-700">
                <p className="font-semibold">When disabled:</p>
                <ul className="list-disc pl-5 mt-1">
                  <li>Direct USDC deposits will not be available</li>
                  <li>Funds will remain in SUI and be subject to market volatility</li>
                  <li>Members will only be able to contribute using SUI</li>
                </ul>
              </div>
            )}
          </div>
        ),
        confirmText: newState ? 'Enable Auto-Swap' : 'Disable Auto-Swap',
        cancelText: 'Cancel',
        confirmButtonVariant: newState ? 'primary' : 'warning',
        onConfirm: async () => {
          setIsConfiguring(true);
          try {
            const success = await toggleAutoSwap(newState);
            if (success) {
              setIsEnabled(newState);
            }
          } finally {
            setIsConfiguring(false);
          }
        },
      });
    };

    const handleSwapComplete = () => {
      // Refresh wallet info
      fetchCircleDetails();
      fetchCustodyWalletSuiBalance();
      fetchCustodyWalletUsdcBalance();
    };

    // Function to refresh all balances
    const refreshAllBalances = () => {
      fetchCustodyWalletSuiBalance();
      fetchCustodyWalletUsdcBalance();
    };
    
    return (
      <div className="bg-white rounded-lg shadow-md overflow-hidden">
        <div className="bg-blue-50 px-4 py-3 border-b border-blue-100">
          <h3 className="text-lg font-semibold text-blue-800">Stablecoin Auto-Swap Settings</h3>
          <p className="text-sm text-blue-600">Configure automatic conversion of SUI to stablecoins to protect from market volatility</p>
        </div>
        
        <div className="p-4">
          {!circle.custody?.walletId ? (
            <div className="text-center p-4 text-gray-500">
              <p>Custody wallet information not available</p>
            </div>
          ) : (
            <div className="space-y-6">
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <h4 className="font-medium text-gray-800">Auto-Swap Funds</h4>
                    <p className="text-sm text-gray-500">Automatically convert SUI to stablecoins when received</p>
                  </div>
                  <div className="flex items-center">
                    <button
                      type="button"
                      onClick={handleToggleAutoSwap}
                      disabled={isConfiguring}
                      className={`relative inline-flex h-6 w-11 items-center rounded-full ${isEnabled ? 'bg-blue-600' : 'bg-gray-200'} ${isConfiguring ? 'opacity-50 cursor-not-allowed' : ''}`}
                    >
                      <span className="sr-only">Enable auto-swap</span>
                      <span 
                        className={`inline-block h-4 w-4 transform rounded-full bg-white transition ${isEnabled ? 'translate-x-6' : 'translate-x-1'}`} 
                      />
                    </button>
                  </div>
                </div>
                
                <div className="bg-yellow-50 p-3 rounded-lg border border-yellow-200">
                  <p className="text-sm text-yellow-700">
                    <strong>Note:</strong> When auto-swap is enabled, all members contributing to this circle will 
                    have the option to use DEX swaps for their contributions. Additional DEX settings (coin type, 
                    slippage, etc.) are configured by each member individually.
                  </p>
                </div>
                
                {circle.custody && (
                  <div className="mt-4 border-t border-gray-100 pt-4">
                    <div className="flex justify-between items-center mb-3">
                      <h5 className="font-medium text-gray-700">Wallet Balances</h5>
                      <button 
                        onClick={refreshAllBalances}
                        disabled={fetchingSuiBalance || fetchingUsdcBalance}
                        className="text-xs bg-indigo-50 hover:bg-indigo-100 text-indigo-600 py-1 px-2 rounded flex items-center transition-colors disabled:opacity-50"
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

                    {/* SUI Balance Section */}
                    <div className="space-y-4">
                      <div className="p-3 bg-gray-50 rounded-lg">
                        <div className="flex justify-between items-center mb-2">
                          <p className="text-xs text-gray-500 font-medium">SUI</p>
                          {fetchingSuiBalance ? (
                            <span className="text-xs text-gray-400">Updating...</span>
                          ) : (
                            <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">
                              Total: {circle.custody.suiBalance > 0 ? circle.custody.suiBalance.toFixed(6) : '0'} SUI
                            </span>
                          )}
                        </div>
                        
                        {!fetchingSuiBalance && ((suiContributionBalance !== null && suiContributionBalance > 0) || 
                                               (suiSecurityDepositBalance !== null && suiSecurityDepositBalance > 0)) && (
                          <div className="space-y-2">
                            {suiContributionBalance !== null && suiContributionBalance > 0 && (
                              <div className="flex items-center">
                                <div className="w-3 h-3 bg-green-300 rounded-sm mr-2"></div>
                                <span className="text-sm text-gray-700">
                                  {suiContributionBalance.toFixed(6)} SUI
                                </span>
                                <span className="ml-2 px-1.5 py-0.5 bg-green-100 text-green-800 text-xs font-medium rounded-full">
                                  Contributions
                                </span>
                              </div>
                            )}
                            
                            {suiSecurityDepositBalance !== null && suiSecurityDepositBalance > 0 && (
                              <div className="flex items-center">
                                <div className="w-3 h-3 bg-amber-300 rounded-sm mr-2"></div>
                                <span className="text-sm text-gray-700">
                                  {suiSecurityDepositBalance.toFixed(6)} SUI
                                </span>
                                <span className="ml-2 px-1.5 py-0.5 bg-amber-100 text-amber-800 text-xs font-medium rounded-full">
                                  Security Deposits
                                </span>
                              </div>
                            )}
                          </div>
                        )}
                        
                        {!fetchingSuiBalance && (suiContributionBalance === null || suiContributionBalance === 0) && 
                          (suiSecurityDepositBalance === null || suiSecurityDepositBalance === 0) && (
                          <p className="text-sm text-gray-500 mt-1">No SUI balances available</p>
                        )}
                      </div>
                      
                      {/* USDC Balance Section */}
                      <div className="p-3 bg-gray-50 rounded-lg">
                        <div className="flex justify-between items-center mb-2">
                          <p className="text-xs text-gray-500 font-medium">USDC</p>
                          {fetchingUsdcBalance ? (
                            <span className="text-xs text-gray-400">Updating...</span>
                          ) : (
                            <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">
                              Total: ${(circle.custody.stablecoinBalance && circle.custody.stablecoinBalance > 0) ? circle.custody.stablecoinBalance.toFixed(2) : '0.00'} USDC
                            </span>
                          )}
                        </div>
                        
                        {!fetchingUsdcBalance && ((usdcContributionBalance !== null && usdcContributionBalance > 0) || 
                                               (usdcSecurityDepositBalance !== null && usdcSecurityDepositBalance > 0)) && (
                          <div className="space-y-2">
                            {usdcContributionBalance !== null && usdcContributionBalance > 0 && (
                              <div className="flex items-center">
                                <div className="w-3 h-3 bg-green-300 rounded-sm mr-2"></div>
                                <span className="text-sm text-gray-700">
                                  ${usdcContributionBalance.toFixed(2)} USDC
                                </span>
                                <span className="ml-2 px-1.5 py-0.5 bg-green-100 text-green-800 text-xs font-medium rounded-full">
                                  Contributions
                                </span>
                              </div>
                            )}
                            
                            {usdcSecurityDepositBalance !== null && usdcSecurityDepositBalance > 0 && (
                              <div className="flex items-center">
                                <div className="w-3 h-3 bg-amber-300 rounded-sm mr-2"></div>
                                <span className="text-sm text-gray-700">
                                  ${usdcSecurityDepositBalance.toFixed(2)} USDC
                                </span>
                                <span className="ml-2 px-1.5 py-0.5 bg-amber-100 text-amber-800 text-xs font-medium rounded-full">
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
                      </div>
                    </div>
                  </div>
                )}
              </div>

              <div className="border-t border-gray-200 pt-4">
                <div className="flex justify-between items-center mb-4">
                  <h4 className="font-medium text-gray-800">Manual Swap</h4>
                  <button
                    type="button"
                    onClick={() => setShowSwapForm(!showSwapForm)}
                    className="px-4 py-2 text-sm font-medium text-blue-700 bg-blue-100 rounded-md hover:bg-blue-200"
                  >
                    {showSwapForm ? 'Hide Swap Form' : 'Show Swap Form'}
                  </button>
                </div>
                
                {showSwapForm && circle.custody?.walletId && (
                  <StablecoinSwapForm 
                    walletId={circle.custody.walletId} 
                    circleId={circle.id}
                    contributionAmount={circle.contributionAmount}
                    onSwapComplete={handleSwapComplete}
                  />
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
          const response = await fetch('/api/zkLogin', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'activateCircle',
              account,
              circleId: circle.id
            }),
          });
          
          const result = await response.json();
          
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
          
          // Update local state
          setCircle(prevCircle => prevCircle ? { ...prevCircle, isActive: true } : null);
          
          // Show success message with the transaction digest
          toast.success(`Circle activated successfully! Transaction: ${result.digest.slice(0,8)}...`, { id: toastId + '-success' });
          
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
              normalizedOrder
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
  }, [members]);

  // Add this shuffle function after the saveRotationOrder function
  const shuffleRotationOrder = () => {
    if (!members.length) return;
    
    // Create a copy of the members array
    const shuffledMembers = [...members];
    
    // Fisher-Yates shuffle algorithm
    for (let i = shuffledMembers.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffledMembers[i], shuffledMembers[j]] = [shuffledMembers[j], shuffledMembers[i]];
    }
    
    // Extract addresses in the new order
    const newOrder = shuffledMembers.map(member => member.address);
    
    // Save the new order
    saveRotationOrder(newOrder);
  };

  // Update the Activate Circle button disabled logic
  const canActivate = useMemo(() => {
    // 1. Check if we have a circle object
    if (!circle) return false;
    
    // 2. Check if all members have paid their security deposits
    const depositsPaid = allDepositsPaid === true;
    
    // 3. Check if rotation order is properly set for all members
    const rotationSet = isRotationOrderSet(members);
    
    // 4. Circle should have at least the minimum required members (3 according to Move contract)
    const hasMinimumMembers = circle.currentMembers >= 3;
    
    // 5. Circle should not already be active
    const notAlreadyActive = !circle.isActive;
    
    // Log conditions for debugging
    console.log('Circle activation conditions:', {
      depositsPaid,
      rotationSet,
      hasMinimumMembers,
      notAlreadyActive,
      currentMembers: circle.currentMembers,
    });
    
    // All conditions must be true
    return depositsPaid && rotationSet && hasMinimumMembers && notAlreadyActive;
  }, [circle, allDepositsPaid, members]);

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
          
          const response = await fetch('/api/zkLogin', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'adminSetMaxMembers',
              account,
              circleId: circle.id,
              newMaxMembers: maxMembersNum
            }),
          });
          
          const result = await response.json();
          
          if (!response.ok) {
            console.error('Failed to update max members:', result);
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
    const client = new SuiClient({ url: getJsonRpcUrl() });
    let currentCycleFromServer = 0;
    let determinedActiveMembersInRotation: string[] = [];
    let currentPositionInRotation: number | null = null;
    let memberAtCurrentPosition: string | null = null;

    try {
      // Check for payout events first, to detect if a cycle has just advanced
      const payoutEvents = await client.queryEvents({
        query: { MoveEventType: `${PACKAGE_ID}::njangi_payments::PayoutProcessed` },
        limit: 20
      });
      
      // Find the most recent payout event for this circle
      const recentPayoutForCircle = payoutEvents.data
        .filter(event => {
          const parsedJson = event.parsedJson as { circle_id?: string };
          return parsedJson?.circle_id === circle.id;
        })
        .sort((a, b) => {
          // Sort by timestamp (newest first)
          return (Number(b.timestampMs) || 0) - (Number(a.timestampMs) || 0);
        })[0]; // Take the first (most recent) one
        
      if (recentPayoutForCircle) {
        console.log('[ContributionStatus] Found recent payout event:', recentPayoutForCircle);
      }

      const circleObjectData = await client.getObject({ id: circle.id, options: { showContent: true } });
      if (circleObjectData.data?.content && 'fields' in circleObjectData.data.content) {
        const cFields = circleObjectData.data.content.fields as Record<string, SuiFieldValue>;
        currentCycleFromServer = cFields.current_cycle ? Number(cFields.current_cycle) : 0;
        currentPositionInRotation = cFields.current_position ? Number(cFields.current_position) : null;
        console.log('[ContributionStatus] Current cycle from server:', currentCycleFromServer);
        console.log('[ContributionStatus] Current position in rotation:', currentPositionInRotation);

        const rotationOrderFromFields = cFields.rotation_order as string[];
        if (Array.isArray(rotationOrderFromFields) && rotationOrderFromFields.length > 0) {
          const membersMap = new Map(members.map(m => [m.address, m]));
          determinedActiveMembersInRotation = rotationOrderFromFields.filter(addr => {
            if (addr && addr !== '0x0') {
              const memberDetail = membersMap.get(addr);
              // Member must be in current member list, active, and have deposit paid
              return memberDetail && memberDetail.status === 'active' && memberDetail.depositPaid;
            }
            return false;
          });
          console.log('[ContributionStatus] Active members from rotation_order:', determinedActiveMembersInRotation);
          
          // Get the member at current position if available
          if (currentPositionInRotation !== null && 
              currentPositionInRotation >= 0 && 
              currentPositionInRotation < rotationOrderFromFields.length) {
            memberAtCurrentPosition = rotationOrderFromFields[currentPositionInRotation];
            console.log('[ContributionStatus] Member at current position:', memberAtCurrentPosition);
          }
        }
      }

      // Fallback if rotation order processing didn't yield results but we have members
      if (determinedActiveMembersInRotation.length === 0 && members.length > 0) {
        determinedActiveMembersInRotation = members
          .filter(m => m.status === 'active' && m.depositPaid)
          .map(m => m.address);
        console.log('[ContributionStatus] Active members from members list (fallback):', determinedActiveMembersInRotation);
      }
      
      if (determinedActiveMembersInRotation.length === 0 && circle.currentMembers > 0) {
        console.warn("[ContributionStatus] Could not determine active members in rotation. Payout trigger UI might be inaccurate.");
      }

      const uniqueContributors = new Set<string>();
      if (currentCycleFromServer > 0) {
        const eventFetchPromises = [
          client.queryEvents({ query: { MoveEventType: `${PACKAGE_ID}::njangi_payments::ContributionMade` }, limit: 250 }),
          client.queryEvents({ query: { MoveEventType: `${PACKAGE_ID}::njangi_circles::StablecoinContributionMade` }, limit: 250 })
        ];
        const eventResults = await Promise.all(eventFetchPromises);

        // If we have a recent payout event, only consider contributions after that event's timestamp
        const payoutTimestamp = recentPayoutForCircle ? Number(recentPayoutForCircle.timestampMs) : 0;

        eventResults.forEach((result, index) => {
          const eventType = index === 0 ? 'ContributionMade' : 'StablecoinContributionMade';
          result.data.forEach(event => {
            const data = event.parsedJson as { circle_id?: string; member?: string; cycle?: string | number; };
            const eventCycle = typeof data.cycle === 'string' ? parseInt(data.cycle, 10) : data.cycle;
            const eventTimestamp = Number(event.timestampMs || 0);
            
            // Only count contributions that match the current cycle AND 
            // (if there was a recent payout) happened after the payout event
            if (data.circle_id === circle.id && 
                data.member && 
                eventCycle === currentCycleFromServer &&
                (!payoutTimestamp || eventTimestamp > payoutTimestamp)) {
              
              if (determinedActiveMembersInRotation.includes(data.member)) { // Only count contributions from active members in rotation
                 uniqueContributors.add(data.member);
              }
            }
          });
          console.log(`[ContributionStatus] ${eventType} events processed. Contributors this cycle: ${uniqueContributors.size}`);
        });
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
  }, [circle, members, PACKAGE_ID]); // Added PACKAGE_ID

  useEffect(() => {
    if (circle && circle.isActive && members.length > 0) {
      fetchContributionStatus();
    }
  }, [circle, members, fetchContributionStatus]); // Ensure members is a dependency too

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

  if (!isAuthenticated || !account) {
    return null;
  }

  // Helper to get activation requirement message
  const getActivationRequirementMessage = () => {
    if (!circle) return "Circle data not loaded.";
    
    if (circle.isActive) {
      return "Circle is already active.";
    }
    
    if (circle.currentMembers < 3) {
      return `Need at least 3 members to activate (currently have ${circle.currentMembers}).`;
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
    
    return "All requirements met! Circle can be activated.";
  };

  // Add a function to resume the cycle
  const handleResumeCycle = async () => {
    if (!circle || !circle.paused) return;
    
    // Show confirmation modal first
    setConfirmationModal({
      isOpen: true,
      title: 'Resume Circle Cycle',
      message: (
        <div>
          <p>Cycle {circle.currentCycle} has completed. Would you like to:</p>
          <ul className="mt-2 list-disc pl-5 text-sm">
            <li>Resume to the next cycle</li>
            <li>Allow members to make contributions for the new cycle</li>
          </ul>
          <p className="mt-2">Are you sure you want to proceed?</p>
        </div>
      ),
      confirmText: 'Resume Cycle',
      cancelText: 'Cancel',
      confirmButtonVariant: 'primary',
      onConfirm: async () => {
        const toastId = 'resume-cycle';
        try {
          toast.loading('Resuming cycle...', { id: toastId });
          
          if (!account) {
            toast.error('User account not available. Please log in again.', { id: toastId });
            return;
          }
          
          // Call the backend API
          const response = await fetch('/api/zkLogin', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'resumeCycle',
              account,
              circleId: circle.id
            }),
          });
          
          const result = await response.json();
          
          if (!response.ok) {
            console.error('Failed to resume cycle:', result);
            const errorDetail = parseMoveError(result.error || '');
            toast.error(errorDetail.message, { id: toastId });
            return;
          }
          
          // Update local state
          setCircle(prevCircle => prevCircle ? { ...prevCircle, paused: false } : null);
          
          // Refresh circle details
          await fetchCircleDetails();
          
          toast.success('Successfully resumed to the next cycle', { id: toastId });
        } catch (error) {
          console.error('Error resuming cycle:', error);
          toast.error('Failed to resume cycle', { id: toastId });
        }
      }
    });
  };

  // Function to handle security deposit payout for multiple members
  const handleSecurityDepositPayout = async (memberAddresses: string[], coinType: 'sui' | 'stablecoin') => {
    if (!circle || !circle.id || !account) {
      toast.error('Missing circle information or account.');
      return;
    }

    if (!circle.custody?.walletId) {
      toast.error('Custody wallet information is not available.');
      return;
    }

    if (!circle.paused) {
      toast.error('Circle must be paused to pay out security deposits.');
      return;
    }

    if (memberAddresses.length === 0) {
      toast.error('No members selected for payout.');
      return;
    }

    setIsProcessingPayout(true);
    const toastId = 'security-deposit-payout';
    
    try {
      toast.loading(`Processing security deposits payout for ${memberAddresses.length} member(s)...`, { id: toastId });
      
      const zkLoginClient = new ZkLoginClient();
      setPayoutProgress({current: 0, total: memberAddresses.length});
      
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
          
          let result;
          
          if (coinType === 'sui') {
            result = await zkLoginClient.payoutSecurityDepositSui(
              account,
              circle.id,
              normalizedAddress,
              circle.custody.walletId
            );
          } else {
            result = await zkLoginClient.payoutSecurityDepositStablecoin(
              account,
              circle.id,
              normalizedAddress,
              circle.custody.walletId
            );
          }
          
          console.log(`Security deposit payout transaction executed for ${shortenAddress(memberAddress)}. Digest: ${result.digest}`);
          
          // Add to paid out set for immediate UI update in modal
          setPaidOutInCurrentSessionMembers(prev => new Set(prev).add(memberAddress));
          
        } catch (memberError) {
          console.error(`Error paying out security deposit for ${shortenAddress(memberAddress)}:`, memberError);
          toast.error(`Failed to process payout for ${shortenAddress(memberAddress)}: ${memberError instanceof Error ? memberError.message : 'Unknown error'}`, 
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
      
      // Show success message
      toast.success(`Completed security deposit payouts: ${payoutProgress.current}/${memberAddresses.length} successful`, { id: toastId });
      
      // Close the modal and reset selections
      setShowPayoutDepositModal(false);
      setSelectedMembersForPayout(new Set());
      // setPaidOutInCurrentSessionMembers(new Set()); // Clear for next modal opening if desired, or let fetchCircleDetails handle it
      
    } catch (error) {
      console.error('Error processing multiple security deposit payouts:', error);
      
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
    if (!showPayoutDepositModal) return null;
    
    // Filter to only show members with paid deposits AND not paid out in current session
    const eligibleMembers = members.filter(member => member.depositPaid && !paidOutInCurrentSessionMembers.has(member.address));
    const alreadyPaidMembers = members.filter(member => !member.depositPaid || paidOutInCurrentSessionMembers.has(member.address));
    
    return (
      <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
        <div className="bg-white rounded-xl shadow-xl max-w-2xl w-full max-h-[90vh] overflow-hidden flex flex-col">
          <div className="bg-blue-600 text-white px-6 py-4">
            <h2 className="text-xl font-semibold">Pay Out Security Deposits</h2>
            <p className="text-blue-100 text-sm mt-1">
              Return security deposits to members who wish to exit the circle
            </p>
          </div>
          
          <div className="px-6 py-4 flex-grow overflow-y-auto">
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
                  Select one or more members to return their security deposits. This action cannot be undone.
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
                        onClick={() => {
                          const newSelected = new Set(selectedMembersForPayout);
                          if (newSelected.has(member.address)) {
                            newSelected.delete(member.address);
                          } else {
                            newSelected.add(member.address);
                          }
                          setSelectedMembersForPayout(newSelected);
                        }}
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
                                {member.address === circle?.admin ? 'Admin' : `Position: ${member.position !== undefined ? member.position + 1 : 'Not set'}`}
                              </p>
                            </div>
                          </div>
                          <div className="text-sm font-medium text-gray-900">
                            {circle?.securityDeposit.toFixed(4)} SUI
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
                              {member.address === circle?.admin ? 'Admin' : `Position: ${member.position !== undefined ? member.position + 1 : 'Not set'}`}
                            </p>
                          </div>
                        </div>
                        <div className="text-sm font-medium text-green-600">
                          Paid Out
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
                
                {/* Coin type selection */}
                {selectedMembersForPayout.size > 0 && (
                  <div className="mt-6 border-t border-gray-200 pt-4">
                    <p className="font-medium text-gray-800 mb-3">Select payout coin type:</p>
                    <div className="flex space-x-3">
                      <button
                        className={`px-4 py-2 rounded-md border ${
                          payoutCoinType === 'sui' 
                            ? 'bg-blue-50 border-blue-500 text-blue-700' 
                            : 'border-gray-300 text-gray-700 hover:bg-gray-50'
                        }`}
                        onClick={() => setPayoutCoinType('sui')}
                        type="button"
                      >
                        SUI
                      </button>
                      <button
                        className={`px-4 py-2 rounded-md border ${
                          payoutCoinType === 'stablecoin' 
                            ? 'bg-blue-50 border-blue-500 text-blue-700' 
                            : 'border-gray-300 text-gray-700 hover:bg-gray-50'
                        }`}
                        onClick={() => setPayoutCoinType('stablecoin')}
                        disabled={!circle?.custody?.stablecoinEnabled}
                        type="button"
                      >
                        Stablecoin (USDC)
                      </button>
                    </div>
                    {payoutCoinType === 'stablecoin' && !circle?.custody?.stablecoinEnabled && (
                      <p className="mt-2 text-sm text-amber-600">
                        Stablecoin payouts are not enabled for this circle.
                      </p>
                    )}
                  </div>
                )}
                
                {/* Progress indicator for multi-payout */}
                {isProcessingPayout && payoutProgress.total > 0 && (
                  <div className="mt-4 border-t border-gray-200 pt-4">
                    <div className="space-y-2">
                      <div className="flex justify-between items-center">
                        <span className="text-sm font-medium text-gray-700">
                          Processing payouts: {payoutProgress.current}/{payoutProgress.total}
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
          
          <div className="px-6 py-4 bg-gray-50 border-t border-gray-200 flex justify-end space-x-3">
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
                selectedMembersForPayout.size === 0 || isProcessingPayout || 
                // Disable if all selected members are already paid out (though they shouldn't be selectable)
                (selectedMembersForPayout.size > 0 && Array.from(selectedMembersForPayout).every(addr => paidOutInCurrentSessionMembers.has(addr) || !members.find(m=>m.address === addr)?.depositPaid))
                  ? 'bg-gray-400 cursor-not-allowed' 
                  : 'bg-blue-600 hover:bg-blue-700'
              }`}
              disabled={selectedMembersForPayout.size === 0 || isProcessingPayout || (selectedMembersForPayout.size > 0 && Array.from(selectedMembersForPayout).every(addr => paidOutInCurrentSessionMembers.has(addr) || !members.find(m=>m.address === addr)?.depositPaid))}
              onClick={() => {
                const selectedAddresses = Array.from(selectedMembersForPayout).filter(
                  addr => !(paidOutInCurrentSessionMembers.has(addr) || !members.find(m=>m.address === addr)?.depositPaid)
                );
                if (selectedAddresses.length > 0) {
                  handleSecurityDepositPayout(selectedAddresses, payoutCoinType);
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
                `Pay Out ${selectedMembersForPayout.size} Deposits`
              ) : (
                'Pay Out Deposit'
              )}
            </button>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <main className="max-w-7xl mx-auto py-4 sm:py-6 px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between items-center mb-4 sm:mb-6 flex-wrap gap-3">
          <button
            onClick={() => router.push('/dashboard')}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 sm:px-4 sm:py-2 rounded-full bg-white border border-gray-200 hover:bg-gray-50 hover:border-gray-300 transition-all shadow-sm text-xs sm:text-sm text-gray-700 font-medium"
          >
            <ArrowLeft className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
            Back to Dashboard
          </button>
          <h1 className="text-lg sm:text-xl font-semibold text-blue-600">Manage Circle</h1>
        </div>

        <div className="bg-white shadow-md rounded-xl overflow-hidden border border-gray-100">
          <div className="p-4 sm:p-6 border-b border-gray-200 bg-gradient-to-r from-blue-50 to-indigo-50">
            <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3 mb-2 sm:mb-0">
              <h2 className="text-xl sm:text-2xl font-bold text-gray-900 flex flex-wrap items-center gap-2">
                {!loading && circle ? circle.name : 'Manage Circle'}
                {!loading && circle && (
                  <span className="text-xs sm:text-sm font-normal bg-blue-100 text-blue-800 py-0.5 px-2 rounded-full">
                    {circle.currentMembers}/{circle.maxMembers} Members
                  </span>
                )}
              </h2>
              {!loading && circle && (
                <div className="flex items-center space-x-2 text-xs sm:text-sm">
                  <span className="text-gray-500 bg-gray-100 py-1 px-2 rounded-md truncate max-w-[120px] sm:max-w-none">{shortenId(id as string)}</span>
                  <Tooltip.Provider>
                    <Tooltip.Root>
                      <Tooltip.Trigger asChild>
                        <button
                          onClick={() => copyToClipboard(id as string, 'id')}
                          className={`text-gray-500 hover:text-blue-600 p-1.5 rounded-full hover:bg-blue-50 transition-colors duration-200 ${copiedId ? 'text-green-500 bg-green-50' : ''}`}
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
                          className="text-gray-500 hover:text-blue-600 p-1.5 rounded-full hover:bg-blue-50 transition-colors duration-200"
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
            {loading ? (
              <ManageCircleSkeleton />
            ) : circle ? (
              <div className="py-4 space-y-6 sm:space-y-8">
                {/* Circle Details */}
                <div className="px-1 sm:px-2">
                  <h3 className="text-lg font-medium text-gray-900 mb-4 border-l-4 border-blue-500 pl-3 flex justify-between items-center">
                    <span>Circle Details</span>
                    {circle.isActive && (
                      <button
                        onClick={() => fetchContributionStatus()}
                        disabled={loadingContributions}
                        className="text-xs bg-blue-50 hover:bg-blue-100 text-blue-600 py-1 px-2 rounded flex items-center transition-colors"
                      >
                        {loadingContributions ? (
                          <svg className="animate-spin -ml-1 mr-1 h-3 w-3 text-blue-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                          </svg>
                        ) : (
                          <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                          </svg>
                        )}
                        {loadingContributions ? "Refreshing..." : "Refresh Status"}
                      </button>
                    )}
                  </h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 sm:gap-6">
                    <div className="bg-gray-50 p-3 sm:p-4 rounded-lg shadow-sm">
                      <p className="text-sm text-gray-500 mb-1">Circle Name</p>
                      <p className="text-lg font-medium">{circle.name}</p>
                    </div>
                    
                    <div className="bg-gray-50 p-3 sm:p-4 rounded-lg shadow-sm">
                      <p className="text-sm text-gray-500 mb-1">Status</p>
                      <div className="flex items-center">
                        <span className={`mr-2 h-2.5 w-2.5 rounded-full ${circle.isActive ? 'bg-green-500' : 'bg-amber-500'}`}></span>
                        <p className="text-lg font-medium">
                          {circle.isActive ? 'Active' : 'Not Active'}
                        </p>
                      </div>
                    </div>

                    {circle.isActive && (
                      <div className="bg-gray-50 p-3 sm:p-4 rounded-lg shadow-sm md:col-span-2">
                        <p className="text-sm text-gray-500 mb-1">Contribution Progress</p>
                        <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-6">
                          <div className="flex-1">
                            <div className="flex items-center justify-between mb-1">
                              <p className="text-sm font-medium">
                                Cycle {contributionStatus.currentCycle}
                                {typeof contributionStatus.currentPosition === 'number' && contributionStatus.totalActiveInRotation > 0 && (
                                  <span className="text-gray-600 ml-1">
                                    (Position {(contributionStatus.currentPosition + 1)} of {contributionStatus.totalActiveInRotation})
                                  </span>
                                )}
                              </p>
                              <p className="text-xs text-gray-600">
                                {loadingContributions ? 'Loading...' : (
                                  contributionStatus.contributedMembers.size > 0 
                                    ? `${contributionStatus.contributedMembers.size}/${contributionStatus.totalActiveInRotation - 1} contributed` 
                                    : 'No contributions yet'
                                )}
                              </p>
                            </div>
                            <div className="w-full bg-gray-200 rounded-full h-2.5">
                              <div 
                                className={`${allContributionsMadeThisCycle ? 'bg-green-500' : 'bg-blue-500'} h-2.5 rounded-full transition-all duration-500`} 
                                style={{ 
                                  width: `${loadingContributions ? '0' : contributionStatus.totalActiveInRotation <= 1 
                                    ? '0' 
                                    : `${(contributionStatus.contributedMembers.size / (contributionStatus.totalActiveInRotation - 1)) * 100}%`}`
                                }}
                              ></div>
                            </div>
                          </div>
                          
                          <div className="flex flex-shrink-0 items-center gap-2">
                            <p className="text-sm">Next Payout:</p>
                            <span className="text-sm font-medium">
                              {formatNextPayoutDate(circle.nextPayoutTime)}
                            </span>
                          </div>
                        </div>
                      </div>
                    )}
                    
                    <div className="bg-gray-50 p-3 sm:p-4 rounded-lg shadow-sm">
                      <p className="text-sm text-gray-500 mb-1">Contribution Amount</p>
                      <CurrencyDisplay usd={circle.contributionAmountUsd} sui={circle.contributionAmount} className="font-medium" />
                    </div>
                    
                    <div className="bg-gray-50 p-3 sm:p-4 rounded-lg shadow-sm">
                      <p className="text-sm text-gray-500 mb-1">Security Deposit</p>
                      <CurrencyDisplay usd={circle.securityDepositUsd} sui={circle.securityDeposit} className="font-medium" />
                    </div>
                    
                    <div className="bg-gray-50 p-3 sm:p-4 rounded-lg shadow-sm">
                      <p className="text-sm text-gray-500 mb-1">
                        {circle.isActive ? 'Next Payout' : 'Potential Next Payout'}
                      </p>
                      <p className="text-base sm:text-lg font-medium">
                        {circle.isActive 
                          ? formatNextPayoutDate(circle.nextPayoutTime)
                          : formatNextPayoutDate(calculatePotentialNextPayoutDate(circle.cycleLength, circle.cycleDay))}
                      </p>
                      {!circle.isActive && (
                        <p className="text-xs text-blue-600 mt-1">
                          <span className="font-bold">Estimate</span> if circle activated now
                        </p>
                      )}
                    </div>
                     {/* Maximum Members - Interactive Edition */}
                     <div className="bg-gray-50 p-4 rounded-lg shadow-sm col-span-1 md:col-span-2">
                          <div className="flex justify-between items-center">
                            <div className="w-full">
                              <p className="text-sm text-gray-500 mb-1">Maximum Members</p>
                              {isEditingMaxMembers ? (
                                <div className="space-y-6 mt-3 w-full">
                                  {/* Visual member count indicators with animation */}
                                  <div className={`flex flex-wrap gap-2 mb-4 transition-opacity duration-300 ${animateMembers ? 'animate-pulse' : ''}`}>
                                    {[...Array(Number(newMaxMembersValue))].map((_, i) => (
                                      <div 
                                        key={i} 
                                        className={`w-8 h-8 rounded-full flex items-center justify-center ${
                                          i < circle.currentMembers 
                                            ? 'bg-blue-100 text-blue-600 border-2 border-blue-300' 
                                            : 'bg-gray-100 text-gray-400 border border-gray-300'
                                        } ${animateMembers ? 'animate-bounce' : ''}`}
                                        style={{ animationDelay: `${i * 50}ms` }}
                                      >
                                        <Users size={14} />
                                      </div>
                                    ))}
                                  </div>
                                  
                                  {/* Slider with current value display */}
                                  <div className="space-y-2">
                                    <div className="flex justify-between items-center">
                                      <span className="text-sm font-medium text-gray-700">
                                        {newMaxMembersValue} members maximum
                                      </span>
                                      <span className={`px-2 py-1 text-xs font-medium rounded-full ${
                                        getCircleSizeCategory(Number(newMaxMembersValue)) === 'small' 
                                          ? 'bg-green-100 text-green-800' 
                                          : getCircleSizeCategory(Number(newMaxMembersValue)) === 'medium'
                                            ? 'bg-blue-100 text-blue-800'
                                            : 'bg-purple-100 text-purple-800'
                                      }`}>
                                        {getCircleSizeCategory(Number(newMaxMembersValue)) === 'small' 
                                          ? 'Small Circle' 
                                          : getCircleSizeCategory(Number(newMaxMembersValue)) === 'medium'
                                            ? 'Medium Circle'
                                            : 'Large Circle'}
                                      </span>
                                    </div>
                                    
                                    <div className="relative">
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
                                        className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-600"
                                      />
                                      
                                      {/* Tick marks for recommended ranges */}
                                      <div className="flex justify-between text-xs text-gray-600 px-2 mt-1">
                                        <span>Min: {Math.max(3, circle.currentMembers)}</span>
                                        <span>Max: 20</span>
                                      </div>
                                    </div>
                                  </div>
                                  
                                  {/* Recommendation based on selection */}
                                  <div className={`p-3 rounded-lg text-sm transition-colors ${
                                    getCircleSizeCategory(Number(newMaxMembersValue)) === 'small' 
                                      ? 'bg-green-50 text-green-800 border border-green-200' 
                                      : getCircleSizeCategory(Number(newMaxMembersValue)) === 'medium'
                                        ? 'bg-blue-50 text-blue-800 border border-blue-200'
                                        : 'bg-purple-50 text-purple-800 border border-purple-200'
                                  }`}>
                                    <p className="font-medium">
                                      {recommendedRanges[getCircleSizeCategory(Number(newMaxMembersValue))].label}
                                    </p>
                                    <p className="mt-1">
                                      {recommendedRanges[getCircleSizeCategory(Number(newMaxMembersValue))].description}
                                    </p>
                                  </div>
                                  
                                  {/* Action buttons */}
                                  <div className="flex space-x-3 justify-end">
                                    <button
                                      onClick={() => {
                                        setIsEditingMaxMembers(false);
                                        setNewMaxMembersValue(circle.maxMembers);
                                      }}
                                      disabled={isSavingMaxMembers}
                                      className="px-4 py-2 border border-gray-300 text-gray-700 rounded-md hover:bg-gray-50 transition-colors text-sm"
                                    >
                                      Cancel
                                    </button>
                                    <button
                                      onClick={handleSaveMaxMembers}
                                      disabled={isSavingMaxMembers || Number(newMaxMembersValue) === circle.maxMembers}
                                      className={`px-4 py-2 rounded-md text-white text-sm transition-colors ${
                                        isSavingMaxMembers || Number(newMaxMembersValue) === circle.maxMembers
                                          ? 'bg-gray-400 cursor-not-allowed'
                                          : 'bg-blue-600 hover:bg-blue-700'
                                      }`}
                                    >
                                      {isSavingMaxMembers ? (
                                        <div className="flex items-center">
                                          <svg className="animate-spin h-4 w-4 mr-2 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                                          </svg>
                                          Saving...
                                        </div>
                                      ) : 'Save Changes'}
                                    </button>
                                  </div>
                                </div>
                              ) : (
                                <div className="flex items-center">
                                  <div className="flex items-center">
                                    <p className="text-lg font-medium">
                                      {circle.currentMembers} / {circle.maxMembers} members
                                    </p>
                                    <span className={`ml-2 px-2 py-0.5 text-xs font-medium rounded-full ${
                                      getCircleSizeCategory(circle.maxMembers) === 'small' 
                                        ? 'bg-green-100 text-green-800' 
                                        : getCircleSizeCategory(circle.maxMembers) === 'medium'
                                          ? 'bg-blue-100 text-blue-800'
                                          : 'bg-purple-100 text-purple-800'
                                    }`}>
                                      {getCircleSizeCategory(circle.maxMembers) === 'small' 
                                        ? 'Small Circle' 
                                        : getCircleSizeCategory(circle.maxMembers) === 'medium'
                                          ? 'Medium Circle'
                                          : 'Large Circle'}
                                    </span>
                                  </div>
                                  {!circle.isActive && (
                                    <button
                                      onClick={() => setIsEditingMaxMembers(true)}
                                      className="ml-3 bg-blue-50 hover:bg-blue-100 text-blue-600 py-1.5 px-3 rounded-md flex items-center transition-colors shadow-sm text-sm border border-blue-200"
                                    >
                                      <Edit3 size={14} className="mr-1.5" />
                                      Edit Max Capacity
                                    </button>
                                  )}
                                </div>
                              )}
                            </div>
                          </div>
                          {circle.isActive && (
                            <p className="text-xs text-gray-400 mt-1">Capacity cannot be changed for active circles.</p>
                          )}
                        </div>
                  </div>
                </div>
                
                {/* Add the paused status banner */}
                {circle.paused && (
                  <div className="mb-6 p-5 bg-amber-50 border-2 border-amber-300 rounded-lg">
                    <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
                      <div className="flex-1">
                        <h3 className="text-lg font-semibold text-amber-800 flex items-center">
                          <Pause className="mr-2 h-5 w-5" />
                          Circle Paused After Cycle Completion
                        </h3>
                        <p className="text-amber-700 mt-2">
                          The circle has been paused after completing cycle {circle.currentCycle}. As the admin, you can:
                        </p>
                        <ul className="list-disc pl-5 mt-2 text-sm text-amber-600 space-y-1">
                          <li>Pay out remaining security deposits to members who want to leave</li>
                          <li>Edit rotation order for the next cycle</li>
                          <li>Resume the circle to start the next cycle</li>
                        </ul>
                        <p className="mt-3 text-sm text-amber-700 font-medium bg-amber-100 p-2 rounded border border-amber-200 flex items-start">
                          <AlertTriangle className="mr-2 h-4 w-4 flex-shrink-0 mt-0.5" />
                          <span>
                            When you resume the circle, all members will need to pay a new security deposit for the next cycle.
                            Their deposit status will be reset, requiring them to make a new deposit before they can contribute.
                          </span>
                        </p>
                      </div>
                      <div className="flex flex-col gap-3 w-full sm:w-auto">
                        {/* Resume Cycle Button */}
                        <button
                          onClick={() => {
                            // Confirm before proceeding
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
                          className="w-full px-4 py-3 bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-600 hover:to-amber-700 text-white rounded-md shadow-sm transition-all flex items-center justify-center font-medium text-sm"
                        >
                          <CheckCircle className="mr-2 h-4 w-4" />
                          Resume Cycle
                        </button>
                        <button
                          onClick={() => setShowPayoutDepositModal(true)}
                          className="w-full px-4 py-3 bg-gradient-to-r from-blue-500 to-blue-600 hover:from-blue-600 hover:to-blue-700 text-white rounded-md shadow-sm transition-all flex items-center justify-center font-medium text-sm"
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                          </svg>
                          Pay Deposits
                        </button>
                        <button
                          onClick={fetchCircleDetails}
                          className="w-full px-4 py-3 bg-white hover:bg-gray-50 text-gray-700 rounded-md shadow-sm transition-all flex items-center justify-center font-medium border border-gray-300 text-sm"
                        >
                          <RefreshCw className="mr-2 h-4 w-4" />
                          Refresh
                        </button>
                      </div>
                    </div>
                  </div>
                )}
                
                {/* Members Management */}
                <div className="px-1 sm:px-2">
                  <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2 mb-4">
                    <h3 className="text-lg font-medium text-gray-900 border-l-4 border-blue-500 pl-3">Members</h3>
                    <div className="flex items-center gap-2">
                      {circle && circle.isActive && contributionStatus.currentCycle > 0 && (
                        <div className="bg-blue-50 border border-blue-100 rounded-lg px-3 py-1.5 mr-2">
                          <p className="text-xs text-blue-700 mb-1">
                            Contribution Progress (Cycle {contributionStatus.currentCycle})
                          </p>
                          <div className="flex items-center gap-2">
                            <div className="w-32 bg-gray-200 rounded-full h-2.5">
                              <div 
                                className="bg-blue-600 h-2.5 rounded-full" 
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
                            <span className="text-xs font-medium text-blue-800">
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
                              <div className="bg-green-100 text-green-800 text-xs font-medium rounded-full px-2 py-0.5 flex items-center">
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
                                  className={`px-3 py-1.5 rounded-md text-xs font-medium flex items-center ${
                                      circle?.isActive && !circle?.paused 
                                      ? 'bg-gray-100 text-gray-500 cursor-not-allowed' 
                                      : 'bg-blue-50 text-blue-600 hover:bg-blue-100 transition-colors'
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
                    <div className="mb-4 p-3 bg-yellow-50 border border-yellow-200 rounded-md text-yellow-700">
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
                        <div className="mb-4 p-3 bg-yellow-50 border border-yellow-200 rounded-md text-yellow-700">
                          <p className="font-medium flex items-center text-sm">
                            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 mr-2" viewBox="0 0 20 20" fill="currentColor">
                              <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
                            </svg>
                            Setting rotation order is required before circle activation
                          </p>
                          <p className="text-xs mt-1">The rotation order determines who receives payouts in which order.</p>
                        </div>
                      )}
                      <div className="flex justify-end mb-4">
                        <button
                          onClick={shuffleRotationOrder}
                          className="px-4 py-2 bg-indigo-50 text-indigo-600 rounded-md flex items-center hover:bg-indigo-100 transition-colors text-sm"
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                          </svg>
                          Shuffle Order
                        </button>
                      </div>
                      <RotationOrderList 
                        members={members}
                        adminAddress={circle.admin}
                        shortenAddress={shortenAddress}
                        onSaveOrder={saveRotationOrder}
                        onCancelEdit={() => setIsEditingRotation(false)}
                      />
                    </div>
                  ) : (
                    <div className="overflow-x-auto -mx-4 sm:mx-0">
                      <div className="inline-block min-w-full align-middle">
                        <div className="overflow-hidden shadow-sm rounded-lg border border-gray-200">
                          <table className="min-w-full divide-y divide-gray-200">
                            <thead className="bg-gray-50">
                              <tr>
                                <th scope="col" className="py-3.5 pl-4 pr-3 text-left text-xs sm:text-sm font-semibold text-gray-900 sm:pl-6">
                                  Address
                                </th>
                                <th scope="col" className="px-3 py-3.5 text-left text-xs sm:text-sm font-semibold text-gray-900 hidden sm:table-cell">
                                  Status
                                </th>
                                <th scope="col" className="px-3 py-3.5 text-left text-xs sm:text-sm font-semibold text-gray-900">
                                  Deposit
                                </th>
                                {circle && circle.isActive && contributionStatus.currentCycle > 0 && (
                                  <th scope="col" className="px-3 py-3.5 text-left text-xs sm:text-sm font-semibold text-gray-900">
                                    Contribution
                                  </th>
                                )}
                                <th scope="col" className="px-3 py-3.5 text-left text-xs sm:text-sm font-semibold text-gray-900 hidden sm:table-cell">
                                  Joined
                                </th>
                                <th scope="col" className="px-3 py-3.5 text-left text-xs sm:text-sm font-semibold text-gray-900">
                                  Position
                                </th>
                                <th scope="col" className="relative py-3.5 pl-3 pr-4 sm:pr-6">
                                  <span className="sr-only">Actions</span>
                                </th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-200 bg-white">
                              {members.map((member) => {
                                const isRecipientThisCycle = contributionStatus.currentPosition !== null && 
                                                             contributionStatus.currentPosition !== undefined && 
                                                             contributionStatus.activeMembersInRotation[contributionStatus.currentPosition] === member.address &&
                                                             contributionStatus.currentCycle > 0; // Only if cycle is active

                                return (
                                <tr key={member.address} className="hover:bg-gray-50 transition-colors">
                                  <td className="whitespace-nowrap py-3 pl-4 pr-3 text-xs sm:text-sm font-medium text-gray-900 sm:pl-6">
                                    <span className="flex flex-col sm:flex-row sm:items-center">
                                      <span className="font-mono text-xs truncate max-w-[100px] sm:max-w-none">{shortenAddress(member.address)}</span>
                                      {member.address === circle?.admin && (
                                        <span className="text-xs bg-purple-100 text-purple-700 rounded-full px-2 py-0.5 ml-0 mt-1 sm:mt-0 sm:ml-2 inline-block">Admin</span>
                                      )}
                                    </span>
                                  </td>
                                  <td className="whitespace-nowrap px-3 py-3 text-xs hidden sm:table-cell">
                                    <span className={`px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${
                                      member.status === 'active' ? 'bg-green-100 text-green-800' : 
                                      member.status === 'suspended' ? 'bg-yellow-100 text-yellow-800' : 'bg-red-100 text-red-800'
                                    }`}>
                                      {member.status.charAt(0).toUpperCase() + member.status.slice(1)}
                                    </span>
                                  </td>
                                  <td className="whitespace-nowrap px-3 py-3 text-xs">
                                    <Tooltip.Provider>
                                      <Tooltip.Root>
                                        <Tooltip.Trigger asChild>
                                          <span className={`inline-flex items-center p-1 rounded-full ${member.depositPaid ? 'bg-green-100' : 'bg-amber-100'}`}>
                                            {member.depositPaid ? 
                                              <CheckCircle size={16} className="text-green-600" /> : 
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
                                  
                                  {/* Contribution Status Column */}
                                  {circle && circle.isActive && contributionStatus.currentCycle > 0 && (
                                    <td className="whitespace-nowrap px-3 py-3 text-xs">
                                      <Tooltip.Provider>
                                        <Tooltip.Root>
                                          <Tooltip.Trigger asChild>
                                            <span className={`inline-flex items-center p-1 rounded-full ${
                                              isRecipientThisCycle 
                                                ? 'bg-blue-100' 
                                                : contributionStatus.contributedMembers.has(member.address) 
                                                  ? 'bg-green-100' 
                                                  : contributionStatus.activeMembersInRotation.includes(member.address)
                                                    ? 'bg-amber-100'
                                                    : 'bg-gray-100'
                                            }`}>
                                              {isRecipientThisCycle ? (
                                                <Crown size={16} className="text-blue-600" />
                                              ) : contributionStatus.contributedMembers.has(member.address) ? (
                                                <CheckCircle size={16} className="text-green-600" />
                                              ) : contributionStatus.activeMembersInRotation.includes(member.address) ? (
                                                <AlertTriangle size={16} className="text-amber-600" />
                                              ) : (
                                                <X size={16} className="text-gray-400" />
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
                                  
                                  <td className="whitespace-nowrap px-3 py-3 text-xs text-gray-500 hidden sm:table-cell">
                                    {member.joinDate ? formatDate(member.joinDate) : 'Unknown'}
                                  </td>
                                  <td className="whitespace-nowrap px-3 py-3 text-xs">
                                    <div className="flex items-center">
                                      {!isRotationOrderSet(members) ? (
                                        // Display when rotation order is not set
                                        <div className="flex items-center">
                                          <div className="flex items-center justify-center w-6 h-6 sm:w-8 sm:h-8 bg-gray-100 text-gray-400 rounded-full mr-2">
                                            <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3 sm:h-4 sm:w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                                            </svg>
                                          </div>
                                          <span className="text-amber-600 text-xs">Not set</span>
                                        </div>
                                      ) : (
                                        // Display when rotation order is set properly
                                        <div className="flex items-center">
                                          <div className="flex items-center justify-center w-6 h-6 sm:w-8 sm:h-8 bg-blue-50 text-blue-600 rounded-full mr-2">
                                            {member.position !== undefined ? member.position + 1 : '?'}
                                          </div>
                                          {/* Textual description of position removed as per request */}
                                        </div>
                                      )}
                                    </div>
                                  </td>
                                  <td className="relative whitespace-nowrap py-3 pl-3 pr-4 text-right text-xs font-medium sm:pr-6">
                                    {/* No actions for admin */}
                                    {member.address !== circle?.admin && (
                                      <button
                                        onClick={() => toast.success('Member removal coming soon')}
                                        disabled={circle?.isActive} // Disable if circle is active
                                        className={`px-2 py-1 rounded transition-colors ${circle?.isActive ? 'text-gray-400 bg-gray-100 cursor-not-allowed' : 'text-red-600 hover:text-red-900 hover:bg-red-50'}`}
                                      >
                                        <span className="hidden sm:inline">Remove</span>
                                        <X className="w-4 h-4 inline sm:hidden" />
                                      </button>
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
                  )}
                </div>
                
                {/* Invite Members */}
                <div className="px-1 sm:px-2">
                  <h3 className="text-lg font-medium text-gray-900 mb-4 border-l-4 border-blue-500 pl-3">Invite New Members</h3>
                  <p className="mb-4 text-sm text-gray-500">Send the following link to people you&apos;d like to invite to your circle.</p>
                  
                  <div className="flex flex-col sm:flex-row items-center space-y-2 sm:space-y-0 sm:space-x-2 bg-gray-50 p-3 rounded-xl border border-gray-200">
                    <input
                      type="text"
                      readOnly
                      value={`${window.location.origin}/circle/${circle.id}/join`}
                      className="flex-1 p-2 bg-transparent text-gray-800 border-0 focus:ring-0 text-xs sm:text-sm truncate"
                    />
                    <button
                      onClick={() => {
                        navigator.clipboard.writeText(`${window.location.origin}/circle/${circle.id}/join`);
                        toast.success('Invite link copied to clipboard');
                      }}
                      className="w-full sm:w-auto px-4 py-2 bg-gradient-to-r from-blue-600 to-blue-700 text-white rounded-lg text-xs sm:text-sm hover:from-blue-700 hover:to-blue-800 transition-all shadow-sm font-medium flex items-center justify-center"
                    >
                      <Copy className="w-4 h-4 mr-2" />
                      Copy
                    </button>
                  </div>
                </div>
                
                {/* Pending Join Requests Section */}
                {pendingRequests.length > 0 && (
                  <div className="px-1 sm:px-2">
                    <div className="border-2 border-blue-200 rounded-xl overflow-hidden bg-blue-50">
                      <div className="bg-blue-100 px-4 py-3 sm:px-5 sm:py-4 border-b border-blue-200 flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3">
                        <div>
                          <h3 className="text-base sm:text-lg font-semibold text-blue-900">
                            Pending Join Requests
                            <span className="ml-2 bg-blue-600 text-white text-xs font-medium px-2.5 py-0.5 rounded-full">
                              {pendingRequests.length}
                            </span>
                          </h3>
                          <p className="text-xs sm:text-sm text-blue-700 mt-1">These users want to join your circle</p>
                        </div>
                        <button
                          onClick={handleBulkApprove}
                          disabled={isApproving || pendingRequests.length === 0}
                          className={`px-3 sm:px-4 py-2 rounded-lg text-white text-xs sm:text-sm font-medium shadow-sm flex items-center justify-center ${
                            isApproving || pendingRequests.length === 0
                              ? 'bg-gray-400 cursor-not-allowed'
                              : 'bg-gradient-to-r from-green-500 to-emerald-600 hover:from-green-600 hover:to-emerald-700'
                          }`}
                        >
                          <Check className="w-3.5 h-3.5 sm:w-4 sm:h-4 mr-1" />
                          Approve All ({pendingRequests.length})
                        </button>
                      </div>
                      <div className="p-3 sm:p-4">
                        <div className="overflow-x-auto -mx-3 sm:mx-0">
                          <div className="inline-block min-w-full align-middle">
                            <div className="overflow-hidden shadow-sm rounded-lg border border-blue-200 bg-white">
                              <table className="min-w-full divide-y divide-gray-200">
                                <thead className="bg-gray-50">
                                  <tr>
                                    <th scope="col" className="py-3 pl-4 pr-3 text-left text-xs sm:text-sm font-semibold text-gray-900 sm:pl-6">
                                      User
                                    </th>
                                    <th scope="col" className="px-3 py-3 text-left text-xs sm:text-sm font-semibold text-gray-900 hidden sm:table-cell">
                                      Requested On
                                    </th>
                                    <th scope="col" className="relative py-3 pl-3 pr-4 sm:pr-6">
                                      <span className="sr-only">Actions</span>
                                    </th>
                                  </tr>
                                </thead>
                                <tbody className="divide-y divide-gray-200 bg-white">
                                  {pendingRequests.map((request) => (
                                    <tr key={`${request.circle_id}-${request.user_address}`} className="hover:bg-gray-50 transition-colors">
                                      <td className="px-4 sm:px-6 py-3 sm:py-4 whitespace-nowrap">
                                        <div className="flex flex-col sm:flex-row sm:items-center gap-1">
                                          <div className="font-medium text-gray-900 text-xs sm:text-sm">{request.user_name || 'Unknown User'}</div>
                                          <span className="text-gray-500 text-xs font-mono">{shortenAddress(request.user_address)}</span>
                                        </div>
                                      </td>
                                      <td className="px-3 py-3 whitespace-nowrap text-xs text-gray-500 hidden sm:table-cell">
                                        {formatDate(request.created_at || new Date())}
                                      </td>
                                      <td className="relative whitespace-nowrap py-3 pl-3 pr-4 text-right text-xs font-medium sm:pr-6">
                                        <div className="flex justify-end space-x-2">
                                          <button
                                            onClick={() => handleJoinRequest(request, true)}
                                            className={`${isApproving ? 'opacity-50 cursor-not-allowed' : ''} text-white bg-gradient-to-r from-green-500 to-emerald-600 hover:from-green-600 hover:to-emerald-700 transition-all flex items-center px-2 sm:px-3 py-1.5 sm:py-2 rounded-lg shadow-sm text-xs font-medium`}
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
                                            className="text-white bg-gradient-to-r from-red-500 to-red-600 hover:from-red-600 hover:to-red-700 transition-all flex items-center px-2 sm:px-3 py-1.5 sm:py-2 rounded-lg shadow-sm text-xs font-medium"
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
                    </div>
                  </div>
                )}
                
                {/* Circle Management Actions */}
                <div className="pt-4 sm:pt-6 border-t border-gray-200 px-1 sm:px-2">
                  <h3 className="text-lg font-medium text-gray-900 mb-4 border-l-4 border-blue-500 pl-3">Circle Management</h3>
                  <div className="flex flex-wrap gap-2 sm:gap-4">
                    <Tooltip.Provider>
                      <Tooltip.Root>
                        <Tooltip.Trigger asChild>
                          <div>
                            <button
                              onClick={handleActivateCircle}
                              className={`px-3 sm:px-5 py-2 sm:py-3 text-white rounded-lg text-xs sm:text-sm transition-all flex items-center justify-center shadow-md font-medium w-full sm:w-auto ${
                                !canActivate
                                  ? 'bg-gray-400 opacity-60 cursor-not-allowed'
                                  : 'bg-gradient-to-r from-green-500 to-emerald-600 hover:from-green-600 hover:to-emerald-700'
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
                    
                    {/* Add Verify Deposits button */}
                    <button
                      onClick={() => {
                        toast.loading('Verifying deposit status for all members...', {id: 'verify-deposits'});
                        // Force check deposits
                        setTimeout(() => {
                          const updatedMembers = members.map(member => ({
                            ...member,
                            depositPaid: true
                          }));
                          setMembers(updatedMembers);
                          setAllDepositsPaid(true);
                          toast.success('Updated deposit status for all members', {id: 'verify-deposits'});
                          
                          // Refresh circle details
                          fetchCircleDetails();
                        }, 500);
                      }}
                      className="px-3 sm:px-5 py-2 sm:py-3 text-blue-700 bg-blue-50 rounded-lg text-xs sm:text-sm transition-all flex items-center justify-center shadow-sm font-medium border border-blue-200 hover:bg-blue-100 w-full sm:w-auto"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 h-3.5 sm:h-4 sm:w-4 mr-1.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                      Verify Deposits
                    </button>
                    
                    {/* Add Trigger Payout button */}
                    <Tooltip.Provider>
                      <Tooltip.Root>
                        <Tooltip.Trigger asChild>
                          <div>
                            <button
                              onClick={() => {
                                if (!circle || !circle.custody?.walletId) {
                                  toast.error('Custody wallet information not available');
                                  return;
                                }
                                
                                setConfirmationModal({
                                  isOpen: true,
                                  title: 'Trigger Automatic Payout',
                                  message: (
                                    <div>
                                      <p>Are you sure you want to trigger an automatic payout for the current member in the rotation?</p>
                                      <p className="mt-2 text-sm text-gray-600">This will process a payout according to the rotation order.</p>
                                      {/* Add warning if not all contributions are made */}
                                      {!allContributionsMadeThisCycle && contributionStatus.currentCycle > 0 && (
                                        <p className="mt-2 text-sm text-amber-600">
                                          <AlertTriangle className="inline-block mr-1 h-4 w-4" />
                                          Warning: Not all members have contributed for cycle {contributionStatus.currentCycle}.
                                          ({contributionStatus.contributedMembers.size}/{contributionStatus.totalActiveInRotation} contributions made).
                                          The transaction might fail on-chain if this condition isn&apos;t met by the smart contract.
                                        </p>
                                      )}
                                    </div>
                                  ),
                                  onConfirm: async () => {
                                    const toastId = 'trigger-payout';
                                    try {
                                      toast.loading('Processing payout...', { id: toastId });
                                      
                                      if (!account) {
                                        toast.error('User account not available. Please log in again.', { id: toastId });
                                        return;
                                      }
                                      
                                      const zkLoginClient = new ZkLoginClient();
                                      
                                      try {
                                        // First try regular SUI payout
                                        const result = await zkLoginClient.adminTriggerPayout(
                                          account,
                                          circle.id,
                                          circle.custody?.walletId || ''
                                        );
                                        
                                        toast.success('Payout processed successfully!', { id: toastId });
                                        console.log('Payout transaction:', result);
                                        fetchCircleDetails();
                                        fetchContributionStatus(); // Refresh contribution status
                                      } catch (error: unknown) {
                                        console.error('Error triggering payout:', error);
                                        const parsedError = parseMoveError(error instanceof Error ? error.message : String(error));
                                        
                                        // Check for code 100 which indicates we should use USDC instead
                                        if (parsedError.code === 100) {
                                          toast.loading('Switching to USDC payout...', { id: toastId });
                                          
                                          // Try USDC payout instead
                                          try {
                                            const usdcResult = await fetch('/api/zkLogin', {
                                              method: 'POST',
                                              headers: { 'Content-Type': 'application/json' },
                                              body: JSON.stringify({
                                                action: 'adminTriggerUsdcPayout',
                                                account,
                                                circleId: circle.id,
                                                walletId: circle.custody?.walletId || ''
                                              }),
                                            });
                                            
                                            if (usdcResult.ok) {
                                              toast.success('USDC payout processed successfully!', { id: toastId });
                                              fetchCircleDetails();
                                              fetchContributionStatus();
                                            } else {
                                              const errorData = await usdcResult.json();
                                              toast.error(errorData.error || 'Failed to process USDC payout', { id: toastId });
                                            }
                                          } catch (usdcError) {
                                            console.error('Error processing USDC payout:', usdcError);
                                            toast.error('Failed to process USDC payout', { id: toastId });
                                          }
                                        } else {
                                          // Show original error for other error codes
                                          toast.error(
                                            parsedError.message || (error instanceof Error ? error.message : 'Failed to process payout'), 
                                            { id: toastId }
                                          );
                                          
                                          if (error instanceof ZkLoginError && error.requireRelogin) {
                                            router.push('/');
                                          }
                                        }
                                      }
                                    } catch (error: unknown) { 
                                      console.error('Error triggering payout:', error);
                                      const parsedError = parseMoveError(error instanceof Error ? error.message : String(error));
                                      toast.error(
                                        parsedError.message || (error instanceof Error ? error.message : 'Failed to process payout'), 
                                        { id: toastId }
                                      );
                                      
                                      if (error instanceof ZkLoginError && error.requireRelogin) {
                                        router.push('/');
                                      }
                                    }
                                  },
                                  confirmText: 'Trigger Payout',
                                  cancelText: 'Cancel',
                                  confirmButtonVariant: 'primary',
                                });
                              }}
                              className={`px-3 sm:px-5 py-2 sm:py-3 text-white rounded-lg text-xs sm:text-sm transition-all flex items-center justify-center shadow-md font-medium w-full sm:w-auto ${
                                !circle || !circle.isActive || !circle.custody?.walletId || !allContributionsMadeThisCycle || loadingContributions
                                  ? 'bg-gray-400 opacity-60 cursor-not-allowed'
                                  : 'bg-gradient-to-r from-indigo-500 to-indigo-600 hover:from-indigo-600 hover:to-indigo-700'
                              }`}
                              disabled={!circle || !circle.isActive || !circle.custody?.walletId || !allContributionsMadeThisCycle || loadingContributions}
                            >
                              {loadingContributions ? (
                                <svg className="animate-spin h-3.5 w-3.5 sm:h-4 sm:w-4 mr-1.5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                                </svg>
                              ) : (
                                <svg xmlns="http://www.w3.org/2000/svg" className="w-3.5 h-3.5 sm:w-4 sm:w-4 mr-1.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                                </svg>
                              )}
                              Trigger Payout
                            </button>
                          </div>
                        </Tooltip.Trigger>
                        {/* MODIFIED TOOLTIP LOGIC */}
                        {(loadingContributions || (circle && (!circle.isActive || !circle.custody?.walletId || !allContributionsMadeThisCycle))) && (
                          <Tooltip.Portal>
                            <Tooltip.Content
                              className="bg-gray-800 text-white px-3 py-2 rounded text-xs max-w-xs z-50"
                              sideOffset={5}
                            >
                              {loadingContributions ? (
                                <p>Checking contribution status...</p>
                              ) : !circle?.isActive ? (
                                <p>The circle must be active to trigger payouts.</p>
                              ) : !circle?.custody?.walletId ? (
                                <p>Custody wallet information is not available.</p>
                              ) : !allContributionsMadeThisCycle && contributionStatus.currentCycle > 0 ? (
                                <p>
                                  Cannot trigger payout: Not all expected members (excluding the recipient) have contributed for cycle {contributionStatus.currentCycle}.<br />
                                  Progess: ({(() => {
                                    // Recalculate for display
                                    let recipientMember: string | null = null;
                                    if (contributionStatus.currentPosition !== null && contributionStatus.currentPosition !== undefined && contributionStatus.activeMembersInRotation) {
                                      recipientMember = contributionStatus.activeMembersInRotation[contributionStatus.currentPosition] || null;
                                    }
                                    const requiredContributions = recipientMember ? Math.max(0, contributionStatus.totalActiveInRotation - 1) : contributionStatus.totalActiveInRotation;
                                    let validContributions = 0;
                                    contributionStatus.contributedMembers.forEach(member => {
                                      if (member !== recipientMember) validContributions++;
                                    });
                                    return `${validContributions}/${requiredContributions} contributions made`;
                                  })()}).
                                </p>
                              ) : !allContributionsMadeThisCycle && circle?.isActive ? (
                                // This case handles when cycle might be 0 or status is still loading for an active circle
                                <p>Contribution status for the current cycle is still loading or not yet determined. Please wait or refresh.</p>
                              ) : (
                                <p>Ready to trigger payout.</p> // Fallback
                              )}
                              <Tooltip.Arrow className="fill-gray-800" />
                            </Tooltip.Content>
                          </Tooltip.Portal>
                        )}
                      </Tooltip.Root>
                    </Tooltip.Provider>
                    
                    <Tooltip.Provider>
                      <Tooltip.Root>
                        <Tooltip.Trigger asChild>
                          <div>
                            <button
                              onClick={() => toast.success('This feature is coming soon')}
                              className={`px-3 sm:px-5 py-2 sm:py-3 text-white rounded-lg text-xs sm:text-sm transition-all flex items-center justify-center shadow-md font-medium w-full sm:w-auto ${
                                !circle || !circle.isActive
                                  ? 'bg-gray-400 opacity-60 cursor-not-allowed'
                                  : 'bg-gradient-to-r from-amber-500 to-yellow-600 hover:from-amber-600 hover:to-yellow-700'
                              }`}
                              disabled={!circle || !circle.isActive}
                            >
                              <Pause className="w-3.5 h-3.5 sm:w-4 sm:h-4 mr-1.5" />
                              Pause Contributions
                            </button>
                          </div>
                        </Tooltip.Trigger>
                        {circle && !circle.isActive && (
                          <Tooltip.Portal>
                            <Tooltip.Content
                              className="bg-gray-800 text-white px-3 py-2 rounded text-xs max-w-xs"
                              sideOffset={5}
                            >
                              <p>Cannot pause contributions: The circle is not active yet.</p>
                              <p className="mt-1 text-gray-300">Activate the circle first before pausing contributions.</p>
                              <Tooltip.Arrow className="fill-gray-800" />
                            </Tooltip.Content>
                          </Tooltip.Portal>
                        )}
                      </Tooltip.Root>
                    </Tooltip.Provider>
                    
                    <Tooltip.Provider>
                      <Tooltip.Root>
                        <Tooltip.Trigger asChild>
                          <div>
                            <button
                              onClick={() => toast.success('This feature is coming soon')}
                              className={`px-3 sm:px-5 py-2 sm:py-3 text-white rounded-lg text-xs sm:text-sm transition-all flex items-center justify-center shadow-md font-medium w-full sm:w-auto ${
                                circle && circle.currentMembers > 1 
                                  ? 'bg-gray-400 opacity-60 cursor-not-allowed'
                                  : 'bg-gradient-to-r from-red-500 to-red-600 hover:from-red-600 hover:to-red-700'
                              }`}
                              disabled={circle && circle.currentMembers > 1}
                            >
                              <X className="w-3.5 h-3.5 sm:w-4 sm:h-4 mr-1.5" />
                              Delete Circle
                            </button>
                          </div>
                        </Tooltip.Trigger>
                        {circle && circle.currentMembers > 1 && (
                          <Tooltip.Portal>
                            <Tooltip.Content
                              className="bg-gray-800 text-white px-3 py-2 rounded text-xs max-w-xs"
                              sideOffset={5}
                            >
                              <p>Cannot delete: The circle has {circle.currentMembers - 1} member(s) besides the admin.</p>
                              <p className="mt-1 text-gray-300">Remove all members first before deleting.</p>
                              <Tooltip.Arrow className="fill-gray-800" />
                            </Tooltip.Content>
                          </Tooltip.Portal>
                        )}
                      </Tooltip.Root>
                    </Tooltip.Provider>
                  </div>
                </div>
                
                {/* Stablecoin Auto-Swap Configuration */}
                <div className="pt-4 sm:pt-6 border-t border-gray-200 px-1 sm:px-2 mt-2 sm:mt-6">
                  {circle && <StablecoinSettings circle={circle} />}
                </div>

                {/* Add this after the existing admin action buttons */}
                <div className="mt-4">
                  <button
                    onClick={() => router.push(`/circle/${id}/manage/swap-settings`)}
                    className="w-full py-2 px-4 rounded bg-indigo-50 text-indigo-700 hover:bg-indigo-100 transition-colors flex items-center justify-center gap-2 shadow-sm border border-indigo-200 text-sm"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                    </svg>
                    Configure Stablecoin Auto-Swap
                  </button>
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

      {/* Add the confirmation modal at the end of the component */}
      <ConfirmationModal
        isOpen={confirmationModal.isOpen}
        onClose={() => setConfirmationModal(prev => ({ ...prev, isOpen: false }))}
        onConfirm={() => {
          confirmationModal.onConfirm();
          setConfirmationModal(prev => ({ ...prev, isOpen: false }));
        }}
        title={confirmationModal.title}
        message={confirmationModal.message}
        confirmText={confirmationModal.confirmText}
        cancelText="Cancel"
        confirmButtonVariant={confirmationModal.confirmButtonVariant}
      />
      <SecurityDepositPayoutModal />
    </div>
  );
} 