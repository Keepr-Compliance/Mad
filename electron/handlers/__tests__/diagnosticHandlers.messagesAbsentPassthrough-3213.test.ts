/**
 * BACKLOG-3213 — the absent-database row survives the health-check pipeline.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS SUITE EXISTS
 * ---------------------------------------------------------------------------
 * The design routes `MESSAGES_STORE_NOT_FOUND` AROUND `FDA_DENIAL_ERROR_CODES`
 * so that `diagnosticHandlers.ts` needs no edit at all. That conclusion was
 * reached by READING the code, and reading is not measuring: a fix that
 * produces a perfect producer object and a row that is then collapsed,
 * decorated, dropped or sorted out downstream would pass every other control
 * in this item.
 *
 * A NEW FILE on purpose. `diagnosticHandlers.ts` and `SystemHealthMonitor.tsx`
 * belong to BACKLOG-3229/3230 (PR #2613) and are not touched here; a new file
 * has no textual conflict with that branch. Flagged for its reviewer: a second
 * suite now depends on the collapse rules.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS DRIVEN
 * ---------------------------------------------------------------------------
 * Both levels. The three exported pure functions, AND the real
 * `system:health-check` handler pulled out of `ipcMain.handle` — the same
 * end-to-end harness `diagnosticHandlers.oneRowPerCause-3237.test.ts` uses.
 * Collapsing correctly in a helper the handler does not call would pass a unit
 * test and ship the bug.
 */

import { ipcMain } from "electron";
import {
  FDA_DENIED_PERMISSION_RESULT,
  MESSAGES_STORE_NOT_FOUND_PERMISSION_RESULT,
  FDA_EXPLAINER_ACTION_HANDLER,
} from "../../../tests/fixtures/fdaDeniedIssue-3219";
import { CONTACTS_LOADING_FAILED_ISSUE } from "../../../tests/fixtures/contactsLoadingFailed-3237";

const mockCheckAllPermissions = jest.fn();
const mockCheckContactsLoading = jest.fn();
const mockCheckAllConnections = jest.fn();

jest.mock("os", () => {
  const actual = jest.requireActual("os");
  return { ...actual, platform: () => "darwin" };
});

jest.mock("../../services/permissionService", () => ({
  __esModule: true,
  default: {
    checkAllPermissions: (...args: unknown[]) => mockCheckAllPermissions(...args),
    checkContactsLoading: (...args: unknown[]) => mockCheckContactsLoading(...args),
  },
}));

jest.mock("../../services/connectionStatusService", () => ({
  __esModule: true,
  default: {
    checkAllConnections: (...args: unknown[]) => mockCheckAllConnections(...args),
  },
}));

jest.mock("../../services/databaseService", () => ({
  __esModule: true,
  default: { getDatabase: jest.fn(), isInitialized: jest.fn(() => false) },
}));

jest.mock("../../services/logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
  registerDiagnosticHandlers,
  decorateFdaPermissionIssues,
  collapseFdaPermissionIssues,
  orderHealthIssues,
} from "../diagnosticHandlers";

type Issue = Record<string, unknown>;
type HealthCheckResult = {
  success: boolean;
  healthy?: boolean;
  issues?: Issue[];
  summary?: { totalIssues: number; criticalIssues: number; warnings: number };
};

const ERRNO_MESSAGE = "EPERM: operation not permitted, access '<redacted>'";
const ABSENT_ERRNO_MESSAGE = "ENOENT: no such file or directory, access '<redacted>'";

const MESSAGES_ABSENT_ISSUE: Issue = {
  ...MESSAGES_STORE_NOT_FOUND_PERMISSION_RESULT,
  error: ABSENT_ERRNO_MESSAGE,
};
const FDA_DENIED_ISSUE: Issue = {
  ...FDA_DENIED_PERMISSION_RESULT,
  error: ERRNO_MESSAGE,
};

const permissionErrors = (errors: Issue[]) => ({
  allGranted: errors.length === 0,
  permissions: {},
  errors,
});

const CONTACTS_UNREADABLE = {
  canLoadContacts: false,
  contactCount: 0,
  coverage: "none",
  booksFound: 3,
  booksRead: 0,
  booksFailed: 3,
  error: CONTACTS_LOADING_FAILED_ISSUE,
};

function getHealthCheckHandler(): (
  event: unknown,
  userId: string | null,
  provider: string | null,
) => Promise<HealthCheckResult> {
  registerDiagnosticHandlers();
  const call = (ipcMain.handle as unknown as jest.Mock).mock.calls.find(
    (c: unknown[]) => c[0] === "system:health-check",
  );
  if (!call) throw new Error("system:health-check was never registered");
  return call[1];
}

describe("BACKLOG-3213 — MESSAGES_STORE_NOT_FOUND reaches the banner intact", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (ipcMain.handle as unknown as jest.Mock).mockClear();
    mockCheckAllPermissions.mockResolvedValue(permissionErrors([]));
    mockCheckContactsLoading.mockResolvedValue({ canLoadContacts: true, contactCount: 12 });
    mockCheckAllConnections.mockResolvedValue({ google: undefined, microsoft: undefined });
  });

  /** C23a — no FDA explainer button is bolted onto the absent row. */
  it("is never decorated with the Full Disk Access explainer", () => {
    const [row] = decorateFdaPermissionIssues([MESSAGES_ABSENT_ISSUE]) as Issue[];

    expect(row).toEqual(MESSAGES_ABSENT_ISSUE);
    expect(row).not.toHaveProperty("actionHandler");
    expect(row).not.toHaveProperty("action");
  });

  /** C23b — it escapes the collapse, and is not dropped by it. */
  it("survives the collapse as its own row, byte-identical, when a denial is also present", () => {
    const rows = collapseFdaPermissionIssues([
      FDA_DENIED_ISSUE,
      MESSAGES_ABSENT_ISSUE,
    ]) as Issue[];

    expect(rows).toHaveLength(2);
    const absent = rows.find((r) => r.errorCode === "MESSAGES_STORE_NOT_FOUND");
    expect(absent).toEqual(MESSAGES_ABSENT_ISSUE);
    // And the denial is still collapsed and decorated, as before.
    const denial = rows.find((r) => r.errorCode === "FULL_DISK_ACCESS_DENIED");
    expect(denial?.actionHandler).toBe(FDA_EXPLAINER_ACTION_HANDLER);
  });

  /** C23c — it is not mis-sorted out of existence. */
  it("is kept by the ordering pass", () => {
    const ordered = orderHealthIssues([MESSAGES_ABSENT_ISSUE]) as Issue[];
    expect(ordered).toEqual([MESSAGES_ABSENT_ISSUE]);
  });

  /**
   * C23d — END TO END. The pure functions above are three of five stages; this
   * drives the registered handler, which is what the renderer actually calls.
   */
  it("reaches the health-check result as a row with no button and no rewritten heading", async () => {
    mockCheckAllPermissions.mockResolvedValue(
      permissionErrors([MESSAGES_ABSENT_ISSUE]),
    );

    const result = await getHealthCheckHandler()({}, null, null);

    expect(result.issues).toHaveLength(1);
    const [row] = result.issues as Issue[];
    expect(row.errorCode).toBe("MESSAGES_STORE_NOT_FOUND");
    expect(row.userMessage).toBe(
      MESSAGES_STORE_NOT_FOUND_PERMISSION_RESULT.userMessage,
    );
    // No button: `SystemHealthMonitor` renders `{issue.action && (<button …>)}`.
    expect(row).not.toHaveProperty("action");
    expect(row).not.toHaveProperty("actionHandler");
    // No collapsed heading: the renderer shows `title || userMessage`, so the
    // absence of `title` is what puts the honest sentence in the heading.
    expect(row).not.toHaveProperty("title");
    // And it names no permission.
    expect(String(row.userMessage)).not.toMatch(/full disk access/i);
  });

  /**
   * C23e — the `hasFdaDenial` CONSEQUENCE, asserted deliberately rather than
   * discovered afterwards.
   *
   * `hasFdaDenial` returns true only for `FULL_DISK_ACCESS_DENIED` /
   * `CONTACTS_ACCESS_DENIED`, and it gates the suppression of a downstream
   * contacts row. TODAY a Mac with no `chat.db` raises a spurious
   * `FULL_DISK_ACCESS_DENIED`, so a genuine contacts-loading failure on that
   * Mac is SILENTLY SUPPRESSED. After this item that error is
   * `MESSAGES_STORE_NOT_FOUND`, so the contacts row is shown.
   *
   * That is not this item's judgement call. BACKLOG-3237 already ruled it, at
   * `diagnosticHandlers.oneRowPerCause-3237.test.ts:224` — "shows it alongside
   * CONTACTS_STORE_NOT_FOUND — an absent address book is not a denial" — and
   * wrote it for the CONTACTS probe only because the messages probe had no
   * absent state to distinguish. This item gives it one, and the same rule
   * follows.
   *
   * Both rows are asserted by IDENTITY, never by a count alone.
   */
  it("stops silencing a genuine contacts failure, because an absent database is not a denial", async () => {
    mockCheckAllPermissions.mockResolvedValue(
      permissionErrors([MESSAGES_ABSENT_ISSUE]),
    );
    mockCheckContactsLoading.mockResolvedValue(CONTACTS_UNREADABLE);

    const result = await getHealthCheckHandler()({}, null, null);

    const identities = (result.issues as Issue[]).map((i) => i.type ?? i.errorCode);
    expect(identities).toEqual(
      expect.arrayContaining(["MESSAGES_STORE_NOT_FOUND", "CONTACTS_LOADING_FAILED"]),
    );
    expect(result.issues).toHaveLength(2);
  });

  /**
   * The discriminating other half: a REAL denial still suppresses the
   * downstream contacts row. Without this, C23e would be satisfied by deleting
   * the suppression outright.
   */
  it("still suppresses the downstream contacts row under a real denial", async () => {
    mockCheckAllPermissions.mockResolvedValue(permissionErrors([FDA_DENIED_ISSUE]));
    mockCheckContactsLoading.mockResolvedValue(CONTACTS_UNREADABLE);

    const result = await getHealthCheckHandler()({}, null, null);

    expect(result.issues).toHaveLength(1);
    expect((result.issues as Issue[])[0].errorCode).toBe("FULL_DISK_ACCESS_DENIED");
  });
});
