/**
 * Sentry reporting for support upload failures (BACKLOG-2431)
 *
 * Before this, `grep Sentry electron/services/supportAccess/*.ts` returned
 * nothing. A user could grant support access for seven days, have every upload
 * fail, and support would never know — the exact silence BACKLOG-2430 was filed
 * to end, one layer further out. The founder only saw
 *
 *   Storage upload failed: mime type application/gzip is not supported
 *
 * because of the failure banner built for BACKLOG-2430. Nothing reached us.
 *
 * The scheduled path is the one that matters: `SupportUploadScheduler.flush()`
 * catches this throw, calls `queue.markFailed`, and logs locally, so it never
 * reaches the `wrapHandler` IPC net that captures everything else.
 *
 * The second half of these tests is about what must NOT be sent. Support
 * diagnostics leak absolute paths and account names (BACKLOG-2415), and the
 * report body is sealed client data — real client names and phone numbers, with
 * PII scrubbing still pending under BACKLOG-2397. None of that may be repeated
 * into Sentry. Scrubbing has to happen at this call site, because the
 * `beforeSend` hook in main.ts only scrubs events tagged
 * `component: "auto-updater"`.
 */

// --- Mocks -----------------------------------------------------------------
// Hoisted handles + arrow-wrapped factory, matching
// electron/handlers/__tests__/supportTicketHandlers.test.ts.
const mockCaptureException = jest.fn();
const mockCaptureMessage = jest.fn();
jest.mock("@sentry/electron/main", () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
  captureMessage: (...args: unknown[]) => mockCaptureMessage(...args),
}));

import * as os from "os";
import * as path from "path";
import { promises as fs } from "fs";
import { SupabaseSupportTransport } from "../supabaseSupportTransport";
import type { SupportReportUpload } from "../types";

// --- Fixtures ---------------------------------------------------------------

const TICKET_ID = "11111111-2222-3333-4444-555555555555";
const CONSENT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

/** A report body standing in for sealed client diagnostics. Must never leave. */
const SECRET_BODY = Buffer.from(
  "SEALED-CLIENT-DIAGNOSTICS Jane Homebuyer +14155550123",
);

function makeUpload(): SupportReportUpload {
  return {
    meta: {
      id: "report-1",
      capturedAt: "2026-08-03T08:35:17.000Z",
      reason: "manual",
      byteSize: SECRET_BODY.length,
      rawByteSize: 4096,
      scopes: [],
      covers: "four areas",
      state: "queued",
      truncated: false,
      truncatedBytes: 0,
      consentId: CONSENT_ID,
    },
    body: SECRET_BODY,
    fileName: "keepr-support-report-2026-08-03T08-35-17-000Z.json.gz",
    contentType: "application/gzip",
    retentionDays: 30,
  } as unknown as SupportReportUpload;
}

/**
 * A Supabase client stub. `uploadError` drives the storage-upload failure;
 * `rpcErrors` drives the RPC responses in call order.
 */
function makeClient(opts: {
  uploadError?: { message: string };
  createTicketError?: { message: string };
  registerError?: { message: string };
  removeError?: { message: string };
}) {
  const upload = jest.fn().mockResolvedValue({
    error: opts.uploadError ?? null,
  });
  const remove = jest.fn().mockResolvedValue({
    error: opts.removeError ?? null,
  });
  const rpc = jest.fn((name: string) => {
    if (name === "support_create_ticket") {
      return Promise.resolve(
        opts.createTicketError
          ? { data: null, error: opts.createTicketError }
          : { data: { id: TICKET_ID }, error: null },
      );
    }
    return Promise.resolve(
      opts.registerError
        ? { data: null, error: opts.registerError }
        : {
            data: {
              id: "att-1",
              storage_path: "p",
              expires_at: "2026-09-02T00:00:00.000Z",
            },
            error: null,
          },
    );
  });
  return {
    storage: { from: () => ({ upload, remove }) },
    rpc,
    _upload: upload,
    _remove: remove,
  };
}

let baseDir: string;

async function makeTransport(client: ReturnType<typeof makeClient>) {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "support-sentry-"));
  return new SupabaseSupportTransport({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getClient: () => client as any,
    getRequester: async () => ({
      email: "jane.homebuyer@example.com",
      name: "Jane Homebuyer",
    }),
    baseDir,
    log: () => undefined,
  });
}

afterEach(async () => {
  jest.clearAllMocks();
  if (baseDir) await fs.rm(baseDir, { recursive: true, force: true });
});

/** All string content across every Sentry call, for leak assertions. */
function allCapturedText(): string {
  return JSON.stringify([
    ...mockCaptureException.mock.calls,
    ...mockCaptureMessage.mock.calls,
  ]);
}

// --- Tests ------------------------------------------------------------------

describe("BACKLOG-2431 — storage upload failure reaches Sentry", () => {
  it("captures the founder's exact failure instead of swallowing it", async () => {
    const client = makeClient({
      uploadError: { message: "mime type application/gzip is not supported" },
    });
    const transport = await makeTransport(client);

    await expect(transport.upload(makeUpload())).rejects.toThrow(
      /mime type application\/gzip is not supported/,
    );

    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    const [error, options] = mockCaptureException.mock.calls[0];

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(
      "mime type application/gzip is not supported",
    );
    expect(options.tags).toMatchObject({
      component: "support-access",
      operation: "upload",
      transport: "supabase",
    });
    // The failure reason — what distinguishes a MIME rejection from a quota
    // failure — has to be searchable.
    expect(options.extra.reason).toBe(
      "mime type application/gzip is not supported",
    );
    expect(options.extra.contentType).toBe("application/gzip");
    expect(options.extra.bodyBytes).toBe(SECRET_BODY.length);
  });

  it("captures a ticket-creation failure", async () => {
    const client = makeClient({
      createTicketError: { message: "permission denied for support_tickets" },
    });
    const transport = await makeTransport(client);

    await expect(transport.upload(makeUpload())).rejects.toThrow(
      /Could not open a support ticket/,
    );

    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    expect(mockCaptureException.mock.calls[0][1].tags.operation).toBe(
      "ensure-ticket",
    );
  });

  it("flags an orphaned object left on the server", async () => {
    // Object landed, row did not, and the cleanup also failed — a copy of
    // client diagnostics stranded where the user can neither see nor delete it.
    const client = makeClient({
      registerError: { message: "new row violates row-level security policy" },
      removeError: { message: "object not found" },
    });
    const transport = await makeTransport(client);

    await expect(transport.upload(makeUpload())).rejects.toThrow(
      /Attachment registration failed/,
    );

    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    const [, options] = mockCaptureException.mock.calls[0];
    expect(options.tags.operation).toBe("register-attachment");
    expect(options.extra.orphanedObject).toBe(true);
  });

  it("stays silent on a successful upload", async () => {
    const client = makeClient({});
    const transport = await makeTransport(client);

    await expect(transport.upload(makeUpload())).resolves.toMatchObject({
      remote: { ticketId: TICKET_ID },
    });

    expect(mockCaptureException).not.toHaveBeenCalled();
    expect(mockCaptureMessage).not.toHaveBeenCalled();
  });
});

describe("BACKLOG-2431 — what must not reach Sentry", () => {
  it("never sends the report body", async () => {
    const client = makeClient({
      uploadError: { message: "mime type application/gzip is not supported" },
    });
    const transport = await makeTransport(client);
    await expect(transport.upload(makeUpload())).rejects.toThrow();

    const text = allCapturedText();
    expect(text).not.toContain("SEALED-CLIENT-DIAGNOSTICS");
    expect(text).not.toContain("Jane Homebuyer");
    expect(text).not.toContain("+14155550123");
  });

  it("never sends the requester's email or name in the fields it adds", async () => {
    // ensureTicket is the one failure path with the requester in scope.
    const client = makeClient({
      createTicketError: { message: "permission denied" },
    });
    const transport = await makeTransport(client);
    await expect(transport.upload(makeUpload())).rejects.toThrow();

    const text = allCapturedText();
    expect(text).not.toContain("jane.homebuyer@example.com");
    expect(text).not.toContain("Jane Homebuyer");
  });

  /**
   * The test above passes trivially — its fixture error carries no value.
   *
   * `reason` is SERVER-AUTHORED text, and Postgres renders the offending value
   * inline on a constraint violation. Keeping the requester out of the fields
   * WE add is not enough if the server hands us their address inside the
   * message: it would land in `extra.reason` and in the Sentry issue title.
   *
   * Not reachable today — `support_tickets` has no unique constraint on
   * `requester_email`, and the RPC's own RAISEs do not interpolate it — but the
   * transport must not depend on that staying true.
   */
  it("redacts an email the SERVER put inside the error text", async () => {
    const client = makeClient({
      createTicketError: {
        message:
          'duplicate key value violates unique constraint "support_tickets_requester_email_key"\n' +
          "DETAIL:  Key (requester_email)=(jane.homebuyer@example.com) already exists.",
      },
    });
    const transport = await makeTransport(client);
    await expect(transport.upload(makeUpload())).rejects.toThrow();

    const reason = mockCaptureException.mock.calls[0][1].extra.reason;
    const title = (mockCaptureException.mock.calls[0][0] as Error).message;

    // Neither the extra nor the issue title may carry the address.
    expect(reason).not.toContain("jane.homebuyer@example.com");
    expect(title).not.toContain("jane.homebuyer@example.com");
    expect(allCapturedText()).not.toContain("jane.homebuyer@example.com");

    // Redacted, not discarded — the domain still says which tenant, and the
    // constraint name is what makes the failure actionable.
    expect(reason).toContain("j***@example.com");
    expect(reason).toContain("support_tickets_requester_email_key");
  });

  it("redacts an email carried in a storage-upload error", async () => {
    // Same exposure on the hot path, not only at ticket creation.
    const client = makeClient({
      uploadError: {
        message:
          "row-level security policy violated for owner jane.homebuyer@example.com",
      },
    });
    const transport = await makeTransport(client);
    await expect(transport.upload(makeUpload())).rejects.toThrow();

    expect(allCapturedText()).not.toContain("jane.homebuyer@example.com");
    expect(mockCaptureException.mock.calls[0][1].extra.reason).toContain(
      "j***@example.com",
    );
  });

  it("redacts absolute local filesystem paths out of the reason", async () => {
    // Storage/IO errors routinely echo a path, and the username in it is PII.
    const client = makeClient({
      uploadError: {
        message:
          "EACCES: permission denied, open '/Users/danielhaim/Library/Application Support/Keepr/support-access/tickets.json'",
      },
    });
    const transport = await makeTransport(client);
    await expect(transport.upload(makeUpload())).rejects.toThrow();

    const text = allCapturedText();
    expect(text).not.toContain("danielhaim");
    expect(text).not.toContain("/Users/");
    expect(mockCaptureException.mock.calls[0][1].extra.reason).toContain(
      "<path>",
    );
  });

  it("sends only a redacted prefix of the ticket id", async () => {
    const client = makeClient({
      registerError: { message: "row-level security" },
    });
    const transport = await makeTransport(client);
    await expect(transport.upload(makeUpload())).rejects.toThrow();

    const extra = mockCaptureException.mock.calls[0][1].extra;
    expect(extra.ticketId).toBe("11111111...");
    expect(allCapturedText()).not.toContain(TICKET_ID);
  });
});
