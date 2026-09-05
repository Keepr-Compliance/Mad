/**
 * BACKLOG-3086 launder fixture — Seam A / the verb reached through the barrel.
 *
 * NOT a mistake and NOT dead code. This file exists to BE detected:
 * `electron/services/db/core/__tests__/sqlText.conduitSeam.test.ts` adds this
 * directory to its program and asserts this file is reported, every run. A guard
 * whose detector quietly dies passes just as loudly as one that works.
 *
 * The guard's header claims the symbol walk resolves through the
 * `electron/services/db/index.ts` re-export chain, so a verb imported from the
 * barrel is the SAME SYMBOL as one imported from `dbConnection.ts`. That claim was
 * written before it was tested. This fixture is the test.
 */
import { dbAll } from "../../../services/db";

const handWritten = `SELECT id FROM contacts WHERE display_name = 'x'`;

const widened = dbAll as (s: string, p?: unknown[]) => unknown[];

export const laundered = widened(handWritten, ["x"]);
