/**
 * BACKLOG-2760 — the import size estimate must describe the STORED preference on
 * first paint, and must fail CLOSED while it does not yet know.
 *
 * ─── WHAT WENT WRONG ─────────────────────────────────────────────────────────
 *
 * Traced from the founder's own `main.log` (cold start 2026-08-16 18:34, merged
 * develop 5c9b4b71e). `messages:get-import-count` logs the filters the renderer
 * sent; first paint produced FOUR requests:
 *
 *     18:34:02.100  { lookbackMonths: 3,    auditPeriodStart: null }
 *     18:34:02.353  { lookbackMonths: 3,    auditPeriodStart: null }
 *     18:34:02.366  { lookbackMonths: null, auditPeriodStart: null }
 *     18:34:02.694  { lookbackMonths: null, auditPeriodStart: null }
 *
 * So the effect DID re-run with the loaded "All time" preference, and no stale
 * `auditPeriodStart` was ever sent. The requests were right. What was wrong was
 * that nothing sequenced the RESPONSES: the mount-time request for the
 * component's initial `useState(3)` window resolved last, and last-write-wins
 * made its 12,074 messages / 2.6 GB final. 2.6 GB fits in 59 GB, so
 * `fitsOnDisk` was true, Import stayed enabled, and BACKLOG-2743's refusal never
 * fired for a ~61 GB copy onto ~59 GB of free disk — the guard failed OPEN.
 *
 * ─── WHY THESE TESTS ARE SHAPED THIS WAY ─────────────────────────────────────
 *
 * The race is a race, so a test that lets the two responses settle naturally
 * proves nothing — it would pass or fail on machine speed. Every test here holds
 * the IPC responses in KEYED DEFERRED PROMISES and resolves them in the order
 * that reproduces the defect: the all-time response FIRST, the stale 3-month
 * response LAST. Against the pre-fix component that reproduces the founder's
 * screen exactly; against the fixed component the 3-month request is never
 * issued at all, and a late response for a superseded window is ignored.
 *
 * The figures are the founder's measured ones, not invented: 707,956 messages /
 * 61.3 GB all-time, 12,074 / 2.6 GB at 3 months, 59.1 GB free.
 *
 * Rendered in StrictMode, matching the app and the rest of this suite — the
 * double-invoked effect is precisely what the sequence guard has to survive.
 */

import React from "react";
import { render, screen, waitFor, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { MacOSMessagesImportSettings } from "../MacOSMessagesImportSettings";

jest.mock("../../../contexts/PlatformContext", () => ({
  usePlatform: jest.fn(() => ({ isMacOS: true })),
}));

const mockRequestSync = jest.fn();
jest.mock("../../../hooks/useSyncOrchestrator", () => ({
  useSyncOrchestrator: jest.fn(() => ({ queue: [], requestSync: mockRequestSync })),
}));

const mockGetPreferences = jest.fn();
const mockUpdatePreferences = jest.fn();
jest.mock("../../../services", () => ({
  settingsService: {
    getPreferences: (...args: unknown[]) => mockGetPreferences(...args),
    updatePreferences: (...args: unknown[]) => mockUpdatePreferences(...args),
  },
}));

const USER_ID = "user-2760";

/** The founder's measured corpus. All time: 707,956 messages, 61.3 GB. */
const ALL_TIME_RESULT = {
  success: true,
  count: 707956,
  filteredCount: undefined,
  attachmentBytes: 61_300_000_000,
  attachmentCount: 113_402,
  availableDiskBytes: 59_100_000_000,
  fitsOnDisk: false,
};

/** The stale window the component used to estimate from: 3 months, 2.6 GB. */
const THREE_MONTH_RESULT = {
  success: true,
  count: 707956,
  filteredCount: 12074,
  attachmentBytes: 2_600_000_000,
  attachmentCount: 2_913,
  availableDiskBytes: 59_100_000_000,
  fitsOnDisk: true,
};

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const renderStrict = (ui: React.ReactElement) =>
  render(<React.StrictMode>{ui}</React.StrictMode>);

/** Filters the component sent on every `getImportCount` call, in order. */
/**
 * The SELECTION the panel asked each estimate for.
 *
 * BACKLOG-2772 moved this to the second argument — the first is now the userId,
 * because main resolves the plan (and with it the audit-widened window) rather
 * than trusting the renderer to describe the import. `auditPeriodStart` is gone
 * from this shape on purpose: the panel states what the USER chose and nothing
 * about what the deals require.
 */
const importCountCalls = (): Array<{
  lookbackMonths: number | null;
}> =>
  (window.api.messages.getImportCount as jest.Mock).mock.calls.map(
    ([, selection]) => selection
  );

const importButton = () => screen.getByRole("button", { name: /Import Messages/i });

beforeEach(() => {
  jest.clearAllMocks();
  mockRequestSync.mockReset();
  mockUpdatePreferences.mockResolvedValue({ success: true });

  // The founder's stored preference, verified in Supabase: explicit All time.
  mockGetPreferences.mockResolvedValue({
    success: true,
    data: {
      messageImport: {
        filters: { lookbackMonths: null, maxMessages: null, skipAttachments: false },
      },
    },
  });

  (window.api.messages.getImportStatus as jest.Mock).mockResolvedValue({
    success: true,
    messageCount: 0,
    lastImportAt: null,
  });

  // All time + no audit period reaching further back ⇒ unbounded window.
  (window.api.messages.getEffectiveImportWindow as jest.Mock).mockResolvedValue({
    success: true,
    effectiveCutoffISO: null,
    source: "lookback-pref",
    lookbackMonths: null,
  });
});

describe("BACKLOG-2760 — first paint estimates the STORED window, not useState(3)", () => {
  it("shows the all-time figures and refuses, even when a stale 3-month response resolves last", async () => {
    const allTime = deferred<typeof ALL_TIME_RESULT>();
    const threeMonth = deferred<typeof THREE_MONTH_RESULT>();

    (window.api.messages.getImportCount as jest.Mock).mockImplementation(
      (_userId: string, selection: { lookbackMonths: number | null }) =>
        selection?.lookbackMonths === null ? allTime.promise : threeMonth.promise
    );

    renderStrict(<MacOSMessagesImportSettings userId={USER_ID} />);

    // The estimate for the STORED window is requested.
    await waitFor(() =>
      expect(importCountCalls().some((f) => f?.lookbackMonths === null)).toBe(true)
    );

    // Resolve the correct (all-time) response FIRST …
    await act(async () => {
      allTime.resolve(ALL_TIME_RESULT);
    });

    // … then let the stale 3-month response land LAST. Pre-fix this is the write
    // that wins and puts 12,074 / 2.6 GB on screen; post-fix the request was
    // never issued, and a superseded response could not overwrite anyway.
    await act(async () => {
      threeMonth.resolve(THREE_MONTH_RESULT);
    });

    expect(screen.getByTestId("import-size-estimate")).toHaveTextContent(
      "This selection covers 707,956 messages and about 61.3 GB of attachments. You have 59.1 GB available."
    );
    expect(screen.queryByText(/12,074/)).not.toBeInTheDocument();
    expect(screen.queryByText(/2\.6 GB/)).not.toBeInTheDocument();

    // The whole point: the guard fires, and Import cannot be clicked.
    expect(screen.getByTestId("import-space-block")).toHaveTextContent(
      "This import needs up to 61.3 GB for attachments but only 59.1 GB is available. It will not start."
    );
    expect(importButton()).toBeDisabled();
  });

  it("never asks for a window the user did not choose", async () => {
    (window.api.messages.getImportCount as jest.Mock).mockResolvedValue(ALL_TIME_RESULT);

    renderStrict(<MacOSMessagesImportSettings userId={USER_ID} />);

    await waitFor(() => expect(screen.getByTestId("import-size-estimate")).toBeInTheDocument());

    // Every request describes the stored preference. A request carrying the
    // component's initial useState(3) is the defect itself, not a harmless extra:
    // its response is what overwrote the truth.
    expect(importCountCalls().length).toBeGreaterThan(0);
    for (const filters of importCountCalls()) {
      expect(filters.lookbackMonths).toBeNull();
    }
  });

  it("estimates the stored 3-month window when that is genuinely what is stored", async () => {
    // The mirror of the test above: the gate must not hard-code "All time". A
    // stored 3-month preference is still the stored preference.
    mockGetPreferences.mockResolvedValue({
      success: true,
      data: {
        messageImport: {
          filters: { lookbackMonths: 3, maxMessages: null, skipAttachments: false },
        },
      },
    });
    (window.api.messages.getEffectiveImportWindow as jest.Mock).mockResolvedValue({
      success: true,
      effectiveCutoffISO: "2026-05-16T00:00:00.000Z",
      source: "lookback-pref",
      lookbackMonths: 3,
    });
    (window.api.messages.getImportCount as jest.Mock).mockResolvedValue(THREE_MONTH_RESULT);

    renderStrict(<MacOSMessagesImportSettings userId={USER_ID} />);

    await waitFor(() =>
      expect(screen.getByTestId("import-size-estimate")).toHaveTextContent(
        "This selection covers 12,074 messages and about 2.6 GB of attachments. You have 59.1 GB available."
      )
    );
    expect(importButton()).toBeEnabled();
  });
});

describe("BACKLOG-2760 — a superseded estimate can never overwrite a newer one", () => {
  it("ignores the response for a window the user has already navigated away from", async () => {
    // The gate removes the mount-time stale request, but the race itself is a
    // property of the effect: any window change issues a request that cannot be
    // aborted, and the old one still resolves. Here the user starts on All time
    // (does not fit) and switches to 3 months (fits); the ALL-TIME response then
    // lands LAST. Without the sequence guard it overwrites the current window's
    // verdict and Settings shows 61.3 GB for a 3-month selection.
    const allTime = deferred<typeof ALL_TIME_RESULT>();

    (window.api.messages.getImportCount as jest.Mock).mockImplementation(
      (_userId: string, selection: { lookbackMonths: number | null }) =>
        selection?.lookbackMonths === null
          ? allTime.promise
          : Promise.resolve(THREE_MONTH_RESULT)
    );

    renderStrict(<MacOSMessagesImportSettings userId={USER_ID} />);

    // On All time, the estimate is in flight and Import is refused.
    await waitFor(() =>
      expect(screen.getByTestId("import-estimate-pending")).toBeInTheDocument()
    );

    const select = screen.getByDisplayValue("All time") as HTMLSelectElement;
    await act(async () => {
      select.value = "3";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });

    await waitFor(() =>
      expect(screen.getByTestId("import-size-estimate")).toHaveTextContent(
        "12,074 messages"
      )
    );

    // The abandoned all-time request finally resolves. It describes a window the
    // user is no longer on, so it must change nothing.
    await act(async () => {
      allTime.resolve(ALL_TIME_RESULT);
    });

    expect(screen.getByTestId("import-size-estimate")).toHaveTextContent(
      "This selection covers 12,074 messages and about 2.6 GB of attachments. You have 59.1 GB available."
    );
    expect(screen.queryByTestId("import-space-block")).not.toBeInTheDocument();
    expect(importButton()).toBeEnabled();
  });
});

describe("BACKLOG-2760 — the guard fails CLOSED while the estimate is unknown", () => {
  it("disables Import while the estimate is still in flight", async () => {
    // Never resolves: the state the user is in for the first seconds on a large
    // library. Pre-BACKLOG-2760 `sizeEstimate === null` meant "nothing to say"
    // and Import was clickable — an unknown size permitted the copy.
    (window.api.messages.getImportCount as jest.Mock).mockImplementation(
      () => new Promise(() => {})
    );

    renderStrict(<MacOSMessagesImportSettings userId={USER_ID} />);

    // Wait for the state itself, not merely for "disabled" — every unresolved
    // state disables, so asserting only that would pass without distinguishing
    // which one we are in.
    await waitFor(() =>
      expect(screen.getByTestId("import-estimate-pending")).toBeInTheDocument()
    );
    expect(importButton()).toBeDisabled();
    expect(screen.getByRole("button", { name: /Force Re-import/i })).toBeDisabled();
    expect(screen.queryByTestId("import-size-estimate")).not.toBeInTheDocument();
  });

  it("disables Import when the estimate fails", async () => {
    // `getAvailableMessageCount` returns `{ success: false }` on any internal
    // failure and logs NOTHING. The renderer used to have no `else`, so a failed
    // estimate silently left the previous verdict — or no verdict — standing.
    (window.api.messages.getImportCount as jest.Mock).mockResolvedValue({
      success: false,
      error: "chat.db unreadable",
    });

    renderStrict(<MacOSMessagesImportSettings userId={USER_ID} />);

    await waitFor(() =>
      expect(screen.getByTestId("import-estimate-unavailable")).toBeInTheDocument()
    );
    expect(importButton()).toBeDisabled();
  });

  it("disables Import when the estimate IPC rejects", async () => {
    (window.api.messages.getImportCount as jest.Mock).mockRejectedValue(
      new Error("IPC channel closed")
    );

    renderStrict(<MacOSMessagesImportSettings userId={USER_ID} />);

    await waitFor(() =>
      expect(screen.getByTestId("import-estimate-unavailable")).toBeInTheDocument()
    );
    expect(importButton()).toBeDisabled();
  });

  it("re-blocks while a NEW window is being estimated, instead of keeping the old verdict", async () => {
    // The second door onto the same fail-open: 3 months fits, user switches to
    // All time, and the stale "fits" verdict keeps Import enabled for as long as
    // the new estimate takes. On a 707k-message library that is many seconds —
    // ample time to click Import.
    mockGetPreferences.mockResolvedValue({
      success: true,
      data: {
        messageImport: {
          filters: { lookbackMonths: 3, maxMessages: null, skipAttachments: false },
        },
      },
    });
    (window.api.messages.getEffectiveImportWindow as jest.Mock).mockResolvedValue({
      success: true,
      effectiveCutoffISO: "2026-05-16T00:00:00.000Z",
      source: "lookback-pref",
      lookbackMonths: 3,
    });

    const pendingAllTime = deferred<typeof ALL_TIME_RESULT>();
    (window.api.messages.getImportCount as jest.Mock).mockImplementation(
      (_userId: string, selection: { lookbackMonths: number | null }) =>
        selection?.lookbackMonths === null
          ? pendingAllTime.promise
          : Promise.resolve(THREE_MONTH_RESULT)
    );

    renderStrict(<MacOSMessagesImportSettings userId={USER_ID} />);

    await waitFor(() => expect(importButton()).toBeEnabled());

    // Switch to All time. The new estimate is in flight and unknown.
    const select = screen.getByDisplayValue("Last 3 months") as HTMLSelectElement;
    await act(async () => {
      select.value = "all";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });

    await waitFor(() => expect(importButton()).toBeDisabled());
    // The superseded 3-month figure is no longer presented as this window's size.
    expect(screen.queryByTestId("import-size-estimate")).not.toBeInTheDocument();

    await act(async () => {
      pendingAllTime.resolve(ALL_TIME_RESULT);
    });

    expect(screen.getByTestId("import-space-block")).toBeInTheDocument();
    expect(importButton()).toBeDisabled();
  });

  it("still allows a text-only import when the estimate is unknown", async () => {
    // Decided, not incidental: the verdict concerns the ATTACHMENT copy. Message
    // text is a small fraction of it and always fits, so an unknown attachment
    // size must not strand a user with no way through — that is BACKLOG-2743's
    // escape hatch, and it has to survive the estimate failing.
    mockGetPreferences.mockResolvedValue({
      success: true,
      data: {
        messageImport: {
          filters: { lookbackMonths: null, maxMessages: null, skipAttachments: true },
        },
      },
    });
    (window.api.messages.getImportCount as jest.Mock).mockResolvedValue({
      success: false,
      error: "chat.db unreadable",
    });

    renderStrict(<MacOSMessagesImportSettings userId={USER_ID} />);

    await waitFor(() =>
      expect(screen.getByTestId("skip-attachments-toggle")).toBeChecked()
    );
    expect(importButton()).toBeEnabled();
  });
});

describe("BACKLOG-2760 — the audit period is asserted as a variable, both ways", () => {
  /**
   * The founder has a non-rejected transaction, which is what gives
   * `messages:get-effective-import-window` a real `auditStartISO` to work with —
   * the originally-filed suspect. Both states must produce an estimate for the
   * window the import will actually run.
   */
  it("with NO transaction: All time estimates unbounded", async () => {
    (window.api.messages.getEffectiveImportWindow as jest.Mock).mockResolvedValue({
      success: true,
      effectiveCutoffISO: null,
      source: "lookback-pref",
      lookbackMonths: null,
    });
    (window.api.messages.getImportCount as jest.Mock).mockResolvedValue(ALL_TIME_RESULT);

    renderStrict(<MacOSMessagesImportSettings userId={USER_ID} />);

    await waitFor(() => expect(screen.getByTestId("import-size-estimate")).toBeInTheDocument());

    // BACKLOG-2772: the panel states the SELECTION only. `auditPeriodStart` is
    // gone from this wire — main derives the deal spans itself — so the shape
    // asserted here is the whole payload, and its narrowness is the point.
    for (const selection of importCountCalls()) {
      expect(selection).toEqual({ lookbackMonths: null });
    }
    expect(importButton()).toBeDisabled();
  });

  it("with a transaction present: All time still estimates unbounded", async () => {
    // A 24-month-old audit period exists. `computeImportCutoffNano` short-circuits
    // an explicit All time to unbounded BEFORE consulting `auditPeriodStart`
    // (BACKLOG-2561), so an audit period cannot narrow this window — and the
    // estimate must not act as though it can.
    (window.api.messages.getEffectiveImportWindow as jest.Mock).mockResolvedValue({
      success: true,
      effectiveCutoffISO: null,
      source: "lookback-pref",
      lookbackMonths: null,
    });
    (window.api.messages.getImportCount as jest.Mock).mockResolvedValue(ALL_TIME_RESULT);

    renderStrict(<MacOSMessagesImportSettings userId={USER_ID} />);

    await waitFor(() =>
      expect(screen.getByTestId("import-size-estimate")).toHaveTextContent("707,956 messages")
    );
    expect(importButton()).toBeDisabled();
  });

  it("with an audit period that WIDENS a 3-month preference: the panel still sends only the preference", async () => {
    // The requirement is unchanged — the estimate must describe the WIDENED
    // window the import will run, because under-stating it is the same
    // fail-open in a different dress. BACKLOG-2772 changed who satisfies it.
    //
    // The widening now happens in main, inside the one resolver, from the same
    // deal query the export gate reads. So the panel sends the preference and
    // the widening is asserted where it is decided:
    // `electron/__tests__/importIncludeSet-2772.test.ts` drives the real
    // estimate handler with a deal present and asserts the resolved plan's
    // `fetchStartISO` reaches back to it.
    const auditCutoffISO = "2024-08-17T00:00:00.000Z";
    mockGetPreferences.mockResolvedValue({
      success: true,
      data: {
        messageImport: {
          filters: { lookbackMonths: 3, maxMessages: null, skipAttachments: false },
        },
      },
    });
    (window.api.messages.getEffectiveImportWindow as jest.Mock).mockResolvedValue({
      success: true,
      effectiveCutoffISO: auditCutoffISO,
      source: "audit-period",
      lookbackMonths: 3,
    });
    (window.api.messages.getImportCount as jest.Mock).mockResolvedValue(ALL_TIME_RESULT);

    renderStrict(<MacOSMessagesImportSettings userId={USER_ID} />);

    await waitFor(() => expect(screen.getByTestId("import-size-estimate")).toBeInTheDocument());

    expect(importCountCalls().length).toBeGreaterThan(0);
    for (const selection of importCountCalls()) {
      expect(selection).toEqual({ lookbackMonths: 3 });
    }
  });
});
