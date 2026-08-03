/** @jest-environment node */
/**
 * Support access window — expiry, restarts and consent (BACKLOG-2393)
 *
 * The interesting assertion in this file is the *restart*. A window that
 * silently resets on relaunch is the failure this design exists to prevent, so
 * "restart" is not simulated by resetting a variable — every restart test
 * constructs a brand new service instance against the same directory, exactly
 * as a relaunched app would. If expiry were held in a timer or in memory,
 * these tests would pass the in-process case and fail here.
 */

import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import { SupportAccessService } from "../supportAccessService";
import {
  SUPPORT_ACCESS_DURATIONS,
  DEFAULT_SUPPORT_ACCESS_DURATION,
  type SupportAccessDurationId,
} from "../types";
import {
  SUPPORT_ACCESS_DISCLOSURE_ID,
  SUPPORT_ACCESS_DISCLOSURE_TEXT,
  hashDisclosure,
} from "../disclosure";

const T0 = Date.parse("2026-08-02T09:00:00.000Z");

describe("SupportAccessService", () => {
  let baseDir: string;
  let now: number;

  const makeService = () =>
    new SupportAccessService({
      now: () => now,
      baseDir,
      appVersion: () => "2.27.0",
    });

  /** A fresh instance against the same directory — i.e. an app relaunch. */
  const restart = async (): Promise<SupportAccessService> => {
    const service = makeService();
    await service.load();
    return service;
  };

  beforeEach(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "keepr-support-access-"));
    now = T0;
  });

  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it("starts closed", async () => {
    const service = await restart();
    expect(service.isActive()).toBe(false);
    expect(service.getState().everGranted).toBe(false);
  });

  // ---------------------------------------------------------------------
  // Every offered duration, not just one.
  // ---------------------------------------------------------------------
  describe.each(SUPPORT_ACCESS_DURATIONS.map((d) => [d.id, d.ms, d.label]))(
    "a %s grant",
    (id, ms, label) => {
      const durationId = id as SupportAccessDurationId;
      const durationMs = ms as number;

      it(`stays open for exactly ${label}, survives restarts, and closes on wall-clock time`, async () => {
        const granting = await restart();
        const consent = await granting.grant({ durationId });

        expect(consent.expiresAt).toBe(new Date(T0 + durationMs).toISOString());
        expect(granting.isActive()).toBe(true);

        // One millisecond before the deadline, after a relaunch.
        now = T0 + durationMs - 1;
        const beforeExpiry = await restart();
        expect(beforeExpiry.isActive()).toBe(true);
        expect(beforeExpiry.msRemaining()).toBe(1);

        // Exactly at the deadline.
        now = T0 + durationMs;
        const atExpiry = await restart();
        expect(atExpiry.isActive()).toBe(false);
        expect(atExpiry.msRemaining()).toBe(0);

        // And well past it, with several relaunches in between — a window that
        // restarted itself on launch would read as open here.
        now = T0 + durationMs + 60_000;
        await restart();
        await restart();
        const wellAfter = await restart();
        expect(wellAfter.isActive()).toBe(false);
      });

      it(`does not extend itself across ${label} worth of relaunches`, async () => {
        const service = await restart();
        await service.grant({ durationId });

        // Relaunch once an hour for the whole window and one hour beyond it.
        for (let elapsed = 0; elapsed <= durationMs; elapsed += 3_600_000) {
          now = T0 + elapsed;
          const instance = await restart();
          expect(instance.isActive()).toBe(elapsed < durationMs);
        }
        now = T0 + durationMs + 3_600_000;
        expect((await restart()).isActive()).toBe(false);
      });
    },
  );

  it("closes a window that expired while the app was shut, and records why", async () => {
    const service = await restart();
    await service.grant({ durationId: "24h" });

    now = T0 + 25 * 60 * 60 * 1000;
    const afterRestart = await restart();
    expect(afterRestart.isActive()).toBe(false);

    const closed = await afterRestart.reconcile();
    expect(closed).toBe(true);
    expect(afterRestart.getConsentRecord()?.endedReason).toBe("expired");
    expect(afterRestart.getConsentRecord()?.endedAt).toBe(
      new Date(now).toISOString(),
    );

    // Idempotent: a second pass has nothing to do.
    expect(await afterRestart.reconcile()).toBe(false);
  });

  it("defaults to a 7 day window", () => {
    expect(DEFAULT_SUPPORT_ACCESS_DURATION).toBe("7d");
    const seven = SUPPORT_ACCESS_DURATIONS.find((d) => d.id === "7d");
    expect(seven?.ms).toBe(7 * 24 * 60 * 60 * 1000);
  });

  // ---------------------------------------------------------------------
  // Consent
  // ---------------------------------------------------------------------
  describe("the consent record", () => {
    it("is retrievable after a restart and names the wording that was shown", async () => {
      const service = await restart();
      await service.grant({ durationId: "14d" });

      const reloaded = await restart();
      const consent = reloaded.getConsentRecord();

      expect(consent).not.toBeNull();
      expect(consent?.disclosureId).toBe(SUPPORT_ACCESS_DISCLOSURE_ID);
      expect(consent?.disclosureText).toBe(SUPPORT_ACCESS_DISCLOSURE_TEXT);
      expect(consent?.disclosureHash).toBe(
        hashDisclosure(SUPPORT_ACCESS_DISCLOSURE_TEXT),
      );
      expect(consent?.appVersion).toBe("2.27.0");
      expect(consent?.grantedAt).toBe(new Date(T0).toISOString());
      expect(consent?.durationId).toBe("14d");
    });

    // -------------------------------------------------------------------
    // Consent attestation
    //
    // The record used to store whatever text the renderer sent, while a
    // comment claimed a mismatch "is caught here". Nothing compared anything,
    // so a screen showing different wording would have produced a consent
    // record attesting to wording nobody approved. With PII scrubbing
    // deferred, this record is the only safeguard in place.
    // -------------------------------------------------------------------
    it("refuses a grant whose displayed wording is not the shipped wording", async () => {
      const service = await restart();
      await expect(
        service.grant({
          durationId: "24h",
          disclosureText: "Some other wording that was on screen at the time.",
        }),
      ).rejects.toThrow(/does not match this version of Keepr/i);

      // Refused means refused: no window opened.
      expect(service.isActive()).toBe(false);
      expect((await restart()).getConsentRecord()).toBeNull();
    });

    it("refuses a grant that names a different disclosure id", async () => {
      const service = await restart();
      await expect(
        service.grant({
          durationId: "24h",
          disclosureId: "support-access-disclosure-v0",
          disclosureText: SUPPORT_ACCESS_DISCLOSURE_TEXT,
        }),
      ).rejects.toThrow(/different disclosure/i);
      expect(service.isActive()).toBe(false);
    });

    it("accepts — and records — the exact wording the renderer displayed", async () => {
      const service = await restart();
      await service.grant({
        durationId: "24h",
        disclosureId: SUPPORT_ACCESS_DISCLOSURE_ID,
        disclosureText: SUPPORT_ACCESS_DISCLOSURE_TEXT,
      });

      const consent = (await restart()).getConsentRecord();
      expect(consent?.disclosureText).toBe(SUPPORT_ACCESS_DISCLOSURE_TEXT);
      expect(consent?.disclosureHash).toBe(
        hashDisclosure(SUPPORT_ACCESS_DISCLOSURE_TEXT),
      );
      // A single byte of drift is enough to be refused, so the stored text and
      // the shipped text cannot silently differ.
      await expect(
        service.grant({
          durationId: "24h",
          disclosureText: `${SUPPORT_ACCESS_DISCLOSURE_TEXT} `,
        }),
      ).rejects.toThrow(/does not match/i);
    });

    it("stays retrievable by id after its window has closed", async () => {
      const service = await restart();
      const consent = await service.grant({ durationId: "24h" });

      now = T0 + 8 * 24 * 60 * 60 * 1000;
      const later = await restart();
      await later.reconcile();
      // Supersede it, pushing the original into history.
      await later.grant({ durationId: "7d" });

      const found = later.findConsent(consent.id);
      expect(found?.id).toBe(consent.id);
      expect(found?.disclosureText).toBe(SUPPORT_ACCESS_DISCLOSURE_TEXT);
    });

    it("notifies end listeners on expiry, not only on revoke", async () => {
      // The asymmetry this covers: revoke cleared the scoped log and expiry did
      // not, so a lapsed window left its contacts on disk for the next grant to
      // sweep up. Both paths now run the same cleanup.
      const seen: string[] = [];
      const service = await restart();
      service.onEnd((reason) => {
        seen.push(reason);
      });

      await service.grant({ durationId: "24h" });
      now = T0 + 25 * 60 * 60 * 1000;
      expect(await service.reconcile()).toBe(true);
      expect(seen).toEqual(["expired"]);

      // And the revoke path still fires it, so this replaced the old behaviour
      // rather than moving the gap somewhere else.
      now = T0 + 26 * 60 * 60 * 1000;
      await service.grant({ durationId: "24h" });
      await service.revoke();
      expect(seen).toEqual(["expired", "revoked"]);
    });

    it("finishes end listeners before the window reads as closed", async () => {
      const service = await restart();
      let cleanupDone = false;
      service.onEnd(async () => {
        await new Promise((r) => setTimeout(r, 5));
        cleanupDone = true;
      });

      await service.grant({ durationId: "24h" });
      now = T0 + 25 * 60 * 60 * 1000;
      await service.reconcile();
      expect(cleanupDone).toBe(true);
    });

    it("refuses a grant with nothing to collect", async () => {
      const service = await restart();
      await expect(
        service.grant({ durationId: "7d", scopes: [] }),
      ).rejects.toThrow(/at least one logging scope/i);
      expect(service.isActive()).toBe(false);
    });

    it("drops scopes it does not recognise", async () => {
      const service = await restart();
      const consent = await service.grant({
        durationId: "7d",
        scopes: ["email-sync", "not-a-real-scope"] as never,
      });
      expect(consent.scopes).toEqual(["email-sync"]);
      expect(service.isScopeActive("email-sync")).toBe(true);
      expect(service.isScopeActive("message-import")).toBe(false);
    });
  });

  // ---------------------------------------------------------------------
  // Revocation and supersession
  // ---------------------------------------------------------------------
  it("closes immediately on revoke, and stays closed across a restart", async () => {
    const service = await restart();
    await service.grant({ durationId: "30d" });
    expect(service.isActive()).toBe(true);

    now = T0 + 60_000;
    await service.revoke();
    expect(service.isActive()).toBe(false);
    expect(service.getConsentRecord()?.endedReason).toBe("revoked");

    now = T0 + 120_000;
    expect((await restart()).isActive()).toBe(false);
  });

  it("supersedes an open window rather than stacking two", async () => {
    const service = await restart();
    const first = await service.grant({ durationId: "24h" });

    now = T0 + 3_600_000;
    const second = await service.grant({ durationId: "30d" });

    const reloaded = await restart();
    expect(reloaded.getConsentRecord()?.id).toBe(second.id);
    expect(reloaded.getConsentHistory().map((c) => c.id)).toContain(first.id);
    expect(reloaded.findConsent(first.id)?.endedReason).toBe("revoked");
    // The new deadline is measured from the new grant, not the old one.
    expect(reloaded.getConsentRecord()?.expiresAt).toBe(
      new Date(T0 + 3_600_000 + 30 * 24 * 60 * 60 * 1000).toISOString(),
    );
  });

  // ---------------------------------------------------------------------
  // Failing closed
  // ---------------------------------------------------------------------
  it("fails closed when the state file is corrupt", async () => {
    const service = await restart();
    await service.grant({ durationId: "30d" });

    await fs.writeFile(path.join(baseDir, "state.json"), "{ not json", "utf8");

    const reloaded = await restart();
    expect(reloaded.isActive()).toBe(false);
    expect(reloaded.getConsentRecord()).toBeNull();
  });

  it("fails closed when a persisted grant has an unusable deadline", async () => {
    const service = await restart();
    await service.grant({ durationId: "30d" });

    const statePath = path.join(baseDir, "state.json");
    const state = JSON.parse(await fs.readFile(statePath, "utf8"));
    state.current.expiresAt = "not-a-date";
    await fs.writeFile(statePath, JSON.stringify(state), "utf8");

    expect((await restart()).isActive()).toBe(false);
  });

  it("notifies listeners when the window opens and closes", async () => {
    const service = await restart();
    const seen: boolean[] = [];
    service.onChange((state) => seen.push(state.active));

    await service.grant({ durationId: "24h" });
    now = T0 + 25 * 60 * 60 * 1000;
    await service.reconcile();

    expect(seen).toEqual([true, false]);
  });
});
