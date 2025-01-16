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

const FULLNODE_URL = 'https://fullnode.devnet.sui.io:443';
const GOOGLE_OAUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const FACEBOOK_OAUTH_URL = 'https://www.facebook.com/v18.0/dialog/oauth';
const GOOGLE_CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
const FACEBOOK_CLIENT_ID = process.env.NEXT_PUBLIC_FACEBOOK_CLIENT_ID;
const REDIRECT_URI = process.env.NEXT_PUBLIC_REDIRECT_URI;
const SALT_SERVICE_URL = 'http://localhost:5002/get-salt'; // Local salt service endpoint
const MAX_EPOCH = 2; // keep ephemeral keys active for this many Sui epochs from now (1 epoch ~= 24h)

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

    // Decode the JWT
    const jwtPayload = decodeJwt(jwt);
    if (!jwtPayload.sub || !jwtPayload.aud) {
      throw new Error('Missing required JWT claims');
    }

    console.log('JWT payload:', {
      sub: jwtPayload.sub,
      aud: jwtPayload.aud,
      picture: jwtPayload.picture,
      name: jwtPayload.name,
      clientId: setupData.provider === 'Google' ? GOOGLE_CLIENT_ID : FACEBOOK_CLIENT_ID
    });

    // Get salt from the salt service
    const clientId = setupData.provider === 'Google' ? GOOGLE_CLIENT_ID : FACEBOOK_CLIENT_ID;
    if (!clientId) {
      throw new Error(`${setupData.provider} Client ID is not configured. Please check your .env.local file.`);
    }

    console.log('Using Client ID:', clientId);
    const saltResponse = await fetch(SALT_SERVICE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: jwt,
        client_id: clientId
      })
    });

    if (!saltResponse.ok) {
      const errorText = await saltResponse.text();
      throw new Error(`Salt service error: ${errorText}`);
    }

    const { salt } = await saltResponse.json();
    const userSalt = BigInt(salt);

    // Get the user's Sui address
    const userAddr = jwtToAddress(jwt, userSalt);

    // Get the ephemeral key pair
    const ephemeralKeyPair = this.keypairFromSecretKey(setupData.ephemeralPrivateKey);
    const ephemeralPublicKey = ephemeralKeyPair.getPublicKey();

    // Get the zero-knowledge proof
    const proofRequest = {
      maxEpoch: setupData.maxEpoch,
      jwtRandomness: setupData.randomness,
      extendedEphemeralPublicKey: getExtendedEphemeralPublicKey(ephemeralPublicKey),
      jwt,
      salt: userSalt.toString(),
      keyClaimName: 'sub'
    };

    console.log('Requesting proof with:', proofRequest);

    const proofResponse = await fetch('https://prover-dev.mystenlabs.com/v1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(proofRequest)
    });

    if (!proofResponse.ok) {
      const errorText = await proofResponse.text();
      console.error('Prover service error:', errorText);
      throw new Error(`Prover service error: ${errorText}`);
    }

    const zkProofs = await proofResponse.json();

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

  public async sendTransaction(account: AccountData): Promise<string> {
    // Create and sign the transaction
    const txb = new TransactionBlock();
    txb.setSender(account.userAddr);

    const ephemeralKeyPair = this.keypairFromSecretKey(account.ephemeralPrivateKey);
    const { bytes, signature: userSignature } = await txb.sign({
      client: this.suiClient,
      signer: ephemeralKeyPair,
    });

    // Generate address seed
    const addressSeed = genAddressSeed(
      BigInt(account.userSalt),
      'sub',
      account.sub,
      account.aud
    ).toString();

    // Create the zkLogin signature
    const zkLoginSignature: string = getZkLoginSignature({
      inputs: {
        ...account.zkProofs,
        addressSeed,
      },
      maxEpoch: account.maxEpoch,
      userSignature,
    });

    // Execute the transaction
    const executeRes = await this.suiClient.executeTransactionBlock({
      transactionBlock: bytes,
      signature: zkLoginSignature,
    });

    return executeRes.digest;
  }
} 