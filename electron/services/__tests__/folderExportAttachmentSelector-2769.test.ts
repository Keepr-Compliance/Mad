/**
 * @jest-environment node
 */

/**
 * BACKLOG-2769: Audit Package with Attachments = None must not write email
 * attachment files to disk, and must not download them from Gmail/Outlook.
 *
 * The defect: `folderExportService.exportTransactionToFolder` called
 * `exportEmailAttachmentsToThreadDirs` under `includeEmails && emails.length > 0`
 * with NO reference to the attachment selector. So an explicit "None" (and
 * equally "Text only") still produced `emails/<thread>/attachments/<file>` on
 * disk AND pulled the declined attachments from the provider.
 *
 * Why no existing test saw it: `folderExportService.test.ts` exercises
 * `includeAttachments: false`, but its database mock returns no attachment
 * rows — a fixture describing a state in which the bug cannot manifest.
 *
 * The two effects have DIFFERENT database preconditions and are therefore
 * driven by two separate, self-consistent fixtures — a single fixture asserting
 * both would describe a row the real database cannot hold:
 *
 *   - DISK fixture:    attachment rows EXIST for the email (COUNT >= 1), so the
 *                      copy path runs and the provider download path correctly
 *                      does nothing.
 *   - NETWORK fixture: `has_attachments = true` but NO attachment rows (COUNT
 *                      = 0), so the provider download path runs and there is
 *                      nothing local to copy.
 *
 * Every database read below is derived from ONE in-memory `attachmentsTable`,
 * so the mocked reads cannot disagree with each other.
 */

import path from "path";

// --- Mocks -----------------------------------------------------------------

// Electron. `net.isOnline` matters: downloadMissingAttachmentsForExport()
// bails out early when the device is offline, which would make the
// "zero provider calls" assertion pass vacuously.
jest.mock("electron", () => ({
  BrowserWindow: jest.fn().mockImplementation(() => {
    const handlers: Record<string, (...args: unknown[]) => void> = {};
    return {
      loadFile: () => {
        if (handlers["did-finish-load"]) {
          setImmediate(() => handlers["did-finish-load"]());
        }
        return Promise.resolve(undefined);
      },
      webContents: {
        printToPDF: jest.fn().mockResolvedValue(Buffer.from("mock-pdf-data")),
        on: (event: string, cb: (...args: unknown[]) => void) => {
          handlers[event] = cb;
        },
      },
      close: jest.fn(),
      isDestroyed: jest.fn().mockReturnValue(false),
    };
  }),
  app: {
    getPath: jest.fn((pathType: string) => {
      if (pathType === "downloads") return "/mock/downloads";
      if (pathType === "temp") return "/mock/temp";
      return "/mock/path";
    }),
  },
  net: { isOnline: jest.fn().mockReturnValue(true) },
}));

// fs (sync) — resolveFilenameConflict() uses existsSync.
jest.mock("fs", () => ({ existsSync: jest.fn().mockReturnValue(false) }));

// fs/promises — record every directory created and every file copied.
const createdDirs: string[] = [];
const copiedFiles: Array<{ src: string; dest: string }> = [];
let accessiblePaths = new Set<string>();

const mockMkdir = jest.fn(async (dirPath: string) => {
  createdDirs.push(dirPath);
  return undefined;
});
const mockCopyFile = jest.fn(async (src: string, dest: string) => {
  copiedFiles.push({ src, dest });
  return undefined;
});
const mockAccess = jest.fn(async (filePath: string) => {
  if (!accessiblePaths.has(filePath)) {
    throw new Error("ENOENT: no such file or directory");
  }
  return undefined;
});

jest.mock("fs/promises", () => ({
  mkdir: (...args: unknown[]) => mockMkdir(...(args as [string])),
  copyFile: (...args: unknown[]) => mockCopyFile(...(args as [string, string])),
  access: (...args: unknown[]) => mockAccess(...(args as [string])),
  writeFile: jest.fn().mockResolvedValue(undefined),
  unlink: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), log: jest.fn() },
}));

// googleapis is pulled in transitively via emailAttachmentService → gmailFetchService.
jest.mock("googleapis", () => ({ google: { gmail: jest.fn() }, gmail_v1: {}, Auth: {} }));

// --- Single source of truth for the mocked database ------------------------

interface AttachmentRow {
  id: string;
  message_id: string | null;
  email_id: string | null;
  filename: string;
  mime_type: string | null;
  storage_path: string | null;
  file_size_bytes: number | null;
}

interface EmailRow {
  id: string;
  external_id: string;
  source: string;
  user_id: string;
}

let attachmentsTable: AttachmentRow[] = [];
let emailsTable: EmailRow[] = [];

const mockGetAttachmentsForEmailExport = jest.fn((emailId: string) =>
  attachmentsTable
    .filter((r) => r.email_id === emailId)
    .map(({ id, filename, mime_type, storage_path, file_size_bytes }) => ({
      id,
      filename,
      mime_type,
      storage_path,
      file_size_bytes,
    })),
);

const mockGetAttachmentsForExportBulk = jest.fn(
  (messageIds: string[], _externalIds: string[], emailIds: string[]) =>
    attachmentsTable.filter(
      (r) =>
        (r.email_id !== null && emailIds.includes(r.email_id)) ||
        (r.message_id !== null && messageIds.includes(r.message_id)),
    ),
);

// The raw-database mock routes by SQL text. Several different prepared
// statements reach it; a single blanket `get()` would feed `{ cnt: 0 }` to the
// email-record lookup, silently emptying the provider download list and making
// "zero provider calls" pass for the wrong reason.
interface PreparedStatement {
  get: (...args: unknown[]) => unknown;
  all: (...args: unknown[]) => unknown[];
  run: (...args: unknown[]) => void;
}

const mockPrepare = jest.fn((sql: string): PreparedStatement => {
  if (sql.includes("COUNT(*) as cnt") && sql.includes("FROM attachments")) {
    return {
      get: (...args: unknown[]) => ({
        cnt: attachmentsTable.filter((r) => r.email_id === (args[0] as string)).length,
      }),
      all: () => [],
      run: () => undefined,
    };
  }
  if (sql.includes("FROM emails WHERE id")) {
    return {
      get: (...args: unknown[]) => emailsTable.find((e) => e.id === (args[0] as string)),
      all: () => [],
      run: () => undefined,
    };
  }
  return { get: () => undefined, all: () => [], run: () => undefined };
});

jest.mock("../databaseService", () => ({
  __esModule: true,
  default: {
    getRawDatabase: () => ({ prepare: (sql: string) => mockPrepare(sql) }),
    getAttachmentsForEmailExport: (...args: unknown[]) =>
      mockGetAttachmentsForEmailExport(...(args as [string])),
    getAttachmentsForExportBulk: (...args: unknown[]) =>
      mockGetAttachmentsForExportBulk(...(args as [string[], string[], string[]])),
    getAttachmentsForMessageWithFallback: () => [],
  },
}));

// Collaborators unrelated to the selector, isolated so the raw-database mock
// above has exactly one consumer (the provider download path).
jest.mock("../db/userDbService", () => ({
  __esModule: true,
  getUserById: jest.fn().mockResolvedValue(null),
}));

jest.mock("../contactResolutionService", () => ({
  __esModule: true,
  resolveHandles: jest.fn().mockResolvedValue(new Map()),
  resolveGroupChatParticipants: jest.fn().mockResolvedValue(""),
  extractParticipantHandles: jest.fn().mockReturnValue([]),
}));

// --- Provider boundary: the observable for "did we hit Gmail/Outlook?" ------

const mockGmailInitialize = jest.fn().mockResolvedValue(true);
const mockGmailGetEmailById = jest.fn().mockResolvedValue({
  attachments: [
    { filename: "declined_by_user.pdf", mimeType: "application/pdf", size: 1024, attachmentId: "gatt-1" },
  ],
});
const mockOutlookInitialize = jest.fn().mockResolvedValue(true);
const mockOutlookGetAttachments = jest.fn().mockResolvedValue([]);
const mockDownloadEmailAttachments = jest.fn().mockResolvedValue(undefined);

jest.mock("../gmailFetchService", () => ({
  __esModule: true,
  default: {
    initialize: (...args: unknown[]) => mockGmailInitialize(...(args as [string])),
    getEmailById: (...args: unknown[]) => mockGmailGetEmailById(...(args as [string])),
  },
}));

jest.mock("../outlookFetchService", () => ({
  __esModule: true,
  default: {
    initialize: (...args: unknown[]) => mockOutlookInitialize(...(args as [string])),
    getAttachments: (...args: unknown[]) => mockOutlookGetAttachments(...(args as [string])),
  },
}));

jest.mock("../emailAttachmentService", () => ({
  __esModule: true,
  default: {
    downloadEmailAttachments: (...args: unknown[]) => mockDownloadEmailAttachments(...args),
  },
}));

import type { Communication } from "../../types/models";
import type { TransactionWithDetails } from "../transactionService/types";
// BACKLOG-2771: plans are built by the REAL resolver, never by hand.
import { testExportPlan } from "./helpers/exportPlanFixture";

// --- Fixtures ---------------------------------------------------------------

const OUTPUT_PATH = "/mock/output";
const EMAILS_PATH = path.join(OUTPUT_PATH, "emails");

/** Windows CI produces backslashes; compare on a single separator. */
const norm = (p: string): string => p.replace(/\\/g, "/");

/** Destination paths of files copied under `emails/` (per-thread attachments). */
const emailAttachmentCopies = (): string[] =>
  copiedFiles.map((c) => norm(c.dest)).filter((d) => d.startsWith(norm(EMAILS_PATH) + "/"));

/** Directories created under `emails/` whose leaf is `attachments`. */
const emailAttachmentDirs = (): string[] =>
  createdDirs
    .map(norm)
    .filter((d) => d.startsWith(norm(EMAILS_PATH) + "/") && d.endsWith("/attachments"));

/** Every call that would reach Gmail or Outlook over the network. */
const providerCallCount = (): number =>
  mockGmailInitialize.mock.calls.length +
  mockGmailGetEmailById.mock.calls.length +
  mockOutlookInitialize.mock.calls.length +
  mockOutlookGetAttachments.mock.calls.length +
  mockDownloadEmailAttachments.mock.calls.length;

const mockTransaction = {
  id: "txn-2769",
  user_id: "user-123",
  property_address: "27 Selector Way",
  transaction_type: "purchase",
  created_at: "2024-01-01T00:00:00Z",
  communications: [],
  contact_assignments: [],
} as unknown as TransactionWithDetails;

const createEmail = (id: string, threadId: string, subject: string, sentAt: string): Communication =>
  ({
    id,
    user_id: "user-123",
    thread_id: threadId,
    subject,
    body: "<div>body</div>",
    sender: "alice@test.com",
    recipients: "bob@test.com",
    direction: "inbound",
    sent_at: sentAt,
    communication_type: "email",
    channel: "email",
    has_attachments: true,
    is_false_positive: false,
    created_at: "2024-01-01T00:00:00Z",
  }) as unknown as Communication;

const emails = (): Communication[] => [
  createEmail("e1", "thread-A", "Closing", "2024-01-15T10:00:00Z"),
  createEmail("e2", "thread-B", "Inspection", "2024-01-16T10:00:00Z"),
];

/**
 * Thread directory names produced by folderExportService for the fixture above
 * (`thread_<idx>_<first date>_<sanitized subject>`).
 */
const THREAD_A_DIR = "thread_001_2024-01-15_Closing";
const THREAD_B_DIR = "thread_002_2024-01-16_Inspection";

const expectedCopy = (threadDir: string, filename: string): string =>
  norm(path.join(EMAILS_PATH, threadDir, "attachments", filename));

/** DISK fixture: attachment rows exist locally, so the copy path runs. */
const seedLocalAttachments = (): void => {
  attachmentsTable = [
    {
      id: "att-1",
      message_id: null,
      email_id: "e1",
      filename: "purchase_agreement.pdf",
      mime_type: "application/pdf",
      storage_path: "/mock/cache/purchase_agreement.pdf",
      file_size_bytes: 2048,
    },
    {
      id: "att-2",
      message_id: null,
      email_id: "e2",
      filename: "inspection_photos.zip",
      mime_type: "application/zip",
      storage_path: "/mock/cache/inspection_photos.zip",
      file_size_bytes: 4096,
    },
  ];
  emailsTable = [];
  accessiblePaths = new Set(
    attachmentsTable.map((r) => r.storage_path).filter((p): p is string => p !== null),
  );
};

/** NETWORK fixture: flagged as having attachments, none stored locally yet. */
const seedMissingAttachments = (): void => {
  attachmentsTable = [];
  emailsTable = [
    { id: "e1", external_id: "gmail-ext-1", source: "gmail", user_id: "user-123" },
    { id: "e2", external_id: "gmail-ext-2", source: "gmail", user_id: "user-123" },
  ];
  accessiblePaths = new Set();
};

interface ExportOptions {
  attachmentType: "all" | "email" | "text" | "none";
}

/**
 * BACKLOG-2771: the attachment selection now reaches the exporter as a resolved
 * plan rather than as a pair of loose flags, and the plan is produced by the
 * real resolver. `includeAttachments` is gone from the wire — it was a second
 * encoding of `attachmentType !== "none"`.
 */
const runExport = async (opts: ExportOptions): Promise<void> => {
  const module = await import("../folderExportService");
  await module.default.exportTransactionToFolder(
    mockTransaction,
    testExportPlan(emails(), {
      contentType: "emails",
      attachmentType: opts.attachmentType,
      emailMode: "thread",
    }),
    { transactionId: mockTransaction.id, outputPath: OUTPUT_PATH },
  );
};

// --- Tests ------------------------------------------------------------------

describe("BACKLOG-2769: email attachment export honors the attachment selector", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    createdDirs.length = 0;
    copiedFiles.length = 0;
    attachmentsTable = [];
    emailsTable = [];
    accessiblePaths = new Set();
    mockGmailInitialize.mockResolvedValue(true);
    mockGmailGetEmailById.mockResolvedValue({
      attachments: [
        { filename: "declined_by_user.pdf", mimeType: "application/pdf", size: 1024, attachmentId: "gatt-1" },
      ],
    });
    mockOutlookInitialize.mockResolvedValue(true);
    mockOutlookGetAttachments.mockResolvedValue([]);
  });

  describe("disk: attachments stored locally", () => {
    beforeEach(seedLocalAttachments);

    it('"none" writes NO email attachment files and creates NO attachment directories', async () => {
      await runExport({ attachmentType: "none" });

      expect(emailAttachmentCopies()).toEqual([]);
      expect(emailAttachmentDirs()).toEqual([]);
    });

    it('"text" (text attachments only) writes NO email attachment files', async () => {
      await runExport({ attachmentType: "text" });

      expect(emailAttachmentCopies()).toEqual([]);
      expect(emailAttachmentDirs()).toEqual([]);
    });

    it('"all" still exports both email attachments', async () => {
      await runExport({ attachmentType: "all" });

      expect(emailAttachmentCopies().sort()).toEqual(
        [
          expectedCopy(THREAD_A_DIR, "purchase_agreement.pdf"),
          expectedCopy(THREAD_B_DIR, "inspection_photos.zip"),
        ].sort(),
      );
    });

    it('"email" (email attachments only) still exports both email attachments', async () => {
      await runExport({ attachmentType: "email" });

      expect(emailAttachmentCopies().sort()).toEqual(
        [
          expectedCopy(THREAD_A_DIR, "purchase_agreement.pdf"),
          expectedCopy(THREAD_B_DIR, "inspection_photos.zip"),
        ].sort(),
      );
    });
  });

  describe("network: attachments flagged but not stored locally", () => {
    beforeEach(seedMissingAttachments);

    it('"none" makes NO Gmail/Outlook requests', async () => {
      await runExport({ attachmentType: "none" });

      expect(mockGmailInitialize).not.toHaveBeenCalled();
      expect(mockGmailGetEmailById.mock.calls.map((c) => c[0])).toEqual([]);
      expect(providerCallCount()).toBe(0);
    });

    it('"text" (text attachments only) makes NO Gmail/Outlook requests', async () => {
      await runExport({ attachmentType: "text" });

      expect(mockGmailInitialize).not.toHaveBeenCalled();
      expect(mockGmailGetEmailById.mock.calls.map((c) => c[0])).toEqual([]);
      expect(providerCallCount()).toBe(0);
    });

    it('"all" still fetches the missing attachments (fixture is live)', async () => {
      await runExport({ attachmentType: "all" });

      expect(mockGmailInitialize).toHaveBeenCalledWith("user-123");
      expect(mockGmailGetEmailById.mock.calls.map((c) => c[0])).toEqual([
        "gmail-ext-1",
        "gmail-ext-2",
      ]);
    });
  });
});
