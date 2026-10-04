/**
 * Source guards for the places that used to scale a coin they had not
 * identified. Each scaled by a guess: the dashboard treated an unknown coin
 * as 9 decimals (its send flow then moved 10^3 times the typed amount of a
 * 6-decimal coin), the goal pools and the swap service treated every non-SUI
 * coin as 6-decimal USDC, the round alerts defaulted to "SUI, 9 decimals"
 * (a 0.30 USDC share read "0.0003 SUI"), and the Add funds watcher divided
 * every balance by 1e6. They now resolve SUI and USDC by exact type
 * (src/lib/supported-coins.ts) and treat anything else as unsupported.
 *
 * Source-level, like copy-guards.test.ts: jest runs in node with no .tsx
 * rendering, and the helpers themselves are unit-tested.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');

/** Comments explain the old behaviour; they must not trip the guard. */
const code = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('no surface scales a coin by a guess', () => {
  it('dashboard: wallet rows by exact type, sends scaled exactly by a supported coin', () => {
    const dashboard = code('src/pages/dashboard.tsx');
    expect(dashboard).not.toContain('getCoinDecimals');
    expect(dashboard).not.toMatch(/Default to 9 decimals/);
    expect(dashboard).not.toMatch(/Math\.floor\(amount \* decimals\)/);
    expect(dashboard).toContain('buildWalletCoins(chainBalances, activeNetwork)');
    expect(dashboard).toContain('parseCoinAmount(transferForm.amount, selectedCoin.decimals)');
    expect(dashboard).not.toContain('/ 1e6');
  });

  it('cetus-service: SUI and USDC by exact type, anything else refused', () => {
    const cetus = code('src/services/cetus-service.ts');
    expect(cetus).not.toContain('STABLECOIN_DECIMALS');
    expect(cetus).not.toContain("includes('::usdc::')");
    expect(cetus).toContain('resolveSupportedCoin(coinType, getCurrentNetwork())');
    // The call to a module the package does not have is gone.
    expect(cetus).not.toContain('njangi_circle::');
  });

  it.each(['src/components/goals/GoalPoolPanel.tsx', 'src/components/goals/GoalPoolsSection.tsx'])(
    '%s: no "every non-SUI coin is USDC"',
    (rel) => {
      const source = code(rel);
      expect(source).not.toContain("endsWith('::sui::sui')");
      expect(source).toContain('resolveSupportedCoin(');
      expect(source).not.toMatch(/Math\.round\(value \* 10 \*\* /);
    },
  );

  it('round alerts: amounts in the round’s own coin, no SUI default', () => {
    const alerts = code('src/components/NjangiRoundAlerts.tsx');
    expect(alerts).not.toMatch(/coinSymbol \?\? 'SUI'/);
    expect(alerts).not.toMatch(/coinDecimals \?\? 9/);
    expect(alerts).toContain('resolveEscrowCoin(state, escrow, network)');
  });

  it('Add funds watcher: both coins in base units', () => {
    const modal = code('src/components/ReceiveFundsModal.tsx');
    expect(modal).toContain('detectFundsArrival(');
    expect(modal).not.toMatch(/Promise<number>/);
  });
});
