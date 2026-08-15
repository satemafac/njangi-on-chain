// sponsored-tx-client.ts — browser half of the sponsored-transaction protocol.
//
// Gas sponsorship used to run entirely on the server: it built the kind, asked
// Enoki to sponsor, THEN minted the user's zkLogin signature from the ephemeral
// key it held, and submitted. Enoki only ever supplied the gas coin — the user
// signature came from us, so the sponsored path was exactly as custodial as the
// self-paid one.
//
// Now the signature is produced here. The server can refuse to sponsor (benign:
// the caller falls back to self-paid gas) but it cannot produce a signature,
// because it has no key.
//
// The load-bearing part is `assertSponsoredMatchesKind`. The sponsor hands back
// full transaction bytes for us to sign. If we signed whatever came back, the
// server would have regained an arbitrary-signing oracle by a longer route and
// the entire exercise would be void. So we re-derive the transaction kind from
// the returned bytes and require it to be byte-identical to what we built, with
// the sender pinned to our own address. Gas data is the only permitted delta —
// that is the sponsor's entire job.

import { Transaction } from '@mysten/sui/transactions';
import { toBase64, fromBase64 } from '@mysten/sui/utils';
import type { SuiClient } from '@mysten/sui/client';
import {
  loadSignerSession,
  signTransactionBytes,
  type ClientSignerSession,
} from './zklogin-client-signer';

export interface SponsorPrepareResponse {
  sponsored: boolean;
  reason?: string;
  bytes?: string;
  digest?: string;
}

export interface SponsoredExecuteResult {
  digest: string;
  sponsored: boolean;
}

/**
 * Verify that sponsored bytes differ from what we built ONLY by gas data.
 *
 * Throws rather than returning false: a mismatch means the sponsor tried to
 * have us sign something we did not construct, which is a security event, not
 * a routine "sponsorship unavailable". Callers catch and fall back to
 * self-paid, so a false positive degrades cost rather than breaking the user —
 * but it must be logged loudly, because a comparator that is too strict looks
 * exactly like sponsorship quietly never working.
 */
export async function assertSponsoredMatchesKind(
  sponsoredBytes: Uint8Array,
  expectedKindBytes: Uint8Array,
  expectedSender: string,
  client: SuiClient,
): Promise<void> {
  const sponsoredTx = Transaction.from(sponsoredBytes);

  const sender = sponsoredTx.getData().sender;
  if (!sender || sender.toLowerCase() !== expectedSender.toLowerCase()) {
    throw new Error(
      `Sponsored transaction sender ${sender ?? '(none)'} does not match this session (${expectedSender}).`,
    );
  }

  // Re-serialize just the command portion and compare against what we sent.
  // Any added MoveCall, TransferObjects, or altered argument changes these
  // bytes; a swapped gas coin does not.
  const roundTripped = await sponsoredTx.build({ client, onlyTransactionKind: true });
  if (toBase64(roundTripped) !== toBase64(expectedKindBytes)) {
    throw new Error(
      'Sponsored transaction body does not match the transaction this client built. Refusing to sign.',
    );
  }
}

/**
 * Run the sponsored path end to end, or report that it is unavailable.
 *
 * Returns null when sponsorship was declined for any reason — disabled, over
 * caps, not premium, ineligible target, or a failed verification. Callers treat
 * null as "pay your own gas", never as a hard failure: a member must never be
 * blocked from contributing because a gas subsidy was unavailable.
 */
export async function trySponsoredExecute(args: {
  action: string;
  buildKind: (txb: Transaction) => void | Promise<void>;
  client: SuiClient;
  context?: Record<string, unknown>;
  session?: ClientSignerSession | null;
}): Promise<SponsoredExecuteResult | null> {
  const session = args.session ?? loadSignerSession();
  if (!session) return null;

  try {
    // 1. Build the gas-less kind. No sender, no gas budget — the sponsor owns
    //    gas, and `onlyTransactionKind` discards any sender we set anyway.
    const txb = new Transaction();
    await args.buildKind(txb);
    const kindBytes = await txb.build({
      client: args.client,
      onlyTransactionKind: true,
    });

    // 2. Ask the server for sponsorship. It resolves the caller from the
    //    session cookie, not from anything we send.
    const prepareRes = await fetch('/api/sponsor/prepare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: args.action,
        kindBytes: toBase64(kindBytes),
        context: args.context ?? {},
      }),
    });

    if (!prepareRes.ok) return null;
    const prepared: SponsorPrepareResponse = await prepareRes.json();
    if (!prepared.sponsored || !prepared.bytes || !prepared.digest) {
      return null;
    }

    // 3. Verify before signing. See the note on assertSponsoredMatchesKind.
    const sponsoredBytes = fromBase64(prepared.bytes);
    await assertSponsoredMatchesKind(
      sponsoredBytes,
      kindBytes,
      session.userAddress,
      args.client,
    );

    // 4. Sign locally. This is the step the server structurally cannot do.
    const signature = await signTransactionBytes(session, sponsoredBytes);

    // 5. Submit through the sponsor, which holds the Enoki key.
    const executeRes = await fetch('/api/sponsor/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ digest: prepared.digest, signature }),
    });
    if (!executeRes.ok) return null;

    const executed = await executeRes.json();
    if (!executed?.digest) return null;

    // Wait here rather than server-side: the effects belong to the caller, and
    // the server has no reason to hold a request open for them.
    await args.client.waitForTransaction({
      digest: executed.digest,
      options: { showEffects: true },
    });

    return { digest: executed.digest, sponsored: true };
  } catch (err) {
    // Loud on purpose. Sponsorship failing is not user-visible, so without this
    // a broken verifier is indistinguishable from "no one is eligible".
    console.warn('[sponsored-tx] falling back to self-paid gas:', err);
    return null;
  }
}
