/**
 * BACKLOG-3476 — the Checklist tab panel: chooser, rows, change template,
 * read-only.
 *
 * Wrong implementations this suite is here to catch:
 *   C-K  "your brokerage has no templates" said when the read FAILED.
 *   C-F  the plain pick passes `replaceExisting` (SVC1); or the change-template
 *        path writes before the confirmation.
 *   C-G  the confirmation does not say what is lost.
 *   C-H  progress recomputed from ticks (counting the optional one).
 *   C-J  read-only still offers writes.
 *   (7.4 SR) a failed `get` rendering "No checklist yet".
 */
import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { TransactionChecklistTab, type TransactionChecklistTabProps } from "../TransactionChecklistTab";
import { useTransactionChecklist } from "../../../hooks/useTransactionChecklist";
import type { StrictFeatureStateOrPending } from "../../../../../hooks/useStrictFeatureState";
import {
  fixtureAttachments,
  fixtureDetail,
  fixtureDetailWithoutLinks,
  fixtureEmailCommunications,
  fixtureTemplates,
} from "./checklistFixture";

jest.mock("../../modals/AttachmentPreviewModal", () => ({ AttachmentPreviewModal: () => null }));

const api = () => window.api.checklists as unknown as Record<string, jest.Mock>;

function Harness({
  gate,
  overrides = {},
}: {
  gate: StrictFeatureStateOrPending;
  overrides?: Partial<TransactionChecklistTabProps>;
}) {
  const checklist = useTransactionChecklist("txn-1");
  return (
    <TransactionChecklistTab
      checklist={checklist}
      gate={gate}
      attachments={fixtureAttachments()}
      attachmentsLoading={false}
      emailCommunications={fixtureEmailCommunications()}
      ensureEmailsLoaded={() => Promise.resolve()}
      onRefreshLinkTargets={jest.fn()}
      onNavigateToTab={jest.fn()}
      onShowSuccess={jest.fn()}
      onShowError={jest.fn()}
      {...overrides}
    />
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  api().get.mockResolvedValue({ success: true, checklist: null });
  api().listTemplates.mockResolvedValue({ success: true, templates: fixtureTemplates(), source: "live" });
  api().selectTemplate.mockResolvedValue({ success: true, result: { status: "selected", checklistId: "c" } });
  api().setItemChecked.mockResolvedValue({ success: true, changed: true });
});

describe("C-K — three sentences for three facts", () => {
  it("a failed read shows main's sentence and Retry, never 'hasn't set up'", async () => {
    api().listTemplates.mockResolvedValue({
      success: false,
      error: "Your brokerage's checklist templates could not be loaded right now.",
    });
    render(<Harness gate="allowed" />);
    expect(await screen.findByTestId("checklist-templates-failed")).toHaveTextContent(
      "could not be loaded right now",
    );
    expect(screen.getByTestId("checklist-templates-retry")).toBeInTheDocument();
    expect(screen.queryByText(/hasn.t set up any checklist templates/)).not.toBeInTheDocument();
  });

  it("an empty catalogue says so, with no Retry", async () => {
    api().listTemplates.mockResolvedValue({ success: true, templates: [], source: "live" });
    render(<Harness gate="allowed" />);
    expect(await screen.findByTestId("checklist-templates-empty")).toHaveTextContent(
      "Your brokerage hasn’t set up any checklist templates yet.",
    );
    expect(screen.queryByTestId("checklist-templates-retry")).not.toBeInTheDocument();
  });

  it("Retry drops the cache, then reads again", async () => {
    api().listTemplates.mockResolvedValueOnce({ success: false, error: "nope" });
    render(<Harness gate="allowed" />);
    fireEvent.click(await screen.findByTestId("checklist-templates-retry"));
    expect(await screen.findByTestId("checklist-template-tpl-probe")).toBeInTheDocument();
    expect(api().invalidateTemplates).toHaveBeenCalledTimes(1);
    expect(api().invalidateTemplates.mock.invocationCallOrder[0]).toBeLessThan(
      api().listTemplates.mock.invocationCallOrder[api().listTemplates.mock.calls.length - 1],
    );
  });

  it("cards show item and required counts; a cached listing says so", async () => {
    api().listTemplates.mockResolvedValue({ success: true, templates: fixtureTemplates(), source: "cache" });
    render(<Harness gate="allowed" />);
    expect(await screen.findByTestId("checklist-template-tpl-probe")).toHaveTextContent("4 items · 2 required");
    expect(screen.getByTestId("checklist-templates-cached")).toBeInTheDocument();
  });

  it("a failed get is an error with Retry, not the chooser", async () => {
    api().get.mockResolvedValue({ success: false, error: "The checklist could not be read." });
    render(<Harness gate="allowed" />);
    expect(await screen.findByTestId("checklist-error")).toHaveTextContent("could not be read");
    expect(screen.queryByText("No checklist yet")).not.toBeInTheDocument();
    expect(api().listTemplates).not.toHaveBeenCalled();
  });
});

describe("C-F — only the confirmation replaces", () => {
  it("a plain pick sends no replaceExisting", async () => {
    render(<Harness gate="allowed" />);
    fireEvent.click(await screen.findByTestId("checklist-template-tpl-probe"));
    await waitFor(() => expect(api().selectTemplate).toHaveBeenCalledTimes(1));
    expect(api().selectTemplate.mock.calls[0][0]).toEqual({
      transactionId: "txn-1",
      templateId: "tpl-probe",
      replaceExisting: undefined,
    });
  });

  it("change template: a pick writes nothing; Go back writes nothing; Replace sends true", async () => {
    api().get.mockResolvedValue({ success: true, checklist: fixtureDetail() });
    render(<Harness gate="allowed" />);
    fireEvent.click(await screen.findByTestId("checklist-change-template"));
    fireEvent.click(await screen.findByTestId("checklist-template-tpl-other"));
    expect(await screen.findByTestId("checklist-replace-confirm")).toBeInTheDocument();
    expect(api().selectTemplate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("checklist-replace-cancel"));
    expect(screen.queryByTestId("checklist-replace-confirm")).not.toBeInTheDocument();
    expect(api().selectTemplate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("checklist-template-tpl-other"));
    fireEvent.click(await screen.findByTestId("checklist-replace-confirm-button"));
    await waitFor(() => expect(api().selectTemplate).toHaveBeenCalledTimes(1));
    expect(api().selectTemplate.mock.calls[0][0]).toEqual({
      transactionId: "txn-1",
      templateId: "tpl-other",
      replaceExisting: true,
    });
  });

  it("the same template is a reset, and says so", async () => {
    api().get.mockResolvedValue({ success: true, checklist: fixtureDetail() });
    render(<Harness gate="allowed" />);
    fireEvent.click(await screen.findByTestId("checklist-change-template"));
    fireEvent.click(await screen.findByTestId("checklist-template-tpl-probe"));
    expect(await screen.findByText("Reset this checklist?")).toBeInTheDocument();
  });
});

describe("C-G — the confirmation names what is lost", () => {
  it("counts ticks, notes and links from the current checklist", async () => {
    // Fixture: items 1 and 3 ticked, item 3 has a note, four link groups.
    api().get.mockResolvedValue({ success: true, checklist: fixtureDetail() });
    render(<Harness gate="allowed" />);
    fireEvent.click(await screen.findByTestId("checklist-change-template"));
    fireEvent.click(await screen.findByTestId("checklist-template-tpl-other"));
    expect(await screen.findByTestId("checklist-replace-loss")).toHaveTextContent(
      "2 ticked items, 1 note and 4 links on “Probe template” will be cleared.",
    );
  });
});

describe("C-H — progress is main's, not a tick count", () => {
  it("an optional tick does not count: 1 of 2 with two items ticked", async () => {
    api().get.mockResolvedValue({ success: true, checklist: fixtureDetail() });
    render(<Harness gate="allowed" />);
    expect(await screen.findByTestId("checklist-progress-text")).toHaveTextContent(/^1 of 2 required done$/);
  });
});

describe("rows", () => {
  it("a tick writes the opposite of the current state, then shows main's answer", async () => {
    const detail = fixtureDetailWithoutLinks();
    api().get.mockResolvedValue({ success: true, checklist: detail });
    render(<Harness gate="allowed" />);
    const second = detail.items[1];
    fireEvent.click(await screen.findByTestId(`checklist-check-${second.id}`));
    await waitFor(() => expect(api().setItemChecked).toHaveBeenCalledWith({ itemId: second.id, checked: true }));
  });

  it("the description sits behind (i); an item without one has none", async () => {
    const detail = fixtureDetailWithoutLinks();
    api().get.mockResolvedValue({ success: true, checklist: detail });
    render(<Harness gate="allowed" />);
    const row1 = await screen.findByTestId(`checklist-item-${detail.items[0].id}`);
    const row2 = screen.getByTestId(`checklist-item-${detail.items[1].id}`);
    expect(row1.querySelectorAll("svg circle").length).toBe(1);
    expect(row2.querySelectorAll("svg circle").length).toBe(0);
  });

  it("a note is saved through main and capped at the schema's 4000", async () => {
    const detail = fixtureDetailWithoutLinks();
    api().get.mockResolvedValue({ success: true, checklist: detail });
    api().setItemNote.mockResolvedValue({ success: true, changed: true });
    render(<Harness gate="allowed" />);
    const item = detail.items[0];
    fireEvent.click(await screen.findByTestId(`checklist-add-note-${item.id}`));
    const box = screen.getByLabelText(`Note for ${item.title}`);
    expect(box).toHaveAttribute("maxLength", "4000");
    fireEvent.change(box, { target: { value: "Generic note." } });
    await act(async () => {
      fireEvent.click(screen.getByTestId(`checklist-note-save-${item.id}`));
    });
    expect(api().setItemNote).toHaveBeenCalledWith({ itemId: item.id, note: "Generic note." });
  });
});

describe("C-J — read-only offers no writes", () => {
  it("blocked: rows and chips render, checkboxes disabled, no Link… / notes / change, Remove offered", async () => {
    api().get.mockResolvedValue({ success: true, checklist: fixtureDetail() });
    render(<Harness gate="blocked" />);
    expect(await screen.findByTestId("checklist-readonly-notice")).toHaveTextContent(
      "aren’t included in your current plan",
    );
    const detail = fixtureDetail();
    for (const item of detail.items) {
      expect(screen.getByTestId(`checklist-check-${item.id}`)).toBeDisabled();
      expect(screen.queryByTestId(`checklist-open-picker-${item.id}`)).not.toBeInTheDocument();
      expect(screen.queryByTestId(`checklist-add-note-${item.id}`)).not.toBeInTheDocument();
      expect(screen.queryByTestId(`checklist-edit-note-${item.id}`)).not.toBeInTheDocument();
    }
    expect(screen.queryByTestId("checklist-change-template")).not.toBeInTheDocument();
    expect(document.querySelectorAll("[data-stale]").length).toBe(4);
    expect(screen.queryByTestId("checklist-link-remove")).not.toBeInTheDocument();
    expect(screen.getByTestId("checklist-remove")).toBeInTheDocument();
  });

  it("unknown: read-only with its own notice and no Remove", async () => {
    api().get.mockResolvedValue({ success: true, checklist: fixtureDetail() });
    render(<Harness gate="unknown" />);
    expect(await screen.findByTestId("checklist-readonly-notice")).toHaveTextContent("couldn’t confirm your plan");
    expect(screen.queryByTestId("checklist-remove")).not.toBeInTheDocument();
  });

  it("Remove confirms, then calls remove for this transaction", async () => {
    api().get.mockResolvedValue({ success: true, checklist: fixtureDetail() });
    render(<Harness gate="blocked" />);
    fireEvent.click(await screen.findByTestId("checklist-remove"));
    expect(api().remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("checklist-remove-confirm"));
    await waitFor(() => expect(api().remove).toHaveBeenCalledWith({ transactionId: "txn-1" }));
  });
});
