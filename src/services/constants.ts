// Package ID for the Njangi Circle - network-aware
import { getCurrentPackageId } from './network-config';
export const PACKAGE_ID = getCurrentPackageId();

// Cetus DEX constants - network-aware
import { getCurrentCetusConfig } from './network-config';
const cetusConfig = getCurrentCetusConfig();
export const CETUS_PACKAGE = cetusConfig.packageId;
export const CETUS_ROUTER = "0x3a5143bb1196e3bcdfab6203d1683ae29edd26294fc8bfeac534ba8a45e32857";
export const CETUS_PUBLISHED_AT = cetusConfig.published_at || "0xb2a1d27337788bda89d350703b8326952413bd94b35b9b573ac8401b9803d018";
export const CETUS_GLOBAL_CONFIG = cetusConfig.globalConfig;

// SUI-USDC Pool on Cetus - network-aware
export const CETUS_POOL_SUI_USDC = cetusConfig.pools.SUI_USDC;

// DeepBook constants (Testnet)
// Updated to DeepBookV3
export const DEEPBOOK_PACKAGE = "0xdee9";
export const DEEPBOOK_MODULE = "pool"; // Updated from clob_v2 to pool for V3
export const DEEPBOOK_SUI_USDC_POOL = "0x9e69acc50b2671183ceedb6854d0ba2cf143cd9b9fd449486aab2bc7ce62674c";
export const DEEP_COIN_TYPE = "0xdee9::deep::DEEP";

// Standard coin types - using network-aware configuration
import { getCurrentCoinTypes } from './network-config';
export const SUI_COIN_TYPE = "0x2::sui::SUI";
export const USDC_COIN_TYPE = getCurrentCoinTypes().USDC;

// Minimum deposit amount in SUI (0.001 SUI)
export const MIN_DEPOSIT_AMOUNT = 1000000; // in MIST (1e-9 SUI)

// Default slippage percentage
export const DEFAULT_SLIPPAGE = 0.5; 