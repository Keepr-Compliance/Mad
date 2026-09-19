/**
 * BACKLOG-2960 PR 0b — CONTROL C2b, the control on the control.
 *
 * A body-type constraint that "accepts everything" by inferring `T` as `any` or
 * `never` would pass every case in mustCompile-syncBodies.ts too — and would
 * also let the line below compile, because `any` and `never` are assignable to
 * `string`. This fixture is what separates a precise signature from a decorative
 * one: `T` must be inferred as exactly `number`, so assigning the result to a
 * `string` must FAIL with TS2322:
 *   Type 'number' is not assignable to type 'string'.
 *
 * Note this fixture is NOT a before/after discriminator for the signature change
 * (the old `(fn: () => T): T` inferred `number` too). It guards the NEW signature
 * against a later "simplification" that widens `T`. Imports the REAL
 * `dbTransaction`; see mustCompile-syncBodies.ts for why.
 */
import { dbTransaction } from "../../../services/db/core/dbConnection";

const s: string = dbTransaction(() => 1);

void s;
