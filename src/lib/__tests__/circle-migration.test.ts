import {
  extractMigrationLedgerFromObjectContent,
  getMigrationLedgerObjectId,
  hasMemberAcknowledged,
  isMigrationLedgerDynamicField,
  isSameMember,
  resolveMigrationRatification,
} from '@/lib/circle-migration';

const ADMIN = '0x000000000000000000000000000000000000000000000000000000000000000a';
const BOB = '0x000000000000000000000000000000000000000000000000000000000000000b';
const CAROL = '0x000000000000000000000000000000000000000000000000000000000000000c';
const DAVE = '0x000000000000000000000000000000000000000000000000000000000000000d';

/** Shape of the `Field<vector<u8>, MigrationLedger>` object as RPC returns it. */
function ledgerObject(fields: Record<string, unknown>) {
  return { dataType: 'moveObject', fields: { id: { id: '0x1' }, name: [], value: { fields } } };
}

function ack(member: string, version: number) {
  return { fields: { member, version: String(version), acked_at: '1700000000000' } };
}

function ledgerFields(overrides: Record<string, unknown> = {}) {
  return {
    declared_by: ADMIN,
    declared_at: '1700000000000',
    version: '1',
    prior_rounds_completed: '2',
    start_position: '2',
    rotation_snapshot: [ADMIN, BOB, CAROL, DAVE],
    acks: [],
    ...overrides,
  };
}

describe('extractMigrationLedgerFromObjectContent', () => {
  it('returns null for content that holds no ledger', () => {
    expect(extractMigrationLedgerFromObjectContent(null)).toBeNull();
    expect(extractMigrationLedgerFromObjectContent({})).toBeNull();
    expect(extractMigrationLedgerFromObjectContent({ fields: {} })).toBeNull();
  });

  // Option<T> reaches us as `{ fields: { vec: [...] } }`, `{ vec: [...] }`, or
  // the bare struct, depending on nesting and node version. Betting on one
  // shape means the ledger silently disappears on some nodes — and a circle
  // whose ledger reads as absent looks like it has no history at all.
  // Some nodes nest the Field value, some flatten it. Betting on one shape
  // means the ledger silently disappears — and a circle whose ledger reads as
  // absent looks like it has no history at all.
  it.each([
    ['nested value', ledgerObject(ledgerFields())],
    ['flattened value', { fields: ledgerFields() }],
  ])('unwraps the %s shape', (_label, content) => {
    const ledger = extractMigrationLedgerFromObjectContent(content);

    expect(ledger).not.toBeNull();
    expect(ledger?.version).toBe(1);
    expect(ledger?.startPosition).toBe(2);
    expect(ledger?.priorRoundsCompleted).toBe(2);
    expect(ledger?.declaredBy).toBe(ADMIN);
  });

  // Version 0 means we failed to unwrap something. Reporting startPosition 0
  // would render as "no turns taken yet" on a circle that has taken some.
  it('rejects a ledger with no usable version rather than defaulting it', () => {
    expect(extractMigrationLedgerFromObjectContent(ledgerObject(ledgerFields({ version: '0' })))).toBeNull();
    expect(
      extractMigrationLedgerFromObjectContent(ledgerObject(ledgerFields({ version: undefined }))),
    ).toBeNull();
  });

  it('parses acknowledgements and drops malformed entries', () => {
    const ledger = extractMigrationLedgerFromObjectContent(
      ledgerObject(
        ledgerFields({
          acks: [ack(ADMIN, 1), { fields: { member: 'not-an-address', version: '1' } }, ack(BOB, 1)],
        }),
      ),
    );

    expect(ledger?.acks.map((entry: { member: string }) => entry.member)).toEqual([ADMIN, BOB]);
  });
});

describe('hasMemberAcknowledged', () => {
  const ledger = extractMigrationLedgerFromObjectContent(
    ledgerObject(ledgerFields({ version: '2', acks: [ack(ADMIN, 2), ack(BOB, 1)] })),
  );

  it('counts a confirmation cast against the current version', () => {
    expect(hasMemberAcknowledged(ledger, ADMIN)).toBe(true);
  });

  // The whole point of versioning: rewriting the ledger must not inherit
  // agreement to terms the member never saw.
  it('does not count a confirmation of a superseded version', () => {
    expect(hasMemberAcknowledged(ledger, BOB)).toBe(false);
  });

  it('matches addresses regardless of zero-padding', () => {
    expect(hasMemberAcknowledged(ledger, '0xa')).toBe(true);
  });

  it('is false with no ledger or no member', () => {
    expect(hasMemberAcknowledged(null, ADMIN)).toBe(false);
    expect(hasMemberAcknowledged(ledger, null)).toBe(false);
  });
});

describe('resolveMigrationRatification', () => {
  const rotation = [ADMIN, BOB, CAROL, DAVE];

  it('splits the rotation at the declared starting position', () => {
    const ledger = extractMigrationLedgerFromObjectContent(
      ledgerObject(ledgerFields({ acks: [ack(ADMIN, 1), ack(BOB, 1)] })),
    );
    const state = resolveMigrationRatification(ledger, rotation);

    expect(state?.alreadyCollected).toEqual([ADMIN, BOB]);
    expect(state?.stillWaiting).toEqual([CAROL, DAVE]);
    expect(state?.nextRecipient).toBe(CAROL);
    expect(state?.confirmed).toEqual([ADMIN, BOB]);
    expect(state?.pending).toEqual([CAROL, DAVE]);
    expect(state?.isRatified).toBe(false);
  });

  it('is ratified only when every seat has confirmed', () => {
    const ledger = extractMigrationLedgerFromObjectContent(
      ledgerObject(
        ledgerFields({ acks: [ack(ADMIN, 1), ack(BOB, 1), ack(CAROL, 1), ack(DAVE, 1)] }),
      ),
    );

    expect(resolveMigrationRatification(ledger, rotation)?.isRatified).toBe(true);
  });

  // An empty rotation ratifying by default would let activation apply a ledger
  // nobody agreed to. The contract refuses it too.
  it('never ratifies an empty rotation', () => {
    const ledger = extractMigrationLedgerFromObjectContent(ledgerObject(ledgerFields()));

    expect(resolveMigrationRatification(ledger, [])?.isRatified).toBe(false);
    expect(resolveMigrationRatification(ledger, [null, undefined])?.isRatified).toBe(false);
  });

  it('clamps a starting position past the end of the rotation', () => {
    const ledger = extractMigrationLedgerFromObjectContent(
      ledgerObject(ledgerFields({ start_position: '99' })),
    );
    const state = resolveMigrationRatification(ledger, rotation);

    expect(state?.alreadyCollected).toEqual(rotation);
    expect(state?.stillWaiting).toEqual([]);
    expect(state?.nextRecipient).toBeNull();
  });

  it('returns null with no ledger', () => {
    expect(resolveMigrationRatification(null, rotation)).toBeNull();
  });
});

describe('isSameMember', () => {
  // The confirmation checklist compares normalized ledger addresses against
  // raw ones read off the circle. Spelling-based comparison reports a member
  // who HAS confirmed as still waiting, and the circle looks stuck forever.
  it('matches the same address written short or zero-padded', () => {
    expect(isSameMember('0xa', ADMIN)).toBe(true);
    expect(isSameMember(ADMIN, '0xA')).toBe(true);
  });

  it('does not match different members', () => {
    expect(isSameMember(ADMIN, BOB)).toBe(false);
  });

  it('never matches on missing or malformed input', () => {
    expect(isSameMember(null, ADMIN)).toBe(false);
    expect(isSameMember(ADMIN, undefined)).toBe(false);
    expect(isSameMember('not-an-address', 'not-an-address')).toBe(false);
    // Two empty rotation slots are not "the same member".
    expect(isSameMember('0x0', '0x0')).toBe(false);
  });
});

describe('rotation snapshot', () => {
  const rotation = [ADMIN, BOB, CAROL, DAVE];

  it('parses the order that members confirmed', () => {
    const ledger = extractMigrationLedgerFromObjectContent(ledgerObject(ledgerFields()));

    expect(ledger?.rotationSnapshot).toEqual(rotation);
  });

  it('matches when the live order is unchanged', () => {
    const ledger = extractMigrationLedgerFromObjectContent(ledgerObject(ledgerFields()));

    expect(resolveMigrationRatification(ledger, rotation)?.matchesRotation).toBe(true);
  });

  // The hole this closes: everyone confirms "position 2 is Carol", the
  // organiser then swaps positions 2 and 3, and the confirmations still read
  // as given — but position 2 is now Dave, holding Carol's turn.
  it('does not match once the order is rearranged', () => {
    const ledger = extractMigrationLedgerFromObjectContent(
      ledgerObject(
        ledgerFields({ acks: [ack(ADMIN, 1), ack(BOB, 1), ack(CAROL, 1), ack(DAVE, 1)] }),
      ),
    );
    const state = resolveMigrationRatification(ledger, [ADMIN, BOB, DAVE, CAROL]);

    expect(state?.matchesRotation).toBe(false);
    // Still "ratified" — every seat confirmed — which is exactly why
    // matchesRotation has to be checked separately.
    expect(state?.isRatified).toBe(true);
  });

  it('does not match once a member is added or removed', () => {
    const ledger = extractMigrationLedgerFromObjectContent(ledgerObject(ledgerFields()));

    expect(
      resolveMigrationRatification(ledger, [ADMIN, BOB, CAROL])?.matchesRotation,
    ).toBe(false);
  });

  it('compares by identity, not by how the address is written', () => {
    const ledger = extractMigrationLedgerFromObjectContent(
      ledgerObject(ledgerFields({ rotation_snapshot: ['0xa', '0xb', '0xc', '0xd'] })),
    );

    expect(resolveMigrationRatification(ledger, rotation)?.matchesRotation).toBe(true);
  });
});

describe('migration ledger dynamic-field discovery', () => {
  const OBJ = '0xfeed';

  // A vector<u8> dynamic-field name comes back as a byte array on most nodes,
  // not the readable string. Matching on the name alone finds nothing, and the
  // circle then looks like it never migrated — which silently restarts the
  // rotation from position one.
  it('finds the field by its struct type', () => {
    const field = {
      objectId: OBJ,
      objectType: '0x2::dynamic_field::Field<vector<u8>, 0xabc::njangi_circle_config::MigrationLedger>',
      name: { type: 'vector<u8>', value: [1, 2, 3] },
    };

    expect(isMigrationLedgerDynamicField(field)).toBe(true);
    expect(getMigrationLedgerObjectId([field])).toBe(OBJ);
  });

  it('finds the field by a byte-array name', () => {
    const bytes = Array.from('migration_ledger').map((c) => c.charCodeAt(0));
    const field = { objectId: OBJ, objectType: '0x2::dynamic_field::Field', name: { value: bytes } };

    expect(isMigrationLedgerDynamicField(field)).toBe(true);
  });

  it('finds the field by a decoded string name', () => {
    const field = { objectId: OBJ, name: { type: 'vector<u8>', value: 'migration_ledger' } };

    expect(isMigrationLedgerDynamicField(field)).toBe(true);
  });

  it('ignores the circle config and other sibling fields', () => {
    const siblings = [
      { objectId: '0x1', objectType: '0x2::dynamic_field::Field<vector<u8>, 0xabc::njangi_circle_config::CircleConfig>' },
      { objectId: '0x2', name: { value: 'requires_attestation' } },
      null,
      undefined,
    ];

    expect(siblings.some((f) => isMigrationLedgerDynamicField(f))).toBe(false);
    expect(getMigrationLedgerObjectId(siblings)).toBeNull();
  });

  it('returns null when the circle has no ledger field at all', () => {
    expect(getMigrationLedgerObjectId([])).toBeNull();
  });
});
