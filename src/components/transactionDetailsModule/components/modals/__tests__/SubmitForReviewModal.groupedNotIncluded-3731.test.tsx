/**
 * BACKLOG-3731 PR-B — the not-included list: truthful wording per import skip
 * reason, grouped by conversation with a count, and "Show more" after 5 lines.
 *
 * Items are shaped as `runSubmissionPreflight` emits them
 * (electron/services/submissionPreflight.ts): `skip:<msg>:<n>` keys with the
 * reason the import recorded, `msg:<id>` for a text with no recorded reason.
 */
import React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import {
  IMPORT_SIZE_LIMIT_MB,
  NOT_INCLUDED_VISIBLE_LINES,
  NotIncludedList,
  groupNotIncluded,
  notIncludedLine,
  type NotIncludedItem,
  type NotIncludedReason,
} from "../SubmitForReviewModal";
import { MAX_ATTACHMENT_SIZE } from "../../../../../../electron/services/macOSMessagesImportService/types";

function item(
  n: number,
  reason: NotIncludedReason,
  opts: Partial<NotIncludedItem> = {},
): NotIncludedItem {
  return {
    key: `skip:m${n}:0`,
    kind: "text",
    localMessageId: `m${n}`,
    threadId: "chat-paul",
    sentAt: "2026-09-24T17:00:00.000Z",
    label: "Paul Example",
    filename: `IMG_${n}.HEIC`,
    reason,
    localAttachmentId: null,
    ...opts,
  };
}

describe("BACKLOG-3731 — wording per reason", () => {
  it("each import skip reason reads as its own plain sentence", () => {
    expect(
      [
        item(1, "text_attachment_not_downloaded_by_messages"),
        item(2, "text_attachment_too_large_to_import", { filename: "Tour.mov" }),
        item(3, "text_attachment_type_not_imported", { filename: "Agent.vcf" }),
        item(4, "text_attachment_unreadable", { filename: "Offer.pdf" }),
        item(5, "text_attachment_not_on_this_computer", { key: "msg:m5", filename: null }),
        item(6, "text_attachment_not_downloaded_by_messages", { filename: null }),
      ].map(notIncludedLine),
    ).toEqual([
      "Text with Paul Example, Sep 24 — IMG_1.HEIC isn't on this Mac. To include it, open this chat in Messages on this Mac, download the attachment, then sync your messages.",
      "Text with Paul Example, Sep 24 — Tour.mov is larger than 100 MB, the largest file Keepr imports.",
      "Text with Paul Example, Sep 24 — Agent.vcf is a type of file Keepr doesn't import.",
      "Text with Paul Example, Sep 24 — Keepr couldn't read Offer.pdf on this Mac.",
      "Text with Paul Example, Sep 24 — Keepr doesn't have a copy of a photo or file from this text.",
      "Text with Paul Example, Sep 24 — A photo or file isn't on this Mac. To include it, open this chat in Messages on this Mac, download the attachment, then sync your messages.",
    ]);
  });

  it("the 100 MB in the wording is the import's own limit", () => {
    expect(IMPORT_SIZE_LIMIT_MB * 1024 * 1024).toBe(MAX_ATTACHMENT_SIZE);
  });
});

describe("BACKLOG-3731 — grouped by conversation, Show more after 5 lines", () => {
  // 12 items across 3 conversations: 7 with Paul, 3 with Gina, 2 in an email.
  const ITEMS: NotIncludedItem[] = [
    ...Array.from({ length: 7 }, (_, i) =>
      item(i, "text_attachment_not_downloaded_by_messages"),
    ),
    ...Array.from({ length: 3 }, (_, i) =>
      item(20 + i, "text_attachment_type_not_imported", {
        threadId: "chat-gina",
        label: "Gina Example",
        filename: `Card${i}.vcf`,
      }),
    ),
    ...Array.from({ length: 2 }, (_, i) => ({
      ...item(40 + i, "email_attachment_not_downloaded", {
        kind: "email" as const,
        key: `att:a${i}`,
        threadId: "thread-inspection",
        label: "Inspection",
        filename: `Report${i}.pdf`,
      }),
    })),
  ];

  it("groups by thread, in first-seen order, with counts", () => {
    expect(groupNotIncluded(ITEMS).map((g) => [g.source, g.items.length])).toEqual([
      ["Text with Paul Example", 7],
      ["Text with Gina Example", 3],
      ['Email "Inspection"', 2],
    ]);
  });

  it("two contacts with the same name in different chats stay apart", () => {
    const groups = groupNotIncluded([
      item(1, "text_attachment_unreadable", { threadId: "chat-a" }),
      item(2, "text_attachment_unreadable", { threadId: "chat-b" }),
    ]);
    expect(groups).toHaveLength(2);
  });

  it("shows 5 lines under their headers, then Show more (7) reveals the rest", () => {
    render(<NotIncludedList items={ITEMS} testId="list" />);
    const headers = screen.getAllByTestId("list-group");
    expect(headers).toHaveLength(1); // the first 5 lines are all Paul's
    expect(headers[0]).toHaveTextContent("Text with Paul Example — 7 attachments");
    expect(screen.getAllByTestId("list-line")).toHaveLength(NOT_INCLUDED_VISIBLE_LINES);
    expect(screen.getAllByTestId("list-line")[0]).toHaveTextContent(
      "Sep 24 — IMG_0.HEIC isn't on this Mac.",
    );

    fireEvent.click(screen.getByTestId("list-toggle"));
    expect(screen.getByTestId("list-toggle")).toHaveTextContent("Show less");
    expect(screen.getAllByTestId("list-line")).toHaveLength(12);
    const groups = screen.getAllByTestId("list-group");
    expect(groups.map((g) => within(g).getByText(/—\s*\d+ attachments?$/).textContent)).toEqual([
      "Text with Paul Example — 7 attachments",
      "Text with Gina Example — 3 attachments",
      'Email "Inspection" — 2 attachments',
    ]);
  });

  it("the toggle reads Show more (7) before it is pressed", () => {
    render(<NotIncludedList items={ITEMS} testId="list" />);
    expect(screen.getByTestId("list-toggle")).toHaveTextContent("Show more (7)");
  });

  it("5 or fewer items: everything shown, no toggle; one item says 'attachment'", () => {
    render(<NotIncludedList items={ITEMS.slice(7, 8)} testId="list" />);
    expect(screen.queryByTestId("list-toggle")).toBeNull();
    expect(screen.getByTestId("list-group")).toHaveTextContent("Text with Gina Example — 1 attachment");
  });
});
