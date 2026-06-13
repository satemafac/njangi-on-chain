export type NetworkType = 'testnet' | 'mainnet';

interface RawPublicEnv {
  NEXT_PUBLIC_SUI_NETWORK?: string;
  NEXT_PUBLIC_TESTNET_RPC_URL?: string;
  NEXT_PUBLIC_MAINNET_RPC_URL?: string;
  NEXT_PUBLIC_TESTNET_RPC_ALT?: string;
  NEXT_PUBLIC_MAINNET_RPC_ALT?: string;
  NEXT_PUBLIC_TESTNET_GRAPHQL_URL?: string;
  NEXT_PUBLIC_MAINNET_GRAPHQL_URL?: string;
  NEXT_PUBLIC_TESTNET_PACKAGE_ID?: string;
  NEXT_PUBLIC_MAINNET_PACKAGE_ID?: string;
  NEXT_PUBLIC_TESTNET_WHATSAPP_PACKAGE_ID?: string;
  NEXT_PUBLIC_MAINNET_WHATSAPP_PACKAGE_ID?: string;
  NEXT_PUBLIC_TESTNET_WHATSAPP_REGISTRY_ID?: string;
  NEXT_PUBLIC_MAINNET_WHATSAPP_REGISTRY_ID?: string;
  NEXT_PUBLIC_TESTNET_DEPLOYMENT_COIN?: string;
  NEXT_PUBLIC_MAINNET_DEPLOYMENT_COIN?: string;
  NEXT_PUBLIC_ENOKI_TESTNET?: string;
  NEXT_PUBLIC_ENOKI_MAINNET?: string;
  // Server-only Enoki private keys. The Enoki private key (enoki_private_*)
  // is a Bearer credential used ONLY by server-side salt/zkp/sponsorship
  // calls (src/services/enokiZkLoginService.ts) — it must never reach the
  // browser bundle. These are non-NEXT_PUBLIC so Next.js keeps them off the
  // client; they take precedence over the deprecated NEXT_PUBLIC_ENOKI_*.
  ENOKI_API_KEY_TESTNET?: string;
  ENOKI_API_KEY_MAINNET?: string;
  NEXT_PUBLIC_PACKAGE_ID?: string;
  NEXT_PUBLIC_WHATSAPP_PACKAGE_ID?: string;
  NEXT_PUBLIC_WHATSAPP_REGISTRY_ID?: string;
  NEXT_PUBLIC_ENOKI?: string;
  NEXT_PUBLIC_SUI_RPC_URL?: string;
  NEXT_PUBLIC_SUI_GRAPHQL_URL?: string;
  TESTNET_GRAPHQL_URL?: string;
  MAINNET_GRAPHQL_URL?: string;
  SUI_GRAPHQL_URL?: string;
  SUI_WHATSAPP_LINKS_REGISTRY_ID?: string;
}

export interface ResolvedPublicNetworkEnv {
  rpcUrl: string;
  rpcAltUrl: string;
  graphqlUrl: string;
  packageId: string;
  enokiApiKey: string;
  whatsappPackageId: string;
  whatsappRegistryId: string;
  deploymentCoin: string;
}

export interface ResolvedPublicEnv {
  currentNetwork: NetworkType;
  networks: Record<NetworkType, ResolvedPublicNetworkEnv>;
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
const DEFAULT_GRAPHQL_URLS: Record<NetworkType, string> = {
  testnet: 'https://sui-testnet.mystenlabs.com/graphql',
  mainnet: 'https://sui-mainnet.mystenlabs.com/graphql',
};

function readRawPublicEnv(): RawPublicEnv {
  return {
    NEXT_PUBLIC_SUI_NETWORK: process.env.NEXT_PUBLIC_SUI_NETWORK,
    NEXT_PUBLIC_TESTNET_RPC_URL: process.env.NEXT_PUBLIC_TESTNET_RPC_URL,
    NEXT_PUBLIC_MAINNET_RPC_URL: process.env.NEXT_PUBLIC_MAINNET_RPC_URL,
    NEXT_PUBLIC_TESTNET_RPC_ALT: process.env.NEXT_PUBLIC_TESTNET_RPC_ALT,
    NEXT_PUBLIC_MAINNET_RPC_ALT: process.env.NEXT_PUBLIC_MAINNET_RPC_ALT,
    NEXT_PUBLIC_TESTNET_GRAPHQL_URL: process.env.NEXT_PUBLIC_TESTNET_GRAPHQL_URL,
    NEXT_PUBLIC_MAINNET_GRAPHQL_URL: process.env.NEXT_PUBLIC_MAINNET_GRAPHQL_URL,
    NEXT_PUBLIC_TESTNET_PACKAGE_ID: process.env.NEXT_PUBLIC_TESTNET_PACKAGE_ID,
    NEXT_PUBLIC_MAINNET_PACKAGE_ID: process.env.NEXT_PUBLIC_MAINNET_PACKAGE_ID,
    NEXT_PUBLIC_TESTNET_WHATSAPP_PACKAGE_ID: process.env.NEXT_PUBLIC_TESTNET_WHATSAPP_PACKAGE_ID,
    NEXT_PUBLIC_MAINNET_WHATSAPP_PACKAGE_ID: process.env.NEXT_PUBLIC_MAINNET_WHATSAPP_PACKAGE_ID,
    NEXT_PUBLIC_TESTNET_WHATSAPP_REGISTRY_ID: process.env.NEXT_PUBLIC_TESTNET_WHATSAPP_REGISTRY_ID,
    NEXT_PUBLIC_MAINNET_WHATSAPP_REGISTRY_ID: process.env.NEXT_PUBLIC_MAINNET_WHATSAPP_REGISTRY_ID,
    NEXT_PUBLIC_TESTNET_DEPLOYMENT_COIN: process.env.NEXT_PUBLIC_TESTNET_DEPLOYMENT_COIN,
    NEXT_PUBLIC_MAINNET_DEPLOYMENT_COIN: process.env.NEXT_PUBLIC_MAINNET_DEPLOYMENT_COIN,
    NEXT_PUBLIC_ENOKI_TESTNET: process.env.NEXT_PUBLIC_ENOKI_TESTNET,
    NEXT_PUBLIC_ENOKI_MAINNET: process.env.NEXT_PUBLIC_ENOKI_MAINNET,
    ENOKI_API_KEY_TESTNET: process.env.ENOKI_API_KEY_TESTNET,
    ENOKI_API_KEY_MAINNET: process.env.ENOKI_API_KEY_MAINNET,
    NEXT_PUBLIC_PACKAGE_ID: process.env.NEXT_PUBLIC_PACKAGE_ID,
    NEXT_PUBLIC_WHATSAPP_PACKAGE_ID: process.env.NEXT_PUBLIC_WHATSAPP_PACKAGE_ID,
    NEXT_PUBLIC_WHATSAPP_REGISTRY_ID: process.env.NEXT_PUBLIC_WHATSAPP_REGISTRY_ID,
    NEXT_PUBLIC_ENOKI: process.env.NEXT_PUBLIC_ENOKI,
    NEXT_PUBLIC_SUI_RPC_URL: process.env.NEXT_PUBLIC_SUI_RPC_URL,
    NEXT_PUBLIC_SUI_GRAPHQL_URL: process.env.NEXT_PUBLIC_SUI_GRAPHQL_URL,
    TESTNET_GRAPHQL_URL: process.env.TESTNET_GRAPHQL_URL,
    MAINNET_GRAPHQL_URL: process.env.MAINNET_GRAPHQL_URL,
    SUI_GRAPHQL_URL: process.env.SUI_GRAPHQL_URL,
    SUI_WHATSAPP_LINKS_REGISTRY_ID: process.env.SUI_WHATSAPP_LINKS_REGISTRY_ID,
  };
}

function warnLegacyUsage(message: string): void {
  if (warnedLegacyKeys.has(message)) {
    return;
  }

  warnedLegacyKeys.add(message);
  console.warn(message);
}

function canonicalOrLegacy(
  canonicalKey: string,
  canonicalValue: string | undefined,
  legacyCandidates: Array<{ key: string; value: string | undefined }>,
): string {
  const presentLegacy = legacyCandidates.filter((candidate) => candidate.value && candidate.value.trim() !== '');

  if (canonicalValue && canonicalValue.trim() !== '') {
    for (const legacy of presentLegacy) {
      if (legacy.value !== canonicalValue) {
        throw new Error(
          `Conflicting environment values for ${canonicalKey} and legacy alias ${legacy.key}. ` +
            `Remove the legacy alias or make the values match.`,
        );
      }
    }

    return canonicalValue;
  }

  const fallback = presentLegacy[0];
  if (!fallback?.value) {
    return '';
  }

  warnLegacyUsage(
    `[env] ${fallback.key} is deprecated. Rename it to ${canonicalKey}.`,
  );
  return fallback.value;
}

export function resolvePublicEnvFromRaw(raw: RawPublicEnv): ResolvedPublicEnv {
  const currentNetwork: NetworkType =
    raw.NEXT_PUBLIC_SUI_NETWORK === 'mainnet' ? 'mainnet' : 'testnet';

  const currentNetworkOnly = (network: NetworkType, key: string, value: string | undefined) =>
    network === currentNetwork ? [{ key, value }] : [];

  const testnetRpcUrl = canonicalOrLegacy(
    'NEXT_PUBLIC_TESTNET_RPC_URL',
    raw.NEXT_PUBLIC_TESTNET_RPC_URL,
    currentNetworkOnly('testnet', 'NEXT_PUBLIC_SUI_RPC_URL', raw.NEXT_PUBLIC_SUI_RPC_URL),
  ) || DEFAULT_RPC_URLS.testnet;

  const mainnetRpcUrl = canonicalOrLegacy(
    'NEXT_PUBLIC_MAINNET_RPC_URL',
    raw.NEXT_PUBLIC_MAINNET_RPC_URL,
    currentNetworkOnly('mainnet', 'NEXT_PUBLIC_SUI_RPC_URL', raw.NEXT_PUBLIC_SUI_RPC_URL),
  ) || DEFAULT_RPC_URLS.mainnet;

  const testnetGraphqlUrl = canonicalOrLegacy(
    'NEXT_PUBLIC_TESTNET_GRAPHQL_URL',
    raw.NEXT_PUBLIC_TESTNET_GRAPHQL_URL,
    [
      { key: 'TESTNET_GRAPHQL_URL', value: raw.TESTNET_GRAPHQL_URL },
      ...currentNetworkOnly('testnet', 'NEXT_PUBLIC_SUI_GRAPHQL_URL', raw.NEXT_PUBLIC_SUI_GRAPHQL_URL),
      ...currentNetworkOnly('testnet', 'SUI_GRAPHQL_URL', raw.SUI_GRAPHQL_URL),
    ],
  ) || DEFAULT_GRAPHQL_URLS.testnet;

  const mainnetGraphqlUrl = canonicalOrLegacy(
    'NEXT_PUBLIC_MAINNET_GRAPHQL_URL',
    raw.NEXT_PUBLIC_MAINNET_GRAPHQL_URL,
    [
      { key: 'MAINNET_GRAPHQL_URL', value: raw.MAINNET_GRAPHQL_URL },
      ...currentNetworkOnly('mainnet', 'NEXT_PUBLIC_SUI_GRAPHQL_URL', raw.NEXT_PUBLIC_SUI_GRAPHQL_URL),
      ...currentNetworkOnly('mainnet', 'SUI_GRAPHQL_URL', raw.SUI_GRAPHQL_URL),
    ],
  ) || DEFAULT_GRAPHQL_URLS.mainnet;

  return {
    currentNetwork,
    networks: {
      testnet: {
        rpcUrl: testnetRpcUrl,
        rpcAltUrl: raw.NEXT_PUBLIC_TESTNET_RPC_ALT || DEFAULT_RPC_ALT_URLS.testnet,
        graphqlUrl: testnetGraphqlUrl,
        packageId: canonicalOrLegacy(
          'NEXT_PUBLIC_TESTNET_PACKAGE_ID',
          raw.NEXT_PUBLIC_TESTNET_PACKAGE_ID,
          currentNetworkOnly('testnet', 'NEXT_PUBLIC_PACKAGE_ID', raw.NEXT_PUBLIC_PACKAGE_ID),
        ),
        // Server-only ENOKI_API_KEY_TESTNET is canonical; the bundled
        // NEXT_PUBLIC_ENOKI_* variants are deprecated (they leak the
        // private key into the client) and only used as a transition
        // fallback. On the client the server var is undefined, so once the
        // operator migrates, this resolves to '' in the browser bundle.
        enokiApiKey: canonicalOrLegacy(
          'ENOKI_API_KEY_TESTNET',
          raw.ENOKI_API_KEY_TESTNET,
          [
            { key: 'NEXT_PUBLIC_ENOKI_TESTNET', value: raw.NEXT_PUBLIC_ENOKI_TESTNET },
            ...currentNetworkOnly('testnet', 'NEXT_PUBLIC_ENOKI', raw.NEXT_PUBLIC_ENOKI),
          ],
        ),
        whatsappPackageId: canonicalOrLegacy(
          'NEXT_PUBLIC_TESTNET_WHATSAPP_PACKAGE_ID',
          raw.NEXT_PUBLIC_TESTNET_WHATSAPP_PACKAGE_ID,
          currentNetworkOnly('testnet', 'NEXT_PUBLIC_WHATSAPP_PACKAGE_ID', raw.NEXT_PUBLIC_WHATSAPP_PACKAGE_ID),
        ),
        whatsappRegistryId: canonicalOrLegacy(
          'NEXT_PUBLIC_TESTNET_WHATSAPP_REGISTRY_ID',
          raw.NEXT_PUBLIC_TESTNET_WHATSAPP_REGISTRY_ID,
          [
            ...currentNetworkOnly('testnet', 'NEXT_PUBLIC_WHATSAPP_REGISTRY_ID', raw.NEXT_PUBLIC_WHATSAPP_REGISTRY_ID),
            ...currentNetworkOnly('testnet', 'SUI_WHATSAPP_LINKS_REGISTRY_ID', raw.SUI_WHATSAPP_LINKS_REGISTRY_ID),
          ],
        ),
        deploymentCoin: raw.NEXT_PUBLIC_TESTNET_DEPLOYMENT_COIN || '',
      },
      mainnet: {
        rpcUrl: mainnetRpcUrl,
        rpcAltUrl: raw.NEXT_PUBLIC_MAINNET_RPC_ALT || DEFAULT_RPC_ALT_URLS.mainnet,
        graphqlUrl: mainnetGraphqlUrl,
        packageId: canonicalOrLegacy(
          'NEXT_PUBLIC_MAINNET_PACKAGE_ID',
          raw.NEXT_PUBLIC_MAINNET_PACKAGE_ID,
          currentNetworkOnly('mainnet', 'NEXT_PUBLIC_PACKAGE_ID', raw.NEXT_PUBLIC_PACKAGE_ID),
        ),
        // See the testnet enokiApiKey note: server-only canonical key,
        // bundled NEXT_PUBLIC_* variants are a deprecated transition fallback.
        enokiApiKey: canonicalOrLegacy(
          'ENOKI_API_KEY_MAINNET',
          raw.ENOKI_API_KEY_MAINNET,
          [
            { key: 'NEXT_PUBLIC_ENOKI_MAINNET', value: raw.NEXT_PUBLIC_ENOKI_MAINNET },
            ...currentNetworkOnly('mainnet', 'NEXT_PUBLIC_ENOKI', raw.NEXT_PUBLIC_ENOKI),
          ],
        ),
        whatsappPackageId: canonicalOrLegacy(
          'NEXT_PUBLIC_MAINNET_WHATSAPP_PACKAGE_ID',
          raw.NEXT_PUBLIC_MAINNET_WHATSAPP_PACKAGE_ID,
          currentNetworkOnly('mainnet', 'NEXT_PUBLIC_WHATSAPP_PACKAGE_ID', raw.NEXT_PUBLIC_WHATSAPP_PACKAGE_ID),
        ),
        whatsappRegistryId: canonicalOrLegacy(
          'NEXT_PUBLIC_MAINNET_WHATSAPP_REGISTRY_ID',
          raw.NEXT_PUBLIC_MAINNET_WHATSAPP_REGISTRY_ID,
          [
            ...currentNetworkOnly('mainnet', 'NEXT_PUBLIC_WHATSAPP_REGISTRY_ID', raw.NEXT_PUBLIC_WHATSAPP_REGISTRY_ID),
            ...currentNetworkOnly('mainnet', 'SUI_WHATSAPP_LINKS_REGISTRY_ID', raw.SUI_WHATSAPP_LINKS_REGISTRY_ID),
          ],
        ),
        deploymentCoin: raw.NEXT_PUBLIC_MAINNET_DEPLOYMENT_COIN || '',
      },
    },
  };
}

export function getResolvedPublicEnv(): ResolvedPublicEnv {
  return resolvePublicEnvFromRaw(readRawPublicEnv());
}

export function getPublicEnvForNetwork(network: NetworkType): ResolvedPublicNetworkEnv {
  return getResolvedPublicEnv().networks[network];
}

export function getConfiguredNetworkFromEnv(): NetworkType {
  return getResolvedPublicEnv().currentNetwork;
}

export function resetPublicEnvWarningsForTests(): void {
  warnedLegacyKeys.clear();
}
