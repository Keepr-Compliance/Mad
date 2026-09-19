/**
 * BACKLOG-3086 launder fixture — Seam B / an ambient CONST, not a function.
 *
 * NOT a mistake and NOT dead code. This file exists to BE detected:
 * `electron/services/db/core/__tests__/sqlText.conduitSeam.test.ts` adds this
 * directory to its program and asserts this file is reported, every run. A guard
 * whose detector quietly dies passes just as loudly as one that works.
 *
 * This fixture exists because the ambient-VARIABLE branch of `uncheckedOutputType`
 * had no fixture and was therefore an untested branch. `declare` sits on the
 * VariableSTATEMENT while the annotation sits on the VariableDECLARATION, so the
 * branch depends on `getCombinedModifierFlags` walking up — which is asserted here
 * rather than believed.
 */
import { dbAll } from "../../../services/db/core/dbConnection";
import type { SafeSql } from "../../../services/db/core/sqlText";

declare const preMinted: SafeSql;

export const laundered = dbAll(preMinted, ["x"]);
