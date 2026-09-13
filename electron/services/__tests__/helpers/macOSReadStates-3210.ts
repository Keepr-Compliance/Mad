/**
 * BACKLOG-3210 — the four macOS address-book read states, TRANSCRIBED from the
 * real reader rather than invented.
 *
 * These constants are consumed by two suites that cannot both drive the real
 * filesystem:
 *
 *   `contactsService.deniedVsEmpty-3210.test.ts` builds real `.abcddb` stores
 *   in a temp `$HOME`, runs the SHIPPED `getContactNames()` against them, and
 *   asserts the status it returns equals the constant below. That suite is the
 *   only reason these values may be trusted.
 *
 *   `contactHandlers.syncExternalCause-3210.test.ts` feeds them to the sync
 *   handler as `getContactNames()`'s output. It never touches a disk.
 *
 * The link between the two is the point. A hand-written status fixture that
 * describes a state the reader cannot emit would make the handler tests green
 * and meaningless — the exact failure recorded in this repo's verification
 * catalogue. If the reader's contract moves, the transcription suite goes red
 * first, and the handler suite cannot silently drift away from reality.
 *
 * ONLY the fields the classifier reads, plus the ones that discriminate the
 * states, are pinned. `source`/`sources`/`attemptedPaths` carry absolute temp
 * paths and are deliberately excluded — they are machine-specific and not part
 * of any claim made here.
 */

import type { LoadStatus } from "../../contactsService";

export interface MacOSReadShape {
  success: boolean;
  contactCount: number;
  booksFound: number;
  booksRead: number;
  booksFailed: number;
  coverage: "complete" | "partial" | "none";
}

/** The comparable subset of a real `LoadStatus`. */
export function shapeOf(status: LoadStatus): MacOSReadShape {
  return {
    success: status.success,
    contactCount: status.contactCount,
    booksFound: status.booksFound,
    booksRead: status.booksRead,
    booksFailed: status.booksFailed,
    coverage: status.coverage,
  };
}

/**
 * NOTHING WAS DISCOVERED.
 *
 * This is the shape produced BOTH by a Full Disk Access denial AND by a Mac
 * with no address book at all — `addressBookDiscovery.findAbcddbFiles` catches
 * and discards its own `readdir` rejection, so the two are indistinguishable in
 * the reader's output. The transcription suite proves that identity.
 *
 * That is why the handler cannot answer from the read alone and has to probe
 * the permission: this one shape has two causes and they send the user to
 * different places.
 */
export const NOTHING_DISCOVERED: MacOSReadShape = {
  success: false,
  contactCount: 0,
  booksFound: 0,
  booksRead: 0,
  booksFailed: 0,
  coverage: "none",
};

/**
 * FDA is granted, one address book opened cleanly, and it holds nobody.
 *
 * `booksRead: 1` is the whole difference from `NOTHING_DISCOVERED`, and it is
 * direct evidence that we were not denied. The handler must still report
 * emptiness here, or the fix has only moved the wrong answer.
 */
export const READ_AND_EMPTY: MacOSReadShape = {
  success: true,
  contactCount: 0,
  booksFound: 1,
  booksRead: 1,
  booksFailed: 0,
  coverage: "complete",
};

/** Stores are on disk; not one of them would open. */
export const FOUND_BUT_UNREADABLE: MacOSReadShape = {
  success: false,
  contactCount: 0,
  booksFound: 2,
  booksRead: 0,
  booksFailed: 2,
  coverage: "none",
};

/** The ordinary success case: one book, read, with people in it. */
export const READ_WITH_CONTACTS: MacOSReadShape = {
  success: true,
  contactCount: 2,
  booksFound: 1,
  booksRead: 1,
  booksFailed: 0,
  coverage: "complete",
};
