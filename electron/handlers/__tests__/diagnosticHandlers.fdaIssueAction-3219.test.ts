/**
 * BACKLOG-3219 / BACKLOG-3210 (part 2) — the health check must hand the
 * renderer a Full Disk Access row it can act on.
 *
 * ---------------------------------------------------------------------------
 * WHAT WAS WRONG
 * ---------------------------------------------------------------------------
 * `system:health-check` pushed `permissionService.checkAllPermissions().errors`
 * into its issue list verbatim. Those are bare `PermissionResult` objects with
 * no `actionHandler` — asserted against the real producer in
 * `electron/services/__tests__/permissionService.fdaDeniedShape-3219.test.ts` —
 * so the banner's button reached `SystemHealthMonitor`'s `default:` branch and
 * did nothing, and its label was the producer's 78-character sentence.
 *
 * Nobody saw it because `AppShell` gated the entire banner on the permission
 * being GRANTED (BACKLOG-3219). With that gate gone the row renders, so the
 * row has to work.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS SUITE DRIVES
 * ---------------------------------------------------------------------------
 * The REAL `system:health-check` handler, pulled out of `ipcMain.handle` after
 * `registerDiagnosticHandlers()` — not the decorator in isolation. A decorator
 * that is correct and unwired would pass a unit test and ship the bug.
 *
 * Inputs are the transcribed producer shapes from
 * `tests/fixtures/fdaDeniedIssue-3219.ts`, not invented literals.
 */

import { ipcMain } from "electron";
import {
  FDA_DENIED_PERMISSION_RESULT,
  CONTACTS_DENIED_PERMISSION_RESULT,
  CONTACTS_STORE_NOT_FOUND_PERMISSION_RESULT,
  FDA_EXPLAINER_ACTION_LABEL,
  FDA_EXPLAINER_ACTION_HANDLER,
} from "../../../tests/fixtures/fdaDeniedIssue-3219";

const mockCheckAllPermissions = jest.fn();
const mockCheckContactsLoading = jest.fn();

jest.mock("os", () => {
  const actual = jest.requireActual("os");
  return { ...actual, platform: () => "darwin" };
});

jest.mock("../../services/permissionService", () => ({
  __esModule: true,
  default: {
    checkAllPermissions: (...args: unknown[]) =>
      mockCheckAllPermissions(...args),
    checkContactsLoading: (...args: unknown[]) =>
      mockCheckContactsLoading(...args),
  },
}));

jest.mock("../../services/connectionStatusService", () => ({
  __esModule: true,
  default: { checkAllConnections: jest.fn() },
}));

jest.mock("../../services/databaseService", () => ({
  __esModule: true,
  default: { getDatabase: jest.fn(), isInitialized: jest.fn(() => false) },
}));

jest.mock("../../services/logService", () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// Imported after the mocks so the handler module picks them up.
import {
  registerDiagnosticHandlers,
  decorateFdaPermissionIssues,
  FDA_EXPLAINER_ACTION,
  FDA_EXPLAINER_ACTION_HANDLER as HANDLER_CONST,
} from "../diagnosticHandlers";

type HealthCheckResult = {
  success: boolean;
  healthy?: boolean;
  issues?: Array<Record<string, unknown>>;
};

/** The real registered `system:health-check` handler. */
function getHealthCheckHandler(): (
  event: unknown,
  userId: string | null,
  provider: string | null
) => Promise<HealthCheckResult> {
  registerDiagnosticHandlers();
  const call = (
    ipcMain.handle as unknown as jest.Mock
  ).mock.calls.find((c: unknown[]) => c[0] === "system:health-check");
  if (!call) {
    throw new Error("system:health-check was never registered");
  }
  return call[1];
}

/** A denied errno message, shaped like the real one but path-free. */
const ERRNO_MESSAGE = "EPERM: operation not permitted, access '<redacted>'";

const deniedPermissions = (errors: Array<Record<string, unknown>>) => ({
  allGranted: false,
  permissions: {},
  errors,
});

describe("BACKLOG-3219 — system:health-check decorates a Full Disk Access denial", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (ipcMain.handle as unknown as jest.Mock).mockClear();
    mockCheckContactsLoading.mockResolvedValue({
      canLoadContacts: true,
      contactCount: 0,
    });
  });

  it("exports the same label and handler the renderer and fixtures expect", () => {
    // Ties the three literals together. If the handler's constants and the
    // shared fixture drift apart, the renderer suite would assert a label the
    // main process no longer sends.
    expect(FDA_EXPLAINER_ACTION).toBe(FDA_EXPLAINER_ACTION_LABEL);
    expect(HANDLER_CONST).toBe(FDA_EXPLAINER_ACTION_HANDLER);
  });

  it("gives the FDA denial a short label and a handler that goes somewhere", async () => {
    mockCheckAllPermissions.mockResolvedValue(
      deniedPermissions([
        { ...FDA_DENIED_PERMISSION_RESULT, error: ERRNO_MESSAGE },
      ])
    );

    const result = await getHealthCheckHandler()({}, null, null);
    const issue = result.issues?.[0] as Record<string, unknown>;

    expect(issue.actionHandler).toBe(FDA_EXPLAINER_ACTION_HANDLER);
    expect(issue.action).toBe(FDA_EXPLAINER_ACTION_LABEL);
    // The row still NAMES the permission — that is the whole point of the
    // banner, and `SystemHealthMonitor` renders `title || userMessage`.
    expect(issue.userMessage).toBe(FDA_DENIED_PERMISSION_RESULT.userMessage);
    expect(issue.errorCode).toBe("FULL_DISK_ACCESS_DENIED");
  });

  it("collapses the contacts denial into that row — the same permission, ONE row", async () => {
    mockCheckAllPermissions.mockResolvedValue(
      deniedPermissions([
        { ...FDA_DENIED_PERMISSION_RESULT, error: ERRNO_MESSAGE },
        { ...CONTACTS_DENIED_PERMISSION_RESULT, error: ERRNO_MESSAGE },
      ])
    );

    const result = await getHealthCheckHandler()({}, null, null);

    // BACKLOG-3237 CHANGED THIS ASSERTION, AND THE CHANGE IS THE POINT.
    //
    // It used to read `toHaveLength(2)` — "both rows appear on a denied Mac;
    // leaving one with a dead button beside a live one would be its own
    // defect". Decorating both was right; emitting both was not. Two rows for
    // one missing permission is what the founder saw on 2026-09-07, and the
    // fix is one row per ROOT CAUSE rather than one per affected feature. The
    // consequences now ride along as secondary text on the single row; see
    // diagnosticHandlers.oneRowPerCause-3237.test.ts.
    //
    // Rewritten rather than deleted: a deleted test hides the behaviour
    // change, this one records it.
    expect(result.issues).toHaveLength(1);
    expect(
      (result.issues as Array<Record<string, unknown>>).map(
        (i) => i.actionHandler
      )
    ).toEqual([FDA_EXPLAINER_ACTION_HANDLER]);
  });

  it("leaves CONTACTS_STORE_NOT_FOUND alone — an absent address book is not a permission to grant", async () => {
    mockCheckAllPermissions.mockResolvedValue(
      deniedPermissions([
        {
          ...CONTACTS_STORE_NOT_FOUND_PERMISSION_RESULT,
          error: "ENOENT: no such file or directory",
        },
      ])
    );

    const result = await getHealthCheckHandler()({}, null, null);
    const issue = result.issues?.[0] as Record<string, unknown>;

    // BACKLOG-2392: telling a user to grant a permission she may already hold
    // is the bug BACKLOG-3210 part 1 was careful to avoid re-creating.
    // BACKLOG-3233 re-pointed the second assertion. It used to compare
    // `issue.action` to the FIXTURE's `action` — both sides from the same
    // constant, through a mocked producer — so it could not see the real
    // producer drop the field. An absent store now carries no `action` at all,
    // which is what takes the dead button off the row.
    expect(issue).not.toHaveProperty("actionHandler");
    expect(issue).not.toHaveProperty("action");
  });

  it("STATE 2 — permissions all granted produces NO issues at all", async () => {
    // The control that stops the fix from becoming "banner always on". If the
    // handler emitted a row here, the renderer could not render nothing.
    mockCheckAllPermissions.mockResolvedValue({
      allGranted: true,
      permissions: {},
      errors: [],
    });

    const result = await getHealthCheckHandler()({}, null, null);

    expect(result.issues).toEqual([]);
    expect(result.healthy).toBe(true);
  });

  describe("the decorator itself", () => {
    it("passes a non-FDA issue through byte-identical", () => {
      const unrelated = {
        type: "OAUTH_CONNECTION",
        severity: "error",
        userMessage: "Your Outlook connection expired.",
        action: "Reconnect",
        actionHandler: "reconnect-microsoft",
      };

      const [out] = decorateFdaPermissionIssues([unrelated]);

      expect(out).toEqual(unrelated);
      expect(out).toBe(unrelated);
    });

    it("does not choke on a malformed issue (no errorCode, null, a string)", () => {
      expect(
        decorateFdaPermissionIssues([{}, null, "nonsense", undefined])
      ).toEqual([{}, null, "nonsense", undefined]);
    });
  });
});
