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
// BACKLOG-1917: the submit handler DOES call appendDiagnosticsToDescription, so
// provide a faithful (non-electron) implementation that mirrors the real one —
// it appends a "--- Keepr Diagnostics ---" block, separated by a blank line,
// and returns the description unchanged when diagnostics are null.
jest.mock("../../services/supportTicketService", () => ({
  collectDiagnostics: jest.fn(),
  captureScreenshot: jest.fn(),
  appendDiagnosticsToDescription: (
    description: string,
    diag: unknown | null
  ) =>
    diag
      ? `${description}\n\n--- Keepr Diagnostics ---\nApp: ${(diag as { app_version?: string }).app_version ?? "unknown"}`
      : description,
}));

// Supabase client mock — storage.from().upload() + rpc() are the surfaces used.
const mockUpload = jest.fn();
const mockRpc = jest.fn();
const mockStorageFrom = jest.fn((..._args: unknown[]) => ({ upload: mockUpload }));
// BACKLOG-2431: `support:get-categories` uses client.from(...).select()...
const mockFrom = jest.fn();
const mockClient = {
  rpc: (...args: unknown[]) => mockRpc(...args),
  from: (...args: unknown[]) => mockFrom(...args),
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

  // BACKLOG-1917: diagnostics summary is appended to the description INLINE, so
  // it is visible in every ticket view without downloading the attachment.
  it("appends the diagnostics summary block to the description passed to support_create_ticket", async () => {
    mockUpload.mockResolvedValue({ error: null });

    const handler = registeredHandlers[CHANNEL];
    await handler({}, ticketParams, null, diagnostics);

    const createCall = mockRpc.mock.calls.find(
      ([fnName]) => fnName === "support_create_ticket"
    );
    expect(createCall).toBeDefined();
    const passedDescription = (createCall as [string, { p_description: string }])[1]
      .p_description;

    // Original user message preserved and comes first.
    expect(passedDescription.startsWith(ticketParams.description)).toBe(true);
    // Inline diagnostics block appended, clearly delimited.
    expect(passedDescription).toContain("--- Keepr Diagnostics ---");
    expect(passedDescription).toContain(diagnostics.app_version);
  });

  it("passes the original description unchanged when no diagnostics are provided", async () => {
    mockUpload.mockResolvedValue({ error: null });

    const handler = registeredHandlers[CHANNEL];
    await handler({}, ticketParams, null, null);

    const createCall = mockRpc.mock.calls.find(
      ([fnName]) => fnName === "support_create_ticket"
    );
    const passedDescription = (createCall as [string, { p_description: string }])[1]
      .p_description;

    expect(passedDescription).toBe(ticketParams.description);
    expect(passedDescription).not.toContain("--- Keepr Diagnostics ---");
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

  /**
   * BACKLOG-2431: one upload failure emits Sentry events from TWO places —
   * `reportAttachmentStepFailure` (which scrubs) and the BACKLOG-1916 callers
   * above, which put the caught `err.message` into `extra` untouched.
   *
   * Scrubbing only inside `reportAttachmentStepFailure` therefore left the same
   * value going out verbatim on the sibling event. `uploadAttachment` now
   * scrubs at the THROW, covering every caller including ones added later.
   *
   * Asserted across ALL captured events rather than one field, so a fourth
   * emission site added later is covered without editing this test.
   */
  it("never lets a server-embedded email reach Sentry from any emission site", async () => {
    mockUpload.mockResolvedValue({
      error: {
        message:
          'duplicate key value violates unique constraint "x" DETAIL:  Key (requester_email)=(jane.homebuyer@example.com) already exists.',
      },
    });

    const handler = registeredHandlers[CHANNEL];
    const result = await handler({}, ticketParams, null, diagnostics);
    expect(result.success).toBe(true);

    const everythingSent = JSON.stringify([
      ...mockCaptureMessage.mock.calls,
      ...mockCaptureException.mock.calls,
    ]);

    expect(everythingSent).not.toContain("jane.homebuyer@example.com");
    // Redacted, not dropped: the constraint text is what makes it actionable.
    expect(everythingSent).toContain("j***@example.com");
    expect(everythingSent).toContain("duplicate key value violates");

    // Prove the sibling path specifically — `extra.jsonError` is a field that
    // carried the wrapped raw text before this fix.
    const dropEvent = mockCaptureMessage.mock.calls.find(
      ([msg]) =>
        msg === "[Support] Diagnostics upload failed (ticket still created)"
    );
    expect(dropEvent).toBeDefined();
    const extra = (dropEvent?.[1] as { extra: Record<string, string> }).extra;
    expect(extra.jsonError).toContain("j***@example.com");
    expect(extra.jsonError).not.toContain("jane.homebuyer@example.com");
  });

  /**
   * BACKLOG-2431: a handler that throws RAW lands in `wrapHandler`, which calls
   * `Sentry.captureException(error)` with the object untouched. `beforeSend` in
   * main.ts does not help — `scrubUpdaterEventPII` returns the event unchanged
   * unless it is tagged `component: "auto-updater"`.
   *
   * `message` was never the only exposed field. Postgres renders the entire
   * offending row into `details` on a CHECK violation, and `support_tickets`
   * carries a `requester_email` column plus several CHECKs — so this is a live
   * vector, not a theoretical one. `details` and `hint` are scrubbed alongside
   * `message`; `code` is kept because it is a fixed identifier that carries no
   * user data and is what makes the failure diagnosable.
   *
   * Asserted over the whole thrown object, not a named field, so a Postgres
   * error growing a new text field is covered without editing this test.
   */
  it("scrubs a CHECK violation before wrapHandler reports ticket creation to Sentry", async () => {
    mockRpc.mockImplementation((fnName: string) => {
      if (fnName === "support_create_ticket") {
        return Promise.resolve({
          data: null,
          error: {
            message:
              'new row violates check constraint "support_tickets_priority_check"',
            // The vector: Postgres renders the whole offending row here.
            details:
              "Failing row contains (1, jane.homebuyer@example.com, bogus).",
            hint: "Contact jane.homebuyer@example.com to correct the value.",
            code: "23514",
          },
        });
      }
      return Promise.resolve({ data: null, error: null });
    });

    const handler = registeredHandlers[CHANNEL];
    const result = await handler({}, ticketParams, null, diagnostics);
    expect(result.success).toBe(false);

    // wrapHandler catches the throw and calls captureException with the object
    // untouched — so this is the real egress, not a proxy for it.
    expect(mockCaptureException).toHaveBeenCalled();
    const captured = JSON.stringify(
      mockCaptureException.mock.calls.map(([e]) => ({
        name: (e as Error)?.name,
        message: (e as Error)?.message,
        ...(e as object),
      }))
    );

    expect(captured).not.toContain("jane.homebuyer@example.com");
    // message, details AND hint scrubbed — not just message.
    expect(captured).toContain("j***@example.com");
    expect(captured).toContain("Failing row contains");
    // `code` survives: a fixed identifier, and what makes this diagnosable.
    expect(captured).toContain("23514");

    // The message returned to the renderer is scrubbed too.
    expect(result.error).not.toContain("jane.homebuyer@example.com");
  });

  it("scrubs the categories query error before wrapHandler reports it", async () => {
    const handler = registeredHandlers["support:get-categories"];
    expect(handler).toBeDefined();

    mockFrom.mockReturnValueOnce({
      select: () => ({
        eq: () => ({
          order: () =>
            Promise.resolve({
              data: null,
              error: {
                message: "permission denied for relation support_categories",
                details:
                  "Failing row contains (7, jane.homebuyer@example.com).",
                hint: null,
                code: "42501",
              },
            }),
        }),
      }),
    });

    const result = await handler({});
    expect(result.success).toBe(false);

    expect(mockCaptureException).toHaveBeenCalled();
    const captured = JSON.stringify(
      mockCaptureException.mock.calls.map(([e]) => ({
        name: (e as Error)?.name,
        message: (e as Error)?.message,
        ...(e as object),
      }))
    );

    expect(captured).not.toContain("jane.homebuyer@example.com");
    expect(captured).toContain("j***@example.com");
    expect(result.error).not.toContain("jane.homebuyer@example.com");
  });
});
