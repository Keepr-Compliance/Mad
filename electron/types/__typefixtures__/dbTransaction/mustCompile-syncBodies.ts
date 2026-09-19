/**
 * BACKLOG-2960 PR 0b — the fixture that MUST compile.
 *
 * `dbTransaction`'s body parameter is typed `() => T extends PromiseLike<unknown>
 * ? never : T` (SR ruling 79c3aa69 §2b, diagnostics re-run in 5687984d C2). The
 * whole point of the conditional is that it costs the 37 real transaction bodies
 * NOTHING: a body returning `void`, a row-or-undefined, or a number must still
 * compile, and `T` must be inferred EXACTLY — not collapsed to `unknown`, which
 * would make the results below unassignable, and not to `any`/`never`, which the
 * sibling `mustNotCompile-inferenceIsPrecise.ts` rules out.
 *
 * It imports the REAL `dbTransaction`, not a local re-declaration: a control that
 * re-declares the signature it is testing proves only that the control agrees
 * with itself.
 */
import { dbTransaction } from "../../../services/db/core/dbConnection";

declare const rowId: string;
declare function readRowSync(): { id: string } | undefined;
declare function countRowsSync(): number;

// A body returning nothing — the most common shape in the tree.
const nothing: void = dbTransaction(() => {
  countRowsSync();
});

// A body returning a row or undefined — `T` must come back as exactly that union.
const row: { id: string } | undefined = dbTransaction(() => {
  const found = readRowSync();
  return found ? { id: found.id } : undefined;
});

// A body returning a number, as an expression body.
const n: number = dbTransaction(() => countRowsSync());

// A body handed a generic argument explicitly, which some call sites do.
const m: number = dbTransaction<number>(() => countRowsSync() + rowId.length);

void nothing;
void row;
void n;
void m;
