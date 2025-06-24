import { WhatsAppConfig, RateLimitConfig } from '../types/whatsapp';

export const whatsappConfig: WhatsAppConfig = {
  phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
  accessToken: process.env.WHATSAPP_ACCESS_TOKEN || '',
  verifyToken: process.env.WHATSAPP_VERIFY_TOKEN || '',
  appSecret: process.env.WHATSAPP_APP_SECRET || '',
  webhookUrl: process.env.WHATSAPP_WEBHOOK_URL || '',
  apiVersion: process.env.WHATSAPP_API_VERSION || 'v21.0',
};

export const whatsappApiUrl = `https://graph.facebook.com/${whatsappConfig.apiVersion}/${whatsappConfig.phoneNumberId}/messages`;

export const rateLimitConfig: RateLimitConfig = {
  windowMs: 15 * 60 * 1000, // 15 minutes
  maxRequests: 100, // Limit each phone number to 100 requests per windowMs
  skipSuccessfulRequests: false,
  skipFailedRequests: false,
};

export const sessionConfig = {
  // Session timeout in milliseconds (1 hour)
  sessionTimeout: 60 * 60 * 1000,
  // Flow timeout in milliseconds (30 minutes)
  flowTimeout: 30 * 60 * 1000,
  // Maximum number of retry attempts for failed operations
  maxRetries: 3,
  // Delay between retries in milliseconds
  retryDelay: 2000,
};

export const commandConfig = {
  // Supported commands
  commands: {
    CREATE: '/create',
    JOIN: '/join',
    CONTRIBUTE: '/contribute',
    STATUS: '/status',
    HELP: '/help',
    AUTH: '/auth',
    SETTINGS: '/settings',
    CANCEL: '/cancel',
    BACK: '/back',
  },
  // Command aliases
  aliases: {
    'c': '/create',
    'j': '/join',
    'pay': '/contribute',
    'p': '/contribute',
    's': '/status',
    'h': '/help',
    '?': '/help',
    'login': '/auth',
    'logout': '/auth logout',
    'quit': '/cancel',
    'exit': '/cancel',
  },
};

export const notificationTemplates = {
  // Pre-approved WhatsApp template names
  PAYMENT_REMINDER: 'payment_reminder',
  ROTATION_NOTIFICATION: 'rotation_notification',
  YIELD_UPDATE: 'yield_update',
  CIRCLE_CREATED: 'circle_created',
  MEMBER_JOINED: 'member_joined',
  CONTRIBUTION_RECEIVED: 'contribution_received',
  AUTHENTICATION_REQUIRED: 'auth_required',
  WELCOME_MESSAGE: 'welcome_message',
};

export const flowSteps = {
  CREATE_CIRCLE: {
    WELCOME: 0,
    CIRCLE_NAME: 1,
    CURRENCY_SELECTION: 2,
    CONTRIBUTION_AMOUNT: 3,
    CYCLE_LENGTH: 4,
    NUMBER_OF_MEMBERS: 5,
    SECURITY_DEPOSIT: 6,
    CONFIRMATION: 7,
    AUTHENTICATION: 8,
    COMPLETION: 9,
  },
  JOIN_CIRCLE: {
    WELCOME: 0,
    CIRCLE_VERIFICATION: 1,
    SECURITY_DEPOSIT: 2,
    CONFIRMATION: 3,
    AUTHENTICATION: 4,
    COMPLETION: 5,
  },
  CONTRIBUTE: {
    CIRCLE_SELECTION: 0,
    AMOUNT_VERIFICATION: 1,
    CONFIRMATION: 2,
    AUTHENTICATION: 3,
    COMPLETION: 4,
  },
  AUTHENTICATION: {
    WELCOME: 0,
    PHONE_VERIFICATION: 1,
    ZKLOGIN_REDIRECT: 2,
    VERIFICATION_COMPLETE: 3,
  },
};

// Validation rules
export const validationRules = {
  phoneNumber: /^\+[1-9]\d{1,14}$/,
  circleId: /^[a-zA-Z0-9_-]{1,50}$/,
  contributionAmount: {
    min: 0.01,
    max: 1000000,
  },
  circleName: {
    minLength: 3,
    maxLength: 50,
    pattern: /^[a-zA-Z0-9\s_-]+$/,
  },
  numberOfMembers: {
    min: 3,
    max: 50,
  },
};

export const errorMessages = {
  INVALID_COMMAND: 'Invalid command. Type /help to see available commands.',
  AUTHENTICATION_REQUIRED: 'You need to authenticate first. Type /auth to start.',
  SESSION_EXPIRED: 'Your session has expired. Please start over.',
  RATE_LIMIT_EXCEEDED: 'Too many requests. Please wait before sending another message.',
  INVALID_PHONE_NUMBER: 'Invalid phone number format.',
  CIRCLE_NOT_FOUND: 'Circle not found. Please check the circle ID.',
  INSUFFICIENT_BALANCE: 'Insufficient balance for this operation.',
  TRANSACTION_FAILED: 'Transaction failed. Please try again.',
  FLOW_CANCELLED: 'Operation cancelled. Type /help for available commands.',
  NETWORK_ERROR: 'Network error. Please try again later.',
};

export const successMessages = {
  AUTHENTICATION_SUCCESS: 'Authentication successful! You can now manage your circles.',
  CIRCLE_CREATED: 'Circle created successfully! Share the circle ID with members.',
  CIRCLE_JOINED: 'Successfully joined the circle!',
  CONTRIBUTION_SENT: 'Contribution sent successfully!',
  FLOW_COMPLETED: 'Operation completed successfully!',
};

// Helper function to validate environment variables
export function validateWhatsAppConfig(): boolean {
  const requiredVars = [
    'WHATSAPP_PHONE_NUMBER_ID',
    'WHATSAPP_ACCESS_TOKEN',
    'WHATSAPP_VERIFY_TOKEN',
    'WHATSAPP_APP_SECRET',
  ];

  const missingVars = requiredVars.filter(varName => !process.env[varName]);
  
  if (missingVars.length > 0) {
    console.error('Missing required WhatsApp environment variables:', missingVars);
    return false;
  }
  
  return true;
} 