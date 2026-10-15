import { useCallback, useMemo } from 'react';
import {
  loadSignerSession,
  type ClientSignerResult,
  type ClientSignerSession,
  type SignTransactionInput,
} from '@/lib/zklogin-client-signer';
import {
  signAndExecuteSponsoredFirst,
  type SponsoredFirstResult,
  type SponsorRequest,
} from '@/lib/sponsored-first-signer';
import { getSigningSuiClient } from '@/services/sui-rpc-failover';

/**
 * React hook wrapper over the framework-agnostic client-side zkLogin
 * signer. Call `signAndExecute(build)` from a component to build, sign,
 * and submit a transaction without round-tripping the ephemeral private
 * key through the server. Returns `null` when the signer session has not
 * been populated (e.g. the OAuth callback hasn't run yet).
 *
 * Legacy server-signing flows in `src/pages/api/zkLogin.ts` continue to
 * work; this hook is the Phase 2 migration path for non-custodial UIs.
 */
export function useZkLoginSigner() {
  const session: ClientSignerSession | null = useMemo(() => loadSignerSession(), []);

  // Pooled per network, so there is nothing to memoise here.
  const getClient = useCallback((network: 'testnet' | 'mainnet') => getSigningSuiClient(network), []);

  const signAndExecute = useCallback(
    async (
      input: SignTransactionInput,
      overrides?: {
        network?: 'testnet' | 'mainnet';
        /**
         * Ask the circle's sponsor to pay the network fee first. Any decline
         * signs with the member's own gas instead (sponsored-first-signer.ts).
         */
        sponsor?: SponsorRequest;
      },
    ): Promise<SponsoredFirstResult> => {
      if (!session) {
        throw new Error(
          'No client-side zkLogin session. Sign in again so the OAuth callback can persist the ephemeral key.',
        );
      }
      const network = overrides?.network ?? session.network;
      const client = getClient(network);
      return signAndExecuteSponsoredFirst(session, client, input, overrides?.sponsor);
    },
    [session, getClient],
  );

  return {
    isReady: Boolean(session),
    userAddress: session?.userAddress ?? null,
    network: session?.network ?? null,
    signAndExecute,
  };
}

export type { ClientSignerResult, SignTransactionInput, SponsoredFirstResult, SponsorRequest };
