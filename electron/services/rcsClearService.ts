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
 *     6. text_thread_count recomputed on every transaction that had a gmweb
 *        link (per message OR thread-level). A thread-level link (auto-link:
 *        message_id NULL, thread_id gmweb2-<hash>) never added to
 *        message_count — it is counted in text_thread_count (communicationDb
 *        createThreadCommunicationReference) — so removing it must refresh that.
 *   after the commit: delete the attachment FILES, only inside the app's
 *   message-attachments folder, and only when NO attachments row (any
 *   source, any user) still points to the file — files are content-addressed
 *   (<sha256><ext>), so iPhone sync or another user can share one
 *   (BACKLOG-3667). A failed transaction deletes no file.
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
  /** Transactions with ANY gmweb link of the user (per message or thread-level). */
  linkedTransactions(userId: string): string[];
  messageCount(userId: string, transactionId: string): number | null;
  deleteAttachments(userId: string): number;
  deleteMessageLinks(userId: string): number;
  deleteThreadLinks(userId: string): number;
  deleteMessages(userId: string): number;
  setMessageCount(userId: string, transactionId: string, count: number): void;
  /**
   * BACKLOG-3667: does any remaining attachments row (any user, any source)
   * point to this file? Matched on the stored path or its file name, since a
   * path may be stored absolute or relative.
   */
  fileStillReferenced(storagePath: string): boolean;
  /** Recompute transactions.text_thread_count from the links that remain. */
  refreshTextThreadCount(transactionId: string): void;
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
  /** Of linksDeleted: thread-level links (auto-link writes these). */
  threadLinksDeleted: number;
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
    const linked = db.linkedTransactions(userId);
    const attachmentsDeleted = db.deleteAttachments(userId);
    const messageLinksDeleted = db.deleteMessageLinks(userId);
    const threadLinksDeleted = db.deleteThreadLinks(userId);
    const messagesDeleted = db.deleteMessages(userId);
    let transactionsUpdated = 0;
    for (const { transactionId, counted: n } of counted) {
      const old = db.messageCount(userId, transactionId);
      if (old === null) continue;
      db.setMessageCount(userId, transactionId, Math.max(0, old - n));
      transactionsUpdated += 1;
    }
    for (const transactionId of linked) db.refreshTextThreadCount(transactionId);
    return {
      paths,
      attachmentsDeleted,
      linksDeleted: messageLinksDeleted + threadLinksDeleted,
      threadLinksDeleted,
      messagesDeleted,
      transactionsUpdated,
      threadCountsUpdated: linked.length,
    };
  });

  // Files only after the commit, only inside the attachments folder, and
  // only when nothing else points to them (BACKLOG-3667: shared by hash).
  let filesDeleted = 0;
  let filesKept = 0;
  for (const p of new Set(done.paths)) {
    if (!p) continue;
    const abs = path.resolve(files.resolve(p));
    if (!abs.startsWith(root)) continue;
    if (db.fileStillReferenced(p)) {
      filesKept += 1;
      continue;
    }
    if (files.deleteFile(abs)) filesDeleted += 1;
  }

  const result: RcsClearResult = {
    messagesDeleted: done.messagesDeleted,
    linksDeleted: done.linksDeleted,
    threadLinksDeleted: done.threadLinksDeleted,
    attachmentsDeleted: done.attachmentsDeleted,
    filesDeleted,
    transactionsUpdated: done.transactionsUpdated,
  };
  log(
    `[RcsClear] Cleared Google Messages for Web texts: ${result.messagesDeleted} messages, ` +
      `${result.linksDeleted} links (${result.threadLinksDeleted} thread-level), ${result.attachmentsDeleted} attachments ` +
      `(${result.filesDeleted} files deleted, ${filesKept} kept: still used), message_count updated on ${result.transactionsUpdated} transactions, ` +
      `thread count refreshed on ${done.threadCountsUpdated}`,
  );
  return result;
}

// ---------------------------------------------------------------------------
// BACKLOG-3658 P3b: optional auto-delete (a setting, OFF by default; 90 days
// when on). After a cache Sync and its auto-link, a gmweb2 chat linked to
// NOTHING whose last message is older than the cutoff is deleted (texts,
// reactions, attachments; files only when no other row uses them). Chats
// linked to any transaction, and every other source, are never touched.
// ---------------------------------------------------------------------------

/** Auto-delete's age when it is on. */
export const RCS_AUTO_DELETE_DAYS = 90;

export interface RcsAutoDeleteDbOps {
  inTransaction<T>(fn: () => T): T;
  unlinkedOldThreads(userId: string, cutoffIso: string): string[];
  attachmentPaths(userId: string, threadIds: string[]): string[];
  deleteAttachments(userId: string, threadIds: string[]): number;
  deleteMessages(userId: string, threadIds: string[]): number;
  fileStillReferenced(storagePath: string): boolean;
}

export function clearUnlinkedOldChats(
  userId: string,
  cutoffIso: string,
  db: RcsAutoDeleteDbOps,
  files: RcsClearFs,
  log: (message: string) => void = () => {},
): { chats: number; messages: number; filesDeleted: number } {
  const root = path.resolve(files.attachmentsRoot) + path.sep;
  const done = db.inTransaction(() => {
    const threads = db.unlinkedOldThreads(userId, cutoffIso);
    if (threads.length === 0) return { threads, paths: [] as string[], messages: 0 };
    const paths = db.attachmentPaths(userId, threads);
    db.deleteAttachments(userId, threads);
    const messages = db.deleteMessages(userId, threads);
    return { threads, paths, messages };
  });
  let filesDeleted = 0;
  for (const p of new Set(done.paths)) {
    const abs = path.resolve(files.resolve(p));
    if (!abs.startsWith(root) || db.fileStillReferenced(p)) continue;
    if (files.deleteFile(abs)) filesDeleted += 1;
  }
  if (done.threads.length > 0) {
    log(`[RcsClear] Auto-delete: ${done.threads.length} chats linked to nothing, ${done.messages} messages, ${filesDeleted} files`);
  }
  return { chats: done.threads.length, messages: done.messages, filesDeleted };
}

/**
 * The shared Android Force re-import result (BACKLOG-3657; founder re-confirmed
 * 2026-10-01): both Android sources — the companion app and Google Messages.
 */
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
 * BACKLOG-3657 (SR F2): the Google Messages clear runs FIRST — it is
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
        `The texts imported from Google Messages were cleared, but the Android Companion texts and contacts were not. ` +
        `Try Force re-import again. (${err instanceof Error ? err.message : String(err)})`,
    };
  }
}
