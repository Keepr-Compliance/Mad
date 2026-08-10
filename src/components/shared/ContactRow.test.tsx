import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ContactRow, ContactRowProps } from "./ContactRow";
import type { ExtendedContact } from "../../types/components";
import type { ContactSource } from "../../../electron/types/models";

// Helper to create a test contact
function createTestContact(
  overrides: Partial<ExtendedContact> = {}
): ExtendedContact {
  return {
    id: "test-contact-1",
    user_id: "user-1",
    name: "John Doe",
    display_name: "John Doe",
    email: "john@example.com",
    phone: "555-1234",
    company: "Acme Inc",
    title: "Agent",
    // "imported" is not a member of the ContactSource union (legacy fixture
    // value). Kept verbatim so the fixture data is unchanged; ContactRow no
    // longer renders source pills, so the value is inert at runtime.
    source: "imported" as unknown as ContactSource,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

// Helper to render with default props
function renderContactRow(props: Partial<ContactRowProps> = {}) {
  const defaultProps: ContactRowProps = {
    contact: createTestContact(),
    ...props,
  };
  return render(<ContactRow {...defaultProps} />);
}

describe("ContactRow", () => {
  describe("Rendering", () => {
    it("displays contact name", () => {
      renderContactRow();
      expect(screen.getByTestId("contact-row-name")).toHaveTextContent(
        "John Doe"
      );
    });

    it("displays avatar with first initial", () => {
      renderContactRow();
      const avatar = screen.getByTestId("contact-row-avatar");
      expect(avatar).toHaveTextContent("J");
    });

    // BACKLOG-2356: rows are name-only. The secondary email/phone line and the
    // source/import-status pills are no longer rendered in any mode — full
    // details live in the contact detail/preview pane.
    it("does not render the secondary email/phone line even when an email is present", () => {
      renderContactRow({
        contact: createTestContact({ email: "john@example.com" }),
      });
      expect(screen.getByTestId("contact-row-name")).toHaveTextContent(
        "John Doe"
      );
      expect(screen.queryByTestId("contact-row-email")).not.toBeInTheDocument();
      // The email value must not leak into the row via any other node.
      expect(screen.queryByText("john@example.com")).not.toBeInTheDocument();
    });

    it("does not render a source pill", () => {
      renderContactRow({
        contact: createTestContact({ source: "contacts_app" }),
      });
      expect(screen.queryByTestId(/^source-pill-/)).not.toBeInTheDocument();
    });

    it("does not render an import-status pill", () => {
      renderContactRow({
        contact: createTestContact({ source: "manual", is_message_derived: false }),
      });
      expect(screen.queryByTestId(/^status-pill-/)).not.toBeInTheDocument();
    });

    it("renders name-only for message-derived (external) contacts too", () => {
      renderContactRow({
        contact: createTestContact({ is_message_derived: true }),
      });
      expect(screen.getByTestId("contact-row-name")).toBeInTheDocument();
      expect(screen.queryByTestId(/^source-pill-/)).not.toBeInTheDocument();
      expect(screen.queryByTestId(/^status-pill-/)).not.toBeInTheDocument();
      expect(screen.queryByTestId("contact-row-email")).not.toBeInTheDocument();
    });

    it("uses display_name over name if available", () => {
      renderContactRow({
        contact: createTestContact({
          name: "John D",
          display_name: "John Doe III",
        }),
      });
      expect(screen.getByTestId("contact-row-name")).toHaveTextContent(
        "John Doe III"
      );
    });

    it("falls back to name if display_name is not available", () => {
      renderContactRow({
        contact: createTestContact({
          name: "Jane Smith",
          display_name: undefined,
        }),
      });
      expect(screen.getByTestId("contact-row-name")).toHaveTextContent(
        "Jane Smith"
      );
    });

    // BACKLOG-2461: these used to assert "Unknown Contact". 18 of a real
    // 1,124-contact address book have no name, and all 18 rendered as that one
    // string — indistinguishable from each other while we held their numbers.
    it("falls back to the organisation when there is no name", () => {
      renderContactRow({
        contact: createTestContact({
          name: undefined,
          display_name: undefined,
        }),
      });
      expect(screen.getByTestId("contact-row-name")).toHaveTextContent(
        "Acme Inc"
      );
    });

    it("falls back to the formatted phone when there is no name or organisation", () => {
      renderContactRow({
        contact: createTestContact({
          name: undefined,
          display_name: undefined,
          company: undefined,
          phone: "+14155550134",
        }),
      });
      expect(screen.getByTestId("contact-row-name")).toHaveTextContent(
        "+1 (415) 555-0134"
      );
    });

    it("keeps the country code on a non-US number", () => {
      renderContactRow({
        contact: createTestContact({
          name: undefined,
          display_name: undefined,
          company: undefined,
          phone: "+50664103686",
        }),
      });
      expect(screen.getByTestId("contact-row-name")).toHaveTextContent(
        "+50664103686"
      );
    });

    it("falls back to the email when there is no name, organisation or phone", () => {
      renderContactRow({
        contact: createTestContact({
          name: undefined,
          display_name: undefined,
          company: undefined,
          phone: undefined,
          email: "john@example.com",
        }),
      });
      expect(screen.getByTestId("contact-row-name")).toHaveTextContent(
        "john@example.com"
      );
    });

    it('shows "No name" only when we hold nothing at all', () => {
      renderContactRow({
        contact: createTestContact({
          name: undefined,
          display_name: undefined,
          company: undefined,
          phone: undefined,
          email: undefined,
        }),
      });
      expect(screen.getByTestId("contact-row-name")).toHaveTextContent(
        "No name"
      );
    });

    it("takes the avatar initial from whatever the label resolved to", () => {
      renderContactRow({
        contact: createTestContact({
          name: undefined,
          display_name: undefined,
        }),
      });
      // "A" from "Acme Inc" — the organisation, not a placeholder.
      expect(screen.getByTestId("contact-row-avatar")).toHaveTextContent("A");
    });
  });

  describe("Checkbox", () => {
    it("shows checkbox when showCheckbox is true", () => {
      renderContactRow({ showCheckbox: true });
      expect(screen.getByTestId("contact-row-checkbox")).toBeInTheDocument();
    });

    it("hides checkbox when showCheckbox is false", () => {
      renderContactRow({ showCheckbox: false });
      expect(
        screen.queryByTestId("contact-row-checkbox")
      ).not.toBeInTheDocument();
    });

    it("checkbox is checked when isSelected is true", () => {
      renderContactRow({ showCheckbox: true, isSelected: true });
      const checkbox = screen.getByTestId("contact-row-checkbox");
      // Check for purple background indicating checked state
      expect(checkbox).toHaveClass("bg-purple-600");
    });

    it("checkbox is unchecked when isSelected is false", () => {
      renderContactRow({ showCheckbox: true, isSelected: false });
      const checkbox = screen.getByTestId("contact-row-checkbox");
      expect(checkbox).toHaveClass("bg-white");
      expect(checkbox).not.toHaveClass("bg-purple-600");
    });
  });

  describe("Import Button", () => {
    it("shows import button for external (message-derived) contacts when showImportButton is true", () => {
      renderContactRow({
        showImportButton: true,
        contact: createTestContact({ is_message_derived: true }),
      });
      expect(
        screen.getByTestId("contact-row-import-button")
      ).toBeInTheDocument();
    });

    it("shows import button for external contacts with is_message_derived=1", () => {
      renderContactRow({
        showImportButton: true,
        contact: createTestContact({ is_message_derived: 1 }),
      });
      expect(
        screen.getByTestId("contact-row-import-button")
      ).toBeInTheDocument();
    });

    it("shows import button for any contact when showImportButton is true", () => {
      // Note: The parent component is responsible for deciding when to show
      // the import button based on contact type
      renderContactRow({
        showImportButton: true,
        contact: createTestContact({ is_message_derived: false }),
      });
      expect(
        screen.getByTestId("contact-row-import-button")
      ).toBeInTheDocument();
    });

    it("hides import button when showImportButton is false", () => {
      renderContactRow({
        showImportButton: false,
        contact: createTestContact({ is_message_derived: true }),
      });
      expect(
        screen.queryByTestId("contact-row-import-button")
      ).not.toBeInTheDocument();
    });

    it("calls onImport when import button clicked", async () => {
      const onImport = jest.fn();
      renderContactRow({
        showImportButton: true,
        contact: createTestContact({ is_message_derived: true }),
        onImport,
      });

      await userEvent.click(screen.getByTestId("contact-row-import-button"));
      expect(onImport).toHaveBeenCalledTimes(1);
    });

    it("does not call onSelect when import button clicked", async () => {
      const onSelect = jest.fn();
      const onImport = jest.fn();
      renderContactRow({
        showImportButton: true,
        contact: createTestContact({ is_message_derived: true }),
        onSelect,
        onImport,
      });

      await userEvent.click(screen.getByTestId("contact-row-import-button"));
      expect(onImport).toHaveBeenCalledTimes(1);
      expect(onSelect).not.toHaveBeenCalled();
    });

    it("import button has accessible label", () => {
      renderContactRow({
        showImportButton: true,
        contact: createTestContact({ is_message_derived: true, display_name: "Jane" }),
      });
      const button = screen.getByTestId("contact-row-import-button");
      expect(button).toHaveAttribute("aria-label", "Add Jane");
    });
  });

  // BACKLOG-2400: the two-pane picker's per-row "+ Add" affordance. Unlike the
  // import button (which calls onImport), this calls onSelect — the row's
  // add-to-selection action — and stops propagation so the row's own onClick
  // does not ALSO fire onSelect (a double-toggle).
  describe("Add Button (BACKLOG-2400)", () => {
    it("shows the + Add button when showAddButton is true", () => {
      renderContactRow({ showAddButton: true });
      expect(screen.getByTestId("contact-row-add-button")).toHaveTextContent("+ Add");
    });

    it("hides the + Add button when showAddButton is false (default)", () => {
      renderContactRow({ showAddButton: false });
      expect(screen.queryByTestId("contact-row-add-button")).not.toBeInTheDocument();
    });

    it("calls onSelect exactly once when the + Add button is clicked", async () => {
      const onSelect = jest.fn();
      renderContactRow({ showAddButton: true, onSelect });
      await userEvent.click(screen.getByTestId("contact-row-add-button"));
      expect(onSelect).toHaveBeenCalledTimes(1);
    });

    it("does not render the + Add button while adding (isAdding)", () => {
      renderContactRow({ showAddButton: true, isAdding: true });
      expect(screen.queryByTestId("contact-row-add-button")).not.toBeInTheDocument();
      expect(screen.getByTestId("contact-row-adding-indicator")).toBeInTheDocument();
    });

    it("+ Add button has an accessible label", () => {
      renderContactRow({
        showAddButton: true,
        contact: createTestContact({ display_name: "Jane" }),
      });
      expect(screen.getByTestId("contact-row-add-button")).toHaveAttribute(
        "aria-label",
        "Add Jane"
      );
    });
  });

  describe("Compact mode (BACKLOG-1898 Phase-1 layout polish)", () => {
    it("defaults to non-compact: avatar is rendered", () => {
      renderContactRow();
      expect(screen.getByTestId("contact-row-avatar")).toBeInTheDocument();
    });

    it("omits the avatar when compact is true", () => {
      renderContactRow({ compact: true });
      expect(screen.queryByTestId("contact-row-avatar")).not.toBeInTheDocument();
    });

    it("does not render the + Add Contact button when compact is true, even if showImportButton is true", () => {
      renderContactRow({
        compact: true,
        showImportButton: true,
        contact: createTestContact({ is_message_derived: true }),
      });
      expect(
        screen.queryByTestId("contact-row-import-button")
      ).not.toBeInTheDocument();
    });

    it("renders the + Add Contact button in non-compact mode when showImportButton is true", () => {
      renderContactRow({
        compact: false,
        showImportButton: true,
        contact: createTestContact({ is_message_derived: true }),
      });
      expect(screen.getByTestId("contact-row-import-button")).toBeInTheDocument();
    });

    // BACKLOG-2356: rows are name-only, so pills are never rendered regardless
    // of compact/viewport. `compact` now only affects the avatar and the
    // per-row "+ Add Contact" button (covered above).
    it("never renders pills in compact mode", () => {
      renderContactRow({ compact: true });
      expect(screen.queryByTestId(/^source-pill-/)).not.toBeInTheDocument();
      expect(screen.queryByTestId(/^status-pill-/)).not.toBeInTheDocument();
    });

    it("never renders pills in non-compact mode", () => {
      renderContactRow({ compact: false });
      expect(screen.queryByTestId(/^source-pill-/)).not.toBeInTheDocument();
      expect(screen.queryByTestId(/^status-pill-/)).not.toBeInTheDocument();
    });
  });

  describe("Selection", () => {
    it("calls onSelect when row is clicked", async () => {
      const onSelect = jest.fn();
      renderContactRow({ onSelect });

      await userEvent.click(screen.getByTestId("contact-row"));
      expect(onSelect).toHaveBeenCalledTimes(1);
    });

    it("calls onSelect on Enter key", () => {
      const onSelect = jest.fn();
      renderContactRow({ onSelect });

      const row = screen.getByTestId("contact-row");
      fireEvent.keyDown(row, { key: "Enter" });
      expect(onSelect).toHaveBeenCalledTimes(1);
    });

    it("calls onSelect on Space key", () => {
      const onSelect = jest.fn();
      renderContactRow({ onSelect });

      const row = screen.getByTestId("contact-row");
      fireEvent.keyDown(row, { key: " " });
      expect(onSelect).toHaveBeenCalledTimes(1);
    });

    it("does not call onSelect on other keys", () => {
      const onSelect = jest.fn();
      renderContactRow({ onSelect });

      const row = screen.getByTestId("contact-row");
      fireEvent.keyDown(row, { key: "Tab" });
      fireEvent.keyDown(row, { key: "Escape" });
      expect(onSelect).not.toHaveBeenCalled();
    });

    it("shows selected styling when isSelected is true", () => {
      renderContactRow({ isSelected: true });
      const row = screen.getByTestId("contact-row");
      expect(row).toHaveClass("bg-purple-50");
    });

    it("shows hover styling when isSelected is false", () => {
      renderContactRow({ isSelected: false });
      const row = screen.getByTestId("contact-row");
      expect(row).toHaveClass("hover:bg-gray-50");
      expect(row).not.toHaveClass("bg-purple-50");
    });
  });

  describe("Accessibility", () => {
    it("has role option", () => {
      renderContactRow();
      const row = screen.getByTestId("contact-row");
      expect(row).toHaveAttribute("role", "option");
    });

    it("has aria-selected attribute matching isSelected", () => {
      const { rerender } = render(
        <ContactRow contact={createTestContact()} isSelected={false} />
      );
      expect(screen.getByTestId("contact-row")).toHaveAttribute(
        "aria-selected",
        "false"
      );

      rerender(<ContactRow contact={createTestContact()} isSelected={true} />);
      expect(screen.getByTestId("contact-row")).toHaveAttribute(
        "aria-selected",
        "true"
      );
    });

    it("is focusable with tabIndex", () => {
      renderContactRow();
      const row = screen.getByTestId("contact-row");
      expect(row).toHaveAttribute("tabIndex", "0");
    });
  });

  describe("Custom className", () => {
    it("applies custom className to row", () => {
      renderContactRow({ className: "custom-class" });
      const row = screen.getByTestId("contact-row");
      expect(row).toHaveClass("custom-class");
    });
  });

  /**
   * =========================================================================
   * BACKLOG-2556 — TWO CONTROLS THAT LOOKED IDENTICAL ON SCREEN. ONE SURVIVES.
   * =========================================================================
   * The founder read both out of the live DOM on 2026-08-09 and asked whether
   * he was confusing them. He was not — they used the SAME TWO WORDS:
   *
   *   A  `contact-row-collapsed-toggle`  purple, expandable   "1 record combined"
   *      On an UNIMPORTED address-book record. A GUESS: the picker had folded
   *      another record into this row on a shared email or phone, and nothing
   *      the user did put it there. DELETED.
   *
   *   B  `contact-row-review-flag`       amber pill           "2 records combined"
   *      On a SAVED contact. A FACT: `review_state` is stamped from the
   *      crosswalk, so it counts records genuinely linked. STAYS.
   *
   * Deleting A resolves the collision by itself, which is why the founder chose
   * deletion over rewording — rewording would have kept a guess he had already
   * ruled out. This block pins BOTH halves of that outcome in one render, so
   * "the purple one is gone" and "the amber one is untouched" cannot drift
   * apart. B's own separate defect (it counts COLUMNS while its sentence counts
   * RECORDS, BACKLOG-2471) is deliberately NOT fixed here and NOT asserted
   * against, so this guard stays true either way.
   *
   * WHAT THE NEGATIVE ASSERTION CAN AND CANNOT CATCH, stated rather than
   * implied: it catches the purple block being re-added to this component. It
   * cannot catch a re-added block behind a prop nobody passes — but the prop
   * itself (`collapsedRecords`) is deleted, so re-adding one is a type error at
   * every call site rather than a silent no-op. The behavioural control lives
   * in the main process (`contact-handlers.foldDeleted-2556.test.ts`), which is
   * where the fold actually was.
   */
  describe("the fold is gone and the crosswalk badge is not (BACKLOG-2556)", () => {
    it("renders the amber review flag from review_state, unchanged", () => {
      renderContactRow({
        contact: createTestContact({
          review_state: { needsReview: true, columns: 2 },
        }),
      });

      const flag = screen.getByTestId("contact-row-review-flag");
      expect(flag).toHaveTextContent("2 records combined");
      expect(flag).toHaveClass("bg-amber-50");
    });

    it("still renders the green Confirmed pill when nothing needs review", () => {
      renderContactRow({
        contact: createTestContact({
          review_state: { needsReview: false, columns: 1 },
        }),
      });

      expect(screen.getByTestId("contact-row-confirmed-flag")).toHaveTextContent(
        "Confirmed",
      );
      expect(
        screen.queryByTestId("contact-row-review-flag"),
      ).not.toBeInTheDocument();
    });

    it("never renders the purple collapsed disclosure, on any row", () => {
      // Rendered WITH a review_state so the amber badge is present in the same
      // DOM: this asserts the two were separated, not that the row is empty.
      renderContactRow({
        contact: createTestContact({
          review_state: { needsReview: true, columns: 2 },
        }),
      });

      expect(screen.getByTestId("contact-row-review-flag")).toBeInTheDocument();
      expect(
        screen.queryByTestId("contact-row-collapsed-toggle"),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByTestId("contact-row-collapsed-detail"),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByTestId("contact-row-collapsed-record-reason"),
      ).not.toBeInTheDocument();
    });
  });
});
