import { 
  getCurrentNetwork, 
  getCurrentCoinTypes, 
  getCurrentPackageId 
} from '../services/network-config';

// Network configuration - now uses dynamic network detection
export const NETWORK = getCurrentNetwork();

// Package IDs - now uses dynamic network configuration
export const PACKAGE_ID = getCurrentPackageId();

// Coin types by network - now uses dynamic network configuration
export const COIN_TYPES = {
  testnet: {
    SUI: '0x2::sui::SUI',
    USDC: '0x26b3bc67befc214058ca78ea9a2690298d731a2d4309485ec3d40198063c4abc::usdc::USDC'
  },
  mainnet: {
    SUI: '0x2::sui::SUI',
    USDC: '0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN' 
  }
};

// Helper function to get coin type based on current network
export const getCoinType = (coin: 'SUI' | 'USDC'): string => {
  return getCurrentCoinTypes()[coin];
}; 