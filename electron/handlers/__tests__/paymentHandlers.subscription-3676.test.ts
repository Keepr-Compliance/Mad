/**
 * @jest-environment node
 *
 * BACKLOG-3676 (S4) — IPC input checks on the new payment channels.
 *   payment:begin-subscription   takes no argument (anything sent is ignored).
 *   payment:confirm-subscription a transaction id: non-empty string, ≤128 chars.
 *   payment:refresh-gate         same check.
 * A malformed payload never reaches paymentService and answers fail-closed.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

const registeredHandlers = new Map<string, any>();
jest.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, fn: any) => {
      registeredHandlers.set(channel, fn);
    },
  },
}));

const mockBegin = jest.fn();
const mockConfirm = jest.fn();
const mockRefresh = jest.fn();
jest.mock("../../services/paymentService", () => ({
  __esModule: true,
  default: {
    beginSubscription: (...a: unknown[]) => mockBegin(...a),
    confirmSubscription: (...a: unknown[]) => mockConfirm(...a),
    refreshGate: (...a: unknown[]) => mockRefresh(...a),
  },
}));
jest.mock("../../services/logService", () => {
  const m = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { __esModule: true, default: m, logService: m };
});

import { registerPaymentHandlers, isValidTransactionIdArg } from "../paymentHandlers";

registerPaymentHandlers();

function invoke(channel: string, ...args: unknown[]): Promise<any> {
  const handler = registeredHandlers.get(channel);
  if (!handler) throw new Error(`no handler for ${channel}`);
  return handler({} as any, ...args);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockBegin.mockResolvedValue({ started: true });
  mockConfirm.mockResolvedValue({ unlocked: true });
  mockRefresh.mockResolvedValue({ unlocked: true });
});

const BAD: unknown[] = [undefined, null, "", 42, { id: "tx" }, ["tx"], "x".repeat(129)];

describe("payment:confirm-subscription", () => {
  it("passes a valid id through, with no options", async () => {
    expect(await invoke("payment:confirm-subscription", "tx-1")).toEqual({ unlocked: true });
    expect(mockConfirm.mock.calls).toEqual([["tx-1"]]);
  });

  it("accepts the 128-character boundary", async () => {
    await invoke("payment:confirm-subscription", "x".repeat(128));
    expect(mockConfirm).toHaveBeenCalledTimes(1);
  });

  it.each(BAD)("refuses %p without calling the service", async (bad) => {
    expect(await invoke("payment:confirm-subscription", bad)).toEqual({ unlocked: false, reason: "error" });
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it("a renderer-supplied options object never reaches the service", async () => {
    await invoke("payment:confirm-subscription", "tx-1", { sleep: () => Promise.resolve() });
    expect(mockConfirm.mock.calls).toEqual([["tx-1"]]);
  });
});

describe("payment:refresh-gate", () => {
  it("passes a valid id through", async () => {
    expect(await invoke("payment:refresh-gate", "tx-1")).toEqual({ unlocked: true });
    expect(mockRefresh.mock.calls).toEqual([["tx-1"]]);
  });

  it.each(BAD)("refuses %p without calling the service", async (bad) => {
    expect(await invoke("payment:refresh-gate", bad)).toEqual({ unlocked: false });
    expect(mockRefresh).not.toHaveBeenCalled();
  });
});

describe("payment:begin-subscription", () => {
  it("ignores anything the renderer sends", async () => {
    expect(await invoke("payment:begin-subscription", "https://evil.example/", { price: 1 })).toEqual({
      started: true,
    });
    expect(mockBegin.mock.calls).toEqual([[]]);
  });
});

describe("isValidTransactionIdArg", () => {
  it("boundaries", () => {
    expect(isValidTransactionIdArg("a")).toBe(true);
    expect(isValidTransactionIdArg("a".repeat(128))).toBe(true);
    expect(isValidTransactionIdArg("a".repeat(129))).toBe(false);
    expect(isValidTransactionIdArg("")).toBe(false);
  });
});
