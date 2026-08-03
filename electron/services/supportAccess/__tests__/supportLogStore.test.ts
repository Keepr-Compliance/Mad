/** @jest-environment node */
/**
 * Scoped log store — the size bound (BACKLOG-2393)
 *
 * The claim under test is "two bounds, whichever comes first". The time bound
 * has its own suite; this one holds the clock still for the entire run so that
 * the *only* thing that can stop growth is the size cap. If the cap were
 * accidentally implemented in terms of elapsed time — or not implemented at
 * all — nothing here would ever stop.
 */

import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import { SupportLogStore } from "../supportLogStore";
import type { SupportLogScopeId } from "../scopes";
import { makeTestCipher } from "./testCipher";

const T0 = Date.parse("2026-08-02T09:00:00.000Z");
const CONSENT_A = "11111111-1111-4111-8111-111111111111";

async function dirSize(dir: string): Promise<number> {
  const names = await fs.readdir(dir);
  let total = 0;
  for (const name of names) {
    total += (await fs.stat(path.join(dir, name))).size;
  }
  return total;
}

describe("SupportLogStore", () => {
  let baseDir: string;
  let logsDir: string;
  let now: number;
  let activeScopes: SupportLogScopeId[];
  let consentId: string | null;
  let cipher: ReturnType<typeof makeTestCipher>;

  const makeStore = (overrides: Partial<{ segment: number; total: number }> = {}) =>
    new SupportLogStore({
      now: () => now,
      baseDir,
      isScopeActive: (scope) => activeScopes.includes(scope),
      currentConsentId: () => consentId,
      cipher,
      maxSegmentBytes: overrides.segment ?? 4 * 1024,
      maxTotalBytes: overrides.total ?? 32 * 1024,
    });

  beforeEach(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "keepr-support-logs-"));
    logsDir = path.join(baseDir, "logs");
    now = T0;
    activeScopes = ["message-import", "contact-resolution"];
    consentId = CONSENT_A;
    cipher = makeTestCipher();
  });

  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------
  // The guard
  // ---------------------------------------------------------------------
  it("writes nothing at all when the scope is not granted", async () => {
    const store = makeStore();
    const wrote = await store.write("email-sync", "folder-scan", { folders: 3 });
    expect(wrote).toBe(false);
    await expect(fs.readdir(logsDir)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await store.totalBytes()).toBe(0);
  });

  it("writes when the scope is granted", async () => {
    const store = makeStore();
    expect(await store.write("message-import", "chats-found", { n: 12 })).toBe(
      true,
    );
    const snapshot = await store.snapshot(1024 * 1024);
    expect(snapshot.text).toContain('"event":"chats-found"');
    expect(snapshot.text).toContain('"n":12');
    expect(snapshot.text).toContain('"scope":"message-import"');
  });

  it("keeps a granted scope's entries and drops an ungranted one in the same run", async () => {
    const store = makeStore();
    await store.write("message-import", "kept", {});
    await store.write("transaction-linking", "dropped", {});
    const snapshot = await store.snapshot(1024 * 1024);
    expect(snapshot.text).toContain("kept");
    expect(snapshot.text).not.toContain("dropped");
  });

  // ---------------------------------------------------------------------
  // The size bound, with the clock held still
  // ---------------------------------------------------------------------
  it("stops growing at the cap even though the window never closes", async () => {
    const total = 32 * 1024;
    const store = makeStore({ segment: 4 * 1024, total });
    const payload = "x".repeat(512);

    // 2000 writes of ~512 bytes is roughly 1 MB of intent against a 32 KB cap.
    // The clock never moves, so time can play no part in stopping it.
    for (let i = 0; i < 2000; i += 1) {
      await store.write("message-import", "bulk", { i, payload });
    }
    expect(now).toBe(T0);

    const size = await dirSize(logsDir);
    expect(size).toBeLessThanOrEqual(total);
    // And it really did write — a broken writer would also "pass" a <= check.
    expect(size).toBeGreaterThan(total / 2);
  });

  it("holds the cap across a long plateau rather than creeping past it", async () => {
    const total = 24 * 1024;
    const store = makeStore({ segment: 3 * 1024, total });
    const payload = "y".repeat(400);

    const sizes: number[] = [];
    for (let batch = 0; batch < 8; batch += 1) {
      for (let i = 0; i < 200; i += 1) {
        await store.write("contact-resolution", "bulk", { batch, i, payload });
      }
      sizes.push(await dirSize(logsDir));
    }

    for (const size of sizes) {
      expect(size).toBeLessThanOrEqual(total);
    }
    // Growth genuinely plateaued instead of trending upward.
    expect(sizes[sizes.length - 1]).toBeLessThanOrEqual(sizes[2] + 1024);
  });

  it("rotates into segments and drops the oldest first", async () => {
    const store = makeStore({ segment: 2 * 1024, total: 8 * 1024 });
    const payload = "z".repeat(256);

    await store.write("message-import", "first-entry-marker", {});
    for (let i = 0; i < 400; i += 1) {
      now = T0 + i * 1000;
      await store.write("message-import", "bulk", { i, payload });
    }

    const names = await fs.readdir(logsDir);
    expect(names).toContain("current.log");
    expect(names.some((n) => n.startsWith("segment-"))).toBe(true);

    // The oldest content is what went, so the earliest marker is gone.
    const snapshot = await store.snapshot(1024 * 1024);
    expect(snapshot.text).not.toContain("first-entry-marker");
    expect(snapshot.text).toContain('"i":399');
  });

  it("never leaves a partial JSON line when truncating a snapshot", async () => {
    const store = makeStore({ segment: 64 * 1024, total: 512 * 1024 });
    for (let i = 0; i < 300; i += 1) {
      await store.write("message-import", "entry", { i, pad: "p".repeat(100) });
    }

    const snapshot = await store.snapshot(4096);
    expect(snapshot.droppedBytes).toBeGreaterThan(0);
    expect(snapshot.totalBytes).toBeGreaterThan(4096);

    const lines = snapshot.text.split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    // Truncation keeps the newest entries, which are the ones that describe
    // whatever the user is complaining about.
    expect(snapshot.text).toContain('"i":299');
  });

  it("reports an honest zero when there is nothing to snapshot", async () => {
    const store = makeStore();
    const snapshot = await store.snapshot(1024);
    expect(snapshot).toEqual({
      text: "",
      totalBytes: 0,
      droppedBytes: 0,
      fileCount: 0,
      unreadableRecords: 0,
      otherConsentRecords: 0,
    });
  });

  it("records the failure instead of throwing when a field cannot be serialised", async () => {
    const store = makeStore();
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    await expect(
      store.write("message-import", "circular", { circular }),
    ).resolves.toBe(true);

    const snapshot = await store.snapshot(1024 * 1024);
    expect(snapshot.text).toContain('"event":"circular"');
    expect(snapshot.text).toContain("unserialisable fields");
  });

  it("clears everything on request", async () => {
    const store = makeStore();
    for (let i = 0; i < 50; i += 1) {
      await store.write("message-import", "entry", { i });
    }
    expect(await store.totalBytes()).toBeGreaterThan(0);

    await store.clear();
    expect(await store.totalBytes()).toBe(0);
  });

  // ---------------------------------------------------------------------
  // Encryption at rest
  //
  // The founder's requirement was "secure at rest and in transit", and PII
  // scrubbing is deferred — so real client names and numbers are in these
  // files. Asserting on the *bytes on disk* rather than on the presence of an
  // encrypt() call is the only thing that shows they are not readable.
  // ---------------------------------------------------------------------
  describe("encryption at rest", () => {
    const NAME = "Jane Q Client";
    const PHONE = "+15551234567";

    async function readAllBytes(): Promise<Buffer> {
      const names = await fs.readdir(logsDir);
      const parts: Buffer[] = [];
      for (const name of names) {
        parts.push(await fs.readFile(path.join(logsDir, name)));
      }
      return Buffer.concat(parts);
    }

    it("leaves no readable contact name or number anywhere on disk", async () => {
      const store = makeStore();
      await store.write("contact-trace", "phone-unresolved", {
        name: NAME,
        handle: PHONE,
      });
      activeScopes = ["contact-trace"];
      await store.write("contact-trace", "phone-unresolved", {
        name: NAME,
        handle: PHONE,
      });

      const raw = await readAllBytes();
      expect(raw.length).toBeGreaterThan(0);
      // Every encoding someone might read the file with.
      for (const encoding of ["utf8", "latin1", "ascii", "utf16le"] as const) {
        expect(raw.toString(encoding)).not.toContain(NAME);
        expect(raw.toString(encoding)).not.toContain(PHONE);
      }
      expect(raw.toString("hex")).not.toContain(
        Buffer.from(PHONE, "utf8").toString("hex"),
      );

      // Control: the data really is there, and the right key returns it.
      const snapshot = await store.snapshot(1024 * 1024, { consentId: CONSENT_A });
      expect(snapshot.text).toContain(NAME);
      expect(snapshot.text).toContain(PHONE);
    });

    it("cannot be read back with a different key, and says how much it could not read", async () => {
      activeScopes = ["contact-trace"];
      const store = makeStore();
      await store.write("contact-trace", "phone-unresolved", { handle: PHONE });
      await store.flush();

      // A second machine's key — what an attacker who copied the files has.
      cipher = makeTestCipher();
      const stranger = makeStore();
      const snapshot = await stranger.snapshot(1024 * 1024);
      expect(snapshot.text).toBe("");
      expect(snapshot.unreadableRecords).toBeGreaterThan(0);
    });

    it("drops the record rather than writing it in the clear when sealing fails", async () => {
      const { makeUnavailableCipher } = await import("./testCipher");
      cipher = makeUnavailableCipher();
      const store = makeStore();

      expect(
        await store.write("message-import", "entry", { handle: PHONE }),
      ).toBe(false);
      expect(store.droppedWriteCount()).toBe(1);

      // Nothing at all was written — not a plaintext fallback, not a stub.
      await expect(fs.readdir(logsDir)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  // ---------------------------------------------------------------------
  // Consent scoping — the log-bleed fix
  //
  // A window that lapses leaves records behind. Without this filter they are
  // swept into the *next* grant's first report and attributed to a consent the
  // user gave months after the data was collected.
  // ---------------------------------------------------------------------
  describe("consent scoping", () => {
    const CONSENT_B = "22222222-2222-4222-8222-222222222222";

    it("excludes another grant's records from a scoped snapshot, and counts them", async () => {
      const store = makeStore();

      consentId = CONSENT_A;
      await store.write("message-import", "window-one", { client: "WindowOne" });

      // The window lapses; months pass; a new, unrelated grant opens.
      now = T0 + 60 * 24 * 60 * 60 * 1000;
      consentId = CONSENT_B;
      await store.write("message-import", "window-two", { client: "WindowTwo" });

      const scoped = await store.snapshot(1024 * 1024, { consentId: CONSENT_B });
      expect(scoped.text).toContain("WindowTwo");
      expect(scoped.text).not.toContain("WindowOne");
      expect(scoped.otherConsentRecords).toBe(1);

      // And the reverse, so this is a filter rather than an ordering accident.
      const first = await store.snapshot(1024 * 1024, { consentId: CONSENT_A });
      expect(first.text).toContain("WindowOne");
      expect(first.text).not.toContain("WindowTwo");
      expect(first.otherConsentRecords).toBe(1);
    });

    it("stamps every record with the grant it was collected under", async () => {
      const store = makeStore();
      await store.write("message-import", "entry", { i: 1 });
      const snapshot = await store.snapshot(1024 * 1024);
      const line = snapshot.text.trim();
      expect(JSON.parse(line).c).toBe(CONSENT_A);
    });

    it("writes nothing when there is no grant to attribute the record to", async () => {
      const store = makeStore();
      consentId = null;
      expect(await store.write("message-import", "orphan", {})).toBe(false);
      expect(await store.totalBytes()).toBe(0);
    });
  });
});
