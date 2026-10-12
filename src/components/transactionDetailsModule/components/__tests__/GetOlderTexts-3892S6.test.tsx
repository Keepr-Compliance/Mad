/**
 * BACKLOG-3892 S6 — "Get older texts" on the Texts tab's iPhone start warning.
 *
 * Fixtures transcribe S5's shapes (electron/types/iphoneBackfill.ts) and its approved
 * sentences (electron/services/atRest/backupProblem.ts): `message` is set by the main
 * process for missing / damaged / key-missing only; a reason "error" can carry raw error
 * text (iphoneBackfillService.ts persisted.error), which must never be shown.
 *
 * Controls:
 *   C1 the button shows only when availability is `available` (locked / no-gap / busy hide it)
 *   C2 Cancel calls cancelBackfill
 *   C3 success re-reads coverage WITH the chosen source and reloads the texts
 *   C4 a refusal shows the right approved sentence; reason "error" never shows its message
 */
import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { SourceCoverageGap } from "../../../../../electron/types/auditCoverage";
import type { BackfillAvailability, BackfillProgress, BackfillResult } from "../../../../../electron/types/iphoneBackfill";

jest.mock("../../../../services/rcsImportService", () => ({
  rcsImportService: {
    onDataChanged: () => () => undefined,
    onDataCleared: () => () => undefined,
  },
}));
jest.mock("../../../../utils/platform", () => ({
  ...jest.requireActual("../../../../utils/platform"),
  isMacOS: () => true,
}));
jest.mock("../../../../services/settingsService", () => ({
  settingsService: {
    getPreferences: async () => ({ success: true, data: { messages: { source: "iphone-sync" } } }),
    getPhoneType: async () => ({ success: true, data: "iphone" }),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { TextCoverageNotice } = require("../TextCoverageNotice") as typeof import("../TextCoverageNotice");

// Transcribed from backupProblem.ts (founder-approved, main process).
const DAMAGED = "Your saved iPhone backup is damaged.";
const KEY_MISSING = "Keepr cannot decrypt your saved iPhone backup on this computer.";
const MISSING = "Your saved iPhone backup is no longer on this computer.";
const FAILED_DRAFT = "Keepr couldn't get older texts. Try again later.";

const TX = "tx-3892-s6";
const getTextCoverage = jest.fn();
const backfillAvailability = jest.fn<Promise<BackfillAvailability>, [string]>();
const backfillOlder = jest.fn<Promise<BackfillResult>, [string]>();
const cancelBackfill = jest.fn(async () => ({ success: true }));
let progressCb: ((p: BackfillProgress) => void) | null = null;

const iphoneGap: SourceCoverageGap = {
  source: "iphone",
  coveredSince: "2026-06-01T00:00:00.000Z",
  approximate: false,
  kind: "later",
};
const gapResult = { success: true, auditStartISO: "2026-03-01T00:00:00.000Z", gaps: [iphoneGap] };
const available: BackfillAvailability = {
  available: true,
  udid: "00008110-TEST",
  floorMs: Date.parse("2026-02-28T00:00:00.000Z"),
  ceilingMs: Date.parse("2026-06-01T00:00:00.000Z"),
  cappedByPhone: false,
  coveredSinceAfterMs: Date.parse("2026-02-28T00:00:00.000Z"),
};

beforeEach(() => {
  jest.clearAllMocks();
  progressCb = null;
  getTextCoverage.mockResolvedValue(gapResult);
  backfillAvailability.mockResolvedValue(available);
  (window as unknown as { api: unknown }).api = {
    transactions: { getTextCoverage, ensureMessagesCoverage: jest.fn(async () => ({ success: true })) },
    sync: {
      backfillAvailability,
      backfillOlder,
      cancelBackfill,
      onBackfillProgress: (cb: (p: BackfillProgress) => void) => {
        progressCb = cb;
        return () => {
          progressCb = null;
        };
      },
    },
  };
});

async function renderNotice(onTextsAdded?: () => void) {
  render(<TextCoverageNotice transactionId={TX} userId="user-1" onTextsAdded={onTextsAdded} />);
  await screen.findByTestId("coverage-gap-iphone");
  await waitFor(() => expect(backfillAvailability).toHaveBeenCalledWith(TX));
}

describe("C1: offered only when the kept backup can fill the gap", () => {
  it("available -> the button", async () => {
    await renderNotice();
    expect(await screen.findByTestId("get-older-texts-button")).toHaveTextContent("Get older texts");
  });

  it.each([
    ["locked"],
    ["no-gap"],
    ["nothing-older"],
    ["busy"],
    ["no-phone"],
    ["error"],
  ] as const)("%s -> no button, no line", async (reason) => {
    backfillAvailability.mockResolvedValue({ available: false, reason });
    await renderNotice();
    // let the availability promise land
    await act(async () => {});
    expect(screen.queryByTestId("get-older-texts-button")).toBeNull();
    expect(screen.queryByTestId("get-older-texts-unavailable")).toBeNull();
    // the sync instruction stays
    expect(screen.getByTestId("coverage-gap-iphone")).toHaveTextContent(/Click Sync iPhone on the dashboard\./);
  });

  it("missing -> the approved sentence, no button", async () => {
    backfillAvailability.mockResolvedValue({ available: false, reason: "missing", message: MISSING });
    await renderNotice();
    expect(await screen.findByTestId("get-older-texts-unavailable")).toHaveTextContent(MISSING);
    expect(screen.queryByTestId("get-older-texts-button")).toBeNull();
  });

  it("no button for a non-iPhone gap (availability never asked)", async () => {
    getTextCoverage.mockResolvedValue({
      success: true,
      auditStartISO: "2026-03-01T00:00:00.000Z",
      gaps: [{ ...iphoneGap, kind: "newer", lastSyncAt: "2026-09-01T00:00:00.000Z", requiredEndISO: "2026-10-01T00:00:00.000Z" }],
    });
    render(<TextCoverageNotice transactionId={TX} userId="user-1" />);
    await screen.findByTestId("coverage-gap-iphone-newer");
    await act(async () => {});
    expect(backfillAvailability).not.toHaveBeenCalled();
    expect(screen.queryByTestId("get-older-texts-button")).toBeNull();
  });
});

describe("C2: progress and Cancel", () => {
  it("shows phase + percent, and Cancel calls cancelBackfill", async () => {
    let finish: (r: BackfillResult) => void = () => undefined;
    backfillOlder.mockImplementation(() => new Promise<BackfillResult>((res) => (finish = res)));
    await renderNotice();
    fireEvent.click(await screen.findByTestId("get-older-texts-button"));
    expect(await screen.findByTestId("get-older-texts-progress")).toHaveTextContent(/Fetching older texts from your saved iPhone backup/);
    expect(backfillOlder).toHaveBeenCalledWith(TX);
    await waitFor(() => expect(progressCb).not.toBeNull());
    act(() => progressCb!({ transactionId: TX, phase: "reading", percent: 37.4 }));
    expect(screen.getByTestId("get-older-texts-phase")).toHaveTextContent("Reading texts");
    expect(screen.getByTestId("get-older-texts-progress")).toHaveTextContent("37%");
    // another deal's progress is ignored
    act(() => progressCb!({ transactionId: "other", phase: "saving", percent: 80 }));
    expect(screen.getByTestId("get-older-texts-phase")).toHaveTextContent("Reading texts");

    fireEvent.click(screen.getByTestId("get-older-texts-cancel"));
    await waitFor(() => expect(cancelBackfill).toHaveBeenCalledTimes(1));
    const coverageCalls = getTextCoverage.mock.calls.length;
    await act(async () => finish({ success: false, reason: "cancelled", messagesStored: 0, coverageRecorded: false }));
    // cancelled: nothing said, coverage not re-read as a success
    expect(screen.queryByTestId("get-older-texts-result")).toBeNull();
    expect(getTextCoverage.mock.calls.length).toBe(coverageCalls);
  });
});

describe("C3: success re-reads coverage with the chosen source", () => {
  it("re-reads with iphone, reloads texts, and the warning clears", async () => {
    const onTextsAdded = jest.fn();
    backfillOlder.mockResolvedValue({
      success: true,
      messagesStored: 12,
      coverageRecorded: true,
      coveredSinceAfter: "2026-02-28T00:00:00.000Z",
      cappedByPhone: false,
    });
    await renderNotice(onTextsAdded);
    getTextCoverage.mockClear();
    getTextCoverage.mockResolvedValue({ success: true, auditStartISO: "2026-03-01T00:00:00.000Z", gaps: [] });
    fireEvent.click(await screen.findByTestId("get-older-texts-button"));
    await waitFor(() => expect(getTextCoverage).toHaveBeenCalledWith(TX, "user-1", "iphone"));
    await waitFor(() => expect(onTextsAdded).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByTestId("text-coverage-notice")).toBeNull());
  });

  it("gap still there (failed chat reads): the done line shows and the warning stays", async () => {
    backfillOlder.mockResolvedValue({ success: true, messagesStored: 1, coverageRecorded: false, cappedByPhone: false });
    await renderNotice();
    backfillAvailability.mockResolvedValue({ available: false, reason: "nothing-older" });
    fireEvent.click(await screen.findByTestId("get-older-texts-button"));
    expect(await screen.findByTestId("get-older-texts-result")).toHaveTextContent("Added 1 older text from your saved iPhone backup.");
    expect(getTextCoverage).toHaveBeenLastCalledWith(TX, "user-1", "iphone");
    expect(screen.getByTestId("coverage-gap-iphone")).toBeInTheDocument();
    expect(screen.queryByTestId("get-older-texts-button")).toBeNull();
  });
});

describe("C4: refusal lines", () => {
  it.each([
    ["damaged", DAMAGED, DAMAGED],
    ["key-missing", KEY_MISSING, KEY_MISSING],
    ["missing", MISSING, MISSING],
    ["error", "SqliteError: database is locked", FAILED_DRAFT],
    ["disk-space", undefined, FAILED_DRAFT],
    ["busy", undefined, FAILED_DRAFT],
  ] as const)("%s -> its line", async (reason, message, expected) => {
    backfillOlder.mockResolvedValue({
      success: false,
      reason,
      messagesStored: 0,
      coverageRecorded: false,
      ...(message ? { message } : {}),
    });
    await renderNotice();
    const coverageCalls = getTextCoverage.mock.calls.length;
    fireEvent.click(await screen.findByTestId("get-older-texts-button"));
    expect(await screen.findByTestId("get-older-texts-result")).toHaveTextContent(expected);
    expect(screen.queryByText(/SqliteError/)).toBeNull();
    // an unusable backup is not offered again (availability still says available here)
    await act(async () => {});
    if ([DAMAGED, KEY_MISSING, MISSING].includes(expected)) {
      expect(screen.queryByTestId("get-older-texts-button")).toBeNull();
    } else {
      expect(screen.getByTestId("get-older-texts-button")).toBeInTheDocument();
    }
    // a refusal is not a success: coverage is not re-read for it
    expect(getTextCoverage.mock.calls.length).toBe(coverageCalls);
  });
});
