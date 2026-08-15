#!/usr/bin/env node
/**
 * assert-recovery-guards.mjs — the money-OUT paths, checked against a live
 * package and a live circle.
 *
 * Invariant #1 says no operator function may direct user funds. The escrow
 * payout half of that is covered by assert-not-recipient.mjs. This covers the
 * other half: the recovery and refund paths, which exist precisely to move
 * money when the normal flow has broken, and are therefore the most attractive
 * place to hide a lever.
 *
 * Two kinds of assertion, deliberately:
 *
 *   STRUCTURAL — read the deployed package and prove no money-out entry point
 *   accepts an address. A destination that cannot be supplied cannot be
 *   redirected, whatever the authorization logic does. This is the stronger
 *   claim and it needs no fixture.
 *
 *   BEHAVIOURAL — simulate the calls that must be refused, via devInspect
 *   (sender, no signature). Proves the authorization guards actually fire
 *   rather than merely existing in source.
 *
 * Usage (from the repo root):
 *   node scripts/assert-recovery-guards.mjs --package 0x… \
 *     [--circle 0x… --wallet 0x… --coin 0x…::usdc::USDC --admin 0x… --member 0x…]
 *
 * Without the circle fixtures only the structural half runs.
 */
import { SuiClient } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';

const CLOCK = '0x6';

/** Every path by which value leaves a circle. */
const MONEY_OUT = {
  njangi_circles: [
    'execute_recovery',
    'trigger_auto_release',
    'propose_emergency_stop',
    'vote_emergency_stop',
  ],
  njangi_cycle_escrow: [
    'finalize_to_recipient',
    'finalize_and_redeem',
    'cancel_unfinalized_escrow',
    'cancel_unfinalized_escrow_for_recovery',
    'refund_expired_claim',
  ],
};

function args() {
  const out = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 2) out[argv[i].replace(/^--/, '')] = argv[i + 1];
  return out;
}

const {
  package: pkg,
  circle,
  wallet,
  coin,
  admin,
  member,
  rpc = process.env.SUI_RPC_URL ?? 'https://sui-testnet-rpc.publicnode.com',
} = args();

if (!pkg) {
  console.error('usage: node scripts/assert-recovery-guards.mjs --package 0x… [--circle 0x… --wallet 0x… --coin … --admin 0x… --member 0x…]');
  process.exit(2);
}

const client = new SuiClient({ url: rpc });
const results = [];
const record = (ok, claim, detail) => results.push({ ok, claim, detail });

// ---------------------------------------------------------------- structural

for (const [moduleName, fns] of Object.entries(MONEY_OUT)) {
  let mod;
  try {
    mod = await client.getNormalizedMoveModule({ package: pkg, module: moduleName });
  } catch (err) {
    record(false, `${moduleName} resolves`, String(err).slice(0, 80));
    continue;
  }
  for (const fn of fns) {
    const def = mod.exposedFunctions?.[fn];
    if (!def) {
      record(false, `${moduleName}::${fn} exists`, 'MISSING');
      continue;
    }
    // An `Address` parameter is the only way a caller could name where funds
    // go. Its absence means the destination comes from on-chain state.
    const takesAddress = JSON.stringify(def.parameters).includes('"Address"');
    record(
      !takesAddress,
      `${fn} takes no caller-supplied destination`,
      takesAddress ? 'ACCEPTS AN ADDRESS' : 'derived from chain state',
    );
  }
}

// --------------------------------------------------------------- behavioural

async function abortsFor(sender, build) {
  const res = await client.devInspectTransactionBlock({ sender, transactionBlock: build() });
  const status = res.effects.status;
  const abort = /MoveAbort\(.*?, (\d+)\)/.exec(status.error ?? '');
  return {
    refused: status.status !== 'success',
    code: abort ? Number(abort[1]) : null,
    error: (status.error ?? '').slice(0, 70),
  };
}

if (circle && wallet && coin && admin) {
  const recovery = () => {
    const tx = new Transaction();
    tx.moveCall({
      target: `${pkg}::njangi_circles::execute_recovery`,
      typeArguments: [coin],
      arguments: [tx.object(circle), tx.object(wallet), tx.object(CLOCK)],
    });
    return tx;
  };
  const autoRelease = () => {
    const tx = new Transaction();
    tx.moveCall({
      target: `${pkg}::njangi_circles::trigger_auto_release`,
      typeArguments: [coin],
      arguments: [tx.object(circle), tx.object(wallet), tx.object(CLOCK)],
    });
    return tx;
  };

  // The admin opens a vote; they do not decide it. Without a passed
  // member-majority proposal, execute_recovery must refuse even for them.
  const adminRecovery = await abortsFor(admin, recovery);
  record(
    adminRecovery.refused,
    'admin cannot execute recovery without a passed member vote',
    adminRecovery.refused ? `refused (${adminRecovery.code ?? adminRecovery.error})` : 'ALLOWED',
  );

  if (member) {
    const memberRecovery = await abortsFor(member, recovery);
    record(
      memberRecovery.refused,
      'a member cannot execute recovery without a passed vote either',
      memberRecovery.refused ? `refused (${memberRecovery.code ?? memberRecovery.error})` : 'ALLOWED',
    );
  }

  // The admin-liveness fallback exists for an ABSENT admin, so the admin is
  // the one party who must never fire it.
  //
  // Read this result carefully. On a circle where auto-release is disabled or
  // the timer has not expired, the refusal is ERecoveryExecutionNotReady (68)
  // — "nothing is armed", NOT "you specifically are excluded". Both are
  // correct refusals, but only the second is the property that matters, and
  // reaching it needs a circle with auto-release enabled AND an expired
  // heartbeat. The admin exclusion itself is proven by the Move unit test
  // njangi_circles::test_auto_release_member_fallback_excludes_admin.
  const adminAuto = await abortsFor(admin, autoRelease);
  const notArmed = adminAuto.code === 68;
  record(
    adminAuto.refused,
    notArmed
      ? 'auto-release refuses the admin (circle not armed; see Move test for exclusion)'
      : 'admin is excluded from the admin-liveness fallback',
    adminAuto.refused ? `refused (${adminAuto.code ?? adminAuto.error})` : 'ALLOWED',
  );
} else {
  record(true, 'behavioural guards (pass --circle/--wallet/--coin/--admin)', 'skipped');
}

// ---------------------------------------------------------------------------

for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.claim.padEnd(58)} ${r.detail}`);
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed${failed ? ` — ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
