import React, { useState, useCallback, useContext, useRef } from "react";
import {
  ContactFormModal,
  RemoveConfirmationModal,
  BlockingTransactionsModal,
  ReviewDuplicatesModal,
  useContactList,
  useContactsLayout,
  useReviewQueueCount,
  useContactSources,
  ExtendedContact,
} from "./contact";
import type { ContactSourceProvenance } from "@/types/contactProvenance";
import { useAppStateMachine } from "../appCore";
import { ContactSearchList } from "./shared/ContactSearchList";
import {
  ContactPreview,
  type ContactTransaction,
} from "./shared/ContactPreview";
import type { ContactListAnchor } from "../utils/contactListAnchor";
import { useContactComms } from "../hooks/useContactComms";
import { useContactCommViewers } from "../hooks/useContactCommViewers";
import logger from '../utils/logger';
import { OfflineNotice } from './common/OfflineNotice';
import { RemovedContactsSection } from "./contact/components/RemovedContactsSection";
import { LinkSourceSearch } from "./shared/LinkSourceSearch";
import { ContactCompareSources } from "./shared/ContactCompareSources";
import { NotificationContext } from "../contexts/NotificationContext";

interface ContactsProps {
  userId: string;
  onClose: () => void;
  /**
   * Open a transaction by id (BACKLOG-1898 T5). Wired from AppModals so a click
   * on a transaction row in the contact detail card opens that transaction.
   * Optional so standalone/test renders of Contacts don't require it.
   */
  onOpenTransaction?: (transactionId: string) => void;
}

/**
 * Contacts Component
 * Full contact management interface using ContactSearchList for consistent UX
 * - List all contacts (imported + external from Contacts App)
 * - Import external contacts
 * - Add/Edit/Delete contacts
 * - View contact details
 */
function Contacts({ userId, onClose, onOpenTransaction }: ContactsProps) {
  // Database initialization guard (belt-and-suspenders defense)
  const { isDatabaseInitialized } = useAppStateMachine();

  // Responsive master-detail layout state (BACKLOG-1898 T5).
  // Owns selected contact + narrow/wide viewport class; keeps this component
  // compositional (no layout logic inline).
  const {
    isNarrow,
    showDetailPane,
    selectContact,
    clearSelection,
    selectedContactId,
  } = useContactsLayout();

  // Modal states
  const [showAddEdit, setShowAddEdit] = useState(false);
  const [selectedContact, setSelectedContact] = useState<
    ExtendedContact | undefined
  >(undefined);

  /**
   * ==========================================================================
   * BACKLOG-2527 — THE CARD THE USER IS ON, READABLE FROM AN ASYNC CONTINUATION
   * ==========================================================================
   * The founder pressed Import, pressed Back while it was still running, and
   * the app took the screen back from him seconds later. An async completion
   * may update what the user is looking at. It may NOT decide what the user is
   * looking at.
   *
   * To leave him where he went, the import's continuation has to know where he
   * IS when it lands — and `previewContact` cannot tell it. `handlePreviewImport`
   * is re-created every render and closes over the value as it was AT CLICK
   * TIME, so a post-await `if (!previewContact) return` reads a stale non-null
   * value and never fires. That is the guard someone will reach for first, and
   * it does nothing.
   *
   * So the id is mirrored into a ref written SYNCHRONOUSLY, in the same tick as
   * the state update, by `showPreviewContact`. Not a `useEffect` mirror: a
   * passive effect is flushed on a scheduler callback, and the IPC promise
   * resolves on a microtask that can run first. This file already carries the
   * same shape for the same reason — `inFlightImports` is a ref because
   * `setState` is async and a second click would otherwise read a stale flag.
   *
   * THE RAW `useState` SETTER IS RENAMED ON PURPOSE. The ref is only true if it
   * is written at EVERY write site, and a plain `setPreviewContact(...)` added
   * later would look completely ordinary while silently disarming the guard.
   * The rename makes a direct write a conspicuous, deliberate act.
   *
   * MERGE INVARIANT, checkable without a test — which matters, because no suite
   * covers a lane that has not been written yet: grepping this file for the raw
   * setter's name must return EXACTLY TWO lines, the declaration immediately
   * below and the single call inside `showPreviewContact`. A third line is a new
   * raw write, and a new raw write silently disarms BACKLOG-2527 while every
   * suite stays green. The name is spelled nowhere else in this file — not even
   * in this comment — so that the grep stays a signal and not a headcount of
   * documentation. The exact command is in the PR body.
   */
  const [previewContact, setPreviewContactState] = useState<ExtendedContact | null>(
    null
  );
  const previewContactIdRef = useRef<string | null>(null);

  /**
   * Is the manual-link search open for the previewed contact? (BACKLOG-2426)
   *
   * Deliberately NOT keyed by contact id: `showPreviewContact` closes it on
   * every pane change, so a boolean cannot outlive the contact it belongs to.
   * Declared ABOVE that wrapper because the wrapper reads it.
   */
  const [linkSearchOpen, setLinkSearchOpen] = useState(false);

  /**
   * Is the compare screen open for the previewed contact? (BACKLOG-2471 PR C)
   *
   * A boolean rather than an id, and closed in the wrapper below for exactly the
   * reason `linkSearchOpen` is: it belongs to whoever was on screen when it
   * opened, so no route can leave a comparison of one person standing over
   * another. Declared ABOVE the wrapper because the wrapper writes it.
   */
  const [compareOpen, setCompareOpen] = useState(false);

  const showPreviewContact = useCallback((contact: ExtendedContact | null) => {
    previewContactIdRef.current = contact?.id ?? null;
    // BACKLOG-2426: the manual-link panel belongs to the contact that was on
    // screen when it opened. Closing it here — rather than in each caller —
    // means no route can leave it open over a DIFFERENT person, which would
    // offer to attach a record to whoever is showing now.
    setLinkSearchOpen(false);
    // BACKLOG-2471 PR C: the compare screen, same rule and the same reason.
    setCompareOpen(false);
    setPreviewContactState(contact);
  }, []);
  const [previewTransactions, setPreviewTransactions] = useState<
    ContactTransaction[]
  >([]);
  const [loadingPreviewTransactions, setLoadingPreviewTransactions] =
    useState(false);

  // BACKLOG-1934: contact-scoped emails for the preview card. Loaded via the
  // shared useContactComms hook (T1) — keyed off the currently-previewed,
  // imported contact (external contacts have no imported comms to show).
  // `isExternal` is a pure helper (declared below); inline the same check here
  // to avoid depending on its declaration order.
  const previewIsExternal =
    previewContact !== null &&
    (previewContact.is_message_derived === 1 ||
      previewContact.is_message_derived === true);
  const emailsContactId =
    previewContact && !previewIsExternal ? previewContact.id : null;
  const {
    emails: previewEmails,
    isLoadingEmails,
    // BACKLOG-1935: text-message threads for the preview card, from the SAME
    // useContactComms call (already loads both emails and texts — no re-query).
    messageThreads: previewMessageThreads,
    isLoadingMessages,
  } = useContactComms(emailsContactId);

  // BACKLOG-1936: in-place email/text viewer plumbing, extracted into the shared
  // useContactCommViewers hook so the transaction "Key Contacts" pane mounts the
  // SAME viewers (no divergent copy). Passing onSeeTransaction={onOpenTransaction}
  // opts this surface into the "See transaction" button — it jumps to the comm's
  // owning transaction via the existing onOpenTransaction seam
  // (AppModals.handleOpenTransactionFromContact → closeContacts(); openTransactions()).
  const {
    openEmail: handleEmailClick,
    openThread: handleMessageClick,
    closeViewers,
    viewers: commViewers,
  } = useContactCommViewers({ userId, onSeeTransaction: onOpenTransaction });

  // BACKLOG-2410 — the review queue and this contact's provenance.
  //
  // The queue lives HERE, on Clients & Contacts, and not in Settings (founder,
  // 2026-08-02): deciding whether two records are the same person is contact
  // work, not configuration, and a review surface nobody finds is the same as no
  // review surface at all.
  const [showReviewDuplicates, setShowReviewDuplicates] = useState(false);
  const { count: reviewQueueCount, refresh: refreshReviewQueueCount } =
    useReviewQueueCount(userId);

  const provenanceContactId =
    previewContact && !previewIsExternal ? previewContact.id : null;
  const { sources: previewSources, refresh: refreshPreviewSources } =
    useContactSources(userId, provenanceContactId);
  const [unlinkingLinkId, setUnlinkingLinkId] = useState<string | null>(null);
  /**
   * BACKLOG-2427: what the last unlink deliberately did NOT do.
   *
   * Cleared on every successful unlink so a stale explanation never sits over a
   * later action that had no such caveat.
   */
  const [unlinkNotice, setUnlinkNotice] = useState<string | null>(null);

  // Track imported contact IDs for visual feedback
  const [importedContactIds, setImportedContactIds] = useState<Set<string>>(
    new Set()
  );

  /**
   * ==========================================================================
   * BACKLOG-2525 — AN IMPORT IN FLIGHT, SHOWN AND DEDUPED.
   * ==========================================================================
   * Founder, 2026-08-05: *"on contact that have lots of emails and data the
   * import button seems like it's not working — you can click it a few times
   * and nothing happens. i was able to click it three times and i went back to
   * the list and i see rosey 3 times"*.
   *
   * A record with many emails and phones takes seconds: `contacts:import`
   * writes the contact, the phones, the emails, every crosswalk row, then runs
   * a linking pass (`contactHandlers.ts:2122`) before it resolves. Nothing on
   * screen changed for the whole of it, so pressing again was the only
   * reasonable read of the situation.
   *
   * TWO FIELDS, AND THEY ARE NOT REDUNDANT.
   *
   * `importingContactId` is what the user SEES — it disables the button and
   * relabels it. State, because rendering is what it is for.
   *
   * `inFlightImports` is what makes the second press HARMLESS. `setState` is
   * async: two clicks inside one React batch both run against the pre-update
   * value, so a state flag alone still fires two IPC calls. The ref is written
   * synchronously in the same tick as the first call, so the second press finds
   * the in-flight promise and awaits THAT — one round trip, and every caller
   * still gets the imported contact back.
   *
   * NEITHER OF THESE IS A LOADING FLAG ON THE LIST. BACKLOG-2511 made the
   * post-import refresh silent on purpose: raising `isLoading` replaces every
   * row with a spinner and throws away the user's place, which is the thing
   * BACKLOG-2459 exists to preserve and which he has already tested and passed.
   *
   * The renderer guard is a courtesy, not the fix. Two windows, or a click that
   * outlives this component, still reach the handler — which is why the real
   * guard is the crosswalk check in `contacts:import` (BACKLOG-2525 part A).
   */
  const [importingContactId, setImportingContactId] = useState<string | null>(null);
  const inFlightImports = useRef<Map<string, Promise<ExtendedContact>>>(new Map());

  /**
   * BACKLOG-2459 — the user's place in the list, held across the detail view.
   *
   * It lives HERE rather than inside ContactSearchList because below 1200px the
   * list is unmounted while the detail card is open (see the layout branch
   * below), and state inside an unmounted component is not a memory. Two plain
   * fields, no state machine: `anchorRef` is what the list captured on open,
   * `pendingAnchor` is that same value handed back when the detail closes.
   * Deliberately NOT another `useAppStateMachine()` call — BACKLOG-2420/2421 are
   * about exactly that duplication in this file.
   */
  const anchorRef = useRef<ContactListAnchor | null>(null);
  const [pendingAnchor, setPendingAnchor] = useState<ContactListAnchor | null>(null);

  const handleAnchorCapture = useCallback((anchor: ContactListAnchor) => {
    anchorRef.current = anchor;
  }, []);

  const handleAnchorConsumed = useCallback(() => {
    setPendingAnchor(null);
  }, []);

  /**
   * BACKLOG-2509 — the user's search text, held across the detail view.
   *
   * The SECOND field to move up here for the identical reason as the anchor
   * directly above: below 1200px the layout branch renders the detail card
   * INSTEAD of the list, so a query living inside `ContactSearchList` was
   * destroyed the moment a contact was opened and the user had to retype it.
   * The anchor solved the scroll position and never touched the query.
   *
   * SESSION-ONLY, founder decision D4 (2026-08-06) — "search is a moment,
   * filters are a setup". So: plain state, no localStorage, no second
   * persistence mechanism (the grouped Source/Role filter keeps its own, and
   * BACKLOG-2370 is what having two rules for one thing costs). It survives
   * opening and closing a contact at both widths and a viewport change across
   * the breakpoint; it dies with this screen and with the app.
   *
   * OWNED HERE ON PURPOSE, and the compare screen (BACKLOG-2471 PR F) consumes
   * it by doing nothing: that screen mounts inside the same layout branch
   * below, so confirming returns to a list whose query the parent still holds.
   * It must not keep its own copy, and it must not push this into
   * `useAppStateMachine` — BACKLOG-2420/2421 are about that duplication in this
   * file. Same seam for the BACKLOG-2591 picker swap.
   */
  const [searchQuery, setSearchQuery] = useState("");

  // Rendered row count reported up from ContactSearchList (BACKLOG-2141) so the
  // header count MATCHES the list (post filter, post search, post external
  // dedup) instead of an unfiltered/undeduped total. `null` until the list
  // reports (falls back to the raw total below).
  const [visibleCount, setVisibleCount] = useState<number | null>(null);

  // Clear stale imported IDs when a contact is deleted
  // BACKLOG-2367: removed-contacts section state. Open state is lifted here so
  // it survives the list's loading remount — a restore never collapses it.
  // Declared ABOVE handleContactDeleted, which sets the refresh key.
  const [removedContactsOpen, setRemovedContactsOpen] = useState(false);
  const [removedContactsRefreshKey, setRemovedContactsRefreshKey] = useState(0);

  const handleContactDeleted = useCallback(() => {
    // Clear all imported IDs - the external contact may reappear and shouldn't show checkmark
    setImportedContactIds(new Set());
    // BACKLOG-2367: the person just removed belongs in the Removed contacts
    // section now. Bump so its count refetches silently — no spinner, and the
    // section stays exactly as expanded or collapsed as the user left it.
    setRemovedContactsRefreshKey((k) => k + 1);
  }, []);

  // Contact list and removal state
  const {
    contacts,
    loading,
    error,
    silentLoadContacts,
    handleRemoveContact,
    handleConfirmRemove,
    handleUndoRemove,
    showRemoveConfirmation,
    setShowRemoveConfirmation,
    setContactToRemove,
    showBlockingModal,
    setShowBlockingModal,
    blockingTransactions,
    setBlockingTransactions,
    // External contacts (from macOS Contacts app, etc.)
    externalContacts,
    externalContactsLoading,
    refreshAfterImport,
  } = useContactList(userId, { onContactDeleted: handleContactDeleted });

  /**
   * BACKLOG-2367: toasts for the removed-contacts restore path. The rest of this
   * screen still uses alert() for failures; a restore is a SUCCESS case, and an
   * alert() would be a modal interruption for good news.
   *
   * Read through `useContext` rather than the `useNotification` hook on purpose.
   * That hook THROWS when no provider is mounted, which would turn a missing
   * context into a blank Clients & Contacts screen — a whole screen lost for a
   * toast. `NotificationProvider` does wrap the app (App.tsx), so in production
   * this is always present; the difference only shows up where the screen is
   * rendered on its own, which is exactly where a crash is least warranted.
   * Undefined handlers simply mean no toast, which is what this screen did
   * before this section existed.
   */
  const notification = useContext(NotificationContext);

  /**
   * Remove the staged contact, then offer Undo (BACKLOG-2501).
   *
   * Founder QA: "can we have a {Name} removed toast with undo button". The
   * removed-contacts section below the list is a RECOVERY surface — it only
   * helps once the user has noticed something is missing and gone looking. The
   * toast catches the mistake in the seconds where they still know they made
   * it.
   *
   * Undo calls `handleUndoRemove`, which is a thin wrapper over the SAME
   * `contacts:restore` channel the removed-contacts section restores through.
   * No second un-remove path exists.
   *
   * `handleConfirmRemove` returning null means nothing was removed (it has
   * already alerted), so no toast is raised over a failure.
   */
  const handleConfirmRemoveWithUndo = useCallback(async () => {
    const removed = await handleConfirmRemove();
    if (!removed) return;

    notification?.notify.success(`${removed.displayName} removed`, {
      action: {
        label: "Undo",
        onClick: () => {
          void (async () => {
            const restored = await handleUndoRemove(removed.id);
            if (!restored) return;
            // The person is back in the list; the removed section's count is
            // now one too high. Same silent bump handleContactDeleted does.
            setRemovedContactsRefreshKey((k) => k + 1);
          })();
        },
      },
    });
  }, [handleConfirmRemove, handleUndoRemove, notification]);

  /**
   * Detach one source from the previewed contact.
   *
   * The contact and every other source survive. The count is refreshed too:
   * unlinking records a "different people" verdict, which can retire a pending
   * question about that same pair, and a button still advertising it would be
   * asking about something the user has just answered.
   */
  // BACKLOG-2471 PR D: takes the LINK ID rather than the whole provenance row,
  // because that is all it ever used (the two lines below) and because the
  // compare screen holds a column, not a `ContactSourceProvenance`. ONE unlink
  // function serves both surfaces — the Sources panel and the compare screen
  // reach the same shipped `contacts:unlink-source`, so there is no second
  // unlink behaviour for PR E to have to change twice.
  const handleUnlinkSource = useCallback(
    async (linkId: string) => {
      if (!provenanceContactId) return;
      setUnlinkingLinkId(linkId);
      try {
        const result = await window.api.contacts.unlinkSource(
          userId,
          provenanceContactId,
          linkId,
        );
        if (!result.success) {
          logger.warn(`[Contacts] unlink source failed: ${result.error}`);
        } else if (result.retainedReason === "frozen_transaction") {
          // BACKLOG-2427: the removal was REFUSED, not skipped. This contact is
          // on an exported audit, so dropping addresses would silently change
          // what a re-export searches. The link is gone and the verdict stands;
          // the addresses were kept on purpose, and saying so is the difference
          // between a decision and a bug.
          // BACKLOG-2471: verb follows the button. The control now reads
          // "Unlink", and a notice answering it with "removed" reads as though
          // the CONTACT was deleted — the exact ambiguity the founder's word
          // choice avoids. Copy-only; the behaviour above is unchanged.
          setUnlinkNotice(
            "The source was unlinked. Its email addresses and phone numbers were kept " +
              "because this contact is on an exported transaction — removing them would " +
              "change what a re-export searches for.",
          );
        } else {
          setUnlinkNotice(null);
        }
        // The contact list carries the emails and phones this may have just
        // taken back, so a stale list would keep showing a rejected person's
        // address until the next reload.
        silentLoadContacts();
      } catch (err) {
        logger.warn(`[Contacts] unlink source threw: ${String(err)}`);
      } finally {
        setUnlinkingLinkId(null);
        refreshPreviewSources();
        refreshReviewQueueCount();
      }
    },
    [
      userId,
      provenanceContactId,
      refreshPreviewSources,
      refreshReviewQueueCount,
      silentLoadContacts,
    ],
  );

  // Helper to check if a contact is external (message-derived or from Contacts app)
  const isExternal = (contact: ExtendedContact): boolean => {
    return contact.is_message_derived === 1 || contact.is_message_derived === true;
  };

  // DEFENSIVE CHECK: Return loading state if database not initialized
  if (!isDatabaseInitialized) {
    return (
      <div className="h-screen bg-gradient-to-br from-blue-50 via-indigo-50 to-purple-50 flex items-center justify-center">
        <div className="text-center">
          <div className="w-8 h-8 border-4 border-purple-600 border-t-transparent rounded-full animate-spin mx-auto mb-2"></div>
          <p className="text-gray-500 text-sm">Waiting for database...</p>
        </div>
      </div>
    );
  }

  // Load transactions for a contact using checkCanDelete (returns transactions list)
  const loadContactTransactions = useCallback(async (contactId: string) => {
    setLoadingPreviewTransactions(true);
    try {
      const result = await window.api.contacts.checkCanDelete(contactId);
      if (result.success && result.transactions) {
        setPreviewTransactions(
          // BACKLOG-1930: `roles` is a typed, deduped string[] at the IPC
          // boundary (ContactBlockingTransaction.roles: string[]). Display
          // formatting (the ", " join) is owned here in the renderer, not the
          // data layer. `t.roles` is statically an array, so the earlier
          // BACKLOG-1898 runtime error (`t.roles?.join is not a function` on a
          // string) cannot recur — a non-array here is a compile error.
          result.transactions.map((t) => ({
            id: t.id,
            property_address: t.property_address,
            role: t.roles && t.roles.length > 0 ? t.roles.join(", ") : "Contact",
          }))
        );
      } else {
        setPreviewTransactions([]);
      }
    } catch (error) {
      // Previously a bare `catch {}` swallowed this error and silently
      // rendered an empty Transactions section (BACKLOG-1898).
      logger.error("Failed to load contact transactions:", error, { contactId });
      setPreviewTransactions([]);
    } finally {
      setLoadingPreviewTransactions(false);
    }
  }, []);

  // Handle clicking on a contact to view details
  const handleContactClick = useCallback((contact: ExtendedContact) => {
    // Open the detail view (pane on wide viewports, full-screen card on narrow)
    showPreviewContact(contact);
    setPreviewTransactions([]);
    selectContact(contact.id);

    /*
      BACKLOG-2471 PR F — THE COMPARE SCREEN IS THE DEFAULT WAY IN, until the
      user has said these records are one person.

      `showPreviewContact` above has already cleared `compareOpen` for the
      outgoing contact, so this only ever opens it for the one being clicked —
      which is why the order matters and why this line sits after it.

      Gated on the STAMPED flag, not on a second query: `review_state` is
      present only for contacts the compare screen actually opens for, so a
      click can never be intercepted onto "there is nothing to compare".
      `undefined` means no flag and no interception — never "reviewed".

      Once confirmed, `needsReview` goes false and the ordinary card opens
      again. The screen stays reachable from `Compare sources`, which is gated
      on having records to compare rather than on this flag, so it is unaffected.
    */
    if (contact.review_state?.needsReview) setCompareOpen(true);

    if (isExternal(contact)) {
      // External contact - no transactions to load
      setLoadingPreviewTransactions(false);
    } else {
      // Imported contact - load associated transactions
      loadContactTransactions(contact.id);
    }
  }, [loadContactTransactions, selectContact, showPreviewContact]);

  /**
   * Close/clear the detail view (narrow Back button, wide pane close, modal X).
   * Also dismiss any open email/text viewer so it can't outlive its contact.
   *
   * BACKLOG-2459: hand the captured anchor back to the list so it returns the
   * user to the person they were looking at. The anchor carries the CONTACT the
   * card was showing, not a scroll offset, which is what makes it survive the
   * list changing while the card was open — linking two records shortens the
   * list, and an offset restored into a shorter list points at a stranger.
   */
  const handleCloseDetail = useCallback(() => {
    showPreviewContact(null);
    closeViewers();
    clearSelection();
    if (anchorRef.current) setPendingAnchor(anchorRef.current);
  }, [clearSelection, closeViewers, showPreviewContact]);

  /**
   * Import ONE address-book record from Clients & Contacts.
   *
   * ==========================================================================
   * BACKLOG-2510 — THIS GOES THROUGH `contacts:import`, THE SAME DOOR AS THE
   * TRANSACTION PICKER. Founder: *"shouldn't they be the same?"*
   * ==========================================================================
   * It used to call `contacts:create` with a payload assembled field by field
   * from the row. Every field it named survived; every field it did not name
   * was dropped — and the ones it did not name were `externalRecordId`,
   * `externalSourceType`, `externalUuid` and `collapsedSources`, the identity
   * of the actual address-book record.
   *
   * `contacts:create` writes no crosswalk row for a source record. Its only
   * crosswalk write is `recordContactOrigin`, whose `source_record_id` is the
   * synthetic `origin:<contactId>`. So an imported contact reached the database
   * holding a `contacts.source` STRING saying "Contacts App" and nothing at all
   * pointing at the card it was made from. Three consequences, none of them
   * visible on the contact card, which is why this survived so long:
   *
   *   1. `contacts:get-available` suppresses a record when some contact claims
   *      its `(source_type, external_record_id)` pair. `origin:<contactId>`
   *      matches no real record id, so the address-book row stayed in the list
   *      after import — the duplicate the founder saw (BACKLOG-2511).
   *   2. Nothing could attach later. When Outlook offers the same person on a
   *      later sync there was no crosswalk row for the linker to extend.
   *   3. The two Import buttons disagreed about what importing means.
   *
   * The fix is not to teach `contacts:create` to write source links — that is
   * a second rule answering a question `contacts:import` already answers, and
   * this codebase has paid for that shape once already (BACKLOG-2370, deleted).
   * It is to stop rebuilding the payload and hand the ROW over, exactly as
   * the transaction flow's import modal used to. `contacts:import` then does what it already
   * does correctly: `toSourceIdentities` reads every record the row stands for,
   * `linkImportedContact` writes a `source_id` crosswalk row for each, and
   * `runContactLinkingNow` runs the duplicate pass while the user is watching.
   *
   * Passing `contact` whole rather than a copy is the load-bearing detail. Any
   * rebuild here silently reintroduces the same defect for whichever field the
   * next person forgets.
   *
   * ONE DELIBERATE BEHAVIOUR CHANGE: `contacts:create` had a duplicate-by-name
   * early return that handed back an existing contact instead of importing.
   * `contacts:import` has no such branch, and should not — name-only matching
   * is what BACKLOG-2316 removed from the picker for over-suppressing distinct
   * people. Two different clients called "Chris Nguyen" are two contacts; the
   * old branch silently discarded the second import and returned the first.
   *
   * BACKLOG-2525 CORRECTS THE SENTENCE ABOVE WITHOUT REVERSING IT. Dropping the
   * name guard was right; dropping EVERY guard was not, and the founder made
   * three Roseys with it. `contacts:import` now returns the existing contact
   * when the SOURCE RECORD is already claimed — the address-book entry, not the
   * name. Two different Chris Nguyens are still two contacts, because they are
   * two records; the same record pressed twice is one, because it is one record.
   *
   * ---------------------------------------------------------------------------
   * BACKLOG-2525 — THE SECOND PRESS SHARES THE FIRST PRESS'S ROUND TRIP
   * ---------------------------------------------------------------------------
   * Keyed on the contact id, so importing two different people at once is
   * unaffected — only a repeat of the SAME row is folded. The entry is removed
   * in a `finally` on the shared promise rather than after the `await` below, so
   * a caller that never awaits cannot leave the row wedged as permanently
   * importing.
   */
  const handleImportContact = useCallback(
    async (contact: ExtendedContact): Promise<ExtendedContact> => {
      const alreadyRunning = inFlightImports.current.get(contact.id);
      if (alreadyRunning) return alreadyRunning;

      const run = (async (): Promise<ExtendedContact> => {
      try {
        // `is_message_derived` is a RENDERER BADGE, not part of the record.
        // `useContactList` stamps it on every external row (:165-168) purely so
        // the list can show an "External" pill. The transaction-flow import has
        // never sent it — it reads `contacts:getAvailable` directly — so leaving
        // it on would make the two payloads differ in the one field neither side
        // of the IPC boundary has any use for. Dropped here, at the boundary,
        // rather than by rebuilding the object.
        const { is_message_derived: _listBadge, ...record } = contact;
        const result = await window.api.contacts.import(userId, [record]);
        const importedContact = result.contacts?.[0];

        if (result.success && importedContact) {
          /**
           * ==================================================================
           * BACKLOG-2511 — REFRESH BOTH LISTS, BECAUSE THIS SCREEN IS BOTH.
           * ==================================================================
           * Clients & Contacts renders two lists joined in the renderer: the
           * saved contacts from `contacts:get-all`, and the address-book
           * records not yet imported from `contacts:get-available`. Importing
           * moves a person from the second list to the first, so it changes
           * BOTH — and this only ever refreshed the first.
           *
           * The result is what the founder saw: the person appears twice,
           * adjacent, because the new saved contact has a fresh UUID while the
           * address-book row still carries the shadow-table UUID, and
           * `assembleContacts` collapses on exact `id` only
           * (`contactPickerList.ts:268-285`). Two different ids, two rows.
           *
           * NOT FIXED BY HIDING THE ROW. Re-deciding in the renderer who is the
           * same person is what `assembleDedupedContacts` did, and BACKLOG-2370
           * deleted it for silently reversing the founder's unlink. Dropping
           * the row optimistically is the same mistake in miniature — a second
           * source of truth about what is imported, kept in component state.
           * The main process already answers this question, and answers it from
           * the crosswalk: `contacts:get-available` suppresses any record a
           * saved contact claims by `(source_type, external_record_id)`
           * (`contactHandlers.ts:1695-1701`). Asking it again is the whole fix.
           *
           * That suppression is load-bearing here, so it is pinned by execution
           * rather than assumed — `contact-handlers.importLinking.test.ts`,
           * "BACKLOG-2511": the record is offered before the import and not
           * after, and deleting the crosswalk row brings it straight back. It
           * only became true when BACKLOG-2510 routed this flow through
           * `contacts:import`; before that the sole crosswalk row written was
           * the synthetic `origin:<contactId>`, which matches no real record.
           *
           * Both refreshes are awaited together. They are independent IPC round
           * trips, and sequencing them would leave the list showing the imported
           * person twice for the width of the second call — a flash of exactly
           * the bug being fixed.
           *
           * ==================================================================
           * BACKLOG-2526 — AWAITING THEM TOGETHER WAS NOT THE SAME AS
           * COMMITTING THEM TOGETHER, AND THE FOUNDER SAW THE DIFFERENCE.
           * ==================================================================
           * This was `Promise.all([silentLoadContacts(), reloadExternalContacts()])`.
           * `Promise.all` gates the code AFTER it; it does not gate the two
           * state writes INSIDE it. Each function committed the moment its own
           * IPC returned, in a separate React continuation — so the flash the
           * comment above says was avoided was still there, just narrower: the
           * saved-contact fetch is the fast one, so for the width of the
           * address-book read (~3.7s at 1000+ contacts) the list held BOTH rows.
           *
           * `refreshAfterImport` fetches both in parallel and commits both in
           * ONE render. The whole rationale, including why it replaced
           * `reloadExternalContacts` outright rather than sitting beside it,
           * is on its declaration in `useContactList.ts`.
           */
          const refreshed = await refreshAfterImport();

          /**
           * BACKLOG-2526 — the "Added" pill lands WITH the new list, not before
           * it.
           *
           * This ran before the refresh, and it is keyed on the EXTERNAL id
           * (`ContactSearchList.tsx` → `ContactRow.tsx`), so it painted "Added"
           * on the address-book row — the row that was about to disappear. The
           * founder: *"one has the added green pill on it which is on the
           * external contact being added … then it resolves and that line with
           * the added disappears"*. The badge meaning "you just added this" sat
           * on the one row that vanished, which reads as the app undoing what he
           * had just done.
           *
           * Moved after the refresh, it is invisible in the ordinary case,
           * because by then the main process no longer offers that record. It is
           * KEPT rather than deleted for the case where it is the truth: if the
           * address-book refetch failed, the row is still on screen, and the
           * pill is then the only honest signal that the import worked.
           */
          setImportedContactIds((prev) => new Set(prev).add(contact.id));

          const created = importedContact as ExtendedContact;

          /**
           * BACKLOG-2459 — return the row as the DATABASE now has it.
           *
           * The handler builds this object from the contact row and the `Contact`
           * type has no `allEmails`/`allPhones` at all — so it carries one email
           * and one phone no matter how many the source record had. That was
           * harmless while the caller discarded it; now the card stays open on
           * this object and renders it, and `ContactPreview` falls back to the
           * single `email`/`phone` when the arrays are absent. A user importing a
           * record with three addresses would stay on the card as intended and
           * see one of them.
           *
           * The refreshed list is the same query the list itself renders from,
           * so preferring its row costs nothing and cannot drift. Falls back to
           * the created object when the refresh failed or has not caught up.
           */
          return refreshed.find((c) => c.id === created.id) ?? created;
        }

        throw new Error(result.error || "Failed to import contact");
      } catch (err) {
        logger.error("Failed to import contact:", err);
        throw err;
      }
      })();

      // Registered BEFORE the first `await` on `run`, in the same synchronous
      // tick as the call above — a second click landing in the same React batch
      // must find it here, which is the whole point.
      inFlightImports.current.set(contact.id, run);
      setImportingContactId(contact.id);

      // On `run` itself, not around a `return await`: a caller that fires and
      // forgets would otherwise leave the map and the button stuck permanently
      // importing, with no way back short of a reload.
      //
      // The trailing `catch` is not optional and not cosmetic. `.finally()`
      // returns a NEW promise that adopts the rejection, and nothing awaits
      // THAT one — a failed import (the founder's "database is locked" case)
      // would raise an unhandled rejection every time. The real callers still
      // receive the rejection through `run` itself, which is the object they
      // were handed; this branch exists only to clear the bookkeeping.
      void run
        .finally(() => {
          inFlightImports.current.delete(contact.id);
          setImportingContactId((current) =>
            current === contact.id ? null : current,
          );
        })
        .catch(() => {});

      return run;
    },
    [userId, refreshAfterImport]
  );

  /**
   * Import the contact the detail card is showing — and STAY ON IT.
   *
   * BACKLOG-2459, founder: *"i clicked import and the screen re-rendered to the
   * list of contacts, it exited the contact detail screen showing [the contact]"*. This
   * used to `setPreviewContact(null)` on success, which closed the one screen
   * that could show what the import had just produced. The user acts on a person
   * and is thrown back to the list, so the thing they created is exactly what
   * they cannot see — and it is why the founder could not tell whether the
   * import had linked both sources.
   *
   * `handleImportContact` already returns the created contact, so the card can
   * simply switch to it. That also flips the card from external to imported,
   * which is what lights up its Emails, Texts and provenance sections — the
   * sections that answer the question the import was asked to settle.
   *
   * ==========================================================================
   * BACKLOG-2527 — …AND ONLY IF HE IS STILL ON IT.
   * ==========================================================================
   * Founder: *"if i click back before it's done importing … once the import is
   * done it forces me back to the contact details screen"*. He pressed Import,
   * went back to the list while it was still running, and the app took the
   * screen back from him when it finished.
   *
   * That is worse than a wrong-looking render: it is the app overriding a
   * navigation he performed, seconds after he performed it, on behalf of an
   * operation he had already left behind. And it is unbounded in the bad
   * direction — the slower the import, the longer the window.
   *
   * The BACKLOG-2459 behaviour above is not withdrawn, it is made conditional.
   * The rule: AN ASYNC COMPLETION MAY UPDATE WHAT THE USER IS LOOKING AT. IT
   * MAY NOT DECIDE WHAT THE USER IS LOOKING AT. Still on the card → it updates
   * in place, exactly as he tested and passed. Moved → the list refresh still
   * lands (that is an update), and the three navigation writes do not.
   *
   * The check compares CONTACT IDS, not null-ness, so it covers the second way
   * he can move: opening a DIFFERENT contact while the import runs. A
   * `!== null` test would leave that case yanking him off the person he chose
   * and onto the one he imported.
   */
  const handlePreviewImport = async () => {
    if (!previewContact) return;

    const hasName = !!(previewContact.display_name || previewContact.name);
    const hasEmail = !!(previewContact.email || previewContact.allEmails?.[0]);
    const hasPhone = !!(previewContact.phone || previewContact.allPhones?.[0]);

    if (!hasName || (!hasEmail && !hasPhone)) {
      // Missing required data - open edit form.
      //
      // BACKLOG-2566: the pane stays MOUNTED under the z-[70] modal. Clearing it
      // here used to leave the user on the empty list once the form closed, on
      // either button — the same defect as `handlePreviewEdit` below, at a
      // second call site. This branch routes to the form's CREATE leg
      // (ContactFormModal.tsx:220 — `contact && !isExternalContact` is false for
      // an address-book record), so the saved contact carries a NEW database id;
      // the id handling for that lives in the modal's onSuccess handler.
      setSelectedContact(previewContact);
      setShowAddEdit(true);
      return;
    }

    // Read BEFORE the await. `previewContact` in this closure is frozen at the
    // moment of the click; `previewContactIdRef` is not, which is the whole
    // reason it exists.
    const startedOn = previewContact.id;

    try {
      const imported = await handleImportContact(previewContact);

      // He moved. Leave him where he went.
      if (previewContactIdRef.current !== startedOn) return;

      showPreviewContact(imported);
      selectContact(imported.id);
      loadContactTransactions(imported.id);
    } catch (err) {
      logger.error("Failed to import contact:", err);
    }
  };

  /**
   * Edit the contact the detail pane is showing — and STAY ON IT.
   *
   * BACKLOG-2566, founder-verified: clicking Edit used to `setPreviewContact(null)`,
   * which UNMOUNTS the detail screen rather than merely covering it (wide: :942,
   * narrow: :835, and `renderDetailPane` hard-returns on null at :702). Nothing put it
   * back, so Save and Cancel both dropped the user on the list — the person they
   * were working on, and the change they had just made, gone from the screen.
   *
   * The modal is `z-[70]` (ContactFormModal.tsx:277) and already renders above
   * the pane, so there was never a reason to clear it. The pane is refreshed to
   * the saved record by the modal's onSuccess handler below.
   */
  const handlePreviewEdit = () => {
    if (previewContact) {
      setSelectedContact(previewContact);
      setShowAddEdit(true);
    }
  };

  /**
   * BACKLOG-2502 — WHERE `Confirm & edit` LANDS. ONE FUNCTION, BOTH ENTRY PATHS.
   *
   * Founder ruling, 2026-08-09: from the duplicates queue, confirm-and-edit must
   * open the contact card *"exactly as confirm-and-edit does when a contact is
   * opened from the main list. Same destination, same behaviour — not a
   * variant."*
   *
   * Sameness is enforced by CONSTRUCTION rather than by two call sites agreeing:
   * the compare screen mounted from the detail pane and the one mounted inside
   * `ReviewDuplicatesModal` are handed this same function, so a change to the
   * destination cannot reach one route and miss the other. `Contacts.compareWayIn`
   * then walks both paths and compares what is on screen at the end, which is
   * what would catch a future fork.
   *
   * `showPreviewContact` rather than a bare `setCompareOpen(false)`: on the queue
   * route the contact being confirmed is usually NOT the one the pane is showing,
   * so the card has to be pointed at it. On the main-list route it is already
   * that contact and the call is a no-op beyond closing the compare screen —
   * which is exactly what this used to do there.
   *
   * The pane is left MOUNTED under the form (BACKLOG-2566): the form is `z-[70]`
   * and covers it, and clearing it is what used to drop the user on the list when
   * they saved.
   */
  const openContactCardForEdit = (contact: ExtendedContact) => {
    showPreviewContact(contact);
    refreshPreviewSources();
    refreshReviewQueueCount();
    silentLoadContacts();
    setSelectedContact(contact);
    setShowAddEdit(true);
  };

  // Handle adding a new contact manually
  const handleAddManually = () => {
    setSelectedContact(undefined);
    setShowAddEdit(true);
  };

  // Render the contact detail as an inline pane (shared by the wide two-pane
  // layout and the narrow full-screen card). Transaction rows are clickable and
  // open the transaction via onOpenTransaction (BACKLOG-1898 T5).
  const renderDetailPane = () => {
    if (!previewContact) return null;
    const external = isExternal(previewContact);

    /*
      BACKLOG-2471 PR C — the compare screen REPLACES the card while it is open,
      and it is returned from here rather than from either layout branch. Both
      the wide two-pane layout and the narrow full-screen card call this one
      function, so one return serves both viewports and neither branch of the
      layout ternary below changes.

      `×` sets this back to false and the card returns. Nothing is decided by
      opening or closing it — PR C is read-only, and the row-click routing that
      makes this screen the default way in is PR F.
    */
    if (compareOpen && !external) {
      return (
        <ContactCompareSources
          userId={userId}
          contactId={previewContact.id}
          onClose={() => setCompareOpen(false)}
          // BACKLOG-2471 PR D — the SAME function the Sources panel calls. The
          // compare screen adds no unlink of its own.
          onUnlinkSource={(linkId) => void handleUnlinkSource(linkId)}
          unlinkingLinkId={unlinkingLinkId}
          // Confirm returns to the card, and the list behind it never
          // unmounted, so its filter and search are still there.
          onConfirmed={() => {
            setCompareOpen(false);
            refreshPreviewSources();
            refreshReviewQueueCount();
            silentLoadContacts();
          }}
          // BACKLOG-2502 — the SHARED destination. The queue route below hands
          // the same function the contact it just confirmed.
          onConfirmedAndEdit={() => openContactCardForEdit(previewContact)}
        />
      );
    }

    return (
      <>
        {/*
          BACKLOG-2426 — manual linking. Above the card so the search and the
          contact it attaches to are on screen together.

          `onLinked` refreshes BOTH: the sources panel gains the new row, and the
          contact list carries the emails and phones the link just copied across
          — the same pair `handleUnlinkSource` refreshes for the same reason, in
          the opposite direction.
        */}
        {linkSearchOpen && !external && (
          <LinkSourceSearch
            userId={userId}
            contactId={previewContact.id}
            contactName={previewContact.display_name || previewContact.name || "this contact"}
            onClose={() => setLinkSearchOpen(false)}
            onLinked={() => {
              refreshPreviewSources();
              silentLoadContacts();
            }}
          />
        )}
      <ContactPreview
        contact={previewContact}
        isExternal={external}
        transactions={previewTransactions}
        isLoadingTransactions={loadingPreviewTransactions}
        // BACKLOG-1934: Emails section is imported-contacts-only. Passing
        // `undefined` for external contacts keeps the section hidden (matches
        // the gating on every other ContactPreview consumer).
        emails={external ? undefined : previewEmails}
        isLoadingEmails={external ? false : isLoadingEmails}
        onEmailClick={external ? undefined : handleEmailClick}
        // BACKLOG-1935: Texts section is imported-contacts-only, gated exactly
        // like Emails. Passing `undefined` for external contacts keeps the
        // section hidden (matches gating on every other ContactPreview consumer).
        messages={external ? undefined : previewMessageThreads}
        isLoadingMessages={external ? false : isLoadingMessages}
        onMessageClick={external ? undefined : handleMessageClick}
        // BACKLOG-2410: provenance, gated exactly like Emails/Texts. An external
        // contact has no crosswalk rows, and ContactPreview renders nothing at
        // all below two sources — so the single-source common case shows no
        // badge and no empty state.
        sources={external ? undefined : previewSources}
        onUnlinkSource={external ? undefined : (link) => void handleUnlinkSource(link.linkId)}
        unlinkingLinkId={unlinkingLinkId}
        unlinkNotice={external ? undefined : unlinkNotice}
        variant="pane"
        onEdit={handlePreviewEdit}
        // BACKLOG-2426: gated exactly like the provenance props above. An
        // external record is not a saved contact, so there is nothing to link
        // it TO — its action is Import.
        onLinkSource={external ? undefined : () => setLinkSearchOpen(true)}
        // BACKLOG-2471 PR C: gated exactly like the props above. The button
        // itself only appears when the card's own Sources panel does — one
        // threshold, decided inside ContactPreview.
        onCompareSources={external ? undefined : () => setCompareOpen(true)}
        onImport={external ? handlePreviewImport : undefined}
        // BACKLOG-2525: the card's own row, not "an import is happening
        // somewhere". Compared by id so a background import of a different
        // person cannot disable this button.
        isImporting={importingContactId === previewContact.id}
        onRemove={
          !external
            ? () => {
                handleCloseDetail();
                handleRemoveContact(previewContact.id);
              }
            : undefined
        }
        onClose={handleCloseDetail}
        onTransactionClick={onOpenTransaction}
      />
      </>
    );
  };

  return (
    <div className="h-screen bg-gradient-to-br from-blue-50 via-indigo-50 to-purple-50 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex-shrink-0 bg-gradient-to-r from-purple-500 to-pink-600 px-3 pt-6 pb-3 sm:px-6 sm:pt-10 sm:pb-4 flex items-center justify-between shadow-lg">
        <button
          onClick={onClose}
          className="text-white hover:bg-white hover:bg-opacity-20 rounded-lg px-2 py-2 sm:px-4 transition-all flex items-center gap-1 sm:gap-2 font-medium text-sm sm:text-base"
        >
          <svg
            className="w-5 h-5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M10 19l-7-7m0 0l7-7m-7 7h18"
            />
          </svg>
          <span className="hidden sm:inline">Back to Dashboard</span>
          <span className="sm:hidden">Back</span>
        </button>
        <div className="flex items-center gap-2 sm:gap-4">
          {/* BACKLOG-2410 — the review queue's entry point.
              Rendered ONLY when there is something to review, mirroring
              NeedsReviewSection (BACKLOG-2319), which returns null on an empty
              list. A permanent "Review 0 possible duplicates" is exactly the
              nagging the founder asked this button not to be, and a control that
              is usually pointless is one users learn to skip past. */}
          {reviewQueueCount !== null && reviewQueueCount > 0 && (
            <button
              type="button"
              onClick={() => setShowReviewDuplicates(true)}
              className="text-white bg-white bg-opacity-20 hover:bg-opacity-30 rounded-lg px-2.5 py-2 sm:px-3.5 transition-all flex items-center gap-1.5 font-medium text-xs sm:text-sm"
              data-testid="review-duplicates-button"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 9v2m0 4h.01M5 19h14a2 2 0 001.84-2.75L13.74 4a2 2 0 00-3.48 0L3.16 16.25A2 2 0 005 19z"
                />
              </svg>
              <span className="hidden sm:inline">
                Review {reviewQueueCount} possible{" "}
                {reviewQueueCount === 1 ? "duplicate" : "duplicates"}
              </span>
              <span className="sm:hidden">Review {reviewQueueCount}</span>
            </button>
          )}
          <div className="text-right">
            <h2 className="text-lg sm:text-2xl font-bold text-white">
              Clients &amp; Contacts
            </h2>
            <p className="text-purple-100 text-xs sm:text-sm">
              {visibleCount ?? contacts.length + externalContacts.length} contacts
              {externalContacts.length > 0 &&
                ` (${externalContacts.length} from Contacts App)`}
            </p>
          </div>
        </div>
      </div>

      {/* Error Banner */}
      {error && (
        <div className="flex-shrink-0 mx-2 sm:mx-4 mt-2 sm:mt-4 p-3 bg-red-50 border border-red-200 rounded-lg">
          <p className="text-sm text-red-800">{error}</p>
        </div>
      )}

      <OfflineNotice />

      {/*
        Master-detail content area (BACKLOG-1898 T5, breakpoint raised to
        1200px in Phase-1 layout polish — see useContactsLayout.ts).
        - Wide (>=1200px): two-pane grid `list | detail`; the detail pane renders
          ContactPreview inline (variant="pane") or an empty-state prompt.
          Bounded by the modal width (Contacts renders inside the AppModals shell).
        - Narrow (<1200px): single column, full-width list; the list shows until
          a contact is selected, then a full-screen detail card with a Back button.
      */}
      {isNarrow && previewContact && showDetailPane ? (
        /* Narrow: full-screen detail card with Back button */
        <div
          className="flex-1 min-h-0 flex flex-col bg-white mx-0 my-0 overflow-hidden"
          data-testid="contacts-detail-view"
        >
          <div className="flex-shrink-0 px-3 py-2 border-b border-gray-200">
            <button
              onClick={handleCloseDetail}
              className="flex items-center gap-1 text-purple-600 hover:text-purple-800 font-medium text-sm px-2 py-1 rounded-lg transition-colors"
              data-testid="contacts-detail-back"
            >
              <svg
                className="w-5 h-5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M15 19l-7-7 7-7"
                />
              </svg>
              Back
            </button>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto">
            {renderDetailPane()}
          </div>
        </div>
      ) : (
        /* Wide: two-pane grid; Narrow (no selection): list only */
        <div
          className={
            !isNarrow
              ? "flex-1 min-h-0 grid grid-cols-1 min-[1200px]:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] gap-0 min-[1200px]:gap-4 mx-0 my-0 sm:mx-4 sm:my-4 overflow-hidden"
              : "flex-1 min-h-0 mx-0 my-0 overflow-hidden"
          }
          data-testid="contacts-master-detail"
        >
          {/* List pane */}
          <div className="h-full min-h-0 flex flex-col bg-white sm:rounded-xl sm:shadow-lg overflow-hidden">
            {/*
              BACKLOG-2367: the list is now one of TWO children of this column,
              so it needs an explicit flex box. `h-full` on ContactSearchList is
              height:100% of this wrapper — without the wrapper it would resolve
              against the whole pane and overlap the removed-contacts footer.
            */}
            <div className="flex-1 min-h-0">
            <ContactSearchList
              contacts={contacts}
              externalContacts={externalContacts}
              selectedIds={[]}
              activeContactId={selectedContactId}
              onSelectionChange={() => {}}
              onContactClick={handleContactClick}
              onImportContact={handleImportContact}
              onAddManually={handleAddManually}
              addedContactIds={importedContactIds}
              isLoading={loading || externalContactsLoading}
              error={error}
              searchPlaceholder="Search contacts by name, email, or phone..."
              // BACKLOG-2352: Contacts screen is the ONLY surface that persists
              // the grouped Source/Role filter. Default sort is now Recent
              // (relevance) everywhere — the user can toggle to Alphabetical via
              // the Sort control.
              filterMode="persistent"
              className="h-full"
              compact
              onVisibleCountChange={setVisibleCount}
              // BACKLOG-2459: keep the user's place across open/close, anchored
              // on the contact rather than a scroll offset.
              onAnchorCapture={handleAnchorCapture}
              pendingAnchor={pendingAnchor}
              onAnchorConsumed={handleAnchorConsumed}
              // BACKLOG-2509: the query is held HERE so the narrow-viewport
              // unmount below cannot destroy it. Session-only (D4) — see the
              // state declaration above.
              searchQuery={searchQuery}
              onSearchQueryChange={setSearchQuery}
            />
            </div>
            {/*
              BACKLOG-2367: removed contacts live at the FOOT of the list, in the
              same pane, collapsed by default. `flex-shrink-0` keeps the toggle
              row pinned so it never competes with the list for height; the
              expanded body scrolls inside its own bounded box rather than
              growing the pane.
            */}
            <div className="flex-shrink-0 border-t border-gray-200 px-3 pb-2 max-h-[45vh] overflow-y-auto">
              <RemovedContactsSection
                userId={userId}
                onRestoreComplete={async () => {
                  await silentLoadContacts();
                }}
                onShowSuccess={notification?.notify.success}
                onShowError={notification?.notify.error}
                isOpen={removedContactsOpen}
                onOpenChange={setRemovedContactsOpen}
                refreshKey={removedContactsRefreshKey}
              />
            </div>
          </div>

          {/* Detail pane (wide only) */}
          {!isNarrow && (
            <div
              className="hidden min-[1200px]:flex min-h-0 bg-white rounded-xl shadow-lg overflow-hidden"
              data-testid="contacts-detail-pane"
            >
              {previewContact ? (
                <div className="flex-1 min-h-0 overflow-y-auto">
                  {renderDetailPane()}
                </div>
              ) : (
                <div
                  className="flex-1 flex items-center justify-center text-gray-400 text-sm p-8 text-center"
                  data-testid="contacts-detail-empty"
                >
                  Select a contact to view details
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Add/Edit Contact Modal */}
      {showAddEdit && (
        <ContactFormModal
          userId={userId}
          contact={selectedContact}
          onClose={() => {
            setShowAddEdit(false);
            setSelectedContact(undefined);
          }}
          onSuccess={(saved) => {
            // BACKLOG-2566. The pane the form was opened over, if any. Read
            // BEFORE the async work below so a later render cannot change what
            // we fall back to. Null on the plain Add Contact path (handleAddManually).
            const paneContact = previewContact;

            setShowAddEdit(false);
            setSelectedContact(undefined);

            void (async () => {
              // SILENT, not `loadContacts()`: raising `loading` replaces every
              // row with a spinner (ContactSearchList.tsx:848) and throws away
              // the user's place — the thing BACKLOG-2459 exists to preserve,
              // and the hazard the comment at :166-169 already warns about.
              const loaded = await silentLoadContacts();

              const found = saved ? loaded.find((c) => c.id === saved.id) : undefined;

              // NEVER `?? null`. `silentLoadContacts` returns [] on IPC failure
              // and on unmount (useContactList.ts:140, 148-153), and onSuccess
              // may be called with undefined (ContactFormModal.tsx:260). Falling
              // back to null would reproduce the exact bug this fixes, on the one
              // path where the user most needs the record in front of them.
              // Stale values beat an empty screen.
              //
              // BACKLOG-2527: this write goes through `showPreviewContact` and
              // is NOT guarded, and both halves of that are deliberate.
              //
              // THE WRAPPER IS MANDATORY. A raw `useState` write here would
              // leave `previewContactIdRef` holding whatever the card was
              // before the form opened. The user would then edit a contact and
              // press Import on that same card, and the guard in
              // `handlePreviewImport` would compare the card's id against a
              // stale ref, fail to match, and silently switch OFF the
              // BACKLOG-2459/2566 stay-on-the-contact behaviour — dropping him
              // on the list after an ordinary import, with every suite green.
              // The wrapper is load-bearing for the guard's correctness, not
              // hygiene.
              //
              // NO GUARD, THOUGH. Where this flow lands is a founder decision,
              // recorded immediately below, and changing it is not this item's
              // to do. It has the same async-completion shape as the import, so
              // it is filed as an observation for him rather than fixed here.
              //
              // ONE RULE FOR ALL THREE FLOWS — founder decision, 2026-08-06.
              // Edit-from-pane, complete-an-incomplete-record, and plain Add
              // Contact all land the pane on the contact that was just saved.
              showPreviewContact(found ?? paneContact);

              // The CREATE paths (plain Add, and completing an incomplete
              // address-book record) produce a new id. Without this,
              // `activeContactId` points at a row no longer in the list, and
              // `previewTransactions` — manual state, not keyed on the contact —
              // would carry the previous record's array across the swap.
              // Mirrors the import-success path above.
              if (found && found.id !== paneContact?.id) {
                selectContact(found.id);
                loadContactTransactions(found.id);
              }
            })();
          }}
        />
      )}


      {/* Blocking Modal - Cannot Delete Contact with Transactions */}
      {showBlockingModal && (
        <BlockingTransactionsModal
          transactions={blockingTransactions}
          onClose={() => {
            setShowBlockingModal(false);
            setBlockingTransactions([]);
          }}
        />
      )}

      {/* Remove Confirmation Modal */}
      {showRemoveConfirmation && (
        <RemoveConfirmationModal
          onClose={() => {
            setShowRemoveConfirmation(false);
            setContactToRemove(null);
          }}
          onConfirm={handleConfirmRemoveWithUndo}
        />
      )}

      {/* BACKLOG-2410 — possible-duplicates review.
          The count is refreshed on every answer, and the contact list is
          reloaded too: confirming a link changes which source records a saved
          contact is assembled from, which the list already reflects. */}
      {showReviewDuplicates && (
        <ReviewDuplicatesModal
          userId={userId}
          onClose={() => setShowReviewDuplicates(false)}
          onResolved={() => {
            refreshReviewQueueCount();
            refreshPreviewSources();
            silentLoadContacts();
          }}
          /*
            BACKLOG-2502 — `Confirm & edit` from the queue leaves for the card.

            The modal closes first (it is above the card and would cover it), and
            the destination is `openContactCardForEdit` — the SAME function the
            detail pane's compare screen uses, not a second version of it.

            A contact that is not in the loaded list has no `ExtendedContact` to
            open a form over, so the queue simply closes: the confirm itself has
            already been written and `onResolved` has already refreshed the list.
            That is a stale-list case, not a lost answer.
          */
          onConfirmedAndEdit={(contactId) => {
            setShowReviewDuplicates(false);
            const contact = contacts.find((c) => c.id === contactId);
            if (contact) openContactCardForEdit(contact as ExtendedContact);
          }}
        />
      )}

      {/*
        BACKLOG-1936: in-place email + text viewers, mounted from the shared
        useContactCommViewers hook (extracted from the former inline blocks so
        the transaction "Key Contacts" pane reuses the exact same plumbing).
        Behaviour is identical to BACKLOG-1934/1935: closing a viewer returns to
        the card; "See transaction" is wired via onSeeTransaction={onOpenTransaction}
        and only shown for transaction-linked comms.
      */}
      {commViewers}
    </div>
  );
}

export default Contacts;
