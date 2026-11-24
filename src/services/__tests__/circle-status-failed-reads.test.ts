/**
 * The WhatsApp /status reply (getCircleStatus) when a read fails.
 *
 * A read that fails is not a fact. When the circle's config, its creation
 * event (the currency) or its join events cannot be read, getCircleStatus
 * returns null, which the webhook turns into a link to the circle page,
 * instead of a status built from default amounts, "USD", or a member list
 * missing everyone who joined. The activation scan stays optional while the
 * circle's own is_active field answers. Mocks as in circle-status-custody.test.ts;
 * nothing here reaches the network.
 */

jest.mock('@/services/network-config', () => ({
  getNetworkConfig: jest.fn(() => ({ rpcUrl: 'http://localhost:9000', packageId: '0xenvpkg' })),
}));
jest.mock('@/services/sui-rpc-failover', () => ({
  getPooledSuiClient: jest.fn(),
}));
jest.mock('@/lib/sui-read', () => ({
  readObject: jest.fn(),
  queryEventsCached: jest.fn(),
}));
jest.mock('@/lib/circle-chain', () => ({
  resolveCircleLifecycleState: jest.fn(() => ({ isActive: true })),
}));
jest.mock('@/services/join-request-database', () => ({
  __esModule: true,
  default: { getUserByAddress: jest.fn() },
}));
jest.mock('@/lib/custody-wallet-discovery', () => ({
  resolveCustodyWalletId: jest.fn(async () => null),
}));

import { getCircleStatus } from '@/services/circle-status.service';
import { getPooledSuiClient } from '@/services/sui-rpc-failover';
import { readObject, queryEventsCached } from '@/lib/sui-read';

const PKG = '0x' + '0e'.repeat(32);
const CIRCLE_ID = '0x' + 'c3'.repeat(32);
const CONFIG_FIELD = '0x' + 'cf'.repeat(32);
const ADMIN = '0x' + 'a1'.repeat(32);

const circle = (fields: Record<string, unknown> = {}) => ({
  data: {
    type: `${PKG}::njangi_circles::Circle`,
    content: {
      dataType: 'moveObject',
      fields: { name: 'Susu', admin: ADMIN, rotation_order: [ADMIN], current_cycle: '1', current_position: '0', is_active: true, ...fields },
    },
  },
});

const readObjectMock = readObject as jest.Mock;
const queryEventsMock = queryEventsCached as jest.Mock;

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  readObjectMock.mockImplementation(async (id: string) => {
    if (id === CIRCLE_ID) return circle();
    if (id === CONFIG_FIELD) {
      return { data: { content: { dataType: 'moveObject', fields: { value: { fields: { max_members: '5', contribution_amount_usd: '1000' } } } } } };
    }
    return { data: null };
  });
  queryEventsMock.mockResolvedValue({ data: [] });
  (getPooledSuiClient as jest.Mock).mockReturnValue({
    getDynamicFields: jest.fn(async () => ({
      data: [{ objectId: CONFIG_FIELD, objectType: `${PKG}::njangi_circle_config::CircleConfig` }],
    })),
    getObject: jest.fn(),
  });
});

describe('getCircleStatus when a read fails', () => {
  it('reads the circle only as a Circle and builds the status from complete reads', async () => {
    const status = await getCircleStatus(CIRCLE_ID, 'testnet');
    expect(readObjectMock).toHaveBeenCalledWith(
      CIRCLE_ID,
      expect.anything(),
      expect.objectContaining({
        expectType: expect.arrayContaining([`${PKG}::njangi_circles::Circle`.replace(PKG, '0xenvpkg')]),
      }),
    );
    expect(status).toMatchObject({ name: 'Susu', maxMembers: 5, contributionAmountUsd: 10 });
  });

  it('returns null, not default amounts, when the config cannot be read', async () => {
    readObjectMock.mockImplementation(async (id: string) => {
      if (id === CIRCLE_ID) return circle();
      throw new Error('[sui-read] no source read the config');
    });
    await expect(getCircleStatus(CIRCLE_ID, 'testnet')).resolves.toBeNull();
  });

  it('returns null, not "USD", when the creation event cannot be read', async () => {
    queryEventsMock.mockImplementation(async ({ query }: { query: { MoveEventType: string } }) => {
      if (query.MoveEventType.endsWith('::CircleCreated')) throw new Error('GraphQL down');
      return { data: [] };
    });
    await expect(getCircleStatus(CIRCLE_ID, 'testnet')).resolves.toBeNull();
  });

  it('returns null, not a short member list, when the join events cannot be read', async () => {
    queryEventsMock.mockImplementation(async ({ query }: { query: { MoveEventType: string } }) => {
      if (query.MoveEventType.endsWith('::MemberJoined')) throw new Error('GraphQL down');
      return { data: [] };
    });
    await expect(getCircleStatus(CIRCLE_ID, 'testnet')).resolves.toBeNull();
  });

  it('still answers when only the activation scan fails and is_active is on the circle', async () => {
    queryEventsMock.mockImplementation(async ({ query }: { query: { MoveEventType: string } }) => {
      if (query.MoveEventType.endsWith('::CircleActivated')) throw new Error('GraphQL down');
      return { data: [] };
    });
    await expect(getCircleStatus(CIRCLE_ID, 'testnet')).resolves.toMatchObject({ isActive: true });
  });

  it('returns null when the activation scan fails and the circle has no is_active field', async () => {
    readObjectMock.mockImplementation(async (id: string) => (id === CIRCLE_ID ? circle({ is_active: undefined }) : { data: null }));
    queryEventsMock.mockImplementation(async ({ query }: { query: { MoveEventType: string } }) => {
      if (query.MoveEventType.endsWith('::CircleActivated')) throw new Error('GraphQL down');
      return { data: [] };
    });
    await expect(getCircleStatus(CIRCLE_ID, 'testnet')).resolves.toBeNull();
  });
});
