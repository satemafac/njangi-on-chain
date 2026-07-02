import {
  getConfiguredNetworkFromEnv,
  getPublicEnvForNetwork,
  type NetworkType,
} from '@/config/public-env';

export type { NetworkType } from '@/config/public-env';

export interface NetworkConfig {
  rpcUrl: string;
  rpcAltUrl: string;
  graphqlUrl: string;
  packageId: string;
  enoki: {
    apiKey: string;
    network: 'testnet' | 'mainnet';
  };
  coinTypes: {
    SUI: string;
    USDC: string;
    SUI_USDE?: string;
  };
  cetus: {
    packageId: string;
    globalConfig: string;
    pools: {
      SUI_USDC: string;
      SUI_USDT?: string;
    };
    aggregatorRouter: string;
    pools_id?: string;
    published_at?: string;
    coin_list_id?: string;
    launchpad_pools_id?: string;
    cert_id?: string;
  };
  tokens: {
    SUI: string;
    USDC: string;
    USDT?: string;
    SUI_USDE?: string;
  };
  ember: {
    vaultPackage?: string;
    suiUsdeVaultId?: string;
    receiptCoinType?: string;
    protocolConfigId?: string;
  };
  whatsapp: {
    packageId: string;
    registryObjectId: string;
  };
}

function buildNetworkConfig(network: NetworkType): NetworkConfig {
  const env = getPublicEnvForNetwork(network);

  if (network === 'testnet') {
    return {
      rpcUrl: env.rpcUrl,
      rpcAltUrl: env.rpcAltUrl,
      graphqlUrl: env.graphqlUrl,
      packageId: env.packageId,
      enoki: {
        apiKey: env.enokiApiKey,
        network: 'testnet' as const,
      },
      coinTypes: {
        SUI: '0x2::sui::SUI',
        USDC: process.env.NEXT_PUBLIC_TESTNET_USDC || '0x26b3bc67befc214058ca78ea9a2690298d731a2d4309485ec3d40198063c4abc::usdc::USDC',
        SUI_USDE: process.env.NEXT_PUBLIC_TESTNET_SUI_USDE || '',
      },
      cetus: {
        packageId: process.env.NEXT_PUBLIC_TESTNET_CETUS_PACKAGE || '0x0c7ae833c220aa73a3643a0d508afa4ac5d50d97312ea4584e35f9eb21b9df12',
        globalConfig: process.env.NEXT_PUBLIC_TESTNET_CETUS_GLOBAL_CONFIG || '0xf5ff7d5ba73b581bca6b4b9fa0049cd320360abd154b809f8700a8fd3cfaf7ca',
        pools: {
          SUI_USDC: process.env.NEXT_PUBLIC_TESTNET_CETUS_POOL_SUI_USDC || '0xb01b068bd0360bb3308b81eb42386707e460b7818816709b7f51e1635d542d40',
          SUI_USDT: '0x2cc7129e25401b5eccfdc678d402e2cc22f688f1c8e5db58c06c3c4e71242eb2',
        },
        aggregatorRouter: '0xeffc8ae61f439bb34c9b905ff8f29ec56873dcedf81c7123ff2f1f67c45ec302',
        pools_id: '0xdf23f5920fbe7d529ddda0c814efd1c5ab3a4ce67fa34dadf9e135c3d617df25',
        published_at: '0xb2a1d27337788bda89d350703b8326952413bd94b35b9b573ac8401b9803d018',
        coin_list_id: '0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb',
        launchpad_pools_id: '0x38465dad7da5e2c57cd68be9cfb7a7b370ac0fae42057a6085e9c7b924af9b09',
        cert_id: '0x6f1a1ccc1c8bfc4a5612fbea2d62c531832e99cbf46582410ec92d938cd1c66a',
      },
      tokens: {
        SUI: '0x2::sui::SUI',
        USDC: '0x9e89965f542887a8f0383451ba553fedf62c04e4dc68f60dec5b8d7ad1436bd6::usdc::USDC',
        USDT: '0xc060006111016b8a020ad5b33834984a437aaa7d3c74c18e09a95d48aceab08::usdt::USDT',
        SUI_USDE: process.env.NEXT_PUBLIC_TESTNET_SUI_USDE || '',
      },
      ember: {
        vaultPackage: process.env.NEXT_PUBLIC_TESTNET_EMBER_VAULT_PACKAGE || '',
        suiUsdeVaultId: process.env.NEXT_PUBLIC_TESTNET_EMBER_SUI_USDE_VAULT_ID || '',
        receiptCoinType: process.env.NEXT_PUBLIC_TESTNET_EMBER_ESUIUSDE_RECEIPT || '',
        protocolConfigId: process.env.NEXT_PUBLIC_TESTNET_EMBER_PROTOCOL_CONFIG || '',
      },
      whatsapp: {
        packageId: env.whatsappPackageId,
        registryObjectId: env.whatsappRegistryId,
      },
    };
  }

  return {
    rpcUrl: env.rpcUrl,
    rpcAltUrl: env.rpcAltUrl,
    graphqlUrl: env.graphqlUrl,
    packageId: env.packageId,
    enoki: {
      apiKey: env.enokiApiKey,
      network: 'mainnet' as const,
    },
    coinTypes: {
      SUI: '0x2::sui::SUI',
      // Native Circle-issued USDC — the asset CEX withdrawals (Binance, Coinbase, …)
      // deliver on Sui. NOT the Wormhole-bridged ::coin::COIN.
      USDC: process.env.NEXT_PUBLIC_MAINNET_USDC || '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC',
      SUI_USDE: process.env.NEXT_PUBLIC_MAINNET_SUI_USDE || '0x41d587e5336f1c86cad50d38a7136db99333bb9bda91cea4ba69115defeb1402::sui_usde::SUI_USDE',
    },
    cetus: {
      packageId: process.env.NEXT_PUBLIC_MAINNET_CETUS_PACKAGE || '0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb',
      globalConfig: process.env.NEXT_PUBLIC_MAINNET_CETUS_GLOBAL_CONFIG || '0xdaa46292632c3c4d8f31f23ea0f9b36a28ff3677e9684980e4438403a67a3d8f',
      pools: {
        // Pool<native USDC, SUI>, 0.25% fee tier (coin A = USDC, coin B = SUI)
        SUI_USDC: process.env.NEXT_PUBLIC_MAINNET_CETUS_POOL_SUI_USDC || '0xb8d7d9e66a60c239e7a60110efcf8de6c705580ed924d0dde141f4a0e2c90105',
        // Pool<native suiUSDT, SUI>, 0.25% fee tier — thin liquidity; USDT routes
        // are better served via the USDC↔suiUSDT pool through the aggregator
        SUI_USDT: '0x84fc1515fd3d2395b2d67b301dc2b60040e31af7e295f8731c84bd528733252f',
      },
      aggregatorRouter: '0xeffc8ae61f439bb34c9b905ff8f29ec56873dcedf81c7123ff2f1f67c45ec302',
      pools_id: '0xf699e7f2276f5c9a75944b37a0c5b5d9ddfd2471bf6242483b03ab2887d198d0',
      published_at: '0xc6faf3703b0e8ba9ed06b7851134bbbe7565eb35ff823fd78432baa4cbeaa12e',
      coin_list_id: '0x8cbc11d9e10140db3d230f50b4d30e9b721201c0083615441707ffec1ef77b23',
      launchpad_pools_id: '0x1098fac992eab3a0ab7acf15bb654fc1cf29b5a6142c4ef1058e6c408dd15115',
    },
    tokens: {
      SUI: '0x2::sui::SUI',
      USDC: process.env.NEXT_PUBLIC_MAINNET_USDC || '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC',
      // Native suiUSDT (Sui Bridge Tether) — what CEXes deliver for USDT on Sui
      USDT: process.env.NEXT_PUBLIC_MAINNET_USDT || '0x375f70cf2ae4c00bf37117d0c85a2c71545e6ee05c4a5c7d282cd66a4504b068::usdt::USDT',
      SUI_USDE: process.env.NEXT_PUBLIC_MAINNET_SUI_USDE || '0x41d587e5336f1c86cad50d38a7136db99333bb9bda91cea4ba69115defeb1402::sui_usde::SUI_USDE',
    },
    ember: {
      vaultPackage: process.env.NEXT_PUBLIC_MAINNET_EMBER_VAULT_PACKAGE || '0xc83d5406fd355f34d3ce87b35ab2c0b099af9d309ba96c17e40309502a49976f',
      suiUsdeVaultId:
        process.env.NEXT_PUBLIC_MAINNET_EMBER_SUI_USDE_VAULT_ID ||
        '0x2a906b7633db9fca6c2f16c1efe73c7e289dfce8ed64a98ec5a5be10a9fb9aa1',
      receiptCoinType:
        process.env.NEXT_PUBLIC_MAINNET_EMBER_ESUIUSDE_RECEIPT ||
        '0xc360f622a9e77bb774061c44c11915e3cfc4242488cd668652dbff39cf0cdd58::esuiusde::ESUIUSDE',
      protocolConfigId:
        process.env.NEXT_PUBLIC_MAINNET_EMBER_PROTOCOL_CONFIG ||
        '0x3a515233ab817af082ef31454cee5eb8122b8b7cd586bf6b26ae9b879ee1e565',
    },
    whatsapp: {
      packageId: env.whatsappPackageId,
      registryObjectId: env.whatsappRegistryId,
    },
  };
}

// Network state management - initialize from environment variable
let currentNetwork: NetworkType = getConfiguredNetworkFromEnv();

// Function to get current network
export function getCurrentNetwork(): NetworkType {
  if (typeof window !== 'undefined') {
    // Client-side: get from localStorage
    const saved = localStorage.getItem('sui-network');
    if (saved === 'testnet' || saved === 'mainnet') {
      currentNetwork = saved;
    }
  }
  return currentNetwork;
}

// Function to set current network
export function setCurrentNetwork(network: NetworkType): void {
  console.log('🌍 NetworkConfig: Setting network to:', network);
  currentNetwork = network;
  if (typeof window !== 'undefined') {
    localStorage.setItem('sui-network', network);
  }
}

// Function to get current network configuration
export function getCurrentNetworkConfig(): NetworkConfig {
  const network = getCurrentNetwork();
  const config = buildNetworkConfig(network);
  console.log('🌍 NetworkConfig: Getting config for network:', network, {
    packageId: config.packageId,
    enokiApiKey: config.enoki.apiKey ? 'present' : 'MISSING',
    enokiNetwork: config.enoki.network
  });
  return config;
}

// Function to get network config by type
export function getNetworkConfig(network: NetworkType): NetworkConfig {
  return buildNetworkConfig(network);
}

// Helper functions for common configuration needs
export function getCurrentRpcUrl(): string {
  return getCurrentNetworkConfig().rpcUrl;
}

export function getRpcUrlForNetwork(network: NetworkType): string {
  return getNetworkConfig(network).rpcUrl;
}

export function getCurrentGraphqlUrl(): string {
  return getCurrentNetworkConfig().graphqlUrl;
}

export function getGraphqlUrlForNetwork(network: NetworkType): string {
  return getNetworkConfig(network).graphqlUrl;
}

export function getCurrentPackageId(): string {
  return getCurrentNetworkConfig().packageId;
}

export function getPackageIdForNetwork(network: NetworkType): string {
  return getNetworkConfig(network).packageId;
}

export function getCurrentEnokiConfig() {
  return getCurrentNetworkConfig().enoki;
}

export function getCurrentCoinTypes() {
  return getCurrentNetworkConfig().coinTypes;
}

export function getCurrentCetusConfig() {
  return getCurrentNetworkConfig().cetus;
}

export function getCurrentTokens() {
  return getCurrentNetworkConfig().tokens;
}

export function getCurrentEmberConfig() {
  return getCurrentNetworkConfig().ember;
}

export function getCurrentWhatsAppConfig() {
  return getCurrentNetworkConfig().whatsapp;
}

export function getWhatsAppConfigForNetwork(network: NetworkType) {
  return getNetworkConfig(network).whatsapp;
}

// Network configuration validation
export function validateNetworkConfig(network: NetworkType): { isValid: boolean; errors: string[] } {
  const config = getNetworkConfig(network);
  const errors: string[] = [];

  // Validate required fields
  if (!config.packageId) {
    errors.push(`Missing package ID for ${network} network`);
  }
  
  if (!config.enoki.apiKey) {
    errors.push(`Missing Enoki API key for ${network} network`);
  }
  
  if (!config.rpcUrl) {
    errors.push(`Missing RPC URL for ${network} network`);
  }
  
  if (!config.coinTypes.USDC) {
    errors.push(`Missing USDC coin type for ${network} network`);
  }

  if (network === 'mainnet') {
    if (!config.coinTypes.SUI_USDE) {
      errors.push('Missing mainnet suiUSDe coin type');
    }
    if (!config.ember.vaultPackage) {
      errors.push('Missing mainnet Ember vault package ID');
    }
    if (!config.ember.suiUsdeVaultId) {
      errors.push('Missing mainnet Ember suiUSDe vault ID');
    }
    if (!config.ember.receiptCoinType) {
      errors.push('Missing mainnet Ember receipt coin type');
    }
    if (!config.ember.protocolConfigId) {
      errors.push('Missing mainnet Ember protocol config ID');
    }
  }

  // Validate mainnet-specific requirements
  if (network === 'mainnet') {
    if (config.packageId === getNetworkConfig('testnet').packageId) {
      errors.push('Mainnet is using testnet package ID - please update NEXT_PUBLIC_MAINNET_PACKAGE_ID');
    }
    
    if (config.enoki.apiKey === getNetworkConfig('testnet').enoki.apiKey) {
      errors.push('Mainnet is using testnet Enoki API key - please update NEXT_PUBLIC_ENOKI_MAINNET');
    }
  }

  return {
    isValid: errors.length === 0,
    errors
  };
}

// Network switching utility
export function switchNetwork(newNetwork: NetworkType): void {
  // Validate configuration before switching
  const validation = validateNetworkConfig(newNetwork);
  if (!validation.isValid) {
    console.error(`Network configuration errors for ${newNetwork}:`, validation.errors);
    // Don't throw error in production, just log warnings
    if (process.env.NODE_ENV === 'development') {
      console.warn('Network configuration issues detected:', validation.errors);
    }
  }
  
  setCurrentNetwork(newNetwork);
  
  // Clear any cached authentication state
  if (typeof window !== 'undefined') {
    localStorage.removeItem('zklogin-session');
    localStorage.removeItem('account-data');
  }
}
