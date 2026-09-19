/**
 * BACKLOG-2960 PR 0b — CONTROL C2. A non-async body that RETURNS a promise must
 * not compile.
 *
 * The other spelling of the same hole: no `async` keyword, but the body hands a
 * promise-returning data call straight back. The transaction commits on return;
 * the promise settles later; a rejection arrives as an unhandled rejection after
 * the commit. Before the signature this compiled clean (exit 0).
 *
 * After the signature tsc must FAIL with TS2345:
 *   Argument of type '() => Promise<{ id: string; } | undefined>' is not
 *   assignable to parameter of type '() => never'.
 *
 * MEASURED, NOT CITED: SR ruling 5687984d C2 recorded this case as TS2322 on the
 * return statement. Against the ruled signature at `int/epic9-close` 139913c51 a
 * block-bodied arrow is rejected as a whole ARGUMENT (TS2345), the same code as
 * the async case; only the type name in the message differs. Either code proves
 * the same thing — the body's promise is not assignable to `never` — and the
 * assertion in dbTransaction.typeControls.test.ts checks the message text, not
 * just the code.
 *
 * Imports the REAL `dbTransaction`; see mustCompile-syncBodies.ts for why.
 */
import { dbTransaction } from "../../../services/db/core/dbConnection";

declare function readRow(): Promise<{ id: string } | undefined>;

dbTransaction(() => {
  return readRow();
});
