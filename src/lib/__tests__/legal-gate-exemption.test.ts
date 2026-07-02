/**
 * Legal-gate route exemptions (docs/legal-drafts/ACCEPTANCE-GATE-SPEC.md):
 * accessing EXISTING funds (claim payouts, recovery proposals/votes/
 * execution, refunds, withdraw) must remain reachable for a user who has
 * NOT accepted the current document versions — a read-only legal hold must
 * never lock funds access. Those live on the circle detail page
 * (/circle/[id]) and its non-entry subroutes, so those stay exempt.
 *
 * 2026-07 GTM hardening: the two ENTRY actions that create a NEW financial
 * commitment — /circle/[id]/join and /circle/[id]/contribute — are gated,
 * so a deep link can no longer let someone commit funds without accepting
 * the disclosures. /auth and /legal remain exempt.
 */

import {
  LEGAL_GATE_EXEMPT_PATH_PREFIXES,
  isLegalGateExemptPath,
} from '@/lib/legal-acceptance';

describe('isLegalGateExemptPath', () => {
  it('never gates fund-ACCESS routes under /circle (detail page, manage, patterns + concrete)', () => {
    expect(isLegalGateExemptPath('/circle/[id]')).toBe(true);
    expect(isLegalGateExemptPath('/circle/[id]/manage')).toBe(true);
    expect(isLegalGateExemptPath('/circle/[id]/goals')).toBe(true);
    expect(isLegalGateExemptPath('/circle/0xabc123')).toBe(true);
  });

  it('GATES the entry actions (join, contribute) — new commitment needs acceptance', () => {
    expect(isLegalGateExemptPath('/circle/[id]/contribute')).toBe(false);
    expect(isLegalGateExemptPath('/circle/[id]/join')).toBe(false);
    expect(isLegalGateExemptPath('/circle/0xabc123/contribute')).toBe(false);
    expect(isLegalGateExemptPath('/circle/0xabc123/join')).toBe(false);
  });

  it('never gates the auth flow or the legal pages themselves', () => {
    expect(isLegalGateExemptPath('/auth')).toBe(true);
    expect(isLegalGateExemptPath('/auth/callback')).toBe(true);
    expect(isLegalGateExemptPath('/legal/terms')).toBe(true);
    expect(isLegalGateExemptPath('/legal/data-deletion')).toBe(true);
  });

  it('gates everything else (dashboard actions, circle creation, admin)', () => {
    expect(isLegalGateExemptPath('/')).toBe(false);
    expect(isLegalGateExemptPath('/dashboard')).toBe(false);
    expect(isLegalGateExemptPath('/create-circle')).toBe(false);
    expect(isLegalGateExemptPath('/pricing')).toBe(false);
    expect(isLegalGateExemptPath('/admin/compliance')).toBe(false);
  });

  it('matches on path segments, not bare string prefixes', () => {
    // '/circles' / '/authn' must not ride along with '/circle' / '/auth'.
    expect(isLegalGateExemptPath('/circles')).toBe(false);
    expect(isLegalGateExemptPath('/authn')).toBe(false);
    expect(isLegalGateExemptPath('/legalese')).toBe(false);
  });

  it('keeps the documented exemption set stable', () => {
    expect([...LEGAL_GATE_EXEMPT_PATH_PREFIXES]).toEqual(['/auth', '/legal', '/circle']);
  });
});
