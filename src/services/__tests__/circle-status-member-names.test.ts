/**
 * The WhatsApp status reply names members from the join-requests table.
 * It reads the rows in-process: /api/join-requests/lookup-user answers only
 * a signed-in admin or member, and this server-side caller has no session.
 */

jest.mock('@/services/network-config', () => ({
  getNetworkConfig: jest.fn(() => ({ rpcUrl: 'http://localhost:9000' })),
}));
jest.mock('@/services/sui-rpc-failover', () => ({
  getPooledSuiClient: jest.fn(),
}));
jest.mock('@/lib/sui-read', () => ({
  readObject: jest.fn(),
  queryEventsCached: jest.fn(),
}));
jest.mock('@/lib/circle-chain', () => ({
  resolveCircleLifecycleState: jest.fn(),
}));
jest.mock('@/services/join-request-database', () => ({
  __esModule: true,
  default: { getUserByAddress: jest.fn() },
}));

import {
  formatCircleStatusForWhatsAppWithNames,
  type CircleStatusData,
} from '@/services/circle-status.service';
import joinRequestDatabase from '@/services/join-request-database';

const CIRCLE_ID = '0x' + 'c3'.repeat(32);
const NAMED = '0x' + 'a1'.repeat(32);
const UNNAMED = '0x' + 'b2'.repeat(32);

function status(): CircleStatusData {
  return {
    name: 'Susu',
    admin: NAMED,
    isActive: true,
    currentCycle: 1,
    maxMembers: 5,
    currentMembers: 2,
    contributionAmount: 10,
    contributionAmountUsd: 10,
    securityDeposit: 5,
    securityDepositUsd: 5,
    currencyType: 'USD',
    cycleLength: 0,
    cycleDay: 0,
    payoutDayType: 0,
    nextPayoutTime: 0,
    members: [
      { address: NAMED, depositPaid: true, isAdmin: true },
      { address: UNNAMED, depositPaid: false, isAdmin: false },
    ],
    rotationOrder: [NAMED, UNNAMED],
  };
}

describe('formatCircleStatusForWhatsAppWithNames', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = jest.fn(() => {
      throw new Error('the status reply must not call an API route');
    }) as unknown as typeof fetch;
    const getUserByAddress = joinRequestDatabase.getUserByAddress as jest.Mock;
    getUserByAddress.mockImplementation(async (_circleId: string, address: string) =>
      address === NAMED ? { user_name: 'Aminata' } : null,
    );
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('names members from the join-requests table without an HTTP call', async () => {
    const text = await formatCircleStatusForWhatsAppWithNames(status(), CIRCLE_ID);

    expect(text).toContain('Aminata');
    expect(joinRequestDatabase.getUserByAddress).toHaveBeenCalledWith(CIRCLE_ID, NAMED);
    expect(joinRequestDatabase.getUserByAddress).toHaveBeenCalledWith(CIRCLE_ID, UNNAMED);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('still formats the reply when a lookup fails', async () => {
    (joinRequestDatabase.getUserByAddress as jest.Mock).mockRejectedValue(new Error('db down'));

    const text = await formatCircleStatusForWhatsAppWithNames(status(), CIRCLE_ID);

    expect(text).toContain('Susu');
    expect(text).not.toContain('Aminata');
  });
});
