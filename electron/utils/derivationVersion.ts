/**
 * BACKLOG-2857 — the derivation version stamped on every `emails` row.
 *
 * WHY THIS EXISTS
 * ---------------
 * BACKLOG-2855 fixed how `body_plain` is derived from an Outlook HTML body, and
 * could not touch a single row already stored. Nothing on disk recorded that the
 * existing rows came from superseded logic, so repairing history depended on a
 * human remembering the fix existed — or on a destructive force re-cache
 * (BACKLOG-2856) that throws away every id and link to get there.
 *
 * `emails.derived_version` removes that dependency. Every row records the version
 * of the derivation that produced it; a row below CURRENT_DERIVATION_VERSION is,
 * by definition, holding output from logic that has since been corrected, and the
 * reprocess pass repairs it.
 *
 * AN INTEGER, NOT A BOOLEAN — founder's call, and the reason matters
 * -----------------------------------------------------------------
 * A bit can only say "stale". Once the first reprocess flips it, a SECOND
 * derivation fix cannot distinguish rows that already received fix #1 from rows
 * still carrying the original output. An integer records exactly which
 * transformations a row has seen, so two fixes months apart compose correctly and
 * only the missing steps run.
 *
 * PER ROW, NOT PER ACCOUNT — also his call
 * ----------------------------------------
 * Per-row is resumable: kill the app mid-reprocess and every row's stamp is still
 * accurate, so the next run continues rather than restarting or guessing. A single
 * account-level flag is all-or-nothing and cannot recover from a partial run.
 *
 * HOW TO ADD A VERSION
 * --------------------
 * 1. Bump CURRENT_DERIVATION_VERSION.
 * 2. Add the entry to DERIVATION_VERSIONS below, declaring its REPAIR CLASS.
 * 3. If it is class "local", extend `reDeriveRow` in
 *    `electron/services/emailDerivationReprocessService.ts`.
 * 4. Ship a migration that REPLACES `idx_emails_derived_version_stale` with one
 *    carrying the new literal — SQLite cannot parameterise an index predicate, so
 *    the partial index embeds the number. Skipping this step leaves the pass
 *    CORRECT but costs a table scan for rows between the two literals.
 *
 * A bump with no matching transform is a bug that this module's test catches:
 * the pass would restamp rows without changing them, quietly marking damaged rows
 * repaired.
 */

/**
 * How a version's damage can be repaired.
 *
 * - `"local"`  — re-derivable from data already on disk, NO network. Instant,
 *                deletes nothing, keeps every id and every link.
 * - `"refetch"` — requires an additive re-fetch from the provider. `bcc`,
 *                `in_reply_to` and `sent_at` are the known cases: stored wrong or
 *                NULL by earlier bugs and not recoverable from local data.
 *
 * NOTHING IMPLEMENTS `"refetch"` TODAY, deliberately (BACKLOG-2857 ships class 1
 * only). The type exists so a future version can declare itself and the pass can
 * route it, rather than a later author having to re-derive the distinction.
 */
export type DerivationRepairClass = "local" | "refetch";

export interface DerivationVersionSpec {
  version: number;
  repairClass: DerivationRepairClass;
  /** What changed, and which backlog item changed it. */
  description: string;
}

/**
 * Version 0 is not listed: it is the implicit "produced before any of this
 * existed" state that `DEFAULT 0` gives every pre-existing row. That default is
 * load-bearing — see the column comment in schema.sql. Never backfill it.
 */
export const DERIVATION_VERSIONS: readonly DerivationVersionSpec[] = [
  {
    version: 1,
    repairClass: "local",
    description:
      "body_plain derived from the full body_html via htmlToPlainText, replacing Graph's 255-char bodyPreview (BACKLOG-2855)",
  },
] as const;

/**
 * The version the CURRENT code produces. Rows below this are stale.
 *
 * MUST equal the literal in `idx_emails_derived_version_stale` (migration v66).
 */
export const CURRENT_DERIVATION_VERSION = 1;

/** The spec for a version, or undefined if the version is unknown. */
export function getDerivationVersionSpec(
  version: number,
): DerivationVersionSpec | undefined {
  return DERIVATION_VERSIONS.find((v) => v.version === version);
}

/**
 * Every repair class needed to bring a row at `fromVersion` up to current.
 *
 * A caller uses this to decide whether a pass can run offline: if the result
 * contains `"refetch"`, some of the work needs the provider. Repairing from 0
 * today returns `["local"]`, which is why the founder's mailbox can be fixed
 * without a re-download.
 */
export function repairClassesFrom(fromVersion: number): DerivationRepairClass[] {
  const classes = new Set<DerivationRepairClass>();
  for (const spec of DERIVATION_VERSIONS) {
    if (spec.version > fromVersion && spec.version <= CURRENT_DERIVATION_VERSION) {
      classes.add(spec.repairClass);
    }
  }
  return [...classes];
}

/** True when every step from `fromVersion` to current is purely local. */
export function isLocallyRepairable(fromVersion: number): boolean {
  return !repairClassesFrom(fromVersion).includes("refetch");
}
