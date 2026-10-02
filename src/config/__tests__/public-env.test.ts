import { readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';
import {
  getResolvedPublicEnv,
  resolvePublicEnvFromRaw,
  resetPublicEnvWarningsForTests,
} from '@/config/public-env';

describe('public env resolution', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    resetPublicEnvWarningsForTests();
  });

  it('prefers canonical values when legacy aliases match', () => {
    const env = resolvePublicEnvFromRaw({
      NEXT_PUBLIC_SUI_NETWORK: 'testnet',
      NEXT_PUBLIC_TESTNET_RPC_URL: 'https://rpc.testnet.example',
      NEXT_PUBLIC_MAINNET_RPC_URL: 'https://rpc.mainnet.example',
      NEXT_PUBLIC_TESTNET_PACKAGE_ID: '0xtestnet',
      NEXT_PUBLIC_MAINNET_PACKAGE_ID: '0xmainnet',
      NEXT_PUBLIC_TESTNET_WHATSAPP_PACKAGE_ID: '0xwa-testnet',
      NEXT_PUBLIC_MAINNET_WHATSAPP_PACKAGE_ID: '0xwa-mainnet',
      NEXT_PUBLIC_TESTNET_WHATSAPP_REGISTRY_ID: '0xregistry-testnet',
      NEXT_PUBLIC_MAINNET_WHATSAPP_REGISTRY_ID: '0xregistry-mainnet',
      NEXT_PUBLIC_PACKAGE_ID: '0xtestnet',
      NEXT_PUBLIC_WHATSAPP_PACKAGE_ID: '0xwa-testnet',
      NEXT_PUBLIC_WHATSAPP_REGISTRY_ID: '0xregistry-testnet',
    } as never);

    expect(env.currentNetwork).toBe('testnet');
    expect(env.networks.testnet.packageId).toBe('0xtestnet');
    expect(env.networks.testnet.whatsappRegistryId).toBe('0xregistry-testnet');
    expect(env.networks.mainnet.packageId).toBe('0xmainnet');
  });

  it('maps active-network legacy aliases and emits a warning', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    const env = resolvePublicEnvFromRaw({
      NEXT_PUBLIC_SUI_NETWORK: 'testnet',
      NEXT_PUBLIC_MAINNET_RPC_URL: 'https://rpc.mainnet.example',
      NEXT_PUBLIC_TESTNET_RPC_URL: '',
      NEXT_PUBLIC_TESTNET_PACKAGE_ID: '',
      NEXT_PUBLIC_MAINNET_PACKAGE_ID: '0xmainnet',
      NEXT_PUBLIC_TESTNET_WHATSAPP_PACKAGE_ID: '',
      NEXT_PUBLIC_MAINNET_WHATSAPP_PACKAGE_ID: '0xwa-mainnet',
      NEXT_PUBLIC_TESTNET_WHATSAPP_REGISTRY_ID: '',
      NEXT_PUBLIC_MAINNET_WHATSAPP_REGISTRY_ID: '0xregistry-mainnet',
      NEXT_PUBLIC_PACKAGE_ID: '0xtestnet',
      NEXT_PUBLIC_WHATSAPP_PACKAGE_ID: '0xwa-testnet',
      NEXT_PUBLIC_WHATSAPP_REGISTRY_ID: '0xregistry-testnet',
      NEXT_PUBLIC_SUI_RPC_URL: 'https://rpc.testnet.example',
    } as never);

    expect(env.networks.testnet.packageId).toBe('0xtestnet');
    expect(env.networks.testnet.rpcUrl).toBe('https://rpc.testnet.example');
    expect(warnSpy).toHaveBeenCalled();
  });

  it('reads the Enoki key from the server-only ENOKI_API_KEY_*', () => {
    const env = resolvePublicEnvFromRaw({
      NEXT_PUBLIC_SUI_NETWORK: 'testnet',
      NEXT_PUBLIC_TESTNET_PACKAGE_ID: '0xtestnet',
      NEXT_PUBLIC_MAINNET_PACKAGE_ID: '0xmainnet',
      NEXT_PUBLIC_TESTNET_WHATSAPP_PACKAGE_ID: '0xwa-testnet',
      NEXT_PUBLIC_MAINNET_WHATSAPP_PACKAGE_ID: '0xwa-mainnet',
      NEXT_PUBLIC_TESTNET_WHATSAPP_REGISTRY_ID: '0xregistry-testnet',
      NEXT_PUBLIC_MAINNET_WHATSAPP_REGISTRY_ID: '0xregistry-mainnet',
      ENOKI_API_KEY_TESTNET: 'enoki_private_server_testnet',
      ENOKI_API_KEY_MAINNET: 'enoki_private_server_mainnet',
    } as never);

    expect(env.networks.testnet.enokiApiKey).toBe('enoki_private_server_testnet');
    expect(env.networks.mainnet.enokiApiKey).toBe('enoki_private_server_mainnet');
  });

  it('resolves enoki to empty on the client when only the server key is set', () => {
    // Simulates the browser bundle: ENOKI_API_KEY_* is stripped by Next
    // (non-NEXT_PUBLIC), so raw has neither the server var nor a public one.
    const env = resolvePublicEnvFromRaw({
      NEXT_PUBLIC_SUI_NETWORK: 'testnet',
      NEXT_PUBLIC_TESTNET_PACKAGE_ID: '0xtestnet',
      NEXT_PUBLIC_MAINNET_PACKAGE_ID: '0xmainnet',
      NEXT_PUBLIC_TESTNET_WHATSAPP_PACKAGE_ID: '0xwa-testnet',
      NEXT_PUBLIC_MAINNET_WHATSAPP_PACKAGE_ID: '0xwa-mainnet',
      NEXT_PUBLIC_TESTNET_WHATSAPP_REGISTRY_ID: '0xregistry-testnet',
      NEXT_PUBLIC_MAINNET_WHATSAPP_REGISTRY_ID: '0xregistry-mainnet',
    } as never);

    expect(env.networks.testnet.enokiApiKey).toBe('');
    expect(env.networks.mainnet.enokiApiKey).toBe('');
  });

  it('throws when canonical and legacy values conflict', () => {
    expect(() =>
      resolvePublicEnvFromRaw({
        NEXT_PUBLIC_SUI_NETWORK: 'testnet',
        NEXT_PUBLIC_TESTNET_PACKAGE_ID: '0xcanonical',
        NEXT_PUBLIC_PACKAGE_ID: '0xlegacy',
        NEXT_PUBLIC_MAINNET_PACKAGE_ID: '0xmainnet',
        NEXT_PUBLIC_TESTNET_WHATSAPP_PACKAGE_ID: '0xwa-testnet',
        NEXT_PUBLIC_MAINNET_WHATSAPP_PACKAGE_ID: '0xwa-mainnet',
        NEXT_PUBLIC_TESTNET_WHATSAPP_REGISTRY_ID: '0xregistry-testnet',
        NEXT_PUBLIC_MAINNET_WHATSAPP_REGISTRY_ID: '0xregistry-mainnet',
      } as never),
    ).toThrow(/NEXT_PUBLIC_TESTNET_PACKAGE_ID/);
  });
});

/**
 * The NEXT_PUBLIC_ENOKI* aliases were removed, not deprecated: Next.js inlines
 * every NEXT_PUBLIC_* variable the code reads into the client bundle, which is
 * how the Enoki private key leaked before its 2026-07-04 rotation. These cases
 * set the real process.env and go through getResolvedPublicEnv(), the app's
 * own path.
 */
describe('removed NEXT_PUBLIC_ENOKI* aliases', () => {
  const KEYS = [
    'ENOKI_API_KEY_TESTNET',
    'ENOKI_API_KEY_MAINNET',
    'NEXT_PUBLIC_ENOKI_TESTNET',
    'NEXT_PUBLIC_ENOKI_MAINNET',
    'NEXT_PUBLIC_ENOKI',
  ] as const;
  const original: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of KEYS) {
      original[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (original[k] === undefined) delete process.env[k];
      else process.env[k] = original[k];
    }
    resetPublicEnvWarningsForTests();
  });

  it('are ignored: no fallback key and no deprecation warning', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    process.env.NEXT_PUBLIC_ENOKI_TESTNET = 'enoki_private_legacy_testnet';
    process.env.NEXT_PUBLIC_ENOKI_MAINNET = 'enoki_private_legacy_mainnet';
    process.env.NEXT_PUBLIC_ENOKI = 'enoki_private_legacy';

    const env = getResolvedPublicEnv();

    expect(env.networks.testnet.enokiApiKey).toBe('');
    expect(env.networks.mainnet.enokiApiKey).toBe('');
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('ENOKI'));
  });

  it('no longer conflict with the server key', () => {
    // A stale alias next to the server key used to throw "Conflicting
    // environment values", which failed every Preview build for ~29 days
    // until the alias was deleted on 2026-08-02.
    process.env.ENOKI_API_KEY_TESTNET = 'enoki_private_server';
    process.env.NEXT_PUBLIC_ENOKI_TESTNET = 'enoki_private_revoked';
    process.env.NEXT_PUBLIC_ENOKI = 'enoki_private_revoked';

    expect(getResolvedPublicEnv().networks.testnet.enokiApiKey).toBe('enoki_private_server');
  });
});

/**
 * Source guard: removing the reads is the fix, so nothing that ships may name
 * a NEXT_PUBLIC_*ENOKI* variable again (a one-line "fallback" would put the key
 * back in every browser). Comments may mention the names; tests may set them.
 */
describe('shipped code never names a NEXT_PUBLIC_*ENOKI* variable', () => {
  const REPO_ROOT = path.resolve(__dirname, '../../..');
  const CODE_FILE = /\.[cm]?[jt]sx?$/;

  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry !== '__tests__') walk(full, out);
      } else if (CODE_FILE.test(entry) && !entry.includes('.test.')) {
        out.push(full);
      }
    }
    return out;
  }

  const stripComments = (source: string): string =>
    source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  const files = [
    ...walk(path.join(REPO_ROOT, 'src')),
    path.join(REPO_ROOT, 'next.config.js'),
    path.join(REPO_ROOT, 'sentry.client.config.ts'),
  ];

  it('scans the app source', () => {
    expect(files).toContain(path.join(REPO_ROOT, 'src/config/public-env.ts'));
    expect(files.length).toBeGreaterThan(100);
  });

  it('finds no NEXT_PUBLIC_*ENOKI* outside comments', () => {
    const offenders = files.filter((file) =>
      /NEXT_PUBLIC_\w*ENOKI/.test(stripComments(readFileSync(file, 'utf8'))),
    );

    expect(offenders.map((file) => path.relative(REPO_ROOT, file))).toEqual([]);
  });
});
