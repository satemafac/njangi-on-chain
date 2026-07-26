import fs from 'fs';
import path from 'path';
import {
  findRepoRoot,
  resetBotEnvWarningsForTests,
  resolveBotRuntimeEnvFromProcessEnv,
  resolveLocalEnvFilePath,
} from '..';

const realExistsSync = fs.existsSync;

describe('bot env resolution', () => {
  const repoRoot = path.resolve(__dirname, '../../../../');
  const backendDir = path.join(repoRoot, 'whatsapp-bot-backend');

  afterEach(() => {
    jest.restoreAllMocks();
    resetBotEnvWarningsForTests();
  });

  it('finds the repo root from both repo and backend directories', () => {
    expect(findRepoRoot(repoRoot)).toBe(repoRoot);
    expect(findRepoRoot(backendDir)).toBe(repoRoot);
  });

  it('defaults to the root .env.local for local bot runs', () => {
    // `.env.local` is gitignored, so it is absent on a clean CI checkout —
    // resolveLocalEnvFilePath returns null when the file does not exist,
    // which used to make this test pass locally (file present) but fail in
    // CI. Force just that path to "exist" (real fs for everything else, so
    // findRepoRoot's package.json probes still work) to test the resolution
    // logic rather than the runner's filesystem.
    const expected = path.join(repoRoot, '.env.local');
    jest
      .spyOn(fs, 'existsSync')
      .mockImplementation((p) => p === expected || realExistsSync(p as fs.PathLike));

    expect(
      resolveLocalEnvFilePath({
        cwd: backendDir,
        nodeEnv: 'development',
      }),
    ).toBe(expected);
  });

  it('uses legacy aliases for the active network when canonical values are missing', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    const env = resolveBotRuntimeEnvFromProcessEnv({
      NEXT_PUBLIC_SUI_NETWORK: 'testnet',
      NEXT_PUBLIC_MAINNET_RPC_URL: 'https://rpc.mainnet.example',
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
      SUI_WHATSAPP_LINKS_REGISTRY_ID: '0xregistry-testnet',
      NEXT_PUBLIC_ENOKI: 'testnet-enoki',
      NEXT_PUBLIC_SUI_RPC_URL: 'https://rpc.testnet.example',
    });

    expect(env.currentNetwork).toBe('testnet');
    expect(env.networks.testnet.packageId).toBe('0xtestnet');
    expect(env.networks.testnet.whatsappRegistryId).toBe('0xregistry-testnet');
    expect(warnSpy).toHaveBeenCalled();
  });

  it('fails on canonical and legacy conflicts', () => {
    expect(() =>
      resolveBotRuntimeEnvFromProcessEnv({
        NEXT_PUBLIC_SUI_NETWORK: 'testnet',
        NEXT_PUBLIC_TESTNET_PACKAGE_ID: '0xcanonical',
        NEXT_PUBLIC_MAINNET_PACKAGE_ID: '0xmainnet',
        NEXT_PUBLIC_TESTNET_WHATSAPP_PACKAGE_ID: '0xwa-testnet',
        NEXT_PUBLIC_MAINNET_WHATSAPP_PACKAGE_ID: '0xwa-mainnet',
        NEXT_PUBLIC_TESTNET_WHATSAPP_REGISTRY_ID: '0xregistry-testnet',
        NEXT_PUBLIC_MAINNET_WHATSAPP_REGISTRY_ID: '0xregistry-mainnet',
        NEXT_PUBLIC_ENOKI_TESTNET: 'testnet-enoki',
        NEXT_PUBLIC_ENOKI_MAINNET: 'mainnet-enoki',
        NEXT_PUBLIC_PACKAGE_ID: '0xlegacy',
      }),
    ).toThrow(/NEXT_PUBLIC_TESTNET_PACKAGE_ID/);
  });
});
