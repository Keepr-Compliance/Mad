/**
 * @jest-environment node
 */
/**
 * BACKLOG-3816 S2 — the attachment IPC readers decrypt on read.
 *
 * Fixtures are REAL KEPRENC files written by the same FileCrypto the app uses
 * (createFileCrypto, small chunks so multi-chunk paths run), in a real temp
 * userData. Nothing about the container is hand-built.
 *
 * Controls in this file:
 *   R1  attachments:get-data   on an encrypted file → data: URL of the PLAINTEXT
 *   R2  attachments:get-buffer on an encrypted file → base64 of the PLAINTEXT
 *   R3  attachments:open       → shell.openPath gets a decrypted copy under
 *       userData/at-rest-open/<run>/<n>/<original name>
 *   O1  the open-copy dir is removed on will-quit and at the next launch
 *   P1  a path that leaves the attachment folders via `..`, a symlink, a
 *       directory link (junction-shaped) or a sibling-prefix folder is refused
 *   PH  phase switch: plaintext accepted before the scope is `done`, refused after
 *   NC  after preview reads, no plaintext copy of any fixture is left in userData
 */
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { Readable } from "stream";

import { createIpcHandlerRegistry, type IpcHandlerRegistry } from "../../../../tests/support/ipcHandlerRegistry";

const registeredHandlers: IpcHandlerRegistry = createIpcHandlerRegistry();
const appListeners: Record<string, Array<() => void>> = {};
const openedPaths: Array<{ path: string; bytes: Buffer }> = [];

jest.mock("electron", () => ({
  ipcMain: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handle: (channel: string, fn: any) => {
      registeredHandlers.set(channel, fn);
    },
  },
  BrowserWindow: jest.fn(),
  app: {
    isPackaged: false,
    getPath: jest.fn(() => "/tmp"),
    on: (event: string, cb: () => void) => {
      (appListeners[event] ??= []).push(cb);
    },
  },
  shell: {
    openPath: jest.fn(async (p: string) => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      openedPaths.push({ path: p, bytes: require("fs").readFileSync(p) });
      return "";
    }),
  },
  net: { fetch: jest.fn() },
}));

jest.mock("../../databaseService", () => ({
  __esModule: true,
  default: {
    getRawDatabase: () => ({
      prepare: () => ({ get: () => ({ filename: "Contract Final.pdf" }), all: () => [] }),
    }),
    isInitialized: jest.fn(() => true),
  },
}));
jest.mock("../../logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock("../../auditService", () => ({ __esModule: true, default: { logAction: jest.fn(), log: jest.fn() } }));
jest.mock("../../emailAttachmentService", () => ({
  __esModule: true,
  default: { getAttachmentsForEmail: jest.fn(() => Promise.resolve([])) },
}));
jest.mock("../../emailAttachmentBackfillService", () => ({ backfillAttachmentMetadata: jest.fn() }));
jest.mock("../../attachmentTextExtractionBackfillService", () => ({ backfillAttachmentTextContent: jest.fn() }));
jest.mock("../../gmailFetchService", () => ({ __esModule: true, default: { fetchAttachment: jest.fn() } }));
jest.mock("../../outlookFetchService", () => ({ __esModule: true, default: { fetchAttachment: jest.fn() } }));
jest.mock("../../featureGateService", () => ({ __esModule: true, default: { canUseFeature: jest.fn(() => true) } }));
jest.mock("../../supabaseService", () => ({ __esModule: true, default: { getClient: jest.fn() } }));
jest.mock("../../db/emailDbService", () => ({ getEmailById: jest.fn() }));

import { registerAttachmentHandlers, resetOpenTempCleanupForTests } from "../../../handlers/attachmentHandlers";
import { setAttachmentReaderDepsForTests } from "../attachmentReader";
import { isInside } from "../containment";
import { createFileCrypto, MAGIC, type KeyResolver } from "../fileCrypto";
import { createMarkerStore } from "../markers";
import { AT_REST_OPEN_DIR } from "../openTemp";

const KEY = crypto.randomBytes(32);
const KEY_ID = crypto.randomBytes(16).toString("hex");
const resolver: KeyResolver = {
  currentKey: async () => ({ keyId: KEY_ID, key: KEY }),
  keyFor: async (id) => {
    if (id !== KEY_ID) throw new Error("unknown key");
    return KEY;
  },
};
const files = createFileCrypto(resolver, { chunkSize: 64 });

// A JPEG-shaped plaintext (magic FF D8 FF) spanning several 64-byte chunks.
const PLAIN = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(300)]);

let root: string;
let userData: string;
let outside: string;
let encPath: string;

async function invoke(channel: string, ...args: unknown[]): Promise<{ success: boolean; data?: string; error?: string }> {
  const fn = registeredHandlers.get(channel);
  if (!fn) throw new Error(`no handler ${channel}`);
  return fn({} as never, ...args);
}

function allFiles(dir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...allFiles(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

/** NC: every file left in userData is ciphertext or the state file; no fixture plaintext anywhere. */
function assertNoPlaintextInUserData(except: string[] = []): void {
  const leaks = allFiles(userData).filter((f) => {
    if (except.some((e) => f.startsWith(e))) return false;
    if (path.basename(f) === "at-rest-state.json") return false;
    const bytes = fs.readFileSync(f);
    return !bytes.subarray(0, MAGIC.length).equals(MAGIC) || bytes.includes(PLAIN.subarray(0, 32));
  });
  expect(leaks).toEqual([]);
}

beforeEach(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "s2-handlers-")));
  userData = path.join(root, "keepr");
  outside = path.join(root, "outside");
  fs.mkdirSync(path.join(userData, "message-attachments"), { recursive: true });
  fs.mkdirSync(path.join(userData, "attachments"), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  encPath = path.join(userData, "message-attachments", "abc123.jpg");
  await files.encryptStreamToFile(Readable.from([PLAIN]), encPath);
  setAttachmentReaderDepsForTests({
    files: () => files,
    markers: () => createMarkerStore({ userData: () => userData }),
    userData: () => userData,
  });
  for (const k of Object.keys(appListeners)) delete appListeners[k];
  openedPaths.length = 0;
  registeredHandlers.clear();
  resetOpenTempCleanupForTests();
  registerAttachmentHandlers(null);
});

afterEach(() => {
  setAttachmentReaderDepsForTests(null);
  fs.rmSync(root, { recursive: true, force: true });
});

describe("fixture sanity", () => {
  it("the stored file is a KEPRENC container, not the plaintext", () => {
    const raw = fs.readFileSync(encPath);
    expect(raw.subarray(0, MAGIC.length).equals(MAGIC)).toBe(true);
    expect(raw.includes(PLAIN.subarray(0, 32))).toBe(false);
  });
});

describe("R1/R2 preview readers decrypt", () => {
  it("R1 attachments:get-data returns a data: URL of the plaintext", async () => {
    const res = await invoke("attachments:get-data", encPath, "image/jpeg");
    expect(res.success).toBe(true);
    expect(res.data).toBe(`data:image/jpeg;base64,${PLAIN.toString("base64")}`);
    assertNoPlaintextInUserData();
  });

  it("R2 attachments:get-buffer returns base64 of the plaintext", async () => {
    const res = await invoke("attachments:get-buffer", encPath);
    expect(res.success).toBe(true);
    expect(Buffer.from(res.data as string, "base64").equals(PLAIN)).toBe(true);
    assertNoPlaintextInUserData();
  });

  it("an email attachment (userData/attachments) decrypts too", async () => {
    const p = path.join(userData, "attachments", "e1", "doc.pdf");
    await files.encryptStreamToFile(Readable.from([PLAIN]), p);
    const res = await invoke("attachments:get-buffer", p);
    expect(Buffer.from(res.data as string, "base64").equals(PLAIN)).toBe(true);
  });
});

describe("R3 open + O1 cleanup", () => {
  it("R3 opens a decrypted copy named after the original file, inside at-rest-open", async () => {
    const res = await invoke("attachments:open", encPath);
    expect(res.success).toBe(true);
    expect(openedPaths).toHaveLength(1);
    const opened = openedPaths[0];
    expect(opened.bytes.equals(PLAIN)).toBe(true);
    expect(path.basename(opened.path)).toBe("Contract Final.jpg"); // stem from the DB name, extension of the STORED file (.jpg)
    expect(isInside(opened.path, path.join(userData, AT_REST_OPEN_DIR))).toBe(true);
  });

  it("O1 the decrypted copies are removed on will-quit", async () => {
    await invoke("attachments:open", encPath);
    expect(fs.existsSync(openedPaths[0].path)).toBe(true);
    expect(appListeners["will-quit"]?.length).toBe(1);
    for (const cb of appListeners["will-quit"]) cb();
    expect(fs.existsSync(path.join(userData, AT_REST_OPEN_DIR))).toBe(false);
    assertNoPlaintextInUserData();
  });

  it("O1 copies left by a crashed run are removed at the next launch", async () => {
    const stale = path.join(userData, AT_REST_OPEN_DIR, "deadbeef", "1", "left.jpg");
    fs.mkdirSync(path.dirname(stale), { recursive: true });
    fs.writeFileSync(stale, PLAIN);
    resetOpenTempCleanupForTests();
    registerAttachmentHandlers(null); // = next launch
    const openRoot = path.join(userData, AT_REST_OPEN_DIR);
    // the launch cleanup is fire-and-forget; wait (bounded) for the whole dir, not just the file
    for (let i = 0; i < 200 && fs.existsSync(openRoot); i++) await new Promise((r) => setTimeout(r, 10));
    expect(fs.existsSync(path.join(userData, AT_REST_OPEN_DIR))).toBe(false);
    assertNoPlaintextInUserData();
  });
});

describe("P1 containment", () => {
  const refused = (res: { success: boolean; error?: string }) => {
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Invalid attachment path/);
  };

  it("refuses `..` out of the attachment folder to another userData file", async () => {
    fs.writeFileSync(path.join(userData, "mad.db"), "SQLite format 3\0secret");
    refused(await invoke("attachments:get-buffer", path.join(userData, "message-attachments", "..", "mad.db")));
  });

  it("refuses a symlink inside the folder that points outside", async () => {
    fs.writeFileSync(path.join(outside, "secret.jpg"), PLAIN);
    const link = path.join(userData, "message-attachments", "link.jpg");
    try {
      fs.symlinkSync(path.join(outside, "secret.jpg"), link);
    } catch (error) {
      // Windows runners without the symlink privilege: the junction test below covers links there.
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    refused(await invoke("attachments:get-data", link, "image/jpeg"));
    refused(await invoke("attachments:open", link));
    expect(openedPaths).toHaveLength(0);
  });

  it("refuses a directory link (junction-shaped) inside the folder that points outside", async () => {
    fs.writeFileSync(path.join(outside, "secret.jpg"), PLAIN);
    const junction = path.join(userData, "message-attachments", "jdir");
    fs.symlinkSync(outside, junction, "junction"); // a real junction on Windows; a dir symlink on POSIX
    refused(await invoke("attachments:get-buffer", path.join(junction, "secret.jpg")));
  });

  it("refuses a sibling folder that shares the root's name as a prefix", async () => {
    const sibling = path.join(userData, "message-attachments-evil");
    fs.mkdirSync(sibling);
    fs.writeFileSync(path.join(sibling, "x.jpg"), PLAIN);
    refused(await invoke("attachments:get-buffer", path.join(sibling, "x.jpg")));
  });

  it("refuses a directory (not a regular file) inside the folder", async () => {
    fs.mkdirSync(path.join(userData, "message-attachments", "sub"));
    refused(await invoke("attachments:get-buffer", path.join(userData, "message-attachments", "sub")));
  });

  it("isInside is separator-aware and case-insensitive on Windows only", () => {
    expect(isInside("/a/bc", "/a/b", "darwin")).toBe(false);
    expect(isInside("/a/b/c", "/a/b", "darwin")).toBe(true);
    expect(isInside("/A/B/c", "/a/b", "darwin")).toBe(false);
    expect(isInside("C:\\Users\\X\\Keepr\\message-attachments\\f.jpg", "c:\\users\\x\\keepr\\message-attachments", "win32")).toBe(true);
    expect(isInside("C:\\Users\\X\\Keepr\\message-attachments-evil\\f.jpg", "c:\\users\\x\\keepr\\message-attachments", "win32")).toBe(false);
  });
});

describe("PH phase switch", () => {
  it("plaintext passes through before the scope is done and is refused after", async () => {
    const plainPath = path.join(userData, "message-attachments", "legacy.jpg");
    fs.writeFileSync(plainPath, PLAIN);
    const markers = createMarkerStore({ userData: () => userData });

    await markers.setScope("message-attachments", "migrating");
    const before = await invoke("attachments:get-buffer", plainPath);
    expect(Buffer.from(before.data as string, "base64").equals(PLAIN)).toBe(true);

    await markers.setScope("message-attachments", "done");
    const after = await invoke("attachments:get-buffer", plainPath);
    expect(after.success).toBe(false);
    expect(after.error).toMatch(/not encrypted/);
    const openAfter = await invoke("attachments:open", plainPath);
    expect(openAfter.success).toBe(false);
    expect(openedPaths).toHaveLength(0);

    // ciphertext still reads after done
    const enc = await invoke("attachments:get-buffer", encPath);
    expect(Buffer.from(enc.data as string, "base64").equals(PLAIN)).toBe(true);
  });

  it("the email scope switches independently (key \"email-attachments\")", async () => {
    const plainPath = path.join(userData, "attachments", "legacy.pdf");
    fs.writeFileSync(plainPath, PLAIN);
    const markers = createMarkerStore({ userData: () => userData });
    await markers.setScope("message-attachments", "done");
    expect((await invoke("attachments:get-buffer", plainPath)).success).toBe(true);
    await markers.setScope("email-attachments", "done");
    expect((await invoke("attachments:get-buffer", plainPath)).success).toBe(false);
  });
});

// KP — an OLD plaintext attachment whose bytes happen to begin with "KEPRENC"
// must preview as itself. Detection is structural (S1's full-header probe, on the
// reader's one handle), so the 7-byte magic alone does not classify a file.
describe("KP plaintext that starts with the magic bytes", () => {
  it("previews a legacy plaintext file beginning with KEPRENC as its own bytes", async () => {
    const forged = Buffer.concat([Buffer.from("KEPRENC"), crypto.randomBytes(200)]);
    const p = path.join(userData, "message-attachments", "legacy-kep.bin");
    fs.writeFileSync(p, forged);
    const res = await invoke("attachments:get-buffer", p);
    expect(res.success).toBe(true);
    expect(Buffer.from(res.data as string, "base64").equals(forged)).toBe(true);
  });
});

