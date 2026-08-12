/**
 * BACKLOG-2426 — the `Link` action on the contact card.
 *
 * The founder asked for it BY POSITION: *"maybe next to the edit there should
 * be link, or turn edit into edit and link, so the user can search for other
 * contacts to link it with"*. So the tests below assert WHERE it is and WHEN it
 * appears, not merely that it exists somewhere.
 *
 * ---------------------------------------------------------------------------
 * THE ONE THAT MATTERS: NEVER ON AN EXTERNAL RECORD
 * ---------------------------------------------------------------------------
 * An unimported address-book row has nothing to link TO — its action is
 * `Import`. Offering `Link` there would invite the user to join a record to a
 * contact that does not exist yet.
 */

import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { ContactPreview } from "./ContactPreview";
import type { ExtendedContact } from "../../types/components";

const contact = {
  id: "c-pat",
  user_id: "u1",
  display_name: "Pat Riverton",
  email: "pat@example.com",
  created_at: "2026-01-01T00:00:00.000Z",
} as unknown as ExtendedContact;

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

describe("the Link action", () => {
  /**
   * CONTROL: render the button unconditionally (drop the `onLinkSource &&`).
   * OBSERVED: 1 failed / 5 passed — it appears on the four surfaces that never
   * pass the prop, where pressing it would do nothing.
   */
  it("is absent when the surface does not offer linking", () => {
    renderPreview({ onEdit: jest.fn() });
    expect(screen.queryByTestId("contact-preview-link")).toBeNull();
    expect(screen.getByTestId("contact-preview-edit")).toBeInTheDocument();
  });

  it("sits beside Edit Contact when offered", () => {
    renderPreview({ onEdit: jest.fn(), onLinkSource: jest.fn() });
    expect(screen.getByTestId("contact-preview-link")).toBeInTheDocument();
    expect(screen.getByTestId("contact-preview-edit")).toBeInTheDocument();
  });

  /**
   * FOUNDER QA, PR #2254: *"can we move the link button to be near the edit, to
   * its left?"*
   *
   * The first form returned the two buttons as BARE SIBLINGS. The header row is
   * `justify-between` and had exactly two children for its whole life — the
   * name block and ONE button — so three children made it spread them, and
   * `Link` was stranded in the MIDDLE of the header rather than beside `Edit`.
   *
   * ---------------------------------------------------------------------------
   * THE FIRST VERSION OF THIS TEST WAS NOT A CONTROL — recorded, because the
   * near-miss is the lesson
   * ---------------------------------------------------------------------------
   * It asserted `link.parentElement === edit.parentElement` and
   * `link.nextElementSibling === edit`. **Both hold in the BROKEN layout too**:
   * as bare siblings the buttons still share a parent (the header row) and are
   * still adjacent in the DOM. Running the control proved it — restoring the
   * fragment left the suite fully GREEN.
   *
   * The defect is a LAYOUT fact, and jsdom does no layout, so no
   * position-of-the-buttons assertion can see it. What CAN be asserted is the
   * structural cause: `justify-between` spreads its children, so the fix is that
   * the buttons occupy ONE child of that row rather than two. Hence the
   * assertion below is on the CLUSTER — a parent holding exactly the buttons —
   * which is false the moment they are bare siblings again.
   *
   * CONTROL 1 — replace the wrapping <div> with a bare <> fragment (the exact
   * reported bug): OBSERVED 1 failed / 6 passed.
   * CONTROL 2 — swap the two JSX blocks so `Edit` renders first:
   * OBSERVED 1 failed / 6 passed.
   */
  it("renders immediately LEFT of Edit, inside a dedicated action cluster", () => {
    renderPreview({ onEdit: jest.fn(), onLinkSource: jest.fn() });
    const link = screen.getByTestId("contact-preview-link");
    const edit = screen.getByTestId("contact-preview-edit");
    const cluster = screen.getByTestId("contact-preview-actions");

    // LEFT, and immediately so.
    expect(link.nextElementSibling).toBe(edit);

    // THE CLUSTER IS THE POINT: both buttons live in it, and it holds NOTHING
    // ELSE. As bare siblings their parent is the `justify-between` header row,
    // which also holds the name block — so this is the assertion that separates
    // the fixed layout from the broken one.
    expect(link.parentElement).toBe(cluster);
    expect(edit.parentElement).toBe(cluster);
    expect(cluster.children).toHaveLength(2);
  });

  it("calls back when pressed", () => {
    const onLinkSource = jest.fn();
    renderPreview({ onEdit: jest.fn(), onLinkSource });
    fireEvent.click(screen.getByTestId("contact-preview-link"));
    expect(onLinkSource).toHaveBeenCalledTimes(1);
  });

  /**
   * CONTROL: move the `Link` button out of the `onEdit` arm so it renders for
   * the external case too.
   * OBSERVED: 1 failed / 5 passed — `Link` appears next to `Import` on an
   * address-book row that is not a saved contact yet.
   */
  it("is NEVER offered on an unimported external record", () => {
    renderPreview({ isExternal: true, onImport: jest.fn(), onLinkSource: jest.fn() });
    expect(screen.queryByTestId("contact-preview-link")).toBeNull();
    expect(screen.getByTestId("contact-preview-import")).toBeInTheDocument();
  });

  it("renders alone when a surface offers linking but not editing", () => {
    renderPreview({ onLinkSource: jest.fn() });
    expect(screen.getByTestId("contact-preview-link")).toBeInTheDocument();
    expect(screen.queryByTestId("contact-preview-edit")).toBeNull();
  });
});
