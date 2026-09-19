/**
 * BACKLOG-3128 — the macOS Messages import progress must say what is true.
 *
 * The founder, testing PR #2522: "it seems to always get straight to 33% then
 * 67% nothing in between and it says importing messages nothing else."
 *
 * Two defects, both pre-existing, both asserted here.
 *
 *   1. THE LABEL. Three ternary chains picked the label, colour and unit, each
 *      with an `else` arm that swallowed every phase it did not name. The
 *      `querying` phase — the whole chat.db read, and the slowest part of a
 *      large import — fell into that `else` and was announced as "Importing
 *      messages...". No test asserted the querying label at all, which is why
 *      it shipped: `cancel-2748.test.tsx` had a `phase: "querying"` fixture but
 *      asserted only the cancel button.
 *
 *   2. THE NUMBERS. The panel hard-coded `current: 0, total: 0` and rendered
 *      them, so every import displayed a literal "0 / 0 messages" — and the
 *      percent beside it was a composite that gave each phase an equal third of
 *      the bar regardless of how long it took. Both were values presented as
 *      known that were never known (BACKLOG-2886).
 *
 * The rule these tests hold: a value that is not known must never render as
 * known. Counts render only when the producer actually sent them; there is no
 * percentage anywhere, because this import has no honest one.
 *
 * Rendered in StrictMode, matching the app and the sibling cancel-2748 suite
 * whose fake-orchestrator harness this mirrors.
 */

import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { MacOSMessagesImportSettings } from "../MacOSMessagesImportSettings";
import type { SyncItem } from "../../../services/SyncOrchestratorService";
import { IMPORT_PHASE_DISPLAY } from "../../../utils/importPhaseDisplay";
// BACKLOG-3132: the phase list is DERIVED from the published tuple, not
// hand-written. A hand-written list meant a new phase got no render coverage
// at all — the compiler forced copy into the map, and nothing forced the copy
// to be rendered. Deriving it means a fifth phase is exercised here for free.
import { IMPORT_PHASES } from "@electron/types/ipc/importPhase";

jest.mock("../../../contexts/PlatformContext", () => ({
  usePlatform: jest.fn(() => ({ isMacOS: true })),
}));

let mockQueue: SyncItem[] = [];

jest.mock("../../../hooks/useSyncOrchestrator", () => ({
  useSyncOrchestrator: jest.fn(() => ({
    queue: mockQueue,
    requestSync: jest.fn(),
    markCancelRequested: jest.fn(() => "none" as const),
    getQueueItem: jest.fn((type: string) =>
      mockQueue.find((queued) => queued.type === type)
    ),
  })),
}));

const mockGetPreferences = jest.fn();
const mockUpdatePreferences = jest.fn();
jest.mock("../../../services", () => ({
  /**
   * BACKLOG-3208: the panel now asks whether Full Disk Access is usable before
   * it offers an import, through the same service abstraction it already uses
   * for preferences. Granted is this suite's premise — every case here is about
   * what the import does once Keepr CAN read Messages. The denied path has its
   * own suite (`MacOSMessagesImportSettings.fdaRecovery-3208.test.tsx`).
   */
  systemService: {
    checkMessagesPermission: jest
      .fn()
      .mockResolvedValue({ success: true, data: { hasPermission: true } }),
    openFullDiskAccessSettings: jest.fn().mockResolvedValue({ success: true }),
    relaunchApp: jest
      .fn()
      .mockResolvedValue({ success: true, data: { relaunched: true } }),
  },
  settingsService: {
    getPreferences: (...args: unknown[]) => mockGetPreferences(...args),
    updatePreferences: (...args: unknown[]) => mockUpdatePreferences(...args),
  },
}));

const USER_ID = "user-3128";

const renderStrict = (ui: React.ReactElement) =>
  render(<React.StrictMode>{ui}</React.StrictMode>);

/** A queue holding one macOS-messages item in the given state. */
function messagesQueue(item: Partial<SyncItem>): SyncItem[] {
  return [
    { type: "messages", status: "running", progress: 0, ...item } as SyncItem,
  ];
}

beforeEach(() => {
  jest.clearAllMocks();
  mockQueue = [];
  mockUpdatePreferences.mockResolvedValue({ success: true });
  mockGetPreferences.mockResolvedValue({
    success: true,
    data: { messageImport: { filters: { lookbackMonths: 3, maxMessages: 50000 } } },
  });
});

describe("BACKLOG-3128 — every phase is named honestly", () => {
  /**
   * CONTROL (b). Mutating the `querying` arm of IMPORT_PHASE_DISPLAY back to the
   * importing copy turns this red — which is the defect exactly as it shipped.
   */
  it("names the querying phase for what it is, never 'Importing messages'", async () => {
    mockQueue = messagesQueue({ phase: "querying", indeterminate: true });

    renderStrict(<MacOSMessagesImportSettings userId={USER_ID} />);

    await waitFor(() =>
      expect(
        screen.getByText("Reading messages from Messages.app...")
      ).toBeInTheDocument()
    );
    // The whole defect in one line: the chat.db read used to announce itself as
    // importing, because it fell through a ternary's `else`.
    expect(screen.queryByText("Importing messages...")).not.toBeInTheDocument();
  });

  it.each(IMPORT_PHASES.map((p) => [p, IMPORT_PHASE_DISPLAY[p].label] as const))(
    "labels the %s phase from the shared map",
    async (phase, label) => {
      mockQueue = messagesQueue({ phase, indeterminate: true });

      renderStrict(<MacOSMessagesImportSettings userId={USER_ID} />);

      await waitFor(() => expect(screen.getByText(label)).toBeInTheDocument());
    }
  );

  it("renders the literal finalizing copy — the derived list cannot pin this", async () => {
    // BACKLOG-3132. The `it.each` above derives its expected label FROM the
    // display map, which makes it tautological about COPY: change the map and
    // the expectation changes with it. Measured — pointing `finalizing` at the
    // importing copy left that suite 26/26 green.
    //
    // So the derived list is worth exactly what it is worth (a new phase is
    // exercised at all, and renders something rather than crashing or leaking
    // its identifier) and no more. The literal string a user reads is pinned
    // here, by hand, because nothing else can pin it.
    mockQueue = messagesQueue({ phase: "finalizing", indeterminate: true });

    renderStrict(<MacOSMessagesImportSettings userId={USER_ID} />);

    await waitFor(() =>
      expect(screen.getByText("Saving imported messages...")).toBeInTheDocument()
    );
    // The label this phase used to wear, and the reason this item exists.
    expect(screen.queryByText("Importing messages...")).not.toBeInTheDocument();
    // No count: the save step has nothing to count and no knowable duration.
    expect(screen.getByTestId("import-progress-indeterminate")).toBeInTheDocument();
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
  });

  it("gives every phase its OWN copy — no two phases read alike", async () => {
    // Derived, so it scales to a sixth phase, and it catches the mutation the
    // derived `it.each` cannot: pointing one phase at another's copy. Two phases
    // sharing a label is the exact defect BACKLOG-3128 fixed (querying fell
    // through a ternary and wore the importing label), so it must not return.
    const labels = IMPORT_PHASES.map((p) => IMPORT_PHASE_DISPLAY[p].label);
    expect(new Set(labels).size).toBe(labels.length);
    const pills = IMPORT_PHASES.map((p) => IMPORT_PHASE_DISPLAY[p].pill);
    expect(new Set(pills).size).toBe(pills.length);
  });

  it("renders an unknown phase as itself rather than borrowing another label", async () => {
    // The queue item types `phase` as a bare string (it carries iPhone and
    // export phases too). An unrecognised value must not be asserted into
    // ImportPhase and given some other phase's copy — that is the class of bug
    // this item fixes, so the fallback is honest text and no count.
    mockQueue = messagesQueue({ phase: "verifying", indeterminate: true });

    renderStrict(<MacOSMessagesImportSettings userId={USER_ID} />);

    await waitFor(() => expect(screen.getByText("verifying")).toBeInTheDocument());
    expect(screen.queryByText("Importing messages...")).not.toBeInTheDocument();
  });
});

describe("BACKLOG-3128 — real counts, or none", () => {
  /**
   * CONTROL (c). Dropping `current`/`total` from the orchestrator's plumbing
   * (SyncOrchestratorService's updateQueueItem call) turns this red.
   */
  it("renders the producer's real counts for a phase that has them", async () => {
    mockQueue = messagesQueue({
      phase: "querying",
      current: 4120,
      total: 33637,
    });

    renderStrict(<MacOSMessagesImportSettings userId={USER_ID} />);

    await waitFor(() =>
      expect(screen.getByText(/4,120 of 33,637\s+messages read/)).toBeInTheDocument()
    );
    expect(screen.getByTestId("import-progress-bar")).toBeInTheDocument();
  });

  it("uses each phase's own unit, so attachments are not counted as messages", async () => {
    mockQueue = messagesQueue({ phase: "attachments", current: 12, total: 573 });

    renderStrict(<MacOSMessagesImportSettings userId={USER_ID} />);

    // Matched on the whole count line, not a bare /attachments/ — the panel has
    // other attachment copy, and a loose regex would pass without proving the
    // per-phase unit was used.
    await waitFor(() =>
      expect(screen.getByText(/12 of 573\s+attachments/)).toBeInTheDocument()
    );
  });

  it("shows an indeterminate bar — and NO count — when the phase reports none", async () => {
    mockQueue = messagesQueue({ phase: "querying", indeterminate: true });

    renderStrict(<MacOSMessagesImportSettings userId={USER_ID} />);

    await waitFor(() =>
      expect(screen.getByTestId("import-progress-indeterminate")).toBeInTheDocument()
    );
    expect(screen.queryByTestId("import-progress-bar")).not.toBeInTheDocument();
    expect(screen.queryByText(/ of /)).not.toBeInTheDocument();
  });

  it("never renders '0 of 0' — the value the panel used to hard-code", async () => {
    // Before this item the panel set `current: 0, total: 0` unconditionally and
    // rendered them, so every single import displayed "0 / 0 messages".
    mockQueue = messagesQueue({ phase: "querying", current: 0, total: 0 });

    renderStrict(<MacOSMessagesImportSettings userId={USER_ID} />);

    await waitFor(() =>
      expect(screen.getByTestId("import-progress-indeterminate")).toBeInTheDocument()
    );
    expect(screen.queryByText(/0 of 0/)).not.toBeInTheDocument();
    expect(screen.queryByText(/0 \/ 0/)).not.toBeInTheDocument();
  });
});

describe("BACKLOG-3128 — no percentage anywhere on this import", () => {
  /** CONTROL (d). Re-introducing any `%` render turns these red. */
  it.each(IMPORT_PHASES)(
    "renders no %% string during the %s phase",
    async (phase) => {
      mockQueue = messagesQueue({ phase, current: 500, total: 1000, progress: 50 });

      renderStrict(<MacOSMessagesImportSettings userId={USER_ID} />);

      await waitFor(() =>
        expect(
          screen.getByText(IMPORT_PHASE_DISPLAY[phase as keyof typeof IMPORT_PHASE_DISPLAY].label)
        ).toBeInTheDocument()
      );
      // `progress: 50` is deliberately non-zero: if any surface still read the
      // queue item's number, "50%" would appear here.
      expect(screen.queryByText(/%/)).not.toBeInTheDocument();
      expect(screen.queryByText("50%")).not.toBeInTheDocument();
    }
  );
});
