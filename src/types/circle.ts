export type CycleType = 'rotational' | 'smart-goal';
export type RotationStyle = 'fixed' | 'auction-based';
export type CycleLength = 'weekly' | 'monthly' | 'quarterly';
export type WeekDay = 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday';

export interface CircleFormData {
  name: string;
  selectedCurrency: string; // Selected currency code (e.g., 'USD', 'NGN', 'XAF')
  contributionAmount: number; // SUI amount
  contributionAmountUSD: number; // Deprecated - use contributionAmountLocal
  contributionAmountLocal: number; // Amount in selected currency
  cycleLength: CycleLength;
  cycleDay: number | WeekDay;
  cycleType: CycleType;
  rotationStyle?: RotationStyle;
  numberOfMembers: number;
  securityDeposit: number; // SUI amount
  securityDepositUSD: number; // Deprecated - use securityDepositLocal
  securityDepositLocal: number; // Amount in selected currency
  penaltyRules: {
    latePayment: boolean;
    missedMeeting: boolean;
  };
  smartGoal?: {
    goalType: 'amount' | 'date';
    targetAmount?: number;
    targetAmountUSD?: number; // Deprecated - use targetAmountLocal
    targetAmountLocal?: number; // Amount in selected currency
    targetDate?: string;
    verificationRequired: boolean;
  };
} 