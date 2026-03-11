import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

export type NetworkType = 'testnet' | 'mainnet';

export interface ResolvedBotNetworkEnv {
  rpcUrl: string;
  rpcAltUrl: string;
  packageId: string;
  whatsappPackageId: string;
  whatsappRegistryId: string;
  enokiApiKey: string;
}

export interface ResolvedBotRuntimeEnv {
  currentNetwork: NetworkType;
  networks: Record<NetworkType, ResolvedBotNetworkEnv>;
}

const warnedLegacyKeys = new Set<string>();
const DEFAULT_RPC_URLS: Record<NetworkType, string> = {
  testnet: 'https://fullnode.testnet.sui.io:443',
  mainnet: 'https://fullnode.mainnet.sui.io:443',
};
const DEFAULT_RPC_ALT_URLS: Record<NetworkType, string> = {
  testnet: 'https://sui-testnet-endpoint.blockvision.org',
  mainnet: 'https://sui-mainnet-endpoint.blockvision.org',
};

function warnLegacyUsage(message: string): void {
  if (warnedLegacyKeys.has(message)) {
    return;
  }

  warnedLegacyKeys.add(message);
  console.warn(message);
}

function normalizeValue(value: string | undefined): string {
  return value?.trim() ?? '';
}

function canonicalOrLegacy(
  canonicalKey: string,
  canonicalValue: string | undefined,
  legacyCandidates: Array<{ key: string; value: string | undefined }>,
): string {
  const canonical = normalizeValue(canonicalValue);
  const presentLegacy = legacyCandidates.filter((candidate) => normalizeValue(candidate.value) !== '');

  if (canonical) {
    for (const legacy of presentLegacy) {
      if (normalizeValue(legacy.value) !== canonical) {
        throw new Error(
          `Conflicting environment values for ${canonicalKey} and legacy alias ${legacy.key}. ` +
            `Remove the legacy alias or make the values match.`,
        );
      }
    }

    return canonical;
  }

  const fallback = presentLegacy[0];
  if (!fallback?.value) {
    return '';
  }

  warnLegacyUsage(`[env] ${fallback.key} is deprecated. Rename it to ${canonicalKey}.`);
  return normalizeValue(fallback.value);
}

export function findRepoRoot(startDir: string = process.cwd()): string | null {
  let currentDir = path.resolve(startDir);

  while (true) {
    const hasRootPackage = fs.existsSync(path.join(currentDir, 'package.json'));
    const hasBackendPackage = fs.existsSync(path.join(currentDir, 'whatsapp-bot-backend', 'package.json'));

    if (hasRootPackage && hasBackendPackage) {
      return currentDir;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }

    currentDir = parentDir;
  }
}

export function resolveLocalEnvFilePath(options?: {
  cwd?: string;
  nodeEnv?: string;
  overridePath?: string;
}): string | null {
  const cwd = options?.cwd ?? process.cwd();
  const nodeEnv = options?.nodeEnv ?? process.env.NODE_ENV;
  const overridePath = options?.overridePath ?? process.env.NJANGI_ENV_FILE ?? process.env.ENV_FILE;

  if (overridePath) {
    const absoluteOverride = path.isAbsolute(overridePath)
      ? overridePath
      : path.resolve(cwd, overridePath);
    return fs.existsSync(absoluteOverride) ? absoluteOverride : null;
  }

  if (nodeEnv === 'production') {
    return null;
  }

  const repoRoot = findRepoRoot(cwd);
  if (!repoRoot) {
    return null;
  }

  const rootEnvFile = path.join(repoRoot, '.env.local');
  return fs.existsSync(rootEnvFile) ? rootEnvFile : null;
}

export function loadLocalEnvFile(options?: {
  cwd?: string;
  nodeEnv?: string;
  overridePath?: string;
}): string | null {
  const envFilePath = resolveLocalEnvFilePath(options);

  if (!envFilePath) {
    return null;
  }

  dotenv.config({ path: envFilePath, override: false });
  return envFilePath;
}

export function resolveBotRuntimeEnvFromProcessEnv(
  env: NodeJS.ProcessEnv = process.env,
): ResolvedBotRuntimeEnv {
  const currentNetwork: NetworkType = env.NEXT_PUBLIC_SUI_NETWORK === 'mainnet' ? 'mainnet' : 'testnet';
  const currentNetworkOnly = (network: NetworkType, key: string, value: string | undefined) =>
    network === currentNetwork ? [{ key, value }] : [];

  return {
    currentNetwork,
    networks: {
      testnet: {
        rpcUrl:
          canonicalOrLegacy(
            'NEXT_PUBLIC_TESTNET_RPC_URL',
            env.NEXT_PUBLIC_TESTNET_RPC_URL,
            currentNetworkOnly('testnet', 'NEXT_PUBLIC_SUI_RPC_URL', env.NEXT_PUBLIC_SUI_RPC_URL),
          ) || DEFAULT_RPC_URLS.testnet,
        rpcAltUrl: normalizeValue(env.NEXT_PUBLIC_TESTNET_RPC_ALT) || DEFAULT_RPC_ALT_URLS.testnet,
        packageId: canonicalOrLegacy(
          'NEXT_PUBLIC_TESTNET_PACKAGE_ID',
          env.NEXT_PUBLIC_TESTNET_PACKAGE_ID,
          currentNetworkOnly('testnet', 'NEXT_PUBLIC_PACKAGE_ID', env.NEXT_PUBLIC_PACKAGE_ID),
        ),
        whatsappPackageId: canonicalOrLegacy(
          'NEXT_PUBLIC_TESTNET_WHATSAPP_PACKAGE_ID',
          env.NEXT_PUBLIC_TESTNET_WHATSAPP_PACKAGE_ID,
          currentNetworkOnly('testnet', 'NEXT_PUBLIC_WHATSAPP_PACKAGE_ID', env.NEXT_PUBLIC_WHATSAPP_PACKAGE_ID),
        ),
        whatsappRegistryId: canonicalOrLegacy(
          'NEXT_PUBLIC_TESTNET_WHATSAPP_REGISTRY_ID',
          env.NEXT_PUBLIC_TESTNET_WHATSAPP_REGISTRY_ID,
          [
            ...currentNetworkOnly('testnet', 'NEXT_PUBLIC_WHATSAPP_REGISTRY_ID', env.NEXT_PUBLIC_WHATSAPP_REGISTRY_ID),
            ...currentNetworkOnly('testnet', 'SUI_WHATSAPP_LINKS_REGISTRY_ID', env.SUI_WHATSAPP_LINKS_REGISTRY_ID),
          ],
        ),
        enokiApiKey: canonicalOrLegacy(
          'NEXT_PUBLIC_ENOKI_TESTNET',
          env.NEXT_PUBLIC_ENOKI_TESTNET,
          [
            ...currentNetworkOnly('testnet', 'NEXT_PUBLIC_ENOKI', env.NEXT_PUBLIC_ENOKI),
            { key: 'ZKLOGIN_TESTNET_ENOKI_KEY', value: env.ZKLOGIN_TESTNET_ENOKI_KEY },
            { key: 'ZKLOGIN_DEFAULT_ENOKI_KEY', value: currentNetwork === 'testnet' ? env.ZKLOGIN_DEFAULT_ENOKI_KEY : '' },
          ],
        ),
      },
      mainnet: {
        rpcUrl:
          canonicalOrLegacy(
            'NEXT_PUBLIC_MAINNET_RPC_URL',
            env.NEXT_PUBLIC_MAINNET_RPC_URL,
            currentNetworkOnly('mainnet', 'NEXT_PUBLIC_SUI_RPC_URL', env.NEXT_PUBLIC_SUI_RPC_URL),
          ) || DEFAULT_RPC_URLS.mainnet,
        rpcAltUrl: normalizeValue(env.NEXT_PUBLIC_MAINNET_RPC_ALT) || DEFAULT_RPC_ALT_URLS.mainnet,
        packageId: canonicalOrLegacy(
          'NEXT_PUBLIC_MAINNET_PACKAGE_ID',
          env.NEXT_PUBLIC_MAINNET_PACKAGE_ID,
          currentNetworkOnly('mainnet', 'NEXT_PUBLIC_PACKAGE_ID', env.NEXT_PUBLIC_PACKAGE_ID),
        ),
        whatsappPackageId: canonicalOrLegacy(
          'NEXT_PUBLIC_MAINNET_WHATSAPP_PACKAGE_ID',
          env.NEXT_PUBLIC_MAINNET_WHATSAPP_PACKAGE_ID,
          currentNetworkOnly('mainnet', 'NEXT_PUBLIC_WHATSAPP_PACKAGE_ID', env.NEXT_PUBLIC_WHATSAPP_PACKAGE_ID),
        ),
        whatsappRegistryId: canonicalOrLegacy(
          'NEXT_PUBLIC_MAINNET_WHATSAPP_REGISTRY_ID',
          env.NEXT_PUBLIC_MAINNET_WHATSAPP_REGISTRY_ID,
          [
            ...currentNetworkOnly('mainnet', 'NEXT_PUBLIC_WHATSAPP_REGISTRY_ID', env.NEXT_PUBLIC_WHATSAPP_REGISTRY_ID),
            ...currentNetworkOnly('mainnet', 'SUI_WHATSAPP_LINKS_REGISTRY_ID', env.SUI_WHATSAPP_LINKS_REGISTRY_ID),
          ],
        ),
        enokiApiKey: canonicalOrLegacy(
          'NEXT_PUBLIC_ENOKI_MAINNET',
          env.NEXT_PUBLIC_ENOKI_MAINNET,
          [
            ...currentNetworkOnly('mainnet', 'NEXT_PUBLIC_ENOKI', env.NEXT_PUBLIC_ENOKI),
            { key: 'ZKLOGIN_MAINNET_ENOKI_KEY', value: env.ZKLOGIN_MAINNET_ENOKI_KEY },
            { key: 'ZKLOGIN_DEFAULT_ENOKI_KEY', value: currentNetwork === 'mainnet' ? env.ZKLOGIN_DEFAULT_ENOKI_KEY : '' },
          ],
        ),
      },
    },
  };
}

export function resetBotEnvWarningsForTests(): void {
  warnedLegacyKeys.clear();
}
