import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import { useAuth } from '../contexts/AuthContext';
import * as Slider from '@radix-ui/react-slider';
import * as Switch from '@radix-ui/react-switch';
import * as Select from '@radix-ui/react-select';
import * as Tooltip from '@radix-ui/react-tooltip';
import { priceService } from '../services/price-service';
import { toast } from 'react-hot-toast';
import { copyToClipboard, manualCopyMessage } from '@/lib/copy-to-clipboard';
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
import { resolveCreatedCircleId } from '@/lib/circle-creation-discovery';
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
import {
  MAX_MEMBERS,
  MIN_MEMBERS,
  QUICK_START_FREQUENCIES,
  QUICK_START_MEMBERS,
  buildWhatsAppShareUrl,
  clampMembers,
  defaultCycleDay,
  deriveSecurityDeposit,
  type QuickStartFrequency,
} from '../lib/circle-quick-start';
import { rememberPostLoginDestination } from '../lib/post-login-redirect';
import { trackFunnel } from '../lib/funnel-events';
import { refreshSuiBalance } from '../lib/wallet';

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

// Contract member limits come from src/lib/circle-quick-start.ts (MIN_MEMBERS /
// MAX_MEMBERS) so the one-screen defaults and this validation cannot drift.

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
  const { isAuthenticated, isLoading: authLoading, account, userAddress } = useAuth();
  const { isReady: signerReady, signAndExecute: signGoalPool } = useZkLoginSigner();
  const { t } = useTranslation();
  // Two screens: 0 = set up (one form), 1 = invite (the circle exists).
  const [currentStep, setCurrentStep] = useState(0);
  const [useCustomDeposit, setUseCustomDeposit] = useState(false);
  // "More settings" reveals the controls the quick path derives for you.
  const [showMoreSettings, setShowMoreSettings] = useState(false);
  // Once the organizer edits the deposit by hand, stop deriving it from the
  // contribution — their number wins.
  const [depositOverridden, setDepositOverridden] = useState(false);
  // Submit is disabled while the creation transaction is in flight; before
  // this there was no pending state and a double-click could mean two circles.
  const [isCreating, setIsCreating] = useState(false);
  // Testnet only: a fresh account has nothing to pay its first transaction
  // with. Surfaced above the submit button rather than as a raw RPC error.
  const [needsTestnetFunds, setNeedsTestnetFunds] = useState(false);
  // Invite screen: the link resolves on entry; this flags a failed attempt.
  const [linkResolveFailed, setLinkResolveFailed] = useState(false);
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
    numberOfMembers: QUICK_START_MEMBERS,
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
  // The creation transaction names the circle exactly; the event scan below
  // only guesses at it. Keep the digest so we can ask the cheap question first.
  const [createdCircleDigest, setCreatedCircleDigest] = useState<string | null>(null);
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
    // Wait for the session to hydrate before deciding anybody is signed out.
    // Without this, a hard load of /create-circle bounces every signed-in
    // organiser: isAuthenticated is false on the first render, this pushed
    // them to '/', and '/' pushes an authenticated user straight to
    // /dashboard — so a bookmark or a pasted link silently never opened the
    // page. `replace` rather than `push` so a genuinely signed-out visitor
    // does not land back here with the Back button.
    if (authLoading) {
      return;
    }

    if (!isAuthenticated) {
      router.replace('/');
    }
  }, [authLoading, isAuthenticated, router]);

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

  // The amount can now be typed BEFORE the currency is picked (they sit on
  // the same screen), so a currency switch re-converts what is already there.
  useEffect(() => {
    if (formData.contributionAmountLocal > 0) {
      void handleLocalInputChange('contributionAmountLocal', formData.contributionAmountLocal);
    }
    // Re-run on currency change only; the converter reads the current amount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      // The security deposit follows the contribution at exactly half (the
      // contract minimum, njangi_core::min_security_deposit) until the
      // organizer overrides it under "More settings". Local and USD halves
      // round UP to the cent; the SUI half is exact so the client-side
      // `deposit >= contribution / 2` check can never lose to rounding.
      const derived = depositOverridden
        ? {}
        : {
            securityDepositLocal: deriveSecurityDeposit(snappedValue),
            securityDepositUSD: deriveSecurityDeposit(usdValue),
            securityDeposit: suiValue / 2,
          };
      setFormData(prev => ({
        ...prev,
        contributionAmountLocal: snappedValue,
        contributionAmountUSD: usdValue, // Proper USD conversion
        contributionAmount: suiValue,
        ...derived,
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

  // Cadence change resets the day-of-cycle to the matching kind (weekday vs
  // day-of-month) and keeps any liveness delay legal for the new cadence.
  const handleCycleLengthChange = (value: QuickStartFrequency) => {
    setFormData((prev) => ({
      ...prev,
      cycleLength: value,
      cycleDay: defaultCycleDay(value),
      autoReleaseDelayMs:
        prev.autoReleaseEnabled && !isValidAutoReleaseDelayMs(value, prev.autoReleaseDelayMs)
          ? getDefaultAutoReleaseDelayMs(value)
          : prev.autoReleaseDelayMs,
    }));
  };

  // The two other kinds of circle are doors off the setup screen, not a step
  // in front of it.
  const toggleMigrating = () => {
    setFormData((prev) => ({
      ...prev,
      cycleType: 'rotational',
      smartGoal: undefined,
      isMigrating: !prev.isMigrating,
    }));
  };

  const chooseRotational = () => {
    // Drop any smart-goal config so a rotational circle never ships a
    // goal_type on chain.
    setFormData((prev) => ({ ...prev, cycleType: 'rotational', smartGoal: undefined }));
  };

  const chooseSmartGoal = () => {
    if (checkingSmartGoalAccess) return;
    setCheckingSmartGoalAccess(true);
    hasFeaturePreflight('smartGoals')
      .then((entitled) => {
        if (!entitled) {
          setShowSmartGoalUpsell(true);
          return;
        }
        setFormData((prev) => ({
          ...prev,
          cycleType: 'smart-goal',
          isMigrating: false,
          // Initialize the goal config to match the visual default of the
          // Smart Goal Settings select ('amount'). Without this, accepting
          // the default and submitting would send goal_type: none on chain
          // and permanently lock out milestones (create_circle_milestones
          // aborts with E_GOAL_NOT_CONFIGURED).
          smartGoal: prev.smartGoal ?? {
            goalType: 'amount',
            verificationRequired: false,
          },
        }));
      })
      .finally(() => setCheckingSmartGoalAccess(false));
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
    if (isCreating) return;

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
      setIsCreating(true);
      try {
        await handleCreateGoalPool();
      } finally {
        setIsCreating(false);
      }
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

    setIsCreating(true);
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
      
      // Keep the digest: it resolves the new circle deterministically, without
      // event history (which not every RPC serves) and without guessing.
      if (result.digest) {
        console.log('Circle creation transaction successful:', result.digest);
        setCreatedCircleDigest(result.digest);
      }

      trackFunnel('circle_created');
      // Move to the invite screen on success
      setCurrentStep(1);
    } catch (err) {
      console.error('Error creating circle:', err);
      if (err instanceof ZkLoginError && err.requireRelogin) {
        if (typeof window !== 'undefined' && userAddress) {
          const currentNetwork = getCurrentNetwork();
          const cacheKey = `cache_${userAddress}_${currentNetwork}_circles`;
          localStorage.removeItem(cacheKey);
        }
        // Keep what they typed and bring them straight back here after the
        // fresh sign-in: the restore effect below reads this key, and the
        // OAuth callback honours the destination. Until now the key was
        // read but never written, so a session expiry mid-form lost
        // everything and landed on the dashboard.
        try {
          sessionStorage.setItem('createCircleFormData', JSON.stringify(formData));
        } catch {
          // Storage unavailable: they start over, which is what happened before.
        }
        rememberPostLoginDestination('/create-circle');
        router.push('/dashboard');
        return;
      }
      setError(err instanceof Error ? err.message : 'Failed to create circle. Please try again.');
    } finally {
      setIsCreating(false);
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

      // Preferred path: read the circle straight out of the transaction that
      // created it. One request, no event history, and it names THE circle
      // just created rather than the most recent one this admin happens to
      // own. The event scan below stays as a fallback for a session that lost
      // the digest (e.g. the form was restored after re-authentication).
      if (createdCircleDigest) {
        try {
          const fromDigest = await resolveCreatedCircleId(client, createdCircleDigest);
          if (fromDigest) {
            console.log('Resolved circle ID from creation transaction:', fromDigest);
            return fromDigest;
          }
        } catch (digestError) {
          console.warn('Could not resolve circle from creation digest, falling back to events:', digestError);
        }
      }

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

  // --- Invite screen: resolve the link on entry, no click required ---------
  const resolveInviteLink = async () => {
    setLinkResolveFailed(false);
    try {
      const id = await fetchCircleId();
      if (id) {
        setCreatedCircleId(id);
        setInviteLink(`${window.location.origin}/circle/${id}/join`);
      } else {
        setLinkResolveFailed(true);
      }
    } catch (resolveError) {
      console.warn('Could not resolve the invite link yet:', resolveError);
      setLinkResolveFailed(true);
    }
  };

  useEffect(() => {
    if (currentStep === 1 && !createdCircleId) {
      void resolveInviteLink();
    }
    // The resolver closes over the freshly stored digest; re-running it on
    // every render would spam the RPC, so key on the screen change only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentStep]);

  const copyInviteLink = () => {
    if (!inviteLink) return;
    // Synchronous call from the click handler: the user activation the
    // Clipboard API needs must still be current (src/lib/copy-to-clipboard.ts).
    void copyToClipboard(inviteLink).then((outcome) => {
      if (outcome === 'failed') {
        toast.error(manualCopyMessage('invite link', inviteLink), { duration: 12000 });
        return;
      }
      trackFunnel('invite_link_copied');
      toast.success(t('create.copied'));
    });
  };

  const clearDashboardCaches = () => {
    if (typeof window === 'undefined' || !userAddress) return;
    const currentNetwork = getCurrentNetwork();
    localStorage.removeItem(`cache_${userAddress}_${currentNetwork}_circles`);
    const eventsCachePattern = `cache_${userAddress}_${currentNetwork}_events`;
    for (let i = localStorage.length - 1; i >= 0; i -= 1) {
      const key = localStorage.key(i);
      if (key && key.startsWith(eventsCachePattern)) {
        localStorage.removeItem(key);
      }
    }
  };

  const finalizeInvites = () => {
    const pendingEmails = inviteMembers.filter(
      (member) => member.type === 'email' && member.status === 'pending',
    );
    if (pendingEmails.length > 0 && createdCircleId) {
      sendAllEmailInvites();
    }
    clearDashboardCaches();
  };

  const openCreatedCircle = () => {
    if (!createdCircleId) return;
    finalizeInvites();
    router.push(`/circle/${createdCircleId}`);
  };

  const finishToDashboard = () => {
    finalizeInvites();
    router.push('/dashboard?refreshCircles=true');
  };

  // --- Testnet gas: say it before the button, not after the failure --------
  useEffect(() => {
    if (!userAddress || getCurrentNetwork() !== 'testnet') {
      setNeedsTestnetFunds(false);
      return;
    }
    let cancelled = false;
    const check = async () => {
      try {
        const { totalBalance } = await refreshSuiBalance(userAddress, {
          network: 'testnet',
          forceRefresh: true,
        });
        if (!cancelled) setNeedsTestnetFunds(BigInt(totalBalance) === BigInt(0));
      } catch (balanceError) {
        // A read failure is not a fact: leave the notice as it was, but say so.
        console.warn('Could not read the account balance for the funds notice:', balanceError);
      }
    };
    void check();
    // They open the faucet in a new tab and come back — re-check on return.
    const onReturn = () => {
      if (document.visibilityState === 'visible') void check();
    };
    window.addEventListener('focus', onReturn);
    document.addEventListener('visibilitychange', onReturn);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', onReturn);
      document.removeEventListener('visibilitychange', onReturn);
    };
  }, [userAddress]);

  if (authLoading || !isAuthenticated) {
    return null;
  }

  const stepDefinitions = [
    {
      label: t('create.step.setup.label'),
      title: t('create.step.setup.title'),
      description: t('create.step.setup.description'),
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
            <form onSubmit={handleSubmit} className="space-y-8">
              {/* The page header above already carries the title; this card
                  only appears when the organizer took the "already running"
                  door, so the screen says so. (The goal-pot branch has its
                  own banner below.) */}
              {formData.cycleType === 'rotational' && formData.isMigrating && (
                <div className={sectionCardClass}>
                  <p className={stepLabelClass}>Already running</p>
                  <p className="mt-2 text-sm leading-6 text-[#5f6674]">{t('create.altMigratingOn')}</p>
                </div>
              )}

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
              {/* The quick path: name, amount, cadence, headcount. Everything
                  else the contract needs (deposit, day of cycle, rotation
                  style, penalties, liveness fallback) is derived and lives
                  under "More settings", so a first-time organizer never meets
                  a slider that starts at zero. */}
              <div className="space-y-6">
                <div className="space-y-2">
                  <label htmlFor="name" className="block text-sm font-medium text-gray-700">
                    {t('create.circleNameLabel')}
                  </label>
                  <input
                    type="text"
                    name="name"
                    id="name"
                    required
                    autoFocus
                    value={formData.name}
                    onChange={(e) => handleInputChange('name', e.target.value)}
                    className="block w-full rounded-xl border-gray-300 bg-white px-3 py-3 text-base shadow-sm focus:border-[#1d2533] focus:ring-[#1d2533]"
                    placeholder={t('create.circleNamePlaceholder')}
                  />
                </div>

                <div className="space-y-2">
                  <label htmlFor="contribution-amount" className="block text-sm font-medium text-gray-700">
                    {t('create.amountLabel')}
                  </label>
                  <div className="flex gap-2">
                    <div className="relative flex-1">
                      <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-gray-500">
                        {SUPPORTED_CURRENCIES[formData.selectedCurrency]?.symbol || formData.selectedCurrency}
                      </span>
                      <input
                        id="contribution-amount"
                        type="number"
                        inputMode="decimal"
                        min="0"
                        step="0.01"
                        required
                        value={formData.contributionAmountLocal || ''}
                        onChange={(e) => {
                          const value = e.target.value === '' ? 0 : parseFloat(e.target.value);
                          if (!isNaN(value)) {
                            void handleLocalInputChange('contributionAmountLocal', value);
                          }
                        }}
                        className="block w-full rounded-xl border-gray-300 bg-white py-3 pl-14 pr-3 text-base shadow-sm focus:border-[#1d2533] focus:ring-[#1d2533]"
                        placeholder="0"
                      />
                    </div>
                    <select
                      aria-label={t('create.currencyLabel')}
                      value={formData.selectedCurrency}
                      onChange={(e) => handleInputChange('selectedCurrency', e.target.value)}
                      className="rounded-xl border-gray-300 bg-white py-3 pl-3 pr-8 text-sm font-medium text-[#171923] shadow-sm focus:border-[#1d2533] focus:ring-[#1d2533]"
                    >
                      <optgroup label="Western">
                        {getSupportedCurrencies().western.map((currency: SupportedCurrency) => (
                          <option key={currency.code} value={currency.code}>
                            {currency.code}
                          </option>
                        ))}
                      </optgroup>
                      <optgroup label="African">
                        {getSupportedCurrencies().african.map((currency: SupportedCurrency) => (
                          <option key={currency.code} value={currency.code}>
                            {currency.code}
                          </option>
                        ))}
                      </optgroup>
                    </select>
                  </div>
                  <p className="text-xs text-gray-500">{t('create.amountHint')}</p>
                </div>

                <div className="grid gap-6 sm:grid-cols-2">
                  <div className="space-y-2">
                    <span className="block text-sm font-medium text-gray-700">{t('create.frequencyLabel')}</span>
                    <div role="radiogroup" aria-label={t('create.frequencyLabel')} className="grid grid-cols-2 gap-2">
                      {QUICK_START_FREQUENCIES.map((option) => {
                        const selected = formData.cycleLength === option.value;
                        return (
                          <button
                            key={option.value}
                            type="button"
                            role="radio"
                            aria-checked={selected}
                            onClick={() => handleCycleLengthChange(option.value)}
                            className={`rounded-xl border px-3 py-2.5 text-sm font-medium transition-colors ${
                              selected
                                ? 'border-[#1d2533] bg-[#1d2533] text-white'
                                : 'border-stone-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-stone-50'
                            }`}
                          >
                            {t(option.labelKey)}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div className="space-y-2">
                    <label htmlFor="number-of-members" className="block text-sm font-medium text-gray-700">
                      {t('create.membersLabel')}
                    </label>
                    <input
                      id="number-of-members"
                      type="number"
                      inputMode="numeric"
                      min={MIN_MEMBERS}
                      max={MAX_MEMBERS}
                      value={formData.numberOfMembers || ''}
                      onChange={(event) => {
                        const parsed = Number(event.target.value);
                        handleInputChange('numberOfMembers', Number.isFinite(parsed) ? Math.trunc(parsed) : 0);
                      }}
                      onBlur={() => handleInputChange('numberOfMembers', clampMembers(formData.numberOfMembers))}
                      className="block w-full rounded-xl border-gray-300 bg-white px-3 py-3 text-base shadow-sm focus:border-[#1d2533] focus:ring-[#1d2533]"
                    />
                    <p className="text-xs text-gray-500">
                      {t('create.membersHint', { min: MIN_MEMBERS, max: MAX_MEMBERS })}
                    </p>
                  </div>
                </div>

                <p className="rounded-xl border border-[#e6dccd] bg-[#fcfaf6] px-4 py-3 text-sm leading-6 text-[#5f6674]">
                  {formData.securityDepositLocal > 0
                    ? t('create.depositAuto', {
                        amount: formatCurrency(formData.securityDepositLocal, formData.selectedCurrency),
                      })
                    : t('create.depositAutoEmpty')}
                </p>

                <button
                  type="button"
                  onClick={() => setShowMoreSettings((open) => !open)}
                  aria-expanded={showMoreSettings}
                  className="inline-flex items-center gap-2 text-sm font-medium text-[#1d2533] underline-offset-4 hover:underline"
                >
                  <span className={`transition-transform ${showMoreSettings ? 'rotate-180' : ''}`}>
                    <ChevronDownIcon />
                  </span>
                  {showMoreSettings ? t('create.lessSettings') : t('create.moreSettings')}
                </button>
              </div>

              {showMoreSettings && (
              <div className="space-y-8 rounded-[24px] border border-[#e7dfd4] bg-white p-4 sm:p-5">
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
                
                
                {useCustomDeposit ? (
                  <div className="flex items-center space-x-2">
                    <span className="text-gray-500">{SUPPORTED_CURRENCIES[formData.selectedCurrency]?.symbol || '$'}</span>
                    <input
                      type="number"
                      value={formData.securityDepositLocal || ''}
                      onChange={async (e) => {
                        const value = e.target.value === '' ? 0 : parseFloat(e.target.value);
                        if (!isNaN(value)) {
                          setDepositOverridden(true);
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
                            onValueChange={async ([value]) => {
                              setDepositOverridden(true);
                              await handleLocalInputChange('securityDepositLocal', value);
                            }}
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
              </div>
              )}

              </>
              )}

              {needsTestnetFunds && formData.cycleType === 'rotational' && (
                /* Creating a circle is the organizer's first transaction, and on
                   testnet a fresh account has nothing to pay it with. Say so
                   here, before the button, with the same wording and faucet
                   link as the dashboard banner — instead of letting the
                   transaction fail afterwards with a raw RPC error. */
                <div className="rounded-[22px] border border-amber-200 bg-amber-50/90 p-4">
                  <p className="text-sm font-medium text-amber-900">{t('create.needsFundsTitle')}</p>
                  <p className="mt-1 text-sm text-amber-800">{t('create.needsFundsBody')}</p>
                  <a
                    href={`https://faucet.sui.io/?address=${userAddress || ''}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-3 inline-flex items-center rounded-full border border-amber-400 bg-amber-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-amber-600"
                  >
                    {t('create.openFaucet')}
                  </a>
                </div>
              )}

              <div className="flex flex-col-reverse gap-3 pt-6 sm:flex-row sm:justify-end">
                <button
                  type="button"
                  onClick={() => router.push('/dashboard')}
                  disabled={isCreating}
                  className={secondaryActionClass}
                >
                  {t('create.cancel')}
                </button>
                <button
                  type="submit"
                  disabled={isCreating}
                  className={`${primaryActionClass} disabled:cursor-not-allowed disabled:opacity-60`}
                >
                  {formData.cycleType === 'smart-goal'
                    ? (isCreating ? 'Creating goal pool…' : 'Create goal pool')
                    : (isCreating ? t('create.submitting') : t('create.submit'))}
                </button>
              </div>

              {/* The other two kinds of circle are doors off this screen, not
                  a step in front of it. */}
              {formData.cycleType === 'rotational' ? (
                <div className="flex flex-col gap-2 border-t border-[#e7dfd4] pt-5 text-sm sm:flex-row sm:flex-wrap sm:gap-6">
                  <button
                    type="button"
                    onClick={toggleMigrating}
                    className="text-left font-medium text-[#51627b] underline-offset-4 hover:text-[#171923] hover:underline"
                  >
                    {formData.isMigrating ? t('create.altMigratingOff') : t('create.altMigrating')}
                  </button>
                  <button
                    type="button"
                    onClick={chooseSmartGoal}
                    disabled={checkingSmartGoalAccess}
                    className="text-left font-medium text-[#51627b] underline-offset-4 hover:text-[#171923] hover:underline disabled:opacity-60"
                  >
                    {t('create.altGoal')}
                  </button>
                </div>
              ) : (
                <div className="border-t border-[#e7dfd4] pt-5 text-sm">
                  <button
                    type="button"
                    onClick={chooseRotational}
                    className="font-medium text-[#51627b] underline-offset-4 hover:text-[#171923] hover:underline"
                  >
                    {t('create.altBackToCircle')}
                  </button>
                </div>
              )}
            </form>
          ) : (
            <div className="space-y-8">
              {/* The finish line. The circle exists; the one thing an organizer
                  needs from this screen is the link to forward to their group,
                  so it is resolved on entry (from the creation digest) and
                  shown first — no "fetch manually" scavenger hunt. */}
              <div className="rounded-[24px] border border-emerald-200/70 bg-gradient-to-br from-emerald-50 to-[#fbfaf7] p-5 sm:p-6">
                <p className={stepLabelClass}>{t('create.step.invites.label')}</p>
                <h2 className="mt-2 text-2xl font-semibold tracking-[-0.03em] text-[#171923]">
                  {formData.name.trim()
                    ? t('create.doneTitle', { name: formData.name.trim() })
                    : t('create.doneTitleNoName')}
                </h2>
                <p className="mt-2 text-sm leading-6 text-[#5f6674]">{t('create.doneBody')}</p>

                {inviteLink ? (
                  <div className="mt-5 space-y-3">
                    <div className="flex flex-col gap-2 sm:flex-row">
                      <input
                        type="text"
                        readOnly
                        value={inviteLink}
                        onFocus={(e) => e.currentTarget.select()}
                        aria-label="Invite link"
                        className="block w-full rounded-xl border-gray-300 bg-white text-sm shadow-sm focus:border-[#1d2533] focus:ring-[#1d2533]"
                      />
                      <button
                        type="button"
                        onClick={copyInviteLink}
                        className={`${primaryActionClass} whitespace-nowrap`}
                      >
                        {t('create.copyInvite')}
                      </button>
                    </div>
                    <a
                      href={buildWhatsAppShareUrl(
                        t('create.whatsappText', { name: formData.name, link: inviteLink }),
                      )}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={() => trackFunnel('invite_link_shared')}
                      className="inline-flex items-center justify-center rounded-full border border-[#25D366] bg-[#25D366] px-5 py-3 text-sm font-medium text-white transition hover:bg-[#1ebe5d] focus:outline-none focus:ring-2 focus:ring-[#25D366] focus:ring-offset-2"
                    >
                      {t('create.shareWhatsApp')}
                    </a>
                  </div>
                ) : linkResolveFailed ? (
                  <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900" role="alert">
                    {t('create.linkFailed')}{' '}
                    <button
                      type="button"
                      onClick={() => void resolveInviteLink()}
                      className="font-semibold underline underline-offset-2"
                    >
                      {t('create.linkRetry')}
                    </button>
                  </div>
                ) : (
                  <p className="mt-5 text-sm text-[#5f6674]" role="status">
                    {t('create.linkPending')}
                  </p>
                )}

                {/* An already-running group has one more step than a new one:
                    the history can only be recorded once every member is in and
                    the payout order is set, so it lives on the manage page
                    rather than here. Point at it, or it gets missed and the
                    circle starts over from position one. */}
                {formData.isMigrating && (
                  <div className="mt-5 rounded-[22px] border border-[#d8e2f0] bg-white p-4">
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

              {/* Email / phone invites are the long way round; the link above
                  is how a njangi actually gets shared. Keep them, folded. */}
              <details className="rounded-[24px] border border-[#e7dfd4] bg-[#fbfaf7] p-4 sm:p-5">
                <summary className="cursor-pointer text-sm font-medium text-[#1d2533] underline-offset-4 hover:underline">
                  {t('create.moreInviteOptions')}
                </summary>
                <div className="mt-4">
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
                        <p className="mt-1">Email invites open in your default email client with a pre-written message containing the circle details and the join link.</p>
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
                </div>
              </details>
              <div className="flex flex-col-reverse gap-3 pt-2 sm:flex-row sm:justify-end">
                <button
                  type="button"
                  onClick={finishToDashboard}
                  className={secondaryActionClass}
                >
                  {t('create.backToDashboard')}
                </button>
                <button
                  type="button"
                  onClick={openCreatedCircle}
                  disabled={!createdCircleId}
                  className={`${primaryActionClass} disabled:cursor-not-allowed disabled:opacity-60`}
                >
                  {t('create.openCircle')}
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
