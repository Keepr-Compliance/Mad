/**
 * BACKLOG-3275 — the only production writer of `"granted"`.
 *
 * `FDA_GRANTED` is what makes the app believe it can read the local Messages
 * database. The reducer half is pinned in `reducer.fdaInversion.test.ts`; this
 * file pins the dispatch, because without it that reducer case has no caller
 * and the fix would be unreachable from the running app.
 *
 * It is also the control for the mutation protocol: deleting the dispatch line
 * must make a named assertion here go red.
 *
 * @module appCore/state/flows/__tests__/usePermissionsFlow.fdaGranted.test
 */

import { renderHook, act } from "@testing-library/react";
import { usePermissionsFlow } from "../usePermissionsFlow";
import { systemService } from "@/services";
import type { AppAction } from "../../machine/types";

jest.mock("@/services", () => ({
  systemService: {
    checkAllPermissions: jest.fn(),
  },
}));

const mockCheckAllPermissions = systemService.checkAllPermissions as jest.Mock;

describe("BACKLOG-3275 — handlePermissionsGranted reports the capability, not just the step", () => {
  let dispatched: AppAction[];

  beforeEach(() => {
    jest.clearAllMocks();
    dispatched = [];
    // The initial effect probes; a denial keeps the fixture honest — the grant
    // under test comes from the handler, not from the probe.
    mockCheckAllPermissions.mockResolvedValue({
      success: true,
      data: { allGranted: false },
    });
  });

  function renderFlow() {
    return renderHook(() =>
      usePermissionsFlow({
        isWindows: false,
        onSetShowMoveAppPrompt: jest.fn(),
        onSetCurrentStep: jest.fn(),
        stateMachineDispatch: (action: AppAction) => {
          dispatched.push(action);
        },
      })
    );
  }

  it("dispatches FDA_GRANTED", async () => {
    const { result } = renderFlow();
    await act(async () => {
      result.current.handlePermissionsGranted();
    });

    expect(dispatched.map((a) => a.type)).toContain("FDA_GRANTED");
  });

  it("dispatches FDA_GRANTED BEFORE the step completion", async () => {
    // Order matters: the step completion carries the Full Disk Access state
    // through untouched, so the capability has to be recorded first or the
    // transition it triggers would carry the pre-grant value.
    const { result } = renderFlow();
    await act(async () => {
      result.current.handlePermissionsGranted();
    });

    const types = dispatched.map((a) => a.type);
    const granted = types.indexOf("FDA_GRANTED");
    const stepComplete = types.indexOf("ONBOARDING_STEP_COMPLETE");

    expect(granted).toBeGreaterThanOrEqual(0);
    expect(stepComplete).toBeGreaterThanOrEqual(0);
    expect(granted).toBeLessThan(stepComplete);
  });

  it("still completes the permissions step — navigation is unchanged", async () => {
    const { result } = renderFlow();
    await act(async () => {
      result.current.handlePermissionsGranted();
    });

    expect(dispatched).toContainEqual({
      type: "ONBOARDING_STEP_COMPLETE",
      step: "permissions",
    });
  });

  it("CONTROL: a probe that reports NOT granted dispatches neither", async () => {
    // The handler is the grant path. Merely mounting the hook and probing must
    // never assert the capability — otherwise the fix would report granted for
    // every user who opens the app.
    renderFlow();
    await act(async () => {
      await Promise.resolve();
    });

    expect(dispatched).toEqual([]);
  });
});
