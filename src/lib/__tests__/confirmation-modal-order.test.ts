/**
 * A confirmation dialog must close BEFORE it runs its action, not after.
 *
 * The manage page's dialog did `onConfirm(); setState({isOpen:false})`. Some
 * handlers chain a second confirmation — `handleResumeCycle` opens one to
 * spell out that resuming resets every member's deposit — and the trailing
 * close ran against the state that handler had just set, so the second dialog
 * opened and shut in the same tick. Resume Cycle silently did nothing, which
 * strands every circle paused at the end of every round.
 *
 * Found on production 2026-08-21 while running a migrated circle through a
 * full round: the pause landed correctly and the circle could not be resumed.
 *
 * Source-text assertion because jest runs `testEnvironment: 'node'` and
 * `testMatch` excludes `.tsx` — same technique as copy-guards.test.ts.
 */
import { readFileSync } from 'fs';
import path from 'path';

const read = (rel: string) => readFileSync(path.resolve(__dirname, '../..', rel), 'utf8');

const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('confirmation dialog ordering', () => {
  it('the manage page closes the dialog before running the action', () => {
    const page = stripComments(read('pages/circle/[id]/manage/index.tsx'));

    // The exact broken shape: invoke, then close.
    expect(page).not.toMatch(
      /confirmationModal\.onConfirm\(\);\s*setConfirmationModal\(\s*prev\s*=>\s*\(\{\s*\.\.\.prev,\s*isOpen:\s*false/,
    );

    // The correct shape: close, then invoke.
    expect(page).toMatch(
      /setConfirmationModal\(\s*prev\s*=>\s*\(\{\s*\.\.\.prev,\s*isOpen:\s*false\s*\}\)\s*\);\s*confirmationModal\.onConfirm\(\);/,
    );
  });
});
