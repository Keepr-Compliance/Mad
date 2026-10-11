/**
 * BACKLOG-3785: apply a `transactions:get-communications-delta` reply to the
 * communications the Texts/Emails tabs already hold.
 *
 * The full reload this replaces did:
 *   [...rows of the OTHER channel, ...fresh rows of this channel (sent_at DESC)]
 * The merge keeps that shape: rows of the other channel untouched and first,
 * this channel's held rows minus `removedIds`, plus `added` rows whose id is not
 * already held, interleaved newest first by `sent_at`. The comparison is a plain
 * string comparison with missing dates last — what SQLite's
 * `ORDER BY sent_at DESC` does with the same values.
 */
interface DeltaRow {
  id: string;
  sent_at?: string | null;
}

function sentAtOf(row: DeltaRow): string | null {
  const value = (row as { sent_at?: unknown }).sent_at;
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** True when `a` sorts before `b` under ORDER BY sent_at DESC (ties keep `a`). */
function sortsBefore(a: DeltaRow, b: DeltaRow): boolean {
  const sa = sentAtOf(a);
  const sb = sentAtOf(b);
  if (sa === sb) return true;
  if (sa === null) return false;
  if (sb === null) return true;
  return sa > sb;
}

export function mergeCommunicationsDelta<T extends DeltaRow>(
  prev: readonly T[],
  isChannel: (row: T) => boolean,
  added: readonly T[],
  removedIds: readonly string[],
): T[] {
  const removed = new Set(removedIds);
  const otherChannel: T[] = [];
  const channelRows: T[] = [];
  for (const row of prev) {
    if (!isChannel(row)) otherChannel.push(row);
    else if (!removed.has(row.id)) channelRows.push(row);
  }

  const held = new Set<string>();
  for (const row of otherChannel) held.add(row.id);
  for (const row of channelRows) held.add(row.id);
  const fresh: T[] = [];
  for (const row of added) {
    if (held.has(row.id)) continue;
    held.add(row.id);
    fresh.push(row);
  }

  // Both inputs arrive newest first; a linear merge keeps that order.
  const merged: T[] = [];
  let i = 0;
  let j = 0;
  while (i < channelRows.length && j < fresh.length) {
    if (sortsBefore(channelRows[i], fresh[j])) merged.push(channelRows[i++]);
    else merged.push(fresh[j++]);
  }
  while (i < channelRows.length) merged.push(channelRows[i++]);
  while (j < fresh.length) merged.push(fresh[j++]);

  return [...otherChannel, ...merged];
}
