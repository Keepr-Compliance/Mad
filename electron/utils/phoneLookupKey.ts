/**
 * BACKLOG-1729: This file is intentionally reduced to a 1-line shim.
 *
 * The canonical implementation lives in `./phoneNormalization` (`toLookupKey`).
 * This shim continues to exist because migration v40 calls
 * `require("../utils/phoneLookupKey")` at runtime, and MIGRATION-GUIDE.md
 * forbids modifying applied migrations.
 *
 * BACKLOG-2635: `toLookupKey` semantics changed (IL national forms and
 * CC-included international forms key differently). v40 therefore backfills
 * NEW keys on fresh upgrade paths — deliberate; see the finding pinned in
 * `databaseService.migration-v40.test.ts` and the re-key migration scoped on
 * the BACKLOG-2635 PR.
 *
 * TODO(post-v41-baseline): remove when v40 is folded into schema.sql.
 */
export { toLookupKey as normalizePhoneLookupKey } from "./phoneNormalization";
