/**
 * The round panel signs through useZkLoginSigner, which only ever paid its
 * own gas: payments and collects were self-paid in every circle, so a member
 * holding no SUI could post a deposit but not pay a share or collect a
 * payout. signAndExecuteSponsoredFirst is the hook's new path. These pin its
 * two promises: ask the sponsor first when asked to, and land on the
 * self-paid path for every decline.
 */
import type { SuiClient } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import {
  signAndExecuteSponsoredFirst,
  type SponsoredFirstDeps,
  type SponsorRequest,
} from '@/lib/sponsored-first-signer';

const session = { userAddress: '0x' + 'a'.repeat(64), network: 'testnet' } as never;
const client = { tag: 'client' } as unknown as SuiClient;
const sponsor: SponsorRequest = {
  action: 'payRoundShare',
  context: { escrowId: '0x' + 'e'.repeat(64), coinType: '0x2::usdc::USDC' },
};
const failedEffects = { status: { status: 'failure', error: 'MoveAbort(...)' } };

function makeDeps(sponsored: Awaited<ReturnType<SponsoredFirstDeps['trySponsored']>>) {
  const trySponsored = jest.fn(async () => sponsored);
  const selfPaid = jest.fn(async () => ({ digest: 'self-paid-digest', effects: { status: { status: 'success' } } }));
  return {
    deps: { trySponsored, selfPaid } as unknown as SponsoredFirstDeps,
    trySponsored,
    selfPaid,
  };
}

describe('signAndExecuteSponsoredFirst', () => {
  it('returns the sponsored transaction and never signs a self-paid one', async () => {
    const { deps, trySponsored, selfPaid } = makeDeps({
      digest: 'sponsored-digest',
      sponsored: true,
      effects: failedEffects,
    });

    const result = await signAndExecuteSponsoredFirst(
      session,
      client,
      { build: jest.fn(), gasBudget: 1 },
      sponsor,
      deps,
    );

    // The effects travel with it, so the caller can still see a failure.
    expect(result).toEqual({ digest: 'sponsored-digest', effects: failedEffects, sponsored: true });
    expect(trySponsored).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'payRoundShare', context: sponsor.context, client, session }),
    );
    expect(selfPaid).not.toHaveBeenCalled();
  });

  it('pays its own gas when the sponsor declines', async () => {
    const { deps, selfPaid } = makeDeps(null);
    const input = { build: jest.fn(), gasBudget: 1 };

    const result = await signAndExecuteSponsoredFirst(session, client, input, sponsor, deps);

    expect(selfPaid).toHaveBeenCalledWith(session, client, input);
    expect(result).toMatchObject({ digest: 'self-paid-digest', sponsored: false });
  });

  it('does not ask when the caller did not request sponsorship', async () => {
    const { deps, trySponsored, selfPaid } = makeDeps(null);

    const result = await signAndExecuteSponsoredFirst(
      session,
      client,
      { build: jest.fn() },
      undefined,
      deps,
    );

    expect(trySponsored).not.toHaveBeenCalled();
    expect(selfPaid).toHaveBeenCalled();
    expect(result.sponsored).toBe(false);
  });

  it("does not ask for prebuilt bytes, which already carry the member's gas", async () => {
    const { deps, trySponsored, selfPaid } = makeDeps(null);

    await signAndExecuteSponsoredFirst(
      session,
      client,
      { bytes: new Uint8Array([1, 2, 3]) },
      sponsor,
      deps,
    );

    expect(trySponsored).not.toHaveBeenCalled();
    expect(selfPaid).toHaveBeenCalled();
  });

  it('rebuilds the same transaction as the gas-less kind, with the same client', async () => {
    const { deps, trySponsored } = makeDeps(null);
    const build = jest.fn();

    await signAndExecuteSponsoredFirst(session, client, { build }, sponsor, deps);

    const { buildKind } = (trySponsored.mock.calls[0] as unknown as [
      { buildKind: (txb: Transaction) => unknown },
    ])[0];
    const txb = new Transaction();
    await buildKind(txb);
    expect(build).toHaveBeenCalledWith(txb, client);
  });
});
