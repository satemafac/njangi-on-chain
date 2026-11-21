/**
 * NJA-3380 (refile of NJA-3332 / NJA-2818): the Testnet/Mainnet switch must sit
 * behind a default-off flag, NEXT_PUBLIC_NETWORK_SWITCH_ENABLED.
 *
 * While the flag is unset:
 *   - getCurrentNetwork() and getCurrentNetworkConfig() follow
 *     NEXT_PUBLIC_SUI_NETWORK even when localStorage holds a different
 *     'sui-network'. Today src/services/network-config.ts getCurrentNetwork()
 *     (L152-161) reads the stored value unconditionally, so it wins.
 *   - setCurrentNetwork() neither stores a choice nor leaves the configured
 *     network. Today (L164-170) it does both.
 *   - LandingHeader renders no network control. Today it always renders the
 *     Testnet/Mainnet group (L71 desktop, L84 mobile sheet).
 * With the flag set to 'true', today's behaviour is unchanged.
 *
 * jest runs with testEnvironment 'node', so `window` and `localStorage` are
 * installed by hand. network-config keeps module-level state initialised from
 * the env at import time, so every case loads it fresh (jest.resetModules plus
 * a dynamic import). No require() and no eslint-disable directives: PR #156
 * failed the app's ESLint (@typescript-eslint/no-require-imports) on those.
 */
import type { ReactNode } from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { NetworkType } from '../../config/public-env';
import LandingHeader from '../../components/landing/LandingHeader';

type SiteHeaderStubProps = {
  controls?: ReactNode;
  sheetExtras?: (close: () => void) => ReactNode;
};

// SiteHeader pulls in next/font/google, next/image and Radix, none of which
// load under node. The stub renders the two slots LandingHeader fills, which
// is where the network control lives.
jest.mock('../../components/landing/SiteHeader', () => {
  const { createElement: h } = jest.requireActual<typeof import('react')>('react');
  return {
    __esModule: true,
    default: ({ controls, sheetExtras }: SiteHeaderStubProps) =>
      h('div', null, controls, sheetExtras ? sheetExtras(() => undefined) : null),
  };
});
jest.mock('../../components/ui/LocaleSwitcher', () => ({ LocaleSwitcher: () => null }));
jest.mock('../../components/landing/ui', () => ({ focusRing: '' }));

const ENV_KEYS = ['NEXT_PUBLIC_SUI_NETWORK', 'NEXT_PUBLIC_NETWORK_SWITCH_ENABLED'] as const;
const savedEnv: Record<string, string | undefined> = {};

/** A browser-shaped global: `window` plus the bare `localStorage` the code reads. */
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
    clear: () => {
      store.clear();
    },
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size;
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

function removeBrowserGlobals(): void {
  Reflect.deleteProperty(globalThis, 'window');
  Reflect.deleteProperty(globalThis, 'localStorage');
}

async function loadNetworkConfig() {
  jest.resetModules();
  return import('../../services/network-config');
}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  // getCurrentNetworkConfig and setCurrentNetwork log on every call.
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  removeBrowserGlobals();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('NEXT_PUBLIC_NETWORK_SWITCH_ENABLED', () => {
  it('is exposed as isNetworkSwitchEnabled, OFF by default and on only for an explicit true', async () => {
    jest.resetModules();
    const flags = (await import('../../config/feature-flags')) as unknown as Record<string, unknown>;
    const isNetworkSwitchEnabled = flags.isNetworkSwitchEnabled as (() => boolean) | undefined;

    expect(typeof isNetworkSwitchEnabled).toBe('function');
    expect(isNetworkSwitchEnabled?.()).toBe(false);

    for (const v of ['true', 'TRUE', ' true ', 'True']) {
      process.env.NEXT_PUBLIC_NETWORK_SWITCH_ENABLED = v;
      expect(isNetworkSwitchEnabled?.()).toBe(true);
    }
    for (const v of ['false', '1', 'yes', 'on', 'enabled', 'tru', '', ' ']) {
      process.env.NEXT_PUBLIC_NETWORK_SWITCH_ENABLED = v;
      expect(isNetworkSwitchEnabled?.()).toBe(false);
    }
  });
});

describe('network-config while the flag is unset', () => {
  const CASES: Array<[configured: NetworkType, stored: NetworkType]> = [
    ['mainnet', 'testnet'],
    ['testnet', 'mainnet'],
  ];

  it.each(CASES)(
    'follows NEXT_PUBLIC_SUI_NETWORK=%s even with sui-network=%s stored',
    async (configured, stored) => {
      process.env.NEXT_PUBLIC_SUI_NETWORK = configured;
      installBrowserGlobals({ 'sui-network': stored });

      const { getCurrentNetwork, getCurrentNetworkConfig, getNetworkConfig } = await loadNetworkConfig();

      expect(getCurrentNetwork()).toBe(configured);
      expect(getCurrentNetworkConfig().enoki.network).toBe(configured);
      expect(getCurrentNetworkConfig().rpcUrl).toBe(getNetworkConfig(configured).rpcUrl);
    },
  );

  it('neither stores a choice nor leaves the configured network on setCurrentNetwork', async () => {
    process.env.NEXT_PUBLIC_SUI_NETWORK = 'mainnet';
    const store = installBrowserGlobals({});

    const { getCurrentNetwork, setCurrentNetwork } = await loadNetworkConfig();
    setCurrentNetwork('testnet');

    expect(getCurrentNetwork()).toBe('mainnet');
    expect(store.has('sui-network')).toBe(false);
  });

  it('follows the configured network on the server, where there is no window', async () => {
    process.env.NEXT_PUBLIC_SUI_NETWORK = 'mainnet';

    const { getCurrentNetwork } = await loadNetworkConfig();

    expect(getCurrentNetwork()).toBe('mainnet');
  });
});

describe('network-config while the flag is on', () => {
  it('keeps the current behaviour: the stored choice wins and a switch is stored', async () => {
    process.env.NEXT_PUBLIC_NETWORK_SWITCH_ENABLED = 'true';
    process.env.NEXT_PUBLIC_SUI_NETWORK = 'mainnet';
    const store = installBrowserGlobals({ 'sui-network': 'testnet' });

    const { getCurrentNetwork, getCurrentNetworkConfig, setCurrentNetwork } = await loadNetworkConfig();

    expect(getCurrentNetwork()).toBe('testnet');
    expect(getCurrentNetworkConfig().enoki.network).toBe('testnet');

    setCurrentNetwork('mainnet');
    expect(store.get('sui-network')).toBe('mainnet');
    expect(getCurrentNetwork()).toBe('mainnet');
  });
});

describe('LandingHeader while the flag is unset', () => {
  it('renders no Testnet/Mainnet control', () => {
    const html = renderToStaticMarkup(
      createElement(LandingHeader, {
        signedIn: false,
        network: 'testnet',
        onSwitchNetwork: () => undefined,
        onLogin: () => undefined,
        t: (key: string) => key,
      }),
    );

    expect(html).not.toContain('aria-pressed=');
    expect(html).not.toContain('role="group"');
    expect(html).not.toMatch(/<button/);
  });
});
