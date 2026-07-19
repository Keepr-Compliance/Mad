/**
 * IPC Channel Definitions
 * Type-safe IPC channel definitions and type helpers
 */

import type {
  User,
  Contact,
  Transaction,
  Communication,
  UserFeedback,
  TransactionFilters,
  CommunicationFilters,
  ContactFilters,
  NewContact,
  NewTransaction,
  OAuthProvider,
  ExportFormat,
} from "../models";
import type { ExportResult, ExtractionResult, SyncStatus } from "../database";

// ============================================
// IPC CHANNEL DEFINITIONS
// ============================================

/**
 * Type-safe IPC channel definitions
 * Format: { 'channel:name': { request: RequestType, response: ResponseType } }
 */
export interface IpcChannels {
  // ============================================
  // AUTHENTICATION CHANNELS
  // ============================================
  "auth:login": {
    request: { provider: OAuthProvider };
    response: { success: boolean; user?: User; error?: string };
  };
  "auth:logout": {
    request: { userId: string };
    response: { success: boolean };
  };
  "auth:get-current-user": {
    request: void;
    response: User | null;
  };
  "auth:refresh-token": {
    request: { provider: OAuthProvider };
    response: { success: boolean; error?: string };
  };

  // ============================================
  // TRANSACTION CHANNELS
  // ============================================
  "transactions:get-all": {
    request: { userId: string; filters?: TransactionFilters };
    response: Transaction[];
  };
  /** BACKLOG-1124: Lightweight pending count via SQL COUNT(*) */
  "transactions:get-pending-count": {
    request: { userId: string };
    response: { success: boolean; count: number };
  };
  "transactions:get-by-id": {
    request: { transactionId: string };
    response: Transaction | null;
  };
  "transactions:create": {
    request: { userId: string; transactionData: NewTransaction };
    response: Transaction;
  };
  "transactions:update": {
    request: { transactionId: string; updates: Partial<Transaction> };
    response: { success: boolean };
  };
  "transactions:delete": {
    request: { transactionId: string };
    response: { success: boolean };
  };
  "transactions:extract-data": {
    request: { transactionId: string };
    response: ExtractionResult;
  };
  "transactions:export": {
    request: {
      transactionId: string;
      format: ExportFormat;
      options?: {
        includeAttachments?: boolean;
        includeEmails?: boolean;
        includeTexts?: boolean;
      };
    };
    response: ExportResult;
  };
  "transactions:link-contact": {
    request: { transactionId: string; contactId: string; role?: string };
    response: { success: boolean };
  };
  "transactions:unlink-contact": {
    request: { transactionId: string; contactId: string };
    response: { success: boolean };
  };

  // ============================================
  // CONTACT CHANNELS
  // ============================================
  "contacts:get-all": {
    request: { userId: string; filters?: ContactFilters };
    response: Contact[];
  };
  "contacts:get-available": {
    request: { userId: string };
    response: Contact[];
  };
  "contacts:get-sorted-by-activity": {
    request: { userId: string; propertyAddress?: string };
    response: Contact[];
  };
  "contacts:create": {
    request: { userId: string; contactData: NewContact };
    response: Contact;
  };
  "contacts:update": {
    request: { contactId: string; updates: Partial<Contact> };
    response: { success: boolean };
  };
  "contacts:delete": {
    request: { contactId: string };
    response: { success: boolean };
  };
  "contacts:remove": {
    request: { contactId: string };
    response: { success: boolean };
  };
  "contacts:checkCanDelete": {
    request: { contactId: string };
    response: { canDelete: boolean; linkedTransactions: number };
  };
  "contacts:import": {
    request: { userId: string; contactsToImport: NewContact[] };
    response: { success: boolean; contacts?: Contact[]; error?: string };
  };
  "contacts:forceReimport": {
    request: { userId: string };
    response: { success: boolean; cleared: number; error?: string };
  };
  "contacts:syncOutlookContacts": {
    request: { userId: string };
    response: { success: boolean; count?: number; reconnectRequired?: boolean; tokenExpired?: boolean; error?: string };
  };
  "contacts:syncGoogleContacts": {
    request: { userId: string };
    response: { success: boolean; count?: number; reconnectRequired?: boolean; tokenExpired?: boolean; error?: string };
  };
  "contacts:get-email-name-map": {
    request: { userId: string };
    response: { success: boolean; nameMap: Record<string, string>; error?: string };
  };

  // ============================================
  // COMMUNICATION CHANNELS
  // ============================================
  "communications:get-by-transaction": {
    request: { transactionId: string };
    response: Communication[];
  };
  "communications:get-all": {
    request: { userId: string; filters?: CommunicationFilters };
    response: Communication[];
  };
  "communications:sync": {
    request: { userId: string; provider: OAuthProvider };
    response: SyncStatus;
  };

  // ============================================
  // FEEDBACK CHANNELS
  // ============================================
  "feedback:submit": {
    request: {
      userId: string;
      feedbackData: Omit<UserFeedback, "id" | "created_at" | "user_id">;
    };
    response: { success: boolean };
  };
  "feedback:get-for-transaction": {
    request: { transactionId: string };
    response: UserFeedback[];
  };
  "feedback:get-metrics": {
    request: { userId: string; fieldName?: string };
    response: {
      totalFeedback: number;
      confirmations: number;
      corrections: number;
      rejections: number;
      accuracyRate: number;
    };
  };
  "feedback:get-suggestion": {
    request: {
      userId: string;
      fieldName: string;
      extractedValue: string;
      confidence: number;
    };
    response: {
      shouldShowWarning: boolean;
      suggestedValue?: string;
      reason?: string;
    };
  };
  "feedback:get-learning-stats": {
    request: { userId: string; fieldName: string };
    response: {
      totalSamples: number;
      averageAccuracy: number;
      commonCorrections: Array<{ from: string; to: string; count: number }>;
    };
  };

  // ============================================
  // SYSTEM CHANNELS
  // ============================================
  "system:run-permission-setup": {
    request: void;
    response: { success: boolean };
  };
  "system:request-contacts-permission": {
    request: void;
    response: { granted: boolean };
  };
  "system:setup-full-disk-access": {
    request: void;
    response: { success: boolean };
  };
  "system:open-privacy-pane": {
    request: { pane: string };
    response: { success: boolean };
  };
  "system:check-full-disk-access-status": {
    request: void;
    response: { hasAccess: boolean };
  };
  "system:check-full-disk-access": {
    request: void;
    response: { hasAccess: boolean };
  };
  "system:check-contacts-permission": {
    request: void;
    response: { hasPermission: boolean };
  };
  "system:check-all-permissions": {
    request: void;
    response: {
      allGranted: boolean;
      permissions: {
        fullDiskAccess?: { hasPermission: boolean; error?: string };
        contacts?: { hasPermission: boolean; error?: string };
      };
      errors: Array<{ hasPermission: boolean; error?: string }>;
    };
  };
  "system:check-google-connection": {
    request: { userId: string };
    response: {
      connected: boolean;
      email?: string;
      error?: string;
    };
  };
  "system:check-microsoft-connection": {
    request: { userId: string };
    response: {
      connected: boolean;
      email?: string;
      error?: string;
    };
  };
  "system:check-all-connections": {
    request: { userId: string };
    response: {
      google: { connected: boolean; email?: string };
      microsoft: { connected: boolean; email?: string };
    };
  };
  "system:health-check": {
    request: { userId: string; provider?: OAuthProvider };
    response: {
      healthy: boolean;
      provider?: OAuthProvider;
      issues?: string[];
    };
  };

  // ============================================
  // ADDRESS CHANNELS
  // ============================================
  "address:initialize": {
    request: { apiKey: string };
    response: { success: boolean };
  };
  "address:get-suggestions": {
    request: { input: string; sessionToken: string };
    response: Array<{
      description: string;
      placeId: string;
    }>;
  };
  "address:get-details": {
    request: { placeId: string };
    response: {
      address: string;
      street?: string;
      city?: string;
      state?: string;
      zip?: string;
      coordinates?: { lat: number; lng: number };
    };
  };
  "address:geocode": {
    request: { address: string };
    response: {
      lat: number;
      lng: number;
      formattedAddress: string;
    };
  };

  // ============================================
  // PREFERENCE CHANNELS
  // ============================================
  "preferences:get": {
    request: { userId: string };
    response: Record<string, unknown>;
  };
  "preferences:set": {
    request: { userId: string; key: string; value: unknown };
    response: { success: boolean };
  };
  "preferences:reset": {
    request: { userId: string };
    response: { success: boolean };
  };

  // ============================================
  // PAIRING CHANNELS (TASK-1428)
  // ============================================
  "pairing:generate-qr": {
    request: void;
    response: {
      success: boolean;
      error?: string;
      result?: {
        qrDataUrl: string;
        pairingInfo: {
          ip: string;
          port: number;
          secret: string;
          deviceName: string;
        };
      };
    };
  };
  "pairing:get-status": {
    request: void;
    response: {
      success: boolean;
      error?: string;
      status?: {
        isPaired: boolean;
        devices: Array<{
          deviceId: string;
          deviceName: string;
          secret: string;
          pairedAt: string;
          lastSeen: string;
        }>;
      };
    };
  };
  "pairing:disconnect": {
    request: { deviceId: string };
    response: { success: boolean; error?: string };
  };
}

// ============================================
// TYPE HELPERS
// ============================================

/**
 * Extract request type for a channel
 */
export type IpcRequest<T extends keyof IpcChannels> = IpcChannels[T]["request"];

/**
 * Extract response type for a channel
 */
export type IpcResponse<T extends keyof IpcChannels> =
  IpcChannels[T]["response"];

/**
 * Type-safe IPC handler function
 */
export type IpcHandler<T extends keyof IpcChannels> = (
  event: Electron.IpcMainInvokeEvent,
  ...args: IpcRequest<T> extends void ? [] : [IpcRequest<T>]
) => Promise<IpcResponse<T>> | IpcResponse<T>;

/**
 * Type-safe IPC invoke function (for renderer)
 */
export type IpcInvoke = <T extends keyof IpcChannels>(
  channel: T,
  ...args: IpcRequest<T> extends void ? [] : [IpcRequest<T>]
) => Promise<IpcResponse<T>>;
