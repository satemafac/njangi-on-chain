/**
 * Legal-gate route exemptions (docs/legal-drafts/ACCEPTANCE-GATE-SPEC.md):
 * recovery/claim flows must remain reachable for a user who has NOT
 * accepted the current document versions — a read-only legal hold must
 * never lock funds access. Claim payouts, recovery proposals/votes/
 * execution, and refunds all live under /circle/[id]/**, so the whole
 * /circle prefix is exempt, as are the /auth flow and the /legal pages
 * the user is being asked to read.
 */

import {
  LEGAL_GATE_EXEMPT_PATH_PREFIXES,
  isLegalGateExemptPath,
} from '@/lib/legal-acceptance';

describe('isLegalGateExemptPath', () => {
  it('never gates recovery/claim routes under /circle (route patterns and concrete paths)', () => {
    expect(isLegalGateExemptPath('/circle/[id]')).toBe(true);
    expect(isLegalGateExemptPath('/circle/[id]/manage')).toBe(true);
    expect(isLegalGateExemptPath('/circle/[id]/contribute')).toBe(true);
    expect(isLegalGateExemptPath('/circle/0xabc123')).toBe(true);
    expect(isLegalGateExemptPath('/circle/0xabc123/contribute')).toBe(true);
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
