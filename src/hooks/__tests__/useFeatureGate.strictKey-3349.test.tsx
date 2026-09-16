/**
 * BACKLOG-3349 — G4: strictness in the renderer is PER KEY.
 *
 * Two opposite mistakes, one control:
 *
 *   (a) No strict branch at all. `isAllowed` is `feature?.allowed ?? true`, and
 *       the payload `feature-gate:get-all` returns for a user whose organization
 *       could not be resolved carries ONLY the four team-only keys — so the new
 *       key would read ALLOWED for exactly those users. Against today's code
 *       this file fails 3 of its 4 strict assertions.
 *
 *   (b) Strictness made global. Turning `?? true` into `=== true` for every key
 *       was measured three times at 7 of 19 export-gate tests red: an offline
 *       user would lose exports, attachments and the rest. So the existing-key
 *       assertions below are as load-bearing as the strict ones.
 *
 * The payloads are transcribed from the handler that produces them
 * (`electron/handlers/featureGateHandlers.ts`, the no-org branch) and from the
 * live Individual plan's key set, not invented.
 */

import { renderHook, waitFor } from "@testing-library/react";
import { useFeatureGate } from "../useFeatureGate";

const STRICT_KEY = "email_contact_inference";

/** Keys that must KEEP failing open, whatever happens to the strict one. */
const FAIL_OPEN_KEYS = ["text_export", "desktop_email_attachments", "desktop_text_export"];

type Access = { allowed: boolean; value: string; source: "plan" | "override" | "default" };

function denied(): Access {
  return { allowed: false, value: "", source: "default" };
}

/**
 * The exact payload the main process returns when no organization resolves:
 * the four team-only keys, all denied, and nothing else.
 */
const NO_ORG_PAYLOAD: Record<string, Access> = {
  broker_submission: denied(),
  ai_detection: denied(),
  broker_email_view: denied(),
  broker_email_attachments: denied(),
};

/** A real plan answer that simply does not carry the strict key yet. */
const PLAN_WITHOUT_THE_KEY: Record<string, Access> = {
  ai_detection: { allowed: false, value: "false", source: "plan" },
  text_export: { allowed: true, value: "true", source: "plan" },
  email_export: { allowed: true, value: "true", source: "plan" },
  desktop_email_attachments: { allowed: true, value: "true", source: "plan" },
  desktop_text_attachments: { allowed: true, value: "true", source: "plan" },
  broker_submission: { allowed: false, value: "false", source: "plan" },
};

function mockGetAll(impl: () => Promise<Record<string, Access>>): void {
  (window.api.featureGate.getAll as jest.Mock).mockImplementation(impl);
}

async function loadGate() {
  const { result } = renderHook(() => useFeatureGate());
  await waitFor(() => expect(result.current.hasInitialized).toBe(true));
  return result;
}

describe("BACKLOG-3349 G4 — useFeatureGate is strict for the strict key only", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it("(a) the no-org payload: the strict key is NOT allowed, the fail-open keys are", async () => {
    mockGetAll(async () => NO_ORG_PAYLOAD);

    const result = await loadGate();

    expect(result.current.isAllowed(STRICT_KEY)).toBe(false);
    for (const key of FAIL_OPEN_KEYS) {
      expect([key, result.current.isAllowed(key)]).toEqual([key, true]);
    }
  });

  it("(b) a real plan that does not carry the key: not allowed, others unaffected", async () => {
    mockGetAll(async () => PLAN_WITHOUT_THE_KEY);

    const result = await loadGate();

    expect(result.current.isAllowed(STRICT_KEY)).toBe(false);
    for (const key of FAIL_OPEN_KEYS) {
      expect([key, result.current.isAllowed(key)]).toEqual([key, true]);
    }
  });

  it("(c) the lookup rejected: not allowed, while the fail-open keys stay usable", async () => {
    mockGetAll(async () => {
      throw new Error("ipc down");
    });

    const result = await loadGate();

    expect(result.current.isAllowed(STRICT_KEY)).toBe(false);
    for (const key of FAIL_OPEN_KEYS) {
      expect([key, result.current.isAllowed(key)]).toEqual([key, true]);
    }
  });

  it("(d) a positive read allows it — without this the others pass against 'always false'", async () => {
    mockGetAll(async () => ({
      ...PLAN_WITHOUT_THE_KEY,
      [STRICT_KEY]: { allowed: true, value: "true", source: "plan" },
    }));

    const result = await loadGate();

    expect(result.current.isAllowed(STRICT_KEY)).toBe(true);
  });

  it("(e) an explicit false is blocked, the same as an absent key", async () => {
    mockGetAll(async () => ({
      ...PLAN_WITHOUT_THE_KEY,
      [STRICT_KEY]: { allowed: false, value: "false", source: "plan" },
    }));

    const result = await loadGate();

    expect(result.current.isAllowed(STRICT_KEY)).toBe(false);
  });

  it("(f) prototype names are not features, in either direction", async () => {
    // `features["constructor"]` is truthy through the prototype chain. A strict
    // branch written with `in`, or a fail-open branch reading `?.allowed` off
    // `Object.prototype.constructor`, both misread this.
    mockGetAll(async () => PLAN_WITHOUT_THE_KEY);

    const result = await loadGate();

    expect(result.current.isAllowed("constructor")).toBe(true);
    expect(result.current.isAllowed("__proto__")).toBe(true);
  });
});
