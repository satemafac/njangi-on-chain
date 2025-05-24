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

// Use testnet for development
const FULLNODE_URL = process.env.NEXT_PUBLIC_SUI_RPC_URL || 'https://fullnode.testnet.sui.io:443';

// OAuth URLs and client IDs (same as before)
const GOOGLE_OAUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const FACEBOOK_OAUTH_URL = 'https://www.facebook.com/v18.0/dialog/oauth';
const APPLE_OAUTH_URL = 'https://appleid.apple.com/auth/authorize';
const GOOGLE_CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
const FACEBOOK_CLIENT_ID = process.env.NEXT_PUBLIC_FACEBOOK_CLIENT_ID;
const APPLE_CLIENT_ID = process.env.NEXT_PUBLIC_APPLE_CLIENT_ID;
const REDIRECT_URI = process.env.NEXT_PUBLIC_REDIRECT_URI;

// Enoki API configuration
const ENOKI_API_KEY = process.env.NEXT_PUBLIC_ENOKI;
const ENOKI_BASE_URL = 'https://api.enoki.mystenlabs.com/v1';

const MAX_EPOCH = 2; // keep ephemeral keys active for this many Sui epochs from now (1 epoch ~= 24h)
const GRAPHQL_URL = 'https://sui-testnet.mystenlabs.com/graphql';

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

interface TransactionOptions {
  gasBudget?: number;
  requestType?: ExecuteTransactionRequestType;
}

interface TransactionResult {
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

/**
 * Enhanced zkLogin service using Mysten Labs' managed Enoki service
 * This replaces the self-managed prover and salt services with Enoki APIs
 */
export class EnokiZkLoginService {
  private static instance: EnokiZkLoginService;
  private suiClient: SuiClient;

  private constructor() {
    if (!ENOKI_API_KEY) {
      throw new Error('NEXT_PUBLIC_ENOKI API key is required. Please set it in your environment variables.');
    }
    
    this.suiClient = new SuiClient({
      url: FULLNODE_URL
    });
  }

  public static getInstance(): EnokiZkLoginService {
    if (!EnokiZkLoginService.instance) {
      EnokiZkLoginService.instance = new EnokiZkLoginService();
    }
    return EnokiZkLoginService.instance;
  }

  public async beginLogin(provider: OAuthProvider = 'Google'): Promise<{ loginUrl: string, setupData: SetupData }> {
    if (
      !GOOGLE_CLIENT_ID || 
      !FACEBOOK_CLIENT_ID || 
      !APPLE_CLIENT_ID ||
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
        response_mode: 'fragment',
        scope: 'openid profile email'
      });
      loginUrl = `${GOOGLE_OAUTH_URL}?${params.toString()}`;
    } else if (provider === 'Facebook') {
      const params = new URLSearchParams({
        client_id: FACEBOOK_CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        response_type: 'id_token',
        response_mode: 'fragment',
        scope: 'openid email public_profile',
        nonce: nonce,
      });
      loginUrl = `${FACEBOOK_OAUTH_URL}?${params.toString()}`;
    } else { // Apple
      const params = new URLSearchParams({
        client_id: APPLE_CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        response_type: 'code id_token',
        scope: 'openid email name',
        response_mode: 'form_post',
        nonce: nonce,
      });
      loginUrl = `${APPLE_OAUTH_URL}?${params.toString()}`;
    }

    return { loginUrl, setupData };
  }

  /**
   * Get user salt and address using Enoki's managed service
   */
  private async getUserSalt(jwt: string): Promise<string> {
    try {
      const response = await fetch(`${ENOKI_BASE_URL}/zklogin`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${ENOKI_API_KEY}`,
          'zklogin-jwt': jwt,
          'Content-Type': 'application/json',
        }
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Enoki zklogin service error: ${response.status} ${errorText}`);
      }

      const result = await response.json();
      if (!result.data || !result.data.salt) {
        throw new Error('No salt returned from Enoki zklogin service');
      }

      return result.data.salt;
    } catch (error) {
      console.error('Error getting salt from Enoki:', error);
      throw new Error(`Failed to get user salt: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Get zero-knowledge proof using Enoki's managed proving service
   */
  private async getZkProof(proofRequest: {
    maxEpoch: number;
    jwtRandomness: string;
    extendedEphemeralPublicKey: string;
    jwt: string;
    salt: string;
    keyClaimName: string;
  }): Promise<ZkLoginProofs> {
    try {
      const response = await fetch(`${ENOKI_BASE_URL}/zklogin/zkp`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${ENOKI_API_KEY}`,
          'zklogin-jwt': proofRequest.jwt,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          network: 'testnet',
          ephemeralPublicKey: proofRequest.extendedEphemeralPublicKey,
          maxEpoch: proofRequest.maxEpoch,
          randomness: proofRequest.jwtRandomness
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Enoki zkp service error: ${response.status} ${errorText}`);
      }

      const result = await response.json();
      
      // Validate proof structure - Enoki returns different format
      if (!result.data || !result.data.proofPoints || !result.data.issBase64Details || !result.data.headerBase64) {
        throw new Error('Invalid proof structure returned from Enoki');
      }

      return {
        proofPoints: result.data.proofPoints,
        issBase64Details: result.data.issBase64Details,
        headerBase64: result.data.headerBase64
      };
    } catch (error) {
      console.error('Error getting proof from Enoki:', error);
      throw new Error(`Failed to get zero-knowledge proof: ${error instanceof Error ? error.message : 'Unknown error'}`);
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
    // The token is a JWT directly
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
      provider: setupData.provider
    });

    // Get salt from Enoki salt service
    const saltString = await this.getUserSalt(jwt);
    const userSalt = BigInt(saltString);

    // Generate user address
    const userAddr = await this.generateUserAddress(jwt, userSalt);

    // Get ephemeral keypair and validate
    const ephemeralKeyPair = this.keypairFromSecretKey(setupData.ephemeralPrivateKey);
    const extendedEphemeralPublicKey = getExtendedEphemeralPublicKey(ephemeralKeyPair.getPublicKey());

    // Prepare proof request
    const proofRequest = {
      maxEpoch: setupData.maxEpoch,
      jwtRandomness: setupData.randomness,
      extendedEphemeralPublicKey,
      jwt,
      salt: userSalt.toString(),
      keyClaimName: 'sub'
    };

    // Get the zero-knowledge proof from Enoki
    const zkProofs = await this.getZkProof(proofRequest);

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
   * Format proof points for zkLogin signature
   */
  private formatProofPoints(proofPoints: ZkLoginProofs['proofPoints']): ZkLoginProofs['proofPoints'] {
    try {
      // Deep clone the proof points to ensure we don't modify the original
      const proofPointsClone = JSON.parse(JSON.stringify(proofPoints));
      
      // Verify all required proof point components exist
      if (!proofPointsClone.a || !proofPointsClone.b || !proofPointsClone.c ||
          !Array.isArray(proofPointsClone.a) || !Array.isArray(proofPointsClone.b) || !Array.isArray(proofPointsClone.c)) {
        throw new Error('Proof points missing required components');
      }
      
      // Format the proof points according to Sui zkLogin requirements
      return {
        a: proofPointsClone.a.map((point: string | number) => BigInt(point).toString()),
        b: proofPointsClone.b.map((pair: string | number | Array<string | number>) => {
          // Handle b points correctly - must be pairs
          if (Array.isArray(pair) && pair.length === 2) {
            return pair.map((point: string | number) => BigInt(point).toString());
          } else if (!Array.isArray(pair)) {
            // If not an array, create a pair with [point, 0]
            return [BigInt(pair).toString(), "0"];
          } else {
            // If array but not length 2, log and throw error
            console.error('Invalid b point format:', pair);
            throw new Error(`Invalid b point format: expected pair but got array of length ${pair.length}`);
          }
        }),
        c: proofPointsClone.c.map((point: string | number) => BigInt(point).toString()),
      };
    } catch (error) {
      console.error('Error formatting proof points:', error);
      throw new Error(`Failed to format proof points: ${error instanceof Error ? error.message : 'Unknown error'}`);
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
      console.log(`Current epoch: ${currentEpoch}, maxEpoch: ${account.maxEpoch}`);
      if (currentEpoch >= account.maxEpoch) {
        throw new Error('Session has expired. Please re-authenticate to get a new proof.');
      }

      // Check all proof fields are present
      if (!account.zkProofs.proofPoints || !account.zkProofs.issBase64Details || !account.zkProofs.headerBase64) {
        throw new Error('Invalid proof data: Missing required proof components');
      }

      // Generate address seed for verification
      const addressSeed = genAddressSeed(
        BigInt(account.userSalt),
        'sub',
        account.sub,
        account.aud
      ).toString();
      console.log(`Generated address seed: ${addressSeed}`);

      // Create and prepare transaction block
      const txb = new TransactionBlock();
      txb.setSender(account.userAddr);
      
      // Let the caller customize the transaction block
      prepareBlock(txb);

      // Set gas budget with validation - increase default gas for zkLogin transactions
      const DEFAULT_GAS_BUDGET = 50000000;
      const gasBudget = options.gasBudget || DEFAULT_GAS_BUDGET;
      if (gasBudget < 1000000) {
        console.warn(`Gas budget ${gasBudget} may be too low for zkLogin transactions`);
      }
      txb.setGasBudget(gasBudget);

      // Build transaction to get bytes for signing
      const { bytes, signature: userSignature } = await txb.sign({
        client: this.suiClient,
        signer: ephemeralKeyPair,
      });

      // Validate userSignature
      if (!userSignature) {
        throw new Error('Failed to generate ephemeral signature');
      }

      try {
        // Deep clone the proof points to ensure we don't modify the original
        const proofPointsClone = JSON.parse(JSON.stringify(account.zkProofs.proofPoints));
        
        // Verify all required proof point components exist
        if (!proofPointsClone.a || !proofPointsClone.b || !proofPointsClone.c ||
            !Array.isArray(proofPointsClone.a) || !Array.isArray(proofPointsClone.b) || !Array.isArray(proofPointsClone.c)) {
          throw new Error('Proof points missing required components');
        }
        
        // Format the proof points according to Sui zkLogin requirements
        const formattedProofPoints = {
          a: proofPointsClone.a.map((point: string | number) => BigInt(point).toString()),
          b: proofPointsClone.b.map((pair: string | number | Array<string | number>) => {
            // Handle b points correctly - must be pairs
            if (Array.isArray(pair) && pair.length === 2) {
              return pair.map((point: string | number) => BigInt(point).toString());
            } else if (!Array.isArray(pair)) {
              // If not an array, create a pair with [point, 0]
              return [BigInt(pair).toString(), "0"];
            } else {
              // If array but not length 2, log and throw error
              console.error('Invalid b point format:', pair);
              throw new Error(`Invalid b point format: expected pair but got array of length ${pair.length}`);
            }
          }),
          c: proofPointsClone.c.map((point: string | number) => BigInt(point).toString()),
        };
        
        console.log('Proof points formatted successfully');
        
        // Create zkLogin signature with the exact format required by Sui
        console.log('Creating zkLogin signature with components:', {
          hasAddressSeed: !!addressSeed,
          userSignatureLength: userSignature?.length,
          maxEpoch: account.maxEpoch,
          proofPointsA: formattedProofPoints.a?.length,
          proofPointsB: formattedProofPoints.b?.length,
          proofPointsC: formattedProofPoints.c?.length,
          hasHeaderBase64: !!account.zkProofs.headerBase64,
          hasIssBase64Details: !!account.zkProofs.issBase64Details?.value
        });

        // Ensure we have all the required inputs
        if (!addressSeed || !userSignature || !account.zkProofs.headerBase64 ||
            !account.zkProofs.issBase64Details || !account.zkProofs.issBase64Details.value) {
          throw new Error('Missing required zkLogin signature components');
        }

        // Create the zkLogin signature
        const zkLoginSignature = getZkLoginSignature({
          inputs: {
            ...account.zkProofs,
            proofPoints: formattedProofPoints,
            addressSeed,
          },
          maxEpoch: account.maxEpoch,
          userSignature,
        });
        
        console.log('Generated zkLogin signature:', zkLoginSignature.substring(0, 20) + '...');
        
        // Execute transaction
        console.log('Executing transaction with zkLogin signature...');
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

        if (!result.digest) {
          throw new Error('Transaction execution failed: No digest returned');
        }

        console.log('Transaction executed successfully:', {
          digest: result.digest,
          status: result.effects?.status?.status || 'unknown',
          gasUsed: result.effects?.gasUsed || 'unknown'
        });

        // Verify the signature using GraphQL (optional - for debugging)
        if (process.env.NODE_ENV === 'development') {
          try {
            await this.verifyZkLoginSignature(bytes, zkLoginSignature, account.userAddr);
            console.log('zkLogin signature verified successfully');
          } catch (verifyError) {
            console.warn('Signature verification failed (transaction may still be valid):', verifyError);
          }
        }

        // Return the transaction result with proper typing
        return {
          digest: result.digest,
          status: result.effects?.status?.status === 'success' ? 'success' : 'failure',
          error: result.effects?.status?.error || undefined,
          gasUsed: result.effects?.gasUsed || undefined,
          confirmedLocalExecution: result.confirmedLocalExecution || undefined,
          timestampMs: result.timestampMs || undefined,
          checkpoint: result.checkpoint || undefined
        };

      } catch (formattingError) {
        console.error('Error during proof formatting or signature creation:', formattingError);
        throw new Error(`Failed to create zkLogin signature: ${formattingError instanceof Error ? formattingError.message : 'Unknown error'}`);
      }

    } catch (err) {
      console.error('Transaction error:', err);
      
      // Check for common error patterns and provide better messages
      if (err instanceof Error) {
        if (err.message.includes('epoch')) {
          throw new Error('Session has expired. Please re-authenticate to get a new proof.');
        }
        if (err.message.includes('Invalid signature')) {
          throw new Error('Invalid zkLogin signature. Please try re-authenticating.');
        }
        if (err.message.includes('InsufficientGas')) {
          throw new Error('Insufficient gas for transaction. Please ensure you have enough SUI for gas fees.');
        }
      }
      
      throw err;
    }
  }

  /**
   * Process transaction response into standardized format
   */
  private processTransactionResponse(response: SuiTransactionBlockResponse): TransactionResult {
    return {
      digest: response.digest || '',
      status: response.effects?.status?.status === 'success' ? 'success' : 'failure',
      error: response.effects?.status?.error || undefined,
      gasUsed: response.effects?.gasUsed || undefined,
      confirmedLocalExecution: response.confirmedLocalExecution || undefined,
      timestampMs: response.timestampMs || undefined,
      checkpoint: response.checkpoint || undefined
    };
  }

  /**
   * Get transaction status by digest
   */
  public async getTransactionStatus(digest: string): Promise<TransactionResult> {
    try {
      const txResponse = await this.suiClient.getTransactionBlock({
        digest,
        options: {
          showEffects: true,
          showEvents: true,
          showObjectChanges: true,
          showBalanceChanges: true,
        }
      });

      return this.processTransactionResponse(txResponse);
    } catch (error) {
      console.error('Error getting transaction status:', error);
      throw new Error(`Failed to get transaction status: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
}

// Create and export singleton instance
export const enokiZkLoginService = EnokiZkLoginService.getInstance(); 