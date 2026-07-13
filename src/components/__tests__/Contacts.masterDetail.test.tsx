/**
 * Integration tests for the Contacts master-detail layout + clickable
 * transactions (BACKLOG-1898 T5).
 *
 * matchMedia is not implemented by jsdom / not mocked globally, so each case
 * installs its own matchMedia mock to drive the narrow/wide layout.
 */

import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import Contacts from "../Contacts";

// isDatabaseInitialized: true so the real component content renders.
jest.mock("../../appCore", () => ({
  ...jest.requireActual("../../appCore"),
  useAppStateMachine: () => ({
    isDatabaseInitialized: true,
  }),
}));

jest.mock("../../contexts/NetworkContext", () => ({
  useNetwork: () => ({
    isOnline: true,
    isChecking: false,
    lastOnlineAt: null,
    lastOfflineAt: null,
    connectionError: null,
    checkConnection: jest.fn(),
    clearError: jest.fn(),
    setConnectionError: jest.fn(),
  }),
}));

type Listener = (event: { matches: boolean }) => void;

function installMatchMedia(narrow: boolean) {
  const listeners = new Set<Listener>();
  const mql = {
    matches: narrow,
    media: "",
    addEventListener: (_e: string, cb: Listener) => listeners.add(cb),
    removeEventListener: (_e: string, cb: Listener) => listeners.delete(cb),
    addListener: (cb: Listener) => listeners.add(cb),
    removeListener: (cb: Listener) => listeners.delete(cb),
    onchange: null,
    dispatchEvent: () => true,
  };
  (window as unknown as { matchMedia: unknown }).matchMedia = jest
    .fn()
    .mockReturnValue(mql);
}

const mockUserId = "user-123";

// A client (imported) contact with a transaction, so the detail card shows a
// clickable transaction row.
const importedContact = {
  id: "contact-1",
  name: "John Doe",
  email: "john@example.com",
  phone: "555-1234",
  company: "ABC Real Estate",
  source: "manual",
  default_role: "buyer",
};

describe("Contacts - master-detail layout (BACKLOG-1898 T5)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    window.api.contacts.getAll.mockResolvedValue({
      success: true,
      contacts: [importedContact],
    });
    // checkCanDelete supplies the transaction list shown in the detail card.
    window.api.contacts.checkCanDelete.mockResolvedValue({
      success: true,
      transactions: [
        { id: "txn-99", property_address: "123 Main St", roles: ["buyer"] },
      ],
    });
  });

  afterEach(() => {
    delete (window as unknown as { matchMedia?: unknown }).matchMedia;
  });

  describe("wide viewport", () => {
    beforeEach(() => installMatchMedia(false));

    it("renders the two-pane layout with the list and an empty detail pane", async () => {
      render(<Contacts userId={mockUserId} onClose={jest.fn()} />);

      await waitFor(() => {
        expect(screen.getByText("John Doe")).toBeInTheDocument();
      });

      expect(
        screen.getByTestId("contacts-master-detail")
      ).toBeInTheDocument();
      // Detail pane is mounted (empty-state) before any selection.
      expect(screen.getByTestId("contacts-detail-empty")).toBeInTheDocument();
    });

    it("shows the contact detail inline in the pane after selecting a contact", async () => {
      render(<Contacts userId={mockUserId} onClose={jest.fn()} />);

      await waitFor(() => {
        expect(screen.getByText("John Doe")).toBeInTheDocument();
      });

      await userEvent.click(screen.getByText("John Doe"));

      // Detail body renders inline (pane) — no modal backdrop.
      await waitFor(() => {
        expect(screen.getByTestId("contact-preview-modal")).toBeInTheDocument();
      });
      expect(
        screen.queryByTestId("contact-preview-backdrop")
      ).not.toBeInTheDocument();
      expect(
        screen.queryByTestId("contacts-detail-empty")
      ).not.toBeInTheDocument();
    });

    it("highlights the clicked row in the list (BACKLOG-1898 QA fix)", async () => {
      render(<Contacts userId={mockUserId} onClose={jest.fn()} />);

      await waitFor(() => {
        expect(screen.getByText("John Doe")).toBeInTheDocument();
      });

      await userEvent.click(screen.getByText("John Doe"));

      await waitFor(() => {
        expect(screen.getByTestId("contact-preview-modal")).toBeInTheDocument();
      });

      const row = screen
        .getByTestId("contact-row-name")
        .closest('[role="option"]');
      expect(row).not.toBeNull();
      expect(row).toHaveAttribute("aria-selected", "true");
    });
  });

  describe("narrow viewport", () => {
    beforeEach(() => installMatchMedia(true));

    it("shows list only, then the detail card on selection, and Back returns to the list", async () => {
      render(<Contacts userId={mockUserId} onClose={jest.fn()} />);

      await waitFor(() => {
        expect(screen.getByText("John Doe")).toBeInTheDocument();
      });

      // List only — no detail view yet.
      expect(
        screen.queryByTestId("contacts-detail-view")
      ).not.toBeInTheDocument();

      // Select => full-screen detail card with a Back button.
      await userEvent.click(screen.getByText("John Doe"));
      await waitFor(() => {
        expect(screen.getByTestId("contacts-detail-view")).toBeInTheDocument();
      });
      expect(screen.getByTestId("contacts-detail-back")).toBeInTheDocument();

      // Back => returns to the list.
      await userEvent.click(screen.getByTestId("contacts-detail-back"));
      await waitFor(() => {
        expect(
          screen.queryByTestId("contacts-detail-view")
        ).not.toBeInTheDocument();
      });
      expect(screen.getByText("John Doe")).toBeInTheDocument();
    });
  });

  describe("clickable transactions", () => {
    beforeEach(() => installMatchMedia(false));

    it("fires onOpenTransaction with the transaction id when a row is clicked", async () => {
      const onOpenTransaction = jest.fn();
      render(
        <Contacts
          userId={mockUserId}
          onClose={jest.fn()}
          onOpenTransaction={onOpenTransaction}
        />
      );

      await waitFor(() => {
        expect(screen.getByText("John Doe")).toBeInTheDocument();
      });

      await userEvent.click(screen.getByText("John Doe"));

      // Wait for the transaction row (loaded via checkCanDelete) to render.
      const row = await screen.findByTestId(
        "contact-preview-transaction-txn-99"
      );
      await userEvent.click(row);

      expect(onOpenTransaction).toHaveBeenCalledWith("txn-99");
    });
  });

  describe("roles as a typed string[] (BACKLOG-1930 boundary + BACKLOG-1898 regression)", () => {
    beforeEach(() => installMatchMedia(false));

    it("renders the Transactions section when checkCanDelete returns `roles` as the real backend shape (a string[])", async () => {
      // Real backend behavior (getTransactionsByContact, BACKLOG-1930): each
      // transaction's `roles` field is a typed, deduped string[] at the IPC
      // boundary — the renderer owns the ", " display join (Contacts.tsx
      // mapper). This is the honest-typed replacement for the pre-joined
      // string that caused BACKLOG-1898's `t.roles?.join is not a function`
      // (a string has no .join). With roles now an array, the mapper's
      // `.join(", ")` is type-safe and the Transactions section renders.
      window.api.contacts.checkCanDelete.mockResolvedValue({
        success: true,
        canDelete: false,
        count: 2,
        transactions: [
          {
            id: "t1",
            property_address: "123 Main St",
            status: "active",
            roles: ["client"],
          },
          {
            id: "t2",
            property_address: "456 Oak Ave",
            status: "active",
            roles: ["title_company"],
          },
        ],
      });

      render(<Contacts userId={mockUserId} onClose={jest.fn()} />);

      await waitFor(() => {
        expect(screen.getByText("John Doe")).toBeInTheDocument();
      });

      await userEvent.click(screen.getByText("John Doe"));

      // BACKLOG-1944: the section header is now the "Transactions" title +
      // a separate count-badge pill showing the total (2), not a single
      // "Transactions (2)" string. Same intent (section renders, with the
      // total reflecting the 2 transactions) via the new structure — plus
      // the per-row testid assertions below already confirm both rows render.
      const transactionsHeading = await screen.findByText("Transactions");
      expect(transactionsHeading).toBeInTheDocument();
      const sectionHead = transactionsHeading.parentElement;
      expect(sectionHead).toHaveTextContent("2");

      expect(
        screen.getByTestId("contact-preview-transaction-t1")
      ).toBeInTheDocument();
      expect(
        screen.getByTestId("contact-preview-transaction-t2")
      ).toBeInTheDocument();
      expect(screen.getByText("123 Main St")).toBeInTheDocument();
      expect(screen.getByText("456 Oak Ave")).toBeInTheDocument();

      // Role label derived from the joined `roles` array (Contacts.tsx joins
      // with ", ", then formatRoleLabel formats — ["client"] -> "client" ->
      // "Client (Buyer/Seller)").
      expect(screen.getByText("Client (Buyer/Seller)")).toBeInTheDocument();
      expect(screen.getByText("Title Company")).toBeInTheDocument();
    });
  });
});
