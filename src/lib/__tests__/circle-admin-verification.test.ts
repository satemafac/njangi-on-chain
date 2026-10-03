jest.mock('@/services/network-config', () => ({
  getNetworkConfig: jest.fn(() => ({ rpcUrl: 'http://localhost:9000' })),
}));
jest.mock('@/services/sui-rpc-failover', () => ({
  getPooledSuiClient: jest.fn(),
}));

import {
  fetchCircleAdminAddress,
  fetchCircleAuthority,
} from '../circle-admin-verification';
import { getPooledSuiClient } from '@/services/sui-rpc-failover';

const CIRCLE_ID = '0x' + 'c3'.repeat(32);
const ADMIN = '0x' + 'a1'.repeat(32);
const MEMBERS_TABLE = '0x' + '5e'.repeat(32);

function clientReturning(response: unknown) {
  const getObject = jest.fn().mockResolvedValue(response);
  (getPooledSuiClient as jest.Mock).mockReturnValue({ getObject });
  return getObject;
}

// The shape a testnet circle returns with showContent (checked against the
// live circle 0xa3fada18… on 2026-10-03).
const circleObject = {
  data: {
    content: {
      dataType: 'moveObject',
      fields: {
        admin: ADMIN,
        members: {
          type: '0x2::table::Table<address, 0x89cd::njangi_members::Member>',
          fields: { id: { id: MEMBERS_TABLE }, size: '3' },
        },
      },
    },
  },
};

describe('fetchCircleAuthority', () => {
  it("reads the admin and the members Table id from one object read", async () => {
    const getObject = clientReturning(circleObject);

    await expect(fetchCircleAuthority(CIRCLE_ID, 'testnet')).resolves.toEqual({
      admin: ADMIN,
      membersTableId: MEMBERS_TABLE,
    });
    expect(getObject).toHaveBeenCalledTimes(1);
    expect(getObject).toHaveBeenCalledWith({ id: CIRCLE_ID, options: { showContent: true } });
  });

  it('returns null when the object does not exist', async () => {
    clientReturning({ error: { code: 'notExists' } });

    await expect(fetchCircleAuthority(CIRCLE_ID, 'testnet')).resolves.toBeNull();
  });

  it('reports missing fields as null rather than guessing', async () => {
    clientReturning({ data: { content: { dataType: 'moveObject', fields: {} } } });

    await expect(fetchCircleAuthority(CIRCLE_ID, 'testnet')).resolves.toEqual({
      admin: null,
      membersTableId: null,
    });
  });

  it('throws on RPC failure so callers fail closed', async () => {
    (getPooledSuiClient as jest.Mock).mockReturnValue({
      getObject: jest.fn().mockRejectedValue(new Error('rpc down')),
    });

    await expect(fetchCircleAuthority(CIRCLE_ID, 'testnet')).rejects.toThrow('rpc down');
  });
});

describe('fetchCircleAdminAddress', () => {
  it('returns the admin field', async () => {
    clientReturning(circleObject);

    await expect(fetchCircleAdminAddress(CIRCLE_ID, 'testnet')).resolves.toBe(ADMIN);
  });

  it('returns null for a missing circle', async () => {
    clientReturning({ error: { code: 'notExists' } });

    await expect(fetchCircleAdminAddress(CIRCLE_ID, 'testnet')).resolves.toBeNull();
  });
});
