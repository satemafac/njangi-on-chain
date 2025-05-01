import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { useAuth } from '../../../../contexts/AuthContext';
import { SuiClient } from '@mysten/sui/client';
import { toast } from 'react-hot-toast';
import { ArrowLeft } from 'lucide-react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { priceService } from '../../../../services/price-service';
import { PACKAGE_ID } from '../../../../services/circle-service';
import SimplifiedSwapUI from '../../../../components/SimplifiedSwapUI';

// Constants for transaction calculations
const ESTIMATED_GAS_FEE = 0.00021; // Gas fee in SUI
const DEFAULT_SLIPPAGE = 0.5; // Default slippage percentage
const BUFFER_PERCENTAGE = 1.5; // Additional buffer percentage for swap rate fluctuations

// IMPORTANT: The values in CircleConfig are stored as follows:
// - contribution_amount: SUI amount with 9 decimals (MIST)
// - contribution_amount_usd: USD amount in cents (e.g., 20 = $0.20)
// - security_deposit: SUI amount with 9 decimals (MIST)
// - security_deposit_usd: USD amount in cents (e.g., 20 = $0.20)
//
// For USDC deposits (6 decimals), the validation compares the USDC amount with 
// security_deposit_usd * 10000. For example:
// $0.20 USD (20 cents) should be exactly 200,000 microUSDC (0.2 USDC with 6 decimals).
// 
// For SUI deposits, the validation requires an EXACT match with the security_deposit
// value stored in the CircleConfig, which is in MIST (9 decimals). Frontend calculations 
// can sometimes lead to rounding differences, so it's safest to query the exact value
// from the CircleConfig and use that.
// 
// Do NOT double-convert values. The frontend should calculate and pass the exact 
// required amount, and the contract will not perform additional scaling.

// Define a proper Circle type to fix linter errors
interface Circle {
  id: string;
  name: string;
  admin: string;
  contributionAmount: number;
  contributionAmountUsd: number;
  securityDeposit: number;
  securityDepositUsd: number;
  walletId: string; // Custody wallet ID
  autoSwapEnabled?: boolean; // Add this field
}

// Define a type for the fields from the SUI object
interface CircleFields {
  name: string;
  admin: string;
  contribution_amount: string;
  security_deposit: string;
  contribution_amount_usd?: string;
  security_deposit_usd?: string;
  usd_amounts?: {
    fields?: {
      contribution_amount: string;
      security_deposit: string;
      target_amount?: string;
    };
    contribution_amount?: string;
    security_deposit?: string;
    target_amount?: string;
  } | string; // Allow string for potential older structures
  wallet_id?: string; // Add wallet_id if it can be a direct field
  auto_swap_enabled?: boolean | string; // Allow string for potential older structures
  // Use unknown for index signature as a safer alternative to any
  [key: string]: string | number | boolean | object | unknown;
}

// Add missing CircleCreatedEvent interface
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

// Define types for SUI object field values
type SuiFieldValue = string | number | boolean | null | undefined | SuiFieldValue[] | Record<string, unknown>;

export default function ContributeToCircle() {
  const router = useRouter();
  const { id } = router.query;
  const { isAuthenticated, userAddress, account } = useAuth();
  const [loading, setLoading] = useState(true);
  const [circle, setCircle] = useState<Circle | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [suiPrice, setSuiPrice] = useState(1.25);
  
  // New state variables
  const [userBalance, setUserBalance] = useState<number | null>(null);
  const [userDepositPaid, setUserDepositPaid] = useState(false);
  const [fetchingBalance, setFetchingBalance] = useState(false);
  const [isPayingDeposit, setIsPayingDeposit] = useState(false);

  // Add state to track custody wallet stablecoin balance
  const [custodyStablecoinBalance, setCustodyStablecoinBalance] = useState<number | null>(null);
  // Add separate states for security deposits and contribution funds
  const [securityDepositBalance, setSecurityDepositBalance] = useState<number | null>(null);
  const [contributionBalance, setContributionBalance] = useState<number | null>(null);
  const [loadingStablecoinBalance, setLoadingStablecoinBalance] = useState(false);
  const [isInitialBalanceLoad, setIsInitialBalanceLoad] = useState(true);
  
  // New state for user's USDC balance
  const [userUsdcBalance, setUserUsdcBalance] = useState<number | null>(null);
  const [showDirectDepositOption, setShowDirectDepositOption] = useState<boolean>(false);
  const [directDepositProcessing, setDirectDepositProcessing] = useState<boolean>(false);
  
  // USDC coin type
  const USDC_COIN_TYPE = '0x26b3bc67befc214058ca78ea9a2690298d731a2d4309485ec3d40198063c4abc::usdc::USDC';

  useEffect(() => {
    if (!isAuthenticated) {
      router.push('/');
      return;
    }
  }, [isAuthenticated, router]);

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
    if (id && userAddress) {
      fetchCircleDetails();
    }
  }, [id, userAddress]);

  // Add effect to fetch user balance and deposit status when circle data is loaded
  useEffect(() => {
    if (circle && userAddress) {
      fetchUserWalletInfo();
    }
  }, [circle, userAddress]);

  // First add console logs to debug the conditions for showing the button
  useEffect(() => {
    if (circle && userDepositPaid !== null) {
      console.log('Security deposit button conditions:', {
        userDepositPaid,
        hasCircle: !!circle,
        securityDepositAmount: circle.securityDeposit,
        shouldShowButton: !userDepositPaid && !!circle && circle.securityDeposit > 0
      });
    }
  }, [circle, userDepositPaid]);

  // Add debug log to check the security deposit value when showing the warning
  useEffect(() => {
    if (circle) {
      console.log('Security deposit values:', {
        rawValue: circle.securityDeposit,
        usdValue: circle.securityDepositUsd,
        formattedSUI: `${circle.securityDeposit} SUI`,
        formattedUSD: `$${circle.securityDepositUsd}`
      });
    }
  }, [circle]);

  // Add effect to fetch custody wallet stablecoin balance when circle data is loaded
  useEffect(() => {
    if (circle && circle.walletId) {
      fetchCustodyWalletBalance();
    }
    // fetchCustodyWalletBalance depends on circle but we don't need to
    // re-run it every time the entire circle object changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [circle?.id, circle?.walletId]);

  const fetchCircleDetails = async () => {
    if (!id) return;
    console.log('Contribute - Fetching circle details for:', id);
    
    setLoading(true);
    try {
      const client = new SuiClient({ url: 'https://fullnode.testnet.sui.io:443' });
      
      // Get circle object with content
      const objectData = await client.getObject({
        id: id as string,
        options: { showContent: true, showType: true }
      });
      
      if (!objectData.data?.content || !('fields' in objectData.data.content)) {
        throw new Error('Invalid circle object data received');
      }
        const fields = objectData.data.content.fields as CircleFields;
      console.log('Contribute - Raw Circle Object Fields:', fields);
        
      // Get dynamic fields
      const dynamicFieldsResult = await client.getDynamicFields({
        parentId: id as string
      });
      const dynamicFields = dynamicFieldsResult.data;
      console.log('Contribute - Dynamic Fields:', dynamicFields);

      // Fetch creation event and transaction inputs (similar to dashboard)
      let transactionInput: Record<string, unknown> | undefined;
      let circleCreationEventData: CircleCreatedEvent | undefined;
      let walletId = '';

      try {
        // 1. Fetch CircleCreated event
        const circleEvents = await client.queryEvents({
          query: { MoveEventType: `${PACKAGE_ID}::njangi_circles::CircleCreated` },
          limit: 50
        });
        const createEvent = circleEvents.data.find(event => 
          (event.parsedJson as { circle_id?: string })?.circle_id === id
        );
        console.log('Contribute - Found creation event:', !!createEvent);

        if (createEvent?.parsedJson) {
          circleCreationEventData = createEvent.parsedJson as CircleCreatedEvent;
          // Try extracting basic config from event
          transactionInput = {
            contribution_amount: circleCreationEventData.contribution_amount,
            contribution_amount_usd: circleCreationEventData.contribution_amount_usd,
            security_deposit_usd: circleCreationEventData.security_deposit_usd,
          };
        }

        // 2. Fetch Transaction Block for inputs (like cycle_day, potentially others)
        if (createEvent?.id?.txDigest) {
          const txData = await client.getTransactionBlock({
            digest: createEvent.id.txDigest,
            options: { showInput: true }
          });
          console.log('Contribute - Transaction data fetched:', !!txData);
          if (txData?.transaction?.data?.transaction?.kind === 'ProgrammableTransaction') {
            const inputs = txData.transaction.data.transaction.inputs || [];
            console.log('Contribute - Transaction inputs:', inputs);
            if (!transactionInput) transactionInput = {};
            // Extract relevant inputs based on expected positions (adjust if needed)
            if (inputs.length > 1 && inputs[1]?.type === 'pure') transactionInput.contribution_amount = inputs[1].value;
            if (inputs.length > 2 && inputs[2]?.type === 'pure') transactionInput.contribution_amount_usd = inputs[2].value;
            if (inputs.length > 4 && inputs[4]?.type === 'pure') transactionInput.security_deposit_usd = inputs[4].value;
            // Add any other inputs you stored this way
          }
        }
        
        // 3. Fetch CustodyWalletCreated event for walletId
        const custodyEvents = await client.queryEvents({
          query: { MoveEventType: `${PACKAGE_ID}::njangi_custody::CustodyWalletCreated` },
          limit: 100
        });
        const custodyEvent = custodyEvents.data.find(event =>
          event.parsedJson && 
              typeof event.parsedJson === 'object' &&
              'circle_id' in event.parsedJson &&
              'wallet_id' in event.parsedJson &&
          event.parsedJson.circle_id === id
        );
        if (custodyEvent?.parsedJson) {
          walletId = (custodyEvent.parsedJson as { wallet_id: string }).wallet_id;
          console.log('Contribute - Found wallet ID from events:', walletId);
        }

      } catch (error) {
        console.error('Contribute - Error fetching event/transaction data:', error);
        // Continue even if this fails, rely on other data sources
        }

      // --- Process Extracted Data (Prioritize sources) ---
      const configValues = {
        contributionAmount: 0,
        contributionAmountUsd: 0,
        securityDeposit: 0, // SUI amount
        securityDepositUsd: 0,
        autoSwapEnabled: false,
      };

      // 1. Use values from transaction/event first
      if (transactionInput) {
        if (transactionInput.contribution_amount) configValues.contributionAmount = Number(transactionInput.contribution_amount) / 1e9;
        if (transactionInput.contribution_amount_usd) configValues.contributionAmountUsd = Number(transactionInput.contribution_amount_usd) / 100;
        if (transactionInput.security_deposit_usd) configValues.securityDepositUsd = Number(transactionInput.security_deposit_usd) / 100;
      }
      // Note: CircleCreatedEvent doesn't hold SUI amounts directly, rely on other sources or calculation
      console.log('Contribute - Config after Tx/Event:', configValues);

      // 2. Look for config in dynamic fields
      for (const field of dynamicFields) {
        if (!field) continue;

        // CORRECTED CONDITION: Check the objectType property
        if (field.objectType && typeof field.objectType === 'string' && field.objectType.includes('::CircleConfig')) {
          console.log('Contribute - Found CircleConfig dynamic field by objectType:', field);
          if (field.objectId) {
            console.log('Contribute - Fetching CircleConfig dynamic field object:', field.objectId);
            try {
              const configData = await client.getObject({
                id: field.objectId,
                options: { showContent: true }
              });
              console.log('Contribute - Config object content:', configData);

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
                    console.log('Contribute - Accessed nested configFields:', configFields);

                    // Override with values from the config object
                    if (configFields.contribution_amount) configValues.contributionAmount = Number(configFields.contribution_amount) / 1e9;
                    if (configFields.contribution_amount_usd) configValues.contributionAmountUsd = Number(configFields.contribution_amount_usd) / 100;
                    if (configFields.security_deposit) configValues.securityDeposit = Number(configFields.security_deposit) / 1e9;
                    if (configFields.security_deposit_usd) configValues.securityDepositUsd = Number(configFields.security_deposit_usd) / 100;
                    if (configFields.auto_swap_enabled !== undefined) {
                        const dynamicValue = Boolean(configFields.auto_swap_enabled);
                        console.log(`Contribute - Found auto_swap_enabled (${dynamicValue}) in dynamic field ${field.objectId}`);
                        configValues.autoSwapEnabled = dynamicValue;
                    }
                    // Add other config fields if needed
                  } else {
                     console.warn('Contribute - Could not find nested fields in outerFields.value');
                  }
                } else {
                  console.warn("Contribute - Could not find 'value' property in outerFields");
                }
               } else {
                  console.warn('Contribute - Could not find fields in configData.data.content');
               }
            } catch (error) {
              console.error(`Contribute - Error fetching config object ${field.objectId}:`, error);
            }
            break; // Assuming only one config object
          }
        }
      }
      console.log('Contribute - Config after Dynamic Fields:', configValues);

      // 3. Use direct fields from the circle object as a fallback
      // Only update if the value hasn't been set yet (is 0 or false)
      if (configValues.contributionAmount === 0 && fields.contribution_amount) configValues.contributionAmount = Number(fields.contribution_amount) / 1e9;
      if (configValues.contributionAmountUsd === 0) {
          if (fields.contribution_amount_usd) {
              configValues.contributionAmountUsd = Number(fields.contribution_amount_usd) / 100;
          } else if (fields.usd_amounts && typeof fields.usd_amounts === 'object' && fields.usd_amounts !== null) {
              // Refined type assertion for usd_amounts
              const usdData = fields.usd_amounts as {
                 fields?: { contribution_amount?: string; security_deposit?: string };
                 contribution_amount?: string;
                 security_deposit?: string;
              };
              const usdFields = usdData.fields || usdData;
              if (usdFields?.contribution_amount) {
                  configValues.contributionAmountUsd = Number(usdFields.contribution_amount) / 100;
        }
          }
      }
      if (configValues.securityDeposit === 0 && fields.security_deposit) configValues.securityDeposit = Number(fields.security_deposit) / 1e9;
      if (configValues.securityDepositUsd === 0) {
          if (fields.security_deposit_usd) {
              configValues.securityDepositUsd = Number(fields.security_deposit_usd) / 100;
          } else if (fields.usd_amounts && typeof fields.usd_amounts === 'object' && fields.usd_amounts !== null) {
              // Refined type assertion for usd_amounts
              const usdData = fields.usd_amounts as {
                 fields?: { contribution_amount?: string; security_deposit?: string };
                 contribution_amount?: string;
                 security_deposit?: string;
              };
              const usdFields = usdData.fields || usdData;
              if (usdFields?.security_deposit) {
                  configValues.securityDepositUsd = Number(usdFields.security_deposit) / 100;
              }
          }
      }
      console.log('Contribute - Config after Direct Fields Fallback:', configValues);
      
      // 4. Calculate SUI amounts from USD if SUI amount is still zero (and price is available)
      if (configValues.contributionAmount === 0 && configValues.contributionAmountUsd > 0 && suiPrice > 0) {
          configValues.contributionAmount = configValues.contributionAmountUsd / suiPrice;
          console.log(`Contribute - Calculated contribution SUI from USD: ${configValues.contributionAmount}`);
      }
      if (configValues.securityDeposit === 0 && configValues.securityDepositUsd > 0 && suiPrice > 0) {
          configValues.securityDeposit = configValues.securityDepositUsd / suiPrice;
          console.log(`Contribute - Calculated security deposit SUI from USD: ${configValues.securityDeposit}`);
      }

      // Ensure walletId is set, even if event fetch failed, try direct field (less reliable)
      if (!walletId && typeof fields.wallet_id === 'string') {
          walletId = fields.wallet_id;
          console.log('Contribute - Using wallet ID from direct field:', walletId);
      }
        
      // Set the final circle state
        setCircle({
          id: id as string,
        name: typeof fields.name === 'string' ? fields.name : '',
        admin: typeof fields.admin === 'string' ? fields.admin : '',
        contributionAmount: configValues.contributionAmount,
        contributionAmountUsd: configValues.contributionAmountUsd,
        securityDeposit: configValues.securityDeposit,
        securityDepositUsd: configValues.securityDepositUsd,
        walletId: walletId, // Use the reliably fetched walletId
        autoSwapEnabled: configValues.autoSwapEnabled,
        });

    } catch (error) {
      console.error('Contribute - Error fetching circle details:', error);
      toast.error('Could not load circle information');
    } finally {
      setLoading(false);
    }
  };

  const fetchUserWalletInfo = async () => {
    if (!userAddress || !circle) return;
    
    setFetchingBalance(true);
    try {
      const client = new SuiClient({ url: 'https://fullnode.testnet.sui.io:443' });
      
      // 1. Get user's SUI coins to calculate balance
      const coins = await client.getCoins({
        owner: userAddress,
        coinType: '0x2::sui::SUI'
      });
      
      // Calculate total balance
      const totalBalance = coins.data.reduce((sum, coin) => sum + Number(coin.balance), 0) / 1e9;
      setUserBalance(totalBalance);
      
      // Get user's USDC coins and calculate USDC balance
      try {
        const usdcCoins = await client.getCoins({
          owner: userAddress,
          coinType: USDC_COIN_TYPE
        });
        
        // Calculate total USDC balance (USDC typically has 6 decimals)
        const totalUsdcBalance = usdcCoins.data.reduce((sum, coin) => sum + Number(coin.balance), 0) / 1e6;
        setUserUsdcBalance(totalUsdcBalance);
        console.log('User USDC balance:', totalUsdcBalance);
        
        // Enable direct deposit option if user has enough USDC
        if (totalUsdcBalance > 0) {
          // For security deposit
          if (!userDepositPaid && circle.securityDepositUsd > 0 && totalUsdcBalance >= circle.securityDepositUsd) {
            setShowDirectDepositOption(true);
          }
          // For regular contribution
          else if (userDepositPaid && circle.contributionAmountUsd > 0 && totalUsdcBalance >= circle.contributionAmountUsd) {
            setShowDirectDepositOption(true);
          }
        } else {
          setShowDirectDepositOption(false);
        }
        
      } catch (error) {
        console.error('Error fetching USDC balance:', error);
        setUserUsdcBalance(null);
        setShowDirectDepositOption(false);
      }
      
      // 2. Check if the user has already paid their security deposit
      let depositPaid = false;
      
      // First method: check if the user is in the members table with a deposit
      if (circle.id) {
        const circleData = await client.getObject({
          id: circle.id,
          options: { showContent: true, showDisplay: true }
        });
        
        if (circleData.data?.content && 'fields' in circleData.data.content) {
          // Check members table in circle
          const fields = circleData.data.content.fields as {
            members?: {
              fields?: {
                table?: {
                  fields?: {
                    contents?: Array<{
                      fields?: {
                        key: string;
                        value: {
                          fields: {
                            deposit_balance: string;
                            [key: string]: unknown;
                          }
                        }
                      }
                    }>
                  }
                }
              }
            }
          };
          
          // Look for the user in the members table
          if (fields.members?.fields?.table?.fields?.contents) {
            const memberEntries = fields.members.fields.table.fields.contents;
            
            for (const entry of memberEntries) {
              if (entry.fields && entry.fields.key === userAddress) {
                // Found the user in the members table, check their deposit status
                const memberData = entry.fields.value.fields;
                
                // If deposit_balance is greater than 0, they've paid their deposit
                const depositFromMember = Number(memberData.deposit_balance) > 0;
                if (depositFromMember) {
                  depositPaid = true;
                  console.log('User deposit found in member table:', depositFromMember ? 'Paid' : 'Not Paid');
                  break;
                }
              }
            }
          }
        }
      }
      
      // Second method: Check custody wallet's dynamic fields for coins
      if (!depositPaid && circle.walletId) {
        console.log('Checking custody wallet dynamic fields for deposits...');
        
        // Get dynamic fields
        const dynamicFields = await client.getDynamicFields({
          parentId: circle.walletId
        });
        
        console.log('Dynamic fields in custody wallet:', dynamicFields);

        // Look for the coin_objects field that holds the coins
        for (const field of dynamicFields.data) {
          if (field.name && typeof field.name === 'object' && 'type' in field.name) {
            // Check if it's our coin_objects field
            if (field.name.value === 'coin_objects') {
              console.log('Found coin_objects field:', field);
              
              // Get the actual dynamic field object to find the coin references
              const coinObjectsField = await client.getObject({
                id: field.objectId,
                options: { showContent: true, showOwner: true, showDisplay: true }
              });
              
              console.log('Coin objects field content:', coinObjectsField);
              
              // If it contains USDC coins, check if they came from this user
              if (coinObjectsField.data?.content && 'fields' in coinObjectsField.data.content) {
                // Check for any USDC deposit events from this user
                const custodyDepositEvents = await client.queryEvents({
                  query: {
                    MoveEventType: `${PACKAGE_ID}::njangi_circles::StablecoinDeposited`
                  },
                  limit: 50
                });
                
                // Process events to find deposits by this user
                for (const event of custodyDepositEvents.data) {
                  if (event.parsedJson && typeof event.parsedJson === 'object') {
                    const eventData = event.parsedJson as {
                      circle_id?: string;
                      wallet_id?: string;
                      member?: string;
                      amount?: string;
                      new_balance?: string;
                      previous_balance?: string;
                      coin_type?: string;
                    };
                    
                    console.log('Found stablecoin deposit event:', eventData);
                    
                    // Check if this deposit was made by our user to our circle's wallet
                    if (eventData.circle_id === circle.id && 
                        eventData.wallet_id === circle.walletId && 
                        eventData.member === userAddress && 
                        eventData.amount) {
                      // Check if the amount is at least the required security deposit (with some margin for gas)
                      const depositAmount = Number(eventData.amount) / 1e6; // USDC typically has 6 decimals
                      if (depositAmount >= circle.securityDeposit * 0.95) { // 5% margin for gas
                        depositPaid = true;
                        console.log('User deposit found in stablecoin events:', depositAmount, 'USDC');
                        break;
                      }
                    }
                  }
                }
              }
              
              break;
            }
          }
        }
      }
      
      // Third method (fallback): Check USDC deposit events if we haven't found a deposit yet
      if (!depositPaid && circle.walletId) {
        console.log('Checking custody wallet for deposit events...');
        
        // Query events for deposits made by this user to the custody wallet
        const custodyDepositEvents = await client.queryEvents({
          query: {
            MoveEventType: `${PACKAGE_ID}::njangi_circles::CustodyDeposited`
          },
          limit: 50
        });
        
        // Process events to find deposits by this user for this circle
        for (const event of custodyDepositEvents.data) {
          if (event.parsedJson && typeof event.parsedJson === 'object') {
            const eventData = event.parsedJson as {
              circle_id?: string;
              wallet_id?: string;
              member?: string;
              amount?: string;
            };
            
            console.log('Found custody deposit event:', eventData);
            
            // Check if this deposit was made by our user to our circle's wallet
            if (eventData.circle_id === circle.id && 
                eventData.wallet_id === circle.walletId && 
                eventData.member === userAddress && 
                eventData.amount) {
              // Check if the amount is at least the required security deposit (with some margin for gas)
              const depositAmount = Number(eventData.amount) / 1e9;
              if (depositAmount >= circle.securityDeposit * 0.95) { // 5% margin for gas
                depositPaid = true;
                console.log('User deposit found in custody events:', depositAmount, 'SUI');
                break;
              }
            }
          }
        }
      }
      
      // Set final deposit status
      setUserDepositPaid(depositPaid);
      console.log('Final user deposit status:', depositPaid ? 'Paid' : 'Not Paid');
    } catch (error) {
      console.error('Error fetching user wallet info:', error);
    } finally {
      setFetchingBalance(false);
    }
  };

  const handleContribute = async () => {
    if (!circle || !userAddress) return;
    
    setIsProcessing(true);
    try {
      if (!userDepositPaid) {
        toast.error('Security deposit required before contributing');
        setIsProcessing(false);
        return;
      }
      
      if (!account) {
        toast.error('User account not available. Please log in again.');
        setIsProcessing(false);
        return;
      }
      
      // Check if there's sufficient USDC balance in contribution funds (not security deposits)
      const hasEnoughUSDC = contributionBalance !== null && 
                           contributionBalance >= circle.contributionAmountUsd;

      // Log the contribution source decision with detailed breakdown
      console.log('Contribution source decision:', {
        totalBalance: custodyStablecoinBalance,
        securityDeposits: securityDepositBalance,
        contributionFunds: contributionBalance,
        requiredAmount: circle.contributionAmountUsd,
        hasEnoughUSDC,
        willUseUSDC: hasEnoughUSDC
      });
      
      // Show different toast message based on the source of funds
      if (hasEnoughUSDC) {
        toast.loading('Processing contribution from custody wallet USDC...', { id: 'contribute-tx' });
      } else {
        toast.loading('Processing contribution from SUI...', { id: 'contribute-tx' });
      }
      
      // Execute contribution through the custody wallet
      const result = await fetch('/api/zkLogin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'contributeFromCustody',
          account,
          circleId: circle.id,
          walletId: circle.walletId,
          useUSDC: hasEnoughUSDC // Tell backend to prefer USDC if available
        }),
      });
      
      const responseData = await result.json();
      
      if (!result.ok) {
        console.error('Contribution failed:', responseData);
        toast.error(responseData.error || 'Failed to process contribution', { id: 'contribute-tx' });
        return;
      }
      
      // Show success message based on source of funds
      if (hasEnoughUSDC) {
        toast.success('Contribution successful! Used USDC from custody wallet.', { id: 'contribute-tx' });
      } else {
        toast.success('Contribution successful!', { id: 'contribute-tx' });
      }
      
      console.log('Contribution transaction digest:', responseData.digest);
      
      // Refresh user wallet info, circle data, and custody wallet balance
      fetchUserWalletInfo();
      fetchCircleDetails();
      fetchCustodyWalletBalance();
    } catch (error) {
      console.error('Error contributing:', error);
      toast.error('Failed to process contribution');
    } finally {
      setIsProcessing(false);
    }
  };

  // Add a helper function to calculate live security deposit amount in SUI
  const getSecurityDepositInSui = (): number => {
    if (!circle || !circle.securityDepositUsd || typeof suiPrice !== 'number' || suiPrice <= 0) {
      return circle?.securityDeposit || 0;
    }
    
    // Calculate based on the latest SUI price
    return circle.securityDepositUsd / suiPrice;
  };

  // New function to calculate total required amount including slippage and fees
  const calculateTotalRequiredAmount = (baseAmount: number): number => {
    if (!baseAmount || baseAmount <= 0) return 0;
    
    // Calculate slippage buffer (DEFAULT_SLIPPAGE% of the base amount)
    const slippageBuffer = baseAmount * (DEFAULT_SLIPPAGE / 100);
    
    // Add additional buffer for exchange rate fluctuations
    const rateFluctuationBuffer = baseAmount * (BUFFER_PERCENTAGE / 100);
    
    // Calculate total with all buffers and gas fee
    const total = baseAmount + slippageBuffer + rateFluctuationBuffer + ESTIMATED_GAS_FEE;
    
    return total;
  };

  // New function to calculate the deposit amount including all necessary buffers
  const getRequiredDepositAmount = (): number => {
    const baseAmount = getSecurityDepositInSui();
    return calculateTotalRequiredAmount(baseAmount);
  };

  // New function to calculate the contribution amount including all necessary buffers
  const getRequiredContributionAmount = (): number => {
    const baseAmount = getValidContributionAmount();
    return calculateTotalRequiredAmount(baseAmount);
  };

  // Helper function to show the breakdown of a calculation
  const getAmountBreakdown = (baseAmount: number): { 
    baseAmount: number;
    slippageBuffer: number;
    rateBuffer: number;
    gasFee: number;
    total: number;
  } => {
    const slippageBuffer = baseAmount * (DEFAULT_SLIPPAGE / 100);
    const rateBuffer = baseAmount * (BUFFER_PERCENTAGE / 100);
    
    return {
      baseAmount,
      slippageBuffer,
      rateBuffer,
      gasFee: ESTIMATED_GAS_FEE,
      total: baseAmount + slippageBuffer + rateBuffer + ESTIMATED_GAS_FEE
    };
  };

  const handlePaySecurityDeposit = async () => {
    if (!circle || !userAddress || !circle.walletId) {
      toast.error('Circle information incomplete. Cannot process deposit.');
      return;
    }
    
    // Use the calculated amount that includes slippage and fees
    const requiredAmount = getRequiredDepositAmount();
    
    // Check if wallet balance is sufficient for the total required amount
    if (userBalance !== null && userBalance < requiredAmount) {
      toast.error('Insufficient wallet balance to pay security deposit.');
      return;
    }
    
    setIsPayingDeposit(true);
    
    try {
      console.log('Preparing to pay security deposit:', {
        baseAmount: getSecurityDepositInSui(),
        requiredAmount,
        breakdown: getAmountBreakdown(getSecurityDepositInSui())
      });
      
      if (!account) {
        toast.error('User account not available. Please log in again.');
        setIsPayingDeposit(false);
        return;
      }
      
      toast.loading('Processing security deposit payment...', { id: 'pay-security-deposit' });
      
      // Use the original security deposit amount for the actual transaction
      // as the contract expects the exact amount, buffers are just for checking sufficient balance
      const depositAmount = getSecurityDepositInSui();
      
      // Execute the transaction through the API
      const response = await fetch('/api/zkLogin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'paySecurityDeposit',
          account,
          circleId: circle.id,
          walletId: circle.walletId,
          depositAmount: Math.floor(depositAmount * 1e9)
        }),
      });
      
      const responseData = await response.json();
      
      if (!response.ok) {
        console.error('Security deposit payment failed:', responseData);
        toast.error(responseData.error || 'Failed to process security deposit payment', { id: 'pay-security-deposit' });
      } else {
        toast.success('Security deposit paid successfully!', { id: 'pay-security-deposit' });
        // Refresh user's wallet info and circle data
        fetchUserWalletInfo();
        fetchCircleDetails();
      }
    } catch (error) {
      console.error('Error paying security deposit:', error);
      toast.error('Failed to process security deposit payment');
    } finally {
      setIsPayingDeposit(false);
    }
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

  // Helper function to get valid contribution amount
  const getValidContributionAmount = (): number => {
    // Make sure we have a valid, reasonable number
    const contributionAmount = typeof circle?.contributionAmount === 'number' && !isNaN(circle.contributionAmount)
      ? circle.contributionAmount : 0;
    
    // Validate the amount is reasonable (not millions)
    const isValidAmount = contributionAmount > 0 && contributionAmount < 1000;
    
    // If amount seems incorrect but we have USD value, calculate from USD
    if (!isValidAmount && circle?.contributionAmountUsd && 
        typeof circle.contributionAmountUsd === 'number' && 
        !isNaN(circle.contributionAmountUsd) && 
        typeof suiPrice === 'number' && 
        suiPrice > 0) {
      return circle.contributionAmountUsd / suiPrice;
    }
    
    // Return the original amount if it's valid, or 0 as a safe default
    return isValidAmount ? contributionAmount : 0;
  };

  // Currency display component
  const CurrencyDisplay = ({ usd, sui, className = '' }: { usd?: number, sui?: number, className?: string }) => {
    const isPriceUnavailable = suiPrice === null;
    const isPriceStale = priceService.getFetchStatus() === 'error';
    
    console.log('CurrencyDisplay inputs:', { usd, sui, suiPrice, isPriceUnavailable });
    
    // Check for invalid inputs and provide defaults
    if ((usd === undefined || isNaN(usd)) && (sui === undefined || isNaN(sui))) {
      console.log('CurrencyDisplay: both usd and sui values are invalid, defaulting to 0');
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
      console.log('CurrencyDisplay: using USD value to calculate SUI:', { 
        usd: calculatedUsd, 
        sui: calculatedSui,
        suiPrice 
      });
    } else if (sui !== undefined && !isNaN(sui)) {
      // If SUI is provided and valid, calculate USD
      calculatedSui = sui;
      calculatedUsd = suiPrice !== null ? sui * suiPrice : null;
      console.log('CurrencyDisplay: using SUI value to calculate SUI:', { 
        sui: calculatedSui, 
        usd: calculatedUsd,
        suiPrice 
      });
    } else {
      // Default values if neither is provided or values are invalid
      calculatedSui = 0;
      calculatedUsd = 0;
      console.log('CurrencyDisplay: using default values:', { 
        sui: calculatedSui, 
        usd: calculatedUsd 
      });
    }
    
    // Format SUI with appropriate precision if available
    const formattedSui = calculatedSui !== null ? (
      calculatedSui >= 1000 
        ? calculatedSui.toLocaleString(undefined, { maximumFractionDigits: 0 }) 
        : calculatedSui >= 100 
          ? calculatedSui.toFixed(1) 
          : calculatedSui.toFixed(2)
    ) : '—';
    
    // Check if the component is being used inline
    const isInline = className.includes('inline');
    
    if (isInline) {
      return (
        <span className={className}>
          {calculatedUsd !== null ? formatUSD(calculatedUsd) : '$—.—'} ({formattedSui} SUI)
          {isPriceStale && <span title="Using cached price" className="text-xs text-amber-500 ml-1">⚠️</span>}
        </span>
      );
    }
    
    return (
      <Tooltip.Provider>
        <Tooltip.Root>
          <Tooltip.Trigger asChild>
            <div className={`flex flex-col ${className} cursor-help`}>
              <span className="font-medium">{calculatedUsd !== null ? formatUSD(calculatedUsd) : '$—.—'}</span>
              <span className="text-sm text-gray-500">{formattedSui} SUI</span>
              {isPriceStale && <span title="Using cached price" className="text-xs text-amber-500">⚠️ Cached price</span>}
            </div>
          </Tooltip.Trigger>
          <Tooltip.Portal>
            <Tooltip.Content
              className="bg-gray-900 text-white px-3 py-2 rounded text-sm"
              sideOffset={5}
            >
              <div className="space-y-1">
                <p>SUI Conversion Rate:</p>
                {suiPrice !== null ? (
                  <p>1 SUI = {formatUSD(suiPrice)}</p>
                ) : (
                  <p className="text-amber-400">SUI price unavailable</p>
                )}
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

  // Add function to fetch custody wallet stablecoin balance
  const fetchCustodyWalletBalance = async () => {
    if (!circle || !circle.walletId) return;
    
    setLoadingStablecoinBalance(true);
    let toastId;
    const wasManualRefresh = !isInitialBalanceLoad;
    
    // Only show loading toast if this was triggered by a user clicking refresh (not initial load)
    if (wasManualRefresh) {
      toastId = toast.loading('Refreshing USDC balance...'); 
    }
    
    // Update initial load state for future refreshes
    setIsInitialBalanceLoad(false);
    
    try {
      const client = new SuiClient({ url: 'https://fullnode.testnet.sui.io:443' });
      const previousBalance = custodyStablecoinBalance;
      let newBalance = null;
      let newSecurityDepositBalance = 0;
      let newContributionBalance = 0;
      
      // First get total balance from StablecoinDeposited events
      const stablecoinEvents = await client.queryEvents({
        query: {
          MoveEventType: `${PACKAGE_ID}::njangi_circles::StablecoinDeposited`
        },
        limit: 10
      });
      
      // Find the most recent event for this wallet to get total balance
      for (const event of stablecoinEvents.data) {
        if (event.parsedJson && 
            typeof event.parsedJson === 'object' &&
            'wallet_id' in event.parsedJson &&
            event.parsedJson.wallet_id === circle.walletId &&
            'new_balance' in event.parsedJson) {
          const balanceInMicroUnits = Number(event.parsedJson.new_balance);
          const balanceInDollars = balanceInMicroUnits / 1e6; // Convert from micro units to dollars
          setCustodyStablecoinBalance(balanceInDollars);
          newBalance = balanceInDollars;
          console.log('Custody stablecoin balance:', balanceInDollars, 'USDC');
          break;
        }
      }
      
      // Now query different event types to categorize funds
      // 1. Get security deposit events - check both event types
      
      // First check SecurityDepositReceived events (older version)
      const securityDepositEvents = await client.queryEvents({
        query: {
          MoveEventType: `${PACKAGE_ID}::njangi_circles::SecurityDepositReceived`
        },
        limit: 50
      });
      
      // Then check CustodyDeposited events (newer version)
      const custodyDepositEvents = await client.queryEvents({
        query: {
          MoveEventType: `${PACKAGE_ID}::njangi_circles::CustodyDeposited`
        },
        limit: 50
      });
      
      // Calculate security deposit balance from SecurityDepositReceived events
      console.log('Processing SecurityDepositReceived events:', securityDepositEvents.data);
      for (const event of securityDepositEvents.data) {
        if (event.parsedJson && 
            typeof event.parsedJson === 'object' &&
            'circle_id' in event.parsedJson &&
            event.parsedJson.circle_id === circle.id &&
            'amount' in event.parsedJson) {
          const depositAmount = Number(event.parsedJson.amount) / 1e6; // Convert from micro units
          newSecurityDepositBalance += depositAmount;
          console.log('Found SecurityDepositReceived event for this circle:', {
            circleId: event.parsedJson.circle_id,
            amount: depositAmount,
            runningTotal: newSecurityDepositBalance
          });
        }
      }
      
      // Calculate security deposit balance from CustodyDeposited events
      console.log('Processing CustodyDeposited events:', custodyDepositEvents.data);
      for (const event of custodyDepositEvents.data) {
        if (event.parsedJson && 
            typeof event.parsedJson === 'object' &&
            'circle_id' in event.parsedJson &&
            event.parsedJson.circle_id === circle.id &&
            'amount' in event.parsedJson &&
            'operation_type' in event.parsedJson) {
          console.log('Found CustodyDeposited event for this circle:', {
            circleId: event.parsedJson.circle_id,
            amount: Number(event.parsedJson.amount) / 1e6,
            operationType: event.parsedJson.operation_type
          });
          
          // Operation type 3 indicates security deposit
          // Check for both string "3" and number 3 since JSON parsing may vary
          if (event.parsedJson.operation_type === 3 || 
              event.parsedJson.operation_type === "3" || 
              Number(event.parsedJson.operation_type) === 3) {
            const depositAmount = Number(event.parsedJson.amount) / 1e6; // Convert from micro units
            newSecurityDepositBalance += depositAmount;
            console.log('Added to security deposit balance, new total:', newSecurityDepositBalance);
          }
        }
      }
      
      // 2. Get security deposit withdrawal events
      const depositWithdrawEvents = await client.queryEvents({
        query: {
          MoveEventType: `${PACKAGE_ID}::njangi_circles::SecurityDepositWithdrawn`
        },
        limit: 50
      });
      
      // Subtract withdrawn deposits
      for (const event of depositWithdrawEvents.data) {
        if (event.parsedJson && 
            typeof event.parsedJson === 'object' &&
            'circle_id' in event.parsedJson &&
            event.parsedJson.circle_id === circle.id &&
            'amount' in event.parsedJson) {
          const withdrawAmount = Number(event.parsedJson.amount) / 1e6; // Convert from micro units
          newSecurityDepositBalance -= withdrawAmount;
        }
      }
      
      // Ensure security deposit balance is not negative
      newSecurityDepositBalance = Math.max(0, newSecurityDepositBalance);
      
      // Calculate contribution balance (total minus security deposits)
      if (newBalance !== null) {
        newContributionBalance = Math.max(0, newBalance - newSecurityDepositBalance);
      }
      
      // Set the separated balances
      setSecurityDepositBalance(newSecurityDepositBalance);
      setContributionBalance(newContributionBalance);
      
      console.log('Custody balances breakdown:', {
        total: newBalance,
        securityDeposits: newSecurityDepositBalance,
        contributionFunds: newContributionBalance
      });
      
      // If we didn't find any events, try checking dynamic fields
      if (newBalance === null) {
        const dynamicFields = await client.getDynamicFields({
          parentId: circle.walletId
        });
        
        for (const field of dynamicFields.data) {
          if (field.name && typeof field.name === 'object' && 'type' in field.name) {
            if (field.name.value === 'coin_objects') {
              // Found the coin objects field but can't determine breakdown
              setCustodyStablecoinBalance(0);
              setSecurityDepositBalance(0);
              setContributionBalance(0);
              newBalance = 0;
              console.log('Found coin_objects field but could not determine balance');
              break;
            }
          }
        }
      }
      
      // Show success message if this was a manual refresh
      if (wasManualRefresh && toastId) {
        if (newBalance !== null) {
          if (previousBalance !== newBalance) {
            toast.success(`Balance updated: $${newBalance.toFixed(2)} USDC`, { id: toastId });
            
            // If there was a security deposit transaction, show a specific message
            if (newSecurityDepositBalance > 0) {
              // Use a new toast ID to avoid conflicting with the first toast
              toast.success(`Security deposit detected: $${newSecurityDepositBalance.toFixed(2)} USDC`, { 
                id: 'security-deposit-toast',
                duration: 5000
              });
            }
          } else {
            toast.success('Balance refreshed', { id: toastId });
          }
        } else {
          toast.success('Balance check completed', { id: toastId });
        }
      }
    } catch (error) {
      console.error('Error fetching custody wallet stablecoin balance:', error);
      if (wasManualRefresh && toastId) {
        toast.error('Failed to fetch balance', { id: toastId });
      }
    } finally {
      setLoadingStablecoinBalance(false);
    }
  };

  // New function to handle direct USDC deposit
  const handleDirectUsdcDeposit = async () => {
    if (!circle || !userAddress || !userUsdcBalance) return;
    
    setDirectDepositProcessing(true);
    
    try {
      const toastId = toast.loading('Processing direct USDC deposit...');
      
      // Determine amount and type based on whether security deposit is already paid
      const isSecurityDeposit = !userDepositPaid;
      const requiredAmount = isSecurityDeposit ? circle.securityDepositUsd : circle.contributionAmountUsd;
      
      if (userUsdcBalance < requiredAmount) {
        toast.error(`Insufficient USDC balance. Need ${requiredAmount.toFixed(2)} USDC but you have ${userUsdcBalance.toFixed(2)} USDC.`, { id: toastId });
        setDirectDepositProcessing(false);
        return;
      }
      
      if (!account) {
        toast.error('User account not available. Please log in again.', { id: toastId });
        setDirectDepositProcessing(false);
        return;
      }
      
      console.log('Processing direct USDC deposit with parameters:', {
        circleId: circle.id,
        walletId: circle.walletId,
        usdcAmount: requiredAmount,
        isSecurityDeposit
      });
      
      // Call API to transfer USDC directly
      const response = await fetch('/api/zkLogin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'depositUsdcDirect',
          account,
          circleId: circle.id,
          walletId: circle.walletId,
          usdcAmount: Math.floor(requiredAmount * 1e6), // Convert to micro USDC (6 decimals)
          isSecurityDeposit
        }),
      });
      
      const responseData = await response.json();
      
      if (!response.ok) {
        console.error('Direct USDC deposit failed:', responseData);
        toast.error(responseData.error || 'Failed to process USDC deposit', { id: toastId });
        return;
      }
      
      // Success message
      if (isSecurityDeposit) {
        toast.success('Security deposit paid successfully with your USDC!', { id: toastId });
      } else {
        toast.success('Contribution made successfully with your USDC!', { id: toastId });
      }
      
      console.log('Direct USDC deposit transaction digest:', responseData.digest);
      
      // Refresh user wallet info, circle data, and custody wallet balance
      fetchUserWalletInfo();
      fetchCircleDetails();
      fetchCustodyWalletBalance();
      
    } catch (error) {
      console.error('Error in direct USDC deposit:', error);
      toast.error('Failed to process USDC deposit');
    } finally {
      setDirectDepositProcessing(false);
    }
  };

  // Modify the renderContributionOptions function
  const renderContributionOptions = () => {
    return (
      <div className="pt-6 border-t border-gray-200 px-2">
        <h3 className="text-lg font-medium text-gray-900 mb-4 border-l-4 border-blue-500 pl-3">Make Contribution</h3>
        
        {/* Show auto swap enabled notice if applicable */}
        {circle?.autoSwapEnabled && (
          <div className="mb-4 p-3 bg-blue-50 rounded border border-blue-200">
            <p className="text-sm text-blue-700">
              <strong>Auto-swap enabled:</strong> Your SUI contribution will automatically be swapped to USDC.
            </p>
          </div>
        )}

        {/* Show direct USDC deposit option if user has sufficient USDC balance */}
        {showDirectDepositOption && userUsdcBalance !== null && (
          <div className="mb-4 p-4 bg-emerald-50 rounded-lg border-2 border-emerald-200">
            <div className="flex items-start space-x-3">
              <div className="bg-emerald-100 p-1.5 rounded-full flex-shrink-0 mt-0.5">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <div className="flex-1">
                <h4 className="font-medium text-emerald-800">Use USDC from your wallet</h4>
                <p className="text-sm text-emerald-700 mt-1">
                  You have <span className="font-medium">${userUsdcBalance.toFixed(2)} USDC</span> in your wallet.
                  You can directly deposit {!userDepositPaid ? 'security deposit' : 'contribution'} without swapping SUI.
                </p>
                <div className="mt-3">
                  <button
                    onClick={handleDirectUsdcDeposit}
                    disabled={directDepositProcessing}
                    className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium rounded-md shadow-sm transition-colors disabled:opacity-70 disabled:cursor-not-allowed"
                  >
                    {directDepositProcessing ? (
                      <span className="flex items-center">
                        <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                        </svg>
                        Processing...
                      </span>
                    ) : !userDepositPaid ? (
                      `Deposit ${circle?.securityDepositUsd?.toFixed(2)} USDC as Security Deposit`
                    ) : (
                      `Contribute ${circle?.contributionAmountUsd?.toFixed(2)} USDC Directly`
                    )}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Show the appropriate form based on auto-swap setting */}
        {circle?.autoSwapEnabled ? (
          <SimplifiedSwapUI
            walletId={circle?.walletId || ''}
            circleId={circle?.id || ''}
            contributionAmount={getValidContributionAmount()}
            securityDepositPaid={userDepositPaid}
            securityDepositAmount={getSecurityDepositInSui()}
            onComplete={() => {
              fetchUserWalletInfo();
              fetchCircleDetails();
            }}
          />
        ) : (
          <div className="bg-gray-50 p-6 rounded-lg shadow-sm">
            <div className="mb-6">
              <p className="text-sm text-gray-600 mb-2">You are about to contribute:</p>
              <div className="flex items-center">
                <span className="bg-blue-100 text-blue-800 text-xl font-semibold rounded-lg py-2 px-4">
                  ${circle?.contributionAmountUsd?.toFixed(2) || '0.00'} ({getValidContributionAmount().toFixed(4)} SUI)
                </span>
              </div>
            </div>

            {/* Debug the balance comparison by logging values */}
            {userDepositPaid && userBalance !== null && (
              <script dangerouslySetInnerHTML={{
                __html: `
                  console.log("Balance check:", {
                    userBalance: ${userBalance},
                    contributionAmount: ${circle?.contributionAmount},
                    hasEnough: ${userBalance >= (circle?.contributionAmount || 0)},
                    difference: ${userBalance - (circle?.contributionAmount || 0)}
                  });
                `
              }} />
            )}

            {/* Show warning if balance is insufficient - only when deposit is already paid */}
            {(() => {
              // Skip if deposit not paid or balance not loaded
              if (!userDepositPaid || userBalance === null) return null;
              
              // Get required contribution amount with buffer
              const requiredAmount = getRequiredContributionAmount();
              
              // Only show warning if balance is insufficient
              if (userBalance >= requiredAmount) return null;
              
              return (
                <div className="mb-4 p-3 bg-red-50 text-red-700 rounded-lg border border-red-200">
                  <p className="text-sm font-medium">
                    ⚠️ Your wallet balance is insufficient for this contribution.
                  </p>
                  <p className="text-xs mt-1">
                    Required base amount: {getValidContributionAmount().toFixed(4)} SUI<br/>
                    With slippage & fees: {requiredAmount.toFixed(4)} SUI<br/>
                    Available: {userBalance.toFixed(4)} SUI
                  </p>
                </div>
              );
            })()}

            {/* Show detailed breakdown of contribution amount if deposit is paid */}
            {userDepositPaid && circle && getValidContributionAmount() > 0 && (
              <div className="mb-4 p-3 bg-blue-50 rounded-lg border border-blue-200">
                <p className="text-sm font-medium text-blue-800">
                  Estimated amount needed for contribution:
                </p>
                <div className="text-blue-700 text-xs space-y-1 mt-2">
                  <p>Base contribution: {getValidContributionAmount().toFixed(4)} SUI</p>
                  <p>+ Slippage ({DEFAULT_SLIPPAGE}%): {(getValidContributionAmount() * DEFAULT_SLIPPAGE / 100).toFixed(4)} SUI</p>
                  <p>+ Rate buffer ({BUFFER_PERCENTAGE}%): {(getValidContributionAmount() * BUFFER_PERCENTAGE / 100).toFixed(4)} SUI</p>
                  <p>+ Network fee: {ESTIMATED_GAS_FEE.toFixed(6)} SUI</p>
                  <p className="font-semibold border-t border-blue-200 pt-1 mt-1">
                    Total required: {getRequiredContributionAmount().toFixed(4)} SUI
                  </p>
                </div>
              </div>
            )}

            {/* Show warning if security deposit is not paid */}
            {!userDepositPaid && (
              <div className="mb-4 p-4 bg-amber-50 rounded-lg border-2 border-amber-300">
                <div className="flex flex-col gap-4">
                  <div>
                    <p className="text-base font-medium text-amber-700 mb-1">
                      ⚠️ Security deposit required
                    </p>
                    <p className="text-sm text-amber-600">
                      You need to pay a security deposit of{' '}
                      {(!circle || isNaN(circle.securityDeposit) || circle.securityDeposit <= 0) ? (
                        'amount unavailable'
                      ) : (
                        <span className="font-semibold">
                          <CurrencyDisplay usd={circle.securityDepositUsd} className="inline" />
                        </span>
                      )}{' '}
                      before contributing.
                    </p>
                  </div>
                  
                  {/* Show the required amount including slippage and fees */}
                  {userBalance !== null && circle && circle.securityDeposit > 0 && (
                    <div className="bg-blue-50 p-2 rounded border border-blue-100 text-sm">
                      <p className="font-medium text-blue-800">Estimated amount needed:</p>
                      <div className="text-blue-700 text-xs space-y-1 mt-1">
                        <p>Base deposit: {getSecurityDepositInSui().toFixed(4)} SUI</p>
                        <p>+ Slippage ({DEFAULT_SLIPPAGE}%): {(getSecurityDepositInSui() * DEFAULT_SLIPPAGE / 100).toFixed(4)} SUI</p>
                        <p>+ Rate buffer ({BUFFER_PERCENTAGE}%): {(getSecurityDepositInSui() * BUFFER_PERCENTAGE / 100).toFixed(4)} SUI</p>
                        <p>+ Network fee: {ESTIMATED_GAS_FEE.toFixed(6)} SUI</p>
                        <p className="font-semibold border-t border-blue-200 pt-1 mt-1">
                          Total required: {getRequiredDepositAmount().toFixed(4)} SUI
                        </p>
                      </div>
                    </div>
                  )}
                  
                  {/* Show combined insufficient balance warning for both security deposit and contribution */}
                  {userBalance !== null && circle && userBalance < getRequiredDepositAmount() && (
                    <div className="p-2 bg-red-50 text-red-700 rounded border border-red-200 text-sm">
                      <p className="font-medium">Insufficient funds for security deposit</p>
                      <p className="text-xs mt-1">
                        You need {getRequiredDepositAmount().toFixed(4)} SUI for the security deposit (including slippage & fees), but your balance is only {userBalance.toFixed(4)} SUI.
                      </p>
                    </div>
                  )}
                  
                  <button
                    onClick={handlePaySecurityDeposit}
                    disabled={isPayingDeposit || !circle || circle.securityDepositUsd <= 0 || (userBalance !== null && userBalance < getRequiredDepositAmount())}
                    className="w-full py-3 px-4 rounded-lg shadow-sm text-sm font-bold text-white bg-amber-500 hover:bg-amber-600 transition-all disabled:opacity-70 disabled:cursor-not-allowed"
                  >
                    {isPayingDeposit ? (
                      <span className="flex items-center justify-center">
                        <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                        </svg>
                        Processing...
                      </span>
                    ) : (
                      'Pay Security Deposit'
                    )}
                  </button>
                  
                  {/* Add note about payment sequence */}
                  <p className="text-xs text-gray-600">
                    Note: You must pay the security deposit before you can make contributions.
                    The deposit is refundable if you decide to leave the circle later.
                  </p>
                </div>
              </div>
            )}

            {/* Add contribution source indicator */}
            {userDepositPaid && (
              <div className="mb-4 p-3 rounded-lg border">
                {userDepositPaid && contributionBalance !== null && circle?.contributionAmountUsd !== undefined && contributionBalance >= circle.contributionAmountUsd ? (
                  <div className="bg-green-50 border-green-200 p-3 rounded-lg flex items-start">
                    <div className="bg-green-100 rounded-full p-1 mr-3 mt-0.5">
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-green-600" viewBox="0 0 20 20" fill="currentColor">
                        <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                      </svg>
                    </div>
                    <div>
                      <p className="text-sm font-medium text-green-800">USDC available for contribution</p>
                      <p className="text-xs text-green-700 mt-1">
                        Your contribution will use ${contributionBalance.toFixed(2)} USDC from the contribution funds in the custody wallet.
                        No SUI will be taken from your wallet for this contribution.
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="bg-blue-50 border-blue-200 p-3 rounded-lg flex items-start">
                    <div className="bg-blue-100 rounded-full p-1 mr-3 mt-0.5">
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-blue-600" viewBox="0 0 20 20" fill="currentColor">
                        <path fillRule="evenodd" d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4zm2 6a1 1 0 011-1h6a1 1 0 110 2H7a1 1 0 01-1-1zm1 3a1 1 0 100 2h6a1 1 0 100-2H7z" clipRule="evenodd" />
                      </svg>
                    </div>
                    <div>
                      <p className="text-sm font-medium text-blue-800">Using SUI for contribution</p>
                      <p className="text-xs text-blue-700 mt-1">
                        This contribution will require {getValidContributionAmount().toFixed(4)} SUI from your wallet.
                        {contributionBalance !== null && contributionBalance > 0 && (
                          <span> The custody wallet has ${contributionBalance.toFixed(2)} USDC available for contributions, but it&apos;s not enough for this contribution.</span>
                        )}
                      </p>
                    </div>
                  </div>
                )}
              </div>
            )}
          
            <button
              onClick={handleContribute}
              disabled={isProcessing || (userBalance !== null && userBalance < getRequiredContributionAmount()) || !userDepositPaid}
              className={`w-full flex justify-center py-3 px-4 rounded-lg shadow-sm text-sm font-medium text-white bg-gradient-to-r from-blue-600 to-blue-700 hover:from-blue-700 hover:to-blue-800 transition-all ${(isProcessing || (userBalance !== null && userBalance < getRequiredContributionAmount()) || !userDepositPaid) ? 'opacity-70 cursor-not-allowed' : ''}`}
            >
              {isProcessing ? 'Processing...' : 'Contribute Now'}
            </button>
            
            <p className="mt-3 text-xs text-center text-gray-500">
              By contributing, you agree to the circle&apos;s terms and conditions.
            </p>
          </div>
        )}
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
              <h2 className="text-2xl font-bold text-gray-900 mb-6">
                {!loading && circle ? `Contribute to ${circle.name}` : 'Contribute to Circle'}
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
                  {/* User Wallet Information */}
                  <div className="px-2">
                    <h3 className="text-lg font-medium text-gray-900 mb-4 border-l-4 border-green-500 pl-3">Your Wallet</h3>
                    <div className="bg-gradient-to-r from-blue-50 to-indigo-50 p-4 rounded-lg shadow-sm border border-blue-100">
                      <div className="flex justify-between items-center">
                        <div>
                          <p className="text-sm text-gray-600 mb-1">Available Balance:</p>
                          {fetchingBalance ? (
                            <div className="animate-pulse h-6 w-32 bg-gray-200 rounded"></div>
                          ) : (
                            <div className="text-lg font-semibold text-blue-700">
                              {userBalance !== null ? (
                                <CurrencyDisplay sui={userBalance} />
                              ) : (
                                'Unable to fetch balance'
                              )}
                            </div>
                          )}
                        </div>
                        <div className="text-right">
                          <p className="text-sm text-gray-600 mb-1">Wallet Address:</p>
                          <p className="text-sm font-mono bg-white px-2 py-1 rounded border border-gray-200">
                            {userAddress ? `${userAddress.substring(0, 6)}...${userAddress.substring(userAddress.length - 4)}` : ''}
                          </p>
                        </div>
                      </div>
                    </div>
                  </div>

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
                        <CurrencyDisplay usd={circle.contributionAmountUsd} sui={circle.contributionAmount} />
                      </div>

                      <div className="bg-gray-50 p-4 rounded-lg shadow-sm">
                        <p className="text-sm text-gray-500 mb-1">Security Deposit Required</p>
                        <CurrencyDisplay usd={circle.securityDepositUsd} sui={circle.securityDeposit} />
                      </div>

                      <div className="bg-gray-50 p-4 rounded-lg shadow-sm">
                        <p className="text-sm text-gray-500 mb-1">Security Deposit Status</p>
                        {fetchingBalance ? (
                          <div className="animate-pulse h-6 w-32 bg-gray-200 rounded"></div>
                        ) : (
                          <div className="flex items-center">
                            {userDepositPaid ? (
                              <>
                                <span className="h-4 w-4 rounded-full bg-green-500 mr-2"></span>
                                <span className="text-green-700 font-medium">Paid</span>
                              </>
                            ) : (
                              <>
                                <span className="h-4 w-4 rounded-full bg-amber-500 mr-2"></span>
                                <span className="text-amber-700 font-medium">Not Paid</span>
                              </>
                            )}
                          </div>
                        )}
                      </div>
                      
                      {/* Add Custody Wallet Stablecoin Balance */}
                      <div className="bg-gray-50 p-4 rounded-lg shadow-sm md:col-span-2">
                        <div className="flex justify-between items-center mb-1">
                          <p className="text-sm text-gray-500">Custody Wallet USDC Balance</p>
                          <button 
                            onClick={fetchCustodyWalletBalance}
                            disabled={loadingStablecoinBalance}
                            className="text-xs bg-indigo-50 hover:bg-indigo-100 text-indigo-600 py-1 px-2 rounded flex items-center transition-colors disabled:opacity-50"
                          >
                            {loadingStablecoinBalance ? (
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
                                Refresh
                              </span>
                            )}
                          </button>
                        </div>
                        {loadingStablecoinBalance ? (
                          <div className="animate-pulse h-6 w-32 bg-gray-200 rounded"></div>
                        ) : (
                          <div className="flex flex-col gap-2">
                            {/* Total Balance */}
                            <div className="flex items-center">
                              <span className="text-lg font-medium text-indigo-700">
                                {custodyStablecoinBalance !== null 
                                  ? `$${custodyStablecoinBalance.toFixed(2)} USDC`
                                  : "No balance data available"}
                              </span>
                              <span className="ml-2 px-2 py-1 bg-gray-100 text-gray-600 text-xs font-medium rounded-full">
                                Total Balance
                              </span>
                            </div>
                            
                            {/* Breakdown of Balances */}
                            {custodyStablecoinBalance !== null && custodyStablecoinBalance > 0 && (
                              <div className="mt-1 space-y-2 border-t border-gray-200 pt-2">
                                {/* Security Deposits */}
                                <div className="flex items-center">
                                  <div className="w-4 h-4 bg-amber-200 rounded-sm mr-2" title="Security deposits held in escrow"></div>
                                  <span className="text-sm text-gray-700">
                                    ${securityDepositBalance?.toFixed(2) || '0.00'} USDC
                                  </span>
                                  <span className="ml-2 px-2 py-0.5 bg-amber-100 text-amber-800 text-xs font-medium rounded-full" 
                                    title="These funds are security deposits from members and cannot be used for contributions">
                                    Security Deposits
                                  </span>
                                  {securityDepositBalance === 0 && (
                                    <span className="ml-2 px-2 py-0.5 bg-red-100 text-red-800 text-xs font-medium rounded-full">
                                      Not detected
                                    </span>
                                  )}
                                </div>
                                
                                {/* Contribution Funds */}
                                <div className="flex items-center">
                                  <div className="w-4 h-4 bg-green-200 rounded-sm mr-2" title="Funds available for automated contributions"></div>
                                  <span className="text-sm text-gray-700">
                                    ${contributionBalance?.toFixed(2) || '0.00'} USDC
                                  </span>
                                  <span className="ml-2 px-2 py-0.5 bg-green-100 text-green-800 text-xs font-medium rounded-full"
                                    title="These funds can be used for automated contributions to the circle">
                                    Available for Contributions
                                  </span>
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                        <p className="text-xs text-gray-500 mt-1">
                          This is the current USDC balance in the circle&apos;s custody wallet used for automated contributions.
                        </p>
                      </div>
                    </div>
                  </div>
                  
                  {renderContributionOptions()}
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