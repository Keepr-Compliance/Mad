/**
 * BACKLOG-4149 — a plan that carries `unlimited_transactions` has NO transaction cap,
 * whatever `max_transaction_size` says.
 *
 * Real LicenseProvider + real useFeatureGate (only `window.api.featureGate.getAll` is
 * mocked), then the real AccountSettings and the real Dashboard on top of it.
 *
 * Fixtures are the get_org_features payload after featureGateService maps
 * `{enabled,value,source}` to `{allowed,value,source}`, transcribed from the production
 * plan rows (read-only, 2026-11-05). The trap: the Agent subscription and the Unlimited
 * override arrive as `allowed:true, value:"false", source:"override"`, so the rule must
 * read `allowed`, never `value`. Identifiers are placeholders.
 *
 * Controls (mutation -> red test), each run and recorded on the backlog item:
 *   ignore unlimited / unlimited=false  -> C1a, C1b, C1c, C4 unlimited, C5 unlimited
 *   always Infinity                     -> C2a, C2b, C2c, C2d, C4 individual, C5 individual
 *   read `value === "true"`             -> C1c only
 *   fail-open featureIsAllowed()        -> C2c only
 *   missing cap read as 0               -> C3 only
 */
import React from "react";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { LicenseProvider, useLicense } from "../LicenseContext";
import { AccountSettings } from "../../components/settings/account/AccountSettings";
import Dashboard from "../../components/Dashboard";

jest.mock("../../services", () => ({
  __esModule: true,
  licenseService: { get: jest.fn(), validate: jest.fn(), create: jest.fn() },
}));

const mockLicenseService = (
  jest.requireMock("../../services") as {
    licenseService: { get: jest.Mock; validate: jest.Mock; create: jest.Mock };
  }
).licenseService;

jest.mock("../../utils/logger", () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

// Dashboard's heavy neighbours, stubbed as in Dashboard.test.tsx. The license context,
// the feature gate and the New Transaction handler are the real ones.
jest.mock("react-joyride", () => ({ __esModule: true, default: () => null }));
jest.mock("../../hooks/useTour", () => ({
  useTour: () => ({ runTour: false, handleJoyrideCallback: jest.fn() }),
}));
jest.mock("../../hooks/usePendingTransactionCount", () => ({
  usePendingTransactionCount: () => ({ pendingCount: 0 }),
}));
jest.mock("../../hooks/useSyncOrchestrator", () => ({
  useSyncOrchestrator: () => ({ isRunning: false }),
}));
jest.mock("../../hooks/useReconnectionSummary", () => ({ useReconnectionSummary: () => {} }));
jest.mock("../../components/dashboard/index", () => ({
  SyncStatusIndicator: () => <div data-testid="sync-status-indicator" />,
}));
jest.mock("../../components/StartNewAuditModal", () => ({
  __esModule: true,
  default: () => <div data-testid="start-new-audit-modal" />,
}));
jest.mock("../../components/common/AlertBanner", () => ({
  AlertBanner: () => null,
  AlertIcons: { email: null, warning: null },
}));
jest.mock("../../components/common/TransactionLimitModal", () => ({
  TransactionLimitModal: () => <div data-testid="limit-modal" />,
}));
jest.mock("../../config/tourSteps", () => ({
  getDashboardTourSteps: () => [],
  JOYRIDE_STYLES: {},
  JOYRIDE_LOCALE: {},
}));
jest.mock("../../components/settings/billing/PlanBillingCard", () => ({
  PlanBillingCard: () => null,
}));

type Access = { allowed: boolean; value: string; source: "plan" | "override" | "default" };
type FeatureMap = Record<string, Access>;

const AI_OFF: Access = { allowed: false, value: "false", source: "plan" };
const CAP = (value: string): Access => ({ allowed: true, value, source: "plan" });

/** Keepr Internal org: enterprise plan, cap "10", unlimited on via the plan. */
const KEEPR_INTERNAL: FeatureMap = {
  max_transaction_size: CAP("10"),
  unlimited_transactions: { allowed: true, value: "true", source: "plan" },
  ai_detection: AI_OFF,
};
/** Team org: cap "100", unlimited on via the plan. */
const TEAM: FeatureMap = {
  max_transaction_size: CAP("100"),
  unlimited_transactions: { allowed: true, value: "true", source: "plan" },
  ai_detection: AI_OFF,
};
/** Individual + Agent subscription (stripe override): allowed:true but value "false". */
const AGENT_OVERRIDE: FeatureMap = {
  max_transaction_size: CAP("10"),
  unlimited_transactions: { allowed: true, value: "false", source: "override" },
  ai_detection: AI_OFF,
};
/** Individual, no override: unlimited off. */
const INDIVIDUAL: FeatureMap = {
  max_transaction_size: CAP("10"),
  unlimited_transactions: { allowed: false, value: "false", source: "plan" },
  ai_detection: AI_OFF,
};
/** Cap present, no unlimited_transactions key at all (e.g. a cache older than the feature). */
const CAP_WITHOUT_UNLIMITED_KEY: FeatureMap = {
  max_transaction_size: CAP("10"),
  ai_detection: AI_OFF,
};
/** Suspended brokerage (S1): Team cap "100", unlimited written off by the override. */
const SUSPENDED_TEAM: FeatureMap = {
  max_transaction_size: CAP("100"),
  unlimited_transactions: { allowed: false, value: "false", source: "override" },
  ai_detection: AI_OFF,
};

const PERSONAL_GET = {
  success: true,
  data: {
    license_type: "individual" as const,
    ai_detection_enabled: false,
    organization_id: undefined,
    sessionBacked: true,
  },
};

const validateWith = (transactionCount: number) => ({
  success: true,
  data: {
    isValid: true,
    licenseType: "individual" as const,
    transactionCount,
    transactionLimit: 10,
    canCreateTransaction: true,
    deviceCount: 1,
    deviceLimit: 3,
    aiEnabled: false,
  },
});

const USER = { id: "00000000-0000-0000-0000-000000000000", email: "user@example.com" };

function setup(features: FeatureMap, transactionCount: number): void {
  mockLicenseService.get.mockResolvedValue(PERSONAL_GET);
  mockLicenseService.validate.mockResolvedValue(validateWith(transactionCount));
  mockLicenseService.create.mockResolvedValue({ success: false, data: null });
  (window as unknown as { api: unknown }).api = {
    featureGate: {
      getAll: jest.fn().mockResolvedValue(features),
      invalidateCache: jest.fn().mockResolvedValue(undefined),
    },
  };
}

/**
 * Renders hasAIAddon beside each screen. Every fixture here (except the empty map) has
 * ai_detection OFF, and an unloaded map is fail-open (hasAIAddon true), so "false" is
 * readable only once the feature map has actually loaded. Without this gate, a map that
 * never loads leaves the limit at fail-open Infinity and passes every "unlimited" test.
 */
function MapLoaded(): React.ReactElement {
  const { hasAIAddon } = useLicense();
  return <span data-testid="map-loaded">{String(hasAIAddon)}</span>;
}

/**
 * Lets the mocked feature map and validation land, then flushes the renders they cause.
 * `gated` waits for the map to be visibly loaded; C3 (empty map) passes false, because an
 * empty map has no ai_detection entry and so never reads "false".
 */
async function settle(gated = true): Promise<void> {
  await waitFor(() => expect((window.api.featureGate.getAll as jest.Mock)).toHaveBeenCalled());
  if (gated) {
    await waitFor(() => expect(screen.getByTestId("map-loaded").textContent).toBe("false"));
  }
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
}

function Probe(): React.ReactElement {
  const { transactionLimit, canCreateTransaction, transactionCount } = useLicense();
  return (
    <span data-testid="probe">
      {String(transactionLimit)}|{String(canCreateTransaction)}|{String(transactionCount)}
    </span>
  );
}

async function probeText(features: FeatureMap, count: number, gated = true): Promise<string> {
  setup(features, count);
  render(
    <LicenseProvider userId={USER.id}>
      <Probe />
      <MapLoaded />
    </LicenseProvider>,
  );
  await settle(gated);
  // Settled first, then read once: before the feature map lands the limit is Infinity
  // (fail-open), which would satisfy an "unlimited" expectation on its own.
  return screen.getByTestId("probe").textContent as string;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("BACKLOG-4149 C1 — a plan with unlimited_transactions has no cap", () => {
  it("C1a Keepr Internal (cap 10, unlimited from the plan) at 150: Infinity, can create", async () => {
    expect(await probeText(KEEPR_INTERNAL, 150)).toBe("Infinity|true|150");
  });

  it("C1b Team (cap 100, unlimited from the plan) at 150: Infinity, can create", async () => {
    expect(await probeText(TEAM, 150)).toBe("Infinity|true|150");
  });

  // The only guard for a rule that reads `value` instead of `allowed`.
  it("C1c Agent override (allowed:true, value \"false\") at 150: Infinity, can create", async () => {
    expect(await probeText(AGENT_OVERRIDE, 150)).toBe("Infinity|true|150");
  });
});

describe("BACKLOG-4149 C2 — without unlimited the cap still applies", () => {
  it("C2a Individual at 10 of 10: limit 10, cannot create", async () => {
    expect(await probeText(INDIVIDUAL, 10)).toBe("10|false|10");
  });

  it("C2b Individual at 9 of 10: limit 10, can create", async () => {
    expect(await probeText(INDIVIDUAL, 9)).toBe("10|true|9");
  });

  // The only guard for a rule that uses the fail-open featureIsAllowed() (R2).
  it("C2c cap present but no unlimited_transactions key, at 10: limit 10, cannot create", async () => {
    expect(await probeText(CAP_WITHOUT_UNLIMITED_KEY, 10)).toBe("10|false|10");
  });

  // S1: the shape the admin-label ruling rests on (suspension writes unlimited off).
  it("C2d suspended brokerage (Team cap 100, unlimited off) at 100: limit 100, cannot create", async () => {
    expect(await probeText(SUSPENDED_TEAM, 100)).toBe("100|false|100");
  });
});

describe("BACKLOG-4149 C3 — loading or a failed read stays fail-open", () => {
  // Ungated on purpose: an empty map has no ai_detection entry, so the map-loaded signal
  // would never read "false". This case IS the fail-open state, so there is nothing to wait for.
  it("empty map, count 150: Infinity, can create", async () => {
    expect(await probeText({}, 150, false)).toBe("Infinity|true|150");
  });
});

describe("BACKLOG-4149 C4 — the Account row", () => {
  async function accountRow(features: FeatureMap): Promise<string> {
    setup(features, 0);
    render(
      <LicenseProvider userId={USER.id}>
        <AccountSettings user={USER} />
        <MapLoaded />
      </LicenseProvider>,
    );
    const label = await screen.findByText("Transactions");
    await settle();
    return (label.parentElement?.textContent ?? "").replace(/\s+/g, " ");
  }

  it("Keepr Internal reads 0 / Unlimited", async () => {
    expect(await accountRow(KEEPR_INTERNAL)).toBe("Transactions0 / Unlimited");
  });

  it("Individual reads 0 / 10", async () => {
    expect(await accountRow(INDIVIDUAL)).toBe("Transactions0 / 10");
  });
});

describe("BACKLOG-4149 C5 — New Transaction on the Dashboard", () => {
  async function clickNew(features: FeatureMap, count: number): Promise<jest.Mock> {
    setup(features, count);
    const onAuditNew = jest.fn();
    render(
      <LicenseProvider userId={USER.id}>
        <Dashboard onAuditNew={onAuditNew} onViewTransactions={jest.fn()} onManageContacts={jest.fn()} />
        <MapLoaded />
      </LicenseProvider>,
    );
    await settle();
    fireEvent.click(screen.getByTestId("nav-new-audit"));
    return onAuditNew;
  }

  it("Keepr Internal at 10: opens the new transaction, no limit dialog", async () => {
    const onAuditNew = await clickNew(KEEPR_INTERNAL, 10);
    expect(onAuditNew).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("limit-modal")).toBeNull();
  });

  it("Individual at 10: shows the limit dialog, does not open the new transaction", async () => {
    const onAuditNew = await clickNew(INDIVIDUAL, 10);
    expect(onAuditNew).not.toHaveBeenCalled();
    expect(screen.getByTestId("limit-modal")).toBeInTheDocument();
  });
});
