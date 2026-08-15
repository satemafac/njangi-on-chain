import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { useAuth } from '@/contexts/AuthContext';
import { ArrowLeft, AlertCircle, LogIn } from 'lucide-react';
import { toast } from 'react-hot-toast';
import { getCircleConfigFieldsFromDynamicFields } from '@/lib/circle-config';
import { resolveCircleLifecycleState } from '@/lib/circle-chain';
import {
  getSuiRpcErrorMessage,
  isTransientSuiRpcError,
} from '@/services/sui-rpc-failover';
import { readObject, queryEventsCached } from '@/lib/sui-read';
import { logSuiReadError } from '@/services/sui-rpc-failover';
import { priceService } from '@/services/price-service';
import { getCirclePackageId, getSuiClientFromPool } from '../../../../services/circle-service';
import { getCurrentRpcUrl } from '../../../../services/network-config';
import { LoginButton } from '@/components/LoginButton';
import { useTranslation } from '@/hooks/useTranslation';
import { Seo } from '@/components/Seo';
import { SITE_URL } from '@/lib/structured-data';

// Define Circle type
interface Circle {
  id: string;
  name: string;
  admin: string;
  contributionAmount: number; // Calculated SUI amount
  contributionAmountUsd: number; // USD amount (cents/100)
  currencyType?: string; // Add currency type field
  securityDeposit: number; // Calculated SUI amount
  securityDepositUsd: number; // USD amount (cents/100)
  cycleLength: number;
  cycleDay: number;
  maxMembers: number;
  currentMembers: number;
  nextPayoutTime: number;
  isActive: boolean;
  paused: boolean;
}

// Define CircleFields type
interface CircleFields {
  name: string;
  admin: string;
  // Allow potentially missing direct fields after refactor
  contribution_amount?: string;
  contribution_amount_usd?: string; // Legacy field
  contribution_amount_local?: string; // New field
  security_deposit?: string;
  security_deposit_usd?: string; // Legacy field
  security_deposit_local?: string; // New field
  currency_type?: string; // New field
  cycle_length?: string;
  cycle_day?: string;
  max_members?: string;
  current_members: string; // Assume this is still reliable
  next_payout_time: string;
  is_active?: boolean | string;
  paused_after_cycle?: boolean | string;
  usd_amounts?: object | string;
  [key: string]: string | number | boolean | object | unknown;
}

// Define CircleCreationEventData type
interface CircleCreationEventData {
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

// Define type for transaction input data (same as dashboard)
interface TransactionInputData {
  cycle_day?: number;
  currency_type?: string;
  [key: string]: unknown;
}

export default function JoinCircle() {
  const router = useRouter();
  const { id } = router.query;
  const { t } = useTranslation();
  const {
    isAuthenticated,
    userAddress,
    account
  } = useAuth();
  const [loading, setLoading] = useState(true);
  const [circle, setCircle] = useState<Circle | null>(null);
  const [isMember, setIsMember] = useState(false);
  const [suiPrice, setSuiPrice] = useState(1.25); // Default price until we fetch real price
  const [hasPendingRequest, setHasPendingRequest] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    // Fetch the current SUI price
    const fetchSuiPrice = async () => {
      try {
        const price = await priceService.getSUIPrice();
        if (price && !isNaN(price) && price > 0) {
          setSuiPrice(price);
          console.log('Fetched SUI price:', price);
        }
      } catch (error) {
        console.error('Error fetching SUI price:', error);
        // Keep using default price
      }
    };
    
    fetchSuiPrice();
  }, []);

  useEffect(() => {
    // Fetch circle details when ID is available and router is ready
    if (router.isReady && id) {
      fetchCircleDetails();
    }
    // `fetchCircleDetails` is a stable component closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, userAddress, router.isReady]);

  useEffect(() => {
    // Check if this user already has a pending request for this circle
    if (router.isReady && id && userAddress) {
      checkPendingRequest();
    }
    // `checkPendingRequest` closes over id/userAddress already.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, userAddress, router.isReady]);

  useEffect(() => {
    if (router.isReady && id) {
      fetchCircleDetails();

      // Only store viewed circles for authenticated users
      if (isAuthenticated) {
        // Store this circle ID in localStorage for notifications
        try {
          const existingCircleIds = localStorage.getItem('viewedCircles');
          let circleIds: string[] = [];

          if (existingCircleIds) {
            circleIds = JSON.parse(existingCircleIds);
          }

          if (!circleIds.includes(id as string)) {
            circleIds.push(id as string);
            localStorage.setItem('viewedCircles', JSON.stringify(circleIds));
          }
        } catch (error) {
          console.error('Error storing circle ID in localStorage:', error);
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, userAddress, isAuthenticated, router.isReady]);

  const fetchCircleDetails = async () => {
    if (!id) return;
    console.log('Join - Fetching circle details for:', id);
    
    setLoading(true);
    try {
      const client = getSuiClientFromPool(getCurrentRpcUrl());
      
      // Get circle object
      const objectData = await readObject(id as string, { showContent: true, showType: true });
      
      if (!objectData.data?.content || !('fields' in objectData.data.content)) {
        throw new Error('Invalid circle object data received');
      }
      const determinedPackageId = await getCirclePackageId(
        id as string,
        userAddress ?? undefined,
      );
      const fields = objectData.data.content.fields as CircleFields;
      const lifecycle = resolveCircleLifecycleState(fields);
      console.log('Join - Using package ID:', determinedPackageId);
      console.log('Join - Raw Circle Object Fields:', fields);
      console.log('Join - Circle lifecycle:', lifecycle);
        
      // Get dynamic fields
      const dynamicFieldsResult = await client.getDynamicFields({
        parentId: id as string
      });
      const dynamicFields = dynamicFieldsResult.data;
      console.log('Join - Dynamic Fields:', dynamicFields);
        
      // --- Fetch Event/Transaction Data (like dashboard) ---
      let transactionInput: TransactionInputData | undefined;
      let circleCreationEventData: CircleCreationEventData | undefined;

      try {
        // 1. Fetch CircleCreated event
        const circleEvents = await queryEventsCached({
          query: { MoveEventType: `${determinedPackageId}::njangi_circles::CircleCreated` },
          limit: 50 // Limit scope if needed
        });
        const createEvent = circleEvents.data.find(event => 
          (event.parsedJson as { circle_id?: string })?.circle_id === id
        );
        console.log('Join - Found creation event:', !!createEvent);

        if (createEvent?.parsedJson) {
          circleCreationEventData = createEvent.parsedJson as CircleCreationEventData;
        }

        // 2. Fetch Transaction Block for inputs (if possible)
        if (createEvent?.id?.txDigest) {
          const txData = await client.getTransactionBlock({
            digest: createEvent.id.txDigest,
            options: { showInput: true } // Only need inputs
          });
          console.log('Join - Transaction data fetched:', !!txData);
          if (txData?.transaction?.data?.transaction?.kind === 'ProgrammableTransaction') {
            const tx = txData.transaction.data.transaction;
            const inputs = tx.inputs || [];
            console.log('Join - Transaction inputs:', inputs);
            // Try to find cycle_day and currency_type
            if (inputs.length > 6 && inputs[6].type === 'pure' && inputs[6].valueType === 'u64') {
              transactionInput = { cycle_day: Number(inputs[6].value) };
              console.log(`Join - Found cycle_day ${transactionInput.cycle_day} from tx`);
            }
            // Look for currency_type in transaction inputs
            const currencyInput = inputs.find((input) => 
              input.type === 'pure' && 
              'value' in input &&
              typeof input.value === 'string' && 
              ['USD', 'XAF', 'NGN', 'EUR', 'GBP'].includes(input.value)
            );
            if (currencyInput && 'value' in currencyInput) {
              transactionInput = { 
                ...transactionInput, 
                currency_type: currencyInput.value as string
              };
              console.log(`Join - Found currency_type ${currencyInput.value} from tx`);
            }
          }
        }
      } catch (error) {
        logSuiReadError('Join - Error fetching event/transaction data:', error);
        // Continue even if this fails
      }
      
      // --- Process Extracted Data (Prioritize sources) ---
      const configValues = {
        contributionAmount: 0,      // SUI
        contributionAmountUsd: 0,   // USD cents / 100
        securityDeposit: 0,         // SUI
        securityDepositUsd: 0,      // USD cents / 100
        cycleLength: 0,             // 0=weekly, 1=monthly, 2=quarterly
        cycleDay: 1,                // Default to 1st day
        maxMembers: 3,              // Default max members
      };

      // 1. Use values from transaction/event first
      if (circleCreationEventData) {
        if (circleCreationEventData.contribution_amount) configValues.contributionAmount = Number(circleCreationEventData.contribution_amount) / 1e9;
        if (circleCreationEventData.contribution_amount_local) configValues.contributionAmountUsd = Number(circleCreationEventData.contribution_amount_local) / 100;
        if (circleCreationEventData.security_deposit_local) configValues.securityDepositUsd = Number(circleCreationEventData.security_deposit_local) / 100;
        if (circleCreationEventData.cycle_length) configValues.cycleLength = Number(circleCreationEventData.cycle_length);
        if (circleCreationEventData.max_members) configValues.maxMembers = Number(circleCreationEventData.max_members);
      }
      if (transactionInput?.cycle_day !== undefined) {
        configValues.cycleDay = transactionInput.cycle_day;
      }
      console.log('Join - Config after Tx/Event:', configValues);

      try {
        const configFields = await getCircleConfigFieldsFromDynamicFields(
          client,
          dynamicFields,
        );

        if (configFields) {
          console.log('Join - CircleConfig fields:', configFields);

          if (configFields.contribution_amount) {
            configValues.contributionAmount = Number(configFields.contribution_amount) / 1e9;
          }
          if (configFields.contribution_amount_local) {
            configValues.contributionAmountUsd = Number(configFields.contribution_amount_local) / 100;
          }
          if (configFields.security_deposit) {
            configValues.securityDeposit = Number(configFields.security_deposit) / 1e9;
          }
          if (configFields.security_deposit_local) {
            configValues.securityDepositUsd = Number(configFields.security_deposit_local) / 100;
          }
          if (configFields.cycle_length) {
            configValues.cycleLength = Number(configFields.cycle_length);
          }
          if (configFields.cycle_day) {
            configValues.cycleDay = Number(configFields.cycle_day);
          }
          if (configFields.max_members) {
            configValues.maxMembers = Number(configFields.max_members);
            console.log('Join - Extracted max_members from CircleConfig:', configValues.maxMembers);
          }
        }
      } catch (error) {
        logSuiReadError('Join - Error fetching CircleConfig fields:', error);
      }
      console.log('Join - Config after Dynamic Fields:', configValues);

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
      // Fallback for cycle info only if not set by higher priority sources
      if (configValues.cycleLength === 0 && fields.cycle_length !== undefined && !isNaN(Number(fields.cycle_length))) configValues.cycleLength = Number(fields.cycle_length);
      if (configValues.cycleDay === 1 && fields.cycle_day !== undefined && !isNaN(Number(fields.cycle_day))) configValues.cycleDay = Number(fields.cycle_day);
      if (configValues.maxMembers === 3 && fields.max_members !== undefined && !isNaN(Number(fields.max_members))) configValues.maxMembers = Number(fields.max_members);
      console.log('Join - Config after Direct Fields Fallback:', configValues);
      
      // 4. Calculate SUI amounts from USD if SUI amount is still zero (and price is available)
      const effectiveSuiPrice = suiPrice > 0 ? suiPrice : 1.0; // Use 1.0 as fallback price to avoid division by zero
      if (configValues.contributionAmount === 0 && configValues.contributionAmountUsd > 0) {
          configValues.contributionAmount = configValues.contributionAmountUsd / effectiveSuiPrice;
          console.log(`Join - Calculated contribution SUI from USD: ${configValues.contributionAmount}`);
      }
      if (configValues.securityDeposit === 0 && configValues.securityDepositUsd > 0) {
          configValues.securityDeposit = configValues.securityDepositUsd / effectiveSuiPrice;
          console.log(`Join - Calculated security deposit SUI from USD: ${configValues.securityDeposit}`);
      }

      // --- Check Membership and Fetch Member Count only if user is authenticated ---
      let isUserAdmin = false;
      let memberCount = 1; // Start with admin
      const memberAddresses = new Set<string>();
      
      try {
        // Only add admin to member set
        memberAddresses.add(fields.admin); // Add admin
        
        // Fetch all members from join events
        const joinedEvents = await queryEventsCached({
          query: { MoveEventType: `${determinedPackageId}::njangi_circles::MemberJoined` },
          limit: 1000 // Fetch enough events
        });
        
        joinedEvents.data.forEach(event => {
          if ((event.parsedJson as { circle_id?: string })?.circle_id === id && 
              (event.parsedJson as { member?: string })?.member) {
            memberAddresses.add((event.parsedJson as { member: string }).member);
          }
        });
        
        // 🔴 CRITICAL FIX: Also fetch MemberRemoved events to filter out removed members
        const removedEvents = await queryEventsCached({
          query: { MoveEventType: `${determinedPackageId}::njangi_circles::MemberRemoved` },
          limit: 1000
        });
        
        // Create a set of removed member addresses for this circle
        const removedAddresses = new Set<string>();
        removedEvents.data.forEach(event => {
          if ((event.parsedJson as { circle_id?: string })?.circle_id === id && 
              (event.parsedJson as { member?: string })?.member) {
            removedAddresses.add((event.parsedJson as { member: string }).member);
          }
        });
        
        // Remove the removed members from the member set (except admin who can't be removed)
        removedAddresses.forEach(removedAddr => {
          if (removedAddr !== fields.admin) {
            memberAddresses.delete(removedAddr);
            console.log(`Join - Filtered out removed member: ${removedAddr}`);
          }
        });
        
        memberCount = memberAddresses.size;
        console.log(`Join - Final member count after filtering removed: ${memberCount}`);
        
        // If user is authenticated, check membership
        if (userAddress) {
          console.log('Join - Checking if user is admin or member');
          isUserAdmin = fields.admin === userAddress;
          
          // Check if user was removed from this circle
          const wasUserRemoved = removedAddresses.has(userAddress);
          if (wasUserRemoved) {
            console.log('Join - User was previously removed from this circle, allowing rejoin');
          }
          
          // Set member status based on admin status or event membership (accounting for removals)
          const isUserMember = isUserAdmin || (memberAddresses.has(userAddress) && !wasUserRemoved);
          setIsMember(isUserMember);
          
          // Show toast and redirect IF user is authenticated AND is admin/member
          if (isUserAdmin) {
            console.log('Join - User is the admin of this circle');
            toast('You are the admin of this circle.');
            router.push(`/circle/${id}`); // Redirect admin
            return; // Exit early
          } else if (isUserMember) {
            console.log('Join - User is already a member based on event query');
            toast('You are already a member of this circle.');
            router.push(`/circle/${id}`); // Redirect member
            return; // Exit early
          }
        } else {
          console.log('Join - User not authenticated, skipping membership checks');
        }
      } catch (error) {
        logSuiReadError(`Join - Error processing membership for circle ${id}:`, error);
        memberCount = Number(fields.current_members || 1); // Fallback
      }
        
      // --- Final State Update ---
      console.log('Join - Setting circle state with data:', {
        id,
        name: fields.name,
        contributionAmount: configValues.contributionAmount,
        contributionAmountUsd: configValues.contributionAmountUsd,
        memberCount
      });
      
      setCircle({
        id: id as string,
        name: typeof fields.name === 'string' ? fields.name : '',
        admin: typeof fields.admin === 'string' ? fields.admin : '',
        contributionAmount: configValues.contributionAmount,
        contributionAmountUsd: configValues.contributionAmountUsd,
        currencyType: transactionInput?.currency_type || circleCreationEventData?.currency_type || fields.currency_type || 'USD', // Get currency type from transaction input, creation event, or fields
        securityDeposit: configValues.securityDeposit,
        securityDepositUsd: configValues.securityDepositUsd,
        cycleLength: configValues.cycleLength,
        cycleDay: configValues.cycleDay,
        maxMembers: configValues.maxMembers,
        currentMembers: memberCount, // Use accurately fetched count
        nextPayoutTime: Number(fields.next_payout_time || 0),
        isActive: lifecycle.isActive,
        paused: lifecycle.isPausedAfterCycle,
      });
        
    } catch (error) {
      if (isTransientSuiRpcError(error)) {
        // RPC is momentarily unavailable (rate-limit / failover cooldown). The
        // page already rendered; this is expected and will recover on retry.
        console.warn(
          'Join - Circle details fetch deferred (transient RPC):',
          getSuiRpcErrorMessage(error),
        );
        toast.error('Network busy — retrying shortly');
        return;
      }
      console.error('Join - Error fetching circle details:', error);
      toast.error('Could not load circle information');
      // Set a minimal circle object to prevent UI failures
      setCircle(null);
    } finally {
      setLoading(false);
    }
  };

  const checkPendingRequest = async () => {
    if (!id || !userAddress) return;
    
    try {
      console.log(`[JoinPage] Checking if user ${userAddress} has pending request for circle ${id}`);
      
      const response = await fetch(`/api/join-requests/check?circleId=${id}&userAddress=${userAddress}`);
      
      if (!response.ok) {
        console.error('[JoinPage] Failed to check pending request:', response.status, response.statusText);
        return;
      }
      
      const data = await response.json();
      console.log('[JoinPage] Pending request check response:', data);
      
      if (data.success && data.data && data.data.hasPendingRequest) {
        console.log('[JoinPage] User has a pending request, updating UI');
        setHasPendingRequest(true);
      } else {
        console.log('[JoinPage] User does not have a pending request');
        setHasPendingRequest(false);
      }
    } catch (error) {
      console.error('[JoinPage] Error checking pending request:', error);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!id || !userAddress) {
      return;
    }

    if (circle?.isActive && !circle.paused) {
      toast.error('This circle is currently active. New members can only join when the circle is paused between cycles or inactive.');
      return;
    }

    console.log(`[JoinPage] Submitting join request for circle ${id} and user ${userAddress}`);
    
    try {
      // Show submitting state
      setIsSubmitting(true);
      toast.loading('Submitting join request...', {id: 'submit-request'});
      
      // Make API call to create join request
      const response = await fetch('/api/join-requests/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          circleId: id,
          circleName: circle?.name || 'Unknown Circle',
          userAddress: userAddress,
          userName: account?.name || 'Anonymous',
        }),
      });

      const data = await response.json().catch(() => null);
      
      if (!response.ok) {
        console.error('[JoinPage] Failed to create join request:', response.status, response.statusText);
        toast.error(data?.message || 'Failed to submit join request. Please try again.', {id: 'submit-request'});
        return;
      }

      console.log('[JoinPage] Join request creation response:', data);
      
      if (data?.success) {
        // Update UI state
        setHasPendingRequest(true);
        toast.success('Join request submitted successfully', {id: 'submit-request'});
        
        // Recheck pending request status to confirm
        setTimeout(checkPendingRequest, 1000);
      } else {
        toast.error(data?.message || 'Failed to submit join request', {id: 'submit-request'});
      }
    } catch (error) {
      console.error('[JoinPage] Error submitting join request:', error);
      toast.error('An error occurred. Please try again.', {id: 'submit-request'});
    } finally {
      setIsSubmitting(false);
    }
  };

  // Format cycle info
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
    
    // Return formatted string
    return `${cyclePeriod} (${dayFormat})`;
  };

  // Helper to format dates with ordinal suffix
  const getOrdinalSuffix = (day: number) => {
    // Handle special cases for 11th, 12th, 13th
    if (day >= 11 && day <= 13) {
      return `${day}th`;
    }
    
    // Handle other cases based on last digit
    const lastDigit = day % 10;
    switch (lastDigit) {
      case 1:
        return `${day}st`;
      case 2:
        return `${day}nd`;
      case 3:
        return `${day}rd`;
      default:
        return `${day}th`;
    }
  };

  // Add formatCurrency function to handle different currency types
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
      'GHS': { symbol: 'GH₵', locale: 'en-GH', code: 'GHS', customFormat: true, position: 'before' } // Added GHS
    };

    const format = currencyFormats[currencyType] || currencyFormats['USD'];
    
    // For currencies like XAF that use the symbol after the amount
    if (currencyType === 'XAF') {
      return `${amount.toLocaleString(format.locale, { minimumFractionDigits: 0, maximumFractionDigits: 0 })} ${format.symbol}`;
    }
    
    // For other currencies, use the symbol before the amount
    return `${format.symbol}${amount.toLocaleString(format.locale, { 
      minimumFractionDigits: currencyType === 'USD' ? 2 : 0, 
      maximumFractionDigits: currencyType === 'USD' ? 2 : 0 
    })}`;
  };

  const formatAddress = (address: string) => {
    if (!address) return 'Unknown';
    if (address.length <= 14) return address;
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
  };

  // Helper component to display both USD and SUI amounts
  const CurrencyDisplay = ({ 
    usd, 
    sui, 
    currencyType = 'USD',
    className = '' 
  }: { 
    usd?: number; 
    sui?: number; 
    currencyType?: string;
    className?: string;
  }) => {
    // Ensure we have valid numbers
    const usdValue = usd !== undefined && !isNaN(usd) ? usd : 0;
    
    // For SUI, check if the value is unreasonably large (blockchain raw value)
    // If so, calculate it from USD instead
    let displaySuiValue: number;
    if (sui !== undefined && !isNaN(sui) && sui < 1_000_000) { // If SUI value is reasonable
      displaySuiValue = sui;
    } else if (usdValue && suiPrice > 0) { // Otherwise calculate from USD
      // Calculate SUI based on USD value and current price
      displaySuiValue = usdValue / suiPrice;
    } else {
      displaySuiValue = 0;
    }
    
    // Format the SUI value based on its magnitude
    const formattedSui = displaySuiValue >= 1000 
      ? displaySuiValue.toLocaleString('en-US', { maximumFractionDigits: 0 })
      : displaySuiValue.toLocaleString('en-US', { maximumFractionDigits: 2 });
    
    return (
      <div className={`flex flex-col gap-1 ${className}`}>
        <span className="text-xl font-semibold tracking-[-0.02em] text-[#171923]">
          {formatCurrency(usdValue, currencyType)}
        </span>
        <span className="text-sm font-medium text-[#667085]">
          {formattedSui} SUI
        </span>
      </div>
    );
  };

  // Store the current URL for redirect after login
  useEffect(() => {
    if (!router.isReady) return; // Wait for router to be ready
    
    if (!isAuthenticated && id) {
      // Store the current join URL so user can be redirected back after login
      const currentUrl = window.location.href;
      localStorage.setItem('redirectAfterLogin', currentUrl);
      console.log('Stored redirect URL for after login:', currentUrl);
    } else if (isAuthenticated) {
      // Clear redirect URL if user is already authenticated
      localStorage.removeItem('redirectAfterLogin');
    }
    
    // Cleanup function to remove redirect URL when component unmounts
    return () => {
      // Only clear if user is not authenticated (to avoid clearing during login flow)
      if (!isAuthenticated) {
        localStorage.removeItem('redirectAfterLogin');
      }
    };
  }, [isAuthenticated, id, router.isReady]);

  // Generate page title & description based on circle data
  const joinRequestsOpen = circle ? (!circle.isActive || circle.paused) : false;
  const pageTitle = circle 
    ? `Join ${circle.name} Circle - Njangi On-Chain`
    : 'Join Circle - Njangi On-Chain';
    
  const pageDescription = circle 
    ? `Join ${circle.name}, a savings circle with ${formatCurrency(circle.contributionAmountUsd, circle.currencyType)} contribution ${formatCycleInfo(circle.cycleLength, circle.cycleDay).toLowerCase()}. Currently ${circle.currentMembers}/${circle.maxMembers} members.`
    : 'Join a secure, transparent savings circle powered by SUI blockchain. Create and manage your community savings with automated payouts.';

  // Update document title when circle data is loaded
  useEffect(() => {
    if (circle) {
      document.title = pageTitle;
    }
  }, [circle, pageTitle]);

  const backDestination = isAuthenticated ? '/dashboard' : '/';
  const backLabel = isAuthenticated ? t('join.backToDashboard') : t('join.backToHome');
  const pageShellClass =
    'relative isolate min-h-screen overflow-hidden bg-[#f5f1e8] text-[#171923]';
  const shellCardClass =
    'overflow-hidden rounded-[30px] border border-[#e6ded0] bg-white/95 shadow-[0_28px_90px_-50px_rgba(15,23,42,0.28)] backdrop-blur';
  const sectionCardClass =
    'rounded-[24px] border border-[#e8dfd2] bg-[#fcfbf8] p-5 shadow-[0_24px_60px_-42px_rgba(15,23,42,0.2)] sm:p-6';
  const nestedCardClass =
    'rounded-[20px] border border-[#ebe3d6] bg-white p-4 shadow-[0_16px_40px_-36px_rgba(15,23,42,0.18)] sm:p-5';
  const eyebrowClass =
    'text-[0.72rem] font-semibold uppercase tracking-[0.32em] text-[#6b7280]';
  const badgeClass =
    'inline-flex items-center rounded-full border border-[#ddd4c5] bg-white px-4 py-2 text-[0.7rem] font-semibold uppercase tracking-[0.24em] text-[#64748b]';
  const secondaryActionClass =
    'inline-flex items-center justify-center gap-2 rounded-full border border-[#d8cfbf] bg-white px-5 py-3 text-sm font-semibold text-[#1f2430] transition-all duration-200 hover:border-[#cbbfae] hover:bg-[#fcfbf8] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#70819b]/30';
  const primaryActionClass =
    'inline-flex w-full items-center justify-center rounded-full bg-[#171923] px-5 py-3.5 text-sm font-semibold text-white transition-colors duration-200 hover:bg-[#10131b] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#70819b]/35';

  const renderBackButton = () => (
    <div className="mb-6 sm:mb-8">
      <button
        onClick={() => router.push(backDestination)}
        className={secondaryActionClass}
      >
        <ArrowLeft className="h-4 w-4" />
        {backLabel}
      </button>
    </div>
  );

  // Update the component's return statement to safely check auth state
  if (!router.isReady) {
    // Show loading while router is initializing
    return (
      <div className={pageShellClass}>
        <div className="pointer-events-none absolute inset-x-0 top-0 h-[360px] bg-[radial-gradient(circle_at_top,rgba(112,129,155,0.18),transparent_68%)]" />
        <main className="relative mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
          {renderBackButton()}
          <div className={shellCardClass}>
            <div className="border-b border-[#ece4d7] px-6 py-8 sm:px-8">
              <span className={eyebrowClass}>Join circle</span>
              <h1 className="mt-4 text-3xl font-semibold tracking-[-0.04em] text-[#171923] sm:text-[2.8rem]">
                Preparing the join flow
              </h1>
              <p className="mt-4 max-w-2xl text-base leading-8 text-[#5f6b7f]">
                Loading the circle terms, member count, and approval state.
              </p>
            </div>
            <div className="flex justify-center px-6 py-14 sm:px-8 sm:py-20">
              <svg
                className="h-8 w-8 animate-spin text-[#70819b]"
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
          </div>
        </main>
      </div>
    );
  }

  if (!id) {
    return (
      <div className={pageShellClass}>
        <div className="pointer-events-none absolute inset-x-0 top-0 h-[360px] bg-[radial-gradient(circle_at_top,rgba(112,129,155,0.18),transparent_68%)]" />
        <main className="relative mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
          {renderBackButton()}
          <div className={shellCardClass}>
            <div className="px-6 py-14 text-center sm:px-8 sm:py-20">
              <span className={eyebrowClass}>Join circle</span>
              <h1 className="mt-4 text-3xl font-semibold tracking-[-0.04em] text-[#171923] sm:text-[2.8rem]">
                Invalid circle link
              </h1>
              <p className="mx-auto mt-4 max-w-xl text-base leading-8 text-[#5f6b7f]">
                This join page is missing a valid circle identifier. Return to the
                dashboard and open the invitation again.
              </p>
              <div className="mt-8 flex justify-center">
                <button
                  onClick={() => router.push('/dashboard')}
                  className={secondaryActionClass}
                >
                  <ArrowLeft className="h-4 w-4" />
                  Go to dashboard
                </button>
              </div>
            </div>
          </div>
        </main>
      </div>
    );
  }

  return (
    <>
      {/* This is the most-shared URL in the product — invite links land here
          from WhatsApp. It stays noindex (inherited from _app: /circle is an
          app route) but keeps a full share card, since robots directives and
          Open Graph are orthogonal.

          The image was /og-image.png, a stale blue-brand card left over from
          the previous visual identity. */}
      <Seo
        title={pageTitle}
        titleAbsolute
        description={pageDescription}
        canonical={`${SITE_URL}/circle/${id}/join`}
        image={{
          url: '/og/join.png',
          alt: `Join ${circle?.name || 'a njangi'} circle on Njangi On-Chain`,
        }}
      />
      
      <div className={pageShellClass}>
        <div className="pointer-events-none absolute inset-x-0 top-0 h-[360px] bg-[radial-gradient(circle_at_top,rgba(112,129,155,0.18),transparent_68%)]" />
        <main className="relative mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
          {renderBackButton()}

          <div className={shellCardClass}>
            {loading ? (
              <>
                <div className="border-b border-[#ece4d7] px-6 py-8 sm:px-8">
                  <span className={eyebrowClass}>Join circle</span>
                  <h1 className="mt-4 text-3xl font-semibold tracking-[-0.04em] text-[#171923] sm:text-[2.8rem]">
                    Preparing the circle details
                  </h1>
                  <p className="mt-4 max-w-2xl text-base leading-8 text-[#5f6b7f]">
                    We&apos;re checking the contribution terms and whether you already
                    have an active request.
                  </p>
                </div>
                <div className="flex justify-center px-6 py-14 sm:px-8 sm:py-20">
                  <svg
                    className="h-8 w-8 animate-spin text-[#70819b]"
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
              </>
            ) : circle ? (
              <>
                <div className="grid gap-8 border-b border-[#ece4d7] px-6 py-8 sm:px-8 lg:grid-cols-[minmax(0,1.2fr)_340px]">
                  <div className="space-y-6">
                    <div className="space-y-4">
                      <span className={eyebrowClass}>{t('join.eyebrow')}</span>
                      <div className="space-y-3">
                        <h1 className="text-3xl font-semibold tracking-[-0.05em] text-[#171923] sm:text-[3rem]">
                          {circle.name}
                        </h1>
                        <p className="max-w-2xl text-base leading-8 text-[#5f6b7f]">
                          {t('join.reviewTerms')}
                        </p>
                      </div>
                    </div>

                    <div className="flex flex-wrap gap-3">
                      <span className={badgeClass}>
                        {t('join.members', {
                          current: circle.currentMembers,
                          max: circle.maxMembers,
                        })}
                      </span>
                      <span className={badgeClass}>
                        {formatCycleInfo(circle.cycleLength, circle.cycleDay)}
                      </span>
                      <span className={badgeClass}>
                        {circle.currencyType || 'USD'} settlement
                      </span>
                      <span className={badgeClass}>
                        {joinRequestsOpen ? t('join.requestsOpen') : t('join.requestsPaused')}
                      </span>
                    </div>
                  </div>

                  <div className={sectionCardClass}>
                    <span className={eyebrowClass}>At a glance</span>
                    <dl className="mt-6 space-y-4">
                      <div className="flex items-start justify-between gap-4 border-b border-[#ece4d7] pb-4">
                        <dt className="text-sm font-medium text-[#667085]">
                          {t('join.contribution')}
                        </dt>
                        <dd>
                          <CurrencyDisplay
                            usd={circle.contributionAmountUsd}
                            sui={circle.contributionAmount}
                            currencyType={circle.currencyType}
                            className="items-end text-right"
                          />
                        </dd>
                      </div>
                      <div className="flex items-start justify-between gap-4 border-b border-[#ece4d7] pb-4">
                        <dt className="text-sm font-medium text-[#667085]">
                          {t('join.securityDeposit')}
                        </dt>
                        <dd>
                          <CurrencyDisplay
                            usd={circle.securityDepositUsd}
                            sui={circle.securityDeposit}
                            currencyType={circle.currencyType}
                            className="items-end text-right"
                          />
                        </dd>
                      </div>
                      <div className="flex items-start justify-between gap-4 border-b border-[#ece4d7] pb-4">
                        <dt className="text-sm font-medium text-[#667085]">
                          Contribution cadence
                        </dt>
                        <dd className="text-right text-sm font-semibold text-[#171923]">
                          {formatCycleInfo(circle.cycleLength, circle.cycleDay)}
                        </dd>
                      </div>
                      <div className="flex items-start justify-between gap-4">
                        <dt className="text-sm font-medium text-[#667085]">
                          {t('join.circleAdmin')}
                        </dt>
                        <dd className="text-sm font-semibold text-[#171923]">
                          {formatAddress(circle.admin)}
                        </dd>
                      </div>
                    </dl>
                  </div>
                </div>

                <div className="grid gap-6 px-6 py-8 sm:px-8 lg:grid-cols-[minmax(0,1.1fr)_360px]">
                  <div className="space-y-6">
                    <section className={sectionCardClass}>
                      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                        <div>
                          <span className={eyebrowClass}>Circle details</span>
                          <h2 className="mt-3 text-2xl font-semibold tracking-[-0.04em] text-[#171923]">
                            Contribution structure
                          </h2>
                        </div>
                        <div className="self-start rounded-full border border-[#ddd4c5] bg-white px-4 py-2 text-sm font-semibold text-[#455468]">
                          {circle.currentMembers}/{circle.maxMembers} active spots filled
                        </div>
                      </div>

                      <div className="mt-6 grid gap-4 sm:grid-cols-2">
                        <div className={nestedCardClass}>
                          <p className={eyebrowClass}>Contribution amount</p>
                          <CurrencyDisplay
                            usd={circle.contributionAmountUsd}
                            sui={circle.contributionAmount}
                            currencyType={circle.currencyType}
                            className="mt-4"
                          />
                        </div>
                        <div className={nestedCardClass}>
                          <p className={eyebrowClass}>Security deposit</p>
                          <CurrencyDisplay
                            usd={circle.securityDepositUsd}
                            sui={circle.securityDeposit}
                            currencyType={circle.currencyType}
                            className="mt-4"
                          />
                        </div>
                        <div className={nestedCardClass}>
                          <p className={eyebrowClass}>Contribution schedule</p>
                          <p className="mt-4 text-xl font-semibold tracking-[-0.03em] text-[#171923]">
                            {formatCycleInfo(circle.cycleLength, circle.cycleDay)}
                          </p>
                        </div>
                        <div className={nestedCardClass}>
                          <p className={eyebrowClass}>Membership</p>
                          <p className="mt-4 text-xl font-semibold tracking-[-0.03em] text-[#171923]">
                            {circle.currentMembers} members active
                          </p>
                          <p className="mt-2 text-sm leading-6 text-[#667085]">
                            Maximum capacity is {circle.maxMembers} members for this
                            circle.
                          </p>
                        </div>
                      </div>
                    </section>

                    <section className={sectionCardClass}>
                      <span className={eyebrowClass}>Process</span>
                      <h2 className="mt-3 text-2xl font-semibold tracking-[-0.04em] text-[#171923]">
                        What happens after you request access
                      </h2>

                      <div className="mt-6 grid gap-4 sm:grid-cols-3">
                        <div className={nestedCardClass}>
                          <p className="text-sm font-semibold text-[#455468]">01</p>
                          <p className="mt-4 text-lg font-semibold tracking-[-0.03em] text-[#171923]">
                            Review the terms
                          </p>
                          <p className="mt-3 text-sm leading-6 text-[#667085]">
                            Confirm the contribution amount, cadence, and the security
                            deposit before you continue.
                          </p>
                        </div>
                        <div className={nestedCardClass}>
                          <p className="text-sm font-semibold text-[#455468]">02</p>
                          <p className="mt-4 text-lg font-semibold tracking-[-0.03em] text-[#171923]">
                            Send your request
                          </p>
                          <p className="mt-3 text-sm leading-6 text-[#667085]">
                            Your request is sent to the admin for review. No contribution
                            is taken at this stage.
                          </p>
                        </div>
                        <div className={nestedCardClass}>
                          <p className="text-sm font-semibold text-[#455468]">03</p>
                          <p className="mt-4 text-lg font-semibold tracking-[-0.03em] text-[#171923]">
                            Join after approval
                          </p>
                          <p className="mt-3 text-sm leading-6 text-[#667085]">
                            Once approved, you can enter the circle flow and manage your
                            contributions from the app.
                          </p>
                        </div>
                      </div>
                    </section>
                  </div>

                  <aside className="space-y-6">
                    <section className={sectionCardClass}>
                      <span className={eyebrowClass}>Request access</span>
                      <h2 className="mt-3 text-2xl font-semibold tracking-[-0.04em] text-[#171923]">
                        Review the terms
                      </h2>
                      <p className="mt-4 text-base leading-8 text-[#5f6b7f]">
                        By requesting access, you&apos;re agreeing to contribute{' '}
                        {formatCurrency(
                          circle.contributionAmountUsd,
                          circle.currencyType,
                        )}{' '}
                        on a{' '}
                        {formatCycleInfo(
                          circle.cycleLength,
                          circle.cycleDay,
                        ).toLowerCase()}{' '}
                        basis and to hold a security deposit of{' '}
                        {formatCurrency(
                          circle.securityDepositUsd,
                          circle.currencyType,
                        )}{' '}
                        under the circle rules.
                      </p>

                      <div className="mt-6 space-y-3">
                        <div className={nestedCardClass}>
                          <p className={eyebrowClass}>Contribution</p>
                          <CurrencyDisplay
                            usd={circle.contributionAmountUsd}
                            sui={circle.contributionAmount}
                            currencyType={circle.currencyType}
                            className="mt-4"
                          />
                        </div>
                        <div className={nestedCardClass}>
                          <p className={eyebrowClass}>Deposit</p>
                          <CurrencyDisplay
                            usd={circle.securityDepositUsd}
                            sui={circle.securityDeposit}
                            currencyType={circle.currencyType}
                            className="mt-4"
                          />
                        </div>
                      </div>
                    </section>

                    {!joinRequestsOpen ? (
                      <section className={sectionCardClass}>
                        <div className="flex items-start gap-4">
                          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-[#ddd4c5] bg-white">
                            <AlertCircle className="h-5 w-5 text-[#5f6b7f]" />
                          </div>
                          <div>
                            <span className={eyebrowClass}>Request status</span>
                            <h3 className="mt-3 text-2xl font-semibold tracking-[-0.04em] text-[#171923]">
                              Joining is temporarily closed
                            </h3>
                            <p className="mt-4 text-sm leading-7 text-[#667085]">
                              New members can only join when the current cycle is paused
                              between rounds or when the circle is inactive.
                            </p>
                          </div>
                        </div>
                        <div className="mt-6 rounded-[20px] border border-[#e8dfd2] bg-white px-4 py-4 text-sm leading-7 text-[#455468]">
                          Join requests reopen automatically once the active cycle is
                          paused or the circle becomes inactive.
                        </div>
                      </section>
                    ) : !isAuthenticated ? (
                      <section className={sectionCardClass}>
                        <div className="flex items-start gap-4">
                          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-[#ddd4c5] bg-white">
                            <LogIn className="h-5 w-5 text-[#5f6b7f]" />
                          </div>
                          <div>
                            <span className={eyebrowClass}>Authentication</span>
                            <h3 className="mt-3 text-2xl font-semibold tracking-[-0.04em] text-[#171923]">
                              {t('join.signInToRequest')}
                            </h3>
                            <p className="mt-4 text-sm leading-7 text-[#667085]">
                              {t('join.signInBody')}
                            </p>
                          </div>
                        </div>
                        <LoginButton
                          variant="landing"
                          className="mt-6 sm:!grid-cols-1"
                        />
                      </section>
                    ) : hasPendingRequest ? (
                      <section className={sectionCardClass}>
                        <div className="flex items-start gap-4">
                          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-[#ddd4c5] bg-white">
                            <AlertCircle className="h-5 w-5 text-[#5f6b7f]" />
                          </div>
                          <div>
                            <span className={eyebrowClass}>Request status</span>
                            <h3 className="mt-3 text-2xl font-semibold tracking-[-0.04em] text-[#171923]">
                              Request sent
                            </h3>
                            <p className="mt-4 text-sm leading-7 text-[#667085]">
                              Your request is already with the circle admin. You&apos;ll
                              be able to join once it has been approved.
                            </p>
                          </div>
                        </div>
                        <div className="mt-6 rounded-[20px] border border-[#e8dfd2] bg-white px-4 py-4 text-sm leading-7 text-[#455468]">
                          No further action is needed right now. You can safely leave
                          this page and return later to check the decision.
                        </div>
                      </section>
                    ) : (
                      <section className={sectionCardClass}>
                        <span className={eyebrowClass}>Request status</span>
                        <h3 className="mt-3 text-2xl font-semibold tracking-[-0.04em] text-[#171923]">
                          Send your request
                        </h3>
                        <p className="mt-4 text-sm leading-7 text-[#667085]">
                          The admin will review your request before you can access the
                          circle and begin contributing.
                        </p>
                        <div className="mt-6 rounded-[20px] border border-[#e8dfd2] bg-white px-4 py-4 text-sm leading-7 text-[#455468]">
                          Requesting access does not trigger a payment. Contributions
                          only begin after your membership is approved.
                        </div>
                        <button
                          onClick={handleSubmit}
                          disabled={
                            isSubmitting ||
                            isMember ||
                            hasPendingRequest ||
                            !joinRequestsOpen
                          }
                          className={`${primaryActionClass} mt-6 ${
                            isSubmitting ||
                            isMember ||
                            hasPendingRequest ||
                            !joinRequestsOpen
                              ? 'cursor-not-allowed opacity-60'
                              : ''
                          }`}
                        >
                          {isSubmitting
                            ? t('join.submitting')
                            : isMember
                              ? t('join.alreadyMember')
                              : t('join.requestToJoin')}
                        </button>
                      </section>
                    )}
                  </aside>
                </div>
              </>
            ) : (
              <div className="px-6 py-14 text-center sm:px-8 sm:py-20">
                <span className={eyebrowClass}>Join circle</span>
                <h1 className="mt-4 text-3xl font-semibold tracking-[-0.04em] text-[#171923] sm:text-[2.8rem]">
                  Circle information could not be loaded
                </h1>
                <p className="mx-auto mt-4 max-w-xl text-base leading-8 text-[#5f6b7f]">
                  Refresh the page or reopen the invitation link. The circle details
                  may be temporarily unavailable.
                </p>
                <div className="mt-8 flex justify-center">
                  <button
                    onClick={() => router.push(backDestination)}
                    className={secondaryActionClass}
                  >
                    <ArrowLeft className="h-4 w-4" />
                    {backLabel}
                  </button>
                </div>
              </div>
            )}
          </div>
        </main>
      </div>
    </>
  );
}
