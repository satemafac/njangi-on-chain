/**
 * WhatsApp Registry Initialization
 * 
 * This module handles auto-discovery of WhatsApp registries on app startup.
 * It queries the deployment coins to find all created registries from init_registry transactions.
 */

import { refreshRegistriesFromBlockchain } from '@/services/whatsapp-registry-service';

let discoveryInProgress = false;
let lastDiscoveryTime = 0;
const DISCOVERY_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Initialize WhatsApp registries
 * Automatically discovers registries from blockchain on first call or after cache expiry
 */
export async function initializeWhatsAppRegistries(): Promise<void> {
  // Skip if discovery is already in progress
  if (discoveryInProgress) {
    console.log('⏳ WhatsApp registry discovery already in progress...');
    return;
  }

  // Skip if we've recently discovered (cache hit)
  const timeSinceLastDiscovery = Date.now() - lastDiscoveryTime;
  if (lastDiscoveryTime > 0 && timeSinceLastDiscovery < DISCOVERY_CACHE_TTL) {
    console.log(`✅ Using cached registry discovery (${Math.round(timeSinceLastDiscovery / 1000)}s old)`);
    return;
  }

  try {
    discoveryInProgress = true;
    console.log('🚀 Initializing WhatsApp registries from blockchain...');
    
    await refreshRegistriesFromBlockchain();
    
    lastDiscoveryTime = Date.now();
    console.log('✅ WhatsApp registries initialized successfully');
  } catch (error) {
    console.error('❌ Failed to initialize WhatsApp registries:', error);
    // Don't throw - allow app to continue even if discovery fails
    // Manual env vars will be used as fallback
  } finally {
    discoveryInProgress = false;
  }
}

/**
 * Force refresh registries from blockchain
 * Bypasses cache, useful for debugging or manual updates
 */
export async function forceRefreshWhatsAppRegistries(): Promise<void> {
  try {
    lastDiscoveryTime = 0; // Clear cache
    await initializeWhatsAppRegistries();
  } catch (error) {
    console.error('❌ Failed to force refresh registries:', error);
    throw error;
  }
}

