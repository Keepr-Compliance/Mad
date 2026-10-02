/**
 * Settings → Google Messages → "N chats not synced · Manage" (founder,
 * 2026-10-02): the chats switched off with the eye in Google Messages, in a
 * modal instead of an inline list that would fill the page.
 *
 * Search (by the stored title), a scrollable list, "Sync again" per row and
 * "Sync all again" (after a confirmation) in the footer. The keyboard
 * alternative to the page's eye: every control is a button or an input in
 * tab order, Escape closes, the search box takes focus on open.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import { ResponsiveModal } from "../../common/ResponsiveModal";

export const NOT_SYNCED_FALLBACK_TITLE = "A chat you switched off in Google Messages";

interface NotSyncedChatsModalProps {
  chats: ReadonlyArray<{ id: string; title: string | null }>;
  onSyncAgain: (id: string) => void | Promise<void>;
  onSyncAllAgain: () => void | Promise<void>;
  onClose: () => void;
}

export function NotSyncedChatsModal({ chats, onSyncAgain, onSyncAllAgain, onClose }: NotSyncedChatsModalProps) {
  const [query, setQuery] = useState("");
  const [confirmAll, setConfirmAll] = useState(false);
  /** Live (0.3.15): after Sync again, say when it happens (the next Sync reads the chat in full). */
  const [notice, setNotice] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return chats;
    const digits = q.replace(/\D/g, "");
    return chats.filter((c) => {
      const title = (c.title ?? "").toLowerCase();
      if (title.includes(q)) return true;
      return digits.length >= 3 && title.replace(/\D/g, "").includes(digits);
    });
  }, [chats, query]);

  return (
    <ResponsiveModal onClose={onClose} zIndex="z-[70]" panelClassName="max-w-lg sm:max-h-[80vh] flex flex-col" testId="gm-not-synced-modal">
      <div
        className="flex flex-col min-h-0 h-full"
        role="dialog"
        aria-modal="true"
        aria-labelledby="gm-not-synced-title"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <div className="flex items-center justify-between px-4 pt-4 pb-2">
          <h2 id="gm-not-synced-title" className="text-base font-semibold text-gray-900">
            {chats.length} chat{chats.length === 1 ? "" : "s"} not synced
          </h2>
          <button type="button" className="text-sm text-gray-600 hover:text-gray-900" onClick={onClose} aria-label="Close">
            Close
          </button>
        </div>
        <div className="px-4 pb-2">
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search chats"
            aria-label="Search chats not synced"
            className="w-full min-h-[40px] px-3 rounded-lg border border-gray-300 text-sm text-gray-900"
          />
        </div>
        <ul className="flex-1 min-h-0 overflow-y-auto px-4 divide-y divide-gray-100" data-testid="gm-not-synced-list">
          {shown.map((c) => (
            <li key={c.id} className="flex items-center justify-between gap-3 py-2 text-sm text-gray-800">
              <span className="min-w-0 truncate">{c.title ?? NOT_SYNCED_FALLBACK_TITLE}</span>
              <button
                type="button"
                className="shrink-0 text-indigo-700 hover:text-indigo-900 text-xs font-medium min-h-[32px] px-2"
                onClick={() => {
                  setNotice(`${c.title ?? NOT_SYNCED_FALLBACK_TITLE}: will sync on the next Sync.`);
                  void onSyncAgain(c.id);
                }}
              >
                Sync again
              </button>
            </li>
          ))}
          {shown.length === 0 && <li className="py-3 text-sm text-gray-600">No chat matches.</li>}
        </ul>
        {notice && (
          <p className="px-4 py-2 text-xs text-indigo-800 bg-indigo-50" role="status" data-testid="gm-not-synced-notice">
            {notice}
          </p>
        )}
        <div className="px-4 py-3 border-t border-gray-200">
          {!confirmAll ? (
            <button
              type="button"
              className="text-sm font-medium text-indigo-700 hover:text-indigo-900"
              onClick={() => setConfirmAll(true)}
            >
              Sync all again
            </button>
          ) : (
            <div className="p-2 rounded border border-amber-300 bg-amber-50 text-xs text-amber-800" role="alert">
              New messages from all {chats.length} chats will be synced again from the next Sync.
              <div className="flex gap-2 mt-2">
                <button
                  type="button"
                  className="px-2 py-1 rounded bg-amber-600 text-white font-medium"
                  onClick={() => {
                    setConfirmAll(false);
                    setNotice("Every chat will sync on the next Sync.");
                    void onSyncAllAgain();
                  }}
                >
                  Sync all again
                </button>
                <button
                  type="button"
                  className="px-2 py-1 rounded border border-gray-300 bg-white text-gray-700"
                  onClick={() => setConfirmAll(false)}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </ResponsiveModal>
  );
}
