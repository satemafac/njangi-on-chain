import { Transaction as TransactionBlock } from '@mysten/sui/transactions';
import { SuiClient } from '@mysten/sui/client';
import { bcs } from '@mysten/sui/bcs';
import type { CircleFormData, CycleLength, WeekDay } from '../types/circle';

// Package ID from published contract
const PACKAGE_ID = "0x3668a1e8e51453627141a2d2043e0244242dfe38c2f324686f6b4ec76d4d5a6d";

// Constants from Move contract
const CIRCLE_TYPE_ROTATIONAL = 0;
const CIRCLE_TYPE_SMART_GOAL = 1;
const ROTATION_STYLE_FIXED = 0;
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
  sunday: 0, // Changed to 0 to match contract
};

const CYCLE_LENGTH_MAP: Record<CycleLength, number> = {
  weekly: 0,
  monthly: 1,
  quarterly: 2,
};

export class CircleService {
  constructor(private suiClient: SuiClient) {}

  async createCircle(formData: CircleFormData) {
    try {
      const tx = new TransactionBlock();
      
      // Get clock object
      const [clock] = tx.moveCall({
        target: '0x2::clock::clock',
        arguments: [],
      });
      
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
          ? [BigInt(Math.floor(new Date(formData.smartGoal.targetDate).getTime()))]
          : [];
      
      // 5. Build transaction
      tx.moveCall({
        target: `${PACKAGE_ID}::njangi_circle::create_circle`,
        arguments: [
          tx.pure(nameBytes),                    // name: vector<u8>
          tx.pure.u64(contributionAmount),       // contribution_amount: u64
          tx.pure.u64(securityDeposit),         // security_deposit: u64
          tx.pure.u64(CYCLE_LENGTH_MAP[formData.cycleLength]), // cycle_length: u64
          tx.pure.u64(cycleDay),                // cycle_day: u64
          tx.pure.u8(formData.cycleType === 'rotational' ? CIRCLE_TYPE_ROTATIONAL : CIRCLE_TYPE_SMART_GOAL), // circle_type: u8
          tx.pure.u64(formData.numberOfMembers), // max_members: u64
          tx.pure.u8(ROTATION_STYLE_FIXED),     // rotation_style: u8
          tx.pure(bcs.vector(bcs.bool()).serialize([
            formData.penaltyRules.latePayment,
            formData.penaltyRules.missedMeeting
          ])),                                  // penalty_rules: vector<bool>
          tx.pure(bcs.vector(bcs.u8()).serialize(goalType)),     // goal_type: Option<u8>
          tx.pure(bcs.vector(bcs.u64()).serialize(targetAmount)), // target_amount: Option<u64>
          tx.pure(bcs.vector(bcs.u64()).serialize(targetDate)),   // target_date: Option<u64>
          tx.pure.bool(formData.smartGoal?.verificationRequired || false), // verification_required: bool
          clock,                               // clock: &Clock
        ],
      });

      return tx;
    } catch (error) {
      console.error('Error creating circle transaction:', error);
      throw error;
    }
  }

  async joinCircle(circleId: string, depositAmount: number) {
    try {
      const tx = new TransactionBlock();
      
      // Get clock object
      const [clock] = tx.moveCall({
        target: '0x2::clock::clock',
        arguments: [],
      });

      // Create deposit coin
      const [depositCoin] = tx.moveCall({
        target: '0x2::coin::mint_for_testing',
        typeArguments: ['0x2::sui::SUI'],
        arguments: [tx.pure.u64(BigInt(Math.floor(depositAmount * 1e9)))],
      });

      // Join the circle
      tx.moveCall({
        target: `${PACKAGE_ID}::njangi_circle::join_circle`,
        arguments: [
          tx.object(circleId),    // circle: &mut Circle
          depositCoin,            // deposit: Coin<SUI>
          tx.pure(bcs.vector(bcs.u64()).serialize([])), // position: Option<u64>
          clock,                  // clock: &Clock
        ],
      });

      return tx;
    } catch (error) {
      console.error('Error creating join circle transaction:', error);
      throw error;
    }
  }

  // Helper function to invite members to the circle
  async inviteMembers(circleId: string, memberAddresses: string[]) {
    try {
      const tx = new TransactionBlock();
      
      for (const address of memberAddresses) {
        tx.moveCall({
          target: `${PACKAGE_ID}::njangi_circle::invite_member`,
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

