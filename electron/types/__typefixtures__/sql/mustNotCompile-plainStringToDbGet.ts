/**
 * CONTROL 1 — fixture per verb: dbGet. BACKLOG-3064.
 *
 * The whole item in one line: a bare `string`, authored anywhere, reaching a
 * database verb.
 *
 *   BEFORE the brand exists -> this file COMPILES CLEAN (exit 0).
 *     That is the defect. `dbGet(sql: string, ...)` accepts any string from any
 *     file, so "SQL text lives in electron/services/db/**" is a rule the compiler
 *     has no opinion about — which is why it has only ever been enforced by a text
 *     matcher, and why four separate items found four ways past that matcher.
 *
 *   AFTER the brand exists -> tsc must FAIL with TS2345 naming `SafeSql`.
 *
 * ONE FIXTURE PER VERB, each with its own tsconfig and therefore its own exit
 * code. A single fixture carrying four errors would leave three signatures
 * mutation-blind: revert `dbRun` to `string` and a combined fixture still exits 2
 * because `dbGet` failed, so the mutation control could not tell which signature
 * it had just destroyed. BACKLOG-3067's mutation run proved the same hazard one
 * level down — removing a brand left tsc exiting 2 anyway, and only the
 * DIAGNOSTIC TEXT assertion caught it.
 *
 * It imports the REAL conduit, not a local re-declaration. A control that
 * re-declares the signature it is testing proves only that the control agrees
 * with itself.
 */
import { dbGet } from "../../../services/db/core/dbConnection";

// `declare const` conjures the value with zero runtime and zero fixture setup, so
// the only thing under test is the assignability of the argument to the parameter.
declare const handWrittenSql: string;

void dbGet<{ id: string }>(handWrittenSql, ["some-id"]);
