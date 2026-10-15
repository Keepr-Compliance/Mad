/**
 * @jest-environment node
 */
/**
 * BACKLOG-3816 — cross-slice contract between S3 (migration writes the scope's
 * `done` marker) and S2 (attachment readers switch to requireEncrypted when the
 * scope they read from is `done`).
 *
 * Real KEPRENC crypto, real marker store, real temp userData. The migration runs
 * for real; the readers are the real S2 readers pointed at the same userData.
 *
 *   X1  before migration: a plaintext file in either scope is read (pass-through).
 *   X2  after migration marks both scopes done: a plaintext file dropped into
 *       either scope is REFUSED by every S2 reader entry point; the migrated
 *       (encrypted) file still reads back as its original bytes.
 *   X3  migrating ONE scope marks only that scope done; the other stays not-done
 *       and its plaintext file still reads.
 */
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

import {
  decryptStoredAttachmentTo,
  readContainedAttachment,
  readStoredAttachment,
  resolveRendererAttachment,
  setAttachmentReaderDepsForTests,
} from "../attachmentReader";
import { createFileCrypto, type FileCrypto, type KeyResolver } from "../fileCrypto";
import { createMarkerStore, SCOPE_EMAIL_ATTACHMENTS, SCOPE_MESSAGE_ATTACHMENTS, type MarkerStore } from "../markers";
import { DISK_HEADROOM_BYTES, createAtRestMigration } from "../migration";

const KEY = crypto.randomBytes(32);
const KEY_ID = crypto.randomBytes(16).toString("hex");
const resolver: KeyResolver = {
  currentKey: async () => ({ keyId: KEY_ID, key: KEY }),
  keyFor: async (id) => {
    if (id !== KEY_ID) throw new Error("unknown key");
    return KEY;
  },
};

const SCOPES = [
  { scope: SCOPE_MESSAGE_ATTACHMENTS, dir: "message-attachments" },
  { scope: SCOPE_EMAIL_ATTACHMENTS, dir: "attachments" },
] as const;

let root: string;
let files: FileCrypto;
let markers: MarkerStore;

const sha = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");

async function seed(dir: string, bytes: Buffer): Promise<string> {
  const full = path.join(root, dir);
  await fs.promises.mkdir(full, { recursive: true });
  const file = path.join(full, `${sha(bytes)}.bin`);
  await fs.promises.writeFile(file, bytes);
  return file;
}

function makeMigration(): ReturnType<typeof createAtRestMigration> {
  return createAtRestMigration({
    files: () => files,
    markers: () => markers,
    userData: () => root,
    ensureKey: async () => undefined,
    freeBytes: async () => 10 * DISK_HEADROOM_BYTES,
    now: () => Date.now() + 60_000,
    sleep: async () => undefined,
    log: () => undefined,
    broadcast: () => undefined,
    setTimer: () => undefined,
  });
}

async function migrateAll(): Promise<void> {
  const migration = makeMigration();
  for (const { scope } of SCOPES) await migration.runScope(scope);
}

beforeEach(async () => {
  root = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), "keepr-3816-xslice-")));
  files = createFileCrypto(resolver, { chunkSize: 64 });
  markers = createMarkerStore({ userData: () => root });
  setAttachmentReaderDepsForTests({ files: () => files, markers: () => markers, userData: () => root });
});

afterEach(async () => {
  setAttachmentReaderDepsForTests(null);
  await fs.promises.rm(root, { recursive: true, force: true });
});

describe.each(SCOPES)("S3 done marker → S2 reader phase switch ($dir)", ({ scope, dir }) => {
  it("X1 before migration a plaintext file is read as-is", async () => {
    const bytes = crypto.randomBytes(300);
    const file = await seed(dir, bytes);
    expect(await markers.getScope(scope)).toBeNull();
    expect((await readStoredAttachment(file)).equals(bytes)).toBe(true);
    expect((await readContainedAttachment(await resolveRendererAttachment(file))).equals(bytes)).toBe(true);
  });

  it("X2 after migration marks the scope done, a plaintext file in it is refused", async () => {
    const original = crypto.randomBytes(300);
    const migrated = await seed(dir, original);
    // The other scope too, so both are marked done by real runs.
    await migrateAll();
    expect((await markers.getScope(scope))?.state).toBe("done");

    // Migrated file: ciphertext on disk, original bytes through the reader.
    expect((await readStoredAttachment(migrated)).equals(original)).toBe(true);

    // A plaintext file appearing in the scope afterwards must not be served.
    const stray = await seed(dir, crypto.randomBytes(300));
    await expect(readStoredAttachment(stray)).rejects.toThrow();
    await expect(readContainedAttachment(await resolveRendererAttachment(stray))).rejects.toThrow();
    const dest = path.join(root, "out.bin");
    await expect(decryptStoredAttachmentTo(stray, dest)).rejects.toThrow();
    expect(fs.existsSync(dest)).toBe(false);
  });

  it("X3 migrating only this scope does not mark the other scope done", async () => {
    const other = SCOPES.find((s) => s.scope !== scope)!;
    // Both scopes need a file: an empty scope finishes "empty" and is never marked done.
    const mine = await seed(dir, crypto.randomBytes(300));
    const theirBytes = crypto.randomBytes(300);
    const theirs = await seed(other.dir, theirBytes);

    await makeMigration().runScope(scope);

    expect((await markers.getScope(scope))?.state).toBe("done");
    expect((await markers.getScope(other.scope))?.state).not.toBe("done");
    // The other scope's plaintext file is still served (its phase has not switched).
    expect((await readStoredAttachment(theirs)).equals(theirBytes)).toBe(true);
    expect(mine).not.toBe(theirs);
  });
});
