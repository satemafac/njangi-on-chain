/**
 * NJA-3920: the transaction-package resolvers never turn a foreign or failed
 * read into a move-call target. A look-alike circle, an object from a package
 * outside this app and a read that failed each reject with a plain message,
 * and a circle of one of this app's packages still resolves to an app
 * package. The read layer is stubbed; nothing here reaches the network.
 */
jest.mock('../../services/network-config', () => ({
  ...(jest.requireActual('../../services/network-config') as Record<string, unknown>),
  getCurrentNetwork: () => 'testnet',
}));
jest.mock('../../lib/sui-read', () => ({
  ...(jest.requireActual('../../lib/sui-read') as Record<string, unknown>),
  readObject: jest.fn(),
}));

import { readObject, SuiReadError } from '../../lib/sui-read';
import { KNOWN_PACKAGE_IDS } from '../../lib/app-packages';
import {
  appPackageIds,
  getCircleTransactionPackageId,
  getObjectTransactionPackageId,
} from '../../services/circle-service';

const CIRCLE = `0x${'c1'.repeat(32)}`;
const WALLET = `0x${'0b'.repeat(32)}`;
const FORGED_PACKAGE = `0x${'ee'.repeat(32)}`;
const readObjectMock = readObject as jest.Mock;

describe('transaction-package resolvers never call an unchecked package (NJA-3920)', () => {
  beforeEach(() => readObjectMock.mockReset());

  it('refuses a circle the pinned read rejects as a look-alike', async () => {
    readObjectMock.mockRejectedValue(
      new SuiReadError(`${CIRCLE} is a ${FORGED_PACKAGE}::njangi_circles::Circle`, 'unexpected-type'),
    );

    await expect(getCircleTransactionPackageId(CIRCLE)).rejects.toThrow("This circle isn't a Njangi circle.");
  });

  it('does not fall back to the configured package when the circle cannot be read', async () => {
    readObjectMock.mockRejectedValue(new SuiReadError(`no source read ${CIRCLE}`, 'unavailable'));

    await expect(getCircleTransactionPackageId(CIRCLE)).rejects.toThrow(
      "Couldn't check this circle right now. Please try again.",
    );
  });

  it("still resolves a circle of one of this app's packages to an app package", async () => {
    readObjectMock.mockResolvedValue({
      data: { objectId: CIRCLE, type: `${KNOWN_PACKAGE_IDS.testnet[0]}::njangi_circles::Circle` },
    });

    const target = await getCircleTransactionPackageId(CIRCLE);

    expect(appPackageIds('testnet')).toContain(target);
  });

  it('refuses an object whose type comes from a package outside this app', async () => {
    expect(appPackageIds('testnet')).not.toContain(FORGED_PACKAGE);
    readObjectMock.mockResolvedValue({
      data: { objectId: WALLET, type: `${FORGED_PACKAGE}::njangi_custody::CustodyWallet` },
    });

    await expect(getObjectTransactionPackageId(WALLET)).rejects.toThrow("This item isn't part of Njangi.");
  });

  it('does not fall back to the configured package when the object cannot be read', async () => {
    readObjectMock.mockRejectedValue(new SuiReadError(`no source read ${WALLET}`, 'unavailable'));

    await expect(getObjectTransactionPackageId(WALLET)).rejects.toThrow(
      "Couldn't check this item right now. Please try again.",
    );
  });
});
