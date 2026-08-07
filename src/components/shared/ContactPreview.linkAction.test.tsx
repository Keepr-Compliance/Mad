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
  id: "c-ada",
  user_id: "u1",
  display_name: "Ada Lovelace",
  email: "ada@example.com",
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
