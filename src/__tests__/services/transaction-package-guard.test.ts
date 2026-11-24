/**
 * NJA-3920: the transaction-package resolvers must refuse an object whose
 * package is not one of this app's (appPackageIds). Anybody can publish a
 * `njangi_circles::Circle`; on this commit getCircleTransactionPackageId
 * takes the package from the object's type unchecked (getCirclePackageId
 * reads without expectType) and resolveUpgradeAwarePackageId returns an
 * unknown package unchanged, so a forged circle id routes a join, deposit or
 * delete call into the forger's package. The read layer is stubbed; nothing
 * here reaches the network.
 */
jest.mock('../../services/network-config', () => ({
  ...(jest.requireActual('../../services/network-config') as Record<string, unknown>),
  getCurrentNetwork: () => 'testnet',
}));
jest.mock('../../lib/sui-read', () => ({
  ...(jest.requireActual('../../lib/sui-read') as Record<string, unknown>),
  readObject: jest.fn(),
}));

import { readObject } from '../../lib/sui-read';
import { appPackageIds, getCircleTransactionPackageId } from '../../services/circle-service';

const CIRCLE = `0x${'c1'.repeat(32)}`;
const FORGED_PACKAGE = `0x${'ee'.repeat(32)}`;
const readObjectMock = readObject as jest.Mock;

describe('getCircleTransactionPackageId package guard (NJA-3920)', () => {
  beforeEach(() => readObjectMock.mockReset());

  it("refuses a circle from a package outside this app with a plain message", async () => {
    // The forged package is not one of ours, so the guard must apply.
    expect(appPackageIds('testnet')).not.toContain(FORGED_PACKAGE);

    // The chain answers with a look-alike Circle struct from a package
    // nobody in this app published. No user address is passed, so the
    // resolver never reaches its event scans.
    readObjectMock.mockResolvedValue({
      data: { objectId: CIRCLE, type: `${FORGED_PACKAGE}::njangi_circles::Circle` },
    });

    // On this commit the promise RESOLVES to the forger's package id; the
    // zkLogin client would then build its move call against that target.
    await expect(getCircleTransactionPackageId(CIRCLE)).rejects.toThrow(
      "This circle isn't a Njangi circle.",
    );
  });
});
