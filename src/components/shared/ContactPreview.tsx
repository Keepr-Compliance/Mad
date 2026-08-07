import React, { useState } from "react";
import { ResponsiveModal } from "../common/ResponsiveModal";
import { SourcePill, ImportStatusPill, mapToSourcePillSources } from "./SourcePill";
import { formatRoleLabel } from "../../utils/transactionRoleUtils";
import type { ExtendedContact } from "../../types/components";
import type { Communication, ContactMessageThread, Message } from "@/types";
import type { ContactSourceProvenance } from "@/types/contactProvenance";
import { labelForContact } from "@/utils/contactDisplayLabel";
import {
  canUnlinkSource,
  showSourcesPanel,
} from "@/utils/contactSourceAffordances";

/**
 * Transaction associated with a contact
 */
export interface ContactTransaction {
  id: string;
  property_address: string;
  role: string;
}

/** Number of rows shown per section before "Show all N" is offered (BACKLOG-1944). */
const DEFAULT_VISIBLE_ROWS = 3;

/**
 * Best-effort one-line "from" label for an email row in the contact card.
 * Prefers the subject; falls back to the sender address, then a placeholder.
 * Kept purely presentational (no data-layer coupling) — BACKLOG-1934.
 */
function getEmailPrimaryLine(email: Communication): string {
  return email.subject?.trim() || email.sender?.trim() || "(No subject)";
}

/**
 * Formats a sent_at/received_at pair for a row's secondary line. Returns an
 * empty string when no date is available (rendered as blank rather than
 * "Invalid Date"). Shared by email rows (formatEmailDate) and text-thread rows
 * (formatThreadDate) since Communication and Message carry the same fields.
 */
function formatTimestamp(item: Pick<Message, "sent_at" | "received_at"> | undefined): string {
  if (!item) return "";
  const raw = item.sent_at || item.received_at;
  if (!raw) return "";
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toLocaleDateString();
}

/**
 * Formats an email's timestamp for the row's secondary line. Returns an empty
 * string when no date is available (rendered as blank rather than "Invalid Date").
 */
function formatEmailDate(email: Communication): string {
  return formatTimestamp(email);
}

/**
 * One-line body snippet for an email row (BACKLOG-1944). Prefers the
 * normalized `body_text`, falls back to the legacy `body_plain` field — same
 * fallback chain MessageBubble uses. Strips newlines so `truncate` (CSS
 * single-line ellipsis) has one continuous line to clip. Returns undefined
 * when no body text is available so the caller can render nothing (never the
 * literal string "undefined").
 */
function getEmailSnippet(email: Communication): string | undefined {
  const raw = email.body_text || email.body_plain;
  if (!raw) return undefined;
  const flattened = raw.replace(/\s+/g, " ").trim();
  return flattened || undefined;
}

/**
 * Sent/received tag for an email row, derived from `direction`
 * ("outbound" | "inbound" — same field Message/MessageBubble uses). Returns
 * undefined when direction wasn't classified, so the tag is simply omitted.
 */
function getDirectionTag(direction: Message["direction"]): string | undefined {
  if (direction === "outbound") return "Sent";
  if (direction === "inbound") return "Received";
  return undefined;
}

/**
 * One-line label for a text thread row in the contact card. Prefers the thread's
 * representative phone number; falls back to a placeholder for the (rare) case of
 * an empty phone. Kept purely presentational — BACKLOG-1935.
 */
function getThreadPrimaryLine(thread: ContactMessageThread): string {
  return thread.phoneNumber?.trim() || "(Unknown number)";
}

/**
 * Secondary line for a text thread row: the last-activity date (from the newest
 * message in the group). Returns an empty string when no valid date is available
 * (rendered blank rather than "Invalid Date"), mirroring formatEmailDate.
 */
function formatThreadDate(thread: ContactMessageThread): string {
  return formatTimestamp(newestMessage(thread));
}

/**
 * Count label for a text thread row (e.g. "3 messages" / "1 message").
 */
function formatThreadCount(thread: ContactMessageThread): string {
  const count = thread.messages.length;
  return `${count} message${count === 1 ? "" : "s"}`;
}

/**
 * The newest message in a thread group, by sent_at/received_at. Returns
 * undefined for an (unexpected) empty message list.
 */
function newestMessage(thread: ContactMessageThread): Message | undefined {
  let latest: Message | undefined;
  let latestTime = -Infinity;
  for (const message of thread.messages) {
    const raw = message.sent_at || message.received_at;
    if (!raw) continue;
    const time = new Date(raw).getTime();
    if (!Number.isNaN(time) && time > latestTime) {
      latestTime = time;
      latest = message;
    }
  }
  return latest ?? thread.messages[thread.messages.length - 1];
}

/**
 * One-line body snippet for a text thread row (BACKLOG-1944): the newest
 * message's body_text, same guard/flatten treatment as getEmailSnippet.
 */
function getThreadSnippet(thread: ContactMessageThread): string | undefined {
  const message = newestMessage(thread);
  if (!message) return undefined;
  const raw = message.body_text || message.body_plain;
  if (!raw) return undefined;
  const flattened = raw.replace(/\s+/g, " ").trim();
  return flattened || undefined;
}

/** Small chat-bubble icon for text rows (BACKLOG-1944). Also used inside CommIcon for SMS. */
function TextIcon({ className }: { className: string }): React.ReactElement {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
      />
    </svg>
  );
}

/**
 * "Show all N" / "Show less" toggle button, shared by all three sections
 * (BACKLOG-1944). Renders nothing when there's nothing to hide.
 */
function ShowAllToggle({
  total,
  expanded,
  onToggle,
  testId,
}: {
  total: number;
  expanded: boolean;
  onToggle: () => void;
  testId: string;
}): React.ReactElement | null {
  if (total <= DEFAULT_VISIBLE_ROWS) return null;
  return (
    <button
      type="button"
      onClick={onToggle}
      className="text-xs font-medium text-purple-600 hover:text-purple-800 transition-colors whitespace-nowrap"
      data-testid={testId}
    >
      {expanded ? "Show less" : "See all"}
    </button>
  );
}

export interface ContactPreviewProps {
  /** Contact to display - uses ExtendedContact for all contacts */
  contact: ExtendedContact;
  /** Whether this is an external contact (not yet imported) */
  isExternal: boolean;
  /** Transactions this contact is involved in (imported only) */
  transactions?: ContactTransaction[];
  /** Loading state for transactions */
  isLoadingTransactions?: boolean;
  /**
   * Emails involving this contact, aggregated across all transactions
   * (BACKLOG-1934, imported only). OPTIONAL and gated: when omitted the Emails
   * section is not rendered at all, so the other ContactPreview consumers
   * (ContactSelectModal, ContactAssignmentStep, TransactionDetailsTab,
   * EditContactsModal) are unaffected. Only the Contacts card passes this.
   */
  emails?: Communication[];
  /** Loading state for the emails section (BACKLOG-1934). */
  isLoadingEmails?: boolean;
  /**
   * Fired when an email row is clicked (BACKLOG-1934). Receives the hydrated
   * email so the caller can mount EmailViewModal in place. When omitted, email
   * rows render as static (non-interactive) content — mirrors onTransactionClick.
   */
  onEmailClick?: (email: Communication) => void;
  /**
   * Text-message threads involving this contact, aggregated across all
   * transactions (BACKLOG-1935, imported only). OPTIONAL and gated exactly like
   * `emails`: when omitted the Texts section is not rendered at all, so the other
   * ContactPreview consumers (ContactSelectModal, ContactAssignmentStep,
   * TransactionDetailsTab, EditContactsModal) are unaffected. Only the Contacts
   * card passes this. Each thread carries the required `phoneNumber` and its own
   * `messages` (passed straight to ConversationViewModal — no client-side
   * grouping).
   */
  messages?: ContactMessageThread[];
  /** Loading state for the texts section (BACKLOG-1935). */
  isLoadingMessages?: boolean;
  /**
   * Fired when a text-thread row is clicked (BACKLOG-1935). Receives the whole
   * thread group so the caller can mount ConversationViewModal in place. When
   * omitted, thread rows render as static (non-interactive) content.
   */
  onMessageClick?: (thread: ContactMessageThread) => void;
  /**
   * BACKLOG-2410 — where this contact came from, and how each link was made.
   *
   * OPT-IN with the same gating as `emails` and `messages`: omitted by every
   * other ContactPreview consumer, so their output is unchanged. An EMPTY array
   * (or one holding nothing but the contact's own `origin` row) renders NOTHING.
   *
   * BACKLOG-2471 — ONE linked source is now enough to show the panel. The panel
   * used to require two, so unlinking down to a single source made it vanish,
   * taking with it the only place the remaining link is visible or undoable. The
   * founder hit that himself. A contact with one linked source still has a link
   * that can be wrong, so it still has something to disclose.
   */
  sources?: ContactSourceProvenance[];
  /**
   * Detach one source. When omitted the section is read-only — which the
   * founder was explicit is the wrong end state ("showing the merge without
   * letting someone undo it just tells them about a problem they can't fix"),
   * so the Contacts card always supplies it.
   */
  onUnlinkSource?: (link: ContactSourceProvenance) => void;
  /** The link currently being detached, for the in-flight row state. */
  unlinkingLinkId?: string | null;
  /**
   * BACKLOG-2427: what the last unlink DIDN'T do, and why.
   *
   * Set when the addresses a removed source contributed were deliberately kept
   * — today only because the contact is on an exported audit. Shown here rather
   * than swallowed, because an outcome that differs from what the paragraph
   * above promises has to be said out loud or it reads as the bug it is
   * replacing.
   */
  unlinkNotice?: string | null;
  /** Callback to edit the contact (imported only) */
  onEdit?: () => void;
  /**
   * Open the manual-link search — "these two ARE the same person"
   * (BACKLOG-2426).
   *
   * Sits beside `Edit Contact`, per the founder: *"next to the edit there
   * should be link, so the user can search for other contacts to link it
   * with"*. Optional, so the four other surfaces that render this card are
   * unaffected until they choose to pass it.
   *
   * NEVER offered on an external record: an unimported address-book row has
   * nothing to link TO, and its action is `Import`.
   */
  onLinkSource?: () => void;
  /** Callback to remove the contact */
  onRemove?: () => void;
  /** Callback to import the contact (external only) */
  onImport?: () => void;
  /**
   * An import of THIS contact is in flight (BACKLOG-2525).
   *
   * Founder, 2026-08-05: *"the import button seems like it's not working — you
   * can click it a few times and nothing happens... i see rosey 3 times"*. A
   * record with many emails and phones takes seconds to write, and until now
   * the card was identical throughout, so a second and third press were the
   * only sensible reading of a button that appeared dead.
   *
   * Deliberately a prop and not local state: the owner is the one that knows
   * whether the IPC call has resolved, and a second source of truth here would
   * drift from it. Defaults to `false`, so the transaction-flow consumers that
   * never pass it render exactly as before.
   */
  isImporting?: boolean;
  /** Callback to close the preview */
  onClose: () => void;
  /**
   * Callback fired when a transaction row is clicked. Receives the transaction
   * id so the caller can open that transaction (BACKLOG-1898 T5). When omitted,
   * transaction rows render as static (non-interactive) content.
   */
  onTransactionClick?: (transactionId: string) => void;
  /**
   * Render mode (BACKLOG-1898 T5):
   * - "modal" (default): renders inside a ResponsiveModal shell with backdrop —
   *   the original behaviour; existing modal callers are unaffected.
   * - "pane": renders the same body inline (no ResponsiveModal shell / backdrop)
   *   for the wide-viewport master-detail two-pane layout.
   */
  variant?: "modal" | "pane";
}

/**
 * Gets the display name for a contact
 */
function getDisplayName(contact: ExtendedContact): string {
  // BACKLOG-2461: see src/utils/contactDisplayLabel.ts.
  return labelForContact(contact);
}

/**
 * Gets the first initial from a name for avatar display
 */
function getInitial(name: string): string {
  return name.charAt(0).toUpperCase();
}

/**
 * "Added <date>" label for the card-head meta-line (BACKLOG-1944, matches the
 * approved mockup). Only shown for IMPORTED contacts — `created_at` is a
 * required field on the model, but for external (message-derived / not-yet-
 * imported) contacts it isn't a meaningful "added to Keepr" date, so the
 * caller gates this on `!isExternal` too. Returns undefined (omit the whole
 * meta segment) when the date is missing/invalid — never renders "Invalid Date".
 */
function formatAddedDate(createdAt: string | undefined): string | undefined {
  if (!createdAt) return undefined;
  const parsed = new Date(createdAt);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return `Added ${parsed.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}`;
}

/** Small chevron-right icon, app's established affordance for a clickable row (TransactionMobileCard, ConversationCard, etc.) — BACKLOG-1944. */
function ChevronIcon({ className }: { className: string }): React.ReactElement {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
    </svg>
  );
}

/**
 * Small rounded-square colored icon for a comm row (BACKLOG-1944, matches the
 * artifact's `.comm-icon` / `.ic-in` / `.ic-out` / `.ic-sms`). Email inbound =
 * violet, email outbound = gray, SMS = teal — independent of DirectionIcon's
 * glyph (this is a flat color block, not an in/out arrow).
 */
/**
 * "email-in" = a real inbound email (direction === "inbound"), "email-out" =
 * outbound, "email-neutral" = direction wasn't classified (undefined) — SR
 * polish (BACKLOG-1944): an undirected message shows no SENT/RECEIVED tag, so
 * it shouldn't be colored violet as if it were confidently inbound either.
 * Reserve violet for a REAL "inbound".
 */
function CommIcon({
  kind,
  className,
}: {
  kind: "email-in" | "email-out" | "email-neutral" | "sms";
  className: string;
}): React.ReactElement {
  const bg =
    kind === "email-in"
      ? "bg-violet-600"
      : kind === "email-out" || kind === "email-neutral"
        ? "bg-gray-400"
        : "bg-teal-600";
  return (
    <div className={`${bg} ${className} rounded-lg flex items-center justify-center flex-shrink-0 text-white`}>
      {kind === "sms" ? (
        <TextIcon className="w-4 h-4" />
      ) : (
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
          />
        </svg>
      )}
    </div>
  );
}

/**
 * Section header (BACKLOG-1944, matches the artifact's `.section-head`):
 * title + a count-badge pill showing the TOTAL (never the truncated visible
 * count). The mockup's "clickable"/"Phase 2" chips are mockup-only annotations
 * and are intentionally NOT reproduced here.
 */
function SectionHead({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  /**
   * Right-aligned slot (BACKLOG-1944 refinement) — sits where the artifact's
   * PHASE 2 / CLICKABLE chip sits, pushed right via ml-auto. Used for the
   * "See all"/"Show less" link; omitted (nothing rendered) when there's
   * nothing to show more of.
   */
  children?: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="flex items-center gap-2 mb-3">
      <h3 className="text-sm font-semibold text-gray-700">{title}</h3>
      <span
        className="text-xs font-semibold text-gray-600 bg-gray-100 rounded-full px-2 py-0.5"
        style={{ fontVariantNumeric: "tabular-nums" }}
      >
        {count}
      </span>
      {children && <span className="ml-auto">{children}</span>}
    </div>
  );
}

/**
 * ContactPreview Component
 *
 * Displays a modal preview of contact details when a ContactCard is clicked.
 * Shows full contact information including:
 * - Large avatar with initial
 * - Name, emails, phones, company, title
 * - Source pill (Imported/External)
 * - Transaction list for imported contacts
 * - "Not yet imported" message for external contacts
 * - Contextual action button (Edit for imported, Import for external)
 *
 * @example
 * // Imported contact with transactions
 * <ContactPreview
 *   contact={importedContact}
 *   isExternal={false}
 *   transactions={transactions}
 *   onEdit={() => handleEdit()}
 *   onClose={() => setPreviewContact(null)}
 * />
 *
 * @example
 * // External contact
 * <ContactPreview
 *   contact={externalContact}
 *   isExternal={true}
 *   onImport={() => handleImport()}
 *   onClose={() => setPreviewContact(null)}
 * />
 */
export function ContactPreview({
  contact,
  isExternal,
  transactions = [],
  isLoadingTransactions = false,
  // Renamed to avoid colliding with the local `emails` (the contact's own
  // email addresses shown in the header). `contactEmails` = the contact's
  // messages loaded via useContactComms (BACKLOG-1934).
  emails: contactEmails,
  isLoadingEmails = false,
  onEmailClick,
  // Renamed for symmetry with `contactEmails` — `contactMessages` = the
  // contact's text threads loaded via useContactComms (BACKLOG-1935).
  messages: contactMessages,
  isLoadingMessages = false,
  onMessageClick,
  sources,
  onUnlinkSource,
  unlinkingLinkId = null,
  unlinkNotice = null,
  onEdit,
  onLinkSource,
  onRemove,
  onImport,
  isImporting = false,
  onClose,
  onTransactionClick,
  variant = "modal",
}: ContactPreviewProps): React.ReactElement {
  const displayName = getDisplayName(contact);
  const initial = getInitial(displayName);
  /**
   * BACKLOG-2493 — one pill per LIVE crosswalk source, not one per contact.
   *
   * This line used to call the singular `mapToSourcePillSource(contact.source,
   * …)`. `contacts.source` is the scalar written once at INSERT that no unlink
   * revises, so the card asserted an origin it could not support: the founder's
   * Paul Dorian read "Outlook" while every address and number on the card had
   * come from the Mac address book, because Outlook merely imported him first
   * and the label never moved when the Outlook link was removed. The list filter
   * had already been moved onto the live links (BACKLOG-2472) — so the filter
   * and the card disagreed, and the card was the one that was wrong.
   *
   * `mapToSourcePillSources` is the SAME call `ContactRoleRow.tsx` and
   * `ContactCard.tsx` already make. The live set REPLACES the scalar; the two
   * are never unioned, or the removed source would be displayed forever, which
   * is the defect (see SourcePill.tsx). A contact with no links — manual, or
   * created before the crosswalk existed — keeps its scalar-derived pill,
   * because `source_types` is left `undefined` for those and the mapper falls
   * back. Nothing disappears.
   */
  const sourcePillSources = mapToSourcePillSources(
    contact.source,
    contact.source_types,
    isExternal,
  );
  const addedLabel = formatAddedDate(contact.created_at);

  // Collect emails and phones
  const emails =
    contact.allEmails && contact.allEmails.length > 0
      ? contact.allEmails
      : contact.email
        ? [contact.email]
        : [];

  const phones =
    contact.allPhones && contact.allPhones.length > 0
      ? contact.allPhones
      : contact.phone
        ? [contact.phone]
        : [];

  // BACKLOG-1934: the Emails section is entirely opt-in. It renders ONLY when a
  // caller supplies the `emails` prop (or is actively loading them). All other
  // ContactPreview consumers omit these props, so the section is absent for them
  // — no empty section, no layout change, byte-for-byte identical output.
  // Once opted in, the section shows even for an empty result (the "No emails"
  // empty state) — the empty array is a valid "opted-in, none found" outcome and
  // is distinct from "not opted in" (prop undefined → section hidden).
  const emailsProvided = contactEmails !== undefined || isLoadingEmails;
  const emailList = contactEmails ?? [];
  const showEmailsSection = !isExternal && emailsProvided;

  // BACKLOG-1935: the Texts section is opt-in with the SAME gating as Emails —
  // it renders ONLY when a caller supplies `messages` (or is loading them). Every
  // other ContactPreview consumer omits these props, so the section is absent
  // for them (no empty section, no layout change). Once opted in, an empty array
  // is the valid "opted-in, none found" outcome and shows the "No texts" empty
  // state, distinct from "not opted in" (prop undefined → section hidden).
  const messagesProvided = contactMessages !== undefined || isLoadingMessages;
  const threadList = contactMessages ?? [];
  const showTextsSection = !isExternal && messagesProvided;

  // BACKLOG-2471 — THIS THRESHOLD WAS DELIBERATELY REVERSED. It required TWO
  // linked sources (BACKLOG-2410's "no clutter on the common case" rule); it now
  // requires one.
  //
  // The reason is not cosmetic. The Unlink control lives INSIDE this panel, so
  // at a threshold of two, unlinking a two-source contact down to one made the
  // panel disappear — removing the only place the surviving link is visible and
  // the only way to undo it. The founder hit that himself. A contact with one
  // linked source still has a link that can be wrong, so it still has something
  // to disclose, and the panel is where he goes to see and undo it.
  //
  // The original noise concern is answered by the `origin` filter below, not by
  // the threshold: a contact the user typed in, or one imported from a single
  // address book with no crosswalk row, still shows nothing.
  //
  // There is deliberately NO loading prop either: a spinner that resolves to
  // nothing on most contacts is noise, one frame later. The section simply
  // appears once the sources arrive.
  //
  // BACKLOG-2473 — DEFENCE IN DEPTH, and it carries MORE weight at a threshold
  // of one. `getContactProvenance` already excludes `origin` rows, because an
  // origin row ("you typed this contact in") can never be a wrong merge and can
  // never be detached — the founder's words: "we can't unlink a contact from
  // itself so we should hide the button". EVERY created contact now carries an
  // origin row, so one leaking through the IPC boundary used to need a second
  // row to open the panel; at `> 0` it would open the panel on its own, on
  // ordinary contacts, with an Unlink button that always fails. The filter is
  // what stops that, and ContactPreview.sources.test.tsx pins both halves.
  const sourceList = (sources ?? []).filter((s) => s.matchMethod !== "origin");

  // BACKLOG-2510 — "IS THERE ANYTHING TO ACT ON", NOT "IS THE LIST NON-EMPTY",
  // and this PR is what makes the difference matter.
  //
  // Routing the Clients & Contacts import through `contacts:import` means every
  // imported contact finally gets a crosswalk row for the card it came from —
  // `match_method: 'source_id'`. That row is NOT an `origin` row, so it passes
  // the filter above, and at a bare `length > 0` this panel would have opened on
  // every freshly imported contact with `Unlink` on the single record it came
  // from. The founder rejected exactly that: *"why would we have unlink on a
  // singular contact. we have a remove contact button already"*. The fix created
  // the case; this gate is what keeps it out.
  //
  // He had already been told where the contact came from — *"but after i
  // imported tad it still had the 'Contacts App'"* is the card's source label
  // doing its job. A panel repeating it adds a button, not an answer.
  //
  // Multi-source contacts are UNCHANGED. A single import can write two
  // `source_id` rows when the picker collapsed two address books into one row
  // (BACKLOG-2458), and unlinking one of those is the wrong-merge undo this
  // panel exists for. See utils/contactSourceAffordances for the full rule and
  // for the one case left open.
  const showSourcesSection = !isExternal && showSourcesPanel(sourceList);

  // BACKLOG-1944: per-section "Show all N" / "Show less" expand state. Plain
  // useState is safe here — StrictMode is ON app-wide, but this is local UI
  // state (not a didMount-guard antipattern); double-invoke in dev just
  // re-runs the same initializer, no duplicate side effects.
  const [transactionsExpanded, setTransactionsExpanded] = useState(false);
  const [emailsExpanded, setEmailsExpanded] = useState(false);
  const [textsExpanded, setTextsExpanded] = useState(false);

  const visibleTransactions = transactionsExpanded
    ? transactions
    : transactions.slice(0, DEFAULT_VISIBLE_ROWS);
  const visibleEmails = emailsExpanded
    ? emailList
    : emailList.slice(0, DEFAULT_VISIBLE_ROWS);
  const visibleThreads = textsExpanded
    ? threadList
    : threadList.slice(0, DEFAULT_VISIBLE_ROWS);

  const body = (
    <div
      data-testid="contact-preview-modal"
      className={
        variant === "pane"
          ? "flex flex-col h-full min-h-0 bg-white overflow-y-auto"
          : "flex flex-col max-h-[80vh] overflow-y-auto"
      }
    >
        {/*
          Header with close button.

          BACKLOG-2579 — the X is rendered ONLY in the "modal" variant.

          In the "pane" variant this card is the Clients & Contacts detail, and
          `Contacts.tsx` is the only caller that passes `variant="pane"`. There
          the X was a SECOND dismissal affordance beside the screen's own Back
          button, which is what the founder asked us to drop — at every viewport
          width, not just the narrow layout. FOUNDER DECISION (2026-08-06,
          recorded on BACKLOG-2579): remove it everywhere, knowingly accepting
          that the wide (>=1200px) two-pane layout has no Back button and so
          loses its explicit close; the pane is persistent there by design and
          the user moves on by selecting another contact.

          The X STAYS in the modal variant. The four modal consumers
          (ContactSelectModal, ContactAssignmentStep, EditContactsModal,
          TransactionDetailsTab) have no Back button, and below the `sm`
          breakpoint ResponsiveModal is full-screen with no backdrop to click —
          so there the X is the only way out. Removing it globally would trap
          those users. Both directions are controlled: C6 and C7.
        */}
        {variant !== "pane" && (
        <div className="flex justify-end p-3 sm:p-4">
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 transition-colors p-1"
            aria-label="Close preview"
            data-testid="contact-preview-close"
          >
            <svg
              className="w-6 h-6"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>
        )}

        {/* Card Head (BACKLOG-1944, matches the artifact's .card-head): left-aligned
            avatar + name/pills column, replacing the prior centered layout. The
            contextual primary action (Import / Edit) sits top-right, across
            from the name — moved out of the footer per Daniel's refinement.
            Remove stays a secondary action in the footer.

            BACKLOG-2579 follow-up (founder QA of PR #2249): this container has
            never carried top padding, and never needed any — the close-X row
            above it (`p-3 sm:p-4`) supplied the gap. Hiding the X in the pane
            variant took that gap with it and left the avatar flush against the
            top of the card on the wide (>=1200px) two-pane layout, which has
            nothing above it at all.

            So the padding is added for the PANE VARIANT ONLY, gated exactly the
            way the X is hidden. The modal variant still renders the X row and
            an unconditional value would double-pad it.

            `pt-6` rather than the X row's `p-3 sm:p-4`: it makes the top inset
            equal to this container's own `px-6`, so the card head sits on a
            consistent 24px inset instead of inheriting a leftover measurement
            from a row that no longer exists. */}
        <div
          className={`px-6 pb-4${variant === "pane" ? " pt-6" : ""}`}
          data-testid="contact-preview-head"
        >
          <div className="flex gap-3.5 items-center justify-between">
            <div className="flex gap-3.5 items-center min-w-0">
              <div
                className="bg-gradient-to-br from-purple-500 to-pink-600 rounded-full flex items-center justify-center text-white font-bold text-xl flex-shrink-0"
                style={{ width: 52, height: 52 }}
                data-testid="contact-preview-avatar"
              >
                {initial}
              </div>
              <div className="min-w-0">
                <h2
                  className="text-lg font-bold text-gray-900 truncate"
                  data-testid="contact-preview-name"
                >
                  {displayName}
                </h2>
                <div className="flex items-center gap-2 flex-wrap mt-1 text-xs text-gray-500">
                  {/* BACKLOG-2493: one pill per live source — two sources show
                      two pills, and unlinking one drops its pill on the next
                      list load. */}
                  {sourcePillSources.map((pillSource) => (
                    <SourcePill key={pillSource} source={pillSource} size="sm" />
                  ))}
                  <ImportStatusPill isImported={!isExternal} size="sm" />
                  {!isExternal && addedLabel && <span>· {addedLabel}</span>}
                </div>
              </div>
            </div>
            {/* SR polish (BACKLOG-1944): guard each button on its OWN handler,
                not just isExternal — ContactSelectModal and EditContactsModal
                compute isExternal but never pass onImport, so an unguarded
                render put a dead no-op Import button in their header. Now
                neither button renders unless its handler is actually wired. */}
            {isExternal
              ? onImport && (
                  /* BACKLOG-2525: `disabled` is the load-bearing attribute, not
                     the label — a disabled button fires no `onClick` at all, so
                     the founder's second and third presses reach nothing. The
                     wording changes too because "Import", greyed, reads as "not
                     allowed"; "Importing…" reads as "working". */
                  <button
                    onClick={onImport}
                    disabled={isImporting}
                    aria-busy={isImporting}
                    className={`flex-shrink-0 px-3.5 py-1.5 text-white text-sm font-semibold rounded-lg transition-all shadow-md ${
                      isImporting
                        ? "bg-gradient-to-r from-purple-400 to-pink-500 opacity-70 cursor-wait"
                        : "bg-gradient-to-r from-purple-500 to-pink-600 hover:from-purple-600 hover:to-pink-700"
                    }`}
                    data-testid="contact-preview-import"
                  >
                    {isImporting ? "Importing…" : "Import"}
                  </button>
                )
              : (onEdit || onLinkSource) && (
                  <>
                    {/*
                      BACKLOG-2426 — `Link` beside `Edit`, on SAVED contacts only.
                      The `isExternal` arm above renders `Import` instead: an
                      unimported address-book row has nothing to link TO.
                    */}
                    {onLinkSource && (
                      <button
                        onClick={onLinkSource}
                        className="flex-shrink-0 px-3.5 py-1.5 border border-purple-300 text-purple-700 text-sm font-semibold rounded-lg hover:bg-purple-50 transition-all"
                        data-testid="contact-preview-link"
                      >
                        Link
                      </button>
                    )}
                    {onEdit && (
                      <button
                        onClick={onEdit}
                        className="flex-shrink-0 px-3.5 py-1.5 bg-gradient-to-r from-purple-500 to-pink-600 text-white text-sm font-semibold rounded-lg hover:from-purple-600 hover:to-pink-700 transition-all shadow-md"
                        data-testid="contact-preview-edit"
                      >
                        Edit Contact
                      </button>
                    )}
                  </>
                )}
          </div>
        </div>

        {/* Field Grid (BACKLOG-1944, matches the artifact's .field-grid):
            two-column grid of uppercase/mono-ish labels with values below. */}
        <div className="px-6 pb-6 grid grid-cols-2 gap-x-4 gap-y-2.5">
          {emails.length > 0 && (
            <div>
              <div className="text-[10.5px] font-mono uppercase tracking-wider text-gray-400">
                Emails
              </div>
              <div className="text-sm text-gray-900 mt-0.5" data-testid="contact-preview-emails">
                {emails.map((email, idx) => (
                  <div key={`${email}-${idx}`} className="truncate">
                    {email}
                  </div>
                ))}
              </div>
            </div>
          )}
          {phones.length > 0 && (
            <div>
              <div className="text-[10.5px] font-mono uppercase tracking-wider text-gray-400">
                Phone
              </div>
              <div className="text-sm text-gray-900 mt-0.5" data-testid="contact-preview-phones">
                {phones.map((phone, idx) => (
                  <div key={`${phone}-${idx}`} className="truncate">
                    {phone}
                  </div>
                ))}
              </div>
            </div>
          )}
          {contact.company && (
            <div>
              <div className="text-[10.5px] font-mono uppercase tracking-wider text-gray-400">
                Company
              </div>
              <div className="text-sm text-gray-900 mt-0.5" data-testid="contact-preview-company">
                {contact.company}
              </div>
            </div>
          )}
          {contact.title && (
            <div>
              <div className="text-[10.5px] font-mono uppercase tracking-wider text-gray-400">
                Title
              </div>
              <div className="text-sm text-gray-900 mt-0.5" data-testid="contact-preview-title">
                {contact.title}
              </div>
            </div>
          )}
        </div>

        {/* Sources / provenance (BACKLOG-2410).
            Sits above Transactions deliberately: this is identity — WHO this
            record is — and it has to be readable before anything attributed to
            them. Rendered for any contact with at least one linked source
            (BACKLOG-2471); never for a contact that only has its own row. */}
        {showSourcesSection && (
          <div
            className="border-t border-gray-200 px-6 py-4"
            data-testid="contact-sources-section"
          >
            <SectionHead title="Sources" count={sourceList.length} />
            {/* BACKLOG-2427: this line used to stop after "the other sources
                stay". True about sources, and silent about the emails and
                phones that source had already contributed — which also stayed,
                on a contact who may be a party to a transaction. The second
                sentence is the promise the code now actually keeps. */}
            {/* BACKLOG-2471: at a threshold of one, the old single sentence
                ("put together from more than one place", "the other sources
                stay") is simply FALSE — there is one source and there are no
                others. Copy that contradicts what is on screen is how a user
                stops believing the panel, so the one-source case gets its own
                wording rather than a plural fudge. */}
            <p
              className="text-xs text-gray-500 -mt-1.5 mb-3"
              data-testid="contact-sources-explainer"
            >
              {sourceList.length === 1 ? (
                <>
                  This contact is linked to one record from somewhere else. If it is a
                  different person, unlink it — this contact stays. Its email addresses
                  and phone numbers go with it, unless you added them yourself.
                </>
              ) : (
                <>
                  This contact was put together from more than one place. If any of these
                  is a different person, unlink it — the contact and the other sources
                  stay. Their email addresses and phone numbers go with them, unless
                  another source has them too or you added them yourself.
                </>
              )}
            </p>
            {unlinkNotice && (
              <p
                className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2 mb-3"
                data-testid="contact-unlink-notice"
              >
                {unlinkNotice}
              </p>
            )}
            <div className="space-y-2">
              {sourceList.map((link) => (
                <div
                  key={link.linkId}
                  className="flex items-start gap-3 rounded-lg border border-gray-200 px-3 py-2"
                  data-testid={`contact-source-row-${link.linkId}`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-gray-900">
                      {link.sourceLabel}
                      {link.sourceName && (
                        <span className="font-normal text-gray-500"> — {link.sourceName}</span>
                      )}
                    </div>
                    {/* Words, never a score. This line is what lets a user judge
                        whether the link is plausible. */}
                    <div className="text-xs text-gray-500 mt-0.5">{link.matchDescription}</div>
                    {!link.sourceRecordPresent && (
                      <div className="text-xs text-amber-700 mt-0.5">
                        This entry is no longer in that account.
                      </div>
                    )}
                  </div>
                  {/* BACKLOG-2510 — no button on the SINGLE record a contact was
                      created from. Detaching it would assert the contact did not
                      come from where it came from, and would leave it with no
                      source at all — which is `Remove`, a control the card
                      already has. Founder: "why would we have unlink on a
                      singular contact. we have a remove contact button already".
                      Every other row keeps its button, including both halves of
                      a two-address-book collapse. */}
                  {onUnlinkSource && canUnlinkSource(sourceList, link) && (
                    <button
                      type="button"
                      onClick={() => onUnlinkSource(link)}
                      disabled={unlinkingLinkId === link.linkId}
                      className="flex-shrink-0 px-2.5 py-1 text-xs font-semibold text-orange-700 hover:bg-orange-50 rounded-md transition-colors disabled:opacity-50"
                      data-testid={`contact-source-unlink-${link.linkId}`}
                    >
                      {/* BACKLOG-2471: the founder chose this word himself,
                          replacing the shipped "Not this person". The prop stays
                          `onUnlinkSource` — it always was — so this is a label
                          change, not a rename. The in-flight state follows the
                          same verb: "Removing…" belonged to the old wording and
                          reads like the contact is being deleted. */}
                      {unlinkingLinkId === link.linkId ? "Unlinking…" : "Unlink"}
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Transactions Section (imported contacts only) */}
        {!isExternal && (isLoadingTransactions || transactions.length > 0) && (
        <div className="border-t border-gray-200 px-6 py-4">
          {isLoadingTransactions ? (
            <div
              className="text-center py-4"
              data-testid="contact-preview-loading"
            >
              <div className="w-6 h-6 border-2 border-purple-600 border-t-transparent rounded-full animate-spin mx-auto" />
            </div>
          ) : (
            <>
              <SectionHead title="Transactions" count={transactions.length}>
                <ShowAllToggle
                  total={transactions.length}
                  expanded={transactionsExpanded}
                  onToggle={() => setTransactionsExpanded((prev) => !prev)}
                  testId="contact-preview-transactions-show-all"
                />
              </SectionHead>
              <div
                className="space-y-2"
                data-testid="contact-preview-transactions"
              >
                {visibleTransactions.map((txn) => (
                  <button
                    key={txn.id}
                    type="button"
                    onClick={
                      onTransactionClick
                        ? () => onTransactionClick(txn.id)
                        : undefined
                    }
                    disabled={!onTransactionClick}
                    className="relative w-full flex items-center justify-between gap-2 text-sm text-left border border-gray-200 rounded-lg pl-3 pr-8 py-2.5 transition-colors enabled:hover:bg-purple-50 enabled:cursor-pointer disabled:cursor-default"
                    data-testid={`contact-preview-transaction-${txn.id}`}
                  >
                    <span className="min-w-0">
                      <span className="block font-medium text-gray-900 truncate">
                        {txn.property_address}
                      </span>
                      <span className="block text-xs text-gray-500 truncate">
                        {formatRoleLabel(txn.role)}
                      </span>
                    </span>
                    {onTransactionClick && (
                      <ChevronIcon className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                    )}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
        )}

        {/* Emails Section (BACKLOG-1934, imported contacts only, opt-in) */}
        {showEmailsSection && (
        <div className="border-t border-gray-200 px-6 py-4">
          {isLoadingEmails ? (
            <div
              className="text-center py-4"
              data-testid="contact-preview-emails-loading"
            >
              <div className="w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto" />
            </div>
          ) : emailList.length === 0 ? (
            <>
              <SectionHead title="Emails" count={0} />
              <p
                className="text-sm text-gray-500"
                data-testid="contact-preview-emails-empty"
              >
                No emails
              </p>
            </>
          ) : (
            <>
              <SectionHead title="Emails" count={emailList.length}>
                <ShowAllToggle
                  total={emailList.length}
                  expanded={emailsExpanded}
                  onToggle={() => setEmailsExpanded((prev) => !prev)}
                  testId="contact-preview-emails-show-all"
                />
              </SectionHead>
              <div className="space-y-2" data-testid="contact-preview-email-list">
                {visibleEmails.map((email) => {
                  const snippet = getEmailSnippet(email);
                  const directionTag = getDirectionTag(email.direction);
                  return (
                    <button
                      key={email.id}
                      type="button"
                      onClick={
                        onEmailClick ? () => onEmailClick(email) : undefined
                      }
                      disabled={!onEmailClick}
                      className="relative w-full flex items-start gap-2.5 text-sm text-left rounded-lg pl-1 pr-8 py-2 transition-colors enabled:hover:bg-gray-50 enabled:cursor-pointer disabled:cursor-default"
                      data-testid={`contact-preview-email-${email.id}`}
                    >
                      <CommIcon
                        kind={
                          email.direction === "outbound"
                            ? "email-out"
                            : email.direction === "inbound"
                              ? "email-in"
                              : "email-neutral"
                        }
                        className="w-[30px] h-[30px] mt-0.5"
                      />
                      <span className="flex flex-col min-w-0 flex-1">
                        <span className="flex items-baseline justify-between gap-2">
                          <span className="font-medium text-gray-900 truncate">
                            {getEmailPrimaryLine(email)}
                          </span>
                          <span
                            className="text-gray-400 text-xs flex-shrink-0"
                            style={{ fontVariantNumeric: "tabular-nums" }}
                          >
                            {formatEmailDate(email)}
                          </span>
                        </span>
                        <span className="text-gray-500 text-xs truncate mt-0.5">
                          {directionTag && (
                            <span className="font-mono uppercase tracking-wide text-gray-400">
                              {directionTag}
                            </span>
                          )}
                          {directionTag && snippet && " · "}
                          {snippet}
                        </span>
                      </span>
                      {onEmailClick && (
                        <ChevronIcon className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                      )}
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>
        )}

        {/* Texts Section (BACKLOG-1935, imported contacts only, opt-in) */}
        {showTextsSection && (
        <div className="border-t border-gray-200 px-6 py-4">
          {isLoadingMessages ? (
            <div
              className="text-center py-4"
              data-testid="contact-preview-texts-loading"
            >
              <div className="w-6 h-6 border-2 border-green-600 border-t-transparent rounded-full animate-spin mx-auto" />
            </div>
          ) : threadList.length === 0 ? (
            <>
              <SectionHead title="Texts" count={0} />
              <p
                className="text-sm text-gray-500"
                data-testid="contact-preview-texts-empty"
              >
                No texts
              </p>
            </>
          ) : (
            <>
              <SectionHead title="Texts" count={threadList.length}>
                <ShowAllToggle
                  total={threadList.length}
                  expanded={textsExpanded}
                  onToggle={() => setTextsExpanded((prev) => !prev)}
                  testId="contact-preview-texts-show-all"
                />
              </SectionHead>
              <div className="space-y-2" data-testid="contact-preview-text-list">
                {visibleThreads.map((thread) => {
                  const latest = newestMessage(thread);
                  const snippet = getThreadSnippet(thread);
                  const directionTag = getDirectionTag(latest?.direction);
                  const countLabel = formatThreadCount(thread);
                  return (
                    <button
                      key={thread.thread_id}
                      type="button"
                      onClick={
                        onMessageClick ? () => onMessageClick(thread) : undefined
                      }
                      disabled={!onMessageClick}
                      className="relative w-full flex items-start gap-2.5 text-sm text-left rounded-lg pl-1 pr-8 py-2 transition-colors enabled:hover:bg-gray-50 enabled:cursor-pointer disabled:cursor-default"
                      data-testid={`contact-preview-text-${thread.thread_id}`}
                    >
                      <CommIcon kind="sms" className="w-[30px] h-[30px] mt-0.5" />
                      <span className="flex flex-col min-w-0 flex-1">
                        <span className="flex items-baseline justify-between gap-2">
                          <span className="font-medium text-gray-900 truncate">
                            {getThreadPrimaryLine(thread)}
                          </span>
                          <span
                            className="text-gray-400 text-xs flex-shrink-0"
                            style={{ fontVariantNumeric: "tabular-nums" }}
                          >
                            {formatThreadDate(thread)}
                          </span>
                        </span>
                        <span className="text-gray-500 text-xs truncate mt-0.5">
                          {directionTag && (
                            <span className="font-mono uppercase tracking-wide text-gray-400">
                              {directionTag}
                            </span>
                          )}
                          {directionTag && snippet && " · "}
                          {snippet}
                        </span>
                        {/* Message count kept as a subtle subline (BACKLOG-1944: "keep somewhere subtle"). */}
                        <span className="text-gray-400 text-[11px] mt-0.5">
                          {countLabel}
                        </span>
                      </span>
                      {onMessageClick && (
                        <ChevronIcon className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                      )}
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>
        )}

        {/* Footer (BACKLOG-1944): the primary action (Import/Edit) moved to the
            card-head top-right. Remove stays here as a secondary action for
            imported contacts. External contacts have nothing left to show
            here (Import is header-only, and onRemove is never passed for
            external contacts — see Contacts.tsx), so the whole footer is
            omitted rather than rendering an empty bar. */}
        {!isExternal && onRemove && (
          <div className="border-t border-gray-200 p-4 pb-safe flex justify-end gap-3">
            <button
              onClick={onRemove}
              className="px-4 py-2 bg-red-50 hover:bg-red-100 text-red-600 rounded-lg font-medium transition-all"
              data-testid="contact-preview-remove"
            >
              Remove
            </button>
          </div>
        )}
      </div>
  );

  // "pane" variant (BACKLOG-1898 T5): render the same body inline, WITHOUT the
  // ResponsiveModal shell/backdrop, for the wide-viewport master-detail layout.
  if (variant === "pane") {
    return body;
  }

  // "modal" variant (default): original behaviour — wrapped in ResponsiveModal.
  return (
    <ResponsiveModal
      onClose={onClose}
      overlayClassName="bg-black bg-opacity-50"
      testId="contact-preview-backdrop"
      panelClassName="max-w-md max-h-[80vh] !h-auto !w-[calc(100%-2rem)] rounded-xl shadow-2xl"
    >
      {body}
    </ResponsiveModal>
  );
}

export default ContactPreview;
