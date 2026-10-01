/**
 * @jest-environment node
 *
 * BACKLOG-3618 — where the chooser's "create your own → Checklists" answer
 * comes from, now that brokerage agents can make their own checklists.
 *
 * `checklists:can-edit-templates` asks, in the portal page gate's own order:
 *   1. `can_edit_checklist_templates` — true → creator (broker, admin, solo).
 *   2. only when that said false: `can_create_own_checklist_templates`.
 *   A failure of step 2 is "cannot create" (the 3617 answer), not unknown, so a
 *   database without the 3618 function behaves exactly as before 3618.
 *
 * The missing-function reply below is captured from production on 2026-09-30,
 * before the 3618 migration was applied (HTTP 404, verbatim body).
 *
 * Wrong implementations this suite catches:
 *   OLD     still asking only can_edit → an agent never gets the link.
 *   NEWONLY asking only can_create_own → before 3618 is applied (or after its
 *           rollback) every editor's answer turns unknown and the link vanishes.
 *   UNKNOWN step 2's failure answered as unknown → an agent pre-3618 sees the
 *           "Templates come from…" line instead of today's answer.
 *   ORDER   can_create_own asked first → an editor depends on the new function.
 *
 * C3 (release order) is the last describe: a desktop tree that ships the flip
 * must carry the portal page that admits agents.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import fs from "fs";
import path from "path";

const registeredHandlers = new Map<string, any>();

jest.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, fn: any) => {
      registeredHandlers.set(channel, fn);
    },
  },
  shell: { openExternal: jest.fn() },
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
jest.mock("../../services/supabaseService", () => ({
  __esModule: true,
  default: {
    getClient: () => ({ rpc: (...args: unknown[]) => mockRpc(...args) }),
    getAuthSession: jest.fn().mockResolvedValue({ userId: "u-3618", accessToken: "t" }),
  },
}));

jest.mock("../featureGateHandlers", () => ({
  isChecklistsAllowed: jest.fn().mockResolvedValue(true),
  resolveOrgIdOrRefusal: jest
    .fn()
    .mockResolvedValue({ status: "member", organizationId: "00000000-0000-4000-8000-00003618f0a1" }), // pii-allow-uuid: invented fixture id
}));

import { CHECKLIST_TEMPLATE_ROLE_UNKNOWN_ERROR, registerChecklistHandlers } from "../checklistHandlers";

const ORG = "00000000-0000-4000-8000-00003618f0a1"; // pii-allow-uuid: invented fixture id

/** Production, 2026-09-30, before 3618: POST /rest/v1/rpc/can_create_own_checklist_templates. */
const MISSING_FUNCTION = {
  code: "PGRST202",
  details:
    "Searched for the function public.can_create_own_checklist_templates with parameter p_org_id or with a single unnamed json/jsonb parameter, but no matches were found in the schema cache.",
  hint: "Perhaps you meant to call the function public.can_edit_checklist_templates",
  message:
    "Could not find the function public.can_create_own_checklist_templates(p_org_id) in the schema cache",
};

registerChecklistHandlers();

function ask(): Promise<any> {
  const handler = registeredHandlers.get("checklists:can-edit-templates");
  if (!handler) throw new Error("no handler");
  return handler({} as any);
}

type Reply = { data: unknown; error: unknown } | Error;
function answer(replies: Record<string, Reply>): void {
  mockRpc.mockImplementation(async (fn: string) => {
    const reply = replies[fn];
    if (!reply) throw new Error(`unexpected rpc ${fn}`);
    if (reply instanceof Error) throw reply;
    return reply;
  });
}

const rpcNames = (): string[] => mockRpc.mock.calls.map((c) => c[0] as string);

beforeEach(() => {
  mockRpc.mockReset();
});

describe("BACKLOG-3618 — the create flag's source", () => {
  it("an agent on a plan with checklists (can_edit false, can_create_own true) is a creator", async () => {
    answer({
      can_edit_checklist_templates: { data: false, error: null },
      can_create_own_checklist_templates: { data: true, error: null },
    });
    expect(await ask()).toEqual({ success: true, canEdit: true });
    expect(rpcNames()).toEqual(["can_edit_checklist_templates", "can_create_own_checklist_templates"]);
    expect(mockRpc).toHaveBeenLastCalledWith("can_create_own_checklist_templates", { p_org_id: ORG });
  });

  it("an editor is answered by can_edit alone — the new function is never asked", async () => {
    answer({
      can_edit_checklist_templates: { data: true, error: null },
      can_create_own_checklist_templates: MISSING_FUNCTION as any,
    });
    expect(await ask()).toEqual({ success: true, canEdit: true });
    expect(rpcNames()).toEqual(["can_edit_checklist_templates"]);
  });

  it("a member whose plan has no checklists (both false) cannot create", async () => {
    answer({
      can_edit_checklist_templates: { data: false, error: null },
      can_create_own_checklist_templates: { data: false, error: null },
    });
    expect(await ask()).toEqual({ success: true, canEdit: false });
  });

  describe("a database without the 3618 function (not applied, or rolled back)", () => {
    it("an editor still gets the link", async () => {
      answer({
        can_edit_checklist_templates: { data: true, error: null },
        can_create_own_checklist_templates: { data: null, error: MISSING_FUNCTION },
      });
      expect(await ask()).toEqual({ success: true, canEdit: true });
    });

    it("an agent gets today's answer — cannot create — not unknown", async () => {
      answer({
        can_edit_checklist_templates: { data: false, error: null },
        can_create_own_checklist_templates: { data: null, error: MISSING_FUNCTION },
      });
      expect(await ask()).toEqual({ success: true, canEdit: false });
    });

    it("a thrown or non-boolean second answer is also cannot-create", async () => {
      answer({
        can_edit_checklist_templates: { data: false, error: null },
        can_create_own_checklist_templates: new Error("offline"),
      });
      expect(await ask()).toEqual({ success: true, canEdit: false });
      answer({
        can_edit_checklist_templates: { data: false, error: null },
        can_create_own_checklist_templates: { data: "true", error: null },
      });
      expect(await ask()).toEqual({ success: true, canEdit: false });
    });
  });

  it("can_edit unknown stays unknown, and can_create_own is not asked", async () => {
    answer({
      can_edit_checklist_templates: { data: null, error: { code: "PGRST", message: "x" } },
      can_create_own_checklist_templates: { data: true, error: null },
    });
    expect(await ask()).toEqual({ success: false, error: CHECKLIST_TEMPLATE_ROLE_UNKNOWN_ERROR });
    expect(rpcNames()).toEqual(["can_edit_checklist_templates"]);
  });
});

/**
 * C3 — release order. The flip above sends agents to the portal Checklists
 * page. Before BACKLOG-3618 PR 2 that page refuses agents (notFound). The
 * desktop release and the production portal are both built from `main`, and
 * the portal deploys on the push, before the desktop release exists. So the
 * guard is: this tree's portal gate must admit own-checklist creators. A
 * desktop tree without the portal change cannot go green.
 */
describe("BACKLOG-3618 C3 — the portal in this tree admits agents to Checklists", () => {
  const gate = fs.readFileSync(
    path.join(__dirname, "..", "..", "..", "broker-portal", "lib", "checklist-access.ts"),
    "utf8",
  );

  it("the page gate asks can_create_own_checklist_templates", () => {
    expect(gate).toMatch(/rpc\(\s*['"]can_create_own_checklist_templates['"]/);
  });

  it("and still asks can_edit_checklist_templates first", () => {
    const edit = gate.search(/rpc\(\s*['"]can_edit_checklist_templates['"]/);
    const own = gate.search(/rpc\(\s*['"]can_create_own_checklist_templates['"]/);
    expect(edit).toBeGreaterThanOrEqual(0);
    expect(own).toBeGreaterThan(edit);
  });
});
