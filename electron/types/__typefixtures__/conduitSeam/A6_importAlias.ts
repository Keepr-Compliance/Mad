/**
 * BACKLOG-3086 launder fixture — Seam A / the import alias.
 *
 * NOT a mistake and NOT dead code. This file exists to BE detected:
 * `electron/services/db/core/__tests__/sqlText.conduitSeam.test.ts` adds this
 * directory to its program and asserts this file is reported, every run. A guard
 * whose detector quietly dies passes just as loudly as one that works.
 *
 * This one is here because the FIRST version of that guard missed it. The walk
 * began with `CONDUIT_VERBS.includes(node.text)` as a cheap gate before resolving
 * the symbol, so the identifier `q` was never even visited — a checker-based guard
 * that was still, underneath, matching a name. It stayed green on this file.
 *
 * BACKLOG-3072's whole finding is that a name can be spelled unboundedly many ways.
 * This fixture is what stops that lesson being un-learned here.
 */
import { dbAll as q } from "../../../services/db/core/dbConnection";

const handWritten = `SELECT id FROM contacts WHERE display_name = 'x'`;

const widened = q as (s: string, p?: unknown[]) => unknown[];

export const laundered = widened(handWritten, ["x"]);
