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
const RETRY_MS = 20;

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

  let warnings: string[];
  let stores: SupportLogStore[];

  const makeStore = (overrides: Partial<{ segment: number; total: number }> = {}) => {
    const store = new SupportLogStore({
      now: () => now,
      baseDir,
      isScopeActive: (scope) => activeScopes.includes(scope),
      currentConsentId: () => consentId,
      cipher,
      maxSegmentBytes: overrides.segment ?? 4 * 1024,
      maxTotalBytes: overrides.total ?? 32 * 1024,
      capRetryDelayMs: RETRY_MS,
      // Captured so a red on a Windows runner names the errno (BACKLOG-3191).
      log: (level, message) => {
        if (level !== "info") warnings.push(message);
      },
    });
    stores.push(store);
    return store;
  };

  /**
   * Measure the directory once queued writes have landed. If something outside
   * the store (on Windows: antivirus or the indexer) is holding a segment, the
   * store trims again on its delayed retry and on the next write — so wait,
   * write one small record, and measure again. The bound asserted is unchanged;
   * only the instant it is measured moves past a retry. On a hold that outlasts
   * the deadline, fail with the captured warnings so the errno is named
   * (BACKLOG-3191).
   */
  async function settledSize(store: SupportLogStore, cap: number): Promise<number> {
    const deadline = Date.now() + 10_000;
    for (;;) {
      await store.flush();
      const size = await dirSize(logsDir);
      if (size <= cap) return size;
      if (Date.now() > deadline) {
        throw new Error(
          `log dir ${size} > cap ${cap}; warnings:\n${warnings.join("\n")}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
      await store.write("message-import", "settle", {});
    }
  }

  beforeEach(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "keepr-support-logs-"));
    logsDir = path.join(baseDir, "logs");
    now = T0;
    activeScopes = ["message-import", "contact-resolution"];
    consentId = CONSENT_A;
    cipher = makeTestCipher();
    warnings = [];
    stores = [];
  });

  afterEach(async () => {
    // Nothing may still be writing, or holding a retry timer, when the
    // directory goes away.
    for (const store of stores) await store.clear();
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
    const payload = "x".repeat(1536);

    // 300 writes of ~1.5 KB is roughly 460 KB of intent against a 32 KB cap
    // (~14x). BACKLOG-3915: was 2000 x 512 B — the same claim at ~6x the fs
    // calls, which ran past the 30 s timeout on a loaded Windows runner.
    // The clock never moves, so time can play no part in stopping it.
    for (let i = 0; i < 300; i += 1) {
      await store.write("message-import", "bulk", { i, payload });
    }
    expect(now).toBe(T0);

    const size = await settledSize(store, total);
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
      sizes.push(await settledSize(store, total));
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
    await settledSize(store, 8 * 1024);

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
    const PHONE = "+15555550112";

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
      await store.write("contact-resolution", "resolve-phone-names", {
        name: NAME,
        handle: PHONE,
      });
      activeScopes = ["contact-resolution"];
      await store.write("contact-resolution", "resolve-phone-names", {
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
      activeScopes = ["contact-resolution"];
      const store = makeStore();
      await store.write("contact-resolution", "resolve-phone-names", { handle: PHONE });
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
  // ---------------------------------------------------------------------
  // A segment that cannot be removed (BACKLOG-3191)
  //
  // On Windows an antivirus scanner or the indexer can hold a just-renamed
  // file, and unlink fails with EPERM/EBUSY. The store must not spin on it:
  // one delayed retry that does not block the caller, then wait for the next
  // write. The cap is small enough that exactly one segment exists when the
  // trim first needs it, so skipping it cannot satisfy the cap another way.
  // ---------------------------------------------------------------------
  describe("when the oldest segment is held by another process", () => {
    const SEGMENT = 2 * 1024;
    const CAP = 3 * 1024;
    const payload = "h".repeat(200);
    let held: { code: string; failuresLeft: number; attempts: number };
    let realUnlink: typeof fs.unlink;
    let unlinkSpy: jest.SpyInstance;

    beforeEach(() => {
      jest.useFakeTimers({
        doNotFake: ["nextTick", "setImmediate", "queueMicrotask"],
      });
      held = { code: "EPERM", failuresLeft: 0, attempts: 0 };
      realUnlink = fs.unlink.bind(fs);
      unlinkSpy = jest
        .spyOn(fs, "unlink")
        .mockImplementation(async (target) => {
          if (path.basename(String(target)).startsWith("segment-")) {
            held.attempts += 1;
            if (held.failuresLeft > 0) {
              held.failuresLeft -= 1;
              const error = new Error(`${held.code}: file is in use, unlink`);
              (error as NodeJS.ErrnoException).code = held.code;
              throw error;
            }
          }
          return realUnlink(target);
        });
    });

    afterEach(async () => {
      unlinkSpy.mockRestore();
      jest.useRealTimers();
    });

    /** Write until the trim first has to touch a segment. */
    async function writeUntilTrimNeeded(store: SupportLogStore): Promise<void> {
      for (let i = 0; i < 100 && held.attempts === 0; i += 1) {
        expect(await store.write("message-import", "bulk", { i, payload })).toBe(
          true,
        );
      }
      expect(held.attempts).toBeGreaterThan(0);
    }

    async function names(): Promise<string[]> {
      return fs.readdir(logsDir);
    }

    async function advancePastRetry(store: SupportLogStore): Promise<void> {
      await jest.advanceTimersByTimeAsync(RETRY_MS);
      await store.flush();
    }

    it("tries once inline and once after the delay, then stops, without blocking writes", async () => {
      const store = makeStore({ segment: SEGMENT, total: CAP });
      // More failures than the store may ever spend. An unbounded retry would
      // burn through them inside a single write.
      held.failuresLeft = 50;

      await writeUntilTrimNeeded(store);
      expect(held.attempts).toBe(1);
      const segment = (await names()).find((n) => n.startsWith("segment-"));
      expect(segment).toBeDefined();
      expect(await names()).toContain("current.log");

      await advancePastRetry(store);
      expect(held.attempts).toBe(2);

      // Nothing else is scheduled after the retry fails.
      await jest.advanceTimersByTimeAsync(RETRY_MS * 20);
      await store.flush();
      expect(held.attempts).toBe(2);

      // The held segment is still there, writes still succeed, and the
      // overage is bounded by that one segment.
      expect(await names()).toEqual(expect.arrayContaining(["current.log", segment]));
      expect(await store.totalBytes()).toBeLessThanOrEqual(CAP + SEGMENT);
      expect(warnings.some((w) => w.includes("EPERM"))).toBe(true);
    });

    it("trims to the cap when the delayed retry succeeds", async () => {
      const store = makeStore({ segment: SEGMENT, total: CAP });
      held.code = "EBUSY";
      held.failuresLeft = 1;

      await writeUntilTrimNeeded(store);
      const segment = (await names()).find((n) => n.startsWith("segment-"));
      expect(segment).toBeDefined();

      await advancePastRetry(store);
      expect(held.attempts).toBe(2);
      expect(await names()).not.toContain(segment);
      expect(await names()).toContain("current.log");
      expect(await store.totalBytes()).toBeLessThanOrEqual(CAP);
    });

    it("tries again on the next write after the retry has given up", async () => {
      const store = makeStore({ segment: SEGMENT, total: CAP });
      held.failuresLeft = 50;

      await writeUntilTrimNeeded(store);
      await advancePastRetry(store);
      expect(held.attempts).toBe(2);
      const segment = (await names()).find((n) => n.startsWith("segment-"));

      // Still held: the next write tries inline and arms one more retry.
      expect(await store.write("message-import", "after-1", {})).toBe(true);
      expect(held.attempts).toBe(3);
      await advancePastRetry(store);
      expect(held.attempts).toBe(4);

      // Released: the next write trims it.
      held.failuresLeft = 0;
      expect(await store.write("message-import", "after-2", {})).toBe(true);
      expect(await names()).not.toContain(segment);
      expect(await names()).toContain("current.log");
      expect(await store.totalBytes()).toBeLessThanOrEqual(CAP);
    });
  });

  it("keeps a current.log when current.log alone was over the cap", async () => {
    // One record larger than the whole cap: the only way under is to seal
    // current.log and trim it. The store must still have a file to append to.
    const store = makeStore({ segment: 64 * 1024, total: 1024 });
    expect(
      await store.write("message-import", "big", { pad: "b".repeat(2048) }),
    ).toBe(true);

    expect(await fs.readdir(logsDir)).toEqual(["current.log"]);
    expect(await store.totalBytes()).toBeLessThanOrEqual(1024);

    expect(await store.write("message-import", "next", {})).toBe(true);
    const snapshot = await store.snapshot(1024 * 1024);
    expect(snapshot.text).toContain('"event":"next"');
  });
});
