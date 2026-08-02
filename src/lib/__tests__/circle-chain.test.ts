import {
  extractPackageIdFromMoveType,
  getPackageLookupIds,
  normalizePackageId,
  resolveUpgradeAwarePackageId,
  resolveCircleLifecycleState,
} from '@/lib/circle-chain';

describe('circle-chain helpers', () => {
  describe('extractPackageIdFromMoveType', () => {
    it('extracts the package id from a Move type string', () => {
      expect(
        extractPackageIdFromMoveType(
          '0xabc123::njangi_circles::Circle',
        ),
      ).toBe('0xabc123');
    });

    it('returns null when the type does not contain a package id prefix', () => {
      expect(extractPackageIdFromMoveType('Circle')).toBeNull();
      expect(extractPackageIdFromMoveType(undefined)).toBeNull();
    });
  });

  describe('package lineage helpers', () => {
    it('normalizes package ids consistently', () => {
      expect(normalizePackageId('AFDC')).toBe('0xafdc');
      expect(normalizePackageId('0xAFDC')).toBe('0xafdc');
      expect(normalizePackageId('')).toBeNull();
    });

    it('routes upgraded testnet lineage objects to the current package', () => {
      expect(
        resolveUpgradeAwarePackageId({
          network: 'testnet',
          objectPackageId:
            '0xc5aed33e4da2530d0f9b36a64d96d662b109ba2962bb6918bc3fa21be1622465',
          currentPackageId:
            '0xc5aed33e4da2530d0f9b36a64d96d662b109ba2962bb6918bc3fa21be1622465',
        }),
      ).toBe(
        '0xc5aed33e4da2530d0f9b36a64d96d662b109ba2962bb6918bc3fa21be1622465',
      );
    });

    it('keeps unrelated legacy packages unchanged', () => {
      expect(
        resolveUpgradeAwarePackageId({
          network: 'testnet',
          objectPackageId:
            '0x9f916ce4a0a4970e1d466a79ec2a916ec930feac10218e2b94c282a3906d7926',
          currentPackageId:
            '0x21ee64ed90d13cee893106153f8c3eaa02ad21f00aff28e2e0afd53fac31264b',
        }),
      ).toBe(
        '0x9f916ce4a0a4970e1d466a79ec2a916ec930feac10218e2b94c282a3906d7926',
      );
    });

    it('returns lookup ids for the active upgrade lineage', () => {
      // A lineage lookup must return every id the lineage spans so
      // reads/event filters resolve across upgrades. The testnet lineage
      // is original 0x89cddf… (2026-06-12 v1) upgraded to published-at
      // 0x5578b7… (v2/v3, 2026-06-15) — a current-lineage query must
      // return both so event filters keyed by defining package id still
      // match (see resolveComplianceConfigId for a real consumer).
      expect(
        getPackageLookupIds({
          network: 'testnet',
          packageId:
            '0x89cddf4dfe654e7c7b16333096d9e750cf04bb96f7de934403a512d460594f02',
          currentPackageId:
            '0x89cddf4dfe654e7c7b16333096d9e750cf04bb96f7de934403a512d460594f02',
        }),
      ).toEqual([
        '0x89cddf4dfe654e7c7b16333096d9e750cf04bb96f7de934403a512d460594f02',
        '0x1a5fd4877f940f637cf4ac95fcd75cb352065de8b9e0acb9dbd29daa09b7846e',
      ]);

      // An app still configured with the retired package id is treated as
      // current-lineage (packageId === currentPackageId) and additionally
      // gets the live lineage ids, so reads keep resolving across cutover.
      expect(
        getPackageLookupIds({
          network: 'testnet',
          packageId:
            '0xc5aed33e4da2530d0f9b36a64d96d662b109ba2962bb6918bc3fa21be1622465',
          currentPackageId:
            '0xc5aed33e4da2530d0f9b36a64d96d662b109ba2962bb6918bc3fa21be1622465',
        }),
      ).toEqual([
        '0xc5aed33e4da2530d0f9b36a64d96d662b109ba2962bb6918bc3fa21be1622465',
        '0x1a5fd4877f940f637cf4ac95fcd75cb352065de8b9e0acb9dbd29daa09b7846e',
        '0x89cddf4dfe654e7c7b16333096d9e750cf04bb96f7de934403a512d460594f02',
      ]);
    });

    it('returns only the unrelated package id for non-lineage lookups', () => {
      expect(
        getPackageLookupIds({
          network: 'testnet',
          packageId:
            '0x9f916ce4a0a4970e1d466a79ec2a916ec930feac10218e2b94c282a3906d7926',
          currentPackageId:
            '0x21ee64ed90d13cee893106153f8c3eaa02ad21f00aff28e2e0afd53fac31264b',
        }),
      ).toEqual([
        '0x9f916ce4a0a4970e1d466a79ec2a916ec930feac10218e2b94c282a3906d7926',
      ]);
    });
  });

  describe('resolveCircleLifecycleState', () => {
    it('prefers explicit lifecycle fields from the object', () => {
      expect(
        resolveCircleLifecycleState({
          is_active: false,
          paused_after_cycle: 'true',
          current_cycle: '3',
        }),
      ).toEqual({
        isActive: false,
        isPausedAfterCycle: true,
        currentCycle: 3,
        activeSource: 'field',
      });
    });

    it('falls back to activation events only when is_active is missing', () => {
      expect(
        resolveCircleLifecycleState(
          {
            paused_after_cycle: false,
            current_cycle: 0,
          },
          { activationEventFound: true },
        ),
      ).toEqual({
        isActive: true,
        isPausedAfterCycle: false,
        currentCycle: 0,
        activeSource: 'activation-event',
      });
    });

    it('defaults safely when lifecycle data is unavailable', () => {
      expect(resolveCircleLifecycleState({})).toEqual({
        isActive: false,
        isPausedAfterCycle: false,
        currentCycle: 1,
        activeSource: 'default',
      });
    });

    it('does not let activation events override an explicit false field', () => {
      expect(
        resolveCircleLifecycleState(
          {
            is_active: 'false',
            current_cycle: '2',
          },
          { activationEventFound: true },
        ),
      ).toEqual({
        isActive: false,
        isPausedAfterCycle: false,
        currentCycle: 2,
        activeSource: 'field',
      });
    });
  });
});
