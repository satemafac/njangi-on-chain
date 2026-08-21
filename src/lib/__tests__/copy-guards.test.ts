/**
 * Source guards for copy that asserts something the contract does not enforce.
 *
 * The manage page told every admin that activating a circle "requires ... a
 * non-admin recovery delegate". `activate_circle`
 * (move/sources/njangi_circles.move:635) enforces that only inside
 * `if (config::is_auto_release_enabled(&circle.id))`. On a circle created
 * without auto-release the demand was not merely premature — it was
 * unsatisfiable: the contract stores `option::none()` for the delegate at
 * creation (njangi_circles.move:555) and exposes no entry point to change it,
 * while the UI disabled the very button it was telling the admin to press.
 *
 * These are source-text assertions rather than render tests because jest runs
 * `testEnvironment: 'node'` with `testMatch: ['**\/__tests__\/**\/*.test.ts']` —
 * no jsdom, no testing-library, and `.tsx` is not matched. The same technique
 * as scripts/check-marketing-copy.mjs, which is what caught the yield
 * vocabulary. A guard that can actually run beats a render test that cannot.
 */
import { readFileSync } from 'fs';
import path from 'path';

const read = (rel: string) =>
  readFileSync(path.resolve(__dirname, '../..', rel), 'utf8');

/** Comments explain the rule; they must not trip it. */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('activation requirement copy', () => {
  it('the escrow panel does not enumerate activation requirements', () => {
    // The panel has no recoveryStatus prop and cannot know whether a delegate
    // is required, so it must point at the manage page rather than guess.
    // Only the manage page passes showAdminOpenButton, so this branch is the
    // admin view exclusively.
    const panel = stripComments(read('components/CycleEscrowPanel.tsx'));

    expect(panel).not.toMatch(/delegate/i);
    expect(panel).not.toMatch(/recovery delegate/i);
  });

  it('delegate copy lives in the pure helper, not inline in the page', () => {
    // Inline ternaries are how the enabled/disabled distinction got lost in
    // five places at once. getRecoveryDelegateCardCopy owns the wording and is
    // unit-tested for the disabled and unknown cases.
    const page = stripComments(read('pages/circle/[id]/manage/index.tsx'));

    expect(page).not.toContain('Delegate required');
    expect(page).not.toContain('Set a valid delegate before activating this circle');
    expect(page).not.toContain(
      'Auto-release now requires a valid delegate address before this fallback should be relied on.',
    );
    expect(page).toContain('getRecoveryDelegateCardCopy');
  });

  it('the delegate validator is not hardcoded as always-required', () => {
    // required:true ignored autoReleaseEnabled. Latent only because the edit
    // button happened to be disabled on those circles — same bug class.
    const page = stripComments(read('pages/circle/[id]/manage/index.tsx'));

    expect(page).not.toMatch(/getRecoveryDelegateValidationError\(\{[^}]*required:\s*true/);
  });
});

describe('mid-cycle migration copy', () => {
  // The declared history is a claim about turns taken somewhere Njangi cannot
  // see. The members confirm it; the software does not check it. Copy that
  // says "verified" turns a group's own bookkeeping into a platform assurance
  // we have no basis for — the same over-claim class as the regulatory and
  // fraud-elimination patterns already banned in check-marketing-copy.mjs.
  const surfaces = [
    'components/CircleMigrationPanel.tsx',
    'pages/circle/[id]/contribute/index.tsx',
    'pages/create-circle.tsx',
  ];

  it.each(surfaces)('%s does not claim the recorded history is verified', (rel) => {
    const source = stripComments(read(rel));

    expect(source).not.toMatch(/verif\w*\s+(?:history|payouts?|turns?|rotation)/i);
    expect(source).not.toMatch(/(?:history|turns?|payouts?)\s+(?:are|is|was|were)\s+verif/i);
  });

  it.each(surfaces)('%s attributes the history to the members, not the platform', (rel) => {
    const source = stripComments(read(rel));

    // "we confirmed" / "Njangi confirms" would put the assurance on us.
    expect(source).not.toMatch(/\b(?:we|njangi)\s+(?:confirm|verify|validate)\w*\b/i);
  });

  // Every member must sign off before a declared history takes effect
  // (EMigrationNotRatified, njangi_circles.move). If the manage page ever
  // stopped gating on that, the button would promise an activation the
  // contract refuses.
  it('the manage page gates activation on unanimous confirmation', () => {
    const page = stripComments(read('pages/circle/[id]/manage/index.tsx'));

    expect(page).toContain('migrationRatification');
    expect(page).toMatch(/migrationSettled/);
  });

  // The version the member saw is what makes a rewritten ledger abort rather
  // than silently inherit their agreement. Re-reading it at signing time would
  // defeat the guard entirely.
  it('the contribute page confirms against the version on screen', () => {
    const page = stripComments(read('pages/circle/[id]/contribute/index.tsx'));

    expect(page).toContain('migrationVersionOnScreen');
    expect(page).toContain('acknowledgeMigrationVersion: migrationVersionOnScreen');
  });
});
