/**
 * BACKLOG-3951 — the no-license paywall in the REAL screen.
 *
 * ExportModal inside the real LicenseProvider: main's license:get answer
 * (window.api.license.get) flows through the real licenseService and
 * LicenseContext into ExportUnlockPrompt. A locked export by a member whose
 * standing is "unlicensed" shows the founder's sentence and no unlock; the same
 * screen without the standing shows the credit button (the control that the
 * test can tell the two apart). Deals unlocked earlier never reach the prompt:
 * a successful export stays a success.
 */

import React from "react";
import { render, screen, act, fireEvent } from "@testing-library/react";
import ExportModal from "../ExportModal";
import { LicenseProvider } from "../../contexts/LicenseContext";
import type { Transaction } from "../../../electron/types/models";

const updateMock = window.api.transactions.update as jest.Mock;
const exportEnhancedMock = window.api.transactions.exportEnhanced as jest.Mock;
const getStatusMock = window.api.entitlement.getStatus as jest.Mock;
const unlockMock = window.api.entitlement.unlockWithCredit as jest.Mock;
const featureCheckMock = window.api.featureGate.check as jest.Mock;

const TX = "tx-locked-3951";
const USER = "user-3951";
const PAYWALL = "PAYWALL_LOCKED: This transaction is locked. Unlock it to export.";

const transaction = {
  id: TX,
  user_id: USER,
  status: "active",
  property_address: "123 Main St",
  started_at: "2026-01-01T00:00:00Z",
  closed_at: "2026-03-01T00:00:00Z",
} as unknown as Transaction;

const licenseGet = jest.fn();
const VALID = {
  isValid: true,
  licenseType: "individual",
  transactionCount: 0,
  transactionLimit: 100,
  canCreateTransaction: true,
  deviceCount: 1,
  deviceLimit: 2,
  aiEnabled: false,
};

function licenseAnswer(membership?: { standing: string }) {
  return {
    success: true,
    sessionBacked: true,
    license: { license_type: "individual", ai_detection_enabled: false },
    ...(membership ? { membership } : {}),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  (window.api as unknown as { license: unknown }).license = {
    get: licenseGet,
    refresh: licenseGet,
    validate: jest.fn().mockResolvedValue(VALID),
    create: jest.fn().mockResolvedValue(VALID),
    incrementTransactionCount: jest.fn(),
    clearCache: jest.fn(),
  };
  featureCheckMock.mockResolvedValue({ allowed: true, value: "", source: "default" });
  updateMock.mockResolvedValue({ success: true });
  getStatusMock.mockResolvedValue({
    localTransactionId: TX,
    status: "locked",
    lockReason: "no_unlock",
    fromCache: false,
    quote: { nextUnitIndex: 1, unitPriceCents: 1300, currency: "USD", pricingTierId: "t1" },
    creditBalance: 1,
  });
});

async function driveToExport(): Promise<void> {
  const nextButtons = await screen.findAllByRole("button", { name: /next/i });
  await act(async () => {
    fireEvent.click(nextButtons[0]);
  });
  const exportButtons = await screen.findAllByRole("button", { name: /^export$/i });
  await act(async () => {
    fireEvent.click(exportButtons[0]);
  });
}

function renderScreen() {
  render(
    <LicenseProvider userId={USER}>
      <ExportModal transaction={transaction} userId={USER} onClose={jest.fn()} onExportComplete={jest.fn()} />
    </LicenseProvider>,
  );
}

it("unlicensed member, locked export ⇒ the founder's sentence, no unlock", async () => {
  licenseGet.mockResolvedValue(licenseAnswer({ standing: "unlicensed" }));
  exportEnhancedMock.mockResolvedValue({ success: false, error: PAYWALL });
  renderScreen();
  await driveToExport();

  const panel = await screen.findByTestId("paywall-no-license");
  expect(panel).toHaveTextContent("Your brokerage hasn't assigned you a license. Contact your admin.");
  expect(screen.queryByTestId("unlock-with-credit")).toBeNull();
  expect(screen.queryByTestId("unlock-purchase")).toBeNull();
  expect(screen.queryByTestId("agent-subscribe")).toBeNull();
  expect(unlockMock).not.toHaveBeenCalled();
});

it("control: same screen, standing not known ⇒ the credit button (plan cards)", async () => {
  licenseGet.mockResolvedValue(licenseAnswer());
  exportEnhancedMock.mockResolvedValue({ success: false, error: PAYWALL });
  renderScreen();
  await driveToExport();

  expect(await screen.findByTestId("unlock-with-credit")).toBeInTheDocument();
  expect(screen.queryByTestId("paywall-no-license")).toBeNull();
});

it("unlicensed member, deal unlocked earlier ⇒ export succeeds, no prompt", async () => {
  licenseGet.mockResolvedValue(licenseAnswer({ standing: "unlicensed" }));
  exportEnhancedMock.mockResolvedValue({ success: true, path: "/out/audit" });
  renderScreen();
  await driveToExport();

  expect(exportEnhancedMock).toHaveBeenCalledTimes(1);
  expect(screen.queryByTestId("export-unlock-prompt")).toBeNull();
  expect(screen.queryByTestId("paywall-no-license")).toBeNull();
});
