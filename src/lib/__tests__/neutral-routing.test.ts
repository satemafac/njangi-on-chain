/**
 * Compliance invariant #5: DEX routing is member-initiated and NEUTRAL — no
 * routing fee, no positive slippage taken, no embedded market-making position.
 *
 * Breaking it is not a UX regression. Taking a cut of a swap is taking a fee
 * from a fund flow, which is invariant #3 as well, and between them they are
 * most of the argument that this is coordination software rather than a
 * financial intermediary.
 *
 * The risk is specific and easy to trip: the Cetus SDKs offer a fee-share hook
 * as an OPTIONAL argument — `swap_partner` on the CLMM SDK, `partner` on the
 * aggregator. Passing an address there routes a share of every swap to it. It
 * is one word, in a call we already make, and nothing about the code would look
 * unusual afterwards. Hence a test rather than a convention.
 *
 * Source-level, because the alternative is a live swap against a real pool on
 * every CI run.
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

const SWAP_SOURCES = [
  'src/services/cetus-service.ts',
  'src/lib/cetus-service.ts',
  'src/services/sui-swap-router.ts',
  'src/services/swap-service.ts',
  'src/lib/swap-service.ts',
];

const read = (rel: string) => {
  try {
    return readFileSync(join(process.cwd(), rel), 'utf8');
  } catch {
    return null;
  }
};

/** Comments explain the rule; they must not trip it. */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('neutral DEX routing (compliance invariant #5)', () => {
  const present = SWAP_SOURCES.map((rel) => ({ rel, code: read(rel) })).filter(
    (f): f is { rel: string; code: string } => f.code !== null,
  );

  it('finds the swap sources it means to guard', () => {
    // Without this, deleting or renaming a file would make the suite silently
    // vacuous rather than failing.
    expect(present.length).toBeGreaterThan(0);
    expect(present.some((f) => f.rel.includes('cetus-service'))).toBe(true);
  });

  it('never passes a partner or referral to the swap SDK', () => {
    // `swap_partner` (CLMM) and `partner` (aggregator) are the documented
    // fee-share hooks. Not passing them is the invariant.
    const offenders: string[] = [];
    for (const { rel, code } of present) {
      const src = stripComments(code);
      for (const hook of ['swap_partner', 'partner:', 'referral', 'partnerId']) {
        if (src.includes(hook)) offenders.push(`${rel} -> ${hook}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('takes no fee, spread or commission on a swap', () => {
    const offenders: string[] = [];
    for (const { rel, code } of present) {
      const src = stripComments(code);
      for (const term of [
        /\bplatformFee\b/,
        /\btakeFee\b/,
        /\bfeeRecipient\b/,
        /\bcommission\b/,
        /\bskim\b/,
        /\bmarkup\b/,
      ]) {
        if (term.test(src)) offenders.push(`${rel} -> ${term.source}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('sends swap output to the member, never to a hardcoded address', () => {
    // A literal 0x… address in the swap path would be the obvious way to
    // route proceeds somewhere else. The sender is set from the caller's own
    // wallet address and nothing else.
    const offenders: string[] = [];
    for (const { rel, code } of present) {
      const src = stripComments(code);
      const literals = src.match(/['"]0x[0-9a-fA-F]{40,}['"]/g) ?? [];
      // Coin types and the clock are legitimate; a bare 64-hex ADDRESS is not.
      const bare = literals.filter((l) => !l.includes('::') && !/0x0*6['"]$/.test(l));
      if (bare.length) offenders.push(`${rel} -> ${bare.join(', ')}`);
    }
    expect(offenders).toEqual([]);
  });

  it('derives the slippage limit from the quote rather than a reduced figure', () => {
    // amount_limit is what the member is guaranteed. Computing it from
    // anything other than the live quote would let the difference be captured
    // as positive slippage — a fee by another name.
    const cetus = present.find((f) => f.rel === 'src/services/cetus-service.ts');
    expect(cetus).toBeDefined();
    const src = stripComments(cetus!.code);
    expect(src).toMatch(/amountLimit\s*=\s*byAmountIn/);
    expect(src).toMatch(/quote\.estimatedAmountOut/);
    expect(src).toMatch(/amount_limit:\s*amountLimit\.toString\(\)/);
  });
});

describe('routing stays member-initiated', () => {
  it('no server route executes a swap', () => {
    // Invariant #5 says member-initiated. A server-side swap executor would
    // also need a key it no longer has, but the capability gate is the layer
    // that makes the intent explicit.
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full, out);
        else if (full.endsWith('.ts')) out.push(full);
      }
      return out;
    };

    const swapActions = ['executeStablecoinSwap', 'swapAndDepositCetus', 'swapAndDepositDeepBook'];
    const dispatcher = readFileSync(join(process.cwd(), 'src/pages/api/zkLogin.ts'), 'utf8');

    // Each must be inside SWAP_ACTIONS, i.e. behind the kill switch.
    const gateBlock = /const SWAP_ACTIONS = new Set\(\[([\s\S]*?)\]\)/.exec(dispatcher)?.[1] ?? '';
    for (const action of swapActions) {
      expect(gateBlock).toContain(action);
    }

    // And no OTHER api route may reference them at all.
    const others = walk(join(process.cwd(), 'src/pages/api')).filter(
      (f) => !f.endsWith('api/zkLogin.ts'),
    );
    const offenders: string[] = [];
    for (const file of others) {
      const code = stripComments(readFileSync(file, 'utf8'));
      for (const action of swapActions) {
        if (code.includes(action)) offenders.push(`${relative(process.cwd(), file)} -> ${action}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('swap reads survive a rate-limited endpoint', () => {
  it('builds through the pooled failover client, not a raw single-URL one', () => {
    // Found by trying to execute a real swap: the quote succeeded, then
    // building the transaction failed with "Unable to prepare the swap
    // transaction" because it constructed `new SuiClient({ url:
    // getCurrentRpcUrl() })` — one endpoint, no failover — while blockvision
    // was returning 429. Every other read path in the app fails over.
    //
    // A swap that cannot build is not a compliance failure, but it is the
    // difference between invariant #5 being exercisable and being theoretical.
    const src = readFileSync(join(process.cwd(), 'src/services/cetus-service.ts'), 'utf8');
    const code = stripComments(src);

    expect(code).not.toMatch(/new SuiClient\(/);
    expect(code).toContain('getPooledSuiClient()');
    // The SDK takes a URL rather than a client, so it gets the first
    // CANDIDATE — the ordering that deprioritises rate-limited hosts.
    expect(code).toContain('getRpcCandidateUrls(');
  });
});
