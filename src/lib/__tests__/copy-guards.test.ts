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
