/**
 * Android's ONE Force re-import confirmation (BACKLOG-3657; founder
 * re-confirmed 2026-10-01): shown by both Android sections (Google Messages
 * and Android Companion), because either one clears both Android sources.
 * iPhone and Mac have their own Force re-imports and are not touched.
 */

import React from "react";
import { lastMonthsPhrase } from "./LookbackMonthsSelect";

export const ANDROID_FORCE_REIMPORT_TITLE =
  "Force re-import will delete every text imported from your Android phone (Google Messages and Android Companion)";
/** SR (C6 review): the title when no Android Companion data exists. */
export const ANDROID_FORCE_REIMPORT_TITLE_GM = "Force re-import will delete every text imported from Google Messages";

interface AndroidForceReimportWarningProps {
  onConfirm: () => void;
  onCancel: () => void;
  /**
   * SR (2026-10-02): the window the next Sync copies back (this section's
   * months setting; null = All time). Everything is deleted first, so texts
   * older than it are not copied back unless an audit period covers them.
   */
  windowMonths: number | null;
  /**
   * SR (C6 review): the Android Companion's data exists — only then is it
   * named (like androidClearedText). Default: named (the Companion panel).
   */
  companion?: boolean;
}

/** The line every Android Force dialog states. */
export function androidForceWindowLine(months: number | null): string {
  return months === null
    ? "Syncing again copies all your texts back."
    : `Syncing again copies texts from ${lastMonthsPhrase(months)}; older texts not in an audit period are not copied back.`;
}

export function AndroidForceReimportWarning({ onConfirm, onCancel, windowMonths, companion = true }: AndroidForceReimportWarningProps) {
  return (
    <div className="p-3 bg-amber-50 border border-amber-300 rounded-lg" data-testid="android-force-warning">
      <p className="text-sm font-medium text-amber-800">{companion ? ANDROID_FORCE_REIMPORT_TITLE : ANDROID_FORCE_REIMPORT_TITLE_GM}</p>
      {companion ? (
        <p className="text-xs text-amber-800 mt-1">
          This deletes every text, reaction and image Keepr copied from Google Messages, and every text and contact the
          Android Companion app sent, with their links to transactions. Links from checklist items to those
          messages&rsquo; attachments are removed too. Your iPhone and Mac texts stay. To import them again, click Sync Android on
          the dashboard, or open the companion app and tap Sync Now. Chats you removed from a transaction stay removed
          when you sync again; you can restore them from &ldquo;Show removed&rdquo; on the transaction.
        </p>
      ) : (
        <p className="text-xs text-amber-800 mt-1" data-testid="android-force-body-gm">
          This deletes every text, reaction and image Keepr copied from Google Messages, with their links to
          transactions and checklist items. Your iPhone and Mac texts stay. Chats you removed from a transaction stay
          removed when you sync again; you can restore them from &ldquo;Show removed&rdquo; on the transaction.
        </p>
      )}
      <p className="text-xs font-medium text-amber-900 mt-1" data-testid="force-window-line">
        {androidForceWindowLine(windowMonths)}
      </p>
      <div className="flex gap-2 mt-2">
        <button
          type="button"
          onClick={onConfirm}
          className="px-3 py-1.5 bg-amber-600 hover:bg-amber-700 text-white text-xs font-medium rounded transition-all"
        >
          Continue with Re-import
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="px-3 py-1.5 bg-white hover:bg-gray-100 text-gray-700 text-xs font-medium rounded border border-gray-300 transition-all"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * The line after a shared Android clear (founder, minimal copy): "Cleared
 * 8,344 texts. Sync Android on the dashboard to get them back." The Android
 * Companion (and its Sync Now) is named ONLY when it actually cleared texts
 * or contacts.
 */
export function androidClearedText(r: { gmwebMessages: number; companionMessages: number; contacts: number }): string {
  if (r.companionMessages <= 0 && r.contacts <= 0) {
    return `Cleared ${r.gmwebMessages.toLocaleString()} texts. Sync Android on the dashboard to get them back.`;
  }
  const texts = (r.gmwebMessages + r.companionMessages).toLocaleString();
  const contacts = r.contacts > 0 ? ` and ${r.contacts.toLocaleString()} ${r.contacts === 1 ? "contact" : "contacts"}` : "";
  return `Cleared ${texts} texts${contacts}. Sync Android on the dashboard, or Sync Now in the Android Companion, to get them back.`;
}
