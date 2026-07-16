/**
 * @jest-environment node
 */

/**
 * Unit tests for the authoritative export gate (BACKLOG-2006a).
 *
 * The export IS the product, so these prove the non-bypassable gate:
 *   - a LOCKED transaction throws PaywallLockedError BEFORE any content is
 *     handed to an export service (the bypass guard), and
 *   - a permitted SAMPLE export reduces to an EXACT id-SET of exactly one email
 *     thread + one text thread (never a count).
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

const mockGetTransactions = jest.fn();
jest.mock("../transactionService", () => ({
  __esModule: true,
  default: { getTransactions: mockGetTransactions },
}));

const mockTrackEvent = jest.fn();
jest.mock("../supabaseService", () => ({
  __esModule: true,
  default: { trackEvent: mockTrackEvent },
}));

import {
  enforceExportGate,
  emitExportCompleted,
  selectSampleCommunications,
  PaywallLockedError,
} from "../exportGate";
import { PAYWALL_LOCKED_ERROR } from "../../types/entitlement";

const USER = "user-1";
const TX = "tx-1";

// A realistic comms fixture: 2 email threads, 2 text threads.
const COMMS = [
  { id: "e1", channel: "email", thread_id: "ET1", sent_at: "2026-01-01T10:00:00Z" },
  { id: "e2", channel: "email", thread_id: "ET1", sent_at: "2026-01-01T11:00:00Z" },
  { id: "e3", channel: "email", thread_id: "ET2", sent_at: "2026-02-01T10:00:00Z" },
  { id: "t1", channel: "imessage", thread_id: "TT1", sent_at: "2026-01-05T10:00:00Z" },
  { id: "t2", channel: "sms", thread_id: "TT2", sent_at: "2026-03-01T10:00:00Z" },
  { id: "t3", channel: "imessage", thread_id: "TT1", sent_at: "2026-01-05T12:00:00Z" },
];

beforeEach(() => {
  jest.clearAllMocks();
  mockGetTransactions.mockResolvedValue([{ id: TX, closed_at: null, created_at: "2026-07-01T00:00:00Z" }]);
});

describe("selectSampleCommunications — exact id-SET (first thread per channel)", () => {
  it("reduces to exactly the FIRST email thread + FIRST text thread", () => {
    const sample = selectSampleCommunications(COMMS);
    const ids = new Set(sample.map((c) => c.id));
    // Earliest email is e1 (ET1) ⇒ ET1 = {e1, e2}. Earliest text is t1 (TT1) ⇒ TT1 = {t1, t3}.
    expect(ids).toEqual(new Set(["e1", "e2", "t1", "t3"]));
    // Explicitly NOT the later threads.
    expect(ids.has("e3")).toBe(false);
    expect(ids.has("t2")).toBe(false);
  });
});

describe("enforceExportGate — bypass guard", () => {
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

  it("unlocked ⇒ mode full, returns communications UNCHANGED", async () => {
    mockGetExportDecision.mockResolvedValue({ allowed: true, mode: "full" });
    const r = await enforceExportGate({ transactionId: TX, userId: USER, communications: COMMS });
    expect(r.decision.mode).toBe("full");
    expect(r.communications).toBe(COMMS); // same reference — no reduction
  });

  it("sample ⇒ returns EXACT id-set of 1 email thread + 1 text thread", async () => {
    mockGetExportDecision.mockResolvedValue({ allowed: true, mode: "sample" });
    const r = await enforceExportGate({
      transactionId: TX, userId: USER, communications: COMMS, requestSample: true,
    });
    expect(r.decision.mode).toBe("sample");
    expect(new Set(r.communications.map((c) => c.id))).toEqual(new Set(["e1", "e2", "t1", "t3"]));
  });

  it("passes the user's real transaction list to the decision (first-tx determinism)", async () => {
    mockGetExportDecision.mockResolvedValue({ allowed: true, mode: "full" });
    await enforceExportGate({ transactionId: TX, userId: USER, communications: COMMS });
    expect(mockGetTransactions).toHaveBeenCalledWith(USER);
    expect(mockGetExportDecision).toHaveBeenCalledWith(TX, expect.any(Array), false);
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
