/**
 * NJA-3334 (refile of NJA-2820) — Create circle form: no Penalty Rules section.
 *
 * src/pages/create-circle.tsx shows organizers a "Penalty Rules" section with
 * two switches (late payment, missed meeting) and the tooltip lines "Charge fee
 * for delayed contributions" and "Penalties are deducted from security
 * deposit". Nothing enforces penalties: both create-circle builders always
 * send NO_PENALTY_RULES and document that the form's value is never read
 * (src/lib/zklogin-tx-builders.ts, NJA-2593), so the section records a promise
 * the product never keeps.
 *
 * The wire field must stay: CircleData in src/services/zkLoginClient.ts
 * requires `penalty_rules: boolean[]`, and the NJA-2929 attempt broke the type
 * check by dropping it from serializedData. The form should send a constant
 * [false, false] for every circle.
 *
 * Source-text assertions rather than a render test: jest runs
 * `testEnvironment: 'node'` and `testMatch` only collects `.test.ts`, so the
 * page cannot be mounted here (same technique as
 * src/__tests__/learn/what-is-njangi-penalty-copy.test.ts). The page is read by
 * relative path and readFileSync throws if it is missing or unreadable — a
 * failed read must not pass as "no penalty section".
 */
import { readFileSync } from 'fs';
import path from 'path';

const PAGE = path.resolve(__dirname, '../../pages/create-circle.tsx');

/** Comments explaining the rule must not trip it. */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('create-circle form: Penalty Rules section (NJA-3334)', () => {
  const source = stripComments(readFileSync(PAGE, 'utf8'));

  it('is reading the create form and its contract-data builder', () => {
    // Guards that the file and the blocks below still exist, so the assertions
    // are about the right text and not vacuously true.
    expect(source).toContain('const prepareCircleCreationData = (');
    expect(source).toContain('const serializedData = {');
    expect(source).toContain('Admin Liveness Fallback');
  });

  it('renders no Penalty Rules section or penalty copy', () => {
    expect(source).not.toContain('Penalty Rules');
    expect(source).not.toContain('Charge fee for delayed contributions');
    expect(source).not.toContain('Penalties are deducted from security deposit');
    expect(source).not.toContain('Enable Late Payment Penalties');
    expect(source).not.toContain('Enable Missed Meeting Penalties');
    expect(source).not.toContain('id="latePayment"');
    expect(source).not.toContain('id="missedMeeting"');
  });

  it('keeps no penalty switches in the form state', () => {
    // The type, the initial value and handlePenaltyChange all write
    // `penaltyRules: {`. handleInputChange's Omit<CircleFormData, 'penaltyRules'>
    // may stay, so the bare word is deliberately not asserted on.
    expect(source).not.toMatch(/penaltyRules:\s*\{/);
    expect(source).not.toContain('handlePenaltyChange');
    expect(source).not.toContain('formData.penaltyRules');
  });

  it('still sends penalty_rules, as a constant [false, false] for every circle', () => {
    const start = source.indexOf('const prepareCircleCreationData');
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf('\n};', start);
    expect(end).toBeGreaterThan(start);
    const builder = source.slice(start, end);

    // CircleData (src/services/zkLoginClient.ts) requires penalty_rules:
    // boolean[]. The builder's return and serializedData must both carry it —
    // dropping it from serializedData is the NJA-2929 type error.
    expect(builder).toMatch(/return \{[\s\S]*\bpenalty_rules\b/);
    expect(source).toContain('penalty_rules: contractData.penalty_rules');

    // Not derived from the organizer's switches: one constant, the same for
    // rotational and smart-goal circles.
    expect(builder).not.toContain('formData.penaltyRules');
    expect(builder).toMatch(/penalty_rules[^;\n]*(\[\s*false\s*,\s*false\s*\]|NO_PENALTY_RULES)/);
  });
});
