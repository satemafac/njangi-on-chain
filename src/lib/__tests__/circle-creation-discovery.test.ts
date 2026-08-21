import {
  extractCreatedCircleId,
  resolveCreatedCircleId,
} from '@/lib/circle-creation-discovery';

const CIRCLE = '0x83bd939b76c636aaf0f1608b702ff2de4b3824c57c26c928c7b31c0bddb8a1f0';
const OTHER = '0x1111111111111111111111111111111111111111111111111111111111111111';
// Type identity keeps the ORIGINAL package id across upgrades.
const ORIGINAL_PKG = '0x89cddf4dfe654e7c7b16333096d9e750cf04bb96f7de934403a512d460594f02';

const circleChange = (objectId = CIRCLE) => ({
  type: 'created',
  objectId,
  objectType: `${ORIGINAL_PKG}::njangi_circles::Circle`,
});

describe('extractCreatedCircleId', () => {
  it('finds the circle among the other objects a creation makes', () => {
    const changes = [
      { type: 'created', objectId: OTHER, objectType: `${ORIGINAL_PKG}::njangi_custody::CustodyWallet` },
      circleChange(),
      { type: 'mutated', objectId: OTHER, objectType: '0x2::coin::Coin<0x2::sui::SUI>' },
    ];

    expect(extractCreatedCircleId(changes)).toBe(CIRCLE);
  });

  // CircleMembership is minted in the same transaction and its type contains
  // "Circle" as a prefix — a substring match would return the receipt instead,
  // and the organiser's invite link would point at a soulbound token.
  it('does not match CircleMembership or other Circle-prefixed types', () => {
    const changes = [
      { type: 'created', objectId: OTHER, objectType: `${ORIGINAL_PKG}::njangi_circles::CircleMembership` },
    ];

    expect(extractCreatedCircleId(changes)).toBeNull();
  });

  it('matches regardless of which package version published it', () => {
    const v5 = '0x988966677bb06995062c05bacd3a716cb3135a63b94ef04d1d5bdcccd9e53442';
    const changes = [{ type: 'created', objectId: CIRCLE, objectType: `${v5}::njangi_circles::Circle` }];

    expect(extractCreatedCircleId(changes)).toBe(CIRCLE);
  });

  it('ignores objects that were mutated rather than created', () => {
    const changes = [{ ...circleChange(), type: 'mutated' }];

    expect(extractCreatedCircleId(changes)).toBeNull();
  });

  // Better no link than a link to the wrong circle.
  it('refuses to guess when a transaction created more than one circle', () => {
    expect(extractCreatedCircleId([circleChange(CIRCLE), circleChange(OTHER)])).toBeNull();
  });

  it('rejects an unresolved or zeroed object id', () => {
    expect(extractCreatedCircleId([circleChange('0x0')])).toBeNull();
    expect(extractCreatedCircleId([{ ...circleChange(), objectId: undefined }])).toBeNull();
  });

  it('handles missing or empty object changes', () => {
    expect(extractCreatedCircleId(null)).toBeNull();
    expect(extractCreatedCircleId([])).toBeNull();
    expect(extractCreatedCircleId([null, undefined])).toBeNull();
  });
});

describe('resolveCreatedCircleId', () => {
  it('reads the circle out of the creation transaction', async () => {
    const client = {
      getTransactionBlock: jest.fn().mockResolvedValue({ objectChanges: [circleChange()] }),
    };

    await expect(resolveCreatedCircleId(client, 'DIGEST123')).resolves.toBe(CIRCLE);
    expect(client.getTransactionBlock).toHaveBeenCalledWith({
      digest: 'DIGEST123',
      options: { showObjectChanges: true },
    });
  });

  // No digest means no lookup — the caller falls back rather than issuing a
  // request that cannot succeed.
  it('does not call the RPC without a digest', async () => {
    const client = { getTransactionBlock: jest.fn() };

    await expect(resolveCreatedCircleId(client, null)).resolves.toBeNull();
    await expect(resolveCreatedCircleId(client, '   ')).resolves.toBeNull();
    expect(client.getTransactionBlock).not.toHaveBeenCalled();
  });
});
