/**
 * TransactionDetails Module Types
 * Shared type definitions for the transaction details feature
 */
import type { Transaction, Communication, Contact, Message } from "@/types";
import type { NotificationOptions } from "../ui/Notification/types";

/**
 * Interface for AI-suggested contact assignment
 */
export interface SuggestedContact {
  role: string;
  contact_id: string;
  is_primary?: boolean;
  notes?: string;
}

/**
 * Interface for resolved suggested contact with contact details
 */
export interface ResolvedSuggestedContact extends SuggestedContact {
  contact?: Contact;
}

/**
 * Contact assignment from transaction details
 */
export interface ContactAssignment {
  id: string;
  contact_id: string;
  contact_name?: string;
  contact_email?: string;
  contact_phone?: string;
  contact_company?: string;
  contact_source?: string;
  role?: string;
  specific_role?: string;
  is_primary?: number;
  notes?: string;
  /**
   * BACKLOG-2568 — when the PERSON was deleted from Clients & Contacts
   * (`contacts.removed_at`). NULL for a live contact.
   *
   * Note what is NOT here: this type carries exactly ONE tombstone field. Every
   * assignment in this list is live on the deal by construction — the query
   * behind it filters `tc.removed_at IS NULL` — so the junction tombstone would
   * be uniformly NULL and is deliberately not projected. On the electron side
   * `TransactionContactResult` carries BOTH, two lines apart; here there is
   * only one, so a reader cannot pick the wrong one.
   *
   * Format: SQLite `datetime('now')` → `YYYY-MM-DD HH:MM:SS`, not ISO-8601.
   */
  contact_removed_at?: string | null;
  /** Total number of emails for this contact (from contact_emails table) */
  contact_email_count?: number | string;
  /** Total number of phones for this contact (from contact_phones table) */
  contact_phone_count?: number | string;
}

/**
 * Props for TransactionDetails component
 */
export interface TransactionDetailsProps {
  transaction: Transaction;
  onClose: () => void;
  onTransactionUpdated?: () => void;
  /** If true, shows approve/reject buttons instead of export/delete (for pending review) */
  isPendingReview?: boolean;
  /** User ID for feedback recording */
  userId?: string;
  /**
   * Toast handler for success messages - if provided, uses parent's toast system.
   * BACKLOG-2390: accepts an optional inline action (e.g. Undo) for move toasts.
   */
  onShowSuccess?: (message: string, options?: NotificationOptions) => void;
  /** Toast handler for error messages - if provided, uses parent's toast system */
  onShowError?: (message: string) => void;
  /** Initial tab to display when opening TransactionDetails */
  initialTab?: TransactionTab;
}

/**
 * Tab types for transaction details view
 * - overview: Audit dates, AI suggestions, and contacts summary (default)
 * - messages: Text conversations
 * - emails: Email threads
 * - attachments: File attachments (hidden)
 */
export type TransactionTab = "overview" | "messages" | "emails" | "attachments";

/**
 * BACKLOG-1869: Transient deep-navigate target produced when the user clicks an
 * email or text result in the linked-content search. The receiving tab locates
 * the matching conversation card, scrolls to it, and applies a brief highlight.
 */
export interface HighlightTarget {
  type: "email" | "text";
  /** For email: the communication/email id from LinkedContentEmailHit.id */
  emailId?: string;
  /** For text: the communication id from LinkedContentTextHit.id */
  communicationId?: string;
}

/**
 * Communication type for local use
 */
export type { Communication };

/**
 * Message type for local use
 */
export type { Message };

/**
 * Re-export Transaction type
 */
export type { Transaction };
