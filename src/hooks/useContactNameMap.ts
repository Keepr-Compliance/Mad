/**
 * useContactNameMap
 * BACKLOG-1762: Provides an address -> contact display_name map for the current
 * user, fetched once via a single IPC call and shared across all email views.
 *
 * Email views (thread chat bubbles, single-email From/To/CC lines, email list
 * rows) use this map to resolve display names when the email header carries no
 * name (or only repeats the address). Keys are lowercase email addresses.
 *
 * Design notes:
 * - Takes `userId` as an argument (no useAuth coupling) so it can be used in
 *   components/tests without an AuthProvider. Containers that already have the
 *   current user pass `currentUser?.id`.
 * - A module-level cache keyed by userId dedupes the IPC fetch across every
 *   consumer for the session, so many components can call this cheaply.
 */
import { useEffect, useState } from "react";
import logger from "../utils/logger";

// userId -> resolved map. Shared across all hook instances for the session.
const cache = new Map<string, ReadonlyMap<string, string>>();
// userId -> in-flight fetch, so concurrent mounts share a single IPC call.
const inflight = new Map<string, Promise<ReadonlyMap<string, string>>>();

const EMPTY_MAP: ReadonlyMap<string, string> = new Map();

async function fetchNameMap(userId: string): Promise<ReadonlyMap<string, string>> {
  const contactsApi = window.api?.contacts;
  if (!contactsApi?.getEmailNameMap) return EMPTY_MAP;

  const result = await contactsApi.getEmailNameMap(userId);
  if (!result?.success || !result.nameMap) return EMPTY_MAP;

  const map = new Map<string, string>();
  for (const [email, name] of Object.entries(result.nameMap)) {
    if (email && name) map.set(email.toLowerCase(), name);
  }
  return map;
}

/**
 * Returns a lowercase-email -> display_name map for the given user.
 * Returns an empty map while loading, when no user is available, or on error.
 */
export function useContactNameMap(userId?: string | null): ReadonlyMap<string, string> {
  const [nameMap, setNameMap] = useState<ReadonlyMap<string, string>>(() =>
    userId && cache.has(userId) ? cache.get(userId)! : EMPTY_MAP,
  );

  useEffect(() => {
    if (!userId) {
      setNameMap(EMPTY_MAP);
      return;
    }

    const cached = cache.get(userId);
    if (cached) {
      setNameMap(cached);
      return;
    }

    let cancelled = false;

    let promise = inflight.get(userId);
    if (!promise) {
      promise = fetchNameMap(userId)
        .then((map) => {
          cache.set(userId, map);
          inflight.delete(userId);
          return map;
        })
        .catch((err) => {
          inflight.delete(userId);
          logger.error("useContactNameMap: failed to load contact name map", err);
          return EMPTY_MAP;
        });
      inflight.set(userId, promise);
    }

    void promise.then((map) => {
      if (!cancelled) setNameMap(map);
    });

    return () => {
      cancelled = true;
    };
  }, [userId]);

  return nameMap;
}

export default useContactNameMap;
