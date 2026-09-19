/**
 * BACKLOG-3086 launder fixture — Seam A(ii) / P10-P12 — the namespace object routes around the symbol walk.
 *
 * NOT a mistake and NOT dead code. This file exists to BE detected:
 * `electron/services/db/core/__tests__/sqlText.conduitSeam.test.ts` adds this
 * directory to its program and asserts this file is reported, every run. A guard
 * whose detector quietly dies passes just as loudly as one that works.
 *
 * It compiles clean under the real settings — that is the whole point.
 */
import * as conduit from "../../../services/db/core/dbConnection";

const handWritten = `SELECT id FROM contacts WHERE display_name = 'x'`;

// Destructuring with an annotation retypes the binding without ever writing an
// assertion. The identifier's symbol is the ANNOTATION's member, not the export —
// which is why the namespace import itself has to be the thing that is banned.
const { dbAll: loose }: { dbAll(s: string, p?: unknown[]): unknown[] } = conduit;

export const laundered = loose(handWritten, ["x"]);
