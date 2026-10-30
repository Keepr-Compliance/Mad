/**
 * BACKLOG-4065: which transaction the user has open, read by the support
 * ticket flow at submit time.
 *
 * Module state, shared across React subtrees (the support widget and the
 * transaction views are unrelated in the tree). Holds ids only.
 *
 * A stack of entries, most recent wins: the regular and pending-review detail
 * views can be mounted together, and the same id can be registered more than
 * once (React.StrictMode runs every effect register -> unregister -> register).
 * Each register call pushes its own entry object, and its unregister removes
 * that entry only — never by id value.
 */

interface OpenTransactionEntry {
  readonly id: string;
}

let entries: OpenTransactionEntry[] = [];

/** Record `id` as open. Returns a function that removes this entry only. */
export function registerOpenTransaction(id: string): () => void {
  const entry: OpenTransactionEntry = { id };
  entries.push(entry);
  return () => {
    entries = entries.filter((e) => e !== entry);
  };
}

/** The most recently opened transaction id still open, or null. */
export function getOpenTransactionId(): string | null {
  return entries.length > 0 ? entries[entries.length - 1].id : null;
}

/** Test-only: clear all entries. */
export function resetOpenTransactionRegistryForTests(): void {
  entries = [];
}
