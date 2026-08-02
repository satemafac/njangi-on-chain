/**
 * Wire-contract tests for the login handshake.
 *
 * The claim these defend is narrow and load-bearing: the ephemeral signing key
 * is generated in the browser and the server never receives it. Everything in
 * the non-custodial posture follows from that, so it is asserted against the
 * actual bytes sent over the wire rather than inferred from the code shape.
 */
import { ZkLoginClient } from '@/services/zkLoginClient';
import type { AccountData } from '@/services/zkLoginService';
import { loadPendingLogin, savePendingLogin } from '@/lib/zklogin-ephemeral-key';
import { readFileSync } from 'fs';
import { join } from 'path';

jest.mock('../network-config', () => ({
  getCurrentNetwork: jest.fn(() => 'testnet'),
  getCurrentPackageId: jest.fn(() => '0xabc'),
  getNetworkConfig: jest.fn(() => ({ rpcUrl: 'https://rpc.invalid' })),
}));

jest.mock('../circle-service', () => ({
  getCircleTransactionPackageId: jest.fn(),
}));

function installBrowserGlobals(): void {
  const store = new Map<string, string>();
  (global as unknown as { window: unknown }).window = {
    location: { origin: 'https://njangionchain.com' },
    sessionStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
  };
}

function lastRequestBody(): Record<string, unknown> {
  const calls = (global.fetch as jest.Mock).mock.calls;
  return JSON.parse(calls[calls.length - 1][1].body);
}

describe('zkLogin login protocol', () => {
  beforeEach(() => {
    installBrowserGlobals();
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ loginUrl: 'https://accounts.google.com/o/oauth2/v2/auth?nonce=abc', maxEpoch: 99 }),
    } as Response)) as unknown as typeof fetch;
  });

  afterAll(() => {
    Reflect.deleteProperty(global as unknown as Record<string, unknown>, 'window');
  });

  describe('beginLogin', () => {
    it('sends the ephemeral PUBLIC key and randomness, and no private key', async () => {
      await ZkLoginClient.getInstance().beginLogin('Google');

      const body = lastRequestBody();
      expect(body.action).toBe('beginLogin');
      expect(body.ephemeralPublicKey).toEqual(expect.any(String));
      expect(body.randomness).toEqual(expect.any(String));

      // The whole point. Assert on the serialized payload, not the object, so
      // a nested or renamed field cannot slip a secret through.
      const pending = loadPendingLogin();
      expect(pending?.ephemeralPrivateKey).toEqual(expect.any(String));

      const raw = (global.fetch as jest.Mock).mock.calls[0][1].body as string;
      expect(raw).not.toContain(pending!.ephemeralPrivateKey);
      expect(raw.toLowerCase()).not.toContain('privatekey');
      expect(raw.toLowerCase()).not.toContain('secret');
    });

    it('does not send a client-computed nonce', async () => {
      // The server derives the nonce itself. Accepting one from the client
      // would let a caller bind the OAuth challenge to a key the server never
      // validated.
      await ZkLoginClient.getInstance().beginLogin('Google');
      expect(lastRequestBody()).not.toHaveProperty('nonce');
    });

    it('retains the private key locally so the callback can complete', async () => {
      await ZkLoginClient.getInstance().beginLogin('Facebook');

      const pending = loadPendingLogin();
      expect(pending).toMatchObject({ network: 'testnet', provider: 'Facebook', maxEpoch: 99 });
      expect(pending?.ephemeralPrivateKey).toEqual(expect.any(String));
    });

    it('leaves no pending login behind when the server rejects the key', async () => {
      global.fetch = jest.fn(async () => ({
        ok: false,
        status: 400,
        text: async () => 'bad key',
      } as Response)) as unknown as typeof fetch;

      await expect(ZkLoginClient.getInstance().beginLogin('Google')).rejects.toThrow('bad key');
      expect(loadPendingLogin()).toBeNull();
    });
  });

  describe('legacy server-signing actions', () => {
    it('never posts an account without stripping the signing key', () => {
      // Asserted against the SOURCE rather than by calling one method,
      // because the set of methods that still POST shrinks with every
      // migration — a test pinned to one of them keeps breaking for the
      // right reason and gets "fixed" by repointing it, which is how the
      // guarantee quietly stops being checked.
      //
      // The rule: if a request body carries `account`, it must be
      // `withoutSigningKey(account)`. A raw `account,` in a POST body would
      // put a live ephemeral key into edge, WAF and APM logs.
      const src = readFileSync(
        join(process.cwd(), 'src/services/zkLoginClient.ts'),
        'utf8',
      );

      const bodies = [...src.matchAll(/JSON\.stringify\(\{([\s\S]*?)\}\)/g)].map(
        (m) => m[1],
      );
      expect(bodies.length).toBeGreaterThan(0);

      const leaking = bodies.filter((b) => /(^|[\s,{])account\s*,/.test(b));
      expect(leaking).toEqual([]);
    });

    it('never references the private key field in a request body', () => {
      const src = readFileSync(
        join(process.cwd(), 'src/services/zkLoginClient.ts'),
        'utf8',
      );
      const bodies = [...src.matchAll(/JSON\.stringify\(\{([\s\S]*?)\}\)/g)].map(
        (m) => m[1],
      );
      expect(bodies.filter((b) => b.includes('ephemeralPrivateKey'))).toEqual([]);
    });
  });

  describe('handleCallback', () => {
    const serverAccount = {
      provider: 'Google',
      userAddr: '0xaaa',
      zkProofs: { proofPoints: { a: [], b: [], c: [] }, issBase64Details: {}, headerBase64: 'h' },
      userSalt: '1',
      sub: 'sub',
      aud: 'aud',
      maxEpoch: 99,
    } as unknown as AccountData;

    it('merges the browser-held key into the account the server returns', async () => {
      savePendingLogin({
        ephemeralPrivateKey: 'suiprivkey-local',
        ephemeralPublicKey: 'pub',
        randomness: 'r',
        maxEpoch: 99,
        network: 'testnet',
        provider: 'Google',
      });

      global.fetch = jest.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => serverAccount,
      } as Response)) as unknown as typeof fetch;

      const account = await ZkLoginClient.getInstance().handleCallback('jwt');

      // The server's payload had no key; the signable account does.
      expect(serverAccount.ephemeralPrivateKey).toBeUndefined();
      expect(account.ephemeralPrivateKey).toBe('suiprivkey-local');

      // Consumed, so a later callback cannot reuse a stale key.
      expect(loadPendingLogin()).toBeNull();
    });

    it('fails with a re-login prompt when the redirect landed in another context', async () => {
      // No pending login: this is the stranded-key case the in-app-browser
      // handoff is designed to prevent.
      global.fetch = jest.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => serverAccount,
      } as Response)) as unknown as typeof fetch;

      await expect(ZkLoginClient.getInstance().handleCallback('jwt')).rejects.toThrow(
        /could not be completed in this browser tab/,
      );
    });
  });
});
