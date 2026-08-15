import { SuiClient } from '@mysten/sui/client';
import { Transaction as TransactionBlock } from '@mysten/sui/transactions';
import { ExecuteTransactionRequestType } from '@mysten/sui/client';
import { enokiZkLoginService } from './enokiZkLoginService';

import { getCurrentRpcUrl, NetworkType } from './network-config';

// This module is a thin delegating wrapper over `enokiZkLoginService`. These
// types are re-exported rather than redeclared: a second copy would drift, and
// a copy that still marks `ephemeralPrivateKey` as required would quietly
// reassert that the server always holds a signing key.
export type {
  OAuthProvider,
  ZkLoginProofs,
  SetupData,
  AccountData,
  ZkLoginProtocolVersion,
} from './enokiZkLoginService';

import type { SetupData, AccountData, ZkLoginProofs, OAuthProvider } from './enokiZkLoginService';

export interface TransactionOptions {
  gasBudget?: number;
  requestType?: ExecuteTransactionRequestType;
}

export interface TransactionResult {
  digest: string;
  status: 'success' | 'failure';
  error?: string;
  gasUsed?: {
    computationCost: string;
    storageCost: string;
    storageRebate: string;
  };
  confirmedLocalExecution?: boolean;
  timestampMs?: string;
  checkpoint?: string;
}

export class ZkLoginService {
  private static instance: ZkLoginService;
  private suiClient!: SuiClient; // Add ! to mark as definitely assigned

  private constructor() {
    this.initializeClient();
  }

  private initializeClient() {
    this.suiClient = new SuiClient({
      url: getCurrentRpcUrl()
    });
  }

  public static getInstance(): ZkLoginService {
    if (!ZkLoginService.instance) {
      ZkLoginService.instance = new ZkLoginService();
    } else {
      // Reinitialize client with current network configuration
      ZkLoginService.instance.initializeClient();
    }
    return ZkLoginService.instance;
  }

  public async beginLogin(
    provider: OAuthProvider = 'Google',
    network?: NetworkType,
    origin?: string,
    clientKey?: { ephemeralPublicKey: string; randomness: string },
  ): Promise<{ loginUrl: string, setupData: SetupData }> {
    return enokiZkLoginService.beginLogin(provider, network, origin, clientKey);
  }

  public async handleCallback(token: string, setupData: SetupData): Promise<{ 
    address: string;
    zkProofs: ZkLoginProofs;
    userSalt: string;
    sub: string;
    aud: string;
    picture?: string;
    name?: string;
  }> {
    return enokiZkLoginService.handleCallback(token, setupData);
  }

  public async sendTransaction(
    account: AccountData,
    prepareBlock: (txb: TransactionBlock) => void,
    options: TransactionOptions = {}
  ): Promise<TransactionResult> {
    return enokiZkLoginService.sendTransaction(account, prepareBlock, options);
  }

  public async getTransactionStatus(digest: string): Promise<TransactionResult> {
    return enokiZkLoginService.getTransactionStatus(digest);
  }
} 
