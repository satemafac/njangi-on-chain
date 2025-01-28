import { Transaction as TransactionBlock } from '@mysten/sui/transactions';
import { SuiClient } from '@mysten/sui/client';
import { bcs } from '@mysten/sui/bcs';
import type { CircleFormData, CycleLength, WeekDay } from '../types/circle';

// Constants from Move contract
const CIRCLE_TYPE_ROTATIONAL = 0;
const CIRCLE_TYPE_SMART_GOAL = 1;
const GOAL_TYPE_AMOUNT = 0;
const GOAL_TYPE_TIME = 1;

// Type-safe mappings
const WEEKDAY_MAP: Record<WeekDay, number> = {
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
  sunday: 7,
};

const CYCLE_LENGTH_MAP: Record<CycleLength, number> = {
  weekly: 0,
  monthly: 1,
  quarterly: 2,
};

export class CircleService {
  constructor(private suiClient: SuiClient, private packageId: string) {}

  async createCircle(formData: CircleFormData) {
    try {
      const tx = new TransactionBlock();
      
      // 1. Convert name to UTF-8 bytes
      const nameBytes = new TextEncoder().encode(formData.name);
      
      // 2. Convert amounts to MIST (1 SUI = 1e9 MIST)
      const contributionAmount = BigInt(Math.floor(formData.contributionAmount * 1e9));
      const securityDeposit = BigInt(Math.floor(formData.securityDeposit * 1e9));
      
      // 3. Convert cycle day to contract format
      const cycleDay = typeof formData.cycleDay === 'string' 
        ? WEEKDAY_MAP[formData.cycleDay as WeekDay]
        : formData.cycleDay;

      // 4. Prepare smart goal options
      const goalType = formData.cycleType === 'smart-goal' && formData.smartGoal
        ? [formData.smartGoal.goalType === 'amount' ? GOAL_TYPE_AMOUNT : GOAL_TYPE_TIME]
        : [];

      const targetAmount = formData.cycleType === 'smart-goal' && 
        formData.smartGoal?.goalType === 'amount' && 
        formData.smartGoal.targetAmount
          ? [BigInt(Math.floor(formData.smartGoal.targetAmount * 1e9))]
          : [];

      const targetDate = formData.cycleType === 'smart-goal' && 
        formData.smartGoal?.goalType === 'date' && 
        formData.smartGoal.targetDate
          ? [BigInt(Math.floor(new Date(formData.smartGoal.targetDate).getTime() / 1000))]
          : [];
      
      // 5. Build transaction
      tx.moveCall({
        target: `${this.packageId}::circle::create_circle`,
        arguments: [
          // Required arguments
          tx.pure(nameBytes),                    // name: vector<u8>
          tx.pure.u64(contributionAmount),       // contribution_amount: u64
          tx.pure.u64(securityDeposit),         // security_deposit: u64
          tx.pure.u8(CYCLE_LENGTH_MAP[formData.cycleLength]), // cycle_length: u8
          tx.pure.u8(cycleDay),                 // cycle_day: u8
          tx.pure.u8(formData.cycleType === 'rotational' ? CIRCLE_TYPE_ROTATIONAL : CIRCLE_TYPE_SMART_GOAL), // circle_type: u8
          tx.pure.u64(formData.numberOfMembers), // max_members: u64
          tx.pure.bool(formData.penaltyRules.latePayment),   // late_payment: bool
          tx.pure.bool(formData.penaltyRules.missedMeeting), // missed_meeting: bool
          
          // Optional arguments for smart goals
          tx.pure(bcs.vector(bcs.u8()).serialize(goalType)),     // goal_type: Option<u8>
          tx.pure(bcs.vector(bcs.u64()).serialize(targetAmount)), // target_amount: Option<u64>
          tx.pure(bcs.vector(bcs.u64()).serialize(targetDate)),   // target_date: Option<u64>
          tx.pure.bool(formData.smartGoal?.verificationRequired || false), // verification_required: bool
        ],
      });

      return tx;
    } catch (error) {
      console.error('Error creating circle transaction:', error);
      throw error;
    }
  }

  // Helper function to invite members to the circle
  async inviteMembers(circleId: string, memberAddresses: string[]) {
    try {
      const tx = new TransactionBlock();
      
      for (const address of memberAddresses) {
        tx.moveCall({
          target: `${this.packageId}::circle::invite_member`,
          typeArguments: [],
          arguments: [
            tx.object(circleId), // circle: &mut NjangiCircle
            tx.pure.address(address), // member_address: address
          ],
        });
      }

      return tx;
    } catch (error) {
      console.error('Error creating invite members transaction:', error);
      throw error;
    }
  }
} 

