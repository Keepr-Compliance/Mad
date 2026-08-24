/**
 * useResolvedContactNames (BACKLOG-2791)
 *
 * Handle -> contact-name lookup for text conversations, extracted from
 * TransactionMessagesTab so the Needs Review screen can resolve names WITHOUT
 * depending on the Texts tab being mounted.
 *
 * That dependency was the bug: contact names were resolved inside the Texts tab
 * and lived in its state, so opening the review screen from the Emails tab left
 * every sender as a bare number.
 *
 * The map is keyed exactly as the tab keys it — raw handle, last-10-digit
 * normalized form for phone-like handles, and lowercase for emails — because
 * MessageThreadCard looks up `contactNames[raw] || contactNames[normalized]`.
 * Key it any other way and the lookup silently misses.
 */
import { useEffect, useState } from "react";
import { logger } from "../../../utils/logger";

export function useResolvedContactNames(
  handles: string[],
  userId?: string | null,
): Record<string, string> {
  const [contactNames, setContactNames] = useState<Record<string, string>>({});

  // Join, so the effect re-runs when the SET changes rather than on every
  // render (a fresh array literal has a new identity each time).
  const key = handles.join("|");

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      const list = key ? key.split("|") : [];
      if (list.length === 0) return;
      try {
        const result = await window.api.contacts.resolveHandles(list, userId ?? undefined);
        if (cancelled || !result?.success || !result.names) return;

        const withNormalized: Record<string, string> = {};
        Object.entries(result.names as Record<string, string>).forEach(([handle, name]) => {
          withNormalized[handle] = name;
          const isPhone = handle.startsWith("+") || /^\d[\d\s\-()]{6,}$/.test(handle);
          if (isPhone) {
            const normalized = handle.replace(/\D/g, "").slice(-10);
            if (normalized.length >= 7) withNormalized[normalized] = name;
          }
          if (handle.includes("@")) withNormalized[handle.toLowerCase()] = name;
        });
        setContactNames(withNormalized);
      } catch (err) {
        logger.error("Failed to resolve contact names for review:", err);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [key, userId]);

  return contactNames;
}
