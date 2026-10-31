/**
 * openTransactionRequest — BACKLOG-3965 PR-4a.
 *
 * A tiny store for "open this deal, on this tab". It replaces the
 * `pendingTransactionId` state that lived inside AppModals, so a caller outside
 * AppModals (the Dashboard's Todo and Recent rows, PR-4b) can ask for a deal to
 * open without a state-machine change.
 *
 * A caller writes the request, then opens the Transactions view
 * (`openTransactions()` / `onViewTransactions()`). AppModals reads the request
 * and hands it to TransactionList, which opens the deal on the named tab.
 * AppModals clears it when the Transactions view closes.
 *
 * Every write names its tab, so a "checklist" request can never carry over to
 * the next open (the Contacts card always writes "overview").
 */
import { useSyncExternalStore } from "react";
import type { TransactionTab } from "../components/transactionDetailsModule/types";

export interface OpenTransactionRequest {
  id: string;
  tab: TransactionTab;
}

let current: OpenTransactionRequest | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((listener) => listener());
}

/** Ask for a deal to open on `tab` (default: the overview tab). */
export function requestOpenTransaction(id: string, tab: TransactionTab = "overview"): void {
  current = { id, tab };
  emit();
}

/** Forget the request (the Transactions view closed). */
export function clearOpenTransactionRequest(): void {
  if (current === null) return;
  current = null;
  emit();
}

export function getOpenTransactionRequest(): OpenTransactionRequest | null {
  return current;
}

export function subscribeOpenTransactionRequest(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** React binding: re-renders when the request changes. */
export function useOpenTransactionRequest(): OpenTransactionRequest | null {
  return useSyncExternalStore(
    subscribeOpenTransactionRequest,
    getOpenTransactionRequest,
    getOpenTransactionRequest,
  );
}
