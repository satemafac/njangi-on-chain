import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import { useAuth } from '../contexts/AuthContext';
import * as Slider from '@radix-ui/react-slider';
import * as Switch from '@radix-ui/react-switch';
import * as Select from '@radix-ui/react-select';
import * as Tooltip from '@radix-ui/react-tooltip';
import { priceService } from '../services/price-service';

type CycleType = 'rotational' | 'smart-goal';
type RotationStyle = 'fixed' | 'auction-based';
type CycleLength = 'weekly' | 'bi-weekly' | 'monthly' | 'quarterly';
type WeekDay = 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday';

interface CircleFormData {
  name: string;
  contributionAmount: number; // SUI amount
  contributionAmountUSD: number; // NEW: USD amount
  cycleLength: CycleLength;
  cycleDay: number | WeekDay;
  cycleType: CycleType;
  rotationStyle?: RotationStyle;
  numberOfMembers: number;
  securityDeposit: number; // SUI amount
  securityDepositUSD: number; // NEW: USD amount
  penaltyRules: {
    latePayment: boolean;
    missedMeeting: boolean;
  };
  smartGoal?: {
    goalType: 'amount' | 'date';
    targetAmount?: number;
    targetAmountUSD?: number; // NEW: USD amount
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
const prepareCircleCreationData = (formData: CircleFormData, suiPrice: number) => {
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

  // Store the USD values (converted to cents) - This is the primary value for the contract
  // IMPORTANT: The contract expects USD values in cents (2 decimal places)
  // For example, $0.20 = 20 cents, $10.50 = 1050 cents
  const contribution_amount_usd = Math.floor(formData.contributionAmountUSD * 100);
  const security_deposit_usd = Math.floor(formData.securityDepositUSD * 100);
  const target_amount_usd = formData.smartGoal?.targetAmountUSD 
    ? Math.floor(formData.smartGoal.targetAmountUSD * 100) 
    : 0;
    
  // Convert target date to Option<u64> (Unix timestamp in seconds)
  const target_date = formData.smartGoal?.goalType === 'date' && formData.smartGoal.targetDate
    ? { some: BigInt(Math.round(new Date(formData.smartGoal.targetDate).getTime() / 1000)) }
    : { none: null };

  // Calculate SUI amounts based on USD values and current SUI price
  // IMPORTANT: These values are proper SUI amounts with 9 decimals (MIST)
  // For example, if $0.20 USD = 0.0575 SUI, then it would be 57,500,000 MIST (0.0575 * 1e9)
  // The contract expects values in MIST format (9 decimals)
  const contribution_amount = BigInt(Math.round((formData.contributionAmountUSD / suiPrice) * 1e9));
  
  // Calculate security deposit similarly
  const security_deposit = BigInt(Math.round((formData.securityDepositUSD / suiPrice) * 1e9));

  // Convert penalty rules to array of booleans
  const penalty_rules = [
    formData.penaltyRules.latePayment,
    formData.penaltyRules.missedMeeting
  ];

  return {
    name: formData.name,
    contribution_amount,
    contribution_amount_usd,
    security_deposit,
    security_deposit_usd,
    cycle_length,
    cycle_day,
    circle_type,
    max_members: formData.numberOfMembers,
    rotation_style: formData.rotationStyle === 'auction-based' ? 1 : 0,
    penalty_rules,
    goal_type,
    target_amount,
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
  const { isAuthenticated, account } = useAuth();
  const [currentStep, setCurrentStep] = useState(0); // Start at step 0 for circle type selection
  const [useCustomContribution, setUseCustomContribution] = useState(false);
  const [useCustomDeposit, setUseCustomDeposit] = useState(false);
  const [formData, setFormData] = useState<CircleFormData>({
    name: '',
    contributionAmount: 0,
    contributionAmountUSD: 0,
    cycleLength: 'monthly',
    cycleDay: 1, // Default to 1st of month/Monday
    cycleType: 'rotational', // Default to rotational
    rotationStyle: 'fixed', // Default to fixed rotation
    numberOfMembers: 3,
    securityDeposit: 0,
    securityDepositUSD: 0,
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
  const [showCopiedToast, setShowCopiedToast] = useState(false);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

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

  // Update conversion helpers to allow precise values for testnet
  const snapToTwentyDollars = (usdAmount: number, forceSnap: boolean = false) => {
    if (forceSnap) {
      return Math.round(usdAmount / 20) * 20; // Snap to nearest $20
    }
    return usdAmount; // Allow any value for testnet testing
  };

  const convertUSDtoSUI = (usdAmount: number) => {
    if (!isPriceAvailable || suiPrice === null) return 0;
    return Number((usdAmount / suiPrice).toFixed(6));
  };

  // Update CurrencyDisplay component to use live price
  const SuiAmountDisplay = ({ sui, usd, className = "" }: { sui: number; usd: number; className?: string }) => {
    return (
      <Tooltip.Provider>
        <Tooltip.Root>
          <Tooltip.Trigger asChild>
            <span className={`cursor-help ${className}`}>
              {formatUSD(usd)} {isPriceAvailable ? 
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
                    <p>1 SUI = {formatUSD(suiPrice!)}</p>
                    <p className="text-xs text-gray-400">Updates every minute</p>
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

  const handleInputChange = (name: keyof Omit<CircleFormData, 'penaltyRules'>, value: string | number) => {
    setFormData(prev => ({
      ...prev,
      [name]: value,
    }));
  };

  // New function to handle USD amount changes and calculate SUI
  const handleUSDInputChange = (field: 'contributionAmountUSD' | 'securityDepositUSD', value: number) => {
    const snappedValue = snapToTwentyDollars(value);
    const suiValue = convertUSDtoSUI(snappedValue);
    
    if (field === 'contributionAmountUSD') {
      setFormData(prev => ({
        ...prev,
        contributionAmountUSD: snappedValue,
        contributionAmount: suiValue
      }));
    } else {
      setFormData(prev => ({
        ...prev,
        securityDepositUSD: snappedValue,
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
      const contractData = prepareCircleCreationData(formData, suiPrice!);
      
      // Debug logging
      console.log("Circle Creation Data:", {
        contributionAmountUSD: formData.contributionAmountUSD.toFixed(2),
        securityDepositUSD: formData.securityDepositUSD.toFixed(2),
        suiPrice: suiPrice!.toFixed(4),
        contributionAmountMIST: contractData.contribution_amount.toString(),
        securityDepositMIST: contractData.security_deposit.toString(),
        expectedSUIAmount: (formData.contributionAmountUSD / suiPrice!).toFixed(6),
        expectedMIST: Math.round((formData.contributionAmountUSD / suiPrice!) * 1e9)
      });
      
      // Convert BigInt values to strings for JSON serialization
      const serializedData = {
        ...contractData,
        contribution_amount: contractData.contribution_amount.toString(),
        contribution_amount_usd: contractData.contribution_amount_usd,
        security_deposit: contractData.security_deposit.toString(),
        security_deposit_usd: contractData.security_deposit_usd,
        target_amount: contractData.target_amount?.some 
          ? { some: contractData.target_amount.some.toString() }
          : { none: null },
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
        }),
      });

      const result = await response.json();

      if (!response.ok) {
        if (response.status === 401) {
          // Session expired or authentication failed, redirect to dashboard
          router.push('/dashboard');
          return;
        }
        throw new Error(result.error || 'Transaction failed.');
      }
      
      // Move to invite step on success
      setCurrentStep(2);
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

  if (!isAuthenticated) {
    return null;
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <main className="max-w-3xl mx-auto py-6 sm:px-6 lg:px-8">
        <h1 className="text-2xl font-semibold text-blue-600 mb-4 px-4">Create New Njangi Circle</h1>
        <div className="bg-white shadow rounded-lg p-6">
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
                    setCurrentStep(1);
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
                    setFormData(prev => ({ ...prev, cycleType: 'smart-goal' }));
                    setCurrentStep(1);
                  }}
                  className="p-6 border rounded-lg hover:border-blue-500 hover:shadow-md transition-all text-center group"
                >
                  <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
                    <svg className="w-8 h-8 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                  </div>
                  <h3 className="text-xl font-medium text-gray-900 mb-2">Smart Goal Circle</h3>
                  <p className="text-gray-600">Members contribute towards a shared savings goal with automatic distribution upon completion</p>
                </button>
              </div>

              {/* Cancel Button */}
              <div className="flex justify-center mt-8">
                <button
                  onClick={() => router.push('/dashboard')}
                  className="group inline-flex items-center px-6 py-3 text-base font-medium text-gray-700 bg-white border-2 border-gray-200 rounded-xl shadow-sm hover:bg-gray-50 hover:border-gray-300 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 transition-all duration-200"
                >
                  <svg 
                    className="w-5 h-5 mr-2 text-gray-400 group-hover:text-gray-500 transition-colors duration-200" 
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
                <div className="flex items-center">
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
                <div className="flex justify-between items-center">
                  <div className="flex items-center">
                    <label className="block text-sm font-medium text-gray-700">
                      Contribution Amount
                    </label>
                    <InfoTooltip>
                      <p>The USD amount each member contributes per cycle</p>
                      <p className="text-gray-300 text-xs mt-1">This amount will remain stable in USD value</p>
                      <p className="text-gray-300 text-xs mt-1">The SUI amount will adjust based on current price</p>
                    </InfoTooltip>
                  </div>
                  <div className="flex items-center space-x-2">
                    <SuiAmountDisplay 
                      sui={formData.contributionAmount}
                      usd={formData.contributionAmountUSD}
                      className="text-sm text-blue-600 font-medium"
                    />
                    {useCustomContribution ? (
                      <button
                        type="button"
                        onClick={() => setUseCustomContribution(false)}
                        className="text-sm text-blue-600 hover:text-blue-700 font-medium"
                      >
                        Use Slider
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setUseCustomContribution(true)}
                        className="text-sm text-blue-600 hover:text-blue-700 font-medium"
                      >
                        Custom Amount
                      </button>
                    )}
                  </div>
                </div>
                
                {/* USD Pegging Explanation */}
                <div className="px-3 py-2 bg-blue-50 border border-blue-200 rounded-md text-sm text-blue-700">
                  <div className="flex items-start">
                    <div className="mr-2 mt-0.5">
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                    </div>
                    <div>
                      <p className="font-medium">USD-Pegged Contributions</p>
                      <p className="mt-1 text-xs">All contributions and security deposits are stored in USD value and converted to SUI at the current exchange rate when transactions occur. This provides stability against SUI price fluctuations.</p>
                    </div>
                  </div>
                </div>
                
                {useCustomContribution ? (
                  <div className="flex items-center space-x-2">
                    <span className="text-gray-500">$</span>
                    <input
                      type="number"
                      value={formData.contributionAmountUSD || ''}
                      onChange={(e) => {
                        const value = e.target.value === '' ? 0 : parseFloat(e.target.value);
                        if (!isNaN(value)) {
                          handleUSDInputChange('contributionAmountUSD', value);
                        }
                      }}
                      placeholder="Enter amount in USD"
                      className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500"
                      min="0"
                      step="0.01"
                    />
                    <span className="text-gray-500">USD</span>
                  </div>
                ) : (
                  <Tooltip.Provider>
                    <Tooltip.Root>
                      <Tooltip.Trigger asChild>
                        <div className="px-2">
                          <Slider.Root
                            className="relative flex items-center select-none touch-none w-full h-5"
                            value={[formData.contributionAmountUSD]}
                            max={1000} // $1000 USD max
                            step={20} // $20 USD increments
                            onValueChange={([value]) => handleUSDInputChange('contributionAmountUSD', value)}
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
                              {formatUSD(formData.contributionAmountUSD)} per cycle
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
                  <div className="flex items-center">
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
                <div className="flex items-center">
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
                <div className="flex items-center">
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
                <div className="flex justify-between items-center">
                  <div className="flex items-center">
                    <label className="block text-sm font-medium text-gray-700">
                      Security Deposit
                    </label>
                    <InfoTooltip>
                      <p>One-time deposit to ensure member commitment</p>
                      <p className="text-gray-300 text-xs mt-1">Fixed in USD value, converted to SUI at current price</p>
                      <p className="text-gray-300 text-xs mt-1">Refundable when leaving the circle in good standing</p>
                    </InfoTooltip>
                  </div>
                  <div className="flex items-center space-x-2">
                    <SuiAmountDisplay 
                      sui={formData.securityDeposit}
                      usd={formData.securityDepositUSD}
                      className="text-sm text-blue-600 font-medium"
                    />
                    {useCustomDeposit ? (
                      <button
                        type="button"
                        onClick={() => setUseCustomDeposit(false)}
                        className="text-sm text-blue-600 hover:text-blue-700 font-medium"
                      >
                        Use Slider
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setUseCustomDeposit(true)}
                        className="text-sm text-blue-600 hover:text-blue-700 font-medium"
                      >
                        Custom Amount
                      </button>
                    )}
                  </div>
                </div>
                
                {/* USD Pegging Explanation for Security Deposit */}
                <div className="px-3 py-2 bg-green-50 border border-green-200 rounded-md text-sm text-green-700">
                  <div className="flex items-start">
                    <div className="mr-2 mt-0.5">
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                    </div>
                    <div>
                      <p className="font-medium">Stable Security Deposit</p>
                      <p className="mt-1 text-xs">The security deposit is stored as a USD value on-chain. Members will always deposit the same USD value regardless of SUI price, ensuring fairness across time.</p>
                    </div>
                  </div>
                </div>
                
                {useCustomDeposit ? (
                  <div className="flex items-center space-x-2">
                    <span className="text-gray-500">$</span>
                    <input
                      type="number"
                      value={formData.securityDepositUSD || ''}
                      onChange={(e) => {
                        const value = e.target.value === '' ? 0 : parseFloat(e.target.value);
                        if (!isNaN(value)) {
                          handleUSDInputChange('securityDepositUSD', value);
                        }
                      }}
                      placeholder="Enter amount in USD"
                      className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500"
                      min="0"
                      step="0.01"
                    />
                    <span className="text-gray-500">USD</span>
                  </div>
                ) : (
                  <Tooltip.Provider>
                    <Tooltip.Root>
                      <Tooltip.Trigger asChild>
                        <div className="px-2">
                          <Slider.Root
                            className="relative flex items-center select-none touch-none w-full h-5"
                            value={[formData.securityDepositUSD]}
                            max={1000} // $1000 USD max
                            step={20} // $20 USD increments
                            onValueChange={([value]) => handleUSDInputChange('securityDepositUSD', value)}
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
                              One-time deposit: {formatUSD(formData.securityDepositUSD)}
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
                          <p>The total USD amount your group aims to save</p>
                          <p className="text-gray-300 text-xs mt-1">Fixed in USD value, not affected by SUI price</p>
                          <p className="text-gray-300 text-xs mt-1">Must be greater than individual contribution amount</p>
                        </InfoTooltip>
                      </div>
                      <div className="flex items-center space-x-2">
                        <span className="text-gray-500">$</span>
                        <input
                          type="number"
                          value={formData.smartGoal?.targetAmountUSD || ''}
                          onChange={(e) => {
                            const usdAmount = parseFloat(e.target.value);
                            if (!isNaN(usdAmount)) {
                              setFormData(prev => ({
                                ...prev,
                                smartGoal: {
                                  ...prev.smartGoal!,
                                  targetAmountUSD: usdAmount,
                                  targetAmount: convertUSDtoSUI(usdAmount)
                                }
                              }));
                            }
                          }}
                          placeholder="Enter target amount in USD"
                          className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500"
                          min={formData.securityDepositUSD}
                          step="100"
                        />
                        <span className="text-gray-500">USD</span>
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
                <div className="flex items-center">
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

              {/* Final USD Peg Summary */}
              <div className="mt-8 mb-6 border border-indigo-200 bg-indigo-50 rounded-lg p-4 text-indigo-700">
                <h3 className="font-semibold text-sm flex items-center">
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 mr-2 text-indigo-600" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-11a1 1 0 11-2 0v2H7a1 1 0 100 2h2v2a1 1 0 102 0v-2h2a1 1 0 100-2h-2V7z" clipRule="evenodd" />
                  </svg>
                  USD-Pegged Njangi Feature
                </h3>
                <div className="mt-2 text-sm">
                  <p>This circle will store all monetary values in USD. Key benefits:</p>
                  <ul className="mt-2 list-disc list-inside space-y-1 text-xs">
                    <li>Contribution amounts remain stable in USD terms regardless of SUI price</li>
                    <li>Members joining at different times pay the same real-world value</li>
                    <li>Security deposits maintain consistent value over time</li>
                    <li>The UI will always show both USD and equivalent SUI amounts</li>
                  </ul>
                  <p className="mt-2 text-xs">Current SUI price: {suiPrice ? `$${suiPrice.toFixed(4)}` : "Loading..."}</p>
                </div>
              </div>

              <div className="flex justify-end space-x-3 pt-6">
                <button
                  type="button"
                  onClick={() => router.back()}
                  className="px-4 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
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
              <div className="bg-white rounded-lg p-6 space-y-6">
                <div className="flex items-center justify-between">
                  <h3 className="text-lg font-medium text-gray-900">Direct Invites</h3>
                  <div className="flex items-center space-x-2">
                    <button
                      type="button"
                      onClick={() => setInviteType('email')}
                      className={`px-3 py-1.5 text-sm font-medium rounded-md ${
                        inviteType === 'email'
                          ? 'bg-blue-100 text-blue-700'
                          : 'text-gray-500 hover:text-gray-700'
                      }`}
                    >
                      Email
                    </button>
                    <button
                      type="button"
                      onClick={() => setInviteType('phone')}
                      className={`px-3 py-1.5 text-sm font-medium rounded-md ${
                        inviteType === 'phone'
                          ? 'bg-blue-100 text-blue-700'
                          : 'text-gray-500 hover:text-gray-700'
                      }`}
                    >
                      Phone
                    </button>
                  </div>
                </div>

                {/* Invite Input */}
                <div className="flex space-x-2">
                  <div className="flex-grow">
                    <label htmlFor="invite-input" className="sr-only">
                      {inviteType === 'email' ? 'Email address' : 'Phone number'}
                    </label>
                    <input
                      type={inviteType === 'email' ? 'email' : 'tel'}
                      id="invite-input"
                      value={inviteInput}
                      onChange={(e) => setInviteInput(e.target.value)}
                      placeholder={inviteType === 'email' ? 'Enter email address' : 'Enter phone number'}
                      className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      if (inviteInput) {
                        setInviteMembers([
                          ...inviteMembers,
                          { type: inviteType, value: inviteInput, status: 'pending' },
                        ]);
                        setInviteInput('');
                      }
                    }}
                    className="inline-flex items-center px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
                  >
                    Add
                  </button>
                </div>

                {/* Invite List */}
                {inviteMembers.length > 0 && (
                  <div className="mt-4 space-y-2">
                    {inviteMembers.map((member, index) => (
                      <div
                        key={index}
                        className="flex items-center justify-between py-2 px-3 bg-gray-50 rounded-md"
                      >
                        <div className="flex items-center space-x-3">
                          <span className="text-gray-500">
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
                          <span className="text-sm font-medium text-gray-900">{member.value}</span>
                        </div>
                        <div className="flex items-center space-x-2">
                          <span className={`text-sm ${
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
                            onClick={() => {
                              setInviteMembers(inviteMembers.filter((_, i) => i !== index));
                            }}
                            className="text-gray-400 hover:text-red-500"
                          >
                            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
              <div className="bg-white rounded-lg p-6 space-y-4">
                <h3 className="text-lg font-medium text-gray-900">Shareable Invite Link</h3>
                <p className="text-sm text-gray-500">
                  Share this link with potential members to let them join your circle
                </p>
                <div className="flex space-x-2">
                  <div className="flex-grow relative">
                    <input
                      type="text"
                      readOnly
                      value={inviteLink || 'Generating link...'}
                      className="block w-full rounded-md border-gray-300 bg-gray-50 pr-24 shadow-sm focus:border-blue-500 focus:ring-blue-500"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        navigator.clipboard.writeText(inviteLink);
                        setShowCopiedToast(true);
                        setTimeout(() => setShowCopiedToast(false), 2000);
                      }}
                      className="absolute right-2 top-1/2 -translate-y-1/2 px-3 py-1 text-sm font-medium text-blue-600 hover:text-blue-700"
                    >
                      Copy Link
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      // Generate new invite link
                      setInviteLink(`https://njangi.com/invite/${Math.random().toString(36).slice(2)}`);
                    }}
                    className="inline-flex items-center px-4 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
                  >
                    <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                    Generate New Link
                  </button>
                </div>
              </div>

              {/* Action Buttons */}
              <div className="flex justify-between pt-6">
                <Tooltip.Provider>
                  <Tooltip.Root>
                    <Tooltip.Trigger asChild>
                      <button
                        type="button"
                        disabled
                        className="px-4 py-2 border border-gray-200 rounded-md shadow-sm text-sm font-medium text-gray-400 bg-gray-50 cursor-not-allowed"
                      >
                        Back
                      </button>
                    </Tooltip.Trigger>
                    <Tooltip.Portal>
                      <Tooltip.Content
                        className="bg-gray-900 text-white px-3 py-2 rounded text-sm"
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
                    // TODO: Send invites and create circle
                    router.push('/dashboard');
                  }}
                  className="px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
                >
                  Create Circle & Send Invites
                </button>
              </div>

              {/* Copied Toast */}
              {showCopiedToast && (
                <div className="fixed top-4 right-4 bg-gray-900 text-white px-4 py-2 rounded-lg shadow-lg transition-opacity duration-200 flex items-center space-x-2">
                  <svg className="w-5 h-5 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" />
                  </svg>
                  <span>Link copied to clipboard!</span>
                </div>
              )}
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

const formatUSD = (amount: number) => {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(amount);
};

// Add InfoIcon component
const InfoIcon = () => (
  <svg 
    width="16" 
    height="16" 
    viewBox="0 0 16 16" 
    fill="none" 
    xmlns="http://www.w3.org/2000/svg"
    className="text-gray-400 hover:text-gray-500"
  >
    <path 
      d="M8 16A8 8 0 1 1 8 0a8 8 0 0 1 0 16zm0-1.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13z" 
      fill="currentColor"
    />
    <path 
      d="M8 4a1 1 0 1 1 0-2 1 1 0 0 1 0 2zm0 9a1 1 0 0 1-1-1V7a1 1 0 1 1 2 0v5a1 1 0 0 1-1 1z" 
      fill="currentColor"
    />
  </svg>
);

const InfoTooltip = ({ children }: { children: React.ReactNode }) => (
  <Tooltip.Provider>
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <span className="ml-1.5 inline-flex items-center cursor-help">
          <InfoIcon />
        </span>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          className="bg-gray-900 text-white px-3 py-2 rounded text-sm max-w-xs"
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