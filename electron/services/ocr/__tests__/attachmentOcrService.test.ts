/**
 * @jest-environment node
 *
 * BACKLOG-3943 — the OCR pass end to end against the real driver and the shipped schema,
 * with the page child replaced by an in-process fake (fakeOcrChild.ts). Nothing here
 * spawns a process.
 *
 * Controls (SR plan review): R1 compare-and-set, R3 attempts, R5 crash handling, R7 quit,
 * C4 timeout, C6 page cap sweep, C7 text cap, C11 no path in argv.
 *
 * Runs under Electron's node (the driver is built for Electron):
 *   ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js <this file> --bail=0
 */
import fs from "fs";
import os from "os";
import path from "path";
import type { Database as DatabaseType } from "better-sqlite3";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const RealDatabase = require(
  path.join(__dirname, "..", "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

jest.mock("../../logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// databaseService is a large facade; forward only the two OCR methods to the real db layer.
jest.mock("../../databaseService", () => {
  const real = jest.requireActual("../../db/attachmentDbService");
  return {
    __esModule: true,
    default: {
      getAttachmentOcrRow: (id: string) => real.getAttachmentOcrRow(id),
      compareAndSetAttachmentOcrResult: (...a: [string, string, string, string | null]) =>
        real.compareAndSetAttachmentOcrResult(...a),
    },
  };
});

import { setDb, setDbPath, setEncryptionKey } from "../../db/core/dbConnection";
import { prepareOcrPendingPage, type TextExtractionQueryable } from "../../db/attachmentTextExtractionSql";
import { ocrAttachmentText, type OcrRunOptions } from "../attachmentOcrService";
import { __setOcrSpawnerForTests, stopLiveOcrChild } from "../ocrChild";
import { OCR_MAX_ATTEMPTS, OCR_MIME_TYPES, OCR_PAGE_CAP } from "../ocrConfig";
import { makeFakeSpawner, type FakeBehaviour } from "./fakeOcrChild";

const SCHEMA = path.join(__dirname, "..", "..", "..", "database", "schema.sql");

let db: DatabaseType;
let tmpDir: string;
let filePath: string;
const FILE_BYTES = Buffer.from("%PDF-1.7 synthetic test bytes, not a real document");

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-3943-"));
  filePath = path.join(tmpDir, "scan.pdf");
  fs.writeFileSync(filePath, FILE_BYTES);
});
afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

beforeEach(() => {
  db = new RealDatabase(":memory:") as unknown as DatabaseType;
  db.exec(fs.readFileSync(SCHEMA, "utf8"));
  setDb(db);
  setDbPath(":memory:");
  setEncryptionKey("test-key-not-a-real-key");
  db.prepare(
    `INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES ('u1', 'fixture@example.invalid', 'google', 'o1')`,
  ).run();
  db.prepare(`INSERT INTO messages (id, user_id, channel, body_text) VALUES ('m1', 'u1', 'imessage', 'b')`).run();
  insertRow("a");
});

afterEach(() => {
  __setOcrSpawnerForTests(null);
  setDb(null as unknown as DatabaseType);
  setDbPath(null as unknown as string);
  db.close();
});

function insertRow(id: string, opts: { text?: string | null; meta?: string | null; mime?: string; storage?: string | null } = {}): void {
  db.prepare(
    `INSERT INTO attachments (id, message_id, filename, mime_type, storage_path, text_content, analysis_metadata)
     VALUES (?, 'm1', 'scan.pdf', ?, ?, ?, ?)`,
  ).run(
    id,
    opts.mime ?? "application/pdf",
    opts.storage === undefined ? filePath : opts.storage,
    opts.text === undefined ? "" : opts.text,
    opts.meta ?? null,
  );
}

function row(id = "a"): { text_content: string | null; meta: Record<string, unknown> | null } {
  const r = db.prepare(`SELECT text_content, analysis_metadata FROM attachments WHERE id = ?`).get(id) as {
    text_content: string | null;
    analysis_metadata: string | null;
  };
  return { text_content: r.text_content, meta: r.analysis_metadata ? JSON.parse(r.analysis_metadata) : null };
}

function pending(): string[] {
  return (
    prepareOcrPendingPage(db as unknown as TextExtractionQueryable, OCR_MIME_TYPES).all(
      ...OCR_MIME_TYPES,
      OCR_MAX_ATTEMPTS,
      100,
    ) as Array<{ id: string }>
  ).map((r) => r.id);
}

function useFake(plan: (page: number, attempt: number) => FakeBehaviour) {
  const fake = makeFakeSpawner(plan);
  __setOcrSpawnerForTests(fake.spawner);
  return fake;
}

/** Poll until `cond` holds (the pass does async file I/O before it spawns). */
async function waitFor(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  if (!cond()) throw new Error("waitFor: condition never held");
}

const run = (opts: OcrRunOptions = {}) => ocrAttachmentText("a", { platform: "darwin", ...opts });
const pageLines = (p: number) => [`Form 41`, `page ${p + 1} line`];

describe("happy path", () => {
  it("stores the pages' text with provenance, and the row leaves the pending set", async () => {
    const fake = useFake((p) => ({ kind: "page", pagesTotal: 3, lines: pageLines(p) }));
    expect(pending()).toEqual(["a"]);
    await expect(run()).resolves.toBe("text");
    const r = row();
    expect(r.text_content).toBe("Form 41\npage 1 line\nForm 41\npage 2 line\nForm 41\npage 3 line");
    expect(r.meta).toMatchObject({
      textSource: "ocr",
      result: "text",
      engine: "apple-vision",
      level: "accurate",
      pagesOcr: 3,
      pagesFailed: 0,
      pagesTotal: 3,
      truncated: false,
    });
    expect(fake.calls.map((c) => c.page)).toEqual([0, 1, 2]);
    expect(pending()).toEqual([]);
  });

  it("C11: the child gets the bytes on stdin and never the path; env is PATH only", async () => {
    const fake = useFake((p) => ({ kind: "page", pagesTotal: 1, lines: pageLines(p) }));
    await run();
    const call = fake.calls[0];
    expect(call.command).toBe("/usr/bin/osascript");
    expect(call.args.join("\u0000")).not.toContain(filePath);
    expect(call.args.join("\u0000")).not.toContain(tmpDir);
    expect(call.args.slice(-4)).toEqual(["200", "2600", "0", "1"]);
    expect(call.stdinBytes).toBe(FILE_BYTES.length);
    expect(call.options.env).toEqual({ PATH: "/usr/bin:/bin" });
  });

  it("a blank scan stores \"\" with result empty, and is not pending again (C3)", async () => {
    useFake(() => ({ kind: "page", pagesTotal: 2, lines: [] }));
    await expect(run()).resolves.toBe("empty");
    expect(row()).toMatchObject({ text_content: "", meta: { textSource: "ocr", result: "empty", pagesOcr: 2 } });
    expect(pending()).toEqual([]);
  });
});

describe("C6 — page cap sweep", () => {
  it.each(Array.from({ length: OCR_PAGE_CAP + 2 }, (_, i) => i + 1))(
    "a %i-page document spawns min(n, cap) page children and records pagesTotal",
    async (n) => {
      const fake = useFake((p) => ({ kind: "page", pagesTotal: n, lines: pageLines(p) }));
      await run();
      expect(fake.calls.length).toBe(Math.min(n, OCR_PAGE_CAP));
      expect(row().meta).toMatchObject({ pagesOcr: Math.min(n, OCR_PAGE_CAP), pagesTotal: n });
    },
  );
});

describe("R5 — a crashed page child is retried once, then skipped; other pages are kept", () => {
  it("crash once, then success: the page is kept", async () => {
    const fake = useFake((p, attempt) =>
      p === 1 && attempt === 1 ? { kind: "crash", signal: "SIGSEGV" } : { kind: "page", pagesTotal: 3, lines: pageLines(p) },
    );
    await expect(run()).resolves.toBe("text");
    expect(fake.calls.map((c) => c.page)).toEqual([0, 1, 1, 2]);
    expect(row().meta).toMatchObject({ pagesOcr: 3, pagesFailed: 0 });
    expect(row().text_content).toContain("page 2 line");
  });

  it("crash twice on page 2 (SIGSEGV then SIGTRAP): page 2 skipped, pages 1 and 3 kept", async () => {
    const fake = useFake((p, attempt) =>
      p === 1
        ? { kind: "crash", signal: attempt === 1 ? "SIGSEGV" : "SIGTRAP", pagesTotal: 3 }
        : { kind: "page", pagesTotal: 3, lines: pageLines(p) },
    );
    await expect(run()).resolves.toBe("text");
    expect(fake.calls.map((c) => c.page)).toEqual([0, 1, 1, 2]);
    const r = row();
    expect(r.text_content).toContain("page 1 line");
    expect(r.text_content).toContain("page 3 line");
    expect(r.text_content).not.toContain("page 2 line");
    expect(r.meta).toMatchObject({ result: "text", pagesOcr: 2, pagesFailed: 1, pagesTotal: 3 });
  });

  it("a crash on the first page before the DOC line still reads the later pages", async () => {
    useFake((p) => (p === 0 ? { kind: "crash", signal: "SIGSEGV" } : { kind: "page", pagesTotal: 2, lines: pageLines(p) }));
    await expect(run()).resolves.toBe("text");
    expect(row().meta).toMatchObject({ pagesOcr: 1, pagesFailed: 1, pagesTotal: 2 });
  });
});

describe("C4 — a hung page child is stopped with SIGKILL, retried once, then skipped", () => {
  it("timeout on page 1 both times; page 2 kept", async () => {
    const fake = useFake((p) => (p === 0 ? { kind: "hang" } : { kind: "page", pagesTotal: 2, lines: pageLines(p) }));
    await expect(run({ pageTimeoutMs: 30 })).resolves.toBe("text");
    const page0 = fake.calls.filter((c) => c.page === 0);
    expect(page0.length).toBe(2);
    expect(page0.every((c) => c.killedWith === "SIGKILL")).toBe(true);
    expect(row().meta).toMatchObject({ pagesOcr: 1, pagesFailed: 1 });
  });
});

describe("R3 — retryable failure vs permanent", () => {
  it("every page fails: retryable error, attempts counts up, parks at the bound", async () => {
    useFake(() => ({ kind: "exit", code: 1, stderr: "vision performRequests failed" }));
    for (let i = 1; i <= OCR_MAX_ATTEMPTS; i++) {
      await expect(run()).resolves.toBe("retryable-error");
      expect(row()).toMatchObject({ text_content: "", meta: { reason: "error", retryable: true, attempts: i } });
      expect(pending()).toEqual(i < OCR_MAX_ATTEMPTS ? ["a"] : []);
    }
    await expect(run()).resolves.toBe("ineligible");
  });

  it("one failure then success: the retry clears the error and stores text", async () => {
    let calls = 0;
    useFake((p) => (calls++ < 2 ? { kind: "exit", code: 1 } : { kind: "page", pagesTotal: 1, lines: pageLines(p) }));
    await expect(run()).resolves.toBe("retryable-error");
    expect(row().meta).toMatchObject({ attempts: 1 });
    await expect(run()).resolves.toBe("text");
    expect(row().meta).toMatchObject({ textSource: "ocr", result: "text" });
  });

  it("unreadable input parks permanently without a retry", async () => {
    const fake = useFake(() => ({ kind: "exit", code: 1, stderr: "Error: stdin is neither a PDF nor an image (-2700)" }));
    await expect(run()).resolves.toBe("unreadable");
    expect(fake.calls.length).toBe(1);
    expect(row().meta).toMatchObject({ textSource: "none", reason: "unreadable" });
    expect(pending()).toEqual([]);
  });

  it("over the size cap: parked without spawning", async () => {
    const fake = useFake(() => ({ kind: "page", pagesTotal: 1, lines: ["x"] }));
    await expect(run({ maxSizeBytes: 4 })).resolves.toBe("over-cap");
    expect(fake.calls.length).toBe(0);
    expect(row().meta).toMatchObject({ textSource: "none", reason: "over-cap" });
    expect(pending()).toEqual([]);
  });

  it("missing file: retryable error, not a crash of the pass", async () => {
    db.prepare(`UPDATE attachments SET storage_path = ? WHERE id = 'a'`).run(path.join(tmpDir, "absent.pdf"));
    useFake(() => ({ kind: "page", pagesTotal: 1, lines: ["x"] }));
    await expect(run()).resolves.toBe("retryable-error");
    expect(row().meta).toMatchObject({ reason: "error", lastFailure: "read", attempts: 1 });
  });
});

describe("R1 — compare-and-set: a row changed while OCR ran is not overwritten", () => {
  it("text_content written by another pass mid-OCR survives; outcome row-changed", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { calls } = useFake((p) => ({ kind: "gated", release: gate, pagesTotal: 1, lines: pageLines(p) }));
    const fakeCalls = () => calls;
    const running = run();
    await waitFor(() => fakeCalls().length === 1);
    db.prepare(`UPDATE attachments SET text_content = 'written by another pass' WHERE id = 'a'`).run();
    release();
    await expect(running).resolves.toBe("row-changed");
    expect(row()).toEqual({ text_content: "written by another pass", meta: null });
  });
});

describe("R7 — quit during a job stops the child and writes nothing", () => {
  it("SIGKILL to the live child; row stays \"\" + NULL and still pending", async () => {
    let stopped = false;
    const fake = useFake(() => ({ kind: "hang" }));
    const running = run({ isStopped: () => stopped });
    await waitFor(() => fake.calls.length === 1);
    stopped = true;
    expect(stopLiveOcrChild()).toBe(true);
    await expect(running).resolves.toBe("stopped");
    expect(fake.calls.length).toBe(1);
    expect(fake.calls[0].killedWith).toBe("SIGKILL");
    expect(row()).toEqual({ text_content: "", meta: null });
    expect(pending()).toEqual(["a"]);
  });
});

describe("guards", () => {
  it("unsupported platform: nothing spawned, nothing written", async () => {
    const fake = useFake(() => ({ kind: "page", pagesTotal: 1, lines: ["x"] }));
    await expect(ocrAttachmentText("a", { platform: "win32" })).resolves.toBe("unsupported");
    expect(fake.calls.length).toBe(0);
    expect(row()).toEqual({ text_content: "", meta: null });
  });

  it.each([
    ["text_content NULL (text pass not run)", { text: null }],
    ["already has text", { text: "words" }],
    ["text/plain", { mime: "text/plain" }],
    ["image/png (a later item)", { mime: "image/png" }],
    ["no storage path", { storage: null }],
    ["a metadata value we did not write", { meta: "stray" }],
    ["already OCR'd", { meta: JSON.stringify({ textSource: "ocr", result: "empty" }) }],
  ])("ineligible: %s", async (_label, opts) => {
    insertRow("b", opts as Parameters<typeof insertRow>[1]);
    const fake = useFake(() => ({ kind: "page", pagesTotal: 1, lines: ["x"] }));
    await expect(ocrAttachmentText("b", { platform: "darwin" })).resolves.toBe("ineligible");
    expect(fake.calls.length).toBe(0);
  });
});

describe("C7 — text cap and file budget", () => {
  it("truncates to the text cap and records truncated:true", async () => {
    useFake(() => ({ kind: "page", pagesTotal: 1, lines: ["0123456789abcdef"] }));
    await run({ maxTextLength: 10 });
    expect(row().text_content).toBe("0123456789");
    expect(row().meta).toMatchObject({ truncated: true });
  });

  it("stops starting page children once the file budget is spent", async () => {
    let t = 0;
    const fake = useFake((p) => {
      t += 25_000;
      return { kind: "page", pagesTotal: 6, lines: pageLines(p) };
    });
    await run({ now: () => t, fileBudgetMs: 60_000 });
    expect(fake.calls.length).toBe(3);
    expect(row().meta).toMatchObject({ pagesOcr: 3, pagesTotal: 6, budgetExceeded: true });
  });
});
