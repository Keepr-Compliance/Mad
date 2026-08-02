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

  const makeQueue = (maxUploadBytes?: number) =>
    new SupportReportQueue({
      now: () => now,
      baseDir,
      logStore,
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
    diagnostics = { app_version: "2.27.0", db_initialized: true };
    logStore = new SupportLogStore({
      now: () => now,
      baseDir,
      isScopeActive: () => true,
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

  it("purges local copies once their server retention has passed", async () => {
    const queue = makeQueue();
    const expiring = await queue.capture("scheduled");
    now = T0 + 1000;
    const keeping = await queue.capture("scheduled");

    await queue.markSent(
      expiring.id,
      { ticketId: "t", attachmentId: "a", storagePath: "p" },
      new Date(T0 + 5000).toISOString(),
    );
    await queue.markSent(
      keeping.id,
      { ticketId: "t", attachmentId: "b", storagePath: "q" },
      new Date(T0 + 999_999).toISOString(),
    );

    now = T0 + 6000;
    const removed = await queue.purgeExpired();
    expect(removed).toEqual([expiring.id]);

    const remaining = await queue.list();
    expect(remaining.map((r) => r.id)).toEqual([keeping.id]);
    await expect(queue.readBody(expiring.id)).rejects.toMatchObject({
      code: "ENOENT",
    });
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
});
