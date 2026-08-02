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

const T0 = Date.parse("2026-08-02T09:00:00.000Z");

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

  const makeStore = (overrides: Partial<{ segment: number; total: number }> = {}) =>
    new SupportLogStore({
      now: () => now,
      baseDir,
      isScopeActive: (scope) => activeScopes.includes(scope),
      maxSegmentBytes: overrides.segment ?? 4 * 1024,
      maxTotalBytes: overrides.total ?? 32 * 1024,
    });

  beforeEach(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "keepr-support-logs-"));
    logsDir = path.join(baseDir, "logs");
    now = T0;
    activeScopes = ["message-import", "contact-resolution"];
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
});
