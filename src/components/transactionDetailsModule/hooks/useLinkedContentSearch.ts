/**
 * useLinkedContentSearch (BACKLOG-1866, generalized in BACKLOG-1876)
 *
 * Debounced search that wraps the typed IPC calls so components never touch
 * `window.api` directly. Two scopes:
 *   - { type: 'transaction', id } → searchLinkedContent (single-transaction,
 *     unchanged BACKLOG-1866 behavior; three groups, no attribution).
 *   - { type: 'global', userId }  → searchGlobalContent (all of the user's
 *     content; five groups with per-hit transaction attribution + unattached).
 *
 * Both responses are normalized into one shape so a single component renders
 * either scope. Scoped mode leaves `transactions`/`unattached` null and every
 * hit's `attribution` null — identical rendering to the original overview panel.
 *
 * - Debounces the raw query (~250ms).
 * - Empty/whitespace query ⇒ no request, no panel (results === null).
 * - Guards against out-of-order responses (only the latest query wins).
 * - IPC failures are logged and surfaced as `unavailable` rather than swallowed
 *   as empty results (BACKLOG-1866 fix).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  LinkedContentGroup,
  GlobalTransactionHit,
  GlobalContactHit,
  GlobalEmailHit,
  GlobalTextHit,
  GlobalUnattachedHit,
} from "@electron/types/ipc/window-api-transactions";

export type { LinkedContentSearchResults } from "@electron/types/ipc/window-api-transactions";

const DEBOUNCE_MS = 250;

/**
 * Search scope. A single transaction (details window) or global (list window,
 * scoped to the owning user).
 */
export type SearchScope =
  | { type: "transaction"; id: string }
  | { type: "global"; userId: string };

/**
 * Normalized results the component renders regardless of scope. In transaction
 * scope, `transactions` and `unattached` are null and each hit's attribution is
 * null.
 */
export interface NormalizedSearchResults {
  transactions: LinkedContentGroup<GlobalTransactionHit> | null;
  contacts: LinkedContentGroup<GlobalContactHit>;
  emails: LinkedContentGroup<GlobalEmailHit>;
  texts: LinkedContentGroup<GlobalTextHit>;
  unattached: LinkedContentGroup<GlobalUnattachedHit> | null;
}

export interface UseLinkedContentSearchResult {
  /** Current (immediate) query text bound to the input. */
  query: string;
  /** Update the query text (debounced before it triggers a request). */
  setQuery: (value: string) => void;
  /** Normalized grouped results, or null when there is no active query. */
  results: NormalizedSearchResults | null;
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

function emptyNormalized(scope: SearchScope): NormalizedSearchResults {
  const global = scope.type === "global";
  return {
    transactions: global ? { items: [], total: 0 } : null,
    contacts: { items: [], total: 0 },
    emails: { items: [], total: 0 },
    texts: { items: [], total: 0 },
    unattached: global ? { items: [], total: 0 } : null,
  };
}

export function useLinkedContentSearch(
  scope: SearchScope,
): UseLinkedContentSearchResult {
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [results, setResults] = useState<NormalizedSearchResults | null>(null);
  const [searching, setSearching] = useState(false);
  const [unavailable, setUnavailable] = useState(false);

  // Monotonic token so a slow earlier response can't overwrite a newer one.
  const requestSeq = useRef(0);

  // Stable dependency key so a fresh scope object identity doesn't re-fire.
  const scopeKey = scope.type === "transaction" ? scope.id : scope.userId;

  // Debounce: push `query` into `debouncedQuery` after the idle window.
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  // Fetch whenever the debounced query (or scope) changes.
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

    const request =
      scope.type === "transaction"
        ? window.api.transactions
            .searchLinkedContent(scope.id, trimmed)
            .then((res) => {
              if (!res.success || !res.results) return null;
              const r = res.results;
              return {
                transactions: null,
                contacts: {
                  items: r.contacts.items.map((c) => ({
                    ...c,
                    attribution: null,
                  })),
                  total: r.contacts.total,
                },
                emails: {
                  items: r.emails.items.map((e) => ({
                    ...e,
                    attribution: null,
                  })),
                  total: r.emails.total,
                },
                texts: {
                  items: r.texts.items.map((t) => ({
                    ...t,
                    attribution: null,
                  })),
                  total: r.texts.total,
                },
                unattached: null,
              } as NormalizedSearchResults;
            })
        : window.api.transactions
            .searchGlobalContent(scope.userId, trimmed)
            .then((res) => {
              if (!res.success || !res.results) return null;
              return res.results as NormalizedSearchResults;
            });

    void request
      .then((normalized) => {
        if (seq !== requestSeq.current) return;
        setResults(normalized ?? emptyNormalized(scope));
        setSearching(false);
      })
      .catch((err: unknown) => {
        if (seq !== requestSeq.current) return;
        console.error(
          `[useLinkedContentSearch] IPC error (${scope.type} scope):`,
          err,
        );
        setUnavailable(true);
        setResults(null);
        setSearching(false);
      });
    // Deps are the PRIMITIVE scope identity (type + id/userId) so an inline
    // `scope={{...}}` object (new identity each render) does not re-fire the
    // effect. The branch reads the live scope object, consistent with these deps.
  }, [debouncedQuery, scope.type, scopeKey]);

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
