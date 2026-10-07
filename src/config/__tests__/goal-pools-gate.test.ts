import * as fs from 'fs';
import * as path from 'path';

/**
 * Goal-pool creation is gated on NEXT_PUBLIC_GOAL_POOLS_ENABLED (off for the
 * first mainnet cohort, per counsel). The pages are .tsx modules jest does
 * not load, so this pins their source the way create-circle-coin.test.ts
 * pins the coin choice: every entry point to a new pool has to consult
 * isGoalPoolsEnabled(), and the read-only pool surfaces must not.
 */
const read = (...segments: string[]) =>
  fs.readFileSync(path.join(__dirname, '..', '..', ...segments), 'utf8');

describe('the create page gates goal pools on isGoalPoolsEnabled()', () => {
  const page = read('pages', 'create-circle.tsx');

  it('reads the flag from the shared feature-flags module', () => {
    expect(page).toContain("import { isGoalPoolsEnabled } from '../config/feature-flags';");
    expect(page).toContain('const goalPoolsEnabled = isGoalPoolsEnabled();');
  });

  it('does not render the smart-goal choice while the flag is off', () => {
    expect(page).toMatch(
      /\{goalPoolsEnabled && \(\s*<button\s+type="button"\s+onClick=\{chooseSmartGoal\}/,
    );
    // The door's handler refuses too, so a stale render cannot open it.
    expect(page).toMatch(
      /const chooseSmartGoal = \(\) => \{\s*if \(!goalPoolsEnabled\) \{\s*toast\.error\(GOAL_POOLS_DISABLED_MESSAGE\);\s*return;/,
    );
  });

  it('does not mount the smart-goals upsell modal while the flag is off', () => {
    expect(page).toMatch(/\{goalPoolsEnabled && \(\s*<BillingUpsellModal\s+open=\{showSmartGoalUpsell\}/);
  });

  it('refuses to submit a goal pool even if state holds smart-goal', () => {
    expect(page).toMatch(
      /if \(formData\.cycleType === 'smart-goal'\) \{\s*if \(!goalPoolsEnabled\) \{[\s\S]*?toast\.error\(GOAL_POOLS_DISABLED_MESSAGE\);\s*chooseRotational\(\);\s*return;\s*\}\s*setIsCreating\(true\);\s*try \{\s*await handleCreateGoalPool\(\);/,
    );
    expect(page).toMatch(
      /const handleCreateGoalPool = async \(\) => \{[\s\S]{0,200}?if \(!goalPoolsEnabled\) \{\s*toast\.error\(GOAL_POOLS_DISABLED_MESSAGE\);\s*return;/,
    );
  });

  it('pins cycleType to rotational while the flag is off, restored drafts included', () => {
    expect(page).toContain(
      "isGoalPoolsEnabled() || restored.cycleType !== 'smart-goal'",
    );
    expect(page).toContain(
      "if (!isGoalPoolsEnabled() && formData.cycleType === 'smart-goal') {",
    );
  });

  it('names the refusal in plain words', () => {
    expect(page).toContain(
      "'Goal pools are not available yet. Create a rotating circle instead.'",
    );
  });
});

describe('the circle goals page gates its create link on isGoalPoolsEnabled()', () => {
  const page = read('pages', 'circle', '[id]', 'goals.tsx');

  it('hides the "Create a smart-goal circle" link while the flag is off', () => {
    expect(page).toContain("import { isGoalPoolsEnabled } from '@/config/feature-flags';");
    expect(page).toMatch(
      /\{isGoalPoolsEnabled\(\) \? \(\s*<NextLink\s+href="\/create-circle"[\s\S]*?Create a smart-goal circle[\s\S]*?\) : null\}/,
    );
  });
});

describe('existing pools stay readable whatever the flag says', () => {
  // Only CREATION is gated. The pool page, the dashboard section and the
  // discovery module must not consult the flag, or a mainnet operator
  // flipping it off would hide pots that already hold money.
  it.each([
    ['pages', 'pool', '[id].tsx'],
    ['components', 'goals', 'GoalPoolsSection.tsx'],
    ['components', 'goals', 'GoalPoolPanel.tsx'],
    ['lib', 'goal-pool-discovery.ts'],
  ])('%s/%s/%s does not read isGoalPoolsEnabled', (...segments) => {
    expect(read(...segments)).not.toContain('isGoalPoolsEnabled');
  });
});
