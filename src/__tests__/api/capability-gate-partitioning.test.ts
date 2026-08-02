/**
 * The legacy-rail kill switch must block NEW COMMITMENTS without trapping
 * money already committed. A switch that leaves funds unrecoverable is a worse
 * compliance outcome than the feature it retires — so the partitioning of
 * actions is asserted here rather than left to a reviewer noticing it.
 *
 * Read against the source, so adding a payout or recovery action to
 * LEGACY_RAIL_ACTIONS fails this test rather than silently stranding a member.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const SOURCE = readFileSync(
  join(process.cwd(), 'src/pages/api/zkLogin.ts'),
  'utf8',
);

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
});
