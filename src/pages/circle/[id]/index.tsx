import React, { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { useAuth } from '../../../contexts/AuthContext';
import { toast } from 'react-hot-toast';
import {
  ArrowLeft,
  AlertTriangle,
  ArrowUpRight,
  CalendarDays,
  CheckCircle2,
  CircleDot,
  Copy,
  Link2,
  RefreshCw,
  Shield,
  Users,
  Wallet,
} from 'lucide-react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { RecoveryProposalCard } from '@/components/recovery/RecoveryProposalCard';
import { RecoveryRefundTable } from '@/components/recovery/RecoveryRefundTable';
import { RecoveryStateBadge } from '@/components/recovery/RecoveryStateBadge';
import { getCircleConfigFieldsFromDynamicFields } from '@/lib/circle-config';
import {
  getRecoveryAutoReleaseUiState,
  parseRecoveryStatus,
  type RecoveryStatusSnapshot,
} from '@/lib/recovery-liveness';
import {
  loadRecoveryExecutionStatus,
  loadRecoveryStablecoinCoinType,
  type RecoveryExecutionStatus,
} from '@/lib/recovery-execution';
import { getRecoveryProposalUiState } from '@/lib/recovery-ui';
import { resolveStablecoinMetadata } from '@/lib/stablecoin-metadata';
import { priceService } from '../../../services/price-service';
import { getCirclePackageId, getSuiClientFromPool } from '../../../services/circle-service';
import { readObject, queryEventsCached, invalidateObject, invalidateSuiRead } from '@/lib/sui-read';
import { logSuiReadError } from '@/services/sui-rpc-failover';
import { ZkLoginClient, ZkLoginError } from '../../../services/zkLoginClient';
import { getCurrentNetwork, getCurrentRpcUrl } from '../../../services/network-config';

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
  nextPayoutTime: number;
  isActive: boolean;
  custody?: {
    walletId: string;
    stablecoinCoinType?: string;
  };
}

// Fix linter errors by using more specific types
type SuiFieldValue = string | number | boolean | null | undefined | SuiFieldValue[] | Record<string, unknown>;

// Define CircleCreatedEvent interface
interface CircleCreatedEvent {
  circle_id: string;
  admin: string;
  name: string;
  contribution_amount: string;
  currency_type?: string;                  // Currency code (e.g., "USD", "XAF", "NGN")
  contribution_amount_local?: string;      // Amount in local currency
  security_deposit_local?: string;         // Amount in local currency
  max_members: string;
  cycle_length: string;
}

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

const unwrapMoveValue = (value: unknown): unknown => {
  const record = asRecord(value);
  if (!record) return value;
  if ('fields' in record) return unwrapMoveValue(record.fields);
  if ('value' in record) return unwrapMoveValue(record.value);
  return value;
};

const moveVectorToArray = (value: unknown): unknown[] => {
  if (Array.isArray(value)) return value;
  const unwrapped = unwrapMoveValue(value);
  if (Array.isArray(unwrapped)) return unwrapped;
  const record = asRecord(unwrapped);
  if (!record) return [];
  return Array.isArray(record.vec) ? record.vec : [];
};

const moveOptionToValue = (value: unknown): unknown | null => {
  if (value === null || typeof value === 'undefined') return null;
  const record = asRecord(value);
  if (record && 'some' in record) return record.some ?? null;
  const vec = moveVectorToArray(value);
  return vec.length > 0 ? vec[0] : null;
};

const normalizeAddress = (value: string | null | undefined): string | null =>
  typeof value === 'string' && value.length > 0 ? value.toLowerCase() : null;

const canMemberTriggerAutoReleaseFromFieldObject = (value: unknown): boolean => {
  const wrapper = asRecord(value);
  const memberValue = wrapper?.value ? asRecord(wrapper.value) : wrapper;
  const memberFields = memberValue?.fields ? asRecord(memberValue.fields) : memberValue;
  if (!memberFields) {
    return false;
  }

  const status = Number(parseU64Like(memberFields.status));
  const suspensionEndTime = moveOptionToValue(memberFields.suspension_end_time);
  return status === 0 && suspensionEndTime === null;
};

export default function CircleDetails() {
  const router = useRouter();
  const { id } = router.query;
  const { isAuthenticated, isLoading: authLoading, userAddress, account } = useAuth();
  const [loading, setLoading] = useState(true);
  const [circle, setCircle] = useState<Circle | null>(null);
  const [membersTableId, setMembersTableId] = useState<string | null>(null);
  const [circlePackageId, setCirclePackageId] = useState<string | null>(null);
  const [recoveryStatus, setRecoveryStatus] = useState<RecoveryStatusSnapshot | null>(null);
  const [loadingRecoveryStatus, setLoadingRecoveryStatus] = useState(false);
  const [recoveryExecution, setRecoveryExecution] = useState<RecoveryExecutionStatus | null>(null);
  const [loadingRecoveryExecution, setLoadingRecoveryExecution] = useState(false);
  const [recoveryStablecoinType, setRecoveryStablecoinType] = useState<string | null>(null);
  const [viewerCanAutoReleaseFallback, setViewerCanAutoReleaseFallback] = useState(false);
  const [delegateCanAutoReleaseFallback, setDelegateCanAutoReleaseFallback] = useState(false);
  const [loadingRecoveryLiveness, setLoadingRecoveryLiveness] = useState(false);
  const [isSubmittingRecoveryVote, setIsSubmittingRecoveryVote] = useState(false);
  const [isSubmittingAutoRelease, setIsSubmittingAutoRelease] = useState(false);
  const [suiPrice, setSuiPrice] = useState(1.25); // Default price until we fetch real price
  const [copiedId, setCopiedId] = useState(false);
  // Track membership verification status (used for access control flow)
  const [, setMembershipVerified] = useState<boolean | null>(null);

  useEffect(() => {
    if (authLoading) {
      return;
    }

    if (!isAuthenticated && id) {
      // Redirect to home with returnUrl so user comes back after login
      const returnUrl = encodeURIComponent(`/circle/${id}`);
      router.replace(`/?returnUrl=${returnUrl}`);
      return;
    }
  }, [authLoading, isAuthenticated, router, id]);

  // Verify user membership before showing circle details
  const verifyMembership = async (): Promise<boolean | null> => {
    if (!id || !userAddress) return false;
    
    try {
      const client = getSuiClientFromPool(getCurrentRpcUrl());
      const determinedPackageId = await getCirclePackageId(id as string, userAddress);
      
      // First check if user is the admin
      const objectData = await readObject(id as string, { showContent: true });
      
      if (objectData.data?.content && 'fields' in objectData.data.content) {
        const fields = objectData.data.content.fields as Record<string, SuiFieldValue>;
        // Admin always has access
        if (fields.admin === userAddress) {
          console.log('[Membership] User is admin, access granted');
          return true;
        }
        
        // Check if user is in the members table
        const circleFields = fields as { members?: { fields?: { id?: { id: string } } } };
        if (circleFields.members?.fields?.id?.id) {
          const membersTableId = circleFields.members.fields.id.id;
          try {
            const memberField = await client.getDynamicFieldObject({
              parentId: membersTableId,
              name: { type: 'address', value: userAddress }
            });
            
            if (memberField.data?.content) {
              console.log('[Membership] User found in members table, access granted');
              return true;
            }
          } catch {
            // User not found in members table
            console.log('[Membership] User not found in members table');
          }
        }
      }
      
      // Check if user ever joined this circle and get their join events
      const joinEvents = await queryEventsCached({
        query: { MoveEventType: `${determinedPackageId}::njangi_circles::MemberJoined` },
        limit: 100
      });
      
      // Find the user's join events for this circle and get the latest timestamp
      const userJoinEvents = joinEvents.data.filter(event => {
        const parsed = event.parsedJson as { circle_id?: string; member?: string };
        return parsed?.circle_id === id && parsed?.member === userAddress;
      });
      
      if (userJoinEvents.length === 0) {
        console.log('[Membership] User never joined this circle');
        return false;
      }
      
      // Get the latest join timestamp
      const latestJoinTimestamp = Math.max(...userJoinEvents.map(e => Number(e.timestampMs || 0)));
      console.log(`[Membership] User's latest join timestamp: ${new Date(latestJoinTimestamp).toISOString()}`);
      
      // Check for MemberRemoved events to see if user was removed
      const removedEvents = await queryEventsCached({
        query: { MoveEventType: `${determinedPackageId}::njangi_circles::MemberRemoved` },
        limit: 100
      });
      
      // Find the user's removal events for this circle and get the latest timestamp
      const userRemovalEvents = removedEvents.data.filter(event => {
        const parsed = event.parsedJson as { circle_id?: string; member?: string };
        return parsed?.circle_id === id && parsed?.member === userAddress;
      });
      
      if (userRemovalEvents.length > 0) {
        const latestRemovalTimestamp = Math.max(...userRemovalEvents.map(e => Number(e.timestampMs || 0)));
        console.log(`[Membership] User's latest removal timestamp: ${new Date(latestRemovalTimestamp).toISOString()}`);
        
        // If the user joined AFTER they were last removed, they have rejoined - allow access
        if (latestJoinTimestamp > latestRemovalTimestamp) {
          console.log('[Membership] User rejoined after removal, access granted');
          return true;
        }
        
        // User was removed after their last join - deny access
        console.log('[Membership] User was removed after their last join, access denied');
        return false;
      }
      
      // User joined and was never removed - they should have access
      console.log('[Membership] User joined and was never removed, access granted');
      return true;
      
    } catch (error) {
      logSuiReadError('[Membership] Error verifying membership:', error);
      return null;
    }
  };

  useEffect(() => {
    // Fetch circle details when ID is available
    if (authLoading || !router.isReady || !id || !userAddress) {
      return;
    }

    if (id && userAddress) {
      // First verify membership, then fetch details
      verifyMembership().then(isMember => {
        setMembershipVerified(isMember ?? null);
        if (isMember === false) {
          setLoading(false);
          toast.error('You are no longer a member of this circle');
          router.replace('/dashboard');
          return;
        }

        fetchCircleDetails();
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, id, router.isReady, userAddress]);

  useEffect(() => {
    // Fetch SUI price
    const fetchPrice = async () => {
      try {
        const price = await priceService.getSUIPrice();
        if (price !== null) {
          setSuiPrice(price);
        }
      } catch {
        // Keep using the default price
      }
    };
    fetchPrice();
  }, []);

  const fetchCircleDetails = async () => {
    if (!id || !userAddress) return;
    console.log('Details - Fetching circle details:', id);
    const client = getSuiClientFromPool(getCurrentRpcUrl());

    // Central refetch (also called after recovery votes/actions): drop cached
    // reads for this circle so we reflect the latest chain state.
    invalidateObject(id as string);
    invalidateSuiRead('events:');

    try {
      setLoading(true);
      
      // Determine package ID for this circle
      const determinedPackageId = await getCirclePackageId(id as string, userAddress);
      console.log('Details - Using package ID:', determinedPackageId);
      setCirclePackageId(determinedPackageId);
      // Get object data
      const objectData = await readObject(id as string, { showContent: true, showType: true });
      
      console.log('Details - Circle object data:', objectData);
      if (!objectData.data?.content || !('fields' in objectData.data.content)) {
        throw new Error('Invalid circle object data received');
      }
      const fields = objectData.data.content.fields as Record<string, SuiFieldValue>;
      const resolvedMembersTableId = fields.members && typeof fields.members === 'object' && fields.members !== null &&
        'fields' in fields.members && fields.members.fields && typeof fields.members.fields === 'object' &&
        fields.members.fields !== null && 'id' in fields.members.fields &&
        fields.members.fields.id && typeof fields.members.fields.id === 'object' &&
        fields.members.fields.id !== null && 'id' in fields.members.fields.id
        ? (fields.members.fields.id as { id: string }).id
        : null;
      setMembersTableId(resolvedMembersTableId);

      // Get dynamic fields
      const dynamicFieldsResult = await client.getDynamicFields({
        parentId: id as string
      });
      console.log('Details - Dynamic fields:', dynamicFieldsResult.data);

      // Fetch creation event and transaction inputs
      let transactionInput: Record<string, unknown> | undefined;
      let circleCreationEventData: CircleCreatedEvent | undefined;

        try {
        const circleEvents = await queryEventsCached({
          query: { MoveEventType: `${determinedPackageId}::njangi_circles::CircleCreated` },
            limit: 50
          });
        const createEvent = circleEvents.data.find(event => 
          (event.parsedJson as { circle_id?: string })?.circle_id === id
        );
        console.log('Details - Found creation event:', !!createEvent);

        if (createEvent?.parsedJson) {
          circleCreationEventData = createEvent.parsedJson as CircleCreatedEvent;
          transactionInput = {
            contribution_amount: circleCreationEventData.contribution_amount,
            contribution_amount_local: circleCreationEventData.contribution_amount_local,
            security_deposit_local: circleCreationEventData.security_deposit_local,
          };
        }

        if (createEvent?.id?.txDigest) {
          const txData = await client.getTransactionBlock({
            digest: createEvent.id.txDigest,
            options: { showInput: true }
          });
          console.log('Details - Transaction data fetched:', !!txData);
          if (txData?.transaction?.data?.transaction?.kind === 'ProgrammableTransaction') {
            const inputs = txData.transaction.data.transaction.inputs || [];
            console.log('Details - Transaction inputs:', inputs);
            if (!transactionInput) transactionInput = {};
            if (inputs.length > 1 && inputs[1]?.type === 'pure') transactionInput.contribution_amount = inputs[1].value;
            if (inputs.length > 2 && inputs[2]?.type === 'pure') transactionInput.contribution_amount_local = inputs[2].value;
            if (inputs.length > 4 && inputs[4]?.type === 'pure') transactionInput.security_deposit_local = inputs[4].value;
            if (inputs.length > 6 && inputs[6]?.type === 'pure') transactionInput.cycle_day = inputs[6].value;
            console.log('Details - Extracted from Tx Inputs:', transactionInput);
          }
        }
        } catch (error) {
        logSuiReadError('Details - Error fetching transaction data:', error);
        }
        
      // --- Process Extracted Data --- 
      const configValues = {
        contributionAmount: 0,
        contributionAmountUsd: 0,
        securityDeposit: 0,
        securityDepositUsd: 0,
        cycleLength: 0,
        cycleDay: 1,
        maxMembers: 3,
      };

      // 1. Use values from transaction/event first
      if (transactionInput) {
        if (transactionInput.contribution_amount) configValues.contributionAmount = Number(transactionInput.contribution_amount) / 1e9;
        if (transactionInput.contribution_amount_local) configValues.contributionAmountUsd = Number(transactionInput.contribution_amount_local) / 100;
        if (transactionInput.security_deposit_local) configValues.securityDepositUsd = Number(transactionInput.security_deposit_local) / 100;
        if (transactionInput.cycle_day) configValues.cycleDay = Number(transactionInput.cycle_day);
      }
      if (circleCreationEventData) {
        if (circleCreationEventData.cycle_length) configValues.cycleLength = Number(circleCreationEventData.cycle_length);
        if (circleCreationEventData.max_members) configValues.maxMembers = Number(circleCreationEventData.max_members);
      }
      console.log('Details - Config after Tx/Event:', configValues);

      try {
        const configFields = await getCircleConfigFieldsFromDynamicFields(
          client,
          dynamicFieldsResult.data,
        );

        if (configFields) {
          console.log('Details - CircleConfig fields:', configFields);
          setRecoveryStatus(parseRecoveryStatus(configFields));

          if (configFields.contribution_amount) {
            configValues.contributionAmount = Number(configFields.contribution_amount) / 1e9;
          }
          if (configFields.contribution_amount_local) {
            configValues.contributionAmountUsd = Number(configFields.contribution_amount_local) / 100;
          } else if (configFields.contribution_amount_usd) {
            configValues.contributionAmountUsd = Number(configFields.contribution_amount_usd) / 100;
          }
          if (configFields.security_deposit) {
            configValues.securityDeposit = Number(configFields.security_deposit) / 1e9;
          }
          if (configFields.security_deposit_local) {
            configValues.securityDepositUsd = Number(configFields.security_deposit_local) / 100;
          } else if (configFields.security_deposit_usd) {
            configValues.securityDepositUsd = Number(configFields.security_deposit_usd) / 100;
          }
          if (configFields.cycle_length) {
            configValues.cycleLength = Number(configFields.cycle_length);
          }
          if (configFields.cycle_day) {
            configValues.cycleDay = Number(configFields.cycle_day);
          }
          if (configFields.max_members) {
            configValues.maxMembers = Number(configFields.max_members);
            console.log('Details - Extracted max_members from CircleConfig:', configValues.maxMembers);
          }
        } else {
          setRecoveryStatus(null);
        }
      } catch (error) {
        logSuiReadError('Details - Error fetching CircleConfig fields:', error);
        setRecoveryStatus(null);
      }
      console.log('Details - Config after Dynamic Fields:', configValues);

      // 3. Use direct fields from the circle object as a fallback
      if (configValues.contributionAmount === 0 && fields.contribution_amount) configValues.contributionAmount = Number(fields.contribution_amount) / 1e9;
      if (configValues.contributionAmountUsd === 0) {
        if (fields.contribution_amount_local) {
          configValues.contributionAmountUsd = Number(fields.contribution_amount_local) / 100;
        } else if (fields.contribution_amount_usd) {
          configValues.contributionAmountUsd = Number(fields.contribution_amount_usd) / 100;
        }
      }
      if (configValues.securityDeposit === 0 && fields.security_deposit) configValues.securityDeposit = Number(fields.security_deposit) / 1e9;
      if (configValues.securityDepositUsd === 0) {
        if (fields.security_deposit_local) {
          configValues.securityDepositUsd = Number(fields.security_deposit_local) / 100;
        } else if (fields.security_deposit_usd) {
          configValues.securityDepositUsd = Number(fields.security_deposit_usd) / 100;
        }
      }
      // Fallback for cycle info if not found earlier
      if (configValues.cycleLength === 0 && fields.cycle_length !== undefined) configValues.cycleLength = Number(fields.cycle_length);
      if (configValues.cycleDay === 1 && fields.cycle_day !== undefined) configValues.cycleDay = Number(fields.cycle_day);
      if (configValues.maxMembers === 3 && fields.max_members !== undefined) configValues.maxMembers = Number(fields.max_members);

      console.log('Details - Final Config Values:', configValues);

      // Check activation status
      let isActive = false;
      try {
        const activationEvents = await queryEventsCached({
          query: { MoveEventType: `${determinedPackageId}::njangi_circles::CircleActivated` },
          limit: 50
        });
        isActive = activationEvents.data.some(event => 
          (event.parsedJson as { circle_id?: string })?.circle_id === id
        );
        console.log('Details - Circle activation status:', isActive);
      } catch (error) {
        logSuiReadError('Details - Error checking activation:', error);
      }

      // Calculate member count
      let actualMemberCount = 1;
      const memberAddresses = new Set<string>();
      if (typeof fields.admin === 'string') memberAddresses.add(fields.admin);
      try {
        const memberEvents = await queryEventsCached({
          query: { MoveEventType: `${determinedPackageId}::njangi_circles::MemberJoined` },
          limit: 1000
        });
        const circleMemberEvents = memberEvents.data.filter(event => 
          (event.parsedJson as { circle_id?: string })?.circle_id === id
        );
        circleMemberEvents.forEach(event => {
          const memberAddr = (event.parsedJson as { member?: string })?.member;
          if (memberAddr) memberAddresses.add(memberAddr);
        });
          actualMemberCount = memberAddresses.size;
        console.log(`Details - Calculated member count: ${actualMemberCount}`);
        } catch (error) {
        logSuiReadError('Details - Error calculating member count:', error);
        actualMemberCount = Number(fields.current_members || 1);
        }

      let custodyWalletId: string | null = null;
      let custodyStablecoinCoinType: string | undefined;
      try {
        const custodyWalletEvents = await queryEventsCached({
          query: { MoveEventType: `${determinedPackageId}::njangi_custody::CustodyWalletCreated` },
          limit: 50,
        });
        const custodyEvent = custodyWalletEvents.data.find((event) =>
          (event.parsedJson as { circle_id?: string })?.circle_id === id,
        );
        custodyWalletId = (custodyEvent?.parsedJson as { wallet_id?: string })?.wallet_id || null;

        if (custodyWalletId) {
          const walletData = await readObject(custodyWalletId, { showContent: true });

          if (walletData.data?.content && 'fields' in walletData.data.content) {
            const walletFields = walletData.data.content.fields as Record<string, SuiFieldValue>;
            const stablecoinConfigFields = walletFields.stablecoin_config
              && typeof walletFields.stablecoin_config === 'object'
              && walletFields.stablecoin_config !== null
              && 'fields' in walletFields.stablecoin_config
              ? walletFields.stablecoin_config.fields as Record<string, unknown>
              : null;
            if (typeof stablecoinConfigFields?.target_coin_type === 'string') {
              custodyStablecoinCoinType = stablecoinConfigFields.target_coin_type;
            }
          }
        }
      } catch (error) {
        logSuiReadError('Details - Error fetching custody wallet info:', error);
      }
      
      // Set circle state
        setCircle({
          id: id as string,
        name: typeof fields.name === 'string' ? fields.name : '',
        admin: typeof fields.admin === 'string' ? fields.admin : '',
        contributionAmount: configValues.contributionAmount,
        contributionAmountUsd: configValues.contributionAmountUsd,
        currencyType: circleCreationEventData?.currency_type || 'USD',
        securityDeposit: configValues.securityDeposit,
        securityDepositUsd: configValues.securityDepositUsd,
        cycleLength: configValues.cycleLength,
        cycleDay: configValues.cycleDay,
        maxMembers: configValues.maxMembers,
          currentMembers: actualMemberCount,
        nextPayoutTime: Number(fields.next_payout_time || 0),
          isActive: isActive,
        custody: custodyWalletId
          ? {
              walletId: custodyWalletId,
              stablecoinCoinType: custodyStablecoinCoinType,
            }
          : undefined,
        });

    } catch (error) {
      // Transient cooldowns log quietly and skip the toast (self-heals on
      // refresh); only genuine failures surface to the user.
      if (!logSuiReadError('Details - Error fetching circle details:', error)) {
        toast.error('Error loading circle details');
      }
    } finally {
      setLoading(false);
    }
  };

  const fetchRecoveryStatus = useCallback(async () => {
    if (!id) return;

    setLoadingRecoveryStatus(true);
    try {
      const client = getSuiClientFromPool(getCurrentRpcUrl());
      const dynamicFieldsResult = await client.getDynamicFields({ parentId: id as string });
      const configFields = await getCircleConfigFieldsFromDynamicFields(client, dynamicFieldsResult.data);
      setRecoveryStatus(parseRecoveryStatus(configFields));
    } catch (error) {
      logSuiReadError('Details - Error refreshing recovery status:', error);
    } finally {
      setLoadingRecoveryStatus(false);
    }
  }, [id]);

  const fetchRecoveryExecutionState = useCallback(async (packageIdOverride?: string) => {
    if (!id) {
      setRecoveryExecution(null);
      setRecoveryStablecoinType(null);
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
        setRecoveryStablecoinType(null);
        return;
      }

      if (!circlePackageId) {
        setCirclePackageId(resolvedPackageId);
      }

      const client = getSuiClientFromPool(getCurrentRpcUrl());
      const [executionStatus, stablecoinCoinType] = await Promise.all([
        loadRecoveryExecutionStatus({
          client,
          packageId: resolvedPackageId,
          circleId: id as string,
        }),
        loadRecoveryStablecoinCoinType({
          client,
          packageId: resolvedPackageId,
          circleId: id as string,
        }),
      ]);

      setRecoveryExecution(executionStatus);
      setRecoveryStablecoinType(stablecoinCoinType);
    } catch (error) {
      logSuiReadError('Details - Error refreshing recovery execution state:', error);
    } finally {
      setLoadingRecoveryExecution(false);
    }
  }, [circlePackageId, id, userAddress]);

  const fetchRecoveryLivenessState = useCallback(async (nextInCommandOverride?: string | null) => {
    if (!membersTableId || !userAddress) {
      setViewerCanAutoReleaseFallback(false);
      setDelegateCanAutoReleaseFallback(false);
      return;
    }

    setLoadingRecoveryLiveness(true);
    try {
      const client = getSuiClientFromPool(getCurrentRpcUrl());
      const configuredDelegate = nextInCommandOverride ?? recoveryStatus?.nextInCommand ?? null;
      const readEligibility = async (address: string | null | undefined): Promise<boolean> => {
        if (!address) {
          return false;
        }

        try {
          const memberField = await client.getDynamicFieldObject({
            parentId: membersTableId,
            name: { type: 'address', value: address },
          });
          return canMemberTriggerAutoReleaseFromFieldObject(memberField.data?.content);
        } catch {
          return false;
        }
      };

      const viewerEligibilityPromise = readEligibility(userAddress);
      const delegateEligibilityPromise = configuredDelegate
        ? normalizeAddress(configuredDelegate) === normalizeAddress(userAddress)
          ? viewerEligibilityPromise
          : readEligibility(configuredDelegate)
        : Promise.resolve(false);

      const [viewerEligible, delegateEligible] = await Promise.all([
        viewerEligibilityPromise,
        delegateEligibilityPromise,
      ]);

      setViewerCanAutoReleaseFallback(viewerEligible);
      setDelegateCanAutoReleaseFallback(delegateEligible);
    } catch (error) {
      logSuiReadError('Details - Error refreshing recovery liveness state:', error);
      setViewerCanAutoReleaseFallback(false);
      setDelegateCanAutoReleaseFallback(false);
    } finally {
      setLoadingRecoveryLiveness(false);
    }
  }, [membersTableId, recoveryStatus?.nextInCommand, userAddress]);

  useEffect(() => {
    if (!id || !userAddress) return;

    void fetchRecoveryStatus();
    void fetchRecoveryExecutionState();
    // Recovery is a slow-moving safety status (liveness/grace windows are hours),
    // not a live feed — poll gently and skip while the tab is backgrounded. The
    // old 15s cadence on every open circle page was a top contributor to RPC
    // rate-limit cooldowns.
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
    if (!membersTableId || !userAddress) {
      return;
    }

    void fetchRecoveryLivenessState();
  }, [fetchRecoveryLivenessState, membersTableId, recoveryStatus?.nextInCommand, userAddress]);

  const formatDate = (timestamp: number, useLocalTime = false) => {
    if (!timestamp) return 'Not set';
    return new Date(timestamp).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      timeZone: useLocalTime ? undefined : 'UTC' // Use local timezone when requested
    });
  };

  const formatRelativeDuration = (milliseconds: number) => {
    if (!Number.isFinite(milliseconds) || milliseconds <= 0) return 'Ready now';

    const totalSeconds = Math.ceil(milliseconds / 1000);
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);

    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m`;
    return `${totalSeconds}s`;
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
      'XAF': { symbol: 'FCFA', locale: 'fr-CM', code: 'XAF', customFormat: true, position: 'after' },
      'NGN': { symbol: '₦', locale: 'en-NG', code: 'NGN' },
      'EUR': { symbol: '€', locale: 'de-DE', code: 'EUR' },
      'GBP': { symbol: '£', locale: 'en-GB', code: 'GBP' },
      'CAD': { symbol: 'C$', locale: 'en-CA', code: 'CAD', customFormat: true, position: 'before' },
      'ZAR': { symbol: 'R', locale: 'en-ZA', code: 'ZAR', customFormat: true, position: 'before' },
      'KES': { symbol: 'KSh', locale: 'en-KE', code: 'KES', customFormat: true, position: 'before' },
      'EGP': { symbol: 'E£', locale: 'en-US', code: 'EGP', customFormat: true, position: 'before' },
      'MAD': { symbol: 'MAD', locale: 'en-US', code: 'MAD', customFormat: true, position: 'before' },
      'GHS': { symbol: 'GH₵', locale: 'en-GH', code: 'GHS', customFormat: true, position: 'before' }
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

  // Format USD value
  const formatUSD = (amount: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
    }).format(amount);
  };

  // Currency display component
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
    
    console.log('CurrencyDisplay inputs:', { usd, sui, currencyType, suiPrice, isPriceStale });
    
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
            <span className={`inline-flex cursor-help items-center ${className}`}>
              {displayLocalAmount !== null ? formatCurrency(displayLocalAmount, currencyType) : `${formatCurrency(0, currencyType)}`} 
              <span className="ml-1 text-sm text-[#667085]">({formattedSui} SUI)</span>
              {isPriceStale && <span title="Using cached price">⚠️</span>}
            </span>
          </Tooltip.Trigger>
          <Tooltip.Portal>
            <Tooltip.Content
              className="rounded-xl border border-[#d9d0c4] bg-[#1d2533] px-3 py-2 text-sm text-white shadow-[0_18px_48px_-24px_rgba(15,23,42,0.55)]"
              sideOffset={5}
            >
              <div className="space-y-1">
                <p>Current SUI Conversion Rate:</p>
                <p>1 SUI = {formatUSD(suiPrice)}</p>
                <p className="text-xs text-white/70">
                  {isPriceStale 
                    ? "Using cached price - service temporarily unavailable" 
                    : "Updated price data from CoinGecko"}
                </p>
                <p className="text-xs text-[#b9c8dd]">
                  Currency: {currencyType}
                </p>
                <p className="text-xs text-white/70">
                  Note: SUI amount was calculated at circle creation time
                </p>
              </div>
              <Tooltip.Arrow className="fill-[#1d2533]" />
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

  // Add formatCycleInfo function to match dashboard display
  const formatCycleInfo = (cycleLength: number, cycleDay: number) => {
    // Cycle length: 0 = weekly, 1 = monthly, 2 = quarterly, 3 = bi-weekly
    let cyclePeriod = '';
    let dayFormat = '';
    
    // Validate inputs to avoid errors
    const validCycleLength = typeof cycleLength === 'number' ? cycleLength : 0;
    let validCycleDay = typeof cycleDay === 'number' ? cycleDay : 0;
    
    // Prepare weekdays array used in multiple cases
    const weekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

    // Ensure cycle day is in valid range based on the *actual* cycle length rules
    if ((validCycleLength === 0 || validCycleLength === 3) && validCycleDay > 6) validCycleDay = 0; // Weekly/Bi-Weekly (0-6)
    if ((validCycleLength === 1 || validCycleLength === 2) && (validCycleDay <= 0 || validCycleDay > 28)) validCycleDay = 1; // Monthly/Quarterly (1-28)
    
    switch (validCycleLength) {
      case 0: // Weekly
        cyclePeriod = 'Weekly';
        // For weekly, cycleDay is 0-6
        dayFormat = weekdays[validCycleDay] || weekdays[0]; // Default to Monday if out of range
        break;
      case 3: // Bi-Weekly (NEW)
        cyclePeriod = 'Bi-Weekly';
        // For bi-weekly, cycleDay is 0-6 (like weekly)
        dayFormat = weekdays[validCycleDay] || weekdays[0]; // Default to Monday if out of range
        break;
      case 1: // Monthly
        cyclePeriod = 'Monthly';
        // Ensure we have a valid day (1-28)
        dayFormat = getOrdinalSuffix(validCycleDay);
        break;
      case 2: // Quarterly
        cyclePeriod = 'Quarterly';
        // Ensure we have a valid day (1-28)
        dayFormat = getOrdinalSuffix(validCycleDay);
        break;
      default:
        cyclePeriod = 'Unknown';
        dayFormat = `Day ${validCycleDay === 0 ? 1 : validCycleDay}`;
    }
    
    // Return string with day format only, removing " day" suffix if using ordinals
    if (validCycleLength === 1 || validCycleLength === 2) {
        return `${cyclePeriod} (${dayFormat.replace(' day', '')})`;
    } else {
        return `${cyclePeriod} (${dayFormat})`;
    }
  };

  // Helper to format dates with ordinal suffix
  const getOrdinalSuffix = (day: number) => {
    const suffixes = ['th', 'st', 'nd', 'rd'];
    const relevantDigits = (day % 100);
    
    // Special case for 11, 12, 13
    if (relevantDigits >= 11 && relevantDigits <= 13) {
      return `${day}th`;
    }
    
    // For other numbers, use last digit
    const lastDigit = day % 10;
    const suffix = lastDigit >= 1 && lastDigit <= 3 ? suffixes[lastDigit] : suffixes[0];
    return `${day}${suffix}`;
  };

  // Add the missing function to calculate potential next payout date
  const calculatePotentialNextPayoutDate = (cycleLength: number, cycleDay: number): number => {
    try {
      // Get the current date
      const now = new Date();
      
      // Create a new date for the potential payout
      const potentialDate = new Date();
      
      // Set to beginning of day
      potentialDate.setHours(0, 0, 0, 0);
      
      // Handle different cycle types
      switch (cycleLength) {
        case 0: // Weekly
          // Adjust day of week (0-6, with 0 being Sunday)
          // Convert our day (0-6, with 0 being Monday) to JavaScript's day of week
          const targetDay = cycleDay === 6 ? 0 : cycleDay + 1; // Convert from Mon-Sun (0-6) to Sun-Sat (0-6)
          const currentDay = potentialDate.getDay(); // Sunday = 0, Monday = 1, etc.
          
          // Calculate days to add
          let daysToAdd = targetDay - currentDay;
          if (daysToAdd <= 0) {
            daysToAdd += 7; // Go to next week if the day has passed or is today
          }
          
          potentialDate.setDate(potentialDate.getDate() + daysToAdd);
          break;
          
        case 1: // Monthly
          // Set to the specified day of the current month
          potentialDate.setDate(cycleDay);
          
          // If that day has passed this month, go to next month
          if (potentialDate.getTime() <= now.getTime()) {
            potentialDate.setMonth(potentialDate.getMonth() + 1);
          }
          
          // Handle invalid dates (e.g., Feb 30 becomes Mar 2)
          // If the day changed, it means we hit an invalid date
          if (potentialDate.getDate() !== cycleDay) {
            // Go back to the last day of the previous month
            potentialDate.setDate(0);
          }
          break;
          
        case 2: // Quarterly
          // Start with current month
          const currentMonth = now.getMonth();
          
          // Determine which quarter we're in
          const currentQuarter = Math.floor(currentMonth / 3);
          
          // Calculate the month of the next quarter
          let nextQuarterMonth = (currentQuarter + 1) * 3;
          
          // If we're at Q4, wrap around to Q1 of next year
          if (nextQuarterMonth >= 12) {
            nextQuarterMonth = 0;
            potentialDate.setFullYear(potentialDate.getFullYear() + 1);
          }
          
          // Set to the first month of the next quarter
          potentialDate.setMonth(nextQuarterMonth);
          
          // Set the day
          potentialDate.setDate(cycleDay);
          
          // Handle invalid dates (e.g., Feb 30)
          if (potentialDate.getDate() !== cycleDay) {
            // Go back to the last day of the previous month
            potentialDate.setDate(0);
          }
          break;
          
        default:
          console.error('Unknown cycle length:', cycleLength);
          return now.getTime();
      }
      
      // Set payout time to 12 PM UTC
      potentialDate.setUTCHours(12, 0, 0, 0);
      
      // Return timestamp in milliseconds
      return potentialDate.getTime();
    } catch (error) {
      console.error('Error calculating potential next payout date:', error);
      return new Date().getTime(); // Fallback to current time
    }
  };

  if (authLoading || !isAuthenticated || !account) {
    return null;
  }

  const isAdmin = circle?.admin === userAddress;
  const recoveryProposal = recoveryStatus?.proposal ?? null;
  const recoveryProposalUi = recoveryProposal
    ? getRecoveryProposalUiState({
        proposal: recoveryProposal,
        userAddress,
      })
    : null;
  const recoveryProposalPassed = recoveryProposalUi?.isPassed ?? false;
  const recoveryProposalFailed = recoveryProposalUi?.isFailed ?? false;
  const recoveryDeadlinePassed = recoveryProposalUi?.isDeadlinePassed ?? false;
  const currentUserVote = recoveryProposalUi?.currentUserVote ?? null;
  const currentUserEligibleToVote = recoveryProposalUi?.currentUserEligibleToVote ?? false;
  const canVoteOnRecoveryProposal = recoveryProposalUi?.canVote ?? false;
  const autoReleaseUi = getRecoveryAutoReleaseUiState({
    recoveryStatus,
    adminAddress: circle?.admin,
    userAddress,
    viewerIsEligibleActiveMember: viewerCanAutoReleaseFallback,
    delegateIsEligibleActiveMember: delegateCanAutoReleaseFallback,
  });
  const recoveryStablecoinMeta = resolveStablecoinMetadata(
    recoveryStablecoinType || circle?.custody?.stablecoinCoinType || null,
  );
  const canTriggerAutoRelease = autoReleaseUi.viewerCanTrigger;
  const recoveryExecutionStarted = Boolean(recoveryExecution?.startedAt);
  const recoveryExecutionCompleted = Boolean(recoveryExecution?.completedAt) || recoveryStatus?.rawState === 3;
  const recoveryExecutionProgress = recoveryExecution
    ? Math.min(100, (recoveryExecution.refundedMembers / Math.max(recoveryExecution.totalMembers, 1)) * 100)
    : recoveryStatus?.rawState === 3
      ? 100
      : 0;
  const formatRecoveryAssetAmount = (rawAmount: bigint, decimals: number, label: string) =>
    `${(Number(rawAmount) / 10 ** decimals).toLocaleString(undefined, {
      minimumFractionDigits: 0,
      maximumFractionDigits: decimals === 9 ? 4 : 2,
    })} ${label}`;
  const shouldShowRecoverySection = Boolean(
    recoveryProposal
      || recoveryExecution
      || recoveryStatus?.autoReleaseEnabled
      || recoveryStatus?.rawState === 2
      || recoveryStatus?.rawState === 3,
  );
  const estimatedNextPayout = circle
    ? calculatePotentialNextPayoutDate(circle.cycleLength, circle.cycleDay)
    : 0;
  const pageSurfaceClass =
    'rounded-[30px] border border-[#ddd5c9] bg-white/88 shadow-[0_30px_90px_-62px_rgba(15,23,42,0.42)] backdrop-blur';
  const detailCardClass =
    'rounded-[24px] border border-[#e9e1d6] bg-[#fbfaf7] shadow-[0_24px_60px_-56px_rgba(15,23,42,0.42)]';
  const detailLabelClass =
    'text-[11px] font-semibold uppercase tracking-[0.22em] text-[#7a818e]';
  const pillBaseClass =
    'inline-flex items-center gap-2 rounded-full border px-3 py-2 text-sm font-medium';

  const handleVoteEmergencyStop = async (yesVote: boolean) => {
    if (!circle || !account) {
      toast.error('Circle or account information is unavailable.');
      return;
    }

    const confirmed = window.confirm(
      `Cast a ${yesVote ? 'YES' : 'NO'} vote on the emergency stop proposal? This action is recorded onchain and cannot be changed.`,
    );
    if (!confirmed) return;

    setIsSubmittingRecoveryVote(true);
    const toastId = `vote-recovery-${yesVote ? 'yes' : 'no'}`;

    try {
      toast.loading(`Submitting ${yesVote ? 'approval' : 'rejection'} vote...`, { id: toastId });
      const zkLoginClient = ZkLoginClient.getInstance();
      await zkLoginClient.voteEmergencyStop(account, {
        circleId: circle.id,
        yesVote,
        network: getCurrentNetwork(),
      });

      toast.success(`Your ${yesVote ? 'approval' : 'rejection'} vote was recorded.`, { id: toastId });
      await Promise.all([
        fetchCircleDetails(),
        fetchRecoveryStatus(),
        fetchRecoveryExecutionState(),
        fetchRecoveryLivenessState(),
      ]);
    } catch (error) {
      console.error('Details - Failed to vote on recovery proposal:', error);
      if (error instanceof ZkLoginError && error.requireRelogin) {
        router.push('/');
        return;
      }
      toast.error(error instanceof Error ? error.message : 'Failed to cast vote', { id: toastId });
    } finally {
      setIsSubmittingRecoveryVote(false);
    }
  };

  const handleTriggerAutoRelease = async () => {
    if (!circle || !circle.custody?.walletId || !account) {
      toast.error('Recovery wallet information is unavailable.');
      return;
    }

    const stablecoinType = recoveryStablecoinType || circle.custody.stablecoinCoinType;
    if (!stablecoinType) {
      toast.error('Stablecoin type is unavailable for this custody wallet.');
      return;
    }

    const confirmed = window.confirm(
      'Trigger the admin-liveness fallback now? This stops the circle and returns tracked funds to their recorded owners.',
    );
    if (!confirmed) {
      return;
    }

    setIsSubmittingAutoRelease(true);
    const toastId = 'trigger-auto-release';

    try {
      toast.loading('Triggering auto-release recovery...', { id: toastId });
      const zkLoginClient = ZkLoginClient.getInstance();
      await zkLoginClient.triggerAutoRelease(account, {
        circleId: circle.id,
        walletId: circle.custody.walletId,
        stablecoinType,
        network: getCurrentNetwork(),
      });

      toast.success('Auto-release recovery submitted.', { id: toastId });
      await Promise.all([
        fetchCircleDetails(),
        fetchRecoveryStatus(),
        fetchRecoveryExecutionState(),
        fetchRecoveryLivenessState(),
      ]);
    } catch (error) {
      console.error('Details - Failed to trigger auto-release:', error);
      if (error instanceof ZkLoginError && error.requireRelogin) {
        router.push('/');
        return;
      }
      toast.error(error instanceof Error ? error.message : 'Failed to trigger auto-release', { id: toastId });
    } finally {
      setIsSubmittingAutoRelease(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#f6f3ee] text-[#171923]">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[420px] bg-[radial-gradient(circle_at_top_left,_rgba(108,122,147,0.16),_transparent_34%),radial-gradient(circle_at_85%_8%,_rgba(218,204,178,0.28),_transparent_24%),linear-gradient(180deg,_rgba(255,255,255,0.58)_0%,_rgba(246,243,238,0)_72%)]" />

      <main className="relative mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8 lg:py-10">
        <div className="mb-6 flex flex-wrap items-center gap-3">
          <button
            onClick={() => router.push('/dashboard')}
            className="inline-flex items-center gap-2 rounded-full border border-[#d7cec1] bg-white px-4 py-2.5 text-sm font-semibold text-[#334155] shadow-[0_18px_36px_-30px_rgba(15,23,42,0.42)] transition-all duration-200 hover:-translate-y-0.5 hover:bg-[#fbfaf7]"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to dashboard
          </button>

          {!loading && circle && (
            <>
              <span
                className={`${pillBaseClass} ${
                  circle.isActive
                    ? 'border-[#cfe2d5] bg-[#eef7f0] text-[#24553a]'
                    : 'border-[#e5dac9] bg-[#fcf7ef] text-[#8a5a21]'
                }`}
              >
                {circle.isActive ? (
                  <CheckCircle2 className="h-4 w-4" />
                ) : (
                  <CircleDot className="h-4 w-4" />
                )}
                {circle.isActive ? 'Active circle' : 'Awaiting activation'}
              </span>
              <RecoveryStateBadge rawState={recoveryStatus?.rawState} stateLabel={recoveryStatus?.stateLabel} />
            </>
          )}
        </div>

        {loading ? (
          <div className={`${pageSurfaceClass} p-12 text-center`}>
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full border border-[#d9d0c4] bg-white">
              <svg
                className="h-7 w-7 animate-spin text-[#6b7b92]"
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                />
              </svg>
            </div>
            <h2 className="mt-5 text-2xl font-semibold tracking-[-0.04em] text-[#171923]">
              Loading circle details
            </h2>
            <p className="mt-2 text-sm leading-6 text-[#667085] sm:text-base">
              Fetching membership, configuration, and payout timing from the
              selected network.
            </p>
          </div>
        ) : circle ? (
          <div className="grid gap-6 xl:grid-cols-[minmax(0,1.45fr)_360px]">
            <section className="space-y-6">
              <div className={`${pageSurfaceClass} overflow-hidden`}>
                <div className="border-b border-[#e7dfd4] bg-[linear-gradient(135deg,rgba(243,246,251,0.95),rgba(251,250,247,0.9))] px-6 py-6 sm:px-8 sm:py-8">
                  <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
                    <div className="max-w-2xl">
                      <span className={detailLabelClass}>Circle overview</span>
                      <h1 className="mt-4 text-3xl font-semibold tracking-[-0.04em] text-[#171923] sm:text-[2.4rem]">
                        {circle.name}
                      </h1>
                      <p className="mt-3 max-w-xl text-sm leading-7 text-[#5f6674] sm:text-base">
                        {isAdmin
                          ? 'You manage this circle.'
                          : 'You are viewing this circle as a member.'}{' '}
                        Contributions follow a{' '}
                        {formatCycleInfo(circle.cycleLength, circle.cycleDay).toLowerCase()}{' '}
                        cadence and settle on the currently selected network.
                      </p>

                      <div className="mt-5 flex flex-wrap gap-3">
                        <span className={`${pillBaseClass} border-[#dde5ef] bg-white text-[#51627b]`}>
                          <Users className="h-4 w-4" />
                          {circle.currentMembers}/{circle.maxMembers} members
                        </span>
                        <span className={`${pillBaseClass} border-[#dde5ef] bg-white text-[#51627b]`}>
                          <CalendarDays className="h-4 w-4" />
                          {formatCycleInfo(circle.cycleLength, circle.cycleDay)}
                        </span>
                        <span className={`${pillBaseClass} border-[#dde5ef] bg-white text-[#51627b]`}>
                          <Wallet className="h-4 w-4" />
                          {circle.currencyType || 'USD'} settlement
                        </span>
                      </div>
                    </div>

                    <div className={`${detailCardClass} w-full max-w-sm p-5`}>
                      <p className={detailLabelClass}>
                        {circle.isActive ? 'Next payout' : 'Projected first payout'}
                      </p>
                      <div className="mt-4 flex items-start gap-3">
                        <CalendarDays className="mt-1 h-5 w-5 text-[#70819a]" />
                        <div>
                          {circle.isActive ? (
                            <>
                              <p className="text-2xl font-semibold tracking-[-0.04em] text-[#171923]">
                                {formatDate(circle.nextPayoutTime)}
                              </p>
                              <p className="mt-2 text-sm leading-6 text-[#5f6674]">
                                The current cycle is active and payout timing is
                                already scheduled on-chain.
                              </p>
                            </>
                          ) : (
                            <>
                              <p className="text-lg font-semibold tracking-[-0.03em] text-[#171923]">
                                Activate circle to start
                              </p>
                              <p className="mt-2 text-sm leading-6 text-[#5f6674]">
                                Estimated first payout: {formatDate(estimatedNextPayout)}
                              </p>
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="p-6 sm:p-8">
                  <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                    <div className={`${detailCardClass} p-5`}>
                      <div className="flex h-10 w-10 items-center justify-center rounded-2xl border border-[#e3dbcf] bg-white text-[#6b7b92]">
                        <Wallet className="h-4 w-4" />
                      </div>
                      <p className={`mt-5 ${detailLabelClass}`}>Contribution amount</p>
                      <CurrencyDisplay
                        usd={circle.contributionAmountUsd}
                        sui={circle.contributionAmount}
                        currencyType={circle.currencyType}
                        className="mt-3 text-lg font-semibold text-[#171923]"
                      />
                    </div>

                    <div className={`${detailCardClass} p-5`}>
                      <div className="flex h-10 w-10 items-center justify-center rounded-2xl border border-[#e3dbcf] bg-white text-[#6b7b92]">
                        <Shield className="h-4 w-4" />
                      </div>
                      <p className={`mt-5 ${detailLabelClass}`}>Security deposit</p>
                      <CurrencyDisplay
                        usd={circle.securityDepositUsd}
                        sui={circle.securityDeposit}
                        currencyType={circle.currencyType}
                        className="mt-3 text-lg font-semibold text-[#171923]"
                      />
                    </div>

                    <div className={`${detailCardClass} p-5`}>
                      <div className="flex h-10 w-10 items-center justify-center rounded-2xl border border-[#e3dbcf] bg-white text-[#6b7b92]">
                        <Users className="h-4 w-4" />
                      </div>
                      <p className={`mt-5 ${detailLabelClass}`}>Members</p>
                      <p className="mt-3 text-lg font-semibold text-[#171923]">
                        {circle.currentMembers} / {circle.maxMembers}
                      </p>
                    </div>

                    <div className={`${detailCardClass} p-5`}>
                      <div className="flex h-10 w-10 items-center justify-center rounded-2xl border border-[#e3dbcf] bg-white text-[#6b7b92]">
                        <CalendarDays className="h-4 w-4" />
                      </div>
                      <p className={`mt-5 ${detailLabelClass}`}>Cycle cadence</p>
                      <p className="mt-3 text-lg font-semibold text-[#171923]">
                        {formatCycleInfo(circle.cycleLength, circle.cycleDay)}
                      </p>
                    </div>
                  </div>
                </div>
              </div>

              {shouldShowRecoverySection && (
                <div className={`${pageSurfaceClass} p-6 sm:p-8`}>
                  <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
                    <div className="max-w-2xl">
                      <span className={detailLabelClass}>Emergency recovery</span>
                      <h2 className="mt-3 text-2xl font-semibold tracking-[-0.04em] text-[#171923]">
                        {recoveryStatus?.rawState === 3
                          ? 'Recovery completed'
                          : recoveryStatus?.rawState === 2
                            ? 'Recovery execution in progress'
                            : recoveryProposal
                              ? `Member vote ${recoveryProposalUi?.titleLabel || 'in progress'}`
                              : recoveryStatus?.autoReleaseEnabled
                                ? 'Admin liveness fallback'
                                : 'Recovery status'}
                      </h2>
                      <p className="mt-3 text-sm leading-7 text-[#5f6674]">
                        {recoveryStatus?.rawState === 3
                          ? 'The emergency recovery path finished onchain and tracked balances were returned to their recorded owners.'
                          : recoveryStatus?.rawState === 2
                            ? 'The circle has been stopped for recovery. Refund progress below reflects the unwind events emitted from custody.'
                            : recoveryProposalPassed
                              ? 'This emergency stop proposal has majority approval and is waiting for admin execution.'
                              : recoveryProposalFailed
                                ? 'This emergency stop proposal closed without majority approval. The vote path is no longer active.'
                                : recoveryProposal
                                  ? 'An emergency stop proposal is active for this circle. Eligible members can cast one vote to approve or reject the stop-and-refund action.'
                                  : 'This circle has a heartbeat-based fallback. If the admin disappears long enough, the designated delegate gets the first 24 hours to trigger the stop-and-refund path before eligible active members inherit fallback rights.'}
                      </p>
                    </div>

                    <div className={`${detailCardClass} w-full max-w-sm p-5`}>
                      <div className="flex items-center justify-between gap-3">
                        <p className={detailLabelClass}>Recovery state</p>
                        <button
                          type="button"
                          onClick={() => {
                            void fetchRecoveryStatus();
                            void fetchRecoveryExecutionState();
                            void fetchRecoveryLivenessState();
                          }}
                          disabled={loadingRecoveryStatus || loadingRecoveryExecution || loadingRecoveryLiveness}
                          className="inline-flex items-center gap-2 rounded-full border border-[#d7cec1] bg-white px-3 py-2 text-xs font-semibold text-[#334155] transition-colors hover:bg-[#fbfaf7] disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          <RefreshCw className={`h-3.5 w-3.5 ${(loadingRecoveryStatus || loadingRecoveryExecution || loadingRecoveryLiveness) ? 'animate-spin' : ''}`} />
                          Refresh
                        </button>
                      </div>

                      <div className="mt-4">
                        <RecoveryStateBadge
                          rawState={recoveryStatus?.rawState}
                          stateLabel={recoveryStatus?.stateLabel || (loadingRecoveryStatus ? 'Loading' : 'Active')}
                        />
                      </div>

                      <p className="mt-3 text-sm leading-6 text-[#5f6674]">
                        {recoveryProposal
                          ? `Proposal deadline: ${formatDate(recoveryProposal.deadline, true)}`
                          : recoveryExecution?.startedAt
                            ? `Execution started: ${formatDate(recoveryExecution.startedAt, true)}`
                            : recoveryStatus?.autoReleaseEnabled
                              ? `Heartbeat expiry: ${recoveryStatus.autoReleaseTriggerTime ? formatDate(recoveryStatus.autoReleaseTriggerTime, true) : 'Not configured'}`
                              : 'No emergency recovery proposal is active right now.'}
                      </p>
                      <p className="mt-1 text-sm leading-6 text-[#5f6674]">
                        {recoveryProposalUi?.deadlineSummary
                          ? recoveryProposalUi.deadlineSummary
                          : recoveryProposal && !recoveryDeadlinePassed
                            ? `${formatRelativeDuration(recoveryProposal.deadline - Date.now())} remaining`
                            : recoveryExecutionCompleted
                              ? 'Recovery execution has finalized onchain.'
                              : recoveryExecutionStarted
                                ? 'Refund execution is still in progress.'
                                : recoveryStatus?.autoReleaseEnabled
                                  ? autoReleaseUi.ready
                                    ? 'The heartbeat window has expired and the fallback path is open.'
                                    : `${formatRelativeDuration(autoReleaseUi.remainingMs)} until the fallback opens.`
                                  : 'Refresh this card to pull the latest onchain recovery events.'}
                      </p>
                    </div>
                  </div>

                  {recoveryProposal && recoveryProposalUi && (
                    <RecoveryProposalCard
                      eyebrow="Member vote"
                      title={`Emergency stop ${recoveryProposalUi.titleLabel}`}
                      description={
                        recoveryProposalPassed
                          ? 'Member-majority approval is locked in. The admin can now execute the stop-and-refund path.'
                          : recoveryProposalFailed
                            ? 'This proposal closed without meeting the majority threshold.'
                            : 'Eligible members can cast one irreversible onchain vote on whether this circle should halt and unwind funds.'
                      }
                      stateLabel={recoveryStatus?.stateLabel || 'Proposal Pending'}
                      rawState={recoveryStatus?.rawState ?? 1}
                      proposal={recoveryProposal}
                      proposalUi={recoveryProposalUi}
                      now={Date.now()}
                      formatDate={formatDate}
                      formatRelativeDuration={formatRelativeDuration}
                      onRefresh={() => {
                        void fetchRecoveryStatus();
                        void fetchRecoveryExecutionState();
                        void fetchRecoveryLivenessState();
                      }}
                      loading={loadingRecoveryStatus || loadingRecoveryExecution || loadingRecoveryLiveness}
                      className="mt-6 border-[#e9e1d6] bg-[#fbfaf7]"
                      footerTags={
                        <>
                          {currentUserVote && (
                            <span className="inline-flex items-center rounded-full bg-[#eef7f0] px-3 py-1 text-xs font-medium text-[#24553a]">
                              You voted {currentUserVote.approved ? 'yes' : 'no'}
                            </span>
                          )}
                          {!currentUserVote && currentUserEligibleToVote && (
                            <span className="inline-flex items-center rounded-full bg-[#fff5e7] px-3 py-1 text-xs font-medium text-[#8a5a21]">
                              Your vote is still required
                            </span>
                          )}
                        </>
                      }
                      actionArea={
                        canVoteOnRecoveryProposal ? (
                          <div className="rounded-[24px] border border-[#e9e1d6] bg-white p-5">
                            <p className={detailLabelClass}>Cast your vote</p>
                            <p className="mt-3 text-sm leading-7 text-[#5f6674]">
                              Votes are submitted onchain individually by each eligible member and cannot be changed after confirmation.
                            </p>
                            <div className="mt-5 flex flex-wrap gap-3">
                              <button
                                type="button"
                                onClick={() => handleVoteEmergencyStop(true)}
                                disabled={isSubmittingRecoveryVote}
                                className="inline-flex items-center gap-2 rounded-2xl bg-[#d28a2d] px-4 py-3 text-sm font-semibold text-white transition-all duration-200 hover:-translate-y-0.5 hover:bg-[#b97721] disabled:cursor-not-allowed disabled:opacity-50"
                              >
                                <CheckCircle2 className="h-4 w-4" />
                                Vote yes
                              </button>
                              <button
                                type="button"
                                onClick={() => handleVoteEmergencyStop(false)}
                                disabled={isSubmittingRecoveryVote}
                                className="inline-flex items-center gap-2 rounded-2xl border border-[#d7cec1] bg-white px-4 py-3 text-sm font-semibold text-[#334155] transition-all duration-200 hover:-translate-y-0.5 hover:bg-[#fbfaf7] disabled:cursor-not-allowed disabled:opacity-50"
                              >
                                <CircleDot className="h-4 w-4" />
                                Vote no
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className={`rounded-[18px] border p-4 text-sm leading-6 ${
                            recoveryProposalUi.closedVoteTone === 'success'
                              ? 'border-[#cfe2d5] bg-[#eef7f0] text-[#24553a]'
                              : recoveryProposalUi.closedVoteTone === 'danger'
                                ? 'border-[#ead6d0] bg-[#fdf2f1] text-[#8f3f34]'
                                : 'border-[#e9e1d6] bg-white text-[#5f6674]'
                          }`}>
                            {recoveryProposalUi.closedVoteMessage}
                          </div>
                        )
                      }
                    />
                  )}

                  {!recoveryProposal && (recoveryStatus?.rawState === 2 || recoveryStatus?.rawState === 3) && (
                    <div className={`${detailCardClass} mt-6 p-5`}>
                      <p className={detailLabelClass}>Proposal</p>
                      <h3 className="mt-3 text-xl font-semibold tracking-[-0.03em] text-[#171923]">
                        Vote window closed
                      </h3>
                      <p className="mt-3 text-sm leading-7 text-[#5f6674]">
                        The circle is already in a recovery lifecycle state, so proposal voting is no longer the active control path.
                      </p>
                    </div>
                  )}

                  <div className={`${detailCardClass} mt-6 p-5`}>
                    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                      <div>
                        <p className={detailLabelClass}>Admin liveness fallback</p>
                        <h3 className="mt-2 text-xl font-semibold tracking-[-0.03em] text-[#171923]">
                          {recoveryStatus?.autoReleaseEnabled ? 'Delegate and member fallback' : 'Fallback not configured'}
                        </h3>
                        <p className="mt-2 text-sm leading-6 text-[#5f6674]">
                          {recoveryStatus?.autoReleaseEnabled
                            ? 'Heartbeat expiry opens a delegate-exclusive recovery window first. If the delegate is invalid at expiry or does not act within 24 hours, eligible active non-admin members become the fallback.'
                            : 'This circle was created without the admin-liveness fallback, so the vote path is the only recovery path available here.'}
                        </p>
                      </div>
                      {canTriggerAutoRelease && (
                        <button
                          type="button"
                          onClick={handleTriggerAutoRelease}
                          disabled={isSubmittingAutoRelease || loadingRecoveryExecution}
                          className="inline-flex items-center gap-2 rounded-2xl bg-[#d28a2d] px-4 py-3 text-sm font-semibold text-white transition-all duration-200 hover:-translate-y-0.5 hover:bg-[#b97721] disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          <AlertTriangle className="h-4 w-4" />
                          {isSubmittingAutoRelease ? 'Triggering...' : 'Trigger Auto-Release'}
                        </button>
                      )}
                    </div>

                    <div className="mt-5 grid gap-3 sm:grid-cols-2">
                      <div className={`${detailCardClass} border-[#e9e1d6] bg-white p-4 shadow-none`}>
                        <p className={detailLabelClass}>Last admin heartbeat</p>
                        <p className="mt-2 text-sm font-semibold text-[#171923]">
                          {recoveryStatus?.autoReleaseEnabled
                            ? formatDate(recoveryStatus.lastAdminHeartbeatAt, true)
                            : 'Not configured'}
                        </p>
                        <p className="mt-1 text-xs text-[#5f6674]">
                          {recoveryStatus?.autoReleaseEnabled
                            ? autoReleaseUi.ready
                              ? 'The liveness window has expired.'
                              : `${formatRelativeDuration(autoReleaseUi.remainingMs)} until expiry`
                            : 'No heartbeat window exists for this circle.'}
                        </p>
                      </div>
                      <div className={`${detailCardClass} border-[#e9e1d6] bg-white p-4 shadow-none`}>
                        <p className={detailLabelClass}>Member fallback unlocks</p>
                        <p className="mt-2 text-sm font-semibold text-[#171923]">
                          {autoReleaseUi.memberFallbackUnlockTime
                            ? formatDate(autoReleaseUi.memberFallbackUnlockTime, true)
                            : 'Not configured'}
                        </p>
                        <p className="mt-1 text-xs text-[#5f6674]">
                          {recoveryStatus?.autoReleaseEnabled
                            ? autoReleaseUi.memberFallbackReady
                              ? 'Eligible active members can use the fallback now.'
                              : autoReleaseUi.delegateStatus === 'valid'
                                ? 'Members inherit trigger rights only after the 24-hour delegate window ends.'
                                : 'If the delegate is invalid at expiry, member fallback opens immediately.'
                            : 'No fallback trigger timestamp exists.'}
                        </p>
                      </div>
                      <div className={`${detailCardClass} border-[#e9e1d6] bg-white p-4 shadow-none`}>
                        <p className={detailLabelClass}>Next in command</p>
                        <p className="mt-2 break-all font-mono text-sm font-semibold text-[#171923]">
                          {autoReleaseUi.configuredDelegate ? autoReleaseUi.configuredDelegate : 'Not configured'}
                        </p>
                        <p className="mt-1 text-xs text-[#5f6674]">
                          {autoReleaseUi.delegateStatus === 'valid'
                            ? 'This wallet is currently active and gets the first 24 hours of trigger authority after heartbeat expiry.'
                            : autoReleaseUi.delegateStatus === 'invalid'
                              ? 'A delegate is configured, but that wallet is no longer an eligible active member.'
                              : 'Auto-release now requires a valid delegate wallet to be configured.'}
                        </p>
                      </div>
                      <div className={`${detailCardClass} border-[#e9e1d6] bg-white p-4 shadow-none`}>
                        <p className={detailLabelClass}>Your role</p>
                        <p className="mt-2 text-sm font-semibold text-[#171923]">
                          {autoReleaseUi.viewerRole === 'admin'
                            ? 'Admin'
                            : autoReleaseUi.viewerRole === 'delegate'
                              ? 'Designated delegate'
                              : autoReleaseUi.viewerRole === 'member_fallback'
                                ? 'Active-member fallback'
                                : autoReleaseUi.viewerRole === 'member_waiting_delegate'
                                  ? 'Active member, delegate ahead'
                                  : 'Not eligible'}
                        </p>
                        <p className="mt-1 text-xs text-[#5f6674]">
                          {autoReleaseUi.viewerRole === 'admin'
                            ? 'Admins refresh the heartbeat through signed circle actions, but admins cannot trigger auto-release themselves.'
                            : autoReleaseUi.viewerRole === 'delegate'
                              ? autoReleaseUi.ready
                                ? autoReleaseUi.memberFallbackReady
                                  ? 'The delegate-exclusive window has ended, but you can still trigger recovery as an eligible active member.'
                                  : 'You are in the delegate-exclusive recovery window right now.'
                                : 'You become the first authorized fallback caller once the heartbeat expires.'
                              : autoReleaseUi.viewerRole === 'member_fallback'
                                ? autoReleaseUi.ready
                                  ? autoReleaseUi.delegateStatus === 'valid'
                                    ? 'The 24-hour delegate window has ended, so you can now trigger recovery as an eligible active member.'
                                    : 'No valid delegate exists, so you can trigger recovery now as an active non-admin member.'
                                  : autoReleaseUi.delegateStatus === 'valid'
                                    ? 'You can trigger recovery if the delegate does not respond within 24 hours after heartbeat expiry.'
                                    : 'If no valid delegate exists when the heartbeat expires, you will be eligible to trigger recovery.'
                                : autoReleaseUi.viewerRole === 'member_waiting_delegate'
                                  ? 'A valid delegate exists, so active members stay blocked until the 24-hour delegate window ends unless that delegate becomes invalid first.'
                                  : 'Only eligible active members can use this fallback path.'}
                        </p>
                      </div>
                    </div>

                    <div className={`mt-5 rounded-[18px] border p-4 text-sm leading-6 ${
                      canTriggerAutoRelease
                        ? 'border-[#e6c28f] bg-[#fff5e7] text-[#8a5a21]'
                        : autoReleaseUi.ready
                          ? 'border-[#e9e1d6] bg-white text-[#5f6674]'
                          : 'border-[#e9e1d6] bg-white text-[#5f6674]'
                    }`}>
                      {recoveryStatus?.rawState === 2 || recoveryStatus?.rawState === 3 ? (
                        'The circle is already in the recovery lifecycle, so the heartbeat fallback is no longer the active control path.'
                      ) : !recoveryStatus?.autoReleaseEnabled ? (
                        'No auto-release fallback is configured for this circle.'
                      ) : canTriggerAutoRelease ? (
                        'You satisfy the current onchain authorization rules and can trigger the stop-and-refund recovery path now.'
                      ) : autoReleaseUi.viewerRole === 'admin' ? (
                        'Admins cannot use the fallback trigger. If recovery is needed now and the vote has passed, use the admin execution path instead.'
                      ) : autoReleaseUi.viewerRole === 'member_waiting_delegate' ? (
                        'The heartbeat may expire, but the designated delegate keeps exclusive authority for the first 24 hours while they remain valid.'
                      ) : autoReleaseUi.ready ? (
                        'The fallback window is open, but your wallet is not eligible to trigger it.'
                      ) : (
                        'The heartbeat window is still active. This card will switch to a triggerable state automatically when the expiry time is reached for the correct caller.'
                      )}
                    </div>
                  </div>

                  {(recoveryExecutionStarted || recoveryStatus?.rawState === 2 || recoveryStatus?.rawState === 3) && (
                    <div className={`${detailCardClass} mt-6 p-5`}>
                      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                        <div>
                          <p className={detailLabelClass}>Execution</p>
                          <h3 className="mt-2 text-xl font-semibold tracking-[-0.03em] text-[#171923]">Refund progress</h3>
                          <p className="mt-2 text-sm leading-6 text-[#5f6674]">
                            Recovery execution emits per-member refund events and a completion summary when the unwind finishes.
                          </p>
                        </div>
                        <span className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium ${
                          recoveryExecutionCompleted
                            ? 'bg-[#eef7f0] text-[#24553a]'
                            : 'bg-[#fff5e7] text-[#8a5a21]'
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
                          <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                            <div className={`${detailCardClass} p-5`}>
                              <p className={detailLabelClass}>Started</p>
                              <p className="mt-3 text-sm font-semibold text-[#171923]">
                                {formatDate(recoveryExecution.startedAt, true)}
                              </p>
                              <p className="mt-1 text-sm text-[#5f6674]">
                                by {recoveryExecution.executor.slice(0, 6)}...{recoveryExecution.executor.slice(-4)}
                              </p>
                            </div>
                            <div className={`${detailCardClass} p-5`}>
                              <p className={detailLabelClass}>Path</p>
                              <p className="mt-3 text-sm font-semibold text-[#171923]">
                                {recoveryExecution.usedAutoRelease ? 'Auto-release fallback' : 'Member-vote execution'}
                              </p>
                              <p className="mt-1 text-sm text-[#5f6674]">
                                {recoveryExecutionCompleted ? 'Execution finalized onchain' : 'Awaiting completion signal'}
                              </p>
                            </div>
                            <div className={`${detailCardClass} p-5`}>
                              <p className={detailLabelClass}>Members refunded</p>
                              <p className="mt-3 text-2xl font-semibold text-[#171923]">
                                {recoveryExecution.refundedMembers} / {recoveryExecution.totalMembers}
                              </p>
                              <p className="mt-1 text-sm text-[#5f6674]">Members with non-zero refunds processed</p>
                            </div>
                            <div className={`${detailCardClass} p-5`}>
                              <p className={detailLabelClass}>Completed</p>
                              <p className="mt-3 text-sm font-semibold text-[#171923]">
                                {recoveryExecution.completedAt ? formatDate(recoveryExecution.completedAt, true) : 'Pending'}
                              </p>
                              <p className="mt-1 text-sm text-[#5f6674]">
                                {recoveryStatus?.stateLabel || 'Recovery state unavailable'}
                              </p>
                            </div>
                          </div>

                          <div className="mt-6">
                            <div className="mb-2 flex items-center justify-between gap-3">
                              <p className="text-sm font-medium text-[#334155]">Execution progress</p>
                              <p className="text-xs text-[#7a818e]">
                                {recoveryExecution.refundedMembers} / {Math.max(recoveryExecution.totalMembers, 1)} members
                              </p>
                            </div>
                            <div className="h-3 rounded-full bg-[#e8e0d3]">
                              <div
                                className={`h-3 rounded-full transition-all duration-500 ${
                                  recoveryExecutionCompleted ? 'bg-[#2f7a51]' : 'bg-[#d28a2d]'
                                }`}
                                style={{ width: `${recoveryExecutionProgress}%` }}
                              />
                            </div>
                          </div>

                          <div className="mt-6 grid gap-4 sm:grid-cols-2">
                            <div className={`${detailCardClass} p-5`}>
                              <p className={detailLabelClass}>Total SUI refund</p>
                              <p className="mt-3 text-sm font-semibold text-[#171923]">
                                {formatRecoveryAssetAmount(recoveryExecution.totalSuiRefundRaw, 9, 'SUI')}
                              </p>
                            </div>
                            <div className={`${detailCardClass} p-5`}>
                              <p className={detailLabelClass}>Total stablecoin refund</p>
                              <p className="mt-3 text-sm font-semibold text-[#171923]">
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
                            formatDate={(timestamp) => formatDate(timestamp, true)}
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
                            className="mt-6 border-[#e9e1d6] bg-[#fbfaf7]"
                          />
                        </>
                      ) : (
                        <div className="mt-6 rounded-[18px] border border-[#e9e1d6] bg-white p-4 text-sm leading-6 text-[#5f6674]">
                          The circle is in a recovery lifecycle state, but the current RPC response has not returned execution events yet.
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </section>

            <aside className="space-y-6">
              <div className={`${pageSurfaceClass} p-6`}>
                <p className={detailLabelClass}>Circle access</p>
                <div className="mt-5 space-y-4">
                  <div className={`${detailCardClass} p-4`}>
                    <p className={detailLabelClass}>Circle ID</p>
                    <div className="mt-3 flex items-center justify-between gap-3">
                      <p className="text-sm font-semibold text-[#171923]">
                        {shortenId(circle.id)}
                      </p>
                      <button
                        onClick={() => copyToClipboard(circle.id, 'id')}
                        className={`inline-flex items-center gap-2 rounded-full border px-3 py-2 text-xs font-semibold transition-colors duration-200 ${
                          copiedId
                            ? 'border-[#cfe2d5] bg-[#eef7f0] text-[#24553a]'
                            : 'border-[#d7cec1] bg-white text-[#334155] hover:bg-[#fbfaf7]'
                        }`}
                      >
                        <Copy className="h-3.5 w-3.5" />
                        {copiedId ? 'Copied' : 'Copy'}
                      </button>
                    </div>
                  </div>

                  <div className={`${detailCardClass} p-4`}>
                    <p className={detailLabelClass}>Admin wallet</p>
                    <p className="mt-3 break-all text-sm font-medium leading-6 text-[#334155]">
                      {circle.admin}
                    </p>
                  </div>

                  {isAdmin && (
                    <button
                      onClick={() => copyToClipboard(circle.id, 'link')}
                      className="inline-flex w-full items-center justify-center gap-2 rounded-2xl border border-[#d7cec1] bg-white px-4 py-3 text-sm font-semibold text-[#334155] transition-all duration-200 hover:-translate-y-0.5 hover:bg-[#fbfaf7]"
                    >
                      <Link2 className="h-4 w-4" />
                      Copy invite link
                    </button>
                  )}
                </div>
              </div>

              <div className={`${pageSurfaceClass} p-6`}>
                <p className={detailLabelClass}>Actions</p>
                <h2 className="mt-3 text-xl font-semibold tracking-[-0.03em] text-[#171923]">
                  {isAdmin ? 'Run this circle' : 'Stay current on your turn'}
                </h2>
                <p className="mt-3 text-sm leading-6 text-[#5f6674]">
                  Move into the contribution flow, and if you are the admin,
                  step directly into circle management from here.
                </p>

                <div className="mt-6 space-y-3">
                  <button
                    onClick={() => router.push(`/circle/${circle.id}/contribute`)}
                    className="inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-[#1d2533] px-4 py-3.5 text-sm font-semibold text-white transition-all duration-200 hover:-translate-y-0.5 hover:bg-[#101723]"
                  >
                    Contribute
                    <ArrowUpRight className="h-4 w-4" />
                  </button>

                  {isAdmin && (
                    <button
                      onClick={() => router.push(`/circle/${circle.id}/manage`)}
                      className="inline-flex w-full items-center justify-center gap-2 rounded-2xl border border-[#d7cec1] bg-white px-4 py-3.5 text-sm font-semibold text-[#334155] transition-all duration-200 hover:-translate-y-0.5 hover:bg-[#fbfaf7]"
                    >
                      Manage circle
                      <ArrowUpRight className="h-4 w-4" />
                    </button>
                  )}
                </div>

                <p className="mt-4 text-xs leading-5 text-[#7a818e]">
                  Contributions, balances, and payouts remain tied to the
                  network selected in your current session.
                </p>
              </div>
            </aside>
          </div>
        ) : (
          <div className={`${pageSurfaceClass} p-12 text-center`}>
            <h2 className="text-2xl font-semibold tracking-[-0.04em] text-[#171923]">
              Circle not found
            </h2>
            <p className="mt-3 text-sm leading-6 text-[#667085] sm:text-base">
              This circle is unavailable or you no longer have access to view it.
            </p>
            <button
              onClick={() => router.push('/dashboard')}
              className="mt-6 inline-flex items-center gap-2 rounded-full border border-[#d7cec1] bg-white px-4 py-2.5 text-sm font-semibold text-[#334155] transition-all duration-200 hover:-translate-y-0.5 hover:bg-[#fbfaf7]"
            >
              <ArrowLeft className="h-4 w-4" />
              Back to dashboard
            </button>
          </div>
        )}
      </main>
    </div>
  );
}
