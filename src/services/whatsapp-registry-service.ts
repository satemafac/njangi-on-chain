/**
 * WhatsApp Registry Service
 * 
 * Manages multiple WhatsApp registry versions across different package deployments.
 * Similar to circle-service, this handles backward compatibility when contracts are updated.
 * 
 * Registry Discovery:
 * For testnet/mainnet deployment coins, we can auto-discover registry IDs from init_registry transactions.
 * Instead of manually tracking, we query the transaction history of the deployment coin to find all created registries.
 */

import { getCurrentNetwork, getNetworkConfig } from './network-config';
import { SuiClient } from '@mysten/sui/client';

export type NetworkType = 'testnet' | 'mainnet';

export interface WhatsAppRegistryConfig {
  packageId: string;
  registryObjectId: string;
  description?: string;
  deprecated?: boolean;
}

/**
 * Known WhatsApp registry configurations for each network
 * Add new entries when deploying updated contracts
 * Each network can have multiple registries from different package versions
 */
const WHATSAPP_REGISTRIES: Record<NetworkType, WhatsAppRegistryConfig[]> = {
  testnet: [
    {
      packageId: '0x2ee55011e9d3c27a2743f83fb9f4498de8cdb6078cc175bec03362326f9ec1a1',
      registryObjectId: '0xc4f2bfc4e0022cef04e71ce7f9aecf9b3dfc3dc13085f15e2dbf5e4ace1bde12',
      description: 'Previous testnet package (before unlink fix)',
      deprecated: true,
    },
    {
      // Current testnet - support both naming conventions
      packageId: process.env.NEXT_PUBLIC_TESTNET_WHATSAPP_PACKAGE_ID 
        || process.env.NEXT_PUBLIC_WHATSAPP_PACKAGE_ID 
        || '0x2ee55011e9d3c27a2743f83fb9f4498de8cdb6078cc175bec03362326f9ec1a1',
      registryObjectId: process.env.NEXT_PUBLIC_TESTNET_WHATSAPP_REGISTRY_ID 
        || process.env.NEXT_PUBLIC_WHATSAPP_REGISTRY_ID 
        || process.env.SUI_WHATSAPP_LINKS_REGISTRY_ID 
        || '0x65fad7ceeb6a960af0702280052c85b9e4e467f33531e9b8d3f08c6244bf0150',
      description: 'Current testnet deployment (with unlink fix)',
      deprecated: false,
    },
  ],
  mainnet: [
    {
      // Current mainnet
      packageId: process.env.NEXT_PUBLIC_MAINNET_WHATSAPP_PACKAGE_ID || '',
      registryObjectId: process.env.NEXT_PUBLIC_MAINNET_WHATSAPP_REGISTRY_ID || '',
      description: 'Current mainnet deployment',
      deprecated: false,
    },
  ],
};

/**
 * Configuration for deployment coins per network
 * These coins are used to fund all init_registry transactions
 * We query their transaction history to discover all created registries
 */
const DEPLOYMENT_COINS: Record<NetworkType, string> = {
  testnet: process.env.NEXT_PUBLIC_TESTNET_DEPLOYMENT_COIN || '0x0649a5b68500d73a7fb57bf2b4e9983562da1af970b7fd6fe24e247b7c9c7ed5',
  mainnet: process.env.NEXT_PUBLIC_MAINNET_DEPLOYMENT_COIN || '',
};

/**
 * Auto-discover WhatsApp registries from deployment coin transaction history
 * Queries the coin's transactions to find all init_registry calls and extract created registry IDs
 */
export async function discoverWhatsAppRegistries(network: NetworkType): Promise<WhatsAppRegistryConfig[]> {
  const deploymentCoin = DEPLOYMENT_COINS[network];
  
  if (!deploymentCoin) {
    console.warn(`⚠️ No deployment coin configured for ${network}, skipping auto-discovery`);
    return [];
  }

  try {
    const networkConfig = getNetworkConfig(network);
    const suiClient = new SuiClient({ url: networkConfig.rpcUrl });
    
    console.log(`🔍 Discovering WhatsApp registries for ${network} from coin ${deploymentCoin.slice(0, 10)}...`);
    
    // Query all transactions involving the deployment coin
    const transactions = await suiClient.queryTransactionBlocks({
      options: {
        showObjectChanges: true,
        showEvents: true,
      },
      limit: 100, // Adjust as needed
    });

    const discoveredRegistries: WhatsAppRegistryConfig[] = [];

    // Look through transactions for init_registry calls that created WhatsAppLinksRegistry objects
    for (const tx of transactions.data) {
      if (tx.objectChanges) {
        for (const change of tx.objectChanges) {
          // Look for created WhatsAppLinksRegistry objects
          if (
            change.type === 'created' &&
            change.objectType?.includes('WhatsAppLinksRegistry')
          ) {
            const registryId = change.objectId;
            const packageId = change.objectType?.split('::')[0];

            if (registryId && packageId && packageId !== '0x2') {
              // Extract just the package ID before ::
              const cleanPackageId = packageId.split('::')[0];
              
              discoveredRegistries.push({
                packageId: cleanPackageId,
                registryObjectId: registryId,
                description: `Auto-discovered ${network} registry from package ${cleanPackageId.slice(0, 10)}...`,
                deprecated: false,
              });
              
              console.log(`✅ Discovered registry: ${registryId.slice(0, 10)}... from package ${cleanPackageId.slice(0, 10)}...`);
            }
          }
        }
      }
    }

    return discoveredRegistries;
  } catch (error) {
    console.error(`❌ Error discovering registries for ${network}:`, error);
    return [];
  }
}

/**
 * Refresh registries from blockchain (auto-discovery)
 * Can be called on app startup to keep registry list current
 */
export async function refreshRegistriesFromBlockchain(): Promise<void> {
  try {
    console.log('🔄 Refreshing WhatsApp registries from blockchain...');
    
    // Discover registries for testnet
    const testnetRegistries = await discoverWhatsAppRegistries('testnet');
    if (testnetRegistries.length > 0) {
      // Merge with existing, keeping manually configured ones and adding new discoveries
      const existingTestnet = WHATSAPP_REGISTRIES.testnet;
      const newPackageIds = testnetRegistries.map(r => r.packageId);
      const manuallyConfigured = existingTestnet.filter(r => !newPackageIds.includes(r.packageId));
      
      WHATSAPP_REGISTRIES.testnet = [...manuallyConfigured, ...testnetRegistries];
      console.log(`✅ Updated testnet registries: ${WHATSAPP_REGISTRIES.testnet.length} total`);
    }
    
    // Discover registries for mainnet
    const mainnetRegistries = await discoverWhatsAppRegistries('mainnet');
    if (mainnetRegistries.length > 0) {
      const existingMainnet = WHATSAPP_REGISTRIES.mainnet;
      const newPackageIds = mainnetRegistries.map(r => r.packageId);
      const manuallyConfigured = existingMainnet.filter(r => !newPackageIds.includes(r.packageId));
      
      WHATSAPP_REGISTRIES.mainnet = [...manuallyConfigured, ...mainnetRegistries];
      console.log(`✅ Updated mainnet registries: ${WHATSAPP_REGISTRIES.mainnet.length} total`);
    }
  } catch (error) {
    console.error('❌ Error refreshing registries:', error);
  }
}

/**
 * Get the current active WhatsApp registry for the given network
 * Returns the latest non-deprecated registry
 */
export function getCurrentWhatsAppRegistry(network?: NetworkType): WhatsAppRegistryConfig | null {
  const targetNetwork = network || getCurrentNetwork();
  const registries = WHATSAPP_REGISTRIES[targetNetwork];
  
  // Return the last (most recent) non-deprecated registry
  const activeRegistry = [...registries].reverse().find(r => !r.deprecated);
  
  if (!activeRegistry?.packageId || !activeRegistry?.registryObjectId) {
    console.warn(`⚠️ No active WhatsApp registry configured for ${targetNetwork}`);
    return null;
  }
  
  return activeRegistry;
}

/**
 * Get the current WhatsApp package ID
 */
export function getCurrentWhatsAppPackageId(): string {
  const registry = getCurrentWhatsAppRegistry();
  return registry?.packageId || '';
}

/**
 * Get the current WhatsApp registry object ID
 */
export function getCurrentWhatsAppRegistryId(): string {
  const registry = getCurrentWhatsAppRegistry();
  return registry?.registryObjectId || '';
}

/**
 * Get all registries for a network (including deprecated ones)
 * Useful for querying historical data or migrating between versions
 */
export function getAllWhatsAppRegistries(network?: NetworkType): WhatsAppRegistryConfig[] {
  const targetNetwork = network || getCurrentNetwork();
  return WHATSAPP_REGISTRIES[targetNetwork];
}

/**
 * Get active registries only (non-deprecated)
 * Useful for querying current state
 */
export function getActiveWhatsAppRegistries(network?: NetworkType): WhatsAppRegistryConfig[] {
  const targetNetwork = network || getCurrentNetwork();
  const activeRegistries = WHATSAPP_REGISTRIES[targetNetwork].filter(r => !r.deprecated);
  
  // Debug logging
  console.log(`📱 WhatsApp Active Registries (${targetNetwork}):`, {
    count: activeRegistries.length,
    registries: activeRegistries.map(r => ({
      packageId: r.packageId?.slice(0, 10) + '...',
      registryId: r.registryObjectId?.slice(0, 10) + '...',
      description: r.description
    }))
  });
  
  return activeRegistries;
}

/**
 * Find registry by package ID
 * Useful for determining which registry a circle link was created in
 */
export function getRegistryByPackageId(packageId: string, network?: NetworkType): WhatsAppRegistryConfig | null {
  const targetNetwork = network || getCurrentNetwork();
  return WHATSAPP_REGISTRIES[targetNetwork].find(r => r.packageId === packageId) || null;
}

/**
 * Find registry by registry object ID
 * Useful for reverse lookups
 */
export function getRegistryByObjectId(registryObjectId: string, network?: NetworkType): WhatsAppRegistryConfig | null {
  const targetNetwork = network || getCurrentNetwork();
  return WHATSAPP_REGISTRIES[targetNetwork].find(r => r.registryObjectId === registryObjectId) || null;
}

/**
 * Check if a registry is deprecated
 * Useful for showing warnings when using old registries
 */
export function isRegistryDeprecated(packageId: string, network?: NetworkType): boolean {
  const registry = getRegistryByPackageId(packageId, network);
  return registry?.deprecated || false;
}

/**
 * Get migration suggestions
 * If using a deprecated registry, suggest the current one
 */
export function getMigrationSuggestion(packageId: string, network?: NetworkType): WhatsAppRegistryConfig | null {
  const targetNetwork = network || getCurrentNetwork();
  const currentRegistry = getCurrentWhatsAppRegistry(targetNetwork);
  const oldRegistry = getRegistryByPackageId(packageId, targetNetwork);
  
  if (oldRegistry?.deprecated && currentRegistry) {
    return currentRegistry;
  }
  
  return null;
}

/**
 * Validate WhatsApp registry configuration
 */
export function validateWhatsAppRegistry(network?: NetworkType): { isValid: boolean; errors: string[] } {
  const targetNetwork = network || getCurrentNetwork();
  const registries = getActiveWhatsAppRegistries(targetNetwork);
  const errors: string[] = [];
  
  if (registries.length === 0) {
    errors.push(`No active WhatsApp registries configured for ${targetNetwork}`);
  }
  
  for (const registry of registries) {
    if (!registry.packageId) {
      errors.push(`Missing package ID for ${registry.description}`);
    }
    if (!registry.registryObjectId) {
      errors.push(`Missing registry object ID for ${registry.description}`);
    }
  }
  
  return {
    isValid: errors.length === 0,
    errors
  };
}

/**
 * Log current registry configuration (for debugging)
 */
export function logWhatsAppRegistry(): void {
  const network = getCurrentNetwork();
  const registry = getCurrentWhatsAppRegistry();
  const allRegistries = getAllWhatsAppRegistries();
  
  console.log(`📱 WhatsApp Registry Configuration (${network}):`, {
    current: {
      packageId: registry?.packageId?.slice(0, 10) + '...',
      registryId: registry?.registryObjectId?.slice(0, 10) + '...',
      description: registry?.description,
    },
    total: allRegistries.length,
    active: allRegistries.filter(r => !r.deprecated).length,
    deprecated: allRegistries.filter(r => r.deprecated).length,
  });
}

const whatsappRegistryService = {
  getCurrentWhatsAppRegistry,
  getCurrentWhatsAppPackageId,
  getCurrentWhatsAppRegistryId,
  getAllWhatsAppRegistries,
  getActiveWhatsAppRegistries,
  getRegistryByPackageId,
  getRegistryByObjectId,
  isRegistryDeprecated,
  getMigrationSuggestion,
  validateWhatsAppRegistry,
  logWhatsAppRegistry,
  discoverWhatsAppRegistries,
  refreshRegistriesFromBlockchain,
};

export default whatsappRegistryService;
