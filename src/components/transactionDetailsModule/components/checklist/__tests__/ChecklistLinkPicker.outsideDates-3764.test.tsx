/**
 * BACKLOG-3764 — the link picker asks before linking evidence dated outside
 * the deal's audit dates (founder decision, pm_comments on BACKLOG-3764).
 *
 * Main decides "outside" and answers `outside_dates` (writing nothing); the
 * picker only words the question and repeats the request with the answer.
 *
 *   C4  the picker still OFFERS out-of-dates evidence (the wrong fix "filter
 *       the picker so it cannot be linked" hides it instead of asking).
 *   Q1  outside_dates -> the founder's sentence, nothing reported as linked.
 *   Q2  Include it -> the same group again, with includeOutsideDates.
 *   Q3  Don't link -> no second request; the picker says nothing was linked.
 */
import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { ChecklistLinkPicker } from "../ChecklistLinkPicker";
import type { ChecklistLinkOutcome, ChecklistLinkRequest } from "../../../hooks/useTransactionChecklist";
import { linkableAttachments } from "../../../utils/checklistLinks";
import { outsideDatesSentence, includeAnywayQuestion } from "../../../utils/outsideAuditDatesCopy";
import { fixtureAttachments, fixtureDetail, fixtureEmailCommunications } from "./checklistFixture";

jest.mock("../../modals/AttachmentPreviewModal", () => ({
  AttachmentPreviewModal: () => null,
}));
jest.mock("../../modals/EmailThreadViewModal", () => ({
  EmailThreadViewModal: () => null,
}));

const detail = fixtureDetail();
const freshItem = detail.items[3];

/** `addChecklistLink`'s outside_dates answer, as main returns it. */
const outsideAnswer = (id: string): ChecklistLinkOutcome["result"] => ({
  success: true,
  data: {
    status: "outside_dates",
    outside: [{ id, sentAt: "2026-10-03T15:00:00.000Z" }],
    auditStart: "2026-09-01",
    auditEnd: "2026-09-30",
  },
});
const added = (): ChecklistLinkOutcome["result"] => ({
  success: true,
  data: { status: "added", linkId: "l", memberCount: 1 },
});

function renderPicker(onLinkImpl: (r: ChecklistLinkRequest[]) => Promise<ChecklistLinkOutcome[]>) {
  const onLink = jest.fn(onLinkImpl);
  const props = { onClose: jest.fn(), onShowSuccess: jest.fn(), onShowError: jest.fn(), onRefreshTargets: jest.fn() };
  render(
    <ChecklistLinkPicker
      item={freshItem}
      templateName={detail.checklist.templateName}
      existingLinks={[]}
      attachments={fixtureAttachments()}
      attachmentsLoading={false}
      emailCommunications={fixtureEmailCommunications()}
      ensureEmailsLoaded={() => Promise.resolve()}
      onLink={onLink}
      {...props}
    />,
  );
  return { onLink, ...props };
}

const settle = () => act(async () => {});

describe("BACKLOG-3764 — out-of-dates evidence in the link picker", () => {
  it("the founder's sentence, word for word", () => {
    expect(`${outsideDatesSentence("email", "2026-10-03T15:00:00.000Z", "2026-09-01", "2026-09-30")} ${includeAnywayQuestion(1)}`).toBe(
      "This email is from Oct 3, outside this deal's audit dates (Sep 1 – Sep 30). Include it in the submission anyway?",
    );
  });

  it("C4: evidence dated far outside any deal's dates is still offered", async () => {
    const rows = fixtureAttachments().map((a) => ({ ...a, source_date: "2031-01-15T12:00:00.000Z" }));
    expect(linkableAttachments(rows).map((a) => a.id)).toEqual(rows.filter((a) => a.email_id || a.message_id).map((a) => a.id));
    expect(linkableAttachments(rows).length).toBeGreaterThan(0);
  });

  it("Q1 + Q2: outside_dates asks; Include it repeats the request with includeOutsideDates", async () => {
    const { onLink, onShowSuccess, onClose } = renderPicker(async (reqs) =>
      reqs.map((request) => ({ request, result: request.includeOutsideDates ? added() : outsideAnswer("att-1") })),
    );
    await settle();
    fireEvent.click(screen.getByTestId("checklist-picker-attachment-att-1"));
    fireEvent.click(screen.getByTestId("checklist-picker-link"));
    await waitFor(() => expect(screen.getByTestId("checklist-outside-dates-question")).toBeInTheDocument());
    expect(screen.getByTestId("checklist-outside-dates-sentence")).toHaveTextContent(
      "This file is from Oct 3, outside this deal's audit dates (Sep 1 – Sep 30). Include it in the submission anyway?",
    );
    expect(onShowSuccess).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("checklist-outside-dates-include"));
    await waitFor(() => expect(onLink).toHaveBeenCalledTimes(2));
    expect(onLink.mock.calls[1][0]).toEqual([{ kind: "attachment", targetIds: ["att-1"], includeOutsideDates: true }]);
    await waitFor(() => expect(onShowSuccess).toHaveBeenCalledWith("Linked to checklist item"));
    expect(onClose).toHaveBeenCalled();
  });

  it("Q3: Don't link sends nothing more and says nothing was linked", async () => {
    const { onLink, onShowSuccess, onClose } = renderPicker(async (reqs) =>
      reqs.map((request) => ({ request, result: outsideAnswer("att-1") })),
    );
    await settle();
    fireEvent.click(screen.getByTestId("checklist-picker-attachment-att-1"));
    fireEvent.click(screen.getByTestId("checklist-picker-link"));
    await waitFor(() => expect(screen.getByTestId("checklist-outside-dates-decline")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("checklist-outside-dates-decline"));
    expect(onLink).toHaveBeenCalledTimes(1);
    expect(onShowSuccess).toHaveBeenCalledWith("Not linked");
    expect(onClose).toHaveBeenCalled();
  });

  it("several groups in one pick: one question listing them; an in-dates group links at once", async () => {
    const { onLink } = renderPicker(async (reqs) =>
      reqs.map((request) => ({
        request,
        result: request.targetIds[0] === "att-2" ? added() : outsideAnswer(request.targetIds[0]),
      })),
    );
    await settle();
    fireEvent.click(screen.getByTestId("checklist-picker-attachment-att-1"));
    fireEvent.click(screen.getByTestId("checklist-picker-attachment-att-2"));
    fireEvent.click(screen.getByTestId("checklist-picker-attachment-att-text"));
    fireEvent.click(screen.getByTestId("checklist-picker-link"));
    await waitFor(() => expect(screen.getByTestId("checklist-outside-dates-list")).toBeInTheDocument());
    expect(screen.getByTestId("checklist-outside-dates-sentence")).toHaveTextContent(
      "These are outside this deal's audit dates (Sep 1 – Sep 30). Include them in the submission anyway?",
    );
    expect(screen.getByTestId("checklist-outside-dates-list").querySelectorAll("li")).toHaveLength(2);
    expect(screen.getByTestId("checklist-outside-dates-include")).toHaveTextContent("Include them");
    expect(onLink).toHaveBeenCalledTimes(1);
  });
});
