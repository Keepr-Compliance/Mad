/**
 * BACKLOG-2471 PR C — the `Compare sources` button, and the one threshold it
 * shares with the Sources panel.
 *
 * THE CLAIM BEING PINNED, AND ITS PREMISE.
 *
 * The button appears exactly when the Sources panel does. That is not a
 * coincidence to be maintained by hand — both answer "is there a record here
 * that could be wrong?", so they read ONE predicate, `showSourcesPanel`.
 *
 * The equivalence holds only BECAUSE `getContactProvenance` filters `origin`
 * rows in SQL, so the list this component receives never contains the row the
 * compare reader absorbs into the contact's own column. That premise is exercised
 * here from the renderer's side: an origin row is passed in deliberately (the
 * component's own filter is defence in depth against it arriving over IPC), and
 * neither the panel nor the button may appear for it.
 *
 * BOTH DIRECTIONS ARE COVERED. A test that only checked the shapes which OPEN
 * the screen would stay green if the button were rendered unconditionally — the
 * false side is where the founder's objection lives: *"why would we have unlink
 * on a singular contact. we have a remove contact button already"*.
 */

import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { ContactPreview } from "./ContactPreview";
import type { ExtendedContact } from "../../types/components";
import type { ContactSourceProvenance } from "@/types/contactProvenance";

const contact = {
  id: "c-casey",
  user_id: "u1",
  display_name: "Casey Lane",
  email: "casey@example.com",
  created_at: "2026-01-01T00:00:00.000Z",
} as unknown as ExtendedContact;

/**
 * TRANSCRIBED, as in `ContactPreview.sources.test.tsx`: the fields are what
 * `getContactProvenance` projects, and `matchMethod` is the crosswalk's own
 * vocabulary from `contactSourceLinkDbService.ts`.
 */
function makeSource(
  linkId: string,
  matchMethod: ContactSourceProvenance["matchMethod"],
): ContactSourceProvenance {
  return {
    linkId,
    sourceType: "macos",
    sourceLabel: "Mac address book",
    matchMethod,
    matchDescription: "Recognised by its own entry in your Mac address book",
    sourceName: "Casey Lane",
    sourceRecordPresent: true,
    matchedAt: "2026-08-02T00:00:00.000Z",
    lastSyncedAt: "2026-08-02T00:00:00.000Z",
  } as ContactSourceProvenance;
}

/** The contact's OWN row — `origin`, pointing at the synthetic `origin:<id>`. */
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

/**
 * `onEdit` IS PASSED ON PURPOSE, AND IT IS NOT DECORATION.
 *
 * The button sits inside the header's action cluster, which only renders when
 * it has something to hold. Without `onEdit` the cluster's own condition is the
 * only thing keeping the button off screen, and a control that weakened the
 * button's OWN gate stayed green — the outer condition was doing the work and
 * the test was proving something else. `Contacts.tsx` always passes `onEdit`
 * (`handlePreviewEdit`), so this matches how the card is really wired.
 */
function renderPreview(
  props: Partial<React.ComponentProps<typeof ContactPreview>> = {},
) {
  return render(
    <ContactPreview
      contact={contact}
      isExternal={false}
      variant="pane"
      onClose={jest.fn()}
      onEdit={jest.fn()}
      onCompareSources={jest.fn()}
      {...props}
    />,
  );
}

describe("the Compare sources button", () => {
  /**
   * CONTROL: gate the button on `sourceList.length > 0` instead of
   * `showSourcesPanel(sourceList)` and the first two rows go red while the last
   * three stay green — which is exactly the asymmetry that makes this table
   * worth having.
   */
  const cases: {
    name: string;
    sources: ContactSourceProvenance[];
    appears: boolean;
  }[] = [
    {
      name: "hand-typed contact, nothing attached (origin row only)",
      sources: [makeOriginRow("l-origin")],
      appears: false,
    },
    {
      name: "imported contact, nothing attached (one source_id row)",
      sources: [makeSource("l-sid", "source_id")],
      appears: false,
    },
    {
      name: "one record attached after the fact",
      sources: [makeSource("l-email", "email")],
      appears: true,
    },
    {
      name: "a collapsed import — two source_id rows",
      sources: [makeSource("l-sid1", "source_id"), makeSource("l-sid2", "source_id")],
      appears: true,
    },
    {
      name: "imported plus one attached",
      sources: [makeSource("l-sid", "source_id"), makeSource("l-manual", "manual")],
      appears: true,
    },
  ];

  it.each(cases)("$name -> button and panel agree", ({ sources, appears }) => {
    const { unmount } = renderPreview({ sources });

    const button = screen.queryByTestId("contact-compare-open");
    const panel = screen.queryByTestId("contact-sources-section");

    // One predicate, asserted as one fact: the two are never allowed to differ.
    expect({ button: !!button, panel: !!panel }).toEqual({
      button: appears,
      panel: appears,
    });
    if (appears) expect(button!.textContent).toBe("Compare sources");

    unmount();
  });

  it("is never offered on an external record", () => {
    // An unimported address-book row is not a saved contact; its action is
    // Import, and it has no crosswalk rows to compare.
    renderPreview({
      isExternal: true,
      sources: [makeSource("l-email", "email")],
      onImport: jest.fn(),
    });

    expect(screen.queryByTestId("contact-compare-open")).toBeNull();
  });

  it("is absent when the caller does not pass the handler", () => {
    // The four other surfaces that render this card are unchanged until PR G
    // opts them in. CONTROL: render the button unconditionally and this goes
    // red — which is what keeps this PR off ContactSelectModal and friends.
    renderPreview({ sources: [makeSource("l-email", "email")], onCompareSources: undefined });

    expect(screen.queryByTestId("contact-compare-open")).toBeNull();
    // …and the panel is still there, so the absence above is the button's own.
    expect(screen.getByTestId("contact-sources-section")).toBeTruthy();
  });

  it("calls back when pressed", () => {
    const onCompareSources = jest.fn();
    renderPreview({ sources: [makeSource("l-email", "email")], onCompareSources });

    fireEvent.click(screen.getByTestId("contact-compare-open"));
    expect(onCompareSources).toHaveBeenCalledTimes(1);
  });
});
