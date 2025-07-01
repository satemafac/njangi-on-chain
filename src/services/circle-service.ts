import { Transaction as TransactionBlock } from '@mysten/sui/transactions';
import { SuiClient } from '@mysten/sui/client';
import { bcs } from '@mysten/sui/bcs';
import type { CircleFormData, CycleLength, WeekDay } from '../types/circle';

// Check if we're on the client side
const isClient = typeof window !== 'undefined';

// Get package ID from environment variable, or fall back to a default value
export const PACKAGE_ID = isClient 
  ? process.env.NEXT_PUBLIC_PACKAGE_ID || "0xd530bfd7511ac2d343646a8ca4e2e14ffb89e1ec69a38ff8fb99c415706d6154"
  : process.env.NEXT_PUBLIC_PACKAGE_ID || "0xd530bfd7511ac2d343646a8ca4e2e14ffb89e1ec69a38ff8fb99c415706d6154";

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
      
      // 3. Convert currency type to UTF-8 bytes
      const currencyTypeBytes = new TextEncoder().encode(formData.selectedCurrency);
      
      // 4. Convert local currency amounts to appropriate format
      const contributionAmountLocal = BigInt(Math.floor(formData.contributionAmountLocal * 100));
      const securityDepositLocal = BigInt(Math.floor(formData.securityDepositLocal * 100));
      
      // 5. Convert cycle day to contract format
      const cycleDay = typeof formData.cycleDay === 'string' 
        ? WEEKDAY_MAP[formData.cycleDay as WeekDay]
        : formData.cycleDay;

      // 6. Prepare smart goal options
      const goalType = formData.cycleType === 'smart-goal' && formData.smartGoal
        ? [formData.smartGoal.goalType === 'amount' ? GOAL_TYPE_AMOUNT : GOAL_TYPE_TIME]
        : [];

      const targetAmount = formData.cycleType === 'smart-goal' && 
        formData.smartGoal?.goalType === 'amount' && 
        formData.smartGoal.targetAmount
          ? [BigInt(Math.floor(formData.smartGoal.targetAmount * 1e9))]
          : [];

      // 7. Convert target amount local currency
      const targetAmountLocal = formData.cycleType === 'smart-goal' && 
        formData.smartGoal?.goalType === 'amount' && 
        formData.smartGoal.targetAmountLocal
          ? [BigInt(Math.floor(formData.smartGoal.targetAmountLocal * 100))]
          : [];

      const targetDate = formData.cycleType === 'smart-goal' && 
        formData.smartGoal?.goalType === 'date' && 
        formData.smartGoal.targetDate
          ? [BigInt(Math.floor(new Date(formData.smartGoal.targetDate).getTime()))]
          : [];
      
      // 8. Build transaction with new currency-aware parameters
      tx.moveCall({
        target: `${PACKAGE_ID}::njangi_circles::create_circle`,
        arguments: [
          tx.pure(nameBytes),                    // name: vector<u8>
          tx.pure.u64(contributionAmount),       // contribution_amount: u64
          tx.pure(currencyTypeBytes),            // currency_type: vector<u8>
          tx.pure.u64(contributionAmountLocal),  // contribution_amount_local: u64
          tx.pure.u64(securityDeposit),          // security_deposit: u64
          tx.pure.u64(securityDepositLocal),     // security_deposit_local: u64
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
          tx.pure(bcs.vector(bcs.u64()).serialize(targetAmountLocal)), // target_amount_local: Option<u64>
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
        target: `${PACKAGE_ID}::njangi_circles::join_circle`,
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
          target: `${PACKAGE_ID}::njangi_circles::invite_member`,
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

// Standalone helper functions for multi-package support
// These can be imported and used directly without needing a CircleService instance

/**
 * Get the package ID that was used to create a specific circle
 * @param circleId The ID of the circle to look up
 * @param userAddress Optional user address to optimize the search
 * @returns Promise<string> The package ID used to create the circle
 */
export async function getCirclePackageId(circleId: string, userAddress?: string): Promise<string> {
  try {
    const client = new SuiClient({ url: 'https://fullnode.testnet.sui.io:443' });
    
    // If we have a user address, get their package IDs first (more efficient)
    if (userAddress) {
      const userPackageIds = await getUserPackageIds(userAddress);
      
      // Search through each package ID for the circle
      for (const packageId of userPackageIds) {
        try {
          const events = await client.queryEvents({
            query: { MoveEventType: `${packageId}::njangi_circles::CircleCreated` },
            limit: 100
          });
          
          const foundEvent = events.data.find(event => 
            (event.parsedJson as { circle_id?: string })?.circle_id === circleId
          );
          
          if (foundEvent) {
            console.log(`Found circle ${circleId} created with package ${packageId}`);
            return packageId;
          }
        } catch (error) {
          console.warn(`Error querying events for package ${packageId}:`, error);
          continue;
        }
      }
    }
    
    // Fallback: try with the current default package ID
    try {
      const events = await client.queryEvents({
        query: { MoveEventType: `${PACKAGE_ID}::njangi_circles::CircleCreated` },
        limit: 100
      });
      
      const foundEvent = events.data.find(event => 
        (event.parsedJson as { circle_id?: string })?.circle_id === circleId
      );
      
      if (foundEvent) {
        console.log(`Found circle ${circleId} created with default package ${PACKAGE_ID}`);
        return PACKAGE_ID;
      }
    } catch (error) {
      console.warn('Error querying events for default package:', error);
    }
    
    // If not found anywhere, return the current package ID as fallback
    console.warn(`Could not find package ID for circle ${circleId}, using default ${PACKAGE_ID}`);
    return PACKAGE_ID;
    
  } catch (error) {
    console.error('Error in getCirclePackageId:', error);
    return PACKAGE_ID; // Return default as fallback
  }
}

/**
 * Get all package IDs that a user has used to create circles
 * @param userAddress The user's address
 * @returns Promise<string[]> Array of package IDs used by the user
 */
export async function getUserPackageIds(userAddress: string): Promise<string[]> {
  try {
    const client = new SuiClient({ url: 'https://fullnode.testnet.sui.io:443' });
    const packageIds = new Set<string>();
    
    // Always include the current default package ID
    packageIds.add(PACKAGE_ID);
    
    // Get user's transactions to find package IDs they've interacted with
    try {
      const response = await client.queryTransactionBlocks({
        filter: { FromAddress: userAddress },
        limit: 50,
        options: { showEvents: true, showObjectChanges: true }
      });
      
      for (const tx of response.data) {
        // Look through events for CircleCreated events
        if (tx.events) {
          for (const event of tx.events) {
            if (event.type.includes('::njangi_circles::CircleCreated')) {
              // Extract package ID from the event type
              const match = event.type.match(/^(0x[a-f0-9]+)::/);
              if (match && match[1]) {
                packageIds.add(match[1]);
              }
            }
          }
        }
        
        // Look through object changes for objects from different packages
        if (tx.objectChanges) {
          for (const change of tx.objectChanges) {
            if (change.type === 'created' && change.objectType?.includes('::njangi_circles::Circle')) {
              // Extract package ID from the object type
              const match = change.objectType.match(/^(0x[a-f0-9]+)::/);
              if (match && match[1]) {
                packageIds.add(match[1]);
              }
            }
          }
        }
      }
    } catch (error) {
      console.warn('Error querying user transactions:', error);
    }
    
    const result = Array.from(packageIds);
    console.log(`Found ${result.length} package IDs for user ${userAddress}:`, result);
    return result;
    
  } catch (error) {
    console.error('Error in getUserPackageIds:', error);
    return [PACKAGE_ID]; // Return default package ID as fallback
  }
} 

