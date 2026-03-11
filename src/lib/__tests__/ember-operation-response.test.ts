import {
  emberErrorResponse,
  buildDeploySuccessResponse,
  buildRedemptionSuccessResponse,
} from '@/lib/ember-operation-response';

describe('ember operation response helpers', () => {
  it('builds deploy success response with stable lifecycle shape', () => {
    const response = buildDeploySuccessResponse({
      digest: '0xabc',
      status: 'success',
      gasUsed: {
        computationCost: '10',
        storageCost: '20',
        storageRebate: '5',
      },
      circleId: '0xcircle',
      walletId: '0xwallet',
      network: 'mainnet',
      sourceAsset: 'USDC',
      sourceCoinType: '0x1::usdc::USDC',
      sourceAmount: '1000000',
      estimatedSuiUsdeOut: '999900',
      swapExecuted: true,
      slippageBps: 50,
      vaultId: '0xvault',
      vaultPackageId: '0xpackage',
      protocolConfigId: '0xprotocol',
      receiptCoinType: '0xreceipt::esuiusde::ESUIUSDE',
    });

    expect(response.operation).toBe('deployToEmberVault');
    expect(response.targetCoinType).toBe('SUI_USDE');
    expect(response.lifecycle).toEqual({
      status: 'VAULT_DEPLOYED',
      partialCompletion: false,
      pendingRedemption: false,
      processing: 'onchain_deposit_complete',
    });
  });

  it('builds redemption success response with pending redemption lifecycle', () => {
    const response = buildRedemptionSuccessResponse({
      digest: '0xdef',
      status: 'success',
      circleId: '0xcircle',
      walletId: '0xwallet',
      network: 'mainnet',
      receiptAmount: '1000',
      receiptCoinType: '0xreceipt::esuiusde::ESUIUSDE',
      vaultId: '0xvault',
      vaultPackageId: '0xpackage',
      protocolConfigId: '0xprotocol',
      receiver: '0xreceiver',
    });

    expect(response.operation).toBe('requestEmberRedemption');
    expect(response.lifecycle).toEqual({
      status: 'REDEEM_REQUESTED',
      partialCompletion: false,
      pendingRedemption: true,
      processing: 'external_operator_required',
    });
    expect(response.message).toContain('operator-driven');
  });

  it('returns deploy error response with default failed lifecycle', () => {
    const response = emberErrorResponse(
      'deployToEmberVault',
      'transaction',
      'Failure',
      'EDEPLOY_FAILED',
    );

    expect(response).toMatchObject({
      operation: 'deployToEmberVault',
      stage: 'transaction',
      code: 'EDEPLOY_FAILED',
      error: 'Failure',
      lifecycle: {
        status: 'VAULT_DEPLOY_FAILED',
        partialCompletion: false,
        pendingRedemption: false,
        processing: 'error',
      },
    });
  });

  it('returns redemption error response with default failed lifecycle', () => {
    const response = emberErrorResponse(
      'requestEmberRedemption',
      'transaction',
      'Failure',
      'EREDEMPTION_REQUEST_FAILED',
    );

    expect(response).toMatchObject({
      operation: 'requestEmberRedemption',
      stage: 'transaction',
      code: 'EREDEMPTION_REQUEST_FAILED',
      error: 'Failure',
      lifecycle: {
        status: 'REDEEM_REQUEST_FAILED',
        partialCompletion: false,
        pendingRedemption: true,
        processing: 'error',
      },
    });
  });

  it('keeps explicit lifecycle override in error response', () => {
    const response = emberErrorResponse(
      'deployToEmberVault',
      'route',
      'No route',
      'ENO_SWAP_ROUTE',
      {
        lifecycle: {
          status: 'SWAP_ROUTE_UNAVAILABLE',
          partialCompletion: false,
          pendingRedemption: false,
          processing: 'route_lookup_failed',
        },
      },
    );

    expect(response.lifecycle).toEqual({
      status: 'SWAP_ROUTE_UNAVAILABLE',
      partialCompletion: false,
      pendingRedemption: false,
      processing: 'route_lookup_failed',
    });
  });
});
