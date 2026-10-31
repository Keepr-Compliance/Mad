/**
 * BACKLOG-4065: registry of open transaction ids read by the support ticket.
 */
import {
  registerOpenTransaction,
  getOpenTransactionId,
  resetOpenTransactionRegistryForTests,
} from "../openTransactionRegistry";

// pii-allow-uuid: invented, not from any live row
const A = "00000000-0000-4000-8000-00000000000a";
// pii-allow-uuid: invented, not from any live row
const B = "00000000-0000-4000-8000-00000000000b";

describe("openTransactionRegistry (BACKLOG-4065)", () => {
  beforeEach(() => resetOpenTransactionRegistryForTests());

  it("C3: register then unregister", () => {
    expect(getOpenTransactionId()).toBeNull();
    const off = registerOpenTransaction(A);
    expect(getOpenTransactionId()).toBe(A);
    off();
    expect(getOpenTransactionId()).toBeNull();
  });

  it("C3b: most recent wins; closing one keeps the other", () => {
    const offA = registerOpenTransaction(A);
    const offB = registerOpenTransaction(B);
    expect(getOpenTransactionId()).toBe(B);
    offB();
    expect(getOpenTransactionId()).toBe(A);
    offA();
    const offB2 = registerOpenTransaction(B);
    offA(); // stale handle called again
    offA();
    expect(getOpenTransactionId()).toBe(B);
    offB2();
    expect(getOpenTransactionId()).toBeNull();
  });

  it("C3c: the same id registered twice survives one unregister", () => {
    const off1 = registerOpenTransaction(A);
    const off2 = registerOpenTransaction(A);
    off1();
    expect(getOpenTransactionId()).toBe(A);
    off2();
    expect(getOpenTransactionId()).toBeNull();
  });
});
