import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import { useAuth } from '../contexts/AuthContext';
import * as Slider from '@radix-ui/react-slider';
import * as Switch from '@radix-ui/react-switch';
import * as Select from '@radix-ui/react-select';
import * as Tooltip from '@radix-ui/react-tooltip';
import { priceService } from '../services/price-service';
import { toast } from 'react-hot-toast';
import { ZkLoginClient, ZkLoginError } from '../services/zkLoginClient';
import {
  autoReleaseDelayMsToDays,
  daysToAutoReleaseDelayMs,
  formatAutoReleaseDurationDays,
  getDefaultAutoReleaseDelayMs,
  getMinimumAutoReleaseDelayMs,
  isValidAutoReleaseDelayMs,
  type AutoReleaseCycleLength,
} from '../lib/auto-release';
import { getCurrentPackageId, getCurrentRpcUrl, getCurrentNetwork } from '../services/network-config';

// Add batch optimization imports
import {
  getSuiClientFromPool,
  batchQueryEvents
} from '../services/circle-service';

// Smart-goal milestones (Premium): sketch editor + preflight gate.
// hasFeaturePreflight comes from the CLIENT-SAFE mirror — value-importing
// src/lib/entitlement-gate.ts from a page drags the Stripe SDK + pg pool
// into the client bundle and breaks the webpack build (see
// entitlement-preflight.ts and the matching note in BillingUpsellModal).
import { hasFeaturePreflight } from '../components/milestones/entitlement-preflight';
import { useTranslation } from '../hooks/useTranslation';
import BillingUpsellModal from '../components/BillingUpsellModal';
import {
  preflightSanctionsCheck,
  SANCTIONS_BLOCKED_MESSAGE,
} from '../lib/sanctions-preflight';
import { resolveComplianceConfigId, isComplianceGateEnabled } from '../lib/compliance-gate';
import GoalPotProgress from '../components/goals/GoalPotProgress';
import { goalDisplayFont } from '../lib/fonts';
import { useZkLoginSigner } from '../hooks/useZkLoginSigner';
import {
  buildOpenGoalPoolTx,
  GOAL_KIND_AMOUNT,
  GOAL_KIND_DATE,
  GOAL_KIND_AMOUNT_BY_DATE,
} from '../services/goal-pool-service';
import { isValidSuiAddress } from '@mysten/sui/utils';
import type { NetworkType } from '../services/whatsapp-registry-service';

// Curated emoji set for giving a Smart Goal pot a bit of personality. The
// chosen emoji is prepended to the on-chain circle name so it travels with the
// goal everywhere it is displayed.
const GOAL_EMOJIS = ['🎯', '🎉', '🏠', '✈️', '🎓', '💍', '🚗', '🍼', '🏥', '🎁', '🌴', '💰', '📱', '🎄', '⚽', '🐐'];

// Get package ID dynamically based on current network
const getPackageId = () => {
  return getCurrentPackageId();
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
type CycleLength = AutoReleaseCycleLength;
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
  autoReleaseEnabled: boolean;
  autoReleaseDelayMs: number;
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
    byDate?: string; // amount goals: optional "reach it by this date"
    byDateBehavior?: 'release' | 'refund'; // what happens at byDate if target unmet
    verificationRequired: boolean;
  };
  /**
   * Frontend-only. The group is already part-way through its rotation and
   * will record where it stands before activating. Nothing about the
   * created circle differs — the history is declared afterwards, once the
   * roster and payout order exist — so this only steers the wizard.
   */
  isMigrating?: boolean;
  goalEmoji?: string; // Frontend-only: prepended to name for smart-goal circles
  goalBeneficiary?: string; // Frontend-only: smart-goal pool beneficiary (blank = creator)
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
const validateFormData = (
  formData: CircleFormData,
): string[] => {
  const errors: string[] = [];
  const isSmartGoal = formData.cycleType === 'smart-goal';

  if (!formData.name) {
    errors.push(isSmartGoal ? 'Goal description is required' : 'Circle name is required');
  }

  if (isSmartGoal) {
    // Smart-goal pools accept flexible contributions toward a shared target —
    // no per-member contribution, no member count, no security deposit. They
    // only need a goal configured and (optionally) a valid beneficiary.
    if (!formData.smartGoal) {
      errors.push('Choose a goal: a target amount or a target date');
    } else {
      if (formData.smartGoal.goalType === 'amount' && (!formData.smartGoal.targetAmount || formData.smartGoal.targetAmount <= 0)) {
        errors.push('Set a target amount greater than 0');
      }
      if (formData.smartGoal.goalType === 'date' && !formData.smartGoal.targetDate) {
        errors.push('Pick a target date');
      }
      // Optional "reach it by a date" on amount goals.
      if (formData.smartGoal.goalType === 'amount' && formData.smartGoal.byDate !== undefined) {
        if (!formData.smartGoal.byDate) {
          errors.push('Pick the date to reach your goal by (or untick "Reach it by a date")');
        } else if (new Date(formData.smartGoal.byDate).getTime() <= Date.now()) {
          errors.push('The "reach it by" date must be in the future');
        }
      }
    }
    const ben = (formData.goalBeneficiary || '').trim();
    if (ben && !isValidSuiAddress(ben)) {
      errors.push('Beneficiary must be a valid Sui address (or leave it blank to receive the pot yourself)');
    }
    return errors;
  }

  if (formData.contributionAmount <= 0) {
    errors.push('Contribution amount must be greater than 0');
  } else if (Math.floor(formData.contributionAmountUSD * 100) <= 0) {
    // The contract asserts contribution_amount_usd > 0 (cents). A sub-cent
    // contribution passes the SUI check above but would abort on-chain.
    errors.push('Contribution amount is too small');
  }

  if (formData.numberOfMembers < MIN_MEMBERS || formData.numberOfMembers > MAX_MEMBERS) {
    errors.push(`Number of members must be between ${MIN_MEMBERS} and ${MAX_MEMBERS}`);
  }

  // --- Rotational-only validation (cadence + security deposit + recovery) ---
  if (formData.securityDeposit < formData.contributionAmount / 2) {
    errors.push('Security deposit must be at least 50% of contribution amount');
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

  if (
    formData.autoReleaseEnabled
    && !isValidAutoReleaseDelayMs(formData.cycleLength, formData.autoReleaseDelayMs)
  ) {
    const minimumDays = autoReleaseDelayMsToDays(getMinimumAutoReleaseDelayMs(formData.cycleLength));
    errors.push(
      `Auto-release delay must be greater than ${formatAutoReleaseDurationDays(minimumDays)} for a ${formData.cycleLength} circle`,
    );
  }

  return errors;
};

// Function to prepare form data for contract
const prepareCircleCreationData = (formData: CircleFormData) => {
  const isSmartGoal = formData.cycleType === 'smart-goal';

  // Convert cycle length to contract format. Smart-goal pools have no
  // member-facing cadence, but the contract still requires a valid schedule, so
  // we anchor them to a silent monthly cadence (drives the "your turn" nudges).
  const cycle_length = isSmartGoal ? CYCLE_LENGTH_MAP['monthly'] : CYCLE_LENGTH_MAP[formData.cycleLength];

  // Convert cycle day to contract format
  const cycle_day = isSmartGoal
    ? 1
    : typeof formData.cycleDay === 'string'
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
  // Goal pools still rotate on-chain (the milestone layer is observational), so
  // the contract requires the standard 50% refundable commitment deposit. We
  // auto-derive it from the contribution instead of asking the organizer to set
  // it, rather than sending 0 (which the contract rejects).
  const security_deposit_local = isSmartGoal
    ? Math.ceil(contribution_amount_local / 2)
    : Math.floor(formData.securityDepositLocal * 100);
  const target_amount_local = formData.smartGoal?.goalType === 'amount' && formData.smartGoal?.targetAmountLocal
    ? Math.floor(formData.smartGoal.targetAmountLocal * 100)
    : 0;
    
  // IMPORTANT: Also include USD equivalent values for contract validation
  // The contract uses these USD values for internal calculations and validation
  const contribution_amount_usd = Math.floor(formData.contributionAmountUSD * 100);
  const security_deposit_usd = isSmartGoal
    ? Math.max(1, Math.ceil(contribution_amount_usd / 2))
    : Math.floor(formData.securityDepositUSD * 100);
  const target_amount_usd = formData.smartGoal?.goalType === 'amount' && formData.smartGoal?.targetAmountUSD
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

  // Calculate security deposit. Goal pools auto-derive the 50% commitment
  // deposit from the contribution (must be > 0 on-chain).
  const sgDepositMist = contribution_amount / BigInt(2);
  const security_deposit = isSmartGoal
    ? (sgDepositMist > BigInt(0) ? sgDepositMist : BigInt(1))
    : BigInt(Math.round(formData.securityDeposit * 1e9));

  // Convert penalty rules to array of booleans (none for smart-goal pools)
  const penalty_rules = isSmartGoal
    ? [false, false]
    : [
        formData.penaltyRules.latePayment,
        formData.penaltyRules.missedMeeting
      ];

  // Prepend the chosen emoji so it travels with the goal name everywhere. Falls
  // back to the same 🎯 default the picker shows, so the persisted name always
  // matches the preview the organizer saw.
  const display_name = isSmartGoal
    ? `${formData.goalEmoji || '🎯'} ${formData.name}`.trim()
    : formData.name;

  return {
    name: display_name,
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
    rotation_style: isSmartGoal ? 0 : (formData.rotationStyle === 'auction-based' ? 1 : 0),
    penalty_rules,
    goal_type,
    target_amount,
    target_amount_local,
    target_amount_usd,
    target_date,
    verification_required: isSmartGoal ? false : (formData.smartGoal?.verificationRequired || false),
    auto_release_enabled: isSmartGoal ? false : formData.autoReleaseEnabled,
    auto_release_delay_ms: isSmartGoal ? 0 : formData.autoReleaseDelayMs,
    next_in_command: null,
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
  const { isReady: signerReady, signAndExecute: signGoalPool } = useZkLoginSigner();
  const { t } = useTranslation();
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
    autoReleaseEnabled: false,
    autoReleaseDelayMs: 0,
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
  const [showSmartGoalUpsell, setShowSmartGoalUpsell] = useState(false);
  const [checkingSmartGoalAccess, setCheckingSmartGoalAccess] = useState(false);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);

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
                <span className="text-[#667085]">({sui.toFixed(2)} SUI)</span> : 
                <span className="text-yellow-500">(SUI price unavailable)</span>}
            </span>
          </Tooltip.Trigger>
          <Tooltip.Portal>
            <Tooltip.Content
              className="rounded-xl border border-[#d9d0c4] bg-[#1d2533] px-3 py-2 text-sm text-white shadow-[0_18px_48px_-24px_rgba(15,23,42,0.55)]"
              sideOffset={5}
            >
              <div className="space-y-1">
                {isPriceAvailable ? (
                  <>
                    <p>Live Conversion Rate:</p>
                    <p>1 SUI = {suiPrice ? formatCurrency(suiPrice, 'USD') : 'Loading...'}</p>
                    <p className="text-xs text-white/70">Updates every minute</p>
                    <p className="text-xs text-[#b9c8dd]">Currency: {formData.selectedCurrency}</p>
                  </>
                ) : (
                  <>
                    <p>SUI price currently unavailable</p>
                    <p className="text-xs text-white/70">SUI conversion will be applied at transaction time</p>
                  </>
                )}
              </div>
              <Tooltip.Arrow className="fill-[#1d2533]" />
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

  const minimumAutoReleaseDelayMs = getMinimumAutoReleaseDelayMs(formData.cycleLength);
  const minimumAutoReleaseDelayDays = autoReleaseDelayMsToDays(minimumAutoReleaseDelayMs);
  const minimumAllowedAutoReleaseDelayDays = minimumAutoReleaseDelayDays + 1;
  const selectedAutoReleaseDelayDays = autoReleaseDelayMsToDays(formData.autoReleaseDelayMs);
  const autoReleasePresetOptions = [
    {
      label: 'Minimum + 1 day',
      delayMs: getDefaultAutoReleaseDelayMs(formData.cycleLength),
    },
    {
      label: '2 cycles',
      delayMs: minimumAutoReleaseDelayMs * 2,
    },
    {
      label: '3 cycles',
      delayMs: minimumAutoReleaseDelayMs * 3,
    },
  ];

  // --- Smart-goal pot preview (derived from current form values) ---
  const sgCurrencySymbol = SUPPORTED_CURRENCIES[formData.selectedCurrency]?.symbol || formData.selectedCurrency;
  const sgGoalType = formData.smartGoal?.goalType || 'amount';
  const sgTargetLocal = formData.smartGoal?.targetAmountLocal || 0;
  const sgTargetDateObj = formData.smartGoal?.targetDate ? new Date(formData.smartGoal.targetDate) : null;
  const sgDaysToDate = sgTargetDateObj ? Math.max(0, Math.ceil((sgTargetDateObj.getTime() - Date.now()) / (24 * 3600 * 1000))) : null;
  const formatLocalAmount = (n: number) => `${sgCurrencySymbol}${Math.round(n).toLocaleString()}`;

  const handleAutoReleaseToggle = (checked: boolean) => {
    setFormData((prev) => ({
      ...prev,
      autoReleaseEnabled: checked,
      autoReleaseDelayMs: checked
        ? isValidAutoReleaseDelayMs(prev.cycleLength, prev.autoReleaseDelayMs)
          ? prev.autoReleaseDelayMs
          : getDefaultAutoReleaseDelayMs(prev.cycleLength)
        : 0,
    }));
  };

  const handleAutoReleaseDelayDaysChange = (rawValue: string) => {
    const parsedValue = Number(rawValue);
    setFormData((prev) => ({
      ...prev,
      autoReleaseDelayMs:
        Number.isFinite(parsedValue) && parsedValue > 0
          ? daysToAutoReleaseDelayMs(parsedValue)
          : 0,
    }));
  };

  // Smart-goal creation now mints a non-rotating GoalPool (no deposit, no
  // rotation, flexible contributions). Settled in SUI for v1.
  const handleCreateGoalPool = async () => {
    const SUI_COIN_TYPE = '0x2::sui::SUI';
    if (!signerReady || !userAddress) {
      setError('Please sign in again to create your goal pool.');
      return;
    }
    const sg = formData.smartGoal;
    if (!sg) {
      setValidationErrors(['Choose a goal: a target amount or a target date']);
      return;
    }
    const isAmount = sg.goalType === 'amount';
    if (isAmount && !isPriceAvailable) {
      setValidationErrors(['SUI price is currently unavailable. Please try again later.']);
      return;
    }

    // Encode the goal into the four supported on-chain shapes:
    //   pure amount          -> AMOUNT
    //   amount by date (keep)-> AMOUNT_BY_DATE + target_date (releases at the date)
    //   amount by date (a/n) -> AMOUNT + deadline_ms (refund if not met by the date)
    //   pure date            -> DATE + target_date
    let goalKind = GOAL_KIND_AMOUNT;
    let targetAmountMist = BigInt(0);
    let targetDateMs = BigInt(0);
    let deadlineMs = BigInt(0);
    if (isAmount) {
      targetAmountMist = sg.targetAmount ? BigInt(Math.round(sg.targetAmount * 1e9)) : BigInt(0);
      const byMs = sg.byDate ? BigInt(new Date(sg.byDate).getTime()) : BigInt(0);
      if (byMs > BigInt(0)) {
        if (sg.byDateBehavior === 'refund') {
          goalKind = GOAL_KIND_AMOUNT; // refund if target not met by the deadline
          deadlineMs = byMs;
        } else {
          goalKind = GOAL_KIND_AMOUNT_BY_DATE; // release what's pooled at the date
          targetDateMs = byMs;
        }
      }
    } else {
      goalKind = GOAL_KIND_DATE;
      targetDateMs = sg.targetDate ? BigInt(new Date(sg.targetDate).getTime()) : BigInt(0);
    }

    const beneficiary = (formData.goalBeneficiary || '').trim() || userAddress;
    const name = formData.goalEmoji ? `${formData.goalEmoji} ${formData.name}`.trim() : formData.name;
    const network = getCurrentNetwork() as NetworkType;

    // Goal pools sign client-side (straight to RPC), so the server choke
    // points never see this flow — courtesy OFAC preflight; the server
    // screens stay authoritative (docs/sanctions-program.md).
    if (userAddress && (await preflightSanctionsCheck(userAddress))) {
      setError(SANCTIONS_BLOCKED_MESSAGE);
      return;
    }

    // Compliance gating is an ops lever, not a user control: it is OFF
    // unless NEXT_PUBLIC_COMPLIANCE_GATE_ENABLED is set (a corridor that
    // demands KYC). Gated pools take the shared ComplianceConfig as an
    // on-chain argument — resolve it up front, same flow as the rotational
    // escrow. No user-facing toggle: for the CEX/DEX-funded, no-KYC launch,
    // users never see a verification requirement
    // (docs/compliance-roadmap-cex-dex-non-kyc.md §0).
    const gated = isComplianceGateEnabled();
    let complianceConfigId: string | undefined;
    if (gated) {
      complianceConfigId =
        (await resolveComplianceConfigId(network).catch(() => null)) ?? undefined;
      if (!complianceConfigId) {
        setError(
          'Verification is required in your region but is not configured yet. Please contact support.',
        );
        return;
      }
    }

    try {
      const build = buildOpenGoalPoolTx({
        network,
        coinType: SUI_COIN_TYPE,
        name,
        beneficiary,
        goalKind,
        targetAmount: targetAmountMist,
        targetDateMs,
        deadlineMs,
        withComplianceGate: gated || undefined,
        complianceConfigId,
      });
      const result = await signGoalPool({ build, gasBudget: 100_000_000 });
      const events = (result?.events ?? []) as Array<{ type?: string; parsedJson?: { pool_id?: string } }>;
      let poolId: string | null = null;
      for (const ev of events) {
        if (ev.type && ev.type.includes('::njangi_goal_pool::GoalPoolOpened')) {
          if (typeof ev.parsedJson?.pool_id === 'string') {
            poolId = ev.parsedJson.pool_id;
            break;
          }
        }
      }
      router.push(poolId ? `/pool/${poolId}` : '/dashboard');
    } catch (err) {
      console.error('Error creating goal pool:', err);
      setError(err instanceof Error ? err.message : 'Failed to create goal pool. Please try again.');
    }
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

    // Smart-goal circles are now non-rotating GoalPools (no deposit, no
    // rotation). They take a completely different creation path.
    if (formData.cycleType === 'smart-goal') {
      await handleCreateGoalPool();
      return;
    }

    // Check if SUI price is available
    if (!isPriceAvailable) {
      setValidationErrors(["SUI price is currently unavailable. Please try again later."]);
      return;
    }

    if (!account) {
      setError('Authentication is required before creating a circle.');
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
        auto_release_enabled: contractData.auto_release_enabled,
        auto_release_delay_ms: contractData.auto_release_delay_ms,
        next_in_command: contractData.next_in_command,
        target_amount: contractData.target_amount?.some 
          ? { some: contractData.target_amount.some.toString() }
          : { none: null },
        target_amount_local: contractData.target_amount_local > 0
          ? { some: contractData.target_amount_local.toString() }
          : { none: null },
        target_amount_usd: contractData.target_amount_usd,
        target_date: contractData.target_date?.some
          ? { some: contractData.target_date.some.toString() }
          : { none: null }
      };
      
      const zkLoginClient = ZkLoginClient.getInstance();
      const result = await zkLoginClient.createCircle(
        account,
        serializedData,
        getCurrentNetwork(),
      );
      
      // Store the transaction digest for reference
      if (result.digest) {
        console.log('Circle creation transaction successful:', result.digest);
      }

      // Move to invite step on success
      setCurrentStep(3); // Updated to step 3 for invite members
    } catch (err) {
      console.error('Error creating circle:', err);
      if (err instanceof ZkLoginError && err.requireRelogin) {
        if (typeof window !== 'undefined' && userAddress) {
          const currentNetwork = getCurrentNetwork();
          const cacheKey = `cache_${userAddress}_${currentNetwork}_circles`;
          localStorage.removeItem(cacheKey);
        }
        router.push('/dashboard');
        return;
      }
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

  const stepDefinitions = [
    {
      label: t('create.step.type.label'),
      title: t('create.step.type.title'),
      description: t('create.step.type.description'),
    },
    {
      label: t('create.step.currency.label'),
      title: t('create.step.currency.title'),
      description: t('create.step.currency.description'),
    },
    {
      label: t('create.step.config.label'),
      title: t('create.step.config.title'),
      description: t('create.step.config.description'),
    },
    {
      label: t('create.step.invites.label'),
      title: t('create.step.invites.title'),
      description: t('create.step.invites.description'),
    },
  ];
  const currentStepMeta = stepDefinitions[currentStep] ?? stepDefinitions[0];
  const shellCardClass =
    'rounded-[32px] border border-[#ddd5c9] bg-white/88 shadow-[0_30px_90px_-62px_rgba(15,23,42,0.42)] backdrop-blur';
  const sectionCardClass =
    'rounded-[24px] border border-[#e7dfd4] bg-[#fbfaf7] p-4 shadow-[0_24px_70px_-58px_rgba(15,23,42,0.28)] sm:p-5';
  const primaryActionClass =
    'inline-flex items-center justify-center rounded-full bg-slate-950 px-5 py-3 text-sm font-medium text-white transition hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-slate-400 focus:ring-offset-2';
  const secondaryActionClass =
    'inline-flex items-center justify-center rounded-full border border-stone-300 bg-white px-5 py-3 text-sm font-medium text-slate-700 transition hover:border-stone-400 hover:bg-stone-50 focus:outline-none focus:ring-2 focus:ring-stone-300 focus:ring-offset-2';
  const stepChipBaseClass =
    'rounded-[22px] border px-4 py-3 text-left transition-colors';
  const stepLabelClass =
    'text-[11px] font-semibold uppercase tracking-[0.22em] text-[#717784]';

  return (
    <div className="min-h-screen bg-[#f6f3ee] text-[#171923]">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[440px] bg-[radial-gradient(circle_at_top_left,_rgba(108,122,147,0.16),_transparent_34%),radial-gradient(circle_at_85%_10%,_rgba(218,204,178,0.28),_transparent_24%),linear-gradient(180deg,_rgba(255,255,255,0.58)_0%,_rgba(246,243,238,0)_72%)]" />
      <main className="relative mx-auto max-w-5xl px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
        <div className="mb-6 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => router.push('/dashboard')}
            className={secondaryActionClass}
          >
            <svg
              className="mr-2 h-4 w-4"
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
            {t('create.backToDashboard')}
          </button>
          <span className="inline-flex items-center rounded-full border border-[#dfe5ef] bg-white px-3 py-2 text-sm font-medium text-[#51627b]">
            {t('create.stepCounter', {
              current: currentStep + 1,
              total: stepDefinitions.length,
            })}
          </span>
        </div>

        <div className={`${shellCardClass} overflow-hidden`}>
          <div className="border-b border-[#e7dfd4] bg-[linear-gradient(135deg,rgba(243,246,251,0.95),rgba(251,250,247,0.9))] px-5 py-6 sm:px-8 sm:py-8">
            <div className="max-w-3xl">
              <p className={stepLabelClass}>{t('create.eyebrow')}</p>
              <h1 className="mt-3 text-3xl font-semibold tracking-[-0.04em] text-[#171923] sm:text-[2.45rem]">
                {currentStepMeta.title}
              </h1>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-[#5f6674] sm:text-base">
                {currentStepMeta.description}
              </p>
            </div>

            <div className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {stepDefinitions.map((step, index) => {
                const isActive = index === currentStep;
                const isCompleted = index < currentStep;

                return (
                  <div
                    key={step.label}
                    className={`${stepChipBaseClass} ${
                      isActive
                        ? 'border-[#d5dde8] bg-white text-[#171923]'
                        : isCompleted
                          ? 'border-[#cfe2d5] bg-[#eef7f0] text-[#24553a]'
                          : 'border-[#e3dbcf] bg-[#fbfaf7] text-[#6b7280]'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-sm font-semibold">{step.label}</p>
                      <span
                        className={`inline-flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold ${
                          isActive
                            ? 'bg-[#1d2533] text-white'
                            : isCompleted
                              ? 'bg-[#24553a] text-white'
                              : 'bg-white text-[#6b7280]'
                        }`}
                      >
                        {index + 1}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="p-5 sm:p-8">
          {currentStep === 0 ? (
            <div className="space-y-6">
              <div className="max-w-2xl">
                <p className="text-sm leading-6 text-[#5f6674]">
                  Pick the structure before you move into currency and scheduling.
                  Smart-goal circles add shared milestones and are part of Premium.
                </p>
              </div>
              
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mt-8">
                {/* Rotational Circle Card */}
                <button
                  onClick={() => {
                    // Drop any smart-goal config from a previous selection so a
                    // rotational circle never ships a goal_type on chain.
                    setFormData(prev => ({ ...prev, cycleType: 'rotational', smartGoal: undefined }));
                    setCurrentStep(1); // Go to currency selection step
                  }}
                  className="group rounded-[28px] border border-[#d7cec1] bg-[#fbfaf7] p-6 text-center transition-all duration-200 hover:-translate-y-0.5 hover:border-[#c9c0b2] hover:bg-white hover:shadow-[0_24px_70px_-58px_rgba(15,23,42,0.34)]"
                >
                  <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-full border border-[#d8e2f0] bg-white text-[#5f708a]">
                    <svg className="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                  </div>
                  <p className={stepLabelClass}>Available now</p>
                  <h3 className="mt-3 text-xl font-semibold tracking-[-0.03em] text-[#171923]">Rotational Circle</h3>
                  <p className="mt-3 text-sm leading-6 text-[#5f6674]">Members contribute regularly and take turns receiving the full pot in a predetermined order.</p>
                </button>

                {/* Smart Goal Circle Card (Premium) */}
                <button
                  onClick={() => {
                    if (checkingSmartGoalAccess) return;
                    setCheckingSmartGoalAccess(true);
                    hasFeaturePreflight('smartGoals')
                      .then((entitled) => {
                        if (!entitled) {
                          setShowSmartGoalUpsell(true);
                          return;
                        }
                        setFormData(prev => ({
                          ...prev,
                          cycleType: 'smart-goal',
                          // Initialize the goal config to match the visual
                          // default of the Smart Goal Settings select
                          // ('amount'). Without this, accepting the default
                          // and submitting would send goal_type: none on
                          // chain and permanently lock out milestones
                          // (create_circle_milestones aborts with
                          // E_GOAL_NOT_CONFIGURED).
                          smartGoal: prev.smartGoal ?? {
                            goalType: 'amount',
                            verificationRequired: false,
                          },
                        }));
                        setCurrentStep(1); // Go to currency selection step
                      })
                      .finally(() => setCheckingSmartGoalAccess(false));
                  }}
                  disabled={checkingSmartGoalAccess}
                  className="group relative rounded-[28px] border border-[#d7cec1] bg-[#fbfaf7] p-6 text-center transition-all duration-200 hover:-translate-y-0.5 hover:border-[#c9c0b2] hover:bg-white hover:shadow-[0_24px_70px_-58px_rgba(15,23,42,0.34)] disabled:opacity-60"
                >
                  {/* Premium badge */}
                  <div className="absolute top-2 right-2">
                    <span className="rounded-full border border-[#e2d3ae] bg-[#fdf6e7] px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-[#a07b2f] shadow-sm">
                      Premium
                    </span>
                  </div>

                  <div className="relative mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-full border border-[#d8e2f0] bg-white text-[#5f708a]">
                    <svg className="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                  </div>
                  <p className={`${stepLabelClass} relative`}>Available now</p>
                  <h3 className="relative mt-3 text-xl font-semibold tracking-[-0.03em] text-[#171923]">Smart Goal Circle</h3>
                  <p className="relative mt-3 text-sm leading-6 text-[#5f6674]">Members contribute toward a shared savings goal and celebrate milestones together along the way.</p>
                </button>
              </div>

              {/* An already-running group is not a third kind of circle — it
                  is a rotational one that starts part-way through its order.
                  Giving it its own door matters because the alternative is
                  restarting the rotation, which costs somebody their turn. */}
              <button
                type="button"
                onClick={() => {
                  setFormData(prev => ({
                    ...prev,
                    cycleType: 'rotational',
                    smartGoal: undefined,
                    isMigrating: true,
                  }));
                  setCurrentStep(1);
                }}
                className="mt-6 flex w-full items-start gap-4 rounded-[24px] border border-[#d7cec1] bg-white p-5 text-left transition-all duration-200 hover:-translate-y-0.5 hover:border-[#c9c0b2] hover:shadow-[0_24px_70px_-58px_rgba(15,23,42,0.34)]"
              >
                <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full border border-[#d8e2f0] bg-[#fbfaf7] text-[#5f708a]">
                  <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </div>
                <div>
                  <p className={stepLabelClass}>Already running</p>
                  <h3 className="mt-2 text-lg font-semibold tracking-[-0.03em] text-[#171923]">
                    Bring a circle that has already started
                  </h3>
                  <p className="mt-2 text-sm leading-6 text-[#5f6674]">
                    Halfway through your rotation? Set it up the same way, then
                    record who has already collected and whose turn is next. Your
                    circle carries on from there — no waiting for the round to end,
                    and nobody loses their place.
                  </p>
                </div>
              </button>

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
                  className={secondaryActionClass}
                >
                  <svg 
                    className="mr-2 h-4 w-4 text-slate-400 transition-colors duration-200 group-hover:text-slate-500" 
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
              <div className="max-w-2xl">
                <p className="text-sm leading-6 text-[#5f6674]">
                  Choose the currency members will reason about when they plan
                  contributions and deposits.
                </p>
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
                        className={`rounded-[22px] border p-4 text-left transition-all ${
                          formData.selectedCurrency === currency.code
                            ? 'border-[#d5dde8] bg-white shadow-[0_24px_60px_-54px_rgba(15,23,42,0.32)]'
                            : 'border-[#e3dbcf] bg-[#fbfaf7] hover:border-[#d2c8ba] hover:bg-white'
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <div>
                            <h4 className="font-medium text-[#171923]">{currency.name}</h4>
                            <p className="text-sm text-[#667085]">{currency.symbol} • {currency.code}</p>
                          </div>
                          {formData.selectedCurrency === currency.code && (
                            <div className="h-5 w-5 text-[#51627b]">
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
                        className={`rounded-[22px] border p-4 text-left transition-all ${
                          formData.selectedCurrency === currency.code
                            ? 'border-[#d5dde8] bg-white shadow-[0_24px_60px_-54px_rgba(15,23,42,0.32)]'
                            : 'border-[#e3dbcf] bg-[#fbfaf7] hover:border-[#d2c8ba] hover:bg-white'
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <div>
                            <h4 className="font-medium text-[#171923]">{currency.name}</h4>
                            <p className="text-sm text-[#667085]">{currency.symbol} • {currency.code}</p>
                          </div>
                          {formData.selectedCurrency === currency.code && (
                            <div className="h-5 w-5 text-[#51627b]">
                              <CheckIcon />
                            </div>
                          )}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Currency Information */}
                <div className={sectionCardClass}>
                  <div className="flex items-start">
                    <div className="mr-3 mt-1">
                      <svg className="h-5 w-5 text-[#70819a]" fill="none" viewBox="0 0 20 20" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                    </div>
                    <div className="flex-1">
                      <h4 className="text-sm font-medium text-[#171923]">Stable Value Pegging</h4>
                      <p className="mt-1 text-sm leading-6 text-[#5f6674]">
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
                  className={secondaryActionClass}
                >
                  <svg 
                    className="mr-2 h-4 w-4 text-slate-400 transition-colors duration-200 group-hover:text-slate-500" 
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
                  className={primaryActionClass}
                >
                  Continue to Circle Setup
                  <svg 
                    className="ml-2 h-4 w-4 text-slate-300 transition-colors duration-200 group-hover:text-white" 
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
              <div className={sectionCardClass}>
                <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                  <div className="max-w-2xl">
                    <p className={stepLabelClass}>Circle setup</p>
                    <h2 className="mt-2 text-2xl font-semibold tracking-[-0.03em] text-[#171923]">
                      Configure how this circle should run
                    </h2>
                    <p className="mt-2 text-sm leading-6 text-[#5f6674]">
                      Define the core economics and cadence first. The invite
                      step comes immediately after the circle is created.
                    </p>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <span className="inline-flex items-center rounded-full border border-[#dde5ef] bg-white px-3 py-2 text-sm font-medium text-[#51627b]">
                      {formData.cycleType === 'rotational' ? 'Rotational' : 'Smart Goal'}
                    </span>
                    <span className="inline-flex items-center rounded-full border border-[#dde5ef] bg-white px-3 py-2 text-sm font-medium text-[#51627b]">
                      {formData.selectedCurrency}
                    </span>
                    <span className="inline-flex items-center rounded-full border border-[#dde5ef] bg-white px-3 py-2 text-sm font-medium text-[#51627b]">
                      {formData.numberOfMembers} members
                    </span>
                  </div>
                </div>
              </div>

              {/* Error Display */}
              {error && (
                <div className="rounded-[22px] border border-red-200 bg-red-50/90 p-4">
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
                <div className="rounded-[22px] border border-amber-200 bg-amber-50/90 p-4">
                  <div className="flex">
                    <div className="flex-shrink-0">
                      <svg className="h-5 w-5 text-amber-500" viewBox="0 0 20 20" fill="currentColor">
                        <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                      </svg>
                    </div>
                    <div className="ml-3">
                      <h3 className="text-sm font-medium text-amber-900">Please fix the following issues:</h3>
                      <ul className="mt-2 list-disc list-inside text-sm text-amber-800">
                        {validationErrors.map((error, index) => (
                          <li key={index}>{error}</li>
                        ))}
                      </ul>
                    </div>
                  </div>
                </div>
              )}

              {formData.cycleType === 'smart-goal' ? (
              <div className="space-y-8">
                {/* Intro banner */}
                <div className="rounded-[24px] border border-emerald-200/70 bg-gradient-to-br from-emerald-50 to-[#fbfaf7] p-5">
                  <div className="flex items-start gap-3">
                    <span className="text-3xl leading-none">🫙</span>
                    <div>
                      <h3 className={`${goalDisplayFont.className} text-xl font-semibold text-[#0f5132]`}>
                        Pool money with friends &mdash; and watch the pot grow
                      </h3>
                      <p className="mt-1 text-sm leading-6 text-[#3f6b54]">
                        Everyone chips in toward one shared goal. Track every contribution as your pot
                        fills up, round after round, and celebrate together the moment you hit it.
                      </p>
                    </div>
                  </div>
                </div>

                {/* Goal description + emoji */}
                <div className="space-y-2">
                  <div className="flex items-center flex-wrap">
                    <label htmlFor="goal-name" className="block text-sm font-medium text-gray-700">
                      Goal Description
                    </label>
                    <InfoTooltip>
                      <p>What are you all saving for?</p>
                      <p className="text-gray-300 text-xs mt-1">Example: Family Reunion 2026</p>
                    </InfoTooltip>
                  </div>
                  <div className="flex items-stretch gap-2">
                    <div className="relative">
                      <button
                        type="button"
                        onClick={() => setShowEmojiPicker((v) => !v)}
                        className="flex h-full min-w-[3rem] items-center justify-center rounded-md border border-gray-300 bg-white px-3 text-2xl shadow-sm transition duration-100 hover:bg-gray-50 hover:scale-105 active:scale-95"
                        aria-label="Pick a goal emoji"
                      >
                        {formData.goalEmoji || '🎯'}
                      </button>
                      {showEmojiPicker && (
                        <div className="absolute z-20 mt-2 grid w-56 grid-cols-6 gap-1 rounded-xl border border-gray-200 bg-white p-2 shadow-lg">
                          {GOAL_EMOJIS.map((emoji) => (
                            <button
                              key={emoji}
                              type="button"
                              onClick={() => {
                                setFormData((prev) => ({ ...prev, goalEmoji: emoji }));
                                setShowEmojiPicker(false);
                              }}
                              className={`flex h-8 w-8 items-center justify-center rounded-md text-xl transition duration-100 hover:bg-emerald-50 hover:scale-110 active:scale-95 ${formData.goalEmoji === emoji ? 'bg-emerald-100' : ''}`}
                            >
                              {emoji}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                    <input
                      type="text"
                      name="name"
                      id="goal-name"
                      required
                      value={formData.name}
                      onChange={(e) => handleInputChange('name', e.target.value)}
                      className="block w-full flex-1 rounded-md border-gray-300 bg-white shadow-sm focus:border-emerald-500 focus:ring-emerald-500"
                      placeholder="e.g. Family Reunion 2026"
                    />
                  </div>
                </div>

                {/* The shared goal — amount or date — with a live growing-pot preview */}
                <div className="rounded-[24px] border border-[#e6dccd] bg-[#fcfaf6] p-5">
                  <div className="flex items-center flex-wrap">
                    <h4 className="text-sm font-semibold text-gray-800">Set your shared goal</h4>
                    <InfoTooltip>
                      <p>Choose how the goal is defined</p>
                      <p className="text-gray-300 text-xs mt-1">Reach an amount: pool toward a target total</p>
                      <p className="text-gray-300 text-xs mt-1">Reach a date: keep chipping in until a deadline</p>
                    </InfoTooltip>
                  </div>

                  {/* Segmented amount / date toggle */}
                  <div className="mt-3 inline-flex w-full max-w-sm rounded-full border border-[#dfe5ef] bg-white p-1">
                    <button
                      type="button"
                      onClick={() =>
                        setFormData((prev) => ({
                          ...prev,
                          smartGoal: { ...(prev.smartGoal ?? { verificationRequired: false }), goalType: 'amount', verificationRequired: prev.smartGoal?.verificationRequired ?? false },
                        }))
                      }
                      className={`flex-1 rounded-full px-4 py-2 text-sm font-medium transition duration-100 active:scale-[0.97] ${sgGoalType === 'amount' ? 'bg-slate-900 text-white shadow' : 'text-slate-600 hover:text-slate-900'}`}
                    >
                      💰 Reach an amount
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setFormData((prev) => ({
                          ...prev,
                          smartGoal: { ...(prev.smartGoal ?? { verificationRequired: false }), goalType: 'date', verificationRequired: prev.smartGoal?.verificationRequired ?? false },
                        }))
                      }
                      className={`flex-1 rounded-full px-4 py-2 text-sm font-medium transition duration-100 active:scale-[0.97] ${sgGoalType === 'date' ? 'bg-slate-900 text-white shadow' : 'text-slate-600 hover:text-slate-900'}`}
                    >
                      📅 Reach a date
                    </button>
                  </div>

                  <div className="mt-4 grid items-center gap-6 lg:grid-cols-[minmax(0,1fr)_200px]">
                    <div className="space-y-3">
                      {sgGoalType === 'amount' ? (
                        <div className="space-y-2">
                          <label className="block text-sm font-medium text-gray-700">Target amount</label>
                          <div className="flex items-center space-x-2">
                            <span className="text-gray-500">{sgCurrencySymbol}</span>
                            <input
                              type="number"
                              value={formData.smartGoal?.targetAmountLocal || ''}
                              onChange={async (e) => {
                                const localAmount = parseFloat(e.target.value);
                                if (!isNaN(localAmount)) {
                                  let usdAmount = localAmount;
                                  if (formData.selectedCurrency !== 'USD') {
                                    try {
                                      usdAmount = await priceService.convertToUSD(localAmount, formData.selectedCurrency);
                                    } catch (error) {
                                      console.error('Error converting to USD:', error);
                                      usdAmount = localAmount;
                                    }
                                  }
                                  const suiAmount = await convertLocalToSUI(localAmount);
                                  setFormData((prev) => ({
                                    ...prev,
                                    smartGoal: { ...prev.smartGoal!, targetAmountLocal: localAmount, targetAmountUSD: usdAmount, targetAmount: suiAmount },
                                  }));
                                }
                              }}
                              placeholder={`How much do you want to pool in ${formData.selectedCurrency}?`}
                              className="block w-full rounded-md border-gray-300 shadow-sm focus:border-emerald-500 focus:ring-emerald-500"
                              min="0"
                              step="100"
                            />
                            <span className="text-gray-500">{formData.selectedCurrency}</span>
                          </div>
                          <p className="text-xs text-gray-500">≈ {formData.smartGoal?.targetAmount?.toFixed(2) || '0'} SUI at current price · pegged to {formData.selectedCurrency}</p>

                          {/* Optional: reach the amount by a date */}
                          <div className="space-y-2 rounded-[14px] border border-[#e6dccd] bg-white/60 p-3">
                            <label className="flex items-center gap-2 text-sm font-medium text-gray-700">
                              <input
                                type="checkbox"
                                checked={formData.smartGoal?.byDate !== undefined}
                                onChange={(e) =>
                                  setFormData((prev) => ({
                                    ...prev,
                                    smartGoal: {
                                      ...prev.smartGoal!,
                                      byDate: e.target.checked ? (prev.smartGoal?.byDate || '') : undefined,
                                      byDateBehavior: prev.smartGoal?.byDateBehavior || 'release',
                                    },
                                  }))
                                }
                                className="rounded border-gray-300 text-emerald-600 focus:ring-emerald-500"
                              />
                              ⏳ Reach it by a date (optional)
                            </label>
                            {formData.smartGoal?.byDate !== undefined && (
                              <div className="space-y-3 pl-6">
                                <input
                                  type="date"
                                  value={formData.smartGoal?.byDate || ''}
                                  onChange={(e) =>
                                    setFormData((prev) => ({ ...prev, smartGoal: { ...prev.smartGoal!, byDate: e.target.value } }))
                                  }
                                  min={new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().split('T')[0]}
                                  className="block w-full rounded-md border-gray-300 shadow-sm focus:border-emerald-500 focus:ring-emerald-500"
                                />
                                <div className="space-y-2">
                                  <p className="text-xs font-medium text-gray-600">If the date arrives before the goal:</p>
                                  <label className="flex items-start gap-2 text-sm text-gray-700">
                                    <input
                                      type="radio"
                                      name="byDateBehavior"
                                      checked={(formData.smartGoal?.byDateBehavior || 'release') === 'release'}
                                      onChange={() =>
                                        setFormData((prev) => ({ ...prev, smartGoal: { ...prev.smartGoal!, byDateBehavior: 'release' } }))
                                      }
                                      className="mt-1 border-gray-300 text-emerald-600 focus:ring-emerald-500"
                                    />
                                    <span><strong>Release what&apos;s pooled</strong> to the beneficiary (keep what you raise)</span>
                                  </label>
                                  <label className="flex items-start gap-2 text-sm text-gray-700">
                                    <input
                                      type="radio"
                                      name="byDateBehavior"
                                      checked={formData.smartGoal?.byDateBehavior === 'refund'}
                                      onChange={() =>
                                        setFormData((prev) => ({ ...prev, smartGoal: { ...prev.smartGoal!, byDateBehavior: 'refund' } }))
                                      }
                                      className="mt-1 border-gray-300 text-emerald-600 focus:ring-emerald-500"
                                    />
                                    <span><strong>Refund everyone</strong> (all-or-nothing)</span>
                                  </label>
                                </div>
                              </div>
                            )}
                          </div>
                        </div>
                      ) : (
                        <div className="space-y-2">
                          <label className="block text-sm font-medium text-gray-700">Target date</label>
                          <input
                            type="date"
                            value={formData.smartGoal?.targetDate || ''}
                            onChange={(e) => {
                              setFormData((prev) => ({ ...prev, smartGoal: { ...prev.smartGoal!, targetDate: e.target.value } }));
                            }}
                            min={new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]}
                            className="block w-full rounded-md border-gray-300 shadow-sm focus:border-emerald-500 focus:ring-emerald-500"
                          />
                          {sgDaysToDate != null && (
                            <p className="text-xs text-gray-500">{sgDaysToDate} days to go · keep the pot growing until then</p>
                          )}
                        </div>
                      )}

                      {/* How it works */}
                      <div className="rounded-[16px] border border-[#dbe2ec] bg-[#f3f6fb] p-3 text-sm leading-6 text-[#51627b]">
                        {sgGoalType === 'amount' ? (
                          sgTargetLocal > 0 ? (
                            <span>
                              Friends chip in <strong>any amount</strong> toward <strong>{formatLocalAmount(sgTargetLocal)}</strong>. Watch the pot fill up — the moment it hits the goal, the whole pot is released to the beneficiary.
                            </span>
                          ) : (
                            <span>Set a target amount above. Friends can then chip in any amount toward it.</span>
                          )
                        ) : sgTargetDateObj ? (
                          <span>
                            Friends chip in <strong>any amount</strong> until <strong>{sgTargetDateObj.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</strong>, then the pot is released to the beneficiary.
                          </span>
                        ) : (
                          <span>Pick a target date above. Friends can then chip in any amount until then.</span>
                        )}
                      </div>
                    </div>

                    {/* Live growing-pot preview */}
                    <GoalPotProgress
                      percent={8}
                      size={150}
                      goalKind={sgGoalType}
                      title={(formData.goalEmoji ? formData.goalEmoji + ' ' : '') + (formData.name || 'Your goal')}
                      primaryLabel={
                        sgGoalType === 'amount'
                          ? (sgTargetLocal > 0 ? `Goal: ${formatLocalAmount(sgTargetLocal)}` : 'Set a target')
                          : (sgTargetDateObj ? sgTargetDateObj.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : 'Pick a date')
                      }
                      secondaryLabel="Friends chip in any amount"
                    />
                  </div>
                </div>

                {/* Who receives the pot */}
                <div className="space-y-2">
                  <div className="flex items-center flex-wrap">
                    <label htmlFor="goal-beneficiary" className="block text-sm font-medium text-gray-700">Who receives the pot?</label>
                    <InfoTooltip>
                      <p>The wallet that receives the whole pot once the goal is reached.</p>
                      <p className="text-gray-300 text-xs mt-1">Defaults to you. Paste a friend&apos;s Sui address to collect on their behalf.</p>
                    </InfoTooltip>
                  </div>
                  <input
                    type="text"
                    id="goal-beneficiary"
                    value={formData.goalBeneficiary || ''}
                    onChange={(e) => handleInputChange('goalBeneficiary', e.target.value)}
                    placeholder={userAddress ? `You (${userAddress.slice(0, 6)}…${userAddress.slice(-4)})` : 'Your wallet (default)'}
                    className="block w-full rounded-md border-gray-300 bg-white font-mono text-sm shadow-sm focus:border-emerald-500 focus:ring-emerald-500"
                  />
                  <p className="text-xs text-gray-500">Leave blank to receive the pot yourself.</p>
                </div>

                {/* Open-pool explainer */}
                <div className="flex items-start gap-2 rounded-[16px] border border-emerald-200/70 bg-emerald-50/60 px-3 py-2.5 text-xs leading-5 text-[#3f6b54]">
                  <span className="text-base leading-none">✨</span>
                  <span>
                    <strong>No security deposit, no fixed rounds.</strong> Anyone with the link chips in any amount and watches the pot grow.
                    When the goal is reached, the whole pot is released to the beneficiary; if it falls through, contributors are refunded.
                  </span>
                </div>
              </div>
              ) : (
              <>
              {/* Group Name */}
              <div className="space-y-2">
                <div className="flex items-center flex-wrap">
                  <label htmlFor="name" className="block text-sm font-medium text-gray-700">
                    {t('create.circleNameLabel')}
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
                  placeholder={t('create.circleNamePlaceholder')}
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

              {/* How many people are in the circle.
                  Until now this was pinned at MIN_MEMBERS with no input, so
                  every circle was created with room for three and the organiser
                  had to raise the cap afterwards from the manage page. A group
                  moving here part-way through its rotation cannot do that: it
                  needs all its seats before the payout order means anything. */}
              {formData.cycleType === 'rotational' && (
                <div className="space-y-2">
                  <div className="flex items-center flex-wrap">
                    <label htmlFor="number-of-members" className="block text-sm font-medium text-gray-700">
                      How many members?
                    </label>
                    <InfoTooltip>
                      <p>Everyone who takes a turn receiving the pot</p>
                      <p className="text-gray-300 text-xs mt-1">Between {MIN_MEMBERS} and {MAX_MEMBERS}. You can change this later, before the circle starts.</p>
                    </InfoTooltip>
                  </div>
                  <input
                    id="number-of-members"
                    type="number"
                    min={MIN_MEMBERS}
                    max={MAX_MEMBERS}
                    value={formData.numberOfMembers}
                    onChange={(event) => {
                      const parsed = Number(event.target.value);
                      handleInputChange(
                        'numberOfMembers',
                        Number.isFinite(parsed) ? Math.trunc(parsed) : MIN_MEMBERS,
                      );
                    }}
                    className="w-full px-3 py-2 text-sm bg-white border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  <p className="text-xs text-gray-500">
                    Counting you. One full round is one turn each.
                  </p>
                </div>
              )}

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
                    setFormData((prev) => ({
                      ...prev,
                      cycleLength: value,
                      cycleDay: (value === 'weekly' || value === 'bi-weekly') ? 'monday' : 1,
                      autoReleaseDelayMs:
                        prev.autoReleaseEnabled && !isValidAutoReleaseDelayMs(value, prev.autoReleaseDelayMs)
                          ? getDefaultAutoReleaseDelayMs(value)
                          : prev.autoReleaseDelayMs,
                    }));
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

              <div className="space-y-4 rounded-[24px] border border-[#e6dccd] bg-[#fcfaf6] p-4 sm:p-5">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                  <div className="max-w-2xl">
                    <div className="flex items-center flex-wrap">
                      <h3 className="text-sm font-medium text-gray-700">Admin Liveness Fallback</h3>
                      <InfoTooltip>
                        <p>Optional recovery path for worst-case admin absence.</p>
                        <p className="text-gray-300 text-xs mt-1">If enabled, the delegate gets the first 24 hours of trigger authority after this delay elapses.</p>
                        <p className="text-gray-300 text-xs mt-1">The delay must be longer than the selected cycle length.</p>
                      </InfoTooltip>
                    </div>
                    <p className="mt-2 text-sm leading-6 text-gray-600">
                      Configure an automatic release window that can unwind the circle if the admin is deceased, missing, or permanently unreachable.
                    </p>
                  </div>
                  <Switch.Root
                    checked={formData.autoReleaseEnabled}
                    onCheckedChange={handleAutoReleaseToggle}
                    className="h-7 w-12 rounded-full bg-gray-200 relative data-[state=checked]:bg-[#1d2533] transition-colors duration-200"
                    aria-label="Enable admin liveness fallback"
                  >
                    <Switch.Thumb className="block h-6 w-6 rounded-full bg-white shadow-lg transition-transform duration-200 translate-x-0.5 data-[state=checked]:translate-x-[22px]" />
                  </Switch.Root>
                </div>

                <div className={`rounded-[20px] border p-4 ${
                  formData.autoReleaseEnabled
                    ? 'border-amber-200 bg-amber-50 text-amber-900'
                    : 'border-stone-200 bg-white text-slate-600'
                }`}>
                  <p className="text-sm font-semibold">
                    Admin liveness fallback {formData.autoReleaseEnabled ? 'enabled' : 'disabled'}
                  </p>
                  <p className="mt-2 text-sm leading-6">
                    {formData.autoReleaseEnabled
                      ? 'This setting is irreversible after creation. If recovery is triggered, the cycle stops and custody funds are returned to their recorded owners.'
                      : 'Leave this off if you do not want an automatic admin-absence recovery path attached to the circle.'}
                  </p>
                </div>

                {formData.autoReleaseEnabled && (
                  <div className="space-y-4">
                    <div className="grid gap-4 lg:grid-cols-[minmax(0,1.15fr)_300px]">
                      <div className="space-y-3 rounded-[20px] border border-stone-200 bg-white p-4">
                        <div className="flex items-center justify-between gap-3">
                          <label htmlFor="auto-release-delay-days" className="text-sm font-medium text-gray-700">
                            Delay before fallback unlocks
                          </label>
                          <span className="rounded-full bg-stone-100 px-3 py-1 text-xs font-medium text-slate-700">
                            More than {formatAutoReleaseDurationDays(minimumAutoReleaseDelayDays)}
                          </span>
                        </div>
                        <div className="flex items-center gap-3">
                          <input
                            id="auto-release-delay-days"
                            type="number"
                            min={minimumAllowedAutoReleaseDelayDays}
                            step={1}
                            value={selectedAutoReleaseDelayDays > 0 ? selectedAutoReleaseDelayDays : ''}
                            onChange={(e) => handleAutoReleaseDelayDaysChange(e.target.value)}
                            className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500"
                            placeholder={`${minimumAllowedAutoReleaseDelayDays}`}
                          />
                          <span className="text-sm text-gray-500">days</span>
                        </div>
                        <p className="text-sm text-gray-500">
                          Choose a delay longer than the circle cadence. Weekly circles must exceed 7 days, monthly circles must exceed 30 days, and so on.
                        </p>
                        <div className="flex flex-wrap gap-2">
                          {autoReleasePresetOptions.map((preset) => {
                            const presetDays = autoReleaseDelayMsToDays(preset.delayMs);
                            const isSelected = formData.autoReleaseDelayMs === preset.delayMs;
                            return (
                              <button
                                key={preset.label}
                                type="button"
                                onClick={() => {
                                  setFormData((prev) => ({
                                    ...prev,
                                    autoReleaseDelayMs: preset.delayMs,
                                  }));
                                }}
                                className={`rounded-full border px-3 py-1.5 text-sm font-medium transition-colors ${
                                  isSelected
                                    ? 'border-[#1d2533] bg-[#1d2533] text-white'
                                    : 'border-stone-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-stone-50'
                                }`}
                              >
                                {preset.label} ({presetDays}d)
                              </button>
                            );
                          })}
                        </div>
                      </div>

                      <div className="rounded-[20px] border border-[#dbe2ec] bg-[#f3f6fb] p-4">
                        <p className="text-sm font-medium text-[#1d2533]">Recovery window summary</p>
                        <p className="mt-3 text-2xl font-semibold tracking-[-0.03em] text-[#171923]">
                          {selectedAutoReleaseDelayDays > 0
                            ? formatAutoReleaseDurationDays(selectedAutoReleaseDelayDays)
                            : 'Set a delay'}
                        </p>
                        <p className="mt-2 text-sm leading-6 text-[#51627b]">
                          The delegate-exclusive recovery window can only open after this delay from circle creation. You can leave the delegate blank for now, but the circle cannot go live until one is assigned in manage.
                        </p>
                        <p className="mt-3 text-xs text-[#70819a]">
                          Minimum allowed: {formatAutoReleaseDurationDays(minimumAllowedAutoReleaseDelayDays)}
                        </p>
                      </div>
                    </div>

                    <div className="rounded-[20px] border border-[#dbe2ec] bg-[#f3f6fb] p-4">
                      <p className="text-sm font-medium text-[#1d2533]">Trigger order</p>
                      <div className="mt-3 space-y-3 text-sm leading-6 text-[#51627b]">
                        <p>1. Admin heartbeat expires after {formatAutoReleaseDurationDays(selectedAutoReleaseDelayDays || minimumAllowedAutoReleaseDelayDays)}.</p>
                        <p>2. Once members join, the admin assigns an active member as next in command from manage.</p>
                        <p>3. That delegate gets 24 hours of exclusive recovery authority, then eligible active members can trigger the same unwind path.</p>
                      </div>
                      <p className="mt-3 text-xs text-[#70819a]">
                        Recovery stops the circle and returns custody funds to their recorded owners.
                      </p>
                    </div>
                  </div>
                )}
              </div>

              {/* Final Currency Peg Summary */}
              <div className="mt-8 mb-6 rounded-[24px] border border-[#dbe2ec] bg-[#f3f6fb] p-4 text-[#51627b] sm:p-5">
                <h3 className="font-semibold text-sm flex items-center">
                  <svg xmlns="http://www.w3.org/2000/svg" className="mr-2 h-5 w-5 text-[#5f708a]" viewBox="0 0 20 20" fill="currentColor">
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
              </>
              )}

              <div className="flex justify-end space-x-3 pt-6">
                <button
                  type="button"
                  onClick={() => router.back()}
                  className={secondaryActionClass}
                >
                  {t('create.cancel')}
                </button>
                <button
                  type="submit"
                  className={primaryActionClass}
                >
                  {formData.cycleType === 'smart-goal' ? 'Create goal pool' : t('create.nextInvite')}
                </button>
              </div>
            </form>
          ) : (
            <div className="space-y-8">
              <div className={sectionCardClass}>
                <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                  <div className="max-w-2xl">
                    <p className={stepLabelClass}>Invites</p>
                    <h2 className="mt-2 text-2xl font-semibold tracking-[-0.03em] text-[#171923]">
                      Invite members into the circle
                    </h2>
                    <p className="mt-2 text-sm leading-6 text-[#5f6674]">
                      Add direct invites, generate the share link, and finish the
                      flow once the circle ID is available.
                    </p>
                  </div>
                  <span className="inline-flex items-center rounded-full border border-[#dde5ef] bg-white px-3 py-2 text-sm font-medium text-[#51627b]">
                    {formData.numberOfMembers - 1} member slots to fill
                  </span>
                </div>

                {/* An already-running group has one more step than a new one:
                    the history can only be recorded once every member is in and
                    the payout order is set, so it lives on the manage page
                    rather than here. Point at it, or it gets missed and the
                    circle starts over from position one. */}
                {formData.isMigrating && (
                  <div className="mt-5 rounded-[22px] border border-[#d8e2f0] bg-[#f7fafc] p-4">
                    <p className={stepLabelClass}>Next, for a circle already running</p>
                    <p className="mt-2 text-sm leading-6 text-[#5f6674]">
                      Once everyone has joined and you have set the payout order,
                      open <span className="font-medium text-[#171923]">Circle history</span> on
                      the manage page to record who has already collected and whose
                      turn is next. Each member confirms it, and then the circle
                      picks up where your group left off.
                    </p>
                    {createdCircleId && (
                      <button
                        type="button"
                        onClick={() => router.push(`/circle/${createdCircleId}/manage`)}
                        className="mt-3 inline-flex items-center rounded-full border border-[#d7cec1] bg-white px-4 py-2 text-sm font-medium text-[#171923] transition hover:border-[#c9c0b2]"
                      >
                        Go to circle management
                      </button>
                    )}
                  </div>
                )}
              </div>

              {/* Direct Invites Section */}
              <div className={sectionCardClass}>
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between space-y-3 sm:space-y-0">
                  <h3 className="text-lg font-medium text-[#171923]">Direct Invites</h3>
                  <div className="flex items-center space-x-2 rounded-full border border-[#e3dbcf] bg-white p-1">
                    <button
                      type="button"
                      onClick={() => setInviteType('email')}
                      className={`rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${
                        inviteType === 'email'
                          ? 'bg-[#1d2533] text-white shadow-sm'
                          : 'text-[#667085] hover:text-[#171923]'
                      }`}
                    >
                      Email
                    </button>
                    <button
                      type="button"
                      onClick={() => setInviteType('phone')}
                      className={`rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${
                        inviteType === 'phone'
                          ? 'bg-[#1d2533] text-white shadow-sm'
                          : 'text-[#667085] hover:text-[#171923]'
                      }`}
                    >
                      Phone
                    </button>
                  </div>
                </div>

                {/* Email functionality note */}
                {inviteType === 'email' && (
                  <div className="rounded-[20px] border border-[#dbe2ec] bg-[#f3f6fb] p-4">
                    <div className="flex items-start">
                      <svg className="mr-2 mt-0.5 h-5 w-5 flex-shrink-0 text-[#70819a]" fill="none" viewBox="0 0 20 20" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                      <div className="min-w-0 text-sm text-[#5f6674]">
                        <p className="font-medium text-[#171923]">Email Invites</p>
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
              <div className={sectionCardClass}>
                <h3 className="text-lg font-medium text-[#171923]">Shareable Invite Link</h3>
                <p className="text-sm text-[#667085]">
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
                        className="w-full sm:w-auto rounded-full border border-stone-200 bg-stone-50 px-5 py-3 text-sm font-medium text-stone-400 cursor-not-allowed"
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
                  className={`w-full sm:w-auto ${primaryActionClass}`}
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
        </div>
      </main>

      {/* Premium upsell when smart goals are not on the caller's plan */}
      <BillingUpsellModal
        open={showSmartGoalUpsell}
        onClose={() => setShowSmartGoalUpsell(false)}
        feature="smartGoals"
      />
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
          className="z-50 max-w-xs rounded-xl border border-[#d9d0c4] bg-[#1d2533] px-2 sm:px-3 py-1.5 sm:py-2 text-xs text-white shadow-[0_18px_48px_-24px_rgba(15,23,42,0.55)] sm:text-sm"
          sideOffset={5}
        >
          <div className="space-y-1">
            {children}
          </div>
          <Tooltip.Arrow className="fill-[#1d2533]" />
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
