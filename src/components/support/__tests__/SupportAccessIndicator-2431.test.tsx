/**
 * Tests for SupportAccessIndicator.tsx (BACKLOG-2431)
 *
 * One claim: the persistent "support access is on" banner reflects THE GRANT,
 * not the existence of a captured report.
 *
 * Founder QA, 2026-08-03, with log timestamps:
 *
 *   08:34:21  Support access granted for 7 days
 *   08:35:17  Generated a support diagnostics encryption key
 *   08:35:17  Support report ... queued (reason=manual)
 *             ^ banner appeared only now
 *
 * The banner is the only always-visible sign that client data is being
 * collected. A user who grants access and never manually captures must still
 * see it — otherwise collection is running with no persistent indication, which
 * is the failure mode that matters.
 *
 * The real cause was NOT the encryption key (the backend's `isActive()` reads
 * only the grant's `expiresAt`). It was the renderer: the banner had a 60s
 * `setInterval` poll and main pushed nothing on grant, so it could lag a grant
 * by nearly a full minute. The fix subscribes to a pushed state change.
 *
 * Wrapped in StrictMode per repo convention (StrictMode is ON in main.tsx).
 * The renderer service is mocked — components never call window.api directly.
 */

import React, { StrictMode } from "react";
import { render, screen, act, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { SupportAccessState } from "../../../services/supportAccessService";

// --- Mocks -----------------------------------------------------------------

const mockGetSnapshot = jest.fn();
const mockSubscribe = jest.fn();

jest.mock("../../../services/supportAccessService", () => {
  const actual = jest.requireActual("../../../services/supportAccessService");
  return {
    ...actual,
    getSnapshot: () => mockGetSnapshot(),
    subscribeToAccessChanges: (cb: (s: SupportAccessState) => void) =>
      mockSubscribe(cb),
    revokeAccess: jest.fn(),
  };
});

jest.mock("../../../utils/logger", () => ({
  __esModule: true,
  default: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

import { SupportAccessIndicator } from "../SupportAccessIndicator";

// --- Fixtures ---------------------------------------------------------------

const HOUR = 60 * 60 * 1000;

/** An active 7-day grant. Deliberately carries NO reports and no key state. */
function activeGrant(): SupportAccessState {
  return {
    active: true,
    consent: {
      id: "consent-1",
      grantedAt: new Date("2026-08-03T08:34:21Z").toISOString(),
      expiresAt: new Date("2026-08-10T08:34:21Z").toISOString(),
      durationId: "7d",
      scopes: [],
      disclosureId: "d1",
      disclosureHash: "hash",
      endedAt: null,
    },
    msRemaining: 7 * 24 * HOUR,
    history: [],
    everGranted: true,
  } as unknown as SupportAccessState;
}

function inactive(): SupportAccessState {
  return {
    active: false,
    consent: null,
    msRemaining: 0,
    history: [],
    everGranted: false,
  } as unknown as SupportAccessState;
}

/** The snapshot shape getSnapshot() resolves. `reports: []` is the point. */
function snapshotOf(state: SupportAccessState) {
  return {
    state,
    reports: [],
    durations: [],
    defaultDurationId: "7d",
    scopes: [],
    defaultScopes: [],
    disclosure: { id: "d1", text: "t", hash: "h" },
    retentionDays: 30,
    captureFailure: null,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  // Default: nothing granted, and no push arrives unless a test sends one.
  mockGetSnapshot.mockResolvedValue(snapshotOf(inactive()));
  mockSubscribe.mockReturnValue(() => undefined);
});

afterEach(() => {
  jest.useRealTimers();
});

describe("BACKLOG-2431 — banner reflects the grant, not capture state", () => {
  it("appears on the pushed grant with zero captured reports and no poll tick", async () => {
    // Capture the push callback the component registers.
    let push: ((s: SupportAccessState) => void) | undefined;
    mockSubscribe.mockImplementation((cb: (s: SupportAccessState) => void) => {
      push = cb;
      return () => undefined;
    });

    render(
      <StrictMode>
        <SupportAccessIndicator />
      </StrictMode>
    );

    // Initial load resolves as "not granted" — banner absent.
    await act(async () => {
      await Promise.resolve();
    });
    expect(
      screen.queryByTestId("support-access-indicator")
    ).not.toBeInTheDocument();
    expect(push).toBeDefined();

    // Baseline: mount-time loads only. (StrictMode double-invokes effects, so
    // this is 2, not 1 — the number is not the point; that it does not grow is.)
    const loadsAfterMount = mockGetSnapshot.mock.calls.length;

    // The grant happens. Main pushes the new state. NOTHING has been captured:
    // getSnapshot still reports inactive, and reports is empty either way. If
    // the banner keyed off a report/queue/encryption key existing, this would
    // not be enough to show it.
    act(() => {
      push?.(activeGrant());
    });

    await waitFor(() => {
      expect(screen.getByTestId("support-access-indicator")).toBeInTheDocument();
    });
    expect(screen.getByText("Keepr support access is on")).toBeInTheDocument();

    // And it did so without re-reading state at all: the push carried it. This
    // is the regression guard — revert to poll-only and the banner assertion
    // above fails, because no timer has advanced and no further load happened.
    expect(mockGetSnapshot.mock.calls.length).toBe(loadsAfterMount);
  });

  it("does not wait up to the 60s poll interval to show a grant", async () => {
    let push: ((s: SupportAccessState) => void) | undefined;
    mockSubscribe.mockImplementation((cb: (s: SupportAccessState) => void) => {
      push = cb;
      return () => undefined;
    });

    render(
      <StrictMode>
        <SupportAccessIndicator />
      </StrictMode>
    );
    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      push?.(activeGrant());
    });
    await waitFor(() => {
      expect(screen.getByTestId("support-access-indicator")).toBeInTheDocument();
    });

    // Assert we never needed the interval: advancing just short of a full
    // period changes nothing, because the banner is already up.
    act(() => {
      jest.advanceTimersByTime(59_000);
    });
    expect(screen.getByTestId("support-access-indicator")).toBeInTheDocument();
  });

  it("subscribes on mount and unsubscribes on unmount", async () => {
    const unsubscribe = jest.fn();
    mockSubscribe.mockReturnValue(unsubscribe);

    const { unmount } = render(
      <StrictMode>
        <SupportAccessIndicator />
      </StrictMode>
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(mockSubscribe).toHaveBeenCalled();

    unmount();
    expect(unsubscribe).toHaveBeenCalled();
  });

  it("hides the banner when a revocation is pushed", async () => {
    let push: ((s: SupportAccessState) => void) | undefined;
    mockSubscribe.mockImplementation((cb: (s: SupportAccessState) => void) => {
      push = cb;
      return () => undefined;
    });
    mockGetSnapshot.mockResolvedValue(snapshotOf(activeGrant()));

    render(
      <StrictMode>
        <SupportAccessIndicator />
      </StrictMode>
    );
    await waitFor(() => {
      expect(screen.getByTestId("support-access-indicator")).toBeInTheDocument();
    });

    act(() => {
      push?.(inactive());
    });

    await waitFor(() => {
      expect(
        screen.queryByTestId("support-access-indicator")
      ).not.toBeInTheDocument();
    });
  });
});
