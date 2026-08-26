/**
 * BACKLOG-2885 — the founder's exact symptom, asserted on the REAL header.
 *
 *   "after cliking complete i suddenly saw the export button appear"
 *
 * The hook suite (useCompleteTransaction.licenseUnknown-2885) proves Complete
 * takes neither action while the license class is unknown. It cannot prove what
 * he actually SAW, because the thing he saw was a button changing shape in the
 * header — a component the hook never touches. `TransactionDetails.tsx` derived
 * that button's visibility from the same expression that routed the action:
 *
 *     showExport={complete.resolveTarget() === "submit"}
 *
 * so an unread license hid it, and reading the license made it appear. Fixing
 * the ROUTING alone would have left that exactly as it was.
 *
 * THE REAL `TransactionHeader` IS RENDERED HERE. The sibling 2866 suite stubs it
 * to a pair of bare buttons, which is right for asking whether routes are wired
 * but useless for asking what a user sees: a stub renders whatever the test
 * author decided `showExport` means, so the assertion would be about the stub.
 *
 * CONTROL RUN (count in the PR): revert `showExport` to `=== "submit"` and drop
 * `licensePending` → the invariance case reddens.
 */
import React from "react";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { NotificationProvider } from "../../contexts/NotificationContext";

const exportMounts: { transactionId: string }[] = [];
const submitMounts: string[] = [];

/**
 * The license the screen reads, swapped between renders.
 *
 * UNREAD is transcribed from the state the provider actually emits, not
 * invented: `electron/handlers/licenseHandlers.ts` answers `success: true,
 * license_type: "individual", organization_id: undefined` when no session has
 * loaded, LicenseProvider mounts above auth and records that, and
 * `validateLicense` then fills in the team licenseType on login without ever
 * setting the organization. Hence canSubmit true, organizationId null,
 * isLoading FALSE — and isLicenseResolved false, which is the only field that
 * tells them apart from a genuine individual.
 */
const BROKERAGE_UNREAD = {
  licenseType: "team" as string,
  hasAIAddon: false,
  organizationId: null as string | null,
  canExport: false,
  canSubmit: true,
  canAutoDetect: false,
  isLoading: false,
  isLicenseResolved: false,
  refresh: jest.fn(),
};

const BROKERAGE_READ = {
  ...BROKERAGE_UNREAD,
  organizationId: "org-2885" as string | null,
  isLicenseResolved: true,
};

const mockLicense = { value: { ...BROKERAGE_UNREAD } };

jest.mock("../ExportModal", () => ({
  __esModule: true,
  default: (props: { transaction: { id: string } }) => {
    const { useEffect } = require("react") as typeof import("react");
    useEffect(() => {
      exportMounts.push({ transactionId: props.transaction.id });
    }, []);
    return <div data-testid="export-destination" />;
  },
}));

jest.mock("../transactionDetailsModule", () => {
  const actual = jest.requireActual<typeof import("../transactionDetailsModule")>(
    "../transactionDetailsModule",
  );
  return {
    ...actual,
    // TransactionHeader is deliberately NOT overridden — it is the subject.
    // ReviewPromptDialog is not overridden either: a spurious P3 flash is one of
    // the things being ruled out.
    TransactionEmailsTab: () => null,
    TransactionMessagesTab: () => null,
    TransactionAttachmentsTab: () => null,
    TransactionDetailsTab: () => null,
    TransactionTabs: () => null,
    ReviewNotesPanel: () => null,
    DeleteConfirmModal: () => null,
    UnlinkEmailModal: () => null,
    EmailViewModal: () => null,
    RejectReasonModal: () => null,
    EditContactsModal: () => null,
    NeedsReviewScreen: () => <div data-testid="needs-review-screen" />,
  };
});

jest.mock("../transactionDetailsModule/components/modals/SubmitForReviewModal", () => ({
  SubmitForReviewModal: () => {
    const { useEffect } = require("react") as typeof import("react");
    useEffect(() => {
      submitMounts.push("submit");
    }, []);
    return <div data-testid="submit-destination" />;
  },
}));

jest.mock("../transactionDetailsModule/components/ReviewNotesPanel", () => ({
  ReviewNotesPanel: () => null,
}));

jest.mock("../../contexts/LicenseContext", () => ({
  useLicense: () => mockLicense.value,
}));
jest.mock("../../contexts/AuthContext", () => ({
  useAuth: () => ({ currentUser: { id: "user-2885", email: "t@t.com" } }),
  useIsAuthenticated: () => true,
  useCurrentUser: () => ({ id: "user-2885", email: "t@t.com" }),
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
jest.mock("../../contexts/NetworkContext", () => ({
  useNetwork: () => ({ isOnline: true }),
}));
jest.mock("../../hooks/useSyncOrchestrator", () => ({
  useSyncOrchestrator: () => ({ isRunning: false }),
}));
jest.mock("../common/ResponsiveModal", () => ({
  ResponsiveModal: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  MODAL_PANEL: { lg: "" },
}));
jest.mock("../common/OfflineNotice", () => ({ OfflineNotice: () => null }));

import TransactionDetails from "../TransactionDetails";

const baseTransaction = {
  id: "txn-2885",
  user_id: "user-2885",
  property_address: "18 Bellweather Lane",
  transaction_type: "purchase" as const,
  status: "active" as const,
  submission_status: "not_submitted",
  message_count: 0,
  attachment_count: 0,
  export_status: "not_exported" as const,
  export_count: 0,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

beforeEach(() => {
  exportMounts.length = 0;
  submitMounts.length = 0;
  mockLicense.value = { ...BROKERAGE_UNREAD };

  window.api.transactions.getDetails = jest.fn().mockResolvedValue({
    success: true,
    transaction: { ...baseTransaction, communications: [], contact_assignments: [] },
  });
  /* eslint-disable @typescript-eslint/no-explicit-any */
  (window.api.transactions as any).getOverview = jest.fn().mockResolvedValue({
    success: true,
    transaction: { ...baseTransaction, contact_assignments: [] },
  });
  (window.api.transactions as any).getCommunications = jest.fn().mockResolvedValue({
    success: true,
    transaction: { communications: [], contact_assignments: [] },
  });
  (window.api.transactions as any).isAutoSyncInFlight = jest
    .fn()
    .mockResolvedValue({ inFlight: false });
  // An EMPTY review queue throughout, so the completeness gate can never be the
  // reason an action did not happen.
  (window.api.transactions as any).getReviewState = jest
    .fn()
    .mockResolvedValue({ count: 0, items: [], threadCount: 0 });
  (window.api.transactions as any).syncReviewQueue = jest.fn().mockResolvedValue({
    success: true, added: 0, linked: 0, found: 0,
  });
  /* eslint-enable @typescript-eslint/no-explicit-any */
  window.api.contacts.getAll = jest.fn().mockResolvedValue({ success: true, contacts: [] });
});

const renderDetails = () =>
  render(
    <TransactionDetails transaction={baseTransaction as never} onClose={jest.fn()} />,
    { wrapper: NotificationProvider },
  );

/**
 * TransactionHeader renders its action row TWICE — once in the `sm:hidden`
 * mobile layout and once in the `hidden sm:flex` desktop one — so every button
 * has two instances in jsdom, where CSS media queries do not apply. These
 * assert across BOTH copies deliberately: a fix applied to one layout and not
 * the other is a real bug on a real screen size, and a `[0]` lookup would hide
 * it.
 */
const exportButtons = () => screen.queryAllByTestId("header-export-button");
const completeButtons = () => screen.getAllByTestId("complete-button");

function expectAllPresentAnd(
  buttons: HTMLElement[],
  state: "disabled" | "enabled",
): void {
  expect(buttons.length).toBeGreaterThan(0);
  for (const b of buttons) {
    if (state === "disabled") expect(b).toBeDisabled();
    else expect(b).not.toBeDisabled();
  }
}

describe("BACKLOG-2885 — the Export button does not appear under the cursor", () => {
  it("a brokerage user sees the Export button in BOTH the unread and read states", async () => {
    // THE founder's symptom. Before the fix the button was absent in the first
    // half of this test and present in the second — it materialised the moment
    // the license landed, which for him was the moment he clicked.
    const view = renderDetails();
    await waitFor(() => expect(completeButtons().length).toBeGreaterThan(0));

    // License not read yet: present, and inert — in every layout.
    const unreadCount = exportButtons().length;
    expectAllPresentAnd(exportButtons(), "disabled");

    // The license lands.
    mockLicense.value = { ...BROKERAGE_READ };
    view.rerender(
      <NotificationProvider>
        <TransactionDetails transaction={baseTransaction as never} onClose={jest.fn()} />
      </NotificationProvider>,
    );
    await waitFor(() => expectAllPresentAnd(exportButtons(), "enabled"));

    // Still there, and the SAME number of them. Nothing appeared, nothing
    // moved — only the enabled state changed, which cannot shift a control out
    // from under a click.
    expect(exportButtons()).toHaveLength(unreadCount);
  });

  it("Complete is disabled while the license is unread, and clicking it exports nothing", async () => {
    renderDetails();
    await waitFor(() => expect(completeButtons().length).toBeGreaterThan(0));

    expectAllPresentAnd(completeButtons(), "disabled");

    fireEvent.click(completeButtons()[0]);

    // Neither destination, and no review-gate dialog about the wrong problem.
    await waitFor(() => expect(exportMounts).toHaveLength(0));
    expect(screen.queryByTestId("export-destination")).not.toBeInTheDocument();
    expect(screen.queryByTestId("submit-destination")).not.toBeInTheDocument();
    expect(screen.queryByTestId("review-prompt-blocked")).not.toBeInTheDocument();
  });

  it("once read, a brokerage user's Complete reaches SUBMIT — never a local export", async () => {
    mockLicense.value = { ...BROKERAGE_READ };
    renderDetails();
    await waitFor(() => expectAllPresentAnd(completeButtons(), "enabled"));

    fireEvent.click(completeButtons()[0]);

    await waitFor(() =>
      expect(screen.getByTestId("submit-destination")).toBeInTheDocument(),
    );
    expect(exportMounts).toHaveLength(0);
  });

  it("a genuine individual gets NO Export button once the license is read", async () => {
    // The other half of the visibility rule: the disabled button an individual
    // may briefly see is a loading state, not a control they keep.
    mockLicense.value = {
      ...BROKERAGE_UNREAD,
      licenseType: "individual",
      canSubmit: false,
      canExport: true,
      organizationId: null,
      isLicenseResolved: true,
    };
    renderDetails();
    await waitFor(() => expectAllPresentAnd(completeButtons(), "enabled"));

    expect(exportButtons()).toHaveLength(0);

    // And their Complete still reaches the export flow, which is their only
    // completion path.
    fireEvent.click(completeButtons()[0]);
    await waitFor(() =>
      expect(screen.getByTestId("export-destination")).toBeInTheDocument(),
    );
    expect(submitMounts).toHaveLength(0);
  });
});
