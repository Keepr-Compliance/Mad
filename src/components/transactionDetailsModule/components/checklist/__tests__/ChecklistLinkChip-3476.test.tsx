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
import { fixtureAttachments, fixtureDetail, fixtureEmailCommunications } from "./checklistFixture";
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
