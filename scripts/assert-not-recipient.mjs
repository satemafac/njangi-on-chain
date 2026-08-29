#!/usr/bin/env node
/**
 * assert-not-recipient.mjs — proves the single most important on-chain
 * property in the product against a LIVE, FUNDED escrow:
 *
 *   a cycle's pot is redeemable only by the address frozen into its snapshot.
 *
 * Uses devInspectTransactionBlock, which takes a sender but needs no
 * signature. That matters: the UI never offers a non-recipient the collect
 * button, so clicking through the interface proves only that the interface is
 * well behaved. Simulating the call measures the CONTRACT's guard instead.
 *
 * Runs the same call once per member. Non-recipients must abort with
 * E_NOT_RECIPIENT (207). The recipient is the control, and it is not a
 * formality: without it an abort proves only that the call was malformed,
 * which is exactly the false pass this script hit on its first draft.
 *
 * The control passes if the recipient either succeeds OR fails on a LATER
 * guard. The identity assert is the first one in the function, so anything
 * other than 207 means the recipient cleared the gate that stopped everyone
 * else — on an escrow that has already paid out, for instance, the recipient
 * gets E_ALREADY_FINALIZED (205) while non-recipients still get 207. That is
 * a sharper demonstration than a bare success, and it means this script stays
 * meaningful after the pot has been claimed.
 *
 * Usage (from the repo root, so @mysten/sui resolves):
 *   node scripts/assert-not-recipient.mjs \
 *     --escrow 0x… --package 0x… --coin 0x…::usdc::USDC \
 *     --recipient 0x… --member 0x… --member 0x…
 *
 * Exits non-zero if the property does not hold.
 */
import { SuiClient } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';

const E_NOT_RECIPIENT = 207;
const CLOCK = '0x6';

function args() {
  const out = { member: [] };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '');
    const value = argv[i + 1];
    if (key === 'member') out.member.push(value);
    else out[key] = value;
  }
  return out;
}

const {
  escrow,
  package: pkg,
  coin,
  recipient,
  member: members = [],
  rpc = process.env.SUI_RPC_URL ?? 'https://sui-testnet-rpc.publicnode.com',
} = args();

if (!escrow || !pkg || !coin || !recipient || members.length === 0) {
  console.error(
    'usage: node scripts/assert-not-recipient.mjs --escrow 0x… --package 0x… ' +
      '--coin 0x…::usdc::USDC --recipient 0x… --member 0x… [--member 0x…]',
  );
  process.exit(2);
}

const client = new SuiClient({ url: rpc });

function build() {
  // finalize_and_redeem returns NOTHING — it pays the recorded recipient
  // directly, so there is no coin for a caller to redirect. The guard is
  // structural, not a check that could be bypassed.
  const tx = new Transaction();
  tx.moveCall({
    target: `${pkg}::njangi_cycle_escrow::finalize_and_redeem`,
    typeArguments: [coin],
    arguments: [tx.object(escrow), tx.object(CLOCK)],
  });
  return tx;
}

async function attempt(label, sender) {
  const res = await client.devInspectTransactionBlock({ sender, transactionBlock: build() });
  const status = res.effects.status;
  const abort = /MoveAbort\(.*?, (\d+)\)/.exec(status.error ?? '');
  return {
    label,
    sender,
    ok: status.status === 'success',
    abortCode: abort ? Number(abort[1]) : null,
    error: (status.error ?? '').slice(0, 90),
  };
}

const rows = [];
for (const m of members) {
  if (m.toLowerCase() === recipient.toLowerCase()) continue;
  rows.push(await attempt('non-recipient', m));
}
rows.push(await attempt('recipient (control)', recipient));

for (const r of rows) {
  const verdict = r.ok ? 'OK   ' : `ABORT`;
  const detail = r.abortCode !== null ? `code=${r.abortCode}` : r.error;
  console.log(`${verdict} ${r.label.padEnd(20)} ${r.sender.slice(0, 12)}…  ${detail}`);
}

const nonRecipients = rows.filter((r) => r.label === 'non-recipient');
const control = rows[rows.length - 1];
// The recipient must clear the identity gate: success, or any abort that is
// not E_NOT_RECIPIENT (the first assert in the function).
const controlClearedIdentityGate = control.ok || control.abortCode !== E_NOT_RECIPIENT;
const pass =
  nonRecipients.length > 0 &&
  nonRecipients.every((r) => r.abortCode === E_NOT_RECIPIENT) &&
  controlClearedIdentityGate;

if (!control.ok && controlClearedIdentityGate) {
  console.log(
    `\nnote: escrow already settled (recipient hit ${control.abortCode}), so the control ` +
      'shows the recipient clearing the identity gate rather than completing a payout.',
  );
}

console.log(
  `\n${pass ? 'PASS' : 'FAIL'} — non-recipients stopped by E_NOT_RECIPIENT (${E_NOT_RECIPIENT}); ` +
    'recipient clears that gate',
);
process.exit(pass ? 0 : 1);
