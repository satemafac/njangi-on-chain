// resolveEscrowSponsorship fails closed on every unknown: an unreadable chain
// never enables a spend. What changed is only the logged reason: an escrow
// that could not be read is `escrow_lookup_failed`, not `no_circle_id`.

const getObject = jest.fn();
const fetchCircleAdminAddress = jest.fn();
const shouldSponsor = jest.fn();

jest.mock('../../services/sui-rpc-failover', () => ({ getPooledSuiClient: () => ({ getObject }) }));
jest.mock('../../services/network-config', () => ({ getNetworkConfig: () => ({ rpcUrl: 'https://rpc.invalid' }) }));
jest.mock('../circle-admin-verification', () => ({
  fetchCircleAdminAddress: (...args: unknown[]) => fetchCircleAdminAddress(...args),
}));
jest.mock('../entitlement-gate', () => ({ getEntitlements: async () => ({ plan: 'premium' }) }));
jest.mock('../gas-sponsorship', () => ({ shouldSponsor: (...args: unknown[]) => shouldSponsor(...args) }));

import { resolveEscrowSponsorship } from '../gas-sponsorship-eligibility';

const input = {
  sub: 'sub-1',
  escrowId: '0xescrow',
  coinType: '0x2::sui::SUI',
  packageId: '0xpkg',
  network: 'testnet' as const,
};
const escrow = (fields: Record<string, unknown>) => ({
  data: { content: { dataType: 'moveObject', fields } },
});

beforeEach(() => {
  getObject.mockReset();
  fetchCircleAdminAddress.mockReset().mockResolvedValue('0xadmin');
  shouldSponsor.mockReset().mockResolvedValue({ sponsor: true, reason: 'eligible' });
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

it("sponsors through the escrow's circle when everything reads", async () => {
  getObject.mockResolvedValue(escrow({ circle_id: '0xcircle' }));
  await expect(resolveEscrowSponsorship(input)).resolves.toEqual({
    sponsor: true,
    reason: 'eligible',
    circleId: '0xcircle',
  });
  expect(fetchCircleAdminAddress).toHaveBeenCalledWith('0xcircle', 'testnet');
});

it.each([
  ['the read throws', () => getObject.mockRejectedValue(new Error('Unexpected status code: 503'))],
  ['the chain answers with a non-gone error', () => getObject.mockResolvedValue({ error: { code: 'unknown' } })],
])('declines as escrow_lookup_failed when %s', async (_label, arrange) => {
  arrange();
  await expect(resolveEscrowSponsorship(input)).resolves.toEqual({
    sponsor: false,
    reason: 'escrow_lookup_failed',
    circleId: null,
  });
  expect(shouldSponsor).not.toHaveBeenCalled();
});

it.each([
  ['the escrow is gone', () => getObject.mockResolvedValue({ error: { code: 'notExists' } })],
  ['the object has no circle_id (not an escrow)', () => getObject.mockResolvedValue(escrow({}))],
])('declines as no_circle_id when %s', async (_label, arrange) => {
  arrange();
  await expect(resolveEscrowSponsorship(input)).resolves.toEqual({
    sponsor: false,
    reason: 'no_circle_id',
    circleId: null,
  });
});

it('skips the escrow read when the caller already knows the circle', async () => {
  await resolveEscrowSponsorship({ ...input, circleId: '0xknown' });
  expect(getObject).not.toHaveBeenCalled();
  expect(fetchCircleAdminAddress).toHaveBeenCalledWith('0xknown', 'testnet');
});
