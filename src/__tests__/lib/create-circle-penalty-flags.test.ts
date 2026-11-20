import type { Transaction } from '@mysten/sui/transactions';
import { buildCreateCircleWithAssetTx } from '../../lib/v11-circle-tx';
import {
  buildCreateCircleTx,
  type CreateCircleTransactionData,
} from '../../lib/zklogin-tx-builders';

// NJA-2593: nothing on chain enforces penalties (the Move side stores fixed
// constants that are only read and the circle's penalty balance never moves),
// so the create-circle builders must always send `false` for both flags,
// whatever the form supplied. No network, RPC or wallet is touched: the
// builders only assemble a Transaction.

const ADDR = (b: string) => `0x${b.repeat(64)}`;
const PKG = ADDR('a');
const REGISTRY = ADDR('b');
const USDC = `0x${'26b3bc67befc214058ca78ea9a2690298d731a2d4309485ec3d40198063c4abc'}::usdc::USDC`;

// BCS of vector<bool> [false, false]: ULEB128 length 2, then two zero bytes.
const NO_PENALTIES = [2, 0, 0];

// In both create builders the penalty vector is the 14th pure input
// (name, currency, contribution local/usd, deposit local/usd, [native
// amounts or contribution/deposit], cycle length, cycle day, circle type,
// max members, rotation style, penalty rules).
const PENALTY_RULES_INPUT_INDEX = 13;

const circleData = (penaltyRules: boolean[]): CreateCircleTransactionData => ({
  name: 'Circle without penalties',
  contribution_amount: '1000000000',
  contribution_amount_local: 1200,
  contribution_amount_usd: 1000,
  currency_type: 'USD',
  security_deposit: '500000000',
  security_deposit_local: 600,
  security_deposit_usd: 500,
  cycle_length: 0,
  cycle_day: 1,
  circle_type: 0,
  max_members: 5,
  rotation_style: 0,
  penalty_rules: penaltyRules,
  verification_required: false,
});

/** The BCS bytes of the `index`-th input of `tx`, which must be a pure value. */
const pureBytesAt = (tx: Transaction, index: number): number[] => {
  const input = tx.getData().inputs[index];
  expect(input?.$kind).toBe('Pure');
  return Array.from(Buffer.from(input!.Pure!.bytes, 'base64'));
};

describe('create-circle builders send no penalty flags (NJA-2593)', () => {
  it('v11 create_circle_with_asset sends [false, false] even when the form asked for penalties', () => {
    const tx = buildCreateCircleWithAssetTx({
      packageId: PKG,
      registryId: REGISTRY,
      coinType: USDC,
      circleData: circleData([true, true]),
      contributionNative: 10_000_000n,
      depositNative: 5_000_000n,
    });
    const call = tx.getData().commands[0].MoveCall!;
    expect(`${call.module}::${call.function}`).toBe('njangi_circles::create_circle_with_asset');
    // Currently [2, 1, 1]: the organizer's switches are sent on chain although
    // nothing collects a penalty.
    expect(pureBytesAt(tx, PENALTY_RULES_INPUT_INDEX)).toEqual(NO_PENALTIES);
  });

  it('legacy create_circle sends [false, false] even when the form asked for penalties', () => {
    const tx = buildCreateCircleTx({
      packageId: PKG,
      circleData: circleData([true, true]),
    });
    const call = tx.getData().commands[0].MoveCall!;
    expect(`${call.module}::${call.function}`).toBe('njangi_circles::create_circle');
    expect(pureBytesAt(tx, PENALTY_RULES_INPUT_INDEX)).toEqual(NO_PENALTIES);
  });
});
