/** @jest-environment node */
/**
 * Report capture, compression and the 10 MB cap (BACKLOG-2393)
 *
 * The bucket rejects anything over 10485760 bytes and one observed log was
 * 15 MB, so the interesting cases here are the two ways that can go wrong:
 * shipping something too large, and — worse — shipping something that fits
 * because it was quietly emptied, which would read as "this machine had
 * nothing to report".
 */

import { promises as fs } from "fs";
import { gunzipSync } from "zlib";
import * as os from "os";
import * as path from "path";
import { randomBytes } from "crypto";
import { SupportLogStore } from "../supportLogStore";
import { SupportReportQueue, type SupportReportPayload } from "../supportReportQueue";
import type { SupportConsentRecord } from "../types";
import { makeTestCipher } from "./testCipher";
import type { SupportCipher } from "../supportCipher";

const T0 = Date.parse("2026-08-02T09:00:00.000Z");

const CONSENT: SupportConsentRecord = {
  id: "consent-1",
  grantedAt: new Date(T0).toISOString(),
  expiresAt: new Date(T0 + 7 * 24 * 60 * 60 * 1000).toISOString(),
  durationId: "7d",
  appVersion: "2.27.0",
  disclosureId: "support-access-disclosure-v1",
  disclosureHash: "abc123",
  disclosureText: "The wording that was shown.",
  scopes: ["message-import", "contact-resolution"],
};

describe("SupportReportQueue", () => {
  let baseDir: string;
  let now: number;
  let logStore: SupportLogStore;
  let diagnostics: unknown;
  let consent: SupportConsentRecord | null;
  let cipher: SupportCipher;

  const makeQueue = (maxUploadBytes?: number) =>
    new SupportReportQueue({
      now: () => now,
      baseDir,
      logStore,
      cipher,
      collectDiagnostics: async () => diagnostics,
      getConsent: () => consent,
      maxUploadBytes,
    });

  const readPayload = async (
    queue: SupportReportQueue,
    id: string,
  ): Promise<SupportReportPayload> =>
    JSON.parse(gunzipSync(await queue.readBody(id)).toString("utf8"));

  beforeEach(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "keepr-support-queue-"));
    now = T0;
    consent = CONSENT;
    cipher = makeTestCipher();
    diagnostics = { app_version: "2.27.0", db_initialized: true };
    logStore = new SupportLogStore({
      now: () => now,
      baseDir,
      isScopeActive: () => true,
      currentConsentId: () => consent?.id ?? null,
      cipher,
      maxSegmentBytes: 512 * 1024,
      maxTotalBytes: 8 * 1024 * 1024,
    });
  });

  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it("refuses to capture without an open window", async () => {
    consent = null;
    await expect(makeQueue().capture("scheduled")).rejects.toThrow(
      /without an active grant/i,
    );
  });

  it("captures a gzipped report carrying the consent it was taken under", async () => {
    await logStore.write("message-import", "chats-found", { n: 12 });
    const queue = makeQueue();
    const meta = await queue.capture("manual");

    expect(meta.state).toBe("queued");
    expect(meta.reason).toBe("manual");
    expect(meta.capturedAt).toBe(new Date(T0).toISOString());
    expect(meta.consentId).toBe("consent-1");
    expect(meta.byteSize).toBeGreaterThan(0);
    expect(meta.byteSize).toBeLessThan(meta.rawByteSize);
    expect(meta.covers).toContain("Text message import");

    const payload = await readPayload(queue, meta.id);
    expect(payload.schema).toBe("keepr.support-report.v1");
    // The consent travels with the data it authorised.
    expect(payload.consent.disclosureText).toBe("The wording that was shown.");
    expect(payload.diagnostics).toEqual({
      app_version: "2.27.0",
      db_initialized: true,
    });
    expect(payload.logs.text).toContain("chats-found");
    expect(payload.logs.truncated).toBe(false);
  });

  it("drops log history to fit the cap, and says how much it dropped", async () => {
    for (let i = 0; i < 4000; i += 1) {
      await logStore.write("message-import", "entry", {
        i,
        pad: `${i}`.repeat(40),
      });
    }

    const cap = 4 * 1024;
    const queue = makeQueue(cap);
    const meta = await queue.capture("scheduled");

    expect(meta.byteSize).toBeLessThanOrEqual(cap);
    expect(meta.truncated).toBe(true);
    expect(meta.truncatedBytes).toBeGreaterThan(0);

    const payload = await readPayload(queue, meta.id);
    // The report states its own partiality rather than presenting a fragment
    // as the whole picture.
    expect(payload.logs.truncated).toBe(true);
    expect(payload.logs.droppedBytes).toBe(meta.truncatedBytes);
    expect(payload.logs.totalBytes).toBeGreaterThan(
      payload.logs.droppedBytes,
    );
  });

  it("fails loudly rather than shipping a report emptied to make it fit", async () => {
    // Incompressible diagnostics larger than the cap: no amount of log
    // truncation can save this, and quietly sending an empty-logged report
    // would send someone looking in the wrong place.
    diagnostics = { blob: randomBytes(256 * 1024).toString("base64") };
    const queue = makeQueue(4 * 1024);

    await expect(queue.capture("scheduled")).rejects.toThrow(
      /exceeds the 10 MB upload limit/i,
    );
    // Nothing was left behind pretending to be a report.
    expect(await queue.list()).toEqual([]);
  });

  it("lists newest first and resolves the retention countdown", async () => {
    const queue = makeQueue();
    const first = await queue.capture("scheduled");
    now = T0 + 60_000;
    const second = await queue.capture("manual");

    await queue.markSent(
      first.id,
      { ticketId: "t1", attachmentId: "a1", storagePath: "t1/a1/f.gz" },
      new Date(T0 + 30 * 24 * 60 * 60 * 1000).toISOString(),
    );

    now = T0 + 3 * 24 * 60 * 60 * 1000;
    const listed = await queue.listForDisplay();
    expect(listed.map((r) => r.id)).toEqual([second.id, first.id]);

    const sent = listed.find((r) => r.id === first.id);
    expect(sent?.state).toBe("sent");
    expect(sent?.serverDeleteInDays).toBe(27);
    expect(sent?.remote?.attachmentId).toBe("a1");

    const queued = listed.find((r) => r.id === second.id);
    expect(queued?.state).toBe("queued");
    expect(queued?.serverDeleteInDays).toBeUndefined();
  });

  it("does not downgrade a sent report to failed", async () => {
    const queue = makeQueue();
    const meta = await queue.capture("scheduled");
    await queue.markSent(
      meta.id,
      { ticketId: "t1", attachmentId: "a1", storagePath: "p" },
      new Date(T0 + 1000).toISOString(),
    );

    // A later failure (e.g. a delete that could not reach the server) must not
    // tell the user the report was never sent — the remote copy still exists.
    const after = await queue.markFailed(meta.id, "network down");
    expect(after?.state).toBe("sent");
    expect(after?.lastError).toBe("network down");
  });

  // -----------------------------------------------------------------------
  // Retention
  //
  // The consent checkbox says reports are deleted after 30 days. Two separate
  // failures used to make that false: a sent report's local row was deleted at
  // the deadline while the server copy lived on — taking the Delete button with
  // it — and a report that was never sent had no deadline at all.
  // -----------------------------------------------------------------------
  it("does NOT drop a sent report's local row at the deadline, because that row is the delete handle", async () => {
    const queue = makeQueue();
    const sent = await queue.capture("scheduled");
    await queue.markSent(
      sent.id,
      { ticketId: "t", attachmentId: "a", storagePath: "p" },
      new Date(T0 + 5000).toISOString(),
    );

    now = T0 + 6000;
    // The old behaviour removed this row here. Nothing on the server had been
    // deleted, so the user was shown "gone" for something still held.
    expect(await queue.purgeLocallyExpired()).toEqual([]);
    expect((await queue.list()).map((r) => r.id)).toEqual([sent.id]);

    // It is reported as due, so the scheduler can delete the server copy first.
    expect((await queue.dueForServerPurge()).map((r) => r.id)).toEqual([sent.id]);
  });

  it("gives a captured-but-never-sent report an expiry of its own", async () => {
    const queue = makeQueue();
    const stranded = await queue.capture("scheduled");
    expect(stranded.localExpiresAt).toBe(
      new Date(T0 + 30 * 24 * 60 * 60 * 1000).toISOString(),
    );

    // One day short: still here, and the user can still see and delete it.
    now = T0 + 29 * 24 * 60 * 60 * 1000;
    expect(await queue.purgeLocallyExpired()).toEqual([]);
    const [row] = await queue.listForDisplay();
    expect(row.localDeleteInDays).toBe(1);

    // Past the deadline: gone, because no other copy of it exists anywhere.
    now = T0 + 31 * 24 * 60 * 60 * 1000;
    expect(await queue.purgeLocallyExpired()).toEqual([stranded.id]);
    expect(await queue.list()).toEqual([]);
    await expect(queue.readBody(stranded.id)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("counts a sent report's deadline from the server, not from capture", async () => {
    const queue = makeQueue();
    const meta = await queue.capture("scheduled");
    await queue.markSent(
      meta.id,
      { ticketId: "t", attachmentId: "a", storagePath: "p" },
      new Date(T0 + 10 * 24 * 60 * 60 * 1000).toISOString(),
    );
    const [row] = await queue.listForDisplay();
    expect(row.serverDeleteInDays).toBe(10);
    // The local countdown is not shown once a server copy exists — that copy is
    // the one that matters, and showing two numbers invites the wrong one to be
    // believed.
    expect(row.localDeleteInDays).toBeUndefined();
  });

  it("removes both the payload and its metadata on local delete", async () => {
    const queue = makeQueue();
    const meta = await queue.capture("manual");
    await queue.removeLocal(meta.id);

    expect(await queue.getMeta(meta.id)).toBeNull();
    await expect(queue.readBody(meta.id)).rejects.toMatchObject({
      code: "ENOENT",
    });
    // Idempotent — a retry after a partial failure must not throw.
    await expect(queue.removeLocal(meta.id)).resolves.toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // Encryption at rest
  //
  // The queued payload used to be gzip only. `gunzipSync` with no key at all
  // recovered a client's name and number, which is the thing being fixed —
  // so the assertion is on the bytes, and the negative control is the exact
  // command that used to work.
  // -----------------------------------------------------------------------
  describe("encryption at rest", () => {
    const NAME = "Jane Q Client";
    const PHONE = "+15551234567";

    it("cannot be gunzipped off disk, and holds no readable name or number", async () => {
      await logStore.write("contact-trace", "phone-unresolved", {
        name: NAME,
        handle: PHONE,
      });
      const queue = makeQueue();
      const meta = await queue.capture("manual");

      const files = await fs.readdir(path.join(baseDir, "queue"));
      const payloadName = files.find((f) => f.startsWith(meta.id) && f.endsWith(".enc"));
      expect(payloadName).toBeDefined();
      const onDisk = await fs.readFile(
        path.join(baseDir, "queue", payloadName as string),
      );

      // This is the command that used to hand over the client list.
      expect(() => gunzipSync(onDisk)).toThrow();
      for (const encoding of ["utf8", "latin1", "utf16le"] as const) {
        expect(onDisk.toString(encoding)).not.toContain(NAME);
        expect(onDisk.toString(encoding)).not.toContain(PHONE);
      }

      // Control: with the key, it is still a gzip of the real report.
      const payload = await readPayload(queue, meta.id);
      expect(payload.logs.text).toContain(NAME);
      expect(payload.logs.text).toContain(PHONE);
    });

    it("refuses to capture rather than write a client list in the clear", async () => {
      const { makeUnavailableCipher } = await import("./testCipher");
      cipher = makeUnavailableCipher("keychain locked");
      const queue = makeQueue();

      await expect(queue.capture("manual")).rejects.toThrow(/keychain locked/);
      // Nothing was left behind — no half-written payload, no orphan metadata.
      await expect(fs.readdir(path.join(baseDir, "queue"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    });

    it("keeps the metadata readable without the key, so the row stays deletable", async () => {
      const queue = makeQueue();
      const meta = await queue.capture("manual");

      // A machine that lost its key must still show the user the row and its
      // Delete button; hiding it is how a user loses control of data that
      // still exists on the server.
      const raw = await fs.readFile(
        path.join(baseDir, "queue", `${meta.id}.meta.json`),
        "utf8",
      );
      expect(JSON.parse(raw).id).toBe(meta.id);
      expect(raw).not.toContain("Jane Q Client");
    });
  });

  // -----------------------------------------------------------------------
  // Consent scoping at capture
  // -----------------------------------------------------------------------
  it("captures only records collected under the grant it is attributed to", async () => {
    await logStore.write("message-import", "old-window", { client: "WindowOne" });

    const later: SupportConsentRecord = {
      ...CONSENT,
      id: "consent-2",
      grantedAt: new Date(T0 + 60 * 86_400_000).toISOString(),
      expiresAt: new Date(T0 + 67 * 86_400_000).toISOString(),
    };
    consent = later;
    now = T0 + 60 * 86_400_000;
    await logStore.write("message-import", "new-window", { client: "WindowTwo" });

    const queue = makeQueue();
    const meta = await queue.capture("scheduled");
    const payload = await readPayload(queue, meta.id);

    expect(meta.consentId).toBe("consent-2");
    expect(payload.logs.text).toContain("WindowTwo");
    expect(payload.logs.text).not.toContain("WindowOne");
    // The report states what it left out rather than presenting the gap as
    // "nothing happened".
    expect(payload.logs.otherConsentRecords).toBe(1);
  });
});
