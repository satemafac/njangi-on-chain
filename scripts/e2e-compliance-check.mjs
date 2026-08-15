#!/usr/bin/env node
/**
 * e2e-compliance-check.mjs — asserts the CLARITY-alignment properties against
 * a LIVE deployment and the LIVE chain.
 *
 *   node scripts/e2e-compliance-check.mjs [--host https://njangionchain.com]
 *
 * This covers everything provable without a browser session. It deliberately
 * does NOT cover the things only a signed-in user can exercise (that a real
 * transaction is signed locally and lands on chain) — those live in
 * docs/e2e-browser-runbook.md, because pretending an unauthenticated probe
 * proves them is how the Phase 1 regression went unnoticed for a day.
 *
 * Each check names the claim it defends. A check that cannot say what it
 * would catch is not worth running.
 */

const HOST =
  process.argv.find((a) => a.startsWith('--host='))?.split('=')[1] ??
  'https://njangionchain.com';

const RPC =
  process.env.SUI_RPC_URL ?? 'https://sui-testnet-rpc.publicnode.com';

const results = [];
let failed = 0;

function record(area, claim, ok, detail) {
  results.push({ area, claim, ok, detail });
  if (!ok) failed += 1;
}

async function post(path, body) {
  try {
    const res = await fetch(`${HOST}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    let json = null;
    try {
      json = await res.json();
    } catch {
      /* non-JSON body is fine; status is what most checks assert */
    }
    return { status: res.status, json };
  } catch (err) {
    return { status: 0, json: { error: String(err) } };
  }
}

async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return res.json();
}

// ---------------------------------------------------------------------------

async function checkNoSigningOracle() {
  // Phase 0. The endpoint took arbitrary transaction bytes and signed them
  // with the session's key, gated only by cookie possession — cookie theft
  // was wallet theft.
  for (const action of ['sendSerializedTransaction', 'executeSwap']) {
    const { status, json } = await post('/api/zkLogin', {
      action,
      txb: 'AAAA',
      account: { userAddr: '0x1' },
    });
    record(
      'no-signing-oracle',
      `${action} refuses arbitrary transaction bytes`,
      status === 410 && json?.code === 'SERIALIZED_TX_REMOVED',
      `HTTP ${status} ${json?.code ?? ''}`,
    );
  }
}

async function checkBrowserHeldKeys() {
  // Phase 1. The server must not accept, or be able to use, a user's key.
  const { status, json } = await post('/api/zkLogin', {
    action: 'beginLogin',
    provider: 'Google',
    network: 'testnet',
  });
  record(
    'browser-held-keys',
    'beginLogin refuses to start without a browser-generated public key',
    status === 400 && json?.code === 'EPHEMERAL_KEY_REQUIRED',
    `HTTP ${status} ${json?.code ?? ''}`,
  );

  // And with one, the nonce it returns must be derivable from the PUBLIC half
  // alone — proving the server needs no secret to run the handshake.
  const { Ed25519Keypair } = await import('@mysten/sui/keypairs/ed25519');
  const { generateNonce, generateRandomness } = await import('@mysten/sui/zklogin');
  const kp = new Ed25519Keypair();
  const randomness = generateRandomness().toString();
  const begun = await post('/api/zkLogin', {
    action: 'beginLogin',
    provider: 'Google',
    network: 'testnet',
    origin: HOST,
    ephemeralPublicKey: kp.getPublicKey().toBase64(),
    randomness,
  });
  const loginUrl = begun.json?.loginUrl;
  const serverNonce = loginUrl ? new URL(loginUrl).searchParams.get('nonce') : null;
  const clientNonce = begun.json?.maxEpoch
    ? generateNonce(kp.getPublicKey(), begun.json.maxEpoch, randomness)
    : null;
  record(
    'browser-held-keys',
    'OAuth nonce is bound to the browser-generated key',
    Boolean(serverNonce) && serverNonce === clientNonce,
    serverNonce === clientNonce ? 'match' : `server=${serverNonce} client=${clientNonce}`,
  );
  record(
    'browser-held-keys',
    'callback response carries no private key field',
    !JSON.stringify(begun.json ?? {}).includes('ephemeralPrivateKey'),
    'beginLogin payload inspected',
  );
}

async function checkSponsorSplit() {
  // Phase 2. The sponsor routes must resolve the caller from the session
  // cookie, never the request body — otherwise sponsorship could be billed
  // to, and attributed to, someone else.
  for (const route of ['prepare', 'execute']) {
    const { status, json } = await post(`/api/sponsor/${route}`, {
      action: 'contributeToCycleEscrow',
      kindBytes: 'AAAA',
      digest: 'd',
      signature: 's',
      // A body-supplied identity must be ignored.
      account: { userAddr: '0xdeadbeef' },
      sub: 'someone-else',
    });
    record(
      'sponsor-split',
      `/api/sponsor/${route} requires a real session`,
      status === 401,
      `HTTP ${status} ${json?.error ?? ''}`,
    );
  }
}

async function checkKillSwitchesDoNotTrapFunds() {
  // Phase 3. The invariant that matters: gates block NEW COMMITMENTS and
  // never the paths that get committed money back out.
  const mustBeReachable = [
    'adminTriggerPayout',
    'finalizeAndRedeemCycleEscrow',
    'executeRecovery',
    'triggerAutoRelease',
    'proposeEmergencyStop',
    'voteEmergencyStop',
  ];
  for (const action of mustBeReachable) {
    const { status, json } = await post('/api/zkLogin', { action });
    const gated = json?.error === 'CAPABILITY_DISABLED';
    record(
      'funds-never-trapped',
      `${action} is not behind a capability gate`,
      !gated,
      gated ? `GATED (${json?.capability})` : `HTTP ${status}`,
    );
  }

  // Legacy CONTRIBUTIONS, by contrast, should be gated.
  const { json } = await post('/api/zkLogin', { action: 'depositUsdcDirect' });
  record(
    'kill-switches',
    'legacy contribution route is gated',
    json?.error === 'CAPABILITY_DISABLED' && json?.capability === 'legacy_rail',
    json?.capability ?? JSON.stringify(json).slice(0, 60),
  );
}

async function checkSanctions() {
  // Phase 4. A listed address must be refused, and an unscreenable request
  // must say so distinctly rather than claiming the user is banned.
  const listed = process.env.E2E_LISTED_ADDRESS;
  if (!listed) {
    record(
      'sanctions',
      'listed-address block (set E2E_LISTED_ADDRESS to check)',
      true,
      'skipped — no sample address supplied',
    );
    return;
  }
  const { status, json } = await post('/api/join-requests/create', {
    circleId: '0x' + '1'.repeat(64),
    circleName: 'e2e-probe',
    userAddress: listed,
  });
  record(
    'sanctions',
    'OFAC-listed address cannot join a circle',
    status === 403 && json?.code === 'SANCTIONS_BLOCKED',
    `HTTP ${status} ${json?.code ?? ''}`,
  );
}

async function checkChainInvariants() {
  // Phase 5. Assert the deployed package, not the local source.
  const pkg = process.env.E2E_PACKAGE_ID;
  if (!pkg) {
    record('chain', 'package assertions (set E2E_PACKAGE_ID)', true, 'skipped');
    return;
  }

  const escrow = await rpc('sui_getNormalizedMoveModule', [pkg, 'njangi_cycle_escrow']);
  if (escrow.error) {
    record('chain', 'cycle escrow module resolves', false, escrow.error.message);
    return;
  }
  const fns = escrow.result.exposedFunctions ?? {};
  record(
    'chain',
    'finalize_to_recipient exists (permissionless settlement survives)',
    'finalize_to_recipient' in fns,
    Object.keys(fns).length + ' exposed functions',
  );
  record(
    'chain',
    'refund paths exist (contributors can always be made whole)',
    'cancel_unfinalized_escrow' in fns && 'refund_expired_claim' in fns,
    ['cancel_unfinalized_escrow', 'refund_expired_claim']
      .filter((f) => f in fns)
      .join(', '),
  );

  const circles = await rpc('sui_getNormalizedMoveModule', [pkg, 'njangi_circles']);
  const cfns = circles.result?.exposedFunctions ?? {};
  record(
    'chain',
    'claim_membership exists (discovery is self-serve, not admin-gated)',
    'claim_membership' in cfns,
    'claim_membership' in cfns ? 'present' : 'MISSING',
  );

  // Compliance invariant #4: the retired yield modules must not be present.
  //
  // Matched by EXACT name, not a substring pattern. A /yield|exchange|ember/
  // regex flags `njangi_members` ("m-ember-s"), which is how a compliance
  // check starts crying wolf and then gets ignored.
  const RETIRED_MODULES = new Set([
    'njangi_yield_integration',
    'exchange',
    'njangi_ember_vault',
  ]);
  const mods = await rpc('sui_getNormalizedMoveModulesByPackage', [pkg]);
  const names = Object.keys(mods.result ?? {});
  const forbidden = names.filter((n) => RETIRED_MODULES.has(n));
  record(
    'chain',
    'no yield/exchange modules in the deployed package',
    forbidden.length === 0,
    forbidden.length ? `FOUND: ${forbidden.join(', ')}` : `${names.length} modules, none forbidden`,
  );
}

// ---------------------------------------------------------------------------

async function main() {
  console.log(`\ne2e-compliance-check → ${HOST}\n`);

  await checkNoSigningOracle();
  await checkBrowserHeldKeys();
  await checkSponsorSplit();
  await checkKillSwitchesDoNotTrapFunds();
  await checkSanctions();
  await checkChainInvariants();

  let area = '';
  for (const r of results) {
    if (r.area !== area) {
      area = r.area;
      console.log(`\n  ${area}`);
    }
    console.log(`    ${r.ok ? 'PASS' : 'FAIL'}  ${r.claim}`);
    if (!r.ok || process.env.E2E_VERBOSE) console.log(`          ${r.detail}`);
  }

  console.log(
    `\n  ${results.length - failed}/${results.length} passed` +
      (failed ? `  — ${failed} FAILED\n` : '\n'),
  );
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('e2e-compliance-check crashed:', err);
  process.exit(1);
});
