/**
 * BACKLOG-3926 — capture for the folder / label match.
 *
 * Called once per stored fetch batch (`fetchStoreAndDedup`):
 *   1. records which Outlook folder / Gmail labels each fetched message sits in —
 *      already-cached messages included, so mail cached before this existed fills
 *      in as it is fetched again;
 *   2. refreshes the account's folder / label names, at most once per account per
 *      CATALOG_REFRESH_MS, reusing the folder walk / label list the fetch itself just
 *      made when it made one. Two cases skip the throttle:
 *        - the first batch of a force re-cache, per account: always refreshed, from a
 *          walk / list made now;
 *        - the fetch service's latest walk / list differs from what was last
 *          catalogued (a folder or label was added, renamed or moved).
 *      A repeated fetch with an unchanged walk / list stays throttled.
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
/** Fingerprint of the walk / list each account's catalogue was last built from. In memory only. */
const lastCatalogSourceFingerprint = new Map<string, string>();
/** Accounts already refreshed by a force re-cache run, keyed by that run's staging object. */
let forceRunsRefreshed = new WeakMap<object, Set<string>>();

/** Test-only. */
export function __resetMailFolderCaptureForTests(): void {
  lastCatalogRefreshAt.clear();
  lastCatalogSourceFingerprint.clear();
  forceRunsRefreshed = new WeakMap();
}

type OutlookFolderSource = ReadonlyArray<{ id: string; displayName: string; parentFolderId?: string }>;
type GmailLabelSource = ReadonlyArray<{ id: string | null; name: string | null; type: string | null }>;

function fingerprint(provider: MailFolderProvider, source: OutlookFolderSource | GmailLabelSource): string {
  const rows =
    provider === "gmail"
      ? (source as GmailLabelSource).map((l) => [l.id ?? "", l.name ?? "", l.type ?? ""])
      : (source as OutlookFolderSource).map((f) => [f.id, f.displayName, f.parentFolderId ?? ""]);
  return JSON.stringify(rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));
}

/** The fetch service's latest walk / list, fingerprinted; null when it has none. No network. */
function peekSourceFingerprint(provider: MailFolderProvider): string | null {
  try {
    const source =
      provider === "gmail"
        ? gmailFetchService.peekLabelCatalogSource()
        : outlookFetchService.peekFolderCatalogSource();
    return source ? fingerprint(provider, source) : null;
  } catch {
    return null;
  }
}

export async function recordMailFoldersForFetchedEmails(params: {
  provider: MailFolderProvider;
  userId: string;
  accountId: string;
  emails: ReadonlyArray<{ id: string; parentFolderId?: string | null; labels?: readonly string[] | null }>;
  /** The force re-cache run this batch belongs to (its staging object); absent otherwise. */
  forceRun?: object;
}): Promise<void> {
  const { provider, userId, accountId, emails, forceRun } = params;
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
  await refreshMailFolderCatalog(provider, userId, accountId, Date.now(), { forceRun });
}

/** Rebuild the account's folder / label names (throttled; never throws). */
export async function refreshMailFolderCatalog(
  provider: MailFolderProvider,
  userId: string,
  accountId: string,
  now: number = Date.now(),
  opts: { forceRun?: object } = {},
): Promise<void> {
  // A force re-cache refreshes once per run per account, from a walk / list made now.
  let forceFirst = false;
  if (opts.forceRun) {
    const done = forceRunsRefreshed.get(opts.forceRun) ?? new Set<string>();
    forceRunsRefreshed.set(opts.forceRun, done);
    forceFirst = !done.has(accountId);
    done.add(accountId);
  }
  const last = lastCatalogRefreshAt.get(accountId);
  if (!forceFirst && last !== undefined && now - last < CATALOG_REFRESH_MS) {
    // Within the throttle: refresh only when the latest walk / list differs from
    // what was last catalogued.
    const peeked = peekSourceFingerprint(provider);
    if (peeked === null || peeked === lastCatalogSourceFingerprint.get(accountId)) return;
  }
  lastCatalogRefreshAt.set(accountId, now);
  const maxAgeMs = forceFirst ? 0 : CATALOG_REFRESH_MS;
  try {
    let entries: MailFolderEntry[];
    if (provider === "gmail") {
      const labels = await gmailFetchService.listLabelCatalogSource(maxAgeMs);
      lastCatalogSourceFingerprint.set(accountId, fingerprint(provider, labels));
      entries = buildGmailCatalog(labels);
    } else {
      const src = await outlookFetchService.listFolderCatalogSource(maxAgeMs);
      lastCatalogSourceFingerprint.set(accountId, fingerprint(provider, src.folders));
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
    lastCatalogSourceFingerprint.delete(accountId);
    await logService.warn("[BACKLOG-3926] folder / label catalogue not refreshed", MODULE, {
      provider,
      error: error instanceof Error ? error.message : "Unknown",
    });
  }
}
