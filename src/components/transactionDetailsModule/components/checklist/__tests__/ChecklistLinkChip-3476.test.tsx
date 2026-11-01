/**
 * BACKLOG-3476 — evidence chips (SR condition 7, control C-P; View B-3).
 *
 * Wrong implementations this suite is here to catch:
 *   - a stale member rendered as live, with a View that opens nothing;
 *   - a thread with ONE email unlinked treated as wholly stale, removing the
 *     View on the emails that are still there;
 *   - View offered on a fully stale chip (B-3): the evidence is no longer on
 *     the transaction, so there is nothing here to open.
 * What View opens (the exact thread, the download first) is pinned in
 * TransactionChecklistTab-3476.test.tsx, where the modals live.
 * Every link below is taken from the producer-generated fixture.
 */
import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { ChecklistLinkChip } from "../ChecklistLinkChip";
import {
  fixtureAttachments,
  fixtureChecklist,
  fixtureDetail,
  fixtureEmailCommunications,
} from "./checklistFixture";
import { linkableThreads } from "../../../utils/checklistLinks";

const detail = fixtureDetail();
const linkOf = (itemIndex: number) => detail.linksByItemId[detail.items[itemIndex].id][0];
const allAttachmentsById = new Map(fixtureAttachments().map((a) => [a.id, a]));
const threads = linkableThreads(fixtureEmailCommunications());

function renderChip(
  itemIndex: number,
  {
    readOnly = false,
    attachmentsById = allAttachmentsById,
    onViewThread = jest.fn().mockResolvedValue(undefined),
    downloadingAttachmentId = null as string | null,
  } = {},
) {
  const onViewAttachment = jest.fn();
  const onRemove = jest.fn().mockResolvedValue(undefined);
  const link = linkOf(itemIndex);
  render(
    <ChecklistLinkChip
      link={link}
      attachmentsById={attachmentsById}
      threads={threads}
      readOnly={readOnly}
      onViewAttachment={onViewAttachment}
      downloadingAttachmentId={downloadingAttachmentId}
      onViewThread={onViewThread}
      onRemove={onRemove}
    />,
  );
  return {
    link,
    onViewAttachment,
    onViewThread,
    onRemove,
    chip: screen.getByTestId(`checklist-link-${link.id}`),
  };
}

describe("ChecklistLinkChip (BACKLOG-3476)", () => {
  it("attachment chip: label from main, size and date; View opens that attachment's row", () => {
    const { chip, onViewAttachment } = renderChip(0);
    expect(chip).toHaveTextContent("probe-document.pdf");
    expect(chip).toHaveTextContent("1.2 MB");
    fireEvent.click(screen.getByTestId("checklist-link-view"));
    expect(onViewAttachment).toHaveBeenCalledTimes(1);
    expect(onViewAttachment.mock.calls[0][0]).toEqual(allAttachmentsById.get("att-1"));
  });

  it("attachment chip while its download runs: View shows it is opening and is disabled", () => {
    renderChip(0, { downloadingAttachmentId: "att-1" });
    expect(screen.getByTestId("checklist-link-view")).toHaveTextContent("Opening…");
    expect(screen.getByTestId("checklist-link-view")).toBeDisabled();
  });

  it("attachment chip whose row is not in this transaction's list: View is disabled", () => {
    const { onViewAttachment } = renderChip(0, { attachmentsById: new Map() });
    fireEvent.click(screen.getByTestId("checklist-link-view"));
    expect(screen.getByTestId("checklist-link-view")).toBeDisabled();
    expect(onViewAttachment).not.toHaveBeenCalled();
  });

  it("live thread chip: email count; View asks for this link's thread and shows it is opening", async () => {
    let finish!: () => void;
    const onViewThread = jest.fn(() => new Promise<void>((r) => (finish = r)));
    const { chip, link } = renderChip(1, { onViewThread });
    expect(chip).toHaveAttribute("data-stale", "false");
    expect(chip).toHaveTextContent("2 emails");
    fireEvent.click(screen.getByTestId("checklist-link-view"));
    expect(onViewThread).toHaveBeenCalledWith(link);
    expect(screen.getByTestId("checklist-link-view")).toHaveTextContent("Opening…");
    await act(async () => finish());
    expect(screen.getByTestId("checklist-link-view")).toHaveTextContent("View");
  });

  it("partly stale thread: still live, keeps its View, says how many left", () => {
    // Fixture: e-solo-1 was unlinked from the transaction, e-solo-2 was not.
    const { chip } = renderChip(2);
    expect(chip).toHaveAttribute("data-stale", "false");
    expect(screen.getByTestId("checklist-link-partly-stale")).toHaveTextContent(
      "1 of 2 emails no longer on this transaction",
    );
    expect(screen.getByTestId("checklist-link-view")).toBeEnabled();
  });

  it("B-3 fully stale: muted, says so, and offers no View", () => {
    const { chip } = renderChip(3);
    expect(chip).toHaveAttribute("data-stale", "true");
    expect(chip).toHaveTextContent("No longer on this transaction");
    expect(screen.queryByTestId("checklist-link-view")).not.toBeInTheDocument();
  });

  it("unlink asks first, then removes that group only", async () => {
    const { link, onRemove } = renderChip(1);
    fireEvent.click(screen.getByTestId("checklist-link-remove"));
    expect(onRemove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("checklist-link-remove-confirm"));
    expect(onRemove).toHaveBeenCalledWith(link.id);
  });

  it("read-only: no unlink, but View is still offered (it only reads)", () => {
    renderChip(1, { readOnly: true });
    expect(screen.queryByTestId("checklist-link-remove")).not.toBeInTheDocument();
    expect(screen.getByTestId("checklist-link-view")).toBeInTheDocument();
  });
});

describe("ChecklistLinkChip — a text group (BACKLOG-3968 PR-4b)", () => {
  // The producer-written text group: the fixture's second checklist, second item.
  const second = fixtureChecklist(1);
  const textLink = second.linksByItemId[second.items[1].id][0];

  function renderText(
    link = textLink,
    {
      textContactNames,
      onViewText,
    }: { textContactNames?: ReadonlyMap<string, string>; onViewText?: (l: typeof textLink) => void } = {},
  ) {
    const onViewThread = jest.fn().mockResolvedValue(undefined);
    const onRemove = jest.fn().mockResolvedValue(undefined);
    render(
      <ChecklistLinkChip
        link={link}
        attachmentsById={allAttachmentsById}
        threads={threads}
        readOnly={false}
        onViewAttachment={jest.fn()}
        downloadingAttachmentId={null}
        onViewThread={onViewThread}
        onRemove={onRemove}
        textContactNames={textContactNames}
        onViewText={onViewText}
      />,
    );
    return { onViewThread, onRemove, chip: screen.getByTestId(`checklist-link-${link.id}`) };
  }

  it("the fixture really holds a live text group of one text (precondition)", () => {
    expect(textLink.kind).toBe("text");
    expect(textLink.members.map((m) => [m.kind, m.messageId, m.emailId, m.inTransaction])).toEqual([
      ["text", "m-1", null, true],
    ]);
  });

  it("reads as texts, not as an email thread: text icon, main's label, a text count, no Thread badge, no View", () => {
    const { chip, onViewThread } = renderText();
    expect(screen.getByTestId("checklist-link-text-icon")).toBeInTheDocument();
    expect(chip).toHaveTextContent(textLink.label);
    expect(textLink.label).toMatch(/^Text · /);
    expect(chip).toHaveTextContent("1 text");
    expect(chip).not.toHaveTextContent(/email/i);
    expect(chip).not.toHaveTextContent("Thread");
    // No text viewer is wired yet (U2): no View to press, and never the email thread.
    expect(screen.queryByTestId("checklist-link-view")).not.toBeInTheDocument();
    expect(onViewThread).not.toHaveBeenCalled();
  });

  it("names the conversation's contact when the tab knows it (U2: the mock's 'Text · <name>' over '<date> · N texts')", () => {
    const { chip } = renderText(textLink, { textContactNames: new Map([["m-1", "Probe Seller"]]) });
    const date = textLink.label.replace(/^Text · /, "");
    expect(date).not.toBe(textLink.label);
    expect(chip).toHaveTextContent(`Text · Probe Seller`);
    expect(chip).toHaveTextContent(`${date} · 1 text`);
    // The persisted label is not repeated as the title once the name is known.
    expect(chip).not.toHaveTextContent(textLink.label);
  });

  it("U2: the text icon is the green TXT mark (kit success token), not the email avatar", () => {
    renderText();
    const icon = screen.getByTestId("checklist-link-text-icon");
    expect(icon).toHaveTextContent("TXT");
    expect(icon.className).toMatch(/\bbg-success-50\b/);
    expect(icon.className).toMatch(/\btext-success-700\b/);
  });

  it("U2: View opens the text group's conversation, never the email thread", () => {
    const onViewText = jest.fn();
    const { onViewThread } = renderText(textLink, { onViewText });
    fireEvent.click(screen.getByTestId("checklist-link-view"));
    expect(onViewText).toHaveBeenCalledWith(textLink);
    expect(onViewThread).not.toHaveBeenCalled();
  });

  it("U2: a stale text group offers no View", () => {
    const stale = { ...textLink, members: textLink.members.map((m) => ({ ...m, inTransaction: false })) };
    renderText(stale, { onViewText: jest.fn() });
    expect(screen.queryByTestId("checklist-link-view")).not.toBeInTheDocument();
  });

  it("a text no longer on the deal reads stale", () => {
    const stale = { ...textLink, members: textLink.members.map((m) => ({ ...m, inTransaction: false })) };
    const { chip } = renderText(stale);
    expect(chip).toHaveAttribute("data-stale", "true");
    expect(chip).toHaveTextContent("No longer on this transaction");
  });

  it("can be removed like any group", async () => {
    const { onRemove } = renderText();
    fireEvent.click(screen.getByTestId("checklist-link-remove"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("checklist-link-remove-confirm"));
    });
    expect(onRemove).toHaveBeenCalledWith(textLink.id);
  });
});
