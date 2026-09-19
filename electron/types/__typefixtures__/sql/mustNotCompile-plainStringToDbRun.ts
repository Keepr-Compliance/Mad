/**
 * CONTROL 1 — fixture per verb: `dbRun`. BACKLOG-3064.
 *
 * Same claim as `mustNotCompile-plainStringToDbGet.ts`, which carries the full
 * reasoning: a bare `string` authored outside the db layer reaches a WRITE — the verb where a wrong statement does damage rather than returning nothing.
 *
 *   BEFORE -> compiles clean, exit 0. That is the defect.
 *   AFTER  -> TS2345 naming `SafeSql`.
 *
 * It exists SEPARATELY, with its own tsconfig and its own exit code, because the
 * mutation control has to be able to say which signature it reverted. Four errors
 * in one fixture would answer "exit 2" to all four questions.
 */
import { dbRun } from "../../../services/db/core/dbConnection";

declare const handWrittenSql: string;

void dbRun(handWrittenSql, ["some-id"]);
