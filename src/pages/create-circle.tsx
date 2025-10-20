import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import { useAuth } from '../contexts/AuthContext';
import * as Slider from '@radix-ui/react-slider';
import * as Switch from '@radix-ui/react-switch';
import * as Select from '@radix-ui/react-select';
import * as Tooltip from '@radix-ui/react-tooltip';
import { priceService } from '../services/price-service';
import { toast } from 'react-hot-toast';
import { getCurrentRpcUrl, getCurrentPackageId, getCurrentNetwork } from '../services/network-config';

// Add batch optimization imports
import { 
  getSuiClientFromPool, 
  batchQueryEvents
} from '../services/circle-service';

// Get package ID dynamically based on current network
const getPackageId = () => {
  return getCurrentPackageId() || process.env.NEXT_PUBLIC_PACKAGE_ID || '0x123';
};

// Add supported currencies directly here since they're not in price-service
export interface SupportedCurrency {
  code: string;
  name: string;
  symbol: string;
}

export const SUPPORTED_CURRENCIES: Record<string, SupportedCurrency> = {
  // Western currencies
  USD: { code: 'USD', name: 'US Dollar', symbol: '$' },
  EUR: { code: 'EUR', name: 'Euro', symbol: '€' },
  GBP: { code: 'GBP', name: 'British Pound', symbol: '£' },
  CAD: { code: 'CAD', name: 'Canadian Dollar', symbol: 'CA$' },
  // African currencies
  NGN: { code: 'NGN', name: 'Nigerian Naira', symbol: '₦' },
  ZAR: { code: 'ZAR', name: 'South African Rand', symbol: 'R' },
  GHS: { code: 'GHS', name: 'Ghanaian Cedi', symbol: '₵' },
  KES: { code: 'KES', name: 'Kenyan Shilling', symbol: 'KSh' },
  EGP: { code: 'EGP', name: 'Egyptian Pound', symbol: 'E£' },
  MAD: { code: 'MAD', name: 'Moroccan Dirham', symbol: 'د.م.' },
  XAF: { code: 'XAF', name: 'Central African CFA Franc', symbol: 'CFA' },
};

// Add currency helper functions
const getSupportedCurrencies = () => ({
  western: [
    SUPPORTED_CURRENCIES.USD,
    SUPPORTED_CURRENCIES.EUR,
    SUPPORTED_CURRENCIES.GBP,
    SUPPORTED_CURRENCIES.CAD,
  ],
  african: [
    SUPPORTED_CURRENCIES.XAF, // Central African CFA Franc
    SUPPORTED_CURRENCIES.EGP, // Egyptian Pound
    SUPPORTED_CURRENCIES.GHS, // Ghanaian Cedi
    SUPPORTED_CURRENCIES.KES, // Kenyan Shilling
    SUPPORTED_CURRENCIES.MAD, // Moroccan Dirham
    SUPPORTED_CURRENCIES.NGN, // Nigerian Naira
    SUPPORTED_CURRENCIES.ZAR, // South African Rand
  ]
});

const formatCurrency = (amount: number, currencyCode: string): string => {
  const currency = SUPPORTED_CURRENCIES[currencyCode];
  if (!currency) return `${amount.toFixed(2)} ${currencyCode}`;
  
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currencyCode,
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    // Fallback for unsupported locales
    return `${currency.symbol}${amount.toFixed(2)}`;
  }
};

// Add interface for CircleCreated event
interface CircleCreatedEvent {
  circle_id: string;
  admin: string;
  name: string;
  contribution_amount: string;
  currency_type: string;                  // Currency code (e.g., "USD", "XAF", "NGN")
  contribution_amount_local: string;      // Amount in local currency
  security_deposit_local: string;         // Amount in local currency
  max_members: string;
  cycle_length: string;
}

type CycleType = 'rotational' | 'smart-goal';
type RotationStyle = 'fixed' | 'auction-based';
type CycleLength = 'weekly' | 'bi-weekly' | 'monthly' | 'quarterly';
type WeekDay = 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday';

interface CircleFormData {
  name: string;
  selectedCurrency: string; // NEW: Selected currency code (e.g., 'USD', 'NGN')
  contributionAmount: number; // SUI amount
  contributionAmountUSD: number; // NEW: USD amount (deprecated, will be replaced by selectedCurrency amount)
  contributionAmountLocal: number; // NEW: Amount in selected currency
  cycleLength: CycleLength;
  cycleDay: number | WeekDay;
  cycleType: CycleType;
  rotationStyle?: RotationStyle;
  numberOfMembers: number;
  securityDeposit: number; // SUI amount
  securityDepositUSD: number; // NEW: USD amount (deprecated, will be replaced by selectedCurrency amount)
  securityDepositLocal: number; // NEW: Amount in selected currency
  penaltyRules: {
    latePayment: boolean;
    missedMeeting: boolean;
  };
  smartGoal?: {
    goalType: 'amount' | 'date';
    targetAmount?: number;
    targetAmountUSD?: number; // NEW: USD amount (deprecated)
    targetAmountLocal?: number; // NEW: Amount in selected currency
    targetDate?: string;
    verificationRequired: boolean;
  };
}

// Contract-specific constants
const MIN_MEMBERS = 3;
const MAX_MEMBERS = 20;

// Type conversion maps for contract interaction
const CYCLE_LENGTH_MAP = {
  weekly: 0,
  'bi-weekly': 3,
  monthly: 1,
  quarterly: 2,
} as const;

const CYCLE_TYPE_MAP = {
  rotational: 0,
  'smart-goal': 1,
  auction: 2,
} as const;

const GOAL_TYPE_MAP = {
  amount: 0,
  date: 1,
} as const;

const WEEKDAY_MAP = {
  monday: 0,
  tuesday: 1,
  wednesday: 2,
  thursday: 3,
  friday: 4,
  saturday: 5,
  sunday: 6,
} as const;

// Validation function for form data
const validateFormData = (formData: CircleFormData): string[] => {
  const errors: string[] = [];
  
  if (!formData.name) {
    errors.push('Circle name is required');
  }
  
  if (formData.contributionAmount <= 0) {
    errors.push('Contribution amount must be greater than 0');
  }
  
  if (formData.securityDeposit < formData.contributionAmount / 2) {
    errors.push('Security deposit must be at least 50% of contribution amount');
  }
  
  if (formData.numberOfMembers < MIN_MEMBERS || formData.numberOfMembers > MAX_MEMBERS) {
    errors.push(`Number of members must be between ${MIN_MEMBERS} and ${MAX_MEMBERS}`);
  }
  
  // Validate cycle day selection
  if (formData.cycleLength === 'weekly' || formData.cycleLength === 'bi-weekly') {
    // For weekly cycles, cycleDay should be a weekday string
    if (typeof formData.cycleDay !== 'string' || !['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].includes(formData.cycleDay)) {
      errors.push('Please select a day of the week');
    }
  } else {
    // For monthly/quarterly cycles, cycleDay should be a valid day number (1-28)
    if (typeof formData.cycleDay !== 'number' || formData.cycleDay < 1 || formData.cycleDay > 28) {
      errors.push('Please select a valid day of the month (1-28)');
    }
  }
  
  if (formData.cycleType === 'smart-goal' && formData.smartGoal) {
    if (formData.smartGoal.goalType === 'amount' && (!formData.smartGoal.targetAmount || formData.smartGoal.targetAmount <= 0)) {
      errors.push('Target amount must be greater than 0');
    }
    if (formData.smartGoal.goalType === 'date' && !formData.smartGoal.targetDate) {
      errors.push('Target date is required');
    }
  }
  
  return errors;
};

// Function to prepare form data for contract
const prepareCircleCreationData = (formData: CircleFormData) => {
  // Convert cycle length to contract format
  const cycle_length = CYCLE_LENGTH_MAP[formData.cycleLength];
  
  // Convert cycle day to contract format
  const cycle_day = typeof formData.cycleDay === 'string' 
    ? WEEKDAY_MAP[formData.cycleDay as WeekDay]
    : formData.cycleDay;
  
  // Convert circle type to contract format
  const circle_type = CYCLE_TYPE_MAP[formData.cycleType];
  
  // Convert goal type to Option<u8>
  const goal_type = formData.smartGoal 
    ? { some: GOAL_TYPE_MAP[formData.smartGoal.goalType] }
    : { none: null };
    
  // Convert target amount to Option<u64> (in MIST)
  const target_amount = formData.smartGoal?.goalType === 'amount' && formData.smartGoal.targetAmount
    ? { some: BigInt(Math.round(formData.smartGoal.targetAmount * 1e9)) }
    : { none: null };

  // Store the local currency values (converted to cents) - This is the primary value for the contract
  // IMPORTANT: The contract expects local currency values in cents (2 decimal places)
  // For example, $0.20 = 20 cents, ₦100.50 = 10050 kobo cents
  const contribution_amount_local = Math.floor(formData.contributionAmountLocal * 100);
  const security_deposit_local = Math.floor(formData.securityDepositLocal * 100);
  const target_amount_local = formData.smartGoal?.targetAmountLocal 
    ? Math.floor(formData.smartGoal.targetAmountLocal * 100) 
    : 0;
    
  // IMPORTANT: Also include USD equivalent values for contract validation
  // The contract uses these USD values for internal calculations and validation
  const contribution_amount_usd = Math.floor(formData.contributionAmountUSD * 100);
  const security_deposit_usd = Math.floor(formData.securityDepositUSD * 100);
  const target_amount_usd = formData.smartGoal?.targetAmountUSD 
    ? Math.floor(formData.smartGoal.targetAmountUSD * 100) 
    : 0;
    
  // Convert target date to Option<u64> (Unix timestamp in seconds)
  const target_date = formData.smartGoal?.goalType === 'date' && formData.smartGoal.targetDate
    ? { some: BigInt(Math.round(new Date(formData.smartGoal.targetDate).getTime() / 1000)) }
    : { none: null };

  // Calculate SUI amounts based on local currency values and current SUI price
  // IMPORTANT: These values are proper SUI amounts with 9 decimals (MIST)
  // Use the already-converted SUI amounts from formData which were calculated via proper currency conversion
  const contribution_amount = BigInt(Math.round(formData.contributionAmount * 1e9));
  
  // Calculate security deposit similarly
  const security_deposit = BigInt(Math.round(formData.securityDeposit * 1e9));

  // Convert penalty rules to array of booleans
  const penalty_rules = [
    formData.penaltyRules.latePayment,
    formData.penaltyRules.missedMeeting
  ];

  return {
    name: formData.name,
    contribution_amount,
    currency_type: formData.selectedCurrency,
    contribution_amount_local,
    contribution_amount_usd,
    security_deposit,
    security_deposit_local,
    security_deposit_usd,
    cycle_length,
    cycle_day,
    circle_type,
    max_members: formData.numberOfMembers,
    rotation_style: formData.rotationStyle === 'auction-based' ? 1 : 0,
    penalty_rules,
    goal_type,
    target_amount,
    target_amount_local,
    target_amount_usd,
    target_date,
    verification_required: formData.smartGoal?.verificationRequired || false,
  };
};

interface InviteMember {
  type: 'email' | 'phone';
  value: string;
  status: 'pending' | 'sent' | 'error';
}

export default function CreateCircle() {
  const router = useRouter();
  const { isAuthenticated, account, userAddress } = useAuth();
  const [currentStep, setCurrentStep] = useState(0); // Start at step 0 for circle type selection
  const [useCustomContribution, setUseCustomContribution] = useState(false);
  const [useCustomDeposit, setUseCustomDeposit] = useState(false);
  const [formData, setFormData] = useState<CircleFormData>({
    name: '',
    selectedCurrency: 'USD',
    contributionAmount: 0,
    contributionAmountUSD: 0,
    contributionAmountLocal: 0,
    cycleLength: 'monthly',
    cycleDay: 1, // Default to 1st of month/Monday
    cycleType: 'rotational', // Default to rotational
    rotationStyle: 'fixed', // Default to fixed rotation
    numberOfMembers: 3,
    securityDeposit: 0,
    securityDepositUSD: 0,
    securityDepositLocal: 0,
    penaltyRules: {
      latePayment: false,
      missedMeeting: false,
    },
  });
  const [suiPrice, setSuiPrice] = useState<number | null>(null); // Changed to allow null
  const [isPriceAvailable, setIsPriceAvailable] = useState(false);
  const [inviteMembers, setInviteMembers] = useState<InviteMember[]>([]);
  const [inviteInput, setInviteInput] = useState('');
  const [inviteType, setInviteType] = useState<'email' | 'phone'>('email');
  const [inviteLink, setInviteLink] = useState('');
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [createdCircleId, setCreatedCircleId] = useState<string | null>(null);

  useEffect(() => {
    const fetchPrice = async () => {
      const price = await priceService.getSUIPrice();
      setSuiPrice(price);
      setIsPriceAvailable(price !== null);
    };

    fetchPrice();
    // Refresh price every minute
    const interval = setInterval(fetchPrice, 60000);

    return () => clearInterval(interval);
  }, []);

  // Update conversion helpers to use selected currency with dynamic increments
  const getCurrencyIncrement = (currency: string): number => {
    // Set appropriate increments based on currency value
    const incrementMap: Record<string, number> = {
      // Western currencies - smaller increments
      USD: 20,
      EUR: 20,
      GBP: 15,
      CAD: 25,
      // African currencies - larger increments to be meaningful
      NGN: 10000,   // ₦10,000 (~$6.25)
      ZAR: 300,     // R300 (~$16)
      GHS: 250,     // ₵250 (~$21)
      KES: 2500,    // KSh2,500 (~$19)
      EGP: 500,     // ج.م500 (~$16)
      MAD: 200,     // DH200 (~$20)
      XAF: 12000,   // 12,000 FCFA (~$20)
    };
    return incrementMap[currency] || 20;
  };

  const getCurrencyMaximum = (currency: string): number => {
    // Set appropriate maximums based on currency value
    const maxMap: Record<string, number> = {
      // Western currencies
      USD: 1000,
      EUR: 1000,
      GBP: 800,
      CAD: 1300,
      // African currencies - higher maximums
      NGN: 500000,    // ₦500,000 (~$312)
      ZAR: 15000,     // R15,000 (~$800)
      GHS: 12500,     // ₵12,500 (~$1,050)
      KES: 125000,    // KSh125,000 (~$950)
      EGP: 25000,     // ج.م25,000 (~$800)
      MAD: 10000,     // DH10,000 (~$1,000)
      XAF: 600000,    // 600,000 FCFA (~$1,000)
    };
    return maxMap[currency] || 1000;
  };

  const snapToCurrencyIncrement = (localAmount: number, currency: string, forceSnap: boolean = false) => {
    const increment = getCurrencyIncrement(currency);
    if (forceSnap) {
      return Math.round(localAmount / increment) * increment;
    }
    return localAmount; // Allow any value for testnet testing
  };

  const convertLocalToSUI = async (localAmount: number) => {
    if (!isPriceAvailable) return 0;
    return await priceService.convertCurrencyToSUI(localAmount, formData.selectedCurrency);
  };

  // Update CurrencyDisplay component to use selected currency
  const SuiAmountDisplay = ({ sui, local, className = "" }: { sui: number; local: number; className?: string }) => {
    const currencyInfo = SUPPORTED_CURRENCIES[formData.selectedCurrency];
    const symbol = currencyInfo?.symbol || formData.selectedCurrency;
    
    return (
      <Tooltip.Provider>
        <Tooltip.Root>
          <Tooltip.Trigger asChild>
            <span className={`cursor-help ${className}`}>
              {symbol} {local.toFixed(2)} {isPriceAvailable ? 
                <span className="text-gray-500">({sui.toFixed(2)} SUI)</span> : 
                <span className="text-yellow-500">(SUI price unavailable)</span>}
            </span>
          </Tooltip.Trigger>
          <Tooltip.Portal>
            <Tooltip.Content
              className="bg-gray-900 text-white px-3 py-2 rounded text-sm"
              sideOffset={5}
            >
              <div className="space-y-1">
                {isPriceAvailable ? (
                  <>
                    <p>Live Conversion Rate:</p>
                    <p>1 SUI = {suiPrice ? formatCurrency(suiPrice, 'USD') : 'Loading...'}</p>
                    <p className="text-xs text-gray-400">Updates every minute</p>
                    <p className="text-xs text-blue-300">Currency: {formData.selectedCurrency}</p>
                  </>
                ) : (
                  <>
                    <p>SUI price currently unavailable</p>
                    <p className="text-xs text-gray-400">SUI conversion will be applied at transaction time</p>
                  </>
                )}
              </div>
              <Tooltip.Arrow className="fill-gray-900" />
            </Tooltip.Content>
          </Tooltip.Portal>
        </Tooltip.Root>
      </Tooltip.Provider>
    );
  };

  React.useEffect(() => {
    if (!isAuthenticated) {
      router.push('/');
    }
  }, [isAuthenticated, router]);

  // Add effect to update SUI price when currency changes
  useEffect(() => {
    const fetchPriceForCurrency = async () => {
      const price = await priceService.getSUIPrice();
      setSuiPrice(price);
      setIsPriceAvailable(price !== null);
    };

    fetchPriceForCurrency();
    // Refresh price every minute for the selected currency
    const interval = setInterval(fetchPriceForCurrency, 60000);

    return () => clearInterval(interval);
  }, [formData.selectedCurrency]);

  const handleInputChange = (name: keyof Omit<CircleFormData, 'penaltyRules'>, value: string | number) => {
    setFormData(prev => ({
      ...prev,
      [name]: value,
    }));
  };

  // New function to handle local currency amount changes and calculate SUI
  const handleLocalInputChange = async (field: 'contributionAmountLocal' | 'securityDepositLocal', value: number) => {
    const snappedValue = snapToCurrencyIncrement(value, formData.selectedCurrency);
    const suiValue = await convertLocalToSUI(snappedValue);
    
    // Convert to USD for contract storage
    let usdValue = snappedValue;
    if (formData.selectedCurrency !== 'USD') {
      try {
        usdValue = await priceService.convertToUSD(snappedValue, formData.selectedCurrency);
      } catch (error) {
        console.error('Error converting to USD:', error);
        // Fallback: use local value if conversion fails
        usdValue = snappedValue;
      }
    }
    
    if (field === 'contributionAmountLocal') {
      setFormData(prev => ({
        ...prev,
        contributionAmountLocal: snappedValue,
        contributionAmountUSD: usdValue, // Proper USD conversion
        contributionAmount: suiValue
      }));
    } else {
      setFormData(prev => ({
        ...prev,
        securityDepositLocal: snappedValue,
        securityDepositUSD: usdValue, // Proper USD conversion
        securityDeposit: suiValue
      }));
    }
  };

  const handlePenaltyChange = (name: string, checked: boolean) => {
    setFormData(prev => ({
      ...prev,
      penaltyRules: {
        ...prev.penaltyRules,
        [name]: checked,
      },
    }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    // Clear previous errors
    setValidationErrors([]);
    setError(null);
    
    // Validate form data
    const errors = validateFormData(formData);
    if (errors.length > 0) {
      setValidationErrors(errors);
      return;
    }
    
    // Check if SUI price is available
    if (!isPriceAvailable) {
      setValidationErrors(["SUI price is currently unavailable. Please try again later."]);
      return;
    }
    
    try {
      // Prepare data for contract with current SUI price
      const contractData = prepareCircleCreationData(formData);
      
      // Debug logging
      console.log("Circle Creation Data:", {
        contributionAmountUSD: formData.contributionAmountUSD.toFixed(2),
        securityDepositUSD: formData.securityDepositUSD.toFixed(2),
        suiPrice: suiPrice!.toFixed(4),
        contributionAmountMIST: contractData.contribution_amount.toString(),
        securityDepositMIST: contractData.security_deposit.toString(),
        expectedSUIAmount: (formData.contributionAmountUSD / suiPrice!).toFixed(6),
        expectedMIST: Math.round((formData.contributionAmountUSD / suiPrice!) * 1e9),
        // Add cycle debugging
        cycleLength: contractData.cycle_length,
        cycleDay: contractData.cycle_day,
        currency: contractData.currency_type
      });
      
      // Convert BigInt values to strings for JSON serialization
      const serializedData = {
        ...contractData,
        contribution_amount: contractData.contribution_amount.toString(),
        contribution_amount_local: contractData.contribution_amount_local,
        contribution_amount_usd: contractData.contribution_amount_usd,
        security_deposit: contractData.security_deposit.toString(),
        security_deposit_local: contractData.security_deposit_local,
        security_deposit_usd: contractData.security_deposit_usd,
        // Ensure cycle_day is explicitly included
        cycle_length: contractData.cycle_length,
        cycle_day: contractData.cycle_day,
        circle_type: contractData.circle_type,
        max_members: contractData.max_members,
        rotation_style: contractData.rotation_style,
        penalty_rules: contractData.penalty_rules,
        verification_required: contractData.verification_required,
        currency_type: contractData.currency_type,
        target_amount: contractData.target_amount?.some 
          ? { some: contractData.target_amount.some.toString() }
          : { none: null },
        target_amount_local: contractData.target_amount_local,
        target_amount_usd: contractData.target_amount_usd,
        target_date: contractData.target_date?.some
          ? { some: contractData.target_date.some.toString() }
          : { none: null }
      };
      
      // Call the backend to send transaction using zkLogin
      const response = await fetch('/api/zkLogin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'sendTransaction',
          account,
          circleData: serializedData,
          network: getCurrentNetwork(), // Include current network selection
        }),
      });

      const result = await response.json();

      if (!response.ok) {
        if (response.status === 401) {
          // Session expired or authentication failed, redirect to dashboard
          // Clear dashboard cache to ensure fresh data is loaded
          if (typeof window !== 'undefined' && userAddress) {
            const currentNetwork = getCurrentNetwork();
            const cacheKey = `cache_${userAddress}_${currentNetwork}_circles`;
            localStorage.removeItem(cacheKey);
          }
          router.push('/dashboard');
          return;
        }
        throw new Error(result.error || 'Transaction failed.');
      }
      
      // Store the transaction digest for reference
      if (result.digest) {
        console.log('Circle creation transaction successful:', result.digest);
      }
      
      // Move to invite step on success
      setCurrentStep(3); // Updated to step 3 for invite members
    } catch (err) {
      console.error('Error creating circle:', err);
      setError(err instanceof Error ? err.message : 'Failed to create circle. Please try again.');
    }
  };

  // Add effect to restore form data after re-authentication
  React.useEffect(() => {
    const savedFormData = sessionStorage.getItem('createCircleFormData');
    if (savedFormData) {
      try {
        setFormData(JSON.parse(savedFormData));
        sessionStorage.removeItem('createCircleFormData');
      } catch (e) {
        console.error('Error restoring form data:', e);
      }
    }
  }, []);

  // Function to fetch the actual circle ID from blockchain events
  const fetchCircleId = async (): Promise<string | null> => {
    if (!account?.userAddr) {
      throw new Error('No user address available');
    }

    try {
      // Use connection pool and batch query for better performance
      const client = getSuiClientFromPool(getCurrentRpcUrl());

      // Query for CircleCreated events using batch query
      const adminEvents = await batchQueryEvents(
        [getPackageId()],
        'CircleCreated',
        client,
        {
          maxConcurrent: 5,
          limit: 100,
          order: 'descending'
        }
      );

      console.log('Fetched circle events:', adminEvents.length);

      // Find the most recent circle created by this user
      const foundEvent = adminEvents.find(event => {
        const parsedEvent = event.parsedJson as CircleCreatedEvent;
        return parsedEvent?.admin === account.userAddr && parsedEvent?.circle_id;
      });

      if (foundEvent) {
        const parsedEvent = foundEvent.parsedJson as CircleCreatedEvent;
        console.log('Found circle ID:', parsedEvent.circle_id);
        return parsedEvent.circle_id;
      }

      throw new Error('No circle found for this user');
    } catch (error) {
      console.error('Error fetching circle ID:', error);
      throw error;
    }
  };

  const addInviteMember = async () => {
    if (inviteInput.trim()) {
      setInviteMembers([
        ...inviteMembers,
        { type: inviteType, value: inviteInput.trim(), status: 'pending' },
      ]);
      setInviteInput('');
      
      // Auto-fetch circle ID when first email is added
      if (inviteType === 'email' && !createdCircleId) {
        try {
          toast.loading('Fetching circle ID...', { id: 'fetch-circle-id' });
          const fetchedCircleId = await fetchCircleId();
          if (fetchedCircleId) {
            setCreatedCircleId(fetchedCircleId);
            const shareLink = `${window.location.origin}/circle/${fetchedCircleId}/join`;
            setInviteLink(shareLink);
            toast.success('Circle ID fetched automatically!', { id: 'fetch-circle-id' });
          } else {
            toast.error('Circle not found yet. Please try again in a moment.', { id: 'fetch-circle-id' });
          }
        } catch (error) {
          console.error('Error auto-fetching circle ID:', error);
          toast.error('Failed to fetch circle ID automatically. You can try the manual button.', { id: 'fetch-circle-id' });
        }
      }
    }
  };

  const removeInviteMember = (index: number) => {
    setInviteMembers(inviteMembers.filter((_, i) => i !== index));
  };

  const sendEmailInvite = (email: string) => {
    if (!inviteLink || !createdCircleId || !formData.name) {
      toast.error('Please fetch the circle ID first before sending invites');
      return;
    }

    const subject = `Join ${formData.name} - Njangi Savings Circle`;
    const body = `Hi there!

You've been invited to join "${formData.name}", a secure savings circle powered by blockchain technology.

Circle Details:
• Contribution: ${SUPPORTED_CURRENCIES[formData.selectedCurrency]?.symbol || formData.selectedCurrency} ${formData.contributionAmountLocal.toFixed(2)} per ${formData.cycleLength}
• Security Deposit: ${SUPPORTED_CURRENCIES[formData.selectedCurrency]?.symbol || formData.selectedCurrency} ${formData.securityDepositLocal.toFixed(2)} (one-time, refundable)
• Members: ${formData.numberOfMembers} people
• Schedule: ${formData.cycleLength} contributions

To join this circle, simply click the link below:
${inviteLink}

What is Njangi On-Chain?
Njangi is a traditional savings system where members contribute regularly and take turns receiving the full pot. Our platform uses blockchain technology to make it transparent, secure, and automated.

Benefits:
✓ Transparent and secure transactions
✓ Automated payouts
✓ No middleman fees
✓ Community-based savings

Questions? Feel free to reach out!

Best regards,
The Njangi On-Chain Team`;

    const mailtoLink = `mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    
    try {
      window.open(mailtoLink, '_self');
      
      // Update the invite status to 'sent'
      setInviteMembers(prev => 
        prev.map(member => 
          member.value === email && member.type === 'email' 
            ? { ...member, status: 'sent' as const }
            : member
        )
      );
      
      toast.success(`Email invite opened for ${email}`);
    } catch (error) {
      console.error('Error opening email client:', error);
      toast.error('Failed to open email client');
      
      // Update status to error
      setInviteMembers(prev => 
        prev.map(member => 
          member.value === email && member.type === 'email' 
            ? { ...member, status: 'error' as const }
            : member
        )
      );
    }
  };

  const sendAllEmailInvites = () => {
    const emailInvites = inviteMembers.filter(member => member.type === 'email' && member.status === 'pending');
    
    if (emailInvites.length === 0) {
      toast.error('No email invites to send');
      return;
    }

    if (!inviteLink || !createdCircleId) {
      toast.error('Please fetch the circle ID first before sending invites');
      return;
    }

    // Send emails one by one with a small delay
    emailInvites.forEach((member, index) => {
      setTimeout(() => {
        sendEmailInvite(member.value);
      }, index * 500); // 500ms delay between each email
    });
  };

  if (!isAuthenticated) {
    return null;
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <main className="max-w-3xl mx-auto py-4 sm:py-6 px-4 sm:px-6 lg:px-8">
        <h1 className="text-xl sm:text-2xl font-semibold text-blue-600 mb-4">Create New Njangi Circle</h1>
        <div className="bg-white shadow rounded-lg p-4 sm:p-6">
          {currentStep === 0 ? (
            <div className="space-y-6">
              <div className="text-center">
                <h2 className="text-2xl font-semibold text-gray-900">Choose Circle Type</h2>
                <p className="mt-2 text-gray-600">Select the type of Njangi circle you want to create</p>
              </div>
              
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mt-8">
                {/* Rotational Circle Card */}
                <button
                  onClick={() => {
                    setFormData(prev => ({ ...prev, cycleType: 'rotational' }));
                    setCurrentStep(1); // Go to currency selection step
                  }}
                  className="p-6 border rounded-lg hover:border-blue-500 hover:shadow-md transition-all text-center group"
                >
                  <div className="w-16 h-16 bg-blue-100 rounded-full flex items-center justify-center mx-auto mb-4">
                    <svg className="w-8 h-8 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                  </div>
                  <h3 className="text-xl font-medium text-gray-900 mb-2">Rotational Circle</h3>
                  <p className="text-gray-600">Members contribute regularly and take turns receiving the full pot in a predetermined order</p>
                </button>

                {/* Smart Goal Circle Card */}
                <button
                  onClick={() => {
                    // Show toast notification instead of navigating
                    toast.success("Smart Goal Circles are coming soon!", {
                      icon: "🚧",
                      duration: 3000
                    });
                  }}
                  className="p-6 border rounded-lg border-gray-300 hover:border-gray-400 transition-all text-center group relative"
                >
                  {/* Coming Soon Badge - move to top-right corner of the card instead of floating outside */}
                  <div className="absolute top-2 right-2">
                    <span className="bg-amber-500 text-white text-xs px-2 py-1 rounded-full font-medium whitespace-nowrap shadow-md">
                      Coming Soon
                    </span>
                  </div>
                  
                  {/* Reduce opacity of the overlay to make text more visible */}
                  <div className="absolute inset-0 bg-white/30 rounded-lg"></div>
                  
                  <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4 relative">
                    <svg className="w-8 h-8 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                  </div>
                  <h3 className="text-xl font-medium text-gray-900 mb-2 relative">Smart Goal Circle</h3>
                  <p className="text-gray-600 relative">Members contribute towards a shared savings goal with automatic distribution upon completion</p>
                </button>
              </div>

              {/* Cancel Button */}
              <div className="flex justify-center mt-8">
                <button
                  onClick={() => {
                    // Clear dashboard cache to ensure fresh data is loaded
                    if (typeof window !== 'undefined' && userAddress) {
                      const currentNetwork = getCurrentNetwork();
                      const cacheKey = `cache_${userAddress}_${currentNetwork}_circles`;
                      localStorage.removeItem(cacheKey);
                    }
                    router.push('/dashboard');
                  }}
                  className="group inline-flex items-center px-4 sm:px-6 py-2 sm:py-3 text-sm sm:text-base font-medium text-gray-700 bg-white border-2 border-gray-200 rounded-lg sm:rounded-xl shadow-sm hover:bg-gray-50 hover:border-gray-300 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 transition-all duration-200"
                >
                  <svg 
                    className="w-4 h-4 sm:w-5 sm:h-5 mr-2 text-gray-400 group-hover:text-gray-500 transition-colors duration-200" 
                    fill="none" 
                    viewBox="0 0 24 24" 
                    stroke="currentColor"
                  >
                    <path 
                      strokeLinecap="round" 
                      strokeLinejoin="round" 
                      strokeWidth={2} 
                      d="M11 15l-3-3m0 0l3-3m-3 3h8M3 12a9 9 0 1118 0 9 9 0 01-18 0z"
                    />
                  </svg>
                  Return to Dashboard
                </button>
              </div>
            </div>
          ) : currentStep === 1 ? (
            // NEW: Currency Selection Step
            <div className="space-y-6">
              <div className="text-center">
                <h2 className="text-2xl font-semibold text-gray-900">Choose Your Currency</h2>
                <p className="mt-2 text-gray-600">Select the currency for contributions and deposits</p>
              </div>

              {/* Currency Selection */}
              <div className="space-y-6">
                {/* Western Currencies */}
                <div>
                  <h3 className="text-lg font-medium text-gray-900 mb-4 flex items-center">
                    <div className="w-8 h-8 bg-blue-100 rounded-full flex items-center justify-center mr-3">
                      <svg className="w-4 h-4 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1" />
                      </svg>
                    </div>
                    Western Currencies
                  </h3>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {getSupportedCurrencies().western.map((currency: SupportedCurrency) => (
                      <button
                        key={currency.code}
                        onClick={() => handleInputChange('selectedCurrency', currency.code)}
                        className={`p-4 border rounded-lg text-left transition-all ${
                          formData.selectedCurrency === currency.code
                            ? 'border-blue-500 bg-blue-50 ring-1 ring-blue-500'
                            : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <div>
                            <h4 className="font-medium text-gray-900">{currency.name}</h4>
                            <p className="text-sm text-gray-500">{currency.symbol} • {currency.code}</p>
                          </div>
                          {formData.selectedCurrency === currency.code && (
                            <div className="w-5 h-5 text-blue-600">
                              <CheckIcon />
                            </div>
                          )}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>

                {/* African Currencies */}
                <div>
                  <h3 className="text-lg font-medium text-gray-900 mb-4 flex items-center">
                    <div className="w-8 h-8 bg-green-100 rounded-full flex items-center justify-center mr-3">
                      <svg className="w-4 h-4 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                    </div>
                    African Currencies
                  </h3>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {getSupportedCurrencies().african.map((currency: SupportedCurrency) => (
                      <button
                        key={currency.code}
                        onClick={() => handleInputChange('selectedCurrency', currency.code)}
                        className={`p-4 border rounded-lg text-left transition-all ${
                          formData.selectedCurrency === currency.code
                            ? 'border-blue-500 bg-blue-50 ring-1 ring-blue-500'
                            : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <div>
                            <h4 className="font-medium text-gray-900">{currency.name}</h4>
                            <p className="text-sm text-gray-500">{currency.symbol} • {currency.code}</p>
                          </div>
                          {formData.selectedCurrency === currency.code && (
                            <div className="w-5 h-5 text-blue-600">
                              <CheckIcon />
                            </div>
                          )}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Currency Information */}
                <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                  <div className="flex items-start">
                    <div className="mr-3 mt-1">
                      <svg className="h-5 w-5 text-blue-400" fill="none" viewBox="0 0 20 20" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                    </div>
                    <div className="flex-1">
                      <h4 className="text-sm font-medium text-blue-800">Stable Value Pegging</h4>
                      <p className="mt-1 text-sm text-blue-700">
                        All contributions and deposits will be pegged to your selected currency. 
                        While transactions are processed in SUI, the equivalent value in {SUPPORTED_CURRENCIES[formData.selectedCurrency]?.name || 'your currency'} remains stable, 
                        protecting members from cryptocurrency price volatility.
                      </p>
                    </div>
                  </div>
                </div>
              </div>

              {/* Navigation Buttons */}
              <div className="flex flex-col sm:flex-row justify-between pt-6 space-y-3 sm:space-y-0">
                <button
                  onClick={() => setCurrentStep(0)}
                  className="group inline-flex items-center justify-center px-4 sm:px-6 py-2 sm:py-3 text-sm sm:text-base font-medium text-gray-700 bg-white border-2 border-gray-200 rounded-lg sm:rounded-xl shadow-sm hover:bg-gray-50 hover:border-gray-300 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 transition-all duration-200"
                >
                  <svg 
                    className="w-4 h-4 sm:w-5 sm:h-5 mr-2 text-gray-400 group-hover:text-gray-500 transition-colors duration-200" 
                    fill="none" 
                    viewBox="0 0 24 24" 
                    stroke="currentColor"
                  >
                    <path 
                      strokeLinecap="round" 
                      strokeLinejoin="round" 
                      strokeWidth={2} 
                      d="M15 19l-7-7 7-7"
                    />
                  </svg>
                  Back to Circle Type
                </button>
                <button
                  onClick={() => setCurrentStep(2)} // Go to main form step
                  className="group inline-flex items-center justify-center px-4 sm:px-6 py-2 sm:py-3 text-sm sm:text-base font-medium text-white bg-blue-600 border-2 border-transparent rounded-lg sm:rounded-xl shadow-sm hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 transition-all duration-200"
                >
                  Continue to Circle Setup
                  <svg 
                    className="w-4 h-4 sm:w-5 sm:h-5 ml-2 text-blue-200 group-hover:text-white transition-colors duration-200" 
                    fill="none" 
                    viewBox="0 0 24 24" 
                    stroke="currentColor"
                  >
                    <path 
                      strokeLinecap="round" 
                      strokeLinejoin="round" 
                      strokeWidth={2} 
                      d="M9 5l7 7-7 7"
                    />
                  </svg>
                </button>
              </div>
            </div>
          ) : currentStep === 2 ? (
            <form onSubmit={handleSubmit} className="space-y-8">
              {/* Error Display */}
              {error && (
                <div className="p-4 bg-red-50 border border-red-200 rounded-md">
                  <div className="flex">
                    <div className="flex-shrink-0">
                      <svg className="h-5 w-5 text-red-400" viewBox="0 0 20 20" fill="currentColor">
                        <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
                      </svg>
                    </div>
                    <div className="ml-3">
                      <h3 className="text-sm font-medium text-red-800">Error</h3>
                      <p className="text-sm text-red-700 mt-1">{error}</p>
                    </div>
                  </div>
                </div>
              )}
              {validationErrors.length > 0 && (
                <div className="p-4 bg-yellow-50 border border-yellow-200 rounded-md">
                  <div className="flex">
                    <div className="flex-shrink-0">
                      <svg className="h-5 w-5 text-yellow-400" viewBox="0 0 20 20" fill="currentColor">
                        <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                      </svg>
                    </div>
                    <div className="ml-3">
                      <h3 className="text-sm font-medium text-yellow-800">Please fix the following issues:</h3>
                      <ul className="mt-2 text-sm text-yellow-700 list-disc list-inside">
                        {validationErrors.map((error, index) => (
                          <li key={index}>{error}</li>
                        ))}
                      </ul>
                    </div>
                  </div>
                </div>
              )}

              {/* Group Name */}
              <div className="space-y-2">
                <div className="flex items-center flex-wrap">
                  <label htmlFor="name" className="block text-sm font-medium text-gray-700">
                    Group Name
                  </label>
                  <InfoTooltip>
                    <p>Choose a unique and memorable name for your Njangi circle</p>
                    <p className="text-gray-300 text-xs mt-1">Example: &ldquo;Monthly Savings Group 2024&rdquo;</p>
                  </InfoTooltip>
                </div>
                <input
                  type="text"
                  name="name"
                  id="name"
                  required
                  value={formData.name}
                  onChange={(e) => handleInputChange('name', e.target.value)}
                  className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 bg-white"
                  placeholder="Enter your circle's name"
                />
              </div>

              {/* Contribution Amount */}
              <div className="space-y-4">
                <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center space-y-2 sm:space-y-0">
                  <div className="flex items-center flex-wrap">
                    <label className="block text-sm font-medium text-gray-700">
                      Contribution Amount
                    </label>
                    <InfoTooltip>
                      <p>The {formData.selectedCurrency} amount each member contributes per cycle</p>
                      <p className="text-gray-300 text-xs mt-1">This amount will remain stable in {formData.selectedCurrency} value</p>
                      <p className="text-gray-300 text-xs mt-1">The SUI amount will adjust based on current price</p>
                    </InfoTooltip>
                  </div>
                  <div className="flex items-center space-x-2 flex-wrap">
                    <SuiAmountDisplay 
                      sui={formData.contributionAmount}
                      local={formData.contributionAmountLocal}
                      className="text-sm text-blue-600 font-medium"
                    />
                    {useCustomContribution ? (
                      <button
                        type="button"
                        onClick={() => setUseCustomContribution(false)}
                        className="text-xs sm:text-sm text-blue-600 hover:text-blue-700 font-medium whitespace-nowrap"
                      >
                        Use Slider
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setUseCustomContribution(true)}
                        className="text-xs sm:text-sm text-blue-600 hover:text-blue-700 font-medium whitespace-nowrap"
                      >
                        Custom Amount
                      </button>
                    )}
                  </div>
                </div>
                
                {/* Currency Pegging Explanation */}
                <div className="px-3 py-2 bg-blue-50 border border-blue-200 rounded-md text-sm text-blue-700">
                  <div className="flex items-start">
                    <div className="mr-2 mt-0.5">
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                    </div>
                    <div>
                      <p className="font-medium">{formData.selectedCurrency}-Pegged Contributions</p>
                      <p className="mt-1 text-xs">All contributions and security deposits are stored in {formData.selectedCurrency} value and converted to SUI at the current exchange rate when transactions occur. This provides stability against SUI price fluctuations.</p>
                    </div>
                  </div>
                </div>
                
                {useCustomContribution ? (
                  <div className="flex items-center space-x-2">
                    <span className="text-gray-500">{SUPPORTED_CURRENCIES[formData.selectedCurrency]?.symbol || '$'}</span>
                    <input
                      type="number"
                      value={formData.contributionAmountLocal || ''}
                      onChange={async (e) => {
                        const value = e.target.value === '' ? 0 : parseFloat(e.target.value);
                        if (!isNaN(value)) {
                          await handleLocalInputChange('contributionAmountLocal', value);
                        }
                      }}
                      placeholder={`Enter amount in ${formData.selectedCurrency}`}
                      className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500"
                      min="0"
                      step="0.01"
                    />
                    <span className="text-gray-500">{formData.selectedCurrency}</span>
                  </div>
                ) : (
                  <Tooltip.Provider>
                    <Tooltip.Root>
                      <Tooltip.Trigger asChild>
                        <div className="px-2">
                          <Slider.Root
                            className="relative flex items-center select-none touch-none w-full h-5"
                            value={[formData.contributionAmountLocal]}
                            max={getCurrencyMaximum(formData.selectedCurrency)}
                            step={getCurrencyIncrement(formData.selectedCurrency)}
                            onValueChange={async ([value]) => await handleLocalInputChange('contributionAmountLocal', value)}
                          >
                            <Slider.Track className="bg-gray-200 relative grow rounded-full h-2">
                              <Slider.Range className="absolute bg-blue-500 rounded-full h-full" />
                            </Slider.Track>
                            <Slider.Thumb
                              className="block w-5 h-5 bg-white shadow-lg rounded-full border-2 border-blue-500 hover:bg-blue-50 focus:outline-none focus:ring-2 focus:ring-blue-500"
                              aria-label="Contribution amount"
                            />
                          </Slider.Root>
                        </div>
                      </Tooltip.Trigger>
                      <Tooltip.Portal>
                        <Tooltip.Content
                          className="bg-gray-900 text-white px-3 py-2 rounded text-sm"
                          sideOffset={5}
                        >
                          <div className="space-y-1">
                            <p>Drag to adjust contribution amount</p>
                            <p className="text-gray-300">
                              {SUPPORTED_CURRENCIES[formData.selectedCurrency]?.symbol || formData.selectedCurrency} {formData.contributionAmountLocal.toFixed(2)} per cycle
                            </p>
                            <p className="text-xs text-gray-400">≈ {formData.contributionAmount.toFixed(2)} SUI at current price</p>
                          </div>
                          <Tooltip.Arrow className="fill-gray-900" />
                        </Tooltip.Content>
                      </Tooltip.Portal>
                    </Tooltip.Root>
                  </Tooltip.Provider>
                )}
              </div>

              {/* Add Rotation Style selector when cycleType is rotational */}
              {formData.cycleType === 'rotational' && (
                <div className="space-y-2">
                  <div className="flex items-center flex-wrap">
                    <label className="block text-sm font-medium text-gray-700">
                      Rotation Style
                    </label>
                    <InfoTooltip>
                      <p>How the rotation order is determined</p>
                      <p className="text-gray-300 text-xs mt-1">Fixed: Members receive funds in a predetermined order</p>
                      <p className="text-gray-300 text-xs mt-1">Auction-based: Members can bid for earlier positions</p>
                    </InfoTooltip>
                  </div>
                  <Select.Root
                    value={formData.rotationStyle}
                    onValueChange={(value: RotationStyle) => handleInputChange('rotationStyle', value)}
                  >
                    <Select.Trigger
                      className="inline-flex items-center justify-between w-full px-3 py-2 text-sm bg-white border border-gray-300 rounded-md shadow-sm hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500"
                      aria-label="Rotation style"
                    >
                      <Select.Value />
                      <Select.Icon className="ml-2">
                        <ChevronDownIcon />
                      </Select.Icon>
                    </Select.Trigger>
                    <Select.Portal>
                      <Select.Content className="overflow-hidden bg-white rounded-md shadow-lg">
                        <Select.Viewport className="p-1">
                          <Select.Item
                            value="fixed"
                            className="relative flex items-center px-8 py-2 text-sm text-gray-700 rounded-md hover:bg-blue-50 hover:text-blue-700 focus:bg-blue-50 focus:text-blue-700 outline-none cursor-pointer"
                          >
                            <Select.ItemText>Fixed Order</Select.ItemText>
                            <Select.ItemIndicator className="absolute left-2 inline-flex items-center">
                              <CheckIcon />
                            </Select.ItemIndicator>
                          </Select.Item>
                          <Select.Item
                            value="auction-based"
                            className="relative flex items-center px-8 py-2 text-sm text-gray-700 rounded-md hover:bg-blue-50 hover:text-blue-700 focus:bg-blue-50 focus:text-blue-700 outline-none cursor-pointer"
                          >
                            <Select.ItemText>Auction-based</Select.ItemText>
                            <Select.ItemIndicator className="absolute left-2 inline-flex items-center">
                              <CheckIcon />
                            </Select.ItemIndicator>
                          </Select.Item>
                        </Select.Viewport>
                      </Select.Content>
                    </Select.Portal>
                  </Select.Root>
                </div>
              )}

              {/* Cycle Length Select */}
              <div className="space-y-2">
                <div className="flex items-center flex-wrap">
                  <label className="block text-sm font-medium text-gray-700">
                    Cycle Length
                  </label>
                  <InfoTooltip>
                    <p>How often the group meets and contributions are made</p>
                    <p className="text-gray-300 text-xs mt-1">Weekly: More frequent, smaller amounts</p>
                    <p className="text-gray-300 text-xs mt-1">Bi-weekly: Twice a month</p>
                    <p className="text-gray-300 text-xs mt-1">Monthly: Most common option</p>
                    <p className="text-gray-300 text-xs mt-1">Quarterly: Larger amounts, less frequent</p>
                  </InfoTooltip>
                </div>
                <Select.Root
                  value={formData.cycleLength}
                  onValueChange={(value: CycleLength) => {
                    handleInputChange('cycleLength', value);
                    // Reset cycleDay to appropriate default based on cycle length
                    // Treat bi-weekly like weekly for day selection
                    handleInputChange('cycleDay', (value === 'weekly' || value === 'bi-weekly') ? 'monday' : 1);
                  }}
                >
                  <Select.Trigger
                    className="inline-flex items-center justify-between w-full px-3 py-2 text-sm bg-white border border-gray-300 rounded-md shadow-sm hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    aria-label="Cycle length"
                  >
                    <Select.Value />
                    <Select.Icon className="ml-2">
                      <ChevronDownIcon />
                    </Select.Icon>
                  </Select.Trigger>
                  <Select.Portal>
                    <Select.Content className="overflow-hidden bg-white rounded-md shadow-lg">
                      <Select.Viewport className="p-1">
                        <Select.Item
                          value="weekly"
                          className="relative flex items-center px-8 py-2 text-sm text-gray-700 rounded-md hover:bg-blue-50 hover:text-blue-700 focus:bg-blue-50 focus:text-blue-700 outline-none cursor-pointer"
                        >
                          <Select.ItemText>Weekly</Select.ItemText>
                          <Select.ItemIndicator className="absolute left-2 inline-flex items-center">
                            <CheckIcon />
                          </Select.ItemIndicator>
                        </Select.Item>
                        <Select.Item
                          value="bi-weekly"
                          className="relative flex items-center px-8 py-2 text-sm text-gray-700 rounded-md hover:bg-blue-50 hover:text-blue-700 focus:bg-blue-50 focus:text-blue-700 outline-none cursor-pointer"
                        >
                          <Select.ItemText>Bi-weekly</Select.ItemText>
                          <Select.ItemIndicator className="absolute left-2 inline-flex items-center">
                            <CheckIcon />
                          </Select.ItemIndicator>
                        </Select.Item>
                        <Select.Item
                          value="monthly"
                          className="relative flex items-center px-8 py-2 text-sm text-gray-700 rounded-md hover:bg-blue-50 hover:text-blue-700 focus:bg-blue-50 focus:text-blue-700 outline-none cursor-pointer"
                        >
                          <Select.ItemText>Monthly</Select.ItemText>
                          <Select.ItemIndicator className="absolute left-2 inline-flex items-center">
                            <CheckIcon />
                          </Select.ItemIndicator>
                        </Select.Item>
                        <Select.Item
                          value="quarterly"
                          className="relative flex items-center px-8 py-2 text-sm text-gray-700 rounded-md hover:bg-blue-50 hover:text-blue-700 focus:bg-blue-50 focus:text-blue-700 outline-none cursor-pointer"
                        >
                          <Select.ItemText>Quarterly</Select.ItemText>
                          <Select.ItemIndicator className="absolute left-2 inline-flex items-center">
                            <CheckIcon />
                          </Select.ItemIndicator>
                        </Select.Item>
                      </Select.Viewport>
                    </Select.Content>
                  </Select.Portal>
                </Select.Root>
              </div>

              {/* Cycle Day Select */}
              <div className="space-y-2">
                <div className="flex items-center flex-wrap">
                  <label className="block text-sm font-medium text-gray-700">
                    {/* Treat bi-weekly like weekly for label */} 
                    {(formData.cycleLength === 'weekly' || formData.cycleLength === 'bi-weekly') ? 'Day of Week' : 'Day of Month'}
                  </label>
                  <InfoTooltip>
                    {/* Treat bi-weekly like weekly for tooltip */}
                    {(formData.cycleLength === 'weekly' || formData.cycleLength === 'bi-weekly') ? (
                      <p>Select which day of the week contributions are due (or meetings occur)</p>
                    ) : (
                      <>
                        <p>Select which day of the month contributions are due (or meetings occur)</p>
                        <p className="text-gray-300 text-xs mt-1">Limited to days 1-28 to ensure consistency across months</p>
                      </>
                    )}
                  </InfoTooltip>
                </div>
                <Select.Root
                  value={formData.cycleDay.toString()}
                  onValueChange={(value) => {
                    // Treat bi-weekly like weekly for value update
                    if (formData.cycleLength === 'weekly' || formData.cycleLength === 'bi-weekly') {
                      handleInputChange('cycleDay', value as WeekDay);
                    } else {
                      handleInputChange('cycleDay', parseInt(value));
                    }
                  }}
                >
                  <Select.Trigger
                    className="inline-flex items-center justify-between w-full px-3 py-2 text-sm bg-white border border-gray-300 rounded-md shadow-sm hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500"
                     /* Treat bi-weekly like weekly for aria-label */
                    aria-label={(formData.cycleLength === 'weekly' || formData.cycleLength === 'bi-weekly') ? 'Day of week' : 'Day of month'}
                  >
                    <Select.Value />
                    <Select.Icon className="ml-2">
                      <ChevronDownIcon />
                    </Select.Icon>
                  </Select.Trigger>
                  <Select.Portal>
                    <Select.Content className="overflow-hidden bg-white rounded-md shadow-lg">
                      <Select.Viewport className="p-1">
                         {/* Treat bi-weekly like weekly for options rendering */} 
                        {(formData.cycleLength === 'weekly' || formData.cycleLength === 'bi-weekly') ? (
                          // Show weekday options
                          WEEKDAYS.map(({ value, label }) => (
                            <Select.Item
                              key={value}
                              value={value}
                              className="relative flex items-center px-8 py-2 text-sm text-gray-700 rounded-md hover:bg-blue-50 hover:text-blue-700 focus:bg-blue-50 focus:text-blue-700 outline-none cursor-pointer"
                            >
                              <Select.ItemText>{label}</Select.ItemText>
                              <Select.ItemIndicator className="absolute left-2 inline-flex items-center">
                                <CheckIcon />
                              </Select.ItemIndicator>
                            </Select.Item>
                          ))
                        ) : (
                          // Show month day options (for monthly/quarterly)
                          MONTH_DAYS.map((day) => (
                            <Select.Item
                              key={day}
                              value={day.toString()}
                              className="relative flex items-center px-8 py-2 text-sm text-gray-700 rounded-md hover:bg-blue-50 hover:text-blue-700 focus:bg-blue-50 focus:text-blue-700 outline-none cursor-pointer"
                            >
                              <Select.ItemText>{day}{getDayOrdinal(day)}</Select.ItemText>
                              <Select.ItemIndicator className="absolute left-2 inline-flex items-center">
                                <CheckIcon />
                              </Select.ItemIndicator>
                            </Select.Item>
                          ))
                        )}
                      </Select.Viewport>
                    </Select.Content>
                  </Select.Portal>
                </Select.Root>
              </div>

              {/* Security Deposit */}
              <div className="space-y-4">
                <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center space-y-2 sm:space-y-0">
                  <div className="flex items-center flex-wrap">
                    <label className="block text-sm font-medium text-gray-700">
                      Security Deposit
                    </label>
                    <InfoTooltip>
                      <p>One-time deposit to ensure member commitment</p>
                      <p className="text-gray-300 text-xs mt-1">Fixed in {formData.selectedCurrency} value, converted to SUI at current price</p>
                      <p className="text-gray-300 text-xs mt-1">Refundable when leaving the circle in good standing</p>
                    </InfoTooltip>
                  </div>
                  <div className="flex items-center space-x-2 flex-wrap">
                    <SuiAmountDisplay 
                      sui={formData.securityDeposit}
                      local={formData.securityDepositLocal}
                      className="text-sm text-blue-600 font-medium"
                    />
                    {useCustomDeposit ? (
                      <button
                        type="button"
                        onClick={() => setUseCustomDeposit(false)}
                        className="text-xs sm:text-sm text-blue-600 hover:text-blue-700 font-medium whitespace-nowrap"
                      >
                        Use Slider
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setUseCustomDeposit(true)}
                        className="text-xs sm:text-sm text-blue-600 hover:text-blue-700 font-medium whitespace-nowrap"
                      >
                        Custom Amount
                      </button>
                    )}
                  </div>
                </div>
                
                {/* Currency Pegging Explanation for Security Deposit */}
                <div className="px-3 py-2 bg-green-50 border border-green-200 rounded-md text-sm text-green-700">
                  <div className="flex items-start">
                    <div className="mr-2 mt-0.5">
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                    </div>
                    <div>
                      <p className="font-medium">Stable Security Deposit</p>
                      <p className="mt-1 text-xs">The security deposit is stored as a {formData.selectedCurrency} value on-chain. Members will always deposit the same {formData.selectedCurrency} value regardless of SUI price, ensuring fairness across time.</p>
                    </div>
                  </div>
                </div>
                
                {useCustomDeposit ? (
                  <div className="flex items-center space-x-2">
                    <span className="text-gray-500">{SUPPORTED_CURRENCIES[formData.selectedCurrency]?.symbol || '$'}</span>
                    <input
                      type="number"
                      value={formData.securityDepositLocal || ''}
                      onChange={async (e) => {
                        const value = e.target.value === '' ? 0 : parseFloat(e.target.value);
                        if (!isNaN(value)) {
                          await handleLocalInputChange('securityDepositLocal', value);
                        }
                      }}
                      placeholder={`Enter amount in ${formData.selectedCurrency}`}
                      className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500"
                      min="0"
                      step="0.01"
                    />
                    <span className="text-gray-500">{formData.selectedCurrency}</span>
                  </div>
                ) : (
                  <Tooltip.Provider>
                    <Tooltip.Root>
                      <Tooltip.Trigger asChild>
                        <div className="px-2">
                          <Slider.Root
                            className="relative flex items-center select-none touch-none w-full h-5"
                            value={[formData.securityDepositLocal]}
                            max={getCurrencyMaximum(formData.selectedCurrency)}
                            step={getCurrencyIncrement(formData.selectedCurrency)}
                            onValueChange={async ([value]) => await handleLocalInputChange('securityDepositLocal', value)}
                          >
                            <Slider.Track className="bg-gray-200 relative grow rounded-full h-2">
                              <Slider.Range className="absolute bg-blue-500 rounded-full h-full" />
                            </Slider.Track>
                            <Slider.Thumb
                              className="block w-5 h-5 bg-white shadow-lg rounded-full border-2 border-blue-500 hover:bg-blue-50 focus:outline-none focus:ring-2 focus:ring-blue-500"
                              aria-label="Security deposit"
                            />
                          </Slider.Root>
                        </div>
                      </Tooltip.Trigger>
                      <Tooltip.Portal>
                        <Tooltip.Content
                          className="bg-gray-900 text-white px-3 py-2 rounded text-sm"
                          sideOffset={5}
                        >
                          <div className="space-y-1">
                            <p>Drag to adjust security deposit</p>
                            <p className="text-gray-300">
                              One-time deposit: {SUPPORTED_CURRENCIES[formData.selectedCurrency]?.symbol || formData.selectedCurrency} {formData.securityDepositLocal.toFixed(2)}
                            </p>
                            <p className="text-xs text-gray-400">≈ {formData.securityDeposit.toFixed(2)} SUI at current price</p>
                          </div>
                          <Tooltip.Arrow className="fill-gray-900" />
                        </Tooltip.Content>
                      </Tooltip.Portal>
                    </Tooltip.Root>
                  </Tooltip.Provider>
                )}
              </div>

              {/* Add Smart Goal Fields when cycleType is smart-goal */}
              {formData.cycleType === 'smart-goal' && (
                <div className="space-y-6 border-t pt-6">
                  <h3 className="text-lg font-medium text-gray-900">Smart Goal Settings</h3>
                  
                  {/* Goal Type Selection */}
                  <div className="space-y-2">
                    <div className="flex items-center">
                      <label className="block text-sm font-medium text-gray-700">
                        Goal Type
                      </label>
                      <InfoTooltip>
                        <p>Choose how you want to define your group&apos;s goal</p>
                        <p className="text-gray-300 text-xs mt-1">Amount-based: Set a specific savings target</p>
                        <p className="text-gray-300 text-xs mt-1">Date-based: Set a target completion date</p>
                      </InfoTooltip>
                    </div>
                    <Select.Root
                      value={formData.smartGoal?.goalType || 'amount'}
                      onValueChange={(value: 'amount' | 'date') => {
                        setFormData(prev => ({
                          ...prev,
                          smartGoal: {
                            ...prev.smartGoal,
                            goalType: value,
                            targetAmount: value === 'amount' ? 0 : undefined,
                            targetDate: value === 'date' ? undefined : undefined,
                            verificationRequired: prev.smartGoal?.verificationRequired || false
                          }
                        }));
                      }}
                    >
                      <Select.Trigger
                        className="inline-flex items-center justify-between w-full px-3 py-2 text-sm bg-white border border-gray-300 rounded-md shadow-sm hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500"
                        aria-label="Goal type"
                      >
                        <Select.Value />
                        <Select.Icon className="ml-2">
                          <ChevronDownIcon />
                        </Select.Icon>
                      </Select.Trigger>
                      <Select.Portal>
                        <Select.Content className="overflow-hidden bg-white rounded-md shadow-lg">
                          <Select.Viewport className="p-1">
                            <Select.Item
                              value="amount"
                              className="relative flex items-center px-8 py-2 text-sm text-gray-700 rounded-md hover:bg-blue-50 hover:text-blue-700 focus:bg-blue-50 focus:text-blue-700 outline-none cursor-pointer"
                            >
                              <Select.ItemText>Amount-based Goal</Select.ItemText>
                              <Select.ItemIndicator className="absolute left-2 inline-flex items-center">
                                <CheckIcon />
                              </Select.ItemIndicator>
                            </Select.Item>
                            <Select.Item
                              value="date"
                              className="relative flex items-center px-8 py-2 text-sm text-gray-700 rounded-md hover:bg-blue-50 hover:text-blue-700 focus:bg-blue-50 focus:text-blue-700 outline-none cursor-pointer"
                            >
                              <Select.ItemText>Date-based Goal</Select.ItemText>
                              <Select.ItemIndicator className="absolute left-2 inline-flex items-center">
                                <CheckIcon />
                              </Select.ItemIndicator>
                            </Select.Item>
                          </Select.Viewport>
                        </Select.Content>
                      </Select.Portal>
                    </Select.Root>
                  </div>

                  {/* Target Amount Field - Show when goalType is 'amount' */}
                  {formData.smartGoal?.goalType === 'amount' && (
                    <div className="space-y-2">
                      <div className="flex items-center">
                        <label className="block text-sm font-medium text-gray-700">
                          Target Amount
                        </label>
                        <InfoTooltip>
                          <p>The total {formData.selectedCurrency} amount your group aims to save</p>
                          <p className="text-gray-300 text-xs mt-1">Fixed in {formData.selectedCurrency} value, not affected by SUI price</p>
                          <p className="text-gray-300 text-xs mt-1">Must be greater than individual contribution amount</p>
                        </InfoTooltip>
                      </div>
                      <div className="flex items-center space-x-2">
                        <span className="text-gray-500">{SUPPORTED_CURRENCIES[formData.selectedCurrency]?.symbol || '$'}</span>
                        <input
                          type="number"
                          value={formData.smartGoal?.targetAmountLocal || ''}
                          onChange={async (e) => {
                            const localAmount = parseFloat(e.target.value);
                            if (!isNaN(localAmount)) {
                              // Convert to USD for contract storage
                              let usdAmount = localAmount;
                              if (formData.selectedCurrency !== 'USD') {
                                try {
                                  usdAmount = await priceService.convertToUSD(localAmount, formData.selectedCurrency);
                                } catch (error) {
                                  console.error('Error converting to USD:', error);
                                  // Fallback: use local value if conversion fails
                                  usdAmount = localAmount;
                                }
                              }
                              
                              // Convert to SUI
                              const suiAmount = await convertLocalToSUI(localAmount);
                              
                              setFormData(prev => ({
                                ...prev,
                                smartGoal: {
                                  ...prev.smartGoal!,
                                  targetAmountLocal: localAmount,
                                  targetAmountUSD: usdAmount,
                                  targetAmount: suiAmount
                                }
                              }));
                            }
                          }}
                          placeholder={`Enter target amount in ${formData.selectedCurrency}`}
                          className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500"
                          min={formData.securityDepositLocal}
                          step="100"
                        />
                        <span className="text-gray-500">{formData.selectedCurrency}</span>
                      </div>
                      <p className="text-sm text-gray-500 mt-1">
                        ≈ {formData.smartGoal?.targetAmount?.toFixed(2) || '0'} SUI at current price
                      </p>
                    </div>
                  )}

                  {/* Target Date Field - Show when goalType is 'date' */}
                  {formData.smartGoal?.goalType === 'date' && (
                    <div className="space-y-2">
                      <div className="flex items-center">
                        <label className="block text-sm font-medium text-gray-700">
                          Target Date
                        </label>
                        <InfoTooltip>
                          <p>When you want to achieve your savings goal</p>
                          <p className="text-gray-300 text-xs mt-1">Must be at least one month in the future</p>
                        </InfoTooltip>
                      </div>
                      <input
                        type="date"
                        value={formData.smartGoal?.targetDate || ''}
                        onChange={(e) => {
                          setFormData(prev => ({
                            ...prev,
                            smartGoal: {
                              ...prev.smartGoal!,
                              targetDate: e.target.value
                            }
                          }));
                        }}
                        min={new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]}
                        className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500"
                      />
                    </div>
                  )}

                  {/* Verification Required Toggle */}
                  <div className="flex items-center justify-between">
                    <div className="flex items-center">
                      <label className="text-sm text-gray-700">
                        Require Goal Verification
                      </label>
                      <InfoTooltip>
                        <p>Enable if goal completion needs admin verification</p>
                        <p className="text-gray-300 text-xs mt-1">Useful for goals tied to specific achievements</p>
                      </InfoTooltip>
                    </div>
                    <Switch.Root
                      checked={formData.smartGoal?.verificationRequired || false}
                      onCheckedChange={(checked) => {
                        setFormData(prev => ({
                          ...prev,
                          smartGoal: {
                            ...prev.smartGoal!,
                            verificationRequired: checked
                          }
                        }));
                      }}
                      className="w-11 h-6 bg-gray-200 rounded-full relative data-[state=checked]:bg-blue-500 transition-colors duration-200"
                    >
                      <Switch.Thumb className="block w-5 h-5 bg-white rounded-full shadow-lg transition-transform duration-200 transform translate-x-0.5 data-[state=checked]:translate-x-[22px]" />
                    </Switch.Root>
                  </div>
                </div>
              )}

              {/* Penalty Rules */}
              <div className="space-y-4">
                <div className="flex items-center flex-wrap">
                  <h3 className="text-sm font-medium text-gray-700">Penalty Rules</h3>
                  <InfoTooltip>
                    <p>Optional rules to maintain group discipline</p>
                    <p className="text-gray-300 text-xs mt-1">Late Payment: Charge fee for delayed contributions</p>
                    <p className="text-gray-300 text-xs mt-1">Missed Meeting: Penalty for skipping group meetings</p>
                    <p className="text-gray-300 text-xs mt-1">Penalties are deducted from security deposit</p>
                  </InfoTooltip>
                </div>
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <label
                      htmlFor="latePayment"
                      className="text-sm text-gray-700"
                    >
                      Enable Late Payment Penalties
                    </label>
                    <Switch.Root
                      id="latePayment"
                      checked={formData.penaltyRules.latePayment}
                      onCheckedChange={(checked) => handlePenaltyChange('latePayment', checked)}
                      className="w-11 h-6 bg-gray-200 rounded-full relative data-[state=checked]:bg-blue-500 transition-colors duration-200"
                    >
                      <Switch.Thumb className="block w-5 h-5 bg-white rounded-full shadow-lg transition-transform duration-200 transform translate-x-0.5 data-[state=checked]:translate-x-[22px]" />
                    </Switch.Root>
                  </div>
                  <div className="flex items-center justify-between">
                    <label
                      htmlFor="missedMeeting"
                      className="text-sm text-gray-700"
                    >
                      Enable Missed Meeting Penalties
                    </label>
                    <Switch.Root
                      id="missedMeeting"
                      checked={formData.penaltyRules.missedMeeting}
                      onCheckedChange={(checked) => handlePenaltyChange('missedMeeting', checked)}
                      className="w-11 h-6 bg-gray-200 rounded-full relative data-[state=checked]:bg-blue-500 transition-colors duration-200"
                    >
                      <Switch.Thumb className="block w-5 h-5 bg-white rounded-full shadow-lg transition-transform duration-200 transform translate-x-0.5 data-[state=checked]:translate-x-[22px]" />
                    </Switch.Root>
                  </div>
                </div>
              </div>

              {/* Final Currency Peg Summary */}
              <div className="mt-8 mb-6 border border-indigo-200 bg-indigo-50 rounded-lg p-4 text-indigo-700">
                <h3 className="font-semibold text-sm flex items-center">
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 mr-2 text-indigo-600" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M10 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16zm1-11a1 1 0 1 1-2 0v2H7a1 1 0 1 0 0 2h2v2a1 1 0 1 0 2 0v-2h2a1 1 0 1 0 0-2h-2V7z" clipRule="evenodd" />
                  </svg>
                  {formData.selectedCurrency}-Pegged Njangi Feature
                </h3>
                <div className="mt-2 text-sm">
                  <p>This circle will store all monetary values in {formData.selectedCurrency}. Key benefits:</p>
                  <ul className="mt-2 list-disc list-inside space-y-1 text-xs">
                    <li>Contribution amounts remain stable in {formData.selectedCurrency} terms regardless of SUI price</li>
                    <li>Members joining at different times pay the same real-world value</li>
                    <li>Security deposits maintain consistent value over time</li>
                    <li>The UI will always show both {formData.selectedCurrency} and equivalent SUI amounts</li>
                  </ul>
                  <p className="mt-2 text-xs">Current SUI price: {suiPrice ? formatCurrency(suiPrice, formData.selectedCurrency) : "Loading..."}</p>
                </div>
              </div>

              <div className="flex justify-end space-x-3 pt-6">
                <button
                  type="button"
                  onClick={() => router.back()}
                  className="px-4 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 transition-all duration-200"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
                >
                  Next: Invite Members
                </button>
              </div>
            </form>
          ) : (
            <div className="space-y-8">
              <div className="text-center">
                <h2 className="text-2xl font-semibold text-gray-900">Invite Members</h2>
                <p className="mt-2 text-sm text-gray-600">
                  Invite {formData.numberOfMembers - 1} members to join your Njangi circle
                </p>
              </div>

              {/* Direct Invites Section */}
              <div className="bg-white rounded-lg p-4 sm:p-6 space-y-6">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between space-y-3 sm:space-y-0">
                  <h3 className="text-lg font-medium text-gray-900">Direct Invites</h3>
                  <div className="flex items-center space-x-2 bg-gray-100 rounded-lg p-1">
                    <button
                      type="button"
                      onClick={() => setInviteType('email')}
                      className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                        inviteType === 'email'
                          ? 'bg-white text-blue-700 shadow-sm'
                          : 'text-gray-500 hover:text-gray-700'
                      }`}
                    >
                      Email
                    </button>
                    <button
                      type="button"
                      onClick={() => setInviteType('phone')}
                      className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                        inviteType === 'phone'
                          ? 'bg-white text-blue-700 shadow-sm'
                          : 'text-gray-500 hover:text-gray-700'
                      }`}
                    >
                      Phone
                    </button>
                  </div>
                </div>

                {/* Email functionality note */}
                {inviteType === 'email' && (
                  <div className="bg-blue-50 border border-blue-200 rounded-md p-3">
                    <div className="flex items-start">
                      <svg className="h-5 w-5 text-blue-400 mr-2 mt-0.5 flex-shrink-0" fill="none" viewBox="0 0 20 20" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                      <div className="text-sm text-blue-700 min-w-0">
                        <p className="font-medium">Email Invites</p>
                        <p className="mt-1">Adding an email will automatically fetch your circle ID and generate the invite link. Email invites will then open in your default email client with a pre-written message containing the circle details and join link.</p>
                      </div>
                    </div>
                  </div>
                )}

                {/* Invite Input */}
                <div className="flex flex-col sm:flex-row space-y-2 sm:space-y-0 sm:space-x-2">
                  <div className="flex-grow">
                    <label htmlFor="invite-input" className="sr-only">
                      {inviteType === 'email' ? 'Email address' : 'Phone number'}
                    </label>
                    <input
                      type={inviteType === 'email' ? 'email' : 'tel'}
                      id="invite-input"
                      value={inviteInput}
                      onChange={(e) => setInviteInput(e.target.value)}
                      onKeyPress={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          addInviteMember();
                        }
                      }}
                      placeholder={inviteType === 'email' ? 'Enter email address' : 'Enter phone number'}
                      className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 text-sm"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={addInviteMember}
                    disabled={!inviteInput.trim()}
                    className={`w-full sm:w-auto inline-flex items-center justify-center px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white transition-colors ${
                      inviteInput.trim()
                        ? 'bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500'
                        : 'bg-gray-400 cursor-not-allowed'
                    }`}
                  >
                    Add
                  </button>
                </div>

                {/* Invite List */}
                {inviteMembers.length > 0 && (
                  <div className="mt-4 space-y-2">
                    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between space-y-2 sm:space-y-0 mb-3">
                      <span className="text-sm font-medium text-gray-700">
                        Added Members ({inviteMembers.length})
                      </span>
                      {inviteMembers.some(member => member.type === 'email' && member.status === 'pending') && createdCircleId && (
                        <button
                          type="button"
                          onClick={sendAllEmailInvites}
                          className="inline-flex items-center px-3 py-1.5 border border-transparent text-xs font-medium rounded text-blue-700 bg-blue-100 hover:bg-blue-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 transition-colors"
                        >
                          <svg className="w-3 h-3 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                          </svg>
                          Send All Email Invites
                        </button>
                      )}
                    </div>
                    {inviteMembers.map((member, index) => (
                      <div
                        key={index}
                        className="flex items-center justify-between py-3 px-3 bg-gray-50 rounded-md"
                      >
                        <div className="flex items-center space-x-3 min-w-0 flex-1">
                          <span className="text-gray-500 flex-shrink-0">
                            {member.type === 'email' ? (
                              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                              </svg>
                            ) : (
                              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
                              </svg>
                            )}
                          </span>
                          <span className="text-sm font-medium text-gray-900 truncate">{member.value}</span>
                        </div>
                        <div className="flex items-center space-x-2 flex-shrink-0">
                          {member.type === 'email' && member.status === 'pending' && createdCircleId && (
                            <button
                              type="button"
                              onClick={() => sendEmailInvite(member.value)}
                              className="text-xs text-blue-600 hover:text-blue-700 font-medium whitespace-nowrap"
                            >
                              Send Email
                            </button>
                          )}
                          <span className={`text-xs whitespace-nowrap ${
                            member.status === 'sent' ? 'text-green-600' :
                            member.status === 'error' ? 'text-red-600' :
                            'text-gray-500'
                          }`}>
                            {member.status === 'sent' ? 'Sent' :
                             member.status === 'error' ? 'Failed' :
                             'Pending'}
                          </span>
                          <button
                            type="button"
                            onClick={() => removeInviteMember(index)}
                            className="text-gray-400 hover:text-red-500 p-1"
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                            </svg>
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Shareable Link Section */}
              <div className="bg-white rounded-lg p-4 sm:p-6 space-y-4">
                <h3 className="text-lg font-medium text-gray-900">Shareable Invite Link</h3>
                <p className="text-sm text-gray-500">
                  {createdCircleId 
                    ? "Your circle ID has been fetched and invite link is ready to share"
                    : "Add an email above to automatically fetch the circle ID and generate the invite link"
                  }
                </p>
                
                {/* Auto-fetch explanation - Only show when no circle ID yet */}
                {!createdCircleId && (
                  <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 sm:p-4">
                    <div className="flex items-start space-x-3">
                      <div className="flex-shrink-0">
                        <svg className="h-5 w-5 text-blue-400" fill="none" viewBox="0 0 20 20" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                      </div>
                      <div className="flex-1 min-w-0">
                        <h4 className="text-sm font-medium text-blue-800">Circle Created Successfully!</h4>
                        <p className="mt-1 text-sm text-blue-700">
                          Your circle has been created on the blockchain. When you add an email address above, we&apos;ll automatically fetch the circle ID and generate your shareable invite link.
                        </p>
                        
                        {/* Manual fetch button as fallback */}
                        <button
                          type="button"
                          onClick={async () => {
                            try {
                              toast.loading('Fetching circle ID...', { id: 'manual-fetch' });
                              const fetchedCircleId = await fetchCircleId();
                              if (fetchedCircleId) {
                                setCreatedCircleId(fetchedCircleId);
                                const shareLink = `${window.location.origin}/circle/${fetchedCircleId}/join`;
                                setInviteLink(shareLink);
                                toast.success('Circle ID fetched successfully!', { id: 'manual-fetch' });
                              } else {
                                toast.error('No circle found. Please try again in a few moments.', { id: 'manual-fetch' });
                              }
                            } catch {
                              toast.error('Failed to fetch circle ID. Please try again.', { id: 'manual-fetch' });
                            }
                          }}
                          className="mt-3 inline-flex items-center px-3 py-1.5 border border-transparent text-xs font-medium rounded text-blue-700 bg-blue-100 hover:bg-blue-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
                        >
                          <svg className="w-3 h-3 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                          </svg>
                          Or fetch manually
                        </button>
                      </div>
                    </div>
                  </div>
                )}
                
                {/* Invite Link Display - Only show after circle ID is fetched */}
                {createdCircleId && (
                  <div className="space-y-3">
                    {/* Circle ID Display - Mobile Responsive */}
                    <div className="bg-green-50 border border-green-200 rounded-lg p-3">
                      <div className="flex items-start space-x-2">
                        <svg className="h-5 w-5 text-green-400 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 20 20" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                        <div className="min-w-0 flex-1">
                          <span className="text-sm font-medium text-green-800 block mb-1">Circle ID:</span>
                          <div className="bg-white rounded border p-2">
                            <code className="text-xs text-gray-800 break-all font-mono leading-relaxed">
                              {createdCircleId}
                            </code>
                          </div>
                        </div>
                      </div>
                    </div>
                    
                    {/* Invite Link Input - Mobile Responsive */}
                    <div className="space-y-2">
                      <label className="text-sm font-medium text-gray-700 block">Invite Link:</label>
                      <div className="flex flex-col sm:flex-row space-y-2 sm:space-y-0 sm:space-x-2">
                        <div className="flex-grow">
                          <input
                            type="text"
                            readOnly
                            value={inviteLink || ''}
                            className="block w-full rounded-md border-gray-300 bg-gray-50 shadow-sm focus:border-blue-500 focus:ring-blue-500 text-sm"
                          />
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            if (inviteLink) {
                              navigator.clipboard.writeText(inviteLink)
                                .then(() => {
                                  toast.success('Invite link copied to clipboard!');
                                })
                                .catch(() => {
                                  toast.error('Failed to copy invite link');
                                });
                            }
                          }}
                          className="w-full sm:w-auto px-4 py-2 text-sm font-medium text-blue-600 bg-blue-50 border border-blue-200 rounded-md hover:bg-blue-100 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 transition-colors"
                        >
                          Copy Link
                        </button>
                      </div>
                    </div>
                  </div>
                )}
                
                {/* Show placeholder when no circle ID yet */}
                {!createdCircleId && (
                  <div className="space-y-2">
                    <label className="text-sm font-medium text-gray-700 block">Invite Link:</label>
                    <div className="flex-grow">
                      <input
                        type="text"
                        readOnly
                        value="Add an email address above to automatically generate your invite link..."
                        className="block w-full rounded-md border-gray-300 bg-gray-100 text-gray-500 shadow-sm text-sm"
                      />
                    </div>
                  </div>
                )}
              </div>

              {/* Action Buttons */}
              <div className="flex flex-col sm:flex-row justify-between pt-6 space-y-3 sm:space-y-0 sm:space-x-3">
                <Tooltip.Provider>
                  <Tooltip.Root>
                    <Tooltip.Trigger asChild>
                      <button
                        type="button"
                        disabled
                        className="w-full sm:w-auto px-4 py-2 border border-gray-200 rounded-md shadow-sm text-sm font-medium text-gray-400 bg-gray-50 cursor-not-allowed"
                      >
                        Back
                      </button>
                    </Tooltip.Trigger>
                    <Tooltip.Portal>
                      <Tooltip.Content
                        className="bg-gray-900 text-white px-3 py-2 rounded text-sm max-w-xs"
                        sideOffset={5}
                      >
                        <p>Circle already created. Going back is not allowed to prevent duplicate creation.</p>
                        <Tooltip.Arrow className="fill-gray-900" />
                      </Tooltip.Content>
                    </Tooltip.Portal>
                  </Tooltip.Root>
                </Tooltip.Provider>
                <button
                  type="button"
                  onClick={() => {
                    // Send all pending email invites first
                    const emailInvites = inviteMembers.filter(member => member.type === 'email' && member.status === 'pending');
                    if (emailInvites.length > 0 && createdCircleId) {
                      sendAllEmailInvites();
                      toast.success(`Opened ${emailInvites.length} email invites in your email client`);
                    }
                    
                    // Clear dashboard cache to ensure fresh data is loaded
                    if (typeof window !== 'undefined' && userAddress) {
                      // Clear circles cache for the current network
                      const currentNetwork = getCurrentNetwork();
                      const cacheKey = `cache_${userAddress}_${currentNetwork}_circles`;
                      localStorage.removeItem(cacheKey);
                      
                      // Also clear events cache to get fresh data
                      const eventsCachePattern = `cache_${userAddress}_${currentNetwork}_events`;
                      for (let i = 0; i < localStorage.length; i++) {
                        const key = localStorage.key(i);
                        if (key && key.startsWith(eventsCachePattern)) {
                          localStorage.removeItem(key);
                        }
                      }
                    }
                    
                    // Then redirect to dashboard with delay to allow blockchain processing
                    setTimeout(() => {
                      router.push('/dashboard?refreshCircles=true');
                    }, 3000); // Increased delay to allow blockchain to process transaction
                  }}
                  className="w-full sm:w-auto px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
                >
                  {inviteMembers.filter(member => member.type === 'email' && member.status === 'pending').length > 0 && createdCircleId
                    ? 'Send Email Invites & Finish'
                    : 'Finish & Go to Dashboard'
                  }
                </button>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

// Icons
const ChevronDownIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M2.5 4L6 7.5L9.5 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

const CheckIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M10 3L4.5 8.5L2 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

// Add this helper function at the bottom with other utility functions
const getDayOrdinal = (day: number): string => {
  if (day > 3 && day < 21) return 'th';
  switch (day % 10) {
    case 1: return 'st';
    case 2: return 'nd';
    case 3: return 'rd';
    default: return 'th';
  }
};


// Add InfoIcon component
const InfoIcon = () => (
  <svg 
    width="14" 
    height="14" 
    viewBox="0 0 16 16" 
    fill="none" 
    xmlns="http://www.w3.org/2000/svg"
    className="text-gray-400 hover:text-gray-500 w-3.5 h-3.5 sm:w-4 sm:h-4"
  >
    <path 
      d="M8 16A8 8 0 1 1 8 0a8 8 0 0 1 0 16zm0-1.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13z" 
      fill="currentColor"
    />
    <path 
      d="M8 4a1 1 0 1 1 0-2 1 1 0 0 1 0 2zm0 9a1 1 0 0 1-1-1V7a1 1 0 1 0 2 0v5a1 1 0 0 1-1 1z" 
      fill="currentColor"
    />
  </svg>
);

const InfoTooltip = ({ children }: { children: React.ReactNode }) => (
  <Tooltip.Provider>
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <span className="ml-1 sm:ml-1.5 inline-flex items-center cursor-help">
          <InfoIcon />
        </span>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          className="bg-gray-900 text-white px-2 sm:px-3 py-1.5 sm:py-2 rounded text-xs sm:text-sm max-w-xs z-50"
          sideOffset={5}
        >
          <div className="space-y-1">
            {children}
          </div>
          <Tooltip.Arrow className="fill-gray-900" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  </Tooltip.Provider>
);

// Add helper constants
const WEEKDAYS: { value: WeekDay; label: string }[] = [
  { value: 'monday', label: 'Monday' },
  { value: 'tuesday', label: 'Tuesday' },
  { value: 'wednesday', label: 'Wednesday' },
  { value: 'thursday', label: 'Thursday' },
  { value: 'friday', label: 'Friday' },
  { value: 'saturday', label: 'Saturday' },
  { value: 'sunday', label: 'Sunday' },
];

const MONTH_DAYS = Array.from({ length: 28 }, (_, i) => i + 1); 