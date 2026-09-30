/**
 * @jest-environment node
 *
 * BACKLOG-3617 — the two channels behind the chooser's create-your-own hint.
 *
 *   checklists:can-edit-templates    asks the database
 *                                    (`can_edit_checklist_templates`) whether
 *                                    this user may create templates. Only the
 *                                    database's literal boolean is an answer;
 *                                    everything else is "unknown".
 *   checklists:open-templates-portal opens the portal Checklists page. The
 *                                    renderer passes no URL, and only a Keepr
 *                                    or localhost origin is ever opened.
 *
 * Wrong implementations this suite is here to catch:
 *   FLAT   an RPC error, a missing session or a non-boolean reply answered as
 *          `canEdit: false` — an unknown user shown the agent view.
 *   OPEN   the channel opening a URL the renderer sent, or any configured
 *          `BROKER_PORTAL_URL` without checking its origin.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

const registeredHandlers = new Map<string, any>();
const mockOpenExternal = jest.fn().mockResolvedValue(undefined);

jest.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, fn: any) => {
      registeredHandlers.set(channel, fn);
    },
  },
  shell: { openExternal: (...args: unknown[]) => mockOpenExternal(...args) },
  BrowserWindow: jest.fn(),
  app: { isPackaged: false, getPath: jest.fn(() => "/mock/user/data") },
}));

jest.mock("@sentry/electron/main", () => ({
  captureException: jest.fn(),
  setUser: jest.fn(),
  addBreadcrumb: jest.fn(),
  flush: jest.fn().mockResolvedValue(true),
}));

jest.mock("../../services/logService", () => {
  const m = {
    info: jest.fn().mockResolvedValue(undefined),
    debug: jest.fn().mockResolvedValue(undefined),
    warn: jest.fn().mockResolvedValue(undefined),
    error: jest.fn().mockResolvedValue(undefined),
  };
  return { __esModule: true, default: m, logService: m };
});

jest.mock("../../services/db/checklistDbService", () => ({}));
jest.mock("../../services/databaseService", () => ({ __esModule: true, default: {} }));
jest.mock("../../services/auditService", () => ({ __esModule: true, default: { log: jest.fn() } }));
jest.mock("../../services/checklistTemplateService", () => ({
  __esModule: true,
  default: { listTemplates: jest.fn(), invalidate: jest.fn() },
}));

const mockRpc = jest.fn();
const mockSession = jest.fn();
jest.mock("../../services/supabaseService", () => ({
  __esModule: true,
  default: {
    getClient: () => ({ rpc: (...args: unknown[]) => mockRpc(...args) }),
    getAuthSession: (...args: unknown[]) => mockSession(...args),
  },
}));

const mockGate = jest.fn();
const mockResolveOrg = jest.fn();
jest.mock("../featureGateHandlers", () => ({
  isChecklistsAllowed: (...args: unknown[]) => mockGate(...args),
  resolveOrgIdOrRefusal: (...args: unknown[]) => mockResolveOrg(...args),
}));

import {
  CHECKLISTS_NOT_ALLOWED_ERROR,
  CHECKLISTS_NO_ORGANIZATION_ERROR,
  CHECKLISTS_PORTAL_URL_REFUSED_ERROR,
  CHECKLIST_TEMPLATE_ROLE_UNKNOWN_ERROR,
  checklistsPortalUrl,
  registerChecklistHandlers,
} from "../checklistHandlers";

const ORG = "00000000-0000-4000-8000-00003617f0a1"; // pii-allow-uuid: invented fixture id

registerChecklistHandlers();

function invoke(channel: string, ...args: unknown[]): Promise<any> {
  const handler = registeredHandlers.get(channel);
  if (!handler) throw new Error(`no handler for ${channel}`);
  return handler({} as any, ...args);
}

const ORIGINAL_PORTAL = process.env.BROKER_PORTAL_URL;

beforeEach(() => {
  jest.clearAllMocks();
  mockGate.mockResolvedValue(true);
  mockResolveOrg.mockResolvedValue({ status: "member", organizationId: ORG });
  mockSession.mockResolvedValue({ userId: "u-3617", accessToken: "t" });
  delete process.env.BROKER_PORTAL_URL;
});

afterAll(() => {
  if (ORIGINAL_PORTAL === undefined) delete process.env.BROKER_PORTAL_URL;
  else process.env.BROKER_PORTAL_URL = ORIGINAL_PORTAL;
});

describe("BACKLOG-3617 — checklists:can-edit-templates", () => {
  it("true from the database is a creator, asked about the resolved organization", async () => {
    mockRpc.mockResolvedValue({ data: true, error: null });
    expect(await invoke("checklists:can-edit-templates")).toEqual({ success: true, canEdit: true });
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockRpc).toHaveBeenCalledWith("can_edit_checklist_templates", { p_org_id: ORG });
  });

  it("false from the database is a user who cannot create", async () => {
    mockRpc.mockResolvedValue({ data: false, error: null });
    expect(await invoke("checklists:can-edit-templates")).toEqual({ success: true, canEdit: false });
  });

  it.each([
    ["an RPC error", () => mockRpc.mockResolvedValue({ data: null, error: { code: "PGRST", message: "x" } })],
    ["a reply that is not a boolean (string)", () => mockRpc.mockResolvedValue({ data: "true", error: null })],
    ["a reply that is not a boolean (null)", () => mockRpc.mockResolvedValue({ data: null, error: null })],
    ["a thrown call", () => mockRpc.mockRejectedValue(new Error("offline"))],
    [
      "no session",
      () => {
        mockSession.mockResolvedValue(null);
        mockRpc.mockResolvedValue({ data: true, error: null });
      },
    ],
  ])("%s is unknown, never `canEdit: false`", async (_label, arrange) => {
    arrange();
    expect(await invoke("checklists:can-edit-templates")).toEqual({
      success: false,
      error: CHECKLIST_TEMPLATE_ROLE_UNKNOWN_ERROR,
    });
  });

  it("the plan gate refuses before anything is asked", async () => {
    mockGate.mockResolvedValue(false);
    expect(await invoke("checklists:can-edit-templates")).toEqual({
      success: false,
      error: CHECKLISTS_NOT_ALLOWED_ERROR,
    });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("an organization lookup that failed is unknown; a confirmed none says so", async () => {
    mockResolveOrg.mockResolvedValue({ status: "unavailable" });
    expect(await invoke("checklists:can-edit-templates")).toEqual({
      success: false,
      error: CHECKLIST_TEMPLATE_ROLE_UNKNOWN_ERROR,
    });
    mockResolveOrg.mockResolvedValue({ status: "none" });
    expect(await invoke("checklists:can-edit-templates")).toEqual({
      success: false,
      error: CHECKLISTS_NO_ORGANIZATION_ERROR,
    });
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

describe("BACKLOG-3617 — checklists:open-templates-portal", () => {
  it("opens exactly the production Checklists page by default", async () => {
    expect(await invoke("checklists:open-templates-portal")).toEqual({ success: true });
    expect(mockOpenExternal.mock.calls).toEqual([["https://app.keeprcompliance.com/dashboard/checklists"]]);
  });

  it("ignores any URL the renderer sends", async () => {
    expect(await invoke("checklists:open-templates-portal", "https://evil.example/")).toEqual({ success: true });
    expect(await invoke("checklists:open-templates-portal", { url: "file:///etc/passwd" })).toEqual({
      success: true,
    });
    expect(mockOpenExternal.mock.calls).toEqual([
      ["https://app.keeprcompliance.com/dashboard/checklists"],
      ["https://app.keeprcompliance.com/dashboard/checklists"],
    ]);
  });

  it("uses the dev portal from BROKER_PORTAL_URL, origin only", async () => {
    process.env.BROKER_PORTAL_URL = "http://localhost:3001/some/path?x=1#y";
    expect(await invoke("checklists:open-templates-portal")).toEqual({ success: true });
    expect(mockOpenExternal.mock.calls).toEqual([["http://localhost:3001/dashboard/checklists"]]);
  });

  it.each([
    "https://evil.example",
    "https://app.keeprcompliance.com.evil.example",
    "https://evilkeeprcompliance.com",
    "http://app.keeprcompliance.com",
    "https://user:pw@app.keeprcompliance.com",
    "javascript:alert(1)",
    "file:///etc/passwd",
    "not a url",
  ])("refuses a portal address outside the allowed origins: %s", async (configured) => {
    process.env.BROKER_PORTAL_URL = configured;
    expect(await invoke("checklists:open-templates-portal")).toEqual({
      success: false,
      error: CHECKLISTS_PORTAL_URL_REFUSED_ERROR,
    });
    expect(mockOpenExternal).not.toHaveBeenCalled();
  });

  it.each([
    [undefined, "https://app.keeprcompliance.com/dashboard/checklists"],
    ["https://app.keeprcompliance.com/", "https://app.keeprcompliance.com/dashboard/checklists"],
    ["https://keeprcompliance.com", "https://keeprcompliance.com/dashboard/checklists"],
    ["http://127.0.0.1:3001", "http://127.0.0.1:3001/dashboard/checklists"],
    ["https://localhost:3001", "https://localhost:3001/dashboard/checklists"],
  ])("checklistsPortalUrl(%s) → %s", (configured, expected) => {
    expect(checklistsPortalUrl(configured)).toBe(expected);
  });
});
