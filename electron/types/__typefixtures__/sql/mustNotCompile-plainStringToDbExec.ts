/**
 * CONTROL 1 — fixture per verb: `dbExec`. BACKLOG-3064.
 *
 * Same claim as `mustNotCompile-plainStringToDbGet.ts`, which carries the full
 * reasoning: a bare `string` authored outside the db layer reaches raw multi-statement execution, which takes no bind parameters at all and is therefore the verb with the least between it and the database.
 *
 *   BEFORE -> compiles clean, exit 0. That is the defect.
 *   AFTER  -> TS2345 naming `SafeSql`.
 *
 * It exists SEPARATELY, with its own tsconfig and its own exit code, because the
 * mutation control has to be able to say which signature it reverted. Four errors
 * in one fixture would answer "exit 2" to all four questions.
 */
import { dbExec } from "../../../services/db/core/dbConnection";

declare const handWrittenSql: string;

dbExec(handWrittenSql);
