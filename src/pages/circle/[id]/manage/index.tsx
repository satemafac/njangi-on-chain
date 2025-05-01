import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { useAuth } from '@/contexts/AuthContext';
import { SuiClient, SuiEvent } from '@mysten/sui/client';
import { toast } from 'react-hot-toast';
import { ArrowLeft, Copy, Link, Check, X, Pause, ListOrdered } from 'lucide-react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { priceService } from '../../../../services/price-service';
import joinRequestService from '../../../../services/join-request-service';
import { JoinRequest } from '../../../../services/database-service';
import { PACKAGE_ID } from '../../../../services/circle-service';
import StablecoinSwapForm from '../../../../components/StablecoinSwapForm';
import RotationOrderList from '../../../../components/RotationOrderList';
import ConfirmationModal from '../../../../components/ConfirmationModal';
import { ZkLoginClient } from '../../../../services/zkLoginClient';

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
  nextPayoutTime: number;
  isActive: boolean;
  autoSwapEnabled: boolean;
  custody?: {
    walletId: string;
    stablecoinEnabled: boolean;
    stablecoinType: string;
    stablecoinBalance: number;
    suiBalance: number;
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
const DAYS_IN_WEEK = 7;

// Define types for SUI object field values
type SuiFieldValue = string | number | boolean | null | undefined | SuiFieldValue[] | Record<string, unknown>;

// Refine the parseMoveError function with a new regex and more logging
const parseMoveError = (error: string): { code: number; message: string } => {
  // **Revised Regex:** Try a simpler pattern to capture the code after MoveAbort
  const moveAbortMatch = error.match(/MoveAbort\(.*,\s*(\d+)\)/); // Simpler regex

  if (moveAbortMatch && moveAbortMatch[1]) { // Check group 1 for the code now
    const codeString = moveAbortMatch[1];
    console.log(`[parseMoveError] MoveAbort matched. Raw code string: "${codeString}"`); // LOGGING
    try {
      const code = parseInt(codeString, 10);
      console.log(`[parseMoveError] Parsed code: ${code}`); // LOGGING

      if (isNaN(code)) {
         console.error("[parseMoveError] Failed to parse code number.");
         // Fall through to generic error if parsing fails
      } else {
        // Keep the existing switch statement
        switch (code) {
          case 22:
            return { code, message: 'Circle activation failed: Some members have not paid their security deposits yet.' };
          case 23:
            return { code, message: 'Circle activation failed: The circle needs to have at least 2 members before activation.' };
          case 24:
            return { code, message: 'Circle activation failed: The circle is already active.' };
          case 25:
             return { code, message: 'Only the circle admin can perform this action.' };
          case 26:
             return { code, message: 'Member approval failed: This user is already a member of the circle.' };
          case 27:
            return { code, message: 'Cannot add more members: Circle has reached its maximum member limit.' };
          case 28:
            return { code, message: 'Security deposit required: Member must pay the required security deposit.' };
          case 29:
            return { code, message: 'Member contribution failed: Invalid amount provided.' };
          default:
             return { code, message: `Error code ${code}: Operation failed. Please try again or contact support.` };
        }
      }
    } catch (parseError) {
       console.error("[parseMoveError] Error during code parsing:", parseError);
       // Fall through if parsing throws error
    }
  } else {
     console.log("[parseMoveError] MoveAbort pattern did not match."); // LOGGING
  }

  // --- Fallback Logic ---
  if (error.includes('authentication') || error.includes('expired') ||
      error.includes('session') || error.includes('login')) {
    console.log("[parseMoveError] Matched authentication error."); // LOGGING
    return { code: 401, message: 'Your session has expired. Please log in again to continue.' };
  }

  // Final fallback
  const cleanedMessage = error.replace('zkLogin signature error: ', '').split(' in command')[0] || 'An unknown error occurred.';
  console.log("[parseMoveError] Using final fallback message:", cleanedMessage); // LOGGING
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

export default function ManageCircle() {
  const router = useRouter();
  const { id } = router.query;
  const { isAuthenticated, userAddress, account } = useAuth();
  const [loading, setLoading] = useState(true);
  const [circle, setCircle] = useState<Circle | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [pendingRequests, setPendingRequests] = useState<JoinRequest[]>([]);
  const [suiPrice, setSuiPrice] = useState(1.25); // Default price until we fetch real price
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
  // Add a new state variable to track if all deposits are paid
  const [allDepositsPaid, setAllDepositsPaid] = useState(false);

  useEffect(() => {
    if (!isAuthenticated) {
      router.push('/');
      return;
    }
  }, [isAuthenticated, router]);

  useEffect(() => {
    // Fetch circle details when ID is available
    if (id && userAddress) {
      fetchCircleDetails();
    }
  }, [id, userAddress]);

  useEffect(() => {
    // Fetch SUI price
    const fetchPrice = async () => {
      try {
        const price = await priceService.getSUIPrice();
        if (price !== null) {
          setSuiPrice(price);
        }
      } catch (error) {
        console.error('Error fetching SUI price:', error);
        // Keep using the default price
      }
    };
    fetchPrice();
  }, []);

  useEffect(() => {
    // Fetch pending join requests from database
    if (id && userAddress) {
      fetchPendingRequests();
    }
  }, [id, userAddress]);

  const fetchCircleDetails = async () => {
    if (!id) return;
    
    setLoading(true);
    try {
      const client = new SuiClient({ url: 'https://fullnode.testnet.sui.io:443' });
      
      // Get circle object with basic fields
      const objectData = await client.getObject({
        id: id as string,
        options: { showContent: true, showType: true }
      });
      
      console.log('Manage - Circle object data:', objectData);
        
      // Ensure data is valid
      if (!objectData.data?.content || !('fields' in objectData.data.content)) {
        throw new Error('Invalid circle object data received');
      }
        
      const fields = objectData.data.content.fields as Record<string, SuiFieldValue>;
        
        // If not admin, redirect to view-only page
      if (fields.admin !== userAddress) {
          toast.error('Only the admin can manage this circle');
          router.push(`/circle/${id}`);
          return;
        }
        
      // Get dynamic fields
      const dynamicFieldsResult = await client.getDynamicFields({
        parentId: id as string
      });
      console.log('Manage - Dynamic fields:', dynamicFieldsResult.data);
      
      // Fetch CircleCreated event and transaction inputs
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

      // Fetch and calculate member count
      let actualMemberCount = 1;
      const memberAddresses = new Set<string>();
      if (typeof fields.admin === 'string') memberAddresses.add(fields.admin);
      
      // Use SuiEvent type for memberEvents
      let memberEvents: { data: SuiEvent[] } = { data: [] };
      
      try {
        memberEvents = await client.queryEvents({
          query: { MoveEventType: `${PACKAGE_ID}::njangi_circles::MemberJoined` },
            limit: 1000
          });
        // Type event params as SuiEvent for compatibility
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
      
      // Fetch members with deposit status
      const membersList: Member[] = [];
      const depositStatusPromises = Array.from(memberAddresses).map(async (address) => {
        try {
              const depositEvents = await client.queryEvents({
                query: { MoveEventType: `${PACKAGE_ID}::njangi_circles::SecurityDepositReceived` },
                limit: 50
              });
          // Type event params as SuiEvent for compatibility
          const hasPaid = depositEvents.data.some((event: SuiEvent) => 
            (event.parsedJson as { circle_id?: string; member?: string })?.circle_id === id &&
            (event.parsedJson as { member?: string })?.member === address
          );
          // Find join date from memberEvents if possible
          // Type event params as SuiEvent for compatibility
          const joinEvent = memberEvents.data.find((e: SuiEvent) => (e.parsedJson as { member?: string })?.member === address && (e.parsedJson as { circle_id?: string })?.circle_id === id);
          const positionEvent = memberEvents.data.find((e: SuiEvent) => (e.parsedJson as { member?: string })?.member === address && (e.parsedJson as { circle_id?: string })?.circle_id === id);
          const position = positionEvent ? (positionEvent.parsedJson as { position?: number })?.position : undefined;

              membersList.push({
            address, 
            depositPaid: hasPaid, 
            status: 'active', // Assume active for now
            joinDate: joinEvent && joinEvent.timestampMs ? Number(joinEvent.timestampMs) : creationTimestamp ?? Date.now(),
            position
          });
            } catch (error) {
          console.error(`Manage - Error fetching deposit status for ${address}:`, error);
          membersList.push({ address, depositPaid: false, status: 'active', joinDate: creationTimestamp ?? Date.now(), position: undefined });
            }
          });
      await Promise.all(depositStatusPromises);

      // Fetch rotation order from fields
      const rotationOrder: string[] = [];
      if (fields.rotation_order && Array.isArray(fields.rotation_order)) {
        (fields.rotation_order as string[]).forEach((addr: string) => {
          if (addr !== '0x0') rotationOrder.push(addr);
        });
      }

      // Set positions based on rotation order
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
          
      const allPaid = sortedMembers.length > 0 && sortedMembers.every(m => m.depositPaid);
          setAllDepositsPaid(allPaid);
      console.log('Manage - All deposits paid status:', allPaid);
          
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
        nextPayoutTime: Number(fields.next_payout_time || 0),
        isActive: isActive,
        autoSwapEnabled: finalAutoSwapValue, 
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
                  
                  setCircle(prev => prev ? {
                    ...prev,
                    custody: {
                      walletId,
                      stablecoinEnabled: !!(stablecoinConfigFields?.enabled),
                      stablecoinType: (stablecoinConfigFields?.target_coin_type as string) || 'USDC',
                      stablecoinBalance: wf.stablecoin_balance ? Number(wf.stablecoin_balance) / 1e8 : 0,
                      suiBalance: (balanceFields?.value) ? Number(balanceFields.value) / 1e9 : 0
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
    } finally {
      setLoading(false);
    }
  };

  const fetchPendingRequests = async () => {
    try {
      // Get pending requests from the service
      if (!id) return;
      const requests = await joinRequestService.getPendingRequestsByCircleId(id as string);
      setPendingRequests(requests);
    } catch (error: unknown) {
      console.error('Error fetching pending requests:', error);
      toast.error('Failed to load join requests');
    }
  };

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
      // If approving, first try to approve on blockchain
      if (approve) {
        const blockchainSuccess = await callAdminApproveMember(
          request.circleId,
          request.userAddress
        );
        
        if (!blockchainSuccess) {
          toast.error('Failed to approve member on blockchain. Please try again.');
          return;
        }
      }
      
      // Update request status using the service
      const success = await joinRequestService.updateJoinRequestStatus(
        request.circleId,
        request.userAddress,
        approve ? 'approved' : 'rejected'
      );
      
      if (success) {
        // Update UI to remove the request
        setPendingRequests(prev => 
          prev.filter(req => 
            !(req.circleId === request.circleId && 
              req.userAddress === request.userAddress)
          )
        );
        
        // If approved, add to members list
        if (approve) {
          // Use current timestamp from blockchain transaction for join date
          const currentTimestamp = Date.now(); // Get the current time as a fallback
          
          setMembers(prev => [
            ...prev,
            {
              address: request.userAddress,
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
          
          toast.success(`Approved ${shortenAddress(request.userAddress)} to join the circle`);
        } else {
          toast.success(`Rejected join request from ${shortenAddress(request.userAddress)}`);
        }
      } else {
        toast.error('Failed to process join request');
      }
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
        try {
          // Extract all the member addresses from pending requests
          const memberAddresses = pendingRequests.map(req => req.userAddress);
          
          // Call the bulk approval method
          const blockchainSuccess = await callAdminApproveMembers(
            pendingRequests[0].circleId, // All requests are for the same circle
            memberAddresses
          );
          
          if (!blockchainSuccess) {
            toast.error('Failed to approve members on blockchain. Please try again.');
            return;
          }
          
          // Update all requests in the database
          let allSuccessful = true;
          for (const request of pendingRequests) {
            const success = await joinRequestService.updateJoinRequestStatus(
              request.circleId,
              request.userAddress,
              'approved'
            );
            
            if (!success) {
              allSuccessful = false;
            }
          }
          
          if (allSuccessful) {
            // Add all members to the UI
            const currentTimestamp = Date.now();
            const newMembers = pendingRequests.map(req => ({
              address: req.userAddress,
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
            
            // Clear all pending requests
            setPendingRequests([]);
            
            toast.success(`Successfully approved all ${pendingRequests.length} member requests`);
          } else {
            // Refresh the pending requests to get the current state
            await fetchPendingRequests();
            toast.error('Some requests could not be updated in the database. Please refresh to see current status.');
          }
        } catch (error: unknown) {
          console.error('Error handling bulk approval:', error);
          toast.error('Failed to process bulk approval');
        }
      },
      confirmText: 'Approve All',
      cancelText: 'Cancel',
      confirmButtonVariant: 'primary',
    });
  };

  // Format timestamp to readable date
  const formatDate = (timestamp: number) => {
    if (!timestamp) return 'Not set';
    
    const date = new Date(timestamp);
    
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
    const currentTime = Date.now();
    
    // Extract year, month, day from the current time
    const currentDate = new Date(currentTime);
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth(); // JS months are 0-indexed (0-11)
    const day = currentDate.getDate();
    
    // Get time of day in ms (since midnight)
    const dayMs = currentTime % MS_PER_DAY;
    
    // Get current weekday (0-6, with 0 being Monday in our system)
    const weekday = (currentDate.getDay() + 6) % 7; // Convert Sunday=0 to Monday=0
    
    console.log('Calculating potential payout date:', {
      currentDate: currentDate.toISOString(),
      year, month: month + 1, day,
      cycleLength, cycleDay,
      weekday
    });
        
        // Validate inputs - ensure they are within reasonable bounds
        // Clamp cycleDay to valid range based on cycle type
        const validCycleDay = (cycleLength === 0) 
            ? Math.min(Math.max(0, cycleDay), 6) // 0-6 for weekly
            : Math.min(Math.max(1, cycleDay), 28); // 1-28 for monthly/quarterly
    
    if (cycleLength === 0) {
      // Weekly payouts
      let daysUntil = 0;
      
            if (validCycleDay > weekday) {
        // Selected day is later this week
                daysUntil = validCycleDay - weekday;
            } else if (validCycleDay < weekday || (validCycleDay === weekday && dayMs > 0)) {
        // Selected day is earlier than today, or it's today but time has passed
                daysUntil = DAYS_IN_WEEK - weekday + validCycleDay;
      }
      
      console.log('Weekly cycle - days until next payout:', daysUntil);
      
      // Calculate timestamp for next payout
      const nextPayoutTime = currentTime + (daysUntil * MS_PER_DAY);
      
      // Reset to midnight UTC
      const nextPayoutDate = new Date(nextPayoutTime);
      nextPayoutDate.setUTCHours(0, 0, 0, 0);
      
            try {
                // Test if date is valid before returning
                nextPayoutDate.toISOString();
      console.log('Calculated next payout date (weekly):', nextPayoutDate.toISOString());
      return nextPayoutDate.getTime();
            } catch (e) {
                console.error('Invalid date created for weekly cycle:', e);
                // Fallback to current time + 7 days if invalid
                return currentTime + (7 * MS_PER_DAY);
            }
        } else if (cycleLength === 1 || cycleLength === 2) {
            // Monthly or quarterly payouts
      
            // If today's date is greater than the selected day, move to next month/quarter
      let targetMonth = month;
      let targetYear = year;
            const monthsToAdd = (cycleLength === 1) ? 1 : 3; // 1 for monthly, 3 for quarterly
      
            if (day > validCycleDay || (day === validCycleDay && dayMs > 0)) {
                // Move to next month/quarter
                targetMonth += monthsToAdd;
        
        // Handle year rollover
        if (targetMonth > 11) { // JS months are 0-11
                    targetYear += Math.floor(targetMonth / 12);
                    targetMonth = targetMonth % 12;
        }
      }
      
            // Safely determine the last day of the target month
            let lastDayOfMonth;
            try {
                // Create a date for the first day of the next month, then go back one day
                const nextMonth = new Date(Date.UTC(targetYear, targetMonth + 1, 1));
                nextMonth.setUTCDate(0);
                lastDayOfMonth = nextMonth.getUTCDate();
            } catch (e) {
                console.error('Error calculating last day of month:', e);
                lastDayOfMonth = 28; // Safe fallback
            }
            
            // If cycleDay exceeds the last day of the month, use the last day instead
            const targetDay = Math.min(validCycleDay, lastDayOfMonth);
            
            console.log(`${cycleLength === 1 ? 'Monthly' : 'Quarterly'} cycle - target date:`, {
                targetYear, targetMonth: targetMonth + 1, targetDay,
                lastDayOfMonth
      });
      
            try {
      // Create date for the target payout day (at midnight UTC)
                const nextPayoutDate = new Date(Date.UTC(targetYear, targetMonth, targetDay));
      
                // Validate that the date is correct
                if (isNaN(nextPayoutDate.getTime())) {
                    throw new Error('Invalid date created');
                }
                
                console.log(`Calculated next payout date (${cycleLength === 1 ? 'monthly' : 'quarterly'}):`, 
                    nextPayoutDate.toISOString());
      
      return nextPayoutDate.getTime();
            } catch (e) {
                console.error(`Error creating ${cycleLength === 1 ? 'monthly' : 'quarterly'} payout date:`, e);
                // Fallback to current time + 30 days (or 90 for quarterly)
                return currentTime + (monthsToAdd * 30 * MS_PER_DAY);
            }
        } else {
            // Invalid cycle length, use a safe fallback
            console.error('Invalid cycle length:', cycleLength);
            return currentTime + (30 * MS_PER_DAY); // Default to 30 days from now
        }
    } catch (error) {
        // Global error handler as final fallback
        console.error('Error in calculatePotentialNextPayoutDate:', error);
        return Date.now() + (7 * MS_PER_DAY); // Safe fallback: one week from now
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
                    <h5 className="font-medium text-gray-700 mb-2">Wallet Balances</h5>
                    <div className="grid grid-cols-2 gap-2">
                      <div className="p-3 bg-gray-50 rounded-lg">
                        <p className="text-xs text-gray-500">SUI</p>
                        <p className="font-medium">{circle.custody.suiBalance.toFixed(4)} SUI</p>
                      </div>
                      
                      <div className="p-3 bg-gray-50 rounded-lg">
                        <p className="text-xs text-gray-500">
                          {circle.custody.stablecoinType || 'USDC'}
                        </p>
                        <p className="font-medium">{formatUSD(circle.custody.stablecoinBalance || 0)}</p>
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

  // Update the saveRotationOrder function to ensure proper validation
  const saveRotationOrder = async (newOrder: string[]) => {
    if (!id || !userAddress || !circle) return;
    
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
  const canActivate = circle && 
                     circle.currentMembers === circle.maxMembers && 
                     isRotationOrderSet(members) && 
                     allDepositsPaid;

  if (!isAuthenticated || !account) {
    return null;
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <main className="max-w-7xl mx-auto py-6 sm:px-6 lg:px-8">
        <div className="px-4 py-6 sm:px-0">
          <div className="flex justify-between items-center mb-6">
            <button
              onClick={() => router.push('/dashboard')}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-white border border-gray-200 hover:bg-gray-50 hover:border-gray-300 transition-all shadow-sm text-sm text-gray-700 font-medium"
            >
              <ArrowLeft className="w-4 h-4" />
              Back to Dashboard
            </button>
            <h1 className="text-xl font-semibold text-blue-600">Manage Circle</h1>
          </div>

          <div className="bg-white shadow-md rounded-xl overflow-hidden border border-gray-100">
            <div className="p-6 border-b border-gray-200 bg-gradient-to-r from-blue-50 to-indigo-50">
              <div className="flex justify-between items-center">
                <h2 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
                  {!loading && circle ? circle.name : 'Manage Circle'}
                  {!loading && circle && (
                    <span className="text-sm font-normal bg-blue-100 text-blue-800 py-0.5 px-2 rounded-full">
                      {circle.currentMembers}/{circle.maxMembers} Members
                    </span>
                  )}
                </h2>
                {!loading && circle && (
                  <div className="flex items-center space-x-2 text-sm">
                    <span className="text-gray-500 bg-gray-100 py-1 px-2 rounded-md">{shortenId(id as string)}</span>
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
                <div className="py-8 flex justify-center">
                  <svg className="animate-spin h-8 w-8 text-blue-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                </div>
              ) : circle ? (
                <div className="py-4 space-y-8">
                  {/* Circle Details */}
                  <div className="px-2">
                    <h3 className="text-lg font-medium text-gray-900 mb-4 border-l-4 border-blue-500 pl-3">Circle Details</h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      <div className="bg-gray-50 p-4 rounded-lg shadow-sm">
                        <p className="text-sm text-gray-500 mb-1">Circle Name</p>
                        <p className="text-lg font-medium">{circle.name}</p>
                      </div>
                      
                      <div className="bg-gray-50 p-4 rounded-lg shadow-sm">
                        <p className="text-sm text-gray-500 mb-1">Contribution Amount</p>
                        <CurrencyDisplay usd={circle.contributionAmountUsd} sui={circle.contributionAmount} className="font-medium" />
                      </div>
                      
                      <div className="bg-gray-50 p-4 rounded-lg shadow-sm">
                        <p className="text-sm text-gray-500 mb-1">Security Deposit</p>
                        <CurrencyDisplay usd={circle.securityDepositUsd} sui={circle.securityDeposit} className="font-medium" />
                      </div>
                      
                      <div className="bg-gray-50 p-4 rounded-lg shadow-sm">
                        <p className="text-sm text-gray-500 mb-1">
                          {circle.isActive ? 'Next Payout' : 'Potential Next Payout'}
                        </p>
                        <p className="text-lg font-medium">
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
                    </div>
                  </div>
                  
                  {/* Members Management */}
                  <div className="px-2">
                    <div className="flex justify-between items-center mb-4">
                      <h3 className="text-lg font-medium text-gray-900 border-l-4 border-blue-500 pl-3">Members</h3>
                      {!isEditingRotation && (
                        <button
                          onClick={() => setIsEditingRotation(true)}
                          className="px-4 py-2 bg-blue-50 text-blue-600 rounded-md flex items-center hover:bg-blue-100 transition-colors"
                        >
                          <ListOrdered size={16} className="mr-1" />
                          Edit Rotation Order
                        </button>
                      )}
                    </div>
                    
                    {/* Add warning message for rotation order when not in edit mode */}
                    {!isEditingRotation && !isRotationOrderSet(members) && (
                      <div className="mb-4 p-3 bg-yellow-50 border border-yellow-200 rounded-md text-yellow-700">
                        <p className="font-medium flex items-center">
                          <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 mr-2" viewBox="0 0 20 20" fill="currentColor">
                            <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
                          </svg>
                          Warning: Rotation order is not properly set
                        </p>
                        <p className="text-sm mt-1">You must set the rotation order for all members before activating the circle. Click &quot;Edit Rotation Order&quot; to fix this issue.</p>
                      </div>
                    )}
                    
                    {isEditingRotation ? (
                      <div>
                        {!isRotationOrderSet(members) && (
                          <div className="mb-4 p-3 bg-yellow-50 border border-yellow-200 rounded-md text-yellow-700">
                            <p className="font-medium flex items-center">
                              <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 mr-2" viewBox="0 0 20 20" fill="currentColor">
                                <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
                              </svg>
                              Setting rotation order is required before circle activation
                            </p>
                            <p className="text-sm mt-1">The rotation order determines who receives payouts in which order.</p>
                          </div>
                        )}
                        <div className="flex justify-end mb-4">
                          <button
                            onClick={shuffleRotationOrder}
                            className="px-4 py-2 bg-indigo-50 text-indigo-600 rounded-md flex items-center hover:bg-indigo-100 transition-colors"
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
                      <div className="overflow-hidden shadow-sm rounded-xl border border-gray-200">
                        <table className="min-w-full divide-y divide-gray-200">
                          <thead className="bg-gray-50">
                            <tr>
                              <th scope="col" className="py-3.5 pl-4 pr-3 text-left text-sm font-semibold text-gray-900 sm:pl-6">
                                Address
                              </th>
                              <th scope="col" className="px-3 py-3.5 text-left text-sm font-semibold text-gray-900">
                                Status
                              </th>
                              <th scope="col" className="px-3 py-3.5 text-left text-sm font-semibold text-gray-900">
                                Joined
                              </th>
                              <th scope="col" className="px-3 py-3.5 text-left text-sm font-semibold text-gray-900">
                                Rotation Position
                              </th>
                              <th scope="col" className="relative py-3.5 pl-3 pr-4 sm:pr-6">
                                <span className="sr-only">Actions</span>
                              </th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-gray-200 bg-white">
                            {members.map((member) => (
                              <tr key={member.address} className="hover:bg-gray-50 transition-colors">
                                <td className="whitespace-nowrap py-4 pl-4 pr-3 text-sm font-medium text-gray-900 sm:pl-6">
                                  {shortenAddress(member.address)} 
                                  {member.address === circle.admin && 
                                    <span className="text-xs bg-purple-100 text-purple-700 rounded-full px-2 py-0.5 ml-2">Admin</span>
                                  }
                                </td>
                                <td className="whitespace-nowrap px-3 py-4 text-sm">
                                  <span className={`px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${
                                    member.status === 'active' ? 'bg-green-100 text-green-800' : 
                                    member.status === 'suspended' ? 'bg-yellow-100 text-yellow-800' : 'bg-red-100 text-red-800'
                                  }`}>
                                    {member.status.charAt(0).toUpperCase() + member.status.slice(1)}
                                  </span>
                                </td>
                                <td className="whitespace-nowrap px-3 py-4 text-sm text-gray-500">
                                  {member.joinDate ? formatDate(member.joinDate) : 'Unknown'}
                                </td>
                                <td className="whitespace-nowrap px-3 py-4 text-sm">
                                  <div className="flex items-center">
                                    {!isRotationOrderSet(members) ? (
                                      // Display when rotation order is not set
                                      <div className="flex items-center">
                                        <div className="flex items-center justify-center w-8 h-8 bg-gray-100 text-gray-400 rounded-full mr-2">
                                          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                                          </svg>
                                        </div>
                                        <span className="text-amber-600 text-xs font-medium">Not configured</span>
                                      </div>
                                    ) : (
                                      // Display when rotation order is set properly
                                      <div className="flex items-center">
                                        <div className="flex items-center justify-center w-8 h-8 bg-blue-50 text-blue-600 rounded-full mr-2">
                                          {member.position !== undefined ? member.position + 1 : '?'}
                                        </div>
                                        <span className="text-gray-600 text-xs">
                                          {member.position === 0 ? 'First' : 
                                           (member.position !== undefined && member.position === members.length - 1) ? 'Last' : 
                                           member.position === undefined ? 'Not set' : `Position ${member.position + 1}`}
                                        </span>
                                      </div>
                                    )}
                                  </div>
                                </td>
                                <td className="relative whitespace-nowrap py-4 pl-3 pr-4 text-right text-sm font-medium sm:pr-6">
                                  {/* No actions for admin */}
                                  {member.address !== circle.admin && (
                                    <button
                                      className="text-red-600 hover:text-red-900 px-2 py-1 rounded hover:bg-red-50"
                                      onClick={() => toast.success('Member removal coming soon')}
                                    >
                                      Remove
                                    </button>
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                  
                  {/* Invite Members */}
                  <div className="px-2">
                    <h3 className="text-lg font-medium text-gray-900 mb-4 border-l-4 border-blue-500 pl-3">Invite New Members</h3>
                    <p className="mb-4 text-sm text-gray-500">Send the following link to people you&apos;d like to invite to your circle.</p>
                    
                    <div className="flex items-center space-x-2 bg-gray-50 p-3 rounded-xl border border-gray-200">
                      <input
                        type="text"
                        readOnly
                        value={`${window.location.origin}/circle/${circle.id}/join`}
                        className="flex-1 p-2 bg-transparent text-gray-800 border-0 focus:ring-0"
                      />
                      <button
                        onClick={() => {
                          navigator.clipboard.writeText(`${window.location.origin}/circle/${circle.id}/join`);
                          toast.success('Invite link copied to clipboard');
                        }}
                        className="px-4 py-2 bg-gradient-to-r from-blue-600 to-blue-700 text-white rounded-lg text-sm hover:from-blue-700 hover:to-blue-800 transition-all shadow-sm font-medium flex items-center"
                      >
                        <Copy className="w-4 h-4 mr-2" />
                        Copy
                      </button>
                    </div>
                  </div>
                  
                  {/* Pending Join Requests Section */}
                  {pendingRequests.length > 0 && (
                    <div className="mt-8 px-2">
                      <div className="flex justify-between items-center mb-4">
                        <h3 className="text-lg font-medium text-gray-900 border-l-4 border-blue-500 pl-3">
                          Pending Join Requests 
                          <span className="ml-2 bg-blue-100 text-blue-800 text-xs font-medium px-2.5 py-0.5 rounded-full">
                            {pendingRequests.length}
                          </span>
                        </h3>
                        <button
                          onClick={handleBulkApprove}
                          disabled={isApproving || pendingRequests.length === 0}
                          className={`px-4 py-2 rounded-lg text-white text-sm font-medium shadow-sm flex items-center ${
                            isApproving || pendingRequests.length === 0
                              ? 'bg-gray-400 cursor-not-allowed'
                              : 'bg-gradient-to-r from-green-500 to-emerald-600 hover:from-green-600 hover:to-emerald-700'
                          }`}
                        >
                          <Check className="w-4 h-4 mr-1" />
                          Approve All ({pendingRequests.length})
                        </button>
                      </div>
                      <div className="overflow-hidden shadow-sm rounded-xl border border-gray-200">
                        <table className="min-w-full divide-y divide-gray-200">
                          <thead className="bg-gray-50">
                            <tr>
                              <th scope="col" className="py-3.5 pl-4 pr-3 text-left text-sm font-semibold text-gray-900 sm:pl-6">
                                User
                              </th>
                              <th scope="col" className="px-3 py-3.5 text-left text-sm font-semibold text-gray-900">
                                Requested On
                              </th>
                              <th scope="col" className="relative py-3.5 pl-3 pr-4 sm:pr-6">
                                <span className="sr-only">Actions</span>
                              </th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-gray-200 bg-white">
                            {pendingRequests.map((request) => (
                              <tr key={`${request.circleId}-${request.userAddress}`} className="hover:bg-gray-50 transition-colors">
                                <td className="whitespace-nowrap py-4 pl-4 pr-3 text-sm sm:pl-6">
                                  <div className="font-medium text-gray-900">{request.userName || 'Unknown User'}</div>
                                  <div className="text-gray-500">{shortenAddress(request.userAddress)}</div>
                                </td>
                                <td className="whitespace-nowrap px-3 py-4 text-sm text-gray-500">
                                  {formatDate(request.requestDate)}
                                </td>
                                <td className="relative whitespace-nowrap py-4 pl-3 pr-4 text-right text-sm font-medium sm:pr-6">
                                  <div className="flex justify-end space-x-3">
                                    <button
                                      onClick={() => handleJoinRequest(request, true)}
                                      className={`${isApproving ? 'opacity-50 cursor-not-allowed' : ''} text-white bg-gradient-to-r from-green-500 to-emerald-600 hover:from-green-600 hover:to-emerald-700 transition-all flex items-center px-4 py-2 rounded-lg shadow-sm font-medium`}
                                      disabled={isApproving}
                                    >
                                      {isApproving ? (
                                        <svg className="animate-spin h-4 w-4 mr-2" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                                        </svg>
                                      ) : (
                                        <Check className="w-4 h-4 mr-2" />
                                      )}
                                      Approve
                                    </button>
                                    <button
                                      onClick={() => handleJoinRequest(request, false)}
                                      className="text-white bg-gradient-to-r from-red-500 to-red-600 hover:from-red-600 hover:to-red-700 transition-all flex items-center px-4 py-2 rounded-lg shadow-sm font-medium"
                                      disabled={isApproving}
                                    >
                                      <X className="w-4 h-4 mr-2" />
                                      Reject
                                    </button>
                                  </div>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                  
                  {/* Circle Management Actions */}
                  <div className="pt-6 border-t border-gray-200 px-2">
                    <h3 className="text-lg font-medium text-gray-900 mb-4 border-l-4 border-blue-500 pl-3">Circle Management</h3>
                    <div className="flex flex-col space-y-4 sm:flex-row sm:space-x-4 sm:space-y-0">
                      <Tooltip.Provider>
                        <Tooltip.Root>
                          <Tooltip.Trigger asChild>
                            <div>
                              <button
                                onClick={handleActivateCircle}
                                className={`px-5 py-3 text-white rounded-lg text-sm transition-all flex items-center justify-center shadow-md font-medium ${
                                  !canActivate
                                    ? 'bg-gray-400 opacity-60 cursor-not-allowed'
                                    : 'bg-gradient-to-r from-green-500 to-emerald-600 hover:from-green-600 hover:to-emerald-700'
                                }`}
                                disabled={!canActivate}
                              >
                                <Check className="w-4 h-4 mr-2" />
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
                                {circle.currentMembers < circle.maxMembers ? (
                                  <p>You need {circle.maxMembers - circle.currentMembers} more member(s) to activate.</p>
                                ) : !isRotationOrderSet(members) ? (
                                  <p>You must set the rotation order for all members before activating.</p>
                                ) : !allDepositsPaid ? (
                                  <p>All members must pay their security deposit before activation.</p>
                                ) : (
                                  <p>Circle cannot be activated yet. Check requirements.</p> // Fallback message
                                )}
                                <p className="mt-1 text-gray-300">Current: {circle.currentMembers}/{circle.maxMembers} members</p>
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
                                className={`px-5 py-3 text-white rounded-lg text-sm transition-all flex items-center justify-center shadow-md font-medium ${
                                  !circle || !circle.isActive
                                    ? 'bg-gray-400 opacity-60 cursor-not-allowed'
                                    : 'bg-gradient-to-r from-amber-500 to-yellow-600 hover:from-amber-600 hover:to-yellow-700'
                                }`}
                                disabled={!circle || !circle.isActive}
                              >
                                <Pause className="w-4 h-4 mr-2" />
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
                                className={`px-5 py-3 text-white rounded-lg text-sm transition-all flex items-center justify-center shadow-md font-medium ${
                                  circle && circle.currentMembers > 1 
                                    ? 'bg-gray-400 opacity-60 cursor-not-allowed'
                                    : 'bg-gradient-to-r from-red-500 to-red-600 hover:from-red-600 hover:to-red-700'
                                }`}
                                disabled={circle && circle.currentMembers > 1}
                              >
                                <X className="w-4 h-4 mr-2" />
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
                  <div className="pt-6 border-t border-gray-200 px-2 mt-6">
                    {circle && <StablecoinSettings circle={circle} />}
                  </div>

                  {/* Add this after the existing admin action buttons */}
                  <div className="mt-4">
                    <button
                      onClick={() => router.push(`/circle/${id}/manage/swap-settings`)}
                      className="w-full py-2 px-4 rounded bg-indigo-50 text-indigo-700 hover:bg-indigo-100 transition-colors flex items-center justify-center gap-2 shadow-sm border border-indigo-200"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                      </svg>
                      Configure Stablecoin Auto-Swap
                    </button>
                  </div>
                </div>
              ) : (
                <div className="py-8 text-center">
                  <p className="text-gray-500">Circle not found</p>
                </div>
              )}
            </div>
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
    </div>
  );
} 