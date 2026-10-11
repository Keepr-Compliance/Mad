/**
 * BACKLOG-3837 follow-up: the per-source floors are read off the main process and may
 * not be ready when the user clicks Continue. The result then says PENDING
 * (`sourceCoveragePending: true`, no `sourceGaps`). The dialog must say "still
 * checking", never present the unknown as "no gaps" (silence).
 *
 * Mutations (each red): the helper drops `sourceCoveragePending`; the pending line is
 * not rendered; the pending line shows for the Mac source (whose lines come from the
 * main-side floor, which is always known).
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import { AuditCoveragePrompt, sourceLinesFromCoverage } from "../AuditCoveragePrompt";
import type { SourceCoverageGap, TextSource } from "../../../../../electron/types/auditCoverage";

const START = "2026-08-01T00:00:00.000Z";
const iphone: SourceCoverageGap = { source: "iphone", coveredSince: "2026-09-10T00:00:00.000Z", approximate: false, kind: "later" };

function show(chosenSource: TextSource | null, lines: ReturnType<typeof sourceLinesFromCoverage>) {
  render(
    <AuditCoveragePrompt
      hasGap
      importerAvailable={false}
      importing={false}
      progress={null}
      onUpdateNow={jest.fn()}
      onSkip={jest.fn()}
      onCancel={jest.fn()}
      sourceGaps={lines.sourceGaps}
      sourceCoveragePending={lines.sourceCoveragePending}
      proposedStartISO={START}
      chosenSource={chosenSource}
    />,
  );
}

describe("BACKLOG-3837: pending source coverage in the date-range dialog", () => {
  it("maps a pending result to pending (not to an empty 'no gaps' list)", () => {
    expect(sourceLinesFromCoverage({ sourceCoveragePending: true })).toEqual({ sourceGaps: [], sourceCoveragePending: true });
    expect(sourceLinesFromCoverage({ sourceGaps: [iphone] })).toEqual({ sourceGaps: [iphone], sourceCoveragePending: false });
    expect(sourceLinesFromCoverage(null)).toEqual({ sourceGaps: [], sourceCoveragePending: false });
  });

  it("iPhone source, pending: one 'still checking' line, no gap line", () => {
    show("iphone", sourceLinesFromCoverage({ sourceCoveragePending: true }));
    expect(screen.getByTestId("audit-coverage-source-pending").textContent).toMatch(/Still checking how far back your texts go/);
    expect(screen.queryByTestId("audit-coverage-source-gaps")).toBeNull();
  });

  it("Google Messages source, pending: the same line", () => {
    show("google_messages", sourceLinesFromCoverage({ sourceCoveragePending: true }));
    expect(screen.getByTestId("audit-coverage-source-pending")).toBeInTheDocument();
  });

  it("known coverage: the gap line, no pending line", () => {
    show("iphone", sourceLinesFromCoverage({ sourceGaps: [iphone] }));
    expect(screen.queryByTestId("audit-coverage-source-pending")).toBeNull();
    expect(screen.getByTestId("audit-coverage-gap-iphone")).toBeInTheDocument();
  });

  it("Mac source or no source: no pending line (the Mac lines come from the main-side floor)", () => {
    show("mac", sourceLinesFromCoverage({ sourceCoveragePending: true }));
    expect(screen.queryByTestId("audit-coverage-source-pending")).toBeNull();
  });

  it("no chosen source: no pending line", () => {
    show(null, sourceLinesFromCoverage({ sourceCoveragePending: true }));
    expect(screen.queryByTestId("audit-coverage-source-pending")).toBeNull();
  });
});
