/**
 * WindowApi RCS import sub-interface — BACKLOG-3619 (proof of concept).
 *
 * The renderer's view of `window.api.rcsImport`: the bridge's state, the Sync
 * jobs, the Google Messages cache Sync and its setup (BACKLOG-3658/3659). The
 * manual import session is gone (BACKLOG-3662).
 */

export type RcsBridgeState = "stopped" | "listening" | "unavailable";

export interface RcsImportStatus {
  bridge: RcsBridgeState;
  port: number;
  reason?: string;
}

export type RcsImportStatusResult =
  | { success: true; status: RcsImportStatus }
  | { success: false; error: string };

export type RcsJobState = "created" | "running" | "finished" | "failed" | "cancelled";

export interface RcsJobProgressCounts {
  listed: number;
  candidates: number;
  checked: number;
  matched: number;
  imported: number;
  messages: number;
  images: number;
  reactions: number;
  skipped: number;
  /** BACKLOG-3645: chats the page did not check (list over the cap). */
  notChecked?: number;
  /** BACKLOG-3642: messages stored but not linked again — the user removed them. */
  removedNotRelinked?: number;
  /** BACKLOG-3658: cache images not kept (no transaction contact in the chat). */
  imagesSkipped?: number;
}

/** BACKLOG-3620: one sync job, as main reports it. */
export interface RcsJobInfo {
  jobId: string;
  transactionId: string;
  state: RcsJobState;
  stage: string;
  progress: RcsJobProgressCounts;
  contactsWithoutPhone: string[];
  error?: { code: string; message: string };
  createdAt: string;
  finishedAt?: string;
  /** BACKLOG-3661: what is syncing (the transaction's name). */
  label?: string;
  /** BACKLOG-3658: "cache" for the all-chats cache job. */
  kind?: "transaction" | "cache";
  /** BACKLOG-3629: chats left out or imported in part. Names only. */
  notReached?: Array<{ name: string; reason: string; count?: number }>;
  notReachedMore?: number;
}

/** BACKLOG-3658: the extension and cache state, for the setup wizard. */
export interface RcsExtensionState {
  extensionVersion: string | null;
  extensionSeenAt: string | null;
  pairedAt: string | null;
  /** The consent is current (P3b). */
  optedIn: boolean;
  lastCacheFinishedAt: string | null;
  /** P3b: the version the user accepted (null: never / withdrawn), and the one required now. */
  consentVersion?: number | null;
  consentRequired?: number;
  consentAt?: string | null;
  /** P3b: auto-delete of old chats linked to nothing (null = off). */
  autoDeleteDays?: number | null;
}

export type RcsExtensionStateResult =
  | { success: true; state: RcsExtensionState }
  | { success: false; error: string };

/** BACKLOG-3659 P3d: Google Messages' own Force re-import. */
export type RcsClearTextsResult =
  | { success: true; messagesDeleted: number; linksDeleted: number; filesDeleted: number }
  | { success: false; error: string };

/** BACKLOG-3659: the extension copied to Downloads. */
export type RcsPrepareExtensionResult =
  | { success: true; folder: string; version: string }
  | { success: false; error: string };

export type RcsImportJobResult =
  | { success: true; job: RcsJobInfo | null }
  | { success: false; error: string };

export interface WindowApiRcsImport {
  /** Bridge state. */
  getStatus: () => Promise<RcsImportStatusResult>;
  /** BACKLOG-3620: start a sync job (opens Messages for Web in the browser). */
  startJob: (args: { transactionId: string }) => Promise<RcsImportJobResult>;
  /** BACKLOG-3620: cancel the job, if it is still the one named. */
  cancelJob: (args: { jobId: string }) => Promise<RcsImportJobResult>;
  /** BACKLOG-3620: the current job, if any. */
  getJob: () => Promise<RcsImportJobResult>;
  /** BACKLOG-3620: every job change. Returns an unsubscribe. */
  onJobProgress: (callback: (job: RcsJobInfo) => void) => () => void;
  /** BACKLOG-3657: Google Messages for Web texts were cleared. Returns an unsubscribe. */
  onDataCleared: (callback: (event: { messagesDeleted: number }) => void) => () => void;
  /** BACKLOG-3658: a cache Sync was saved and auto-linked. Returns an unsubscribe. */
  onDataChanged?: (callback: (event: { reason: string }) => void) => () => void;
  /**
   * BACKLOG-3658: start the cache job (all recent chats), for the signed-in
   * user. `sinceDays` (1..3650) is a DEV-ONLY window override, ignored in a
   * packaged build.
   */
  startCacheJob: (args?: { sinceDays?: number }) => Promise<RcsImportJobResult>;
  /** BACKLOG-3658: the local opt-in to keep a copy of recent chats. */
  setCacheOptIn: (args: { optedIn: boolean }) => Promise<{ success: boolean; error?: string }>;
  /** P3b: accept the consent text of `version`, or withdraw (null). */
  setCacheConsent?: (args: { version: number | null }) => Promise<{ success: boolean; error?: string }>;
  /** P3b: cache options (auto-delete; contacts-only in a development build only). */
  setCacheOptions?: (args: { autoDelete?: boolean; contactsOnly?: boolean }) => Promise<{ success: boolean; error?: string }>;
  /** BACKLOG-3658: is the extension installed / paired, opted in, last cache Sync. */
  getExtensionState: () => Promise<RcsExtensionStateResult>;
  /** BACKLOG-3659 P3d: clear every text imported from Google Messages (Force re-import). */
  clearTexts?: () => Promise<RcsClearTextsResult>;
  /** BACKLOG-3659: copy the extension to Downloads/"Keepr Extension". */
  prepareExtension?: () => Promise<RcsPrepareExtensionResult>;
  /** BACKLOG-3659: show that folder in the file manager. */
  showExtensionFolder?: () => Promise<{ success: boolean }>;
  /** BACKLOG-3659: copy "chrome://extensions" and start Chrome. */
  openChromeForExtension?: () => Promise<{ success: true; copied: boolean; opened: boolean }>;
}
