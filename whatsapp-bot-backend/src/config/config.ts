import { loadLocalEnvFile, resolveBotRuntimeEnvFromProcessEnv, type NetworkType } from './env';

const loadedEnvFile = loadLocalEnvFile();

if (loadedEnvFile) {
  console.log(`📋 Loaded environment from: ${loadedEnvFile}`);
} else if (process.env.NODE_ENV === 'production') {
  console.log('📋 Production mode - using process.env directly');
} else {
  console.log('📋 No root .env.local found - using current process.env');
}

// ============================================================
// Type Definitions
// ============================================================

export interface SuiConfig {
  currentNetwork: NetworkType;
  testnetRpcUrl: string;
  mainnetRpcUrl: string;
  testnetRpcAlt: string;
  mainnetRpcAlt: string;
  testnetPackageId: string;
  mainnetPackageId: string;
  testnetWhatsAppPackageId: string;
  mainnetWhatsAppPackageId: string;
  testnetWhatsAppRegistryId: string;
  mainnetWhatsAppRegistryId: string;
  currentRpcUrl: string;
  currentRpcAlt: string;
  currentPackageId: string;
  currentWhatsAppPackageId: string;
  currentWhatsAppRegistryId: string;
}

export interface WhatsAppConfig {
  phoneNumberId: string;
  accessToken: string;
  verifyToken: string;
  appSecret: string;
  apiVersion: string;
  webhookUrl: string;
  businessAccountId: string;
}

export interface OAuthProvider {
  clientId: string;
  clientSecret: string;
}

export interface ZkLoginConfig {
  issuerUrl: string;
  testnetEnoki: string;
  mainnetEnoki: string;
  currentEnoki: string;
  google: OAuthProvider;
  facebook: OAuthProvider;
  apple: OAuthProvider;
  redirectUrl: string;
}

export interface AppConfig {
  nodeEnv: 'development' | 'production' | 'test';
  port: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  logFile: string;
  enableEventListener: boolean;
  enableMessageSender: boolean;
  enableOnChainLogging: boolean;
}

export interface Config {
  app: AppConfig;
  sui: SuiConfig;
  whatsapp: WhatsAppConfig;
  zkLogin: ZkLoginConfig;
}

// ============================================================
// Validation Functions
// ============================================================

function validateRequiredVar(varName: string, value: string | undefined): string {
  if (!value || value.trim() === '') {
    throw new Error(`❌ Required environment variable missing: ${varName}`);
  }
  return value;
}

function validateUrl(varName: string, value: string): string {
  const url = validateRequiredVar(varName, value);
  try {
    new URL(url);
    return url;
  } catch {
    throw new Error(`❌ Invalid URL for ${varName}: ${url}`);
  }
}

function validateNumber(varName: string, value: string | undefined, defaultValue?: number): number {
  if (!value) {
    if (defaultValue !== undefined) return defaultValue;
    throw new Error(`❌ Required environment variable missing: ${varName}`);
  }
  const num = parseInt(value, 10);
  if (isNaN(num)) {
    throw new Error(`❌ Invalid number for ${varName}: ${value}`);
  }
  return num;
}

function validateBoolean(_varName: string, value: string | undefined, defaultValue: boolean = false): boolean {
  if (!value) return defaultValue;
  return value.toLowerCase() === 'true';
}

function optionalUrl(value: string | undefined, fallback: string): string {
  const candidate = value && value.trim() !== '' ? value : fallback;
  try {
    new URL(candidate);
    return candidate;
  } catch {
    return fallback;
  }
}

function optionalVar(...values: Array<string | undefined>): string {
  for (const value of values) {
    if (value && value.trim() !== '') {
      return value;
    }
  }
  return '';
}

// ============================================================
// Load Configuration
// ============================================================

export function loadConfig(): Config {
  console.log('📋 Loading configuration from environment variables (Node env: ' + (process.env.NODE_ENV || 'development') + ')');

  try {
    const resolvedEnv = resolveBotRuntimeEnvFromProcessEnv(process.env);
    const currentSui = resolvedEnv.networks[resolvedEnv.currentNetwork];

    // App Configuration
    const app: AppConfig = {
      nodeEnv: (process.env.NODE_ENV || 'development') as 'development' | 'production' | 'test',
      port: validateNumber('PORT', process.env.PORT, 3000),
      logLevel: (process.env.LOG_LEVEL || 'info') as 'debug' | 'info' | 'warn' | 'error',
      logFile: process.env.LOG_FILE || 'logs/app.log',
      enableEventListener: validateBoolean('ENABLE_EVENT_LISTENER', process.env.ENABLE_EVENT_LISTENER, true),
      enableMessageSender: validateBoolean('ENABLE_MESSAGE_SENDER', process.env.ENABLE_MESSAGE_SENDER, true),
      enableOnChainLogging: validateBoolean('ENABLE_ON_CHAIN_LOGGING', process.env.ENABLE_ON_CHAIN_LOGGING, true),
    };

    // Sui Configuration
    const sui: SuiConfig = {
      currentNetwork: resolvedEnv.currentNetwork,
      testnetRpcUrl: validateUrl('NEXT_PUBLIC_TESTNET_RPC_URL', resolvedEnv.networks.testnet.rpcUrl),
      mainnetRpcUrl: validateUrl('NEXT_PUBLIC_MAINNET_RPC_URL', resolvedEnv.networks.mainnet.rpcUrl),
      testnetRpcAlt: validateUrl('NEXT_PUBLIC_TESTNET_RPC_ALT', resolvedEnv.networks.testnet.rpcAltUrl),
      mainnetRpcAlt: validateUrl('NEXT_PUBLIC_MAINNET_RPC_ALT', resolvedEnv.networks.mainnet.rpcAltUrl),
      testnetPackageId: resolvedEnv.networks.testnet.packageId,
      mainnetPackageId: resolvedEnv.networks.mainnet.packageId,
      testnetWhatsAppPackageId: resolvedEnv.networks.testnet.whatsappPackageId,
      mainnetWhatsAppPackageId: resolvedEnv.networks.mainnet.whatsappPackageId,
      testnetWhatsAppRegistryId: resolvedEnv.networks.testnet.whatsappRegistryId,
      mainnetWhatsAppRegistryId: resolvedEnv.networks.mainnet.whatsappRegistryId,
      currentRpcUrl: currentSui.rpcUrl,
      currentRpcAlt: currentSui.rpcAltUrl,
      currentPackageId: currentSui.packageId,
      currentWhatsAppPackageId: currentSui.whatsappPackageId,
      currentWhatsAppRegistryId: currentSui.whatsappRegistryId,
    };

    // WhatsApp Configuration
    const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    
    // Debug logging for WhatsApp config
    console.log('📱 WhatsApp Configuration Loading:');
    console.log(`  - Access Token Present: ${accessToken ? 'YES (' + accessToken.substring(0, 30) + '...)' : 'MISSING'}`);
    console.log(`  - Phone Number ID Present: ${phoneNumberId ? 'YES' : 'MISSING'}`);
    console.log(`  - NODE_ENV: ${process.env.NODE_ENV}`);
    
    const whatsapp: WhatsAppConfig = {
      phoneNumberId: validateRequiredVar('WHATSAPP_PHONE_NUMBER_ID', phoneNumberId),
      accessToken: validateRequiredVar('WHATSAPP_ACCESS_TOKEN', accessToken),
      verifyToken: validateRequiredVar('WHATSAPP_VERIFY_TOKEN', process.env.WHATSAPP_VERIFY_TOKEN),
      appSecret: validateRequiredVar('WHATSAPP_APP_SECRET', process.env.WHATSAPP_APP_SECRET),
      apiVersion: process.env.WHATSAPP_API_VERSION || 'v21.0',
      webhookUrl: validateUrl('WHATSAPP_WEBHOOK_URL', process.env.WHATSAPP_WEBHOOK_URL || ''),
      businessAccountId: validateRequiredVar('WHATSAPP_BUSINESS_ACCOUNT_ID', process.env.WHATSAPP_BUSINESS_ACCOUNT_ID),
    };

    // zkLogin Configuration (Enoki)
    const zkLogin: ZkLoginConfig = {
      issuerUrl: process.env.ZKLOGIN_ISSUER_URL || 'https://accounts.google.com',
      testnetEnoki: resolvedEnv.networks.testnet.enokiApiKey,
      mainnetEnoki: resolvedEnv.networks.mainnet.enokiApiKey,
      currentEnoki: currentSui.enokiApiKey,
      google: {
        clientId: optionalVar(process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID, process.env.ZKLOGIN_GOOGLE_CLIENT_ID),
        clientSecret: optionalVar(process.env.ZKLOGIN_GOOGLE_CLIENT_SECRET),
      },
      facebook: {
        clientId: optionalVar(process.env.NEXT_PUBLIC_FACEBOOK_CLIENT_ID, process.env.ZKLOGIN_FACEBOOK_CLIENT_ID),
        clientSecret: optionalVar(process.env.ZKLOGIN_FACEBOOK_CLIENT_SECRET),
      },
      apple: {
        clientId: optionalVar(process.env.NEXT_PUBLIC_APPLE_CLIENT_ID, process.env.ZKLOGIN_APPLE_CLIENT_ID),
        clientSecret: optionalVar(process.env.ZKLOGIN_APPLE_CLIENT_SECRET),
      },
      redirectUrl: optionalUrl(
        process.env.NEXT_PUBLIC_REDIRECT_URI || process.env.ZKLOGIN_REDIRECT_URL,
        'http://localhost:3000/auth/callback',
      ),
    };

    const config: Config = {
      app,
      sui,
      whatsapp,
      zkLogin,
    };

    console.log(`✅ Configuration loaded successfully for environment: ${app.nodeEnv}`);
    return config;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`❌ Configuration Error: ${message}`);
    process.exit(1);
  }
}

// ============================================================
// Configuration Instance
// ============================================================

let configInstance: Config | null = null;

export function getConfig(): Config {
  if (!configInstance) {
    configInstance = loadConfig();
  }
  return configInstance;
}

// ============================================================
// Validation Utility
// ============================================================

export function validateConfig(config: Config): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!config.sui.currentPackageId || config.sui.currentPackageId.length === 0) {
    errors.push(`Sui package ID is not configured for ${config.sui.currentNetwork}`);
  }

  if (!config.sui.currentRpcUrl || config.sui.currentRpcUrl.length === 0) {
    errors.push(`Sui RPC URL is not configured for ${config.sui.currentNetwork}`);
  }

  if (!config.sui.currentWhatsAppRegistryId || config.sui.currentWhatsAppRegistryId.length === 0) {
    errors.push(`WhatsApp registry ID is not configured for ${config.sui.currentNetwork}`);
  }

  // Validate WhatsApp
  if (!config.whatsapp.accessToken || config.whatsapp.accessToken.length === 0) {
    errors.push('WhatsApp access token is not configured');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

export function resetConfigForTests(): void {
  configInstance = null;
}
