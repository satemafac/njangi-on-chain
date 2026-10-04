import {
  getCurrentNetwork,
  getCurrentCoinTypes,
  getCurrentPackageId
} from '../services/network-config';

// Network configuration - now uses dynamic network detection
export const NETWORK = getCurrentNetwork();

// Package IDs - now uses dynamic network configuration
export const PACKAGE_ID = getCurrentPackageId();

// Helper function to get coin type based on current network. USDC comes from
// the one resolver in src/config/coin-types.ts (this file used to carry its
// own copy of both networks' types).
export const getCoinType = (coin: 'SUI' | 'USDC'): string => {
  return getCurrentCoinTypes()[coin];
};
