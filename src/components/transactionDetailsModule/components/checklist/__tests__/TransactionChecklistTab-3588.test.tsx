/**
 * BACKLOG-3588 — pick several checklist templates at once.
 *
 * Runs the real tab + real useTransactionChecklist + real chooser against the
 * mocked preload bridge, so "the succeeded row becomes Already added" is
 * produced the way the app produces it: by the reload inside `afterWrite`
 * after each add, not by the chooser guessing.
 *
 * Wrong implementations this suite is here to catch:
 *   PAR   the batch sent with Promise.all (every add in flight at once, so the
 *         order main sees is not the list's, and two writes race the UNIQUE).
 *   STOP  the batch abandoned at the first failure.
 *   ORD   the batch sent in the order the boxes were ticked, not list order.
 *   UNM   the chooser swapped for the panel after the first add when the
 *         transaction had no checklist, losing the result sentence.
 *   CNT   the button counting a ticked template that is already added.
 *   EXI   an `exists` answer counted as a failure, or shown as an error toast
 *         (founder decision D1: it counts as added, no toast).
 *   RRD   a batch with a failure not reading the templates again.
 *   STK   every add failing on a transaction with no checklist, and the
 *         chooser the batch opened staying open after a checklist arrives.
 */
import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { TransactionChecklistTab } from "../TransactionChecklistTab";
import { useTransactionChecklist } from "../../../hooks/useTransactionChecklist";
import type { ChecklistDetail } from "../../../../../../electron/types/checklist";
import {
  envelopeOf,
  fixtureAttachments,
  fixtureChecklist,
  fixtureEmailCommunications,
  fixtureItem,
  fixtureTemplates,
} from "./checklistFixture";
import { ChecklistItemRow } from "../ChecklistItemRow";
import { ChecklistTemplateChooser } from "../ChecklistTemplateChooser";
import type { ChecklistTemplate } from "../../../../../../electron/types/checklist";

jest.mock("../../../../../contexts/AuthContext", () => ({
  useAuth: () => ({ currentUser: { id: "user-3588", email: "agent@example.test" } }),
}));

const api = () => window.api.checklists as unknown as Record<string, jest.Mock>;
const onShowError = jest.fn();

function Harness() {
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
      onShowError={onShowError}
    />
  );
}

const answer = (checklists: ChecklistDetail[]) => ({ success: true, checklists: envelopeOf(checklists) });
const added = { success: true, result: { status: "added", checklistId: "c" } };
const refused = { success: false, error: "The checklist could not be started." };
const exists = { success: true, result: { status: "exists", checklistId: "x" } };
const ALREADY_ON_TRANSACTION = "That checklist is already on this transaction.";

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const check = (id: string) => screen.getByTestId(`checklist-template-check-${id}`);
const addButton = () => screen.getByTestId("checklist-chooser-add");
const count = () => screen.getByTestId("checklist-chooser-count");
const sentTemplateIds = () =>
  api().selectTemplate.mock.calls.map((c: [{ templateId: string }]) => c[0].templateId);

/**
 * Main's `get` answers as the database would: every template added so far
 * becomes a checklist on the transaction. Fixture checklists 0/1 are
 * tpl-probe / tpl-other (checklistFixture's `templateId`s).
 */
function databaseLike() {
  const onTransaction: ChecklistDetail[] = [];
  const byTemplate: Record<string, ChecklistDetail> = {
    "tpl-probe": fixtureChecklist(0),
    "tpl-other": fixtureChecklist(1),
  };
  api().get.mockImplementation(() => Promise.resolve(answer([...onTransaction])));
  return {
    record(templateId: string) {
      onTransaction.push(byTemplate[templateId]);
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  api().get.mockResolvedValue(answer([]));
  api().listTemplates.mockResolvedValue({ success: true, templates: fixtureTemplates(), source: "live" });
  api().selectTemplate.mockResolvedValue(added);
});

describe("ticking", () => {
  it("updates the count and the button label; the button is disabled at none", async () => {
    render(<Harness />);
    await screen.findByTestId("checklist-template-tpl-probe");
    expect(count()).toHaveTextContent("0 selected");
    expect(addButton()).toBeDisabled();

    fireEvent.click(check("tpl-probe"));
    expect(check("tpl-probe")).toHaveAttribute("aria-checked", "true");
    expect(count()).toHaveTextContent("1 selected");
    expect(addButton()).toHaveTextContent(/^Add checklist$/);
    expect(addButton()).toBeEnabled();

    fireEvent.click(check("tpl-other"));
    expect(count()).toHaveTextContent("2 selected");
    expect(addButton()).toHaveTextContent(/^Add 2 checklists$/);

    fireEvent.click(check("tpl-probe"));
    fireEvent.click(check("tpl-other"));
    expect(count()).toHaveTextContent("0 selected");
    expect(addButton()).toBeDisabled();
    expect(api().selectTemplate).not.toHaveBeenCalled();
  });

  it("clicking a row's name ticks it (the row is the checkbox's label)", async () => {
    render(<Harness />);
    fireEvent.click(await screen.findByText("Fresh probe template"));
    expect(check("tpl-fresh")).toHaveAttribute("aria-checked", "true");
    expect(count()).toHaveTextContent("1 selected");
  });

  it("CNT: an already-added row cannot be ticked, by its box or its row, and is not counted", async () => {
    api().get.mockResolvedValue(answer([fixtureChecklist(0)]));
    render(<Harness />);
    fireEvent.click(await screen.findByTestId("checklist-add"));
    await screen.findByTestId("checklist-template-tpl-probe");
    expect(check("tpl-probe")).toBeDisabled();
    expect(screen.getByTestId("checklist-template-added-tpl-probe")).toHaveTextContent("Already added");
    fireEvent.click(check("tpl-probe"));
    fireEvent.click(screen.getByTestId("checklist-template-tpl-probe"));
    expect(check("tpl-probe")).toHaveAttribute("aria-checked", "false");
    expect(count()).toHaveTextContent("0 selected");
    expect(addButton()).toBeDisabled();
  });

  it("the entry button still reads Add checklist", async () => {
    api().get.mockResolvedValue(answer([fixtureChecklist(0)]));
    render(<Harness />);
    expect(await screen.findByTestId("checklist-add")).toHaveTextContent(/^Add checklist$/);
  });
});

describe("CNT — a ticked template that becomes already-added drops out", () => {
  // In the tab today nothing reloads the list while the chooser is open, so
  // this is driven through the chooser's own contract: `disabledTemplateIds`
  // changing under a ticked row.
  it("the count, the label and the batch all leave it out", async () => {
    const onAdd = jest.fn((_t: ChecklistTemplate) => Promise.resolve(true));
    const props = { mode: "add" as const, onAdd, onAllAdded: jest.fn(), onCancel: jest.fn() };
    const { rerender } = render(<ChecklistTemplateChooser {...props} disabledTemplateIds={new Set<string>()} />);
    await screen.findByTestId("checklist-template-tpl-fresh");
    fireEvent.click(check("tpl-probe"));
    fireEvent.click(check("tpl-fresh"));
    expect(count()).toHaveTextContent("2 selected");
    rerender(<ChecklistTemplateChooser {...props} disabledTemplateIds={new Set(["tpl-probe"])} />);
    expect(count()).toHaveTextContent("1 selected");
    expect(addButton()).toHaveTextContent(/^Add checklist$/);
    expect(check("tpl-probe")).toHaveAttribute("aria-checked", "false");
    fireEvent.click(addButton());
    await waitFor(() => expect(props.onAllAdded).toHaveBeenCalledTimes(1));
    expect(onAdd.mock.calls.map((c) => c[0].id)).toEqual(["tpl-fresh"]);
  });
});

describe("adding several", () => {
  it("PAR / ORD: sends them one at a time, in LIST order, not tick order", async () => {
    const first = deferred<typeof added>();
    api().selectTemplate.mockReturnValueOnce(first.promise).mockResolvedValue(added);
    render(<Harness />);
    await screen.findByTestId("checklist-template-tpl-other");
    // Ticked in the opposite order to the list.
    fireEvent.click(check("tpl-other"));
    fireEvent.click(check("tpl-probe"));
    fireEvent.click(addButton());

    await waitFor(() => expect(api().selectTemplate).toHaveBeenCalledTimes(1));
    // The second add must not start while the first is unanswered.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(api().selectTemplate).toHaveBeenCalledTimes(1);
    expect(addButton()).toHaveTextContent("Adding…");
    expect(addButton()).toBeDisabled();
    expect(check("tpl-fresh")).toBeDisabled();

    await act(async () => {
      first.resolve(added);
    });
    await waitFor(() => expect(api().selectTemplate).toHaveBeenCalledTimes(2));
    expect(sentTemplateIds()).toEqual(["tpl-probe", "tpl-other"]);
    for (const call of api().selectTemplate.mock.calls) {
      expect(Object.keys(call[0]).sort()).toEqual(["templateId", "transactionId"]);
    }
  });

  it("Cancel is disabled while adding", async () => {
    api().get.mockResolvedValue(answer([fixtureChecklist(0)]));
    const first = deferred<typeof added>();
    api().selectTemplate.mockReturnValueOnce(first.promise);
    render(<Harness />);
    fireEvent.click(await screen.findByTestId("checklist-add"));
    fireEvent.click(await screen.findByTestId("checklist-template-check-tpl-fresh"));
    expect(screen.getByTestId("checklist-chooser-cancel")).toBeEnabled();
    fireEvent.click(addButton());
    await waitFor(() => expect(screen.getByTestId("checklist-chooser-cancel")).toBeDisabled());
    await act(async () => {
      first.resolve(added);
    });
  });

  it("all added: the chooser closes onto the checklists", async () => {
    const db = databaseLike();
    api().selectTemplate.mockImplementation(({ templateId }: { templateId: string }) => {
      db.record(templateId);
      return Promise.resolve(added);
    });
    render(<Harness />);
    await screen.findByTestId("checklist-template-tpl-other");
    fireEvent.click(check("tpl-probe"));
    fireEvent.click(check("tpl-other"));
    fireEvent.click(addButton());
    expect(await screen.findByTestId("checklist-panel")).toBeInTheDocument();
    expect(screen.queryByTestId("checklist-chooser")).not.toBeInTheDocument();
    expect(sentTemplateIds()).toEqual(["tpl-probe", "tpl-other"]);
  });
});

describe("partial failure", () => {
  it("UNM: the added one turns Already added, the failed one stays ticked, and the sentence names it", async () => {
    // Starts with NO checklist, so the first add flips the tab out of "pick".
    const db = databaseLike();
    api().selectTemplate.mockImplementation(({ templateId }: { templateId: string }) => {
      if (templateId === "tpl-other") return Promise.resolve(refused);
      db.record(templateId);
      return Promise.resolve(added);
    });
    render(<Harness />);
    await screen.findByTestId("checklist-template-tpl-other");
    fireEvent.click(check("tpl-probe"));
    fireEvent.click(check("tpl-other"));
    fireEvent.click(addButton());

    expect(await screen.findByTestId("checklist-add-result")).toHaveTextContent(
      'Added 1 of 2 checklists. Couldn\'t add "Other probe template" — try again.',
    );
    expect(screen.getByTestId("checklist-chooser")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId("checklist-template-added-tpl-probe")).toHaveTextContent("Already added"),
    );
    expect(check("tpl-probe")).toBeDisabled();
    expect(check("tpl-other")).toHaveAttribute("aria-checked", "true");
    expect(check("tpl-other")).toBeEnabled();
    expect(screen.queryByTestId("checklist-template-added-tpl-other")).not.toBeInTheDocument();
    expect(count()).toHaveTextContent("1 selected");
    expect(addButton()).toHaveTextContent(/^Add checklist$/);
    // Something is on the transaction now, so there is somewhere to go back to.
    expect(screen.getByTestId("checklist-chooser-cancel")).toBeEnabled();
    // Main's own reason is still shown.
    expect(onShowError).toHaveBeenCalledWith("The checklist could not be started.");
  });

  it("STOP: a failure on the first does not stop the second", async () => {
    const db = databaseLike();
    api().selectTemplate.mockImplementation(({ templateId }: { templateId: string }) => {
      if (templateId === "tpl-probe") return Promise.resolve(refused);
      db.record(templateId);
      return Promise.resolve(added);
    });
    render(<Harness />);
    await screen.findByTestId("checklist-template-tpl-other");
    fireEvent.click(check("tpl-probe"));
    fireEvent.click(check("tpl-other"));
    fireEvent.click(addButton());
    expect(await screen.findByTestId("checklist-add-result")).toHaveTextContent(
      'Added 1 of 2 checklists. Couldn\'t add "Probe template" — try again.',
    );
    expect(sentTemplateIds()).toEqual(["tpl-probe", "tpl-other"]);
    await waitFor(() => expect(screen.getByTestId("checklist-template-added-tpl-other")).toBeInTheDocument());
    expect(check("tpl-probe")).toHaveAttribute("aria-checked", "true");
  });

  it("several failures are all named", async () => {
    const db = databaseLike();
    api().selectTemplate.mockImplementation(({ templateId }: { templateId: string }) => {
      if (templateId === "tpl-probe") {
        db.record(templateId);
        return Promise.resolve(added);
      }
      return Promise.resolve(refused);
    });
    render(<Harness />);
    await screen.findByTestId("checklist-template-tpl-fresh");
    for (const id of ["tpl-probe", "tpl-other", "tpl-done", "tpl-fresh"]) fireEvent.click(check(id));
    fireEvent.click(addButton());
    expect(await screen.findByTestId("checklist-add-result")).toHaveTextContent(
      'Added 1 of 4 checklists. Couldn\'t add "Other probe template", "Done probe template" and "Fresh probe template" — try again.',
    );
  });

  it("all fail: says none were added, and every one stays ticked", async () => {
    api().selectTemplate.mockResolvedValue(refused);
    render(<Harness />);
    await screen.findByTestId("checklist-template-tpl-other");
    fireEvent.click(check("tpl-probe"));
    fireEvent.click(check("tpl-other"));
    fireEvent.click(addButton());
    expect(await screen.findByTestId("checklist-add-result")).toHaveTextContent(
      "Couldn't add any of the 2 checklists — try again.",
    );
    await screen.findByTestId("checklist-template-tpl-other");
    expect(check("tpl-probe")).toHaveAttribute("aria-checked", "true");
    expect(check("tpl-other")).toHaveAttribute("aria-checked", "true");
    expect(addButton()).toHaveTextContent(/^Add 2 checklists$/);
  });

  it("one ticked and it fails: names it", async () => {
    api().selectTemplate.mockResolvedValue(refused);
    render(<Harness />);
    await screen.findByTestId("checklist-template-tpl-probe");
    fireEvent.click(check("tpl-probe"));
    fireEvent.click(addButton());
    expect(await screen.findByTestId("checklist-add-result")).toHaveTextContent(
      'Couldn\'t add "Probe template" — try again.',
    );
  });
});

describe("EXI — an `exists` answer in a batch counts as added (D1)", () => {
  it("second of two answers exists: the chooser closes, no result line, no toast", async () => {
    // `exists` means main found it on the transaction, so the reload shows it.
    const db = databaseLike();
    api().selectTemplate.mockImplementation(({ templateId }: { templateId: string }) => {
      db.record(templateId);
      return Promise.resolve(templateId === "tpl-other" ? exists : added);
    });
    render(<Harness />);
    await screen.findByTestId("checklist-template-tpl-other");
    fireEvent.click(check("tpl-probe"));
    fireEvent.click(check("tpl-other"));
    fireEvent.click(addButton());
    expect(await screen.findByTestId("checklist-panel")).toBeInTheDocument();
    expect(screen.queryByTestId("checklist-chooser")).not.toBeInTheDocument();
    expect(screen.queryByTestId("checklist-add-result")).not.toBeInTheDocument();
    expect(sentTemplateIds()).toEqual(["tpl-probe", "tpl-other"]);
    expect(onShowError).not.toHaveBeenCalled();
  });

  it("with a failure beside it: the exists row reads Already added and is not named as failed", async () => {
    const db = databaseLike();
    api().selectTemplate.mockImplementation(({ templateId }: { templateId: string }) => {
      if (templateId === "tpl-other") return Promise.resolve(refused);
      db.record(templateId);
      return Promise.resolve(exists);
    });
    render(<Harness />);
    await screen.findByTestId("checklist-template-tpl-other");
    fireEvent.click(check("tpl-probe"));
    fireEvent.click(check("tpl-other"));
    fireEvent.click(addButton());
    expect(await screen.findByTestId("checklist-add-result")).toHaveTextContent(
      'Added 1 of 2 checklists. Couldn\'t add "Other probe template" — try again.',
    );
    await waitFor(() =>
      expect(screen.getByTestId("checklist-template-added-tpl-probe")).toHaveTextContent("Already added"),
    );
    expect(onShowError).not.toHaveBeenCalledWith(ALREADY_ON_TRANSACTION);
    expect(onShowError).toHaveBeenCalledTimes(1);
    expect(onShowError).toHaveBeenCalledWith("The checklist could not be started.");
  });
});

describe("RRD — a batch with a failure reads the templates again", () => {
  it("listTemplates is called once more after the batch, not before", async () => {
    api().selectTemplate.mockResolvedValue(refused);
    render(<Harness />);
    await screen.findByTestId("checklist-template-tpl-probe");
    expect(api().listTemplates).toHaveBeenCalledTimes(1);
    fireEvent.click(check("tpl-probe"));
    fireEvent.click(addButton());
    await screen.findByTestId("checklist-add-result");
    await waitFor(() => expect(api().listTemplates).toHaveBeenCalledTimes(2));
    expect(api().listTemplates.mock.invocationCallOrder[1]).toBeGreaterThan(
      api().selectTemplate.mock.invocationCallOrder[0],
    );
  });

  it("an all-added batch does not read them again", async () => {
    const db = databaseLike();
    api().selectTemplate.mockImplementation(({ templateId }: { templateId: string }) => {
      db.record(templateId);
      return Promise.resolve(added);
    });
    render(<Harness />);
    await screen.findByTestId("checklist-template-tpl-probe");
    fireEvent.click(check("tpl-probe"));
    fireEvent.click(addButton());
    await screen.findByTestId("checklist-panel");
    expect(api().listTemplates).toHaveBeenCalledTimes(1);
  });
});

describe("STK — every add fails on a transaction with no checklist", () => {
  function ReloadableHarness() {
    const checklist = useTransactionChecklist("txn-1");
    return (
      <>
        <button type="button" data-testid="test-reload" onClick={() => void checklist.reload()} />
        <TransactionChecklistTab
          checklist={checklist}
          gate="allowed"
          attachments={fixtureAttachments()}
          attachmentsLoading={false}
          emailCommunications={fixtureEmailCommunications()}
          ensureEmailsLoaded={() => Promise.resolve()}
          onRefreshLinkTargets={jest.fn()}
          onShowSuccess={jest.fn()}
          onShowError={onShowError}
        />
      </>
    );
  }

  it("the result line stays; a checklist arriving later shows the checklists, not the chooser", async () => {
    api().selectTemplate.mockResolvedValue(refused);
    render(<ReloadableHarness />);
    await screen.findByTestId("checklist-template-tpl-probe");
    fireEvent.click(check("tpl-probe"));
    fireEvent.click(addButton());
    expect(await screen.findByTestId("checklist-add-result")).toHaveTextContent(
      'Couldn\'t add "Probe template" — try again.',
    );
    // Still the "No checklist yet" chooser, with its sentence.
    expect(screen.getByText("No checklist yet")).toBeInTheDocument();
    await waitFor(() => expect(api().listTemplates).toHaveBeenCalledTimes(2));

    // A checklist lands from elsewhere (another window), then the tab re-reads.
    api().get.mockResolvedValue(answer([fixtureChecklist(0)]));
    fireEvent.click(screen.getByTestId("test-reload"));
    expect(await screen.findByTestId("checklist-panel")).toBeInTheDocument();
    expect(screen.queryByTestId("checklist-chooser")).not.toBeInTheDocument();
  });
});

describe("the chooser's checkbox is the item row's checkbox", () => {
  it("ticked and unticked render the same markup as a checklist item's box", async () => {
    render(<Harness />);
    await screen.findByTestId("checklist-template-tpl-probe");
    fireEvent.click(check("tpl-probe"));
    const chooserTicked = check("tpl-probe").outerHTML;
    const chooserUnticked = check("tpl-other").outerHTML;

    const noop = () => undefined;
    const rowBox = (isChecked: boolean) => {
      const item = { ...fixtureItem(0), isChecked };
      const { unmount } = render(
        <ChecklistItemRow
          item={item}
          links={[]}
          readOnly={false}
          pending={false}
          attachmentsById={new Map()}
          threads={[]}
          onToggle={noop}
          onSaveNote={() => Promise.resolve(true)}
          onOpenPicker={noop}
          onRemoveLink={() => Promise.resolve()}
          viewer={{ onViewAttachment: noop, downloadingAttachmentId: null, onViewThread: () => Promise.resolve() }}
        />,
      );
      const html = screen.getByTestId(`checklist-check-${item.id}`).outerHTML;
      unmount();
      return html;
    };
    // Same element, same classes, same glyph; only the name and test id differ.
    const normalise = (html: string) =>
      html.replace(/aria-label="[^"]*"/, 'aria-label="X"').replace(/data-testid="[^"]*"/, 'data-testid="X"');
    expect(normalise(chooserTicked)).toBe(normalise(rowBox(true)));
    expect(normalise(chooserUnticked)).toBe(normalise(rowBox(false)));
  });
});
