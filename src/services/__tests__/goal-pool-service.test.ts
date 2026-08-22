import type { Transaction } from '@mysten/sui/transactions';
import type { SuiClient } from '@mysten/sui/client';
import { buildContributeToPoolTx } from '@/services/goal-pool-service';

jest.mock('@/services/network-config', () => ({
  getPackageIdForNetwork: () => '0xpkg',
}));

jest.mock('@/lib/payment-coin-builder', () => ({
  preparePaymentCoin: jest.fn(async () => ({ coinArg: { kind: 'coin' } })),
}));

interface RecordedCall {
  target: string;
  typeArguments: string[];
  arguments: unknown[];
}

function makeFakeTxb(): { txb: Transaction; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const txb = {
    moveCall: (call: RecordedCall) => {
      calls.push(call);
    },
    object: (id: string) => ({ kind: 'object', id }),
  } as unknown as Transaction;
  return { txb, calls };
}

const fakeClient = {} as SuiClient;

const BASE = {
  network: 'testnet' as const,
  coinType: '0xusdc::usdc::USDC',
  poolId: '0xpool',
  amount: BigInt(500),
  ownerAddress: '0xowner',
};

describe('buildContributeToPoolTx', () => {
  // `njangi_goal_pool::contribute_with_attestation` takes (pool, payment,
  // attestation, config, clock) — the same shape whose ComplianceConfig
  // the cycle-escrow builders once omitted. Lock the full argument order
  // so the gated goal-pool path never regresses the same way.
  it('passes the ComplianceConfig between the attestation and the clock on the gated path', async () => {
    const { txb, calls } = makeFakeTxb();
    await buildContributeToPoolTx({
      ...BASE,
      attestationObjectId: '0xattestation',
      complianceConfigId: '0xconfig',
    })(txb, fakeClient);

    expect(calls).toHaveLength(1);
    expect(calls[0].target).toBe('0xpkg::njangi_goal_pool::contribute_with_attestation');
    expect(calls[0].arguments).toEqual([
      { kind: 'object', id: '0xpool' },
      { kind: 'coin' },
      { kind: 'object', id: '0xattestation' },
      { kind: 'object', id: '0xconfig' },
      { kind: 'object', id: '0x6' },
    ]);
  });

  it('fails with a named error when gated without a config id', async () => {
    const { txb } = makeFakeTxb();
    await expect(
      buildContributeToPoolTx({
        ...BASE,
        attestationObjectId: '0xattestation',
      })(txb, fakeClient),
    ).rejects.toThrow('Missing required argument: complianceConfigId');
  });

  it('keeps the ungated path unchanged', async () => {
    const { txb, calls } = makeFakeTxb();
    await buildContributeToPoolTx(BASE)(txb, fakeClient);

    expect(calls[0].target).toBe('0xpkg::njangi_goal_pool::contribute');
    expect(calls[0].arguments).toEqual([
      { kind: 'object', id: '0xpool' },
      { kind: 'coin' },
    ]);
  });
});
