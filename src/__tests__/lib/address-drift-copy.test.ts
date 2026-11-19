/**
 * Address-drift interstitial copy (src/lib/i18n.ts, drift.* keys).
 *
 * The modal is shown when a sign-in resolved to a different Sui address than
 * this identity used before. The copy must state only what the app actually
 * does in that state:
 *
 *  - Only circle JOIN requests are refused server-side while drifted
 *    (src/pages/api/join-requests/create.ts). Creating a circle and paying a
 *    contribution are signed in the browser with no server gate
 *    (src/components/AddressDriftModal.tsx, src/pages/api/zkLogin.ts), so the
 *    screen must not claim they are "paused".
 *  - There is no refund-request flow in the app. Fund return is self-service
 *    on chain (claimOwnRefund / refund_asset), not something a member "asks
 *    for". The screen must not promise a refund request that does not exist.
 *
 * EN and FR are both authored (other locales fall back to EN), so both are
 * checked.
 */

import { DICTIONARIES } from '../../lib/i18n';

describe('address-drift interstitial copy', () => {
  const en = DICTIONARIES.en;
  const fr = DICTIONARIES.fr;

  it('has both strings authored in EN and FR', () => {
    expect(typeof en['drift.cannotYet']).toBe('string');
    expect(typeof en['drift.canStill']).toBe('string');
    expect(typeof fr['drift.cannotYet']).toBe('string');
    expect(typeof fr['drift.canStill']).toBe('string');
  });

  describe('drift.cannotYet does not claim a pause the code does not enforce', () => {
    it('EN: creating a circle and paying a contribution are not "paused"', () => {
      expect(en['drift.cannotYet']).not.toMatch(/\bpaused\b/i);
      expect(en['drift.cannotYet']).not.toMatch(/until this is sorted out/i);
    });

    it('FR: créer / payer ne sont pas "suspendus"', () => {
      expect(fr['drift.cannotYet']).not.toMatch(/\bsuspendu(e)?s?\b/i);
      expect(fr['drift.cannotYet']).not.toMatch(/\ben pause\b/i);
    });
  });

  describe('drift.canStill does not offer a refund request the app does not provide', () => {
    it('EN: no "ask for a refund"', () => {
      expect(en['drift.canStill']).not.toMatch(/ask for a refund/i);
      expect(en['drift.canStill']).not.toMatch(/request (a )?refund/i);
    });

    it('FR: pas de "demander un remboursement"', () => {
      expect(fr['drift.canStill']).not.toMatch(/demander (un|le) remboursement/i);
    });
  });
});
