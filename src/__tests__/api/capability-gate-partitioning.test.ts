/**
 * The legacy-rail kill switch must block NEW COMMITMENTS without trapping
 * money already committed. A switch that leaves funds unrecoverable is a worse
 * compliance outcome than the feature it retires — so the partitioning of
 * actions is asserted here rather than left to a reviewer noticing it.
 *
 * Read against the source, so adding a payout or recovery action to
 * LEGACY_RAIL_ACTIONS fails this test rather than silently stranding a member.
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

const SOURCE = readFileSync(
  join(process.cwd(), 'src/pages/api/zkLogin.ts'),
  'utf8',
);

/**
 * Components allowed to POST a gated action, because they only render behind
 * a feature flag that is off in production. Each entry needs a render site
 * asserted below — an unverified allowlist is how the last one got through.
 */
const FLAG_GATED_CALLERS = new Map([
  ['src/components/SimplifiedSwapUI.tsx', 'ENABLE_SWAP_AND_DEPOSIT_FORM'],
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== '__tests__' && entry !== 'api') walk(full, out);
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

function actionSet(name: string): string[] {
  const start = SOURCE.indexOf(`const ${name} = new Set([`);
  if (start === -1) throw new Error(`${name} not found`);
  const body = SOURCE.slice(start, SOURCE.indexOf(']);', start));
  return [...body.matchAll(/'([a-zA-Z]+)'/g)].map((m) => m[1]);
}

describe('capability gate partitioning', () => {
  const legacy = actionSet('LEGACY_RAIL_ACTIONS');
  const swaps = actionSet('SWAP_ACTIONS');

  it('never gates a payout behind the legacy kill switch', () => {
    // trigger_payout moves committed funds to the scheduled recipient. If the
    // rail is switched off with money still in it, this is how it gets out.
    expect(legacy).not.toContain('adminTriggerPayout');
    expect(legacy).not.toContain('finalizeAndRedeemCycleEscrow');
  });

  it('never gates a recovery or refund path', () => {
    // These are the member-voted and timer-driven escape hatches. Blocking
    // them would strand funds precisely when members most need them out.
    for (const escape of [
      'executeRecovery',
      'triggerAutoRelease',
      'proposeEmergencyStop',
      'voteEmergencyStop',
    ]) {
      expect(legacy).not.toContain(escape);
      expect(swaps).not.toContain(escape);
    }
  });

  it('gates the legacy contribution routes', () => {
    expect(legacy).toEqual(
      expect.arrayContaining([
        'contributeFromCustody',
        'depositUsdcDirect',
        'depositStablecoin',
      ]),
    );
  });

  it('gates the whole embedded-swap surface', () => {
    expect(swaps).toEqual(
      expect.arrayContaining([
        'executeStablecoinSwap',
        'swapAndDepositCetus',
        'swapAndDepositDeepBook',
        'executeSwapOnly',
      ]),
    );
  });

  it('keeps the two gates disjoint so a route has one owner', () => {
    expect(legacy.filter((a) => swaps.includes(a))).toEqual([]);
  });

  /**
   * The regression this exists for: `depositUsdcDirect` sat in
   * LEGACY_RAIL_ACTIONS while the contribute page still POSTed it for every
   * USDC security deposit. The gate answered 503, the button did nothing, and
   * a comment in zkLogin.ts asserted the action was unreachable — so the audit
   * that would have caught it read the claim instead of the code.
   *
   * A gated action reachable from ungated UI is a dead button, not a disabled
   * feature.
   */
  it('is never POSTed from a component that always renders', () => {
    const gated = new Set([...legacy, ...swaps]);
    const offenders: string[] = [];

    for (const file of walk(join(process.cwd(), 'src/pages')).concat(
      walk(join(process.cwd(), 'src/components')),
    )) {
      const rel = relative(process.cwd(), file);
      if (FLAG_GATED_CALLERS.has(rel)) continue;
      const text = readFileSync(file, 'utf8');
      for (const [, action] of text.matchAll(/action:\s*'([a-zA-Z]+)'/g)) {
        if (gated.has(action)) offenders.push(`${rel} -> ${action}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('only exempts callers that are genuinely flag-gated', () => {
    // Keeps the allowlist honest: each exempt component must have a render
    // site guarded by its named flag, or the exemption is fiction.
    for (const [rel, flag] of FLAG_GATED_CALLERS) {
      const component = rel.split('/').pop()!.replace(/\.tsx?$/, '');
      const renderSites = walk(join(process.cwd(), 'src/pages'))
        .map((f) => readFileSync(f, 'utf8'))
        .filter((t) => t.includes(`<${component}`));

      expect(renderSites.length).toBeGreaterThan(0);
      for (const text of renderSites) {
        expect(text).toMatch(new RegExp(`${flag}\\s*&&`));
      }
    }
  });
});
