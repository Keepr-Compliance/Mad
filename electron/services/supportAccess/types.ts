/**
 * Support access mode — shared types (BACKLOG-2393)
 *
 * A user grants Keepr support access for a *bounded* period. Inside that window
 * the app captures deeper, subsystem-scoped detail and uploads it. Outside it,
 * nothing is captured and nothing leaves the machine.
 *
 * Two properties everything else depends on:
 *
 *  1. The window is **wall-clock** and stored as an absolute instant
 *     (`expiresAt`). It is never a countdown or a timer, so a restart — or a
 *     crash, or a laptop lid closed for a week — cannot silently extend it.
 *  2. The consent record names the *exact wording* the user agreed to. If the
 *     disclosure text changes later we must still be able to answer "what did
 *     this person actually see?".
 */

import type { SupportLogScopeId } from "./scopes";

/** Identifier for one of the four offered grant durations. */
export type SupportAccessDurationId = "24h" | "7d" | "14d" | "30d";

export interface SupportAccessDuration {
  id: SupportAccessDurationId;
  /** Human label shown on the grant screen. */
  label: string;
  /** Length of the window in milliseconds. */
  ms: number;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * The offered durations, in the order they are presented.
 *
 * Deliberately a short, closed list. A free-form "days" field invites a user to
 * type 365 and forget, which is the thing the bounded window exists to prevent.
 */
export const SUPPORT_ACCESS_DURATIONS: readonly SupportAccessDuration[] = [
  { id: "24h", label: "24 hours", ms: DAY_MS },
  { id: "7d", label: "7 days", ms: 7 * DAY_MS },
  { id: "14d", label: "14 days", ms: 14 * DAY_MS },
  { id: "30d", label: "30 days", ms: 30 * DAY_MS },
] as const;

/** Default selection on the grant screen. */
export const DEFAULT_SUPPORT_ACCESS_DURATION: SupportAccessDurationId = "7d";

export function findDuration(
  id: SupportAccessDurationId,
): SupportAccessDuration | undefined {
  return SUPPORT_ACCESS_DURATIONS.find((d) => d.id === id);
}

/**
 * What a user agreed to, and when. Persisted, and shipped inside every
 * uploaded report so the consent travels with the data it authorised.
 */
export interface SupportConsentRecord {
  /** Stable id for this grant. */
  id: string;
  /** ISO 8601, wall-clock, at the moment the user confirmed. */
  grantedAt: string;
  /** ISO 8601, absolute. The window ends here regardless of restarts. */
  expiresAt: string;
  durationId: SupportAccessDurationId;
  /** App version at the moment of consent. */
  appVersion: string;
  /** Stable identifier for the disclosure wording shown. */
  disclosureId: string;
  /** sha256 of the exact disclosure text shown, hex. */
  disclosureHash: string;
  /** The exact disclosure text shown, stored verbatim. */
  disclosureText: string;
  /** Subsystems the user granted deeper logging for. */
  scopes: SupportLogScopeId[];
  /** How the grant ended, once it has. */
  endedAt?: string;
  endedReason?: SupportAccessEndReason;
}

/**
 * How a window ended.
 *
 * `scopes-unavailable` is not a clock or a user action: it is a grant whose
 * every selected scope has since been removed from the app (BACKLOG-2428
 * removed one). `grant()` has always refused a window with nothing to collect;
 * this is the same rule applied on load, where it was missing.
 *
 * It is a distinct reason rather than reusing `expired` because the consent
 * record is an audit artifact — writing "expired" for a window the clock never
 * reached would be a false record, which is the class of defect this whole
 * area exists to remove.
 */
export type SupportAccessEndReason =
  | "expired"
  | "revoked"
  | "scopes-unavailable";

export interface SupportAccessState {
  /** True only while `now < expiresAt` for the current grant. */
  active: boolean;
  /** The current grant, or the most recent one if it has ended. */
  consent: SupportConsentRecord | null;
  /** Milliseconds remaining, or 0 when inactive. */
  msRemaining: number;
  /** Past grants, newest first. Capped — see SupportAccessService. */
  history: SupportConsentRecord[];
  /**
   * True once any grant has ever been made. Drives the empty state: users who
   * have never used this should not be shown an empty report list.
   */
  everGranted: boolean;
}

/** Why a diagnostic report was captured. */
export type SupportReportReason = "scheduled" | "error" | "manual";

export type SupportReportState = "queued" | "sent" | "failed";

/**
 * On-disk metadata for one captured report. Written alongside the gzipped
 * payload so the list can be rendered without decompressing anything.
 */
export interface SupportReportMeta {
  id: string;
  /** ISO 8601. */
  capturedAt: string;
  reason: SupportReportReason;
  /** Size of the gzipped payload on disk, bytes. */
  byteSize: number;
  /** Uncompressed size before gzip, bytes. Shown so "what it covers" is honest. */
  rawByteSize: number;
  /** Subsystems included in this report. */
  scopes: SupportLogScopeId[];
  /** Human summary of what the report covers, for the list row. */
  covers: string;
  state: SupportReportState;
  /** True when log content had to be dropped to fit the upload cap. */
  truncated: boolean;
  /** Bytes of log content dropped by truncation. */
  truncatedBytes: number;
  /** The grant this report was captured under. */
  consentId: string;
  /**
   * Local retention deadline, ISO 8601, set at capture.
   *
   * Separate from `serverExpiresAt` because a report that never uploaded has no
   * server deadline at all — and used to have none of any kind, so an offline
   * capture sat on disk holding client names indefinitely.
   */
  localExpiresAt?: string;
  /** ISO 8601, set once uploaded. */
  sentAt?: string;
  /** Server-side retention deadline, ISO 8601. Drives "deleted in N days". */
  serverExpiresAt?: string;
  /** Set once uploaded, so delete can reach the server. */
  remote?: SupportRemoteRef;
  /** Last failure, surfaced in the list rather than swallowed. */
  lastError?: string;
}

/** Everything needed to delete an uploaded report from the server. */
export interface SupportRemoteRef {
  ticketId: string;
  attachmentId: string;
  storagePath: string;
}

/** The payload handed to a transport. */
export interface SupportReportUpload {
  meta: SupportReportMeta;
  /** Gzipped report body. */
  body: Buffer;
  fileName: string;
  contentType: string;
  /** Days the server should retain this before purging it. */
  retentionDays: number;
}

export interface SupportUploadResult {
  remote: SupportRemoteRef;
  /** ISO 8601 retention deadline reported by the server. */
  expiresAt: string;
}

/**
 * The seam between "decide whether to send" and "actually send".
 *
 * Kept narrow on purpose: the window guard lives on the calling side, and tests
 * assert on what a fake transport was handed. Asserting on the outbound payload
 * is the only way to show that nothing leaves outside the window — reading the
 * guard's source proves nothing.
 */
export interface SupportUploadTransport {
  upload(upload: SupportReportUpload): Promise<SupportUploadResult>;
  /**
   * Remove the stored object *and* the attachment row. Must reject if either
   * fails — a delete that only cleared the local copy while the server kept
   * one is a lie told by a button.
   */
  deleteRemote(ref: SupportRemoteRef): Promise<void>;
}

/** A row in the Settings list. Meta plus derived, display-ready fields. */
export interface SupportReportListItem extends SupportReportMeta {
  /** Whole days until the server deletes it. Undefined until sent. */
  serverDeleteInDays?: number;
  /**
   * Whole days until this Mac drops it. Only for reports with no server copy —
   * once sent, the server deadline is the one that matters.
   */
  localDeleteInDays?: number;
}
