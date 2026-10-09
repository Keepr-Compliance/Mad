/**
 * BACKLOG-3819 G1 — the pre-migration Sentry user context carries a REDACTED
 * email, matching main.ts's Sentry.setUser (BACKLOG-2076). The raw address is
 * never handed to the error reporter (which can persist it to
 * userData/sentry/scope_v3.json and send it).
 */

const mockSetUser = jest.fn();

jest.mock("electron", () => ({ app: { getPath: jest.fn(() => "/mock/user/data") } }));
jest.mock("../../capabilities/errorReporterProvider", () => ({
  hostErrorReporter: {
    setUser: (...a: unknown[]) => mockSetUser(...a),
    addBreadcrumb: jest.fn(),
    captureException: jest.fn(),
    flush: jest.fn().mockResolvedValue(true),
  },
}));
jest.mock("../logService", () => {
  const m = {
    info: jest.fn().mockResolvedValue(undefined),
    debug: jest.fn().mockResolvedValue(undefined),
    warn: jest.fn().mockResolvedValue(undefined),
    error: jest.fn().mockResolvedValue(undefined),
  };
  return { __esModule: true, default: m, logService: m };
});

describe("BACKLOG-3819 G1: pre-migration Sentry user email is redacted", () => {
  it("passes j***@example.com, never the raw address", async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const service = require("../databaseService").default;
    const fakeDb = {
      prepare: (sqlText: string) => ({
        all: () => (/sqlite_master/.test(sqlText) ? [{ name: "users_local" }] : []),
        get: () => ({ id: "user-3819", email: "jane.customer@example.com" }),
        run: () => {
          throw new Error("stop after user context");
        },
      }),
      exec: () => {
        throw new Error("stop after user context");
      },
      pragma: () => [],
      transaction: () => () => {
        throw new Error("stop after user context");
      },
    };
    service.db = fakeDb;
    // Everything after the user-context block is out of scope; it fails on the fake db.
    await service.runMigrations().catch(() => undefined);

    expect(mockSetUser).toHaveBeenCalledTimes(1);
    expect(mockSetUser).toHaveBeenCalledWith({ id: "user-3819", email: "j***@example.com" });
    expect(JSON.stringify(mockSetUser.mock.calls)).not.toContain("jane.customer@example.com");
  });
});
