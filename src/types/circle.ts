export type CycleType = 'rotational' | 'smart-goal';
export type RotationStyle = 'fixed' | 'auction-based';
export type CycleLength = 'weekly' | 'monthly' | 'quarterly';
export type WeekDay = 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday';

export interface CircleFormData {
  name: string;
  contributionAmount: number;
  cycleLength: CycleLength;
  cycleDay: number | WeekDay;
  cycleType: CycleType;
  rotationStyle?: RotationStyle;
  numberOfMembers: number;
  securityDeposit: number;
  penaltyRules: {
    latePayment: boolean;
    missedMeeting: boolean;
  };
  smartGoal?: {
    goalType: 'amount' | 'date';
    targetAmount?: number;
    targetDate?: string;
    verificationRequired: boolean;
  };
} 