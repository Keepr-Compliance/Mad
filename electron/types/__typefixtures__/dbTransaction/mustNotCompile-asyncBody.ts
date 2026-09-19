/**
 * BACKLOG-2960 PR 0b — CONTROL C1. An `async` transaction body must not compile.
 *
 * `better-sqlite3` COMMITS when the synchronous callback returns. An `async` body
 * returns a Promise the moment it hits its first `await`, so the transaction
 * commits with the body still running — every write after the `await` lands
 * outside the transaction, and a throw after it rejects a promise nobody is
 * holding. Before this fixture's signature landed the line below compiled clean
 * (exit 0), which is the defect: the atomicity claim of every such body was
 * false and nothing in the toolchain said so.
 *
 * After the signature (79c3aa69 §2b / 5687984d C2) tsc must FAIL with TS2345:
 *   Argument of type '() => Promise<void>' is not assignable to parameter of
 *   type '() => never'.
 *
 * Imports the REAL `dbTransaction`; see mustCompile-syncBodies.ts for why.
 */
import { dbTransaction } from "../../../services/db/core/dbConnection";

declare function somePromiseReturningExport(): Promise<void>;

dbTransaction(async () => {
  await somePromiseReturningExport();
});
