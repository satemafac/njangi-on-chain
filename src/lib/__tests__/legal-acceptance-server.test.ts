/**
 * legal-acceptance-server (docs/legal-drafts/ACCEPTANCE-GATE-SPEC.md):
 * append-only, (sub, aud)-keyed acceptance records with server-resolved
 * versions. Covers the in-memory dev store (gate logic: first login,
 * idempotent re-acceptance, version-bump re-trigger, identity isolation)
 * and the Postgres path (SQL shape + parameter binding).
 */

import { createHmac } from 'node:crypto';
import {
  __resetLegalAcceptanceMemoryStoreForTests,
  getLegalAcceptanceStatus,
  hasAcceptedAllLegalDocs,
  hashAcceptanceIp,
  recordLegalAcceptances,
  type VerifiedLegalIdentity,
} from '@/lib/legal-acceptance-server';
import { CURRENT_LEGAL_VERSIONS, LEGAL_DOC_IDS } from '@/lib/legal-acceptance';
import { getSharedPgPool, isPostgresConfigured } from '@/lib/pg-pool';

jest.mock('@/lib/pg-pool', () => ({
  getSharedPgPool: jest.fn(),
  isPostgresConfigured: jest.fn(),
}));

const mockedIsConfigured = isPostgresConfigured as jest.MockedFunction<
  typeof isPostgresConfigured
>;
const mockedGetPool = getSharedPgPool as jest.MockedFunction<typeof getSharedPgPool>;

const IDENTITY: VerifiedLegalIdentity = {
  sub: 'oauth-sub',
  aud: 'oauth-aud',
  userAddr: '0xabc',
};

describe('legal-acceptance-server (in-memory dev store)', () => {
  beforeEach(() => {
    mockedIsConfigured.mockReturnValue(false);
    __resetLegalAcceptanceMemoryStoreForTests();
    delete process.env.LEGAL_ACCEPT_IP_SALT;
  });

  afterEach(() => {
    delete process.env.LEGAL_ACCEPT_IP_SALT;
  });

  it('reports all docs missing for a brand-new identity (first login)', async () => {
    const status = await getLegalAcceptanceStatus(IDENTITY.sub, IDENTITY.aud);
    expect(status.allAccepted).toBe(false);
    expect(status.missing).toEqual([...LEGAL_DOC_IDS]);
    expect(status.required).toEqual(
      LEGAL_DOC_IDS.map((doc) => ({
        doc,
        currentVersion: CURRENT_LEGAL_VERSIONS[doc],
        acceptedVersion: null,
      })),
    );
  });

  it('accepting all three docs satisfies the gate', async () => {
    const recorded = await recordLegalAcceptances(IDENTITY, [...LEGAL_DOC_IDS], 'en', null);
    expect(recorded).toEqual(
      LEGAL_DOC_IDS.map((doc) => ({
        doc,
        version: CURRENT_LEGAL_VERSIONS[doc],
        inserted: true,
      })),
    );
    const { accepted, missing } = await hasAcceptedAllLegalDocs(IDENTITY.sub, IDENTITY.aud);
    expect(accepted).toBe(true);
    expect(missing).toEqual([]);
  });

  it('treats a duplicate acceptance as an idempotent no-op', async () => {
    await recordLegalAcceptances(IDENTITY, [...LEGAL_DOC_IDS], 'en', null);
    const second = await recordLegalAcceptances(IDENTITY, [...LEGAL_DOC_IDS], 'en', null);
    expect(second.every((entry) => entry.inserted === false)).toBe(true);
    const status = await getLegalAcceptanceStatus(IDENTITY.sub, IDENTITY.aud);
    expect(status.allAccepted).toBe(true);
  });

  it('re-triggers for exactly the bumped doc on a version bump, preserving old rows', async () => {
    await recordLegalAcceptances(IDENTITY, [...LEGAL_DOC_IDS], 'en', null);

    const bumped = { ...CURRENT_LEGAL_VERSIONS, terms: '1.1.0' };
    const status = await getLegalAcceptanceStatus(IDENTITY.sub, IDENTITY.aud, bumped);

    expect(status.allAccepted).toBe(false);
    expect(status.missing).toEqual(['terms']);
    // Old acceptance rows are preserved as evidence (append-only).
    expect(status.required.find((r) => r.doc === 'terms')).toEqual({
      doc: 'terms',
      currentVersion: '1.1.0',
      acceptedVersion: '1.0.0',
    });
    expect(status.required.find((r) => r.doc === 'privacy')?.acceptedVersion).toBe('1.0.0');

    // Accepting only the changed doc at the new version satisfies the gate
    // again, and both versions remain recorded.
    await recordLegalAcceptances(IDENTITY, ['terms'], 'fr', null, bumped);
    const after = await getLegalAcceptanceStatus(IDENTITY.sub, IDENTITY.aud, bumped);
    expect(after.allAccepted).toBe(true);
    expect(after.required.find((r) => r.doc === 'terms')?.acceptedVersion).toBe('1.1.0');
    // The original version map is still satisfied by the old rows.
    const original = await getLegalAcceptanceStatus(IDENTITY.sub, IDENTITY.aud);
    expect(original.allAccepted).toBe(true);
  });

  it('keeps acceptance scoped to the (sub, aud) identity', async () => {
    await recordLegalAcceptances(IDENTITY, [...LEGAL_DOC_IDS], 'en', null);
    const other = await getLegalAcceptanceStatus('other-sub', IDENTITY.aud);
    expect(other.allAccepted).toBe(false);
    expect(other.missing).toEqual([...LEGAL_DOC_IDS]);
    const otherAud = await getLegalAcceptanceStatus(IDENTITY.sub, 'other-aud');
    expect(otherAud.allAccepted).toBe(false);
  });
});

describe('legal-acceptance-server (Postgres path)', () => {
  beforeEach(() => {
    mockedIsConfigured.mockReturnValue(true);
    delete process.env.LEGAL_ACCEPT_IP_SALT;
  });

  it('inserts append-only rows bound to the verified identity at server-resolved versions', async () => {
    const query = jest.fn().mockResolvedValue({ rowCount: 1, rows: [{ id: 1 }] });
    mockedGetPool.mockReturnValue({ query } as unknown as ReturnType<typeof getSharedPgPool>);

    const recorded = await recordLegalAcceptances(IDENTITY, ['terms', 'risk'], 'fr', 'ip-hmac');

    expect(query).toHaveBeenCalledTimes(2);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('INSERT INTO legal_acceptances');
    expect(sql).toContain('ON CONFLICT (sub, aud, doc, version) DO NOTHING');
    // Version comes from CURRENT_LEGAL_VERSIONS — never from any caller input.
    expect(params).toEqual([
      'oauth-sub',
      'oauth-aud',
      '0xabc',
      'terms',
      CURRENT_LEGAL_VERSIONS.terms,
      'fr',
      'ip-hmac',
    ]);
    expect(recorded).toEqual([
      { doc: 'terms', version: CURRENT_LEGAL_VERSIONS.terms, inserted: true },
      { doc: 'risk', version: CURRENT_LEGAL_VERSIONS.risk, inserted: true },
    ]);
  });

  it('reports inserted=false when the unique index absorbs a duplicate POST', async () => {
    const query = jest.fn().mockResolvedValue({ rowCount: 0, rows: [] });
    mockedGetPool.mockReturnValue({ query } as unknown as ReturnType<typeof getSharedPgPool>);

    const recorded = await recordLegalAcceptances(IDENTITY, ['terms'], 'en', null);
    expect(recorded).toEqual([
      { doc: 'terms', version: CURRENT_LEGAL_VERSIONS.terms, inserted: false },
    ]);
  });

  it('computes status from the stored rows', async () => {
    const query = jest.fn().mockResolvedValue({
      rowCount: 2,
      rows: [
        { doc: 'terms', version: '1.0.0' },
        { doc: 'privacy', version: '1.0.0' },
      ],
    });
    mockedGetPool.mockReturnValue({ query } as unknown as ReturnType<typeof getSharedPgPool>);

    const status = await getLegalAcceptanceStatus(IDENTITY.sub, IDENTITY.aud);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('FROM legal_acceptances');
    expect(params).toEqual(['oauth-sub', 'oauth-aud']);
    expect(status.missing).toEqual(['risk']);
    expect(status.allAccepted).toBe(false);
  });
});

describe('hashAcceptanceIp', () => {
  afterEach(() => {
    delete process.env.LEGAL_ACCEPT_IP_SALT;
  });

  it('returns null when LEGAL_ACCEPT_IP_SALT is unset (never the raw IP)', () => {
    delete process.env.LEGAL_ACCEPT_IP_SALT;
    expect(hashAcceptanceIp('203.0.113.7')).toBeNull();
  });

  it('returns the keyed HMAC of the IP when the salt is set', () => {
    process.env.LEGAL_ACCEPT_IP_SALT = 'test-salt';
    const expected = createHmac('sha256', 'test-salt').update('203.0.113.7').digest('hex');
    const actual = hashAcceptanceIp('203.0.113.7');
    expect(actual).toBe(expected);
    expect(actual).not.toContain('203.0.113.7');
  });
});
