/**
 * BACKLOG-3892 W — the coverage lines (coverageCopy.ts) and the three surfaces that
 * show them: the Texts tab (TextCoverageNotice) and the create/edit dialog
 * (AuditCoveragePrompt). The export gate is in ExportModal.coverageW-3892.test.tsx.
 *
 * Founder-approved sentences are asserted VERBATIM (pm_comments 7845fbe4).
 */
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { SourceCoverageGap } from "../../../../../electron/types/auditCoverage";

let mockSource: string | undefined = "iphone-sync";
let mockIsMac = true;
jest.mock("../../../../services/rcsImportService", () => ({
  rcsImportService: { onDataChanged: () => () => undefined, onDataCleared: () => () => undefined },
}));
jest.mock("../../../../utils/platform", () => ({
  ...jest.requireActual("../../../../utils/platform"),
  isMacOS: () => mockIsMac,
}));
jest.mock("../../../../services/settingsService", () => ({
  settingsService: {
    getPreferences: async () => ({ success: true, data: { messages: { source: mockSource } } }),
    getPhoneType: async () => ({ success: true, data: null }),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const copy = require("../coverageCopy") as typeof import("../coverageCopy");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { TextCoverageNotice } = require("../TextCoverageNotice") as typeof import("../TextCoverageNotice");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { AuditCoveragePrompt } = require("../AuditCoveragePrompt") as typeof import("../AuditCoveragePrompt");

/** Dates at local noon so the day never moves with the test machine's time zone. */
const at = (y: number, m: number, d: number): string => new Date(y, m - 1, d, 12).toISOString();
const NOW = new Date(2026, 9, 12, 12);

const start: SourceCoverageGap = { source: "iphone", coveredSince: at(2026, 8, 25), approximate: false, kind: "later", who: "Dana Reyes" };
const end: SourceCoverageGap = { source: "iphone", coveredSince: at(2026, 8, 25), approximate: false, kind: "newer", lastSyncAt: at(2026, 10, 9), requiredEndISO: at(2026, 10, 12) };

const getTextCoverage = jest.fn();
beforeEach(() => {
  jest.clearAllMocks();
  mockSource = "iphone-sync";
  mockIsMac = true;
  (window as unknown as { api: unknown }).api = {
    transactions: { getTextCoverage, ensureMessagesCoverage: jest.fn(async () => ({ success: true })) },
  };
});

describe("coverageCopy: the approved lines, verbatim", () => {
  it("start, with the person", () => {
    expect(copy.iphoneStartLine(start, at(2026, 1, 5), NOW)).toBe(
      "Keepr only has texts with Dana Reyes from Aug 25, but this deal starts Jan 5. Older texts may be missing.",
    );
  });
  it("start, nameless (PROPOSED)", () => {
    expect(copy.iphoneStartLine({ ...start, who: null }, at(2025, 12, 1), NOW)).toBe(
      "Keepr only has texts from Aug 25, but this deal starts Dec 1, 2025. Older texts may be missing.",
    );
  });
  it("end, iPhone", () => {
    expect(copy.endLine(end, NOW)).toBe(
      "Newer texts may be missing: your iPhone was last synced Oct 9, and this deal runs to Oct 12. Sync iPhone to get them.",
    );
  });
  it("end, Google Messages and Mac (PROPOSED)", () => {
    expect(copy.endLine({ ...end, source: "google_messages" }, NOW)).toBe(
      "Newer texts may be missing: Google Messages was last synced Oct 9, and this deal runs to Oct 12. Sync Android to get them.",
    );
    expect(copy.endLine({ ...end, source: "mac" }, NOW)).toBe(
      "Newer texts may be missing: Mac Messages were last imported Oct 9, and this deal runs to Oct 12. Update Mac messages to get them.",
    );
    expect(copy.endLine({ ...end, source: "android_companion" }, NOW)).toBeNull();
  });
  it("new phone: the previous-phone line replaces the sync action; a single capped phone gets no action", () => {
    const capped: SourceCoverageGap = { ...start, coveredSince: at(2026, 8, 1), cappedByPhone: at(2026, 8, 1), previousPhone: true };
    expect(copy.coverageLine(capped, at(2026, 6, 1), "Click Sync iPhone on the dashboard.", NOW)).toBe(
      "Keepr only has texts with Dana Reyes from Aug 1, but this deal starts Jun 1. Older texts may be missing. " +
        "Texts before Aug 1 are on your previous iPhone or its backup.",
    );
    expect(copy.coverageLine({ ...capped, previousPhone: false }, at(2026, 6, 1), "Click Sync iPhone on the dashboard.", NOW)).toBe(
      "Keepr only has texts with Dana Reyes from Aug 1, but this deal starts Jun 1. Older texts may be missing.",
    );
    expect(copy.coverageLine(start, at(2026, 6, 1), "Click Sync iPhone on the dashboard.", NOW)).toMatch(/Older texts may be missing\. Click Sync iPhone on the dashboard\.$/);
  });
});

describe("Texts tab", () => {
  it("an iPhone start AND end gap: two lines, each with its own test id", async () => {
    getTextCoverage.mockResolvedValue({ success: true, auditStartISO: at(2026, 1, 5), gaps: [start, end] });
    render(<TextCoverageNotice transactionId="tx-1" userId="user-1" />);
    expect(await screen.findByTestId("coverage-gap-iphone")).toHaveTextContent("Keepr only has texts with Dana Reyes from");
    expect(screen.getByTestId("coverage-gap-iphone-newer")).toHaveTextContent("Newer texts may be missing: your iPhone was last synced");
  });

  it("W5: off a Mac a stored Mac source names no source, and no Mac line is shown", async () => {
    mockIsMac = false;
    mockSource = "macos-native";
    const mac: SourceCoverageGap = { source: "mac", coveredSince: at(2026, 8, 1), approximate: false, kind: "later" };
    getTextCoverage.mockResolvedValue({ success: true, auditStartISO: at(2026, 1, 5), gaps: [mac, { ...end, source: "mac" }] });
    render(<TextCoverageNotice transactionId="tx-1" userId="user-1" />);
    await waitFor(() => expect(getTextCoverage).toHaveBeenCalledWith("tx-1", "user-1", null));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByTestId("text-coverage-notice")).toBeNull();
  });

  it("on a Mac, the Mac source and its lines are kept, with ONE Update button", async () => {
    mockSource = "macos-native";
    const mac: SourceCoverageGap = { source: "mac", coveredSince: at(2026, 8, 1), approximate: false, kind: "later" };
    getTextCoverage.mockResolvedValue({ success: true, auditStartISO: at(2026, 1, 5), gaps: [mac, { ...end, source: "mac" }] });
    render(<TextCoverageNotice transactionId="tx-1" userId="user-1" />);
    await waitFor(() => expect(getTextCoverage).toHaveBeenCalledWith("tx-1", "user-1", "mac"));
    expect(await screen.findByTestId("coverage-gap-mac-newer")).toHaveTextContent("Mac Messages were last imported");
    expect(screen.getAllByRole("button", { name: /Update Mac messages/ })).toHaveLength(1);
  });
});

describe("create/edit dialog", () => {
  const base = { hasGap: true, importerAvailable: false, importing: false, progress: null, onUpdateNow: jest.fn(), onSkip: jest.fn(), onCancel: jest.fn() };

  it("iPhone: the start and end lines", () => {
    render(<AuditCoveragePrompt {...base} chosenSource="iphone" sourceGaps={[{ ...start, who: null }, end]} proposedStartISO={at(2026, 1, 5)} />);
    expect(screen.getByTestId("audit-coverage-gap-iphone")).toHaveTextContent(
      "Keepr only has texts from Aug 25, but this deal starts Jan 5. Older texts may be missing. Click Sync iPhone on the dashboard.",
    );
    expect(screen.getByTestId("audit-coverage-gap-iphone-newer")).toHaveTextContent("your iPhone was last synced");
  });

  it("Mac: the END line shows next to the Mac start lines", () => {
    render(<AuditCoveragePrompt {...base} chosenSource="mac" sourceGaps={[{ ...end, source: "mac" }]} proposedStartISO={at(2026, 1, 5)} />);
    expect(screen.getByTestId("audit-coverage-gap-mac-newer")).toHaveTextContent("Mac Messages were last imported");
  });

  it("W2: a gap of another source is never named", () => {
    render(<AuditCoveragePrompt {...base} chosenSource="google_messages" sourceGaps={[start, end]} proposedStartISO={at(2026, 1, 5)} />);
    expect(screen.queryByTestId("audit-coverage-source-gaps")).toBeNull();
  });
});
