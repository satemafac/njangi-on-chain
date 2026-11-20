/**
 * NJA-3378 (refile of NJA-2811) — FAQ: the funds-security answer on a missed
 * payment, exact wording.
 *
 * Legal matter LC-T-0c0de5dc: the "How secure are my funds?" answer in
 * src/pages/faq.tsx must say that a round pays out only once every required
 * share is in (njangi_cycle_escrow.move: required_contributors =
 * member_count - 1, finalize gated by E_NOT_FULLY_FUNDED), that contributions
 * stay in the escrow until then, that after the contract's CANCEL_GRACE_MS
 * (7 days after the due date) the round can be cancelled and the member whose
 * turn it was receives nothing for that round, and it must avoid the words
 * "anyone", "exactly", "never" and "short".
 *
 * Source-text assertion rather than a render test: jest runs
 * `testEnvironment: 'node'` and `testMatch` only collects `.test.ts`, so the
 * page cannot be mounted here (same technique as
 * src/__tests__/learn/what-is-njangi-penalty-copy.test.ts). The page is read
 * by relative path and readFileSync throws if it is missing or unreadable, and
 * the item is located by its id with an explicit not-null assertion, so a
 * failed read never passes as "the wording is fine".
 */
import { readFileSync } from 'fs';
import path from 'path';

const PAGE = path.resolve(__dirname, '../../pages/faq.tsx');

const EXPECTED_ANSWER =
  "Several things work together: 1) contributions sit in a per-cycle escrow contract rather than with a treasurer, 2) each cycle's recipient is fixed when the round opens, so the pot can only be claimed by that member, 3) you sign every transaction yourself — we hold no key that could sign for you, 4) the rotation order and every payment are recorded on chain for the whole circle to see, and 5) the contract code is public and auditable. What this does not do is remove risk: software can contain bugs, and if a member stops contributing, the round waits for the missing share, so your payout can be late or may not happen at all. Under the current contract a round pays out only once every required share is in, so the pot is not paid out partly filled; until then the contributions stay in the escrow. If a share is still missing after the contract's grace period (currently 7 days after the due date), the round can be cancelled: the member whose turn it was receives nothing for that round, and each recorded contribution is refunded to the member who paid it. See our risk disclosure for what you are taking on.";

/** Words the legal matter ruled out of this answer (checked case-insensitively, as substrings). */
const FORBIDDEN = ['anyone', 'exactly', 'never', 'short'];

/**
 * The body of the `answer: "..."` string literal of the faq item whose id is
 * `funds-security`. Null when the item cannot be located, which the tests
 * treat as a failure, not as an empty answer.
 */
function fundsSecurityAnswer(source: string): string | null {
  const match = source.match(
    /id:\s*"funds-security",\s*question:\s*"[^"\n]*",\s*answer:\s*"((?:[^"\\\n]|\\.)*)"/,
  );
  return match ? match[1] : null;
}

describe('faq funds-security answer (NJA-3378)', () => {
  const source = readFileSync(PAGE, 'utf8');
  const answer = fundsSecurityAnswer(source);

  it('locates the funds-security item on the page', () => {
    // Guards that the file and item still exist, so the assertions below are
    // about the right text and not vacuously true.
    expect(source).toContain('id: "funds-security"');
    expect(source).toContain('question: "How secure are my funds?"');
    expect(answer).not.toBeNull();
  });

  it('the approved text needs no escaping, so the literal body is the rendered text', () => {
    expect(EXPECTED_ANSWER).not.toMatch(/["\\]/);
  });

  it('is exactly the wording approved under LC-T-0c0de5dc', () => {
    expect(answer).toBe(EXPECTED_ANSWER);
  });

  it('contains none of "anyone", "exactly", "never", "short" (case-insensitive)', () => {
    expect(answer).not.toBeNull();
    const lower = (answer ?? '').toLowerCase();
    for (const word of FORBIDDEN) {
      expect({ word, present: lower.includes(word) }).toEqual({ word, present: false });
    }
  });

  it('says a cancelled round pays its scheduled recipient nothing, and funds wait in escrow until then', () => {
    expect(answer).not.toBeNull();
    expect(answer).toContain('the round can be cancelled');
    expect(answer).toContain('receives nothing for that round');
    expect(answer).toContain('until then the contributions stay in the escrow');
  });
});
