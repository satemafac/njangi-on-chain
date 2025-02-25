import { SuiClient } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { Transaction as TransactionBlock } from '@mysten/sui/transactions';
import {
  genAddressSeed,
  generateNonce,
  generateRandomness,
  getExtendedEphemeralPublicKey,
  getZkLoginSignature,
  jwtToAddress,
} from '@mysten/sui/zklogin';
import { decodeJwt } from 'jose';
import { SuiTransactionBlockResponse, ExecuteTransactionRequestType } from '@mysten/sui/client';

const FULLNODE_URL = 'https://fullnode.testnet.sui.io:443';
const GOOGLE_OAUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const FACEBOOK_OAUTH_URL = 'https://www.facebook.com/v18.0/dialog/oauth';
const GOOGLE_CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
const FACEBOOK_CLIENT_ID = process.env.NEXT_PUBLIC_FACEBOOK_CLIENT_ID;
const REDIRECT_URI = process.env.NEXT_PUBLIC_REDIRECT_URI;
const SALT_SERVICE_URL = 'http://localhost:5002/get-salt'; // Local salt service endpoint
const MAX_EPOCH = 2; // keep ephemeral keys active for this many Sui epochs from now (1 epoch ~= 24h)
const GRAPHQL_URL = 'https://sui-testnet.mystenlabs.com/graphql';

export type OAuthProvider = 'Google' | 'Facebook';

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

interface ProofPoints {
  a: string[];
  b: string[][];
  c: string[];
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
    if (
      !GOOGLE_CLIENT_ID || 
      !FACEBOOK_CLIENT_ID || 
      !REDIRECT_URI
    ) {
      throw new Error('Missing OAuth configuration');
    }

    // Create a nonce
    const { epoch } = await this.suiClient.getLatestSuiSystemState();
    const maxEpoch = Number(epoch) + MAX_EPOCH;
    const ephemeralKeyPair = new Ed25519Keypair();
    const randomness = generateRandomness();
    const nonce = generateNonce(ephemeralKeyPair.getPublicKey(), maxEpoch, randomness);

    // Create setup data
    const setupData = {
      provider,
      maxEpoch,
      randomness: randomness.toString(),
      ephemeralPrivateKey: ephemeralKeyPair.getSecretKey(),
    };

    // Create OAuth URL based on provider
    let loginUrl: string;
    if (provider === 'Google') {
      const params = new URLSearchParams({
        nonce: nonce,
        client_id: GOOGLE_CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        response_type: 'id_token',
        scope: 'openid profile email'
      });
      loginUrl = `${GOOGLE_OAUTH_URL}?${params.toString()}`;
    } else {
      const params = new URLSearchParams({
        client_id: FACEBOOK_CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        response_type: 'id_token',
        scope: 'openid email public_profile',
        nonce: nonce, // Use nonce directly instead of state for OIDC
      });
      loginUrl = `${FACEBOOK_OAUTH_URL}?${params.toString()}`;
    }

    return { loginUrl, setupData };
  }

  /**
   * Format proof points to ensure proper BigInt conversion and validation
   */
  private formatProofPoints(proofPoints: ProofPoints) {
    if (!proofPoints || !proofPoints.a || !proofPoints.b || !proofPoints.c) {
      throw new Error('Invalid proof points structure');
    }

    try {
      return {
        a: proofPoints.a.map((point: string) => BigInt(point).toString()),
        b: proofPoints.b.map((row: string[]) => 
          Array.isArray(row) 
            ? row.map(point => BigInt(point).toString())
            : [BigInt(row).toString(), BigInt(row).toString()]
        ),
        c: proofPoints.c.map((point: string) => BigInt(point).toString())
      };
    } catch (error) {
      throw new Error(`Failed to format proof points: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Generate user address from JWT and salt
   */
  private async generateUserAddress(jwt: string, userSalt: bigint): Promise<string> {
    const decoded = decodeJwt(jwt);
    const aud = Array.isArray(decoded.aud) ? decoded.aud[0] : decoded.aud;
    
    if (!decoded.sub || !aud) {
      throw new Error('Missing required JWT claims (sub or aud)');
    }
    
    try {
      return jwtToAddress(jwt, userSalt);
    } catch (error) {
      throw new Error(`Failed to generate user address: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Validate account data and proof expiration
   */
  private async validateAccountData(account: AccountData): Promise<void> {
    if (!account.ephemeralPrivateKey || !account.zkProofs || !account.userSalt || !account.sub || !account.aud) {
      throw new Error('Invalid account data: missing required fields');
    }

    // Validate current epoch
    const { epoch } = await this.suiClient.getLatestSuiSystemState();
    if (Number(epoch) >= account.maxEpoch) {
      throw new Error('Proof has expired. Please re-authenticate to get a new proof.');
    }

    // Validate proof structure
    const { proofPoints } = account.zkProofs;
    if (!proofPoints || !proofPoints.a || !proofPoints.b || !proofPoints.c) {
      throw new Error('Invalid proof structure: missing proof points');
    }

    // Validate salt
    try {
      BigInt(account.userSalt);
    } catch {
      throw new Error('Invalid user salt format');
    }
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
    // Both providers now give us a JWT directly
    const jwt = token;

    // Decode and validate the JWT
    const jwtPayload = decodeJwt(jwt);
    if (!jwtPayload.sub || !jwtPayload.aud) {
      throw new Error('Missing required JWT claims');
    }

    console.log('Processing JWT payload:', {
      sub: jwtPayload.sub,
      aud: jwtPayload.aud,
      exp: jwtPayload.exp,
      iat: jwtPayload.iat,
      clientId: setupData.provider === 'Google' ? GOOGLE_CLIENT_ID : FACEBOOK_CLIENT_ID
    });

    // Get salt from the salt service with improved error handling
    const clientId = setupData.provider === 'Google' ? GOOGLE_CLIENT_ID : FACEBOOK_CLIENT_ID;
    if (!clientId) {
      throw new Error(`${setupData.provider} Client ID is not configured`);
    }

    const saltResponse = await fetch(SALT_SERVICE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: jwt, client_id: clientId })
    });

    if (!saltResponse.ok) {
      const errorText = await saltResponse.text();
      throw new Error(`Salt service error: ${errorText}`);
    }

    const { salt } = await saltResponse.json();
    const userSalt = BigInt(salt);

    // Generate user address
    const userAddr = await this.generateUserAddress(jwt, userSalt);

    // Get ephemeral keypair and validate
    const ephemeralKeyPair = this.keypairFromSecretKey(setupData.ephemeralPrivateKey);
    const extendedEphemeralPublicKey = getExtendedEphemeralPublicKey(ephemeralKeyPair.getPublicKey());

    // Prepare proof request with improved validation
    const proofRequest = {
      maxEpoch: setupData.maxEpoch,
      jwtRandomness: setupData.randomness,
      extendedEphemeralPublicKey,
      jwt,
      salt: userSalt.toString(),
      keyClaimName: 'sub'
    };

    // Get and validate the zero-knowledge proof
    const proofResponse = await fetch('https://prover-dev.mystenlabs.com/v1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(proofRequest)
    });

    if (!proofResponse.ok) {
      const errorText = await proofResponse.text();
      throw new Error(`Prover service error: ${errorText}`);
    }

    const zkProofs = await proofResponse.json();

    // Validate proof structure with new helper
    try {
      this.formatProofPoints(zkProofs.proofPoints);
    } catch (error) {
      throw new Error(`Invalid proof structure: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    return { 
      address: userAddr, 
      zkProofs,
      userSalt: userSalt.toString(),
      sub: jwtPayload.sub,
      aud: typeof jwtPayload.aud === 'string' ? jwtPayload.aud : jwtPayload.aud[0],
      picture: jwtPayload.picture as string | undefined,
      name: jwtPayload.name as string | undefined
    };
  }

  private keypairFromSecretKey(privateKeyBase64: string): Ed25519Keypair {
    const keyPair = decodeSuiPrivateKey(privateKeyBase64);
    return Ed25519Keypair.fromSecretKey(keyPair.secretKey);
  }

  /**
   * Get public key from private key
   * @param privateKeyBase64 Base64 encoded private key
   * @returns Base64 encoded public key
   */
  public getPublicKeyFromPrivate(privateKeyBase64: string): string {
    const keyPair = this.keypairFromSecretKey(privateKeyBase64);
    return keyPair.getPublicKey().toBase64();
  }

  /**
   * Prepares a transaction block with custom content
   * @param account The account data for the transaction
   * @param prepareBlock Callback function to prepare the transaction block
   * @returns Prepared transaction block
   */
  private async prepareTransactionBlock(
    account: AccountData,
    prepareBlock: (txb: TransactionBlock) => void
  ): Promise<TransactionBlock> {
    const txb = new TransactionBlock();
    txb.setSender(account.userAddr);
    
    // Let the caller customize the transaction block
    prepareBlock(txb);
    
    return txb;
  }

  private async verifyZkLoginSignature(
    bytes: Uint8Array | string,
    signature: string,
    userAddress: string
  ): Promise<boolean> {
    try {
        // Ensure bytes are properly Base64 encoded
        const bytesBase64 = typeof bytes === 'string' 
            ? bytes 
            : Buffer.from(bytes).toString('base64');

        // For zkLogin signatures starting with 'BQ', we need to keep the original format
        const signatureBase64 = signature.startsWith('BQ') ? signature : Buffer.from(signature).toString('base64');

        const query = `
            query VerifyZkloginSignature($bytes: Base64!, $signature: Base64!, $address: SuiAddress!) {
                verifyZkloginSignature(
                    bytes: $bytes,
                    signature: $signature,
                    intentScope: TRANSACTION_DATA,
                    author: $address
                ) {
                    success
                    errors
                }
            }
        `;

        const response = await fetch(GRAPHQL_URL, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify({
                query,
                variables: {
                    bytes: bytesBase64,
                    signature: signatureBase64,
                    address: userAddress
                }
            })
        });

        if (!response.ok) {
            throw new Error(`GraphQL request failed: ${response.statusText}`);
        }

        const result = await response.json();
        
        if (result.errors) {
            console.error('GraphQL verification errors:', result.errors);
            throw new Error(`GraphQL verification failed: ${result.errors[0].message}`);
        }

        const verifyResult = result.data?.verifyZkloginSignature;
        if (!verifyResult) {
            throw new Error('No verification result returned from server');
        }

        if (!verifyResult.success) {
            if (verifyResult.errors?.some((error: string) => error.includes('Groth16 proof verify failed'))) {
                throw new Error('zkLogin proof verification failed. This could be due to an expired session or invalid proof. Please try re-authenticating.');
            }
            
            if (verifyResult.errors?.some((error: string) => error.includes('epoch'))) {
                throw new Error('Session has expired. Please re-authenticate to get a new proof.');
            }

            throw new Error(`Signature verification failed: ${verifyResult.errors?.join(', ') || 'Unknown error'}`);
        }
        
        return verifyResult.success;
    } catch (err) {
        console.error('Signature verification error:', err);
        throw err;
    }
  }

  /**
   * Signs and executes a transaction with custom content
   * @param account The account data for the transaction
   * @param prepareBlock Callback function to prepare the transaction block
   * @param options Transaction options
   * @returns Transaction result
   */
  public async sendTransaction(
    account: AccountData,
    prepareBlock: (txb: TransactionBlock) => void,
    options: TransactionOptions = {}
  ): Promise<TransactionResult> {
    try {
        // Validate account data and check epoch expiration
        await this.validateAccountData(account);

        // Get ephemeral keypair from stored private key
        const ephemeralKeyPair = this.keypairFromSecretKey(account.ephemeralPrivateKey);

        // Validate current epoch against maxEpoch
        const { epoch } = await this.suiClient.getLatestSuiSystemState();
        const currentEpoch = Number(epoch);
        if (currentEpoch >= account.maxEpoch) {
            throw new Error('Session has expired. Please re-authenticate to get a new proof.');
        }

        // Generate address seed for verification
        const addressSeed = genAddressSeed(
            BigInt(account.userSalt),
            'sub',
            account.sub,
            account.aud
        ).toString();

        // Create and prepare transaction block
        const txb = new TransactionBlock();
        txb.setSender(account.userAddr);
        
        // Let the caller customize the transaction block
        prepareBlock(txb);

        // Set gas budget with validation
        const DEFAULT_GAS_BUDGET = 50000000; // 0.05 SUI
        const gasBudget = options.gasBudget || DEFAULT_GAS_BUDGET;
        if (gasBudget <= 0) {
            throw new Error('Invalid gas budget');
        }
        txb.setGasBudget(gasBudget);

        // Sign the transaction block
        const { bytes, signature: userSignature } = await txb.sign({
            client: this.suiClient,
            signer: ephemeralKeyPair,
        });

        // Format and validate proof points
        let formattedProofPoints;
        try {
            formattedProofPoints = this.formatProofPoints(account.zkProofs.proofPoints);
        } catch (error) {
            throw new Error(`Invalid proof points: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }

        // Create zkLogin signature with validated components
        const zkLoginSignature = getZkLoginSignature({
            inputs: {
                ...account.zkProofs,
                proofPoints: formattedProofPoints,
                addressSeed,
                issBase64Details: account.zkProofs.issBase64Details,
                headerBase64: account.zkProofs.headerBase64
            },
            maxEpoch: account.maxEpoch,
            userSignature,
        });

        // Verify signature before sending
        try {
            const isValid = await this.verifyZkLoginSignature(
                bytes,
                zkLoginSignature,
                account.userAddr
            );

            if (!isValid) {
                throw new Error('Failed to verify zkLogin signature');
            }
        } catch (error) {
            if (error instanceof Error && 
                (error.message.includes('Groth16 proof verify failed') || 
                 error.message.includes('epoch'))) {
                throw new Error('Session has expired or proof is invalid. Please re-authenticate.');
            }
            throw error;
        }

        // Execute transaction with improved error handling
        const result = await this.suiClient.executeTransactionBlock({
            transactionBlock: bytes,
            signature: zkLoginSignature,
            options: {
                showEffects: true,
                showEvents: true,
                showInput: true,
                showObjectChanges: true,
            },
            requestType: options.requestType || 'WaitForLocalExecution'
        });

        if (!result) {
            throw new Error('No transaction response received');
        }

        const txResult = this.processTransactionResponse(result);
        if (txResult.status === 'failure') {
            throw new Error(txResult.error || 'Transaction failed');
        }

        return txResult;
    } catch (err) {
        console.error('Transaction error:', err);
        
        if (err instanceof Error) {
            // Check for specific error types
            if (err.message.includes('epoch has expired') || 
                err.message.includes('maxEpoch') || 
                err.message.includes('proof verify failed') ||
                err.message.includes('Session has expired')) {
                throw new Error('Session expired: Please re-authenticate');
            }
            
            if (err.message.includes('insufficient gas')) {
                throw new Error('Insufficient gas: Please ensure you have enough SUI for gas');
            }

            if (err.message.includes('Invalid proof points')) {
                throw new Error('Invalid proof structure: Please re-authenticate');
            }
        }
        
        throw new Error('Failed to execute transaction. Please try again.');
    }
  }

  /**
   * Process transaction response and extract relevant information
   * @param response Transaction response from Sui
   * @returns Processed transaction result
   */
  private processTransactionResponse(
    response: SuiTransactionBlockResponse
  ): TransactionResult {
    if (!response) {
      return {
        digest: '',
        status: 'failure',
        error: 'No transaction response received',
      };
    }

    const effects = response.effects;
    if (!effects) {
      return {
        digest: response.digest,
        status: 'failure',
        error: 'No transaction effects available',
      };
    }

    const result: TransactionResult = {
      digest: response.digest,
      status: effects.status.status === 'success' ? 'success' : 'failure',
      gasUsed: effects.gasUsed,
      confirmedLocalExecution: response.confirmedLocalExecution || undefined,
      timestampMs: response.timestampMs?.toString(),
      checkpoint: response.checkpoint?.toString(),
    };

    if (effects.status.error) {
      result.error = effects.status.error;
    }

    return result;
  }

  /**
   * Get transaction status and details
   * @param digest Transaction digest
   * @returns Transaction details
   */
  public async getTransactionStatus(digest: string): Promise<TransactionResult> {
    try {
      const txResponse = await this.suiClient.getTransactionBlock({
        digest,
        options: {
          showEffects: true,
          showEvents: true,
          showInput: true,
          showObjectChanges: true,
        },
      });

      return this.processTransactionResponse(txResponse);
    } catch (error) {
      console.error('Failed to get transaction status:', error);
      return {
        digest,
        status: 'failure',
        error: error instanceof Error ? error.message : 'Failed to fetch transaction status',
      };
    }
  }
} 