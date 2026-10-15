/**
 * BACKLOG-3926 — Needs Review "Folder / label match" in the renderer (mock v5,
 * https://claude.ai/artifact/FzecTBH1FApLPjrHyCmqbn).
 *
 * Items are shaped as getReviewState projects them: `matchReason` "folder" carries
 * `matchFolder`, the title-row text ("Outlook folder: <path>" / "Gmail label: <path>").
 * Invented names only.
 */
import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { ReviewQueueSection } from "../ReviewQueueSection";
import { NeedsReviewScreen } from "../NeedsReviewScreen";
import type { ReviewItemDto } from "../../../../../electron/types/ipc/window-api-transactions";
import type { ReviewMatchReason } from "../../../../../electron/types/ipc/reviewMatchReason";

function item(id: string, threadId: string, title: string, matchReason: ReviewMatchReason, matchFolder?: string): ReviewItemDto {
  return {
    id: `pending:${id}`,
    rowId: id,
    origin: "pending",
    kind: "email",
    transaction_id: "tx-1",
    email_id: `e-${id}`,
    thread_id: null,
    found_at: "2026-08-01T00:00:00.000Z",
    matchReason,
    ...(matchFolder ? { matchFolder } : {}),
    display: {
      title,
      subtitle: "someone@example.test",
      snippet: "Body.",
      occurredAt: "2026-03-01T00:00:00.000Z",
      itemCount: 1,
      threadId,
      recipients: "me@example.test",
      cc: null,
      sender: "someone@example.test",
      body: null,
      bodyText: "Body.",
      hasAttachments: false,
      threadParticipants: [],
      threadMessages: [],
    },
  };
}

const OUTLOOK = "Outlook folder: Inbox / 1428 Maple";
const GMAIL = "Gmail label: Maple Ave 1428";

const ITEMS: ReviewItemDto[] = [
  item("1", "th-1", "Updated payoff statement", "contact"),
  item("2", "th-2", "Showing feedback", "address"),
  item("3", "th-3", "Signed disclosures", "folder", OUTLOOK),
  // One thread, three reasons: folder wins (folder > address > contact).
  item("4a", "th-4", "Re: Appraisal appointment", "contact"),
  item("4b", "th-4", "Re: Appraisal appointment", "address"),
  item("4c", "th-4", "Re: Appraisal appointment", "folder", GMAIL),
];

const pills = () => screen.queryAllByTestId("match-pill").map((el) => `${el.getAttribute("data-reason")}:${el.textContent}`);
const folders = () => screen.queryAllByTestId("match-folder").map((el) => el.textContent);

function renderScreen(items = ITEMS) {
  render(
    <NeedsReviewScreen items={items} isLoading={false} onApprove={jest.fn().mockResolvedValue(undefined)} onReject={jest.fn().mockResolvedValue(undefined)} onClose={jest.fn()} />,
  );
}

describe("BACKLOG-3926 full Needs Review screen", () => {
  it("tabs in mock order with thread counts; a mixed thread counts once, under folder", () => {
    renderScreen();
    const tabs = screen.getAllByRole("button").filter((b) => b.getAttribute("data-testid")?.startsWith("needs-review-filter-"));
    expect(tabs.map((b) => b.textContent)).toEqual(["All (4)", "Address match (1)", "Contact match (1)", "Folder / label (2)"]);
  });

  it("All: emerald folder pill and the folder / label name after it, on the title row", () => {
    renderScreen();
    expect(pills()).toEqual([
      "contact:Contact match · no address",
      "address:Address matched",
      "folder:Folder / label match",
      "folder:Folder / label match",
    ]);
    const pill = screen.getAllByTestId("match-pill")[2];
    expect(pill.className).toContain("bg-emerald-100");
    expect(pill.className).toContain("text-emerald-700");
    expect(folders()).toEqual([OUTLOOK, GMAIL]);
    const note = screen.getAllByTestId("match-folder")[0];
    expect(note.className).toContain("text-emerald-700");
    // Same row as the subject and the pill.
    expect(note.parentElement).toBe(pill.parentElement?.parentElement);
  });

  it("Folder / label tab: only folder threads, no pills, names still shown", () => {
    renderScreen();
    fireEvent.click(screen.getByTestId("needs-review-filter-folder"));
    expect(screen.getAllByTestId("thread-subject").map((s) => s.textContent?.split("Outlook")[0].split("Gmail")[0])).toEqual([
      "Signed disclosures",
      "Re: Appraisal appointment",
    ]);
    expect(pills()).toEqual([]);
    expect(folders()).toEqual([OUTLOOK, GMAIL]);
  });

  it("empty Folder / label tab shows the empty state", () => {
    renderScreen([item("1", "th-1", "Updated payoff statement", "contact")]);
    fireEvent.click(screen.getByTestId("needs-review-filter-folder"));
    expect(screen.getByTestId("needs-review-filter-empty").textContent).toContain(
      "No folder / label match emails need review",
    );
  });

  it("(i) explains the folder / label kind with the mock's text", () => {
    renderScreen();
    fireEvent.click(screen.getByTestId("needs-review-info-button"));
    expect(screen.getByTestId("needs-review-info-folder").textContent).toBe(
      "Folder / label match: you filed it in an Outlook folder or Gmail label named after this property.",
    );
  });
});

describe("BACKLOG-3926 Emails-tab Needs Review section", () => {
  it("no tabs; every thread with its pill, folder ones with the name", () => {
    render(<ReviewQueueSection items={ITEMS} kind="email" onApprove={jest.fn().mockResolvedValue(undefined)} onReject={jest.fn().mockResolvedValue(undefined)} />);
    expect(screen.queryByTestId("needs-review-filter")).toBeNull();
    expect(pills()).toEqual([
      "contact:Contact match · no address",
      "address:Address matched",
      "folder:Folder / label match",
      "folder:Folder / label match",
    ]);
    expect(folders()).toEqual([OUTLOOK, GMAIL]);
  });
});
