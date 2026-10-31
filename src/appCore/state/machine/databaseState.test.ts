/**
 * BACKLOG-3321 control C7u: databaseFromProbe translates the
 * `system:is-database-initialized` result `{ success, initialized }`
 * (systemHandlers.ts) without reading the object as a boolean.
 */
import { databaseFromProbe, isDatabaseInitialized, recordedDatabase } from "./databaseState";
import type { AppState } from "./types";

describe("BACKLOG-3321 C7u: databaseFromProbe", () => {
  it("open -> initialized", () => {
    expect(databaseFromProbe({ success: true, initialized: true })).toBe("initialized");
  });

  it("closed -> not-initialized (a truthy object, not an open)", () => {
    expect(databaseFromProbe({ success: true, initialized: false })).toBe("not-initialized");
  });

  it("unsuccessful, null or undefined -> unknown", () => {
    expect(databaseFromProbe({ success: false, initialized: true })).toBe("unknown");
    expect(databaseFromProbe(null)).toBe("unknown");
    expect(databaseFromProbe(undefined)).toBe("unknown");
  });
});

describe("isDatabaseInitialized", () => {
  it("only initialized is open", () => {
    expect(isDatabaseInitialized("initialized")).toBe(true);
    expect(isDatabaseInitialized("not-initialized")).toBe(false);
    expect(isDatabaseInitialized("unknown")).toBe(false);
  });
});

describe("recordedDatabase", () => {
  it("an error with no previous state is unknown", () => {
    const err: AppState = {
      status: "error",
      error: { code: "UNKNOWN_ERROR", message: "x" },
      recoverable: false,
    };
    expect(recordedDatabase(err)).toBe("unknown");
  });
});
