/**
 * BACKLOG-4065: the submitted ticket carries the open transaction id, read
 * at submit time (not when the hook mounted).
 */
import { renderHook, act, waitFor } from "@testing-library/react";
import { useSupportTicket } from "../useSupportTicket";
import {
  registerOpenTransaction,
  resetOpenTransactionRegistryForTests,
} from "../../utils/openTransactionRegistry";

// pii-allow-uuid: invented, not from any live row
const TXN_ID = "00000000-0000-4000-8000-000000000001";
const form = {
  subject: "Something is broken",
  description: "Details here",
  priority: "normal" as const,
  category_id: "",
};

const mockSubmitTicket = jest.fn();

beforeEach(() => {
  resetOpenTransactionRegistryForTests();
  mockSubmitTicket.mockReset().mockResolvedValue({ success: true, ticket_number: 1 });
  // WindowApi is a structured interface; the double cast only widens it for this write.
  (window.api as unknown as Record<string, unknown>).support = {
    collectDiagnostics: jest.fn().mockResolvedValue({ success: true, diagnostics: null }),
    captureScreenshot: jest.fn().mockResolvedValue({ success: true, screenshot: null }),
    getCategories: jest.fn().mockResolvedValue({ success: true, categories: [] }),
    submitTicket: mockSubmitTicket,
  };
});

async function mountAndSettle() {
  const hook = renderHook(() => useSupportTicket());
  await waitFor(() => expect(hook.result.current.categoriesLoading).toBe(false));
  return hook;
}

describe("useSupportTicket open transaction id (BACKLOG-4065)", () => {
  it("C4: an id registered after the hook mounted is sent at submit", async () => {
    const { result } = await mountAndSettle();
    const off = registerOpenTransaction(TXN_ID);
    await act(async () => {
      await result.current.submitTicket(form, "user@example.com", "Test User");
    });
    off();
    expect(mockSubmitTicket).toHaveBeenCalledTimes(1);
    expect(mockSubmitTicket.mock.calls[0][0].open_transaction_id).toBe(TXN_ID);
  });

  it("C4b: nothing open -> null", async () => {
    const { result } = await mountAndSettle();
    await act(async () => {
      await result.current.submitTicket(form, "user@example.com", "Test User");
    });
    expect(mockSubmitTicket).toHaveBeenCalledTimes(1);
    expect(mockSubmitTicket.mock.calls[0][0].open_transaction_id).toBeNull();
  });
});
