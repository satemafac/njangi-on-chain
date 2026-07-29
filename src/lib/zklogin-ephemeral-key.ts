// zklogin-ephemeral-key.ts — browser-side ephemeral key generation.
//
// The ephemeral keypair used to sign zkLogin transactions is generated HERE,
// in the user's browser, and never leaves it. The server receives only the
// public half, which is all it needs to derive the OAuth nonce and to request
// a zkProof from Enoki.
//
// This is the property the whole non-custodial posture rests on: the operator
// cannot produce a user signature, because the operator never possesses the
// key that makes one. Previously `EnokiZkLoginService.beginLogin` called
// `new Ed25519Keypair()` server-side and persisted the secret to Postgres for
// 24h, so the server was structurally capable of signing anything.
//
// Between `beginLogin` and the OAuth callback the key lives in a "pending
// login" record; once the callback returns proofs it is promoted into the
// signer session (`zklogin-client-signer.ts`). Both use `sessionStorage`:
// tab-scoped, cleared on logout, and never written to localStorage.

import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { generateRandomness } from '@mysten/sui/zklogin';

const PENDING_LOGIN_KEY = 'njangi.zklogin.pending';

export interface PendingLogin {
  /** base64-encoded Sui private key — browser-only, never transmitted */
  ephemeralPrivateKey: string;
  /** base64-encoded Ed25519 public key — sent to the server */
  ephemeralPublicKey: string;
  randomness: string;
  /** Assigned by the server from the live chain epoch, not by the client. */
  maxEpoch?: number;
  network: 'testnet' | 'mainnet';
  provider: string;
}

export interface FreshEphemeralKey {
  ephemeralPrivateKey: string;
  ephemeralPublicKey: string;
  randomness: string;
}

/**
 * Mint a fresh ephemeral keypair and JWT randomness in the browser.
 *
 * The nonce is deliberately NOT computed here — the server derives it from
 * the public key, its own `maxEpoch`, and this randomness. A client-supplied
 * nonce would let a caller pin the OAuth challenge to a key the server never
 * validated, so the server must never accept one.
 */
export function createEphemeralKey(): FreshEphemeralKey {
  const keypair = new Ed25519Keypair();
  return {
    ephemeralPrivateKey: keypair.getSecretKey(),
    ephemeralPublicKey: keypair.getPublicKey().toBase64(),
    randomness: generateRandomness().toString(),
  };
}

export function savePendingLogin(pending: PendingLogin): void {
  if (typeof window === 'undefined') return;
  window.sessionStorage.setItem(PENDING_LOGIN_KEY, JSON.stringify(pending));
}

export function loadPendingLogin(): PendingLogin | null {
  if (typeof window === 'undefined') return null;
  const raw = window.sessionStorage.getItem(PENDING_LOGIN_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PendingLogin;
  } catch (err) {
    console.error('[zklogin-ephemeral-key] Failed to parse pending login', err);
    return null;
  }
}

export function clearPendingLogin(): void {
  if (typeof window === 'undefined') return;
  window.sessionStorage.removeItem(PENDING_LOGIN_KEY);
}
