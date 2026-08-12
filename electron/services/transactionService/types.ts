/**
 * Transaction Service Types
 * Shared type definitions used across transaction service sub-modules.
 * Extracted from transactionService.ts for maintainability.
 */

import type {
  Transaction,
  Communication,
  OAuthProvider,
} from "../../types";
import type { TransactionContactResult } from "../db/transactionContactDbService";

// ============================================
// TYPES
// ============================================

export interface FetchProgress {
  fetched: number;
  total: number;
  estimatedTotal?: number;
  percentage: number;
  hasEstimate?: boolean;
}

export interface ProgressUpdate {
  step: "fetching" | "analyzing" | "grouping" | "saving" | "complete";
  message: string;
  fetchProgress?: FetchProgress;
}

export interface ScanOptions {
  provider?: OAuthProvider;
  startDate?: Date;
  endDate?: Date;
  searchQuery?: string;
  maxEmails?: number;
  onProgress?: (progress: ProgressUpdate) => void;
}

export interface ScanResult {
  success: boolean;
  transactionsFound: number;
  emailsScanned: number;
  realEstateEmailsFound: number;
  transactions: TransactionWithSummary[];
}

export interface TransactionWithSummary extends Partial<Transaction> {
  id: string;
}

export interface EmailFetchOptions {
  query?: string;
  after?: Date;
  before?: Date;
  maxResults?: number;
  onProgress?: (progress: FetchProgress) => void;
}

export interface AnalyzedEmail {
  subject?: string;
  from: string;
  date: string | Date;
  isRealEstateRelated: boolean;
  keywords?: string;
  parties?: string;
  confidence?: number;
}

/**
 * Normalized email message shape used within transactionService.
 * Compatible with ParsedEmail from both Gmail and Outlook fetch services.
 * Uses `| null` to match provider return types where fields may be null.
 */
export interface EmailMessage {
  id?: string;
  subject?: string | null;
  from: string | null;
  date?: string | Date;
  to?: string | null;
  cc?: string | null;
  bcc?: string | null;
  body?: string;
  bodyPlain?: string;
  snippet?: string;
  bodyPreview?: string;
  threadId?: string;
  hasAttachments?: boolean;
  attachmentCount?: number;
  attachments?: RawEmailAttachment[];
  /** RFC 5322 Message-ID header for deduplication */
  messageIdHeader?: string | null;
}

interface TransactionSummary {
  propertyAddress: string;
  transactionType?: "purchase" | "sale";
  closingDate?: Date | string;
  communicationsCount: number;
  confidence?: number;
  firstCommunication: Date | string;
  lastCommunication: Date | string;
  salePrice?: number;
}

export interface AddressComponents {
  street: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
}

export interface ContactAssignment {
  contact_id: string;
  role: string;
  role_category: string;
  is_primary: boolean;
  notes?: string;
}

export interface AuditedTransactionData {
  property_address: string;
  property_street?: string;
  property_city?: string;
  property_state?: string;
  property_zip?: string;
  property_coordinates?: string;
  transaction_type?: "purchase" | "sale";
  contact_assignments?: ContactAssignment[];
  started_at?: string;
  closed_at?: string;
  closing_deadline?: string;
}

/**
 * Transaction with communications and contact assignments populated.
 * Returned by getTransactionDetails and getTransactionWithContacts.
 */
export interface TransactionWithDetails extends Transaction {
  communications?: Communication[];
  contact_assignments?: TransactionContactResult[];
}

/**
 * Raw attachment metadata from email providers (Gmail/Outlook).
 * Shape varies by provider; properties are optional to handle both.
 */
export interface RawEmailAttachment {
  filename?: string;
  name?: string;
  mimeType?: string;
  contentType?: string;
  size?: number;
  attachmentId?: string;
  id?: string;
}

export interface DateRange {
  start?: Date;
  end?: Date;
}

export interface ReanalysisResult {
  emailsFound: number;
  realEstateEmailsFound: number;
  analyzed: AnalyzedEmail[];
}

/**
 * Result of assigning a contact to a transaction
 * TASK-1031: Now includes auto-link results
 */
export interface AssignContactResult {
  success: boolean;
  autoLink?: import("../autoLinkService").AutoLinkResult;
}
