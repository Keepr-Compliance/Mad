/**
 * BACKLOG-3968 U2 x BACKLOG-3966 U1 — merged tree: linking from a My item on a
 * plan WITHOUT checklists (gate "blocked", deal not locked). The picker, its
 * Texts tab and linkText must be reachable from a My item; a template item stays
 * off; a locked deal turns both off.
 *
 * Data: the producer-written fixture's checklistsWithMyItems (3476 fixture file).
 */
import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { TransactionChecklistTab } from "../TransactionChecklistTab";
import { useTransactionChecklist } from "../../../hooks/useTransactionChecklist";
import { fixtureAttachments, fixtureChecklistsWithMyItems, fixtureEmailCommunications } from "./checklistFixture";
import captured from "./fixtures/textPage-3968.json";

jest.mock("../../modals/AttachmentPreviewModal", () => ({ AttachmentPreviewModal: () => null }));
jest.mock("../../modals/EmailThreadViewModal", () => ({ EmailThreadViewModal: () => null }));
jest.mock("../../modals/ConversationViewModal", () => ({ ConversationViewModal: () => null }));
jest.mock("../../../../../contexts/AuthContext", () => ({
  useAuth: () => ({ currentUser: { id: "user-3476", email: "agent@example.test" } }),
}));

const checklists = () => window.api.checklists as unknown as Record<string, jest.Mock>;
const transactions = () => window.api.transactions as unknown as Record<string, jest.Mock>;
const contacts = () => window.api.contacts as unknown as Record<string, jest.Mock>;

const envelope = fixtureChecklistsWithMyItems();
const myDetail = envelope.checklists.find((d) => d.checklist.isPrivate)!;
const templateDetail = envelope.checklists.find((d) => !d.checklist.isPrivate)!;
const myItem = myDetail.items[0];
const templateItem = templateDetail.items[0];
const ROW = captured.rows[0];

function Harness({ gate, lockedTooltip }: { gate: "allowed" | "blocked"; lockedTooltip?: string }) {
  const checklist = useTransactionChecklist(myDetail.checklist.transactionId);
  return (
    <TransactionChecklistTab
      checklist={checklist}
      gate={gate}
      lockedTooltip={lockedTooltip}
      attachments={fixtureAttachments()}
      attachmentsLoading={false}
      emailCommunications={fixtureEmailCommunications()}
      ensureEmailsLoaded={() => Promise.resolve()}
      onRefreshLinkTargets={jest.fn()}
      onShowSuccess={jest.fn()}
      onShowError={jest.fn()}
    />
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  checklists().get.mockResolvedValue({ success: true, checklists: envelope });
  checklists().listTemplates.mockResolvedValue({ success: true, templates: [], source: "live" });
  checklists().addLink.mockResolvedValue({ success: true, result: { status: "added", linkId: "l-new", memberCount: 1 } });
  transactions().getTextThreads.mockResolvedValue({ success: true, threads: [captured.thread] });
  transactions().getTextThreadPage.mockResolvedValue({ success: true, rows: captured.rows, nextCursor: null });
  transactions().findTextThread.mockResolvedValue({ success: true, threadKey: captured.thread.threadId });
  contacts().resolveHandles.mockResolvedValue({ success: true, names: { [ROW.sender]: "Probe Buyer" } });
});

it("precondition: the fixture has a My items checklist and a template checklist", () => {
  expect(myDetail.checklist.isPrivate).toBe(true);
  expect(templateDetail.checklist.isPrivate).toBe(false);
});

it("plan without checklists, deal open: Link… on a My item opens the picker, Texts tab usable, linkText reached; template item has no Link…", async () => {
  render(<Harness gate="blocked" />);
  expect(await screen.findByTestId("checklist-readonly-notice")).toBeInTheDocument();
  expect(screen.queryByTestId(`checklist-open-picker-${templateItem.id}`)).not.toBeInTheDocument();
  fireEvent.click(await screen.findByTestId(`checklist-open-picker-${myItem.id}`));
  fireEvent.click(await screen.findByTestId("checklist-picker-tab-texts"));
  fireEvent.click(await screen.findByTestId(`checklist-picker-text-${ROW.id}`));
  await act(async () => {
    fireEvent.click(screen.getByTestId("checklist-picker-link"));
  });
  expect(checklists().addLink).toHaveBeenCalledTimes(1);
  expect(checklists().addLink).toHaveBeenCalledWith({ itemId: myItem.id, kind: "text", targetIds: [ROW.id] });
});

it("locked deal: Link… is off on a My item and on a template item, on an allowed plan and on a plan without checklists", async () => {
  for (const gate of ["allowed", "blocked"] as const) {
    const { unmount } = render(<Harness gate={gate} lockedTooltip="This deal is locked" />);
    await screen.findByTestId("checklist-panel");
    expect(screen.queryByTestId(`checklist-open-picker-${myItem.id}`)).not.toBeInTheDocument();
    expect(screen.queryByTestId(`checklist-open-picker-${templateItem.id}`)).not.toBeInTheDocument();
    expect(screen.queryByTestId("checklist-picker-tab-texts")).not.toBeInTheDocument();
    unmount();
  }
});

it("the deal locks while the picker is open on a My item: the picker goes away (the lock gate on the picker itself)", async () => {
  const { rerender } = render(<Harness gate="blocked" />);
  fireEvent.click(await screen.findByTestId(`checklist-open-picker-${myItem.id}`));
  expect(await screen.findByTestId("checklist-picker-tab-texts")).toBeInTheDocument();
  rerender(<Harness gate="blocked" lockedTooltip="This deal is locked" />);
  expect(screen.queryByTestId("checklist-picker-tab-texts")).not.toBeInTheDocument();
});
