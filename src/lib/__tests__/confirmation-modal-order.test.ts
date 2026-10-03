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
  // The component closes too, and its close runs AFTER the consumer's
  // handler — so this layer matters even when the page gets it right.
  it('the shared modal closes before running its action', () => {
    const modal = stripComments(read('components/ConfirmationModal.tsx'));

    expect(modal).not.toMatch(/onConfirm\(\);\s*onClose\(\);/);
    expect(modal).toMatch(/onClose\(\);\s*onConfirm\(\);/);
  });

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

  // The circle page's member vote, liveness fallback and emergency stop used
  // window.confirm, which in-app browsers (WhatsApp, Instagram) can block and
  // which froze the whole page while it was open.
  describe('the circle page recovery actions', () => {
    const page = stripComments(read('pages/circle/[id]/index.tsx'));

    it('confirm in the shared dialog, not window.confirm', () => {
      expect(page).not.toMatch(/window\.confirm\s*\(/);
      expect(page).toMatch(/import ConfirmationModal from '@\/components\/ConfirmationModal';/);
      expect(page).toMatch(/<ConfirmationModal\b/);
    });

    it('close the dialog before running the action', () => {
      expect(page).not.toMatch(/pending\?\.onConfirm\(\);\s*setRecoveryConfirmation\(null\);/);
      expect(page).toMatch(/setRecoveryConfirmation\(null\);\s*void pending\?\.onConfirm\(\);/);
    });

    it('hold an in-flight lock, so a second confirm cannot submit again', () => {
      // A dialog's onConfirm closes over the render that opened it, so the
      // isSubmitting* state it sees is stale. The ref is the real guard: take
      // it before submitting, release it in `finally`.
      for (const action of ['vote', 'autoRelease', 'execute']) {
        const lock = `recoveryInFlightRef\\.current\\.${action}`;
        expect(page).toMatch(new RegExp(`if \\(${lock}\\) return;\\s*${lock} = true;`));
        expect(page).toMatch(new RegExp(`finally \\{\\s*${lock} = false;`));
      }
    });
  });
});
