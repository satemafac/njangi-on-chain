/**
 * Live on testnet (2026-10-06), only USDC security deposits were sponsored.
 * Every round payment, collect and open signed with the member's own gas,
 * because the round panel's signer never asked, although the allowlist
 * already covered those calls. A member holding no SUI could join a circle
 * and then could not pay in or collect. These pin the panel's requests and
 * the wiring that sends them.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  cancelStalledRoundSponsorRequest,
  escrowSponsorRequest,
  openRoundSponsorRequest,
  payShareSponsorRequest,
} from '@/lib/round-sponsorship';
import type { SupportedCoin } from '@/lib/supported-coins';

const ESCROW = '0x' + 'e'.repeat(64);
const CIRCLE = '0x' + 'd'.repeat(64);
const USDC: SupportedCoin = { symbol: 'USDC', coinType: '0xa::usdc::USDC', decimals: 6 };
const SUI: SupportedCoin = { symbol: 'SUI', coinType: '0x2::sui::SUI', decimals: 9 };

describe('round sponsorship requests', () => {
  it('bills a USDC share through the round escrow', () => {
    expect(payShareSponsorRequest(USDC, ESCROW)).toEqual({
      action: 'payRoundShare',
      context: { escrowId: ESCROW, coinType: USDC.coinType },
    });
  });

  it('never asks for a SUI share, which is split from the gas coin', () => {
    expect(payShareSponsorRequest(SUI, ESCROW)).toBeUndefined();
  });

  it('bills a collect through the round escrow', () => {
    expect(escrowSponsorRequest('collectPayout', ESCROW, USDC.coinType)).toEqual({
      action: 'collectPayout',
      context: { escrowId: ESCROW, coinType: USDC.coinType },
    });
  });

  it('bills a new round through the circle, which has no escrow yet', () => {
    expect(openRoundSponsorRequest(CIRCLE, USDC.coinType)).toEqual({
      action: 'openRound',
      context: { circleId: CIRCLE, coinType: USDC.coinType },
    });
  });

  it('bills a stalled-round cancel through the round escrow, like the expired-claim refund', () => {
    expect(cancelStalledRoundSponsorRequest(ESCROW, USDC.coinType)).toEqual({
      action: 'cancelStalledRound',
      context: { escrowId: ESCROW, coinType: USDC.coinType },
    });
    // A SUI round too: the cancel moves no coin out of the gas coin.
    expect(cancelStalledRoundSponsorRequest(ESCROW, SUI.coinType).context.coinType).toBe(
      SUI.coinType,
    );
  });
});

describe('CycleEscrowPanel asks for sponsorship on every round transaction', () => {
  const source = readFileSync(join(process.cwd(), 'src/components/CycleEscrowPanel.tsx'), 'utf8');

  /** Each `runWithSigner(` call site's argument text, the definition excluded. */
  const runWithSignerCalls = (): string[] =>
    source
      .split('runWithSigner(')
      .slice(1)
      .map((rest) => rest.slice(0, rest.indexOf(');')))
      .filter((args) => args.trimStart().startsWith("'"));

  it('passes a sponsor request from every runWithSigner call', () => {
    const calls = runWithSignerCalls();
    // pay x2, collect x2, advance, refund, cancel: a new call site must make
    // a choice.
    expect(calls).toHaveLength(7);
    for (const args of calls) {
      expect(args).toMatch(/sponsor|SponsorRequest\(/i);
    }
  });

  it('hands the request to the signer', () => {
    expect(source).toContain('signAndExecute({ build, gasBudget }, { sponsor })');
  });

  it('asks for the round open too', () => {
    expect(source).toMatch(/sponsor: openRoundSponsorRequest\(circleId, open\.coin\.coinType\)/);
  });

  it('treats a transaction that landed but failed as a failure, on both paths', () => {
    expect(source.match(/assertTransactionSucceeded\(result\)/g)).toHaveLength(2);
  });
});
