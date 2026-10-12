/**
 * BACKLOG-3892 S2 (SR D3a) — creating a deal opens the date/coverage prompt on an
 * iPhone gap, for a user whose import source is iPhone.
 *
 *  - the coverage check is asked with the user's own source ("iphone");
 *  - an iPhone-only gap opens the prompt, names the iPhone and Sync iPhone, and
 *    offers NO "Update now" (the Mac import cannot fill an iPhone gap — no loop);
 *  - the global oldest-text floor alone does not open it for an iPhone user: the
 *    iPhone coverage decides the texts half.
 */
import React from "react";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import AuditTransactionModal from "../AuditTransactionModal";
import { PlatformProvider } from "../../contexts/PlatformContext";

jest.mock("../../contexts/NetworkContext", () => ({
  useNetwork: () => ({
    isOnline: true,
    isChecking: false,
    lastOnlineAt: null,
    lastOfflineAt: null,
    connectionError: null,
    checkConnection: jest.fn(),
    clearError: jest.fn(),
    setConnectionError: jest.fn(),
  }),
}));
jest.mock("../../appCore", () => ({
  ...jest.requireActual("../../appCore"),
  useAppStateMachine: () => ({ isDatabaseInitialized: true }),
}));
jest.mock("../../hooks/useImportSource", () => ({ useImportSource: () => "iphone-sync" }));
const mockCheckCoverage = jest.fn();
jest.mock("../../hooks/useAuditCoverageCheck", () => ({
  useAuditCoverageCheck: () => ({
    checkCoverage: mockCheckCoverage,
    checkExportCompleteness: jest.fn().mockResolvedValue(null),
    runMessagesImport: jest.fn().mockResolvedValue({ ran: false, importRan: false, floorISO: null }),
    importing: false,
    progress: null,
    indeterminate: false,
  }),
}));

const START = "2025-12-01";
const base = {
  success: true,
  messagesFloorISO: null,
  emailFloorISO: null,
  needsMessagesImport: false,
  needsEmailBackfill: false,
  expansionStale: false,
  // A Mac with Full Disk Access: "Update now" WOULD be offered for a Mac gap.
  messagesImporterAvailable: true,
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(window.api.address.initialize).mockResolvedValue({ success: true });
  jest.mocked(window.api.contacts.getAll).mockResolvedValue({ success: true, contacts: [] } as never);
  jest.mocked(window.api.contacts.getSortedByActivity).mockResolvedValue({ success: true, contacts: [] } as never);
});

async function continueWithStart(): Promise<void> {
  render(
    <PlatformProvider>
      <AuditTransactionModal userId={"user-3892" as string} provider="google" onClose={jest.fn()} onSuccess={jest.fn()} />
    </PlatformProvider>,
  );
  await userEvent.type(screen.getByPlaceholderText(/enter property address/i), "123 Main Street");
  fireEvent.change(screen.getByTestId("create-audit-start-date-input"), { target: { value: START } });
  await userEvent.click(screen.getAllByRole("button", { name: /continue/i })[0]);
}

it("an iPhone-only gap opens the prompt with the Sync iPhone line and no Update now", async () => {
  mockCheckCoverage.mockResolvedValue({
    ...base,
    sourceGaps: [{ source: "iphone", coveredSince: "2026-08-25T00:00:00.000Z", approximate: false, kind: "later" }],
  });
  await continueWithStart();
  expect(await screen.findByTestId("audit-coverage-prompt")).toBeInTheDocument();
  expect(mockCheckCoverage).toHaveBeenCalledWith(START, "iphone");
  expect(screen.getByTestId("audit-coverage-gap-iphone")).toHaveTextContent(/Sync iPhone/);
  expect(screen.queryByTestId("audit-coverage-update-now")).toBeNull();
  expect(screen.getByTestId("audit-coverage-continue")).toBeInTheDocument();
  expect(screen.queryByTestId("contact-assignment-step-2")).toBeNull();
});

it("the global oldest-text floor alone does not open it for an iPhone user whose iPhone coverage reaches the start", async () => {
  mockCheckCoverage.mockResolvedValue({ ...base, needsMessagesImport: true, sourceGaps: [] });
  await continueWithStart();
  await waitFor(() => expect(screen.getByTestId("contact-assignment-step-2")).toBeInTheDocument());
  expect(screen.queryByTestId("audit-coverage-prompt")).toBeNull();
});

// BACKLOG-3892 W1: newer texts may be missing — an END gap alone opens the prompt (so the
// line is read) but is not a start gap: no "Update now", the title stays the reassurance.
it("an END gap alone opens the prompt with its line, as a non-gap (Got it)", async () => {
  mockCheckCoverage.mockResolvedValue({
    ...base,
    sourceGaps: [{
      source: "iphone",
      coveredSince: "2025-01-01T00:00:00.000Z",
      approximate: false,
      kind: "newer",
      lastSyncAt: "2026-09-01T12:00:00.000Z",
      requiredEndISO: "2026-10-12T12:00:00.000Z",
    }],
  });
  await continueWithStart();
  expect(await screen.findByTestId("audit-coverage-gap-iphone-newer")).toHaveTextContent("Newer texts may be missing: your iPhone was last synced");
  expect(screen.queryByTestId("audit-coverage-update-now")).toBeNull();
  expect(screen.getByTestId("audit-coverage-continue")).toHaveTextContent("Got it");
});
