/**
 * ContactsImportSettings Component
 *
 * Unified settings section for contact sources and importing.
 * Combines persisted source toggles (from Supabase) with
 * import controls (sync, force re-import).
 *
 * Features:
 * - Source stats grid (macOS, iPhone, Outlook, Google, Android counts)
 * - Toggle switches for direct import sources + auto-discover
 * - macOS Contacts: sync status, import, force re-import (macOS only)
 * - Outlook Contacts: import button, reconnect-required handling
 * - Android Phone Contacts (BACKLOG-2986): count, toggle, and a NON-DESTRUCTIVE
 *   pointer to the Android Companion re-import. The destructive control stays
 *   where it is: Android is push-only, so a delete here would not be
 *   recoverable (see the DECISION on BACKLOG-3001).
 *
 * @module settings/ContactsImportSettings
 */

import React, { useState, useEffect, useCallback } from "react";
import { usePlatform } from "../../contexts/PlatformContext";
import { useSyncOrchestrator } from "../../hooks/useSyncOrchestrator";
import { useNetwork } from "../../contexts/NetworkContext";
import { ResponsiveModal } from "../common/ResponsiveModal";

/**
 * BACKLOG-3156 stage C — ONE TREATMENT FOR EVERY "Stored on this computer" CELL.
 *
 * The grid had a different hue per source: macOS violet, iPhone blue, Outlook
 * indigo, Google green, Android teal. Five colours carrying no information —
 * each cell already says which source it is, in words, directly under the
 * number — and the effect was a row that reads as unfinished rather than as a
 * set of counts.
 *
 * The one distinction that DOES carry state is kept: a source whose import is
 * switched off is dimmed. That is the only reason a cell may look different
 * from its neighbours.
 *
 * These live as constants rather than as five hand-written class strings so
 * that "every cell wears the same treatment" is a property of the code and not
 * of five edits staying in step. `contactsStoredNeutral-3156` asserts it from
 * the rendered DOM as well, because a constant only helps for as long as the
 * next cell added uses it.
 */
const STORED_CELL = {
  on: "p-2 rounded border bg-white border-gray-200",
  off: "p-2 rounded border bg-gray-50 border-gray-200 opacity-50",
  countOn: "text-lg font-semibold text-gray-900",
  countOff: "text-lg font-semibold text-gray-400",
  labelOn: "text-xs text-gray-500",
  labelOff: "text-xs text-gray-400",
} as const;
import { ImportInfoPopover } from "./ImportInfoPopover";
import logger from '../../utils/logger';
import { safeErrorMessage } from '../../utils/formatUtils';
import type { ContactInferenceStates } from "../../hooks/useContactInferenceState";

/**
 * BACKLOG-2388: Shared "counts clause" for a contact-sync result so the macOS,
 * Outlook, and Google result banners read consistently. Returns only the
 * trailing sentence(s) that follow "<source> contacts synced." — e.g.
 * "No new contacts were found.", "5 new contacts added. 3 updated.", or
 * "12 contacts imported.". Presentation only — no sync logic lives here.
 *
 * Shape notes (verified while scoping):
 *  - The macOS contacts path completes through the sync orchestrator, which
 *    reports completion WITHOUT counts (all fields undefined). We must not
 *    claim "No new contacts were found." in that case, so an unknown result
 *    yields an empty string and the banner shows just "macOS contacts synced.".
 *  - Outlook/Google expose only a single lump `imported` count (their IPC
 *    result carries `count`, with no new-vs-updated breakdown available).
 *  - `updated` is supported here for wording consistency, but no source
 *    currently emits an updated count (see the PR issue log).
 */
export function formatContactSyncCounts(counts: {
  inserted?: number;
  updated?: number;
  deleted?: number;
  total?: number;
  /** Outlook/Google lump total synced this run. */
  imported?: number;
}): string {
  const { inserted, updated, deleted, total, imported } = counts;

  const details: string[] = [];
  if (typeof inserted === "number" && inserted > 0) {
    details.push(`${inserted.toLocaleString()} new ${inserted === 1 ? "contact" : "contacts"} added.`);
  }
  if (typeof imported === "number" && imported > 0) {
    details.push(`${imported.toLocaleString()} ${imported === 1 ? "contact" : "contacts"} imported.`);
  }
  if (typeof updated === "number" && updated > 0) {
    details.push(`${updated.toLocaleString()} updated.`);
  }
  if (typeof deleted === "number" && deleted > 0) {
    details.push(`${deleted.toLocaleString()} removed.`);
  }
  if (typeof total === "number") {
    details.push(`${total.toLocaleString()} total.`);
  }

  // "Nothing new" fires only on a KNOWN-zero signal (a count that is defined
  // and zero), never on a merely-absent one — otherwise the count-less macOS
  // orchestrator result would falsely claim no contacts were found.
  const knownZeroNew =
    (inserted === 0 && deleted === 0) || imported === 0;

  if (knownZeroNew) {
    // Any "0 …" segments were already skipped above; keep the meaningful ones
    // (updated / total) alongside the no-new line.
    return details.length
      ? `No new contacts were found. ${details.join(" ")}`
      : "No new contacts were found.";
  }

  return details.join(" ");
}

interface ContactsImportSettingsProps {
  userId: string;
  /** Whether a Microsoft account is connected */
  isMicrosoftConnected?: boolean;
  /** Whether a Google account is connected */
  isGoogleConnected?: boolean;
  // Persisted source preferences (from Settings.tsx / Supabase)
  outlookContactsEnabled: boolean;
  macosContactsEnabled: boolean;
  /** BACKLOG-2486: iPhone Contacts, which now has a gate of its own. */
  iphoneContactsEnabled: boolean;
  /**
   * BACKLOG-2486: whether to draw the iPhone Contacts switch at all. Decided by
   * the caller from the declared phone type — an Android user has no iPhone to
   * import from.
   */
  showIphoneContacts: boolean;
  /** BACKLOG-2986: Android companion contacts, which now have a switch here. */
  androidContactsEnabled: boolean;
  /**
   * BACKLOG-2986: the caller knows this user has an Android relationship — they
   * declared an Android phone, or a preference for the key has been stored.
   * ORed here with "android_sync contacts exist", which only this component can
   * see, to decide whether the Android switch, count and re-import note appear.
   */
  androidContactsDeclared: boolean;
  /**
   * BACKLOG-2986: is the Android companion the ACTIVE message import source?
   * Only then is the Android Companion panel — and its Force Re-import — on the
   * page for the re-import note to point at.
   */
  androidCompanionActive: boolean;
  /**
   * BACKLOG-2986: the "could not be saved" message for the last failed toggle
   * write, or null. Owned by the parent (which owns the handler) and rendered
   * here, immediately above the toggle group, because that is where the click
   * was — at the top of the section a user flipping one of the lower switches
   * could miss it without scrolling.
   */
  saveError: string | null;
  gmailContactsEnabled: boolean;
  /** TASK-2303: Google Contacts toggle (People API) */
  googleContactsEnabled: boolean;
  outlookEmailsInferred: boolean;
  /**
   * BACKLOG-3349: what the plan on record says about inferring contacts from
   * email, per provider, as the strict gate resolved it.
   *
   * REQUIRED, not optional with a default. An optional prop would let a new
   * caller — or a fixture — leave it out and silently get the permissive
   * branch, which is the one shape this gate exists to prevent. Making it
   * required means `npm run type-check:tests` names every fixture that has to
   * state it.
   */
  contactInference: ContactInferenceStates;
  gmailEmailsInferred: boolean;
  messagesInferred: boolean;
  loadingPreferences: boolean;
  onToggleSource: (category: "direct" | "inferred", key: string, currentValue: boolean) => void;
}

/**
 * Unified contacts settings: source toggles + import controls.
 * Shows toggle switches for all contact sources (persisted via Supabase)
 * and import controls for macOS Contacts and Outlook Contacts.
 */
export function ContactsImportSettings({
  userId,
  isMicrosoftConnected = false,
  isGoogleConnected = false,
  outlookContactsEnabled,
  macosContactsEnabled,
  iphoneContactsEnabled,
  showIphoneContacts,
  androidContactsEnabled,
  androidContactsDeclared,
  androidCompanionActive,
  saveError,
  gmailContactsEnabled,
  googleContactsEnabled,
  outlookEmailsInferred,
  contactInference,
  gmailEmailsInferred,
  messagesInferred,
  loadingPreferences,
  onToggleSource,
}: ContactsImportSettingsProps) {
  const { isMacOS } = usePlatform();
  const { queue, isRunning, requestSync } = useSyncOrchestrator();
  // TASK-2056: Network status for disabling Outlook sync when offline
  const { isOnline } = useNetwork();

  // Derive syncing state from orchestrator queue
  const contactsItem = queue.find(q => q.type === 'contacts');
  const isSyncing = contactsItem?.status === 'running' || contactsItem?.status === 'pending';

  // Check if another sync (not contacts) is running
  const isOtherSyncRunning = isRunning && !isSyncing;

  /**
   * NOTE (BACKLOG-2391): `inserted` / `deleted` / `total` are currently DEAD.
   * No `setLastResult` call site supplies them (see :118, :122, :155, :269 —
   * :259 discards the resolved sync result), so `lastResult.inserted` is always
   * undefined and the numeric block in the render below never draws.
   *
   * If you wire the real result through, fix the summary logic at the same time:
   * `inserted === 0 && deleted === 0` currently renders "No changes detected",
   * which became WRONG once BACKLOG-2391 made these numbers real. An
   * update-only sync (contacts edited on the Mac, none added or removed) has
   * inserted 0 and deleted 0 but is NOT "no changes" — it has a non-zero
   * `updated`, which this type does not even carry yet. Add `updated` and
   * branch on all three.
   */
  const [lastResult, setLastResult] = useState<{
    success: boolean;
    inserted?: number;
    updated?: number;
    deleted?: number;
    total?: number;
    error?: string;
  } | null>(null);
  const [syncStatus, setSyncStatus] = useState<{
    lastSyncAt?: string | null;
    contactCount?: number;
  } | null>(null);

  /**
   * BACKLOG-2404 — address-book read coverage from the last macOS sync.
   *
   * A Mac holds one address book per account. Reading 1 of 3 used to present
   * EXACTLY like reading 3 of 3: the reader isolated the failure (2392) and
   * logged "read 2 of 3", but the return value said only `success: true`, and
   * this panel discarded even that. A user whose Exchange store was locked saw
   * half her contacts, no warning, and a normal-looking sync.
   *
   * Held as `null` until a sync reports, so nothing is claimed before a read
   * has happened — "never looked" is not "found nothing".
   */
  const [readCoverage, setReadCoverage] = useState<{
    found: number;
    read: number;
    failed: number;
    coverage: "complete" | "partial" | "none";
  } | null>(null);

  // Source stats (TASK-1991)
  const [sourceStats, setSourceStats] = useState<Record<string, number> | null>(null);

  // Outlook-specific state
  const [outlookSyncing, setOutlookSyncing] = useState(false);
  const [outlookReconnectRequired, setOutlookReconnectRequired] = useState(false);
  const [outlookLastResult, setOutlookLastResult] = useState<{
    success: boolean;
    count?: number;
    error?: string;
  } | null>(null);

  // TASK-2303: Google Contacts-specific state
  const [googleSyncing, setGoogleSyncing] = useState(false);
  const [googleReconnectRequired, setGoogleReconnectRequired] = useState(false);
  const [googleLastResult, setGoogleLastResult] = useState<{
    success: boolean;
    count?: number;
    error?: string;
  } | null>(null);

  // Load sync status and source stats on mount.
  //
  // BACKLOG-3156 stage C: the connection flags are in the dependency list
  // because connecting an account inside Settings changes what this grid should
  // show — the Outlook and Google cells only render once their account is
  // connected, and they rendered against whatever `sourceStats` held from
  // mount. See the sibling effect below for the other half of that problem.
  useEffect(() => {
    if (!userId) return;
    loadSourceStats();
    if (!isMacOS) return;
    loadSyncStatus();
  }, [isMacOS, userId, isGoogleConnected, isMicrosoftConnected]);

  /**
   * BACKLOG-3156 stage C — THE COUNTS NOW HEAR THE IMPORT THAT FOLLOWS A CONNECT.
   *
   * Connecting a Google or Microsoft account triggers a contact import in the
   * main process (`postConnectContactImport.ts`, reached from
   * `googleAuthHandlers.ts` and `microsoftAuthHandlers.ts`), which finishes by
   * sending `contacts:external-sync-complete`. That import does NOT go through
   * the sync orchestrator, so the `contactsItem?.status === 'complete'` effect
   * above never fires for it, and until this subscription existed NOTHING in
   * the renderer listened to that channel at all — the send had no consumer
   * anywhere in `src/`. The grid therefore kept showing its mount-time numbers
   * until Settings was closed and reopened.
   *
   * The `typeof` guard is for test fixtures that stub `window.api.contacts`
   * with only the methods they call; it is not a claim that the bridge is
   * optional in the app. `contactsStoredNeutral-3156` renders WITH the bridge
   * present and asserts the refetch happens, so removing this subscription
   * fails there rather than passing quietly through the guard.
   */
  useEffect(() => {
    if (!userId) return;
    const subscribe = window.api?.contacts?.onExternalSyncComplete;
    if (typeof subscribe !== "function") return;
    return subscribe(() => {
      void loadSourceStats();
    });
  }, [userId]);

  // Update lastResult when contacts sync completes or errors
  useEffect(() => {
    if (contactsItem?.status === 'complete') {
      setLastResult({ success: true });
      loadSyncStatus();
      loadSourceStats();
    } else if (contactsItem?.status === 'error') {
      setLastResult({ success: false, error: safeErrorMessage(contactsItem.error) });
    }
  }, [contactsItem?.status, contactsItem?.error]);

  const loadSyncStatus = async () => {
    try {
      const result = await window.api.contacts.getExternalSyncStatus(userId);
      if (result.success) {
        setSyncStatus({
          lastSyncAt: result.lastSyncAt,
          contactCount: result.contactCount,
        });
      }
    } catch (error) {
      logger.error("Failed to load sync status:", error);
    }
  };

  /**
   * BACKLOG-3156 stage C: a failed read is now logged.
   *
   * It used to be swallowed under a comment saying the stats would "show as
   * loading". There is no loading state in this grid: when `sourceStats` stays
   * `null`, every cell renders an em-dash, which is the same thing it renders
   * for a source the database has never heard of. So a failed read was
   * indistinguishable from an empty one, on screen AND in the log.
   *
   * The em-dash is deliberately NOT replaced with `0` here. `0` would be a
   * claim that the rows were counted and there were none, which is the one
   * thing this branch knows to be untrue.
   */
  const loadSourceStats = async () => {
    try {
      const result = await window.api.contacts.getSourceStats(userId);
      if (result.success && result.stats) {
        setSourceStats(result.stats);
        return;
      }
      logger.warn(
        "[Contacts] Source stats unavailable; the counts grid will show em-dashes",
        { error: result.error },
      );
    } catch (error) {
      logger.warn("[Contacts] Source stats read threw", error);
    }
  };

  const handleSync = useCallback(
    async (_forceReimport = false) => {
      if (!userId || isSyncing || isOtherSyncRunning) return;

      setLastResult(null);

      // Request sync - orchestrator will handle it
      requestSync(['contacts'], userId);
    },
    [userId, isSyncing, isOtherSyncRunning, requestSync]
  );

  const handleOutlookSync = useCallback(async () => {
    if (!userId || outlookSyncing || isSyncing || isOtherSyncRunning || !isOnline) return;

    setOutlookSyncing(true);
    setOutlookLastResult(null);
    setOutlookReconnectRequired(false);

    try {
      const result = await window.api.contacts.syncOutlookContacts(userId);

      if (result.success) {
        setOutlookLastResult({ success: true, count: result.count });
        loadSourceStats();
      } else if (result.reconnectRequired) {
        setOutlookReconnectRequired(true);
        setOutlookLastResult(null);
      } else {
        setOutlookLastResult({ success: false, error: safeErrorMessage(result.error) });
      }
    } catch (error) {
      setOutlookLastResult({
        success: false,
        error: error instanceof Error ? error.message : "Outlook contacts sync failed",
      });
    } finally {
      setOutlookSyncing(false);
    }
  }, [userId, outlookSyncing, isSyncing, isOtherSyncRunning, isOnline]);

  // TASK-2303: Google contacts sync handler (mirrors Outlook pattern)
  const handleGoogleSync = useCallback(async () => {
    if (!userId || googleSyncing || isSyncing || isOtherSyncRunning || !isOnline) return;

    setGoogleSyncing(true);
    setGoogleLastResult(null);
    setGoogleReconnectRequired(false);

    try {
      const result = await window.api.contacts.syncGoogleContacts(userId);

      if (result.success) {
        setGoogleLastResult({ success: true, count: result.count });
        loadSourceStats();
      } else if (result.reconnectRequired) {
        setGoogleReconnectRequired(true);
        setGoogleLastResult(null);
      } else {
        setGoogleLastResult({ success: false, error: safeErrorMessage(result.error) });
      }
    } catch (error) {
      setGoogleLastResult({
        success: false,
        error: error instanceof Error ? error.message : "Google contacts sync failed",
      });
    } finally {
      setGoogleSyncing(false);
    }
  }, [userId, googleSyncing, isSyncing, isOtherSyncRunning, isOnline]);

  // Format the last sync time for display
  const formatLastSync = (lastSyncAt: string | null | undefined): string => {
    if (!lastSyncAt) return "Never synced";

    const syncDate = new Date(lastSyncAt);
    const now = new Date();
    const diffMs = now.getTime() - syncDate.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return "Just now";
    if (diffMins < 60) return `${diffMins} minute${diffMins > 1 ? "s" : ""} ago`;
    if (diffHours < 24)
      return `${diffHours} hour${diffHours > 1 ? "s" : ""} ago`;
    return `${diffDays} day${diffDays > 1 ? "s" : ""} ago`;
  };

  const hasMacOS = isMacOS;
  const hasOutlook = isMicrosoftConnected;
  const hasGoogle = isGoogleConnected;

  /*
    BACKLOG-3202 — how a connection-gated switch is DRAWN.

    These four rows used to draw their switch from the stored preference alone,
    while `disabled` came from the connection. Nothing made the two agree, so a
    stored `true` with no connection rendered a blue, checked, right-positioned
    switch beside the row's own "(not connected)" label — on a control that was
    greyed out and so could not be clicked to correct it. Screen readers got the
    worst of it, announcing "switch, checked" for a source the user had never
    connected and could not uncheck.

    Display only. `disabled`, the BACKLOG-2142 title and the value handed to
    `onToggleSource` all still read the raw preference, so a dropped connection
    writes nothing and the switch comes back on by itself when the provider
    returns.

    This is not a new rule for this file — it is the rule the file already
    applies everywhere else it consults a source. `noSourcesSelected` below ANDs
    reachability with the preference, and the stored-counts block draws a
    provider's cell only when that provider is connected. The switch was the
    last place that asked one question and displayed the answer to the other.
  */
  const outlookContactsSwitchOn = outlookContactsEnabled && hasOutlook;
  const googleContactsSwitchOn = googleContactsEnabled && hasGoogle;
  /*
    BACKLOG-3349 — the plan is a third term in the same rule BACKLOG-3202 set.

    3202's rule is: DRAW WHAT IS IN EFFECT. A stored `true` with no connection
    used to render a blue, checked switch on a control that was greyed out and
    so could not be clicked to correct it. The plan gate is the same shape — a
    stored `true` that the plan does not permit is not in effect either — so it
    joins the same expression rather than getting a rule of its own.

    `allowed` is required, not "not blocked": `unknown` and `pending` must not
    draw the switch on. Those two say the plan could not be read, and a switch
    drawn ON for a feature that will not run is the lie 3202 removed.

    The STORED PREFERENCE IS NEVER WRITTEN by any of this. If the plan turns
    back on, the user's own choice comes back untouched.
  */
  const outlookInferenceState = contactInference.outlook;
  const outlookInferenceAllowed = outlookInferenceState === "allowed";
  const outlookInferenceBlocked = outlookInferenceState === "blocked";

  const outlookEmailsSwitchOn =
    outlookEmailsInferred && hasOutlook && outlookInferenceAllowed;

  /*
    BACKLOG-1717 — the Gmail row gets the SAME plan treatment as the Outlook
    row above it, and it has to.

    Until this item, Settings showed the Outlook row greyed as "not in your
    plan" while the Gmail row beside it stayed live — which reads as "Gmail is
    included and Outlook is not", the exact opposite of the truth. They are one
    feature and one plan key, so they must look like one feature.

    `allowed` is required, not "not blocked": `unknown` and `pending` must not
    draw the switch on. The stored preference is never written by any of this.
  */
  const gmailInferenceState = contactInference.gmail;
  const gmailInferenceAllowed = gmailInferenceState === "allowed";
  const gmailInferenceBlocked = gmailInferenceState === "blocked";

  const gmailEmailsSwitchOn =
    gmailEmailsInferred && hasGoogle && gmailInferenceAllowed;

  /*
    Which of the two reasons the row is unavailable does it name?

    BLOCKED WINS over "not connected", because connecting the mailbox cannot fix
    it — sending a user to an OAuth flow that changes nothing is worse than
    telling him the plain reason.

    UNKNOWN LOSES to "not connected", the other way round, because there the
    connection IS actionable and the plan may well be fine. With the mailbox
    connected, unknown says so in its own words; it must never borrow the plan
    sentence, which would tell an entitled user something false about what he
    bought.

    PENDING gets no title at all — it lasts one IPC round trip, and a tooltip
    that flickers is noise.
  */
  const outlookEmailsTitle = outlookInferenceBlocked
    ? "Not available on your current plan"
    : !isMicrosoftConnected
      ? "Connect email to enable import"
      : outlookInferenceState === "unknown"
        ? "Can't check your plan right now"
        : undefined;

  // Same precedence as the Outlook row: blocked wins over "not connected"
  // (connecting cannot fix it), unknown loses to it (connecting may well help
  // and the plan is probably fine), pending says nothing at all.
  const gmailEmailsTitle = gmailInferenceBlocked
    ? "Not available on your current plan"
    : !isGoogleConnected
      ? "Connect email to enable import"
      : gmailInferenceState === "unknown"
        ? "Can't check your plan right now"
        : undefined;
  // BACKLOG-2486: `showIphoneContacts` counts as a source. Without it, a Windows
  // user with an iPhone and no mailbox connected hit the "no sources" placeholder
  // below and never saw the one switch that governs their only contact source.
  /**
   * BACKLOG-2986 — Android as a first-class contact source on this screen.
   *
   * Shown when the caller says the user has an Android relationship (declared
   * phone, or a stored preference) OR when `android_sync` rows actually exist.
   * The second clause is what covers the reported case: the founder's
   * `phone_type` is "iphone", he never declared Android, and 389 Android
   * contacts were sitting in `external_contacts` with this screen silent about
   * all of them.
   *
   * Deliberately NOT `count > 0` alone. A count-only gate would make the panel
   * look identical whether Android sync is working or broken — the missing
   * SIGNAL that BACKLOG-2986 calls the worse of its two defects — and would
   * hide the switch during the window after a Force Re-import, when the count
   * is legitimately 0 and the user most needs the control.
   */
  const androidContactCount = sourceStats?.android_sync ?? 0;
  const showAndroidContacts = androidContactsDeclared || androidContactCount > 0;
  // BACKLOG-2986: Android counts as a source, for the same reason BACKLOG-2486
  // added `showIphoneContacts` — a user whose only address book is the phone in
  // their pocket must not hit the "no sources" placeholder.
  const hasAnySources =
    hasMacOS || hasOutlook || hasGoogle || showIphoneContacts || showAndroidContacts;

  const anySyncing = isSyncing || outlookSyncing || googleSyncing;

  // All hooks must be declared before any early return to satisfy Rules of Hooks.
  const [forceReimporting, setForceReimporting] = useState(false);
  // BACKLOG-2388 (#95): gate the destructive-sounding Force Re-import behind an
  // explicit confirm dialog before it wipes the local cache and re-imports.
  const [showReimportConfirm, setShowReimportConfirm] = useState(false);

  // Unified import: triggers only user-selected sources
  // Fire-and-forget by design — each sync has its own loading/error state
  const handleImportAll = useCallback(async () => {
    if (anySyncing || isOtherSyncRunning) return;
    // macOS: call syncExternal directly to populate external_contacts from macOS Contacts
    if (hasMacOS && macosContactsEnabled) {
      handleSync(false);
      // BACKLOG-2404: the result was previously DISCARDED (`.then(() => …)`),
      // which is where the partial read died even after the reader learned to
      // report it. Capture the coverage so the panel can say "read 2 of 3".
      window.api.contacts.syncExternal(userId).then((result) => {
        setReadCoverage(result?.read ?? null);
        loadSourceStats();
      });
    }
    if (hasOutlook && outlookContactsEnabled) handleOutlookSync();
    if (hasGoogle && googleContactsEnabled) handleGoogleSync();
  }, [anySyncing, isOtherSyncRunning, hasMacOS, hasOutlook, hasGoogle, macosContactsEnabled, outlookContactsEnabled, googleContactsEnabled, handleSync, handleOutlookSync, handleGoogleSync, userId]);

  // Force re-import: TASK-2150 -- route through orchestrator with forceReimport option.
  // The contacts sync function handles the wipe + re-sync flow internally.
  const handleForceReimport = useCallback(async () => {
    if (anySyncing || isOtherSyncRunning || forceReimporting) return;
    setForceReimporting(true);
    setLastResult(null);

    // Route through orchestrator -- the contacts sync function handles
    // forceReimport (wipe + re-import) when the option is set.
    requestSync(['contacts'], userId, { forceReimport: true });

    // forceReimporting is for immediate UI feedback. The orchestrator
    // manages the actual running state. Clear after kick-off.
    setForceReimporting(false);
  }, [anySyncing, isOtherSyncRunning, forceReimporting, userId, requestSync]);

  const noSourcesSelected = (!hasMacOS || !macosContactsEnabled) && (!hasOutlook || !outlookContactsEnabled) && (!hasGoogle || !googleContactsEnabled);

  // Render nothing useful if no sources are available
  if (!hasAnySources) {
    return (
      <div className="p-4 bg-gray-50 rounded-lg border border-gray-200">
        <div className="flex items-center gap-2 mb-2">
          <svg
            className="w-5 h-5 text-gray-400"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"
            />
          </svg>
          <h4 className="text-sm font-medium text-gray-900">Contacts</h4>
        </div>
        <p className="text-xs text-gray-500">
          Connect a Microsoft or Google account, or use macOS to import contacts.
        </p>
      </div>
    );
  }

  return (
    /* BACKLOG-3156 stage E: THE OUTER PANEL CARD IS GONE, and so is the panel's
       icon + `<h4>Contacts</h4>` header.
       ────────────────────────────────────────────────────────────────────
       The heading repeated the section's own `<h3>Contacts</h3>` one line
       above it, and the card it opened wrapped every block — putting each
       block's eyebrow inside a card that then held a second heading. Now each
       block is its own card, eyebrow first, and the root is a plain stack.

       The panel's description was the line under that heading; it describes
       what the source switches do, so it moved into the Sources card, in the
       slot the deleted heading used to occupy. Verbatim — no copy was
       rewritten. */
    <div className="space-y-4">
      {/* BACKLOG-3156 stage E: block 1 — Sources. Contacts has no import
          preferences to set, so it has no Import Preferences block; the ORDER
          is the consistent thing across the sections, not the count. */}
      <div
        data-testid="contacts-block-sources"
        className="p-4 bg-gray-50 rounded-lg border border-gray-200"
      >
        <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">
          Sources
        </p>
        <p className="text-xs text-gray-600 mb-3">
          Manage contact sources and import contacts for transaction assignment.
        </p>

        {/*
          BACKLOG-2986: a failed preference write is visible, and visible HERE —
          directly above the switches, so the message sits next to the control
          the user just clicked. It first rendered at the top of the Contacts
          section, which put it off-screen for anyone toggling one of the lower
          switches. An error nobody sees is not much better than the silent
          failure it replaced.

          BACKLOG-3156 stage E moved it INSIDE the Sources card, still directly
          above the switches — the position the item is about — rather than
          leaving it stranded above the card they now live in.
        */}
        {saveError && (
          <div
            role="alert"
            className="mb-3 p-2 rounded text-xs bg-red-50 text-red-700 border border-red-200"
          >
            {saveError}
          </div>
        )}

        <div className="space-y-2">
          {/* Outlook Contacts toggle */}
          <div className="flex items-center justify-between py-1">
            <div className="flex items-center gap-2">
              <span className="text-sm text-gray-700">Outlook Contacts</span>
              {!isMicrosoftConnected && (
                <span className="text-xs text-gray-400">(not connected)</span>
              )}
            </div>
            <button
              onClick={() => onToggleSource("direct", "outlookContacts", outlookContactsEnabled)}
              disabled={loadingPreferences || !isMicrosoftConnected}
              // BACKLOG-2142: explain why a disabled import toggle is grayed out.
              title={!isMicrosoftConnected ? "Connect email to enable import" : undefined}
              className={`ml-4 relative inline-flex h-6 w-11 items-center rounded-full transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                outlookContactsSwitchOn ? "bg-blue-500" : "bg-gray-300"
              }`}
              role="switch"
              aria-checked={outlookContactsSwitchOn}
              aria-label="Outlook Contacts import"
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  outlookContactsSwitchOn ? "translate-x-6" : "translate-x-1"
                }`}
              />
            </button>
          </div>

          {/* TASK-2303: Google Contacts toggle */}
          <div className="flex items-center justify-between py-1">
            <div className="flex items-center gap-2">
              <span className="text-sm text-gray-700">Google Contacts</span>
              {!isGoogleConnected && (
                <span className="text-xs text-gray-400">(not connected)</span>
              )}
            </div>
            <button
              onClick={() => onToggleSource("direct", "googleContacts", googleContactsEnabled)}
              disabled={loadingPreferences || !isGoogleConnected}
              // BACKLOG-2142: explain why a disabled import toggle is grayed out.
              title={!isGoogleConnected ? "Connect email to enable import" : undefined}
              className={`ml-4 relative inline-flex h-6 w-11 items-center rounded-full transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                googleContactsSwitchOn ? "bg-blue-500" : "bg-gray-300"
              }`}
              role="switch"
              aria-checked={googleContactsSwitchOn}
              aria-label="Google Contacts import"
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  googleContactsSwitchOn ? "translate-x-6" : "translate-x-1"
                }`}
              />
            </button>
          </div>

          {/*
            macOS Contacts toggle.

            BACKLOG-2486: this was labelled "macOS / iPhone Contacts" and wrote
            ONLY `macosContacts`. The label named two sources and controlled one.
            That was survivable while the backend OR'd the two keys together;
            now that each source answers to its own preference, a switch called
            "iPhone" that does not move the iPhone gate is simply untrue. Renamed
            to what it actually controls, with iPhone given its own switch below.
          */}
          {isMacOS && (
            <div className="flex items-center justify-between py-1">
              <div className="flex items-center gap-2">
                <span className="text-sm text-gray-700">macOS Contacts</span>
              </div>
              <button
                onClick={() => onToggleSource("direct", "macosContacts", macosContactsEnabled)}
                disabled={loadingPreferences}
                className={`ml-4 relative inline-flex h-6 w-11 items-center rounded-full transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                  macosContactsEnabled ? "bg-blue-500" : "bg-gray-300"
                }`}
                role="switch"
                aria-checked={macosContactsEnabled}
                aria-label="macOS Contacts import"
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                    macosContactsEnabled ? "translate-x-6" : "translate-x-1"
                  }`}
                />
              </button>
            </div>
          )}

          {/*
            BACKLOG-2486: iPhone Contacts, previously settable ONLY during
            onboarding. Rendered on both platforms — on Windows it is the only
            gate for iPhone records, and on macOS it defaults OFF, so without a
            control here a user could not undo that default.
          */}
          {showIphoneContacts && (
            <div className="flex items-center justify-between py-1">
              <div className="flex flex-col">
                <span className="text-sm text-gray-700">iPhone Contacts</span>
                {isMacOS && !iphoneContactsEnabled && (
                  <span className="text-xs text-gray-400">
                    Your Mac address book already includes iPhone contacts synced through
                    iCloud. Turn this on if you have iCloud contact syncing switched off.
                  </span>
                )}
              </div>
              <button
                onClick={() => onToggleSource("direct", "iphoneContacts", iphoneContactsEnabled)}
                disabled={loadingPreferences}
                className={`ml-4 shrink-0 relative inline-flex h-6 w-11 items-center rounded-full transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                  iphoneContactsEnabled ? "bg-blue-500" : "bg-gray-300"
                }`}
                role="switch"
                aria-checked={iphoneContactsEnabled}
                aria-label="iPhone Contacts import"
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                    iphoneContactsEnabled ? "translate-x-6" : "translate-x-1"
                  }`}
                />
              </button>
            </div>
          )}

          {/*
            BACKLOG-2986: Android Phone Contacts.

            The preference existed and the backend honoured it
            (`contactHandlers.ts` gates `android_sync` rows on it by name since
            BACKLOG-2478), but onboarding was its ONLY writer — and only for a
            user who declared an Android phone. So a user whose Android contacts
            were importing had no control anywhere that could stop them. That,
            plus an absent key reading as `true`, is BACKLOG-2986.
          */}
          {showAndroidContacts && (
            <div className="flex items-center justify-between py-1">
              <div className="flex flex-col">
                <span className="text-sm text-gray-700">Android Phone Contacts</span>
                <span className="text-xs text-gray-400">
                  Contacts pushed from the Keepr Companion app on your Android phone.
                </span>
              </div>
              <button
                onClick={() => onToggleSource("direct", "androidContacts", androidContactsEnabled)}
                disabled={loadingPreferences}
                className={`ml-4 shrink-0 relative inline-flex h-6 w-11 items-center rounded-full transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                  androidContactsEnabled ? "bg-blue-500" : "bg-gray-300"
                }`}
                role="switch"
                aria-checked={androidContactsEnabled}
                aria-label="Android Phone Contacts import"
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                    androidContactsEnabled ? "translate-x-6" : "translate-x-1"
                  }`}
                />
              </button>
            </div>
          )}
        </div>
      </div>

      {/* BACKLOG-3156 stage E: `Auto-discover from conversations` is its OWN
          block now. It was a second eyebrow inside the Sources block, which the
          shared shape does not allow: one eyebrow per card, and it is that
          card's first child. */}
      <div
        data-testid="contacts-block-autodiscover"
        className="p-4 bg-gray-50 rounded-lg border border-gray-200"
      >
        <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">
          Auto-discover from conversations
        </p>
        <div className="space-y-2">
          {/* Outlook emails toggle */}
          <div className="flex items-center justify-between py-1">
            <div className="flex items-center gap-2">
              <span className="text-sm text-gray-700">Outlook emails</span>
              {/* BACKLOG-3349: one reason at a time, in the row's existing
                  inline-label slot. The plan reason replaces the connection
                  reason rather than sitting beside it. */}
              {outlookInferenceBlocked ? (
                <span className="text-xs text-gray-400">(not in your plan)</span>
              ) : !isMicrosoftConnected ? (
                <span className="text-xs text-gray-400">(not connected)</span>
              ) : null}
            </div>
            <button
              onClick={() => onToggleSource("inferred", "outlookEmails", outlookEmailsInferred)}
              // BACKLOG-3349: the plan gate disables the control as firmly as a
              // missing connection does. Main decides either way — this only
              // stops the user clicking something that cannot take effect.
              disabled={loadingPreferences || !isMicrosoftConnected || !outlookInferenceAllowed}
              // BACKLOG-2142: explain why a disabled import toggle is grayed out.
              title={outlookEmailsTitle}
              className={`ml-4 relative inline-flex h-6 w-11 items-center rounded-full transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                outlookEmailsSwitchOn ? "bg-blue-500" : "bg-gray-300"
              }`}
              role="switch"
              aria-checked={outlookEmailsSwitchOn}
              aria-label="Outlook emails auto-discover"
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  outlookEmailsSwitchOn ? "translate-x-6" : "translate-x-1"
                }`}
              />
            </button>
          </div>

          {/* Gmail emails toggle */}
          <div className="flex items-center justify-between py-1">
            <div className="flex items-center gap-2">
              <span className="text-sm text-gray-700">Gmail emails</span>
              {/* BACKLOG-1717: one reason at a time, the plan reason replacing
                  the connection reason — the same rule as the Outlook row. */}
              {gmailInferenceBlocked ? (
                <span className="text-xs text-gray-400">(not in your plan)</span>
              ) : !isGoogleConnected ? (
                <span className="text-xs text-gray-400">(not connected)</span>
              ) : null}
            </div>
            <button
              onClick={() => onToggleSource("inferred", "gmailEmails", gmailEmailsInferred)}
              // BACKLOG-1717: the plan gate disables the control as firmly as a
              // missing connection does. Main decides either way.
              disabled={loadingPreferences || !isGoogleConnected || !gmailInferenceAllowed}
              // BACKLOG-2142: explain why a disabled import toggle is grayed out.
              title={gmailEmailsTitle}
              className={`ml-4 relative inline-flex h-6 w-11 items-center rounded-full transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                gmailEmailsSwitchOn ? "bg-blue-500" : "bg-gray-300"
              }`}
              role="switch"
              aria-checked={gmailEmailsSwitchOn}
              aria-label="Gmail emails auto-discover"
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  gmailEmailsSwitchOn ? "translate-x-6" : "translate-x-1"
                }`}
              />
            </button>
          </div>

          {/* Messages/SMS toggle */}
          <div className="flex items-center justify-between py-1">
            <div className="flex items-center gap-2">
              <span className="text-sm text-gray-700">Messages / SMS</span>
            </div>
            <button
              onClick={() => onToggleSource("inferred", "messages", messagesInferred)}
              disabled={loadingPreferences}
              className={`ml-4 relative inline-flex h-6 w-11 items-center rounded-full transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                messagesInferred ? "bg-blue-500" : "bg-gray-300"
              }`}
              role="switch"
              aria-checked={messagesInferred}
              aria-label="Messages SMS auto-discover"
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  messagesInferred ? "translate-x-6" : "translate-x-1"
                }`}
              />
            </button>
          </div>
        </div>
      </div>

      {/* BACKLOG-3156 stage E: the divider that used to sit here is gone. It
          separated two stretches of one card; the blocks are separate cards
          now, so the gap between them draws the same rule. */}

      {/* Sync status (macOS) */}
      {hasMacOS && macosContactsEnabled && syncStatus && (
        <div className="mb-3 text-xs text-gray-500">
          Last synced: {formatLastSync(syncStatus.lastSyncAt)}
          {syncStatus.contactCount !== undefined && (
            <> | {syncStatus.contactCount.toLocaleString()} contacts</>
          )}
        </div>
      )}

      {/*
        BACKLOG-2404: a partial read, said out loud.

        Rendered ONLY when a book actually failed — a complete read adds no
        line, so this cannot become noise the user learns to scroll past. The
        wording leads with what happened ("read 2 of 3 address books") rather
        than with a permission to go grant, because the two failure phases have
        different remedies and the panel does not know which one this was.
      */}
      {hasMacOS && macosContactsEnabled && readCoverage && readCoverage.failed > 0 && (
        <div
          data-testid="contacts-partial-read-warning"
          className="mb-3 p-2 rounded text-xs bg-amber-50 text-amber-800 border border-amber-200"
        >
          Read {readCoverage.read} of {readCoverage.found} address books.{" "}
          {readCoverage.failed === 1 ? "One" : readCoverage.failed} could not be
          opened, so some contacts may be missing.
        </div>
      )}

      {/* BACKLOG-3156 stage E: block 3 — Stored on this computer. The grid
          itself is unchanged; the block is now its own card with the eyebrow as
          that card's first child, like every other block on these screens. */}
      <div
        data-testid="contacts-block-stored"
        className="p-4 bg-gray-50 rounded-lg border border-gray-200"
      >
      <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">
        Stored on this computer
      </p>
      {/* Source stats grid (read-only indicators) */}
      <div className="grid grid-cols-3 gap-2 text-center">
        {isMacOS && (
          <div className={macosContactsEnabled ? STORED_CELL.on : STORED_CELL.off}>
            <div className={macosContactsEnabled ? STORED_CELL.countOn : STORED_CELL.countOff}>
              {sourceStats?.macos?.toLocaleString() ?? "—"}
            </div>
            <div className={macosContactsEnabled ? STORED_CELL.labelOn : STORED_CELL.labelOff}>macOS</div>
          </div>
        )}
        {sourceStats && sourceStats.iphone > 0 && (
          <div className={STORED_CELL.on}>
            <div className={STORED_CELL.countOn}>{sourceStats.iphone.toLocaleString()}</div>
            <div className={STORED_CELL.labelOn}>iPhone</div>
          </div>
        )}
        {isMicrosoftConnected && (
          <div className={outlookContactsEnabled ? STORED_CELL.on : STORED_CELL.off}>
            <div className={outlookContactsEnabled ? STORED_CELL.countOn : STORED_CELL.countOff}>
              {sourceStats?.outlook?.toLocaleString() ?? "—"}
            </div>
            <div className={outlookContactsEnabled ? STORED_CELL.labelOn : STORED_CELL.labelOff}>Outlook</div>
          </div>
        )}
        {isGoogleConnected && (
          <div className={googleContactsEnabled ? STORED_CELL.on : STORED_CELL.off}>
            <div className={googleContactsEnabled ? STORED_CELL.countOn : STORED_CELL.countOff}>
              {sourceStats?.google_contacts?.toLocaleString() ?? "—"}
            </div>
            <div className={googleContactsEnabled ? STORED_CELL.labelOn : STORED_CELL.labelOff}>Google</div>
          </div>
        )}
        {/*
          BACKLOG-2986 — the Android cell.

          WHICH NUMBER THIS IS: `android_sync` rows in `external_contacts`, the
          same `getContactSourceStats` GROUP BY every other cell in this grid
          reads. On the founder's machine that is 389. It is NOT the 26 from
          "Promoted 26 Android contacts to main contacts table" — that is a
          `promoteToMainContacts` result, a different quantity, and no cell here
          shows a promotion count for any source. Putting 26 in this cell would
          make it the only cell in the row that means something else.

          `getContactSourceStats` already seeds and returns the `android_sync`
          key, so nothing behind this needed to change — the grid was simply not
          asking.
        */}
        {showAndroidContacts && (
          <div className={androidContactsEnabled ? STORED_CELL.on : STORED_CELL.off}>
            <div className={androidContactsEnabled ? STORED_CELL.countOn : STORED_CELL.countOff}>
              {sourceStats?.android_sync?.toLocaleString() ?? "—"}
            </div>
            <div className={androidContactsEnabled ? STORED_CELL.labelOn : STORED_CELL.labelOff}>Android</div>
          </div>
        )}
      </div>

      </div>

      {/*
        BACKLOG-2986 — where the Android re-import lives, said on the screen
        that owns contact sources.

        THIS IS A POINTER, NOT A SECOND DESTROYER, and that is deliberate. The
        DECISION on BACKLOG-3001 rules that Android is push-only: the desktop
        cannot re-fetch it, so no operation may treat it as re-fetchable. The
        companion sends a DIFF, not a full snapshot (`storeContacts(...,
        isFullSync)` is decided by the phone; BACKLOG-2411 is still open), so
        deleting `android_sync` contacts from here and waiting for the next sync
        would NOT bring them back. The one flow that does work — clear plus
        `stopServer`, so the phone re-sends from scratch — also deletes MESSAGES,
        which is not a thing a button on the Contacts screen should do.

        So this says where the working control is, and only offers to take the
        user there when that control is actually rendered.
      */}
      {showAndroidContacts && (
        <div className="mb-3 p-2 rounded text-xs bg-gray-50 text-gray-600 border border-gray-200">
          <p>
            Your phone holds the only copy of these contacts — the desktop cannot fetch
            them again on its own.
            {androidCompanionActive
              ? " Re-importing clears the synced messages and contacts together, then the companion app re-sends both."
              : " Set your message import source to Android above to manage or re-import them."}
          </p>
          {androidCompanionActive && (
            <button
              type="button"
              onClick={() =>
                document
                  .getElementById("settings-android-companion")
                  ?.scrollIntoView({ behavior: "smooth", block: "start" })
              }
              className="mt-1 text-xs font-medium text-blue-600 hover:text-blue-700 underline"
            >
              Go to Android Companion re-import
            </button>
          )}
        </div>
      )}

      {/* Offline warning for Outlook contacts */}
      {!isOnline && hasOutlook && outlookContactsEnabled && (
        <div className="mb-3 p-2 rounded text-xs bg-yellow-50 text-yellow-700 border border-yellow-200">
          You are offline. Outlook contacts sync is unavailable.
        </div>
      )}

      {/* Offline warning for Google contacts */}
      {!isOnline && hasGoogle && googleContactsEnabled && (
        <div className="mb-3 p-2 rounded text-xs bg-yellow-50 text-yellow-700 border border-yellow-200">
          You are offline. Google contacts sync is unavailable.
        </div>
      )}

      {/* Reconnect required warning (Outlook) */}
      {outlookReconnectRequired && (
        <div className="mb-3 p-2 rounded text-xs bg-yellow-50 text-yellow-700 border border-yellow-200">
          Please disconnect and reconnect your Microsoft mailbox to grant contact access.
        </div>
      )}

      {/* TASK-2303: Reconnect required warning (Google) */}
      {googleReconnectRequired && (
        <div className="mb-3 p-2 rounded text-xs bg-yellow-50 text-yellow-700 border border-yellow-200">
          Please disconnect and reconnect your Google mailbox to grant contacts access. The contacts.readonly scope is required.
        </div>
      )}

      {/* Show message if another sync is running */}
      {isOtherSyncRunning && !anySyncing && (
        <div className="mb-3 p-2 rounded text-xs bg-yellow-50 text-yellow-700 border border-yellow-200">
          Another sync is in progress. Contacts will sync when it completes.
        </div>
      )}

      {/* macOS sync result */}
      {lastResult && !isSyncing && !isOtherSyncRunning && (
        <div
          className={`mb-3 p-2 rounded text-xs ${
            lastResult.success
              ? "bg-green-50 text-green-700 border border-green-200"
              : "bg-red-50 text-red-700 border border-red-200"
          }`}
        >
          {lastResult.success ? (
            <>
              {hasMacOS && "macOS contacts synced. "}
              {formatContactSyncCounts({
                inserted: lastResult.inserted,
                updated: lastResult.updated,
                deleted: lastResult.deleted,
                total: lastResult.total,
              })}
            </>
          ) : (
            <>Sync failed: {safeErrorMessage(lastResult.error)}</>
          )}
        </div>
      )}

      {/* Outlook sync result */}
      {outlookLastResult && !outlookSyncing && (
        <div
          className={`mb-3 p-2 rounded text-xs ${
            outlookLastResult.success
              ? "bg-green-50 text-green-700 border border-green-200"
              : "bg-red-50 text-red-700 border border-red-200"
          }`}
        >
          {outlookLastResult.success ? (
            <>
              Outlook contacts synced.{" "}
              {formatContactSyncCounts({ imported: outlookLastResult.count })}
            </>
          ) : (
            <>Outlook sync failed: {safeErrorMessage(outlookLastResult.error)}</>
          )}
        </div>
      )}

      {/* TASK-2303: Google sync result */}
      {googleLastResult && !googleSyncing && (
        <div
          className={`mb-3 p-2 rounded text-xs ${
            googleLastResult.success
              ? "bg-green-50 text-green-700 border border-green-200"
              : "bg-red-50 text-red-700 border border-red-200"
          }`}
        >
          {googleLastResult.success ? (
            <>
              Google contacts synced.{" "}
              {formatContactSyncCounts({ imported: googleLastResult.count })}
            </>
          ) : (
            <>Google sync failed: {safeErrorMessage(googleLastResult.error)}</>
          )}
        </div>
      )}

      {/* BACKLOG-3156 stage A: block 4 — the actions, BARE on the page. No
          surrounding card and no heading; primary then destructive. Neither
          `disabled` expression changed. */}
      <div data-testid="contacts-block-actions" className="flex gap-2 items-center">
        <button
          onClick={handleImportAll}
          disabled={anySyncing || isOtherSyncRunning || noSourcesSelected}
          className="flex-1 px-3 py-2 bg-blue-500 hover:bg-blue-600 text-white text-sm font-medium rounded transition-all disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {anySyncing ? "Syncing..." : isOtherSyncRunning ? "Sync in Progress..." : noSourcesSelected ? "Select a Source" : "Import Contacts"}
        </button>
        <button
          onClick={() => setShowReimportConfirm(true)}
          disabled={anySyncing || isOtherSyncRunning || noSourcesSelected || forceReimporting}
          className="px-3 py-2 bg-gray-200 hover:bg-gray-300 text-gray-700 text-sm font-medium rounded transition-all disabled:opacity-50 disabled:cursor-not-allowed"
          title="Clear and download again the contacts Keepr can fetch itself — your Contacts app, Outlook and Google. Contacts synced from your phone are left alone."
        >
          {forceReimporting ? "Clearing..." : "Force Re-import"}
        </button>
        {/* BACKLOG-3156 stage B: the `?`, now the shared `ImportInfoPopover`.
            The copy below is TODAY'S, unchanged — it was already accurate, and
            BACKLOG-3029 is the reason it reads the way it does: it states the
            RULE ("the sources you have switched on") instead of naming them,
            because a list derived from this component's connectedness flags
            disagrees with what the orchestrator actually empties. */}
        <ImportInfoPopover
          testId="contacts-import-info"
          entries={[
            {
              heading: "Import Contacts",
              body: "Adds new contacts, updates existing ones, and removes contacts deleted from the source.",
            },
            {
              heading: "Force Re-import",
              body: "Clears the copy stored on this computer for the sources you have switched on, and downloads them again. Contacts synced from your phone are left alone — only the phone can send those. Use if contacts look out of sync.",
            },
          ]}
        />
      </div>

      {/*
        BACKLOG-2388 (#95): Force Re-import confirmation. This path clears only
        the locally cached copy (external_contacts) and re-imports from enabled
        sources — it does NOT delete manually-added contacts and does NOT unlink
        transaction-attached contacts, so the copy makes no unlink claim (unlike
        the Messages force re-import, which does cascade). Reuses the app's
        shared ResponsiveModal confirm pattern.

        BACKLOG-3029 — THIS COPY IS A CLAIM ABOUT BEHAVIOUR, AND IT WENT FALSE.
        Three strings here (this dialog, the button tooltip, the info popover)
        all said the re-import clears EVERY source. That stopped being true when
        the wipe was scoped to the sources that will actually be refilled, and
        nothing caught the drift — no test read any of them.

        The dialog was also wrong before that change: it listed "Messages",
        which is not a contact source, and omitted the phone entirely.

        DO NOT LIST THE SOURCES BY DERIVING THEM FROM THIS COMPONENT'S FLAGS.
        It gates on connectedness (`hasOutlook = isMicrosoftConnected`) while
        the orchestrator gates only on the preference, so a derived list can
        disagree with what is actually emptied — a second way to be false. The
        copy therefore states the RULE, which holds whatever the state is.

        `MacOSContactsImportSettings.reimportCopy-3029.test.tsx` pins the two
        claims that were false rather than the prose, so the wording stays free
        to change and the falsehoods cannot come back.
      */}
      {showReimportConfirm && (
        <ResponsiveModal
          onClose={() => setShowReimportConfirm(false)}
          zIndex="z-[70]"
          panelClassName="max-w-md p-6"
          testId="contacts-force-reimport-confirm-modal"
        >
          <div className="flex items-center gap-3 mb-3">
            <div className="w-12 h-12 rounded-full bg-blue-100 flex items-center justify-center flex-shrink-0">
              <svg
                className="w-6 h-6 text-blue-600"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                />
              </svg>
            </div>
            <h3 className="text-lg font-bold text-gray-900">
              Re-import contacts?
            </h3>
          </div>
          <p className="text-sm text-gray-600 mb-3">
            This clears the copy stored on this computer for the sources you have
            switched on — your Contacts app, Outlook and Google — and downloads
            them again.
          </p>
          <p className="text-sm text-gray-600 mb-6">
            Contacts synced from your phone stay as they are. Only the phone can
            send those, so clearing them here would leave you without them until
            you paired it again. Contacts you added yourself or attached to a
            transaction are kept too.
          </p>
          <div className="flex items-center gap-3 justify-end">
            <button
              onClick={() => setShowReimportConfirm(false)}
              className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg font-medium transition-all"
            >
              Cancel
            </button>
            <button
              onClick={() => {
                setShowReimportConfirm(false);
                handleForceReimport();
              }}
              data-testid="contacts-force-reimport-confirm"
              className="px-4 py-2 bg-blue-600 text-white hover:bg-blue-700 rounded-lg font-semibold transition-all"
            >
              Re-import
            </button>
          </div>
        </ResponsiveModal>
      )}

      {/* Loading indicators */}
      {isSyncing && (
        <div className="mt-3 flex items-center gap-2 text-sm text-gray-500">
          <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
          Syncing contacts from macOS...
        </div>
      )}
      {outlookSyncing && (
        <div className="mt-3 flex items-center gap-2 text-sm text-gray-500">
          <div className="w-4 h-4 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
          Syncing contacts from Outlook...
        </div>
      )}
      {googleSyncing && (
        <div className="mt-3 flex items-center gap-2 text-sm text-gray-500">
          <div className="w-4 h-4 border-2 border-green-500 border-t-transparent rounded-full animate-spin" />
          Syncing contacts from Google...
        </div>
      )}
    </div>
  );
}

// Backward-compatible named export
export { ContactsImportSettings as MacOSContactsImportSettings };

export default ContactsImportSettings;
