/**
 * WindowApi RCS import sub-interface — BACKLOG-3619 (proof of concept).
 *
 * The renderer's view of `window.api.rcsImport`: open / close the one import
 * session the Chrome extension posts chats into, read the bridge's state, and
 * hear about each chat as it lands.
 */

export type RcsBridgeState = "stopped" | "listening" | "unavailable";

export interface RcsImportSessionInfo {
  sessionId: string;
  transactionId: string;
  chatsReceived: number;
  messagesReceived: number;
  messagesStored: number;
  startedAt: string;
}

export interface RcsImportStatus {
  bridge: RcsBridgeState;
  port: number;
  reason?: string;
  session: RcsImportSessionInfo | null;
}

export type RcsImportStatusResult =
  | { success: true; status: RcsImportStatus }
  | { success: false; error: string };

export interface RcsChatReceivedEvent {
  sessionId: string;
  transactionId: string;
  conversationTitle: string;
  received: number;
  stored: number;
  alreadyPresent: number;
  linked: number;
  reactions: number;
  reactionsStored: number;
  session: RcsImportSessionInfo;
}

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
  optedIn: boolean;
  lastCacheFinishedAt: string | null;
}

export type RcsExtensionStateResult =
  | { success: true; state: RcsExtensionState }
  | { success: false; error: string };

export type RcsImportJobResult =
  | { success: true; job: RcsJobInfo | null }
  | { success: false; error: string };

export interface WindowApiRcsImport {
  /** Bridge + session state. */
  getStatus: () => Promise<RcsImportStatusResult>;
  /** Open the import session for a transaction (replaces any open session). */
  startSession: (args: { transactionId: string }) => Promise<RcsImportStatusResult>;
  /** Close the import session, if it is still the one named. */
  endSession: (args: { sessionId: string }) => Promise<RcsImportStatusResult>;
  /** One call per chat received. Returns an unsubscribe. */
  onChatReceived: (callback: (event: RcsChatReceivedEvent) => void) => () => void;
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
  /** BACKLOG-3658: is the extension installed / paired, opted in, last cache Sync. */
  getExtensionState: () => Promise<RcsExtensionStateResult>;
}
