/**
 * BACKLOG-3926 — Outlook folders and Gmail labels as a matchable catalogue.
 *
 * Pure (no DB, no network, no logging): worker-safe, and the one place that decides
 *   - which folders / labels are SYSTEM (never a match),
 *   - what a nested folder's display path is,
 *   - which names of a path are matched against a deal address,
 *   - which folder ids of a fetched message are worth storing.
 *
 * Folder and label names are the user's own data. Nothing here logs them, and callers
 * must not either (counts only).
 */
import { contentContainsAddressAdjacent, type NormalizedAddress } from "./addressNormalization";

export type MailFolderProvider = "gmail" | "outlook";

/** One row of the catalogue, as stored in `mail_folder_names`. */
export interface MailFolderEntry {
  folderId: string;
  /** "Parent / Child" for nested Outlook folders; the label name for Gmail ("Parent/Child"). */
  displayPath: string;
  /** The path's names that may match (system names are left out). */
  segments: string[];
  isSystem: boolean;
}

/** `users.labels.list` → `response.data.labels[]` (gmailFetchService.discoverLabels). */
export interface RawGmailLabel {
  id?: string | null;
  name?: string | null;
  type?: string | null;
}

/** Graph `mailFolders` / `childFolders` → `value[]` (outlookFetchService.discoverFolders). */
export interface RawOutlookFolder {
  id: string;
  displayName?: string | null;
  parentFolderId?: string | null;
}

/**
 * Gmail's own label ids. `labels.list` marks these `type: "system"`; this list is the
 * fallback when a response carries no `type`.
 */
const GMAIL_SYSTEM_LABEL_IDS = new Set([
  "INBOX",
  "SENT",
  "DRAFT",
  "SPAM",
  "TRASH",
  "UNREAD",
  "STARRED",
  "IMPORTANT",
  "CHAT",
  "YELLOW_STAR",
]);

/** A Gmail label id that is Gmail's own (system or a CATEGORY_* tab). */
export function isGmailSystemLabelId(id: string): boolean {
  return GMAIL_SYSTEM_LABEL_IDS.has(id) || id.startsWith("CATEGORY_");
}

/**
 * Outlook well-known folder names resolved to ids once per catalogue refresh
 * (`GET /me/mailFolders/{name}`). Identified by id, never by display name: a
 * localized mailbox does not call its Inbox "Inbox".
 */
export const OUTLOOK_SYSTEM_WELL_KNOWN_NAMES = [
  "inbox",
  "sentitems",
  "archive",
  "deleteditems",
  "junkemail",
  "drafts",
  "outbox",
  "msgfolderroot",
  "conversationhistory",
  "clutter",
  "scheduled",
  "searchfolders",
  "syncissues",
  "conflicts",
  "localfailures",
  "serverfailures",
  "recoverableitemsdeletions",
] as const;

function splitGmailLabelName(name: string): string[] {
  return name
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function buildGmailCatalog(labels: readonly RawGmailLabel[]): MailFolderEntry[] {
  const out: MailFolderEntry[] = [];
  for (const label of labels) {
    const id = label.id ?? "";
    if (!id) continue;
    const name = (label.name ?? "").trim() || id;
    const isSystem = label.type ? label.type === "system" || isGmailSystemLabelId(id) : isGmailSystemLabelId(id);
    out.push({
      folderId: id,
      displayPath: name,
      segments: isSystem ? [] : splitGmailLabelName(name),
      isSystem,
    });
  }
  return out;
}

/**
 * Outlook: build each folder's path from the `parentFolderId` chain inside the
 * listing. A parent outside the listing (the mailbox root) ends the chain. System
 * folders appear in the display path ("Inbox / Deals") but never in `segments`.
 */
export function buildOutlookCatalog(
  folders: readonly RawOutlookFolder[],
  systemFolderIds: ReadonlySet<string>,
): MailFolderEntry[] {
  const byId = new Map<string, RawOutlookFolder>();
  for (const f of folders) if (f.id) byId.set(f.id, f);
  const out: MailFolderEntry[] = [];
  for (const f of byId.values()) {
    const chain: RawOutlookFolder[] = [];
    const seen = new Set<string>();
    let cur: RawOutlookFolder | undefined = f;
    while (cur && !seen.has(cur.id) && chain.length < 32) {
      seen.add(cur.id);
      chain.unshift(cur);
      cur = cur.parentFolderId ? byId.get(cur.parentFolderId) : undefined;
    }
    const name = (x: RawOutlookFolder): string => (x.displayName ?? "").trim();
    const isSystem = systemFolderIds.has(f.id);
    out.push({
      folderId: f.id,
      displayPath: chain.map(name).filter((n) => n.length > 0).join(" / ") || f.id,
      segments: isSystem
        ? []
        : chain.filter((x) => !systemFolderIds.has(x.id)).map(name).filter((n) => n.length > 0),
      isSystem,
    });
  }
  return out;
}

/** Does this catalogue entry name the deal's address? System entries never do. */
export function folderEntryMatchesAddress(
  entry: Pick<MailFolderEntry, "segments" | "isSystem">,
  address: NormalizedAddress,
): boolean {
  if (entry.isSystem) return false;
  return entry.segments.some((s) => contentContainsAddressAdjacent(s, address));
}

/**
 * The folder ids of one fetched message worth storing. Outlook: its one parent
 * folder. Gmail: its labels minus Gmail's own (those never match, and every message
 * carries several of them).
 */
export function folderIdsForMessage(
  provider: MailFolderProvider,
  email: { parentFolderId?: string | null; labels?: readonly string[] | null },
): string[] {
  if (provider === "outlook") return email.parentFolderId ? [email.parentFolderId] : [];
  const ids = (email.labels ?? []).filter((id) => typeof id === "string" && id.length > 0 && !isGmailSystemLabelId(id));
  return [...new Set(ids)];
}

/** "Outlook folder: <path>" / "Gmail label: <path>" — the title-row text. */
export function folderMatchLabel(provider: MailFolderProvider, displayPath: string): string {
  return `${provider === "outlook" ? "Outlook folder" : "Gmail label"}: ${displayPath}`;
}
