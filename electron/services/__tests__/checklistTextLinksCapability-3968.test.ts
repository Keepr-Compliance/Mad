/**
 * @jest-environment node
 *
 * BACKLOG-3968 — the capability check holds texts on anything but a clear yes
 * (SR review of PR-5 §6: any non-success, and text_links not strictly true).
 *
 * The yes shape is transcribed from the function body in
 * supabase/migrations/20261031230000_backlog_3968_checklist_text_links.sql
 * (`jsonb_build_object('link_kinds', [...], 'text_links', true,
 * 'text_external_ids', true)`), and matches the keepr-test answer recorded on
 * BACKLOG-3968.
 */

jest.mock("../supabaseService", () => ({
  __esModule: true,
  default: { getAuthSession: jest.fn().mockResolvedValue({ userId: "u" }) },
}));
jest.mock("../logService", () => {
  const m = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { __esModule: true, default: m, logService: m };
});

import supabaseService from "../supabaseService";
import {
  CAPABILITIES_RPC,
  textLinksCapability,
  type CapabilityRpcClient,
} from "../checklistTextLinksCapability";

const YES = { link_kinds: ["attachment", "email", "text"], text_links: true, text_external_ids: true };

const client = (answer: () => PromiseLike<{ data: unknown; error: { code?: string; message: string } | null }>) => {
  const rpc = jest.fn(answer);
  return { rpc, get: () => ({ rpc }) as CapabilityRpcClient };
};

describe("BACKLOG-3968 — textLinksCapability", () => {
  it("yes: text_links true -> texts sent; asks the named function", async () => {
    const c = client(async () => ({ data: YES, error: null }));
    expect(await textLinksCapability(c.get)).toEqual({ textLinks: true });
    expect(c.rpc).toHaveBeenCalledWith(CAPABILITIES_RPC);
    expect(CAPABILITIES_RPC).toBe("submission_checklist_capabilities");
  });

  it.each([
    ["text_links false", { ...YES, text_links: false }],
    ["text_links the string 'true'", { ...YES, text_links: "true" }],
    ["no text_links key", { link_kinds: ["attachment", "email"] }],
    ["null data", null],
    ["bare true", true],
  ])("held when %s", async (_name, data) => {
    expect(await textLinksCapability(client(async () => ({ data, error: null })).get)).toEqual({
      textLinks: false,
      reason: "not_supported",
    });
  });

  it("held on an error answer (function absent)", async () => {
    const c = client(async () => ({ data: null, error: { code: "PGRST202", message: "not found" } }));
    expect(await textLinksCapability(c.get)).toEqual({ textLinks: false, reason: "error" });
  });

  it("held when the call throws", async () => {
    const c = client(() => Promise.reject(new Error("network down")));
    expect(await textLinksCapability(c.get)).toEqual({ textLinks: false, reason: "error" });
  });

  it("held when the client cannot be built", async () => {
    expect(
      await textLinksCapability(() => {
        throw new Error("Supabase client not initialized");
      }),
    ).toEqual({ textLinks: false, reason: "error" });
  });

  it("held on a timeout, and the timer does not outlive the call", async () => {
    jest.useFakeTimers();
    try {
      const c = client(() => new Promise(() => undefined));
      const pending = textLinksCapability(c.get, { timeoutMs: 8000 });
      await jest.advanceTimersByTimeAsync(8000);
      expect(await pending).toEqual({ textLinks: false, reason: "timeout" });
    } finally {
      jest.useRealTimers();
    }
  });

  it("held with no signed-in session, and the cloud is not asked", async () => {
    (supabaseService.getAuthSession as jest.Mock).mockResolvedValueOnce(null);
    const c = client(async () => ({ data: YES, error: null }));
    expect(await textLinksCapability(c.get)).toEqual({ textLinks: false, reason: "no_session" });
    expect(c.rpc).not.toHaveBeenCalled();
  });

  it("the default timeout is 8 s", async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    expect(require("../checklistTextLinksCapability").CAPABILITY_TIMEOUT_MS).toBe(8000);
  });
});
