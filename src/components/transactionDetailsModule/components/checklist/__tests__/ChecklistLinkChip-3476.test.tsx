/**
 * BACKLOG-3476 — evidence chips (SR condition 7, control C-P).
 *
 * Wrong implementations this suite is here to catch:
 *   - a stale member rendered as live, with a jump that lands nowhere;
 *   - a thread with ONE email unlinked treated as wholly stale, disabling a
 *     jump to the emails that are still there;
 *   - the jump aimed at a member no longer on the transaction.
 * Every link below is taken from the producer-generated fixture.
 */
import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { ChecklistLinkChip } from "../ChecklistLinkChip";
import { fixtureAttachments, fixtureDetail, fixtureEmailCommunications } from "./checklistFixture";
import { linkableThreads } from "../../../utils/checklistLinks";

const detail = fixtureDetail();
const linkOf = (itemIndex: number) => detail.linksByItemId[detail.items[itemIndex].id][0];
const attachmentsById = new Map(fixtureAttachments().map((a) => [a.id, a]));
const threads = linkableThreads(fixtureEmailCommunications());

function renderChip(itemIndex: number, readOnly = false) {
  const onNavigate = jest.fn();
  const onRemove = jest.fn().mockResolvedValue(undefined);
  const link = linkOf(itemIndex);
  render(
    <ChecklistLinkChip
      link={link}
      attachmentsById={attachmentsById}
      threads={threads}
      readOnly={readOnly}
      onNavigate={onNavigate}
      onRemove={onRemove}
    />,
  );
  return { link, onNavigate, onRemove, chip: screen.getByTestId(`checklist-link-${link.id}`) };
}

describe("ChecklistLinkChip (BACKLOG-3476)", () => {
  it("attachment chip: label from main, size and date, jump to Attachments with its id", () => {
    const { chip, onNavigate } = renderChip(0);
    expect(chip).toHaveTextContent("probe-document.pdf");
    expect(chip).toHaveTextContent("1.2 MB");
    fireEvent.click(screen.getByText("Open in Attachments"));
    expect(onNavigate).toHaveBeenCalledWith({
      tab: "attachments",
      highlight: { type: "attachment", attachmentId: "att-1" },
    });
  });

  it("live thread chip: email count and a jump to Emails", () => {
    const { chip, onNavigate } = renderChip(1);
    expect(chip).toHaveAttribute("data-stale", "false");
    expect(chip).toHaveTextContent("2 emails");
    fireEvent.click(screen.getByText("Open in Emails"));
    expect(onNavigate).toHaveBeenCalledWith({
      tab: "emails",
      highlight: { type: "email", emailId: "e-thread-1" },
    });
  });

  it("partly stale thread: still live, jumps to the member still on the transaction, says how many left", () => {
    // Fixture: e-solo-2 was unlinked from the transaction, e-solo-1 was not.
    const { chip, onNavigate } = renderChip(2);
    expect(chip).toHaveAttribute("data-stale", "false");
    expect(screen.getByTestId("checklist-link-partly-stale")).toHaveTextContent(
      "1 of 2 emails no longer on this transaction",
    );
    fireEvent.click(screen.getByText("Open in Emails"));
    expect(onNavigate).toHaveBeenCalledWith({
      tab: "emails",
      highlight: { type: "email", emailId: "e-solo-1" },
    });
  });

  it("fully stale: muted, says so, and offers no jump", () => {
    const { chip } = renderChip(3);
    expect(chip).toHaveAttribute("data-stale", "true");
    expect(chip).toHaveTextContent("No longer on this transaction");
    expect(screen.queryByTestId("checklist-link-jump")).not.toBeInTheDocument();
  });

  it("unlink asks first, then removes that group only", async () => {
    const { link, onRemove } = renderChip(1);
    fireEvent.click(screen.getByTestId("checklist-link-remove"));
    expect(onRemove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("checklist-link-remove-confirm"));
    expect(onRemove).toHaveBeenCalledWith(link.id);
  });

  it("read-only: no unlink", () => {
    renderChip(1, true);
    expect(screen.queryByTestId("checklist-link-remove")).not.toBeInTheDocument();
  });
});
