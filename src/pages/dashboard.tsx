/* eslint-disable */
import React, { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/router';
import { useAuth } from '../contexts/AuthContext';
import Image from 'next/image';
import { SuiClient } from '@mysten/sui/client';
import { Tab } from '@headlessui/react';
import * as Tooltip from '@radix-ui/react-tooltip';
import * as Dialog from '@radix-ui/react-dialog';
import { priceService } from '../services/price-service';
import { toast } from 'react-hot-toast';
import { Eye, Settings, Trash2, CreditCard, RefreshCw, Users, X, Copy, Link, AlertCircle, Send, Shield, Clock, CheckCircle, ExternalLink } from 'lucide-react';
import { PACKAGE_ID } from '../services/circle-service';
// Use alias path for the modal import
import ConfirmationModal from '@/components/ConfirmationModal';
import { Button } from '@chakra-ui/react';

// Circle type definition
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
  memberStatus: 'active' | 'suspended' | 'exited';
  isAdmin: boolean;
  isActive: boolean;
  walletId?: string; // Add optional wallet ID
}

// Type definitions for SUI event payloads
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

interface MemberJoinedEvent {
  circle_id: string;
  member: string;
  position?: number;
  // These fields may or may not be present in the event payload
  contribution_amount_usd?: string;
  security_deposit_usd?: string;
}

// Add these type definitions at the top of the file with other interfaces
interface TransactionBlock {
  transactions?: Array<{
    kind: string;
    target: string;
    arguments: Array<{
      kind: string;
      index: number;
      type: string;
      value: string;
    }>;
  }>;
  moveCall?: {
    packageObjectId: string;
    module: string;
    function: string;
    typeArguments: string[];
    arguments: string[];
  };
}

interface TransactionOptions {
  showEffects: boolean;
  showEvents: boolean;
}

interface TransactionBlockPayload {
  transactionBlock: TransactionBlock;
  options: TransactionOptions;
}

// Declare global wallet type - updated to include all possible wallet objects
declare global {
  interface Window {
    suiWallet?: {
      // Original API methods
      constructTransaction?: (txData: {
        kind: string;
        data: {
          packageObjectId: string;
          module: string;
          function: string;
          typeArguments: string[];
          arguments: string[];
          gasBudget: number;
        }
      }) => unknown;
      
      signAndExecuteTransaction?: (tx: {
        transaction: unknown;
      }) => Promise<Record<string, unknown>>;
      
      // New API methods
      signAndExecuteTransactionBlock?: (tx: TransactionBlockPayload) => Promise<Record<string, unknown>>;
      
      signTransactionBlock?: (tx: {
        transactionBlock: TransactionBlock;
        options?: {
          showEffects?: boolean;
          showEvents?: boolean;
        };
      }) => Promise<unknown>;
      
      // General connection methods that might be required
      hasPermissions?: () => Promise<boolean>;
      requestPermissions?: () => Promise<boolean>;
      getAccounts?: () => Promise<string[]>;
    };
    
    // Alternative wallet object names used by different SUI wallet versions
    sui?: typeof Window.prototype.suiWallet;
    suix?: typeof Window.prototype.suiWallet;
    ethos?: typeof Window.prototype.suiWallet;
    suiet?: typeof Window.prototype.suiWallet;
    martian?: typeof Window.prototype.suiWallet;
    MoonPayWebSdk?: {
      init: (config: {
        flow: string;
        environment: string;
        variant: string;
        params: {
          apiKey: string;
          currencyCode?: string;
          walletAddress?: string;
          baseCurrencyCode?: string;
          baseCurrencyAmount?: string;
          [key: string]: unknown;
        };
      }) => {
        show: () => void;
        close: () => void;
      };
    };
  }
}

// Update the TokenIcon component to use existing SVG files for SUI and USDC
const TokenIcon = ({ symbol }: { symbol: string }) => {
  // Define the path to each token icon
  const iconPath = (tokenSymbol: string): string => {
    const normalizedSymbol = tokenSymbol.toLowerCase();
    
    // Use existing SVG files for SUI and USDC
    if (normalizedSymbol === 'sui') {
      return '/images/sui-sui-logo.svg';
    }
    
    if (normalizedSymbol === 'usdc') {
      return '/images/usd-coin-usdc-logo.svg';
    }
    
    // For other tokens, use the assets/icons directory
    const supportedTokens = ['usdt', 'btc', 'eth'];
    if (supportedTokens.includes(normalizedSymbol)) {
      return `/assets/icons/${normalizedSymbol}.svg`;
    }
    
    // Return the unknown token icon for any unsupported token
    return '/assets/icons/unknown.svg';
  };
  
  return (
    <img 
      src={iconPath(symbol)}
      alt={`${symbol} icon`}
      className="w-5 h-5 mr-2"
      style={{ objectFit: 'contain' }}
      onError={(e) => {
        // Fallback if the image fails to load
        console.error(`Failed to load icon for ${symbol}`);
        (e.target as HTMLImageElement).src = '/assets/icons/unknown.svg';
      }}
    />
  );
};

// Define types for SUI object field values
type SuiValue = string | number | boolean | null | undefined | SuiValue[] | Record<string, unknown>;

// Define an interface for the object data structure
interface EnhancedObjectData {
  data?: {
    objectId?: string;
    content?: {
      fields: Record<string, SuiValue>;
      [key: string]: unknown;
    };
    dynamicFields?: Array<{
      name?: string;
      type?: string;
      objectId?: string;
      content?: {
        fields?: Record<string, SuiValue>;
      };
      value?: Record<string, SuiValue>;
    }>;
    [key: string]: unknown;
  };
  transactionInput?: {
    cycle_day?: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

// Define type for transaction input data
interface TransactionInputData {
  cycle_day?: number;
  [key: string]: unknown;
}

// Add transfer-related interfaces
interface TransferFormData {
  recipientAddress: string;
  amount: string;
  selectedToken: string;
  memo?: string;
}

interface TransferValidation {
  isValid: boolean;
  errors: {
    recipientAddress?: string;
    amount?: string;
    balance?: string;
    general?: string;
  };
  warnings: {
    highValue?: string;
    newAddress?: string;
    testnet?: string;
  };
}

interface RecentContact {
  address: string;
  name?: string;
  lastUsed: number;
  frequency: number;
}

export default function Dashboard() {
  const router = useRouter();
  const { isAuthenticated, userAddress, account, deleteCircle: authDeleteCircle } = useAuth();
  const [balance, setBalance] = useState<string>('0');
  const [allCoins, setAllCoins] = useState<{coinType: string, symbol: string, balance: string}[]>([]);
  const [showFullAddress, setShowFullAddress] = useState(false);
  const [showToast, setShowToast] = useState(false);
  const [circles, setCircles] = useState<Circle[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [suiPrice, setSuiPrice] = useState<number | null>(null);
  const [isPriceLoading, setIsPriceLoading] = useState(true);
  const [deleteableCircles, setDeleteableCircles] = useState<Set<string>>(new Set());
  const [isDeleting, setIsDeleting] = useState<string | null>(null);
  const [isJoinDialogOpen, setIsJoinDialogOpen] = useState(false);
  const [circleIdInput, setCircleIdInput] = useState('');
  const [copiedCircleId, setCopiedCircleId] = useState<string | null>(null);
  const [showTestnetBanner, setShowTestnetBanner] = useState(true);
  
  // Add MoonPay state for the current implementation
  const [moonpayWidget, setMoonpayWidget] = useState<{ show: () => void; close: () => void } | null>(null);

  // Keep the confirmation modal state
  const [isConfirmModalOpen, setIsConfirmModalOpen] = useState(false);
  const [confirmModalProps, setConfirmModalProps] = useState<{
    title: string;
    message: string | React.ReactNode;
    onConfirm: () => void;
    confirmText?: string;
    confirmButtonVariant?: 'primary' | 'danger' | 'warning';
  } | null>(null);

  // Add transfer-related state
  const [isTransferDialogOpen, setIsTransferDialogOpen] = useState(false);
  const [transferForm, setTransferForm] = useState<TransferFormData>({
    recipientAddress: '',
    amount: '',
    selectedToken: 'SUI',
    memo: ''
  });
  const [transferValidation, setTransferValidation] = useState<TransferValidation>({
    isValid: false,
    errors: {},
    warnings: {}
  });
  const [isTransferring, setIsTransferring] = useState(false);
  const [recentContacts, setRecentContacts] = useState<RecentContact[]>([]);
  const [showAdvancedOptions, setShowAdvancedOptions] = useState(false);
  const [transferStep, setTransferStep] = useState<'form' | 'review' | 'confirm' | 'success'>('form');
  const [transferResult, setTransferResult] = useState<{ digest?: string; error?: string } | null>(null);

  // Update the script loading in useEffect for MoonPay SDK
  useEffect(() => {
    // Load MoonPay SDK script
    const loadMoonPaySDK = () => {
      if (document.getElementById('moonpay-sdk')) {
        console.log('MoonPay SDK already loaded');
        return;
      }
      
      console.log('Loading MoonPay SDK...');
      const script = document.createElement('script');
      script.id = 'moonpay-sdk';
      script.src = 'https://sdk.moonpay.com/embed/moonpay-sdk.js';
      script.async = true;
      
      script.onload = () => {
        console.log('MoonPay SDK loaded successfully');
      };
      
      script.onerror = (error) => {
        console.error('Failed to load MoonPay SDK:', error);
      };
      
      document.body.appendChild(script);
      
      return () => {
        const scriptElement = document.getElementById('moonpay-sdk');
        if (scriptElement && document.body.contains(scriptElement)) {
          document.body.removeChild(scriptElement);
        }
      };
    };
    
    loadMoonPaySDK();
  }, []);

  // Update the openMoonPayWidget function with better debugging
  const openMoonPayWidget = (currencyCode: string = 'usdc') => {
    console.log("Buy button clicked", { currencyCode });
    if (typeof window === 'undefined') {
      console.log('Window undefined, cannot open widget');
      return;
    }
    
    console.log("MoonPay API Key:", process.env.NEXT_PUBLIC_MOONPAY_API_KEY);
    console.log("MoonPay SDK available:", !!window.MoonPayWebSdk);
    
    try {
      // Close any existing widget
      if (moonpayWidget) {
        moonpayWidget.close();
        setMoonpayWidget(null);
      }
      
      // Initialize the widget with new settings
      if (window.MoonPayWebSdk) {
        const sdk = window.MoonPayWebSdk.init({
          flow: "buy",
          environment: "sandbox", // Use 'production' for live environment
          variant: "overlay",
          params: {
            apiKey: process.env.NEXT_PUBLIC_MOONPAY_API_KEY || "", // Using API key from environment variables
            currencyCode: currencyCode,
            walletAddress: userAddress || undefined, // Use undefined instead of null
            baseCurrencyCode: "usd",
            baseCurrencyAmount: "50", // Default amount in USD
          }
        });
        
        // Store the widget reference
        setMoonpayWidget(sdk);
        
        // Open the widget
        sdk.show();
        console.log("MoonPay widget opened successfully");
      } else {
        console.error('MoonPay SDK not loaded, falling back to direct URL');
        openMoonPaySimple(currencyCode);
      }
    } catch (error) {
      console.error('Error initializing MoonPay widget:', error);
      toast.error('Failed to open MoonPay widget. Trying alternative method...');
      openMoonPaySimple(currencyCode);
    }
  };

  // Add a simpler implementation using direct URL
  const openMoonPaySimple = (currencyCode: string = 'usdc') => {
    console.log("Using simple MoonPay URL approach");
    const apiKey = process.env.NEXT_PUBLIC_MOONPAY_API_KEY;
    const baseUrl = 'https://buy-sandbox.moonpay.com'; // Use buy.moonpay.com for production
    const url = new URL(baseUrl);
    
    // Add params
    url.searchParams.append('apiKey', apiKey || '');
    url.searchParams.append('currencyCode', currencyCode);
    if (userAddress) {
      url.searchParams.append('walletAddress', userAddress);
    }
    
    const finalUrl = url.toString();
    console.log("Opening MoonPay URL:", finalUrl);
    
    // Open in new window
    window.open(finalUrl, '_blank');
    toast.success('MoonPay checkout opened in a new tab');
  };

  useEffect(() => {
    if (!isAuthenticated) {
      console.log("User not authenticated, redirecting to home");
      router.push('/');
    } else {
      console.log("User is authenticated:", userAddress);
    }
  }, [isAuthenticated, router]);

  useEffect(() => {
    const fetchBalance = async () => {
      if (userAddress) {
        const client = new SuiClient({ url: 'https://fullnode.testnet.sui.io:443' });
        
        // Fetch SUI balance for the primary balance display
        const suiBalance = await client.getBalance({
          owner: userAddress,
          coinType: '0x2::sui::SUI'
        });
        setBalance(suiBalance.totalBalance);
        
        // Fetch all coins
        try {
          const allCoinsData = await client.getAllCoins({
            owner: userAddress
          });
          
          // Create a map to aggregate coins by symbol
          const coinMap = new Map<string, {coinType: string, symbol: string, balance: string}>();
          
          // Process the coins
          allCoinsData.data.forEach(coin => {
            // Extract coin symbol from the type string (e.g., "0x2::sui::SUI" -> "SUI")
            const typeStr = coin.coinType;
            const typeMatch = typeStr.match(/::([^:]+)$/);
            const symbol = typeMatch ? typeMatch[1] : typeStr;
            
            // If this symbol already exists in our map, add to its balance
            if (coinMap.has(symbol)) {
              const existingCoin = coinMap.get(symbol)!;
              const newBalance = BigInt(existingCoin.balance) + BigInt(coin.balance);
              coinMap.set(symbol, {
                ...existingCoin,
                balance: newBalance.toString()
              });
            } else {
              // Otherwise, add it as a new entry
              coinMap.set(symbol, {
                coinType: coin.coinType,
                symbol: symbol,
                balance: coin.balance
              });
            }
          });
          
          // Convert the map back to an array
          const processedCoins = Array.from(coinMap.values());
          
          console.log('Aggregated coins by symbol:', processedCoins);
          setAllCoins(processedCoins);
        } catch (error) {
          console.error('Error fetching all coins:', error);
        }
      }
    };
    fetchBalance();
  }, [userAddress]);

  // Fetch SUI price - only on page load, no interval
  useEffect(() => {
    const fetchPrice = async () => {
      setIsPriceLoading(true);
      try {
        // Force a refresh of the price to get the latest data
        const price = await priceService.forceRefreshPrice();
        setSuiPrice(price);
        
        // Show error toast if price fetching failed
        if (priceService.getFetchStatus() === 'error') {
          toast.error(
            'Unable to fetch latest SUI price. Some values may not be displayed accurately.',
            {
              duration: 4000,
              position: 'bottom-center',
              icon: '⚠️',
              style: {
                border: '1px solid #F87171',
                padding: '16px',
                color: '#991B1B',
              },
            }
          );
        }
      } catch (error) {
        console.error('Error in price fetch flow:', error);
        setSuiPrice(null);
      } finally {
        setIsPriceLoading(false);
      }
    };

    fetchPrice();
  }, []);

  // Process circle data correctly after the contract restructuring
  const processCircleObject = async (objectData: EnhancedObjectData, userAddress: string, circleCreationData?: CircleCreatedEvent, client?: SuiClient) => {
    // Use optional chaining and nullish coalescing for safer access
    if (!objectData?.data?.content?.fields) { 
      console.warn('Invalid object data structure or missing fields', objectData);
      return null;
    }

    const fields = objectData.data.content.fields as Record<string, unknown>;
    console.log('Processing circle object fields:', fields);

    // Extract basic circle information safely
    const circleId = objectData.data.objectId ?? 'unknown-id'; // Provide fallback
    const name = (fields.name as string) ?? ''; // Type assertion with fallback
    const admin = (fields.admin as string) ?? ''; // Type assertion with fallback
    const currentMembers = Number(fields.current_members ?? 0); // Use nullish coalescing
    const nextPayoutTime = Number(fields.next_payout_time ?? 0); // Use nullish coalescing
    // Ensure boolean conversion is safe
    const isActive = fields.is_active === true || String(fields.is_active).toLowerCase() === 'true'; 
    
    // Initialize config values with default values
    const configValues = {
      contributionAmount: 0,
      contributionAmountUsd: 0,
      securityDeposit: 0,
      securityDepositUsd: 0,
      cycleLength: 0,
      cycleDay: 0,  // Default to day 0 (Monday)
      maxMembers: 3, // Default, will be overridden by config or event
    };

    // Extract from transaction inputs if available (check types safely)
    // Deprioritize creation event for max_members, as it can be updated
    if (circleCreationData) {
      console.log('Using creation event data for circle:', circleId);
      configValues.contributionAmount = Number(circleCreationData.contribution_amount ?? 0) / 1e9;
      configValues.contributionAmountUsd = Number(circleCreationData.contribution_amount_usd ?? 0) / 100;
      configValues.securityDepositUsd = Number(circleCreationData.security_deposit_usd ?? 0) / 100;
      configValues.cycleLength = Number(circleCreationData.cycle_length ?? 0);
      // DO NOT set maxMembers from creation event here, prioritize dynamic field
    }

    // Next, try to extract values from dynamic fields safely
    const dynamicFields = objectData.data.dynamicFields || [];
    console.log('Dynamic fields for circle:', dynamicFields);

    // Find the CircleConfig field first
    const circleConfigField = dynamicFields.find(field => 
      field && typeof field === 'object' && 
      (('objectType' in field && typeof field.objectType === 'string' && 
        field.objectType.includes('::njangi_circle_config::CircleConfig')) ||
       ('type' in field && typeof field.type === 'string' && 
        field.type.includes('::njangi_circle_config::CircleConfig')))
    );

    // If we found a CircleConfig field, fetch its details using its objectId
    if (circleConfigField && client) {
      console.log('Found CircleConfig field:', circleConfigField);
      
      // Extract the objectId to fetch the complete CircleConfig object
      const configObjectId = circleConfigField.objectId;
      if (configObjectId && typeof configObjectId === 'string') {
        try {
          console.log(`Fetching complete CircleConfig object with ID: ${configObjectId}`);
          
          // Fetch the complete CircleConfig object
          const configObjectResponse = await client.getObject({
            id: configObjectId,
            options: { 
              showContent: true,
              showDisplay: false,
              showType: true
            }
          });
          
          if (configObjectResponse.data && configObjectResponse.data.content) {
            console.log('Fetched CircleConfig object:', configObjectResponse.data);
            
            // Access the fields in the fetched object
            if ('fields' in configObjectResponse.data.content) {
              const contentFields = configObjectResponse.data.content.fields;
              console.log('CircleConfig content fields:', contentFields);
              
              // Now try to access the value.fields path
              if (contentFields && typeof contentFields === 'object' && 'value' in contentFields) {
                const valueObj = contentFields.value as Record<string, unknown>;
                
                if (valueObj && typeof valueObj === 'object' && 'fields' in valueObj) {
                  const configFields = valueObj.fields as Record<string, unknown>;
                  console.log('CircleConfig nested fields:', configFields);
                  
                  // Extract max_members value
                  if ('max_members' in configFields) {
                    configValues.maxMembers = Number(configFields.max_members);
                    console.log('Successfully extracted max_members from fetched object:', configValues.maxMembers);
                  }
                  
                  // Extract other config values
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
                    console.log('Found cycle_day in fetched object:', configValues.cycleDay);
                  }
                }
              }
            }
          }
        } catch (error) {
          console.error(`Error fetching CircleConfig object with ID ${configObjectId}:`, error);
        }
      }
    }
    
    // Direct field access with safe checks and type assertions (as fallbacks)
    configValues.contributionAmount = Number(fields.contribution_amount ?? configValues.contributionAmount * 1e9) / 1e9;
    configValues.securityDeposit = Number(fields.security_deposit ?? configValues.securityDeposit * 1e9) / 1e9;
    configValues.contributionAmountUsd = Number(fields.contribution_amount_usd ?? configValues.contributionAmountUsd * 100) / 100;
    configValues.securityDepositUsd = Number(fields.security_deposit_usd ?? configValues.securityDepositUsd * 100) / 100;
    configValues.cycleLength = Number(fields.cycle_length ?? configValues.cycleLength);
    // Only update cycleDay from direct field if it wasn't found elsewhere
    if (configValues.cycleDay === 0 && fields.cycle_day !== undefined) { 
        configValues.cycleDay = Number(fields.cycle_day ?? 0); 
        console.log('Found cycle_day in direct fields:', configValues.cycleDay);
    }
    // Ensure maxMembers is not overwritten by direct field if already set from config
    if (configValues.maxMembers === 3 && fields.max_members !== undefined) { // Check if it's still the default
        configValues.maxMembers = Number(fields.max_members ?? configValues.maxMembers);
        console.log('Updated maxMembers from direct field as fallback:', configValues.maxMembers);
    }
    // If CircleCreatedEvent had a value and dynamic field didn't, use it as a last resort (should be rare)
    else if (circleCreationData && circleCreationData.max_members && configValues.maxMembers === 3) {
        configValues.maxMembers = Number(circleCreationData.max_members);
        console.log('Updated maxMembers from CircleCreatedEvent as last resort:', configValues.maxMembers);
    }

    console.log('Final config values for circle:', circleId, configValues);
    
    // Ensure circleId is a string before returning
    const finalCircleId = typeof circleId === 'string' ? circleId : 'invalid-id';

    return {
      id: finalCircleId, // Use validated ID
      name: name,
      admin: admin,
      contributionAmount: configValues.contributionAmount,
      contributionAmountUsd: configValues.contributionAmountUsd,
      securityDeposit: configValues.securityDeposit,
      securityDepositUsd: configValues.securityDepositUsd,
      cycleLength: configValues.cycleLength,
      cycleDay: configValues.cycleDay,
      maxMembers: configValues.maxMembers,
      currentMembers: currentMembers,
      nextPayoutTime: nextPayoutTime,
      memberStatus: 'active' as const,
      isAdmin: admin === userAddress,
      isActive: isActive
    };
  };

  // Update fetchUserCircles to handle potential undefined IDs
  const fetchUserCircles = useCallback(async () => {
    console.log('fetchUserCircles starting...');
    
    if (!userAddress) {
      console.log('No user address, skipping fetch');
      return;
    }
    
    console.log('Fetching circles for user:', userAddress);
    
    setLoading(true);
    setError('');
    
    try {
      // Create the Sui client
      const client = new SuiClient({
        url: 'https://fullnode.testnet.sui.io:443'
      });
      
      // Log package ID for debugging
      console.log('Using package ID:', PACKAGE_ID);
      
      // Get Circle Created events for admin of circles
      const circleEvents = await client.queryEvents({
        query: {
          MoveEventType: `${PACKAGE_ID}::njangi_circles::CircleCreated`
        },
        limit: 100
      });
      
      // Get Member Joined events
      const memberEvents = await client.queryEvents({
        query: {
          MoveEventType: `${PACKAGE_ID}::njangi_circles::MemberJoined`
        },
        limit: 100
      });
      
      // Get circle activation events
      const activationEvents = await client.queryEvents({
        query: {
          MoveEventType: `${PACKAGE_ID}::njangi_circles::CircleActivated`
        },
        limit: 50
      });
      
      // Get wallet creation events to map circle IDs to wallet IDs
      const walletEvents = await client.queryEvents({
        query: {
          MoveEventType: `${PACKAGE_ID}::njangi_custody::CustodyWalletCreated`
        },
        limit: 100
      });
      
      // Create a map of circle IDs to wallet IDs
      const circleWalletMap = new Map<string, string>();
      for (const event of walletEvents.data) {
        if (event.parsedJson && typeof event.parsedJson === 'object') {
          const eventJson = event.parsedJson as { circle_id?: string, wallet_id?: string };
          if (eventJson.circle_id && eventJson.wallet_id) {
            circleWalletMap.set(eventJson.circle_id, eventJson.wallet_id);
          }
        }
      }
      console.log('Circle to wallet ID mapping from events:', Object.fromEntries(circleWalletMap));
      
      // Fetch wallet IDs from dynamic fields safely
      const fetchWalletIdFromDynamicFields = async (circleId: string | undefined): Promise<string | undefined> => {
        // Add check for undefined circleId
        if (!circleId) return undefined; 
        try {
          console.log(`Fetching dynamic fields for circle ${circleId}`);
          const dynamicFields = await client.getDynamicFields({
            parentId: circleId // ID is now guaranteed to be string
          });
          
          for (const field of dynamicFields.data) {
             // Add check for field and field properties
            if (field?.name && 
                typeof field.name === 'object' && 
                'type' in field.name && 
                field.name.type && 
                field.name.type.includes('vector<u8>') && 
                 // Check field.type instead of objectType
                field.type && field.type.includes('wallet_id')) { 
              
              // Check if objectId exists before fetching
              if (field.objectId) { 
                const walletField = await client.getObject({
                  id: field.objectId, // Safe to use
                  options: { showContent: true }
                });
                
                // Safe access to nested fields with added check for fields property
                const contentFields = walletField.data?.content && 
                                        typeof walletField.data.content === 'object' && 
                                        'fields' in walletField.data.content ? 
                                        walletField.data.content.fields as { value?: string } : null; 
                                        
                if (contentFields?.value) { 
                  console.log(`Found wallet ID in dynamic fields: ${contentFields.value}`);
                  return contentFields.value;
                }
              }
            }
          }
          return undefined;
        } catch (error) {
          console.error(`Error fetching wallet ID for circle ${circleId}:`, error);
          return undefined;
        }
      };
      
      // Create a set of activated circle IDs for quick lookup
      const activatedCircleIds = new Set<string>();
      for (const event of activationEvents.data) {
        if (event.parsedJson && typeof event.parsedJson === 'object') {
          const eventJson = event.parsedJson as { circle_id?: string };
          if (eventJson.circle_id) {
            activatedCircleIds.add(eventJson.circle_id);
          }
        }
      }
      console.log('Activated circle IDs:', Array.from(activatedCircleIds));
      
      // Create a member count map based on member events
      const memberCountMap = new Map<string, Set<string>>();
      
      // Process all member events to build the member count map
      for (const event of memberEvents.data) {
        if (event.parsedJson && typeof event.parsedJson === 'object') {
          const eventJson = event.parsedJson as { circle_id?: string, member?: string };
          if (eventJson.circle_id && eventJson.member) {
            // Initialize set if not exists
            if (!memberCountMap.has(eventJson.circle_id)) {
              memberCountMap.set(eventJson.circle_id, new Set<string>());
            }
            // Add member to the set
            memberCountMap.get(eventJson.circle_id)!.add(eventJson.member);
          }
        }
      }
      
      // Create mapping from circle ID to creation event data
      const circleCreationDataMap = new Map<string, CircleCreatedEvent>();
      
      // Also store transaction data to extract cycle_day which isn't in the event
      const transactionInputMap = new Map<string, TransactionInputData>();
      
      for (const event of circleEvents.data) {
        if (event.parsedJson) {
          const parsedEvent = event.parsedJson as CircleCreatedEvent;
          if (parsedEvent.circle_id) {
            circleCreationDataMap.set(parsedEvent.circle_id, parsedEvent);
            
            // Try to get the transaction digest and fetch transaction data
            if (event.id?.txDigest) {
              try {
                const txData = await client.getTransactionBlock({
                  digest: event.id.txDigest,
                  options: {
                    showInput: true,
                    showEffects: false,
                    showEvents: false,
                    showObjectChanges: false,
                  }
                });
                
                // Extract inputs from transaction data if available
                if (txData?.transaction?.data?.transaction?.kind === 'ProgrammableTransaction') {
                  const tx = txData.transaction.data.transaction;
                  const inputs = tx.inputs || [];
                  
                  // Try to find the cycle_day input (typically at index 6)
                  if (inputs.length > 6 && inputs[6].type === 'pure' && inputs[6].valueType === 'u64') {
                    const cycleDay = inputs[6].value;
                    console.log(`Found cycle_day ${cycleDay} for circle ${parsedEvent.circle_id} from tx`);
                    
                    // Store this with the circle ID
                    transactionInputMap.set(parsedEvent.circle_id, {
                      cycle_day: Number(cycleDay)
                    });
                  }
                }
              } catch (error) {
                console.error(`Error fetching transaction data for ${event.id.txDigest}:`, error);
              }
            }
          }
        }
      }
      
      // Process both result sets
      const circleMap = new Map<string, Circle>();
      
      // Process created circles (admin)
      for (const event of circleEvents.data) {
        const parsedEvent = event.parsedJson as CircleCreatedEvent;
        if (parsedEvent?.admin === userAddress) {
          try {
            // First verify if the circle still exists (hasn't been deleted)
            const objectData = await client.getObject({
              id: parsedEvent.circle_id,
              options: { 
                showType: true, 
                showOwner: true,
                showContent: true,
                showDisplay: false,
                showStorageRebate: false,
                showPreviousTransaction: false,
                showBcs: false
              }
            });
            
            // Skip this circle if it doesn't exist or is not accessible
            if (!objectData.data || objectData.error) {
              console.log(`Circle ${parsedEvent.circle_id} no longer exists, skipping...`);
              continue;
            }
            
            // Get the dynamic fields for this circle
            const dynamicFieldsResult = await client.getDynamicFields({
              parentId: parsedEvent.circle_id
            });
            
            console.log(`Dynamic fields for circle ${parsedEvent.circle_id}:`, dynamicFieldsResult.data);
            
            // Add transaction input data if we have it
            const transactionInput = transactionInputMap.get(parsedEvent.circle_id);
            
            // Add type assertions for the EnhancedObjectData
            const enhancedObjectData = {
              ...objectData,
              data: {
                ...objectData.data,
                dynamicFields: dynamicFieldsResult.data,
              },
              transactionInput
            };
            
            // Process circle using the helper function with all data sources
            // @ts-expect-error - Type compatibility issues with SUI SDK
            const circleData = await processCircleObject(enhancedObjectData, userAddress, parsedEvent, client);
            
            if (circleData) {
              // Update with the actual member count from events
              const memberCount = memberCountMap.has(parsedEvent.circle_id) 
                ? memberCountMap.get(parsedEvent.circle_id)!.size 
                : 1; // Default to 1 (admin only)
              
              // Check if the circle has been activated
              const isActive = activatedCircleIds.has(parsedEvent.circle_id);
              
              const safeCircleData = {
                ...circleData,
                id: circleData?.id ?? '',
                name: typeof circleData?.name === 'string' ? circleData.name : '',
                admin: typeof circleData?.admin === 'string' ? circleData.admin : '',
              } as Circle;
              
              // Try to get wallet ID from map first
              let walletId = circleWalletMap.get(parsedEvent.circle_id);
              
              // If not found in the map, try to get it from dynamic fields
              if (!walletId) {
                walletId = await fetchWalletIdFromDynamicFields(parsedEvent.circle_id);
                
                // If found from dynamic fields, store it in our map for future reference
                if (walletId) {
                  circleWalletMap.set(parsedEvent.circle_id, walletId);
                }
              }
              
              circleMap.set(parsedEvent.circle_id, {
                ...safeCircleData,
                currentMembers: memberCount,
                isActive: isActive,
                walletId: walletId || undefined
              });
              
              console.log('Added admin circle:', parsedEvent.circle_id, 'with members:', memberCount, 'wallet ID:', walletId || 'none');
            }
          } catch (error) {
            console.error(`Error fetching circle details for ${parsedEvent.circle_id}:`, error);
          }
        }
      }
      
      // Process joined circles (member)
      for (const event of memberEvents.data) {
        const parsedEvent = event.parsedJson as MemberJoinedEvent;
        if (parsedEvent?.member === userAddress && !circleMap.has(parsedEvent.circle_id)) {
          // This means the user is a member but not the admin of this circle
          try {
              // Get detailed object data
              const objectData = await client.getObject({
                id: parsedEvent.circle_id,
              options: { 
                showContent: true
              }
            });
            
            // Get any creation data we might have for this circle
            const creationData = circleCreationDataMap.get(parsedEvent.circle_id);
            
            // Get dynamic fields for this circle
            const dynamicFieldsResult = await client.getDynamicFields({
              parentId: parsedEvent.circle_id
            });
            
            // Add transaction input data if we have it
            const transactionInput = transactionInputMap.get(parsedEvent.circle_id);
            
            // Prepare the enhanced object data
            const enhancedObjectData = {
              ...objectData,
              data: {
                ...objectData.data,
                dynamicFields: dynamicFieldsResult.data
              },
              transactionInput
            };
            
            // Process member circle using the helper function
            // @ts-expect-error - Type compatibility issues with SUI SDK
            const circleData = await processCircleObject(enhancedObjectData, userAddress, creationData, client);
            
            if (circleData) {
              // Update with the actual member count from events
              const memberCount = memberCountMap.has(parsedEvent.circle_id) 
                ? memberCountMap.get(parsedEvent.circle_id)!.size 
                : 1;
                  
              // Check if the circle has been activated
              const isActive = activatedCircleIds.has(parsedEvent.circle_id);
                  
              const safeCircleData = {
                ...circleData,
                id: circleData?.id ?? '',
                name: typeof circleData?.name === 'string' ? circleData.name : '',
                admin: typeof circleData?.admin === 'string' ? circleData.admin : '',
              } as Circle;
                  
              // Try to get wallet ID from map first
              let walletId = circleWalletMap.get(parsedEvent.circle_id);
              
              // If not found in the map, try to get it from dynamic fields
              if (!walletId) {
                walletId = await fetchWalletIdFromDynamicFields(parsedEvent.circle_id);
                
                // If found from dynamic fields, store it in our map for future reference
                if (walletId) {
                  circleWalletMap.set(parsedEvent.circle_id, walletId);
                }
              }
                  
              circleMap.set(parsedEvent.circle_id, {
                ...safeCircleData,
                currentMembers: memberCount,
                isActive: isActive,
                walletId: walletId || undefined
              });
              
              console.log('Added member circle:', parsedEvent.circle_id, 'with members:', memberCount, 'wallet ID:', walletId || 'none');
            }
            } catch (err) {
              console.error(`Error fetching circle details for ${parsedEvent.circle_id}:`, err);
          }
        }
      }
      
      // Convert map to array and set state
      setCircles(Array.from(circleMap.values()));
      
      // Store admin circle IDs in localStorage for use by the Navbar component
      const adminCircleIds = Array.from(circleMap.values())
        .filter(circle => circle.isAdmin)
        .map(circle => circle.id);
        
      console.log('Storing admin circle IDs in localStorage:', adminCircleIds);
      localStorage.setItem('adminCircles', JSON.stringify(adminCircleIds));
    } catch (error) {
      console.error('Error fetching circles:', error);
      setError('An error occurred while fetching circles. Please try again later.');
    } finally {
      setLoading(false);
    }
  }, [userAddress]);

  useEffect(() => {
    fetchUserCircles();
  }, [userAddress, fetchUserCircles]);

  // Check which circles can be deleted - only for admin circles
  useEffect(() => {
    const checkDeleteableCircles = async () => {
      if (!userAddress || circles.length === 0) return;
      
      try {
        const deleteable = new Set<string>();
        
        // For each circle where user is admin, check if it can be deleted
        for (const circle of circles.filter(c => c.isAdmin)) {
          try {
            // For simplicity, we'll check if it meets the basic criteria:
            // 1. Is admin
            // 2. Has 0 or 1 members (only admin)
            if (circle.currentMembers <= 1) {
              deleteable.add(circle.id);
            }
          } catch (error) {
            console.error(`Error checking if circle ${circle.id} can be deleted:`, error);
          }
        }
        
        setDeleteableCircles(deleteable);
      } catch (error) {
        console.error('Error checking deleteable circles:', error);
      }
    };
    
    checkDeleteableCircles();
  }, [circles, userAddress]);
  
  // Check for wallet availability on component mount
  useEffect(() => {
    const checkWalletAvailability = async () => {
      // If using zkLogin, we don't need to check for wallet availability
      if (isAuthenticated && account) {
        console.log("Using zkLogin authentication, skipping wallet check");
        return;
      }

      // Check for wallet extensions
      const hasWallet = !!(
        window.suiWallet || 
        window.sui || 
        window.suix || 
        window.ethos || 
        window.suiet || 
        window.martian
      );
      
      if (!hasWallet) {
        console.log("No wallet extension detected");
        // We're primarily using zkLogin, so no need to show error about wallet extensions
        // Users will be directed to zkLogin flow instead
      }
    };
    
    checkWalletAvailability();
  }, [isAuthenticated, account]);

  // --- Updated deleteCircleWithZkLogin to handle wallet balance errors ---
  const deleteCircleWithZkLogin = async (circleId: string) => {
    // The actual deletion logic, to be called by the modal
    const performDeletion = async () => {
      try {
        console.log("Deleting circle with zkLogin:", circleId);
        setIsDeleting(circleId); // Keep track of which circle is being deleted

        // Find the circle to get its wallet ID
        const circle = circles.find(c => c.id === circleId);
        const walletId = circle?.walletId;
        
        console.log("Circle to delete:", circle);
        console.log("Using wallet ID:", walletId);

        // Use the AuthContext's deleteCircle method - now returns a structured response
        const result = await authDeleteCircle(circleId, walletId);
        
        // Check if deletion succeeded
        if (result.success) {
          console.log("Delete successful with digest:", result.digest);
          
          // Update the UI
          setCircles(prevCircles => prevCircles.filter(c => c.id !== circleId));
          
          toast.success("Circle has been deleted.");
        } else {
          // Handle wallet balance errors gracefully
          if (result.errorType === 'WALLET_HAS_BALANCE') {
            console.log("Circle has funds, cannot delete:", result.error);
            
            // Show a user-friendly modal instead of a toast
            setConfirmModalProps({
              title: "Cannot Delete Circle",
              message: "This circle cannot be deleted because it still has funds in its wallet. Please withdraw all funds first, then try deleting the circle again.",
              confirmText: "OK",
              confirmButtonVariant: "warning",
              onConfirm: () => setIsConfirmModalOpen(false)
            });
            setIsConfirmModalOpen(true);
          } else {
            // Handle other types of failures
            toast.error(result.error || "Failed to delete circle");
          }
        }
        
        setIsDeleting(""); // Clear deleting status
      } catch (error) {
        console.error("Error deleting circle:", error);
        setIsDeleting(""); // Clear deleting status
        
        // Generic error handling for other cases
        setConfirmModalProps({
          title: "Error Deleting Circle",
          message: error instanceof Error ? error.message : "Failed to delete circle",
          confirmText: "OK",
          confirmButtonVariant: "danger",
          onConfirm: () => setIsConfirmModalOpen(false)
        });
        setIsConfirmModalOpen(true);
      }
    };

    // First check if we know the circle has a wallet with funds before attempting deletion
    try {
      // Get the wallet ID for the circle
      const circle = circles.find(c => c.id === circleId);
      const walletId = circle?.walletId;
      
      if (!walletId) {
        // Proceed with regular deletion confirmation if we don't know the wallet ID
        // Show confirmation dialog
        setIsConfirmModalOpen(true);
        setConfirmModalProps({
          title: "Delete Circle",
          message: "Are you sure you want to delete this circle? This action cannot be undone.",
          confirmText: "Delete",
          confirmButtonVariant: "danger",
          onConfirm: performDeletion
        });
        return;
      }
      
      // If we have a wallet ID, check if this circle was previously determined to be deletable
      if (deleteableCircles.has(circleId)) {
        // Show confirmation dialog
        setIsConfirmModalOpen(true);
        setConfirmModalProps({
          title: "Delete Circle",
          message: "Are you sure you want to delete this circle? This action cannot be undone.",
          confirmText: "Delete",
          confirmButtonVariant: "danger",
          onConfirm: performDeletion
        });
      } else {
        // If it's not in deleteableCircles, it might have funds - proceed with caution
        setIsConfirmModalOpen(true);
        setConfirmModalProps({
          title: "Delete Circle",
          message: "Are you sure you want to delete this circle? This action cannot be undone. Note that you'll need to withdraw any funds before it can be deleted.",
          confirmText: "Delete",
          confirmButtonVariant: "danger",
          onConfirm: performDeletion
        });
      }
    } catch (error) {
      console.error("Error checking circle status:", error);
      // Fallback to standard confirmation
      setIsConfirmModalOpen(true);
      setConfirmModalProps({
        title: "Delete Circle",
        message: "Are you sure you want to delete this circle? This action cannot be undone.",
        confirmText: "Delete",
        confirmButtonVariant: "danger",
        onConfirm: performDeletion
      });
    }
  };
  
  // --- Add function to withdraw funds from circle wallet ---
  const withdrawFunds = async (walletId: string) => {
    if (!walletId) {
      toast.error("Wallet ID is required to withdraw funds");
      return;
    }
    
    try {
      setIsDeleting(walletId); // Keep track of which wallet is being processed
      
      // Call API to withdraw funds and await the result
      const result = await authDeleteCircle(walletId);
      
      if (result.success) {
        toast.success("Funds have been withdrawn to your wallet");
        
        // Refresh the page to update balances
        setTimeout(() => {
          window.location.reload();
        }, 3000);
      } else {
        toast.error(result.error || "Failed to withdraw funds");
      }
    } catch (error) {
      console.error("Error withdrawing funds:", error);
      
      toast.error(error instanceof Error ? error.message : "Failed to withdraw funds");
    } finally {
      setIsDeleting(""); // Clear processing status
    }
  };

  // --- Updated deleteCircle (non-zkLogin) to use the modal ---
  const deleteCircle = async (circleId: string) => {
    console.log("deleteCircle function called with circleId:", circleId);

    // The actual deletion logic (for wallet extension), to be called by the modal
    const performWalletDeletion = async () => {
      // Check for wallet availability - expanded to check multiple wallet objects
      const walletDetectionDetails = {
        suiWallet: !!window.suiWallet,
        sui: !!window.sui,
        suix: !!window.suix,
        ethos: !!window.ethos,
        suiet: !!window.suiet,
        martian: !!window.martian
      };
      console.log("Wallet detection results:", walletDetectionDetails);
      
      // Try to find an available wallet
      let wallet = null;
      if (window.suiWallet) wallet = window.suiWallet;
      else if (window.sui) wallet = window.sui;
      else if (window.suix) wallet = window.suix;
      else if (window.ethos) wallet = window.ethos;
      else if (window.suiet) wallet = window.suiet;
      else if (window.martian) wallet = window.martian;
      
      if (!wallet) {
        console.log("No compatible SUI wallet found");
        toast.error('No wallet detected. Please install a SUI wallet extension.');
        return;
      }
      
      console.log("Available wallet methods:", Object.keys(wallet));
      const packageId = PACKAGE_ID;
      console.log("Using packageId:", packageId);
      
      setIsDeleting(circleId);
      console.log("Set isDeleting state to:", circleId);
      
      try {
        // Check for wallet features/capabilities
        const hasSignAndExecuteTransactionBlock = typeof wallet.signAndExecuteTransactionBlock === 'function';
        const hasSignTransactionBlock = typeof wallet.signTransactionBlock === 'function';
        const hasSignAndExecuteTransaction = typeof wallet.signAndExecuteTransaction === 'function';
        const hasConstructTransaction = typeof wallet.constructTransaction === 'function';
        const hasSignAndExecuteTransactionV2 = typeof wallet.signAndExecuteTransaction === 'function';
        
        console.log("Wallet capabilities:", {
          signAndExecuteTransactionBlock: hasSignAndExecuteTransactionBlock,
          signTransactionBlock: hasSignTransactionBlock,
          signAndExecuteTransaction: hasSignAndExecuteTransaction,
          constructTransaction: hasConstructTransaction,
          signAndExecuteTransactionV2: hasSignAndExecuteTransactionV2
        });
        
        let result: Record<string, unknown> | null = null;
        
        // Try newer wallet API first (preferred)
        if (hasSignAndExecuteTransactionBlock && wallet.signAndExecuteTransactionBlock) {
          console.log("Using signAndExecuteTransactionBlock API");
          
          // Create a transaction block for the newer API format
          const txb: TransactionBlockPayload = {
            transactionBlock: {
              // Modern format for transaction block
              transactions: [
                {
                  kind: 'MoveCall',
                  target: `${packageId}::njangi_circles::delete_circle`,
                  arguments: [
                    { kind: 'Input', index: 0, type: 'object', value: circleId }
                  ]
                }
              ]
            },
            options: {
              showEffects: true,
              showEvents: true,
            }
          };
          
          console.log("Transaction block created:", txb);
          result = await wallet.signAndExecuteTransactionBlock(txb);
        }
        // Try alternative format for signAndExecuteTransactionBlock
        else if (hasSignAndExecuteTransactionBlock && wallet.signAndExecuteTransactionBlock) {
          console.log("Using alternative signAndExecuteTransactionBlock format");
          
          const txb: TransactionBlockPayload = {
            transactionBlock: {
              // Alternative format
              moveCall: {
                packageObjectId: packageId,
                module: 'njangi_circle',
                function: 'delete_circle',
                typeArguments: [],
                arguments: [circleId]
              }
            },
            options: {
              showEffects: true,
              showEvents: true,
            }
          };
          
          console.log("Transaction block created (alternative format):", txb);
          result = await wallet.signAndExecuteTransactionBlock(txb);
        }
        // Fall back to older wallet API
        else if (hasConstructTransaction && hasSignAndExecuteTransaction && 
                 wallet.constructTransaction && wallet.signAndExecuteTransaction) {
          console.log("Using legacy transaction flow");
          const transaction = wallet.constructTransaction({
            kind: 'moveCall',
            data: {
              packageObjectId: packageId,
              module: 'njangi_circle',
              function: 'delete_circle',
              typeArguments: [],
              arguments: [circleId],
              gasBudget: 10000000,
            }
          });
          
          console.log("Transaction constructed:", transaction);
          result = await wallet.signAndExecuteTransaction({
            transaction: transaction,
          });
        }
        else {
          console.error("No compatible wallet API methods found");
          toast.error('Your wallet does not support the required transaction methods.');
          setIsDeleting(null);
          return;
        }

        console.log("Transaction execution result:", result);
        
        if (result) {
          toast.success('Circle deleted successfully');
          // Update the UI - remove the deleted circle
          setCircles(prevCircles => prevCircles.filter(c => c.id !== circleId));
          setDeleteableCircles(prev => {
            const updated = new Set(prev);
            updated.delete(circleId);
            return updated;
          });
        }
      } catch (error) {
        console.error('Error deleting circle with wallet:', error);
        // Show error toast with appropriate message
        if (error instanceof Error) {
          if (error.message.includes('ECircleHasActiveMembers')) {
            toast.error('Cannot delete: Circle has active members');
          } else if (error.message.includes('ECircleHasContributions')) {
            toast.error('Cannot delete: Circle has received contributions');
          } else {
            toast.error('Error deleting circle: ' + error.message);
          }
        } else {
          toast.error('Error deleting circle');
        }
      } finally {
        setIsDeleting(null);
      }
    };

    // Check if using zkLogin authentication
    if (isAuthenticated && account) {
      console.log("Using zkLogin authentication for deletion");
      // Call the zkLogin version which will handle the modal opening
      deleteCircleWithZkLogin(circleId);
    } else {
      // If using wallet extension, open the modal directly
      const circleToDelete = circles.find(c => c.id === circleId);
      setConfirmModalProps({
        title: `Delete Circle: ${circleToDelete?.name || 'Unknown'}`,
        message: "Are you absolutely sure you want to delete this circle? This action cannot be undone.",
        onConfirm: performWalletDeletion,
        confirmText: 'Delete Circle',
        confirmButtonVariant: 'danger',
      });
      setIsConfirmModalOpen(true);
    }
  };

  const shortenAddress = (address: string | null | undefined) => {
    if (!address) return '';
    return `${address.slice(0, 6)}...${address.slice(-6)}`;
  };

  const copyToClipboard = async (text: string | null, type: 'address' | 'circleId' = 'address') => {
    if (!text) return;
    
    try {
      await navigator.clipboard.writeText(text);
      
      if (type === 'address') {
        setShowToast(true);
        setTimeout(() => setShowToast(false), 2000);
      } else if (type === 'circleId') {
        setCopiedCircleId(text);
        toast.success('Circle ID copied to clipboard!');
        setTimeout(() => setCopiedCircleId(null), 2000);
      }
    } catch (err) {
      console.error(`Failed to copy ${type}:`, err);
      toast.error(`Failed to copy ${type === 'address' ? 'address' : 'circle ID'}`);
    }
  };

  const copyShareLink = async (circleId: string) => {
    try {
      const shareLink = `${window.location.origin}/circle/${circleId}/join`;
      await navigator.clipboard.writeText(shareLink);
      toast.success('Invite link copied to clipboard!');
    } catch (err) {
      console.error('Failed to copy share link:', err);
      toast.error('Failed to copy invite link');
    }
  };

  // Format cycle lengths and days for display
  const formatCycleInfo = (cycleLength: number, cycleDay: number) => {
    // Log the input values for debugging
    console.log('[formatCycleInfo] Received:', { cycleLength, cycleDay });
    
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
    
    return `${cyclePeriod} (${dayFormat})`;
  };

  // Helper to format dates with ordinal suffix
  const getOrdinalSuffix = (day: number) => {
    const suffixes = ['th', 'st', 'nd', 'rd'];
    const relevantDigits = (day % 100);
    
    // Special case for 11, 12, 13
    if (relevantDigits >= 11 && relevantDigits <= 13) {
      return `${day}th day`;
    }
    
    // For other numbers, use last digit
    const lastDigit = day % 10;
    const suffix = lastDigit >= 1 && lastDigit <= 3 ? suffixes[lastDigit] : suffixes[0];
    return `${day}${suffix} day`;
  };

  // Format timestamp to readable date
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
    const isPriceUnavailable = suiPrice === null;
    
    console.log('CurrencyDisplay inputs:', { usd, sui, suiPrice, isPriceUnavailable });
    
    // Debug logging
    if (usd === 0 || sui === 0) {
      console.log('Zero values detected in CurrencyDisplay:', { usd, sui });
    }
    
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
      console.log('CurrencyDisplay: using SUI value to calculate USD:', { 
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
    
    // Special case for zero values - check if this is intentional or missing data
    if (calculatedUsd === 0 && calculatedSui === 0) {
      // Just display as "N/A" or "$0" to be clearer in UI
      return (
        <span className={`${className}`}>
          {isPriceUnavailable ? "Data unavailable" : "$0.00 (0 SUI)"}
        </span>
      );
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
              {isPriceLoading && <RefreshCw size={14} className="animate-spin ml-1 text-blue-500" />}
              {isPriceUnavailable && !isPriceLoading && <AlertCircle size={14} className="ml-1 text-amber-500" />}
            </span>
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
                  {isPriceLoading
                    ? "Loading latest price data..."
                    : isPriceUnavailable
                      ? "Unable to fetch price data"
                      : "Using latest price from CoinGecko"}
                </p>
              </div>
              <Tooltip.Arrow className="fill-gray-900" />
            </Tooltip.Content>
          </Tooltip.Portal>
        </Tooltip.Root>
      </Tooltip.Provider>
    );
  };

  const handleJoinCircle = (e: React.FormEvent) => {
    e.preventDefault();
    
    // Simple validation - make sure the input isn't empty
    if (!circleIdInput.trim()) {
      toast.error('Please enter a valid circle ID');
      return;
    }
    
    // Extract just the ID if the user pasted the full URL
    let circleId = circleIdInput.trim();
    
    // If the input contains a URL path, extract just the circle ID
    if (circleId.includes('/circle/')) {
      const match = circleId.match(/\/circle\/([^\/]+)/);
      if (match && match[1]) {
        circleId = match[1];
      }
    }
    
    // Navigate to the join page for this circle
    router.push(`/circle/${circleId}/join`);
    
    // Reset the input and close the dialog
    setCircleIdInput('');
    setIsJoinDialogOpen(false);
  };

  const shortenId = (id: string) => {
    if (!id) return '';
    return `${id.slice(0, 10)}...${id.slice(-6)}`;
  };

  // Fix toast with the wallet balance warning to use proper entity escaping
  const handleWalletWithBalance = (walletId: string | undefined) => {
    toast((t) => (
      <div className="flex flex-col">
        <p>This circle&apos;s wallet still has funds. Would you like to withdraw them first?</p>
        <button 
          onClick={() => {
            if (walletId) withdrawFunds(walletId);
            toast.dismiss(t.id);
          }}
          className="mt-2 bg-blue-500 hover:bg-blue-600 text-white px-3 py-1 rounded text-sm"
        >
          Withdraw Funds
        </button>
      </div>
    ), { duration: 9000 });
  };

  // Check if the testnet banner should be shown
  useEffect(() => {
    // Check session storage to see if banner was already dismissed
    const bannerDismissed = sessionStorage.getItem('testnetBannerDismissed');
    if (bannerDismissed === 'true') {
      setShowTestnetBanner(false);
    }
  }, []);

  // Function to dismiss the testnet banner
  const dismissTestnetBanner = () => {
    setShowTestnetBanner(false);
    // Save the dismissal to session storage
    sessionStorage.setItem('testnetBannerDismissed', 'true');
  };

  // Load recent contacts from localStorage
  useEffect(() => {
    try {
      const stored = localStorage.getItem('recentContacts');
      if (stored) {
        const contacts = JSON.parse(stored) as RecentContact[];
        // Sort by frequency and last used, limit to 10
        const sortedContacts = contacts
          .sort((a, b) => b.frequency - a.frequency || b.lastUsed - a.lastUsed)
          .slice(0, 10);
        setRecentContacts(sortedContacts);
      }
    } catch (error) {
      console.error('Error loading recent contacts:', error);
    }
  }, []);

  // Validate SUI address format
  const isValidSuiAddress = (address: string): boolean => {
    if (!address) return false;
    
    // Remove 0x prefix if present
    const cleanAddress = address.startsWith('0x') ? address.slice(2) : address;
    
    // Check if it's a valid hex string of correct length
    const hexRegex = /^[0-9a-fA-F]+$/;
    return hexRegex.test(cleanAddress) && (cleanAddress.length === 64 || cleanAddress.length === 40);
  };

  // Validate transfer form
  const validateTransferForm = (formData: TransferFormData): TransferValidation => {
    const errors: TransferValidation['errors'] = {};
    const warnings: TransferValidation['warnings'] = {};

    // Validate recipient address
    if (!formData.recipientAddress.trim()) {
      errors.recipientAddress = 'Recipient address is required';
    } else if (!isValidSuiAddress(formData.recipientAddress)) {
      errors.recipientAddress = 'Invalid SUI address format';
    } else if (formData.recipientAddress.toLowerCase() === userAddress?.toLowerCase()) {
      errors.recipientAddress = 'Cannot send to your own address';
    }

    // Validate amount
    if (!formData.amount.trim()) {
      errors.amount = 'Amount is required';
    } else {
      const amount = parseFloat(formData.amount);
      if (isNaN(amount) || amount <= 0) {
        errors.amount = 'Amount must be a positive number';
      } else {
        // Check balance
        const selectedCoin = allCoins.find(coin => coin.symbol === formData.selectedToken);
        if (selectedCoin) {
          const decimals = selectedCoin.symbol.toLowerCase() === 'usdc' ? 1000000 : 1000000000;
          const availableBalance = Number(selectedCoin.balance) / decimals;
          
          if (amount > availableBalance) {
            errors.balance = `Insufficient balance. Available: ${availableBalance.toFixed(6)} ${formData.selectedToken}`;
          } else if (formData.selectedToken === 'SUI' && amount > availableBalance - 0.01) {
            errors.balance = 'Please leave at least 0.01 SUI for gas fees';
          }

          // High value warning (over $1000 USD equivalent)
          if (formData.selectedToken === 'SUI' && suiPrice && amount * suiPrice > 1000) {
            warnings.highValue = `High value transfer: ~$${(amount * suiPrice).toFixed(2)} USD`;
          } else if (formData.selectedToken === 'USDC' && amount > 1000) {
            warnings.highValue = `High value transfer: $${amount.toFixed(2)} USD`;
          }
        }
      }
    }

    // Check if address is new (not in recent contacts)
    if (formData.recipientAddress && !recentContacts.some(contact => 
      contact.address.toLowerCase() === formData.recipientAddress.toLowerCase()
    )) {
      warnings.newAddress = 'This is a new address. Please double-check before sending.';
    }

    // Testnet warning
    warnings.testnet = 'You are on Sui Testnet. These are test tokens with no real value.';

    return {
      isValid: Object.keys(errors).length === 0,
      errors,
      warnings
    };
  };

  // Update validation when form changes
  useEffect(() => {
    const validation = validateTransferForm(transferForm);
    setTransferValidation(validation);
  }, [transferForm, allCoins, suiPrice, userAddress, recentContacts]);

  // Handle transfer form submission
  const handleTransferSubmit = async () => {
    if (!transferValidation.isValid || !userAddress) return;

    setIsTransferring(true);
    setTransferStep('confirm');

    try {
      // Prepare transaction data
      const amount = parseFloat(transferForm.amount);
      const selectedCoin = allCoins.find(coin => coin.symbol === transferForm.selectedToken);
      
      if (!selectedCoin) {
        throw new Error('Selected token not found');
      }

      const decimals = selectedCoin.symbol.toLowerCase() === 'usdc' ? 1000000 : 1000000000;
      const amountInSmallestUnit = Math.floor(amount * decimals);

      // Normalize recipient address
      let recipientAddress = transferForm.recipientAddress.trim();
      if (!recipientAddress.startsWith('0x')) {
        recipientAddress = '0x' + recipientAddress;
      }

      // Call the transfer API
      const response = await fetch('/api/transfer-tokens', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          recipientAddress,
          amount: amountInSmallestUnit.toString(),
          coinType: selectedCoin.coinType,
          memo: transferForm.memo || undefined,
        }),
      });

      const result = await response.json();

      if (result.success) {
        setTransferResult({ digest: result.digest });
        setTransferStep('success');

        // Add to recent contacts
        const newContact: RecentContact = {
          address: recipientAddress,
          lastUsed: Date.now(),
          frequency: 1
        };

        const updatedContacts = [...recentContacts];
        const existingIndex = updatedContacts.findIndex(c => 
          c.address.toLowerCase() === recipientAddress.toLowerCase()
        );

        if (existingIndex >= 0) {
          updatedContacts[existingIndex].frequency += 1;
          updatedContacts[existingIndex].lastUsed = Date.now();
        } else {
          updatedContacts.push(newContact);
        }

        setRecentContacts(updatedContacts.slice(0, 10));
        localStorage.setItem('recentContacts', JSON.stringify(updatedContacts.slice(0, 10)));

        // Refresh balances after successful transfer
        setTimeout(() => {
          window.location.reload();
        }, 3000);

        toast.success('Transfer completed successfully!');
      } else {
        throw new Error(result.error || 'Transfer failed');
      }
    } catch (error) {
      console.error('Transfer error:', error);
      setTransferResult({ error: error instanceof Error ? error.message : 'Transfer failed' });
      setTransferStep('form');
      toast.error(error instanceof Error ? error.message : 'Transfer failed');
    } finally {
      setIsTransferring(false);
    }
  };

  // Reset transfer dialog
  const resetTransferDialog = () => {
    setTransferForm({
      recipientAddress: '',
      amount: '',
      selectedToken: 'SUI',
      memo: ''
    });
    setTransferStep('form');
    setTransferResult(null);
    setShowAdvancedOptions(false);
    setIsTransferDialogOpen(false);
  };

  // Quick amount buttons
  const getQuickAmounts = (tokenSymbol: string) => {
    if (tokenSymbol === 'SUI') {
      return ['0.1', '1', '5', '10'];
    } else if (tokenSymbol === 'USDC') {
      return ['10', '50', '100', '500'];
    }
    return ['0.1', '1', '10', '100'];
  };

  // Set quick amount
  const setQuickAmount = (amount: string) => {
    setTransferForm(prev => ({ ...prev, amount }));
  };

  // Set max amount
  const setMaxAmount = () => {
    const selectedCoin = allCoins.find(coin => coin.symbol === transferForm.selectedToken);
    if (selectedCoin) {
      const decimals = selectedCoin.symbol.toLowerCase() === 'usdc' ? 1000000 : 1000000000;
      let maxAmount = Number(selectedCoin.balance) / decimals;
      
      // Reserve gas for SUI transfers
      if (transferForm.selectedToken === 'SUI') {
        maxAmount = Math.max(0, maxAmount - 0.01);
      }
      
      setTransferForm(prev => ({ ...prev, amount: maxAmount.toString() }));
    }
  };

  if (!isAuthenticated || !account) {
    return null;
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Toast Notification */}
      {showToast && (
        <div className="fixed top-4 right-4 bg-gray-900 text-white px-4 py-2 rounded-lg shadow-lg transition-opacity duration-200 flex items-center space-x-2 z-50">
          <svg className="w-5 h-5 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" />
          </svg>
          <span>Address copied to clipboard!</span>
        </div>
      )}

      {/* Testnet Banner */}
      {showTestnetBanner && (
        <div className="bg-amber-50 border-b border-amber-200">
          <div className="max-w-7xl mx-auto py-2 px-3 sm:px-6 lg:px-8">
            <div className="flex items-center justify-between">
              <div className="flex items-center">
                <div className="flex-shrink-0">
                  <svg className="h-5 w-5 text-amber-400" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                    <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                  </svg>
                </div>
                <div className="ml-3 flex-1">
                  <p className="text-sm text-amber-700">
                    You are currently using the Sui Testnet. Funds and transactions are not on the main network.
                  </p>
                </div>
                <div className="ml-4">
                  <a
                    href={`https://faucet.sui.io/?address=${userAddress || ''}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center px-3 py-1.5 border border-amber-300 text-xs font-medium rounded-md text-amber-700 bg-amber-100 hover:bg-amber-200 focus:outline-none focus:ring-2 focus:ring-amber-500 transition-colors duration-200"
                  >
                    <svg className="w-4 h-4 mr-1.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                    </svg>
                    Get Test Tokens
                  </a>
                </div>
              </div>
              <button 
                onClick={dismissTestnetBanner}
                className="rounded-md p-1.5 text-amber-500 hover:bg-amber-100 focus:outline-none focus:ring-2 focus:ring-amber-600"
              >
                <span className="sr-only">Dismiss</span>
                <svg className="h-5 w-5" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                  <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      )}

      <main className="max-w-7xl mx-auto py-6 sm:px-6 lg:px-8">
        <div className="px-4 py-6 sm:px-0">
          {/* Profile and Balance Card */}
          <div className="bg-white shadow rounded-lg overflow-hidden">
            <div className="p-6">
              <div className="flex items-center space-x-4">
                <div className="h-16 w-16 rounded-full overflow-hidden bg-gray-200 flex-shrink-0 relative">
                  {account.picture ? (
                    // Use Next.js Image for Google profile pictures
                    <Image
                      src={account.picture}
                      alt="Profile"
                      width={64}
                      height={64}
                      className="object-cover"
                      priority={true}
                      onError={() => {
                        console.error('Error loading Google profile picture');
                      }}
                    />
                  ) : (
                    // Use Next.js Image for fallback avatar
                    <Image
                      src={`https://api.dicebear.com/7.x/micah/svg?seed=${account.sub}`}
                      alt="Profile"
                      width={64}
                      height={64}
                      className="object-cover"
                      priority={true}
                      unoptimized={true} // Required for SVGs
                    />
                  )}
                </div>
                <div className="flex-grow">
                  <h2 className="text-xl font-semibold text-gray-900">
                    Welcome Back{account.name ? `, ${account.name}` : ''}!
                  </h2>
                </div>
              </div>
            </div>
            
            <div className="border-t border-gray-200">
              <div className="grid grid-cols-1 sm:grid-cols-2 divide-y sm:divide-y-0 sm:divide-x divide-gray-200">
                <div className="p-6">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-sm font-medium text-gray-500">Wallet Address</p>
                    <button
                      onClick={() => copyToClipboard(userAddress)}
                      className="text-blue-600 hover:text-blue-700 p-1 rounded-full hover:bg-blue-50 transition-colors duration-200"
                      title="Copy address"
                    >
                      <svg
                        className="w-5 h-5"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth="2"
                          d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3"
                        />
                      </svg>
                    </button>
                  </div>
                  <div className="group relative">
                    <p className="mt-1 text-sm text-gray-900 break-all font-mono">
                      {showFullAddress ? userAddress : shortenAddress(userAddress)}
                    </p>
                    <button
                      onClick={() => setShowFullAddress(!showFullAddress)}
                      className="mt-1 text-xs text-blue-600 hover:text-blue-700"
                    >
                      {showFullAddress ? 'Show less' : 'Show more'}
                    </button>
                  </div>
                </div>
                <div className="p-6">
                  <p className="text-sm font-medium text-gray-500">Balance</p>
                  <p className="mt-1 text-2xl font-semibold text-blue-600">{Number(balance) / 1000000000} SUI</p>
                  
                  {/* Add Send button */}
                  <div className="mt-3 flex space-x-2">
                    <button
                      onClick={() => setIsTransferDialogOpen(true)}
                      className="inline-flex items-center px-3 py-1.5 border border-transparent text-xs font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 transition-colors duration-200"
                    >
                      <Send className="w-4 h-4 mr-1.5" />
                      Send
                    </button>
                    <a
                      href={`https://faucet.sui.io/?address=${userAddress || ''}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center px-3 py-1.5 border border-gray-300 text-xs font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 transition-colors duration-200"
                    >
                      <ExternalLink className="w-4 h-4 mr-1.5" />
                      Faucet
                    </a>
                  </div>
                  
                  {/* Display all coins */}
                  {allCoins.length > 1 && (
                    <div className="mt-3">
                      <p className="text-xs font-medium text-gray-500 mb-1">All Tokens</p>
                      <div className="space-y-1 max-h-40 overflow-y-auto pr-2">
                        {allCoins.map((coin, index) => (
                          <div key={index} className="flex justify-between items-center text-sm py-1">
                            <div className="flex items-center">
                              <TokenIcon symbol={coin.symbol} />
                              <span className="font-medium">{coin.symbol}</span>
                            </div>
                            <div className="flex items-center">
                              <span className="text-gray-700 mr-2">
                                {coin.symbol.toLowerCase() === 'usdc' 
                                  ? (Number(coin.balance) / 1000000).toFixed(6) // Use 1e6 for USDC (6 decimals)
                                  : Number(coin.balance) / 1000000000 // Use 1e9 for SUI and other coins
                                }
                              </span>
                              {coin.symbol.toLowerCase() === 'usdc' && (
                                <button
                                  onClick={() => {
                                    console.log('Buy USDC button clicked');
                                    openMoonPayWidget('usdc');
                                  }}
                                  className="text-xs bg-blue-500 hover:bg-blue-600 text-white px-2 py-1 rounded transition-colors"
                                  title="Buy USDC with MoonPay"
                                >
                                  Buy
                                </button>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Njangi Circles Section */}
          <div className="mt-8">
            <div className="bg-white shadow rounded-lg p-6">
              <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center space-y-4 sm:space-y-0 mb-6">
                <h3 className="text-lg font-medium text-gray-900 text-center sm:text-left">My Njangi Circles</h3>
                <div className="flex flex-col sm:flex-row space-y-3 sm:space-y-0 sm:space-x-3 w-full sm:w-auto">
                  <button
                    type="button"
                    onClick={() => setIsJoinDialogOpen(true)}
                    className="w-full sm:w-auto inline-flex items-center justify-center px-4 py-2 border border-blue-600 text-sm font-medium rounded-md shadow-sm text-blue-600 bg-white hover:bg-blue-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 transition-colors duration-200"
                  >
                    <Users className="w-5 h-5 mr-2" />
                    Join Circle
                  </button>
                  <button
                    type="button"
                    onClick={() => router.push('/create-circle')}
                    className="w-full sm:w-auto inline-flex items-center justify-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 transition-colors duration-200"
                  >
                    <svg
                      className="w-5 h-5 mr-2"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="2"
                        d="M12 4v16m8-8H4"
                      />
                    </svg>
                    Create New Circle
                  </button>
                </div>
              </div>

              {loading ? (
                <div className="flex justify-center items-center py-12">
                  <svg className="animate-spin h-8 w-8 text-blue-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                </div>
              ) : error ? (
                <div className="bg-red-50 rounded-lg p-8 text-center">
                  <svg
                    className="mx-auto h-12 w-12 text-red-400"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    aria-hidden="true"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                    />
                  </svg>
                  <h3 className="mt-2 text-sm font-medium text-red-900">{error}</h3>
                  <p className="mt-1 text-sm text-red-500">Please try again later.</p>
                  <div className="mt-6">
                    <button
                      type="button"
                      onClick={() => fetchUserCircles()}
                      className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-red-600 hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500 transition-colors duration-200"
                    >
                      Try Again
                    </button>
                  </div>
                </div>
              ) : circles.length > 0 ? (
                <div>
                  <Tab.Group>
                    <Tab.List className="flex space-x-1 rounded-xl bg-blue-50 p-1 mb-6">
                      <Tab
                        className={({ selected }) =>
                          `w-full rounded-lg py-2.5 text-sm font-medium leading-5 transition-colors duration-200
                           ${selected
                            ? 'bg-white text-blue-700 shadow'
                            : 'text-blue-600 hover:bg-white/[0.12] hover:text-blue-700'
                          }`
                        }
                      >
                        All Circles ({circles.length})
                      </Tab>
                      <Tab
                        className={({ selected }) =>
                          `w-full rounded-lg py-2.5 text-sm font-medium leading-5 transition-colors duration-200
                           ${selected
                            ? 'bg-white text-blue-700 shadow'
                            : 'text-blue-600 hover:bg-white/[0.12] hover:text-blue-700'
                          }`
                        }
                      >
                        Administering ({circles.filter(c => c.isAdmin).length})
                      </Tab>
                      <Tab
                        className={({ selected }) =>
                          `w-full rounded-lg py-2.5 text-sm font-medium leading-5 transition-colors duration-200
                           ${selected
                            ? 'bg-white text-blue-700 shadow'
                            : 'text-blue-600 hover:bg-white/[0.12] hover:text-blue-700'
                          }`
                        }
                      >
                        Member Only ({circles.filter(c => !c.isAdmin).length})
                      </Tab>
                    </Tab.List>
                    <Tab.Panels>
                      <Tab.Panel>
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                          {circles.map((circle) => (
                            <div key={circle.id} className="bg-white border border-gray-200 rounded-xl overflow-hidden shadow-sm hover:shadow-md transition-shadow duration-200">
                              <div className="p-5 border-b border-gray-100">
                                <div className="flex justify-between items-start">
                                  <h3 className="text-lg font-semibold text-gray-900 line-clamp-1">{circle.name}</h3>
                                  <div className="flex space-x-1">
                                    <span className={`text-xs font-medium px-2 py-1 rounded-full ${circle.isAdmin ? "bg-purple-100 text-purple-800" : "bg-blue-100 text-blue-800"}`}>
                                      {circle.isAdmin ? "Admin" : "Member"}
                                    </span>
                                    <span className={`text-xs font-medium px-2 py-1 rounded-full ${circle.isActive ? "bg-green-100 text-green-800" : "bg-amber-100 text-amber-800"}`}>
                                      {circle.isActive ? "Active" : "Inactive"}
                                    </span>
                                  </div>
                                </div>
                                <div className="mt-2 flex items-center text-sm text-gray-500">
                                  <svg className="mr-1.5 h-4 w-4 flex-shrink-0 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                                  </svg>
                                  {circle.currentMembers} / {circle.maxMembers} members
                                </div>
                                
                                {/* Add circle ID with copy functionality */}
                                <div className="mt-2 flex items-center space-x-1 text-xs text-gray-500">
                                  <span>ID: {shortenId(circle.id)}</span>
                                  <Tooltip.Provider>
                                    <Tooltip.Root>
                                      <Tooltip.Trigger asChild>
                                        <button
                                          onClick={() => copyToClipboard(circle.id, 'circleId')}
                                          className={`text-gray-400 hover:text-blue-600 p-1 rounded-full hover:bg-blue-50 transition-colors duration-200 ${copiedCircleId === circle.id ? 'text-green-500' : ''}`}
                                          aria-label="Copy Circle ID"
                                        >
                                          <Copy size={14} />
                                        </button>
                                      </Tooltip.Trigger>
                                      <Tooltip.Portal>
                                        <Tooltip.Content
                                          className="bg-gray-800 text-white px-2 py-1 rounded text-xs"
                                          sideOffset={5}
                                        >
                                          {copiedCircleId === circle.id ? 'Copied!' : 'Copy Circle ID'}
                                          <Tooltip.Arrow className="fill-gray-800" />
                                        </Tooltip.Content>
                                      </Tooltip.Portal>
                                    </Tooltip.Root>
                                  </Tooltip.Provider>
                                  
                                  {circle.isAdmin && (
                                    <Tooltip.Provider>
                                      <Tooltip.Root>
                                        <Tooltip.Trigger asChild>
                                          <button
                                            onClick={() => copyShareLink(circle.id)}
                                            className="text-gray-400 hover:text-blue-600 p-1 rounded-full hover:bg-blue-50 transition-colors duration-200"
                                            aria-label="Copy Invite Link"
                                          >
                                            <Link size={14} />
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
                              </div>
                              
                              <div className="px-5 py-3 bg-gray-50 text-sm">
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2">
                                  <div>
                                    <p className="text-gray-500">Contribution</p>
                                    <p className="font-medium text-gray-900">
                                      <CurrencyDisplay usd={circle.contributionAmountUsd} />
                                    </p>
                                  </div>
                                  <div>
                                    <p className="text-gray-500">Cycle</p>
                                    <p className="font-medium text-gray-900">{formatCycleInfo(circle.cycleLength, circle.cycleDay)}</p>
                                  </div>
                                  <div>
                                    <p className="text-gray-500">Security Deposit</p>
                                    <p className="font-medium text-gray-900">
                                      <CurrencyDisplay usd={circle.securityDepositUsd} />
                                    </p>
                                  </div>
                                  <div>
                                    <p className="text-gray-500">Next Payout</p>
                                    <p className="font-medium text-gray-900">
                                      {circle.isActive ? formatDate(circle.nextPayoutTime) : "Activate Circle to Start"}
                                    </p>
                                  </div>
                                </div>
                              </div>
                              
                              <div className="p-4 flex justify-between bg-white border-t border-gray-100">
                                <Tooltip.Provider>
                                  <Tooltip.Root>
                                    <Tooltip.Trigger asChild>
                                      <button
                                        onClick={() => router.push(`/circle/${circle.id}`)}
                                        className="text-blue-600 hover:text-blue-800 font-medium p-2 hover:bg-blue-50 rounded-full transition-colors"
                                        aria-label="View Details"
                                      >
                                        <Eye size={18} />
                                      </button>
                                    </Tooltip.Trigger>
                                    <Tooltip.Portal>
                                      <Tooltip.Content
                                        className="bg-gray-800 text-white px-2 py-1 rounded text-xs"
                                        sideOffset={5}
                                      >
                                        View Details
                                        <Tooltip.Arrow className="fill-gray-800" />
                                      </Tooltip.Content>
                                    </Tooltip.Portal>
                                  </Tooltip.Root>
                                </Tooltip.Provider>
                                
                                <div className="flex items-center space-x-2">
                                  {circle.isAdmin && (
                                    <Tooltip.Provider>
                                      <Tooltip.Root>
                                        <Tooltip.Trigger asChild>
                                          <button
                                            onClick={() => router.push(`/circle/${circle.id}/manage`)}
                                            className="text-purple-600 hover:text-purple-800 font-medium p-2 hover:bg-purple-50 rounded-full transition-colors"
                                            aria-label="Manage Circle"
                                          >
                                            <Settings size={18} />
                                          </button>
                                        </Tooltip.Trigger>
                                        <Tooltip.Portal>
                                          <Tooltip.Content
                                            className="bg-gray-800 text-white px-2 py-1 rounded text-xs"
                                            sideOffset={5}
                                          >
                                            Manage
                                            <Tooltip.Arrow className="fill-gray-800" />
                                          </Tooltip.Content>
                                        </Tooltip.Portal>
                                      </Tooltip.Root>
                                    </Tooltip.Provider>
                                  )}
                                  
                                  {circle.isAdmin && deleteableCircles.has(circle.id) && (
                                    <Tooltip.Provider>
                                      <Tooltip.Root>
                                        <Tooltip.Trigger asChild>
                                          <button
                                            onClick={() => {
                                              console.log("Delete button clicked for circle:", circle.id);
                                              try {
                                                deleteCircle(circle.id);
                                              } catch (e) {
                                                console.error("Error in delete button click handler:", e);
                                                toast.error("Error processing delete request");
                                              }
                                            }}
                                            disabled={isDeleting === circle.id}
                                            className={`text-red-600 hover:text-red-800 font-medium p-2 hover:bg-red-50 rounded-full transition-colors ${
                                              isDeleting === circle.id ? 'opacity-50 cursor-not-allowed' : ''
                                            }`}
                                            aria-label="Delete Circle"
                                          >
                                            <Trash2 size={18} />
                                          </button>
                                        </Tooltip.Trigger>
                                        <Tooltip.Portal>
                                          <Tooltip.Content
                                            className="bg-gray-800 text-white px-2 py-1 rounded text-xs"
                                            sideOffset={5}
                                          >
                                            {isDeleting === circle.id ? 'Deleting...' : 'Delete'}
                                            <Tooltip.Arrow className="fill-gray-800" />
                                          </Tooltip.Content>
                                        </Tooltip.Portal>
                                      </Tooltip.Root>
                                    </Tooltip.Provider>
                                  )}
                                  
                                  <Tooltip.Provider>
                                    <Tooltip.Root>
                                      <Tooltip.Trigger asChild>
                                        <button
                                          onClick={() => router.push(`/circle/${circle.id}/contribute`)}
                                          className="text-green-600 hover:text-green-800 font-medium p-2 hover:bg-green-50 rounded-full transition-colors"
                                          aria-label="Contribute"
                                        >
                                          <CreditCard size={18} />
                                        </button>
                                      </Tooltip.Trigger>
                                      <Tooltip.Portal>
                                        <Tooltip.Content
                                          className="bg-gray-800 text-white px-2 py-1 rounded text-xs"
                                          sideOffset={5}
                                        >
                                          Contribute
                                          <Tooltip.Arrow className="fill-gray-800" />
                                        </Tooltip.Content>
                                      </Tooltip.Portal>
                                    </Tooltip.Root>
                                  </Tooltip.Provider>
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      </Tab.Panel>
                      
                      <Tab.Panel>
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                          {circles.filter(c => c.isAdmin).map((circle) => (
                            <div key={circle.id} className="bg-white border border-gray-200 rounded-xl overflow-hidden shadow-sm hover:shadow-md transition-shadow duration-200">
                              <div className="p-5 border-b border-gray-100">
                                <div className="flex justify-between items-start">
                                  <h3 className="text-lg font-semibold text-gray-900 line-clamp-1">{circle.name}</h3>
                                  <div className="flex space-x-1">
                                    <span className="text-xs font-medium px-2 py-1 rounded-full bg-purple-100 text-purple-800">
                                      Admin
                                    </span>
                                    <span className={`text-xs font-medium px-2 py-1 rounded-full ${circle.isActive ? "bg-green-100 text-green-800" : "bg-amber-100 text-amber-800"}`}>
                                      {circle.isActive ? "Active" : "Inactive"}
                                    </span>
                                  </div>
                                </div>
                                <div className="mt-2 flex items-center text-sm text-gray-500">
                                  <svg className="mr-1.5 h-4 w-4 flex-shrink-0 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                                  </svg>
                                  {circle.currentMembers} / {circle.maxMembers} members
                                </div>
                                
                                {/* Add circle ID with copy functionality */}
                                <div className="mt-2 flex items-center space-x-1 text-xs text-gray-500">
                                  <span>ID: {shortenId(circle.id)}</span>
                                  <Tooltip.Provider>
                                    <Tooltip.Root>
                                      <Tooltip.Trigger asChild>
                                        <button
                                          onClick={() => copyToClipboard(circle.id, 'circleId')}
                                          className={`text-gray-400 hover:text-blue-600 p-1 rounded-full hover:bg-blue-50 transition-colors duration-200 ${copiedCircleId === circle.id ? 'text-green-500' : ''}`}
                                          aria-label="Copy Circle ID"
                                        >
                                          <Copy size={14} />
                                        </button>
                                      </Tooltip.Trigger>
                                      <Tooltip.Portal>
                                        <Tooltip.Content
                                          className="bg-gray-800 text-white px-2 py-1 rounded text-xs"
                                          sideOffset={5}
                                        >
                                          {copiedCircleId === circle.id ? 'Copied!' : 'Copy Circle ID'}
                                          <Tooltip.Arrow className="fill-gray-800" />
                                        </Tooltip.Content>
                                      </Tooltip.Portal>
                                    </Tooltip.Root>
                                  </Tooltip.Provider>
                                  
                                  <Tooltip.Provider>
                                    <Tooltip.Root>
                                      <Tooltip.Trigger asChild>
                                        <button
                                          onClick={() => copyShareLink(circle.id)}
                                          className="text-gray-400 hover:text-blue-600 p-1 rounded-full hover:bg-blue-50 transition-colors duration-200"
                                          aria-label="Copy Invite Link"
                                        >
                                          <Link size={14} />
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
                              </div>
                              
                              <div className="px-5 py-3 bg-gray-50 text-sm">
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2">
                                  <div>
                                    <p className="text-gray-500">Contribution</p>
                                    <p className="font-medium text-gray-900">
                                      <CurrencyDisplay usd={circle.contributionAmountUsd} />
                                    </p>
                                  </div>
                                  <div>
                                    <p className="text-gray-500">Cycle</p>
                                    <p className="font-medium text-gray-900">{formatCycleInfo(circle.cycleLength, circle.cycleDay)}</p>
                                  </div>
                                  <div>
                                    <p className="text-gray-500">Security Deposit</p>
                                    <p className="font-medium text-gray-900">
                                      <CurrencyDisplay usd={circle.securityDepositUsd} />
                                    </p>
                                  </div>
                                  <div>
                                    <p className="text-gray-500">Next Payout</p>
                                    <p className="font-medium text-gray-900">
                                      {circle.isActive ? formatDate(circle.nextPayoutTime) : "Activate Circle to Start"}
                                    </p>
                                  </div>
                                </div>
                              </div>
                              
                              <div className="p-4 flex justify-between bg-white border-t border-gray-100">
                                <Tooltip.Provider>
                                  <Tooltip.Root>
                                    <Tooltip.Trigger asChild>
                                      <button
                                        onClick={() => router.push(`/circle/${circle.id}`)}
                                        className="text-blue-600 hover:text-blue-800 font-medium p-2 hover:bg-blue-50 rounded-full transition-colors"
                                        aria-label="View Details"
                                      >
                                        <Eye size={18} />
                                      </button>
                                    </Tooltip.Trigger>
                                    <Tooltip.Portal>
                                      <Tooltip.Content
                                        className="bg-gray-800 text-white px-2 py-1 rounded text-xs"
                                        sideOffset={5}
                                      >
                                        View Details
                                        <Tooltip.Arrow className="fill-gray-800" />
                                      </Tooltip.Content>
                                    </Tooltip.Portal>
                                  </Tooltip.Root>
                                </Tooltip.Provider>
                                
                                <div className="flex items-center space-x-2">
                                  {circle.isAdmin && (
                                    <Tooltip.Provider>
                                      <Tooltip.Root>
                                        <Tooltip.Trigger asChild>
                                          <button
                                            onClick={() => router.push(`/circle/${circle.id}/manage`)}
                                            className="text-purple-600 hover:text-purple-800 font-medium p-2 hover:bg-purple-50 rounded-full transition-colors"
                                            aria-label="Manage Circle"
                                          >
                                            <Settings size={18} />
                                          </button>
                                        </Tooltip.Trigger>
                                        <Tooltip.Portal>
                                          <Tooltip.Content
                                            className="bg-gray-800 text-white px-2 py-1 rounded text-xs"
                                            sideOffset={5}
                                          >
                                            Manage
                                            <Tooltip.Arrow className="fill-gray-800" />
                                          </Tooltip.Content>
                                        </Tooltip.Portal>
                                      </Tooltip.Root>
                                    </Tooltip.Provider>
                                  )}
                                  
                                  {circle.isAdmin && deleteableCircles.has(circle.id) && (
                                    <Tooltip.Provider>
                                      <Tooltip.Root>
                                        <Tooltip.Trigger asChild>
                                          <button
                                            onClick={() => {
                                              console.log("Delete button clicked for circle:", circle.id);
                                              try {
                                                deleteCircle(circle.id);
                                              } catch (e) {
                                                console.error("Error in delete button click handler:", e);
                                                toast.error("Error processing delete request");
                                              }
                                            }}
                                            disabled={isDeleting === circle.id}
                                            className={`text-red-600 hover:text-red-800 font-medium p-2 hover:bg-red-50 rounded-full transition-colors ${
                                              isDeleting === circle.id ? 'opacity-50 cursor-not-allowed' : ''
                                            }`}
                                            aria-label="Delete Circle"
                                          >
                                            <Trash2 size={18} />
                                          </button>
                                        </Tooltip.Trigger>
                                        <Tooltip.Portal>
                                          <Tooltip.Content
                                            className="bg-gray-800 text-white px-2 py-1 rounded text-xs"
                                            sideOffset={5}
                                          >
                                            {isDeleting === circle.id ? 'Deleting...' : 'Delete'}
                                            <Tooltip.Arrow className="fill-gray-800" />
                                          </Tooltip.Content>
                                        </Tooltip.Portal>
                                      </Tooltip.Root>
                                    </Tooltip.Provider>
                                  )}
                                  
                                  <Tooltip.Provider>
                                    <Tooltip.Root>
                                      <Tooltip.Trigger asChild>
                                        <button
                                          onClick={() => router.push(`/circle/${circle.id}/contribute`)}
                                          className="text-green-600 hover:text-green-800 font-medium p-2 hover:bg-green-50 rounded-full transition-colors"
                                          aria-label="Contribute"
                                        >
                                          <CreditCard size={18} />
                                        </button>
                                      </Tooltip.Trigger>
                                      <Tooltip.Portal>
                                        <Tooltip.Content
                                          className="bg-gray-800 text-white px-2 py-1 rounded text-xs"
                                          sideOffset={5}
                                        >
                                          Contribute
                                          <Tooltip.Arrow className="fill-gray-800" />
                                        </Tooltip.Content>
                                      </Tooltip.Portal>
                                    </Tooltip.Root>
                                  </Tooltip.Provider>
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      </Tab.Panel>
                      
                      <Tab.Panel>
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                          {circles.filter(c => !c.isAdmin).map((circle) => (
                            <div key={circle.id} className="bg-white border border-gray-200 rounded-xl overflow-hidden shadow-sm hover:shadow-md transition-shadow duration-200">
                              <div className="p-5 border-b border-gray-100">
                                <div className="flex justify-between items-start">
                                  <h3 className="text-lg font-semibold text-gray-900 line-clamp-1">{circle.name}</h3>
                                  <div className="flex space-x-1">
                                    <span className="text-xs font-medium px-2 py-1 rounded-full bg-blue-100 text-blue-800">
                                      Member
                                    </span>
                                    <span className={`text-xs font-medium px-2 py-1 rounded-full ${circle.isActive ? "bg-green-100 text-green-800" : "bg-amber-100 text-amber-800"}`}>
                                      {circle.isActive ? "Active" : "Inactive"}
                                    </span>
                                  </div>
                                </div>
                                <div className="mt-2 flex items-center text-sm text-gray-500">
                                  <svg className="mr-1.5 h-4 w-4 flex-shrink-0 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                                  </svg>
                                  {circle.currentMembers} / {circle.maxMembers} members
                                </div>
                                
                                {/* Add circle ID with copy functionality */}
                                <div className="mt-2 flex items-center space-x-1 text-xs text-gray-500">
                                  <span>ID: {shortenId(circle.id)}</span>
                                  <Tooltip.Provider>
                                    <Tooltip.Root>
                                      <Tooltip.Trigger asChild>
                                        <button
                                          onClick={() => copyToClipboard(circle.id, 'circleId')}
                                          className={`text-gray-400 hover:text-blue-600 p-1 rounded-full hover:bg-blue-50 transition-colors duration-200 ${copiedCircleId === circle.id ? 'text-green-500' : ''}`}
                                          aria-label="Copy Circle ID"
                                        >
                                          <Copy size={14} />
                                        </button>
                                      </Tooltip.Trigger>
                                      <Tooltip.Portal>
                                        <Tooltip.Content
                                          className="bg-gray-800 text-white px-2 py-1 rounded text-xs"
                                          sideOffset={5}
                                        >
                                          {copiedCircleId === circle.id ? 'Copied!' : 'Copy Circle ID'}
                                          <Tooltip.Arrow className="fill-gray-800" />
                                        </Tooltip.Content>
                                      </Tooltip.Portal>
                                    </Tooltip.Root>
                                  </Tooltip.Provider>
                                </div>
                              </div>
                              
                              <div className="px-5 py-3 bg-gray-50 text-sm">
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2">
                                  <div>
                                    <p className="text-gray-500">Contribution</p>
                                    <p className="font-medium text-gray-900">
                                      <CurrencyDisplay usd={circle.contributionAmountUsd} />
                                    </p>
                                  </div>
                                  <div>
                                    <p className="text-gray-500">Cycle</p>
                                    <p className="font-medium text-gray-900">{formatCycleInfo(circle.cycleLength, circle.cycleDay)}</p>
                                  </div>
                                  <div>
                                    <p className="text-gray-500">Security Deposit</p>
                                    <p className="font-medium text-gray-900">
                                      <CurrencyDisplay usd={circle.securityDepositUsd} />
                                    </p>
                                  </div>
                                  <div>
                                    <p className="text-gray-500">Next Payout</p>
                                    <p className="font-medium text-gray-900">
                                      {circle.isActive ? formatDate(circle.nextPayoutTime) : "Activate Circle to Start"}
                                    </p>
                                  </div>
                                </div>
                              </div>
                              
                              <div className="p-4 flex justify-between bg-white border-t border-gray-100">
                                <Tooltip.Provider>
                                  <Tooltip.Root>
                                    <Tooltip.Trigger asChild>
                                      <button
                                        onClick={() => router.push(`/circle/${circle.id}`)}
                                        className="text-blue-600 hover:text-blue-800 font-medium p-2 hover:bg-blue-50 rounded-full transition-colors"
                                        aria-label="View Details"
                                      >
                                        <Eye size={18} />
                                      </button>
                                    </Tooltip.Trigger>
                                    <Tooltip.Portal>
                                      <Tooltip.Content
                                        className="bg-gray-800 text-white px-2 py-1 rounded text-xs"
                                        sideOffset={5}
                                      >
                                        View Details
                                        <Tooltip.Arrow className="fill-gray-800" />
                                      </Tooltip.Content>
                                    </Tooltip.Portal>
                                  </Tooltip.Root>
                                </Tooltip.Provider>
                                
                                <div className="flex items-center space-x-2">
                                  {circle.isAdmin && (
                                    <Tooltip.Provider>
                                      <Tooltip.Root>
                                        <Tooltip.Trigger asChild>
                                          <button
                                            onClick={() => router.push(`/circle/${circle.id}/manage`)}
                                            className="text-purple-600 hover:text-purple-800 font-medium p-2 hover:bg-purple-50 rounded-full transition-colors"
                                            aria-label="Manage Circle"
                                          >
                                            <Settings size={18} />
                                          </button>
                                        </Tooltip.Trigger>
                                        <Tooltip.Portal>
                                          <Tooltip.Content
                                            className="bg-gray-800 text-white px-2 py-1 rounded text-xs"
                                            sideOffset={5}
                                          >
                                            Manage
                                            <Tooltip.Arrow className="fill-gray-800" />
                                          </Tooltip.Content>
                                        </Tooltip.Portal>
                                      </Tooltip.Root>
                                    </Tooltip.Provider>
                                  )}
                                  
                                  {circle.isAdmin && deleteableCircles.has(circle.id) && (
                                    <Tooltip.Provider>
                                      <Tooltip.Root>
                                        <Tooltip.Trigger asChild>
                                          <button
                                            onClick={() => {
                                              console.log("Delete button clicked for circle:", circle.id);
                                              try {
                                                deleteCircle(circle.id);
                                              } catch (e) {
                                                console.error("Error in delete button click handler:", e);
                                                toast.error("Error processing delete request");
                                              }
                                            }}
                                            disabled={isDeleting === circle.id}
                                            className={`text-red-600 hover:text-red-800 font-medium p-2 hover:bg-red-50 rounded-full transition-colors ${
                                              isDeleting === circle.id ? 'opacity-50 cursor-not-allowed' : ''
                                            }`}
                                            aria-label="Delete Circle"
                                          >
                                            <Trash2 size={18} />
                                          </button>
                                        </Tooltip.Trigger>
                                        <Tooltip.Portal>
                                          <Tooltip.Content
                                            className="bg-gray-800 text-white px-2 py-1 rounded text-xs"
                                            sideOffset={5}
                                          >
                                            {isDeleting === circle.id ? 'Deleting...' : 'Delete'}
                                            <Tooltip.Arrow className="fill-gray-800" />
                                          </Tooltip.Content>
                                        </Tooltip.Portal>
                                      </Tooltip.Root>
                                    </Tooltip.Provider>
                                  )}
                                  
                                  <Tooltip.Provider>
                                    <Tooltip.Root>
                                      <Tooltip.Trigger asChild>
                                        <button
                                          onClick={() => router.push(`/circle/${circle.id}/contribute`)}
                                          className="text-green-600 hover:text-green-800 font-medium p-2 hover:bg-green-50 rounded-full transition-colors"
                                          aria-label="Contribute"
                                        >
                                          <CreditCard size={18} />
                                        </button>
                                      </Tooltip.Trigger>
                                      <Tooltip.Portal>
                                        <Tooltip.Content
                                          className="bg-gray-800 text-white px-2 py-1 rounded text-xs"
                                          sideOffset={5}
                                        >
                                          Contribute
                                          <Tooltip.Arrow className="fill-gray-800" />
                                        </Tooltip.Content>
                                      </Tooltip.Portal>
                                    </Tooltip.Root>
                                  </Tooltip.Provider>
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      </Tab.Panel>
                    </Tab.Panels>
                  </Tab.Group>
                </div>
              ) : (
              <div className="bg-gray-50 rounded-lg p-8 text-center">
                <svg
                  className="mx-auto h-12 w-12 text-gray-400"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"
                  />
                </svg>
                <h3 className="mt-2 text-sm font-medium text-gray-900">No circles yet</h3>
                <p className="mt-1 text-sm text-gray-500">Get started by creating a new circle or joining an existing one.</p>
                <div className="mt-6 flex justify-center space-x-4">
                  <button
                    type="button"
                    onClick={() => setIsJoinDialogOpen(true)}
                    className="inline-flex items-center justify-center p-3 rounded-full text-blue-600 bg-white border border-blue-600 hover:bg-blue-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 transition-colors duration-200"
                    title="Join Existing Circle"
                  >
                    <Users className="w-6 h-6" />
                  </button>
                  <button
                    type="button"
                    onClick={() => router.push('/create-circle')}
                    className="inline-flex items-center justify-center p-3 rounded-full text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 transition-colors duration-200"
                    title="Create New Circle"
                  >
                    <svg
                      className="w-6 h-6"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="2"
                        d="M12 4v16m8-8H4"
                      />
                    </svg>
                  </button>
                </div>
              </div>
              )}
            </div>
          </div>
        </div>
      </main>
      
      {/* Join Circle Dialog */}
      <Dialog.Root open={isJoinDialogOpen} onOpenChange={setIsJoinDialogOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/30" />
          <Dialog.Content className="fixed top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 bg-white rounded-lg shadow-lg p-6 w-full max-w-md focus:outline-none">
            <div className="flex justify-between items-center mb-4">
              <Dialog.Title className="text-lg font-medium text-gray-900">
                Join a Circle
              </Dialog.Title>
              <Dialog.Close className="text-gray-400 hover:text-gray-500">
                <X className="w-5 h-5" />
              </Dialog.Close>
            </div>
            
            <form onSubmit={handleJoinCircle}>
              <div className="mt-2">
                <label htmlFor="circleId" className="block text-sm font-medium text-gray-700 mb-1">
                  Enter Circle ID or Invite Link
                </label>
                <input
                  type="text"
                  id="circleId"
                  value={circleIdInput}
                  onChange={(e) => setCircleIdInput(e.target.value)}
                  placeholder="0x123... or full invite link"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                />
                <p className="mt-1 text-sm text-gray-500">
                  Paste the circle ID or the complete invite link to join
                </p>
              </div>
              
              <div className="mt-6 flex justify-end space-x-3">
                <button
                  type="button"
                  onClick={() => setIsJoinDialogOpen(false)}
                  className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 text-sm font-medium text-white bg-blue-600 border border-transparent rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
                >
                  Join Circle
                </button>
              </div>
            </form>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {/* Render the Confirmation Modal */}
      {confirmModalProps && (
        <ConfirmationModal
          isOpen={isConfirmModalOpen}
          onClose={() => setIsConfirmModalOpen(false)}
          onConfirm={confirmModalProps.onConfirm}
          title={confirmModalProps.title}
          message={confirmModalProps.message}
          confirmText={confirmModalProps.confirmText}
          confirmButtonVariant={confirmModalProps.confirmButtonVariant}
        />
      )}

      {/* Transfer Dialog */}
      <Dialog.Root open={isTransferDialogOpen} onOpenChange={resetTransferDialog}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/50 backdrop-blur-sm" />
          <Dialog.Content className="fixed top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 bg-white rounded-xl shadow-2xl w-full max-w-md max-h-[90vh] overflow-y-auto focus:outline-none">
            
            {/* Header */}
            <div className="flex justify-between items-center p-6 border-b border-gray-200">
              <div className="flex items-center space-x-3">
                <div className="p-2 bg-blue-100 rounded-lg">
                  <Send className="w-5 h-5 text-blue-600" />
                </div>
                <div>
                  <Dialog.Title className="text-lg font-semibold text-gray-900">
                    Send Tokens
                  </Dialog.Title>
                  <p className="text-sm text-gray-500">
                    {transferStep === 'form' && 'Enter transfer details'}
                    {transferStep === 'review' && 'Review your transfer'}
                    {transferStep === 'confirm' && 'Confirming transaction...'}
                    {transferStep === 'success' && 'Transfer completed!'}
                  </p>
                </div>
              </div>
              <Dialog.Close className="text-gray-400 hover:text-gray-500 p-1 rounded-full hover:bg-gray-100 transition-colors">
                <X className="w-5 h-5" />
              </Dialog.Close>
            </div>

            {/* Progress Steps */}
            <div className="px-6 py-4 bg-gray-50">
              <div className="flex items-center justify-between">
                {['form', 'review', 'confirm', 'success'].map((step, index) => (
                  <div key={step} className="flex items-center">
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium ${
                      transferStep === step 
                        ? 'bg-blue-600 text-white' 
                        : ['review', 'confirm', 'success'].includes(transferStep) && index < ['form', 'review', 'confirm', 'success'].indexOf(transferStep)
                          ? 'bg-green-500 text-white'
                          : 'bg-gray-200 text-gray-500'
                    }`}>
                      {['review', 'confirm', 'success'].includes(transferStep) && index < ['form', 'review', 'confirm', 'success'].indexOf(transferStep) 
                        ? <CheckCircle className="w-4 h-4" />
                        : index + 1
                      }
                    </div>
                    {index < 3 && (
                      <div className={`w-12 h-0.5 mx-2 ${
                        ['review', 'confirm', 'success'].includes(transferStep) && index < ['form', 'review', 'confirm', 'success'].indexOf(transferStep)
                          ? 'bg-green-500'
                          : 'bg-gray-200'
                      }`} />
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* Form Step */}
            {transferStep === 'form' && (
              <div className="p-6 space-y-6">
                {/* Token Selection */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Select Token
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    {allCoins.map((coin) => {
                      const decimals = coin.symbol.toLowerCase() === 'usdc' ? 1000000 : 1000000000;
                      const balance = Number(coin.balance) / decimals;
                      return (
                        <button
                          key={coin.symbol}
                          onClick={() => setTransferForm(prev => ({ ...prev, selectedToken: coin.symbol }))}
                          className={`p-3 rounded-lg border-2 transition-all ${
                            transferForm.selectedToken === coin.symbol
                              ? 'border-blue-500 bg-blue-50'
                              : 'border-gray-200 hover:border-gray-300'
                          }`}
                        >
                          <div className="flex items-center space-x-2">
                            <TokenIcon symbol={coin.symbol} />
                            <div className="text-left">
                              <div className="font-medium text-sm">{coin.symbol}</div>
                              <div className="text-xs text-gray-500">
                                {balance.toFixed(coin.symbol === 'SUI' ? 4 : 2)}
                              </div>
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Recipient Address */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Recipient Address
                  </label>
                  <div className="space-y-2">
                    <input
                      type="text"
                      value={transferForm.recipientAddress}
                      onChange={(e) => setTransferForm(prev => ({ ...prev, recipientAddress: e.target.value }))}
                      placeholder="0x... or paste full address"
                      className={`w-full px-3 py-2 border rounded-lg shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                        transferValidation.errors.recipientAddress 
                          ? 'border-red-300 focus:border-red-500 focus:ring-red-500' 
                          : 'border-gray-300 focus:border-blue-500'
                      }`}
                    />
                    {transferValidation.errors.recipientAddress && (
                      <p className="text-sm text-red-600 flex items-center">
                        <AlertCircle className="w-4 h-4 mr-1" />
                        {transferValidation.errors.recipientAddress}
                      </p>
                    )}
                  </div>

                  {/* Recent Contacts */}
                  {recentContacts.length > 0 && (
                    <div className="mt-3">
                      <p className="text-xs font-medium text-gray-500 mb-2">Recent Contacts</p>
                      <div className="flex flex-wrap gap-1">
                        {recentContacts.slice(0, 3).map((contact) => (
                          <button
                            key={contact.address}
                            onClick={() => setTransferForm(prev => ({ ...prev, recipientAddress: contact.address }))}
                            className="px-2 py-1 text-xs bg-gray-100 hover:bg-gray-200 rounded-md transition-colors"
                          >
                            {contact.name || `${contact.address.slice(0, 6)}...${contact.address.slice(-4)}`}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                {/* Amount */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Amount
                  </label>
                  <div className="space-y-2">
                    <div className="relative">
                      <input
                        type="number"
                        step="any"
                        value={transferForm.amount}
                        onChange={(e) => setTransferForm(prev => ({ ...prev, amount: e.target.value }))}
                        placeholder="0.00"
                        className={`w-full px-3 py-2 pr-16 border rounded-lg shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                          transferValidation.errors.amount || transferValidation.errors.balance
                            ? 'border-red-300 focus:border-red-500 focus:ring-red-500' 
                            : 'border-gray-300 focus:border-blue-500'
                        }`}
                      />
                      <div className="absolute inset-y-0 right-0 flex items-center pr-3">
                        <span className="text-sm text-gray-500">{transferForm.selectedToken}</span>
                      </div>
                    </div>
                    
                    {/* Quick Amount Buttons */}
                    <div className="flex space-x-2">
                      {getQuickAmounts(transferForm.selectedToken).map((amount) => (
                        <button
                          key={amount}
                          onClick={() => setQuickAmount(amount)}
                          className="px-2 py-1 text-xs bg-gray-100 hover:bg-gray-200 rounded transition-colors"
                        >
                          {amount}
                        </button>
                      ))}
                      <button
                        onClick={setMaxAmount}
                        className="px-2 py-1 text-xs bg-blue-100 hover:bg-blue-200 text-blue-700 rounded transition-colors"
                      >
                        Max
                      </button>
                    </div>

                    {/* USD Value Display */}
                    {transferForm.amount && !isNaN(parseFloat(transferForm.amount)) && (
                      <div className="text-sm text-gray-500">
                        {transferForm.selectedToken === 'SUI' && suiPrice && (
                          <>≈ ${(parseFloat(transferForm.amount) * suiPrice).toFixed(2)} USD</>
                        )}
                        {transferForm.selectedToken === 'USDC' && (
                          <>≈ ${parseFloat(transferForm.amount).toFixed(2)} USD</>
                        )}
                      </div>
                    )}

                    {(transferValidation.errors.amount || transferValidation.errors.balance) && (
                      <p className="text-sm text-red-600 flex items-center">
                        <AlertCircle className="w-4 h-4 mr-1" />
                        {transferValidation.errors.amount || transferValidation.errors.balance}
                      </p>
                    )}
                  </div>
                </div>

                {/* Advanced Options */}
                <div>
                  <button
                    onClick={() => setShowAdvancedOptions(!showAdvancedOptions)}
                    className="flex items-center text-sm text-blue-600 hover:text-blue-700"
                  >
                    Advanced Options
                    <svg className={`w-4 h-4 ml-1 transition-transform ${showAdvancedOptions ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </button>
                  
                  {showAdvancedOptions && (
                    <div className="mt-3 space-y-3">
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          Memo (Optional)
                        </label>
                        <input
                          type="text"
                          value={transferForm.memo || ''}
                          onChange={(e) => setTransferForm(prev => ({ ...prev, memo: e.target.value }))}
                          placeholder="Add a note for this transfer"
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                          maxLength={100}
                        />
                      </div>
                    </div>
                  )}
                </div>

                {/* Warnings */}
                {Object.keys(transferValidation.warnings).length > 0 && (
                  <div className="space-y-2">
                    {Object.entries(transferValidation.warnings).map(([key, warning]) => (
                      <div key={key} className="flex items-start p-3 bg-amber-50 border border-amber-200 rounded-lg">
                        <Shield className="w-4 h-4 text-amber-600 mr-2 mt-0.5 flex-shrink-0" />
                        <p className="text-sm text-amber-800">{warning}</p>
                      </div>
                    ))}
                  </div>
                )}

                {/* Action Buttons */}
                <div className="flex space-x-3 pt-4">
                  <button
                    onClick={resetTransferDialog}
                    className="flex-1 px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => setTransferStep('review')}
                    disabled={!transferValidation.isValid}
                    className="flex-1 px-4 py-2 text-sm font-medium text-white bg-blue-600 border border-transparent rounded-lg hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    Review Transfer
                  </button>
                </div>
              </div>
            )}

            {/* Review Step */}
            {transferStep === 'review' && (
              <div className="p-6 space-y-6">
                <div className="bg-gray-50 rounded-lg p-4 space-y-3">
                  <h3 className="font-medium text-gray-900">Transfer Summary</h3>
                  
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span className="text-gray-500">From:</span>
                      <span className="font-mono">{shortenAddress(userAddress)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500">To:</span>
                      <span className="font-mono">{shortenAddress(transferForm.recipientAddress)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500">Amount:</span>
                      <span className="font-medium">{transferForm.amount} {transferForm.selectedToken}</span>
                    </div>
                    {transferForm.selectedToken === 'SUI' && suiPrice && (
                      <div className="flex justify-between">
                        <span className="text-gray-500">USD Value:</span>
                        <span>≈ ${(parseFloat(transferForm.amount) * suiPrice).toFixed(2)}</span>
                      </div>
                    )}
                    {transferForm.selectedToken === 'USDC' && (
                      <div className="flex justify-between">
                        <span className="text-gray-500">USD Value:</span>
                        <span>≈ ${parseFloat(transferForm.amount).toFixed(2)}</span>
                      </div>
                    )}
                    <div className="flex justify-between">
                      <span className="text-gray-500">Network:</span>
                      <span>Sui Testnet</span>
                    </div>
                    {transferForm.memo && (
                      <div className="flex justify-between">
                        <span className="text-gray-500">Memo:</span>
                        <span className="text-right max-w-32 truncate">{transferForm.memo}</span>
                      </div>
                    )}
                  </div>
                </div>

                {/* Security Checklist */}
                <div className="bg-blue-50 rounded-lg p-4">
                  <h4 className="font-medium text-blue-900 mb-2 flex items-center">
                    <Shield className="w-4 h-4 mr-2" />
                    Security Checklist
                  </h4>
                  <div className="space-y-2 text-sm text-blue-800">
                    <div className="flex items-center">
                      <CheckCircle className="w-4 h-4 mr-2 text-green-600" />
                      Recipient address format is valid
                    </div>
                    <div className="flex items-center">
                      <CheckCircle className="w-4 h-4 mr-2 text-green-600" />
                      Sufficient balance available
                    </div>
                    <div className="flex items-center">
                      <CheckCircle className="w-4 h-4 mr-2 text-green-600" />
                      Gas fees reserved (SUI transfers)
                    </div>
                  </div>
                </div>

                <div className="flex space-x-3">
                  <button
                    onClick={() => setTransferStep('form')}
                    className="flex-1 px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 transition-colors"
                  >
                    Back
                  </button>
                  <button
                    onClick={handleTransferSubmit}
                    disabled={isTransferring}
                    className="flex-1 px-4 py-2 text-sm font-medium text-white bg-blue-600 border border-transparent rounded-lg hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {isTransferring ? 'Confirming...' : 'Confirm Transfer'}
                  </button>
                </div>
              </div>
            )}

            {/* Confirm Step */}
            {transferStep === 'confirm' && (
              <div className="p-6 text-center space-y-4">
                <div className="w-16 h-16 mx-auto bg-blue-100 rounded-full flex items-center justify-center">
                  <Clock className="w-8 h-8 text-blue-600 animate-pulse" />
                </div>
                <div>
                  <h3 className="text-lg font-medium text-gray-900">Processing Transfer</h3>
                  <p className="text-sm text-gray-500 mt-1">
                    Please wait while we process your transaction on the Sui network...
                  </p>
                </div>
              </div>
            )}

            {/* Success Step */}
            {transferStep === 'success' && transferResult && (
              <div className="p-6 text-center space-y-4">
                <div className="w-16 h-16 mx-auto bg-green-100 rounded-full flex items-center justify-center">
                  <CheckCircle className="w-8 h-8 text-green-600" />
                </div>
                <div>
                  <h3 className="text-lg font-medium text-gray-900">Transfer Successful!</h3>
                  <p className="text-sm text-gray-500 mt-1">
                    Your {transferForm.amount} {transferForm.selectedToken} has been sent successfully.
                  </p>
                </div>

                {transferResult.digest && (
                  <div className="bg-gray-50 rounded-lg p-3">
                    <p className="text-xs text-gray-500 mb-1">Transaction Hash:</p>
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-xs text-gray-700">
                        {transferResult.digest.slice(0, 20)}...{transferResult.digest.slice(-10)}
                      </span>
                      <button
                        onClick={() => copyToClipboard(transferResult.digest || '')}
                        className="text-blue-600 hover:text-blue-700 p-1"
                      >
                        <Copy className="w-4 h-4" />
                      </button>
                    </div>
                    <a
                      href={`https://testnet.suivision.xyz/txblock/${transferResult.digest}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center text-xs text-blue-600 hover:text-blue-700 mt-2"
                    >
                      View on Explorer
                      <ExternalLink className="w-3 h-3 ml-1" />
                    </a>
                  </div>
                )}

                <button
                  onClick={resetTransferDialog}
                  className="w-full px-4 py-2 text-sm font-medium text-white bg-blue-600 border border-transparent rounded-lg hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 transition-colors"
                >
                  Done
                </button>
              </div>
            )}

          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
} 