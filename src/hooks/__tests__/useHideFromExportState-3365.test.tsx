/**
 * BACKLOG-3365 — the renderer's hide-from-export state.
 *
 * The hook is four lines over BACKLOG-3349's `useStrictFeatureState`, and the
 * shared hook's own behaviours (pending first, unknown on a rejected invoke,
 * survives a bridge with no method) are covered by `useStrictFeatureState-3349`
 * and are deliberately NOT restated here.
 *
 * What is only true of THIS hook, and what this file is for:
 *
 *   - it asks for `desktop_hide_from_export` and not for the other strict key,
 *     which is the one thing a wrong literal would get past the compiler only
 *     if the key list itself were wrong;
 *   - it carries all four states through unchanged, because
 *     `ConversationViewModal` renders the Hide control on `allowed` alone and
 *     distinguishes `pending` from `blocked` in what it says.
 */

import { renderHook, waitFor } from "@testing-library/react";
import { useHideFromExportState } from "../useHideFromExportState";
import type { HideFromExportState } from "../useHideFromExportState";

const HIDE_KEY = "desktop_hide_from_export";
const OTHER_STRICT_KEY = "email_contact_inference";

function strictStateMock(): jest.Mock {
  return window.api.featureGate.strictState as unknown as jest.Mock;
}

describe("BACKLOG-3365 — useHideFromExportState", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it("asks main for the hide key, and never for the other strict key", async () => {
    // Both strict keys now live in the same two registries. A copy-pasted
    // `email_contact_inference` compiles, answers from a real plan read, and
    // would hand the Hide control to whoever has email inference switched on.
    strictStateMock().mockResolvedValue("blocked");

    renderHook(() => useHideFromExportState());

    await waitFor(() => expect(strictStateMock()).toHaveBeenCalled());
    expect(strictStateMock()).toHaveBeenCalledWith(HIDE_KEY);
    expect(strictStateMock()).not.toHaveBeenCalledWith(OTHER_STRICT_KEY);
    expect(strictStateMock()).toHaveBeenCalledTimes(1);
  });

  it.each(["allowed", "blocked", "unknown"] as const)(
    "carries main's answer through unchanged: %s",
    async (state) => {
      strictStateMock().mockResolvedValue(state);

      const { result } = renderHook(() => useHideFromExportState());

      await waitFor(() => expect(result.current).toBe(state));
    }
  );

  it("is pending before the first answer, not blocked", async () => {
    // A control that said "not in your plan" for the half-second before the
    // plan was read would be telling an entitled user something false.
    let resolveIt: (value: HideFromExportState) => void = () => {};
    strictStateMock().mockImplementation(
      () => new Promise<HideFromExportState>((resolve) => { resolveIt = resolve; })
    );

    const { result } = renderHook(() => useHideFromExportState());

    expect(result.current).toBe("pending");

    resolveIt("allowed");
    await waitFor(() => expect(result.current).toBe("allowed"));
  });
});
