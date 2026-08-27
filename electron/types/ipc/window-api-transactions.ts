/**
 * WindowApi Transactions sub-interface
 * Transaction CRUD, linking, export, and submission methods
 */
import type { Transaction, Communication, ExportFormat } from "../models";
import type {
  AuditCoverageResult,
  ExportCompletenessResult,
  EnsureMessagesCoverageResult,
} from "../auditCoverage";
// BACKLOG-2367. TYPE-ONLY, fully erased at build time — the renderer gains the
// shape without gaining a dependency on main-process code. One definition
// rather than a hand-copied mirror that drifts the first time a column moves.
import type { TransactionContactResult } from "../../services/db/transactionContactDbService";


/** BACKLOG-2791: which store a review item came from. */
export type ReviewOrigin = "pending" | "legacy";
/** BACKLOG-2791: emails and texts are one queue. */
export type ReviewKind = "email" | "text";
export type ReviewSyncReason =
  | "open"
  | "background"
  | "contact-change"
  /** The audit dates were edited so the window covers MORE (BACKLOG-2791). */
  | "date-extended";

/**
 * What a surface needs to RENDER an item. It travels WITH the item because a
 * pending item is deliberately not in `communications` — a surface that tried to
 * join display data itself would render nothing for exactly the rows this
 * feature exists to show.
 */
export interface ReviewItemDisplayDto {
  title: string;
  subtitle: string;
  snippet: string;
  occurredAt: string | null;
  itemCount: number;
  /**
   * THE GROUPING KEY — the provider's conversation id for this communication
   * (BACKLOG-2791, Communication Lifecycle Contract, "the unit rule").
   *
   * For an EMAIL this is `emails.thread_id`, which is NOT the same as the item's
   * own `thread_id`: the queue keys emails by `email_id`, so an email item's
   * `thread_id` column is NULL by design. It is carried here, on the display
   * payload, rather than on `ReviewItemDto.thread_id`, because reject writes
   * THAT field into the `ignored_communications` suppression row and the
   * removed-TEXTS section selects on it — an email filed with a thread_id would
   * surface as a removed text conversation.
   *
   * NULL when the provider never threaded the record; the renderer then falls
   * back to the item id, i.e. a thread of one.
   */
  threadId: string | null;
  /** Raw fields so the renderer can rebuild a REAL thread for the app's own
   *  EmailThreadCard / MessageThreadCard — a pending item is absent from
   *  `communications`, so the tabs' loaders cannot hydrate it. */
  recipients: string | null;
  cc: string | null;
  sender: string | null;
  /**
   * The email's HTML body (BACKLOG-2831), under the same name the LINKED
   * loader's projection uses (`COALESCE(m.body_html, e.body_html) AS body`), so
   * the reading modal's existing `body_html || body` fallback finds it without a
   * second code path.
   *
   * Without it a review item carried NO html at all — only `snippet`, which is
   * `firstLine(body_plain)`. Outlook stores Graph's `bodyPreview` in
   * `body_plain` for every HTML message (outlookFetchService `_parseMessage`),
   * so an HTML message whose preview is empty — a calendar invite, an
   * attachment-only mail — produced an empty snippet and the modal rendered
   * "No content" for an email whose body was sitting in `emails.body_html`. The
   * SAME email renders its content once LINKED, because the linked loader
   * projects `body`. That asymmetry is the defect.
   *
   * NULL for texts and for emails that genuinely have no HTML part.
   */
  body: string | null;
  /**
   * The email's FULL plain-text body (BACKLOG-2844), matching what the LINKED
   * loader projects (`COALESCE(m.body_text, e.body_plain) AS body_text`).
   *
   * Separate from `snippet`, which stays capped at 200 characters for the card's
   * one-line preview. Feeding the modal that 200-char string made a message stop
   * mid-word with NO indication: the modal appends "..." only past its own
   * 300-character limit, which a 200-char string never reaches.
   *
   * NULL for texts and for emails with no plain-text part.
   */
  bodyText: string | null;
  hasAttachments: boolean;
  threadParticipants: string[];
  threadMessages: Array<{
    id: string;
    thread_id: string | null;
    body_text: string | null;
    sent_at: string | null;
    direction: string | null;
    /**
     * BACKLOG-2814: the participants JSON. MessageThreadCard derives group-ness
     * from THIS field, not from participants_flat, so its absence used to make
     * every review card render as a 1:1.
     */
    participants: string | null;
    participants_flat: string | null;
    channel: string | null;
    /** BACKLOG-2814: Apple's group name; null for 1:1s and unnamed groups. */
    thread_display_name: string | null;
  }>;
}

export interface ReviewItemDto {
  /** `${origin}:${rowId}` — stable and unambiguous across every surface. */
  id: string;
  /** The underlying row's primary key, already decoded. */
  rowId: string;
  origin: ReviewOrigin;
  kind: ReviewKind;
  transaction_id: string;
  email_id: string | null;
  thread_id: string | null;
  found_at: string;
  display: ReviewItemDisplayDto;
}

export interface ReviewStateResult {
  items: ReviewItemDto[];
  /** items.length — the ONE number for the badge, P2/P3 and the Complete gate. */
  count: number;
}

export interface ReviewSyncResult {
  /** Queued by THIS run — the popup's "require review" number. */
  added: number;
  /** Linked outright by THIS run — the popup's "linked successfully" number. */
  linked: number;
  outstanding: number;
}

export interface ReviewQueueChangedDto {
  transactionId: string;
  /** What THAT run newly queued — the popup's "require review". Silent at 0. */
  added: number;
  /** What THAT run linked outright — the popup's "linked successfully". */
  linked: number;
  /** Outstanding total — drives the badge. */
  outstanding: number;
  reason: ReviewSyncReason;
}

/**
 * A party tombstoned off a transaction — BACKLOG-2367.
 *
 * Structurally identical to a live assignment (`getRemovedTransactionContacts`
 * selects `tc.*` plus the same contact columns as the live read), so it is the
 * producer's own type rather than a parallel one. Aliased for the name: the
 * distinguishing fact about these rows is that `removed_at` is non-null.
 */
export type RemovedTransactionContact = TransactionContactResult;

// ============================================
// BACKLOG-2771: the ONE export vocabulary
// ============================================

/**
 * What a transaction export includes.
 *
 * There used to be two spellings of this on the wire — `"both" | "emails" |
 * "texts"` for folder export and `"both" | "email" | "text"` for the enhanced
 * export — with the ExportModal translating between them at the call site. One
 * type now serves both channels, so the compiler rejects the retired spelling.
 * Untrusted runtime values are mapped by `normalizeContentType()` in
 * `electron/services/exportPlan.ts`.
 */
export type ExportContentType = "both" | "emails" | "texts";

/** Which communications' attachments an export writes to disk. */
export type ExportAttachmentType = "all" | "email" | "text" | "none";

/** How emails are grouped in the exported artifact. */
export type ExportEmailMode = "thread" | "individual";

/**
 * The artifact an export produces.
 *
 * Built from the existing `ExportFormat` union in ../models (the single-file
 * formats) rather than restating it — "folder" is the one the enhanced export
 * service cannot produce.
 */
export type ExportPlanFormat = ExportFormat | "folder";

// ============================================
// BACKLOG-1866: Overview linked-content search result shapes
// ============================================

/** A contact assigned to the transaction that matched the search. */
export interface LinkedContentContactHit {
  contactId: string;
  displayName: string;
  role: string | null;
}

/** An email linked to the transaction that matched the search. */
export interface LinkedContentEmailHit {
  id: string;
  subject: string | null;
  sender: string | null;
  sentAt: string | null;
  snippet: string | null;
  /**
   * BACKLOG-1870 Phase 1.5: the attachment filename(s) that matched the query
   * (only the matches, not every attachment). Absent when the email matched on
   * subject/body/sender only — lets the UI show WHY the email surfaced.
   */
  matchedAttachmentFilenames?: string[];
}

/** A text/message linked to the transaction that matched the search. */
export interface LinkedContentTextHit {
  id: string;
  sender: string | null;
  snippet: string | null;
  sentAt: string | null;
  /** BACKLOG-1870 Phase 1.5: attachment filename(s) that matched the query. */
  matchedAttachmentFilenames?: string[];
}

/**
 * One result group: up to `limit` items, plus whether more were left behind.
 *
 * BACKLOG-2863 replaced the match COUNT with this flag. Six uncapped
 * `SELECT COUNT(*)` queries ran per keystroke at 190-210 ms each and could not
 * exit early — proving a total means visiting every match. Founder, choosing
 * between capped counts reading "200+" and no counts at all: *"i'm also fine with
 * just show more and not counting it."*
 *
 * Mirrors `LinkedGroup` in `electron/services/db/transactionSearchDbService.ts`.
 */
export interface LinkedContentGroup<T> {
  items: T[];
  hasMore: boolean;
}

/** Grouped results for a linked-content search, one group per content type. */
export interface LinkedContentSearchResults {
  contacts: LinkedContentGroup<LinkedContentContactHit>;
  emails: LinkedContentGroup<LinkedContentEmailHit>;
  /** BACKLOG-2858: MESSAGE-level hits only — one row per message. */
  texts: LinkedContentGroup<LinkedContentTextHit>;
  /** BACKLOG-2858: group-chat-name hits — one row per CONVERSATION. */
  groupChats: LinkedContentGroup<LinkedContentTextHit>;
}

// ============================================
// BACKLOG-1876: Global (unscoped) search result shapes
// ============================================

/** The owning transaction a global hit is attributed to (primary/earliest link). */
export interface GlobalTransactionAttribution {
  transactionId: string;
  propertyAddress: string;
}

/** A transaction whose address or a linked contact name matched. */
export interface GlobalTransactionHit {
  id: string;
  propertyAddress: string;
}

/** A contact (any of the user's) that matched, with its owning transaction. */
export interface GlobalContactHit {
  contactId: string;
  displayName: string;
  role: string | null;
  attribution: GlobalTransactionAttribution | null;
}

/** An email linked to some transaction that matched, with attribution. */
export interface GlobalEmailHit {
  id: string;
  subject: string | null;
  sender: string | null;
  sentAt: string | null;
  snippet: string | null;
  attribution: GlobalTransactionAttribution | null;
  /** BACKLOG-1870 Phase 1.5: attachment filename(s) that matched the query. */
  matchedAttachmentFilenames?: string[];
}

/** A text linked to some transaction that matched, with attribution. */
export interface GlobalTextHit {
  id: string;
  sender: string | null;
  snippet: string | null;
  sentAt: string | null;
  attribution: GlobalTransactionAttribution | null;
  /** BACKLOG-1870 Phase 1.5: attachment filename(s) that matched the query. */
  matchedAttachmentFilenames?: string[];
  /**
   * BACKLOG-2816: present ONLY on a thread-level (group chat name) hit. Its
   * presence makes the row a CONVERSATION: the renderer shows this as the primary
   * line and shows no body text on that row at all.
   */
  threadDisplayName?: string;
  /**
   * BACKLOG-2816: resolved contact names of a few group members. Members with no
   * matching contact are omitted rather than rendered as digits.
   */
  memberNames?: string[];
}

/** An email/text with NO communications row (not attached to any transaction). */
export interface GlobalUnattachedHit {
  kind: "email" | "text";
  id: string;
  /** Email subject or text sender — the primary display line. */
  title: string | null;
  sender: string | null;
  snippet: string | null;
  sentAt: string | null;
  /**
   * BACKLOG-2816: present ONLY on a thread-level (group chat name) hit. Its
   * presence makes the row a CONVERSATION: the renderer shows this as the primary
   * line and shows no body text on that row at all.
   */
  threadDisplayName?: string;
  /**
   * BACKLOG-2816: resolved contact names of a few group members. Members with no
   * matching contact are omitted rather than rendered as digits.
   */
  memberNames?: string[];
}

/** Grouped results for a global search: six groups. */
export interface GlobalContentSearchResults {
  transactions: LinkedContentGroup<GlobalTransactionHit>;
  contacts: LinkedContentGroup<GlobalContactHit>;
  emails: LinkedContentGroup<GlobalEmailHit>;
  /** BACKLOG-2858: MESSAGE-level hits only — one row per message. */
  texts: LinkedContentGroup<GlobalTextHit>;
  /** BACKLOG-2858: group-chat-name hits — one row per CONVERSATION. */
  groupChats: LinkedContentGroup<GlobalTextHit>;
  /**
   * Emails/texts attached to no transaction. Group-chat rows for UNATTACHED
   * threads stay here rather than in `groupChats` — these rows are inert (no
   * standalone viewer), and this bucket is not the Texts bucket the founder
   * asked group chats to leave.
   */
  unattached: LinkedContentGroup<GlobalUnattachedHit>;
}

/** Transaction methods on window.api */
export interface WindowApiTransactions {
  getAll: (userId: string) => Promise<{
    success: boolean;
    transactions?: Transaction[];
    error?: string;
  }>;
  /** BACKLOG-1124: Lightweight pending count query */
  getPendingCount: (userId: string) => Promise<{
    success: boolean;
    count: number;
    error?: string;
  }>;
  /**
   * BACKLOG-1866: Search everything linked to a single transaction — assigned
   * contacts, linked emails, and linked texts. Strictly scoped to the given
   * transaction's junction rows. Empty query returns empty groups.
   */
  searchLinkedContent: (
    transactionId: string,
    query: string,
  ) => Promise<{
    success: boolean;
    results?: LinkedContentSearchResults;
    error?: string;
  }>;
  /**
   * BACKLOG-1876: Global (unscoped) search across all of the user's content.
   * Returns transactions/contacts/emails/texts/unattached groups, each hit
   * attributed to its owning transaction (or null for unattached). Empty query
   * returns empty groups.
   */
  searchGlobalContent: (
    userId: string,
    query: string,
  ) => Promise<{
    success: boolean;
    results?: GlobalContentSearchResults;
    error?: string;
  }>;
  scan: (
    userId: string,
    options?: Record<string, unknown>,
  ) => Promise<{
    success: boolean;
    transactions?: Transaction[];
    transactionsFound?: number;
    emailsScanned?: number;
    error?: string;
  }>;
  cancelScan: (
    userId: string,
  ) => Promise<{ success: boolean; cancelled?: boolean; error?: string }>;
  getDetails: (
    transactionId: string,
  ) => Promise<{
    success: boolean;
    transaction?: Transaction & {
      communications?: Communication[];
      contact_assignments?: Array<{
        id: string;
        contact_id: string;
        contact_name?: string;
        contact_email?: string;
        contact_phone?: string;
        contact_company?: string;
        role?: string;
        specific_role?: string;
        is_primary?: number;
        notes?: string;
      }>;
    };
    error?: string;
  }>;
  /**
   * PERF: Lightweight overview - contacts only, no communications.
   */
  getOverview: (transactionId: string) => Promise<{
    success: boolean;
    transaction?: Transaction & {
      contact_assignments?: Array<{
        id: string;
        contact_id: string;
        contact_name?: string;
        contact_email?: string;
        contact_phone?: string;
        contact_company?: string;
        role?: string;
        specific_role?: string;
        is_primary?: number;
        notes?: string;
      }>;
    };
    error?: string;
  }>;
  /**
   * PERF: Filtered communications - only emails or only texts.
   */
  getCommunications: (transactionId: string, channelFilter?: "email" | "text") => Promise<{
    success: boolean;
    communications?: Communication[];
    error?: string;
  }>;
  getWithContacts: (transactionId: string) => Promise<{
    success: boolean;
    transaction?: Transaction;
    contacts?: Array<Record<string, unknown>>;
    error?: string;
  }>;
  create: (
    userId: string,
    transactionData: Record<string, unknown>,
  ) => Promise<{
    success: boolean;
    transaction?: Transaction;
    error?: string;
  }>;
  createAudited: (
    userId: string,
    transactionData: Record<string, unknown>,
  ) => Promise<{
    success: boolean;
    transaction?: Transaction;
    error?: string;
  }>;
  update: (
    transactionId: string,
    data: Record<string, unknown>,
  ) => Promise<{ success: boolean; error?: string }>;
  delete: (
    transactionId: string,
  ) => Promise<{ success: boolean; error?: string }>;
  exportPDF: (
    transactionId: string,
    outputPath: string,
  ) => Promise<{ success: boolean; filePath?: string; error?: string }>;
  exportEnhanced: (
    transactionId: string,
    options?: {
      exportFormat?: string;
      contentType?: ExportContentType;
      startDate?: string;
      endDate?: string;
      summaryOnly?: boolean;
      attachmentType?: ExportAttachmentType;
      emailExportMode?: ExportEmailMode;
    },
  ) => Promise<{ success: boolean; path?: string; error?: string }>;
  assignContact: (
    transactionId: string,
    contactId: string,
    role: string,
    roleCategory?: string,
    isPrimary?: boolean,
    notes?: string,
  ) => Promise<{ success: boolean; error?: string }>;
  removeContact: (
    transactionId: string,
    contactId: string,
  ) => Promise<{ success: boolean; error?: string }>;
  /**
   * BACKLOG-2367: parties previously removed from this transaction, most
   * recently removed first. Removal is a tombstone (BACKLOG-2366), so every
   * row still carries the role it held on the deal.
   */
  getRemovedContacts: (
    transactionId: string,
  ) => Promise<{
    success: boolean;
    removedContacts?: RemovedTransactionContact[];
    error?: string;
  }>;
  /**
   * BACKLOG-2367: put a removed party back on this transaction.
   * `restored: false` means the assignment was already live.
   */
  restoreContact: (
    transactionId: string,
    contactId: string,
  ) => Promise<{
    success: boolean;
    restored?: boolean;
    restoredCount?: number;
    error?: string;
  }>;
  batchUpdateContacts: (
    transactionId: string,
    operations: Array<{
      action: "add" | "remove";
      contactId: string;
      role?: string;
      roleCategory?: string;
      specificRole?: string;
      isPrimary?: boolean;
      notes?: string;
    }>,
  ) => Promise<{
    success: boolean;
    error?: string;
    autoLinkResults?: Array<{
      contactId: string;
      emailsLinked: number;
      messagesLinked: number;
      alreadyLinked: number;
      errors: number;
    }>;
  }>;
  unlinkCommunication: (
    communicationId: string,
    reason?: string,
  ) => Promise<{
    success: boolean;
    /**
     * BACKLOG-1778: communication ids actually removed (clicked row + thread
     * siblings). Lets the renderer drop those rows in place instead of
     * refetching the whole list (which reset the email list scroll position).
     */
    unlinkedIds?: string[];
    error?: string;
  }>;
  /**
   * BACKLOG-2319: Confirm "Needs review" email links (thread-aware) → Linked.
   * Sets match_reason='user_confirmed' on the emails' communication rows.
   */
  confirmEmailLinks: (
    emailIds: string[],
    transactionId: string,
  ) => Promise<{
    success: boolean;
    confirmedCount?: number;
    error?: string;
  }>;
  bulkDelete: (
    transactionIds: string[],
  ) => Promise<{
    success: boolean;
    deletedCount?: number;
    errors?: string[];
    error?: string;
  }>;
  bulkUpdateStatus: (
    transactionIds: string[],
    status: "pending" | "active" | "closed" | "rejected",
  ) => Promise<{
    success: boolean;
    updatedCount?: number;
    errors?: string[];
    error?: string;
  }>;

  // ============================================
  // MESSAGE / EMAIL LINK METHODS
  // ============================================

  /** Gets unlinked messages (SMS/iMessage not attached to any transaction) */
  getUnlinkedMessages: (userId: string) => Promise<{
    success: boolean;
    messages?: unknown[];
    error?: string;
  }>;
  /** Gets unlinked emails with server-side search support (TASK-1993) */
  getUnlinkedEmails: (
    userId: string,
    options?: {
      query?: string;
      after?: string;
      before?: string;
      maxResults?: number;
      skip?: number;
      transactionId?: string;
    },
  ) => Promise<{
    success: boolean;
    emails?: Array<{
      id: string;
      subject: string | null;
      sender: string | null;
      sent_at: string | null;
      body_preview?: string | null;
      thread_id?: string | null;
      has_attachments?: boolean;
    }>;
    error?: string;
  }>;
  /** Gets distinct contacts with unlinked message counts */
  getMessageContacts: (userId: string) => Promise<{
    success: boolean;
    contacts?: unknown[];
    error?: string;
  }>;
  /** Gets unlinked messages for a specific contact */
  getMessagesByContact: (userId: string, contact: string) => Promise<{
    success: boolean;
    messages?: unknown[];
    error?: string;
  }>;
  /** Links messages to a transaction */
  linkMessages: (messageIds: string[], transactionId: string) => Promise<{
    success: boolean;
    error?: string;
  }>;
  /** Unlinks messages from a transaction */
  unlinkMessages: (messageIds: string[], transactionId?: string) => Promise<{
    success: boolean;
    error?: string;
  }>;
  /** BACKLOG-1577: Get removed/unlinked messages for a transaction */
  getRemovedMessages: (transactionId: string) => Promise<{
    success: boolean;
    removedMessages?: Array<{
      ignored_id: string;
      ic_thread_id: string | null;
      reason: string | null;
      ignored_at: string;
      message_id: string;
      body: string | null;
      subject: string | null;
      channel: string | null;
      thread_id: string | null;
      sent_at: string | null;
      received_at: string | null;
      participants: string | null;
      participants_flat: string | null;
      direction: string | null;
    }>;
    error?: string;
  }>;
  /** BACKLOG-1577: Restore a removed message (re-link + remove suppression) */
  restoreRemovedMessage: (ignoredCommId: string, messageIds: string[], transactionId: string) => Promise<{
    success: boolean;
    error?: string;
  }>;
  /** BACKLOG-1578: Get removed/unlinked emails for a transaction */
  getRemovedEmails: (transactionId: string) => Promise<{
    success: boolean;
    removedEmails?: Array<{
      ignored_id: string;
      ic_email_id: string | null;
      reason: string | null;
      ignored_at: string;
      email_id: string;
      subject: string | null;
      sender: string | null;
      recipients: string | null;
      cc: string | null;
      sent_at: string | null;
      thread_id: string | null;
      body_preview: string | null;
      body_plain: string | null;
      has_attachments: boolean | number | null;
      source: string | null;
    }>;
    error?: string;
  }>;
  /** BACKLOG-1578: Restore a removed email (re-link + remove suppression) */
  restoreRemovedEmail: (ignoredCommId: string, emailId: string, transactionId: string) => Promise<{
    success: boolean;
    restoredCount?: number;
    error?: string;
  }>;
  /** Link emails to a transaction */
  linkEmails: (emailIds: string[], transactionId: string) => Promise<{
    success: boolean;
    linked?: number;
    error?: string;
  }>;
  /** Auto-links text messages to a transaction based on assigned contacts */
  autoLinkTexts: (transactionId: string) => Promise<{
    success: boolean;
    error?: string;
  }>;
  /** Re-syncs auto-link communications for all contacts on a transaction */
  resyncAutoLink: (transactionId: string) => Promise<{
    success: boolean;
    contactsProcessed?: number;
    totalEmailsLinked?: number;
    totalMessagesLinked?: number;
    totalAlreadyLinked?: number;
    totalErrors?: number;
    // BACKLOG-2293: messages linked by attached-thread expansion (backfill already
    // sharing an attached thread) — can be > 0 while totalMessagesLinked is 0.
    attachedExpansionLinked?: number;
    addressFilterMessage?: string;
    message?: string;
    error?: string;
  }>;
  /** BACKLOG-1364: Update address filter toggle and re-run auto-link */
  updateAddressFilter: (transactionId: string, skipAddressFilter: boolean) => Promise<{
    success: boolean;
    contactsProcessed?: number;
    totalEmailsLinked?: number;
    totalMessagesLinked?: number;
    totalAlreadyLinked?: number;
    totalErrors?: number;
    addressFilterMessage?: string;
    message?: string;
    error?: string;
  }>;
  /** Sync emails from provider for a transaction */
  syncAndFetchEmails: (transactionId: string) => Promise<{
    success: boolean;
    provider?: "gmail" | "outlook";
    emailsFetched?: number;
    emailsStored?: number;
    totalEmailsLinked?: number;
    totalMessagesLinked?: number;
    totalAlreadyLinked?: number;
    totalErrors?: number;
    error?: string;
    message?: string;
    rateLimited?: boolean;
  }>;
  /**
   * BACKLOG-1362: Pre-cache emails from connected providers.
   *
   * BACKLOG-2856: `force` re-downloads the whole cache window and REPLACES what
   * is stored, instead of fetching only mail newer than the newest cached row.
   * Parity with the macOS messages Force Re-import: it cascade-deletes every
   * email↔transaction link, so the caller must confirm that with the user first.
   */
  precacheEmails: (userId: string, force?: boolean) => Promise<{
    success: boolean;
    emailsFetched?: number;
    emailsStored?: number;
    error?: string;
    rateLimited?: boolean;
    /**
     * BACKLOG-2127: set when a provider's OAuth token is expired/revoked.
     * The renderer sync flow throws on `tokenExpired` so the emails item
     * enters an error state (reconnect prompt) instead of reporting a green
     * "0 new messages". Absent for clean or transient/network failures.
     */
    providerError?: {
      provider: "microsoft" | "google";
      message: string;
      tokenExpired: boolean;
    };
    /**
     * BACKLOG-2856: set only when a force run reached the swap. `emailsInserted`
     * is what actually landed in the live table — `emailsStored` counts staging
     * writes and so overstates a force run — and `providers` names the mailboxes
     * that were rebuilt, so a caller can tell that a connected one was skipped.
     */
    forceSwap?: {
      emailsDeleted: number;
      emailsInserted: number;
      participantsInserted: number;
      providers: Array<"gmail" | "outlook">;
    };
    /**
     * BACKLOG-2856: the user stopped the run. Arrives with `success: false` and
     * a plain-language `error`, but must NOT be rendered as a failure — nothing
     * went wrong, and on a force run nothing was changed either.
     */
    cancelled?: boolean;
  }>;

  /**
   * BACKLOG-2856: stop an in-flight pre-cache / re-cache at its next loop
   * boundary. Resolves `success: true` if a run was asked to stop, `false` if
   * none was in flight (already finished — the outcome the user wanted anyway).
   */
  cancelPrecacheEmails: () => Promise<{ success: boolean; error?: string }>;

  /**
   * BACKLOG-2856: subscribe to pre-cache / re-cache progress, mirroring
   * `window.api.messages.onImportProgress`.
   *
   * Sequences differ by path, because the two runs do different work:
   *   ordinary  repairing -> fetching -> done
   *   force                  fetching -> swapping -> done
   *
   * `percent` never decreases within a run. The final event is always
   * `phase: "done"` with an `outcome`, on success, failure AND cancel, so the
   * subscriber can settle on it without tracking which path ran.
   */
  onPrecacheProgress: (
    callback: (progress: {
      phase: "repairing" | "fetching" | "swapping" | "done";
      current: number;
      total: number;
      percent: number;
      outcome?: "success" | "error" | "cancelled";
    }) => void,
  ) => () => void;
  /** Export transaction to organized folder structure */
  exportFolder: (transactionId: string, options?: {
    contentType?: ExportContentType;
    attachmentType?: ExportAttachmentType;
    emailExportMode?: ExportEmailMode;
  }) => Promise<{
    success: boolean;
    path?: string;
    error?: string;
  }>;
  /** Get earliest communication date for contacts (TASK-1974) */
  getEarliestCommunicationDate: (contactIds: string[], userId: string) => Promise<{
    success: boolean;
    date?: string | null;
    error?: string;
  }>;
  reanalyze: (
    userId: string,
    provider: string,
    propertyAddress: string,
    dateRange: { start?: string | Date; end?: string | Date },
  ) => Promise<{
    success: boolean;
    newCount?: number;
    updatedCount?: number;
    error?: string;
  }>;

  // ============================================
  // EMAIL ATTACHMENT METHODS (TASK-1776)
  // ============================================

  /** Get attachments for a specific email */
  getEmailAttachments: (emailId: string) => Promise<{
    success: boolean;
    data?: Array<{
      id: string;
      filename: string;
      mime_type: string | null;
      file_size_bytes: number | null;
      storage_path: string | null;
    }>;
    error?: string;
    downloadBlocked?: boolean;
    offline?: boolean;
    downloadRequired?: boolean;
    reason?: string;
  }>;
  /**
   * BACKLOG-322 Phase A: Unified list of ALL attachments linked to a transaction
   * (email + text/iMessage), including metadata-only rows not yet downloaded.
   */
  getAllAttachments: (
    transactionId: string,
    auditStart?: string,
    auditEnd?: string,
  ) => Promise<{
    success: boolean;
    data?: Array<{
      id: string;
      filename: string;
      mime_type: string | null;
      file_size_bytes: number | null;
      storage_path: string | null;
      created_at: string | null;
      source: "email" | "text";
      source_date: string | null;
      direction: string | null;
      context_subject: string | null;
      context_sender: string | null;
      email_id: string | null;
      message_id: string | null;
    }>;
    error?: string;
  }>;
  /**
   * BACKLOG-322 Phase A: Force an on-demand download of a metadata-only email
   * attachment so it can be previewed, then return the refreshed rows.
   */
  ensureEmailAttachmentDownloaded: (emailId: string) => Promise<{
    success: boolean;
    data?: Array<{
      id: string;
      filename: string;
      mime_type: string | null;
      file_size_bytes: number | null;
      storage_path: string | null;
    }>;
    error?: string;
    downloadBlocked?: boolean;
    offline?: boolean;
    reason?: string;
  }>;
  /** Backfill missing email attachments */
  backfillAttachments: (userId: string) => Promise<{
    success: boolean;
    error?: string;
  }>;
  /**
   * BACKLOG-2250: One-time metadata-only attachment backfill (no bytes).
   * Indexes filenames for emails synced before BACKLOG-1870.
   */
  backfillAttachmentMetadata: (userId: string) => Promise<{
    success: boolean;
    totalMissing?: number;
    processed?: number;
    indexed?: number;
    attachments?: number;
    errors?: number;
    remaining?: number;
    error?: string;
  }>;
  /**
   * BACKLOG-2257: Manual/dev-only LOCAL text-extraction backfill. Populates
   * attachments.text_content for already-downloaded PDF/plain-text rows (no
   * network, no OCR). Idempotent and bounded — safe to invoke repeatedly.
   */
  extractAttachmentTextBackfill: (options?: { maxAttachments?: number }) => Promise<{
    success: boolean;
    totalPending?: number;
    processed?: number;
    extracted?: number;
    skipped?: number;
    errors?: number;
    remaining?: number;
    error?: string;
  }>;
  /** Open attachment with system viewer */
  openAttachment: (storagePath: string) => Promise<{
    success: boolean;
    error?: string;
  }>;
  /** Get attachment data as base64 data URL for preview */
  getAttachmentData: (storagePath: string, mimeType: string) => Promise<{
    success: boolean;
    data?: string;
    error?: string;
  }>;
  /** Get attachment buffer as raw base64 (for DOCX conversion) */
  getAttachmentBuffer: (storagePath: string) => Promise<{
    success: boolean;
    data?: string;
    error?: string;
  }>;
  /** Get attachment counts for a transaction (TASK-1781) */
  getAttachmentCounts: (transactionId: string, auditStart?: string, auditEnd?: string) => Promise<{
    success: boolean;
    data?: {
      textAttachments: number;
      emailAttachments: number;
      total: number;
      totalSizeBytes?: number;
    };
    error?: string;
  }>;

  // ============================================
  // SUBMISSION METHODS (BACKLOG-391)
  // ============================================

  /**
   * Submit transaction to broker portal for review
   */
  submit: (transactionId: string) => Promise<{
    success: boolean;
    submissionId?: string;
    messagesCount?: number;
    attachmentsCount?: number;
    attachmentsFailed?: number;
    error?: string;
  }>;

  /**
   * Resubmit transaction (creates new version)
   */
  resubmit: (transactionId: string) => Promise<{
    success: boolean;
    submissionId?: string;
    messagesCount?: number;
    attachmentsCount?: number;
    attachmentsFailed?: number;
    error?: string;
  }>;

  /** Get submission status from cloud */
  getSubmissionStatus: (submissionId: string) => Promise<{
    success: boolean;
    status?: string;
    reviewNotes?: string;
    reviewedBy?: string;
    reviewedAt?: string;
    error?: string;
  }>;

  /**
   * Listen for submission progress updates
   */
  onSubmitProgress: (callback: (progress: {
    stage: string;
    stageProgress: number;
    overallProgress: number;
    currentItem?: string;
  }) => void) => () => void;

  /**
   * BACKLOG-1832: Mount-time inflight-sync query.
   * Returns whether a background auto-sync is currently in progress for the
   * given transaction. Used by TransactionDetails to retroactively show the
   * spinner when the component mounts after the push event was already sent.
   */
  isAutoSyncInFlight: (transactionId: string) => Promise<{
    success: boolean;
    inFlight: boolean;
  }>;

  // ============================================
  // AUDIT-WINDOW COMPLETENESS (BACKLOG-2292)
  // ============================================

  /**
   * Coverage for a PROPOSED audit start (date-selection time). Drives the
   * Layer-1 popup. All floors are ISO strings (SR-correction f).
   */
  getAuditCoverage: (
    userId: string,
    proposedStartISO: string,
  ) => Promise<AuditCoverageResult>;

  /**
   * Export completeness backstop (Layer 3): is a transaction's messages coverage
   * complete for its saved audit window?
   */
  checkExportCompleteness: (
    transactionId: string,
    userId: string,
  ) => Promise<ExportCompletenessResult>;

  /**
   * The "Update now" action: run a targeted messages import + expansion for an
   * explicit (possibly unsaved) proposed start. Progress streams over
   * `messages:import-progress`. Returns the floor AFTER the attempt.
   */
  ensureMessagesCoverage: (
    userId: string,
    proposedStartISO: string | null,
    transactionId?: string,
  ) => Promise<EnsureMessagesCoverageResult>;

  /**
   * BACKLOG-2292 (Layer 2): background messages-sync completion event so
   * TransactionDetails can silently refresh its text list. transactionId is null
   * when the import is user-global.
   */
  onMessagesSyncComplete: (
    callback: (data: { transactionId: string | null; ran: boolean; imported: number }) => void,
  ) => () => void;

  // ==========================================================================
  // BACKLOG-2791 / BACKLOG-2792 — the Needs Review queue.
  //
  // ONE source of truth (founder ruling 2026-08-22): the combined S2 screen,
  // both tabs' needs-review sections, the header badge, the P2/P3 popups and the
  // Complete gate all read getReviewState. Nothing in the renderer may derive
  // review state any other way.
  // ==========================================================================

  /** The combined queue: the pending items the sync found + the legacy
   *  BACKLOG-2319 address_missing population, unioned into ONE set. */
  getReviewState: (transactionId: string) => Promise<ReviewStateResult>;

  /**
   * Run discovery for a transaction.
   *  - "open"           → only records INGESTED since the deal's watermark.
   *  - "contact-change" → the full window, but only for `contactIds`.
   * `added` is what THIS run newly queued and drives the popup (silent at 0);
   * `outstanding` is the badge total.
   */
  syncReviewQueue: (
    transactionId: string,
    reason: ReviewSyncReason,
    contactIds?: string[],
  ) => Promise<ReviewSyncResult>;

  /** Approve — THIS is what links a pending item, per the normal rules. */
  approveReviewItems: (itemIds: string[]) => Promise<{ approved: number }>;

  /** Reject — durable; the suppression row stops a later sync resurrecting it. */
  rejectReviewItems: (itemIds: string[]) => Promise<{ rejected: number }>;

  /**
   * BACKLOG-2791: fires whenever any trigger changes the queue, so a
   * MAIN-PROCESS sync (contact save, contact edit elsewhere, deal creation)
   * reaches the screen instead of waiting for the next open.
   */
  onReviewQueueChanged: (
    callback: (data: ReviewQueueChangedDto) => void,
  ) => () => void;
}
