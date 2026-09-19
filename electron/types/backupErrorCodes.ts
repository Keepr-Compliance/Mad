/**
 * Every `BackupErrorCode`, once, as data — so the union cannot silently lose or
 * gain a member (BACKLOG-2953).
 *
 * THIS FILE HAS ONE `import type` AND NO RUNTIME IMPORTS ON PURPOSE. It is a leaf.
 *
 * WHY THIS EXISTS: `backupService.ts:897` returned
 * `errorCode: "BACKUP_FAILED" as BackupErrorCode` — a string that was never a
 * member of the union, made to compile by the cast. BACKLOG-2913 had just widened
 * the union with real, code-derived failure kinds, which is exactly the design
 * that invites an exhaustive `switch`; the first such switch would have let
 * `"BACKUP_FAILED"` fall through in silence because the compiler believed the
 * value could not occur. The tuple + assert below is the pin against the next one.
 *
 * NO PRODUCTION IMPORTER, BY DESIGN. Unlike `IMPORT_PHASES`
 * (`electron/types/ipc/importPhase.ts`), which `SyncOrchestratorService` reads at
 * runtime for `indexOf` progress weighting, NOTHING in `electron/` or `src/`
 * imports `BACKUP_ERROR_CODES` for its value. Its whole job is the compile-time
 * assert at the bottom of this file, which `npm run type-check` performs because
 * `tsconfig.json` includes `electron/**` by PATH, not by import graph. A dead-code
 * sweep that deletes this file deletes that check with it. Do not delete it as
 * "unused"; it is used by `tsc`.
 *
 * DELIBERATELY IN NO BARREL. `src/types/index.ts` does
 * `export * from "../../electron/types/backup"`, so anything with a runtime value
 * in `backup.ts` would be one value-import away from the Vite bundle, where
 * `vite.config.js` (`esbuild.include`) applies the TS loader only under `src/` —
 * see the boundary note in `electron/types/ipc/communicationLifecycle.ts`. That is
 * why the tuple lives HERE and not beside the union: `backup.ts` stays type-only
 * and renderer-reachable, this file holds the value and is reachable by nothing.
 * It is not exported from `electron/types/index.ts`, `electron/types/ipc/index.ts`
 * or `src/types/index.ts`, and must stay out of all three.
 *
 * Pinned by `__tests__/backupErrorCodes-2953.test.ts`, which adds the exhaustive
 * `switch` (type-checked by `npm run type-check:tests`, since `tsconfig.json`
 * excludes test files) and the mutual-`extends` equality between the union and
 * the tuple's element type.
 */

import type { BackupErrorCode } from "./backup";

/**
 * Every member of `BackupErrorCode`, exactly once. Order is the union's
 * declaration order in `backup.ts`; nothing depends on it.
 */
export const BACKUP_ERROR_CODES = [
  "PASSWORD_REQUIRED",
  "INCORRECT_PASSWORD",
  "DEVICE_NOT_FOUND",
  "DEVICE_LOCKED",
  "BACKUP_CANCELLED",
  "BACKUP_TIMEOUT",
  "INSUFFICIENT_SPACE",
  "DECRYPTION_FAILED",
  "CONNECTION_LOST",
  "SERVICE_UNAVAILABLE",
  "BACKUP_FILE_MISSING",
  "INVALID_UDID",
  "UNKNOWN_ERROR",
] as const;

/**
 * Compile-time proof that `BACKUP_ERROR_CODES` lists every member of the union and
 * nothing else — the pin is two-directional across the file split:
 *
 * - `Tuple extends readonly Union[]` rejects an EXTRA entry: remove a member from
 *   the union in `backup.ts` while it is still listed here and `tsc` fails on the
 *   constraint (TS2344) naming that string.
 * - The `Exclude` arm rejects a MISSING entry: add a member to the union without
 *   listing it here and `tsc` fails on the assignment below (TS2322) with the
 *   missing name in the error text.
 *
 * Copied from `importPhase.ts` / `communicationLifecycle.ts` rather than shared,
 * so each leaf stays import-free.
 */
type AssertTupleCoversUnion<
  Union extends string,
  Tuple extends readonly Union[],
> = Exclude<Union, Tuple[number]> extends never
  ? true
  : { readonly missingFromBackupErrorCodes: Exclude<Union, Tuple[number]> };

const _BACKUP_ERROR_CODES_COVER_THE_UNION: AssertTupleCoversUnion<
  BackupErrorCode,
  typeof BACKUP_ERROR_CODES
> = true;
void _BACKUP_ERROR_CODES_COVER_THE_UNION;
