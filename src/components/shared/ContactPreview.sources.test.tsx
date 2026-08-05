/**
 * BACKLOG-2410 — the Sources (provenance) section on the contact card.
 *
 * THE RULE BEING PINNED: show nothing for the common case. A contact from one
 * address book has nothing to disclose, and a badge on every contact is noise
 * that trains the user to ignore the one place a wrong merge is visible.
 *
 * Every assertion names the EXACT link ids it expects to see or not see. A
 * count assertion here would pass while rendering the wrong source.
 */

import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { ContactPreview } from "./ContactPreview";
import type { ExtendedContact } from "../../types/components";
import type { ContactSourceProvenance } from "@/types/contactProvenance";

const contact = {
  id: "c-jane",
  user_id: "u1",
  display_name: "Jane Doe",
  email: "jane@example.com",
  created_at: "2026-01-01T00:00:00.000Z",
} as unknown as ExtendedContact;

function makeSource(
  linkId: string,
  overrides: Partial<ContactSourceProvenance> = {},
): ContactSourceProvenance {
  return {
    linkId,
    sourceType: "macos",
    sourceLabel: "Mac address book",
    matchMethod: "source_id",
    matchDescription: "Recognised by its own entry in your Mac address book",
    sourceName: "Jane Doe",
    sourceRecordPresent: true,
    matchedAt: "2026-08-02T00:00:00.000Z",
    lastSyncedAt: "2026-08-02T00:00:00.000Z",
    ...overrides,
  } as ContactSourceProvenance;
}

function renderPreview(props: Partial<React.ComponentProps<typeof ContactPreview>> = {}) {
  return render(
    <ContactPreview
      contact={contact}
      isExternal={false}
      variant="pane"
      onClose={jest.fn()}
      {...props}
    />,
  );
}

describe("ContactPreview sources section", () => {
  /**
   * NEGATIVE CONTROL RUN: changed the gate from `sourceList.length > 1` to
   * `> 0`. Observed: 1 failed / 9 passed — THIS test, and only this test. The
   * opted-out and empty-list cases still pass, because an omitted prop collapses
   * to `[]` and `[].length > 0` is still false. So this single assertion is the
   * whole of the "no clutter on the common case" guarantee; the other two pin
   * the opt-in gating, which is a different property.
   */
  it("renders nothing when the contact has one source", () => {
    renderPreview({ sources: [makeSource("l-only")] });
    expect(screen.queryByTestId("contact-sources-section")).toBeNull();
    expect(screen.queryByTestId("contact-source-row-l-only")).toBeNull();
  });

  it("renders nothing when the sources prop is omitted entirely", () => {
    renderPreview();
    expect(screen.queryByTestId("contact-sources-section")).toBeNull();
  });

  it("renders nothing for an empty source list", () => {
    renderPreview({ sources: [] });
    expect(screen.queryByTestId("contact-sources-section")).toBeNull();
  });

  it("renders nothing for an external, not-yet-imported contact", () => {
    renderPreview({
      isExternal: true,
      sources: [makeSource("l-1"), makeSource("l-2", { sourceType: "outlook" })],
    });
    expect(screen.queryByTestId("contact-sources-section")).toBeNull();
  });

  it("shows every source, by exact link id, when there is more than one", () => {
    renderPreview({
      sources: [
        makeSource("l-mac"),
        makeSource("l-out", {
          sourceType: "outlook",
          sourceLabel: "Outlook contacts",
          matchMethod: "email",
          matchDescription: "Matched by an email address you already had for this person",
          sourceName: "Jane R Doe",
        }),
      ],
    });

    expect(screen.getByTestId("contact-sources-section")).toBeInTheDocument();
    expect(screen.getByTestId("contact-source-row-l-mac")).toBeInTheDocument();
    expect(screen.getByTestId("contact-source-row-l-out")).toBeInTheDocument();
    expect(screen.queryByTestId("contact-source-row-l-nonexistent")).toBeNull();

    // The HOW, in words — this is what lets a user judge a link.
    expect(
      screen.getByText("Recognised by its own entry in your Mac address book"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Matched by an email address you already had for this person"),
    ).toBeInTheDocument();
  });

  it("says when a source record has gone from its account", () => {
    renderPreview({
      sources: [
        makeSource("l-mac"),
        makeSource("l-out", { sourceType: "outlook", sourceRecordPresent: false }),
      ],
    });
    expect(screen.getByText("This entry is no longer in that account.")).toBeInTheDocument();
  });

  /**
   * BACKLOG-2471 — the founder chose this word himself, replacing the shipped
   * "Not this person".
   *
   * STRUCTURAL + TEXTUAL, deliberately. A bare `queryByText("Not this person")`
   * is null when the panel does not render at all, so on its own it would pass
   * for the wrong reason. The section, the row and the button are all asserted
   * present first; only then is the word checked.
   *
   * CONTROL (label): restore the string "Not this person" at the button. This
   * test must go red.
   */
  it("labels the control 'Unlink', on a panel that is genuinely on screen", () => {
    renderPreview({
      sources: [makeSource("l-mac"), makeSource("l-out", { sourceType: "outlook" })],
      onUnlinkSource: jest.fn(),
    });

    expect(screen.getByTestId("contact-sources-section")).toBeInTheDocument();
    expect(screen.getByTestId("contact-source-row-l-out")).toBeInTheDocument();

    const button = screen.getByTestId("contact-source-unlink-l-out");
    expect(button).toBeInTheDocument();
    expect(button).toHaveTextContent("Unlink");
    expect(screen.queryByText("Not this person")).toBeNull();
  });

  /**
   * The in-flight verb follows the button. "Removing…" belonged to the old
   * wording and reads like the CONTACT is being deleted.
   *
   * CONTROL (in-flight label): restore "Removing…". This test must go red while
   * the one above stays green.
   */
  it("says 'Unlinking…' on the row in flight, and 'Unlink' on the others", () => {
    renderPreview({
      sources: [makeSource("l-mac"), makeSource("l-out", { sourceType: "outlook" })],
      onUnlinkSource: jest.fn(),
      unlinkingLinkId: "l-out",
    });

    expect(screen.getByTestId("contact-source-unlink-l-out")).toHaveTextContent("Unlinking…");
    expect(screen.getByTestId("contact-source-unlink-l-mac")).toHaveTextContent("Unlink");
    expect(screen.queryByText("Removing…")).toBeNull();
  });

  it("offers an unlink per source and reports the exact link clicked", () => {
    const onUnlinkSource = jest.fn();
    const outlook = makeSource("l-out", { sourceType: "outlook" });
    renderPreview({ sources: [makeSource("l-mac"), outlook], onUnlinkSource });

    fireEvent.click(screen.getByTestId("contact-source-unlink-l-out"));

    expect(onUnlinkSource).toHaveBeenCalledTimes(1);
    expect(onUnlinkSource).toHaveBeenCalledWith(outlook);
  });

  it("is read-only when no unlink handler is supplied", () => {
    renderPreview({ sources: [makeSource("l-mac"), makeSource("l-out", { sourceType: "outlook" })] });
    expect(screen.queryByTestId("contact-source-unlink-l-mac")).toBeNull();
    expect(screen.queryByTestId("contact-source-unlink-l-out")).toBeNull();
  });

  it("disables only the row being unlinked", () => {
    renderPreview({
      sources: [makeSource("l-mac"), makeSource("l-out", { sourceType: "outlook" })],
      onUnlinkSource: jest.fn(),
      unlinkingLinkId: "l-out",
    });
    expect(screen.getByTestId("contact-source-unlink-l-out")).toBeDisabled();
    expect(screen.getByTestId("contact-source-unlink-l-mac")).not.toBeDisabled();
  });

  it("never shows a numeric score", () => {
    const { container } = renderPreview({
      sources: [makeSource("l-mac"), makeSource("l-out", { sourceType: "outlook" })],
    });
    const text = container.querySelector('[data-testid="contact-sources-section"]')!.textContent!;
    expect(text).not.toMatch(/\d+%|0\.\d+|confidence/i);
  });
});
