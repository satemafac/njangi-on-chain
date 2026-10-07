// sponsored-first-signer.ts — sign and submit with sponsored gas when the
// sponsor will pay, and with the member's own gas otherwise.
//
// Sponsorship is a subsidy, never a precondition (gas-sponsorship.ts): every
// decline lands on the self-paid path. Falling back cannot submit the same
// action twice, because trySponsoredExecute never returns null for a
// transaction the sponsor already broadcast.
//
// Until this existed, components signing through useZkLoginSigner (the round
// panel above all) never asked: a member's payments and collects were always
// self-paid, even in circles whose admin covers the network fee, so a member
// holding no SUI could post a deposit but not pay a share or collect a payout.

import type { SuiClient } from '@mysten/sui/client';
import {
  signAndExecuteWithZkLogin,
  type ClientSignerResult,
  type ClientSignerSession,
  type SignTransactionInput,
} from './zklogin-client-signer';
import { trySponsoredExecute } from './sponsored-tx-client';

export interface SponsorRequest {
  /** Label recorded with the sponsored transaction (gas_sponsorship_usage.action). */
  action: string;
  /**
   * What /api/sponsor/prepare bills: the escrow or circle the transaction
   * touches. It must be one of the transaction's own inputs, or prepare
   * declines.
   */
  context: { escrowId?: string; circleId?: string; coinType?: string };
}

export interface SponsoredFirstResult extends ClientSignerResult {
  /** True when the sponsor paid the network fee. */
  sponsored: boolean;
}

export interface SponsoredFirstDeps {
  trySponsored: typeof trySponsoredExecute;
  selfPaid: typeof signAndExecuteWithZkLogin;
}

const DEFAULT_DEPS: SponsoredFirstDeps = {
  trySponsored: trySponsoredExecute,
  selfPaid: signAndExecuteWithZkLogin,
};

export async function signAndExecuteSponsoredFirst(
  session: ClientSignerSession,
  client: SuiClient,
  input: SignTransactionInput,
  sponsor: SponsorRequest | undefined,
  deps: SponsoredFirstDeps = DEFAULT_DEPS,
): Promise<SponsoredFirstResult> {
  // Only a builder can be rebuilt as a gas-less kind: prebuilt bytes already
  // carry the member's own gas data.
  if (sponsor && 'build' in input) {
    const sponsored = await deps.trySponsored({
      action: sponsor.action,
      buildKind: (txb) => input.build(txb, client),
      client,
      context: sponsor.context,
      session,
    });
    if (sponsored) {
      return { digest: sponsored.digest, effects: sponsored.effects, sponsored: true };
    }
  }
  const result = await deps.selfPaid(session, client, input);
  return { ...result, sponsored: false };
}
