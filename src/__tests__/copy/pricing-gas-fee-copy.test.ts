/**
 * NJA-2595 — pricing FAQ copy contradicts the gas-sponsorship policy.
 *
 * src/lib/i18n.ts:443 tells members they "pay their own small network fee,
 * on every plan", and :446 answers "Do members need SUI for gas?" with an
 * unconditional "Yes." (FR twins at :987 and :990). The code says otherwise:
 * src/lib/gas-sponsorship.ts:12-16 — when GAS_SPONSORSHIP_ENABLED is on and
 * the circle's admin holds a Premium entitlement, that circle's members
 * transact gas-free, and assessSponsorship() returns { sponsor: true } for
 * exactly that case (the broker uses it in src/pages/api/sponsor/prepare.ts).
 *
 * No network, RPC, wallet or database is touched: assessSponsorship is the
 * pure policy core and DICTIONARIES is a plain object.
 */

import { DICTIONARIES } from '../../lib/i18n';
import { assessSponsorship } from '../../lib/gas-sponsorship';

const PACKAGE_ID = '0x' + '1'.repeat(64);

describe('pricing FAQ gas copy vs gas-sponsorship policy (NJA-2595)', () => {
  let savedFlag: string | undefined;

  beforeAll(() => {
    savedFlag = process.env.GAS_SPONSORSHIP_ENABLED;
    process.env.GAS_SPONSORSHIP_ENABLED = 'true';
  });

  afterAll(() => {
    if (savedFlag === undefined) delete process.env.GAS_SPONSORSHIP_ENABLED;
    else process.env.GAS_SPONSORSHIP_ENABLED = savedFlag;
  });

  it("sponsors gas for members of a Premium admin's circle, so the pricing FAQ must not say every member pays their own fee on every plan", () => {
    // What the code does (holds on this commit).
    expect(
      assessSponsorship({ adminIsPremium: true, usesGasCoinForValue: false, packageId: PACKAGE_ID }),
    ).toEqual({ sponsor: true, reason: 'eligible' });
    expect(
      assessSponsorship({ adminIsPremium: false, usesGasCoinForValue: false, packageId: PACKAGE_ID }),
    ).toEqual({ sponsor: false, reason: 'admin_not_premium' });

    // What the copy says (fails on this commit).
    const en = DICTIONARIES.en;
    const fr = DICTIONARIES.fr;

    // i18n.ts:443 — "Members pay their own small network fee, on every plan."
    expect(en['pricing.faq.fees.a']).not.toMatch(/pay their own[^.]*fee, on every plan/i);
    // i18n.ts:446 — "Yes. Every Sui transaction needs a tiny network fee …"
    expect(en['pricing.faq.gas.a']).not.toMatch(/^\s*Yes\./);

    // i18n.ts:987 / :990 — the French twins make the same unconditional claim.
    expect(fr['pricing.faq.fees.a']).not.toMatch(/sur tous les forfaits/i);
    expect(fr['pricing.faq.gas.a']).not.toMatch(/^\s*Oui\./);
  });
});
