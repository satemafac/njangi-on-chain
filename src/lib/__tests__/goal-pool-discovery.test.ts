// Goal-pool event readers: a failed read throws instead of answering "none".
// GoalPoolsSection keeps its cached pools when discovery throws; when it got
// `[]` it rendered and cached "no pools" instead.

jest.mock('../../services/network-config', () => ({
  getNetworkConfig: () => ({ rpcUrl: 'https://rpc.invalid' }),
  getPackageIdForNetwork: () => '0xcurrent',
}));
jest.mock('../circle-chain', () => ({
  getPublishedPackageMetadata: () => ({ originalId: '0xoriginal', publishedAt: '0xcurrent' }),
}));
jest.mock('../../services/sui-rpc-failover', () => ({ getPooledSuiClient: jest.fn() }));

import { findGoalPoolsByAdmin, listGoalPoolContributors } from '../goal-pool-discovery';

const ADMIN = '0x' + 'a'.repeat(64);
const POOL = '0x' + 'b'.repeat(64);
const clientAnswering = (answer: () => Promise<unknown>) => ({ queryEvents: jest.fn(answer) }) as never;
const down = () => Promise.reject(new Error('Unexpected status code: 503'));

describe('findGoalPoolsByAdmin', () => {
  it("lists the admin's pools", async () => {
    const client = clientAnswering(() =>
      Promise.resolve({
        data: [
          { parsedJson: { pool_id: POOL, admin: ADMIN, name: 'Roof', beneficiary: ADMIN, goal_kind: 0 } },
          { parsedJson: { pool_id: '0xother', admin: '0x' + 'c'.repeat(64) } },
        ],
      }),
    );
    const pools = await findGoalPoolsByAdmin(client, 'testnet', ADMIN);
    expect(pools.map((p) => p.poolId)).toEqual([POOL]);
  });

  it('answers [] when the read succeeded and the admin has no pools', async () => {
    const client = clientAnswering(() => Promise.resolve({ data: [] }));
    await expect(findGoalPoolsByAdmin(client, 'testnet', ADMIN)).resolves.toEqual([]);
  });

  it('throws when the events cannot be read', async () => {
    await expect(findGoalPoolsByAdmin(clientAnswering(down), 'testnet', ADMIN)).rejects.toThrow('503');
  });
});

describe('listGoalPoolContributors', () => {
  it('throws when the events cannot be read, rather than reporting nobody paid', async () => {
    await expect(listGoalPoolContributors(clientAnswering(down), 'testnet', POOL)).rejects.toThrow('503');
  });

  it("lists the pool's contributions", async () => {
    const client = clientAnswering(() =>
      Promise.resolve({ data: [{ parsedJson: { pool_id: POOL, contributor: ADMIN, amount: '5' } }] }),
    );
    await expect(listGoalPoolContributors(client, 'testnet', POOL)).resolves.toEqual([
      { contributor: ADMIN, amount: '5' },
    ]);
  });
});
