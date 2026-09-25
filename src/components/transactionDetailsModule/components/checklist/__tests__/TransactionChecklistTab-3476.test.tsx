/**
 * BACKLOG-3476 — the Checklist tab panel: several checklists, each a section,
 * with a chooser, rows, Remove and a read-only state.
 *
 * BACKLOG-3476 round 2: there is no Change. Add + Remove is the only route by
 * which a checklist's template can be swapped, and there is no per-section
 * progress line — only the tab header and Overview sum across every checklist.
 *
 * Wrong implementations this suite is here to catch:
 *   C-K  "no templates have been set up" said when the read FAILED.
 *   C-H / A-5 / A-6  progress recomputed in the renderer (counting optional
 *        ticks, or only the first checklist) instead of main's sums, or a
 *        per-section progress line reappearing.
 *   A-8  a section's Remove or collapse acting on another section.
 *   A-9  a template already on the transaction offered again.
 *   A-10 an add sending a checklist id (SVC1).
 *   G-1  Add offered without the plan, Remove missing where it is due, or
 *        Change offered at all.
 *   Q2   the "open unless every item is ticked" rule implemented as
 *        required-only, as a live derivation, or before the data arrives.
 *   C-J  read-only still offers writes.
 *   B-1 / B-4  an email chip's View opening "whatever the Emails tab groups
 *        with it" instead of the link's own live members, or a stale member.
 *   B-2  an attachment chip's View skipping the on-demand download.
 *   (7.4 SR) a failed `get` rendering "No checklist yet".
 */
import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import {
  ALREADY_ON_TRANSACTION_ERROR,
  TransactionChecklistTab,
  type TransactionChecklistTabProps,
} from "../TransactionChecklistTab";
import { useTransactionChecklist } from "../../../hooks/useTransactionChecklist";
import type { StrictFeatureStateOrPending } from "../../../../../hooks/useStrictFeatureState";
import type { ChecklistDetail } from "../../../../../../electron/types/checklist";
import {
  envelopeOf,
  fixtureAttachments,
  fixtureChecklist,
  fixtureChecklists,
  fixtureDetail,
  fixtureDetailWithoutLinks,
  fixtureEmailCommunications,
  fixtureTemplates,
} from "./checklistFixture";

jest.mock("../../modals/AttachmentPreviewModal", () => ({
  AttachmentPreviewModal: ({ attachment }: { attachment: { filename: string; storage_path: string | null } }) => (
    <div data-testid="preview-modal">
      {attachment.filename}|{attachment.storage_path}
    </div>
  ),
}));
jest.mock("../../modals/EmailThreadViewModal", () => ({
  EmailThreadViewModal: ({
    thread,
    userEmail,
  }: {
    thread: { emails: Array<{ id: string }> };
    userEmail?: string;
  }) => (
    <div data-testid="thread-modal" data-user-email={userEmail}>
      {thread.emails.map((e) => e.id).join(",")}
    </div>
  ),
}));
jest.mock("../../../../../contexts/AuthContext", () => ({
  useAuth: () => ({ currentUser: { id: "user-3476", email: "agent@example.test" } }),
}));

const api = () => window.api.checklists as unknown as Record<string, jest.Mock>;

const onShowError = jest.fn();

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
      onShowSuccess={jest.fn()}
      onShowError={onShowError}
      {...overrides}
    />
  );
}

const answer = (checklists: ChecklistDetail[]) => ({ success: true, checklists: envelopeOf(checklists) });
const answerAll = () => ({ success: true, checklists: fixtureChecklists() });
const idOf = (index: number) => fixtureChecklist(index).checklist.id;
const isOpen = (index: number) =>
  screen.getByTestId(`checklist-section-toggle-${idOf(index)}`).getAttribute("aria-expanded") === "true";

/**
 * "Done probe template" with its optional item unticked: every REQUIRED item
 * ticked, not every item. The state main produces for that checklist one tick
 * earlier (checklistDbService-3475 "Q2" pins `allItemsChecked` false there).
 */
function doneButOptionalOpen(): ChecklistDetail {
  const detail = fixtureChecklist(2);
  const optional = detail.items.find((i) => !i.isRequired)!;
  optional.isChecked = false;
  optional.checkedAt = null;
  detail.allItemsChecked = false;
  return detail;
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  jest.clearAllMocks();
  api().get.mockResolvedValue(answer([]));
  api().listTemplates.mockResolvedValue({ success: true, templates: fixtureTemplates(), source: "live" });
  api().selectTemplate.mockResolvedValue({ success: true, result: { status: "added", checklistId: "c" } });
  api().setItemChecked.mockResolvedValue({ success: true, changed: true });
  api().remove.mockResolvedValue({ success: true, changed: true });
});

describe("C-K — three sentences for three facts", () => {
  it("a failed read shows main's sentence and Retry, never 'hasn't set up'", async () => {
    api().listTemplates.mockResolvedValue({
      success: false,
      error: "Checklist templates couldn't be loaded right now.",
    });
    render(<Harness gate="allowed" />);
    expect(await screen.findByTestId("checklist-templates-failed")).toHaveTextContent(
      "couldn't be loaded right now",
    );
    expect(screen.getByTestId("checklist-templates-retry")).toBeInTheDocument();
    expect(screen.queryByText(/checklist templates have been set up yet/)).not.toBeInTheDocument();
  });

  it("an empty catalogue says so, with no Retry", async () => {
    api().listTemplates.mockResolvedValue({ success: true, templates: [], source: "live" });
    render(<Harness gate="allowed" />);
    expect(await screen.findByTestId("checklist-templates-empty")).toHaveTextContent(
      "No checklist templates have been set up yet.",
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

describe("A-10 / A-9 — adding a checklist", () => {
  it("A-10: the first pick sends exactly {transactionId, templateId}", async () => {
    render(<Harness gate="allowed" />);
    fireEvent.click(await screen.findByTestId("checklist-template-tpl-probe"));
    await waitFor(() => expect(api().selectTemplate).toHaveBeenCalledTimes(1));
    expect(api().selectTemplate.mock.calls[0]).toEqual([{ transactionId: "txn-1", templateId: "tpl-probe" }]);
  });

  it("A-10: Add checklist on a transaction that has some sends no checklist id", async () => {
    api().get.mockResolvedValue(answerAll());
    render(<Harness gate="allowed" />);
    fireEvent.click(await screen.findByTestId("checklist-add"));
    fireEvent.click(await screen.findByTestId("checklist-template-tpl-fresh"));
    await waitFor(() => expect(api().selectTemplate).toHaveBeenCalledTimes(1));
    expect(api().selectTemplate.mock.calls[0]).toEqual([{ transactionId: "txn-1", templateId: "tpl-fresh" }]);
  });

  it("A-9: templates already on the transaction are disabled and marked; clicking one writes nothing", async () => {
    api().get.mockResolvedValue(answerAll());
    render(<Harness gate="allowed" />);
    fireEvent.click(await screen.findByTestId("checklist-add"));
    await screen.findByTestId("checklist-template-tpl-fresh");
    for (const id of ["tpl-probe", "tpl-other", "tpl-done"]) {
      expect(screen.getByTestId(`checklist-template-${id}`)).toBeDisabled();
      expect(screen.getByTestId(`checklist-template-added-${id}`)).toHaveTextContent("Already added");
      fireEvent.click(screen.getByTestId(`checklist-template-${id}`));
    }
    expect(screen.getByTestId("checklist-template-tpl-fresh")).toBeEnabled();
    expect(screen.queryByTestId("checklist-template-added-tpl-fresh")).not.toBeInTheDocument();
    expect(api().selectTemplate).not.toHaveBeenCalled();
  });

  it("an `exists` answer tells the user the checklist is already there", async () => {
    api().get.mockResolvedValue(answer([fixtureChecklist(0)]));
    api().selectTemplate.mockResolvedValue({ success: true, result: { status: "exists", checklistId: "x" } });
    render(<Harness gate="allowed" />);
    fireEvent.click(await screen.findByTestId("checklist-add"));
    fireEvent.click(await screen.findByTestId("checklist-template-tpl-other"));
    await waitFor(() => expect(onShowError).toHaveBeenCalledWith(ALREADY_ON_TRANSACTION_ERROR));
  });
});

describe("C-H / A-5 / A-6 — progress is main's, not a tick count", () => {
  it("one checklist: an optional tick does not count, 1 of 2 with two items ticked", async () => {
    api().get.mockResolvedValue(answer([fixtureDetail()]));
    render(<Harness gate="allowed" />);
    const total = await screen.findByTestId("checklist-total-progress");
    expect(within(total).getByTestId("checklist-progress-text")).toHaveTextContent(/^1 of 2 required done$/);
  });

  it("A-5: the tab header shows main's sum across every checklist, and no section shows its own (round 2: the per-section line is gone)", async () => {
    api().get.mockResolvedValue(answerAll());
    render(<Harness gate="allowed" />);
    const total = await screen.findByTestId("checklist-total-progress");
    expect(within(total).getByTestId("checklist-progress-text")).toHaveTextContent(/^3 of 6 required done$/);
    for (const i of [0, 1, 2]) {
      const section = screen.getByTestId(`checklist-section-${idOf(i)}`);
      expect(within(section).queryByTestId(`checklist-section-progress-${idOf(i)}`)).not.toBeInTheDocument();
      expect(within(section).queryByTestId("checklist-progress-text")).not.toBeInTheDocument();
    }
  });

  it("A-6: when main's envelope differs from a sum of the items, the header follows main", async () => {
    // Deliberately inconsistent, and only here: it separates "renders main's
    // number" from "re-derives it from the rows", which the real fixture
    // cannot (both give 3 of 6).
    api().get.mockResolvedValue({ success: true, checklists: { ...fixtureChecklists(), requiredDone: 4 } });
    render(<Harness gate="allowed" />);
    const total = await screen.findByTestId("checklist-total-progress");
    expect(within(total).getByTestId("checklist-progress-text")).toHaveTextContent(/^4 of 6 required done$/);
  });
});

describe("A-8 — each section acts on itself", () => {
  it("Remove in section 2 removes exactly checklist 2, after its own confirmation", async () => {
    api().get.mockResolvedValue(answerAll());
    render(<Harness gate="allowed" />);
    fireEvent.click(await screen.findByTestId(`checklist-remove-${idOf(1)}`));
    expect(screen.getByTestId(`checklist-remove-prompt-${idOf(1)}`)).toHaveTextContent(
      "Remove “Other probe template”? Its 1 ticked item, 0 notes and 0 links are removed.",
    );
    expect(api().remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId(`checklist-remove-confirm-${idOf(1)}`));
    await waitFor(() => expect(api().remove).toHaveBeenCalledTimes(1));
    expect(api().remove.mock.calls[0]).toEqual([{ transactionId: "txn-1", checklistId: idOf(1) }]);
  });

  it("collapse state follows the checklist, not its position, when an earlier one is removed", async () => {
    api().get.mockResolvedValue(answer([fixtureChecklist(0), fixtureChecklist(1)]));
    render(<Harness gate="allowed" />);
    await screen.findByTestId(`checklist-section-${idOf(1)}`);
    expect([isOpen(0), isOpen(1)]).toEqual([true, true]);
    fireEvent.click(screen.getByTestId(`checklist-section-toggle-${idOf(1)}`));
    expect([isOpen(0), isOpen(1)]).toEqual([true, false]);

    api().get.mockResolvedValue(answer([fixtureChecklist(1)]));
    fireEvent.click(screen.getByTestId(`checklist-remove-${idOf(0)}`));
    fireEvent.click(screen.getByTestId(`checklist-remove-confirm-${idOf(0)}`));
    await waitFor(() => expect(screen.queryByTestId(`checklist-section-${idOf(0)}`)).not.toBeInTheDocument());
    expect(isOpen(1)).toBe(false);
  });
});

describe("G-1 — what each plan state offers with two checklists", () => {
  const two = () => answer([fixtureChecklist(0), fixtureChecklist(1)]);

  it("allowed: Add checklist, Remove on each section, and no Change anywhere (round 2: Change is gone)", async () => {
    api().get.mockResolvedValue(two());
    render(<Harness gate="allowed" />);
    expect(await screen.findByTestId("checklist-add")).toBeInTheDocument();
    for (const i of [0, 1]) {
      expect(screen.getByTestId(`checklist-remove-${idOf(i)}`)).toBeInTheDocument();
      expect(screen.queryByTestId(`checklist-change-${idOf(i)}`)).not.toBeInTheDocument();
    }
  });

  it("blocked: no Add, Remove on each section, no Change", async () => {
    api().get.mockResolvedValue(two());
    render(<Harness gate="blocked" />);
    await screen.findByTestId("checklist-readonly-notice");
    expect(screen.queryByTestId("checklist-add")).not.toBeInTheDocument();
    for (const i of [0, 1]) {
      expect(screen.queryByTestId(`checklist-change-${idOf(i)}`)).not.toBeInTheDocument();
      expect(screen.getByTestId(`checklist-remove-${idOf(i)}`)).toBeInTheDocument();
    }
  });

  it("unknown: no Add, no Change, no Remove", async () => {
    api().get.mockResolvedValue(two());
    render(<Harness gate="unknown" />);
    expect(await screen.findByTestId("checklist-readonly-notice")).toHaveTextContent("couldn’t confirm your plan");
    expect(screen.queryByTestId("checklist-add")).not.toBeInTheDocument();
    for (const i of [0, 1]) {
      expect(screen.queryByTestId(`checklist-change-${idOf(i)}`)).not.toBeInTheDocument();
      expect(screen.queryByTestId(`checklist-remove-${idOf(i)}`)).not.toBeInTheDocument();
    }
  });
});

describe("Q2 — sections open unless every item is ticked", () => {
  it("fixture: the two unfinished checklists open, the fully ticked one collapsed with its rows hidden", async () => {
    api().get.mockResolvedValue(answerAll());
    render(<Harness gate="allowed" />);
    await screen.findByTestId(`checklist-section-${idOf(2)}`);
    expect([isOpen(0), isOpen(1), isOpen(2)]).toEqual([true, true, false]);
    expect(screen.queryByTestId(`checklist-section-body-${idOf(2)}`)).not.toBeInTheDocument();
    expect(screen.getByTestId(`checklist-section-name-${idOf(2)}`)).toHaveTextContent("Done probe template");
  });

  it("Q2-1: every REQUIRED item ticked but an optional one open → expanded", async () => {
    api().get.mockResolvedValue(answer([doneButOptionalOpen()]));
    render(<Harness gate="allowed" />);
    await screen.findByTestId(`checklist-section-${idOf(2)}`);
    expect(isOpen(2)).toBe(true);
  });

  it("Q2-2: ticking the last item keeps the section open; a collapsed section opens on click", async () => {
    api().get.mockResolvedValue(answer([doneButOptionalOpen()]));
    render(<Harness gate="allowed" />);
    await screen.findByTestId(`checklist-section-${idOf(2)}`);
    const optional = doneButOptionalOpen().items.find((i) => !i.isRequired)!;

    api().get.mockResolvedValue(answer([fixtureChecklist(2)]));
    await act(async () => {
      fireEvent.click(screen.getByTestId(`checklist-check-${optional.id}`));
    });
    await waitFor(() => expect(api().get).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByTestId(`checklist-check-${optional.id}`)).toBeChecked(),
    );
    expect(isOpen(2)).toBe(true);

    fireEvent.click(screen.getByTestId(`checklist-section-toggle-${idOf(2)}`));
    expect(isOpen(2)).toBe(false);
    fireEvent.click(screen.getByTestId(`checklist-section-toggle-${idOf(2)}`));
    expect(isOpen(2)).toBe(true);
  });

  it("Q2-3: a fully ticked checklist that arrives after an async load is collapsed", async () => {
    const late = deferred<unknown>();
    api().get.mockReturnValue(late.promise);
    render(<Harness gate="allowed" />);
    expect(await screen.findByTestId("checklist-loading")).toBeInTheDocument();
    await act(async () => {
      late.resolve(answer([fixtureChecklist(0), fixtureChecklist(2)]));
      await late.promise;
    });
    await screen.findByTestId(`checklist-section-${idOf(2)}`);
    expect([isOpen(0), isOpen(2)]).toEqual([true, false]);
  });
});

describe("rows", () => {
  it("a tick writes the opposite of the current state, then shows main's answer", async () => {
    const detail = fixtureDetailWithoutLinks();
    api().get.mockResolvedValue(answer([detail]));
    render(<Harness gate="allowed" />);
    const second = detail.items[1];
    fireEvent.click(await screen.findByTestId(`checklist-check-${second.id}`));
    await waitFor(() => expect(api().setItemChecked).toHaveBeenCalledWith({ itemId: second.id, checked: true }));
  });

  it("the description sits behind (i); an item without one has none", async () => {
    const detail = fixtureDetailWithoutLinks();
    api().get.mockResolvedValue(answer([detail]));
    render(<Harness gate="allowed" />);
    const row1 = await screen.findByTestId(`checklist-item-${detail.items[0].id}`);
    const row2 = screen.getByTestId(`checklist-item-${detail.items[1].id}`);
    expect(row1.querySelectorAll("svg circle").length).toBe(1);
    expect(row2.querySelectorAll("svg circle").length).toBe(0);
  });

  it("a note is saved through main and capped at the schema's 4000", async () => {
    const detail = fixtureDetailWithoutLinks();
    api().get.mockResolvedValue(answer([detail]));
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
  it("blocked: rows and chips render, checkboxes disabled, no Link… / notes / Change / Add", async () => {
    api().get.mockResolvedValue(answer([fixtureDetail()]));
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
    expect(screen.queryByTestId(`checklist-change-${idOf(0)}`)).not.toBeInTheDocument();
    expect(screen.queryByTestId("checklist-add")).not.toBeInTheDocument();
    expect(document.querySelectorAll("[data-stale]").length).toBe(4);
    expect(screen.queryByTestId("checklist-link-remove")).not.toBeInTheDocument();
  });

  it("blocked Remove confirms, then removes that checklist of this transaction", async () => {
    api().get.mockResolvedValue(answer([fixtureDetail()]));
    render(<Harness gate="blocked" />);
    fireEvent.click(await screen.findByTestId(`checklist-remove-${idOf(0)}`));
    expect(api().remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId(`checklist-remove-confirm-${idOf(0)}`));
    await waitFor(() =>
      expect(api().remove).toHaveBeenCalledWith({ transactionId: "txn-1", checklistId: idOf(0) }),
    );
  });
});

describe("B — View on a chip opens the linked item here", () => {
  const chipOf = (itemIndex: number) => {
    const detail = fixtureDetail();
    const link = detail.linksByItemId[detail.items[itemIndex].id][0];
    return screen.getByTestId(`checklist-link-${link.id}`);
  };
  const tx = () => window.api.transactions as unknown as Record<string, jest.Mock>;

  it("B-1: a thread link opens exactly its own emails, with the signed-in user's address", async () => {
    api().get.mockResolvedValue(answer([fixtureDetail()]));
    render(<Harness gate="allowed" />);
    await screen.findByTestId(`checklist-section-${idOf(0)}`);
    fireEvent.click(within(chipOf(1)).getByTestId("checklist-link-view"));
    const modal = await screen.findByTestId("thread-modal");
    expect(modal).toHaveTextContent(/^e-thread-1,e-thread-2$/);
    expect(modal).toHaveAttribute("data-user-email", "agent@example.test");
  });

  it("B-1 / B-4: a partly stale link opens only its live member, not the stale one and not a same-subject email it never held", async () => {
    // Fixture: the link holds e-solo-1 (unlinked from the transaction, sorts
    // first) and e-solo-2. The Emails tab groups e-solo-2 with e-solo-3 by
    // subject; e-solo-3 was never linked.
    api().get.mockResolvedValue(answer([fixtureDetail()]));
    render(<Harness gate="allowed" />);
    await screen.findByTestId(`checklist-section-${idOf(0)}`);
    fireEvent.click(within(chipOf(2)).getByTestId("checklist-link-view"));
    expect(await screen.findByTestId("thread-modal")).toHaveTextContent(/^e-solo-2$/);
  });

  it("View waits for the emails to load before opening", async () => {
    let loaded!: () => void;
    const ensureEmailsLoaded = jest.fn(() => new Promise<void>((r) => (loaded = r)));
    api().get.mockResolvedValue(answer([fixtureDetail()]));
    render(<Harness gate="allowed" overrides={{ ensureEmailsLoaded }} />);
    await screen.findByTestId(`checklist-section-${idOf(0)}`);
    fireEvent.click(within(chipOf(1)).getByTestId("checklist-link-view"));
    expect(screen.queryByTestId("thread-modal")).not.toBeInTheDocument();
    expect(within(chipOf(1)).getByTestId("checklist-link-view")).toHaveTextContent("Opening…");
    await act(async () => loaded());
    expect(await screen.findByTestId("thread-modal")).toHaveTextContent("e-thread-1,e-thread-2");
  });

  it("B-2: a metadata-only email attachment is downloaded once, then previewed, then the list refreshes once", async () => {
    const att = fixtureAttachments().find((a) => a.id === "att-1")!;
    expect(att.storage_path).toBeNull();
    tx().ensureEmailAttachmentDownloaded = jest.fn().mockResolvedValue({
      success: true,
      data: [{ ...att, storage_path: "/data/probe-document.pdf" }],
    });
    const onRefreshLinkTargets = jest.fn();
    api().get.mockResolvedValue(answer([fixtureDetail()]));
    render(<Harness gate="allowed" overrides={{ onRefreshLinkTargets }} />);
    await screen.findByTestId(`checklist-section-${idOf(0)}`);
    fireEvent.click(within(chipOf(0)).getByTestId("checklist-link-view"));
    expect(await screen.findByTestId("preview-modal")).toHaveTextContent(
      "probe-document.pdf|/data/probe-document.pdf",
    );
    expect(tx().ensureEmailAttachmentDownloaded).toHaveBeenCalledTimes(1);
    expect(tx().ensureEmailAttachmentDownloaded).toHaveBeenCalledWith("e-solo-2");
    expect(onRefreshLinkTargets).toHaveBeenCalledTimes(1);
  });

  it("View works in the read-only state too (it only reads)", async () => {
    api().get.mockResolvedValue(answer([fixtureDetail()]));
    render(<Harness gate="blocked" />);
    await screen.findByTestId("checklist-readonly-notice");
    fireEvent.click(within(chipOf(1)).getByTestId("checklist-link-view"));
    expect(await screen.findByTestId("thread-modal")).toBeInTheDocument();
  });
});
