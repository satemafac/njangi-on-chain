/**
 * The manage page re-reads the circle after every admin transaction. A read
 * that reaches a node before it has indexed the transaction shows the state
 * from before it, and the page believes it. Live on testnet (2026-10-06):
 * after Activate Circle the page fell back to "Inactive", so the round panel
 * never opened the first round by itself until a manual Refresh; after
 * saving the rotation every member showed "without position" until a reload.
 *
 * Resume Cycle already waited for indexing. These pin the same wait on every
 * transaction the page signs, so a new action cannot quietly skip it.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const source = readFileSync(join(process.cwd(), 'src/pages/circle/[id]/manage/index.tsx'), 'utf8');

describe('manage page: re-read only after the transaction is indexed', () => {
  it('runSignedTx resolves only once the node has indexed the transaction', () => {
    const start = source.indexOf('async function runSignedTx(');
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf('\n}\n', start));
    const signed = body.indexOf('await fn()');
    const waited = body.indexOf('await waitForTxIndexed(', signed);
    const succeeded = body.indexOf('response: { ok: true', signed);
    expect(signed).toBeGreaterThan(-1);
    // Signed, then indexed, then reported: the callers' refresh comes after.
    expect(waited).toBeGreaterThan(signed);
    expect(succeeded).toBeGreaterThan(waited);
  });

  it('activates through runSignedTx, so the auto-open sees the circle active', () => {
    const activate = source.slice(source.indexOf('const handleActivateCircle'));
    expect(activate.indexOf('runSignedTx(')).toBeGreaterThan(-1);
    expect(activate.indexOf('runSignedTx(')).toBeLessThan(activate.indexOf('fetchCircleDetails('));
  });

  it('waits after every transaction it signs outside runSignedTx, before re-reading', () => {
    // Every direct signer: the rotation save, the migration record and its
    // removal, the recovery actions and the next-in-command update.
    const signers = [...source.matchAll(/await (?:zkLoginClient|new ZkLoginClient\(\))\.(\w+)\(/g)];
    expect(signers.map((m) => m[1])).toEqual(
      expect.arrayContaining([
        'reorderRotationPositions',
        'declareMigrationState',
        'clearMigrationState',
        'updateNextInCommand',
      ]),
    );
    for (const match of signers) {
      const after = source.slice(match.index);
      const reread = after.indexOf('fetchCircleDetails(');
      const waited = after.indexOf('waitForTxIndexed(');
      expect({ signer: match[1], waitsFirst: waited > -1 && waited < reread }).toEqual({
        signer: match[1],
        waitsFirst: true,
      });
    }
  });

  it('keeps the digest of every direct signer, which is what the wait needs', () => {
    for (const match of source.matchAll(/await (?:zkLoginClient|new ZkLoginClient\(\))\.(\w+)\(/g)) {
      const before = source.slice(Math.max(0, (match.index ?? 0) - 40), match.index);
      expect({ signer: match[1], keepsDigest: /\{\s*digest\s*\}\s*=\s*$/.test(before) }).toEqual({
        signer: match[1],
        keepsDigest: true,
      });
    }
  });
});
