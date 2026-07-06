/**
 * useLinkedContentSearch (BACKLOG-1866)
 *
 * Debounced search over everything linked to a single transaction (assigned
 * contacts, linked emails, linked texts). Wraps the typed IPC call so components
 * never touch `window.api` directly.
 *
 * - Debounces the raw query (~250ms).
 * - Empty/whitespace query ⇒ no request, no panel (results === null).
 * - Guards against out-of-order responses (only the latest query wins).
 * - IPC failures are logged and surfaced as `unavailable` rather than swallowed
 *   as empty results (BACKLOG-1866 fix).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { LinkedContentSearchResults } from "@electron/types/ipc/window-api-transactions";

export type { LinkedContentSearchResults } from "@electron/types/ipc/window-api-transactions";

const DEBOUNCE_MS = 250;

export interface UseLinkedContentSearchResult {
  /** Current (immediate) query text bound to the input. */
  query: string;
  /** Update the query text (debounced before it triggers a request). */
  setQuery: (value: string) => void;
  /** Grouped results, or null when there is no active query. */
  results: LinkedContentSearchResults | null;
  /** True while a request is in flight. */
  searching: boolean;
  /**
   * True when the last IPC call failed (handler not registered, DB error, etc.).
   * The UI should show a subtle "search unavailable" message instead of empty results.
   */
  unavailable: boolean;
  /** Clear the query and results. */
  clear: () => void;
}

export function useLinkedContentSearch(
  transactionId: string,
): UseLinkedContentSearchResult {
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [results, setResults] = useState<LinkedContentSearchResults | null>(null);
  const [searching, setSearching] = useState(false);
  const [unavailable, setUnavailable] = useState(false);

  // Monotonic token so a slow earlier response can't overwrite a newer one.
  const requestSeq = useRef(0);

  // Debounce: push `query` into `debouncedQuery` after the idle window.
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  // Fetch whenever the debounced query (or transaction) changes.
  useEffect(() => {
    const trimmed = debouncedQuery.trim();
    if (trimmed.length === 0) {
      setResults(null);
      setSearching(false);
      setUnavailable(false);
      return;
    }

    const seq = ++requestSeq.current;
    setSearching(true);
    setUnavailable(false);

    void window.api.transactions
      .searchLinkedContent(transactionId, trimmed)
      .then((res) => {
        // Ignore stale responses.
        if (seq !== requestSeq.current) return;
        if (res.success && res.results) {
          setResults(res.results);
        } else {
          setResults({
            contacts: { items: [], total: 0 },
            emails: { items: [], total: 0 },
            texts: { items: [], total: 0 },
          });
        }
        setSearching(false);
      })
      .catch((err: unknown) => {
        if (seq !== requestSeq.current) return;
        console.error(
          "[useLinkedContentSearch] IPC error for channel 'transactions:search-linked-content':",
          err,
        );
        setUnavailable(true);
        setResults(null);
        setSearching(false);
      });
  }, [debouncedQuery, transactionId]);

  const clear = useCallback(() => {
    requestSeq.current++;
    setQuery("");
    setDebouncedQuery("");
    setResults(null);
    setSearching(false);
    setUnavailable(false);
  }, []);

  return { query, setQuery, results, searching, unavailable, clear };
}
