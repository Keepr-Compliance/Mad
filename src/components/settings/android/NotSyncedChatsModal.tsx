/**
 * Settings → Google Messages → "N chats not synced · Manage" (founder,
 * 2026-10-02): the chats switched off with the eye in Google Messages, in a
 * modal instead of an inline list that would fill the page.
 *
 * READ-ONLY (founder, 2026-10-02): the eye in Google Messages is the only
 * control that switches a chat off or on. This lists them — search (by the
 * stored title) and a scrollable list — with the hint to use the eye. Escape
 * closes; the search box takes focus on open.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import { ResponsiveModal } from "../../common/ResponsiveModal";

export const NOT_SYNCED_FALLBACK_TITLE = "A chat you switched off in Google Messages";

export const NOT_SYNCED_EYE_HINT = "To sync a chat again, click the eye next to it in Google Messages.";

interface NotSyncedChatsModalProps {
  chats: ReadonlyArray<{ id: string; title: string | null }>;
  onClose: () => void;
}

export function NotSyncedChatsModal({ chats, onClose }: NotSyncedChatsModalProps) {
  const [query, setQuery] = useState("");
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
            <li key={c.id} className="py-2 text-sm text-gray-800 truncate">
              {c.title ?? NOT_SYNCED_FALLBACK_TITLE}
            </li>
          ))}
          {shown.length === 0 && <li className="py-3 text-sm text-gray-600">No chat matches.</li>}
        </ul>
        <p className="px-4 py-3 border-t border-gray-200 text-xs text-gray-700" data-testid="gm-not-synced-hint">
          {NOT_SYNCED_EYE_HINT}
        </p>
      </div>
    </ResponsiveModal>
  );
}
