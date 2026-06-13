import { resolvePublicEnvFromRaw, resetPublicEnvWarningsForTests } from '@/config/public-env';

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
      NEXT_PUBLIC_ENOKI_TESTNET: 'testnet-enoki',
      NEXT_PUBLIC_ENOKI_MAINNET: 'mainnet-enoki',
      NEXT_PUBLIC_PACKAGE_ID: '0xtestnet',
      NEXT_PUBLIC_WHATSAPP_PACKAGE_ID: '0xwa-testnet',
      NEXT_PUBLIC_WHATSAPP_REGISTRY_ID: '0xregistry-testnet',
      NEXT_PUBLIC_ENOKI: 'testnet-enoki',
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
      NEXT_PUBLIC_ENOKI_TESTNET: '',
      NEXT_PUBLIC_ENOKI_MAINNET: 'mainnet-enoki',
      NEXT_PUBLIC_PACKAGE_ID: '0xtestnet',
      NEXT_PUBLIC_WHATSAPP_PACKAGE_ID: '0xwa-testnet',
      NEXT_PUBLIC_WHATSAPP_REGISTRY_ID: '0xregistry-testnet',
      NEXT_PUBLIC_ENOKI: 'testnet-enoki',
      NEXT_PUBLIC_SUI_RPC_URL: 'https://rpc.testnet.example',
    } as never);

    expect(env.networks.testnet.packageId).toBe('0xtestnet');
    expect(env.networks.testnet.rpcUrl).toBe('https://rpc.testnet.example');
    expect(warnSpy).toHaveBeenCalled();
  });

  it('prefers the server-only ENOKI_API_KEY_* over the bundled NEXT_PUBLIC_ENOKI_*', () => {
    const env = resolvePublicEnvFromRaw({
      NEXT_PUBLIC_SUI_NETWORK: 'testnet',
      NEXT_PUBLIC_TESTNET_PACKAGE_ID: '0xtestnet',
      NEXT_PUBLIC_MAINNET_PACKAGE_ID: '0xmainnet',
      NEXT_PUBLIC_TESTNET_WHATSAPP_PACKAGE_ID: '0xwa-testnet',
      NEXT_PUBLIC_MAINNET_WHATSAPP_PACKAGE_ID: '0xwa-mainnet',
      NEXT_PUBLIC_TESTNET_WHATSAPP_REGISTRY_ID: '0xregistry-testnet',
      NEXT_PUBLIC_MAINNET_WHATSAPP_REGISTRY_ID: '0xregistry-mainnet',
      // Server-only keys present, no NEXT_PUBLIC_ENOKI_* → nothing leaks.
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

  it('falls back to the deprecated NEXT_PUBLIC_ENOKI_* with a warning (transition)', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    const env = resolvePublicEnvFromRaw({
      NEXT_PUBLIC_SUI_NETWORK: 'testnet',
      NEXT_PUBLIC_TESTNET_PACKAGE_ID: '0xtestnet',
      NEXT_PUBLIC_MAINNET_PACKAGE_ID: '0xmainnet',
      NEXT_PUBLIC_TESTNET_WHATSAPP_PACKAGE_ID: '0xwa-testnet',
      NEXT_PUBLIC_MAINNET_WHATSAPP_PACKAGE_ID: '0xwa-mainnet',
      NEXT_PUBLIC_TESTNET_WHATSAPP_REGISTRY_ID: '0xregistry-testnet',
      NEXT_PUBLIC_MAINNET_WHATSAPP_REGISTRY_ID: '0xregistry-mainnet',
      NEXT_PUBLIC_ENOKI_TESTNET: 'enoki_private_public_bundle',
    } as never);

    expect(env.networks.testnet.enokiApiKey).toBe('enoki_private_public_bundle');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('ENOKI_API_KEY_TESTNET'),
    );
  });

  it('throws when the server enoki key conflicts with the bundled alias', () => {
    expect(() =>
      resolvePublicEnvFromRaw({
        NEXT_PUBLIC_SUI_NETWORK: 'testnet',
        NEXT_PUBLIC_TESTNET_PACKAGE_ID: '0xtestnet',
        NEXT_PUBLIC_MAINNET_PACKAGE_ID: '0xmainnet',
        NEXT_PUBLIC_TESTNET_WHATSAPP_PACKAGE_ID: '0xwa-testnet',
        NEXT_PUBLIC_MAINNET_WHATSAPP_PACKAGE_ID: '0xwa-mainnet',
        NEXT_PUBLIC_TESTNET_WHATSAPP_REGISTRY_ID: '0xregistry-testnet',
        NEXT_PUBLIC_MAINNET_WHATSAPP_REGISTRY_ID: '0xregistry-mainnet',
        ENOKI_API_KEY_TESTNET: 'enoki_private_server',
        NEXT_PUBLIC_ENOKI_TESTNET: 'enoki_private_different',
      } as never),
    ).toThrow(/ENOKI_API_KEY_TESTNET/);
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
        NEXT_PUBLIC_ENOKI_TESTNET: 'testnet-enoki',
        NEXT_PUBLIC_ENOKI_MAINNET: 'mainnet-enoki',
      } as never),
    ).toThrow(/NEXT_PUBLIC_TESTNET_PACKAGE_ID/);
  });
});
