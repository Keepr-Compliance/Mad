/**
 * BACKLOG-3477 — the unticked-required-items warning shows BEFORE the Submit
 * for Review window opens, in the emails-needing-review gate's position.
 * Warn, never block: "Continue anyway" opens the window; "Go back" opens
 * nothing. Only when the plan allows checklists (for any other gate value the
 * Checklist tab is read-only).
 *
 * Which items the warning lists is owned by src/services/__tests__/
 * checklistWarningGate.test.ts; this file owns the flow.
 *
 * `useTransactionChecklist` reads `window.api.checklists.get` at mount, so
 * "the warning did not read" is asserted as NO NEW CALL after the click, never
 * as `not.toHaveBeenCalled()`.
 *
 * FIXTURE PROVENANCE: see checklistWarningGate.test.ts —
 * `checklistFixtures-3476.json` is the real `getChecklistsForTransaction`
 * output; REAL has 3 required-unticked items across two checklists.
 *
 * The gate values are the `StrictFeatureStateOrPending` union
 * (electron/types/featureGate.ts). Harness copied from
 * TransactionDetails.submitDatesReread-3498.test.tsx.
 */
import React from "react";
import { render, screen, waitFor, fireEvent, act, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { NotificationProvider } from "../../contexts/NotificationContext";
import type { StrictFeatureStateOrPending } from "../../../electron/types/featureGate";
import type { ChecklistsForTransaction } from "../../../electron/types/checklist";
import fixtures from "../transactionDetailsModule/components/checklist/__tests__/fixtures/checklistFixtures-3476.json";

const mockGate: { value: StrictFeatureStateOrPending } = { value: "allowed" };
const mockLicense = { canSubmit: true, organizationId: "org-3477" as string | null };

jest.mock("../../contexts/StrictFeatureContext", () => ({
  useSessionStrictFeatureState: () => mockGate.value,
}));

jest.mock("../../contexts/LicenseContext", () => ({
  useLicense: () => ({
    licenseType: "team",
    hasAIAddon: false,
    organizationId: mockLicense.organizationId,
    canExport: !mockLicense.canSubmit,
    canSubmit: mockLicense.canSubmit,
    canAutoDetect: false,
    isLoading: false,
    isLicenseResolved: true,
    refresh: jest.fn(),
  }),
}));

jest.mock("../ExportModal", () => ({
  __esModule: true,
  default: () => <div data-testid="export-modal" />,
}));

jest.mock("../transactionDetailsModule", () => {
  const actual = jest.requireActual<typeof import("../transactionDetailsModule")>(
    "../transactionDetailsModule",
  );
  return {
    ...actual,
    TransactionHeader: (props: { onComplete?: () => void }) => (
      <button data-testid="hdr-complete" onClick={() => props.onComplete?.()} />
    ),
    TransactionEmailsTab: () => null,
    TransactionMessagesTab: () => null,
    TransactionAttachmentsTab: () => null,
    TransactionDetailsTab: () => null,
    TransactionTabs: () => null,
    ReviewNotesPanel: () => null,
    DeleteConfirmModal: () => null,
    UnlinkEmailModal: () => null,
    EmailViewModal: () => null,
    RejectReasonModal: () => null,
    EditContactsModal: () => null,
  };
});

jest.mock("../transactionDetailsModule/components/modals/SubmitForReviewModal", () => ({
  SubmitForReviewModal: (props: {
    checklistsNotSent?: string | null;
    onSubmit: () => void;
  }) => (
    <div data-testid="submit-modal">
      {/* BACKLOG-3600 */}
      <span data-testid="checklists-not-sent">{String(props.checklistsNotSent)}</span>
      <button data-testid="modal-submit" onClick={() => props.onSubmit()} />
    </div>
  ),
}));

jest.mock("../transactionDetailsModule/components/ReviewNotesPanel", () => ({
  ReviewNotesPanel: () => null,
}));
jest.mock("../../contexts/AuthContext", () => ({
  useAuth: () => ({ currentUser: { id: "user-3477", email: "t@t.com" } }),
  useIsAuthenticated: () => true,
  useCurrentUser: () => ({ id: "user-3477", email: "t@t.com" }),
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
jest.mock("../../contexts/NetworkContext", () => ({
  useNetwork: () => ({ isOnline: true }),
}));
jest.mock("../../hooks/useSyncOrchestrator", () => ({
  useSyncOrchestrator: () => ({ isRunning: false }),
}));
jest.mock("../common/ResponsiveModal", () => ({
  ResponsiveModal: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  MODAL_PANEL: { lg: "" },
}));
jest.mock("../common/OfflineNotice", () => ({ OfflineNotice: () => null }));

import TransactionDetails from "../TransactionDetails";

const REAL: ChecklistsForTransaction = fixtures.checklists as unknown as ChecklistsForTransaction;
const only = (name: string): ChecklistsForTransaction => {
  const checklists = REAL.checklists.filter((c) => c.checklist.templateName === name);
  return {
    checklists,
    requiredDone: checklists.reduce((s, c) => s + c.requiredDone, 0),
    requiredTotal: checklists.reduce((s, c) => s + c.requiredTotal, 0),
  };
};
const ALL_TICKED = only("Done probe template");
const EMPTY: ChecklistsForTransaction = { checklists: [], requiredDone: 0, requiredTotal: 0 };

const row = {
  id: "txn-3477",
  user_id: "user-3477",
  property_address: "18 Bellweather Lane",
  transaction_type: "purchase" as const,
  status: "active" as const,
  submission_status: "not_submitted",
  message_count: 0,
  attachment_count: 0,
  export_status: "not_exported" as const,
  export_count: 0,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  started_at: "2026-01-05",
  closed_at: "2026-03-14",
};

const getMock = () => window.api.checklists.get as jest.Mock;

function useRow(r: typeof row): void {
  window.api.transactions.getDetails = jest.fn().mockResolvedValue({
    success: true,
    transaction: { ...r, communications: [], contact_assignments: [] },
  });
}

beforeEach(() => {
  mockGate.value = "allowed";
  mockLicense.canSubmit = true;
  mockLicense.organizationId = "org-3477";
  useRow(row);
  /* eslint-disable @typescript-eslint/no-explicit-any */
  (window.api.transactions as any).getOverview = jest.fn().mockResolvedValue({
    success: true,
    transaction: { ...row, contact_assignments: [] },
  });
  (window.api.transactions as any).getCommunications = jest.fn().mockResolvedValue({
    success: true,
    transaction: { communications: [], contact_assignments: [] },
  });
  (window.api.transactions as any).isAutoSyncInFlight = jest.fn().mockResolvedValue({ inFlight: false });
  (window.api.transactions as any).getReviewState = jest.fn().mockResolvedValue({
    count: 0,
    items: [],
    threadCount: 0,
  });
  (window.api.transactions as any).syncReviewQueue = jest.fn().mockResolvedValue({
    success: true, added: 0, linked: 0, found: 0,
  });
  /* eslint-enable @typescript-eslint/no-explicit-any */
  window.api.contacts.getAll = jest.fn().mockResolvedValue({ success: true, contacts: [] });
  // Zero unchecked by default, so a test that is not about the warning (the
  // BACKLOG-3600 one below) still reaches the modal.
  getMock().mockReset();
  getMock().mockResolvedValue({ success: true, checklists: EMPTY });
});

/** Render, and let the Checklist tab hook's own mount read land. */
async function mount(r: typeof row = row) {
  const utils = render(<TransactionDetails transaction={r as never} onClose={jest.fn()} />, {
    wrapper: NotificationProvider,
  });
  await waitFor(() => expect(screen.getByTestId("hdr-complete")).toBeInTheDocument());
  await waitFor(() => expect(getMock()).toHaveBeenCalled());
  await act(async () => {
    await Promise.resolve();
  });
  return utils;
}

async function clickComplete(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByTestId("hdr-complete"));
  });
}

/** Queue every later `checklists.get` as a promise the test resolves. */
function deferReads(): Array<(v: unknown) => void> {
  const resolvers: Array<(v: unknown) => void> = [];
  getMock().mockImplementation(
    () => new Promise((r) => { resolvers.push(r); }),
  );
  return resolvers;
}

const warning = () => screen.queryByTestId("checklist-warning");
const modal = () => screen.queryByTestId("submit-modal");

async function press(testId: string): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByTestId(testId));
  });
}

describe("BACKLOG-3477 — the warning shows before the Submit for Review window", () => {
  it("unticked required items → the warning, listing them, and no window", async () => {
    await mount();
    const before = getMock().mock.calls.length;
    getMock().mockResolvedValue({ success: true, checklists: REAL });
    await clickComplete();
    await waitFor(() => expect(warning()).toBeInTheDocument());
    expect(getMock().mock.calls.length).toBe(before + 1);
    expect(getMock()).toHaveBeenLastCalledWith({ transactionId: "txn-3477" });
    expect(modal()).toBeNull();
    const dialog = warning() as HTMLElement;
    expect(within(dialog).getByRole("heading")).toHaveTextContent("3 required items are not checked");
    expect(dialog).toHaveTextContent(
      "You can still submit. The checklist goes with the transaction as it stands.",
    );
    const rows = within(screen.getByTestId("checklist-warning-list")).getAllByRole("listitem");
    expect(
      rows.map((r) => [
        within(r).getByTestId("checklist-warning-item-title").textContent,
        within(r).queryByTestId("checklist-warning-item-checklist")?.textContent ?? null,
      ]),
    ).toEqual([
      ["Probe item 2", "Probe template"],
      ["Other item 2", "Other probe template"],
      ["Other item 3", "Other probe template"],
    ]);
  });

  it("says 'item is' for exactly one, and a single checklist's rows are the title alone", async () => {
    await mount();
    getMock().mockResolvedValue({ success: true, checklists: only("Probe template") });
    await clickComplete();
    await waitFor(() => expect(warning()).toBeInTheDocument());
    const dialog = warning() as HTMLElement;
    expect(within(dialog).getByRole("heading")).toHaveTextContent("1 required item is not checked");
    expect(within(dialog).queryByTestId("checklist-warning-item-checklist")).toBeNull();
  });

  it("the button reads exactly 'Continue anyway' — never 'Submit anyway'", async () => {
    await mount();
    getMock().mockResolvedValue({ success: true, checklists: REAL });
    await clickComplete();
    await waitFor(() => expect(warning()).toBeInTheDocument());
    expect(screen.getByTestId("checklist-warning-continue").textContent).toBe("Continue anyway");
    expect(screen.queryByText(/Submit anyway/)).toBeNull();
    expect(screen.getByTestId("checklist-warning-go-back").textContent).toBe("Go back");
  });
});

describe("BACKLOG-3477 SR cond. 3 — before the window, asserted as absence", () => {
  it("no window while the read is pending, none while the warning shows; Continue anyway opens it", async () => {
    await mount();
    const resolvers = deferReads();
    await clickComplete();
    await waitFor(() => expect(resolvers).toHaveLength(1));
    expect(modal()).toBeNull();
    expect(warning()).toBeNull();

    await act(async () => {
      resolvers[0]({ success: true, checklists: REAL });
    });
    expect(warning()).toBeInTheDocument();
    expect(modal()).toBeNull();

    await press("checklist-warning-continue");
    expect(modal()).toBeInTheDocument();
    expect(warning()).toBeNull();
  });
});

describe("BACKLOG-3477 E-C2 — warn and allow", () => {
  it("Continue anyway opens the window without reading the checklist again", async () => {
    await mount();
    getMock().mockResolvedValue({ success: true, checklists: REAL });
    await clickComplete();
    await waitFor(() => expect(warning()).toBeInTheDocument());
    const afterWarn = getMock().mock.calls.length;
    await press("checklist-warning-continue");
    expect(modal()).toBeInTheDocument();
    expect(getMock().mock.calls.length).toBe(afterWarn);
  });

  it("Go back closes the warning and opens nothing", async () => {
    await mount();
    getMock().mockResolvedValue({ success: true, checklists: REAL });
    await clickComplete();
    await waitFor(() => expect(warning()).toBeInTheDocument());
    await press("checklist-warning-go-back");
    expect(warning()).toBeNull();
    expect(modal()).toBeNull();
  });
});

describe("BACKLOG-3477 E-C3 — the warning appears on resubmit too", () => {
  it("a needs_changes deal gets the same warning before the window opens", async () => {
    const resubmit = { ...row, submission_status: "needs_changes" };
    useRow(resubmit);
    await mount(resubmit);
    getMock().mockResolvedValue({ success: true, checklists: REAL });
    await clickComplete();
    await waitFor(() => expect(warning()).toBeInTheDocument());
    expect(modal()).toBeNull();
    await press("checklist-warning-continue");
    expect(modal()).toBeInTheDocument();
  });
});

describe("BACKLOG-3477 E-C4 / E-C5 — no warning when there is nothing to warn about", () => {
  it.each<[string, () => void]>([
    ["every required item ticked", () => getMock().mockResolvedValue({ success: true, checklists: ALL_TICKED })],
    ["no checklists on the transaction", () => getMock().mockResolvedValue({ success: true, checklists: EMPTY })],
    ["the read is refused", () => getMock().mockResolvedValue({ success: false, error: "boom" })],
    ["the IPC throws", () => getMock().mockRejectedValue(new Error("ipc down"))],
  ])("%s → read once, no warning, the window opens", async (_label, arrange) => {
    await mount();
    const before = getMock().mock.calls.length;
    arrange();
    await clickComplete();
    await waitFor(() => expect(modal()).toBeInTheDocument());
    expect(getMock().mock.calls.length).toBe(before + 1);
    expect(warning()).toBeNull();
  });
});

describe("BACKLOG-3477 E-C4 — only when the plan allows checklists", () => {
  it.each<StrictFeatureStateOrPending>(["blocked", "unknown", "pending"])(
    "gate %s → no read, no warning, the window opens",
    async (gate) => {
      mockGate.value = gate;
      await mount();
      const before = getMock().mock.calls.length;
      getMock().mockResolvedValue({ success: true, checklists: REAL });
      await clickComplete();
      await waitFor(() => expect(modal()).toBeInTheDocument());
      expect(getMock().mock.calls.length).toBe(before);
      expect(warning()).toBeNull();
    },
  );
});

describe("BACKLOG-3477 SR cond. 2 — the gate is read at click time, not at mount", () => {
  it("mounted while the gate is pending, allowed by the click → the warning", async () => {
    mockGate.value = "pending";
    const { rerender } = await mount();
    mockGate.value = "allowed";
    rerender(<TransactionDetails transaction={row as never} onClose={jest.fn()} />);
    await act(async () => {
      await Promise.resolve();
    });
    const before = getMock().mock.calls.length;
    getMock().mockResolvedValue({ success: true, checklists: REAL });
    await clickComplete();
    await waitFor(() => expect(warning()).toBeInTheDocument());
    expect(getMock().mock.calls.length).toBeGreaterThan(before);
    expect(modal()).toBeNull();
  });
});

describe("BACKLOG-3477 SR cond. 8 — a fresh read, not the Checklist tab's copy", () => {
  it("the tab loaded all-ticked; items unticked since → the click still warns", async () => {
    getMock().mockResolvedValue({ success: true, checklists: ALL_TICKED });
    await mount();
    getMock().mockResolvedValue({ success: true, checklists: REAL });
    await clickComplete();
    await waitFor(() => expect(warning()).toBeInTheDocument());
    expect(modal()).toBeNull();
  });
});

describe("BACKLOG-3477 SR cond. 7 — the emails gate first; the export path never reads", () => {
  it("emails need review AND items unticked → only the emails gate; the checklist is not read", async () => {
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
    (window.api.transactions as any).getReviewState = jest.fn().mockResolvedValue({
      count: 2,
      items: [],
      threadCount: 0,
    });
    await mount();
    const before = getMock().mock.calls.length;
    getMock().mockResolvedValue({ success: true, checklists: REAL });
    await clickComplete();
    await waitFor(() => expect(screen.getByTestId("review-prompt-blocked")).toBeInTheDocument());
    expect(getMock().mock.calls.length).toBe(before);
    expect(warning()).toBeNull();
    expect(modal()).toBeNull();
  });

  it("a user whose Complete exports → the checklist is not read, no warning", async () => {
    mockLicense.canSubmit = false;
    mockLicense.organizationId = null;
    await mount();
    const before = getMock().mock.calls.length;
    getMock().mockResolvedValue({ success: true, checklists: REAL });
    await clickComplete();
    await waitFor(() => expect(screen.getByTestId("export-modal")).toBeInTheDocument());
    expect(getMock().mock.calls.length).toBe(before);
    expect(warning()).toBeNull();
    expect(modal()).toBeNull();
  });
});

describe("BACKLOG-3477 SR cond. 5 — a late read never re-raises the warning", () => {
  it("double-click: the earlier read is dropped; after Continue anyway, nothing comes back", async () => {
    await mount();
    const resolvers = deferReads();
    await clickComplete();
    await clickComplete();
    await waitFor(() => expect(resolvers).toHaveLength(2));

    await act(async () => {
      resolvers[1]({ success: true, checklists: REAL });
    });
    expect(warning()).toBeInTheDocument();
    await press("checklist-warning-continue");
    expect(modal()).toBeInTheDocument();

    await act(async () => {
      resolvers[0]({ success: true, checklists: REAL });
    });
    expect(warning()).toBeNull();
    expect(modal()).toBeInTheDocument();
  });

  it("double-click, the earlier read lands first: it shows nothing; the later one warns once", async () => {
    await mount();
    const resolvers = deferReads();
    await clickComplete();
    await clickComplete();
    await waitFor(() => expect(resolvers).toHaveLength(2));

    await act(async () => {
      resolvers[0]({ success: true, checklists: REAL });
    });
    expect(warning()).toBeNull();
    expect(modal()).toBeNull();

    await act(async () => {
      resolvers[1]({ success: true, checklists: REAL });
    });
    expect(screen.getAllByTestId("checklist-warning")).toHaveLength(1);
  });

  it("after Go back, a late read opens neither the warning nor the window", async () => {
    await mount();
    const resolvers = deferReads();
    await clickComplete();
    await clickComplete();
    await waitFor(() => expect(resolvers).toHaveLength(2));
    await act(async () => {
      resolvers[1]({ success: true, checklists: REAL });
    });
    await press("checklist-warning-go-back");

    await act(async () => {
      resolvers[0]({ success: true, checklists: EMPTY });
    });
    expect(warning()).toBeNull();
    expect(modal()).toBeNull();
  });
});

/**
 * BACKLOG-3600 (D5, the last link): the REAL useSubmitForReview holds the IPC
 * result's `checklistsNotSent`, and TransactionDetails hands it to the modal.
 */
it("BACKLOG-3600: a submit result's checklistsNotSent reaches the modal", async () => {
  mockGate.value = "allowed";
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  (window.api.transactions as any).submit = jest.fn().mockResolvedValue({
    success: true,
    submissionId: "sub-3600-0001",
    checklistsNotSent: "not_in_plan",
  });
  await mount();
  await clickComplete();
  await waitFor(() => expect(modal()).toBeInTheDocument());
  expect(screen.getByTestId("checklists-not-sent").textContent).toBe("null");
  await act(async () => {
    fireEvent.click(screen.getByTestId("modal-submit"));
  });
  await waitFor(() =>
    expect(screen.getByTestId("checklists-not-sent").textContent).toBe("not_in_plan"),
  );
});
