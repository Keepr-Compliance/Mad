/**
 * Who last wrote an item's done and note parts — BACKLOG-4263 PR-11c (local migration v85).
 *
 * ## Writers set the author in the SAME statement as the value
 *
 *   - the UI tick and note (checklistSql.ts SET_CHECKLIST_ITEM_CHECKED_SQL / SET_CHECKLIST_ITEM_NOTE_SQL): `agent`;
 *   - the pull (cloudSyncTodoPullDb.ts writeLocal / insertItem) and the confirm write-back
 *     (cloudSyncTodoDbService.ts): from the server part's `by`, `app` and `at` (`authorFromPart`);
 *   - re-applying a failed write-back (reapplyFailedWrites): NULL (`authorColumns(part, set, null)`).
 * No other statement writes these columns.
 *
 * Cross-column rules the writers keep (pinned by tests, not by CHECKs):
 *   - `*_by_app` is set only with kind `ai_app`;
 *   - `*_by_kind` and `*_by_at` are both set or both NULL;
 *   - `done_by_stamp` is the `checked_at` value of the same statement (NULL when unticked), never recomputed;
 *   - `note_by_*` are all NULL when the note is NULL or blank; otherwise `note_by_digest` is sha256 of the exact
 *     note text the statement binds.
 *
 * ## Validity is checked when the author is READ
 *
 * A tick author is valid only when `is_checked = 1 AND done_by_stamp = checked_at`; a note author only when the note
 * is not blank AND `note_by_digest = sha256(note)`. Any write that does not set these columns (an older build after a
 * downgrade, a raw UPDATE) leaves them mismatched, so the author reads as not recorded (`null`). `kind` is never
 * defaulted: an unknown or missing kind is `null`.
 */
import { createHash } from "crypto";

export type AuthorKind = "agent" | "ai_app";
export type AuthorApp = "anthropic" | "openai";

export interface PartAuthor {
  kind: AuthorKind;
  app: AuthorApp | null;
  /** ISO time of the change. */
  at: string;
}

export interface ReadAuthor {
  kind: AuthorKind;
  app: AuthorApp | null;
}

/** The eight columns, in schema.sql order. */
export const ITEM_AUTHOR_COLUMNS = [
  "done_by_kind",
  "done_by_app",
  "done_by_at",
  "done_by_stamp",
  "note_by_kind",
  "note_by_app",
  "note_by_at",
  "note_by_digest",
] as const;

const KINDS: readonly string[] = ["agent", "ai_app"];
const APPS: readonly string[] = ["anthropic", "openai"];

/** sha256 hex of the exact note text. */
export function noteDigest(note: string): string {
  return createHash("sha256").update(note, "utf8").digest("hex");
}

/** A note that reads as empty: NULL, or only whitespace. */
export function isBlankNote(note: unknown): boolean {
  return typeof note !== "string" || note.trim() === "";
}

/**
 * The author of a part as the server sent it (pull feed or push answer).
 *   `ai_app:<anything>`  -> `ai_app`, app only when it is exactly `anthropic` or `openai`, else NULL
 *   `desktop:<anything>` -> `agent`
 *   anything else        -> null (every author column NULL)
 * `at` is the server's part time; a part with no readable time has no author.
 */
export function authorFromPart(by: unknown, app: unknown, at: unknown): PartAuthor | null {
  if (typeof by !== "string") return null;
  if (typeof at !== "string") return null;
  const ms = Date.parse(at);
  if (Number.isNaN(ms)) return null;
  const iso = new Date(ms).toISOString();
  if (/^ai_app:/.test(by)) {
    return { kind: "ai_app", app: typeof app === "string" && APPS.includes(app) ? (app as AuthorApp) : null, at: iso };
  }
  if (/^desktop:/.test(by)) return { kind: "agent", app: null, at: iso };
  return null;
}

/**
 * The author columns to write together with one part's value columns (`set`, from `partColumns`). Parts other than
 * done and note have no author columns. `author` null writes NULL into every author column of the part.
 */
export function authorColumns(
  part: string,
  set: Record<string, string | number | null>,
  author: PartAuthor | null,
): Record<string, string | number | null> {
  if (part === "done") {
    if (!author) return { done_by_kind: null, done_by_app: null, done_by_at: null, done_by_stamp: null };
    return {
      done_by_kind: author.kind,
      done_by_app: author.kind === "ai_app" ? author.app : null,
      done_by_at: author.at,
      // the SAME value bound to checked_at by this statement, never a second call
      done_by_stamp: set.is_checked === 1 ? (set.checked_at ?? null) : null,
    };
  }
  if (part === "note") {
    const note = set.note;
    if (!author || typeof note !== "string" || isBlankNote(note)) {
      return { note_by_kind: null, note_by_app: null, note_by_at: null, note_by_digest: null };
    }
    return {
      note_by_kind: author.kind,
      note_by_app: author.kind === "ai_app" ? author.app : null,
      note_by_at: author.at,
      note_by_digest: noteDigest(note),
    };
  }
  return {};
}

function readKind(kind: unknown, app: unknown): ReadAuthor | null {
  if (typeof kind !== "string" || !KINDS.includes(kind)) return null;
  const a = kind === "ai_app" && typeof app === "string" && APPS.includes(app) ? (app as AuthorApp) : null;
  return { kind: kind as AuthorKind, app: a };
}

/** The tick author, or null when it is not recorded (validity rule above). */
export function validDoneBy(row: {
  is_checked: unknown;
  checked_at: unknown;
  done_by_kind: unknown;
  done_by_app: unknown;
  done_by_stamp: unknown;
}): ReadAuthor | null {
  if (row.is_checked !== 1) return null;
  if (typeof row.checked_at !== "string" || row.done_by_stamp !== row.checked_at) return null;
  return readKind(row.done_by_kind, row.done_by_app);
}

/** The note author, or null when it is not recorded (validity rule above). */
export function validNoteBy(row: {
  note: unknown;
  note_by_kind: unknown;
  note_by_app: unknown;
  note_by_digest: unknown;
}): ReadAuthor | null {
  if (typeof row.note !== "string" || isBlankNote(row.note)) return null;
  if (typeof row.note_by_digest !== "string" || row.note_by_digest !== noteDigest(row.note)) return null;
  return readKind(row.note_by_kind, row.note_by_app);
}
