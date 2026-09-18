/**
 * =============================================================================
 * BACKLOG-2707 — the Add Contact form saves what `contacts:create` accepts
 * =============================================================================
 * PM decision `5fac2d84` (2026-09-07, on the founder's delegated authority): a
 * company-only contact may be created by hand even though it may not be
 * imported. **That decision was not true in the app when it was made.**
 *
 * `contacts:create` already accepted it — driven through the registered handler
 * against a real database:
 *
 *   CREATE company-only  refused=false  display_name:"" company:"Vantrees Realty"
 *   CREATE name-only     refused=false  display_name:"Gus Example"
 *
 * The refusal was in this form, at two independent gates: `canSave` disabled the
 * button before the press, and `handleSave` refused `!formData.name.trim()`
 * after it. A renderer rule refusing what the handler allows — the fourth
 * instance of this item's own shape.
 *
 * WHY THIS TEST IS AT THE FORM AND NOT AT THE HANDLER. A handler-level test
 * passes while the user still cannot do it. That is the mistake this item has
 * now made four times: the writer's `"Unknown"` fallback, the create-guard
 * TypeError, the `Contacts.tsx` diversion the founder caught at Step 12a, and
 * this. The layer that refuses is the layer that must be driven.
 *
 * The practical stake, in PM's words: blocking hand-creation does not stop the
 * data, it makes the user type "Vantrees Realty" into the NAME field — a
 * company sitting in a person's name field, polluting every name-based match.
 * The Name box was marked required and Save was disabled without it, so that
 * was not a risk, it was the only path the UI offered.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import ContactFormModal from "../ContactFormModal";

const createMock = jest.fn();

beforeAll(() => {
  (window as any).api = (window as any).api ?? {};
  (window as any).api.contacts = {
    ...((window as any).api.contacts ?? {}),
    getEditData: jest.fn().mockResolvedValue({ success: true, emails: [], phones: [] }),
    create: createMock,
    update: jest.fn(),
  };
});

beforeEach(() => {
  createMock.mockReset();
  createMock.mockResolvedValue({ success: true, contact: { id: "new-1" } });
});

function renderAddForm() {
  return render(
    <ContactFormModal
      userId="user-2707"
      contact={undefined}
      onClose={jest.fn()}
      onSuccess={jest.fn()}
    />,
  );
}

function saveButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: /add contact|update contact/i }) as HTMLButtonElement;
}

describe("the Add Contact form saves what the handler accepts (BACKLOG-2707)", () => {
  it("an empty form still cannot be saved — the door is not left open", async () => {
    renderAddForm();

    // `hasNothingToSave` is still a real gate. Relaxing the name rule must not
    // become "anything goes"; BACKLOG-2684 exists to stop an empty record.
    expect(saveButton()).toBeDisabled();
  });

  /**
   * PM decision `5fac2d84`, as the founder will exercise it at the re-gate:
   * open Add Contact, type only a company name, press Save.
   */
  it("saves a COMPANY-ONLY contact — the decision, at the layer that refused it", async () => {
    renderAddForm();

    await userEvent.type(screen.getByPlaceholderText("ABC Real Estate"), "Vantrees Realty");

    expect(saveButton()).toBeEnabled();
    await userEvent.click(saveButton());

    await waitFor(() => expect(createMock).toHaveBeenCalled());
    const [, payload] = createMock.mock.calls[0];
    expect(payload.company).toBe("Vantrees Realty");
    // The name goes to the handler EMPTY rather than carrying the company —
    // which is the whole point of allowing this: the company stays in the
    // company field instead of being typed into the name box.
    expect(payload.name).toBe("");
  });

  /**
   * The other half the form refused and the handler always accepted. A person
   * whose phone and email you do not have yet is an ordinary thing to record.
   */
  it("saves a NAME-ONLY contact, with no phone and no email", async () => {
    renderAddForm();

    await userEvent.type(screen.getByPlaceholderText("John Doe"), "Gus Example");

    expect(saveButton()).toBeEnabled();
    await userEvent.click(saveButton());

    await waitFor(() => expect(createMock).toHaveBeenCalled());
    expect(createMock.mock.calls[0][1].name).toBe("Gus Example");
  });

  /**
   * =========================================================================
   * EDIT MODE — CLEARING A NAME NOW SAVES. STATED, BECAUSE IT IS A WIDENING.
   * =========================================================================
   * `handleSave`'s old `if (!formData.name.trim())` served Add AND Edit, so
   * relaxing it changed both. SR measured the difference at the two SHAs:
   *
   *   base   Save disabled = true   (refused, as it always had)
   *   head   Save disabled = false  -> update called with name: ""
   *
   * It is CONSISTENT — `contacts:update` never required a name, and the
   * NOT NULL column is safe because the validator resolves every spelling of
   * "no name" to `""` rather than `null`. It is also a behaviour change on a
   * surface no ruling named and no test pinned, and this item is the standing
   * proof of what an unstated renderer rule costs in either direction.
   *
   * Pinned here so it is a decision. If it should be stricter on Edit than on
   * Add, that is PM's call to make explicitly — and this test is what goes red.
   */
  it("clearing the Name on an EXISTING contact saves, with an empty name", async () => {
    const updateMock = jest.mocked((window as any).api.contacts.update);
    updateMock.mockResolvedValue({ success: true });

    render(
      <ContactFormModal
        userId="user-2707"
        contact={
          {
            id: "c-existing",
            name: "Dana Whitlock",
            display_name: "Dana Whitlock",
            phone: "+14155550142",
          } as any
        }
        onClose={jest.fn()}
        onSuccess={jest.fn()}
      />,
    );

    const nameBox = await screen.findByDisplayValue("Dana Whitlock");
    await userEvent.clear(nameBox);

    // The contact still has a phone, so `hasNothingToSave` is false and Save
    // stays live — the record is not being emptied, only unnamed.
    expect(saveButton()).toBeEnabled();
    await userEvent.click(saveButton());

    await waitFor(() => expect(updateMock).toHaveBeenCalled());
    expect(updateMock.mock.calls[0][1].name).toBe("");
  });

  /**
   * The other half of the same surface: emptying an existing contact entirely
   * is still refused. Relaxing the name rule must not become "anything goes"
   * on Edit any more than it did on Add.
   */
  it("but emptying an existing contact completely is still refused", async () => {
    render(
      <ContactFormModal
        userId="user-2707"
        contact={{ id: "c-bare", name: "Dana Whitlock", display_name: "Dana Whitlock" } as any}
        onClose={jest.fn()}
        onSuccess={jest.fn()}
      />,
    );

    await userEvent.clear(await screen.findByDisplayValue("Dana Whitlock"));

    expect(saveButton()).toBeDisabled();
  });

  /**
   * The affordance has to agree with the rule. A red asterisk on Name claimed a
   * requirement the form no longer enforces and `contacts:create` never had —
   * the same defect as a disabled button stating an untrue reason, which is
   * what this item is named after.
   */
  it("no longer marks Name as required", () => {
    renderAddForm();

    const nameLabel = screen.getByText(/^name$/i);
    expect(nameLabel.textContent).not.toContain("*");
  });
});
