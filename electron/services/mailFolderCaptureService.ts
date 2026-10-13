/**
 * BACKLOG-3926 — capture for the folder / label match.
 *
 * Called once per stored fetch batch (`fetchStoreAndDedup`):
 *   1. records which Outlook folder / Gmail labels each fetched message sits in —
 *      already-cached messages included, so mail cached before this existed fills
 *      in as it is fetched again;
 *   2. refreshes the account's folder / label names, at most once per account per
 *      CATALOG_REFRESH_MS, reusing the folder walk / label list the fetch itself just
 *      made when it made one.
 *
 * Never throws (a failure here must not fail a sync). Logs counts only: folder and
 * label names are user data and are never logged or sent to Sentry.
 */
import logService from "./logService";
import gmailFetchService from "./gmailFetchService";
import outlookFetchService from "./outlookFetchService";
import { replaceMailFolderCatalog, replaceMailFolderRefs } from "./db/mailFolderDb";
import { yieldToEventLoop } from "./autoLinkSweepGuard";
import {
  buildGmailCatalog,
  buildOutlookCatalog,
  folderIdsForMessage,
  type MailFolderEntry,
  type MailFolderProvider,
} from "../utils/mailFolderCatalog";

const MODULE = "MailFolderCapture";

/** How long a catalogue (and a fetch's own folder walk / label list) is reused. */
export const CATALOG_REFRESH_MS = 10 * 60_000;

/** Messages whose folder rows are rewritten per transaction, with a yield between. */
const REFS_PER_TRANSACTION = 100;

const lastCatalogRefreshAt = new Map<string, number>();

/** Test-only. */
export function __resetMailFolderCaptureForTests(): void {
  lastCatalogRefreshAt.clear();
}

export async function recordMailFoldersForFetchedEmails(params: {
  provider: MailFolderProvider;
  userId: string;
  accountId: string;
  emails: ReadonlyArray<{ id: string; parentFolderId?: string | null; labels?: readonly string[] | null }>;
}): Promise<void> {
  const { provider, userId, accountId, emails } = params;
  const messages = emails.map((e) => ({ externalId: e.id, folderIds: folderIdsForMessage(provider, e) }));
  try {
    for (let i = 0; i < messages.length; i += REFS_PER_TRANSACTION) {
      if (i > 0) await yieldToEventLoop();
      replaceMailFolderRefs(userId, accountId, messages.slice(i, i + REFS_PER_TRANSACTION));
    }
  } catch (error) {
    await logService.warn("[BACKLOG-3926] folder / label ids not recorded for a fetch batch", MODULE, {
      provider,
      messages: messages.length,
      error: error instanceof Error ? error.message : "Unknown",
    });
  }
  await refreshMailFolderCatalog(provider, userId, accountId);
}

/** Rebuild the account's folder / label names (throttled; never throws). */
export async function refreshMailFolderCatalog(
  provider: MailFolderProvider,
  userId: string,
  accountId: string,
  now: number = Date.now(),
): Promise<void> {
  const last = lastCatalogRefreshAt.get(accountId);
  if (last !== undefined && now - last < CATALOG_REFRESH_MS) return;
  lastCatalogRefreshAt.set(accountId, now);
  try {
    let entries: MailFolderEntry[];
    if (provider === "gmail") {
      entries = buildGmailCatalog(await gmailFetchService.listLabelCatalogSource(CATALOG_REFRESH_MS));
    } else {
      const src = await outlookFetchService.listFolderCatalogSource(CATALOG_REFRESH_MS);
      entries = buildOutlookCatalog(src.folders, new Set(src.systemFolderIds));
    }
    // An empty listing (cancelled walk, transient failure) never replaces a catalogue.
    if (entries.length === 0) return;
    const changed = replaceMailFolderCatalog(userId, accountId, provider, entries);
    await logService.info("[BACKLOG-3926] folder / label catalogue refreshed", MODULE, {
      provider,
      changed,
      entries: entries.length,
      system: entries.filter((e) => e.isSystem).length,
    });
  } catch (error) {
    lastCatalogRefreshAt.delete(accountId);
    await logService.warn("[BACKLOG-3926] folder / label catalogue not refreshed", MODULE, {
      provider,
      error: error instanceof Error ? error.message : "Unknown",
    });
  }
}
