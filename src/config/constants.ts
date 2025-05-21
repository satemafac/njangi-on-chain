// Network configuration
export const NETWORK = process.env.NEXT_PUBLIC_NETWORK || 'testnet';

// Package IDs
export const PACKAGE_ID = '0xbcd6e05ee0c582d2a4157f6d4c266013fc40dd62108a93e9c545ec2ecf013077';

// Coin types by network
export const COIN_TYPES = {
  testnet: {
    SUI: '0x2::sui::SUI',
    USDC: '0x26b3bc67befc214058ca78ea9a2690298d731a2d4309485ec3d40198063c4abc::usdc::USDC'
  },
  mainnet: {
    SUI: '0x2::sui::SUI',
    // Update with mainnet USDC when available
    USDC: '0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN' 
  }
};

// Helper function to get coin type based on current network
export const getCoinType = (coin: 'SUI' | 'USDC'): string => {
  return COIN_TYPES[NETWORK as 'testnet' | 'mainnet'][coin];
}; 