/**
 * NJA-3380: while NEXT_PUBLIC_NETWORK_SWITCH_ENABLED is unset, switchNetwork
 * refuses out loud and changes nothing: the configured network stays, the
 * member stays signed in, and a stored 'sui-network' is left in place so
 * turning the flag on restores it. With the flag on, today's behaviour holds.
 *
 * Same harness as network-switch-flag.test.ts: testEnvironment 'node', so
 * `window` and `localStorage` are installed by hand, and network-config is
 * loaded fresh per case (jest.resetModules plus a dynamic import). No
 * require() and no eslint-disable directives.
 */
import type { NetworkType } from '../../config/public-env';

const ENV_KEYS = ['NEXT_PUBLIC_SUI_NETWORK', 'NEXT_PUBLIC_NETWORK_SWITCH_ENABLED'] as const;
const savedEnv: Record<string, string | undefined> = {};

function installBrowserGlobals(stored: Record<string, string>): Map<string, string> {
  const store = new Map(Object.entries(stored));
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
  };
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'window', {
    value: { localStorage: storage },
    configurable: true,
    writable: true,
  });
  return store;
}

async function loadNetworkConfig() {
  jest.resetModules();
  return import('../../services/network-config');
}

let warn: jest.SpyInstance;

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  // validateNetworkConfig reports the package ids this test env leaves unset.
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
  Reflect.deleteProperty(globalThis, 'window');
  Reflect.deleteProperty(globalThis, 'localStorage');
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('switchNetwork while NEXT_PUBLIC_NETWORK_SWITCH_ENABLED is unset', () => {
  it('refuses out loud, keeps the session and leaves the stored choice in place', async () => {
    process.env.NEXT_PUBLIC_SUI_NETWORK = 'mainnet';
    const stored: NetworkType = 'testnet';
    const store = installBrowserGlobals({
      'sui-network': stored,
      'zklogin-session': 'session',
      'account-data': 'account',
    });

    const { getCurrentNetwork, switchNetwork } = await loadNetworkConfig();
    switchNetwork(stored);

    expect(getCurrentNetwork()).toBe('mainnet');
    expect(store.get('sui-network')).toBe(stored);
    expect(store.get('zklogin-session')).toBe('session');
    expect(store.get('account-data')).toBe('account');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('NEXT_PUBLIC_NETWORK_SWITCH_ENABLED'));
  });
});

describe('switchNetwork while NEXT_PUBLIC_NETWORK_SWITCH_ENABLED is on', () => {
  it('keeps the current behaviour: the switch is stored and the session cleared', async () => {
    process.env.NEXT_PUBLIC_NETWORK_SWITCH_ENABLED = 'true';
    process.env.NEXT_PUBLIC_SUI_NETWORK = 'mainnet';
    const store = installBrowserGlobals({
      'sui-network': 'mainnet',
      'zklogin-session': 'session',
      'account-data': 'account',
    });

    const { getCurrentNetwork, switchNetwork } = await loadNetworkConfig();
    switchNetwork('testnet');

    expect(getCurrentNetwork()).toBe('testnet');
    expect(store.get('sui-network')).toBe('testnet');
    expect(store.has('zklogin-session')).toBe(false);
    expect(store.has('account-data')).toBe(false);
  });
});
