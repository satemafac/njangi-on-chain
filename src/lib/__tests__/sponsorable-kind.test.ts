/**
 * Under sponsorship the gas coin is the sponsor's coin, so a sponsored kind
 * that splits, merges, transfers or passes it spends the sponsor's SUI. A SUI
 * share is split from exactly that coin (payment-coin-builder.ts). The rule
 * used to rest on a `usesGasCoinForValue` flag the client sent; these pin the
 * reading of the transaction itself that both the browser and
 * /api/sponsor/prepare now apply.
 */

// The escrow builders resolve the package id when they are called.
const TESTNET_PKG = '0x' + '9'.repeat(64);
process.env.NEXT_PUBLIC_TESTNET_PACKAGE_ID = TESTNET_PKG;

import type { SuiClient } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import { judgeSponsorableKind, kindUsesGasCoin } from '@/lib/sponsorable-kind';
import { buildContributeWithAutoCoinTx } from '@/services/cycle-escrow-service';

const PKG = '0x' + '1'.repeat(64);
const ESCROW = '0x' + 'e'.repeat(64);
const USER = '0x' + 'a'.repeat(64);
const USDC = `${'0x' + 'c'.repeat(64)}::usdc::USDC`;
const CONTRIBUTE = `${PKG}::njangi_cycle_escrow::contribute`;
const ALLOWED = [CONTRIBUTE];

const objRef = (id: string) => ({
  objectId: id,
  version: '1',
  digest: '11111111111111111111111111111111',
});

/** Built and decoded the way prepare reads a kind, offline (every input explicit). */
async function decoded(fill: (txb: Transaction) => void) {
  const txb = new Transaction();
  fill(txb);
  return Transaction.fromKind(await txb.build({ onlyTransactionKind: true })).getData();
}

const escrowArg = (txb: Transaction) =>
  txb.sharedObjectRef({ objectId: ESCROW, initialSharedVersion: 1, mutable: true });

/** A USDC share: merged and split from the member's own coins. */
function ownedCoinPay(txb: Transaction) {
  const primary = txb.objectRef(objRef('0x' + '3'.repeat(64)));
  txb.mergeCoins(primary, [txb.objectRef(objRef('0x' + '4'.repeat(64)))]);
  const [share] = txb.splitCoins(primary, [txb.pure.u64(100_000)]);
  txb.moveCall({ target: CONTRIBUTE, typeArguments: [USDC], arguments: [escrowArg(txb), share] });
}

/** A SUI share: split from the gas coin. */
function gasCoinPay(txb: Transaction) {
  const [share] = txb.splitCoins(txb.gas, [txb.pure.u64(84_745_763)]);
  txb.moveCall({ target: CONTRIBUTE, typeArguments: ['0x2::sui::SUI'], arguments: [escrowArg(txb), share] });
}

describe('kindUsesGasCoin', () => {
  it("is false for a share paid from the member's own coins", async () => {
    expect(kindUsesGasCoin(await decoded(ownedCoinPay))).toBe(false);
  });

  it('is true for a share split from the gas coin', async () => {
    expect(kindUsesGasCoin(await decoded(gasCoinPay))).toBe(true);
  });

  it.each([
    [
      'merged into',
      (txb: Transaction) => txb.mergeCoins(txb.gas, [txb.objectRef(objRef('0x' + '5'.repeat(64)))]),
    ],
    ['transferred', (txb: Transaction) => txb.transferObjects([txb.gas], txb.pure.address(USER))],
    [
      'passed to a Move call',
      (txb: Transaction) =>
        txb.moveCall({ target: CONTRIBUTE, typeArguments: [USDC], arguments: [escrowArg(txb), txb.gas] }),
    ],
  ])('is true when the gas coin is %s', async (_how, fill) => {
    expect(kindUsesGasCoin(await decoded(fill))).toBe(true);
  });

  describe('on the transactions the Pay button really builds', () => {
    const stubClient = {
      getBalance: async () => ({ totalBalance: '5000000000' }),
      getCoins: async () => ({
        data: [{ coinObjectId: '0x' + '6'.repeat(64), balance: '900000', ...objRef('0x' + '6'.repeat(64)) }],
        hasNextPage: false,
        nextCursor: null,
      }),
    } as unknown as SuiClient;

    async function payKindData(coinType: string) {
      const txb = new Transaction();
      await buildContributeWithAutoCoinTx({
        network: 'testnet',
        coinType,
        escrowId: ESCROW,
        contributionAmount: 100_000n,
        ownerAddress: USER,
      })(txb, stubClient);
      return txb.getData();
    }

    it('a SUI share uses the gas coin, so it can never be sponsored', async () => {
      expect(kindUsesGasCoin(await payKindData('0x2::sui::SUI'))).toBe(true);
    });

    it('a USDC share does not', async () => {
      expect(kindUsesGasCoin(await payKindData(USDC))).toBe(false);
    });
  });
});

describe('judgeSponsorableKind', () => {
  it('accepts an allowlisted share paid from owned coins and lists what it touches', async () => {
    const verdict = judgeSponsorableKind(await decoded(ownedCoinPay), ALLOWED);
    expect(verdict.sponsorable).toBe(true);
    if (!verdict.sponsorable) return;
    expect(verdict.objectIds.has(ESCROW)).toBe(true);
  });

  it('refuses a share split from the gas coin even though its target is allowlisted', async () => {
    expect(judgeSponsorableKind(await decoded(gasCoinPay), ALLOWED)).toMatchObject({
      sponsorable: false,
      reason: 'gas_coin_used',
    });
  });

  it('refuses a Move call outside the allowlist', async () => {
    const verdict = judgeSponsorableKind(
      await decoded((txb) =>
        txb.moveCall({ target: `${PKG}::njangi_circles::delete_circle`, arguments: [escrowArg(txb)] }),
      ),
      ALLOWED,
    );
    expect(verdict).toMatchObject({ sponsorable: false, reason: 'target_not_allowed' });
  });

  it('refuses commands no member action uses, such as a publish', async () => {
    const verdict = judgeSponsorableKind(
      await decoded((txb) => {
        ownedCoinPay(txb);
        const cap = txb.publish({ modules: [[1, 2, 3]], dependencies: ['0x1'] });
        txb.transferObjects([cap], txb.pure.address(USER));
      }),
      ALLOWED,
    );
    expect(verdict).toMatchObject({ sponsorable: false, reason: 'command_not_allowed' });
  });
});
