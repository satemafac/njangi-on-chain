/**
 * NJA-3953: the package guard judges a CycleEscrow against the packages of
 * the network the read was asked about, never the ambient one. Here the
 * current network is switched to mainnet while every read targets testnet:
 * a testnet escrow of this app must still verify on each tier that names a
 * candidate (the escrow history, the open-round marker, the event scan) and
 * read as a state. The client is injected and the failover layer stubbed;
 * nothing here reaches the network.
 */
jest.mock('../../services/network-config', () => ({
  ...(jest.requireActual('../../services/network-config') as Record<string, unknown>),
  getCurrentNetwork: jest.fn(() => 'testnet'),
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
  ESCROW_HISTORY_FIELD_NAME,
  OPEN_ROUND_FIELD_NAME,
  findCurrentCycleEscrow,
  isCycleEscrowForCircle,
  readCycleEscrowState,
  verifyCycleEscrowForCircle,
} from '../../lib/cycle-escrow-discovery';
import { getCurrentNetwork } from '../../services/network-config';
import { withSuiRpcFailover } from '../../services/sui-rpc-failover';

const currentNetwork = getCurrentNetwork as unknown as jest.Mock;
const failover = withSuiRpcFailover as unknown as jest.Mock;

const CIRCLE = `0x${'c1'.repeat(32)}`;
const ESCROW_OLDER = `0x${'e1'.repeat(32)}`;
const ESCROW_NEWEST = `0x${'e2'.repeat(32)}`;
const RECIPIENT = `0x${'1f'.repeat(32)}`;
const MEMBER = `0x${'ab'.repeat(32)}`;
const USDC = `0x${'26'.repeat(32)}::usdc::USDC`;
/** The testnet lineage's original id (package-lineage.ts), one of appPackageIds('testnet'). */
const APP_PACKAGE = '0x89cddf4dfe654e7c7b16333096d9e750cf04bb96f7de934403a512d460594f02';
const ESCROW_TYPE = `${APP_PACKAGE}::njangi_cycle_escrow::CycleEscrow<${USDC}>`;

/** getObject({ showType, showContent }) for one of this app's testnet escrows, round 5. */
const escrowObject = (id: string) => ({
  data: {
    objectId: id,
    version: '1',
    digest: 'digest',
    type: ESCROW_TYPE,
    content: {
      dataType: 'moveObject' as const,
      type: ESCROW_TYPE,
      hasPublicTransfer: false,
      fields: {
        id: { id },
        balance: '0',
        circle_id: CIRCLE,
        claimed: false,
        claim_expires_at_ms: '0',
        contributors_count: '0',
        finalized: false,
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

/** A started circle, as readCircleStarted reads it. */
const circleObject = {
  data: {
    objectId: CIRCLE,
    content: { dataType: 'moveObject' as const, fields: { current_cycle: '5', is_active: true } },
  },
};

const NOT_FOUND = { error: { code: 'dynamicFieldNotFound' } };
const sameName = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The circle's escrow history and open-round marker as given; absent when not. */
const testnetClient = (opts: { history?: string[]; markedEscrow?: string } = {}) =>
  ({
    getObject: jest.fn(async ({ id }: { id: string }) =>
      id === CIRCLE ? circleObject : escrowObject(id),
    ),
    getDynamicFieldObject: jest.fn(async ({ name }: { name: unknown }) => {
      if (sameName(name, ESCROW_HISTORY_FIELD_NAME)) {
        return opts.history
          ? { data: { content: { dataType: 'moveObject', fields: { value: opts.history } } } }
          : NOT_FOUND;
      }
      if (sameName(name, OPEN_ROUND_FIELD_NAME)) {
        if (!opts.markedEscrow) return NOT_FOUND;
        const marker = { cycle_no: '5', recipient: RECIPIENT, escrow_id: opts.markedEscrow };
        return { data: { content: { dataType: 'moveObject', fields: { value: { fields: marker } } } } };
      }
      throw new Error('this test serves no other dynamic field');
    }),
  }) as unknown as SuiClient;

describe('the CycleEscrow package guard follows the requested network (NJA-3953)', () => {
  beforeEach(() => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    // The ambient network is mainnet; every read below asks about testnet.
    currentNetwork.mockReturnValue('mainnet');
  });

  afterEach(() => {
    currentNetwork.mockReturnValue('testnet');
  });

  it('verifies against the network it is given', async () => {
    expect(appPackageIds('testnet')).toContain(APP_PACKAGE);
    const client = testnetClient();

    const verified = await verifyCycleEscrowForCircle(client, ESCROW_NEWEST, CIRCLE, 'testnet');
    expect(verified.verdict).toBe(true);
    await expect(isCycleEscrowForCircle(client, ESCROW_NEWEST, CIRCLE, 'testnet')).resolves.toBe(
      true,
    );
  });

  it('finds the newest escrow_history entry of the requested network', async () => {
    const client = testnetClient({ history: [ESCROW_OLDER, ESCROW_NEWEST] });
    await expect(findCurrentCycleEscrow('testnet', CIRCLE, { client })).resolves.toMatchObject({
      escrowId: ESCROW_NEWEST,
      circleId: CIRCLE,
      cycleNo: 5,
      source: 'escrow_history',
    });
  });

  it('verifies the escrow the open-round marker names on the requested network', async () => {
    const client = testnetClient({
      history: [ESCROW_OLDER, ESCROW_NEWEST],
      markedEscrow: ESCROW_OLDER,
    });
    await expect(findCurrentCycleEscrow('testnet', CIRCLE, { client })).resolves.toMatchObject({
      escrowId: ESCROW_OLDER,
      source: 'open_round',
    });
  });

  it('verifies an event-scan candidate on the requested network', async () => {
    failover.mockImplementationOnce(async () => ({
      data: [{ parsedJson: { circle_id: CIRCLE, cycle_no: '5', escrow_id: ESCROW_NEWEST } }],
      hasNextPage: false,
      nextCursor: null,
    }));
    await expect(
      findCurrentCycleEscrow('testnet', CIRCLE, { client: testnetClient() }),
    ).resolves.toMatchObject({ escrowId: ESCROW_NEWEST, source: 'events' });
    expect(failover).toHaveBeenCalledWith('testnet', 'findCurrentCycleEscrow', expect.any(Function));
  });

  it('reads the state of an escrow of the requested network', async () => {
    const state = await readCycleEscrowState(ESCROW_NEWEST, 'testnet', testnetClient());
    expect(state).toMatchObject({ escrowId: ESCROW_NEWEST, cycleNo: 5, finalized: false });
  });
});
