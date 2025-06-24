// WhatsApp Business API Types
export interface WhatsAppConfig {
  phoneNumberId: string;
  accessToken: string;
  verifyToken: string;
  appSecret: string;
  webhookUrl: string;
  apiVersion: string;
}

// Webhook Message Types
export interface WhatsAppWebhookMessage {
  from: string;
  id: string;
  timestamp: string;
  type: 'text' | 'interactive' | 'button' | 'list';
  text?: {
    body: string;
  };
  interactive?: {
    type: string;
    button_reply?: {
      id: string;
      title: string;
    };
    list_reply?: {
      id: string;
      title: string;
    };
  };
  button?: {
    text: string;
    payload: string;
  };
}

export interface WhatsAppWebhookEntry {
  id: string;
  changes: Array<{
    value: {
      messaging_product: string;
      metadata: {
        display_phone_number: string;
        phone_number_id: string;
      };
      messages?: WhatsAppWebhookMessage[];
      statuses?: Array<{
        id: string;
        status: 'sent' | 'delivered' | 'read' | 'failed';
        timestamp: string;
        recipient_id: string;
      }>;
    };
    field: string;
  }>;
}

export interface WhatsAppWebhookPayload {
  object: string;
  entry: WhatsAppWebhookEntry[];
}

// Outbound Message Types
export interface WhatsAppTextMessage {
  messaging_product: 'whatsapp';
  to: string;
  type: 'text';
  text: {
    body: string;
  };
}

export interface WhatsAppInteractiveMessage {
  messaging_product: 'whatsapp';
  to: string;
  type: 'interactive';
  interactive: {
    type: 'button' | 'list';
    header?: {
      type: 'text';
      text: string;
    };
    body: {
      text: string;
    };
    footer?: {
      text: string;
    };
    action: {
      buttons?: Array<{
        type: 'reply';
        reply: {
          id: string;
          title: string;
        };
      }>;
      sections?: Array<{
        title: string;
        rows: Array<{
          id: string;
          title: string;
          description?: string;
        }>;
      }>;
    };
  };
}

export interface WhatsAppTemplateMessage {
  messaging_product: 'whatsapp';
  to: string;
  type: 'template';
  template: {
    name: string;
    language: {
      code: string;
    };
    components?: Array<{
      type: 'header' | 'body' | 'button';
      parameters?: Array<{
        type: 'text' | 'currency' | 'date_time';
        text?: string;
        currency?: {
          fallback_value: string;
          code: string;
          amount_1000: number;
        };
        date_time?: {
          fallback_value: string;
        };
      }>;
      sub_type?: string;
      index?: string;
    }>;
  };
}

export type WhatsAppMessage = WhatsAppTextMessage | WhatsAppInteractiveMessage | WhatsAppTemplateMessage;

// Session and State Management
export interface WhatsAppUserSession {
  phoneNumber: string;
  suiAddress?: string;
  currentFlow?: string;
  flowStep?: number;
  flowData?: Record<string, unknown>;
  isAuthenticated: boolean;
  authenticatedAt?: Date;
  expiresAt?: Date;
  lastActivity: Date;
  conversationState?: string;
  currentCommand?: string;
  commandData?: Record<string, unknown>;
  tempAuthToken?: string;
  zkLoginProof?: Record<string, unknown>;
  pendingAuth?: number; // Timestamp of pending authentication request
}

// Command Types
export type WhatsAppCommandType = 'create' | 'join' | 'contribute' | 'status' | 'help' | 'auth' | 'settings';

export interface WhatsAppCommand {
  type: WhatsAppCommandType;
  args: string[];
  rawMessage: string;
  userId: string;
}

// Flow Types
export type FlowType = 'create_circle' | 'join_circle' | 'contribute' | 'authentication' | 'status_check';

export interface ConversationFlow {
  id: string;
  type: FlowType;
  userId: string;
  currentStep: number;
  totalSteps: number;
  data: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
}

// Circle Integration Types
export interface WhatsAppCircleData {
  circleId?: string;
  name?: string;
  currency?: string;
  contributionAmount?: number;
  cycleLength?: string;
  numberOfMembers?: number;
  securityDeposit?: number;
  memberPhoneNumbers?: string[];
}

// Notification Types
export interface WhatsAppNotification {
  id: string;
  phoneNumber: string;
  type: 'reminder' | 'rotation' | 'yield_update' | 'circle_update' | 'payment_due';
  templateName: string;
  parameters?: Record<string, unknown>;
  scheduledAt?: Date;
  sentAt?: Date;
  status: 'pending' | 'sent' | 'delivered' | 'read' | 'failed';
  retryCount: number;
  maxRetries: number;
}

// API Response Types
export interface WhatsAppAPIResponse {
  messaging_product: string;
  contacts: Array<{
    input: string;
    wa_id: string;
  }>;
  messages: Array<{
    id: string;
  }>;
}

export interface WhatsAppError {
  error: {
    message: string;
    type: string;
    code: number;
    error_subcode?: number;
    fbtrace_id: string;
  };
}

// Rate Limiting Types
export interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
  skipSuccessfulRequests: boolean;
  skipFailedRequests: boolean;
}

export interface RateLimitInfo {
  limit: number;
  current: number;
  remaining: number;
  resetTime: Date;
}

// Audit Log Types
export interface WhatsAppAuditLog {
  id: string;
  userId: string;
  phoneNumber: string;
  action: string;
  details: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
  timestamp: Date;
  success: boolean;
  errorMessage?: string;
} 