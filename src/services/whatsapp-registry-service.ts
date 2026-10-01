/**
 * WhatsApp Registry Service
 * 
 * Manages multiple WhatsApp registry versions across different package deployments.
 * Similar to circle-service, this handles backward compatibility when contracts are updated.
 * 
 * Registry catalog:
 * Built once, when this module loads, from public env. Each network's current entry is
 * NEXT_PUBLIC_<NET>_WHATSAPP_PACKAGE_ID + NEXT_PUBLIC_<NET>_WHATSAPP_REGISTRY_ID, read from
 * src/config/public-env.ts through getWhatsAppConfigForNetwork. After a publish,
 * move/build_and_test.sh writes the package id to .env.local and scripts/bootstrap-package.mjs
 * writes the id of the registry its init_registry call creates (only when that var is empty).
 * Next inlines NEXT_PUBLIC_* at build time, so a deployed app sees a new id only once the env
 * var is set on Vercel and the app is redeployed. Older pairs are hardcoded in
 * buildRegistryCatalog() as deprecated. There is no on-chain discovery: registry ids change
 * only through env.
 */

import { getCurrentNetwork, getWhatsAppConfigForNetwork } from './network-config';
import type { NetworkType } from '@/config/public-env';

export type { NetworkType } from '@/config/public-env';

export interface WhatsAppRegistryConfig {
  packageId: string;
  registryObjectId: string;
  description?: string;
  deprecated?: boolean;
}

/**
 * Known WhatsApp registry configurations for each network
 * The current entry comes from env (see the header); keep replaced pairs here as deprecated
 * Each network can have multiple registries from different package versions
 */
function buildRegistryCatalog(): Record<NetworkType, WhatsAppRegistryConfig[]> {
  const testnetCurrent = getWhatsAppConfigForNetwork('testnet');
  const mainnetCurrent = getWhatsAppConfigForNetwork('mainnet');

  return {
    testnet: [
      {
        packageId: '0x2ee55011e9d3c27a2743f83fb9f4498de8cdb6078cc175bec03362326f9ec1a1',
        registryObjectId: '0xc4f2bfc4e0022cef04e71ce7f9aecf9b3dfc3dc13085f15e2dbf5e4ace1bde12',
        description: 'Previous testnet package (before unlink fix)',
        deprecated: true,
      },
      {
        packageId: testnetCurrent.packageId,
        registryObjectId: testnetCurrent.registryObjectId,
        description: 'Current testnet deployment',
        deprecated: false,
      },
    ],
    mainnet: [
      {
        packageId: mainnetCurrent.packageId,
        registryObjectId: mainnetCurrent.registryObjectId,
        description: 'Current mainnet deployment',
        deprecated: false,
      },
    ],
  };
}

const WHATSAPP_REGISTRIES: Record<NetworkType, WhatsAppRegistryConfig[]> = buildRegistryCatalog();

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
};

export default whatsappRegistryService;
