/**
 * Regression: the on-chain *_with_attestation entries take the escrow-pinned
 * ComplianceConfig as an argument. Both gated builders shipped for weeks
 * omitting it — a dormant arity bug that made every gated contribution and
 * gated collect abort on-chain the moment the compliance corridor flag was
 * enabled (discovered live 2026-08-23 on the "Sponsored gas" circle).
 *
 * These tests pin the PTB argument counts to the published signatures:
 *   contribute_with_attestation        (escrow, coin, attestation, config, clock) = 5
 *   contribute_timed_with_attestation  (escrow, coin, attestation, config, clock) = 5
 *   finalize_and_redeem_with_attestation (escrow, attestation, config, clock)     = 4
 */

process.env.NEXT_PUBLIC_TESTNET_PACKAGE_ID =
  '0x' + '9'.repeat(64); // builder only needs a syntactically valid id

import { Transaction } from '@mysten/sui/transactions';
import {
  buildContributeWithAttestationTx,
  buildFinalizeAndRedeemWithAttestationTx,
} from '../cycle-escrow-service';

jest.mock('@/config/feature-flags', () => ({
  isTimedEscrowEntriesEnabled: jest.fn(() => false),
}));
import { isTimedEscrowEntriesEnabled } from '@/config/feature-flags';

const ADDR = (b: string) => '0x' + b.repeat(64);

const BASE = {
  network: 'testnet' as const,
  coinType: '0x2::sui::SUI',
  escrowId: ADDR('a'),
  attestationObjectId: ADDR('b'),
  complianceConfigId: ADDR('c'),
};

function moveCallOf(txb: Transaction) {
  const cmd = txb.getData().commands.find((c) => 'MoveCall' in c) as
    | { MoveCall: { package: string; module: string; function: string; arguments: unknown[] } }
    | undefined;
  if (!cmd) throw new Error('no MoveCall in transaction');
  return cmd.MoveCall;
}

describe('gated escrow builders pass the ComplianceConfig (arity regression)', () => {
  it('contribute_with_attestation sends 5 arguments incl. the config', () => {
    (isTimedEscrowEntriesEnabled as jest.Mock).mockReturnValue(false);
    const txb = new Transaction();
    buildContributeWithAttestationTx({ ...BASE, paymentCoinId: ADDR('d') })(txb);
    const mc = moveCallOf(txb);
    expect(mc.function).toBe('contribute_with_attestation');
    expect(mc.arguments).toHaveLength(5);
  });

  it('switches to contribute_timed_with_attestation under the v1.1 flag, still 5 args', () => {
    (isTimedEscrowEntriesEnabled as jest.Mock).mockReturnValue(true);
    const txb = new Transaction();
    buildContributeWithAttestationTx({ ...BASE, paymentCoinId: ADDR('d') })(txb);
    const mc = moveCallOf(txb);
    expect(mc.function).toBe('contribute_timed_with_attestation');
    expect(mc.arguments).toHaveLength(5);
  });

  it('finalize_and_redeem_with_attestation sends 4 arguments incl. the config', () => {
    (isTimedEscrowEntriesEnabled as jest.Mock).mockReturnValue(false);
    const txb = new Transaction();
    buildFinalizeAndRedeemWithAttestationTx({ ...BASE, circleId: undefined })(txb);
    const mc = moveCallOf(txb);
    expect(mc.function).toBe('finalize_and_redeem_with_attestation');
    expect(mc.arguments).toHaveLength(4);
  });

  it('refuses to build without a complianceConfigId instead of aborting on-chain', () => {
    expect(() =>
      buildContributeWithAttestationTx({
        ...BASE,
        complianceConfigId: '',
        paymentCoinId: ADDR('d'),
      }),
    ).toThrow(/complianceConfigId/);
  });
});
