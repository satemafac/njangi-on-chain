/**
 * 🔧 Configuration Module
 * 
 * Loads and validates all environment variables
 * - Sui RPC endpoints
 * - WhatsApp Cloud API credentials
 * - zkLogin (Enoki) configuration
 * - Server settings
 */

import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

// Load environment variables from .env.local or .env
// On Heroku, environment variables are passed directly via process.env
// Skip dotenv loading in production - use Heroku's process.env directly
if (process.env.NODE_ENV !== 'production') {
  // Development: try to load from local .env file
  const envPath = path.resolve(process.cwd(), '.env.local');
  if (fs.existsSync(envPath)) {
    console.log(`📋 Loading .env.local from: ${envPath}`);
    dotenv.config({ path: envPath });
  } else {
    console.log(`📋 No .env.local found at: ${envPath}, using process.env`);
  }
} else {
  // Production (Heroku): Don't load from file, use Heroku's process.env directly
  console.log('📋 Production mode - using Heroku environment variables directly');
}

// ============================================================
// Type Definitions
// ============================================================

export interface SuiConfig {
  testnetRpcUrl: string;
  mainnetRpcUrl: string;
  testnetRpcAlt: string;
  mainnetRpcAlt: string;
  testnetPackageId: string;
  mainnetPackageId: string;
  defaultPackageId: string;
  whatsappLinksRegistryId: string;
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
  defaultEnoki: string;
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

// ============================================================
// Load Configuration
// ============================================================

export function loadConfig(): Config {
  console.log('📋 Loading configuration from environment variables (Node env: ' + (process.env.NODE_ENV || 'development') + ')');

  try {
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
      testnetRpcUrl: validateUrl('NEXT_PUBLIC_TESTNET_RPC_URL', process.env.NEXT_PUBLIC_TESTNET_RPC_URL || ''),
      mainnetRpcUrl: validateUrl('NEXT_PUBLIC_MAINNET_RPC_URL', process.env.NEXT_PUBLIC_MAINNET_RPC_URL || ''),
      testnetRpcAlt: validateUrl('NEXT_PUBLIC_TESTNET_RPC_ALT', process.env.NEXT_PUBLIC_TESTNET_RPC_ALT || 'https://testnet-rpc-alt.sui.io'),
      mainnetRpcAlt: validateUrl('NEXT_PUBLIC_MAINNET_RPC_ALT', process.env.NEXT_PUBLIC_MAINNET_RPC_ALT || 'https://mainnet-rpc-alt.sui.io'),
      testnetPackageId: validateRequiredVar('NEXT_PUBLIC_TESTNET_PACKAGE_ID', process.env.NEXT_PUBLIC_TESTNET_PACKAGE_ID),
      mainnetPackageId: validateRequiredVar('NEXT_PUBLIC_MAINNET_PACKAGE_ID', process.env.NEXT_PUBLIC_MAINNET_PACKAGE_ID),
      defaultPackageId: validateRequiredVar('NEXT_PUBLIC_PACKAGE_ID', process.env.NEXT_PUBLIC_PACKAGE_ID),
      // Use testnet registry by default, support legacy name for backward compatibility
      whatsappLinksRegistryId: validateRequiredVar('NEXT_PUBLIC_TESTNET_WHATSAPP_REGISTRY_ID', 
        process.env.NEXT_PUBLIC_TESTNET_WHATSAPP_REGISTRY_ID || process.env.SUI_WHATSAPP_LINKS_REGISTRY_ID),
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
      testnetEnoki: validateRequiredVar('ZKLOGIN_TESTNET_ENOKI_KEY', process.env.ZKLOGIN_TESTNET_ENOKI_KEY),
      mainnetEnoki: validateRequiredVar('ZKLOGIN_MAINNET_ENOKI_KEY', process.env.ZKLOGIN_MAINNET_ENOKI_KEY),
      defaultEnoki: validateRequiredVar('ZKLOGIN_DEFAULT_ENOKI_KEY', process.env.ZKLOGIN_DEFAULT_ENOKI_KEY),
      google: {
        clientId: validateRequiredVar('ZKLOGIN_GOOGLE_CLIENT_ID', process.env.ZKLOGIN_GOOGLE_CLIENT_ID),
        clientSecret: process.env.ZKLOGIN_GOOGLE_CLIENT_SECRET || 'not-configured',
      },
      facebook: {
        clientId: validateRequiredVar('ZKLOGIN_FACEBOOK_CLIENT_ID', process.env.ZKLOGIN_FACEBOOK_CLIENT_ID),
        clientSecret: process.env.NEXT_PUBLIC_FACEBOOK_CLIENT_SECRET || process.env.ZKLOGIN_FACEBOOK_CLIENT_SECRET || 'not-configured',
      },
      apple: {
        clientId: validateRequiredVar('ZKLOGIN_APPLE_CLIENT_ID', process.env.ZKLOGIN_APPLE_CLIENT_ID),
        clientSecret: process.env.ZKLOGIN_APPLE_CLIENT_SECRET || 'not-configured',
      },
      redirectUrl: validateUrl('ZKLOGIN_REDIRECT_URL', process.env.ZKLOGIN_REDIRECT_URL || 'http://localhost:3000/api/auth/callback'),
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

  // Validate Sui
  if (!config.sui.testnetPackageId || config.sui.testnetPackageId.length === 0) {
    errors.push('Sui testnet package ID is not configured');
  }
  if (!config.sui.mainnetPackageId || config.sui.mainnetPackageId.length === 0) {
    errors.push('Sui mainnet package ID is not configured');
  }
  if (!config.sui.defaultPackageId || config.sui.defaultPackageId.length === 0) {
    errors.push('Sui default package ID is not configured');
  }

  // Validate WhatsApp
  if (!config.whatsapp.accessToken || config.whatsapp.accessToken.length === 0) {
    errors.push('WhatsApp access token is not configured');
  }

  // Validate zkLogin - Enoki keys
  if (!config.zkLogin.testnetEnoki || config.zkLogin.testnetEnoki.length === 0) {
    errors.push('Testnet Enoki key is not configured');
  }
  if (!config.zkLogin.mainnetEnoki || config.zkLogin.mainnetEnoki.length === 0) {
    errors.push('Mainnet Enoki key is not configured');
  }
  if (!config.zkLogin.defaultEnoki || config.zkLogin.defaultEnoki.length === 0) {
    errors.push('Default Enoki key is not configured');
  }

  // Validate OAuth providers
  if (!config.zkLogin.google.clientId || config.zkLogin.google.clientId.length === 0) {
    errors.push('Google OAuth client ID is not configured');
  }
  if (!config.zkLogin.facebook.clientId || config.zkLogin.facebook.clientId.length === 0) {
    errors.push('Facebook OAuth client ID is not configured');
  }
  if (!config.zkLogin.apple.clientId || config.zkLogin.apple.clientId.length === 0) {
    errors.push('Apple OAuth client ID is not configured');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
