/**
 * BACKLOG-3785: the difference between what the renderer already holds and a
 * fresh read of a transaction's communications.
 *
 * After "Attach Messages" the Texts tab used to re-download every linked text
 * (107 MB for a 106k-text deal) to show the few thousand it had just linked.
 * The caller now sends the ids it holds and receives only:
 *   - `added`:      rows in the fresh read whose id it does not hold
 *   - `removedIds`: ids it holds that the fresh read no longer returns
 *
 * `fresh` MUST be the output of the same reader the full reload uses
 * (`getTransactionDetails(txn, channel).communications`), so de-duplication and
 * every other rule of that reader apply unchanged. Applying the delta to the
 * held rows therefore yields the same id set as a full reload.
 */
export interface CommunicationsDelta<T extends { id: string }> {
  added: T[];
  removedIds: string[];
  /** Row count of the fresh read — lets the caller check its merge. */
  total: number;
}

export function computeCommunicationsDelta<T extends { id: string }>(
  fresh: readonly T[],
  knownIds: readonly string[],
): CommunicationsDelta<T> {
  const known = new Set(knownIds);
  const freshIds = new Set<string>();
  const added: T[] = [];
  for (const row of fresh) {
    freshIds.add(row.id);
    if (!known.has(row.id)) added.push(row);
  }
  const removedIds = knownIds.filter((id) => !freshIds.has(id));
  return { added, removedIds, total: fresh.length };
}
