/**
 * NJA-2812 — the FAQ answer on identity verification (src/pages/faq.tsx,
 * entry id "identity-verification") must not present verification as a
 * check that runs for circles today.
 *
 * The compliance gate is off by default (src/lib/compliance-gate.ts:
 * isComplianceGateEnabled reads NEXT_PUBLIC_COMPLIANCE_GATE_ENABLED, which
 * defaults to 'false'), the app exposes no per-circle toggle
 * (CycleEscrowPanel.tsx / create-circle.tsx: "no user-facing toggle"), and
 * there is no self-serve KYC flow (VerificationRequiredModal.tsx). The answer
 * should say verification is asked for only when a circle requires it or the
 * app's verification gate is on, and that today the gate is off by default.
 *
 * The FAQ copy is an inline literal inside a Next page component, so this
 * test reads the page source — the same way
 * src/lib/__tests__/cycle-escrow-discovery.test.ts checks the round surfaces.
 * A failed read throws; it never becomes an empty answer.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const FAQ_SOURCE = join(process.cwd(), 'src/pages/faq.tsx');

function identityVerificationAnswer(): string {
  const source = readFileSync(FAQ_SOURCE, 'utf8');
  const match = source.match(
    /id:\s*"identity-verification",\s*question:\s*"[^\n]*",\s*answer:\s*"([^\n]*)"/,
  );
  if (!match) {
    throw new Error('identity-verification FAQ entry not found in src/pages/faq.tsx');
  }
  return match[1];
}

describe('FAQ: identity verification answer (NJA-2812)', () => {
  it('says the verification gate is off by default today, not that the check is running', () => {
    const answer = identityVerificationAnswer();
    expect(answer.length).toBeGreaterThan(0);

    // The shipped app asks for verification only when a circle requires it
    // OR the gate is on; the gate is off by default. The answer must say so
    // instead of describing a one-time check that circles run today.
    expect(answer).toMatch(/off by default/i);
  });
});
