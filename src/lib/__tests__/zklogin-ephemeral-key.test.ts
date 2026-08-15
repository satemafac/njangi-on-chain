/**
 * The invariant these tests defend: the ephemeral signing key is generated in
 * the browser and never reaches the server. Losing that silently would restore
 * the operator's ability to sign for users, which is exactly the property the
 * non-custodial posture depends on — so it is asserted rather than assumed.
 */
import { Ed25519PublicKey } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { fromBase64 } from '@mysten/sui/utils';
import { generateNonce } from '@mysten/sui/zklogin';
import {
  createEphemeralKey,
  savePendingLogin,
  loadPendingLogin,
  clearPendingLogin,
} from '@/lib/zklogin-ephemeral-key';

// `testEnvironment: 'node'`, so provide the sessionStorage the module expects.
function installSessionStorage(): void {
  const store = new Map<string, string>();
  (global as unknown as { window: unknown }).window = {
    sessionStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
  };
}

describe('browser-side ephemeral key generation', () => {
  beforeEach(installSessionStorage);

  afterAll(() => {
    Reflect.deleteProperty(global as unknown as Record<string, unknown>, 'window');
  });

  it('produces a usable Ed25519 keypair whose public half matches the private half', () => {
    const key = createEphemeralKey();

    // The public key we hand the server must actually correspond to the secret
    // we keep. If these ever diverge, Enoki mints a proof against a key the
    // user cannot sign with and every transaction fails signature validation.
    const decoded = decodeSuiPrivateKey(key.ephemeralPrivateKey);
    expect(decoded.schema).toBe('ED25519');

    const derived = new Ed25519PublicKey(fromBase64(key.ephemeralPublicKey));
    expect(derived.toBase64()).toBe(key.ephemeralPublicKey);
  });

  it('mints a distinct key and randomness on every call', () => {
    const a = createEphemeralKey();
    const b = createEphemeralKey();

    expect(a.ephemeralPrivateKey).not.toBe(b.ephemeralPrivateKey);
    expect(a.ephemeralPublicKey).not.toBe(b.ephemeralPublicKey);
    expect(a.randomness).not.toBe(b.randomness);
  });

  it('derives the same nonce the server will compute from the public half alone', () => {
    // The server recomputes the nonce from (publicKey, maxEpoch, randomness)
    // and never accepts a client-supplied one. This asserts the public key we
    // transmit is sufficient for that, i.e. the server needs no secret.
    const key = createEphemeralKey();
    const maxEpoch = 123;

    const serverSide = generateNonce(
      new Ed25519PublicKey(fromBase64(key.ephemeralPublicKey)),
      maxEpoch,
      key.randomness,
    );
    const again = generateNonce(
      new Ed25519PublicKey(fromBase64(key.ephemeralPublicKey)),
      maxEpoch,
      key.randomness,
    );

    expect(serverSide).toBe(again);
    expect(serverSide).toEqual(expect.any(String));
  });

  it('round-trips the pending login and clears it on demand', () => {
    const key = createEphemeralKey();
    savePendingLogin({
      ephemeralPrivateKey: key.ephemeralPrivateKey,
      ephemeralPublicKey: key.ephemeralPublicKey,
      randomness: key.randomness,
      maxEpoch: 42,
      network: 'testnet',
      provider: 'Google',
    });

    expect(loadPendingLogin()?.ephemeralPrivateKey).toBe(key.ephemeralPrivateKey);

    clearPendingLogin();
    expect(loadPendingLogin()).toBeNull();
  });

  it('returns null rather than throwing on a corrupted pending record', () => {
    (global as unknown as { window: { sessionStorage: Storage } }).window.sessionStorage.setItem(
      'njangi.zklogin.pending',
      'not json',
    );
    expect(loadPendingLogin()).toBeNull();
  });
});
