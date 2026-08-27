/**
 * Custom hook for managing transaction list data
 * Handles loading, filtering, searching, and count calculations
 */
import { useState, useEffect, useMemo, useCallback } from "react";
import type { Transaction } from "@/types";

/**
 * Filter counts for transaction status tabs
 */
export interface FilterCounts {
  all: number;
  pending: number;
  active: number;
  closed: number;
  rejected: number;
}

/**
 * Filter type for transaction status
 */
export type TransactionFilter = "all" | "pending" | "active" | "closed" | "rejected";

/**
 * Return type for useTransactionList hook
 */
export interface UseTransactionListResult {
  transactions: Transaction[];
  filteredTransactions: Transaction[];
  loading: boolean;
  error: string | null;
  filterCounts: FilterCounts;
  refetch: () => Promise<void>;
  setError: (error: string | null) => void;
}

/**
 * Options for useTransactionList.
 */
export interface UseTransactionListOptions {
  /**
   * BACKLOG-1876: when true, skip the property_address text filter entirely.
   * The transaction LIST page now uses the global search box (which surfaces a
   * "Transactions" result group) instead of an address-only substring filter,
   * so it opts out here. The legacy Transactions screen leaves this false to
   * preserve its own address search box.
   */
  disableAddressFilter?: boolean;
}

/**
 * Custom hook for managing transaction list data
 * @param userId - User ID to fetch transactions for
 * @param filter - Current filter status
 * @param searchQuery - Search query string (address substring filter)
 * @param options - { disableAddressFilter } to skip the address filter
 * @returns Transaction data, filtered results, loading state, and utility functions
 */
export function useTransactionList(
  userId: string,
  filter: TransactionFilter,
  searchQuery: string,
  options: UseTransactionListOptions = {}
): UseTransactionListResult {
  const { disableAddressFilter = false } = options;
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  /**
   * Load transactions from the API
   */
  const loadTransactions = useCallback(async (): Promise<void> => {
    try {
      setLoading(true);
      const result = await window.api.transactions.getAll(userId);

      if (result.success) {
        setTransactions(result.transactions || []);
      } else {
        setError(result.error || "Failed to load transactions");
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  /**
   * Background re-read of the same rows: no spinner, and it never blanks the
   * list the user is looking at.
   *
   * A failed background refresh must leave the previous array in place and must
   * NOT raise the error banner — the visible list is still valid, merely one
   * revision old, and the loud path already reports a failure the user asked
   * for. Same rule as useReviewQueue's read failure.
   */
  const loadTransactionsSilently = useCallback(async (): Promise<void> => {
    try {
      const result = await window.api.transactions.getAll(userId);
      if (result.success && result.transactions) {
        setTransactions(result.transactions);
      }
    } catch {
      /* keep the rows already on screen */
    }
  }, [userId]);

  // Load transactions on mount
  useEffect(() => {
    loadTransactions();
  }, [loadTransactions]);

  /**
   * BACKLOG-2838: keep the card's counters current while the list stays mounted.
   *
   * Founder, 2026-08-23: "closing keepr and reopening it fixed the count." That
   * is the signature of a snapshot with no subscription, and it was exactly
   * that. `email_count` and `text_thread_count` ride in on the rows fetched by
   * the mount effect above, and the details screen is a MODAL rendered by the
   * list — so the list never unmounts while the user approves, links or unlinks
   * inside a deal, and the array it is rendering from is never re-read. Only an
   * app restart remounted it.
   *
   * This is the same defect as the linked list that did not update after
   * approve (PR #2347) one layer out, and it takes the same shape of fix: one
   * more SUBSCRIBER to a broadcast that already exists, never a callback bolted
   * onto each action. Wiring it per-action is what leaves the next action to
   * rediscover the bug.
   *
   * BOTH existing signals, because both change what the counters count:
   *   • review:queue-changed — every review mutation (approve, reject, restore)
   *     and the discovery sweep, via notifyReviewStateChanged.
   *   • transactions:auto-sync-complete — a background sync that linked mail.
   *     The modal already handles this one (TransactionDetails.tsx) but patches
   *     only its OWN copy of the row; nothing reached the list behind it.
   * Neither is filtered by transactionId: the list renders every deal, so a
   * change to any of them changes something on screen.
   *
   * Subscribing here rather than in TransactionList means the legacy
   * Transactions screen, which uses this same hook, is fixed by the same wire.
   *
   * Optional-chained for the same reason useReviewQueue is: a partially-mocked
   * `window.api` in an existing suite must not break the list's mount. It
   * cannot hide a real wiring break — the pin test asserts both bridges are
   * subscribed and goes red if either goes missing.
   */
  useEffect(() => {
    const unsubscribes: Array<() => void> = [];

    const subscribeReview = window.api?.transactions?.onReviewQueueChanged;
    if (typeof subscribeReview === "function") {
      unsubscribes.push(
        subscribeReview(() => {
          void loadTransactionsSilently();
        })
      );
    }

    const subscribeAutoSync = window.api?.onTransactionAutoSyncComplete;
    if (typeof subscribeAutoSync === "function") {
      unsubscribes.push(
        subscribeAutoSync((data) => {
          // ran=false means throttled/skipped — nothing was fetched, so nothing
          // it counts can have changed.
          if (!data.ran) return;
          void loadTransactionsSilently();
        })
      );
    }

    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
  }, [loadTransactionsSilently]);

  /**
   * Compute filter counts for status tabs
   */
  const filterCounts = useMemo<FilterCounts>(
    () => ({
      all: transactions.length,
      pending: transactions.filter(
        (t) => t.detection_status === "pending" || t.status === "pending"
      ).length,
      active: transactions.filter(
        (t) =>
          t.status === "active" &&
          t.detection_status !== "pending" &&
          t.detection_status !== "rejected"
      ).length,
      closed: transactions.filter((t) => t.status === "closed").length,
      rejected: transactions.filter((t) => t.detection_status === "rejected")
        .length,
    }),
    [transactions]
  );

  /**
   * Filter transactions based on filter and search query
   */
  const filteredTransactions = useMemo(() => {
    return transactions.filter((t) => {
      // BACKLOG-1876: the transaction list opts out of the address filter (the
      // global search box replaces it); the legacy screen keeps it.
      const matchesSearch =
        disableAddressFilter ||
        t.property_address?.toLowerCase().includes(searchQuery.toLowerCase());

      let matchesFilter = false;
      switch (filter) {
        case "all":
          matchesFilter = true;
          break;
        case "pending":
          // Pending = detection_status is pending OR status is pending
          matchesFilter = t.detection_status === "pending" || t.status === "pending";
          break;
        case "active":
          // Active = status is active AND not pending review AND not rejected
          matchesFilter =
            t.status === "active" &&
            t.detection_status !== "pending" &&
            t.detection_status !== "rejected";
          break;
        case "closed":
          matchesFilter = t.status === "closed";
          break;
        case "rejected":
          matchesFilter = t.detection_status === "rejected";
          break;
      }

      return matchesSearch && matchesFilter;
    });
  }, [transactions, filter, searchQuery, disableAddressFilter]);

  return {
    transactions,
    filteredTransactions,
    loading,
    error,
    filterCounts,
    refetch: loadTransactions,
    setError,
  };
}

export default useTransactionList;
