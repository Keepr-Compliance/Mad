/**
 * `ElectronErrorReporter` — the Electron shell's ErrorReporter
 * (BACKLOG-2962, seams PR A).
 *
 * WHY THIS SUITE CARRIES MORE WEIGHT THAN ITS SIZE SUGGESTS
 * ---------------------------------------------------------
 * As with `ElectronLogger`, `tests/helpers/installTestCapabilities.js` installs
 * a call-time forwarder rather than this class, so **no other suite in this
 * repository exercises `ElectronErrorReporter`.** It is the only thing standing
 * between a broken forwarder and a green build.
 *
 * The promise this seam makes is that Sentry receives THE SAME events with THE
 * SAME tags. That is a statement about argument identity, so the assertions
 * below are `toBe` on the options object rather than `toEqual` on a shape: a
 * forwarder that rebuilt `{ tags: {...} }` would satisfy a deep-equality check
 * and would still drop any key the interface's types do not name.
 *
 * The fixtures are transcribed, not invented — each tag set is copied from a
 * real call site, cited by line.
 */

// A LOCAL factory rather than the shared `tests/__mocks__/sentry-electron.js`,
// for one measured reason: the shared mock has no `flush`, and it cannot be
// given one from here. `import * as Sentry` emits `__importStar`, which COPIES
// the module's properties into a fresh object at import time — so the adapter's
// namespace object and this file's are two different objects, and assigning
// `flush` onto one after the fact never reaches the other. (Found by mutation:
// the first version of this suite did exactly that and read
// `TypeError: Sentry.flush is not a function` from inside the adapter.)
// Widening the shared mock instead would change what every other suite sees.
jest.mock("@sentry/electron/main", () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  addBreadcrumb: jest.fn(),
  setUser: jest.fn(),
  flush: jest.fn(() => Promise.resolve(true)),
}));

import * as Sentry from "@sentry/electron/main";

import { ElectronErrorReporter } from "../electronErrorReporter";

const mockSentry = Sentry as unknown as {
  captureException: jest.Mock;
  captureMessage: jest.Mock;
  addBreadcrumb: jest.Mock;
  setUser: jest.Mock;
  flush: jest.Mock;
};

describe("ElectronErrorReporter (BACKLOG-2962)", () => {
  beforeEach(() => {
    mockSentry.captureException.mockClear();
    mockSentry.captureMessage.mockClear();
    mockSentry.addBreadcrumb.mockClear();
    mockSentry.setUser.mockClear();
    mockSentry.flush.mockClear();
  });

  it("the local mock really is in force — otherwise every case below is vacuous", () => {
    expect(jest.isMockFunction(mockSentry.captureException)).toBe(true);
    expect(jest.isMockFunction(mockSentry.flush)).toBe(true);
  });

  it("captureException reaches Sentry.captureException with the error and options BY IDENTITY", () => {
    // Tags transcribed from databaseService.ts:1179.
    const reporter = new ElectronErrorReporter();
    const error = new Error("migration failed");
    const options = { tags: { service: "database-service", operation: "runMigrations" } };

    reporter.captureException(error, options);

    expect(mockSentry.captureException).toHaveBeenCalledTimes(1);
    expect(mockSentry.captureException.mock.calls[0][0]).toBe(error);
    expect(mockSentry.captureException.mock.calls[0][1]).toBe(options);
  });

  it("captureMessage reaches Sentry.captureMessage with level, tags and extra intact", () => {
    // Transcribed from initializationBroadcaster.ts:249.
    const reporter = new ElectronErrorReporter();
    const options = {
      level: "warning" as const,
      tags: { component: "startup", event: "db_ready_timeout" },
      extra: { timeout_ms: 30000, waiters_pending: 3 },
    };

    reporter.captureMessage("db_ready_timeout", options);

    expect(mockSentry.captureMessage).toHaveBeenCalledTimes(1);
    expect(mockSentry.captureMessage.mock.calls[0][0]).toBe("db_ready_timeout");
    expect(mockSentry.captureMessage.mock.calls[0][1]).toBe(options);
  });

  it("addBreadcrumb reaches Sentry.addBreadcrumb with the breadcrumb BY IDENTITY", () => {
    // Transcribed from validate.ts:41 / autoLinkService.ts:192.
    const reporter = new ElectronErrorReporter();
    const breadcrumb = {
      category: "auto_link.contact_resolution",
      message: "Resolved contact info: 2 emails, 1 phones",
      level: "info" as const,
      data: { contactId: "contact-1", emailCount: 2, phoneCount: 1 },
    };

    reporter.addBreadcrumb(breadcrumb);

    expect(mockSentry.addBreadcrumb.mock.calls[0][0]).toBe(breadcrumb);
  });

  it("setUser reaches Sentry.setUser, null included", () => {
    // Transcribed from databaseService.ts:1058.
    const reporter = new ElectronErrorReporter();
    const user = { id: "user-1", email: undefined };

    reporter.setUser(user);
    reporter.setUser(null);

    expect(mockSentry.setUser.mock.calls[0][0]).toBe(user);
    expect(mockSentry.setUser.mock.calls[1][0]).toBeNull();
  });

  it("flush passes the timeout through and returns the SDK's promise", async () => {
    // The three `flush` sites (databaseService.ts:405, 473, 1185) sit on
    // migration-failure paths no suite currently reaches, so this is the only
    // place the forwarding is checked at all.
    const reporter = new ElectronErrorReporter();
    await expect(reporter.flush(2000)).resolves.toBe(true);
    expect(mockSentry.flush).toHaveBeenCalledWith(2000);
  });

  it("adds no tag, no scope and no default of its own", () => {
    // If this class ever starts decorating, every Sentry event in the product
    // changes shape at once and nothing else would notice.
    const reporter = new ElectronErrorReporter();
    reporter.captureException(new Error("bare"));
    expect(mockSentry.captureException.mock.calls[0]).toHaveLength(2);
    expect(mockSentry.captureException.mock.calls[0][1]).toBeUndefined();
  });
});
