/**
 * BACKLOG-3321: the pre-auth effect re-checks `cancelled` after the database
 * probe await. If the orchestrator unmounts while main is still answering
 * `system:is-database-initialized`, nothing is dispatched afterwards.
 *
 * Counted on a dispatch SPY (useAppState mocked), not on reducer calls: a
 * provider's reducer can still run for a dispatch that lands after unmount, so
 * a reducer count cannot tell the two cases apart.
 *
 * Fixture provenance:
 * - preValidateSession result: preAuthValidationHandler.ts returns
 *   `{ valid: false, reason: "offline_grace_expired" }` (a reason that keeps the
 *   database closed, so the probe runs).
 * - isDatabaseInitialized result: systemHandlers.ts returns
 *   `{ success: true, initialized: databaseService.isInitialized() }`.
 */
import React from "react";
import { render, act, waitFor } from "@testing-library/react";
import { LoadingOrchestrator } from "./LoadingOrchestrator";

const dispatch = jest.fn();
jest.mock("./useAppState", () => ({
  useAppState: () => ({
    state: { status: "loading", phase: "validating-auth" },
    dispatch,
    loadingPhase: "validating-auth",
  }),
}));
jest.mock("../../../contexts", () => ({
  useAuth: () => ({ login: jest.fn(), logout: jest.fn(), sessionToken: null }),
}));
jest.mock("./components/LoadingScreen", () => ({ LoadingScreen: () => null }));
jest.mock("./components/ErrorScreen", () => ({ ErrorScreen: () => null }));
jest.mock("@sentry/electron/renderer", () => ({
  addBreadcrumb: jest.fn(),
  setTag: jest.fn(),
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));
jest.mock("../../../utils/logger", () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

let resolveProbe: (v: { success: boolean; initialized: boolean }) => void = () => {};
const mockApi = {
  auth: { preValidateSession: jest.fn() },
  system: { isDatabaseInitialized: jest.fn() },
};

beforeAll(() => {
  (window as unknown as { api: typeof mockApi }).api = mockApi;
});
afterAll(() => {
  delete (window as unknown as { api?: typeof mockApi }).api;
});
beforeEach(() => {
  dispatch.mockClear();
  mockApi.auth.preValidateSession.mockReset();
  mockApi.system.isDatabaseInitialized.mockReset();
  mockApi.auth.preValidateSession.mockResolvedValue({
    valid: false,
    reason: "offline_grace_expired",
  });
  mockApi.system.isDatabaseInitialized.mockImplementation(
    () =>
      new Promise((res) => {
        resolveProbe = res;
      }),
  );
});

function preValidated(): unknown[] {
  return dispatch.mock.calls
    .map((c) => c[0] as { type: string })
    .filter((a) => a.type === "AUTH_PRE_VALIDATED");
}

async function renderUntilProbeInFlight() {
  const r = render(
    <LoadingOrchestrator>
      <div />
    </LoadingOrchestrator>,
  );
  await waitFor(() => expect(mockApi.system.isDatabaseInitialized).toHaveBeenCalledTimes(1));
  return r;
}

describe("BACKLOG-3321 pre-auth probe: cancelled after the probe await", () => {
  it("still mounted: the probe answer is dispatched once", async () => {
    await renderUntilProbeInFlight();
    await act(async () => {
      resolveProbe({ success: true, initialized: false });
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(preValidated()).toEqual([
      expect.objectContaining({
        type: "AUTH_PRE_VALIDATED",
        valid: false,
        reason: "offline_grace_expired",
        database: "not-initialized",
      }),
    ]);
  });

  it("unmounted mid-probe: nothing is dispatched after the probe answers", async () => {
    const r = await renderUntilProbeInFlight();
    r.unmount();
    await act(async () => {
      resolveProbe({ success: true, initialized: false });
      await new Promise((r2) => setTimeout(r2, 20));
    });
    expect(preValidated()).toEqual([]);
  });
});
