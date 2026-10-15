/**
 * BACKLOG-3910 (slice d, founder 2026-10-12): on a locked deal the Checklist
 * tab is read-only. Add checklist and every tick are disabled with the lock's
 * tooltip; Link, notes, unlinking a group and taking a checklist off are not
 * offered; the chooser never opens. On an open deal everything is as before.
 * The main process refuses the same writes
 * (electron/handlers/__tests__/checklistDealLock-3910d.test.ts).
 */
import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { TransactionChecklistTab, type TransactionChecklistTabProps } from "../TransactionChecklistTab";
import { useTransactionChecklist } from "../../../hooks/useTransactionChecklist";
import type { ChecklistDetail } from "../../../../../../electron/types/checklist";
import { DEAL_LOCK_EDIT_TOOLTIP } from "../../../../../utils/dealLock";
import {
  envelopeOf,
  fixtureAttachments,
  fixtureDetail,
  fixtureEmailCommunications,
  fixtureTemplates,
} from "./checklistFixture";

jest.mock("../../modals/AttachmentPreviewModal", () => ({ AttachmentPreviewModal: () => null }));
jest.mock("../../modals/EmailThreadViewModal", () => ({ EmailThreadViewModal: () => null }));
jest.mock("../../../../../contexts/AuthContext", () => ({
  useAuth: () => ({ currentUser: { id: "user-3910d", email: "agent@example.test" } }),
}));

const api = () => window.api.checklists as unknown as Record<string, jest.Mock>;

function Harness({ overrides = {} }: { overrides?: Partial<TransactionChecklistTabProps> }) {
  const checklist = useTransactionChecklist("txn-1");
  return (
    <TransactionChecklistTab
      checklist={checklist}
      gate="allowed"
      attachments={fixtureAttachments()}
      attachmentsLoading={false}
      emailCommunications={fixtureEmailCommunications()}
      ensureEmailsLoaded={() => Promise.resolve()}
      onRefreshLinkTargets={jest.fn()}
      onShowSuccess={jest.fn()}
      onShowError={jest.fn()}
      {...overrides}
    />
  );
}

const answer = (checklists: ChecklistDetail[]) => ({ success: true, checklists: envelopeOf(checklists) });
const byPrefix = (prefix: string) =>
  Array.from(document.querySelectorAll<HTMLElement>(`[data-testid^="${prefix}"]`));

beforeEach(() => {
  jest.clearAllMocks();
  api().get.mockResolvedValue(answer([fixtureDetail()]));
  api().listTemplates.mockResolvedValue({ success: true, templates: fixtureTemplates(), source: "live" });
  api().setItemChecked.mockResolvedValue({ success: true, changed: true });
});

describe.each([
  ["submitted", DEAL_LOCK_EDIT_TOOLTIP.submitted],
  ["sealed", DEAL_LOCK_EDIT_TOOLTIP.sealed],
] as const)("locked (%s)", (_reason, tooltip) => {
  it("Add checklist and every tick are disabled with the tooltip; no tick is sent", async () => {
    render(<Harness overrides={{ lockedTooltip: tooltip }} />);
    await screen.findByTestId("checklist-panel");

    const add = screen.getByTestId("checklist-add");
    expect(add).toBeDisabled();
    expect(add).toHaveAttribute("title", tooltip);

    const ticks = byPrefix("checklist-check-");
    expect(ticks.length).toBeGreaterThan(0);
    for (const t of ticks) {
      expect(t).toBeDisabled();
      expect(t).toHaveAttribute("title", tooltip);
      fireEvent.click(t);
    }
    await act(async () => {});
    expect(api().setItemChecked).not.toHaveBeenCalled();
  });

  it("Link, notes, unlinking a group and taking a checklist off are not offered", async () => {
    render(<Harness overrides={{ lockedTooltip: tooltip }} />);
    await screen.findByTestId("checklist-panel");
    expect(screen.getByTestId("checklist-locked-notice")).toHaveTextContent(tooltip);
    expect(byPrefix("checklist-open-picker-")).toHaveLength(0);
    expect(byPrefix("checklist-add-note-")).toHaveLength(0);
    expect(byPrefix("checklist-edit-note-")).toHaveLength(0);
    expect(screen.queryAllByTestId("checklist-link-remove")).toHaveLength(0);
    expect(screen.queryByTestId(`checklist-remove-${fixtureDetail().checklist.id}`)).toBeNull();
  });

  it("with no checklist yet: the notice, never the chooser", async () => {
    api().get.mockResolvedValue(answer([]));
    render(<Harness overrides={{ lockedTooltip: tooltip }} />);
    expect(await screen.findByTestId("checklist-locked-notice")).toBeInTheDocument();
    expect(screen.queryByTestId("checklist-chooser")).toBeNull();
    expect(screen.getByTestId("checklist-add")).toBeDisabled();
  });
});

describe("REVERSE: open deal (no lock)", () => {
  it("Add checklist, ticks, Link, notes, unlink and take-off are all offered", async () => {
    render(<Harness />);
    await screen.findByTestId("checklist-panel");
    expect(screen.getByTestId("checklist-add")).toBeEnabled();
    expect(screen.queryByTestId("checklist-locked-notice")).toBeNull();

    const ticks = byPrefix("checklist-check-");
    expect(ticks.length).toBeGreaterThan(0);
    for (const t of ticks) expect(t).toBeEnabled();
    expect(byPrefix("checklist-open-picker-").length).toBeGreaterThan(0);
    expect(screen.queryAllByTestId("checklist-link-remove").length).toBeGreaterThan(0);
    expect(screen.getByTestId(`checklist-remove-${fixtureDetail().checklist.id}`)).toBeInTheDocument();

    fireEvent.click(ticks[0]);
    await waitFor(() => expect(api().setItemChecked).toHaveBeenCalledTimes(1));
  });

  it("with no checklist yet: the chooser", async () => {
    api().get.mockResolvedValue(answer([]));
    render(<Harness />);
    expect(await screen.findByTestId("checklist-chooser")).toBeInTheDocument();
  });
});
