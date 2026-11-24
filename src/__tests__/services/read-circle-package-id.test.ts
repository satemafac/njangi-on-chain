/**
 * readCirclePackageId and circleMoveTypes (review of #175, issues 4 and 5).
 *
 * Pages read events by the package that defines the circle's type. That
 * package must come from the circle itself: getCirclePackageId's default
 * package after a failed read sent pages to another package's events
 * (unpaid, inactive, "no longer a member"). And the type must be from this
 * app's packages: anybody can publish a `njangi_circles::Circle`. The read
 * layer is stubbed; nothing here reaches the network.
 */
jest.mock('@/services/network-config', () => ({
  ...(jest.requireActual('@/services/network-config') as Record<string, unknown>),
  getCurrentNetwork: () => 'testnet',
}));
jest.mock('@/lib/sui-read', () => ({
  ...(jest.requireActual('@/lib/sui-read') as Record<string, unknown>),
  readObject: jest.fn(),
}));

import { readObject, SuiReadError } from '@/lib/sui-read';
import { circleMoveTypes, readCirclePackageId } from '@/services/circle-service';
import { getPublishedPackageMetadata } from '@/lib/circle-chain';
import { KNOWN_PACKAGE_IDS } from '@/lib/app-packages';

const CIRCLE = `0x${'c1'.repeat(32)}`;
const readObjectMock = readObject as jest.Mock;

describe('circleMoveTypes', () => {
  it("names the Circle type of this app's lineage and earlier deployments only", () => {
    const types = circleMoveTypes('testnet');
    const { originalId } = getPublishedPackageMetadata('testnet');
    expect(types).toContain(`${originalId}::njangi_circles::Circle`);
    for (const known of KNOWN_PACKAGE_IDS.testnet) expect(types).toContain(`${known}::njangi_circles::Circle`);
    expect(types).not.toContain(`0x${'ee'.repeat(32)}::njangi_circles::Circle`);
  });
});

describe('readCirclePackageId', () => {
  beforeEach(() => readObjectMock.mockReset());

  it("returns the package of the circle's own type, read pinned to this app's packages", async () => {
    const { originalId } = getPublishedPackageMetadata('testnet');
    readObjectMock.mockResolvedValue({ data: { objectId: CIRCLE, type: `${originalId}::njangi_circles::Circle` } });
    await expect(readCirclePackageId(CIRCLE)).resolves.toBe(originalId);
    expect(readObjectMock).toHaveBeenCalledWith(
      CIRCLE,
      { showType: true },
      expect.objectContaining({ expectType: circleMoveTypes('testnet') }),
    );
  });

  it('is null only when the chain answered that the circle is gone', async () => {
    readObjectMock.mockResolvedValue({ error: { code: 'notExists', object_id: CIRCLE } });
    await expect(readCirclePackageId(CIRCLE)).resolves.toBeNull();
  });

  it('throws on a failed or wrong-type read, never the default package', async () => {
    readObjectMock.mockRejectedValue(new SuiReadError('no source read it', 'unavailable'));
    await expect(readCirclePackageId(CIRCLE)).rejects.toThrow(/no source read it/);
    readObjectMock.mockRejectedValue(new SuiReadError('not a Circle', 'unexpected-type'));
    await expect(readCirclePackageId(CIRCLE)).rejects.toThrow(/not a Circle/);
  });
});
