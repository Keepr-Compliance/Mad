/**
 * BACKLOG-2426 — the manual-link search panel.
 *
 * ---------------------------------------------------------------------------
 * THE BEHAVIOUR THIS SUITE EXISTS FOR: ASK BEFORE OVERTURNING A REJECTION
 * ---------------------------------------------------------------------------
 * If the user previously pressed `Unlink` on this exact pair, a
 * `different_people` verdict blocks it everywhere. A manual link must be able to
 * overturn that — otherwise a mistaken unlink is permanent and unexplained — but
 * it must SAY SO FIRST and require a second confirmation. The founder hit this
 * case himself.
 *
 * So `prior_rejection` is asserted as a DISCLOSURE, not an error: the first
 * attempt writes nothing and explains; only the second carries
 * `acknowledgedPriorRejection: true`.
 *
 * Fixtures use RFC 2606 domains and `+1 <area> 555-01xx` numbers.
 */

import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
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

const findLinkableSources = jest.fn();
const linkSource = jest.fn();

beforeEach(() => {
  findLinkableSources.mockReset();
  linkSource.mockReset();
  findLinkableSources.mockResolvedValue({ success: true, records: [ROBIN] });
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

describe("LinkSourceSearch", () => {
  it("lists unclaimed records by exact id and links one on request", async () => {
    linkSource.mockResolvedValue({ success: true, outcome: { ok: true, linkId: "link-1" } });
    const onLinked = jest.fn();
    const onClose = jest.fn();
    renderPanel({ onLinked, onClose });

    await screen.findByTestId(`link-source-result-outlook-${ROBIN.sourceRecordId}`);
    fireEvent.click(screen.getByTestId(`link-source-confirm-outlook-${ROBIN.sourceRecordId}`));

    await waitFor(() => expect(onLinked).toHaveBeenCalledTimes(1));
    expect(linkSource).toHaveBeenCalledWith(
      "u1",
      "c-pat",
      "outlook",
      ROBIN.sourceRecordId,
      false,
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  /**
   * CONTROL: make the `prior_rejection` branch fall through to the generic
   * failure message instead of setting `pendingRejection`.
   * OBSERVED: 2 failed / 5 passed — the warning never renders and the second
   * confirmation is unreachable, so a mistaken unlink stays permanent.
   */
  it("discloses a prior rejection instead of silently overturning it", async () => {
    linkSource.mockResolvedValue({
      success: true,
      outcome: { ok: false, reason: "prior_rejection" },
    });
    const onLinked = jest.fn();
    renderPanel({ onLinked });

    await screen.findByTestId(`link-source-result-outlook-${ROBIN.sourceRecordId}`);
    fireEvent.click(screen.getByTestId(`link-source-confirm-outlook-${ROBIN.sourceRecordId}`));

    await screen.findByTestId("link-prior-rejection-warning");
    // Nothing was linked, and the caller was not told anything had been.
    expect(onLinked).not.toHaveBeenCalled();
    expect(linkSource).toHaveBeenCalledTimes(1);
  });

  it("overturns the rejection only on the second, explicit confirmation", async () => {
    linkSource
      .mockResolvedValueOnce({ success: true, outcome: { ok: false, reason: "prior_rejection" } })
      .mockResolvedValueOnce({ success: true, outcome: { ok: true, linkId: "link-1" } });
    const onLinked = jest.fn();
    renderPanel({ onLinked });

    await screen.findByTestId(`link-source-result-outlook-${ROBIN.sourceRecordId}`);
    fireEvent.click(screen.getByTestId(`link-source-confirm-outlook-${ROBIN.sourceRecordId}`));
    await screen.findByTestId("link-prior-rejection-warning");
    fireEvent.click(screen.getByTestId("link-prior-rejection-confirm"));

    await waitFor(() => expect(onLinked).toHaveBeenCalledTimes(1));
    expect(linkSource).toHaveBeenLastCalledWith(
      "u1",
      "c-pat",
      "outlook",
      ROBIN.sourceRecordId,
      true,
    );
  });

  it("says a record belongs to someone else rather than failing opaquely", async () => {
    linkSource.mockResolvedValue({
      success: true,
      outcome: { ok: false, reason: "claimed", incumbentContactId: "c-jane" },
    });
    renderPanel();

    await screen.findByTestId(`link-source-result-outlook-${ROBIN.sourceRecordId}`);
    fireEvent.click(screen.getByTestId(`link-source-confirm-outlook-${ROBIN.sourceRecordId}`));

    expect(await screen.findByTestId("link-source-error")).toHaveTextContent(
      /already belongs to another contact/i,
    );
  });

  /**
   * A failed search is NOT an empty search — the BACKLOG-1898 shape. Saying "no
   * records match" when the channel is broken tells the user their record does
   * not exist when it does.
   *
   * CONTROL: drop the `searchFailed` branch and let the empty-state render.
   * OBSERVED: 1 failed / 5 passed — a dead channel reads as an empty address
   * book.
   */
  it("distinguishes a broken search from an empty one", async () => {
    findLinkableSources.mockResolvedValue({ success: false, error: "no local user" });
    renderPanel();

    expect(await screen.findByTestId("link-source-search-failed")).toBeInTheDocument();
    expect(screen.queryByTestId("link-source-empty")).toBeNull();
  });
});
