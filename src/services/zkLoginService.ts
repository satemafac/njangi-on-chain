import { SuiClient } from '@mysten/sui/client';
import { Transaction as TransactionBlock } from '@mysten/sui/transactions';
import { ExecuteTransactionRequestType } from '@mysten/sui/client';
import { enokiZkLoginService } from './enokiZkLoginService';

const FULLNODE_URL = 'https://fullnode.testnet.sui.io:443';

export type OAuthProvider = 'Google' | 'Facebook' | 'Apple';

export interface ZkLoginProofs {
  proofPoints: {
    a: string[];
    b: string[][];
    c: string[];
  };
  issBase64Details: {
    value: string;
    indexMod4: number;
  };
  headerBase64: string;
}

export interface SetupData {
  provider: string;
  maxEpoch: number;
  randomness: string;
  ephemeralPrivateKey: string;
}

export interface AccountData {
  provider: string;
  userAddr: string;
  zkProofs: ZkLoginProofs;
  ephemeralPrivateKey: string;
  userSalt: string;
  sub: string;
  aud: string;
  maxEpoch: number;
  picture?: string;
  name?: string;
}

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
  private suiClient: SuiClient;

  private constructor() {
    this.suiClient = new SuiClient({
      url: FULLNODE_URL
    });
  }

  public static getInstance(): ZkLoginService {
    if (!ZkLoginService.instance) {
      ZkLoginService.instance = new ZkLoginService();
    }
    return ZkLoginService.instance;
  }

  public async beginLogin(provider: OAuthProvider = 'Google'): Promise<{ loginUrl: string, setupData: SetupData }> {
    return enokiZkLoginService.beginLogin(provider);
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

  public getPublicKeyFromPrivate(privateKeyBase64: string): string {
    return enokiZkLoginService.getPublicKeyFromPrivate(privateKeyBase64);
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