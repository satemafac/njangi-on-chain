/**
 * NJA-3332 — the Testnet/Mainnet switch sits behind a default-off flag.
 *
 * With NEXT_PUBLIC_NETWORK_SWITCH_ENABLED unset, the deployment's network
 * (NEXT_PUBLIC_SUI_NETWORK) is the only one in use: a 'sui-network' value
 * left in localStorage by an earlier switch must be ignored, and
 * setCurrentNetwork() must neither store a choice nor move off the
 * configured network. Today getCurrentNetwork() reads localStorage on every
 * client-side call and lets it override the configured network
 * (src/services/network-config.ts, getCurrentNetwork / setCurrentNetwork),
 * and the flag itself does not exist in src/config/feature-flags.ts.
 *
 * Runs in jest's node environment: `window` and `localStorage` are stood up
 * per test so the client-side branch is exercised. Nothing is fetched; the
 * coin-type resolver is stubbed so the config build needs no USDC env.
 */

jest.mock('../../config/coin-types', () => ({
  SUI_COIN_TYPE: '0x2::sui::SUI',
  usdcCoinTypeForNetwork: (network: 'testnet' | 'mainnet') => `0x${network}::usdc::USDC`,
}));

type NetworkConfigModule = typeof import('../../services/network-config');
type FeatureFlagsModule = typeof import('../../config/feature-flags');

// Env keys this test sets or clears; restored after each test. The legacy
// aliases are cleared so public-env resolution is deterministic here.
const ENV_KEYS = [
  'NEXT_PUBLIC_SUI_NETWORK',
  'NEXT_PUBLIC_NETWORK_SWITCH_ENABLED',
  'NEXT_PUBLIC_PACKAGE_ID',
  'NEXT_PUBLIC_WHATSAPP_PACKAGE_ID',
  'NEXT_PUBLIC_WHATSAPP_REGISTRY_ID',
  'NEXT_PUBLIC_SUI_RPC_URL',
  'NEXT_PUBLIC_SUI_GRAPHQL_URL',
  'SUI_GRAPHQL_URL',
  'SUI_WHATSAPP_LINKS_REGISTRY_ID',
  'TESTNET_GRAPHQL_URL',
  'MAINNET_GRAPHQL_URL',
] as const;

const savedEnv: Record<string, string | undefined> = {};

function makeStorage(initial: Record<string, string>) {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    getItem: (key: string): string | null => (store.has(key) ? (store.get(key) as string) : null),
    setItem: (key: string, value: string): void => {
      store.set(key, String(value));
    },
    removeItem: (key: string): void => {
      store.delete(key);
    },
    clear: (): void => store.clear(),
    key: (index: number): string | null => Array.from(store.keys())[index] ?? null,
    get length(): number {
      return store.size;
    },
  };
}

type FakeStorage = ReturnType<typeof makeStorage>;

function installBrowserGlobals(storage: FakeStorage): void {
  Object.defineProperty(globalThis, 'localStorage', {
    value: storage,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, 'window', {
    value: globalThis,
    configurable: true,
    writable: true,
  });
}

function removeBrowserGlobals(): void {
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { localStorage?: unknown }).localStorage;
}

interface LoadOptions {
  configuredNetwork: 'testnet' | 'mainnet';
  switchFlag?: string;
  stored?: Record<string, string>;
}

/**
 * Loads fresh copies of network-config and feature-flags with the given
 * env and localStorage contents, so the module-level `currentNetwork`
 * is initialised under this test's environment.
 */
function loadWith(options: LoadOptions): {
  networkConfig: NetworkConfigModule;
  featureFlags: FeatureFlagsModule;
  storage: FakeStorage;
} {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
  process.env.NEXT_PUBLIC_SUI_NETWORK = options.configuredNetwork;
  if (options.switchFlag !== undefined) {
    process.env.NEXT_PUBLIC_NETWORK_SWITCH_ENABLED = options.switchFlag;
  }

  const storage = makeStorage(options.stored ?? {});
  installBrowserGlobals(storage);

  let networkConfig!: NetworkConfigModule;
  let featureFlags!: FeatureFlagsModule;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    networkConfig = require('../../services/network-config') as NetworkConfigModule;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    featureFlags = require('../../config/feature-flags') as FeatureFlagsModule;
  });

  return { networkConfig, featureFlags, storage };
}

describe('NJA-3332: network switch behind NEXT_PUBLIC_NETWORK_SWITCH_ENABLED', () => {
  beforeEach(() => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
    }
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    removeBrowserGlobals();
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  it('flag unset: getCurrentNetwork() and getCurrentNetworkConfig() follow NEXT_PUBLIC_SUI_NETWORK even with a different stored sui-network', () => {
    const { networkConfig } = loadWith({
      configuredNetwork: 'mainnet',
      stored: { 'sui-network': 'testnet' },
    });

    // Today this returns 'testnet': the stored choice overrides the
    // deployment's network on every client-side read.
    expect(networkConfig.getCurrentNetwork()).toBe('mainnet');
    expect(networkConfig.getCurrentNetworkConfig().enoki.network).toBe('mainnet');
  });

  it('flag unset: setCurrentNetwork() neither stores a choice nor leaves the configured network', () => {
    const { networkConfig, storage } = loadWith({ configuredNetwork: 'mainnet' });

    networkConfig.setCurrentNetwork('testnet');

    expect(storage.getItem('sui-network')).toBeNull();
    expect(networkConfig.getCurrentNetwork()).toBe('mainnet');
  });

  it('flag unset: isNetworkSwitchEnabled() exists in feature-flags and is off', () => {
    const { featureFlags } = loadWith({ configuredNetwork: 'mainnet' });
    const flags = featureFlags as unknown as Record<string, unknown>;

    expect(typeof flags.isNetworkSwitchEnabled).toBe('function');
    expect((flags.isNetworkSwitchEnabled as () => boolean)()).toBe(false);
  });

  it('flag on: a stored sui-network choice still wins (today\'s behaviour, unchanged)', () => {
    const { networkConfig } = loadWith({
      configuredNetwork: 'mainnet',
      switchFlag: 'true',
      stored: { 'sui-network': 'testnet' },
    });

    expect(networkConfig.getCurrentNetwork()).toBe('testnet');
    expect(networkConfig.getCurrentNetworkConfig().enoki.network).toBe('testnet');
  });

  it('flag unset: switchNetwork() neither switches, stores a choice, nor clears the session', () => {
    const { networkConfig, storage } = loadWith({
      configuredNetwork: 'mainnet',
      stored: { 'zklogin-session': 'session', 'account-data': 'account' },
    });

    networkConfig.switchNetwork('testnet');

    expect(storage.getItem('sui-network')).toBeNull();
    expect(storage.getItem('zklogin-session')).toBe('session');
    expect(storage.getItem('account-data')).toBe('account');
    expect(networkConfig.getCurrentNetwork()).toBe('mainnet');
  });

  it('flag malformed: anything but "true" keeps the switch off', () => {
    const { networkConfig, featureFlags } = loadWith({
      configuredNetwork: 'mainnet',
      switchFlag: 'yes',
      stored: { 'sui-network': 'testnet' },
    });

    expect(featureFlags.isNetworkSwitchEnabled()).toBe(false);
    expect(networkConfig.getCurrentNetwork()).toBe('mainnet');
  });

  it('server side (no window): the configured network is used regardless of the flag', () => {
    const { networkConfig } = loadWith({ configuredNetwork: 'testnet' });
    removeBrowserGlobals();

    expect(networkConfig.getCurrentNetwork()).toBe('testnet');
  });
});
