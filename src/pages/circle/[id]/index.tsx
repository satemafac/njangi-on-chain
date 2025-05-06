import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { useAuth } from '../../../contexts/AuthContext';
import { SuiClient } from '@mysten/sui/client';
import { toast } from 'react-hot-toast';
import { ArrowLeft, Copy, Link } from 'lucide-react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { priceService } from '../../../services/price-service';
import { PACKAGE_ID } from '../../../services/circle-service';

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
}

// Fix linter errors by using more specific types
type SuiFieldValue = string | number | boolean | null | undefined | SuiFieldValue[] | Record<string, unknown>;

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

export default function CircleDetails() {
  const router = useRouter();
  const { id } = router.query;
  const { isAuthenticated, userAddress, account } = useAuth();
  const [loading, setLoading] = useState(true);
  const [circle, setCircle] = useState<Circle | null>(null);
  const [suiPrice, setSuiPrice] = useState(1.25); // Default price until we fetch real price
  const [copiedId, setCopiedId] = useState(false);

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

  const fetchCircleDetails = async () => {
    if (!id) return;
    console.log('Details - Fetching circle details:', id);
    const client = new SuiClient({ url: 'https://fullnode.testnet.sui.io:443' });
    
    try {
      setLoading(true);
      // Get object data
      const objectData = await client.getObject({
        id: id as string,
        options: { showContent: true, showType: true }
      });
      
      console.log('Details - Circle object data:', objectData);
      if (!objectData.data?.content || !('fields' in objectData.data.content)) {
        throw new Error('Invalid circle object data received');
      }
      const fields = objectData.data.content.fields as Record<string, SuiFieldValue>;

      // Get dynamic fields
      const dynamicFieldsResult = await client.getDynamicFields({
        parentId: id as string
      });
      console.log('Details - Dynamic fields:', dynamicFieldsResult.data);

      // Fetch creation event and transaction inputs
      let transactionInput: Record<string, unknown> | undefined;
      let circleCreationEventData: CircleCreatedEvent | undefined;

        try {
        const circleEvents = await client.queryEvents({
          query: { MoveEventType: `${PACKAGE_ID}::njangi_circles::CircleCreated` },
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
            contribution_amount_usd: circleCreationEventData.contribution_amount_usd,
            security_deposit_usd: circleCreationEventData.security_deposit_usd,
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
            if (inputs.length > 2 && inputs[2]?.type === 'pure') transactionInput.contribution_amount_usd = inputs[2].value;
            if (inputs.length > 4 && inputs[4]?.type === 'pure') transactionInput.security_deposit_usd = inputs[4].value;
            if (inputs.length > 6 && inputs[6]?.type === 'pure') transactionInput.cycle_day = inputs[6].value;
            console.log('Details - Extracted from Tx Inputs:', transactionInput);
          }
        }
        } catch (error) {
        console.error('Details - Error fetching transaction data:', error);
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
        if (transactionInput.contribution_amount_usd) configValues.contributionAmountUsd = Number(transactionInput.contribution_amount_usd) / 100;
        if (transactionInput.security_deposit_usd) configValues.securityDepositUsd = Number(transactionInput.security_deposit_usd) / 100;
        if (transactionInput.cycle_day) configValues.cycleDay = Number(transactionInput.cycle_day);
      }
      if (circleCreationEventData) {
        if (circleCreationEventData.cycle_length) configValues.cycleLength = Number(circleCreationEventData.cycle_length);
        if (circleCreationEventData.max_members) configValues.maxMembers = Number(circleCreationEventData.max_members);
      }
      console.log('Details - Config after Tx/Event:', configValues);

      // 2. Look for config in dynamic fields
      for (const field of dynamicFieldsResult.data) {
        // Find the CircleConfig dynamic field
        if ((field.name && typeof field.name === 'object' && 'value' in field.name && field.name.value === 'circle_config') ||
            (field.type && typeof field.type === 'string' && field.type.includes('CircleConfig')) ||
            (field.objectType && typeof field.objectType === 'string' && field.objectType.includes('CircleConfig'))) {
          
          console.log('Details - Found CircleConfig dynamic field:', field);
          
          if (field.objectId) {
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
              
              console.log('Details - Fetched complete CircleConfig object:', configData);
              
              // Process the object data to access the deeply nested max_members value
              if (configData.data?.content && 'fields' in configData.data.content) {
                const contentFields = configData.data.content.fields as Record<string, unknown>;
                console.log('Details - CircleConfig content fields:', contentFields);
                
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
                  console.log('Details - Extracted max_members directly:', configValues.maxMembers);
                }
                
                // Check for the deep nested structure at value.fields path
                if ('value' in contentFields && 
                    contentFields.value && 
                    typeof contentFields.value === 'object') {
                  
                  const valueObj = contentFields.value as Record<string, unknown>;
                  console.log('Details - CircleConfig value object:', valueObj);
                  
                  if ('fields' in valueObj && 
                      valueObj.fields && 
                      typeof valueObj.fields === 'object') {
                    
                    const configFields = valueObj.fields as Record<string, unknown>;
                    console.log('Details - CircleConfig nested fields:', configFields);
                    
                    // Extract all config values from the deeply nested structure
                    if ('max_members' in configFields) {
                      configValues.maxMembers = Number(configFields.max_members);
                      console.log('Details - Successfully extracted max_members:', configValues.maxMembers);
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
              console.error('Details - Error fetching config object:', error);
            }
          }
        }
      }
      console.log('Details - Config after Dynamic Fields:', configValues);

      // 3. Use direct fields from the circle object as a fallback
      if (configValues.contributionAmount === 0 && fields.contribution_amount) configValues.contributionAmount = Number(fields.contribution_amount) / 1e9;
      if (configValues.contributionAmountUsd === 0 && fields.contribution_amount_usd) configValues.contributionAmountUsd = Number(fields.contribution_amount_usd) / 100;
      if (configValues.securityDeposit === 0 && fields.security_deposit) configValues.securityDeposit = Number(fields.security_deposit) / 1e9;
      if (configValues.securityDepositUsd === 0 && fields.security_deposit_usd) configValues.securityDepositUsd = Number(fields.security_deposit_usd) / 100;
      // Fallback for cycle info if not found earlier
      if (configValues.cycleLength === 0 && fields.cycle_length !== undefined) configValues.cycleLength = Number(fields.cycle_length);
      if (configValues.cycleDay === 1 && fields.cycle_day !== undefined) configValues.cycleDay = Number(fields.cycle_day);
      if (configValues.maxMembers === 3 && fields.max_members !== undefined) configValues.maxMembers = Number(fields.max_members);

      console.log('Details - Final Config Values:', configValues);

      // Check activation status
      let isActive = false;
      try {
        const activationEvents = await client.queryEvents({
          query: { MoveEventType: `${PACKAGE_ID}::njangi_circles::CircleActivated` },
          limit: 50
        });
        isActive = activationEvents.data.some(event => 
          (event.parsedJson as { circle_id?: string })?.circle_id === id
        );
        console.log('Details - Circle activation status:', isActive);
      } catch (error) {
        console.error('Details - Error checking activation:', error);
      }

      // Calculate member count
      let actualMemberCount = 1;
      const memberAddresses = new Set<string>();
      if (typeof fields.admin === 'string') memberAddresses.add(fields.admin);
      try {
        const memberEvents = await client.queryEvents({
          query: { MoveEventType: `${PACKAGE_ID}::njangi_circles::MemberJoined` },
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
        console.error('Details - Error calculating member count:', error);
        actualMemberCount = Number(fields.current_members || 1);
        }
        
      // Set circle state
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
          currentMembers: actualMemberCount,
        nextPayoutTime: Number(fields.next_payout_time || 0),
          isActive: isActive,
        });

    } catch (error) {
      console.error('Details - Error fetching circle details:', error);
      toast.error('Error loading circle details');
    } finally {
      setLoading(false);
    }
  };

  const formatDate = (timestamp: number, useLocalTime = false) => {
    if (!timestamp) return 'Not set';
    return new Date(timestamp).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      timeZone: useLocalTime ? undefined : 'UTC' // Use local timezone when requested
    });
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
    
    // Check for invalid inputs and provide defaults
    if ((usd === undefined || isNaN(usd)) && (sui === undefined || isNaN(sui))) {
      usd = 0;
      sui = 0;
    }
    
    // Calculate values based on which parameter is provided
    let calculatedSui: number | null = null;
    let calculatedUsd: number | null = null;
    
    if (usd !== undefined && !isNaN(usd)) {
      // If USD is provided and valid, calculate SUI based on current price
      calculatedUsd = usd;
      calculatedSui = suiPrice !== null && suiPrice > 0 ? usd / suiPrice : null;
    } else if (sui !== undefined && !isNaN(sui)) {
      // If SUI is provided and valid, calculate USD
      calculatedSui = sui;
      calculatedUsd = suiPrice !== null ? sui * suiPrice : null;
    } else {
      // Default values if neither is provided or values are invalid
      calculatedSui = 0;
      calculatedUsd = 0;
    }
    
    // Format SUI with appropriate precision if available
    const formattedSui = calculatedSui !== null ? (
      calculatedSui >= 1000 
        ? calculatedSui.toLocaleString(undefined, { maximumFractionDigits: 0 }) 
        : calculatedSui >= 100 
          ? calculatedSui.toFixed(1) 
          : calculatedSui.toFixed(2)
    ) : '—';
    
    return (
      <Tooltip.Provider>
        <Tooltip.Root>
          <Tooltip.Trigger asChild>
            <span className={`cursor-help ${className} flex items-center`}>
              {calculatedUsd !== null ? formatUSD(calculatedUsd) : '$—.—'} 
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
              <div className="flex justify-between items-center">
                <h2 className="text-2xl font-bold text-gray-900">
                  {!loading && circle ? circle.name : 'Circle Details'}
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
                            <Copy size={16} />
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
                    
                    {!loading && circle && circle.admin === userAddress && (
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
                    )}
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
                  {/* Circle Details Section - Original style but improved layout */}
                  <div className="px-2">
                    <h3 className="text-lg font-medium text-gray-900 mb-4 border-l-4 border-blue-500 pl-3">Circle Details</h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      <div className="bg-gray-50 p-4 rounded-lg shadow-sm">
                        <p className="text-sm text-gray-500 mb-1">Circle Name</p>
                        <p className="text-lg font-medium">{circle.name}</p>
                      </div>
                      
                      <div className="bg-gray-50 p-4 rounded-lg shadow-sm">
                        <p className="text-sm text-gray-500 mb-1">Admin</p>
                        <p className="text-sm font-medium text-gray-700 truncate">{circle.admin}</p>
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
                        <p className="text-sm text-gray-500 mb-1">Members</p>
                        <p className="text-lg font-medium">{circle.currentMembers} / {circle.maxMembers}</p>
                      </div>
                      
                      <div className="bg-gray-50 p-4 rounded-lg shadow-sm">
                        <p className="text-sm text-gray-500 mb-1">Cycle</p>
                        <p className="text-lg font-medium">{formatCycleInfo(circle.cycleLength, circle.cycleDay)}</p>
                      </div>
                      
                      <div className="bg-gray-50 p-4 rounded-lg shadow-sm col-span-1 md:col-span-2">
                        <p className="text-sm text-gray-500 mb-1">
                          {circle.isActive ? 'Next Payout' : 'Potential Next Payout'}
                        </p>
                        <p className="text-lg font-medium">
                          {circle.isActive 
                            ? formatDate(circle.nextPayoutTime)
                            : <span className="text-blue-600">Activate Circle to Start</span>
                          }
                          {!circle.isActive && 
                            <span className="ml-2 text-sm text-gray-500">
                              (Estimated: {formatDate(calculatePotentialNextPayoutDate(circle.cycleLength, circle.cycleDay))})
                            </span>
                          }
                        </p>
                      </div>
                    </div>
                  </div>
                  
                  {/* Actions */}
                  <div className="pt-6 border-t border-gray-200 px-2">
                    <h3 className="text-lg font-medium text-gray-900 mb-4 border-l-4 border-blue-500 pl-3">Actions</h3>
                    <div className="flex flex-col space-y-4 sm:flex-row sm:space-x-4 sm:space-y-0">
                      <button
                        onClick={() => router.push(`/circle/${circle.id}/contribute`)}
                        className="px-5 py-3 bg-gradient-to-r from-blue-600 to-blue-700 text-white rounded-lg text-sm hover:from-blue-700 hover:to-blue-800 transition-all shadow-md font-medium flex items-center justify-center"
                      >
                        Contribute
                      </button>
                      
                      {circle.admin === userAddress && (
                        <button
                          onClick={() => router.push(`/circle/${circle.id}/manage`)}
                          className="px-5 py-3 bg-gradient-to-r from-purple-600 to-purple-700 text-white rounded-lg text-sm hover:from-purple-700 hover:to-purple-800 transition-all shadow-md font-medium flex items-center justify-center"
                        >
                          Manage Circle
                        </button>
                      )}
                    </div>
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