import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { useAuth } from '@/contexts/AuthContext';
import { ArrowLeft, AlertCircle, LogIn } from 'lucide-react';
import { toast } from 'react-hot-toast';
import { SuiClient } from '@mysten/sui/client';
import { priceService } from '@/services/price-service';
import { PACKAGE_ID } from '../../../../services/circle-service';

// Define Circle type
interface Circle {
  id: string;
  name: string;
  admin: string;
  contributionAmount: number; // Calculated SUI amount
  contributionAmountUsd: number; // USD amount (cents/100)
  securityDeposit: number; // Calculated SUI amount
  securityDepositUsd: number; // USD amount (cents/100)
  cycleLength: number;
  cycleDay: number;
  maxMembers: number;
  currentMembers: number;
  nextPayoutTime: number;
}

// Define CircleFields type
interface CircleFields {
  name: string;
  admin: string;
  // Allow potentially missing direct fields after refactor
  contribution_amount?: string;
  contribution_amount_usd?: string;
  security_deposit?: string;
  security_deposit_usd?: string;
  cycle_length?: string;
  cycle_day?: string;
  max_members?: string;
  current_members: string; // Assume this is still reliable
  next_payout_time: string;
  usd_amounts?: object | string;
  [key: string]: string | number | boolean | object | unknown;
}

// Define CircleCreatedEvent interface (same as dashboard)
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

// Define type for transaction input data (same as dashboard)
interface TransactionInputData {
  cycle_day?: number;
  [key: string]: unknown;
}

export default function JoinCircle() {
  const router = useRouter();
  const { id } = router.query;
  const { isAuthenticated, userAddress, account, login } = useAuth();
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
    // Fetch circle details when ID is available
    if (id) {
      fetchCircleDetails();
    }
  }, [id, userAddress]);

  useEffect(() => {
    // Check if this user already has a pending request for this circle
    if (id && userAddress) {
      checkPendingRequest();
    }
  }, [id, userAddress]);

  useEffect(() => {
    if (id) {
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
  }, [id, userAddress, isAuthenticated]);

  const fetchCircleDetails = async () => {
    if (!id) return;
    console.log('Join - Fetching circle details for:', id);
    
    setLoading(true);
    try {
      const client = new SuiClient({ url: 'https://fullnode.testnet.sui.io:443' });
      
      // Get circle object
      const objectData = await client.getObject({
        id: id as string,
        options: { showContent: true, showType: true }
      });
      
      if (!objectData.data?.content || !('fields' in objectData.data.content)) {
        throw new Error('Invalid circle object data received');
      }
        const fields = objectData.data.content.fields as CircleFields;
      console.log('Join - Raw Circle Object Fields:', fields);
        
      // Get dynamic fields
      const dynamicFieldsResult = await client.getDynamicFields({
        parentId: id as string
      });
      const dynamicFields = dynamicFieldsResult.data;
      console.log('Join - Dynamic Fields:', dynamicFields);
        
      // --- Fetch Event/Transaction Data (like dashboard) ---
      let transactionInput: TransactionInputData | undefined;
      let circleCreationEventData: CircleCreatedEvent | undefined;

      try {
        // 1. Fetch CircleCreated event
        const circleEvents = await client.queryEvents({
          query: { MoveEventType: `${PACKAGE_ID}::njangi_circles::CircleCreated` },
          limit: 50 // Limit scope if needed
        });
        const createEvent = circleEvents.data.find(event => 
          (event.parsedJson as { circle_id?: string })?.circle_id === id
        );
        console.log('Join - Found creation event:', !!createEvent);

        if (createEvent?.parsedJson) {
          circleCreationEventData = createEvent.parsedJson as CircleCreatedEvent;
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
            // Try to find cycle_day (adjust index if creation logic changes)
            if (inputs.length > 6 && inputs[6].type === 'pure' && inputs[6].valueType === 'u64') {
              transactionInput = { cycle_day: Number(inputs[6].value) };
              console.log(`Join - Found cycle_day ${transactionInput.cycle_day} from tx`);
            }
          }
        }
      } catch (error) {
        console.error('Join - Error fetching event/transaction data:', error);
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
        if (circleCreationEventData.contribution_amount_usd) configValues.contributionAmountUsd = Number(circleCreationEventData.contribution_amount_usd) / 100;
        if (circleCreationEventData.security_deposit_usd) configValues.securityDepositUsd = Number(circleCreationEventData.security_deposit_usd) / 100;
        if (circleCreationEventData.cycle_length) configValues.cycleLength = Number(circleCreationEventData.cycle_length);
        if (circleCreationEventData.max_members) configValues.maxMembers = Number(circleCreationEventData.max_members);
      }
      if (transactionInput?.cycle_day !== undefined) {
        configValues.cycleDay = transactionInput.cycle_day;
      }
      console.log('Join - Config after Tx/Event:', configValues);

      // 2. Look for config in dynamic fields (e.g., 'circle_config')
      for (const field of dynamicFields) {
        if (!field) continue;
        
        // Find the CircleConfig dynamic field
        const isConfigField = 
          (field.name && typeof field.name === 'object' && 'value' in field.name && field.name.value === 'circle_config') ||
          (field.type && typeof field.type === 'string' && field.type.includes('CircleConfig')) ||
          (field.objectType && typeof field.objectType === 'string' && field.objectType.includes('CircleConfig'));

        if (isConfigField && field.objectId) {
          console.log('Join - Found CircleConfig dynamic field object:', field.objectId);
          try {
            // Fetch the complete CircleConfig object
            const configData = await client.getObject({
              id: field.objectId,
              options: { 
                showContent: true,
                showDisplay: false,
                showType: true
              }
            });
            
            console.log('Join - Fetched complete CircleConfig object:', configData);
            
            // Process the object data to access potentially nested values
            if (configData.data?.content && 'fields' in configData.data.content) {
              const contentFields = configData.data.content.fields as Record<string, unknown>;
              console.log('Join - CircleConfig content fields:', contentFields);
              
              // Check if we have direct access to the config values
              if ('contribution_amount' in contentFields) {
                configValues.contributionAmount = Number(contentFields.contribution_amount) / 1e9;
              }
              if ('contribution_amount_usd' in contentFields) {
                configValues.contributionAmountUsd = Number(contentFields.contribution_amount_usd) / 100;
              }
              if ('security_deposit' in contentFields) {
                configValues.securityDeposit = Number(contentFields.security_deposit) / 1e9;
              }
              if ('security_deposit_usd' in contentFields) {
                configValues.securityDepositUsd = Number(contentFields.security_deposit_usd) / 100;
              }
              if ('cycle_length' in contentFields) {
                configValues.cycleLength = Number(contentFields.cycle_length);
              }
              if ('cycle_day' in contentFields) {
                configValues.cycleDay = Number(contentFields.cycle_day);
              }
              if ('max_members' in contentFields) {
                configValues.maxMembers = Number(contentFields.max_members);
                console.log('Join - Extracted max_members directly:', configValues.maxMembers);
              }
              
              // Check for the deeper nested path: value.fields.max_members
              if ('value' in contentFields && 
                  contentFields.value && 
                  typeof contentFields.value === 'object') {
                
                const valueObj = contentFields.value as Record<string, unknown>;
                console.log('Join - CircleConfig value object:', valueObj);
                
                if ('fields' in valueObj && 
                    valueObj.fields && 
                    typeof valueObj.fields === 'object') {
                  
                  const configFields = valueObj.fields as Record<string, unknown>;
                  console.log('Join - CircleConfig nested fields:', configFields);
                  
                  // Extract all config values from the deeply nested structure
                  if ('max_members' in configFields) {
                    configValues.maxMembers = Number(configFields.max_members);
                    console.log('Join - Successfully extracted max_members:', configValues.maxMembers);
                  }
                  if ('contribution_amount' in configFields) {
                    configValues.contributionAmount = Number(configFields.contribution_amount) / 1e9;
                  }
                  if ('contribution_amount_usd' in configFields) {
                    configValues.contributionAmountUsd = Number(configFields.contribution_amount_usd) / 100;
                  }
                  if ('security_deposit' in configFields) {
                    configValues.securityDeposit = Number(configFields.security_deposit) / 1e9;
                  }
                  if ('security_deposit_usd' in configFields) {
                    configValues.securityDepositUsd = Number(configFields.security_deposit_usd) / 100;
                  }
                  if ('cycle_length' in configFields) {
                    configValues.cycleLength = Number(configFields.cycle_length);
                  }
                  if ('cycle_day' in configFields) {
                    configValues.cycleDay = Number(configFields.cycle_day);
                  }
                }
              }
            }
          } catch (error) {
            console.error(`Join - Error fetching config object ${field.objectId}:`, error);
          }
          break; // Assume only one config object
        }
      }
      console.log('Join - Config after Dynamic Fields:', configValues);

      // 3. Use direct fields from the circle object as a fallback (handle potential NaN)
      if (configValues.contributionAmount === 0 && fields.contribution_amount) configValues.contributionAmount = Number(fields.contribution_amount) / 1e9;
      if (configValues.contributionAmountUsd === 0 && fields.contribution_amount_usd) configValues.contributionAmountUsd = Number(fields.contribution_amount_usd) / 100;
      if (configValues.securityDeposit === 0 && fields.security_deposit) configValues.securityDeposit = Number(fields.security_deposit) / 1e9;
      if (configValues.securityDepositUsd === 0 && fields.security_deposit_usd) configValues.securityDepositUsd = Number(fields.security_deposit_usd) / 100;
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

      // --- Check Membership and Fetch Member Count (Keep existing logic) ---
      const isAdmin = fields.admin === userAddress;
      setIsMember(isAdmin); // Simplified check
      if (isAdmin) {
        toast('You are the admin of this circle.');
        router.push(`/circle/${id}`); // Redirect admin
        return;
      }

      let memberCount = 1; // Start with admin
      try {
          const joinedEvents = await client.queryEvents({
          query: { MoveEventType: `${PACKAGE_ID}::njangi_circles::MemberJoined` },
          limit: 1000 // Fetch enough events
        });
          const memberAddresses = new Set<string>();
        memberAddresses.add(fields.admin); // Add admin
        joinedEvents.data.forEach(event => {
          if ((event.parsedJson as { circle_id?: string })?.circle_id === id && (event.parsedJson as { member?: string })?.member) {
            memberAddresses.add((event.parsedJson as { member: string }).member);
          }
        });
          memberCount = memberAddresses.size;
        console.log(`Join - Final member count: ${memberCount}`);
        // Check if current user is already a counted member
        if (userAddress && memberAddresses.has(userAddress)) {
             console.log('Join - User is already a member based on event query.');
             setIsMember(true);
             toast('You are already a member of this circle.');
             router.push(`/circle/${id}`);
             return;
        }
        } catch (error) {
        console.error(`Join - Error fetching member count for circle ${id}:`, error);
        memberCount = Number(fields.current_members || 1); // Fallback
      }
        
      // --- Final State Update ---
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
        currentMembers: memberCount, // Use accurately fetched count
        nextPayoutTime: Number(fields.next_payout_time || 0),
        });
        
    } catch (error) {
      console.error('Join - Error fetching circle details:', error);
      toast.error('Could not load circle information');
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
    
    if (!id || !userAddress || !account) {
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
          userName: account.name || 'Anonymous',
        }),
      });
      
      if (!response.ok) {
        console.error('[JoinPage] Failed to create join request:', response.status, response.statusText);
        toast.error('Failed to submit join request. Please try again.', {id: 'submit-request'});
        return;
      }
      
      const data = await response.json();
      console.log('[JoinPage] Join request creation response:', data);
      
      if (data.success) {
        // Update UI state
        setHasPendingRequest(true);
        toast.success('Join request submitted successfully', {id: 'submit-request'});
        
        // Recheck pending request status to confirm
        setTimeout(checkPendingRequest, 1000);
      } else {
        toast.error(data.message || 'Failed to submit join request', {id: 'submit-request'});
      }
    } catch (error) {
      console.error('[JoinPage] Error submitting join request:', error);
      toast.error('An error occurred. Please try again.', {id: 'submit-request'});
    } finally {
      setIsSubmitting(false);
    }
  };

  // Handle login button click
  const handleLoginClick = () => {
    // Store the current URL to redirect back after login
    const currentUrl = window.location.href;
    localStorage.setItem('redirectAfterLogin', currentUrl);
    
    // Trigger login with Google provider
    login('Google');
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
    const suffix = (relevantDigits >= 11 && relevantDigits <= 13) ? 'th' : suffixes[Math.min(relevantDigits % 10, 3)];
    return `${day}${suffix} day`;
  };

  // Helper function to calculate SUI amount from USD value
  const calculateSuiAmount = (usdValue: number): number => {
    if (!usdValue || !suiPrice || suiPrice <= 0) return 0;
    return usdValue / suiPrice;
  };

  // Helper function to format USD amounts
  const formatUSD = (amount: number): string => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(amount);
  };

  // Helper component to display both USD and SUI amounts
  const CurrencyDisplay = ({ usd, sui, className = '' }: { usd?: number, sui?: number, className?: string }) => {
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
      <div className={`flex flex-col ${className}`}>
        <span className="font-medium">{formatUSD(usdValue)}</span>
        <span className="text-sm text-gray-500">{formattedSui} SUI</span>
      </div>
    );
  };

  if (!isAuthenticated || !account) {
    return null;
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <main className="max-w-7xl mx-auto py-6 sm:px-6 lg:px-8">
        <div className="px-4 py-6 sm:px-0">
          <div className="mb-6">
            <button
              onClick={() => router.push('/dashboard')}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-white border border-gray-200 hover:bg-gray-50 hover:border-gray-300 transition-all shadow-sm text-sm text-gray-700 font-medium"
            >
              <ArrowLeft className="w-4 h-4" />
              Back to Dashboard
            </button>
          </div>

          <div className="bg-white shadow-md rounded-xl overflow-hidden border border-gray-100">
            <div className="p-6 border-b border-gray-200 bg-gradient-to-r from-blue-50 to-indigo-50">
              <h2 className="text-2xl font-bold text-gray-900">
                Join Circle
              </h2>
              {loading ? (
                <div className="py-8 flex justify-center">
                  <svg className="animate-spin h-8 w-8 text-blue-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                </div>
              ) : circle ? (
                <div className="py-4 space-y-8">
                  <div className="px-2">
                    <h3 className="text-lg font-medium text-gray-900 mb-4 border-l-4 border-blue-500 pl-3">Circle Details</h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      <div className="bg-gray-50 p-4 rounded-lg shadow-sm">
                        <p className="text-sm text-gray-500 mb-1">Circle Name</p>
                        <p className="text-lg font-medium">{circle.name}</p>
                      </div>
                      
                      <div className="bg-gray-50 p-4 rounded-lg shadow-sm">
                        <p className="text-sm text-gray-500 mb-1">Contribution Amount</p>
                        <CurrencyDisplay usd={circle.contributionAmountUsd} sui={circle.contributionAmount} />
                      </div>
                      
                      <div className="bg-gray-50 p-4 rounded-lg shadow-sm">
                        <p className="text-sm text-gray-500 mb-1">Security Deposit</p>
                        <CurrencyDisplay usd={circle.securityDepositUsd} sui={circle.securityDeposit} />
                      </div>
                      
                      <div className="bg-gray-50 p-4 rounded-lg shadow-sm">
                        <p className="text-sm text-gray-500 mb-1">Contribution Schedule</p>
                        <p className="text-lg font-medium">{formatCycleInfo(circle.cycleLength, circle.cycleDay)}</p>
                      </div>
                      
                      <div className="bg-gray-50 p-4 rounded-lg shadow-sm">
                        <p className="text-sm text-gray-500 mb-1">Members</p>
                        <p className="text-lg font-medium">{circle.currentMembers} / {circle.maxMembers}</p>
                      </div>
                    </div>
                  </div>
                  
                  <div className="pt-6 border-t border-gray-200 px-2">
                    <h3 className="text-lg font-medium text-gray-900 mb-4 border-l-4 border-blue-500 pl-3">Join Request</h3>
                    <div className="bg-yellow-50 p-4 rounded-md mb-6">
                      <p className="text-sm text-yellow-800">
                        By joining this circle, you agree to contribute {formatUSD(circle.contributionAmountUsd)} ({calculateSuiAmount(circle.contributionAmountUsd).toLocaleString()} SUI) {formatCycleInfo(circle.cycleLength, circle.cycleDay).toLowerCase()}. You will also need to pay a security deposit of {formatUSD(circle.securityDepositUsd)} ({calculateSuiAmount(circle.securityDepositUsd).toLocaleString()} SUI).
                      </p>
                    </div>
                    
                    {!isAuthenticated ? (
                      <div className="bg-blue-50 p-4 rounded-md mb-6">
                        <div className="flex flex-col items-center text-center">
                          <LogIn className="w-6 h-6 text-blue-600 mb-2" />
                          <h4 className="text-lg font-medium text-blue-800 mb-2">Login Required</h4>
                          <p className="text-sm text-blue-700 mb-4">
                            You need to log in to join this circle.
                          </p>
                          <button
                            onClick={handleLoginClick}
                            className="px-6 py-2 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-md transition-colors"
                          >
                            Log In to Continue
                          </button>
                        </div>
                      </div>
                    ) : hasPendingRequest ? (
                      <div className="bg-blue-50 p-4 rounded-md mb-6 flex items-start">
                        <AlertCircle className="w-5 h-5 text-blue-500 mr-2 flex-shrink-0 mt-0.5" />
                        <div>
                          <h4 className="text-sm font-medium text-blue-800">Request Sent</h4>
                          <p className="text-sm text-blue-700 mt-1">
                            Your request to join this circle has been sent to the admin. 
                            You&apos;ll be notified when your request is approved.
                          </p>
                        </div>
                      </div>
                    ) : (
                      <button
                        onClick={handleSubmit}
                        disabled={isSubmitting || isMember || hasPendingRequest}
                        className={`w-full flex justify-center py-3 px-4 rounded-lg shadow-sm text-sm font-medium text-white bg-gradient-to-r from-blue-600 to-blue-700 hover:from-blue-700 hover:to-blue-800 transition-all ${(isSubmitting || isMember || hasPendingRequest) ? 'opacity-70 cursor-not-allowed' : ''}`}
                      >
                        {isSubmitting ? 'Submitting Request...' : isMember ? 'Already a Member' : 'Request to Join Circle'}
                      </button>
                    )}
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
    </div>
  );
} 