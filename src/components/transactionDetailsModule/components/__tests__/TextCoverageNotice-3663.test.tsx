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
jest.mock("../../../../services/settingsService", () => ({
  settingsService: {
    getPreferences: async () => ({ success: true, data: { messages: { source: mockSource } } }),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { TextCoverageNotice, chosenTextSource, gapLine, googleMessagesOlderLine } = require("../TextCoverageNotice") as typeof import("../TextCoverageNotice");
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
    // C02: Google Messages alone → the one blue line.
    expect(await screen.findByTestId("coverage-gap-google_messages")).toHaveTextContent(/^Older than .*\? Click Sync Android on the dashboard: it reads back to the start\.$/);
    expect(getTextCoverage).toHaveBeenCalledWith("tx-1", "user-1", "google_messages");
    expect(chosenTextSource("macos-native")).toBe("mac");
    expect(chosenTextSource("iphone-sync")).toBe("iphone");
    expect(chosenTextSource("android-companion")).toBe("android_companion");
    expect(chosenTextSource(undefined)).toBeNull();
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

  // Storyboard C02: Google Messages alone, read only since a date → ONE blue
  // line. Mutation: the old amber block for this case → red.
  it("C02: Google Messages alone, later → 'Older than <date>? Click Sync Android on the dashboard: it reads back to the start.'", () => {
    const when = new Date(Date.parse("2026-08-01T12:00:00.000Z")).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    expect(googleMessagesOlderLine([{ ...gm, coveredSince: "2026-08-01T12:00:00.000Z" }])).toBe(
      `Older than ${when}? Click Sync Android on the dashboard: it reads back to the start.`,
    );
    expect(googleMessagesOlderLine([{ ...gm, kind: "never" }])).toBeNull();
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
    expect(list).toHaveTextContent("Google Messages: texts only from");
    expect(list).not.toHaveTextContent("Mac Messages");
  });
});
