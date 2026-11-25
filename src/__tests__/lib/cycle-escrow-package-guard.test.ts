/**
 * NJA-3953: a CycleEscrow counts as ours only when its Move type's package is
 * one of this app's (appPackageIds). On this commit verifyCycleEscrowForCircle
 * matches the package-less marker '::njangi_cycle_escrow::CycleEscrow<'
 * (cycle-escrow-discovery.ts:364, :403) and readCycleEscrowState checks no
 * type at all (:715-717), so a look-alike escrow published by anyone, naming
 * our circle_id, verifies true and reads as the round. The client is injected
 * and the failover layer stubbed; nothing here reaches the network.
 */
jest.mock('../../services/network-config', () => ({
  ...(jest.requireActual('../../services/network-config') as Record<string, unknown>),
  getCurrentNetwork: () => 'testnet',
}));
jest.mock('../../services/sui-rpc-failover', () => ({
  ...(jest.requireActual('../../services/sui-rpc-failover') as Record<string, unknown>),
  getPooledSuiClient: jest.fn(() => {
    throw new Error('this test reaches no network');
  }),
  withSuiRpcFailover: jest.fn(async () => {
    throw new Error('this test reaches no network');
  }),
}));

import type { SuiClient } from '@mysten/sui/client';
import { appPackageIds } from '../../lib/app-packages';
import {
  readCycleEscrowState,
  verifyCycleEscrowForCircle,
} from '../../lib/cycle-escrow-discovery';

const CIRCLE = `0x${'c1'.repeat(32)}`;
const OTHER_CIRCLE = `0x${'a1'.repeat(32)}`;
const ESCROW = `0x${'e3'.repeat(32)}`;
const RECIPIENT = `0x${'1f'.repeat(32)}`;
const MEMBER = `0x${'ab'.repeat(32)}`;
const USDC = `0x${'26'.repeat(32)}::usdc::USDC`;
/** The testnet lineage's original id (package-lineage.ts), one of appPackageIds('testnet'). */
const APP_PACKAGE = '0x89cddf4dfe654e7c7b16333096d9e750cf04bb96f7de934403a512d460594f02';
/** A package nobody in this app published. */
const FORGED_PACKAGE = `0x${'ee'.repeat(32)}`;

const cycleEscrowType = (pkg: string) => `${pkg}::njangi_cycle_escrow::CycleEscrow<${USDC}>`;

/**
 * getObject({ showType, showContent }) for a CycleEscrow<USDC>, in the shape
 * testnet returns. Without `type` both the object-level and the content-level
 * type are left off, as a read that returned no Move type does.
 */
const escrowObject = (opts: { type?: string; circleId?: string }) => ({
  data: {
    objectId: ESCROW,
    version: '1',
    digest: 'digest',
    ...(opts.type ? { type: opts.type } : {}),
    content: {
      dataType: 'moveObject' as const,
      ...(opts.type ? { type: opts.type } : {}),
      hasPublicTransfer: false,
      fields: {
        id: { id: ESCROW },
        balance: '0',
        circle_id: opts.circleId ?? CIRCLE,
        claimed: false,
        claim_expires_at_ms: '1793926356233',
        contributors_count: '1',
        finalized: true,
        refunded: false,
        requires_attestation: false,
        snapshot: {
          type: `${APP_PACKAGE}::njangi_cycle_escrow::CycleSnapshot`,
          fields: {
            cycle_no: '5',
            recipient: RECIPIENT,
            members: [MEMBER, RECIPIENT],
            required_contributors: '1',
            contribution_amount: '100000',
            due_at_ms: '1792540800000',
            opened_at_ms: '1788742214815',
          },
        },
      },
    },
  },
});

const clientServing = (object: unknown) =>
  ({ getObject: jest.fn(async () => object) }) as unknown as SuiClient;

/** 'state' when the read was accepted; 'null' or 'threw' when it was not. */
const stateOutcome = (client: SuiClient) =>
  readCycleEscrowState(ESCROW, 'testnet', client).then(
    (state) => (state === null ? 'null' : 'state'),
    () => 'threw',
  );

describe("CycleEscrow reads accept only this app's packages (NJA-3953)", () => {
  beforeEach(() => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  it('refuses an escrow from another package even when it names our circle', async () => {
    expect(appPackageIds('testnet')).not.toContain(FORGED_PACKAGE);
    const client = clientServing(escrowObject({ type: cycleEscrowType(FORGED_PACKAGE) }));

    // On this commit: verdict true, because the package-less marker matches.
    const verified = await verifyCycleEscrowForCircle(client, ESCROW, CIRCLE);
    expect(verified.verdict).toBe(false);

    // On this commit: a full CycleEscrowLiveState, because no type is checked.
    await expect(stateOutcome(client)).resolves.not.toBe('state');
  });

  it('refuses an escrow of this app that names another circle', async () => {
    const client = clientServing(
      escrowObject({ type: cycleEscrowType(APP_PACKAGE), circleId: OTHER_CIRCLE }),
    );
    const verified = await verifyCycleEscrowForCircle(client, ESCROW, CIRCLE);
    expect(verified.verdict).toBe(false);
  });

  it('treats an object read without any Move type as unknown, never accepted', async () => {
    const client = clientServing(escrowObject({}));

    const verified = await verifyCycleEscrowForCircle(client, ESCROW, CIRCLE);
    expect(verified.verdict).toBeNull();

    // On this commit: accepted as a state, because readCycleEscrowState
    // never looks at the type.
    await expect(stateOutcome(client)).resolves.not.toBe('state');
  });

  it("reads this app's escrow exactly as before", async () => {
    expect(appPackageIds('testnet')).toContain(APP_PACKAGE);
    const client = clientServing(escrowObject({ type: cycleEscrowType(APP_PACKAGE) }));

    const verified = await verifyCycleEscrowForCircle(client, ESCROW, CIRCLE);
    expect(verified.verdict).toBe(true);
    if (verified.verdict === true) {
      expect(verified.summary).toMatchObject({ escrowId: ESCROW, circleId: CIRCLE, cycleNo: 5 });
    }

    const state = await readCycleEscrowState(ESCROW, 'testnet', client);
    expect(state).toMatchObject({
      escrowId: ESCROW,
      cycleNo: 5,
      finalized: true,
      claimed: false,
      refunded: false,
      claimExpiresAtMs: 1793926356233,
    });
  });
});
