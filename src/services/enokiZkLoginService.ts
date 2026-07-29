import { SuiClient } from '@mysten/sui/client';
import { Ed25519Keypair, Ed25519PublicKey } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { Transaction as TransactionBlock } from '@mysten/sui/transactions';
import {
  genAddressSeed,
  // `generateRandomness` is intentionally absent: JWT randomness is minted in
  // the browser alongside the ephemeral key and arrives with the request.
  generateNonce,
  getExtendedEphemeralPublicKey,
  getZkLoginSignature,
  jwtToAddress,
} from '@mysten/sui/zklogin';
import { decodeJwt } from 'jose';
import { EnokiClient } from '@mysten/enoki';
import { toBase64, fromBase64 } from '@mysten/sui/utils';
import { SuiTransactionBlockResponse, ExecuteTransactionRequestType } from '@mysten/sui/client';
import { allowedMoveCallTargets } from '@/lib/gas-sponsorship';
import {
  getCurrentEnokiConfig,
  getCurrentGraphqlUrl,
  getCurrentNetwork,
  getCurrentRpcUrl,
  getGraphqlUrlForNetwork,
  getNetworkConfig,
  NetworkType,
} from './network-config';
import { getHealthySuiClient, withSuiRpcFailover } from './sui-rpc-failover';
import { getCanonicalBaseOrigin, preferCanonicalOrigin } from '@/lib/canonical-host';

// Dynamic RPC URL based on network configuration
function getNetworkRpcUrl(): string {
  if (networkOverride) {
    return getNetworkConfig(networkOverride).rpcUrl;
  }
  return getCurrentRpcUrl();
}

// OAuth URLs and client IDs (same as before)
const GOOGLE_OAUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const FACEBOOK_OAUTH_URL = 'https://www.facebook.com/v18.0/dialog/oauth';
const APPLE_OAUTH_URL = 'https://appleid.apple.com/auth/authorize';
const GOOGLE_CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
const FACEBOOK_CLIENT_ID = process.env.NEXT_PUBLIC_FACEBOOK_CLIENT_ID;
const APPLE_CLIENT_ID = process.env.NEXT_PUBLIC_APPLE_CLIENT_ID;
const REDIRECT_URI = process.env.NEXT_PUBLIC_REDIRECT_URI;

// Network override for server-side session handling
let networkOverride: 'testnet' | 'mainnet' | undefined = undefined;

// Dynamic Enoki API configuration based on network
function getEnokiConfig() {
  // Use network override if set (for server-side callback processing)
  if (networkOverride) {
    console.log('🌍 Using network override:', networkOverride);
    return getNetworkConfig(networkOverride).enoki;
  }
  return getCurrentEnokiConfig();
}

const ENOKI_BASE_URL = 'https://api.enoki.mystenlabs.com/v1';

const MAX_EPOCH = 1; // keep ephemeral keys active for this many Sui epochs from now (1 epoch ~= 24h)
// Note: Sui rejects zkLogin proofs where maxEpoch > currentEpoch + 30, so keep this conservative

// Dynamic GraphQL URL based on network
function getGraphQLUrl(): string {
  if (networkOverride) {
    return getGraphqlUrlForNetwork(networkOverride);
  }

  return getCurrentGraphqlUrl();
}

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

/**
 * Session protocol version.
 *
 * v1 — the server generated the ephemeral keypair and persisted the secret,
 *      so it could sign on the user's behalf.
 * v2 — the browser generates the keypair; the server only ever sees the
 *      public half and cannot produce a user signature.
 *
 * New logins are always v2. v1 sessions are not migrated: they simply expire.
 * Because maxEpoch is one Sui epoch (~24h) and the session cookie matches,
 * every v1 session drains within a day of deploy, so no flag day is needed.
 */
export type ZkLoginProtocolVersion = 1 | 2;

export interface SetupData {
  provider: string;
  maxEpoch: number;
  randomness: string;
  /**
   * v1 sessions only. Never populated for new logins — the server no longer
   * generates or receives ephemeral private keys. Present solely so
   * already-issued sessions keep working until they expire.
   */
  ephemeralPrivateKey?: string;
  /** v2: base64 Ed25519 public key minted in the user's browser. */
  ephemeralPublicKey?: string;
  protocolVersion?: ZkLoginProtocolVersion;
  network?: 'testnet' | 'mainnet';  // Network selected on the frontend
  origin?: string;
  redirectUri?: string;
}

export interface AccountData {
  provider: string;
  userAddr: string;
  zkProofs: ZkLoginProofs;
  /**
   * Optional because the server-held copy is gone on v2 sessions. The browser
   * populates this from its own pending-login record after the callback
   * returns, so client-side signing sees a fully-formed account while the
   * server never does.
   */
  ephemeralPrivateKey?: string;
  userSalt: string;
  sub: string;
  aud: string;
  maxEpoch: number;
  picture?: string;
  name?: string;
}

/**
 * Thrown when a server-side signing path is reached with a v2 session. The API
 * route maps this to 409 so the client knows to sign locally instead.
 */
export class ClientSigningRequiredError extends Error {
  public readonly code = 'CLIENT_SIGNING_REQUIRED';
  constructor() {
    super(
      'This session has no server-held signing key. Transactions must be signed in the browser.',
    );
    this.name = 'ClientSigningRequiredError';
  }
}

interface TransactionOptions {
  gasBudget?: number;
  requestType?: ExecuteTransactionRequestType;
}

export interface SponsoredExecutionResult extends TransactionResult {
  sponsored: boolean;
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
  private suiClient!: SuiClient; // Add ! to mark as definitely assigned

  private constructor() {
    // Initialize with current network configuration
    this.initializeWithNetwork();
  }

  public initializeWithNetwork(targetNetwork?: NetworkType) {
    const currentNetwork = targetNetwork ?? getCurrentNetwork();
    const networkConfig = targetNetwork ? getNetworkConfig(targetNetwork) : undefined;
    const enokiConfig = networkConfig?.enoki ?? getEnokiConfig();
    
    console.log('🔧 EnokiZkLoginService initializing with network:', currentNetwork);
    console.log('🔑 Enoki config:', {
      network: enokiConfig.network,
      apiKey: enokiConfig.apiKey ? 'present' : 'MISSING',
      hasApiKey: !!enokiConfig.apiKey
    });
    
    if (!enokiConfig.apiKey) {
      throw new Error(`Enoki API key is required for ${currentNetwork} network. Please check your environment variables.`);
    }
    
    this.suiClient = new SuiClient({
      url: networkConfig?.rpcUrl ?? getNetworkRpcUrl()
    });
  }

  public static getInstance(): EnokiZkLoginService {
    if (!EnokiZkLoginService.instance) {
      EnokiZkLoginService.instance = new EnokiZkLoginService();
    } else {
      // Reinitialize with current network configuration
      EnokiZkLoginService.instance.initializeWithNetwork();
    }
    return EnokiZkLoginService.instance;
  }

  private resolveEffectiveNetwork(targetNetwork?: NetworkType): NetworkType {
    return targetNetwork ?? networkOverride ?? getCurrentNetwork();
  }

  /**
   * Start an OAuth login for a browser-generated ephemeral key.
   *
   * `clientKey` carries the public half of a keypair the browser just minted,
   * plus its JWT randomness. The server derives `maxEpoch` from the live chain
   * epoch and computes the nonce itself — a client-supplied nonce is never
   * accepted, since that would let a caller bind the OAuth challenge to a key
   * the server never validated.
   */
  public async beginLogin(
    provider: OAuthProvider = 'Google',
    targetNetwork?: NetworkType,
    requestOrigin?: string,
    clientKey?: { ephemeralPublicKey: string; randomness: string },
  ): Promise<{ loginUrl: string, setupData: SetupData }> {
    if (!clientKey?.ephemeralPublicKey || !clientKey?.randomness) {
      throw new Error(
        'A browser-generated ephemeral public key and randomness are required. Refresh the page and try signing in again.',
      );
    }
    if (
      !GOOGLE_CLIENT_ID || 
      !FACEBOOK_CLIENT_ID || 
      !APPLE_CLIENT_ID ||
      !REDIRECT_URI
    ) {
      throw new Error('Missing OAuth configuration');
    }

    const effectiveNetwork = this.resolveEffectiveNetwork(targetNetwork);
    const networkConfig = getNetworkConfig(effectiveNetwork);
    this.initializeWithNetwork(effectiveNetwork);
    const resolvedOrigin = this.resolveAuthOrigin(requestOrigin);
    const resolvedRedirectUri = this.resolveRedirectUri(resolvedOrigin);

    console.log('🌍 beginLogin: Using network configuration', {
      network: effectiveNetwork,
      rpcUrl: networkConfig.rpcUrl,
      packageId: networkConfig.packageId,
      redirectUri: resolvedRedirectUri,
    });

    // Create a nonce
    const { epoch } = await withSuiRpcFailover(
      effectiveNetwork,
      'enoki.beginLogin.getLatestSuiSystemState',
      async (suiClient) => suiClient.getLatestSuiSystemState(),
    );
    const maxEpoch = Number(epoch) + MAX_EPOCH;

    // The public key arrives from the browser; the private half never leaves
    // it. `generateNonce` needs only the public key, so nothing here requires
    // the server to hold signing material.
    const ephemeralPublicKey = new Ed25519PublicKey(
      fromBase64(clientKey.ephemeralPublicKey),
    );
    const randomness = clientKey.randomness;
    const nonce = generateNonce(ephemeralPublicKey, maxEpoch, randomness);

    // Create setup data
    const setupData: SetupData = {
      provider,
      maxEpoch,
      randomness,
      ephemeralPublicKey: clientKey.ephemeralPublicKey,
      protocolVersion: 2,
      network: effectiveNetwork,
      origin: resolvedOrigin,
      redirectUri: resolvedRedirectUri,
    };

    // Create OAuth URL based on provider
    let loginUrl: string;
    if (provider === 'Google') {
      const params = new URLSearchParams({
        nonce: nonce,
        client_id: GOOGLE_CLIENT_ID,
        redirect_uri: resolvedRedirectUri,
        response_type: 'id_token',
        response_mode: 'fragment',
        scope: 'openid profile email',
        prompt: 'select_account'  // Force account selection screen
      });
      loginUrl = `${GOOGLE_OAUTH_URL}?${params.toString()}`;
    } else if (provider === 'Facebook') {
      const params = new URLSearchParams({
        client_id: FACEBOOK_CLIENT_ID,
        redirect_uri: resolvedRedirectUri,
        response_type: 'id_token',
        response_mode: 'fragment',
        scope: 'openid email public_profile',
        nonce: nonce,
      });
      loginUrl = `${FACEBOOK_OAUTH_URL}?${params.toString()}`;
    } else { // Apple
      // Apple uses form_post, so it needs to redirect to our API endpoint
      const appleRedirectUri = resolvedRedirectUri.replace('/auth/callback', '/api/auth/callback');
      const params = new URLSearchParams({
        client_id: APPLE_CLIENT_ID,
        redirect_uri: appleRedirectUri,
        response_type: 'code id_token',
        scope: 'openid email name',
        response_mode: 'form_post',
        nonce: nonce,
      });
      loginUrl = `${APPLE_OAUTH_URL}?${params.toString()}`;
    }

    return { loginUrl, setupData };
  }

  private resolveAuthOrigin(requestOrigin?: string): string {
    const preferredOrigin = preferCanonicalOrigin(requestOrigin);
    if (preferredOrigin) {
      if (requestOrigin && preferredOrigin !== requestOrigin.trim()) {
        console.log('Redirecting auth flow to canonical public origin:', preferredOrigin);
      }
      return preferredOrigin;
    }

    const envRedirectUri = REDIRECT_URI?.trim();
    if (envRedirectUri) {
      try {
        return preferCanonicalOrigin(new URL(envRedirectUri).origin) ?? new URL(envRedirectUri).origin;
      } catch (error) {
        console.warn('Ignoring invalid NEXT_PUBLIC_REDIRECT_URI while resolving auth origin:', envRedirectUri, error);
      }
    }

    const canonicalOrigin = getCanonicalBaseOrigin();
    if (canonicalOrigin) {
      return canonicalOrigin;
    }

    return 'http://localhost:3000';
  }

  private resolveRedirectUri(requestOrigin?: string): string {
    return `${this.resolveAuthOrigin(requestOrigin)}/auth/callback`;
  }

  /**
   * Get user salt and address using Enoki's managed service
   */
  private async getUserSalt(jwt: string): Promise<string> {
    try {
      const enokiConfig = getEnokiConfig();
      const currentNetwork = getCurrentNetwork();
      
      console.log('🧂 Getting user salt for network:', currentNetwork);
      console.log('🔑 Using Enoki API key:', enokiConfig.apiKey ? 'present' : 'MISSING');
      
      const response = await fetch(`${ENOKI_BASE_URL}/zklogin`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${enokiConfig.apiKey}`,
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
      const enokiConfig = getEnokiConfig();
      
      console.log('🕰️ Getting zkProof for network:', enokiConfig.network);
      console.log('🔑 Using Enoki API key:', enokiConfig.apiKey ? 'present' : 'MISSING');
      console.log('🌍 Network in proof request:', enokiConfig.network);
      
      const response = await fetch(`${ENOKI_BASE_URL}/zklogin/zkp`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${enokiConfig.apiKey}`,
          'zklogin-jwt': proofRequest.jwt,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          network: enokiConfig.network,
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
  /**
   * Validates a legacy v1 account and returns its server-held signing key.
   *
   * Returning the key (rather than just validating) is deliberate: it is the
   * only way callers get a non-optional `string` across the async boundary, so
   * the compiler enforces that every server-side signing path went through
   * this check. There is no other supported way to obtain the key.
   */
  private async validateAccountData(account: AccountData): Promise<string> {
    // v2 sessions carry no server-held secret, so there is nothing here that
    // could sign. Surface that as a distinct, typed condition rather than a
    // generic "missing fields" error — the API route turns it into a 409 that
    // tells the client to sign locally.
    if (!account.ephemeralPrivateKey) {
      throw new ClientSigningRequiredError();
    }
    if (!account.zkProofs || !account.userSalt || !account.sub || !account.aud) {
      throw new Error('Invalid account data: missing required fields');
    }

    // Validate current epoch
    const { epoch } = await withSuiRpcFailover(
      this.resolveEffectiveNetwork(),
      'enoki.validateAccountData.getLatestSuiSystemState',
      async (suiClient) => suiClient.getLatestSuiSystemState(),
    );
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

    return account.ephemeralPrivateKey;
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
    // Set network override for server-side callback processing
    if (setupData.network) {
      networkOverride = setupData.network;
      console.log('🌍 handleCallback: Using network from setupData:', setupData.network);
    }

    try {
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
        provider: setupData.provider,
        network: setupData.network,
        // Log all available claims for debugging
        allClaims: Object.keys(jwtPayload),
        name: jwtPayload.name || 'not provided',
        email: jwtPayload.email || 'not provided',
        picture: jwtPayload.picture || 'not provided'
      });

      // Get salt from Enoki salt service
      const saltString = await this.getUserSalt(jwt);
      const userSalt = BigInt(saltString);

    // Generate user address
    const userAddr = await this.generateUserAddress(jwt, userSalt);

    // Resolve the ephemeral PUBLIC key. On v2 sessions it was supplied by the
    // browser at beginLogin; on legacy v1 sessions it is derived from the
    // server-held secret. Either way only the public half is needed to request
    // a proof — proofs authorize nothing without the corresponding secret.
    const publicKey = setupData.ephemeralPublicKey
      ? new Ed25519PublicKey(fromBase64(setupData.ephemeralPublicKey))
      : setupData.ephemeralPrivateKey
        ? this.keypairFromSecretKey(setupData.ephemeralPrivateKey).getPublicKey()
        : null;

    if (!publicKey) {
      throw new Error('Session is missing an ephemeral public key. Please sign in again.');
    }

    const extendedEphemeralPublicKey = getExtendedEphemeralPublicKey(publicKey);

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

    // Extract profile data with provider-specific logic
    let name = jwtPayload.name as string | undefined;
    let picture = jwtPayload.picture as string | undefined;
    
    // For Apple, handle special cases
    if (setupData.provider === 'Apple') {
      // Apple may not provide name/picture in subsequent logins
      // Check for email as a fallback identifier
      const email = jwtPayload.email as string | undefined;
      
      if (!name && email) {
        // Extract name from email prefix as fallback
        name = email.split('@')[0].replace(/[._]/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
      }
      
      // Apple doesn't provide profile pictures via OAuth
      // Generate a custom avatar URL based on the user's name
      if (!picture && name) {
        // Create initials-based avatar using a service like DiceBear or UI Avatars
        const initials = name.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase();
        const backgroundColor = this.generateColorFromName(name);
        picture = `https://ui-avatars.com/api/?name=${encodeURIComponent(initials)}&background=${backgroundColor}&color=fff&size=128&bold=true`;
      }
      
      console.log('Apple profile data:', { 
        hasName: !!name, 
        hasEmail: !!email, 
        hasPicture: !!picture,
        extractedName: name,
        generatedAvatar: picture
      });
    }

    return { 
      address: userAddr, 
      zkProofs,
      userSalt: userSalt.toString(),
      sub: jwtPayload.sub,
      aud: typeof jwtPayload.aud === 'string' ? jwtPayload.aud : jwtPayload.aud[0],
      picture,
      name
    };
    } finally {
      // Always clear the network override after callback processing
      networkOverride = undefined;
    }
  }

  private keypairFromSecretKey(privateKeyBase64: string): Ed25519Keypair {
    const keyPair = decodeSuiPrivateKey(privateKeyBase64);
    return Ed25519Keypair.fromSecretKey(keyPair.secretKey);
  }

  // Removed: `getPublicKeyFromPrivate` existed only to derive a public key for
  // log lines, which meant passing a secret around for a debug string. The
  // public key is now stored on the session directly (`ephemeralPublicKey`),
  // so nothing needs the secret to produce it.

  /**
   * Generate a consistent color based on a name for avatar generation
   * @param name The user's name
   * @returns A hex color code without the # prefix
   */
  private generateColorFromName(name: string): string {
    // Simple hash function to generate consistent colors
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
      hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    
    // Convert to hex color (avoiding too dark colors)
    const hue = Math.abs(hash) % 360;
    const saturation = 65; // Fixed saturation for pleasant colors
    const lightness = 55; // Fixed lightness for readability
    
    // Convert HSL to RGB then to hex
    const rgb = this.hslToRgb(hue / 360, saturation / 100, lightness / 100);
    return rgb.map(x => {
      const hex = Math.round(x * 255).toString(16);
      return hex.length === 1 ? '0' + hex : hex;
    }).join('');
  }

  /**
   * Convert HSL to RGB
   */
  private hslToRgb(h: number, s: number, l: number): [number, number, number] {
    let r, g, b;

    if (s === 0) {
      r = g = b = l; // achromatic
    } else {
      const hue2rgb = (p: number, q: number, t: number) => {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1/6) return p + (q - p) * 6 * t;
        if (t < 1/2) return q;
        if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
        return p;
      };

      const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      const p = 2 * l - q;
      r = hue2rgb(p, q, h + 1/3);
      g = hue2rgb(p, q, h);
      b = hue2rgb(p, q, h - 1/3);
    }

    return [r, g, b];
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

        const response = await fetch(getGraphQLUrl(), {
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
        const errorMessage = err instanceof Error ? err.message : String(err);
        // Don't throw - signature verification is optional and transaction may have already succeeded.
        console.warn(`Signature verification skipped: ${errorMessage}`);
        return false;
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
  /**
   * Builds, sponsors, and executes a transaction via Enoki so the user pays
   * NO gas. The user still authorizes with their own zkLogin signature — the
   * sponsor only provides (and pays for) the gas coin, so this is not
   * custodial: we cannot move funds the user didn't sign for.
   *
   * Flow (Enoki sponsored-transaction protocol):
   *   1. Build a gas-less transaction KIND (onlyTransactionKind) — no gas coin,
   *      no gas budget set by us.
   *   2. Enoki `createSponsoredTransaction` returns full tx bytes (with the
   *      sponsor's gas) + a digest, restricted to `allowedMoveCallTargets`.
   *   3. User signs those bytes with the ephemeral key -> zkLogin signature.
   *   4. Enoki `executeSponsoredTransaction(digest, signature)` submits it.
   *
   * The caller is responsible for the eligibility decision (see
   * `src/lib/gas-sponsorship.ts`); this method just performs a sponsored
   * execution and throws on failure so the caller can fall back to self-paid
   * `sendTransaction`.
   */
  public async sendSponsoredTransaction(
    account: AccountData,
    prepareBlock: (txb: TransactionBlock) => void,
    targetNetwork?: 'testnet' | 'mainnet',
  ): Promise<SponsoredExecutionResult> {
    const ephemeralPrivateKey = await this.validateAccountData(account);

    const effectiveNetwork = this.resolveEffectiveNetwork(targetNetwork);
    const networkConfig = getNetworkConfig(effectiveNetwork);
    const apiKey = networkConfig.enoki?.apiKey;
    if (!apiKey) {
      throw new Error('Enoki API key not configured for sponsorship');
    }
    const allowedTargets = allowedMoveCallTargets(networkConfig.packageId);
    if (allowedTargets.length === 0) {
      throw new Error('No package id available for sponsored move-call allowlist');
    }

    const { client: suiClient } = await getHealthySuiClient(
      effectiveNetwork,
      'enoki.sendSponsoredTransaction',
    );

    // 1. Build the gas-LESS transaction kind. We must NOT set a sender or gas
    //    here — the sponsor owns the gas; sender is passed to Enoki separately.
    const txb = new TransactionBlock();
    prepareBlock(txb);
    const kindBytes = await txb.build({ client: suiClient, onlyTransactionKind: true });

    const enoki = new EnokiClient({ apiKey });

    // 2. Ask Enoki to sponsor, pinned to our entry functions only.
    const sponsored = await enoki.createSponsoredTransaction({
      network: effectiveNetwork,
      transactionKindBytes: toBase64(kindBytes),
      sender: account.userAddr,
      allowedMoveCallTargets: allowedTargets,
      allowedAddresses: [account.userAddr],
    });

    // 3. User authorizes the sponsored bytes with their zkLogin signature.
    const ephemeralKeyPair = this.keypairFromSecretKey(ephemeralPrivateKey);
    const sponsoredBytes = fromBase64(sponsored.bytes);
    const { signature: userSignature } = await ephemeralKeyPair.signTransaction(sponsoredBytes);

    const addressSeed = genAddressSeed(
      BigInt(account.userSalt),
      'sub',
      account.sub,
      account.aud,
    ).toString();

    const zkLoginSignature = getZkLoginSignature({
      inputs: {
        ...account.zkProofs,
        proofPoints: this.formatProofPoints(account.zkProofs.proofPoints),
        addressSeed,
      },
      maxEpoch: account.maxEpoch,
      userSignature,
    });

    // 4. Submit through Enoki.
    const { digest } = await enoki.executeSponsoredTransaction({
      digest: sponsored.digest,
      signature: zkLoginSignature,
    });

    // Enoki returns only the digest; fetch effects for a consistent result
    // shape and to surface on-chain execution failures to the caller.
    const receipt = await suiClient.waitForTransaction({
      digest,
      options: { showEffects: true, showEvents: true },
    });

    const status = receipt.effects?.status?.status === 'success' ? 'success' : 'failure';
    if (status !== 'success') {
      throw new Error(
        `Sponsored transaction failed on-chain: ${receipt.effects?.status?.error || 'unknown'}`,
      );
    }

    return {
      digest,
      status,
      sponsored: true,
      error: receipt.effects?.status?.error || undefined,
      gasUsed: receipt.effects?.gasUsed || undefined,
      timestampMs: receipt.timestampMs || undefined,
      checkpoint: receipt.checkpoint || undefined,
    };
  }

  public async sendTransaction(
    account: AccountData,
    prepareBlock: ((txb: TransactionBlock) => void) | TransactionBlock,
    options: TransactionOptions = {},
    targetNetwork?: 'testnet' | 'mainnet'
  ): Promise<TransactionResult> {
    try {
      // Validate account data and check epoch expiration
      const ephemeralPrivateKey = await this.validateAccountData(account);

      // Get ephemeral keypair from stored private key
      const ephemeralKeyPair = this.keypairFromSecretKey(ephemeralPrivateKey);

      const effectiveNetwork = this.resolveEffectiveNetwork(targetNetwork);
      const { client: suiClient, rpcUrl, isFallback } = await getHealthySuiClient(
        effectiveNetwork,
        'enoki.sendTransaction',
      );
      console.log('Using Sui RPC for transaction submission:', {
        network: effectiveNetwork,
        rpcUrl,
        isFallback,
      });

      // Validate current epoch against maxEpoch
      // Note: Sui accepts transactions where currentEpoch < maxEpoch (strictly less than)
      // So if currentEpoch === maxEpoch, the transaction will be rejected
      const { epoch } = await suiClient.getLatestSuiSystemState();
      const currentEpoch = Number(epoch);
      const epochsRemaining = account.maxEpoch - currentEpoch;
      console.log(`Current epoch: ${currentEpoch}, maxEpoch: ${account.maxEpoch}, epochs remaining: ${epochsRemaining}`);
      
      if (currentEpoch >= account.maxEpoch) {
        throw new Error('Session has expired. Please re-authenticate to get a new proof.');
      }
      
      // Warn if proof is expiring soon (less than 1 epoch remaining)
      if (epochsRemaining < 1) {
        console.warn(`⚠️  WARNING: Proof expiring very soon! Only ${epochsRemaining} epochs remaining. Consider re-authenticating.`);
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

      // Create a new transaction block or use the prebuilt one directly.
      const txb =
        typeof prepareBlock === 'function'
          ? (() => {
              const nextTxb = new TransactionBlock();
              nextTxb.setSender(account.userAddr);
              prepareBlock(nextTxb);
              return nextTxb;
            })()
          : TransactionBlock.from(prepareBlock);

      txb.setSenderIfNotSet(account.userAddr);

      // Set gas budget with validation - increase default gas for zkLogin transactions
      const DEFAULT_GAS_BUDGET = 50000000;
      const gasBudget = options.gasBudget || DEFAULT_GAS_BUDGET;
      if (gasBudget < 1000000) {
        console.warn(`Gas budget ${gasBudget} may be too low for zkLogin transactions`);
      }
      if (options.gasBudget) {
        txb.setGasBudget(options.gasBudget);
      } else {
        txb.setGasBudgetIfNotSet(DEFAULT_GAS_BUDGET);
      }

      // Build transaction to get bytes for signing
      const { bytes, signature: userSignature } = await txb.sign({
        client: suiClient,
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
        const result = await suiClient.executeTransactionBlock({
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
          const verified = await this.verifyZkLoginSignature(bytes, zkLoginSignature, account.userAddr);
          if (verified) {
            console.log('zkLogin signature verified successfully');
          } else {
            console.warn('zkLogin signature verification could not be confirmed.');
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
