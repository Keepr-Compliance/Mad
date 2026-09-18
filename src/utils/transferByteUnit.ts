/**
 * BACKLOG-3416: the unit the iPhone sync's "transferred" readout is shown in.
 *
 * Two halves, kept apart on purpose:
 *   - the DECISION (`pickDisplayUnitIndex`), made once per sync by
 *     `useIPhoneSync` on the first non-zero byte count and carried on the
 *     sync's progress state;
 *   - the FORMATTING (`formatBytesAtUnit`), done by `SyncProgress` at whatever
 *     unit it is handed.
 *
 * The decision lives with the sync, not with the component, because the modal
 * that renders the readout unmounts on minimize. A unit held by the component
 * was forgotten on every minimize and re-picked from the current count on
 * reopen, so one sync could read "800.0 MB" and then "1.5 GB".
 */

export const BYTE_UNITS = ["B", "KB", "MB", "GB"] as const;

/**
 * The floor. The transferred figure is shown in MB or GB and in nothing else —
 * the founder's ask was "either only in MB or GB".
 *
 * This is not cosmetic. `bytesProcessed` originates in
 * `electron/services/backupService.ts:1839`, which advances the counter ONLY when
 * a whole file completes, by that file's size. The first non-zero sample is
 * therefore the first completed file — typically a few KB — so deciding on the
 * raw promotion would pin an entire multi-gigabyte sync to KB and read
 * "6291456.0 KB". On the founder's own reported run it would have shown
 * "1010995.2 KB" where he had been watching "987.3 MB".
 */
export const MB_UNIT_INDEX = 2;

/**
 * Which unit this byte count would normally be shown in — the same KB/MB/GB
 * promotion the display has always used. Not floored; see `pickDisplayUnitIndex`.
 */
export function pickByteUnitIndex(bytes: number): number {
  let unitIndex = 0;
  let size = bytes;

  while (size >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    size /= 1024;
    unitIndex++;
  }

  return unitIndex;
}

/** The unit a sync may be held at: the normal promotion, never below MB. */
export function pickDisplayUnitIndex(bytes: number): number {
  return Math.max(pickByteUnitIndex(bytes), MB_UNIT_INDEX);
}

/**
 * The FORMATTING, with no unit decision in it.
 *
 * Formats at whatever unit it is handed, however large the result gets — a sync
 * held at MB that goes on to move 6 GiB reads "6144.0 MB", deliberately. That is
 * the point: the founder asked for no mid-sync unit changes, ever.
 *
 * Zero formats at the given unit too ("0.0 MB"), rather than short-circuiting to
 * "0 B". A "0 B" reading would be a third unit on screen and would flip to MB on
 * the next update — the exact behaviour this all removes.
 */
export function formatBytesAtUnit(bytes: number | undefined, unitIndex: number): string {
  const safeBytes = bytes && bytes > 0 ? bytes : 0;

  return `${(safeBytes / 1024 ** unitIndex).toFixed(1)} ${BYTE_UNITS[unitIndex]}`;
}
