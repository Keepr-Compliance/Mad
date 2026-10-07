/**
 * Live (founder, 2026-10-05, Windows, source = Google Messages): the
 * "Update communications for this date range" dialog showed BOTH the Mac
 * line ("Older messages can only be imported on a Mac with Full Disk
 * Access…") AND the Google Messages line. Rule: name the user's ACTUAL
 * source and its action only — one gap line, one action.
 *
 * Mutations (each red): the Mac lines not gated on the Mac source; the list
 * not narrowed to the chosen source; the Mac source counted on Windows.
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import { AuditCoveragePrompt } from "../AuditCoveragePrompt";
import { dialogTextSource, googleMessagesGapLine } from "../TextCoverageNotice";
import type { SourceCoverageGap, TextSource } from "../../../../../electron/types/auditCoverage";

const START = "2026-08-01T00:00:00.000Z";
const gm: SourceCoverageGap = { source: "google_messages", coveredSince: "2026-09-05T00:00:00.000Z", approximate: false, kind: "later" };
const iphone: SourceCoverageGap = { source: "iphone", coveredSince: "2026-09-10T00:00:00.000Z", approximate: false, kind: "later" };
const mac: SourceCoverageGap = { source: "mac", coveredSince: "2026-09-12T00:00:00.000Z", approximate: false, kind: "later" };

function show(chosenSource: TextSource | null, importerAvailable = false) {
  render(
    <AuditCoveragePrompt
      hasGap
      importerAvailable={importerAvailable}
      importing={false}
      progress={null}
      onUpdateNow={jest.fn()}
      onSkip={jest.fn()}
      onCancel={jest.fn()}
      sourceGaps={[gm, iphone, mac]}
      proposedStartISO={START}
      chosenSource={chosenSource}
    />,
  );
  return screen.getByTestId("audit-coverage-prompt").textContent ?? "";
}

describe("the date-range dialog names only the user's own source (live)", () => {
  it("Google Messages (Windows): only its line — no Mac / Full Disk Access, no iPhone", () => {
    const text = show("google_messages");
    expect(screen.queryByTestId("audit-coverage-degrade-line")).toBeNull();
    expect(screen.queryByTestId("audit-coverage-import-line")).toBeNull();
    expect(text).not.toMatch(/Full Disk Access|Mac/);
    expect(screen.getByTestId("audit-coverage-gap-google_messages").textContent).toBe(googleMessagesGapLine(gm));
    expect(screen.queryByTestId("audit-coverage-gap-iphone")).toBeNull();
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
  });

  it("macOS: only the Mac line (degrade without the importer, import with it)", () => {
    const text = show("mac");
    expect(screen.getByTestId("audit-coverage-degrade-line")).toBeInTheDocument();
    expect(screen.queryByTestId("audit-coverage-source-gaps")).toBeNull();
    expect(text).not.toMatch(/Google Messages|Sync Android|Sync iPhone/);
  });

  it("macOS with the importer: the import line, nothing else", () => {
    show("mac", true);
    expect(screen.getByTestId("audit-coverage-import-line")).toBeInTheDocument();
    expect(screen.queryByTestId("audit-coverage-degrade-line")).toBeNull();
    expect(screen.queryByTestId("audit-coverage-source-gaps")).toBeNull();
  });

  it("iPhone: its own line only", () => {
    const text = show("iphone");
    expect(screen.getByTestId("audit-coverage-gap-iphone")).toHaveTextContent("Click Sync iPhone on the dashboard.");
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(text).not.toMatch(/Full Disk Access|Google Messages/);
  });

  it("no source of its own (e.g. the Mac source on Windows): no text line at all", () => {
    const text = show(null);
    expect(screen.queryByTestId("audit-coverage-degrade-line")).toBeNull();
    expect(screen.queryByTestId("audit-coverage-source-gaps")).toBeNull();
    expect(text).not.toMatch(/Full Disk Access|Sync Android|Sync iPhone/);
  });

  it("dialogTextSource: the effective source → the dialog's; the Mac only on a Mac", () => {
    expect(dialogTextSource("macos-native", true)).toBe("mac");
    expect(dialogTextSource("macos-native", false)).toBeNull();
    expect(dialogTextSource("android-messages-web", false)).toBe("google_messages");
    expect(dialogTextSource("iphone-sync", false)).toBe("iphone");
    // SR C6: a stored Companion choice is shown as Google Messages everywhere.
    expect(dialogTextSource("android-companion", false)).toBe("google_messages");
  });
});
