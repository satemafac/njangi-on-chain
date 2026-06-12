import { useCallback, useMemo, useRef } from 'react';
import { SuiClient } from '@mysten/sui/client';
import {
  loadSignerSession,
  signAndExecuteWithZkLogin,
  type ClientSignerResult,
  type ClientSignerSession,
  type SignTransactionInput,
} from '@/lib/zklogin-client-signer';
import { getCurrentRpcUrl, getNetworkConfig } from '@/services/network-config';

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
  const clientRef = useRef<SuiClient | null>(null);
  const clientNetworkRef = useRef<'testnet' | 'mainnet' | null>(null);

  const session: ClientSignerSession | null = useMemo(() => loadSignerSession(), []);

  const getClient = useCallback((network: 'testnet' | 'mainnet') => {
    if (!clientRef.current || clientNetworkRef.current !== network) {
      const url = network ? getNetworkConfig(network).rpcUrl : getCurrentRpcUrl();
      clientRef.current = new SuiClient({ url });
      clientNetworkRef.current = network;
    }
    return clientRef.current;
  }, []);

  const signAndExecute = useCallback(
    async (
      input: SignTransactionInput,
      overrides?: { network?: 'testnet' | 'mainnet' },
    ): Promise<ClientSignerResult> => {
      if (!session) {
        throw new Error(
          'No client-side zkLogin session. Sign in again so the OAuth callback can persist the ephemeral key.',
        );
      }
      const network = overrides?.network ?? session.network;
      const client = getClient(network);
      return signAndExecuteWithZkLogin(session, client, input);
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

export type { ClientSignerResult, SignTransactionInput };
