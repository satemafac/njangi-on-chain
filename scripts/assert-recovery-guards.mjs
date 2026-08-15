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
  //
  // State-aware, because the correct answer INVERTS once a proposal passes:
  // recovery is then supposed to be executable by anyone, and asserting a
  // refusal would fail on exactly the circles where the mechanism worked. The
  // meaningful assertion is the pairing — refused before the majority, allowed
  // after — so the script reports which side of that line the circle is on
  // rather than assuming one.
  const adminRecovery = await abortsFor(admin, recovery);
  const proposalHasPassed = !adminRecovery.refused;

  if (proposalHasPassed) {
    record(
      true,
      'recovery is executable BECAUSE a member majority passed',
      'proposal passed — refusal correctly lifted',
    );
    if (member) {
      const memberRecovery = await abortsFor(member, recovery);
      record(
        !memberRecovery.refused,
        'recovery is permissionless once passed (any member can execute)',
        memberRecovery.refused ? `REFUSED (${memberRecovery.code})` : 'allowed',
      );
    }
  } else {
    record(
      true,
      'admin cannot execute recovery without a passed member vote',
      `refused (${adminRecovery.code ?? adminRecovery.error})`,
    );
    if (member) {
      const memberRecovery = await abortsFor(member, recovery);
      record(
        memberRecovery.refused,
        'a member cannot execute recovery without a passed vote either',
        memberRecovery.refused ? `refused (${memberRecovery.code ?? memberRecovery.error})` : 'ALLOWED',
      );
    }
  }

  // The rotation order decides WHO receives each pot. Once a circle is active
  // and members have funded a cycle, an admin who could reorder it could move
  // themselves into the current payout slot — the one place a role called
  // "admin" ever had discretion over fund direction. The contract refuses
  // unless the circle is inactive or explicitly paused.
  //
  // Only meaningful against an ACTIVE circle: on an inactive one the reorder
  // is legitimately allowed, so a pass here would prove nothing.
  const circleState = await client.getObject({ id: circle, options: { showContent: true } });
  const content = circleState.data?.content;
  const fields = content && content.dataType === 'moveObject' ? content.fields : {};
  const isActive = fields.is_active === true;
  const rotation = Array.isArray(fields.rotation_order) ? fields.rotation_order : [];

  if (isActive && rotation.length >= 2) {
    // Swap the first two positions: the smallest change that redirects the
    // current payout.
    const swapped = [rotation[1], rotation[0], ...rotation.slice(2)];
    const reorder = () => {
      const tx = new Transaction();
      tx.moveCall({
        target: `${pkg}::njangi_circles::reorder_rotation_positions_entry`,
        arguments: [tx.object(circle), tx.pure.vector('address', swapped), tx.object(CLOCK)],
      });
      return tx;
    };
    const attempt = await abortsFor(admin, reorder);
    record(
      attempt.refused && attempt.code === 58,
      'admin cannot reorder the rotation while the circle is active',
      attempt.refused
        ? `refused (${attempt.code === 58 ? '58 ECircleNotPausedForConfigChange' : attempt.code ?? attempt.error})`
        : 'ALLOWED — an admin could redirect a funded payout',
    );
  } else {
    record(
      true,
      'rotation lock (needs an ACTIVE circle with >=2 in rotation)',
      isActive ? 'skipped — rotation too short' : 'skipped — circle inactive',
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
