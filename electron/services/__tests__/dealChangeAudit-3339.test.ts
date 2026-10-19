/**
 * BACKLOG-3339 slice 1 — driver errors are read by shape, not `instanceof Error`.
 *
 * better-sqlite3 sets its SqliteError class once per process
 * (`lib/database.js`, `addon.setErrorConstructor`), so an error it throws can
 * extend a different realm's `Error`. jest gives each test file its own realm,
 * which is how the K3 tests in dealAuditInTransaction-3339 went red on CI when
 * another real-driver suite ran first in the same worker. Here the foreign
 * error is built in a `vm` context so the case is deterministic and does not
 * depend on test order.
 */
import vm from "vm";

jest.mock("../auditService", () => ({
  AuditNotRecordedError: class AuditNotRecordedError extends Error {},
}));

import { AuditNotRecordedError } from "../auditService";
import {
  DEAL_AUDIT_NOT_SAVED_MESSAGE,
  dealChangeFailureCode,
  dealChangeUserError,
} from "../dealChangeAudit";

function foreignSqliteError(message: string): unknown {
  return vm.runInNewContext(
    `(() => { class SqliteError extends Error { constructor(m) { super(m); this.name = "SqliteError"; } } return new SqliteError(${JSON.stringify(message)}); })()`,
  );
}

describe("dealChangeAudit with an error from another realm", () => {
  it("precondition: the foreign error is not instanceof this realm's Error", () => {
    expect(foreignSqliteError("x") instanceof Error).toBe(false);
  });

  it("the failure code keeps the driver error's class name", () => {
    expect(dealChangeFailureCode(foreignSqliteError("forced change failure"))).toBe(
      "change_failed:SqliteError",
    );
  });

  it("the user error is a local Error carrying the original name and message", () => {
    const original = foreignSqliteError("forced change failure");
    const out = dealChangeUserError("update", original);
    expect(out).toBeInstanceOf(Error);
    expect((out as Error).message).toBe("forced change failure");
    expect((out as Error).name).toBe("SqliteError");
    expect((out as Error & { cause?: unknown }).cause).toBe(original);
  });

  it("a same-realm error passes through unchanged", () => {
    const err = new Error("same realm");
    expect(dealChangeUserError("delete", err)).toBe(err);
  });

  it("an unrecorded audit entry still becomes the fixed message", () => {
    const out = dealChangeUserError("delete", new AuditNotRecordedError("driver text"));
    expect((out as Error).message).toBe(DEAL_AUDIT_NOT_SAVED_MESSAGE.delete);
    expect(dealChangeFailureCode(new AuditNotRecordedError("driver text"))).toBe(
      "audit_entry_not_written",
    );
  });

  it("a value with no message passes through unchanged", () => {
    expect(dealChangeUserError("create", "plain string")).toBe("plain string");
    expect(dealChangeFailureCode("plain string")).toBe("change_failed:Error");
  });
});
