/**
 * Core Data Models for Keepr
 * Version: 2.0 (LLM + Agent Ready)
 * These types represent the main entities in the application
 */

// ============================================
// ENUMS & TYPE ALIASES
// ============================================

// Auth & User
// Note: 'azure' is Microsoft's Azure AD provider - we accept it from Supabase
// but normalize to 'microsoft' for local database storage (CHECK constraint)
export type OAuthProvider = "google" | "microsoft" | "azure";
export type OAuthPurpose = "authentication" | "mailbox";
export type SubscriptionTier = "free" | "pro" | "enterprise";
export type SubscriptionStatus = "trial" | "active" | "cancelled" | "expired";
export type Theme = "light" | "dark" | "auto";

// License Types (BACKLOG-426)
export type LicenseType = "individual" | "team" | "enterprise";

// Contacts
// BACKLOG-1900 (P0.1): "iphone" added for distinct iOS address-book origin.
export type ContactSource = "manual" | "email" | "sms" | "messages" | "contacts_app" | "inferred" | "outlook" | "google_contacts" | "android_sync" | "iphone";
export type ContactInfoSource = "import" | "manual" | "inferred";

// Messages
export type MessageChannel = "email" | "sms" | "imessage";
export type MessageDirection = "inbound" | "outbound";
export type ClassificationMethod = "pattern" | "llm" | "user";
export type FalsePositiveReason = "signature" | "promotional" | "unrelated" | "other";

/**
 * Type of message content for UI differentiation (TASK-1799)
 *
 * - text: Regular text message
 * - voice_message: Audio message with optional transcript
 * - location: Location sharing message
 * - attachment_only: Has attachment but no text content
 * - system: System/service message (delivery receipts, etc.)
 * - unknown: Unable to determine type
 */
export type MessageType =
  | "text"
  | "voice_message"
  | "location"
  | "attachment_only"
  | "system"
  | "unknown";

// Transactions
export type TransactionType = "purchase" | "sale" | "other";
export type TransactionStatus = "pending" | "active" | "closed" | "rejected";

// B2B Submission Status (BACKLOG-390)
export type SubmissionStatus =
  | "not_submitted"
  | "submitted"
  | "under_review"
  | "needs_changes"
  | "resubmitted"
  | "approved"
  | "rejected";
export type TransactionStage =
  | "intro"
  | "showing"
  | "offer"
  | "inspections"
  | "escrow"
  | "closing"
  | "post_closing";

// Participants
/** @deprecated Use ContactRole instead — this legacy type does not match SPECIFIC_ROLES */
export type ParticipantRole =
  | "buyer"
  | "seller"
  | "buyer_agent"
  | "listing_agent"
  | "lender"
  | "loan_officer"
  | "escrow_officer"
  | "title_officer"
  | "inspector"
  | "appraiser"
  | "attorney"
  | "tc"
  | "other"
  | "unknown";

/** Canonical contact role type — matches SPECIFIC_ROLES in src/constants/contactRoles.ts */
export type ContactRole =
  | "client"
  | "buyer"
  | "seller"
  | "buyer_agent"
  | "seller_agent"
  | "listing_agent"
  | "appraiser"
  | "inspector"
  | "surveyor"
  | "title_company"
  | "escrow_officer"
  | "mortgage_broker"
  | "lender"
  | "real_estate_attorney"
  | "transaction_coordinator"
  | "insurance_agent"
  | "hoa_management"
  | "condo_management"
  | "other";

// Export & Audit
export type ExportStatus = "not_exported" | "exported" | "re_export_needed";
export type ExportFormat = "pdf" | "csv" | "json" | "txt_eml" | "excel";
export type AuditPackageFormat = "pdf" | "zip" | "json" | "excel";

// Feedback
export type ClassificationFeedbackType =
  | "message_relevance"
  | "transaction_link"
  | "document_type"
  | "contact_role"
  | "stage_hint";

// Legacy types (for backwards compatibility during migration)
/** @deprecated Use MessageChannel instead */
export type CommunicationType = "email" | "text" | "imessage";
/** @deprecated Use ClassificationFeedbackType instead */
export type FeedbackType = "correction" | "confirmation" | "rejection";
/** @deprecated Use TransactionStatus instead */
export type Status = "active" | "closed";

// ============================================
// USER MODELS
// ============================================

export interface User {
  // Core Identity
  id: string;
  email: string;
  first_name?: string;
  last_name?: string;
  display_name?: string;
  avatar_url?: string;

  // OAuth
  oauth_provider: OAuthProvider;
  oauth_id: string;

  // Subscription
  subscription_tier: SubscriptionTier;
  subscription_status: SubscriptionStatus;
  trial_ends_at?: string;

  // Account Status
  is_active: boolean;
  created_at: string;
  updated_at: string;
  last_login_at?: string;

  // Legal
  terms_accepted_at?: string;
  terms_version_accepted?: string;
  privacy_policy_accepted_at?: string;
  privacy_policy_version_accepted?: string;

  // Onboarding
  email_onboarding_completed_at?: string;

  // Preferences
  timezone?: string;
  theme?: Theme;
  notification_preferences?: string | Record<string, unknown>;
  company?: string;
  job_title?: string;
  mobile_phone_type?: "iphone" | "android";

  // License (BACKLOG-426)
  /** Base license tier: individual, team, or enterprise */
  license_type?: LicenseType;
  /** AI detection add-on enabled (works with any base license) */
  ai_detection_enabled?: boolean;
  /** Organization ID for team/enterprise users */
  organization_id?: string;

  // Sync
  last_cloud_sync_at?: string;
}

export interface OAuthToken {
  id: string;
  user_id: string;
  provider: OAuthProvider;
  purpose: OAuthPurpose;

  // Token Data (encrypted)
  access_token?: string;
  refresh_token?: string;
  token_expires_at?: string;
  scopes_granted?: string;

  // Mailbox
  connected_email_address?: string;
  mailbox_connected: boolean;
  permissions_granted_at?: string;

  // Token Health
  token_last_refreshed_at?: string;
  token_refresh_failed_count: number;
  last_sync_at?: string;
  last_sync_error?: string;

  // Status
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface Session {
  id: string;
  user_id: string;
  session_token: string;
  expires_at: string;
  created_at: string;
  last_accessed_at: string;
}

export interface Subscription {
  tier: SubscriptionTier;
  status: SubscriptionStatus;
  isActive: boolean;
  isTrial: boolean;
  trialEnded: boolean;
  trialDaysRemaining: number;
}

/**
 * User license information (BACKLOG-426)
 *
 * License Model:
 *   license_type: 'individual' | 'team' | 'enterprise' (base license)
 *   ai_detection_enabled: boolean (add-on, works with ANY base license)
 *
 * Combined Examples:
 *   - Individual + No AI: Export, manual transactions only
 *   - Individual + AI: Export, manual transactions, AI detection features
 *   - Team + No AI: Submit for review, manual transactions only
 *   - Team + AI: Submit for review, manual transactions, AI detection features
 */
export interface UserLicense {
  /** Base license tier */
  license_type: LicenseType;
  /** AI detection add-on enabled (works with any base license) */
  ai_detection_enabled: boolean;
  /** Organization ID for team/enterprise users */
  organization_id?: string;
  /** Organization name for display purposes */
  organization_name?: string;
}

// ============================================
// CONTACT MODELS
// ============================================

export interface Contact {
  id: string;
  user_id: string;

  // Display Info
  /** Primary field for contact name. Migration ensures this is always populated. */
  display_name?: string;
  company?: string;
  title?: string;

  // Source
  source: ContactSource;

  // Engagement Metrics (for CRM/Relationship Agent)
  last_inbound_at?: string;
  last_outbound_at?: string;
  total_messages?: number; // Optional for backwards compat
  tags?: string; // JSON array: ["VIP", "past_client", "lead"]

  // Auto-role (BACKLOG-1355)
  /** Default role for auto-fill when assigning contact to transactions */
  default_role?: string;

  // Metadata
  metadata?: string; // JSON
  created_at: string;
  updated_at: string;

  // Import status
  /** Whether this contact was derived from message participants (not explicitly imported) */
  is_message_derived?: number | boolean;
  /** Last communication date (for message-derived contacts and activity tracking) */
  last_communication_at?: string | null;

  // ========== Array Fields (for display) ==========
  /** All emails for this contact (from contact_emails table) */
  allEmails?: string[];
  /** All phones for this contact (from contact_phones table) */
  allPhones?: string[];

  // ========== Legacy Fields (backwards compatibility) ==========
  /** @deprecated Read-only. Use display_name for all writes. */
  name?: string;
  /** @deprecated Use ContactEmail child table instead */
  email?: string;
  /** @deprecated Use ContactPhone child table instead */
  phone?: string;
  /** @deprecated Derive from source field instead */
  is_imported?: boolean | number;
}

export interface ContactEmail {
  id: string;
  contact_id: string;

  email: string;
  is_primary: boolean;
  label?: string; // work, personal, etc.
  source?: ContactInfoSource;

  created_at: string;
}

export interface ContactPhone {
  id: string;
  contact_id: string;

  phone_e164: string; // Normalized: +14155550000
  phone_display?: string; // Display format: (415) 555-0000
  is_primary: boolean;
  label?: string; // mobile, home, work, etc.
  source?: ContactInfoSource;

  created_at: string;
}

// Contact with all related data (for UI display)
export interface ContactWithDetails extends Contact {
  emails: ContactEmail[];
  phones: ContactPhone[];
}

// ============================================
// MESSAGE MODELS
// ============================================

// Participants JSON structure
export interface MessageParticipants {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
}

export interface Message {
  id: string;
  user_id: string;

  // Channel/Source Info
  channel_account_id?: string;
  external_id?: string; // Provider ID (Gmail, Outlook, iMessage)

  // Type & Direction
  channel?: MessageChannel;
  direction?: MessageDirection;

  // Content
  subject?: string;
  body_html?: string;
  body_text?: string; // Normalized plain text - what LLMs see

  // Participants
  participants?: string; // JSON: MessageParticipants
  participants_flat?: string; // Denormalized for search

  // Threading
  thread_id?: string;

  // Timestamps
  sent_at?: string;
  received_at?: string;

  // Attachments
  has_attachments: boolean;

  // Message Type (TASK-1799)
  /** Type of message content for UI differentiation */
  message_type?: MessageType;

  // Classification Results
  is_transaction_related?: boolean; // null = not classified
  classification_confidence?: number; // 0.0 - 1.0
  classification_method?: ClassificationMethod;
  classified_at?: string;

  // False Positive Tracking
  is_false_positive: boolean;
  false_positive_reason?: FalsePositiveReason;

  // Stage Hint (for future timeline features)
  stage_hint?: TransactionStage;
  stage_hint_source?: ClassificationMethod;
  stage_hint_confidence?: number;

  // Transaction Link
  transaction_id?: string;
  transaction_link_confidence?: number;
  transaction_link_source?: ClassificationMethod;

  // Metadata
  metadata?: string; // JSON

  created_at: string;

  // ========== LLM Analysis (Migration 11) ==========
  /** Full LLM analysis response stored as JSON string */
  llm_analysis?: string;

  // ========== Deduplication (TASK-905) ==========
  /** RFC 5322 Message-ID header for cross-provider deduplication */
  message_id_header?: string;
  /** SHA-256 hash of email content for fallback deduplication */
  content_hash?: string;
  /** ID of the original message if this is a duplicate */
  duplicate_of?: string;

  // ========== Legacy Fields (backwards compatibility) ==========
  /** @deprecated Use channel instead */
  communication_type?: string;
  /** @deprecated Use channel_account_id instead */
  source?: string;
  /** @deprecated Use participants JSON instead */
  sender?: string;
  /** @deprecated Use participants JSON instead */
  recipients?: string;
  /** @deprecated Use participants JSON instead */
  cc?: string;
  /** @deprecated Use participants JSON instead */
  bcc?: string;
  /** @deprecated Use body_html instead */
  body?: string;
  /** @deprecated Use body_text instead */
  body_plain?: string;
  /** @deprecated Query Attachment table instead */
  attachment_count?: number;
  /** @deprecated Moved to Attachment table */
  attachment_metadata?: string;
  /** @deprecated Use metadata JSON instead */
  keywords_detected?: string;
  /** @deprecated Use participants_flat instead */
  parties_involved?: string;
  /** @deprecated Use stage_hint instead */
  communication_category?: string;
  /** @deprecated Use classification_confidence instead */
  relevance_score?: number;
  /** @deprecated Use is_transaction_related instead */
  is_compliance_related?: boolean;
  /** @deprecated Use is_false_positive instead */
  flagged_for_review?: boolean;

  // ========== TASK-975: Junction Table Fields ==========
  // These fields are used when storing as a communications record (junction table)
  // linking a message to a transaction
  /** Reference to the source message in the messages table (for junction table pattern) */
  message_id?: string;
  /** How the link was created: 'auto', 'manual', or 'scan' */
  link_source?: 'auto' | 'manual' | 'scan';
  /** Confidence score for the link (0.0 - 1.0) */
  link_confidence?: number;
  /** When the link was created */
  linked_at?: string;

  // Email Link (BACKLOG-506)
  /** ID of the email in the emails table (for email communications) */
  email_id?: string;
}

// ============================================
// ATTACHMENT MODELS
// ============================================

export type DocumentType =
  | "offer"
  | "inspection"
  | "disclosure"
  | "contract"
  | "appraisal"
  | "amendment"
  | "addendum"
  | "title"
  | "closing"
  | "other";

export interface Attachment {
  id: string;
  message_id: string;

  // File Info
  filename: string;
  mime_type?: string;
  file_size_bytes?: number;
  storage_path?: string;

  // Extracted Content (for LLMs)
  text_content?: string; // OCR / extracted text

  // Document Classification
  document_type?: DocumentType;
  document_type_confidence?: number;
  document_type_source?: ClassificationMethod;

  // Analysis Results (JSON)
  analysis_metadata?: string;

  created_at: string;
}

// ============================================
// TRANSACTION MODELS
// ============================================

export interface Transaction {
  id: string;
  user_id: string;

  // Property Information
  property_address: string;
  property_street?: string;
  property_city?: string;
  property_state?: string;
  property_zip?: string;
  property_coordinates?: string; // JSON: {"lat": ..., "lng": ...}

  // Transaction Type & Status
  transaction_type?: TransactionType;
  status: TransactionStatus;

  // Key Dates
  started_at?: string;
  closed_at?: string;
  last_activity_at?: string;

  // Confidence
  confidence_score?: number;

  // Stage (for future timeline/agent features)
  stage?: TransactionStage;
  stage_source?: ClassificationMethod | "import";
  stage_confidence?: number;
  stage_updated_at?: string;

  // Financial Data
  listing_price?: number;
  sale_price?: number;
  earnest_money_amount?: number;

  // Key Dates (auto-extracted)
  mutual_acceptance_date?: string;
  inspection_deadline?: string;
  financing_deadline?: string;
  closing_deadline?: string;

  // Stats
  message_count: number;
  attachment_count: number;
  /** BACKLOG-396: Stored thread count for consistent display across card/details */
  text_thread_count?: number;

  // Separate communication counts by type
  /** Count of email communications linked to this transaction */
  email_count?: number;
  /** @deprecated Use text_thread_count for display. This is computed dynamically and may be incorrect. */
  text_count?: number;

  // Export Tracking
  export_status: ExportStatus;
  export_count: number;
  last_exported_at?: string;
  /**
   * Legacy alias of last_exported_at (schema migration 4). This is the column
   * the export handlers actually WRITE on every export completion and the field
   * the transaction-list SELECT returns, so it — not last_exported_at — holds
   * the real "last exported" timestamp today (BACKLOG-2109). Prefer
   * last_exported_on ?? last_exported_at when displaying.
   */
  last_exported_on?: string;

  /**
   * BACKLOG-2013: freeze boundary. Set once, on the FIRST successful export
   * (distinct from last_exported_on, which updates on every export). When set,
   * identity fields are frozen and linked comms are add-only. Cleared only by
   * an admin unfreeze. NULL/undefined = never exported = fully editable.
   */
  first_exported_at?: string;

  // Metadata
  metadata?: string; // JSON
  created_at: string;
  updated_at: string;

  // ========== AI Detection Fields (Migration 11) ==========
  /** How the transaction was created: manual, auto-detected, or hybrid */
  detection_source?: 'manual' | 'auto' | 'hybrid';
  /** User review status of detected transaction */
  detection_status?: 'pending' | 'confirmed' | 'rejected';
  /** Confidence score from detection (0.0 - 1.0) */
  detection_confidence?: number;
  /** Which algorithm detected it: 'pattern' | 'llm' | 'hybrid' */
  detection_method?: string;
  /** JSON array of suggested contact assignments */
  suggested_contacts?: string;
  /** When user reviewed the detected transaction */
  reviewed_at?: string;
  /** Why user rejected (if detection_status='rejected') */
  rejection_reason?: string;

  // ========== B2B Submission Tracking (BACKLOG-390) ==========
  /** Broker review submission status */
  submission_status?: SubmissionStatus;
  /** UUID reference to transaction_submissions in Supabase cloud */
  submission_id?: string | null;
  /** ISO timestamp of last submission to broker portal */
  submitted_at?: string | null;
  /** Most recent broker feedback (synced from cloud) */
  last_review_notes?: string | null;

  // ========== Email Auto-Link Settings (BACKLOG-1364) ==========
  /** Per-transaction toggle: 1 = skip address filter (link ALL emails from contacts), 0 = filter by property address (default) */
  skip_address_filter?: number;

  // ========== Legacy Fields (backwards compatibility) ==========
  /** @deprecated Use status instead */
  transaction_status?: string;
  /** @deprecated Use confidence_score instead */
  extraction_confidence?: number;
  /** @deprecated Use message_count instead */
  total_communications_count?: number;
  /** @deprecated Query messages table instead */
  first_communication_date?: string;
  /** @deprecated Use last_activity_at instead */
  last_communication_date?: string;
  /** @deprecated Use metadata JSON instead */
  closing_date_verified?: boolean;
  /** @deprecated Use message_count instead */
  communications_scanned?: number;
  /** @deprecated Use metadata JSON instead */
  offer_count?: number;
  /** @deprecated Use metadata JSON instead */
  failed_offers_count?: number;
  /** @deprecated Use confidence_score instead */
  representation_start_confidence?: number;
  /** @deprecated Use confidence_score instead */
  closing_date_confidence?: number;
}

// ============================================
// TRANSACTION PARTICIPANT MODELS
// ============================================

export interface TransactionParticipant {
  id: string;
  transaction_id: string;
  contact_id: string;

  // Role — stores SPECIFIC_ROLES values (ContactRole) for new writes
  role?: string;
  specific_role?: string;
  role_category?: string;

  // Confidence & Source
  confidence?: number;
  role_source?: ClassificationMethod;

  is_primary: boolean;
  notes?: string;

  created_at: string;
  updated_at: string;
}

// Participant with contact details (for UI display)
export interface TransactionParticipantWithContact extends TransactionParticipant {
  contact: Contact;
}

// ============================================
// AUDIT PACKAGE MODELS
// ============================================

export interface AuditPackage {
  id: string;
  transaction_id: string;
  user_id: string;

  // Package Info
  generated_at: string;
  format?: AuditPackageFormat;
  storage_path?: string;

  // Content Summary
  message_count?: number;
  attachment_count?: number;
  date_range_start?: string;
  date_range_end?: string;

  // LLM-Generated Summary
  summary?: string;

  // Quality Score
  completeness_score?: number; // 0.0 - 1.0

  // Version tracking
  version: number;

  // Metadata
  metadata?: string; // JSON
}

// ============================================
// STAGE HISTORY MODELS
// ============================================

export interface TransactionStageHistory {
  id: string;
  transaction_id: string;

  stage: TransactionStage;
  source?: ClassificationMethod;
  confidence?: number;
  changed_at: string;

  // What triggered this change
  trigger_message_id?: string;
}

// ============================================
// CLASSIFICATION FEEDBACK MODELS
// ============================================

export interface ClassificationFeedback {
  id: string;
  user_id: string;

  // What was corrected
  message_id?: string;
  attachment_id?: string;
  transaction_id?: string;
  contact_id?: string;

  // Feedback Type
  feedback_type: ClassificationFeedbackType;

  // Values
  original_value?: string;
  corrected_value?: string;
  reason?: string;

  created_at: string;
}

// ============================================
// EXTRACTED DATA MODELS
// ============================================

export interface ExtractedTransactionData {
  id: string;
  transaction_id: string;

  // Extracted Field
  field_name: string;
  field_value?: string;

  // Source
  source_message_id?: string;
  extraction_method?: ClassificationMethod;
  confidence_score?: number;

  // Verification
  manually_verified: boolean;
  verified_at?: string;

  created_at: string;
}

// ============================================
// UTILITY TYPES
// ============================================

// Type for creating new records (omit auto-generated fields)
export type NewUser = Omit<User, "id" | "created_at" | "updated_at">;
export type NewContact = Omit<Contact, "id" | "created_at" | "updated_at" | "total_messages"> & {
  total_messages?: number;
};
export type NewContactEmail = Omit<ContactEmail, "id" | "created_at">;
export type NewContactPhone = Omit<ContactPhone, "id" | "created_at">;
export type NewMessage = Omit<Message, "id" | "created_at">;
export type NewAttachment = Omit<Attachment, "id" | "created_at">;
export type NewTransaction = Omit<Transaction, "id" | "created_at" | "updated_at" | "message_count" | "attachment_count"> & {
  message_count?: number;
  attachment_count?: number;
};
export type NewTransactionParticipant = Omit<TransactionParticipant, "id" | "created_at" | "updated_at">;
export type NewAuditPackage = Omit<AuditPackage, "id" | "generated_at" | "version"> & {
  version?: number;
};
export type NewClassificationFeedback = Omit<ClassificationFeedback, "id" | "created_at">;

// Type for updating records (all fields optional except id)
export type UpdateUser = Partial<Omit<User, "id">> & { id: string };
export type UpdateContact = Partial<Omit<Contact, "id">> & { id: string };
export type UpdateMessage = Partial<Omit<Message, "id">> & { id: string };
export type UpdateAttachment = Partial<Omit<Attachment, "id">> & { id: string };
export type UpdateTransaction = Partial<Omit<Transaction, "id">> & { id: string };
export type UpdateTransactionParticipant = Partial<Omit<TransactionParticipant, "id">> & { id: string };

// ============================================
// FILTER TYPES
// ============================================

export interface TransactionFilters {
  user_id?: string;
  transaction_type?: TransactionType;
  status?: TransactionStatus;
  stage?: TransactionStage;
  export_status?: ExportStatus;
  start_date?: string;
  end_date?: string;
  property_address?: string;
  /** @deprecated Use status instead */
  transaction_status?: string;
}

export interface MessageFilters {
  user_id?: string;
  transaction_id?: string;
  channel?: MessageChannel;
  direction?: MessageDirection;
  is_transaction_related?: boolean;
  start_date?: string;
  end_date?: string;
  has_attachments?: boolean;
  /** @deprecated Use channel instead */
  communication_type?: string;
}

export interface ContactFilters {
  user_id?: string;
  source?: ContactSource;
  has_email?: boolean;
  has_phone?: boolean;
  /** @deprecated Derive from source field instead */
  is_imported?: boolean;
}

export interface AttachmentFilters {
  message_id?: string;
  document_type?: DocumentType;
  has_text_content?: boolean;
}

// ============================================
// LLM SETTINGS MODELS (Migration 11)
// ============================================

/**
 * LLM settings and configuration per user
 * Stores API keys (encrypted), usage tracking, and feature flags
 */
export interface LLMSettings {
  id: string;
  user_id: string;

  // Provider Config
  /** Encrypted OpenAI API key */
  openai_api_key_encrypted?: string;
  /** Encrypted Anthropic API key */
  anthropic_api_key_encrypted?: string;
  /** Preferred LLM provider */
  preferred_provider: 'openai' | 'anthropic';
  /** OpenAI model to use */
  openai_model: string;
  /** Anthropic model to use */
  anthropic_model: string;

  // Usage Tracking
  /** Tokens used in current billing period */
  tokens_used_this_month: number;
  /** User-defined token budget limit */
  budget_limit_tokens?: number;
  /** Date when monthly usage resets */
  budget_reset_date?: string;

  // Platform Allowance
  /** Platform-provided token allowance */
  platform_allowance_tokens: number;
  /** Platform allowance tokens used */
  platform_allowance_used: number;
  /** Whether to use platform allowance */
  use_platform_allowance: boolean;

  // Feature Flags
  /** Enable automatic transaction detection */
  enable_auto_detect: boolean;
  /** Enable role extraction from messages */
  enable_role_extraction: boolean;

  // Consent (Security Option C)
  /** User has consented to LLM data processing */
  llm_data_consent: boolean;
  /** When user gave consent */
  llm_data_consent_at?: string;

  // Timestamps
  created_at: string;
  updated_at: string;
}

// ============================================
// LLM ANALYSIS MODELS (Migration 11)
// ============================================

/**
 * Typed interface for the JSON content stored in Message.llm_analysis
 * Parsing happens in the service layer, this interface is for documentation
 */
export interface MessageLLMAnalysis {
  /** Whether the message is related to real estate transactions */
  isRealEstateRelated: boolean;
  /** Overall confidence in the analysis (0.0 - 1.0) */
  confidence: number;
  /** Transaction indicators extracted from the message */
  transactionIndicators: {
    type: 'purchase' | 'sale' | 'lease' | null;
    stage: 'prospecting' | 'active' | 'pending' | 'closing' | 'closed' | null;
  };
  /** Entities extracted from the message */
  extractedEntities: {
    addresses: Array<{ value: string; confidence: number }>;
    amounts: Array<{ value: number; context: string }>;
    dates: Array<{ value: string; type: string }>;
    contacts: Array<{ name: string; email?: string; suggestedRole?: string }>;
  };
  /** LLM's reasoning for the classification */
  reasoning: string;
  /** Model used for analysis */
  model: string;
  /** Version of the prompt used */
  promptVersion: string;
}

// ============================================
// EMAIL MODELS (BACKLOG-506)
// ============================================

/**
 * Email record stored in the emails table.
 * This is the content store for emails - separate from the junction table.
 */
export interface Email {
  id: string;
  user_id: string;

  // Source identification
  external_id?: string;
  source?: "gmail" | "outlook";
  account_id?: string;

  // Direction
  direction?: "inbound" | "outbound";

  // Content
  subject?: string;
  body_plain?: string;
  body_html?: string;

  // Participants
  sender?: string;
  recipients?: string;
  cc?: string;
  bcc?: string;

  // Threading
  thread_id?: string;
  in_reply_to?: string;
  references_header?: string;

  // Timestamps
  sent_at?: string;
  received_at?: string;

  // Attachments
  has_attachments?: boolean;
  attachment_count?: number;

  // Deduplication
  message_id_header?: string;
  content_hash?: string;

  // Metadata
  labels?: string;
  created_at?: string;
}

/**
 * A single parsed participant row destined for the `email_participants`
 * junction table (BACKLOG-1722). Shared by every email-write code path
 * (Outlook fetch, Gmail fetch, manual attach, emailSyncService).
 *
 * - `email_address` is ALWAYS lowercased + trimmed (see normalizeEmailAddress).
 * - `display_name` preserves the original case (may be null).
 * - `role` matches the junction-table CHECK constraint.
 * - `position` is the 0-based ordinal within (email_id, role) — caller is
 *   responsible for preserving header order.
 *
 * Intentionally NOT deduped with the parser's `ParsedAddress` type:
 * the parser is content-only; this type is the write-shape with the role
 * + position metadata that the junction needs.
 */
export interface ParsedParticipant {
  email_address: string;
  display_name: string | null;
  role: "from" | "to" | "cc" | "bcc";
  position: number;
}

/**
 * Data required to create a new email
 */
export type NewEmail = Omit<Email, "id" | "created_at"> & {
  /**
   * Optional structured participants for the `email_participants` junction.
   *
   * If provided, the writer inserts one junction row per entry inside the same
   * transaction as the emails-table INSERT. If absent, a Sentry breadcrumb is
   * recorded (per SR Step-7 Q4 resolution) so we can track callers that have
   * not been migrated. The legacy flat columns (sender/recipients/cc/bcc)
   * remain authoritative for free-text search regardless.
   */
  participants?: ParsedParticipant[];
};

// ============================================
// JUNCTION TABLE MODELS (BACKLOG-506)
// ============================================

/**
 * Communication junction record - links content (message or email) to a transaction.
 * This is the PURE junction table type with NO content columns.
 *
 * Use this type for:
 * - Creating new junction records
 * - Reading junction-only data
 *
 * For reading with content, use the result of getCommunicationsWithMessages()
 * which returns Message (with content populated from JOINs).
 */
export interface JunctionCommunication {
  id: string;
  user_id: string;
  transaction_id: string;

  // Content references (ONE should be set)
  message_id?: string;        // FK to messages table (for texts)
  email_id?: string;          // FK to emails table (for emails)
  thread_id?: string;         // For batch-linking all texts in a thread

  // Link metadata
  link_source?: "auto" | "manual" | "scan";
  link_confidence?: number;
  linked_at?: string;

  created_at?: string;
}

/**
 * Data required to create a new communication junction record.
 * BACKLOG-506: This is the proper type for createCommunication().
 */
export type NewJunctionCommunication = Omit<JunctionCommunication, "id" | "created_at" | "linked_at">;

// ============================================
// LEGACY TYPES (Backwards Compatibility)
// ============================================

/**
 * @deprecated BACKLOG-506: Communication is aliased to Message for backward compatibility.
 *
 * This alias exists because getCommunicationsWithMessages() returns Message objects
 * with content populated from JOINs to messages/emails tables.
 *
 * For junction-only operations, use JunctionCommunication instead.
 * For creating new junction records, use NewJunctionCommunication.
 */
export type Communication = Message;

/**
 * BACKLOG-1933: A contact's text-message conversation thread, grouped for the
 * contact card. Shape matches `ConversationViewModalProps` — `phoneNumber` is
 * REQUIRED (representative phone for the thread header). `transaction_id` is the
 * owning transaction (undefined when the thread is not linked to any
 * transaction — expected; the "See transaction" affordance is hidden for those).
 * Defined here (pure type module) so main / preload / renderer can all import it
 * without pulling in main-process service code.
 */
export interface ContactMessageThread {
  thread_id: string;
  phoneNumber: string;
  messages: Message[];
  transaction_id?: string;
}

/**
 * @deprecated BACKLOG-506: Use NewJunctionCommunication for creating junction records.
 *
 * This alias is kept for backward compatibility during the transition.
 * Code that creates communications should be updated to use NewJunctionCommunication.
 */
export type NewCommunication = NewMessage;

/**
 * @deprecated BACKLOG-506: Use Partial<JunctionCommunication> for updating junction records.
 *
 * This alias is kept for backward compatibility during the transition.
 */
export type UpdateCommunication = UpdateMessage;

/**
 * @deprecated Use MessageFilters instead.
 */
export type CommunicationFilters = MessageFilters;

/**
 * @deprecated Use TransactionParticipant instead.
 */
export type TransactionContact = TransactionParticipant;

/**
 * @deprecated Use ClassificationFeedback instead.
 * Aligned with classification_feedback table columns.
 */
export interface UserFeedback {
  id: string;
  user_id: string;
  message_id?: string;
  attachment_id?: string;
  transaction_id?: string;
  contact_id?: string;
  feedback_type: string;
  original_value?: string;
  corrected_value?: string;
  reason?: string;
  created_at: string;
}

// ============================================
// IGNORED COMMUNICATION MODELS
// ============================================

/**
 * Represents a communication that has been explicitly ignored/excluded
 * from a transaction. This allows users to permanently hide irrelevant
 * emails without them being re-added during future scans.
 */
export interface IgnoredCommunication {
  id: string;
  user_id: string;
  transaction_id: string;
  email_subject?: string;
  email_sender?: string;
  email_sent_at?: string;
  /** BACKLOG-1560: Direct reference to emails table for reliable suppression */
  email_id?: string;
  /** BACKLOG-1560: Thread ID for text/email thread suppression */
  thread_id?: string;
  original_communication_id?: string;
  reason?: string;
  ignored_at: string;
}

/**
 * Data required to create a new ignored communication record.
 */
export interface NewIgnoredCommunication {
  user_id: string;
  transaction_id: string;
  email_subject?: string;
  email_sender?: string;
  email_sent_at?: string;
  /** BACKLOG-1560: Direct reference to emails table for reliable suppression */
  email_id?: string;
  /** BACKLOG-1560: Thread ID for text/email thread suppression */
  thread_id?: string;
  original_communication_id?: string;
  reason?: string;
}
