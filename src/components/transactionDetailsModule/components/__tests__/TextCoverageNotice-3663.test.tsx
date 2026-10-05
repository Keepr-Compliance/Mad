/**
 * BACKLOG-3663 — the Texts tab's per-source coverage notice, and the audit
 * prompt's per-source lines.
 *
 * Mutations that turn this suite red:
 *   N1 the chosen import source not passed (its gap never shown)   → "asks with the chosen source"
 *   N2 approximate gaps shown as warnings (or exact ones as soft)   → "exact vs approximate"
 *   N3 the notice not refreshing after a Sync was saved             → "refreshes"
 *   N4 the prompt dropping the other sources' lines                 → "audit prompt"
 */
import React from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { SourceCoverageGap } from "../../../../../electron/types/auditCoverage";

let changed: (() => void) | null = null;
let mockSource: string | undefined = "android-messages-web";

jest.mock("../../../../services/rcsImportService", () => ({
  rcsImportService: {
    onDataChanged: (cb: () => void) => {
      changed = cb;
      return () => {
        changed = null;
      };
    },
    onDataCleared: () => () => undefined,
  },
}));
let mockIsMac = true;
jest.mock("../../../../utils/platform", () => ({
  ...jest.requireActual("../../../../utils/platform"),
  isMacOS: () => mockIsMac,
}));
jest.mock("../../../../services/settingsService", () => ({
  settingsService: {
    getPreferences: async () => ({ success: true, data: { messages: { source: mockSource } } }),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { TextCoverageNotice, chosenTextSource, gapLine, googleMessagesOlderLine, googleMessagesGapLine } = require("../TextCoverageNotice") as typeof import("../TextCoverageNotice");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { AuditCoveragePrompt } = require("../AuditCoveragePrompt") as typeof import("../AuditCoveragePrompt");

const getTextCoverage = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  mockSource = "android-messages-web";
  (window as unknown as { api: unknown }).api = {
    transactions: { getTextCoverage, ensureMessagesCoverage: jest.fn(async () => ({ success: true })) },
  };
});

const gm: SourceCoverageGap = { source: "google_messages", coveredSince: "2026-07-01T00:00:00.000Z", approximate: false, kind: "later" };
const iphone: SourceCoverageGap = { source: "iphone", coveredSince: "2026-06-01T00:00:00.000Z", approximate: true, kind: "later" };

describe("TextCoverageNotice", () => {
  it("asks with the chosen import source and names the right re-sync (N1)", async () => {
    getTextCoverage.mockResolvedValue({ success: true, auditStartISO: "2026-05-01T00:00:00.000Z", gaps: [gm] });
    render(<TextCoverageNotice transactionId="tx-1" userId="user-1" />);
    // Google Messages alone → the one blue line (the shared wording).
    expect(await screen.findByTestId("coverage-gap-google_messages")).toHaveTextContent(/^Texts start .+\. Sync Android on the dashboard to get older ones\.$/);
    expect(getTextCoverage).toHaveBeenCalledWith("tx-1", "user-1", "google_messages");
    expect(chosenTextSource("macos-native")).toBe("mac");
    expect(chosenTextSource("iphone-sync")).toBe("iphone");
    expect(chosenTextSource("android-companion")).toBe("google_messages"); // SR C6: shown as Google Messages
    expect(chosenTextSource(undefined)).toBeNull();
  });

  // BACKLOG-3749: a stored value this build does not know asks with the
  // platform default's source (Mac: mac, else iPhone), never with nothing.
  // Mutation: the raw value passed to chosenTextSource → red.
  it("an unknown stored source asks with the platform default (BACKLOG-3749)", async () => {
    getTextCoverage.mockResolvedValue({ success: true, auditStartISO: "2026-05-01T00:00:00.000Z", gaps: [] });
    mockSource = "some-future-source";
    mockIsMac = true;
    const { unmount } = render(<TextCoverageNotice transactionId="tx-1" userId="user-1" />);
    await waitFor(() => expect(getTextCoverage).toHaveBeenCalledWith("tx-1", "user-1", "mac"));
    unmount();
    getTextCoverage.mockClear();
    mockIsMac = false;
    render(<TextCoverageNotice transactionId="tx-1" userId="user-1" />);
    await waitFor(() => expect(getTextCoverage).toHaveBeenCalledWith("tx-1", "user-1", "iphone"));
    mockIsMac = true;
  });

  it("exact vs approximate: a warning when any gap is exact, a soft note when all are approximate (N2)", async () => {
    getTextCoverage.mockResolvedValue({ success: true, auditStartISO: "2026-05-01T00:00:00.000Z", gaps: [iphone] });
    const { unmount } = render(<TextCoverageNotice transactionId="tx-1" userId="user-1" />);
    const soft = await screen.findByTestId("text-coverage-notice");
    expect(soft.className).toMatch(/bg-gray-50/);
    expect(soft).toHaveTextContent("from the oldest text Keepr has");
    unmount();
    getTextCoverage.mockResolvedValue({ success: true, auditStartISO: "2026-05-01T00:00:00.000Z", gaps: [iphone, gm] });
    render(<TextCoverageNotice transactionId="tx-1" userId="user-1" />);
    await waitFor(() => expect(screen.getByTestId("text-coverage-notice").className).toMatch(/bg-amber-50/));
  });

  // L2: the not-settled chats of the last full run are shown, not hidden.
  // Mutation: no "incomplete" line → red.
  it("incomplete: \"N chats may be incomplete\" (L2)", () => {
    const gap: SourceCoverageGap = { source: "google_messages", coveredSince: "2026-07-01T00:00:00.000Z", approximate: false, kind: "incomplete", incompleteChats: 3 };
    expect(gapLine(gap, "2026-08-01T00:00:00.000Z")).toBe("Google Messages: 3 chats may be incomplete.");
    expect(gapLine({ ...gap, incompleteChats: 1 }, null)).toBe("Google Messages: 1 chat may be incomplete.");
  });

  // Founder (2026-10-04): ONE wording for a Google Messages gap, everywhere:
  // "Texts start Sep 2. Sync Android on the dashboard to get older ones."
  // ("MMM d"; the year only when not this year). Mutations: another wording;
  // the year always / never → red.
  it("the Google Messages gap line: 'Texts start Sep 2. Sync Android on the dashboard to get older ones.'", () => {
    const now = new Date(2026, 9, 4);
    expect(googleMessagesGapLine({ ...gm, coveredSince: new Date(2026, 8, 2, 12).toISOString() }, now)).toBe(
      "Texts start Sep 2. Sync Android on the dashboard to get older ones.",
    );
    expect(googleMessagesGapLine({ ...gm, coveredSince: new Date(2025, 11, 20, 12).toISOString() }, now)).toBe(
      "Texts start Dec 20, 2025. Sync Android on the dashboard to get older ones.",
    );
    expect(googleMessagesGapLine({ ...gm, kind: "never" }, now)).toBeNull();
    expect(googleMessagesGapLine({ ...gm, source: "mac" }, now)).toBeNull();
    expect(googleMessagesOlderLine([gm, { ...gm, source: "mac" }])).toBeNull();
  });

  it("nothing to say: no notice", async () => {
    getTextCoverage.mockResolvedValue({ success: true, auditStartISO: "2026-05-01T00:00:00.000Z", gaps: [] });
    render(<TextCoverageNotice transactionId="tx-1" userId="user-1" />);
    await waitFor(() => expect(getTextCoverage).toHaveBeenCalled());
    expect(screen.queryByTestId("text-coverage-notice")).toBeNull();
  });

  it("refreshes when a Sync was saved (N3)", async () => {
    getTextCoverage.mockResolvedValue({ success: true, auditStartISO: "2026-05-01T00:00:00.000Z", gaps: [gm] });
    render(<TextCoverageNotice transactionId="tx-1" userId="user-1" />);
    await screen.findByTestId("text-coverage-notice");
    getTextCoverage.mockResolvedValue({ success: true, auditStartISO: "2026-05-01T00:00:00.000Z", gaps: [] });
    await act(async () => {
      changed?.();
    });
    await waitFor(() => expect(screen.queryByTestId("text-coverage-notice")).toBeNull());
  });
});

describe("audit prompt (N4)", () => {
  it("lists the other sources that start later than the range; the Mac lines stay as they were", () => {
    render(
      <AuditCoveragePrompt
        hasGap={false}
        importerAvailable={false}
        importing={false}
        progress={null}
        onUpdateNow={jest.fn()}
        onSkip={jest.fn()}
        onCancel={jest.fn()}
        sourceGaps={[gm, { ...iphone, source: "mac" }]}
        proposedStartISO="2026-05-01T00:00:00.000Z"
      />,
    );
    const list = screen.getByTestId("audit-coverage-source-gaps");
    // The dialog says the Google Messages gap exactly as the Texts tab does.
    expect(screen.getByTestId("audit-coverage-gap-google_messages").textContent).toBe(googleMessagesGapLine(gm));
    expect(list).not.toHaveTextContent("texts only from");
    expect(list).not.toHaveTextContent("Mac Messages");
  });
});
