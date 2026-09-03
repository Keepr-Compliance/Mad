/**
 * Database-specific types for Keepr
 * These types represent database operations, query results, and service interfaces
 */

import type {
  User,
  Contact,
  Transaction,
  Communication,
  UserFeedback,
  NewUser,
  NewContact,
  NewTransaction,
  NewCommunication,
  TransactionFilters,
  CommunicationFilters,
  ContactFilters,
  ContactUpdateFields,
} from "./models";
// BACKLOG-3067: the interface has to agree with the implementation, or the brand
// is erased the moment anything goes through `IDatabaseService`.
import type { CommunicationRow, TransactionRow } from "./ids";
import type { ContactOrigin } from "../services/db/contactOriginLink";

// ============================================
// DATABASE QUERY RESULTS
// ============================================

/**
 * Standard query result from better-sqlite3
 */
export interface QueryResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

/**
 * Paginated result wrapper
 */
export interface PaginatedResult<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

/**
 * Sort options for queries
 */
export interface SortOptions {
  field: string;
  direction: "ASC" | "DESC";
}

/**
 * Pagination options
 */
export interface PaginationOptions {
  page?: number;
  pageSize?: number;
  sort?: SortOptions;
}

// ============================================
// ENRICHED MODELS (with joined data)
// ============================================

/**
 * Transaction with associated contacts
 */
export interface TransactionWithContacts extends Transaction {
  buyer_agent?: Contact;
  seller_agent?: Contact;
  escrow_officer?: Contact;
  inspector?: Contact;
  all_contacts?: Contact[];
}

/**
 * Communication with associated transaction
 */
export interface CommunicationWithTransaction extends Communication {
  transaction?: Transaction;
}

/**
 * Contact with transaction count
 */
export interface ContactWithStats extends Contact {
  transaction_count?: number;
  last_communication_date?: Date | string;
}

// ============================================
// DATABASE SERVICE INTERFACES
// ============================================

/**
 * Database service interface
 */
export interface IDatabaseService {
  // User operations
  createUser(userData: NewUser): Promise<User>;
  getUserById(userId: string): Promise<User | null>;
  getUserByEmail(email: string): Promise<User | null>;
  updateUser(userId: string, updates: Partial<User>): Promise<void>;
  deleteUser(userId: string): Promise<void>;

  // Contact operations
  /**
   * BACKLOG-2496: `origin` is REQUIRED — where the contact came from is written
   * in the same transaction as the contact, and an implementation that omits it
   * does not compile.
   */
  createContact(contactData: NewContact, origin: ContactOrigin): Promise<Contact>;
  getContactById(contactId: string): Promise<Contact | null>;
  getContacts(filters?: ContactFilters): Promise<Contact[]>;
  /**
   * BACKLOG-2528: `ContactUpdateFields`, not `Partial<Contact>`. `Contact` is
   * the READ shape and carries aliases that are not columns, so
   * `Partial<Contact>` typed a rename as valid while the writer discarded it.
   */
  updateContact(contactId: string, updates: ContactUpdateFields): Promise<void>;
  deleteContact(contactId: string): Promise<void>;
  searchContacts(query: string, userId: string): Promise<Contact[]>;

  // Transaction operations
  createTransaction(transactionData: NewTransaction): Promise<Transaction>;
  getTransactionById(transactionId: string): Promise<TransactionRow | null>;
  getTransactions(filters?: TransactionFilters): Promise<Transaction[]>;
  getTransactionWithContacts(
    transactionId: string,
  ): Promise<TransactionWithContacts | null>;
  updateTransaction(
    transactionId: string,
    updates: Partial<Transaction>,
  ): Promise<void>;
  deleteTransaction(transactionId: string): Promise<void>;
  findExistingTransactionsByAddresses(
    userId: string,
    propertyAddresses: string[],
  ): Promise<Map<string, string>>;

  // Communication operations
  createCommunication(
    communicationData: NewCommunication,
  ): Promise<CommunicationRow>;
  getCommunicationById(communicationId: string): Promise<CommunicationRow | null>;
  getCommunications(filters?: CommunicationFilters): Promise<Communication[]>;
  getCommunicationsByTransaction(
    transactionId: string,
  ): Promise<Communication[]>;
  updateCommunication(
    communicationId: string,
    updates: Partial<Communication>,
  ): Promise<void>;
  deleteCommunication(communicationId: string): Promise<void>;

  // Transaction-Contact operations
  linkContactToTransaction(
    transactionId: string,
    contactId: string,
    role?: string,
  ): Promise<void>;
  unlinkContactFromTransaction(
    transactionId: string,
    contactId: string,
    // BACKLOG-2366: persisted to `transaction_contacts.removed_reason`. Removal
    // is a tombstone, not a delete, so the row records why the party came off.
    reason?: string,
  ): Promise<void>;
  getTransactionContacts(transactionId: string): Promise<Contact[]>;

  // Feedback operations
  saveFeedback(
    feedbackData: Omit<UserFeedback, "id" | "created_at">,
  ): Promise<UserFeedback>;
  getFeedbackByTransaction(transactionId: string): Promise<UserFeedback[]>;

  // Utility operations
  runMigrations(): Promise<void>;
  vacuum(): Promise<void>;
  close(): Promise<void>;
}

// ============================================
// VALIDATION SERVICE INTERFACE
// ============================================

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export interface IValidationService {
  validateEmail(email: string): ValidationResult;
  validatePhone(phone: string): ValidationResult;
  validateUUID(uuid: string): ValidationResult;
  validateTransaction(transactionData: Partial<Transaction>): ValidationResult;
  validateContact(contactData: Partial<Contact>): ValidationResult;
  validateCommunication(
    communicationData: Partial<Communication>,
  ): ValidationResult;
}

// ============================================
// EXPORT SERVICE TYPES
// ============================================

export interface ExportOptions {
  format: "pdf" | "csv" | "json" | "txt_eml" | "excel";
  includeAttachments?: boolean;
  dateRange?: {
    start: Date | string;
    end: Date | string;
  };
  filter?: {
    includeEmails?: boolean;
    includeTexts?: boolean;
  };
}

export interface ExportResult {
  success: boolean;
  filePath?: string;
  error?: string;
  metadata?: {
    totalCommunications: number;
    emailCount: number;
    textCount: number;
    attachmentCount: number;
    dateRange?: {
      earliest: Date | string;
      latest: Date | string;
    };
  };
}

// ============================================
// TRANSACTION EXTRACTION TYPES
// ============================================

export interface ExtractionResult {
  transaction_type?: "purchase" | "sale";
  closed_at?: Date | string;
  mutual_acceptance_date?: Date | string;
  started_at?: Date | string;
  listing_price?: number;
  sale_price?: number;
  earnest_money_amount?: number;
  earnest_money_delivered_date?: Date | string;
  key_dates?: Array<{
    date: Date | string;
    description: string;
    confidence: number;
  }>;
  contacts?: Array<{
    name: string;
    email?: string;
    phone?: string;
    role?: string;
    confidence: number;
  }>;
  confidence: number;
}

// ============================================
// SYNC SERVICE TYPES
// ============================================

export interface SyncStatus {
  lastSync?: Date | string;
  inProgress: boolean;
  error?: string;
  itemsSynced?: number;
}

export interface SyncResult {
  success: boolean;
  itemsSynced: number;
  errors: Array<{
    item: string;
    error: string;
  }>;
}

// ============================================
// ERROR TYPES
// ============================================

export class DatabaseError extends Error {
  constructor(
    message: string,
    public code?: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = "DatabaseError";
  }
}

/**
 * BACKLOG-2993 — thrown by the schema-baseline fence when an on-disk database
 * predates the baseline reset (schema_version below the baseline, or a
 * pre-baseline relic with user tables but no schema_version row). The old
 * migration chain was deleted; such a database has NO upgrade path and must be
 * refused UNTOUCHED — never migrated, never auto-restored (every restorable
 * backup is also pre-baseline, so routing this through auto-restore would
 * restore-and-refuse in a loop).
 *
 * Deliberately a DISTINCT class from a migration failure: initialize() treats
 * it as terminal (native dialog, then app.quit()) instead of retryable.
 */
export class SchemaBaselineRefusalError extends DatabaseError {
  constructor(
    message: string,
    public foundVersion?: number,
  ) {
    super(message, "SCHEMA_BASELINE_REFUSED");
    this.name = "SchemaBaselineRefusalError";
  }
}

/**
 * BACKLOG-2999 — the outcome of the post-migration-failure auto-restore
 * attempt. Declared here so `_attemptAutoRestore()`'s return type and
 * `MigrationRecoveryFailedError` share ONE definition: the error is built
 * from that return value, and two independent copies of these unions would
 * drift the moment a fourth status is added.
 */
export type AutoRestoreStatus = "succeeded" | "failed" | "no_backup";
export type BackupIntegrity = "valid" | "corrupt" | "missing";

/**
 * BACKLOG-2999 — thrown by initialize() when a migration failed AND the
 * auto-restore recovered nothing (`restored === false`, by any of its four
 * routes: no backup, corrupt backup, the restore copy throwing, or the
 * post-restore connectivity probe failing).
 *
 * Before this existed, initialize() showed a dismissible "your data may need
 * manual recovery" dialog and then ran `return true` — so the caller could not
 * tell a good start from a failed one and the app opened on a half-migrated,
 * or entirely unopened, database.
 *
 * Deliberately a DISTINCT class, for the same reason as
 * SchemaBaselineRefusalError: initialize()'s outer catch re-throws it
 * untouched instead of capturing it to Sentry a second time (the inner catch
 * already did, tagged `migration_failure`) and instead of broadcasting
 * `retryable: true` for a state that is not retryable.
 */
export class MigrationRecoveryFailedError extends DatabaseError {
  constructor(
    message: string,
    public autoRestoreStatus: AutoRestoreStatus,
    public backupIntegrity: BackupIntegrity,
  ) {
    super(message, "MIGRATION_RECOVERY_FAILED");
    this.name = "MigrationRecoveryFailedError";
  }
}

export class ValidationError extends Error {
  constructor(
    message: string,
    public field?: string,
    public value?: unknown,
  ) {
    super(message);
    this.name = "ValidationError";
  }
}

export class NotFoundError extends Error {
  constructor(
    message: string,
    public resourceType?: string,
    public resourceId?: string,
  ) {
    super(message);
    this.name = "NotFoundError";
  }
}
