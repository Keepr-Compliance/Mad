/**
 * BACKLOG-2426 manual linking, rebuilt on the shared picker (BACKLOG-2591).
 *
 * ---------------------------------------------------------------------------
 * WHAT MOVED, AND WHAT MUST SURVIVE THE MOVE
 * ---------------------------------------------------------------------------
 * The bespoke result list, its empty/loading/failed blocks and its own search
 * input are gone — `ContactSearchList` renders all of that now. The tests for
 * those shapes are REWRITTEN against the new composition rather than deleted,
 * because two of the guarantees they carried are the reason this panel exists:
 *
 *   1. a failed load stays distinguishable from an empty address book
 *      (BACKLOG-1898 shape; the transaction pickers still conflate these —
 *      BACKLOG-2592 — and this swap must not inherit that); and
 *   2. no import path is reachable, because importing would CREATE a contact,
 *      which is the one thing a link surface may never do.
 *
 * Fixtures: RFC 2606 domains, `+1 <area> 555-01xx` (the reserved slot is the
 * exchange, never the area code).
 */

import React from "react";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { LinkSourceSearch } from "./LinkSourceSearch";
import type { LinkableSourceRecord } from "@/types/contactProvenance";

const ROBIN: LinkableSourceRecord = {
  sourceType: "outlook",
  sourceRecordId: "AAMkAGoutlook-robin-1",
  name: "Robin Marsh",
  sourceLabel: "Outlook contacts",
  emails: ["robin@example.org"],
  phones: ["+1 206 555-0142"],
  company: "Example Realty",
  lastMessageAt: null,
};

const PAT_WORK: LinkableSourceRecord = {
  sourceType: "macos",
  sourceRecordId: "macos-pat-2",
  name: "Pat Riverton",
  sourceLabel: "Mac address book",
  emails: ["p.riverton@example.net"],
  phones: [],
  company: null,
  lastMessageAt: null,
};

const findLinkableSources = jest.fn();
const linkSource = jest.fn();

beforeEach(() => {
  findLinkableSources.mockReset();
  linkSource.mockReset();
  findLinkableSources.mockResolvedValue({ success: true, records: [ROBIN, PAT_WORK] });
  (window as unknown as { api: unknown }).api = {
    contacts: { findLinkableSources, linkSource },
  };
});

function renderPanel(props: Partial<React.ComponentProps<typeof LinkSourceSearch>> = {}) {
  return render(
    <LinkSourceSearch
      userId="u1"
      contactId="c-pat"
      contactName="Pat Riverton"
      onClose={jest.fn()}
      {...props}
    />,
  );
}

const rowFor = (record: LinkableSourceRecord) =>
  screen.getByText(record.name as string, {
    selector: '[data-testid="contact-row-name"]',
  });

describe("LinkSourceSearch on the shared picker", () => {
  it("loads ONCE and offers the exact unclaimed set", async () => {
    renderPanel();

    await screen.findByText("Robin Marsh", { selector: '[data-testid="contact-row-name"]' });
    expect(
      screen.getAllByTestId("contact-row-name").map((n) => n.textContent).sort(),
    ).toEqual(["Pat Riverton", "Robin Marsh"]);

    // One read per open — the per-keystroke IPC is gone.
    expect(findLinkableSources).toHaveBeenCalledTimes(1);
    expect(findLinkableSources).toHaveBeenCalledWith("u1");
  });

  /**
   * The reason `showDetailLine` exists. Two of these records would otherwise
   * both read "Pat Riverton" / "Robin Marsh" with nothing to tell a same-named
   * stranger from the same person's second record.
   *
   * CONTROL: pass `showDetailLine={false}` from this panel.
   */
  it("shows the detail line the linking decision needs", async () => {
    renderPanel();

    const detail = await screen.findAllByTestId("contact-row-detail");
    expect(detail.map((d) => d.textContent)).toEqual(
      expect.arrayContaining([
        "Outlook · robin@example.org · +1 206 555-0142 · Example Realty",
        "Contacts App · p.riverton@example.net",
      ]),
    );
  });

  /**
   * A link surface must never create a contact.
   *
   * CONTROL: pass `onImportContact` instead of `onExternalSelect` from this
   * panel (i.e. wire it like the transaction picker).
   */
  it("offers no import affordance at all", async () => {
    renderPanel();
    await screen.findByText("Robin Marsh", { selector: '[data-testid="contact-row-name"]' });

    expect(screen.queryByText("+ Add Contact")).toBeNull();
    expect(screen.queryByTestId("contact-row-import")).toBeNull();
  });

  it("accumulates several records and links them in one call", async () => {
    linkSource.mockResolvedValue({
      success: true,
      outcomes: [
        { ok: true, linkId: "l-1" },
        { ok: true, linkId: "l-2" },
      ],
    });
    const onLinked = jest.fn();
    const onClose = jest.fn();
    renderPanel({ onLinked, onClose });

    await screen.findByText("Robin Marsh", { selector: '[data-testid="contact-row-name"]' });
    fireEvent.click(rowFor(ROBIN));
    fireEvent.click(rowFor(PAT_WORK));

    fireEvent.click(await screen.findByTestId("link-source-commit"));

    await waitFor(() => expect(onLinked).toHaveBeenCalledTimes(1));
    expect(linkSource).toHaveBeenCalledTimes(1);
    expect(linkSource).toHaveBeenCalledWith(
      "u1",
      "c-pat",
      [
        { sourceType: "outlook", sourceRecordId: ROBIN.sourceRecordId },
        { sourceType: "macos", sourceRecordId: PAT_WORK.sourceRecordId },
      ],
      undefined,
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  /**
   * The batch disclosure. One record links, the other comes back
   * `prior_rejection`; the panel asks ONCE and re-sends only that record with
   * its acknowledgement.
   *
   * CONTROL: drop the `prior_rejection` branch in `applyOutcomes`.
   */
  it("discloses prior rejections once, then overturns only those", async () => {
    linkSource
      .mockResolvedValueOnce({
        success: true,
        outcomes: [{ ok: true, linkId: "l-1" }, { ok: false, reason: "prior_rejection" }],
      })
      .mockResolvedValueOnce({ success: true, outcomes: [{ ok: true, linkId: "l-2" }] });
    const onLinked = jest.fn();
    renderPanel({ onLinked });

    await screen.findByText("Robin Marsh", { selector: '[data-testid="contact-row-name"]' });
    fireEvent.click(rowFor(ROBIN));
    fireEvent.click(rowFor(PAT_WORK));
    fireEvent.click(await screen.findByTestId("link-source-commit"));

    const warning = await screen.findByTestId("link-prior-rejection-warning");
    // Names the record, so the user knows WHICH answer they are reversing.
    expect(within(warning).getByText(/Pat Riverton/)).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("link-prior-rejection-confirm"));

    await waitFor(() => expect(linkSource).toHaveBeenCalledTimes(2));
    const secondCall = linkSource.mock.calls[1];
    expect(secondCall[2]).toEqual([
      { sourceType: "macos", sourceRecordId: PAT_WORK.sourceRecordId },
    ]);
    // Acknowledged, and ONLY for the record that needed it.
    expect(secondCall[3]).toEqual([
      { sourceType: "macos", sourceRecordId: PAT_WORK.sourceRecordId },
    ]);
  });

  it("says a record belongs to someone else rather than failing opaquely", async () => {
    linkSource.mockResolvedValue({
      success: true,
      outcomes: [{ ok: false, reason: "claimed", incumbentContactId: "c-jane" }],
    });
    renderPanel();

    await screen.findByText("Robin Marsh", { selector: '[data-testid="contact-row-name"]' });
    fireEvent.click(rowFor(ROBIN));
    fireEvent.click(await screen.findByTestId("link-source-commit"));

    expect(await screen.findByTestId("link-source-error")).toHaveTextContent(
      /already belong to another contact/i,
    );
  });

  /**
   * THE GUARANTEE THAT MUST SURVIVE THE SWAP. `ContactSearchList` renders its
   * `error` branch only when a caller supplies one; the transaction pickers do
   * not, which is BACKLOG-2592. This panel does, so a dead channel never reads
   * as "you have no address book".
   *
   * CONTROL: stop passing `error` to `ContactSearchList`.
   */
  it("distinguishes a broken load from an empty address book", async () => {
    findLinkableSources.mockResolvedValue({ success: false, error: "no local user" });
    renderPanel();

    const errorState = await screen.findByTestId("error-state");
    expect(errorState).toHaveTextContent(/could not be searched/i);
    expect(screen.queryByTestId("empty-state")).toBeNull();
  });

  it("shows the ordinary empty state when the address book really is empty", async () => {
    findLinkableSources.mockResolvedValue({ success: true, records: [] });
    renderPanel();

    await screen.findByTestId("empty-state");
    expect(screen.queryByTestId("error-state")).toBeNull();
  });
});
