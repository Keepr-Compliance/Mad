/**
 * Clear Google Messages for Web texts — BACKLOG-3657.
 *
 * Settings > Android Messages > Force re-import clears the Android texts AND
 * the texts imported from Google Messages for Web (founder decision: one
 * shared reset). For the gmweb rows it does more than the Android clear (a
 * single DELETE relying on cascades), in the order reviewed for the one-off
 * purge:
 *
 *   in ONE database transaction, all scoped to the user:
 *     1. read the attachment file paths and the counted links per transaction
 *     2. delete attachments
 *     3. delete communications (per message, then gmweb thread-level)
 *     4. delete the messages (texts and reactions)
 *     5. message_count = max(0, old - counted links), the rule of
 *        transactionService.unlinkMessages (linkMessages adds +1 per counted
 *        link; reactions are never counted)
 *   after the commit: delete the attachment FILES, only inside the app's
 *   message-attachments folder. A failed transaction deletes no file.
 *
 * The user's removals (`ignored_communications`) are kept, as Android keeps
 * them: a removed chat stays removed and can be restored from "Show removed".
 *
 * Logs carry counts only. Dependencies are injected so jest runs the order,
 * the count rule and the rollback without the native database module.
 */

import * as path from "path";

export interface RcsClearDbOps {
  /** Run `fn` in one database transaction; a throw rolls everything back. */
  inTransaction<T>(fn: () => T): T;
  attachmentPaths(userId: string): string[];
  countedLinks(userId: string): Array<{ transactionId: string; counted: number }>;
  messageCount(userId: string, transactionId: string): number | null;
  deleteAttachments(userId: string): number;
  deleteMessageLinks(userId: string): number;
  deleteThreadLinks(userId: string): number;
  deleteMessages(userId: string): number;
  setMessageCount(userId: string, transactionId: string, count: number): void;
}

export interface RcsClearFs {
  /** `<userData>/message-attachments`: files outside it are never deleted. */
  attachmentsRoot: string;
  /** Resolve a stored path (absolute, or relative to userData). */
  resolve(storagePath: string): string;
  deleteFile(absPath: string): boolean;
}

export interface RcsClearResult {
  messagesDeleted: number;
  linksDeleted: number;
  attachmentsDeleted: number;
  filesDeleted: number;
  transactionsUpdated: number;
}

/**
 * Run `fn` with the RCS bridge's writes paused (see
 * RcsExtensionBridge.pauseWrites); writes resume afterwards even when `fn`
 * throws.
 */
export async function runWithWritesPaused<T>(
  gate: { pauseWrites(): Promise<void>; resumeWrites(): void },
  fn: () => T,
): Promise<T> {
  // pauseWrites can throw (the drain timed out): writes are resumed and `fn`
  // never runs — nothing is deleted.
  try {
    await gate.pauseWrites();
    return fn();
  } finally {
    gate.resumeWrites();
  }
}

export function clearGoogleMessagesWebData(
  userId: string,
  db: RcsClearDbOps,
  files: RcsClearFs,
  log: (message: string) => void = () => {},
): RcsClearResult {
  const root = path.resolve(files.attachmentsRoot) + path.sep;

  const done = db.inTransaction(() => {
    const paths = db.attachmentPaths(userId);
    const counted = db.countedLinks(userId);
    const attachmentsDeleted = db.deleteAttachments(userId);
    const linksDeleted = db.deleteMessageLinks(userId) + db.deleteThreadLinks(userId);
    const messagesDeleted = db.deleteMessages(userId);
    let transactionsUpdated = 0;
    for (const { transactionId, counted: n } of counted) {
      const old = db.messageCount(userId, transactionId);
      if (old === null) continue;
      db.setMessageCount(userId, transactionId, Math.max(0, old - n));
      transactionsUpdated += 1;
    }
    return { paths, attachmentsDeleted, linksDeleted, messagesDeleted, transactionsUpdated };
  });

  // Files only after the commit, and only inside the attachments folder.
  let filesDeleted = 0;
  for (const p of done.paths) {
    if (!p) continue;
    const abs = path.resolve(files.resolve(p));
    if (!abs.startsWith(root)) continue;
    if (files.deleteFile(abs)) filesDeleted += 1;
  }

  const result: RcsClearResult = {
    messagesDeleted: done.messagesDeleted,
    linksDeleted: done.linksDeleted,
    attachmentsDeleted: done.attachmentsDeleted,
    filesDeleted,
    transactionsUpdated: done.transactionsUpdated,
  };
  log(
    `[RcsClear] Cleared Google Messages for Web texts: ${result.messagesDeleted} messages, ` +
      `${result.linksDeleted} links, ${result.attachmentsDeleted} attachments (${result.filesDeleted} files), ` +
      `message_count updated on ${result.transactionsUpdated} transactions`,
  );
  return result;
}

/** The shared Force re-import result (Android + Google Messages for Web). */
export interface SharedForceClearResult {
  messagesDeleted: number;
  contactsDeleted: number;
  gmwebMessagesDeleted: number;
  /** False when that part was not cleared. */
  gmwebCleared: boolean;
  androidCleared: boolean;
  /** Plain-language reason when something was not cleared. */
  error?: string;
}

/**
 * BACKLOG-3657 (SR F2): the Google Messages for Web clear runs FIRST — it is
 * the part that can refuse to start (writes still in progress) — and when it
 * fails nothing at all is deleted. Only then the Android clear; if that fails,
 * the result says which part WAS cleared.
 */
export async function runSharedForceClear(deps: {
  clearGmweb: () => Promise<{ messagesDeleted: number }>;
  clearAndroid: () => { messagesDeleted: number; contactsDeleted: number };
}): Promise<SharedForceClearResult> {
  let gmwebDeleted: number;
  try {
    gmwebDeleted = (await deps.clearGmweb()).messagesDeleted;
  } catch (err) {
    return {
      messagesDeleted: 0,
      contactsDeleted: 0,
      gmwebMessagesDeleted: 0,
      gmwebCleared: false,
      androidCleared: false,
      error: `Nothing was cleared. ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  try {
    const android = deps.clearAndroid();
    return { ...android, gmwebMessagesDeleted: gmwebDeleted, gmwebCleared: true, androidCleared: true };
  } catch (err) {
    return {
      messagesDeleted: 0,
      contactsDeleted: 0,
      gmwebMessagesDeleted: gmwebDeleted,
      gmwebCleared: true,
      androidCleared: false,
      error:
        `The texts imported from Google Messages for Web were cleared, but the Android texts and contacts were not. ` +
        `Try Force re-import again. (${err instanceof Error ? err.message : String(err)})`,
    };
  }
}
