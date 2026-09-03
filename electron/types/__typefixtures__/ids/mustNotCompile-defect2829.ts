/**
 * CONTROL 1 + CONTROL 2 — fixture A. BACKLOG-3067.
 *
 * This is the BACKLOG-2829 defect, transcribed from the real call site
 * (`electron/services/extraction/hybridExtractorService.ts:399`), reduced to the
 * one fact that matters: an EMAIL id is passed into a COMMUNICATION id parameter.
 *
 *   BEFORE the brands exist -> this file COMPILES CLEAN (exit 0).
 *     That is the defect. Both parameters are `string`, the SQL is single-table
 *     and every column is in scope, so nothing in the toolchain objects. The
 *     statement matches zero rows at runtime and reports success.
 *
 *   AFTER the brands exist -> tsc must FAIL with TS2345.
 *
 * The `before` run is recorded in the PR body. If this file ever compiles again,
 * the brand has been removed from `linkCommunicationToTransaction` and the whole
 * item has silently reverted — which is exactly what the mutation control (5)
 * checks on purpose.
 *
 * It imports the REAL production function, not a local re-declaration: a control
 * that re-declares the signature it is testing proves only that the control agrees
 * with itself.
 */
import { linkCommunicationToTransaction } from "../../../services/db/communicationDbService";

// `declare const` conjures values with zero runtime and zero fixture setup, so the
// only thing under test is the assignability of the argument to the parameter.
declare const emailId: string;
declare const transactionId: string;

void linkCommunicationToTransaction(emailId, transactionId);
