/** @jest-environment node */
/**
 * The window guard and the delete contract (BACKLOG-2393)
 *
 * Everything here is asserted on what a fake transport was *handed*, never on
 * the shape of the guard's source. "No upload happens outside the window" is a
 * claim about bytes leaving the machine; reading the `if` that is supposed to
 * prevent it proves nothing, and would keep passing if the call were moved
 * somewhere the guard does not cover.
 *
 * So the transport records every outbound payload, and the assertion is that
 * the recording is empty.
 */

import { promises as fs } from "fs";
import { gunzipSync } from "zlib";
import * as os from "os";
import * as path from "path";
import { SupportAccessService } from "../supportAccessService";
import { SupportLogStore } from "../supportLogStore";
import { SupportReportQueue } from "../supportReportQueue";
import { SupportUploadScheduler } from "../supportUploadScheduler";
import type {
  SupportRemoteRef,
  SupportReportUpload,
  SupportUploadResult,
  SupportUploadTransport,
} from "../types";

const T0 = Date.parse("2026-08-02T09:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

/**
 * Records everything it is asked to send. `uploads` is the outbound payload
 * ledger the assertions read.
 */
class RecordingTransport implements SupportUploadTransport {
  uploads: SupportReportUpload[] = [];
  deletes: SupportRemoteRef[] = [];
  uploadError: Error | null = null;
  deleteError: Error | null = null;
  /** Runs after each accepted upload — used to close the window mid-batch. */
  afterUpload: (() => void) | null = null;
  private counter = 0;

  async upload(upload: SupportReportUpload): Promise<SupportUploadResult> {
    this.uploads.push(upload);
    if (this.uploadError) throw this.uploadError;
    this.counter += 1;
    const id = `attachment-${this.counter}`;
    this.afterUpload?.();
    return {
      remote: {
        ticketId: "ticket-1",
        attachmentId: id,
        storagePath: `ticket-1/${id}/${upload.fileName}`,
      },
      expiresAt: new Date(T0 + 30 * DAY).toISOString(),
    };
  }

  async deleteRemote(ref: SupportRemoteRef): Promise<void> {
    this.deletes.push(ref);
    if (this.deleteError) throw this.deleteError;
  }

  /** What actually went out, decompressed. */
  decoded(): Array<Record<string, unknown>> {
    return this.uploads.map((u) => JSON.parse(gunzipSync(u.body).toString("utf8")));
  }
}

describe("SupportUploadScheduler", () => {
  let baseDir: string;
  let now: number;
  let access: SupportAccessService;
  let logStore: SupportLogStore;
  let queue: SupportReportQueue;
  let transport: RecordingTransport;
  let scheduler: SupportUploadScheduler;

  const build = () => {
    access = new SupportAccessService({
      now: () => now,
      baseDir,
      appVersion: () => "2.27.0",
    });
    logStore = new SupportLogStore({
      now: () => now,
      baseDir,
      isScopeActive: (scope) => access.isScopeActive(scope),
    });
    queue = new SupportReportQueue({
      now: () => now,
      baseDir,
      logStore,
      collectDiagnostics: async () => ({ app_version: "2.27.0" }),
      getConsent: () => (access.isActive() ? access.getConsentRecord() : null),
    });
    transport = new RecordingTransport();
    scheduler = new SupportUploadScheduler({
      now: () => now,
      access,
      queue,
      transport,
    });
  };

  beforeEach(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "keepr-support-sched-"));
    now = T0;
    build();
    await access.load();
  });

  afterEach(async () => {
    scheduler.stop();
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------
  // Positive control: the ledger does record when an upload is allowed.
  // Without this, every "nothing was sent" assertion below could be passing
  // because the fake is broken.
  // ---------------------------------------------------------------------
  it("sends inside the window, and the payload carries the consent", async () => {
    await access.grant({ durationId: "7d" });
    await logStore.write("message-import", "chats-found", { n: 5 });

    const result = await scheduler.tick();

    expect(result.sent).toHaveLength(1);
    expect(transport.uploads).toHaveLength(1);
    expect(transport.uploads[0].contentType).toBe("application/gzip");
    expect(transport.uploads[0].fileName).toMatch(/\.json\.gz$/);
    expect(transport.uploads[0].retentionDays).toBe(30);

    const payload = transport.decoded()[0] as {
      consent: { disclosureText: string; expiresAt: string };
      logs: { text: string };
    };
    expect(payload.consent.expiresAt).toBe(
      new Date(T0 + 7 * DAY).toISOString(),
    );
    expect(payload.consent.disclosureText).toContain("phone numbers");
    expect(payload.logs.text).toContain("chats-found");

    const listed = await scheduler.listReports();
    expect(listed[0].state).toBe("sent");
    expect(listed[0].serverDeleteInDays).toBe(30);
  });

  // ---------------------------------------------------------------------
  // The claim
  // ---------------------------------------------------------------------
  describe("outside the window", () => {
    it("sends nothing on a scheduled tick — asserted on the outbound payload", async () => {
      await access.grant({ durationId: "24h" });
      await logStore.write("message-import", "chats-found", { n: 5 });
      await scheduler.captureNow("manual");
      expect((await queue.list())[0].state).toBe("queued");

      // The window lapses with a report already sitting in the queue.
      now = T0 + 25 * 60 * 60 * 1000;

      const result = await scheduler.tick();

      expect(transport.uploads).toEqual([]);
      expect(result.sent).toEqual([]);
      expect(result.skippedWindowClosed).toHaveLength(1);
      // Still visible and still deletable — it was captured, so hiding it would
      // be its own kind of dishonesty.
      expect((await queue.list())[0].state).toBe("queued");
    });

    it("sends nothing across many ticks", async () => {
      await access.grant({ durationId: "24h" });
      await scheduler.captureNow("manual");
      now = T0 + 40 * 60 * 60 * 1000;

      for (let i = 0; i < 10; i += 1) {
        now += 60 * 60 * 1000;
        await scheduler.tick();
      }
      expect(transport.uploads).toEqual([]);
    });

    it("refuses an explicit Send now", async () => {
      await access.grant({ durationId: "24h" });
      const meta = await scheduler.captureNow("manual");

      now = T0 + 25 * 60 * 60 * 1000;
      await expect(scheduler.sendNow(meta.id)).rejects.toThrow(
        /not active/i,
      );
      expect(transport.uploads).toEqual([]);
    });

    it("refuses to capture at all", async () => {
      await access.grant({ durationId: "24h" });
      now = T0 + 25 * 60 * 60 * 1000;
      await expect(scheduler.captureNow("manual")).rejects.toThrow(/not active/i);
      expect(await queue.list()).toEqual([]);
    });

    it("ignores an error trigger", async () => {
      await access.grant({ durationId: "24h" });
      now = T0 + 25 * 60 * 60 * 1000;
      await scheduler.notifyError();
      expect(transport.uploads).toEqual([]);
      expect(await queue.list()).toEqual([]);
    });

    it("sends nothing after the user revokes, even with a report queued", async () => {
      await access.grant({ durationId: "30d" });
      const meta = await scheduler.captureNow("manual");
      await access.revoke();

      const result = await scheduler.tick();
      expect(transport.uploads).toEqual([]);
      expect(result.skippedWindowClosed).toEqual([meta.id]);
      await expect(scheduler.sendNow(meta.id)).rejects.toThrow(/not active/i);
    });

    it("sends nothing when no grant was ever made", async () => {
      await scheduler.tick();
      await scheduler.notifyError();
      await scheduler.flush();
      expect(transport.uploads).toEqual([]);
    });

    it("stops at the boundary when the window closes mid-batch", async () => {
      await access.grant({ durationId: "24h" });
      await scheduler.captureNow("manual");
      now = T0 + 1000;
      await scheduler.captureNow("manual");
      now = T0 + 2000;
      await scheduler.captureNow("manual");
      expect(await queue.list()).toHaveLength(3);

      // The window lapses the instant the first upload completes. A guard
      // checked once per batch would let the other two through.
      transport.afterUpload = () => {
        now = T0 + 25 * 60 * 60 * 1000;
      };

      const result = await scheduler.flush();

      expect(transport.uploads).toHaveLength(1);
      expect(result.sent).toHaveLength(1);
      expect(result.skippedWindowClosed).toHaveLength(2);
    });

    it("closes the window and stops the timer on a tick that crosses the deadline", async () => {
      await access.grant({ durationId: "24h" });
      scheduler.start();
      now = T0 + 25 * 60 * 60 * 1000;

      await scheduler.tick();

      expect(access.getConsentRecord()?.endedReason).toBe("expired");
      expect(transport.uploads).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------
  // Error trigger
  // ---------------------------------------------------------------------
  it("captures and sends on error, then debounces a burst", async () => {
    await access.grant({ durationId: "7d" });

    await scheduler.notifyError();
    expect(transport.uploads).toHaveLength(1);
    expect(transport.uploads[0].meta.reason).toBe("error");

    // A crash loop must not become a fire hose.
    await scheduler.notifyError();
    await scheduler.notifyError();
    expect(transport.uploads).toHaveLength(1);

    now = T0 + 6 * 60 * 1000;
    await scheduler.notifyError();
    expect(transport.uploads).toHaveLength(2);
  });

  // ---------------------------------------------------------------------
  // Delete
  // ---------------------------------------------------------------------
  describe("delete", () => {
    const seedSent = async () => {
      await access.grant({ durationId: "7d" });
      await logStore.write("message-import", "chats-found", { n: 5 });
      await scheduler.tick();
      const listed = await queue.list();
      expect(listed[0].state).toBe("sent");
      return listed[0];
    };

    it("removes the local file and the server object", async () => {
      const meta = await seedSent();

      const result = await scheduler.deleteReport(meta.id);

      expect(result).toEqual({ deleted: true });
      expect(transport.deletes).toEqual([
        {
          ticketId: "ticket-1",
          attachmentId: "attachment-1",
          storagePath: meta.remote?.storagePath ?? "attachment-1",
        },
      ]);
      expect(await queue.getMeta(meta.id)).toBeNull();
      await expect(queue.readBody(meta.id)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await scheduler.listReports()).toEqual([]);
    });

    it("does NOT report success when the server delete fails, and keeps the local copy", async () => {
      const meta = await seedSent();
      transport.deleteError = new Error("offline");

      const result = await scheduler.deleteReport(meta.id);

      expect(result.deleted).toBe(false);
      expect(result.error).toBe("offline");
      expect(result.remoteRemains).toBe(true);

      // The row survives, so the user can retry. Removing it locally while a
      // copy sits in Keepr storage is the exact failure this guards.
      const after = await queue.getMeta(meta.id);
      expect(after).not.toBeNull();
      expect(after?.state).toBe("sent");
      expect(after?.lastError).toMatch(/offline/);
      await expect(queue.readBody(meta.id)).resolves.toBeInstanceOf(Buffer);
    });

    it("completes on retry once the server is reachable again", async () => {
      const meta = await seedSent();
      transport.deleteError = new Error("offline");
      expect((await scheduler.deleteReport(meta.id)).deleted).toBe(false);

      transport.deleteError = null;
      const retry = await scheduler.deleteReport(meta.id);

      expect(retry.deleted).toBe(true);
      expect(transport.deletes).toHaveLength(2);
      expect(await queue.getMeta(meta.id)).toBeNull();
    });

    it("does not call the server for a report that never left the machine", async () => {
      await access.grant({ durationId: "7d" });
      const meta = await scheduler.captureNow("manual");

      const result = await scheduler.deleteReport(meta.id);

      expect(result).toEqual({ deleted: true });
      expect(transport.deletes).toEqual([]);
      expect(await queue.getMeta(meta.id)).toBeNull();
    });

    it("still works after the window has closed", async () => {
      const meta = await seedSent();
      // Past the 7 day grant but well inside the 30 day server retention, so
      // the report is still there to be deleted.
      now = T0 + 8 * DAY;
      await scheduler.tick();
      expect(access.isActive()).toBe(false);
      expect(await queue.getMeta(meta.id)).not.toBeNull();

      // Deleting your own data is not an upload, so it is deliberately not
      // window-guarded. A user who let the grant lapse must still be able to
      // clear what was already sent.
      const result = await scheduler.deleteReport(meta.id);
      expect(result.deleted).toBe(true);
      expect(transport.deletes).toHaveLength(1);
    });

    it("treats an unknown id as already gone", async () => {
      const result = await scheduler.deleteReport("no-such-report");
      expect(result).toEqual({ deleted: true });
      expect(transport.deletes).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------
  // Failure handling
  // ---------------------------------------------------------------------
  it("records an upload failure on the report instead of losing it", async () => {
    await access.grant({ durationId: "7d" });
    transport.uploadError = new Error("bucket rejected the file");

    const result = await scheduler.tick();

    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].error).toMatch(/bucket rejected/);
    const listed = await scheduler.listReports();
    expect(listed[0].state).toBe("failed");
    expect(listed[0].lastError).toMatch(/bucket rejected/);
  });

  it("retries a failed report on the next tick", async () => {
    await access.grant({ durationId: "7d" });
    transport.uploadError = new Error("temporary");
    // tick() is what captures; flush() only sends what is already queued.
    await scheduler.tick();
    expect((await queue.list())[0].state).toBe("failed");

    transport.uploadError = null;
    now = T0 + 60_000;
    await scheduler.flush();

    const listed = await queue.list();
    expect(listed.every((r) => r.state === "sent")).toBe(true);
  });

  it("drops locally-held reports whose server retention has passed", async () => {
    await access.grant({ durationId: "30d" });
    await scheduler.tick();
    const sent = (await queue.list())[0];
    expect(sent.state).toBe("sent");

    now = T0 + 31 * DAY;
    await scheduler.tick();

    expect(await queue.getMeta(sent.id)).toBeNull();
    expect(await scheduler.listReports()).toEqual([]);
  });
});
