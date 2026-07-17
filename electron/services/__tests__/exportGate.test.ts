/**
 * @jest-environment node
 */

/**
 * Unit tests for the authoritative export gate (BACKLOG-2006a; BACKLOG-2075
 * Option A — gate export only, reading is free).
 *
 * The export IS the product, so these prove the non-bypassable gate:
 *   - a LOCKED transaction throws PaywallLockedError BEFORE any content is
 *     handed to an export service (the bypass guard), and
 *   - an UNLOCKED transaction exports the full record (communications unchanged;
 *     there is no sample reduction under Option A).
 */

import { jest } from "@jest/globals";

jest.mock("@sentry/electron/main", () => ({ captureException: jest.fn() }));
jest.mock("../logService", () => {
  const fns = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { __esModule: true, default: fns, logService: fns };
});

const mockGetExportDecision = jest.fn();
jest.mock("../entitlementService", () => ({
  __esModule: true,
  default: { getExportDecision: mockGetExportDecision },
}));

const mockTrackEvent = jest.fn();
jest.mock("../supabaseService", () => ({
  __esModule: true,
  default: { trackEvent: mockTrackEvent },
}));

import {
  enforceExportGate,
  emitExportCompleted,
  PaywallLockedError,
} from "../exportGate";
import { PAYWALL_LOCKED_ERROR } from "../../types/entitlement";

const USER = "user-1";
const TX = "tx-1";

const COMMS = [
  { id: "e1", channel: "email", thread_id: "ET1", sent_at: "2026-01-01T10:00:00Z" },
  { id: "e2", channel: "email", thread_id: "ET1", sent_at: "2026-01-01T11:00:00Z" },
  { id: "t1", channel: "imessage", thread_id: "TT1", sent_at: "2026-01-05T10:00:00Z" },
];

beforeEach(() => {
  jest.clearAllMocks();
});

describe("PaywallLockedError — message-prefix CONTRACT (renderer detection depends on it)", () => {
  it("carries the PAYWALL_LOCKED_ERROR code AND prefixes its message with it", () => {
    const err = new PaywallLockedError();
    // The renderer detects the paywall case via result.error?.startsWith(PAYWALL_LOCKED_ERROR).
    // A rename here that drops the prefix would silently break that detection.
    expect(err.code).toBe(PAYWALL_LOCKED_ERROR);
    expect(err.message.startsWith(PAYWALL_LOCKED_ERROR)).toBe(true);
    expect(PAYWALL_LOCKED_ERROR).toBe("PAYWALL_LOCKED");
  });
});

describe("enforceExportGate — bypass guard (Option A)", () => {
  it("BYPASS ATTEMPT: locked (mode none) ⇒ throws PaywallLockedError with code, NO comms leaked", async () => {
    mockGetExportDecision.mockResolvedValue({ allowed: false, mode: "none", reason: "no_unlock" });
    await expect(
      enforceExportGate({ transactionId: TX, userId: USER, communications: COMMS }),
    ).rejects.toBeInstanceOf(PaywallLockedError);

    // And the error message carries the machine-readable code for the renderer.
    await expect(
      enforceExportGate({ transactionId: TX, userId: USER, communications: COMMS }),
    ).rejects.toThrow(new RegExp(PAYWALL_LOCKED_ERROR));
  });

  it("unlocked ⇒ mode full, returns communications UNCHANGED (no sample reduction)", async () => {
    mockGetExportDecision.mockResolvedValue({ allowed: true, mode: "full" });
    const r = await enforceExportGate({ transactionId: TX, userId: USER, communications: COMMS });
    expect(r.decision.mode).toBe("full");
    expect(r.communications).toBe(COMMS); // same reference — full record
  });

  it("asks the entitlement service for the decision by transaction id only", async () => {
    mockGetExportDecision.mockResolvedValue({ allowed: true, mode: "full" });
    await enforceExportGate({ transactionId: TX, userId: USER, communications: COMMS });
    // Option A: no full-transaction-list fetch; the decision is transaction-scoped.
    expect(mockGetExportDecision).toHaveBeenCalledWith(TX);
  });
});

describe("emitExportCompleted", () => {
  it("emits export-completed with mode + format; never throws on analytics failure", async () => {
    mockTrackEvent.mockRejectedValue(new Error("net"));
    await expect(
      emitExportCompleted({ userId: USER, transactionId: TX, mode: "full", format: "pdf" }),
    ).resolves.toBeUndefined();
    expect(mockTrackEvent).toHaveBeenCalledWith(
      USER,
      "export-completed",
      expect.objectContaining({ transaction_id: TX, mode: "full", format: "pdf" }),
    );
  });
});
