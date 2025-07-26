export type NetworkType = 'testnet' | 'mainnet';

export interface NetworkConfig {
  rpcUrl: string;
  packageId: string;
  enoki: {
    apiKey: string;
    network: 'testnet' | 'mainnet';
  };
  coinTypes: {
    SUI: string;
    USDC: string;
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
  };
}

export const NETWORK_CONFIGS: Record<NetworkType, NetworkConfig> = {
  testnet: {
    rpcUrl: process.env.NEXT_PUBLIC_TESTNET_RPC_URL || 'https://fullnode.testnet.sui.io:443',
    packageId: process.env.NEXT_PUBLIC_TESTNET_PACKAGE_ID || process.env.NEXT_PUBLIC_PACKAGE_ID || '',
    enoki: {
      apiKey: process.env.NEXT_PUBLIC_ENOKI_TESTNET || process.env.NEXT_PUBLIC_ENOKI || '',
      network: 'testnet' as const,
    },
    coinTypes: {
      SUI: '0x2::sui::SUI',
      USDC: process.env.NEXT_PUBLIC_TESTNET_USDC || '0x26b3bc67befc214058ca78ea9a2690298d731a2d4309485ec3d40198063c4abc::usdc::USDC',
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
    },
  },
  mainnet: {
    rpcUrl: process.env.NEXT_PUBLIC_MAINNET_RPC_URL || 'https://fullnode.mainnet.sui.io:443',
    packageId: process.env.NEXT_PUBLIC_MAINNET_PACKAGE_ID || process.env.NEXT_PUBLIC_PACKAGE_ID || '',
    enoki: {
      apiKey: process.env.NEXT_PUBLIC_ENOKI_MAINNET || process.env.NEXT_PUBLIC_ENOKI || '',
      network: 'mainnet' as const,
    },
    coinTypes: {
      SUI: '0x2::sui::SUI',
      USDC: process.env.NEXT_PUBLIC_MAINNET_USDC || '0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN',
    },
    cetus: {
      packageId: process.env.NEXT_PUBLIC_MAINNET_CETUS_PACKAGE || '0x0c7ae833c220aa73a3643a0d508afa4ac5d50d97312ea4584e35f9eb21b9df12',
      globalConfig: process.env.NEXT_PUBLIC_MAINNET_CETUS_GLOBAL_CONFIG || '0xf5ff7d5ba73b581bca6b4b9fa0049cd320360abd154b809f8700a8fd3cfaf7ca',
      pools: {
        SUI_USDC: process.env.NEXT_PUBLIC_MAINNET_CETUS_POOL_SUI_USDC || '0x5eb2dfcdd1b15c8d13a4b0b53ae77b3916fae780160ef9f19ca3e49686541c7a',
        SUI_USDT: '0x06d8af9e6afd27262db436f0d37b304a041f710c3ea1fa4c3a9bab36b3569cc3',
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
      USDC: '0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN',
      USDT: '0x6674cb08a6ef2a155b3c240df0c559fcb5fef5738a17851c124dfbe96bc9a744::coin::COIN',
    },
  },
};

// Network state management - initialize from environment variable
let currentNetwork: NetworkType = (process.env.NEXT_PUBLIC_SUI_NETWORK as NetworkType) || 'mainnet';

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
  const config = NETWORK_CONFIGS[network];
  console.log('🌍 NetworkConfig: Getting config for network:', network, {
    packageId: config.packageId,
    enokiApiKey: config.enoki.apiKey ? config.enoki.apiKey.slice(0, 20) + '...' : 'MISSING',
    enokiNetwork: config.enoki.network
  });
  return config;
}

// Function to get network config by type
export function getNetworkConfig(network: NetworkType): NetworkConfig {
  return NETWORK_CONFIGS[network];
}

// Helper functions for common configuration needs
export function getCurrentRpcUrl(): string {
  return getCurrentNetworkConfig().rpcUrl;
}

export function getCurrentPackageId(): string {
  return getCurrentNetworkConfig().packageId;
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

// Network configuration validation
export function validateNetworkConfig(network: NetworkType): { isValid: boolean; errors: string[] } {
  const config = NETWORK_CONFIGS[network];
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

  // Validate mainnet-specific requirements
  if (network === 'mainnet') {
    if (config.packageId === NETWORK_CONFIGS.testnet.packageId) {
      errors.push('Mainnet is using testnet package ID - please update NEXT_PUBLIC_MAINNET_PACKAGE_ID');
    }
    
    if (config.enoki.apiKey === NETWORK_CONFIGS.testnet.enoki.apiKey) {
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