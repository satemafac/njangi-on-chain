import type { Transaction } from '@mysten/sui/transactions';
import {
  buildContributeWithAttestationTx,
  buildFinalizeAndRedeemWithAttestationTx,
  buildOpenCycleTx,
  buildReleaseOpenRoundTx,
} from '@/services/cycle-escrow-service';

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

describe('buildContributeWithAttestationTx', () => {
  // Regression: `contribute_with_attestation` takes (escrow, payment,
  // attestation, config, clock). The builder used to omit the shared
  // ComplianceConfig, so every gated contribution aborted on-chain with
  // "Incorrect number of arguments".
  it('passes the ComplianceConfig between the attestation and the clock', () => {
    const { txb, calls } = makeFakeTxb();
    buildContributeWithAttestationTx({
      ...BASE,
      escrowId: '0xescrow',
      paymentCoinId: '0xcoin',
      attestationObjectId: '0xattestation',
      complianceConfigId: '0xconfig',
    })(txb);

    expect(calls).toHaveLength(1);
    expect(calls[0].target).toBe('0xpkg::njangi_cycle_escrow::contribute_with_attestation');
    expect(calls[0].typeArguments).toEqual([BASE.coinType]);
    expect(calls[0].arguments).toEqual([
      { kind: 'object', id: '0xescrow' },
      { kind: 'object', id: '0xcoin' },
      { kind: 'object', id: '0xattestation' },
      { kind: 'object', id: '0xconfig' },
      { kind: 'object', id: '0x6' },
    ]);
  });

  it('fails at build time with a named error when the config id is missing', () => {
    expect(() =>
      buildContributeWithAttestationTx({
        ...BASE,
        escrowId: '0xescrow',
        paymentCoinId: '0xcoin',
        attestationObjectId: '0xattestation',
        complianceConfigId: '',
      }),
    ).toThrow('Missing required argument: complianceConfigId');
  });
});

describe('buildFinalizeAndRedeemWithAttestationTx', () => {
  // Regression: `finalize_and_redeem_with_attestation` takes (escrow,
  // attestation, config, clock). The builder used to omit the shared
  // ComplianceConfig, so every gated payout aborted on-chain with
  // "Incorrect number of arguments".
  it('passes the ComplianceConfig between the attestation and the clock', () => {
    const { txb, calls } = makeFakeTxb();
    buildFinalizeAndRedeemWithAttestationTx({
      ...BASE,
      circleId: undefined,
      escrowId: '0xescrow',
      attestationObjectId: '0xattestation',
      complianceConfigId: '0xconfig',
    })(txb);

    expect(calls).toHaveLength(1);
    expect(calls[0].target).toBe(
      '0xpkg::njangi_cycle_escrow::finalize_and_redeem_with_attestation',
    );
    expect(calls[0].arguments).toEqual([
      { kind: 'object', id: '0xescrow' },
      { kind: 'object', id: '0xattestation' },
      { kind: 'object', id: '0xconfig' },
      { kind: 'object', id: '0x6' },
    ]);
  });

  it('still chains advance_circle_after_claim when a circleId is provided', () => {
    const { txb, calls } = makeFakeTxb();
    buildFinalizeAndRedeemWithAttestationTx({
      ...BASE,
      escrowId: '0xescrow',
      circleId: '0xcircle',
      attestationObjectId: '0xattestation',
      complianceConfigId: '0xconfig',
    })(txb);

    expect(calls).toHaveLength(2);
    expect(calls[1].target).toBe('0xpkg::njangi_cycle_escrow::advance_circle_after_claim');
    expect(calls[1].arguments).toEqual([
      { kind: 'object', id: '0xcircle' },
      { kind: 'object', id: '0xescrow' },
      { kind: 'object', id: '0x6' },
    ]);
  });

  it('fails at build time with a named error when the config id is missing', () => {
    expect(() =>
      buildFinalizeAndRedeemWithAttestationTx({
        ...BASE,
        escrowId: '0xescrow',
        attestationObjectId: '0xattestation',
        complianceConfigId: '',
      }),
    ).toThrow('Missing required argument: complianceConfigId');
  });
});

describe('buildOpenCycleTx release chaining (Circle Record v1.2)', () => {
  // Once the duplicate-open guard is published, a refunded escrow keeps its
  // round pinned until release_open_round clears the marker; the release
  // must land in the same PTB, ahead of the open, or the open aborts 234.
  const FLAG = 'NEXT_PUBLIC_ESCROW_ROUND_GUARD_ENABLED';
  let original: string | undefined;

  beforeEach(() => {
    original = process.env[FLAG];
    delete process.env[FLAG];
  });

  afterEach(() => {
    if (original === undefined) delete process.env[FLAG];
    else process.env[FLAG] = original;
  });

  it('chains release_open_round ahead of the open when the guard flag is on', () => {
    process.env[FLAG] = 'true';
    const { txb, calls } = makeFakeTxb();
    buildOpenCycleTx({ ...BASE, stableDecimals: 6, releaseEscrowId: '0xrefunded' })(txb);

    expect(calls.map((c) => c.target)).toEqual([
      '0xpkg::njangi_cycle_escrow::release_open_round',
      '0xpkg::njangi_cycle_escrow::open_cycle_stable',
    ]);
    expect(calls[0].typeArguments).toEqual([BASE.coinType]);
    expect(calls[0].arguments).toEqual([
      { kind: 'object', id: '0xcircle' },
      { kind: 'object', id: '0xrefunded' },
      { kind: 'object', id: '0x6' },
    ]);
  });

  it('drops the release while the flag is off: the published package may not carry it', () => {
    const { txb, calls } = makeFakeTxb();
    buildOpenCycleTx({ ...BASE, stableDecimals: 6, releaseEscrowId: '0xrefunded' })(txb);

    expect(calls).toHaveLength(1);
    expect(calls[0].target).toBe('0xpkg::njangi_cycle_escrow::open_cycle_stable');
  });

  it('never adds a release without an escrow to release, flag or no flag', () => {
    process.env[FLAG] = 'true';
    const { txb, calls } = makeFakeTxb();
    buildOpenCycleTx({ ...BASE, stableDecimals: 6 })(txb);

    expect(calls).toHaveLength(1);
    expect(calls[0].target).toBe('0xpkg::njangi_cycle_escrow::open_cycle_stable');
  });
});

describe('buildReleaseOpenRoundTx', () => {
  it('builds the standalone release call (circle, escrow, clock)', () => {
    const { txb, calls } = makeFakeTxb();
    buildReleaseOpenRoundTx({ ...BASE, escrowId: '0xabandoned' })(txb);

    expect(calls).toHaveLength(1);
    expect(calls[0].target).toBe('0xpkg::njangi_cycle_escrow::release_open_round');
    expect(calls[0].typeArguments).toEqual([BASE.coinType]);
    expect(calls[0].arguments).toEqual([
      { kind: 'object', id: '0xcircle' },
      { kind: 'object', id: '0xabandoned' },
      { kind: 'object', id: '0x6' },
    ]);
  });

  it('fails at build time with a named error when the escrow id is missing', () => {
    expect(() => buildReleaseOpenRoundTx({ ...BASE, escrowId: '' })).toThrow(
      'Missing required argument: escrowId',
    );
  });
});
