/**
 * BACKLOG-3237 — ONE ROW PER ROOT CAUSE.
 *
 * ---------------------------------------------------------------------------
 * WHAT WAS WRONG
 * ---------------------------------------------------------------------------
 * A Mac without Full Disk Access got THREE banner rows for ONE missing
 * permission: the Messages denial, the Contacts denial, and "Cannot Load
 * Contacts" — that last one a downstream symptom of the first two, worded
 * worse, with a button that drops the user in the raw macOS Privacy pane.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS SUITE DRIVES
 * ---------------------------------------------------------------------------
 * The REAL `system:health-check` handler, pulled out of `ipcMain.handle` after
 * `registerDiagnosticHandlers()`. Collapsing correctly in a helper that the
 * handler does not call would pass a unit test and ship the bug.
 *
 * THE SECOND TEST IS THE ONE THAT MATTERS. Deleting the contacts-loading
 * producer would satisfy "denied shows one row" and destroy the only signal a
 * user gets when her address book is unreadable and no permission is missing.
 * Suppression is conditional, and the condition is asserted here.
 *
 * Inputs are transcribed producer output — `tests/fixtures/fdaDeniedIssue-3219.ts`
 * for the permission results, `tests/fixtures/contactsLoadingFailed-3237.ts`
 * for the contacts row (pinned against the real `checkContactsLoading()` in
 * `permissionService.contactsLoadingRow-3237.test.ts`).
 */

import { ipcMain } from "electron";
import {
  FDA_DENIED_PERMISSION_RESULT,
  CONTACTS_DENIED_PERMISSION_RESULT,
  CONTACTS_STORE_NOT_FOUND_PERMISSION_RESULT,
  FDA_EXPLAINER_ACTION_LABEL,
  FDA_EXPLAINER_ACTION_HANDLER,
} from "../../../tests/fixtures/fdaDeniedIssue-3219";
import {
  FDA_COLLAPSED_TITLE_TEXT,
  FDA_COLLAPSED_MESSAGE_TEXT,
} from "../../../tests/fixtures/fdaDeniedIssue-3219";
import {
  CONTACTS_LOADING_FAILED_ISSUE,
  CONTACTS_CHECK_FAILED_ISSUE,
  OAUTH_RECONNECT_CONNECTION_ERROR,
} from "../../../tests/fixtures/contactsLoadingFailed-3237";

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

// Imported after the mocks so the handler module picks them up.
import {
  registerDiagnosticHandlers,
  FDA_COLLAPSED_TITLE,
  FDA_COLLAPSED_MESSAGE,
} from "../diagnosticHandlers";

type Issue = Record<string, unknown>;
type HealthCheckResult = {
  success: boolean;
  healthy?: boolean;
  issues?: Issue[];
  summary?: { totalIssues: number; criticalIssues: number; warnings: number };
};

// It only has to satisfy validateUserId's UUID regex so the connections
// branch runs at all.
// pii-allow-uuid: invented placeholder, not from any live row
const USER_ID = "11111111-2222-4333-8444-555555555555";

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

/** A denied errno message, shaped like the real one but path-free. */
const ERRNO_MESSAGE = "EPERM: operation not permitted, access '<redacted>'";

const permissionErrors = (errors: Issue[]) => ({
  allGranted: errors.length === 0,
  permissions: {},
  errors,
});

const BOTH_DENIALS: Issue[] = [
  { ...FDA_DENIED_PERMISSION_RESULT, error: ERRNO_MESSAGE },
  { ...CONTACTS_DENIED_PERMISSION_RESULT, error: ERRNO_MESSAGE },
];

const CONTACTS_UNREADABLE = {
  canLoadContacts: false,
  contactCount: 0,
  coverage: "none",
  booksFound: 3,
  booksRead: 0,
  booksFailed: 3,
  error: CONTACTS_LOADING_FAILED_ISSUE,
};

describe("BACKLOG-3237 — the health banner shows one row per cause", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (ipcMain.handle as unknown as jest.Mock).mockClear();
    mockCheckAllPermissions.mockResolvedValue(permissionErrors([]));
    mockCheckContactsLoading.mockResolvedValue({ canLoadContacts: true, contactCount: 12 });
    mockCheckAllConnections.mockResolvedValue({ google: undefined, microsoft: undefined });
  });

  describe("CONTROL 1 — denied", () => {
    it("collapses both denials and the downstream contacts row into ONE actionable row", async () => {
      mockCheckAllPermissions.mockResolvedValue(permissionErrors(BOTH_DENIALS));
      mockCheckContactsLoading.mockResolvedValue(CONTACTS_UNREADABLE);

      const result = await getHealthCheckHandler()({}, null, null);

      // Three rows became one. This is the founder-visible fact.
      expect(result.issues).toHaveLength(1);
      const [row] = result.issues as Issue[];
      expect(row.action).toBe(FDA_EXPLAINER_ACTION_LABEL);
      expect(row.actionHandler).toBe(FDA_EXPLAINER_ACTION_HANDLER);
      expect(row.errorCode).toBe("FULL_DISK_ACCESS_DENIED");
      expect(result.summary?.totalIssues).toBe(1);
    });

    it("names the consequences as secondary text on that row, not as rows of their own", async () => {
      mockCheckAllPermissions.mockResolvedValue(permissionErrors(BOTH_DENIALS));
      mockCheckContactsLoading.mockResolvedValue(CONTACTS_UNREADABLE);

      const [row] = (await getHealthCheckHandler()({}, null, null)).issues as Issue[];

      // `SystemHealthMonitor` renders `title || userMessage` as the heading and
      // `message` beneath it — so both consequences are visible without either
      // owning a row.
      expect(row.title).toBe(FDA_COLLAPSED_TITLE);
      expect(row.message).toBe(FDA_COLLAPSED_MESSAGE);
      expect(String(row.message)).toMatch(/Messages/);
      expect(String(row.message)).toMatch(/contact names/);
      // The producer's own field is untouched — `usePermissionsFlow` and
      // `systemHandlers` read the same object from the same producer.
      expect(row.userMessage).toBe(FDA_DENIED_PERMISSION_RESULT.userMessage);
    });

    it("suppresses CONTACTS_CHECK_FAILED under a denial too", async () => {
      mockCheckAllPermissions.mockResolvedValue(permissionErrors(BOTH_DENIALS));
      mockCheckContactsLoading.mockResolvedValue({
        canLoadContacts: false,
        contactCount: 0,
        error: CONTACTS_CHECK_FAILED_ISSUE,
      });

      const result = await getHealthCheckHandler()({}, null, null);

      expect(result.issues).toHaveLength(1);
      expect((result.issues as Issue[])[0].type).toBeUndefined();
    });

    it("collapses a lone CONTACTS_ACCESS_DENIED as well — one denial is still one row", async () => {
      mockCheckAllPermissions.mockResolvedValue(
        permissionErrors([{ ...CONTACTS_DENIED_PERMISSION_RESULT, error: ERRNO_MESSAGE }]),
      );

      const [row] = (await getHealthCheckHandler()({}, null, null)).issues as Issue[];

      expect(row.errorCode).toBe("CONTACTS_ACCESS_DENIED");
      expect(row.title).toBe(FDA_COLLAPSED_TITLE);
      expect(row.actionHandler).toBe(FDA_EXPLAINER_ACTION_HANDLER);
    });
  });

  describe("CONTROL 2 — no denial, contacts genuinely unloadable (THE DISCRIMINATING CASE)", () => {
    it("still shows 'Cannot Load Contacts', byte-identical to the producer's row", async () => {
      // Every permission granted. A corrupt or unreadable address book is now
      // the ONLY thing that can tell her, so suppressing it here would delete
      // the signal rather than tidy it.
      mockCheckAllPermissions.mockResolvedValue(permissionErrors([]));
      mockCheckContactsLoading.mockResolvedValue(CONTACTS_UNREADABLE);

      const result = await getHealthCheckHandler()({}, null, null);

      expect(result.issues).toHaveLength(1);
      expect((result.issues as Issue[])[0]).toEqual(CONTACTS_LOADING_FAILED_ISSUE);
      expect(result.healthy).toBe(false);
    });

    it("folds CONTACTS_LOADING_FAILED into the absent row — one cause, one row", async () => {
      // BACKLOG-3233 RE-POINTED THIS. It used to assert TWO rows here, which
      // pinned the stacking bug: an absent address book produced both
      // `CONTACTS_STORE_NOT_FOUND` and the downstream "Cannot Load Contacts",
      // each naming Full Disk Access in different words for one fact.
      //
      // WHAT THIS PROVES, EXACTLY: that suppression FIRES. Nothing more.
      // Break the absent leg of `explainedAlready` and this reds.
      //
      // WHAT IT DOES NOT PROVE — and the comment that used to sit here claimed
      // otherwise, which is why it is gone. It said this test showed
      // suppression was keyed on the error CODES rather than on `allGranted`.
      // Measured: it does not. `allGranted` is false in this fixture too, so a
      // wrong fix keying on `allGranted` produces one row here and passes.
      // That discrimination lives entirely in
      // `diagnosticHandlers.contactsStoreAbsent-3214.test.ts` -> C8, and in
      // `diagnosticHandlers.messagesAbsentPassthrough-3213.test.ts`.
      mockCheckAllPermissions.mockResolvedValue(
        permissionErrors([
          { ...CONTACTS_STORE_NOT_FOUND_PERMISSION_RESULT, error: "ENOENT: no such file or directory" },
        ]),
      );
      mockCheckContactsLoading.mockResolvedValue(CONTACTS_UNREADABLE);

      const result = await getHealthCheckHandler()({}, null, null);

      const types = (result.issues as Issue[]).map((i) => i.type ?? i.errorCode);
      expect(types).toEqual(["CONTACTS_STORE_NOT_FOUND"]);
      expect(result.issues).toHaveLength(1);
    });
  });

  describe("CONTROL 3 — CONTACTS_STORE_NOT_FOUND is untouched", () => {
    it("is never decorated and never folded into a Full Disk Access row", async () => {
      mockCheckAllPermissions.mockResolvedValue(
        permissionErrors([
          { ...CONTACTS_STORE_NOT_FOUND_PERMISSION_RESULT, error: "ENOENT: no such file or directory" },
        ]),
      );

      const [row] = (await getHealthCheckHandler()({}, null, null)).issues as Issue[];

      // BACKLOG-2392: telling a user to grant a permission she may already
      // hold is the bug BACKLOG-3210 part 1 was careful not to re-create.
      //
      // BACKLOG-3233 re-pointed the last assertion. It used to read
      // `expect(row.action).toBe(CONTACTS_STORE_NOT_FOUND_PERMISSION_RESULT.action)`
      // — both sides sourced from the fixture, through a mocked producer, so it
      // compared the fixture to itself and stayed green when the real producer
      // dropped the field. The absence is now asserted directly, and the
      // fixture is tied to the producer in
      // `permissionService.contactsStoreShape-3214.test.ts`.
      expect(row).not.toHaveProperty("actionHandler");
      expect(row).not.toHaveProperty("title");
      expect(row).not.toHaveProperty("action");
    });

    it("survives the collapse as its own row when a denial is also present", async () => {
      mockCheckAllPermissions.mockResolvedValue(
        permissionErrors([
          { ...FDA_DENIED_PERMISSION_RESULT, error: ERRNO_MESSAGE },
          { ...CONTACTS_STORE_NOT_FOUND_PERMISSION_RESULT, error: "ENOENT: no such file or directory" },
        ]),
      );

      const rows = (await getHealthCheckHandler()({}, null, null)).issues as Issue[];

      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.errorCode)).toEqual(
        expect.arrayContaining(["FULL_DISK_ACCESS_DENIED", "CONTACTS_STORE_NOT_FOUND"]),
      );
    });
  });

  describe("CONTROL 4 — genuinely distinct causes are both shown, ordered", () => {
    it("keeps a Full Disk Access denial and a broken mailbox as two rows", async () => {
      mockCheckAllPermissions.mockResolvedValue(permissionErrors(BOTH_DENIALS));
      mockCheckAllConnections.mockResolvedValue({
        google: undefined,
        microsoft: { error: OAUTH_RECONNECT_CONNECTION_ERROR, lastSyncAt: null },
      });

      const rows = (await getHealthCheckHandler()({}, USER_ID, "microsoft")) .issues as Issue[];

      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.actionHandler)).toEqual([
        FDA_EXPLAINER_ACTION_HANDLER,
        "reconnect-microsoft",
      ]);
    });

    it("puts a row with a working button ahead of one without, against insertion order", async () => {
      // THE CONTROL THAT ACTUALLY EXERCISES THE SORT. A denial and an OAuth
      // reconnect are both tier 0, so insertion order already matches and the
      // assertion above would pass with the sort deleted.
      //
      // CONTACTS_STORE_NOT_FOUND has action TEXT and NO handler — its button
      // hits `SystemHealthMonitor`'s `default:` branch and does nothing — and
      // it is pushed FIRST, from the permissions block. The reconnect row is
      // pushed LAST, from the connections loop. Insertion order is therefore
      // the wrong order, and only the sort can fix it.
      mockCheckAllPermissions.mockResolvedValue(
        permissionErrors([
          { ...CONTACTS_STORE_NOT_FOUND_PERMISSION_RESULT, error: "ENOENT: no such file or directory" },
        ]),
      );
      mockCheckAllConnections.mockResolvedValue({
        google: undefined,
        microsoft: { error: OAUTH_RECONNECT_CONNECTION_ERROR, lastSyncAt: null },
      });

      const rows = (await getHealthCheckHandler()({}, USER_ID, "microsoft")).issues as Issue[];

      expect(rows).toHaveLength(2);
      expect(rows[0].actionHandler).toBe("reconnect-microsoft");
      expect(rows[1].errorCode).toBe("CONTACTS_STORE_NOT_FOUND");
    });

    it("does not repaint a row while sorting it", async () => {
      // The tier is sort-local. A permission result carries NO `severity`, and
      // the renderer turns that absence into amber deliberately; writing an
      // "error" severity back to satisfy the sort would turn the banner red.
      mockCheckAllPermissions.mockResolvedValue(permissionErrors(BOTH_DENIALS));

      const [row] = (await getHealthCheckHandler()({}, null, null)).issues as Issue[];

      expect(row).not.toHaveProperty("severity");
    });
  });

  describe("the renderer fixture is tied to these constants", () => {
    it("pins FDA_DENIED_BANNER_ISSUE's heading and subtitle to what the handler emits", () => {
      // `SystemHealthMonitor.test.tsx` renders from that fixture. If these two
      // strings drifted apart, the renderer suite would go on asserting a
      // heading the main process no longer sends — the failure
      // tests/fixtures/fdaDeniedIssue-3219.ts's own header warns about.
      expect(FDA_COLLAPSED_TITLE).toBe(FDA_COLLAPSED_TITLE_TEXT);
      expect(FDA_COLLAPSED_MESSAGE).toBe(FDA_COLLAPSED_MESSAGE_TEXT);
    });
  });

  describe("STATE — everything granted", () => {
    it("produces no rows at all", async () => {
      const result = await getHealthCheckHandler()({}, null, null);

      expect(result.issues).toEqual([]);
      expect(result.healthy).toBe(true);
    });
  });
});
