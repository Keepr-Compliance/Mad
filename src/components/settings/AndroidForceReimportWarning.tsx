/**
 * Android's ONE Force re-import confirmation (BACKLOG-3657; founder
 * re-confirmed 2026-10-01): shown by both Android sections (Google Messages
 * and Android Companion), because either one clears both Android sources.
 * iPhone and Mac have their own Force re-imports and are not touched.
 */

import React from "react";

export const ANDROID_FORCE_REIMPORT_TITLE =
  "Force re-import will delete every text imported from your Android phone (Google Messages and Android Companion)";

interface AndroidForceReimportWarningProps {
  onConfirm: () => void;
  onCancel: () => void;
}

export function AndroidForceReimportWarning({ onConfirm, onCancel }: AndroidForceReimportWarningProps) {
  return (
    <div className="p-3 bg-amber-50 border border-amber-300 rounded-lg" data-testid="android-force-warning">
      <p className="text-sm font-medium text-amber-800">{ANDROID_FORCE_REIMPORT_TITLE}</p>
      <p className="text-xs text-amber-800 mt-1">
        This deletes every text, reaction and image Keepr copied from Google Messages, and every text and contact the
        Android Companion app sent, with their links to transactions. Links from checklist items to those
        messages&rsquo; attachments are removed too. Your iPhone and Mac texts stay. To import them again, click Sync Android on
        the dashboard, or open the companion app and tap Sync Now. Chats you removed from a transaction stay removed
        when you sync again; you can restore them from &ldquo;Show removed&rdquo; on the transaction.
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

/** The line after a shared Android clear. */
export function androidClearedText(r: { gmwebMessages: number; companionMessages: number; contacts: number }): string {
  return (
    `Cleared ${r.gmwebMessages.toLocaleString()} texts imported from Google Messages and ` +
    `${r.companionMessages.toLocaleString()} texts and ${r.contacts.toLocaleString()} contacts from the Android Companion. ` +
    "Click Sync Android on the dashboard (or Sync Now in the companion app) to import them again."
  );
}
