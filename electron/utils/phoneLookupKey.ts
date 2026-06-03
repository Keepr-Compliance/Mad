/**
 * BACKLOG-1729: This file is intentionally reduced to a 1-line shim.
 *
 * The canonical implementation lives in `./phoneNormalization` (`toLookupKey`).
 * This shim continues to exist because migration v40 calls
 * `require("../utils/phoneLookupKey")` at runtime, and MIGRATION-GUIDE.md
 * forbids modifying applied migrations.
 *
 * TODO(post-v41-baseline): remove when v40 is folded into schema.sql.
 */
export { toLookupKey as normalizePhoneLookupKey } from "./phoneNormalization";
