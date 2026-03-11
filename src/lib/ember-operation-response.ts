export type EmberOperation = 'deployToEmberVault' | 'requestEmberRedemption';

export interface EmberLifecycle {
  status: string;
  partialCompletion: boolean;
  pendingRedemption: boolean;
  processing: string;
}

export interface EmberTxGasUsed {
  computationCost?: string;
  storageCost?: string;
  storageRebate?: string;
}

export interface EmberDeploySuccessResponse {
  operation: 'deployToEmberVault';
  digest: string;
  status: string;
  gasUsed?: EmberTxGasUsed;
  circleId: string;
  walletId: string;
  network: string;
  sourceAsset: 'SUI' | 'USDC' | 'USDT' | 'SUI_USDE';
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
  lifecycle: EmberLifecycle;
}

export interface EmberRedemptionSuccessResponse {
  operation: 'requestEmberRedemption';
  digest: string;
  status: string;
  gasUsed?: EmberTxGasUsed;
  circleId: string;
  walletId: string;
  network: string;
  receiptAmount: string;
  receiptCoinType: string;
  vaultId: string;
  vaultPackageId: string;
  protocolConfigId: string;
  receiver: string;
  lifecycle: EmberLifecycle;
  message: string;
}

export interface EmberErrorResponse {
  operation: EmberOperation;
  stage: string;
  code: string;
  error: string;
  lifecycle: EmberLifecycle;
  [key: string]: unknown;
}

function getDefaultErrorLifecycle(operation: EmberOperation): EmberLifecycle {
  if (operation === 'requestEmberRedemption') {
    return {
      status: 'REDEEM_REQUEST_FAILED',
      partialCompletion: false,
      pendingRedemption: true,
      processing: 'error'
    };
  }

  return {
    status: 'VAULT_DEPLOY_FAILED',
    partialCompletion: false,
    pendingRedemption: false,
    processing: 'error'
  };
}

export function emberErrorResponse(
  operation: EmberOperation,
  stage: string,
  error: string,
  code: string,
  extra: Record<string, unknown> = {}
): EmberErrorResponse {
  const hasLifecycleOverride = Object.prototype.hasOwnProperty.call(extra, 'lifecycle');
  const lifecycle = hasLifecycleOverride
    ? (extra.lifecycle as EmberLifecycle)
    : getDefaultErrorLifecycle(operation);

  return {
    operation,
    stage,
    code,
    error,
    lifecycle,
    ...extra
  };
}

interface BuildDeploySuccessParams {
  digest: string;
  status: string;
  gasUsed?: EmberTxGasUsed;
  circleId: string;
  walletId: string;
  network: string;
  sourceAsset: 'SUI' | 'USDC' | 'USDT' | 'SUI_USDE';
  sourceCoinType: string;
  sourceAmount: string;
  estimatedSuiUsdeOut: string;
  swapExecuted: boolean;
  targetCoinType?: 'SUI_USDE';
  slippageBps?: number;
  vaultId: string;
  vaultPackageId: string;
  protocolConfigId: string;
  receiptCoinType: string;
}

export function buildDeploySuccessResponse(
  params: BuildDeploySuccessParams
): EmberDeploySuccessResponse {
  return {
    operation: 'deployToEmberVault',
    digest: params.digest,
    status: params.status,
    gasUsed: params.gasUsed,
    circleId: params.circleId,
    walletId: params.walletId,
    network: params.network,
    sourceAsset: params.sourceAsset,
    sourceCoinType: params.sourceCoinType,
    targetCoinType: params.targetCoinType || 'SUI_USDE',
    sourceAmount: params.sourceAmount,
    swapExecuted: params.swapExecuted,
    estimatedSuiUsdeOut: params.estimatedSuiUsdeOut,
    slippageBps: params.slippageBps,
    vaultId: params.vaultId,
    vaultPackageId: params.vaultPackageId,
    protocolConfigId: params.protocolConfigId,
    receiptCoinType: params.receiptCoinType,
    lifecycle: {
      status: 'VAULT_DEPLOYED',
      partialCompletion: false,
      pendingRedemption: false,
      processing: 'onchain_deposit_complete'
    }
  };
}

interface BuildRedemptionSuccessParams {
  digest: string;
  status: string;
  gasUsed?: EmberTxGasUsed;
  circleId: string;
  walletId: string;
  network: string;
  receiptAmount: string;
  receiptCoinType: string;
  vaultId: string;
  vaultPackageId: string;
  protocolConfigId: string;
  receiver: string;
}

export function buildRedemptionSuccessResponse(
  params: BuildRedemptionSuccessParams
): EmberRedemptionSuccessResponse {
  return {
    operation: 'requestEmberRedemption',
    digest: params.digest,
    status: params.status,
    gasUsed: params.gasUsed,
    circleId: params.circleId,
    walletId: params.walletId,
    network: params.network,
    receiptAmount: params.receiptAmount,
    receiptCoinType: params.receiptCoinType,
    vaultId: params.vaultId,
    vaultPackageId: params.vaultPackageId,
    protocolConfigId: params.protocolConfigId,
    receiver: params.receiver,
    lifecycle: {
      status: 'REDEEM_REQUESTED',
      partialCompletion: false,
      pendingRedemption: true,
      processing: 'external_operator_required'
    },
    message:
      'Redemption request submitted. Final withdrawal processing is operator-driven via Ember process_withdrawal_requests.'
  };
}
