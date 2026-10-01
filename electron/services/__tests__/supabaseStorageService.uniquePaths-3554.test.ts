/**
 * @jest-environment node
 *
 * BACKLOG-3554 — two attachments with the same file name in one submission.
 *
 * ## The defect
 *
 * The object path was `{org}/{submission}/{sanitized file name}`. Two
 * attachments named `image001.png` (the same scanner default in two emails)
 * resolved to ONE path. The second upload was answered "already exists", that
 * answer was reported as SUCCESS with the same path, and the second
 * `submission_attachments` row pointed at the first file's bytes.
 *
 * ## What these controls prove
 *
 *  1. same-name attachments get distinct paths, both are uploaded, and each
 *     submission_attachments row points at its OWN path;
 *  2. a retry of the same attachment, after an attempt that sent the upload and
 *     lost the answer, is idempotent: same path, success;
 *  3. "already exists" on the first attempt is a FAILURE, with one upload call
 *     and no retries, and it is counted in `attachmentsFailed`.
 *
 * ## Fixtures
 *
 * - The "already exists" error is the storage-js `StorageApiError` shape:
 *   `handleError` in `@supabase/storage-js/dist/index.cjs` builds it from the
 *   response body as `(message, status, statusCode)`. Body values are the two
 *   shapes Supabase documents — `statusCode "409"` / "The resource already
 *   exists" (guides/storage/debugging/error-codes) and HTTP 400 "Asset Already
 *   Exists" (guides/storage/uploads/standard-uploads). No production 409 was
 *   available to capture (storage logs searched 2026-09-30: none).
 * - Local attachment rows carry the `attachments` columns of
 *   `electron/database/schema.sql` that the submit path reads. Ids are
 *   `randomUUID()`-shaped, as `attachmentDbService.ts` writes them. All values
 *   are invented.
 */

import fs from "fs";
import os from "os";
import path from "path";

import {
  createPostgrestEmulator,
  brokerageMembership,
  FIXTURE_USER_ID,
  FIXTURE_BROKERAGE_ORG_ID,
  type Emulator,
} from "./helpers/postgrestEmulator";

// ---------------------------------------------------------------------------
// Fake storage: an object store keyed by path, with the bucket's upsert:false
// behaviour. `script` lets a test force the answer for a given call.
// ---------------------------------------------------------------------------

type UploadAnswer =
  | { kind: "store" }
  | { kind: "lose-answer" } // stores the bytes, then the client sees a transport error
  | { kind: "error"; error: unknown };

const objects = new Map<string, Buffer>();
const uploadCalls: string[] = [];
let script: UploadAnswer[] = [];

/** storage-js StorageApiError, as `handleError` constructs it. */
function storageApiError(message: string, status: number, statusCode: string) {
  const e = new Error(message) as Error & { status: number; statusCode: string; __isStorageError: boolean };
  e.name = "StorageApiError";
  e.status = status;
  e.statusCode = statusCode;
  e.__isStorageError = true;
  return e;
}
const DUPLICATE_409 = () => storageApiError("The resource already exists", 400, "409");
const ASSET_ALREADY_EXISTS_400 = () => storageApiError("Asset Already Exists", 400, "400");

const fakeStorage = {
  from: (_bucket: string) => ({
    upload: async (storagePath: string, body: Buffer) => {
      uploadCalls.push(storagePath);
      const answer = script.shift() ?? { kind: "store" };
      if (answer.kind === "error") return { data: null, error: answer.error };
      if (objects.has(storagePath)) return { data: null, error: DUPLICATE_409() };
      objects.set(storagePath, Buffer.from(body));
      if (answer.kind === "lose-answer") {
        return { data: null, error: { name: "StorageUnknownError", message: "fetch failed" } };
      }
      return { data: { path: storagePath, id: "obj", fullPath: `submission-attachments/${storagePath}` }, error: null };
    },
  }),
};

let emulator: Emulator;
const mockGetAuthSession = jest.fn();

jest.mock("../supabaseService", () => ({
  __esModule: true,
  default: {
    getClient: () => ({
      storage: fakeStorage,
      from: (table: string) => emulator.from(table),
      rpc: (fn: string, args?: unknown) => {
        const list = (args as { p_checklists?: unknown } | undefined)?.p_checklists;
        if (fn === "snapshot_submission_checklists" && Array.isArray(list) && list.length === 0) {
          return Promise.resolve({
            data: {
              checklists: 0, items: 0, links: 0, members: 0, dropped_members: 0, dropped_links: 0,
              carry: { status: "no_parent" },
            },
            error: null,
          });
        }
        return emulator.rpc(fn, args);
      },
    }),
    getAuthSession: (...args: unknown[]) => mockGetAuthSession(...args),
  },
}));

jest.mock("../db/checklistDbService", () => ({
  getChecklistsForTransaction: async () => ({ checklists: [], requiredDone: 0, requiredTotal: 0 }),
}));
jest.mock("../db/submissionDbService", () => ({
  ...jest.requireActual("../db/submissionDbService"),
  getOwedReviewChecklistPullsFor: () => [],
}));
jest.mock("../databaseService");
jest.mock("../logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock("@sentry/electron/main", () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));
jest.mock("../contactsService");
jest.mock("../emailAttachmentService");
jest.mock("../gmailFetchService");
jest.mock("../outlookFetchService");
jest.mock("../contactResolutionService", () => ({
  resolveHandles: jest.fn().mockResolvedValue({ names: {}, matches: {} }),
  extractParticipantHandles: jest.fn().mockReturnValue([]),
  nameForHandle: jest.fn(),
}));
jest.mock("electron", () => ({
  app: { getVersion: jest.fn().mockReturnValue("2.38.0"), getPath: jest.fn(() => "/nonexistent") },
  net: { isOnline: jest.fn().mockReturnValue(true) },
}));

import supabaseStorageService, { buildAttachmentStoragePath } from "../supabaseStorageService";
import { submissionService } from "../submissionService";
import databaseService from "../databaseService";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const ORG = FIXTURE_BROKERAGE_ORG_ID;
const SUBMISSION = "5a3e0c1d-4b2f-4c8e-9d7a-000000003554"; // pii-allow-uuid: invented fixture id
const TX = "txn-3554";
const ATT_A = "a1b2c3d4-0000-4000-8000-00000000355a"; // pii-allow-uuid: invented fixture id
const ATT_B = "a1b2c3d4-0000-4000-8000-00000000355b"; // pii-allow-uuid: invented fixture id

let tmpRoot: string;
let fileA: string;
let fileB: string;

beforeEach(() => {
  jest.clearAllMocks();
  objects.clear();
  uploadCalls.length = 0;
  script = [];
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-3554-"));
  // Same NAME, different BYTES and sizes — the production shape (3 of 5
  // collided groups had differing file_size_bytes).
  fileA = path.join(tmpRoot, "content-a");
  fileB = path.join(tmpRoot, "content-b");
  fs.writeFileSync(fileA, Buffer.from("first file bytes"));
  fs.writeFileSync(fileB, Buffer.from("second, longer, different file bytes"));
  jest.spyOn(global, "setTimeout").mockImplementation(((fn: () => void) => {
    fn();
    return 0 as unknown as NodeJS.Timeout;
  }) as unknown as typeof setTimeout);
});

afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const sameNamePair = () => [
  { id: ATT_A, localPath: fileA, filename: "image001.png" },
  { id: ATT_B, localPath: fileB, filename: "image001.png" },
];

describe("BACKLOG-3554 — storage path shape", () => {
  it("puts the local attachment id in segment 3 and keeps the file name last", () => {
    expect(buildAttachmentStoragePath(ORG, SUBMISSION, ATT_A, "image001.png")).toBe(
      `${ORG}/${SUBMISSION}/${ATT_A}/image001.png`
    );
  });

  it("cannot let an id add or remove a path segment", () => {
    const p = buildAttachmentStoragePath(ORG, SUBMISSION, "../x/y", "a.pdf");
    expect(p.split("/")).toHaveLength(4);
    expect(p.split("/")[0]).toBe(ORG);
    expect(p.split("/")[1]).toBe(SUBMISSION);
  });
});

describe("BACKLOG-3554 — uploadAttachments", () => {
  it("two same-name attachments → two distinct paths, both uploaded with their own bytes", async () => {
    const result = await supabaseStorageService.uploadAttachments(ORG, SUBMISSION, sameNamePair());

    expect(result.successCount).toBe(2);
    expect(result.failedCount).toBe(0);
    const [a, b] = result.results;
    expect(a.storagePath).toBe(`${ORG}/${SUBMISSION}/${ATT_A}/image001.png`);
    expect(b.storagePath).toBe(`${ORG}/${SUBMISSION}/${ATT_B}/image001.png`);
    expect(a.storagePath).not.toBe(b.storagePath);
    expect(uploadCalls).toEqual([a.storagePath, b.storagePath]);
    expect(objects.get(a.storagePath)?.toString()).toBe("first file bytes");
    expect(objects.get(b.storagePath)?.toString()).toBe("second, longer, different file bytes");
  });

  it("a retry after a lost answer is idempotent: same path, success, bytes stored once", async () => {
    script = [{ kind: "lose-answer" }];

    const result = await supabaseStorageService.uploadAttachments(ORG, SUBMISSION, [sameNamePair()[0]]);

    expect(result.successCount).toBe(1);
    expect(result.results[0]).toMatchObject({
      success: true,
      storagePath: `${ORG}/${SUBMISSION}/${ATT_A}/image001.png`,
    });
    // Attempt 1 stored the bytes and lost the answer; attempt 2 met its own object.
    expect(uploadCalls).toEqual([
      `${ORG}/${SUBMISSION}/${ATT_A}/image001.png`,
      `${ORG}/${SUBMISSION}/${ATT_A}/image001.png`,
    ]);
    expect(objects.size).toBe(1);
  });

  it.each([
    ["409 'The resource already exists'", DUPLICATE_409],
    ["400 'Asset Already Exists'", ASSET_ALREADY_EXISTS_400],
  ])("an unexpected %s on the first attempt is a failure, with no retry", async (_label, make) => {
    script = [{ kind: "error", error: make() }];

    const result = await supabaseStorageService.uploadAttachments(ORG, SUBMISSION, [sameNamePair()[1]]);

    expect(result.successCount).toBe(0);
    expect(result.failedCount).toBe(1);
    expect(result.results[0]).toMatchObject({ success: false, storagePath: "" });
    expect(uploadCalls).toHaveLength(1);
  });

  it("an object already at the path is never claimed when nothing in this loop sent it", async () => {
    // A different file is already where this attachment would go.
    const target = buildAttachmentStoragePath(ORG, SUBMISSION, ATT_B, "image001.png");
    objects.set(target, Buffer.from("first file bytes"));

    const result = await supabaseStorageService.uploadAttachments(ORG, SUBMISSION, [sameNamePair()[1]]);

    expect(result.results[0]).toMatchObject({ success: false, storagePath: "" });
    expect(objects.get(target)?.toString()).toBe("first file bytes");
    expect(uploadCalls).toHaveLength(1);
  });
});

describe("BACKLOG-3554 — submit: each submission_attachments row points at its own file", () => {
  beforeEach(() => {
    emulator = createPostgrestEmulator({
      rows: { organization_members: [brokerageMembership()] },
    });
    mockGetAuthSession.mockResolvedValue({ userId: FIXTURE_USER_ID });
    (databaseService.getTransactionById as jest.Mock).mockResolvedValue({
      id: TX,
      user_id: FIXTURE_USER_ID,
      property_address: "1 Fixture Way",
      started_at: null,
      closed_at: null,
    });
    (databaseService.getTransactionMessages as jest.Mock).mockReturnValue([]);
    (databaseService.getTransactionEmails as jest.Mock).mockReturnValue([]);
    (databaseService.getTransactionAttachments as jest.Mock).mockReturnValue([
      {
        id: ATT_A, email_id: "email-1", message_id: null, filename: "image001.png",
        mime_type: "image/png", file_size_bytes: 16, storage_path: fileA,
        document_type: null, created_at: "2026-09-01T10:00:00.000Z",
      },
      {
        id: ATT_B, email_id: "email-2", message_id: null, filename: "image001.png",
        mime_type: "image/png", file_size_bytes: 36, storage_path: fileB,
        document_type: null, created_at: "2026-09-02T10:00:00.000Z",
      },
    ]);
  });

  const attachmentRows = () =>
    emulator.state.writes
      .filter((w) => w.table === "submission_attachments" && w.op === "insert")
      .flatMap((w) => w.values as Record<string, unknown>[]);

  it("two same-name attachments → two rows, each on its own path and bytes", async () => {
    const result = await submissionService.submitTransaction(TX);

    expect(result).toMatchObject({ success: true, attachmentsCount: 2, attachmentsFailed: 0 });
    const rows = attachmentRows();
    expect(rows).toHaveLength(2);
    const byLocal = new Map(rows.map((r) => [r.local_attachment_id, r]));
    const pathA = byLocal.get(ATT_A)!.storage_path as string;
    const pathB = byLocal.get(ATT_B)!.storage_path as string;
    expect(pathA).not.toBe(pathB);
    expect(pathA.split("/")[2]).toBe(ATT_A);
    expect(pathB.split("/")[2]).toBe(ATT_B);
    expect(byLocal.get(ATT_A)!.filename).toBe("image001.png");
    expect(byLocal.get(ATT_B)!.filename).toBe("image001.png");
    expect(objects.get(pathA)?.toString()).toBe("first file bytes");
    expect(objects.get(pathB)?.toString()).toBe("second, longer, different file bytes");
  });

  it("an unexpected 'already exists' writes no row for that file and is counted as failed", async () => {
    script = [{ kind: "store" }, { kind: "error", error: DUPLICATE_409() }];

    const result = await submissionService.submitTransaction(TX);

    expect(result).toMatchObject({ attachmentsCount: 1, attachmentsFailed: 1 });
    const rows = attachmentRows();
    expect(rows.map((r) => r.local_attachment_id)).toEqual([ATT_A]);
  });
});
