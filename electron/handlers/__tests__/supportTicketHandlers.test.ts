/**
 * @jest-environment node
 *
 * Support Ticket Handlers Tests
 * BACKLOG-1916: In-app support tickets silently dropped diagnostics.json
 * because the support-attachments bucket rejected 'application/json'.
 *
 * These tests pin the durability + observability behaviour of the
 * `support:submit-ticket` handler's diagnostics upload path:
 *  1. Happy path uploads diagnostics.json as application/json.
 *  2. If application/json is rejected, it retries as text/plain (fallback)
 *     and still surfaces the primary failure to Sentry (no longer silent).
 *  3. If BOTH attempts fail, it reports to Sentry (no longer silent) and the
 *     ticket creation still succeeds (a diagnostics drop must not fail a ticket).
 */

const registeredHandlers: Record<string, Function> = {};
const mockIpcHandle = jest.fn((channel: string, handler: Function) => {
  registeredHandlers[channel] = handler;
});

jest.mock("electron", () => ({
  ipcMain: {
    handle: (...args: unknown[]) =>
      mockIpcHandle(...(args as [string, Function])),
  },
}));

// Sentry: assert we surface previously-silent failures.
const mockCaptureMessage = jest.fn();
const mockCaptureException = jest.fn();
jest.mock("@sentry/electron/main", () => ({
  captureMessage: (...args: unknown[]) => mockCaptureMessage(...args),
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

jest.mock("../../services/logService", () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// supportTicketService: only imported for its type + collect/capture helpers,
// which the submit handler does not call. Stub to avoid pulling in electron/db.
jest.mock("../../services/supportTicketService", () => ({
  collectDiagnostics: jest.fn(),
  captureScreenshot: jest.fn(),
}));

// Supabase client mock — storage.from().upload() + rpc() are the surfaces used.
const mockUpload = jest.fn();
const mockRpc = jest.fn();
const mockStorageFrom = jest.fn(() => ({ upload: mockUpload }));
const mockClient = {
  rpc: (...args: unknown[]) => mockRpc(...args),
  storage: { from: (...args: unknown[]) => mockStorageFrom(...args) },
};
jest.mock("../../services/supabaseService", () => ({
  __esModule: true,
  default: { getClient: jest.fn(() => mockClient) },
}));

import { registerSupportTicketHandlers } from "../supportTicketHandlers";

const CHANNEL = "support:submit-ticket";

const ticketParams = {
  subject: "Something is broken",
  description: "Details here",
  priority: "high",
  category_id: null,
  requester_email: "user@example.com",
  requester_name: "Test User",
};

const diagnostics = {
  app_version: "2.9.5",
  os_platform: "darwin",
  collected_at: "2026-07-10T00:00:00.000Z",
};

/** Configure the ticket-create RPC + support_add_attachment RPC to succeed. */
function stubRpcSuccess(): void {
  mockRpc.mockImplementation((fnName: string) => {
    if (fnName === "support_create_ticket") {
      return Promise.resolve({
        data: { id: "ticket-uuid-1", ticket_number: 42 },
        error: null,
      });
    }
    // support_add_attachment
    return Promise.resolve({ data: null, error: null });
  });
}

describe("supportTicketHandlers — support:submit-ticket diagnostics upload", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Object.keys(registeredHandlers).forEach(
      (key) => delete registeredHandlers[key]
    );
    stubRpcSuccess();
    registerSupportTicketHandlers();
  });

  it("uploads diagnostics.json as application/json on the happy path", async () => {
    mockUpload.mockResolvedValue({ error: null });

    const handler = registeredHandlers[CHANNEL];
    const result = await handler({}, ticketParams, null, diagnostics);

    expect(result).toEqual({
      success: true,
      ticket_id: "ticket-uuid-1",
      ticket_number: 42,
    });

    // diagnostics.json uploaded exactly once, as application/json
    const diagnosticsUploads = mockUpload.mock.calls.filter(
      ([path]) => typeof path === "string" && path.endsWith("diagnostics.json")
    );
    expect(diagnosticsUploads).toHaveLength(1);
    expect(diagnosticsUploads[0][2]).toEqual(
      expect.objectContaining({ contentType: "application/json" })
    );

    // No fallback, no Sentry noise on the happy path.
    expect(mockCaptureMessage).not.toHaveBeenCalled();
  });

  it("retries diagnostics as text/plain when application/json is rejected, and surfaces the primary failure", async () => {
    // First diagnostics upload (application/json) fails, fallback succeeds.
    mockUpload.mockImplementation(
      (_path: string, _buf: Buffer, opts: { contentType: string }) => {
        if (opts.contentType === "application/json") {
          return Promise.resolve({
            error: { message: "mime type application/json is not supported" },
          });
        }
        return Promise.resolve({ error: null });
      }
    );

    const handler = registeredHandlers[CHANNEL];
    const result = await handler({}, ticketParams, null, diagnostics);

    // Ticket still succeeds.
    expect(result.success).toBe(true);

    // Both attempts made for diagnostics.json: application/json then text/plain.
    const diagnosticsUploads = mockUpload.mock.calls.filter(
      ([path]) => typeof path === "string" && path.endsWith("diagnostics.json")
    );
    const contentTypes = diagnosticsUploads.map(([, , opts]) => opts.contentType);
    expect(contentTypes).toContain("application/json");
    expect(contentTypes).toContain("text/plain");

    // The primary (application/json) failure is surfaced to Sentry — no longer silent.
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      expect.stringContaining("text/plain fallback succeeded"),
      expect.objectContaining({
        level: "warning",
        tags: expect.objectContaining({
          component: "support",
          attachment: "diagnostics",
        }),
      })
    );
  });

  it("reports to Sentry (not silently) and still returns success when both diagnostics uploads fail", async () => {
    // Every diagnostics upload attempt fails; ticket-create + attachment RPC ok.
    mockUpload.mockResolvedValue({
      error: { message: "storage unavailable" },
    });

    const handler = registeredHandlers[CHANNEL];
    const result = await handler({}, ticketParams, null, diagnostics);

    // Ticket creation success is NOT affected by a diagnostics drop.
    expect(result.success).toBe(true);
    expect(result.ticket_id).toBe("ticket-uuid-1");

    // Both attempts were made.
    const diagnosticsUploads = mockUpload.mock.calls.filter(
      ([path]) => typeof path === "string" && path.endsWith("diagnostics.json")
    );
    expect(diagnosticsUploads.length).toBeGreaterThanOrEqual(2);

    // The drop is observable via Sentry (the whole point of BACKLOG-1916).
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      "[Support] Diagnostics upload failed (ticket still created)",
      expect.objectContaining({
        level: "warning",
        tags: expect.objectContaining({
          component: "support",
          attachment: "diagnostics",
        }),
      })
    );
  });
});
