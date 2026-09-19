/**
 * BACKLOG-3349 — the renderer's strict-state hook.
 *
 * Three behaviours, each of which a surface depends on for its wording:
 *
 *   - it starts PENDING, not blocked, so no row says "not in your plan" for the
 *     half-second before the plan is actually read;
 *   - a failed invoke lands on UNKNOWN rather than throwing, so a suite that
 *     replaces `window.api.featureGate` wholesale gets an honest state instead
 *     of a crashed render;
 *   - it asks main, and forwards main's answer unchanged.
 */

import { renderHook, waitFor } from "@testing-library/react";
import { useStrictFeatureState } from "../useStrictFeatureState";
import { useContactInferenceState } from "../useContactInferenceState";

const STRICT_KEY = "email_contact_inference" as const;

function strictStateMock(): jest.Mock {
  return window.api.featureGate.strictState as unknown as jest.Mock;
}

describe("BACKLOG-3349 — useStrictFeatureState", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it("starts pending, before any answer has arrived", () => {
    let resolveIt: (value: string) => void = () => {};
    strictStateMock().mockImplementation(
      () => new Promise<string>((resolve) => { resolveIt = resolve; })
    );

    const { result } = renderHook(() => useStrictFeatureState(STRICT_KEY));

    expect(result.current).toBe("pending");
    resolveIt("blocked");
  });

  it.each(["allowed", "blocked", "unknown"] as const)(
    "forwards main's answer unchanged: %s",
    async (state) => {
      strictStateMock().mockResolvedValue(state);

      const { result } = renderHook(() => useStrictFeatureState(STRICT_KEY));

      await waitFor(() => expect(result.current).toBe(state));
      expect(strictStateMock()).toHaveBeenCalledWith(STRICT_KEY);
    }
  );

  it("a rejected invoke lands on unknown, never on blocked", async () => {
    // Blocked is a claim about the plan. A failed IPC call has not seen one.
    strictStateMock().mockRejectedValue(new Error("ipc down"));

    const { result } = renderHook(() => useStrictFeatureState(STRICT_KEY));

    await waitFor(() => expect(result.current).toBe("unknown"));
  });

  it("survives a bridge with no strictState method at all", async () => {
    // A suite that replaces `window.api.featureGate` wholesale leaves the
    // method undefined, and reaching through it throws SYNCHRONOUSLY. Awaiting
    // inside the try is what turns that into a state rather than a crash.
    const original = window.api.featureGate;
    (window.api as unknown as { featureGate: unknown }).featureGate = {
      getAll: jest.fn(),
      check: jest.fn(),
      invalidateCache: jest.fn(),
    };

    try {
      const { result } = renderHook(() => useStrictFeatureState(STRICT_KEY));
      await waitFor(() => expect(result.current).toBe("unknown"));
    } finally {
      (window.api as unknown as { featureGate: unknown }).featureGate = original;
    }
  });
});

describe("BACKLOG-3349 — useContactInferenceState", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it("asks for the email-inference key and reports it under 'outlook'", async () => {
    strictStateMock().mockResolvedValue("allowed");

    const { result } = renderHook(() => useContactInferenceState());

    await waitFor(() => expect(result.current.outlook).toBe("allowed"));
    expect(strictStateMock()).toHaveBeenCalledWith(STRICT_KEY);
  });

  it("carries a blocked answer through", async () => {
    strictStateMock().mockResolvedValue("blocked");

    const { result } = renderHook(() => useContactInferenceState());

    await waitFor(() => expect(result.current.outlook).toBe("blocked"));
  });
});
