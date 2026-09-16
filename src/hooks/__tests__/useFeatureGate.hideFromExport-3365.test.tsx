/**
 * BACKLOG-3365 — `useFeatureGate` is strict for the hide key too.
 *
 * `useFeatureGate().isAllowed` is not how the Hide control decides — that is
 * `useHideFromExportState`, over the strict channel. This file exists because
 * `isAllowed` is the obvious WRONG way to decide, it is reachable from any
 * component, and without the key on the renderer's strict list it would answer
 * TRUE for every user today: the row is not applied, so the key is absent from
 * every plan map, and `feature?.allowed ?? true` reads an absent key as allowed.
 *
 * The fail-open assertions are as load-bearing as the strict one. Making
 * `isAllowed` strict for every key was measured at 7 of 19 export-gate tests
 * red — an offline user would lose exports and attachments. Strictness is a
 * property of the key.
 */

import { renderHook, waitFor } from "@testing-library/react";
import { useFeatureGate } from "../useFeatureGate";

const HIDE_KEY = "desktop_hide_from_export";

/** Keys that must KEEP failing open, whatever happens to the strict ones. */
const FAIL_OPEN_KEYS = ["text_export", "desktop_text_export", "desktop_email_attachments"];

type Access = { allowed: boolean; value: string; source: "plan" | "override" | "default" };

function denied(): Access {
  return { allowed: false, value: "", source: "default" };
}

/**
 * The exact payload the main process returns when no organization resolves:
 * the four team-only keys, all denied, and nothing else
 * (`featureGateHandlers.ts`, the no-org branch of `feature-gate:get-all`).
 */
const NO_ORG_PAYLOAD: Record<string, Access> = {
  broker_submission: denied(),
  ai_detection: denied(),
  broker_email_view: denied(),
  broker_email_attachments: denied(),
};

/**
 * A real plan answer that does not carry the hide key — the state of every
 * organization until the BACKLOG-3365 row is applied.
 */
const PLAN_WITHOUT_THE_KEY: Record<string, Access> = {
  ai_detection: { allowed: false, value: "false", source: "plan" },
  text_export: { allowed: true, value: "true", source: "plan" },
  desktop_text_export: { allowed: true, value: "true", source: "plan" },
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

describe("BACKLOG-3365 — useFeatureGate never fails open on the hide key", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it.each([
    ["an empty map", async () => ({})],
    ["the no-org payload", async () => NO_ORG_PAYLOAD],
    ["a real plan that does not carry the key", async () => PLAN_WITHOUT_THE_KEY],
  ])("%s: the hide key is denied while the fail-open keys are not", async (_label, payload) => {
    mockGetAll(payload as () => Promise<Record<string, Access>>);

    const result = await loadGate();

    expect(result.current.isAllowed(HIDE_KEY)).toBe(false);
    for (const key of FAIL_OPEN_KEYS) {
      expect([key, result.current.isAllowed(key)]).toEqual([key, true]);
    }
  });

  it("the lookup rejected: denied, while the fail-open keys stay usable", async () => {
    mockGetAll(async () => {
      throw new Error("ipc down");
    });

    const result = await loadGate();

    expect(result.current.isAllowed(HIDE_KEY)).toBe(false);
    for (const key of FAIL_OPEN_KEYS) {
      expect([key, result.current.isAllowed(key)]).toEqual([key, true]);
    }
  });

  it("a positive read allows it — without this the others pass against 'always false'", async () => {
    mockGetAll(async () => ({
      ...PLAN_WITHOUT_THE_KEY,
      [HIDE_KEY]: { allowed: true, value: "true", source: "plan" },
    }));

    const result = await loadGate();

    expect(result.current.isAllowed(HIDE_KEY)).toBe(true);
  });

  it("an explicit false is denied, the same as an absent key", async () => {
    mockGetAll(async () => ({
      ...PLAN_WITHOUT_THE_KEY,
      [HIDE_KEY]: { allowed: false, value: "false", source: "plan" },
    }));

    const result = await loadGate();

    expect(result.current.isAllowed(HIDE_KEY)).toBe(false);
  });

  it("the other strict key being allowed does not allow this one", async () => {
    mockGetAll(async () => ({
      ...PLAN_WITHOUT_THE_KEY,
      email_contact_inference: { allowed: true, value: "true", source: "plan" },
    }));

    const result = await loadGate();

    expect(result.current.isAllowed(HIDE_KEY)).toBe(false);
    expect(result.current.isAllowed("email_contact_inference")).toBe(true);
  });
});
