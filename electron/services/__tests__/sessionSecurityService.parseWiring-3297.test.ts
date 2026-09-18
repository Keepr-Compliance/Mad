/**
 * @jest-environment node
 *
 * BACKLOG-3297 — the age check must read `created_at` through `parseDbTimestamp`.
 *
 * On a UTC runner (CI) a bare `new Date("2026-09-13 18:15:21")` and the UTC
 * parser return the same instant, so no value-based test in that zone can tell
 * whether the service uses the parser. This file replaces the parser with one
 * that reports every session as 25 hours old: if the service reads `created_at`
 * any other way, the fresh timestamp below passes the age check and this fails.
 */

jest.mock("../logService", () => ({
  __esModule: true,
  default: {
    info: jest.fn().mockResolvedValue(undefined),
    warn: jest.fn().mockResolvedValue(undefined),
    error: jest.fn().mockResolvedValue(undefined),
    debug: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock("../../utils/dbTimestamp", () => ({
  parseDbTimestamp: () => new Date(Date.now() - 25 * 60 * 60 * 1000),
}));

import { sessionSecurityService } from "../sessionSecurityService";

describe("sessionSecurityService reads created_at through parseDbTimestamp (BACKLOG-3297)", () => {
  it("C5 a session the parser reports as 25h old is expired, whatever the raw string says", async () => {
    const freshSqliteUtc = new Date().toISOString().replace("T", " ").slice(0, 19);

    await expect(
      sessionSecurityService.checkSessionValidity(
        { created_at: freshSqliteUtc, last_accessed_at: freshSqliteUtc },
        "token-3297-wiring",
      ),
    ).resolves.toEqual({ valid: false, reason: "expired" });
  });
});
