// zklogin-client-signer.ts — Client-side zkLogin signing primitive.
//
// The Phase 1 implementation routed every Move call through
// `src/pages/api/zkLogin.ts`, which means the server held the user's
// ephemeral private key in memory long enough to sign transactions on
// their behalf. That made the server an effective signer/custodian and
// created an unnecessary trust dependency.
//
// This module ships the alternative: a framework-agnostic signer that
// runs entirely in the browser (or any TypeScript runtime). The client
// holds the ephemeral key in `sessionStorage`, builds the Sui
// `Transaction`, signs locally with `Ed25519Keypair`, assembles the
// zkLogin signature with `getZkLoginSignature`, and submits to RPC
// directly. The server never sees the private key after the OAuth
// callback returns the AccountData payload.
//
// Frontend hook wrapper: `src/hooks/useZkLoginSigner.ts`.

import { SuiClient } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { genAddressSeed, getZkLoginSignature } from '@mysten/sui/zklogin';
import type { ZkLoginProofs, AccountData } from '../services/zkLoginService';

const SESSION_KEY = 'njangi.zklogin.signer';

export interface ClientSignerSession {
  ephemeralPrivateKey: string; // base64-encoded Sui keypair private key
  zkProofs: ZkLoginProofs;
  userSalt: string;
  userAddress: string;
  sub: string;
  aud: string;
  maxEpoch: number;
  network: 'testnet' | 'mainnet';
}

export interface ClientSignerResult {
  digest: string;
  effects?: unknown;
  events?: unknown;
}

export interface SignTransactionInput {
  /**
   * Populate the programmable transaction block. The client is passed
   * as a second argument so async builders (e.g. coin-merge helpers that
   * need `suiClient.getCoins`) don't have to receive it separately.
   */
  build: (txb: Transaction, client: SuiClient) => void | Promise<void>;
  gasBudget?: number;
}

/**
 * Persist the AccountData required for client-side signing. Stored in
 * `sessionStorage` only — clearing the tab logs the user out and
 * eliminates the key. Production deployments may want to additionally
 * encrypt at rest with a passphrase.
 */
export function saveSignerSession(
  session: ClientSignerSession,
): void {
  if (typeof window === 'undefined') return;
  window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export function clearSignerSession(): void {
  if (typeof window === 'undefined') return;
  window.sessionStorage.removeItem(SESSION_KEY);
}

export function loadSignerSession(): ClientSignerSession | null {
  if (typeof window === 'undefined') return null;
  const raw = window.sessionStorage.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ClientSignerSession;
  } catch (err) {
    console.error('[zklogin-client-signer] Failed to parse session', err);
    return null;
  }
}

/**
 * Convenience: derive the signer session payload from the existing
 * AccountData type that the OAuth callback already returns. Use this in
 * the callback page to populate sessionStorage so subsequent calls can
 * sign locally without revisiting the server.
 */
export function accountToSignerSession(
  account: AccountData,
  network: 'testnet' | 'mainnet',
): ClientSignerSession {
  return {
    ephemeralPrivateKey: account.ephemeralPrivateKey,
    zkProofs: account.zkProofs,
    userSalt: account.userSalt,
    userAddress: account.userAddr,
    sub: account.sub,
    aud: account.aud,
    maxEpoch: account.maxEpoch,
    network,
  };
}

function buildKeypair(privateKey: string): Ed25519Keypair {
  const decoded = decodeSuiPrivateKey(privateKey);
  if (decoded.schema !== 'ED25519') {
    throw new Error(`Unsupported keypair schema for client signing: ${decoded.schema}`);
  }
  return Ed25519Keypair.fromSecretKey(decoded.secretKey);
}

/**
 * Builds, signs, and submits a transaction client-side using zkLogin
 * proofs and the user's local ephemeral key. The server is never
 * consulted for signing — only for the original zkProof generation that
 * lives in the AccountData.
 */
export async function signAndExecuteWithZkLogin(
  session: ClientSignerSession,
  client: SuiClient,
  input: SignTransactionInput,
): Promise<ClientSignerResult> {
  const txb = new Transaction();
  txb.setSender(session.userAddress);
  if (typeof input.gasBudget === 'number') {
    txb.setGasBudget(input.gasBudget);
  }
  await input.build(txb, client);

  const keypair = buildKeypair(session.ephemeralPrivateKey);
  const txBytes = await txb.build({ client });
  const userSig = await keypair.signTransaction(txBytes);

  const addressSeed = genAddressSeed(
    BigInt(session.userSalt),
    'sub',
    session.sub,
    session.aud,
  ).toString();

  const zkSignature = getZkLoginSignature({
    inputs: { ...session.zkProofs, addressSeed },
    maxEpoch: session.maxEpoch,
    userSignature: userSig.signature,
  });

  const result = await client.executeTransactionBlock({
    transactionBlock: txBytes,
    signature: zkSignature,
    options: {
      showEffects: true,
      showEvents: true,
    },
  });

  return {
    digest: result.digest,
    effects: result.effects,
    events: result.events,
  };
}
