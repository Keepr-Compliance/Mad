/**
 * BACKLOG-2410 / BACKLOG-2471 — the Sources (provenance) section on the contact
 * card.
 *
 * THE RULE BEING PINNED, AND IT WAS DELIBERATELY REVERSED IN BACKLOG-2471.
 *
 * BACKLOG-2410's rule was "show nothing for the common case", implemented as a
 * threshold of TWO sources. This file used to hold a test named "renders nothing
 * when the contact has one source", with a recorded negative-control run, and it
 * called that single assertion "the whole of the 'no clutter on the common case'
 * guarantee". That test is now inverted, on purpose, and the reason is not
 * cosmetic:
 *
 *   The Unlink control lives INSIDE this panel. At a threshold of two, unlinking
 *   a two-source contact down to one made the panel disappear — permanently
 *   removing the ability to see the surviving link or undo what you just did.
 *   The founder hit that himself.
 *
 * The no-clutter guarantee did not go away; it moved to the `origin` filter,
 * which is now the load-bearing half and is pinned by its own tests below. A
 * contact the user typed in carries an `origin` row and nothing else, so it
 * still shows no panel at all — verified by execution, not assumed.
 *
 * THE SETTLED DESIGN (founder, 2026-08-05, recorded on BACKLOG-2471): "we can't
 * unlink a contact from itself so we should hide the button." The contact's own
 * record is never a row here and never carries an Unlink control. Dropping the
 * threshold to one is exactly the change that could have exposed it, so that is
 * pinned from both sides — mixed with real sources, and alone.
 *
 * Every assertion names the EXACT link ids it expects to see or not see. A count
 * assertion here would pass while rendering the wrong source.
 *
 * NEGATIVE-CONTROL DISCIPLINE: a test asserting only "the label reads Unlink"
 * would also pass if the panel stopped rendering entirely. Every label assertion
 * below is therefore paired with a structural assertion that the section and the
 * row are on screen, so each control reddens for one reason and says which.
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

/**
 * The contact's OWN row — what BACKLOG-2473 writes at creation time.
 *
 * TRANSCRIBED, NOT INVENTED. Every field is what `getContactProvenance` would
 * project for a hand-typed contact's origin row if its `match_method <> 'origin'`
 * clause were removed, which is precisely the leak this fixture stands in for:
 *
 *   contact_source_links: source_type 'manual', match_method 'origin',
 *     source_record_id `origin:<contactId>`   (contactOriginLink.ts)
 *   sourceLabel('manual')                     -> "contacts you added yourself"
 *   matchMethodDescription('origin','manual') -> "You added this contact yourself"
 *   sourceName / sourceRecordPresent          -> null / false, because the
 *     synthetic record id matches no `external_contacts` row, so the LEFT JOIN
 *     that supplies both finds nothing.
 *
 * Passing it straight into the component is the point: the renderer filter is
 * defence in depth against exactly this row arriving over the IPC boundary, so
 * the fixture has to be the row, not a plausible-looking stand-in.
 */
function makeOriginRow(linkId: string): ContactSourceProvenance {
  return {
    linkId,
    sourceType: "manual",
    sourceLabel: "contacts you added yourself",
    matchMethod: "origin",
    matchDescription: "You added this contact yourself",
    sourceName: null,
    sourceRecordPresent: false,
    matchedAt: "2026-08-02T00:00:00.000Z",
    lastSyncedAt: "2026-08-02T00:00:00.000Z",
  } as unknown as ContactSourceProvenance;
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
   * BACKLOG-2471, and this test is the INVERSE of the one it replaces.
   *
   * Until now this asserted the panel was ABSENT at one source. It is now
   * present, because the Unlink control lives inside the panel: at the old
   * threshold, unlinking a two-source contact down to one made the panel vanish
   * and took the undo with it.
   *
   * CONTROL (threshold): revert `sourceList.length > 0` to `> 1`. This test must
   * go red. Deliberately uses ONE source and no origin row, so it isolates the
   * threshold and nothing else.
   */
  it("shows the panel, by exact link id, when the contact has one source", () => {
    renderPreview({ sources: [makeSource("l-only")] });
    expect(screen.getByTestId("contact-sources-section")).toBeInTheDocument();
    expect(screen.getByTestId("contact-source-row-l-only")).toBeInTheDocument();
    expect(screen.queryByTestId("contact-source-row-l-nonexistent")).toBeNull();
  });

  /**
   * The copy has to match what is on screen. At one source the old sentence
   * ("put together from more than one place", "the other sources stay") asserts
   * two things that are both false.
   *
   * CONTROL (copy): drop the `sourceList.length === 1` branch and always render
   * the plural paragraph. This test must go red while the one above stays green.
   */
  it("does not claim more than one place when there is only one source", () => {
    renderPreview({ sources: [makeSource("l-only")] });
    const explainer = screen.getByTestId("contact-sources-explainer");
    expect(explainer).toHaveTextContent("linked to one record from somewhere else");
    expect(explainer).not.toHaveTextContent("more than one place");
  });

  it("still says 'more than one place' when there genuinely is", () => {
    renderPreview({
      sources: [makeSource("l-mac"), makeSource("l-out", { sourceType: "outlook" })],
    });
    expect(screen.getByTestId("contact-sources-explainer")).toHaveTextContent(
      "put together from more than one place",
    );
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
   * Two sources, so the threshold control cannot redden this test — it isolates
   * the label.
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

  /**
   * SETTLED DESIGN (founder, 2026-08-05): "we can't unlink a contact from itself
   * so we should hide the button."
   *
   * Two real sources here, so this holds independently of the threshold — it
   * isolates the `origin` filter.
   *
   * CONTROL (origin filter): delete `.filter((s) => s.matchMethod !== "origin")`.
   * This test must go red on BOTH assertions — the row appears and so does an
   * Unlink button that would always fail.
   */
  it("never lists the contact's own record, and gives it no Unlink", () => {
    renderPreview({
      sources: [
        makeOriginRow("l-origin"),
        makeSource("l-mac"),
        makeSource("l-out", { sourceType: "outlook" }),
      ],
      onUnlinkSource: jest.fn(),
    });

    // Present, by exact id — so the absences below mean "filtered", not "blank".
    expect(screen.getByTestId("contact-source-row-l-mac")).toBeInTheDocument();
    expect(screen.getByTestId("contact-source-row-l-out")).toBeInTheDocument();
    expect(screen.getByTestId("contact-source-unlink-l-mac")).toBeInTheDocument();
    expect(screen.getByTestId("contact-source-unlink-l-out")).toBeInTheDocument();

    expect(screen.queryByTestId("contact-source-row-l-origin")).toBeNull();
    expect(screen.queryByTestId("contact-source-unlink-l-origin")).toBeNull();
    expect(screen.queryByText("You added this contact yourself")).toBeNull();
  });

  /**
   * THE CASE THE THRESHOLD CHANGE COULD HAVE EXPOSED, and the one this PR is
   * asked to establish by execution rather than guess: a contact whose ONLY
   * source is its own origin row.
   *
   * ANSWER: no panel at all. `sourceList` is empty after the filter, and `[]`
   * fails `length > 0` exactly as it failed `length > 1`. A hand-typed contact
   * is unchanged by this PR.
   *
   * CONTROL (origin filter): delete the filter. `sourceList` becomes length 1,
   * clears the new threshold, and this test goes red — which is the whole point:
   * at `> 1` that leak needed a second row to show anything; at `> 0` it opens
   * the panel on its own.
   */
  it("shows no panel when the contact's own record is its only source", () => {
    renderPreview({ sources: [makeOriginRow("l-origin")], onUnlinkSource: jest.fn() });

    expect(screen.queryByTestId("contact-sources-section")).toBeNull();
    expect(screen.queryByTestId("contact-source-row-l-origin")).toBeNull();
    expect(screen.queryByTestId("contact-source-unlink-l-origin")).toBeNull();
  });

  /**
   * The same leak alongside ONE real source. Before this PR the panel stayed
   * hidden here (one row after filtering, threshold two); now it shows the real
   * source and only the real source.
   *
   * Reddens under BOTH the threshold control and the origin-filter control, and
   * that is correct — it is the intersection case, and it is the one the founder
   * will actually be looking at.
   */
  it("shows one real source next to an origin row, and unlinks only the real one", () => {
    renderPreview({
      sources: [makeOriginRow("l-origin"), makeSource("l-mac")],
      onUnlinkSource: jest.fn(),
    });

    expect(screen.getByTestId("contact-sources-section")).toBeInTheDocument();
    expect(screen.getByTestId("contact-source-row-l-mac")).toBeInTheDocument();
    expect(screen.getByTestId("contact-source-unlink-l-mac")).toHaveTextContent("Unlink");

    expect(screen.queryByTestId("contact-source-row-l-origin")).toBeNull();
    expect(screen.queryByTestId("contact-source-unlink-l-origin")).toBeNull();
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
