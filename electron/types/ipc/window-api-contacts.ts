/**
 * WindowApi Contacts sub-interface
 * Contact management methods exposed to renderer process
 */

import type { Contact, ContactSource, NewContact, Transaction, Communication, ContactMessageThread } from "../models";
// BACKLOG-2410. TYPE-ONLY imports, fully erased at build time — the renderer
// gains the shapes without gaining a dependency on main-process code. One
// definition rather than a hand-copied mirror, which drifts the first time a
// field is added and is not noticed until it reads `undefined` at runtime.
import type { ReviewQueueCluster, ReviewQueueItem } from "../../services/contactLinkReview";
import type { ContactSourceProvenance } from "../../services/contactProvenance";
// BACKLOG-2367 — same type-only rule as above. The removed-contact row is
// produced by contactDbService; mirroring its shape by hand here is how
// `active_role_count` would silently become `undefined` the first time the
// query changed.
import type { RemovedContactRow } from "../../services/db/contactDbService";
// BACKLOG-2426 — same type-only rule. A second copy of `LinkableSourceRecord`
// here is how the renderer and the main process come to disagree about what a
// source record is.
import type {
  LinkableSourceRecord,
  LinkSourceOutcome,
  SourceRecordRef,
} from "../../services/contactManualLink";

// BACKLOG-2471 PR C — same type-only rule. The compare view is produced by
// `contactCompare`; a hand-copied mirror here is how a column would start
// reading `undefined` on the one screen whose job is to be trusted about what a
// contact is made of.
import type {
  ContactCompareColumn,
  ContactCompareView,
  CompareCommItem,
  CompareValue,
} from "../../services/contactCompare";

export type ContactReviewCluster = ReviewQueueCluster;
export type ContactReviewItem = ReviewQueueItem;
export type { ContactSourceProvenance, RemovedContactRow };
export type { LinkableSourceRecord, LinkSourceOutcome, SourceRecordRef };
export type {
  ContactCompareColumn,
  ContactCompareView,
  CompareCommItem,
  CompareValue,
};

/**
 * Transaction shape returned by `checkCanDelete` (databaseService.getTransactionsByContact).
 * BACKLOG-1930: `roles` is a typed, deduped `string[]` at this boundary (NOT a
 * pre-joined display string). Display formatting (the ", " join) is owned by the
 * renderer. This replaces the pre-joined-string that caused BACKLOG-1898's
 * `t.roles?.join is not a function` runtime error — `roles` is now honestly
 * typed as an array, matching the producer (`TransactionWithRoles.roles: string[]`).
 */
export interface ContactBlockingTransaction extends Transaction {
  roles?: string[];
}

/**
 * Contact methods on window.api
 */
export interface WindowApiContacts {
  getAll: (
    userId: string,
  ) => Promise<{ success: boolean; contacts?: Contact[]; error?: string }>;
  getSortedByActivity: (
    userId: string,
    propertyAddress?: string,
  ) => Promise<{ success: boolean; contacts?: Contact[]; error?: string }>;
  getAvailable: (
    userId: string,
  ) => Promise<{ success: boolean; contacts?: Contact[]; error?: string }>;
  checkCanDelete: (contactId: string) => Promise<{
    success: boolean;
    canDelete?: boolean;
    transactionCount?: number;
    transactions?: ContactBlockingTransaction[];
    count?: number;
    error?: string;
  }>;
  create: (
    userId: string,
    contactData: Record<string, unknown>,
  ) => Promise<{ success: boolean; contact?: Contact; error?: string }>;
  update: (
    contactId: string,
    updates: Record<string, unknown>,
  ) => Promise<{ success: boolean; error?: string }>;
  /** TASK-1995: Get email/phone entries with row IDs for multi-entry editing */
  getEditData: (contactId: string) => Promise<{
    success: boolean;
    emails?: { id: string; email: string; is_primary: boolean }[];
    phones?: { id: string; phone: string; is_primary: boolean }[];
    /**
     * BACKLOG-2493: the contact's LIVE crosswalk sources, so a hand-built
     * contact object (the transaction "Key Contacts" pane) shows the same
     * source pills as the Clients & Contacts card instead of the stale
     * INSERT-time scalar. OMITTED, never `[]`, when there are no links —
     * `undefined` and `[]` are not interchangeable on this field.
     */
    source_types?: ContactSource[];
    error?: string;
  }>;
  delete: (
    contactId: string,
  ) => Promise<{ success: boolean; error?: string }>;
  remove: (
    contactId: string,
  ) => Promise<{ success: boolean; error?: string }>;
  /**
   * BACKLOG-2367: contacts the user has removed, most recently removed first.
   * Feeds the "Show removed contacts (N)" section of Clients & Contacts.
   */
  getRemoved: (
    userId: string,
  ) => Promise<{ success: boolean; contacts?: RemovedContactRow[]; error?: string }>;
  /**
   * BACKLOG-2367: undo a contact removal.
   * `restored: false` means the contact was already active — a stale click on
   * a list another window has already restored from, not a failure.
   */
  restore: (
    contactId: string,
  ) => Promise<{ success: boolean; restored?: boolean; error?: string }>;
  /**
   * BACKLOG-2510 — the return type now says what the handler actually returns.
   *
   * It declared `imported?: number`, which the handler has never sent. What it
   * sends is `contacts` — the created rows, read straight from the database
   * (`contactHandlers.ts:2052-2055`). The one caller that needed them cast the
   * result to a hand-written shape to get at them, so the declared type was
   * wrong AND unenforced, and any new caller reading `result.imported` would
   * have compiled cleanly and got `undefined` at runtime.
   *
   * `contacts` is what the Clients & Contacts import needs: it keeps the user
   * on the contact they just imported, which requires the created row back.
   */
  import: (
    userId: string,
    contacts: NewContact[],
  ) => Promise<{ success: boolean; contacts?: Contact[]; error?: string }>;
  /** Listen for import progress updates */
  onImportProgress: (
    callback: (progress: { current: number; total: number; percent: number }) => void
  ) => () => void;
  /**
   * Sync external contacts from macOS Contacts app
   * @param userId - User ID to sync contacts for
   * @returns Sync result with inserted/deleted/total counts, plus BACKLOG-2404
   *          address-book read coverage — `read 2 of 3` has to reach the
   *          renderer, not only the log, or the panel reports a partial read
   *          as a clean sync
   */
  syncExternal: (userId: string) => Promise<{
    success: boolean;
    inserted?: number;
    deleted?: number;
    total?: number;
    /** BACKLOG-2404 — address books found / read / failed for this sync. */
    read?: {
      found: number;
      read: number;
      failed: number;
      coverage: "complete" | "partial" | "none";
    };
    error?: string;
  }>;
  /**
   * Get external contacts sync status
   * @param userId - User ID to check status for
   * @returns Sync status (lastSyncAt, isStale, contactCount)
   */
  getExternalSyncStatus: (userId: string) => Promise<{
    success: boolean;
    lastSyncAt?: string | null;
    isStale?: boolean;
    contactCount?: number;
    error?: string;
  }>;
  /**
   * Get contact source stats - per-source counts (TASK-1991)
   * @param userId - User ID to get stats for
   * @returns Per-source contact counts
   */
  getSourceStats: (userId: string) => Promise<{
    success: boolean;
    stats?: Record<string, number>;
    error?: string;
  }>;
  /** Sync Outlook contacts to external_contacts table */
  syncOutlookContacts: (userId: string) => Promise<{
    success: boolean;
    count?: number;
    reconnectRequired?: boolean;
    /** BACKLOG-2142: dead-token discriminator for the reconnect CTA */
    tokenExpired?: boolean;
    error?: string;
  }>;
  /** Sync Google contacts to external_contacts table (TASK-2303) */
  syncGoogleContacts: (userId: string) => Promise<{
    success: boolean;
    count?: number;
    reconnectRequired?: boolean;
    /** BACKLOG-2142: dead-token discriminator for the reconnect CTA */
    tokenExpired?: boolean;
    error?: string;
  }>;
  /** Force re-import: wipe ALL external contacts then return */
  forceReimport: (userId: string) => Promise<{
    success: boolean;
    cleared: number;
    error?: string;
  }>;
  /** Look up contact names by phone numbers (batch) */
  getNamesByPhones: (phones: string[]) => Promise<{
    success: boolean;
    names: Record<string, string>;
    error?: string;
  }>;
  /** TASK-2026: Resolve any mix of phones, emails, Apple IDs to contact names */
  resolveHandles: (handles: string[], userId?: string) => Promise<{
    success: boolean;
    names: Record<string, string>;
    error?: string;
  }>;
  /**
   * BACKLOG-1762: Get an email address -> display_name map for the user's
   * contacts. Keys are lowercase email addresses. Email views use this to
   * resolve display names when the email header carries no name.
   */
  getEmailNameMap: (userId: string) => Promise<{
    success: boolean;
    nameMap: Record<string, string>;
    error?: string;
  }>;
  /**
   * BACKLOG-1933: Get ALL emails involving this contact's addresses, aggregated
   * across every transaction. Each element is a hydrated `Communication` ready
   * to mount in EmailViewModal; `transaction_id` is undefined for emails not
   * linked to any transaction.
   */
  getEmailsForContact: (contactId: string) => Promise<{
    success: boolean;
    emails?: Communication[];
    error?: string;
  }>;
  /**
   * BACKLOG-1933: Get ALL text-message threads involving this contact's phones,
   * aggregated across every transaction. Each group carries the required
   * `phoneNumber` for ConversationViewModal.
   */
  getMessagesForContact: (contactId: string) => Promise<{
    success: boolean;
    messages?: ContactMessageThread[];
    error?: string;
  }>;
  /** Update the default_role on a contact (manual override) */
  updateDefaultRole: (contactId: string, role: string) => Promise<{
    success: boolean;
    error?: string;
  }>;
  /** Search contacts at database level (for selection modal) */
  searchContacts: (userId: string, query: string) => Promise<{
    success: boolean;
    contacts?: Contact[];
    error?: string;
  }>;
  /** Listen for external contacts sync completion */
  onExternalSyncComplete: (callback: () => void) => () => void;
  /**
   * Fires after a contact-linking pass settles — BACKLOG-2474.
   *
   * DISTINCT from `onExternalSyncComplete`, which means "the shadow table
   * changed" and drives a picker reload. This one means "the review queue may
   * have changed", and its only job is the count on the Review button.
   *
   * Keeping them apart is load-bearing: the linking pass runs during
   * `contacts:import`, fired from a modal that reloads its available-contacts
   * list on `onExternalSyncComplete`. Reusing that channel would repopulate the
   * picker mid-import and invalidate its selection against new contact ids.
   */
  onLinkReviewUpdated: (callback: () => void) => () => void;

  // ---- BACKLOG-2410: contact-level review queue --------------------------
  /** How many identity questions are waiting — the number on the button. */
  getReviewQueueCount: (
    userId: string,
  ) => Promise<{ success: boolean; count?: number; error?: string }>;
  /** The pending questions, grouped so one answer can settle several pairs. */
  getReviewQueue: (
    userId: string,
  ) => Promise<{ success: boolean; clusters?: ContactReviewCluster[]; error?: string }>;
  /** "The same person" — creates the link, records a durable must-link. */
  confirmLink: (
    userId: string,
    proposalId: string,
  ) => Promise<{ success: boolean; linked?: boolean; alsoRejected?: number; error?: string }>;
  /** "Different people" — records a durable cannot-link. Never asked again. */
  rejectLink: (
    userId: string,
    proposalId: string,
  ) => Promise<{ success: boolean; error?: string }>;

  // ---- BACKLOG-2410: contact provenance ----------------------------------
  /** Which sources this contact was assembled from, and how each was matched. */
  getSources: (
    userId: string,
    contactId: string,
  ) => Promise<{ success: boolean; sources?: ContactSourceProvenance[]; error?: string }>;
  /** Detach ONE source without deleting the contact or the source record. */
  unlinkSource: (
    userId: string,
    contactId: string,
    linkId: string,
  ) => Promise<UnlinkSourceResponse>;

  // ---- BACKLOG-2471 PR C: the compare screen, read-only ------------------
  /**
   * Every record this contact is assembled from, as columns. `view` is absent
   * when there is nothing to compare — a contact whose only source is the one
   * it was created from.
   */
  getCompareColumns: (
    userId: string,
    contactId: string,
  ) => Promise<{ success: boolean; view?: ContactCompareView | null; error?: string }>;

  // ---- BACKLOG-2426: manual linking ---------------------------------------
  /**
   * Source records the user could attach by hand — UNCLAIMED ones only.
   * Empty query lists everything available; otherwise it is a text search.
   */
  findLinkableSources: (userId: string) => Promise<FindLinkableSourcesResponse>;
  /**
   * Attach one source record to one saved contact, because a human said so.
   *
   * `acknowledgedPriorRejection` is the second confirmation: the first call
   * returns `prior_rejection` when the user previously unlinked this exact
   * pair, so the renderer can disclose that before overturning it.
   */
  linkSource: (
    userId: string,
    contactId: string,
    records: SourceRecordRef[],
    acknowledgedPriorRejections?: SourceRecordRef[],
  ) => Promise<LinkSourceResponse>;
}

/**
 * What an unlink did — BACKLOG-2427.
 *
 * `remaining` alone was the whole story until the founder found that it was not:
 * the link went, the `different_people` verdict was recorded, and the rejected
 * record's email stayed on a contact who is a party to a transaction. The
 * removal counts are here so the renderer can report the action it actually
 * performed rather than the one the copy promises.
 */
export interface UnlinkSourceResponse {
  success: boolean;
  /** Source links still attached to the contact. */
  remaining?: number;
  /** Emails taken back — contributed by this source and by nothing else. */
  removedEmails?: number;
  /** Phones taken back, same rule. */
  removedPhones?: number;
  /**
   * Why removable addresses were KEPT anyway. `frozen_transaction`: the contact
   * is on an exported audit and removing them would silently change what a
   * re-export searches, so the removal is refused and explained rather than
   * done quietly. Absent when nothing was withheld.
   */
  retainedReason?: "frozen_transaction";
  error?: string;
}

export interface FindLinkableSourcesResponse {
  success: boolean;
  records?: LinkableSourceRecord[];
  error?: string;
}

/**
 * `success` is about the CALL; `outcome` is about the ANSWER.
 *
 * A refused link ("that record already belongs to someone else", "you
 * previously said these were different people") is a successful call with a
 * negative outcome — not an error. Collapsing the two would force the renderer
 * to distinguish a disclosure it must render from a failure it must report by
 * reading message text.
 */
export interface LinkSourceResponse {
  success: boolean;
  /**
   * ONE OUTCOME PER INPUT RECORD, IN THE SAME ORDER (BACKLOG-2591).
   *
   * Plural because linking is a batch: `outcomes[i]` describes `records[i]`, so
   * the caller can say WHICH record was skipped without matching on identity.
   * A refusal is per-record and local — one claimed record does not spoil the
   * others, which is exactly why the service loops transactions instead of
   * wrapping them.
   */
  outcomes?: LinkSourceOutcome[];
  error?: string;
}
