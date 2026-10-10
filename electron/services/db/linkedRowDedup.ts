/**
 * BACKLOG-3884: the row de-duplication of `getCommunicationsWithMessages`
 * (communicationDbService.ts), in a module with no imports so the paged Texts-tab
 * reader can apply the same rules on the main thread or on the contact worker.
 */
import type { Communication } from "../../types";
/**
 * The de-duplication `getCommunicationsWithMessages` applies to its rows, as a
 * function of the rows alone (BACKLOG-3884: the paged Texts-tab reader applies the
 * SAME rules to each page, per thread). Moved here unchanged; order of `results` is
 * the order first-wins is decided in.
 */
export function dedupeLinkedCommunicationRows(results: Communication[]): Communication[] {
  // Deduplicate by message ID first
  const seenIds = new Set<string>();
  const dedupedById = results.filter(r => {
    if (seenIds.has(r.id)) return false;
    seenIds.add(r.id);
    return true;
  });

  // Content-based deduplication for text messages
  // Catches cases where same content exists with different IDs
  const isTextRow = (r: Communication): boolean => {
    const channel = (r as { channel?: string }).channel;
    const commType = (r as { communication_type?: string }).communication_type;
    return channel === 'sms' || channel === 'imessage' ||
           commType === 'sms' || commType === 'imessage';
  };
  const contentKeyOf = (r: Communication): string =>
    `${(r as { body_text?: string }).body_text || ''}|${(r as { sent_at?: string }).sent_at || ''}`;
  const isHiddenRow = (r: Communication): boolean =>
    !!(r as { hidden_from_export?: 0 | 1 }).hidden_from_export;

  // BACKLOG-3366: WITHIN A CONTENT GROUP, A HIDDEN COPY WINS.
  //
  // Which duplicate survives the first-wins rule below is decided by row order,
  // and two duplicates share `sent_at` by definition, so the tie is broken by
  // insertion order of the `communications` and `messages` rows (measured in
  // the SR plan review). Removing and restoring a conversation re-inserts its
  // link rows, so the copy a user hid can stop being the survivor later — and
  // then the UNHIDDEN copy is what the export reads. Keeping the hidden copy
  // also keeps the gray bubble and the stored row on the same id, so Unhide on
  // that bubble deletes the row it is looking at.
  const hiddenContent = new Set<string>();
  for (const r of dedupedById) {
    if (!isTextRow(r) || !isHiddenRow(r)) continue;
    if (((r as { body_text?: string }).body_text || '').trim().length === 0) continue;
    hiddenContent.add(contentKeyOf(r));
  }

  const seenContent = new Set<string>();
  const deduped = dedupedById.filter(r => {
    if (!isTextRow(r)) return true;

    const bodyText = (r as { body_text?: string }).body_text || '';

    // BACKLOG-2280 (I2): content-dedup keys on `bodyText|sentAt`, but MANY distinct
    // rows now share an empty body — reactions (empty by design) AND caption-less
    // media (empty since BACKLOG-2262). Two empty-body rows at the same second are
    // DIFFERENT messages, so keying them on content would wrongly collapse them
    // (e.g. two reactions in the same second, or a reaction that coincides with a
    // caption-less photo). Empty-body rows are already de-duplicated by id above;
    // exempt them from content-dedup entirely.
    if (bodyText.trim().length === 0) return true;

    const contentKey = contentKeyOf(r);

    if (seenContent.has(contentKey)) return false;
    // BACKLOG-3366: a group that contains a hidden copy keeps the first HIDDEN
    // copy, so an unhidden duplicate is dropped even when it comes first.
    if (hiddenContent.has(contentKey) && !isHiddenRow(r)) return false;
    seenContent.add(contentKey);
    return true;
  });

  return deduped;
}
