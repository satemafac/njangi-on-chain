import { AccountData } from './zkLoginService';
import type { OAuthProvider } from './zkLoginService';
import { Transaction } from '@mysten/sui/transactions';
import {
  buildBatchHeartbeatAdminLivenessTx,
  buildActivateCircleTx,
  buildAdminApproveMemberTx,
  buildAdminRemoveMemberTx,
  buildAdminSetMaxMembersTx,
  buildToggleAutoSwapTx,
  buildTriggerPayoutTx,
  buildAdminApproveMembersTx,
  buildClaimMembershipTx,
  buildDeleteCircleTx,
  buildReorderRotationPositionsTx,
  buildResumeCycleTx,
  buildSetRotationPositionTx,
  buildCreateCircleTx,
  buildExecuteRecoveryTx,
  buildHeartbeatAdminLivenessTx,
  buildProposeEmergencyStopTx,
  buildTriggerAutoReleaseTx,
  buildUpdateNextInCommandTx,
  buildVoteEmergencyStopTx,
  type CreateCircleTransactionData,
} from '@/lib/zklogin-tx-builders';
import { getCircleTransactionPackageId } from './circle-service';
import { getCurrentNetwork, getCurrentPackageId, getNetworkConfig } from './network-config';

/**
 * Non-React helper that returns a client-side signer wrapper when the
 * ephemeral-key session is present in the browser sessionStorage. Returns
 * null in SSR contexts or when the user hasn't signed in yet.
 *
 * `networkOverride` targets the RPC client at a specific chain when a caller
 * operates on a network other than the one recorded at login. The signing
 * session itself is unaffected — only which node the transaction is submitted
 * to changes.
 */
async function tryClientSideSigner(
  networkOverride?: NetworkOverride,
): Promise<
  | {
      signAndExecute: (
        input: import('@/lib/zklogin-client-signer').SignTransactionInput,
      ) => Promise<{ digest: string }>;
    }
  | null
> {
  if (typeof window === 'undefined') return null;
  try {
    const [{ SuiClient }, signerModule] = await Promise.all([
      import('@mysten/sui/client'),
      import('@/lib/zklogin-client-signer'),
    ]);
    const session = signerModule.loadSignerSession();
    if (!session) return null;
    const client = new SuiClient({
      url: getNetworkConfig(networkOverride ?? session.network).rpcUrl,
    });
    return {
      signAndExecute: async (input) => {
        const res = await signerModule.signAndExecuteWithZkLogin(
          session,
          client,
          input,
        );
        return { digest: res.digest };
      },
    };
  } catch (err) {
    console.warn('[zkLoginClient] client-side signer unavailable', err);
    return null;
  }
}

/**
 * Attempt the sponsored-gas path, returning null when it is unavailable.
 *
 * Sponsorship is a subsidy, never a precondition: every "no" here — disabled,
 * over caps, admin not premium, target not allowlisted, verification failed —
 * falls through to the caller paying their own gas. Bundled here so the
 * sponsored and self-paid paths share one builder and cannot drift.
 */
async function trySponsoredGas(args: {
  action: string;
  build: (txb: Transaction, client: import('@mysten/sui/client').SuiClient) => void | Promise<void>;
  network: NetworkOverride;
  context: Record<string, unknown>;
}): Promise<{ digest: string } | null> {
  if (typeof window === 'undefined') return null;
  try {
    const [{ SuiClient }, { trySponsoredExecute }] = await Promise.all([
      import('@mysten/sui/client'),
      import('@/lib/sponsored-tx-client'),
    ]);
    const client = new SuiClient({ url: getNetworkConfig(args.network).rpcUrl });
    return await trySponsoredExecute({
      action: args.action,
      buildKind: (txb) => args.build(txb, client),
      client,
      context: args.context,
    });
  } catch (err) {
    console.warn('[zkLoginClient] sponsored gas unavailable', err);
    return null;
  }
}

/**
 * Strip signing material before an account goes over the wire.
 *
 * The server identifies the caller from the `session-id` cookie and reads
 * everything it needs from its own session record — the posted `account` is
 * advisory. Sending the ephemeral private key with it served only the
 * now-removed `session.ephemeralPrivateKey === account.ephemeralPrivateKey`
 * comparison, while putting a live signing key into request bodies, and from
 * there into edge, WAF, and APM logs.
 */
/**
 * Build a transaction with the caller's builder and sign it locally.
 *
 * The shared spine for every action that used to POST to /api/zkLogin and be
 * signed with the server-held ephemeral key. Those began returning 409 once
 * sessions stopped carrying a server key, so each is moved here.
 *
 * `resolvePackageId` is a callback, and async, because a circle created under
 * an earlier package in the upgrade lineage must be addressed with THAT
 * package rather than the newest one.
 */
async function signLocallyWithBuilder(args: {
  account: AccountData;
  resolvePackageId: () => Promise<string> | string;
  build: (packageId: string) => Transaction;
  network?: NetworkOverride;
}): Promise<{ digest: string; requireRelogin?: boolean }> {
  if (!args.account?.zkProofs?.proofPoints) {
    throw new ZkLoginError('Missing authentication data. Please login again.', true);
  }

  const signer = await tryClientSideSigner(args.network);
  if (!signer) {
    throw new ZkLoginError(
      'Your signing session is unavailable. Please sign in again.',
      true,
    );
  }

  const packageId = await args.resolvePackageId();
  const { digest } = await signer.signAndExecute({ transaction: args.build(packageId) });
  return { digest };
}

function withoutSigningKey(account: AccountData): AccountData {
  const { ephemeralPrivateKey: _omitted, ...rest } = account;
  void _omitted;
  return rest as AccountData;
}

export interface EmberOperationLifecycle {
  status: string;
  partialCompletion: boolean;
  pendingRedemption: boolean;
  processing: string;
}

interface ZkLoginErrorMetadata {
  code?: string;
  stage?: string;
  operation?: string;
  lifecycle?: EmberOperationLifecycle;
}

// Custom error class for zkLogin errors that includes requireRelogin property
export class ZkLoginError extends Error {
  requireRelogin: boolean;
  code?: string;
  stage?: string;
  operation?: string;
  lifecycle?: EmberOperationLifecycle;
  
  constructor(
    message: string,
    requireRelogin: boolean = false,
    metadata: ZkLoginErrorMetadata = {}
  ) {
    super(message);
    this.requireRelogin = requireRelogin;
    this.name = 'ZkLoginError';
    this.code = metadata.code;
    this.stage = metadata.stage;
    this.operation = metadata.operation;
    this.lifecycle = metadata.lifecycle;
  }
}

interface ZkLoginResponse {
  error?: string;
  details?: string;
  code?: string;
  stage?: string;
  operation?: string;
  lifecycle?: EmberOperationLifecycle;
  requireRelogin?: boolean;
  digest?: string;
  status?: 'success' | 'failure';
  gasUsed?: {
    computationCost: string;
    storageCost: string;
    storageRebate: string;
  };
  [key: string]: unknown;
}

export interface CircleData extends CreateCircleTransactionData {
  name: string;
  contribution_amount: string | number;
  contribution_amount_local?: string | number;
  contribution_amount_usd?: string | number;
  currency_type?: string;
  security_deposit: string | number;
  security_deposit_local?: string | number;
  security_deposit_usd?: string | number;
  cycle_length: number;
  cycle_day: number;
  circle_type: number;
  max_members: number;
  rotation_style: number;
  penalty_rules: boolean[];
  goal_type?: { some?: number };
  target_amount?: { some?: string | number };
  target_amount_local?: { some?: string | number } | string | number;
  target_amount_usd?: string | number;
  target_date?: { some?: string | number };
  verification_required: boolean;
  auto_release_enabled?: boolean;
  auto_release_delay_ms?: string | number;
  next_in_command?: string | null;
}

type NetworkOverride = 'testnet' | 'mainnet';

export interface RecoveryActionRequest {
  circleId: string;
  network?: NetworkOverride;
}

export interface RecoveryExecutionRequest extends RecoveryActionRequest {
  walletId: string;
  stablecoinType: string;
}

export interface BatchHeartbeatAdminLivenessRequest {
  circleIds: string[];
  network?: NetworkOverride;
}

export interface UpdateNextInCommandRequest extends RecoveryActionRequest {
  nextInCommand?: string | null;
}

export type StablecoinTarget = 'USDC' | 'USDT' | 'SUI_USDE';
export type EmberSourceAsset = 'SUI' | 'USDC' | 'USDT' | 'SUI_USDE';

export interface EmberDeployRequest {
  circleId: string;
  walletId: string;
  sourceAsset: EmberSourceAsset;
  sourceAmount: string;
  targetCoinType: 'SUI_USDE';
  slippageBps?: number;
  emberVaultId?: string;
  emberVaultPackageId?: string;
  emberProtocolConfigId?: string;
}

export interface EmberRedeemRequest {
  circleId: string;
  walletId: string;
  receiptAmount: string;
  receiptCoinType?: string;
  emberVaultId?: string;
  emberVaultPackageId?: string;
  emberProtocolConfigId?: string;
  receiver?: string;
}

export interface EmberDeployResponse {
  operation: 'deployToEmberVault';
  digest: string;
  status: string;
  gasUsed?: {
    computationCost: string;
    storageCost: string;
    storageRebate: string;
  };
  circleId: string;
  walletId: string;
  network: string;
  sourceAsset: EmberSourceAsset;
  sourceCoinType: string;
  targetCoinType: 'SUI_USDE';
  sourceAmount: string;
  swapExecuted: boolean;
  estimatedSuiUsdeOut: string;
  slippageBps?: number;
  vaultId: string;
  vaultPackageId: string;
  protocolConfigId: string;
  receiptCoinType: string;
  lifecycle: EmberOperationLifecycle;
  requireRelogin?: boolean;
}

export interface EmberRedemptionResponse {
  operation: 'requestEmberRedemption';
  digest: string;
  status: string;
  gasUsed?: {
    computationCost: string;
    storageCost: string;
    storageRebate: string;
  };
  circleId: string;
  walletId: string;
  network: string;
  receiptAmount: string;
  receiptCoinType: string;
  vaultId: string;
  vaultPackageId: string;
  protocolConfigId: string;
  receiver: string;
  lifecycle: EmberOperationLifecycle;
  message: string;
  requireRelogin?: boolean;
}

export class ZkLoginClient {
  private static instance: ZkLoginClient;

  public static getInstance(): ZkLoginClient {
    if (!ZkLoginClient.instance) {
      ZkLoginClient.instance = new ZkLoginClient();
    }
    return ZkLoginClient.instance;
  }

  /**
   * Begin an OAuth login.
   *
   * The ephemeral keypair is minted here, in the browser. Only its public half
   * and the JWT randomness go to the server, which derives `maxEpoch` from the
   * chain and computes the nonce. The private key is held in sessionStorage
   * until the callback promotes it into a signer session, and is never
   * transmitted.
   *
   * Must run in the same browser context that will handle the OAuth redirect
   * back — sessionStorage is per-context. See `InAppBrowserModal`, which hands
   * off to `/login` in the external browser so this runs there rather than
   * stranding the key in a webview.
   */
  public async beginLogin(provider: OAuthProvider = 'Google'): Promise<{ loginUrl: string }> {
    if (typeof window === 'undefined') {
      throw new Error('beginLogin must run in the browser: it generates the ephemeral signing key.');
    }

    const network = getCurrentNetwork();
    const origin = window.location.origin;
    console.log('🌍 ZkLoginClient.beginLogin: Starting login on network:', network);

    const { createEphemeralKey, savePendingLogin } = await import('@/lib/zklogin-ephemeral-key');
    const fresh = createEphemeralKey();

    const response = await fetch('/api/zkLogin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'beginLogin',
        provider,
        network,
        origin,
        ephemeralPublicKey: fresh.ephemeralPublicKey,
        randomness: fresh.randomness,
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to begin login: ${errorText}`);
    }

    const data = await response.json();
    if (!data.loginUrl) {
      throw new Error('No login URL returned from server');
    }

    // Persist only after the server accepted the key, so a failed begin does
    // not leave a stale pending login behind.
    savePendingLogin({
      ephemeralPrivateKey: fresh.ephemeralPrivateKey,
      ephemeralPublicKey: fresh.ephemeralPublicKey,
      randomness: fresh.randomness,
      maxEpoch: typeof data.maxEpoch === 'number' ? data.maxEpoch : undefined,
      network,
      provider,
    });

    return data;
  }

  /**
   * Reunite the server's proof payload with the browser-held ephemeral key.
   *
   * On a v2 session the server never had the key, so the account it returns is
   * unsignable until this runs. Legacy v1 sessions still carry a key in the
   * response; those are left as-is and expire on their own.
   */
  private async attachLocalEphemeralKey(account: AccountData): Promise<AccountData> {
    if (account.ephemeralPrivateKey) return account;

    const { loadPendingLogin, clearPendingLogin } = await import('@/lib/zklogin-ephemeral-key');
    const pending = loadPendingLogin();

    if (!pending?.ephemeralPrivateKey) {
      throw new ZkLoginError(
        'Your sign-in could not be completed in this browser tab. Please start again from the same tab you began in.',
        true,
      );
    }

    clearPendingLogin();
    return { ...account, ephemeralPrivateKey: pending.ephemeralPrivateKey };
  }

  public async handleCallback(jwt: string): Promise<AccountData> {
    // Set up a retry mechanism with backoff
    let retries = 0;
    const maxRetries = 3;
    const baseBackoff = 1500; // 1.5 seconds base
    
    // Get the current network to pass to the backend
    const network = getCurrentNetwork();
    console.log('🌍 ZkLoginClient.handleCallback: Using network:', network);
    
    while (true) {
      try {
        const response = await fetch('/api/zkLogin', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'handleCallback', jwt, network })
        });
        
        // Handle processing status (202)
        if (response.status === 202) {
          const data = await response.json();
          
          // Only log on first retry
          if (retries === 0) {
            console.log('Authentication processing:', data.message);
          }
          
          retries++;
          
          // If we've tried too many times, throw an error
          if (retries > maxRetries) {
            throw new Error('Authentication is taking too long. Please try again.');
          }
          
          // Exponential backoff with jitter
          const jitter = Math.random() * 500;
          const backoff = baseBackoff * Math.pow(1.5, retries) + jitter;
          
          console.log(`Retry ${retries}/${maxRetries} after ${Math.round(backoff)}ms...`);
          await new Promise(resolve => setTimeout(resolve, backoff));
          continue; // Try again
        }
        
        // Handle other errors
        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(errorData.error || 'Failed to process authentication');
        }
        
        // Success. The server's response carries proofs, address and salt but
        // no signing key — it does not have one. Merge in the ephemeral key
        // this browser generated at beginLogin so the account is signable
        // locally.
        return this.attachLocalEphemeralKey(await response.json());
      } catch (err) {
        // If we've hit our retry limit or received a non-processing error, rethrow
        if (retries > maxRetries || !(err instanceof Error && err.message.includes('taking too long'))) {
          throw err;
        }
        
        // Otherwise, try again after backoff
        const backoff = baseBackoff * Math.pow(1.5, retries) + (Math.random() * 500);
        await new Promise(resolve => setTimeout(resolve, backoff));
        retries++;
      }
    }
  }

  // Removed: `sendTransaction`. The legacy server-signed circle-creation
  // action, with no remaining callers — `createCircle` above builds the
  // same transaction and signs it in the browser.

  private assertTransactionAccount(account: AccountData): void {
    if (!account.zkProofs?.proofPoints ||
        !account.zkProofs.issBase64Details ||
        !account.zkProofs.headerBase64) {
      throw new ZkLoginError(
        'Missing required authentication data. Please login again.',
        true,
      );
    }
  }

  /**
   * Signs and submits a caller-built transaction locally.
   *
   * This previously POSTed the serialized bytes to `/api/zkLogin`, where
   * the server deserialized them, overrode the sender, and signed with the
   * ephemeral key it held. That endpoint was an unconditional "sign
   * anything" oracle gated only by cookie possession, so it has been
   * removed (410). Every caller here already builds its transaction in the
   * browser, so signing locally is the natural home for this work.
   *
   * The name and signature are unchanged so the eight public callers below
   * are unaffected.
   */
  private async sendSerializedTransaction(
    account: AccountData,
    tx: Transaction,
    network?: NetworkOverride,
  ): Promise<{ digest: string; requireRelogin?: boolean }> {
    try {
      this.assertTransactionAccount(account);

      const signer = await tryClientSideSigner(network);
      if (!signer) {
        throw new ZkLoginError(
          'Your signing session is unavailable. Please sign in again.',
          true,
        );
      }

      const { digest } = await signer.signAndExecute({ transaction: tx });
      return { digest };
    } catch (error) {
      if (error instanceof ZkLoginError) {
        throw error;
      }

      throw new ZkLoginError(String(error), false);
    }
  }

  /**
   * Sign and submit transaction bytes that a builder already serialized
   * (Cetus swap routing builds and serializes in the browser). The signer
   * verifies the baked-in sender against the session address before
   * signing.
   */
  public async sendPrebuiltTransactionBytes(
    account: AccountData,
    bytes: Uint8Array,
    network?: NetworkOverride,
  ): Promise<{ digest: string; requireRelogin?: boolean }> {
    try {
      this.assertTransactionAccount(account);

      const signer = await tryClientSideSigner(network);
      if (!signer) {
        throw new ZkLoginError(
          'Your signing session is unavailable. Please sign in again.',
          true,
        );
      }

      const { digest } = await signer.signAndExecute({ bytes });
      return { digest };
    } catch (error) {
      if (error instanceof ZkLoginError) {
        throw error;
      }

      throw new ZkLoginError(String(error), false);
    }
  }

  public async createCircle(
    account: AccountData,
    circleData: CircleData,
    network?: NetworkOverride,
  ): Promise<{ digest: string; requireRelogin?: boolean }> {
    const tx = buildCreateCircleTx({
      packageId: getCurrentPackageId(),
      circleData,
    });

    return this.sendSerializedTransaction(account, tx, network);
  }

  public async proposeEmergencyStop(
    account: AccountData,
    request: RecoveryActionRequest,
  ): Promise<{ digest: string; requireRelogin?: boolean }> {
    const packageId = await getCircleTransactionPackageId(request.circleId, account.userAddr);
    const tx = buildProposeEmergencyStopTx({
      packageId,
      circleId: request.circleId,
    });

    return this.sendSerializedTransaction(account, tx, request.network);
  }

  public async voteEmergencyStop(
    account: AccountData,
    request: RecoveryActionRequest & { yesVote: boolean },
  ): Promise<{ digest: string; requireRelogin?: boolean }> {
    const packageId = await getCircleTransactionPackageId(request.circleId, account.userAddr);
    const tx = buildVoteEmergencyStopTx({
      packageId,
      circleId: request.circleId,
      yesVote: request.yesVote,
    });

    return this.sendSerializedTransaction(account, tx, request.network);
  }

  public async executeRecovery(
    account: AccountData,
    request: RecoveryExecutionRequest,
  ): Promise<{ digest: string; requireRelogin?: boolean }> {
    const packageId = await getCircleTransactionPackageId(request.circleId, account.userAddr);
    const tx = buildExecuteRecoveryTx({
      packageId,
      circleId: request.circleId,
      walletId: request.walletId,
      stablecoinType: request.stablecoinType,
    });

    return this.sendSerializedTransaction(account, tx, request.network);
  }

  public async triggerAutoRelease(
    account: AccountData,
    request: RecoveryExecutionRequest,
  ): Promise<{ digest: string; requireRelogin?: boolean }> {
    const packageId = await getCircleTransactionPackageId(request.circleId, account.userAddr);
    const tx = buildTriggerAutoReleaseTx({
      packageId,
      circleId: request.circleId,
      walletId: request.walletId,
      stablecoinType: request.stablecoinType,
    });

    return this.sendSerializedTransaction(account, tx, request.network);
  }

  public async heartbeatAdminLiveness(
    account: AccountData,
    request: RecoveryActionRequest,
  ): Promise<{ digest: string; requireRelogin?: boolean }> {
    const packageId = await getCircleTransactionPackageId(request.circleId, account.userAddr);
    const tx = buildHeartbeatAdminLivenessTx({
      packageId,
      circleId: request.circleId,
    });

    return this.sendSerializedTransaction(account, tx, request.network);
  }

  public async batchHeartbeatAdminLiveness(
    account: AccountData,
    request: BatchHeartbeatAdminLivenessRequest,
  ): Promise<{ digest: string; requireRelogin?: boolean }> {
    const uniqueCircleIds = [...new Set(
      request.circleIds
        .filter((circleId): circleId is string => typeof circleId === 'string')
        .map((circleId) => circleId.trim())
        .filter((circleId) => circleId.length > 0),
    )];

    if (uniqueCircleIds.length === 0) {
      throw new ZkLoginError('At least one circle ID is required.', false);
    }

    const circles = await Promise.all(uniqueCircleIds.map(async (circleId) => ({
      circleId,
      packageId: await getCircleTransactionPackageId(circleId, account.userAddr),
    })));
    const tx = buildBatchHeartbeatAdminLivenessTx({ circles });

    return this.sendSerializedTransaction(account, tx, request.network);
  }

  public async updateNextInCommand(
    account: AccountData,
    request: UpdateNextInCommandRequest,
  ): Promise<{ digest: string; requireRelogin?: boolean }> {
    const packageId = await getCircleTransactionPackageId(request.circleId, account.userAddr);
    const tx = buildUpdateNextInCommandTx({
      packageId,
      circleId: request.circleId,
      nextInCommand: request.nextInCommand ?? null,
    });

    return this.sendSerializedTransaction(account, tx, request.network);
  }

  public async deleteCircle(
    account: AccountData,
    circleId: string,
    walletId?: string,
  ): Promise<{ digest: string; requireRelogin?: boolean }> {
    if (!walletId) {
      throw new ZkLoginError(
        'A custody wallet id is required to delete a circle.',
        false,
      );
    }
    return signLocallyWithBuilder({
      account,
      resolvePackageId: () => getCircleTransactionPackageId(circleId, account.userAddr),
      build: (packageId) => buildDeleteCircleTx({ packageId, circleId, walletId }),
    });
  }

  public async activateCircle(
    account: AccountData,
    circleId: string,
  ): Promise<{ digest: string; requireRelogin?: boolean }> {
    return signLocallyWithBuilder({
      account,
      resolvePackageId: () => getCircleTransactionPackageId(circleId, account.userAddr),
      build: (packageId) => buildActivateCircleTx({ packageId, circleId }),
    });
  }

  /**
   * Pay a member's security deposit — the transaction that joins a circle.
   *
   * Signed in the browser like everything else. The deposit AMOUNT is read
   * from the circle's on-chain config inside the builder rather than taken
   * from the caller, so a stale figure in the UI cannot under-pay.
   *
   * Tries sponsored gas first: this is the first action a brand-new member
   * takes and they may hold no SUI at all. A declined sponsorship falls
   * through to self-paid rather than blocking the join.
   */
  public async paySecurityDeposit(
    account: AccountData,
    circleId: string,
    walletId: string,
    opts: {
      currency: 'USDC' | 'SUI';
      usdcCoinType: string;
      suiCoinType: string;
      fallbackSuiAmount?: bigint;
      network?: NetworkOverride;
    },
  ): Promise<{ digest: string; requireRelogin?: boolean }> {
    if (!account?.zkProofs?.proofPoints) {
      throw new ZkLoginError('Missing authentication data. Please login again.', true);
    }

    const signer = await tryClientSideSigner(opts.network);
    if (!signer) {
      throw new ZkLoginError(
        'Your signing session is unavailable. Please sign in again.',
        true,
      );
    }

    const packageId = await getCircleTransactionPackageId(circleId, account.userAddr);
    const { buildSecurityDepositTx } = await import('@/lib/security-deposit-tx');

    const build = (
      txb: Transaction,
      client: import('@mysten/sui/client').SuiClient,
    ) =>
      buildSecurityDepositTx(txb, client, {
        packageId,
        circleId,
        walletId,
        userAddress: account.userAddr,
        currency: opts.currency,
        usdcCoinType: opts.usdcCoinType,
        suiCoinType: opts.suiCoinType,
        fallbackSuiAmount: opts.fallbackSuiAmount,
      });

    const sponsored = await trySponsoredGas({
      action: 'paySecurityDeposit',
      build,
      network: opts.network ?? getCurrentNetwork(),
      context: {
        circleId,
        coinType: opts.currency === 'USDC' ? opts.usdcCoinType : opts.suiCoinType,
        // The USDC path splits from an owned coin; the SUI path splits from
        // txb.gas, which draws the sponsor's coin for value and must not be
        // sponsored.
        usesGasCoinForValue: opts.currency === 'SUI',
      },
    });
    if (sponsored) return { digest: sponsored.digest };

    const { digest } = await signer.signAndExecute({ build, gasBudget: 120_000_000 });
    return { digest };
  }

  // Removed: `configureStablecoinSwap`. No component reached it — the only
  // caller was cetus-service, which nothing calls either. Left as a
  // server-signed action it was a live signing path serving dead code.

  public async deployToEmberVault(
    account: AccountData,
    payload: EmberDeployRequest
  ): Promise<EmberDeployResponse> {
    try {
      const response = await fetch('/api/zkLogin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'deployToEmberVault',
          account: withoutSigningKey(account),
          payload
        })
      });

      const responseData = await response.json() as EmberDeployResponse & ZkLoginResponse;
      if (response.status === 401) {
        throw new ZkLoginError(
          `Authentication error: ${responseData.error || 'Session expired'}. Please login again.`,
          true,
          {
            code: responseData.code,
            stage: responseData.stage,
            operation: responseData.operation,
            lifecycle: responseData.lifecycle
          }
        );
      }
      if (!response.ok) {
        throw new ZkLoginError(
          responseData.error || 'Failed to deploy to Ember vault',
          !!responseData.requireRelogin,
          {
            code: responseData.code,
            stage: responseData.stage,
            operation: responseData.operation,
            lifecycle: responseData.lifecycle
          }
        );
      }
      if (!responseData.digest) {
        throw new ZkLoginError('No transaction digest received from server', false);
      }
      return {
        ...responseData,
        requireRelogin: responseData.requireRelogin
      };
    } catch (error) {
      if (error instanceof ZkLoginError) {
        throw error;
      }
      throw new ZkLoginError(String(error), false);
    }
  }

  public async requestEmberRedemption(
    account: AccountData,
    payload: EmberRedeemRequest
  ): Promise<EmberRedemptionResponse> {
    try {
      const response = await fetch('/api/zkLogin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'requestEmberRedemption',
          account: withoutSigningKey(account),
          payload
        })
      });

      const responseData = await response.json() as EmberRedemptionResponse & ZkLoginResponse;
      if (response.status === 401) {
        throw new ZkLoginError(
          `Authentication error: ${responseData.error || 'Session expired'}. Please login again.`,
          true,
          {
            code: responseData.code,
            stage: responseData.stage,
            operation: responseData.operation,
            lifecycle: responseData.lifecycle
          }
        );
      }
      if (!response.ok) {
        throw new ZkLoginError(
          responseData.error || 'Failed to request Ember redemption',
          !!responseData.requireRelogin,
          {
            code: responseData.code,
            stage: responseData.stage,
            operation: responseData.operation,
            lifecycle: responseData.lifecycle
          }
        );
      }
      if (!responseData.digest) {
        throw new ZkLoginError('No transaction digest received from server', false);
      }
      return {
        ...responseData,
        requireRelogin: responseData.requireRelogin
      };
    } catch (error) {
      if (error instanceof ZkLoginError) {
        throw error;
      }
      throw new ZkLoginError(String(error), false);
    }
  }

  public async setRotationPosition(
    account: AccountData,
    circleId: string,
    memberAddress: string,
    position: number,
  ): Promise<{ digest: string; requireRelogin?: boolean }> {
    return signLocallyWithBuilder({
      account,
      resolvePackageId: () => getCircleTransactionPackageId(circleId, account.userAddr),
      build: (packageId) =>
        buildSetRotationPositionTx({ packageId, circleId, memberAddress, position }),
    });
  }

  public async reorderRotationPositions(
    account: AccountData,
    circleId: string,
    newOrder: string[],
    network?: NetworkOverride,
  ): Promise<{ digest: string; requireRelogin?: boolean }> {
    return signLocallyWithBuilder({
      account,
      network,
      resolvePackageId: () => getCircleTransactionPackageId(circleId, account.userAddr),
      build: (packageId) =>
        buildReorderRotationPositionsTx({ packageId, circleId, newOrder }),
    });
  }

  public async adminApproveMember(
    account: AccountData,
    circleId: string,
    memberAddress: string,
  ): Promise<{ digest: string; requireRelogin?: boolean }> {
    return signLocallyWithBuilder({
      account,
      resolvePackageId: () => getCircleTransactionPackageId(circleId, account.userAddr),
      build: (packageId) =>
        buildAdminApproveMemberTx({ packageId, circleId, memberAddress }),
    });
  }

  public async adminRemoveMember(
    account: AccountData,
    circleId: string,
    memberAddress: string,
    walletId: string,
  ): Promise<{ digest: string; requireRelogin?: boolean }> {
    return signLocallyWithBuilder({
      account,
      resolvePackageId: () => getCircleTransactionPackageId(circleId, account.userAddr),
      build: (packageId) =>
        buildAdminRemoveMemberTx({ packageId, circleId, memberAddress, walletId }),
    });
  }

  public async adminSetMaxMembers(
    account: AccountData,
    circleId: string,
    newMaxMembers: number,
  ): Promise<{ digest: string; requireRelogin?: boolean }> {
    return signLocallyWithBuilder({
      account,
      resolvePackageId: () => getCircleTransactionPackageId(circleId, account.userAddr),
      build: (packageId) =>
        buildAdminSetMaxMembersTx({ packageId, circleId, newMaxMembers }),
    });
  }

  public async toggleAutoSwap(
    account: AccountData,
    circleId: string,
    enabled: boolean,
  ): Promise<{ digest: string; requireRelogin?: boolean }> {
    return signLocallyWithBuilder({
      account,
      resolvePackageId: () => getCircleTransactionPackageId(circleId, account.userAddr),
      build: (packageId) => buildToggleAutoSwapTx({ packageId, circleId, enabled }),
    });
  }

  public async adminApproveMembers(
    account: AccountData,
    circleId: string,
    memberAddresses: string[],
  ): Promise<{ digest: string; requireRelogin?: boolean }> {
    return signLocallyWithBuilder({
      account,
      resolvePackageId: () => getCircleTransactionPackageId(circleId, account.userAddr),
      build: (packageId) =>
        buildAdminApproveMembersTx({ packageId, circleId, memberAddresses }),
    });
  }

  /**
   * Release a legacy-rail payout to the scheduled recipient.
   *
   * Permissionless on chain — the recipient comes from the circle's rotation,
   * not the caller — so anyone can pay the gas to settle a cycle. Kept
   * reachable on purpose: the legacy kill switch blocks new contributions but
   * must never block getting committed funds out.
   */
  async adminTriggerPayout(
    account: AccountData,
    circleId: string,
    walletId: string,
    coinType: string,
    network?: NetworkOverride,
  ): Promise<{ digest: string; requireRelogin?: boolean }> {
    return signLocallyWithBuilder({
      account,
      network,
      resolvePackageId: () => getCircleTransactionPackageId(circleId, account.userAddr),
      build: (packageId) =>
        buildTriggerPayoutTx({ packageId, circleId, walletId, coinType }),
    });
  }

  async resumeCycle(
    account: AccountData,
    circleId: string,
  ): Promise<{ digest: string; requireRelogin?: boolean }> {
    return signLocallyWithBuilder({
      account,
      resolvePackageId: () => getCircleTransactionPackageId(circleId, account.userAddr),
      build: (packageId) => buildResumeCycleTx({ packageId, circleId }),
    });
  }

  async openCycleEscrow(
    account: AccountData,
    circleId: string,
    coinType: string,
    network: 'testnet' | 'mainnet' = 'testnet',
  ): Promise<{ digest: string; requireRelogin?: boolean }> {
    const client = await tryClientSideSigner();
    if (client) {
      const { buildOpenCycleTx } = await import('./cycle-escrow-service');
      const build = buildOpenCycleTx({ network, circleId, coinType });
      const res = await client.signAndExecute({ build, gasBudget: 80_000_000 });
      return { digest: res.digest };
    }
    return this.postCycleEscrowAction('openCycleEscrow', account, { circleId, coinType });
  }

  async contributeToCycleEscrow(
    account: AccountData,
    escrowId: string,
    paymentCoinId: string,
    coinType: string,
    network: 'testnet' | 'mainnet' = 'testnet',
  ): Promise<{ digest: string; requireRelogin?: boolean }> {
    const client = await tryClientSideSigner();
    if (client) {
      const { buildContributeTx } = await import('./cycle-escrow-service');
      const build = buildContributeTx({ network, escrowId, paymentCoinId, coinType });

      // Try sponsored gas first (Premium admin benefit). Declining is normal
      // and silent — the member pays their own gas rather than being blocked.
      const sponsored = await trySponsoredGas({
        action: 'contributeToCycleEscrow',
        build,
        network,
        context: { escrowId, coinType, usesGasCoinForValue: false },
      });
      if (sponsored) return { digest: sponsored.digest };

      const res = await client.signAndExecute({ build, gasBudget: 100_000_000 });
      return { digest: res.digest };
    }
    return this.postCycleEscrowAction('contributeToCycleEscrow', account, {
      escrowId,
      paymentCoinId,
      coinType,
    });
  }

  /**
   * Mint the caller's missing membership receipts so their circles stay
   * discoverable without an event scan.
   *
   * Signed client-side and batched into one transaction. Aborts on-chain
   * (ENotMember) for any circle the caller isn't actually a member of, so this
   * cannot be used to fabricate membership.
   */
  async claimMembership(
    account: AccountData,
    circles: Array<{ packageId: string; circleId: string }>,
  ): Promise<{ digest: string; claimed: number }> {
    this.assertTransactionAccount(account);
    if (circles.length === 0) {
      throw new ZkLoginError('No circles to restore.', false);
    }

    const signer = await tryClientSideSigner();
    if (!signer) {
      throw new ZkLoginError(
        'Your signing session is unavailable. Please sign in again.',
        true,
      );
    }

    const tx = buildClaimMembershipTx({ circles });
    const { digest } = await signer.signAndExecute({ transaction: tx });
    return { digest, claimed: circles.length };
  }

  async finalizeAndRedeemCycleEscrow(
    account: AccountData,
    escrowId: string,
    coinType: string,
    network: 'testnet' | 'mainnet' = 'testnet',
  ): Promise<{ digest: string; requireRelogin?: boolean }> {
    const client = await tryClientSideSigner();
    if (client) {
      const { buildFinalizeAndRedeemTx } = await import('./cycle-escrow-service');
      const build = buildFinalizeAndRedeemTx({ network, escrowId, coinType });
      const res = await client.signAndExecute({ build, gasBudget: 120_000_000 });
      return { digest: res.digest };
    }
    return this.postCycleEscrowAction('finalizeAndRedeemCycleEscrow', account, {
      escrowId,
      coinType,
    });
  }

  private async postCycleEscrowAction(
    action:
      | 'openCycleEscrow'
      | 'contributeToCycleEscrow'
      | 'finalizeAndRedeemCycleEscrow',
    account: AccountData,
    payload: Record<string, string>,
  ): Promise<{ digest: string; requireRelogin?: boolean }> {
    const response = await fetch('/api/zkLogin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // withoutSigningKey, not `account` — the Phase 1 sweep that stripped
      // the ephemeral key from request bodies matched on a literal `account:`
      // key and missed this shorthand, so this path kept posting the live
      // signing key. Caught by the source-level invariant in
      // zklogin-login-protocol.test.ts.
      body: JSON.stringify({ action, account: withoutSigningKey(account), ...payload }),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new ZkLoginError(
        data.error || `Failed to execute ${action}`,
        !!data.requireRelogin,
      );
    }
    if (!data.digest) {
      throw new ZkLoginError(`No digest returned from ${action}`, false);
    }
    return { digest: data.digest, requireRelogin: data.requireRelogin };
  }

} 
