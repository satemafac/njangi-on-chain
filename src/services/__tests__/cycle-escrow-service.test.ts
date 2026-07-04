import type { Transaction } from '@mysten/sui/transactions';
import { buildOpenCycleTx } from '@/services/cycle-escrow-service';

jest.mock('@/services/network-config', () => ({
  getNetworkConfig: () => ({ rpcUrl: 'http://localhost:9000' }),
  getPackageIdForNetwork: () => '0xpkg',
}));

jest.mock('@/services/sui-rpc-failover', () => ({
  getPooledSuiClient: jest.fn(),
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
    pure: { u8: (v: number) => ({ kind: 'u8', v }) },
  } as unknown as Transaction;
  return { txb, calls };
}

const BASE = {
  network: 'testnet' as const,
  circleId: '0xcircle',
  coinType: '0xusdc::usdc::USDC',
};

describe('buildOpenCycleTx', () => {
  // Regression for the on-chain "Incorrect number of arguments for
  // njangi_cycle_escrow::open_cycle_stable_with_gate" abort: the gated
  // entrypoints take the shared ComplianceConfig as their second
  // argument, which the builder used to omit.
  it('passes the ComplianceConfig as the second argument on the gated stable path', () => {
    const { txb, calls } = makeFakeTxb();
    buildOpenCycleTx({
      ...BASE,
      withComplianceGate: true,
      complianceConfigId: '0xconfig',
      stableDecimals: 6,
    })(txb);

    expect(calls).toHaveLength(1);
    expect(calls[0].target).toBe('0xpkg::njangi_cycle_escrow::open_cycle_stable_with_gate');
    expect(calls[0].arguments).toEqual([
      { kind: 'object', id: '0xcircle' },
      { kind: 'object', id: '0xconfig' },
      { kind: 'u8', v: 6 },
      { kind: 'object', id: '0x6' },
    ]);
  });

  it('passes the ComplianceConfig as the second argument on the gated SUI path', () => {
    const { txb, calls } = makeFakeTxb();
    buildOpenCycleTx({
      ...BASE,
      coinType: '0x2::sui::SUI',
      withComplianceGate: true,
      complianceConfigId: '0xconfig',
    })(txb);

    expect(calls[0].target).toBe('0xpkg::njangi_cycle_escrow::open_cycle_with_gate');
    expect(calls[0].arguments).toEqual([
      { kind: 'object', id: '0xcircle' },
      { kind: 'object', id: '0xconfig' },
      { kind: 'object', id: '0x6' },
    ]);
  });

  it('fails at build time with a named error when gated without a config id', () => {
    expect(() =>
      buildOpenCycleTx({ ...BASE, withComplianceGate: true, stableDecimals: 6 }),
    ).toThrow('Missing required argument: complianceConfigId');
  });

  it('keeps the ungated paths unchanged', () => {
    const { txb, calls } = makeFakeTxb();
    buildOpenCycleTx({ ...BASE, stableDecimals: 6 })(txb);

    expect(calls[0].target).toBe('0xpkg::njangi_cycle_escrow::open_cycle_stable');
    expect(calls[0].arguments).toEqual([
      { kind: 'object', id: '0xcircle' },
      { kind: 'u8', v: 6 },
      { kind: 'object', id: '0x6' },
    ]);
  });
});
