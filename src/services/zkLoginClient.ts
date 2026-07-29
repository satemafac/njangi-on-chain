import { AccountData } from './zkLoginService';
import type { OAuthProvider } from './zkLoginService';
import { Transaction } from '@mysten/sui/transactions';
import {
  buildBatchHeartbeatAdminLivenessTx,
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

  public async beginLogin(provider: OAuthProvider = 'Google'): Promise<{ loginUrl: string }> {
    const network = getCurrentNetwork();
    const origin = typeof window !== 'undefined' ? window.location.origin : undefined;
    console.log('🌍 ZkLoginClient.beginLogin: Starting login on network:', network);

    const response = await fetch('/api/zkLogin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'beginLogin', provider, network, origin })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to begin login: ${errorText}`);
    }

    const data = await response.json();
    if (!data.loginUrl) {
      throw new Error('No login URL returned from server');
    }

    return data;
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
        
        // Success - return the account data
        return response.json();
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

  public async sendTransaction(account: AccountData, circleData: CircleData): Promise<{ digest: string; requireRelogin?: boolean }> {
    try {
      // Log key information for debugging
      console.log('Sending transaction with account:', {
        address: account.userAddr,
        hasProofPoints: !!account.zkProofs?.proofPoints,
        hasIssBase64Details: !!account.zkProofs?.issBase64Details,
        hasHeaderBase64: !!account.zkProofs?.headerBase64,
        maxEpoch: account.maxEpoch
      });

      const response = await fetch('/api/zkLogin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          action: 'sendTransaction', 
          account,
          circleData
        })
      });
      
      const responseData: ZkLoginResponse = await response.json();
      
      // Handle authentication errors (401)
      if (response.status === 401) {
        console.error('Authentication error:', responseData);
        throw new ZkLoginError(
          `Authentication error: ${responseData.error || 'Session expired'}. Please login again.`, 
          true
        );
      }
      
      // Handle server errors (500)
      if (!response.ok) {
        console.error('Transaction failed:', responseData);
        throw new ZkLoginError(
          responseData.error || 'Transaction failed', 
          !!responseData.requireRelogin
        );
      }
      
      // Even for successful response, check if we have a digest
      if (!responseData.digest) {
        throw new ZkLoginError('No transaction digest received from server', false);
      }
      
      console.log('Transaction succeeded:', responseData);
      return {
        digest: responseData.digest,
        requireRelogin: responseData.requireRelogin
      };
    } catch (error) {
      console.error('Transaction error in client:', error);
      // Rethrow ZkLoginError as is
      if (error instanceof ZkLoginError) {
        throw error;
      }
      // Otherwise wrap in a new error
      throw new ZkLoginError(String(error), false);
    }
  }

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

  public async deleteCircle(account: AccountData, circleId: string): Promise<{ digest: string; requireRelogin?: boolean }> {
    try {
      // Log key information for debugging
      console.log('ZkLoginClient: Deleting circle with account:', {
        address: account.userAddr,
        circleId: circleId,
        hasProofPoints: !!account.zkProofs?.proofPoints,
        hasIssBase64Details: !!account.zkProofs?.issBase64Details,
        hasHeaderBase64: !!account.zkProofs?.headerBase64,
        maxEpoch: account.maxEpoch
      });

      // Verify the account has valid proof data
      if (!account.zkProofs?.proofPoints || 
          !account.zkProofs.issBase64Details || 
          !account.zkProofs.headerBase64) {
        throw new ZkLoginError(
          'Missing required authentication data. Please login again.',
          true
        );
      }

      const response = await fetch('/api/zkLogin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          action: 'deleteCircle', 
          account,
          circleId
        })
      });
      
      // Try to parse the response even if status is not OK
      let responseData;
      try {
        responseData = await response.json();
        console.log('ZkLoginClient: Circle deletion response:', 
          response.status, response.statusText, responseData);
      } catch (parseError) {
        console.error('Failed to parse response:', parseError);
        throw new ZkLoginError(`Failed to parse server response: ${response.statusText}`, false);
      }
      
      // Handle authentication errors (401)
      if (response.status === 401) {
        console.error('Authentication error:', responseData);
        throw new ZkLoginError(
          `Authentication error: ${responseData.error || 'Session expired'}. Please login again.`, 
          true
        );
      }
      
      // Handle server errors (500)
      if (!response.ok) {
        console.error('Circle deletion failed:', responseData);
        
        // Check for specific contract errors
        const errorMsg = responseData.error || 'Circle deletion failed';
        
        if (errorMsg.includes('ECircleHasActiveMembers') || 
            errorMsg.includes('ECircleHasContributions') ||
            errorMsg.includes('EOnlyCircleAdmin')) {
          // These are expected contract error conditions, not authentication errors
          throw new ZkLoginError(errorMsg, false);
        }
        
        throw new ZkLoginError(
          errorMsg, 
          !!responseData.requireRelogin
        );
      }
      
      // Even for successful response, check if we have a digest
      if (!responseData.digest) {
        throw new ZkLoginError('No transaction digest received from server', false);
      }
      
      console.log('ZkLoginClient: Circle deletion succeeded:', responseData);
      return {
        digest: responseData.digest,
        requireRelogin: responseData.requireRelogin
      };
    } catch (error) {
      console.error('ZkLoginClient: Circle deletion error:', error);
      
      // Rethrow ZkLoginError as is
      if (error instanceof ZkLoginError) {
        throw error;
      }
      
      // Otherwise wrap in a new error
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('ZkLoginClient: Non-ZkLoginError occurred:', errorMessage);
      throw new ZkLoginError(errorMessage, false);
    }
  }

  public async activateCircle(account: AccountData, circleId: string): Promise<{ digest: string; requireRelogin?: boolean }> {
    try {
      // Log key information for debugging
      console.log('ZkLoginClient: Activating circle with account:', {
        address: account.userAddr,
        circleId: circleId,
        hasProofPoints: !!account.zkProofs?.proofPoints,
        hasIssBase64Details: !!account.zkProofs?.issBase64Details,
        hasHeaderBase64: !!account.zkProofs?.headerBase64,
        maxEpoch: account.maxEpoch
      });

      // Verify the account has valid proof data
      if (!account.zkProofs?.proofPoints || 
          !account.zkProofs.issBase64Details || 
          !account.zkProofs.headerBase64) {
        throw new ZkLoginError(
          'Missing required authentication data. Please login again.',
          true
        );
      }

      const response = await fetch('/api/zkLogin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          action: 'activateCircle', 
          account,
          circleId
        })
      });
      
      // Try to parse the response even if status is not OK
      let responseData;
      try {
        responseData = await response.json();
        console.log('ZkLoginClient: Circle activation response:', 
          response.status, response.statusText, responseData);
      } catch (parseError) {
        console.error('Failed to parse response:', parseError);
        throw new ZkLoginError(`Failed to parse server response: ${response.statusText}`, false);
      }
      
      // Handle authentication errors (401)
      if (response.status === 401) {
        console.error('Authentication error:', responseData);
        throw new ZkLoginError(
          `Authentication error: ${responseData.error || 'Session expired'}. Please login again.`, 
          true
        );
      }
      
      // Handle server errors (500)
      if (!response.ok) {
        console.error('Circle activation failed:', responseData);
        throw new ZkLoginError(
          responseData.error || 'Circle activation failed', 
          !!responseData.requireRelogin
        );
      }
      
      // Even for successful response, check if we have a digest
      if (!responseData.digest) {
        throw new ZkLoginError('No transaction digest received from server', false);
      }
      
      console.log('Circle activation succeeded:', responseData);
      return {
        digest: responseData.digest,
        requireRelogin: responseData.requireRelogin
      };
    } catch (error) {
      console.error('Circle activation error in client:', error);
      // Rethrow ZkLoginError as is
      if (error instanceof ZkLoginError) {
        throw error;
      }
      // Otherwise wrap in a new error
      throw new ZkLoginError(String(error), false);
    }
  }

  public async paySecurityDeposit(account: AccountData, walletId: string, depositAmount: number): Promise<{ digest: string; requireRelogin?: boolean }> {
    try {
      // Log key information for debugging
      console.log('ZkLoginClient: Paying security deposit with account:', {
        address: account.userAddr,
        walletId: walletId,
        depositAmount: depositAmount,
        hasProofPoints: !!account.zkProofs?.proofPoints,
        hasIssBase64Details: !!account.zkProofs?.issBase64Details,
        hasHeaderBase64: !!account.zkProofs?.headerBase64,
        maxEpoch: account.maxEpoch
      });

      // Verify the account has valid proof data
      if (!account.zkProofs?.proofPoints || 
          !account.zkProofs.issBase64Details || 
          !account.zkProofs.headerBase64) {
        throw new ZkLoginError(
          'Missing required authentication data. Please login again.',
          true
        );
      }

      const response = await fetch('/api/zkLogin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          action: 'paySecurityDeposit',
          account,
          walletId,
          depositAmount
        })
      });
      
      // Try to parse the response even if status is not OK
      let responseData;
      try {
        responseData = await response.json();
        console.log('ZkLoginClient: Security deposit payment response:', 
          response.status, response.statusText, responseData);
      } catch (parseError) {
        console.error('Failed to parse response:', parseError);
        throw new ZkLoginError(`Failed to parse server response: ${response.statusText}`, false);
      }
      
      // Handle authentication errors (401)
      if (response.status === 401) {
        console.error('Authentication error:', responseData);
        throw new ZkLoginError(
          `Authentication error: ${responseData.error || 'Session expired'}. Please login again.`, 
          true
        );
      }
      
      // Handle server errors (500)
      if (!response.ok) {
        console.error('Security deposit payment failed:', responseData);
        throw new ZkLoginError(
          responseData.error || 'Security deposit payment failed', 
          !!responseData.requireRelogin
        );
      }
      
      // Even for successful response, check if we have a digest
      if (!responseData.digest) {
        throw new ZkLoginError('No transaction digest received from server', false);
      }
      
      console.log('Security deposit payment succeeded:', responseData);
      return {
        digest: responseData.digest,
        requireRelogin: responseData.requireRelogin
      };
    } catch (error) {
      console.error('Security deposit payment error in client:', error);
      // Rethrow ZkLoginError as is
      if (error instanceof ZkLoginError) {
        throw error;
      }
      // Otherwise wrap in a new error
      throw new ZkLoginError(String(error), false);
    }
  }

  /**
   * Configure stablecoin swap settings for a custody wallet
   * @param account ZkLogin account data
   * @param walletId The custody wallet ID
   * @param config Configuration settings for stablecoin swaps
   */
  public async configureStablecoinSwap(
    account: AccountData, 
    walletId: string,
    config: {
      enabled: boolean;
      targetCoinType: StablecoinTarget;
      slippageTolerance: number; 
      minimumSwapAmount: number;
    }
  ): Promise<{ digest: string; requireRelogin?: boolean }> {
    try {
      console.log('Configuring stablecoin swap with account:', {
        address: account.userAddr,
        walletId,
        config
      });
      
      const response = await fetch('/api/zkLogin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'configureStablecoinSwap',
          account,
          walletId,
          config
        })
      });
      
      const responseData: ZkLoginResponse = await response.json();
      
      // Handle authentication errors
      if (response.status === 401) {
        console.error('Authentication error:', responseData);
        throw new ZkLoginError(
          `Authentication error: ${responseData.error || 'Session expired'}. Please login again.`,
          true
        );
      }
      
      // Handle server errors
      if (!response.ok) {
        console.error('Stablecoin configuration failed:', responseData);
        throw new ZkLoginError(
          responseData.error || 'Stablecoin configuration failed',
          !!responseData.requireRelogin
        );
      }
      
      // Check digest
      if (!responseData.digest) {
        throw new ZkLoginError('No transaction digest received from server', false);
      }
      
      console.log('Stablecoin configuration succeeded:', responseData);
      return {
        digest: responseData.digest,
        requireRelogin: responseData.requireRelogin
      };
    } catch (error) {
      console.error('Stablecoin configuration error:', error);
      if (error instanceof ZkLoginError) {
        throw error;
      }
      throw new ZkLoginError(String(error), false);
    }
  }

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
          account,
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
          account,
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
    position: number
  ): Promise<{ digest: string; requireRelogin?: boolean }> {
    try {
      // Ensure address is in the correct format for the smart contract
      // First, strip any leading 0x if present
      const cleanAddress = memberAddress.toLowerCase().replace(/^0x/, '');
      // Then ensure it has 0x prefix for the API call
      const normalizedMemberAddress = `0x${cleanAddress}`;
      
      // Log key information for debugging
      console.log('Setting rotation position with:', {
        sender: account.userAddr,
        circleId,
        rawMemberAddress: memberAddress,
        normalizedMemberAddress,
        position,
        hasProofPoints: !!account.zkProofs?.proofPoints,
        hasIssBase64Details: !!account.zkProofs?.issBase64Details,
        hasHeaderBase64: !!account.zkProofs?.headerBase64,
        maxEpoch: account.maxEpoch
      });

      // Verify the account has valid proof data
      if (!account.zkProofs?.proofPoints || 
          !account.zkProofs.issBase64Details || 
          !account.zkProofs.headerBase64) {
        throw new ZkLoginError(
          'Missing required authentication data. Please login again.',
          true
        );
      }

      const response = await fetch('/api/zkLogin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          action: 'setRotationPosition', 
          account,
          circleId,
          memberAddress: normalizedMemberAddress,
          position
        })
      });
      
      // Try to parse the response even if status is not OK
      let responseData;
      try {
        responseData = await response.json();
        console.log('ZkLoginClient: Set rotation position response:', 
          response.status, response.statusText, responseData);
      } catch (parseError) {
        console.error('Failed to parse response:', parseError);
        throw new ZkLoginError(`Failed to parse server response: ${response.statusText}`, false);
      }
      
      // Handle authentication errors (401)
      if (response.status === 401) {
        console.error('Authentication error:', responseData);
        throw new ZkLoginError(
          `Authentication error: ${responseData.error || 'Session expired'}. Please login again.`, 
          true
        );
      }
      
      // Handle server errors (500)
      if (!response.ok) {
        console.error('Set rotation position failed:', responseData);
        
        // Check if this is a business logic error (HTTP 400)
        if (response.status === 400 && responseData.error) {
          throw new Error(responseData.error);
        }
        
        throw new ZkLoginError(
          responseData.error || 'Failed to set rotation position', 
          !!responseData.requireRelogin
        );
      }
      
      // Even for successful response, check if we have a digest
      if (!responseData.digest) {
        throw new ZkLoginError('No transaction digest received from server', false);
      }
      
      console.log('Set rotation position succeeded:', responseData);
      return {
        digest: responseData.digest,
        requireRelogin: responseData.requireRelogin
      };
    } catch (error) {
      console.error('Set rotation position error in client:', error);
      // Rethrow ZkLoginError as is
      if (error instanceof ZkLoginError) {
        throw error;
      }
      // Otherwise wrap in a new error
      throw new ZkLoginError(String(error), false);
    }
  }

  /**
   * Reorder all rotation positions in one transaction
   * @param account ZkLogin account data
   * @param circleId The circle ID
   * @param newOrder Array of member addresses in the desired order
   * @param network Optional network override (testnet/mainnet)
   */
  public async reorderRotationPositions(
    account: AccountData, 
    circleId: string,
    newOrder: string[],
    network?: 'testnet' | 'mainnet'
  ): Promise<{ digest: string; requireRelogin?: boolean }> {
    try {
      // Log key information for debugging
      console.log('ZkLoginClient: Reordering rotation positions with account:', {
        address: account.userAddr,
        circleId,
        newOrderLength: newOrder.length,
        hasProofPoints: !!account.zkProofs?.proofPoints,
        hasHeaderBase64: !!account.zkProofs?.headerBase64,
        maxEpoch: account.maxEpoch,
        network
      });

      // Verify the account has valid proof data
      if (!account.zkProofs?.proofPoints || 
          !account.zkProofs.issBase64Details || 
          !account.zkProofs.headerBase64) {
        throw new ZkLoginError(
          'Missing required authentication data. Please login again.',
          true
        );
      }

      const response = await fetch('/api/zkLogin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          action: 'reorderRotationPositions', 
          account,
          circleId,
          newOrder,
          network // Include network parameter for correct chain targeting
        })
      });
      
      // Try to parse the response even if status is not OK
      let responseData;
      try {
        responseData = await response.json();
      } catch (parseError) {
        console.error('Failed to parse response:', parseError);
        throw new ZkLoginError(`Failed to parse server response: ${response.statusText}`, false);
      }
      
      // Handle authentication errors (401)
      if (response.status === 401) {
        console.error('Authentication error:', responseData);
        throw new ZkLoginError(
          `Authentication error: ${responseData.error || 'Session expired'}. Please login again.`, 
          true
        );
      }
      
      // Handle server errors (500)
      if (!response.ok) {
        console.error('Transaction failed:', responseData);
        throw new ZkLoginError(
          responseData.error || 'Transaction failed', 
          !!responseData.requireRelogin
        );
      }
      
      // Even for successful response, check if we have a digest
      if (!responseData.digest) {
        throw new ZkLoginError('No transaction digest received from server', false);
      }
      
      console.log('Reorder rotation positions succeeded:', responseData);
      return {
        digest: responseData.digest,
        requireRelogin: responseData.requireRelogin
      };
    } catch (error) {
      console.error('Reorder rotation positions error in client:', error);
      // Rethrow ZkLoginError as is
      if (error instanceof ZkLoginError) {
        throw error;
      }
      // Otherwise wrap in a new error
      throw new ZkLoginError(String(error), false);
    }
  }

  public async adminApproveMembers(
    account: AccountData, 
    circleId: string,
    memberAddresses: string[]
  ): Promise<{ digest: string; requireRelogin?: boolean }> {
    try {
      // Log key information for debugging
      console.log('ZkLoginClient: Approving multiple members with account:', {
        address: account.userAddr,
        circleId,
        memberCount: memberAddresses.length,
        hasProofPoints: !!account.zkProofs?.proofPoints,
        hasHeaderBase64: !!account.zkProofs?.headerBase64,
        maxEpoch: account.maxEpoch
      });

      // Verify the account has valid proof data
      if (!account.zkProofs?.proofPoints || 
          !account.zkProofs.issBase64Details || 
          !account.zkProofs.headerBase64) {
        throw new ZkLoginError(
          'Missing required authentication data. Please login again.',
          true
        );
      }

      const response = await fetch('/api/zkLogin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          action: 'adminApproveMembers', 
          account,
          circleId,
          memberAddresses
        })
      });
      
      // Try to parse the response even if status is not OK
      let responseData;
      try {
        responseData = await response.json();
      } catch (parseError) {
        console.error('Failed to parse response:', parseError);
        throw new ZkLoginError(`Failed to parse server response: ${response.statusText}`, false);
      }
      
      // Handle authentication errors (401)
      if (response.status === 401) {
        console.error('Authentication error:', responseData);
        throw new ZkLoginError(
          `Authentication error: ${responseData.error || 'Session expired'}. Please login again.`, 
          true
        );
      }
      
      // Handle server errors (500)
      if (!response.ok) {
        console.error('Transaction failed:', responseData);
        throw new ZkLoginError(
          responseData.error || 'Transaction failed', 
          !!responseData.requireRelogin
        );
      }
      
      // Even for successful response, check if we have a digest
      if (!responseData.digest) {
        throw new ZkLoginError('No transaction digest received from server', false);
      }
      
      console.log('Approve multiple members succeeded:', responseData);
      return {
        digest: responseData.digest,
        requireRelogin: responseData.requireRelogin
      };
    } catch (error) {
      console.error('Approve multiple members error in client:', error);
      // Rethrow ZkLoginError as is
      if (error instanceof ZkLoginError) {
        throw error;
      }
      // Otherwise wrap in a new error
      throw new ZkLoginError(String(error), false);
    }
  }

  /**
   * Trigger the permissionless `trigger_payout<T>` Move function. The
   * dispatcher accepts a CoinType-specific call (USDC by default) and the
   * Move function routes USDC-first with a SUI fallback. The previous SUI
   * → USDC fallback chain has been collapsed into a single call.
   */
  async adminTriggerPayout(
    account: AccountData,
    circleId: string,
    walletId: string,
    network?: string
  ): Promise<{ digest: string; requireRelogin?: boolean }> {
    try {
      console.log(`ZkLoginClient: Triggering payout for circle ${circleId} with wallet ${walletId} on network ${network || 'default'}`);
      const response = await fetch('/api/zkLogin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'adminTriggerPayout',
          account,
          circleId,
          walletId,
          network,
        }),
      });
      if (response.ok) {
        const result = await response.json();
        return { digest: result.digest, requireRelogin: result.requireRelogin };
      }
      const errorData = await response.json();
      throw new ZkLoginError(
        errorData.error || 'Failed to trigger payout',
        errorData.requireRelogin || false,
      );
    } catch (error) {
      if (!(error instanceof ZkLoginError)) {
        console.error('Error in adminTriggerPayout:', error);
        throw new ZkLoginError(
          error instanceof Error ? error.message : 'Unknown error triggering payout',
          false,
        );
      }
      throw error;
    }
  }

  async resumeCycle(
    account: AccountData,
    circleId: string
  ): Promise<{ digest: string; requireRelogin?: boolean }> {
    try {
      console.log(`ZkLoginClient: Resuming cycle for circle ${circleId}`);

      // Verify the account has valid proof data
      if (!account.zkProofs?.proofPoints || 
          !account.zkProofs.issBase64Details || 
          !account.zkProofs.headerBase64) {
        throw new ZkLoginError(
          'Missing required authentication data. Please login again.',
          true
        );
      }

      const response = await fetch('/api/zkLogin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          action: 'resumeCycle', 
          account,
          circleId
        })
      });
      
      // Try to parse the response
      let responseData;
      try {
        responseData = await response.json();
        console.log('ZkLoginClient: Resume cycle response:', 
          response.status, response.statusText, responseData);
      } catch (parseError) {
        console.error('Failed to parse response:', parseError);
        throw new ZkLoginError(`Failed to parse server response: ${response.statusText}`, false);
      }
      
      // Handle authentication errors (401)
      if (response.status === 401) {
        console.error('Authentication error:', responseData);
        throw new ZkLoginError(
          `Authentication error: ${responseData.error || 'Session expired'}. Please login again.`, 
          true
        );
      }
      
      // Handle server errors (500)
      if (!response.ok) {
        console.error('Resume cycle failed:', responseData);
        throw new ZkLoginError(
          responseData.error || 'Failed to resume cycle', 
          !!responseData.requireRelogin
        );
      }
      
      // Even for successful response, check if we have a digest
      if (!responseData.digest) {
        throw new ZkLoginError('No transaction digest received from server', false);
      }
      
      console.log('Resume cycle succeeded:', responseData);
      return {
        digest: responseData.digest,
        requireRelogin: responseData.requireRelogin
      };
    } catch (error) {
      console.error('Resume cycle error in client:', error);
      // Rethrow ZkLoginError as is
      if (error instanceof ZkLoginError) {
        throw error;
      }
      // Otherwise wrap in a new error
      throw new ZkLoginError(String(error), false);
    }
  }

  // Phase 2 cleanup: payoutSecurityDepositSui, payoutSecurityDepositStablecoin,
  // addCetusLiquidity, removeCetusLiquidity, collectCetusFees, configureCetusYield,
  // and rebalanceCetusPosition were removed. They wrapped Move entrypoints that
  // were deleted in Phase 1 (admin_payout_security_deposit_*, the entire
  // njangi_yield_integration module). Refunds now run through the recovery
  // path in njangi_circles, and the yield product line is out of scope.

  // ------------------------------------------------------------------
  // Phase 5: CycleEscrow wrappers default to the client-side zkLogin
  // signer (ephemeral key stays in the browser); they only fall back to
  // the server-signing API when the sessionStorage signer session hasn't
  // been populated yet. That keeps the legacy admin surfaces working
  // while giving member-facing flows a non-custodial default.
  // ------------------------------------------------------------------

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
      const res = await client.signAndExecute({ build, gasBudget: 100_000_000 });
      return { digest: res.digest };
    }
    return this.postCycleEscrowAction('contributeToCycleEscrow', account, {
      escrowId,
      paymentCoinId,
      coinType,
    });
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
      body: JSON.stringify({ action, account, ...payload }),
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
