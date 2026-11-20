/**
 * NJA-3442 (refile of NJA-2816). The Terms and Risk texts changed on
 * 2026-10-01 (commit ccacbd5: Enoki supplies the zkLogin salt, recovery
 * codes dropped, Enoki among the third parties) without a version bump in
 * CURRENT_LEGAL_VERSIONS, so a user who accepted terms/risk 1.0.0 is never
 * re-prompted and no "what changed" note exists for either doc.
 *
 * Pins the 1.1.0 bump and the founder-approved notes (approved 2026-11-20,
 * copied character for character from the request).
 */

import {
  CURRENT_LEGAL_VERSIONS,
  LEGAL_CHANGE_NOTES,
  LEGAL_DOC_IDS,
  getLegalChangeNote,
  legalDocsUpdatedSinceAcceptance,
  type LegalDocId,
} from '../../lib/legal-acceptance';
import {
  __resetLegalAcceptanceMemoryStoreForTests,
  getLegalAcceptanceStatus,
  recordLegalAcceptances,
  type VerifiedLegalIdentity,
} from '../../lib/legal-acceptance-server';

// No database in this test: the server module falls back to its in-memory
// store when Postgres is not configured (NODE_ENV is 'test' under jest).
jest.mock('../../lib/pg-pool', () => ({
  getSharedPgPool: jest.fn(),
  isPostgresConfigured: jest.fn(() => false),
}));

const IDENTITY: VerifiedLegalIdentity = {
  sub: 'oauth-sub',
  aud: 'oauth-aud',
  userAddr: '0xabc',
};

// What a signed-in user had accepted before this bump: terms and risk at
// 1.0.0, privacy at its current version (bumped separately, not in question).
const PRE_BUMP_VERSIONS: Record<LegalDocId, string> = {
  terms: '1.0.0',
  privacy: CURRENT_LEGAL_VERSIONS.privacy,
  risk: '1.0.0',
};

const EXPECTED_NOTES = {
  terms: {
    version: '1.1.0',
    en: "Your wallet address now also depends on a private value (a 'salt') that Enoki, run by Mysten Labs, supplies each time you sign in, and Enoki is listed among the third-party services. Recovery codes, which the app does not offer, are no longer mentioned: without your social account there is no way to restore access to your wallet. If Enoki stopped supplying your salt, you could lose access to your wallet.",
    fr: "L'adresse de votre portefeuille dépend désormais aussi d'une valeur privée (un « sel ») qu'Enoki, exploité par Mysten Labs, fournit à chaque connexion, et Enoki figure parmi les services tiers. Les codes de récupération, que l'application ne propose pas, ne sont plus mentionnés : sans votre compte social, il n'existe aucun moyen de rétablir l'accès à votre portefeuille. Si Enoki cessait de fournir votre sel, vous pourriez perdre l'accès à votre portefeuille.",
  },
  risk: {
    version: '1.1.0',
    en: "The risk of losing your login is spelled out: Njangi On-Chain has no recovery codes and cannot restore your access. Signing in also relies on Enoki, run by Mysten Labs; if it stopped working for Njangi On-Chain, you could lose access to your wallet. Keep your social account's recovery options up to date.",
    fr: "Le risque de perdre votre connexion est désormais précisé : Njangi On-Chain n'a pas de codes de récupération et ne peut pas rétablir votre accès. La connexion repose aussi sur Enoki, exploité par Mysten Labs ; s'il cessait de fonctionner pour Njangi On-Chain, vous pourriez perdre l'accès à votre portefeuille. Tenez à jour les options de récupération de votre compte social.",
  },
};

describe('NJA-3442: Terms and Risk bumped to 1.1.0 with change notes', () => {
  beforeEach(() => {
    __resetLegalAcceptanceMemoryStoreForTests();
  });

  it('CURRENT_LEGAL_VERSIONS carries the 2026-10-01 text change for terms and risk', () => {
    expect(CURRENT_LEGAL_VERSIONS.terms).toBe('1.1.0');
    expect(CURRENT_LEGAL_VERSIONS.risk).toBe('1.1.0');
  });

  it('re-prompts a user who accepted terms and risk 1.0.0, for exactly those docs', async () => {
    await recordLegalAcceptances(IDENTITY, [...LEGAL_DOC_IDS], 'en', null, PRE_BUMP_VERSIONS);

    // Default (server-resolved) versions, exactly as /api/legal/status uses them.
    const status = await getLegalAcceptanceStatus(IDENTITY.sub, IDENTITY.aud);

    expect(status.allAccepted).toBe(false);
    expect(status.missing).toEqual(['terms', 'risk']);
    // The modal classifies these as bumps (not first acceptances) and looks up
    // a change note for each.
    expect(legalDocsUpdatedSinceAcceptance(status.missing, status.required)).toEqual([
      'terms',
      'risk',
    ]);
  });

  it.each(['terms', 'risk'] as const)(
    '%s shows the founder-approved "what changed" note in both locales',
    (doc) => {
      expect(LEGAL_CHANGE_NOTES[doc]).toEqual(EXPECTED_NOTES[doc]);
      expect(getLegalChangeNote(doc, 'en')).toBe(EXPECTED_NOTES[doc].en);
      expect(getLegalChangeNote(doc, 'fr')).toBe(EXPECTED_NOTES[doc].fr);
    },
  );
});
