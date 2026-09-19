/**
 * BACKLOG-3086 launder fixture — Seam A(ii) / the BARREL, not the module.
 *
 * NOT a mistake and NOT dead code. This file exists to BE detected:
 * `electron/services/db/core/__tests__/sqlText.conduitSeam.test.ts` adds this
 * directory to its program and asserts this file is reported, every run. A guard
 * whose detector quietly dies passes just as loudly as one that works.
 *
 * This fixture exists because the first version of that guard banned namespace
 * imports of `dbConnection.ts` BY PATH — and `electron/services/db/index.ts`
 * re-exports all four verbs, so importing the barrel as a namespace handed out the
 * same object A5 retypes, with the ban none the wiser.
 *
 * The lesson is the same one BACKLOG-3072 records, one level up: a module is not its
 * path any more than a type is its name. The guard now asks each specifier's module
 * what it EXPORTS, so a barrel added tomorrow is covered without an edit.
 */
import * as db from "../../../services/db";

const handWritten = `SELECT id FROM contacts WHERE display_name = 'x'`;

const { dbAll: loose }: { dbAll(s: string, p?: unknown[]): unknown[] } = db;

export const laundered = loose(handWritten, ["x"]);
