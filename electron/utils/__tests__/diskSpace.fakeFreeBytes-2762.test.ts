/**
 * @jest-environment node
 *
 * BACKLOG-2762 — the DEV-ONLY free-space override (`KEEPR_FAKE_FREE_BYTES`).
 *
 * WHAT THESE TESTS PROTECT
 * ========================
 *
 * The import space guard (BACKLOG-2743) only refuses when a disk is genuinely
 * too full — a state a healthy machine cannot produce on demand, which makes the
 * refusal copy, dialog and toggle states unreviewable by a human. The override
 * fakes the reported available bytes so that condition can be summoned in dev.
 *
 * A dev override that leaks into a shipped build, or whose effect is
 * indistinguishable from a real symptom, is worse than no override at all —
 * `KEEPR_E2E` blanks the contact list by design and burned a founder QA session
 * exactly that way. So three properties are pinned here, and each is written so
 * that removing the behaviour turns the assertion RED:
 *
 *   1. PACKAGED BUILDS IGNORE IT. Deleting `!app.isPackaged` from the gate must
 *      break "packaged build ignores the override" — mirrors the KEEPR_E2E
 *      gating tests in permissionHandlers.relaunch.test.ts.
 *   2. THE LOUD LINE FIRES ON EVERY READ. Asserted by CALL COUNT across two
 *      reads, not by presence: a cached/once-only log is the specific failure
 *      mode, and a presence-only assertion cannot see it.
 *   3. GARBAGE IS IGNORED, NOT PROPAGATED. A typo must never become `NaN` free
 *      bytes inside the guard's arithmetic.
 *
 * The fixture below keeps `bavail` and `bfree` DIFFERENT and both different from
 * the override, so a passing test can only be produced by the intended source —
 * an override read, a bavail read and a bfree read are three distinct numbers.
 */

import * as fs from "fs";
import { app } from "electron";

jest.mock("../../services/logService", () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

import logService from "../../services/logService";
import {
  getAvailableDiskBytes,
  evaluateAttachmentSpace,
  FAKE_FREE_BYTES_ENV_VAR,
  ATTACHMENT_SPACE_HEADROOM_BYTES,
} from "../diskSpace";

const warnMock = logService.warn as unknown as jest.Mock;

const GB = 1024 * 1024 * 1024;

/** The REAL number the mocked filesystem reports (bavail x bsize). */
const REAL_AVAILABLE_BYTES = 48 * GB;
/** The fake number the founder asks for. Distinct from every real figure here. */
const OVERRIDE_BYTES = 1 * GB;

function statfsFixture({ availGb, freeGb }: { availGb: number; freeGb: number }): fs.StatsFs {
  const bsize = 4096;
  return {
    type: 26,
    bsize,
    blocks: (500 * GB) / bsize,
    // bfree > bavail is the normal shape (superuser-reserved blocks). Keeping
    // them apart means this fixture can tell the two implementations apart.
    bfree: (freeGb * GB) / bsize,
    bavail: (availGb * GB) / bsize,
    files: 1000,
    ffree: 900,
  } as fs.StatsFs;
}

function mockRealDiskAt48Gb(): void {
  jest.spyOn(fs.promises, "statfs").mockResolvedValue(statfsFixture({ availGb: 48, freeGb: 60 }));
}

/** `app.isPackaged` is declared readonly on the Electron types; the Jest mock is
 *  a plain mutable object, and the gate reads it at CALL time. */
function setPackaged(value: boolean): void {
  (app as unknown as { isPackaged: boolean }).isPackaged = value;
}

/** Warn calls whose message announces an ACTIVE override. */
function inForceWarnings(): unknown[][] {
  return warnMock.mock.calls.filter(
    (call) => typeof call[0] === "string" && (call[0] as string).includes("in force")
  );
}

const ORIGINAL_ENV_VALUE = process.env[FAKE_FREE_BYTES_ENV_VAR];

describe("KEEPR_FAKE_FREE_BYTES — dev-only free-space override (BACKLOG-2762)", () => {
  beforeEach(() => {
    warnMock.mockClear();
    delete process.env[FAKE_FREE_BYTES_ENV_VAR];
    setPackaged(false);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    // restoreAllMocks does NOT undo a mutated plain property or an env var.
    setPackaged(false);
    delete process.env[FAKE_FREE_BYTES_ENV_VAR];
  });

  afterAll(() => {
    if (ORIGINAL_ENV_VALUE === undefined) delete process.env[FAKE_FREE_BYTES_ENV_VAR];
    else process.env[FAKE_FREE_BYTES_ENV_VAR] = ORIGINAL_ENV_VALUE;
  });

  // ==========================================================================
  // CONTROL 1 — both halves: override on, override off.
  // ==========================================================================
  describe("control 1 — the override is honoured in dev, and only while it is set", () => {
    it("dev build + override at 1 GB: the space read returns 1 GB, not the real 48 GB", async () => {
      mockRealDiskAt48Gb();
      process.env[FAKE_FREE_BYTES_ENV_VAR] = String(OVERRIDE_BYTES);

      const available = await getAvailableDiskBytes("/some/path");

      expect(available).toBe(OVERRIDE_BYTES);
      // Pin the failure modes explicitly: the real bavail figure and the bfree
      // figure are both distinct from the override, so neither can pass here.
      expect(available).not.toBe(REAL_AVAILABLE_BYTES);
      expect(available).not.toBe(60 * GB);
    });

    it("dev build + override at 1 GB: the GUARD then refuses an estimate that exceeds it", async () => {
      // This is the half a human needs on screen — the refusal itself, provoked
      // on a machine with plenty of room.
      mockRealDiskAt48Gb();
      process.env[FAKE_FREE_BYTES_ENV_VAR] = String(OVERRIDE_BYTES);

      const estimatedBytes = 5 * GB;
      const verdict = evaluateAttachmentSpace(
        estimatedBytes,
        await getAvailableDiskBytes("/some/path")
      );

      expect(verdict.fits).toBe(false);
      expect(verdict.availableBytes).toBe(OVERRIDE_BYTES);
      expect(verdict.shortfallBytes).toBe(
        estimatedBytes + ATTACHMENT_SPACE_HEADROOM_BYTES - OVERRIDE_BYTES
      );
      // Without the override the same estimate fits comfortably in 48 GB — so
      // this refusal is caused by the override and by nothing else.
      expect(evaluateAttachmentSpace(estimatedBytes, REAL_AVAILABLE_BYTES).fits).toBe(true);
    });

    it("override UNSET: the real measurement comes back, silently", async () => {
      mockRealDiskAt48Gb();
      delete process.env[FAKE_FREE_BYTES_ENV_VAR];

      expect(await getAvailableDiskBytes("/some/path")).toBe(REAL_AVAILABLE_BYTES);
      // The normal dev path must not warn at all, or the loud line stops being
      // loud — every run would carry it.
      expect(warnMock).not.toHaveBeenCalled();
    });

    it("an override of 0 is honoured — 'the disk is completely full' is a reviewable state", async () => {
      mockRealDiskAt48Gb();
      process.env[FAKE_FREE_BYTES_ENV_VAR] = "0";

      const available = await getAvailableDiskBytes("/some/path");

      expect(available).toBe(0);
      expect(available).not.toBeNull(); // 0 must not collapse into "unknown"/fail-open
      expect(evaluateAttachmentSpace(1, available).fits).toBe(false);
    });

    it("the override short-circuits the real read entirely (statfs is never called)", async () => {
      const statfsSpy = jest
        .spyOn(fs.promises, "statfs")
        .mockResolvedValue(statfsFixture({ availGb: 48, freeGb: 60 }));
      process.env[FAKE_FREE_BYTES_ENV_VAR] = String(OVERRIDE_BYTES);

      await getAvailableDiskBytes("/some/path");

      expect(statfsSpy).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // CONTROL 2 — the ship guard. Deleting `!app.isPackaged` must turn this RED.
  // ==========================================================================
  describe("control 2 — a packaged build ignores the env var unconditionally", () => {
    it("app.isPackaged === true + override set: the REAL number is returned", async () => {
      mockRealDiskAt48Gb();
      setPackaged(true);
      process.env[FAKE_FREE_BYTES_ENV_VAR] = String(OVERRIDE_BYTES);

      const available = await getAvailableDiskBytes("/some/path");

      expect(available).toBe(REAL_AVAILABLE_BYTES);
      expect(available).not.toBe(OVERRIDE_BYTES);
    });

    it("app.isPackaged === true: the override is not even announced", async () => {
      mockRealDiskAt48Gb();
      setPackaged(true);
      process.env[FAKE_FREE_BYTES_ENV_VAR] = String(OVERRIDE_BYTES);

      await getAvailableDiskBytes("/some/path");

      // A shipped build must not log about a flag it does not honour.
      expect(warnMock).not.toHaveBeenCalled();
    });

    it("the SAME env value that a packaged build ignores does take effect unpackaged", async () => {
      // Proves the previous two assertions are caused by isPackaged and not by a
      // value that would have been rejected anyway.
      mockRealDiskAt48Gb();
      process.env[FAKE_FREE_BYTES_ENV_VAR] = String(OVERRIDE_BYTES);

      setPackaged(true);
      expect(await getAvailableDiskBytes("/some/path")).toBe(REAL_AVAILABLE_BYTES);

      setPackaged(false);
      expect(await getAvailableDiskBytes("/some/path")).toBe(OVERRIDE_BYTES);
    });
  });

  // ==========================================================================
  // CONTROL 3 — the loud line, asserted by COUNT (a cached log is the failure).
  // ==========================================================================
  describe("control 3 — every overridden read announces itself", () => {
    it("two reads produce TWO 'in force' warnings (not one cached announcement)", async () => {
      mockRealDiskAt48Gb();
      process.env[FAKE_FREE_BYTES_ENV_VAR] = String(OVERRIDE_BYTES);

      await getAvailableDiskBytes("/some/path");
      await getAvailableDiskBytes("/some/other/path");

      expect(inForceWarnings()).toHaveLength(2);
      expect(warnMock).toHaveBeenCalledTimes(2);
    });

    it("the warning names the variable, the value, and that it is NOT real", async () => {
      mockRealDiskAt48Gb();
      process.env[FAKE_FREE_BYTES_ENV_VAR] = String(OVERRIDE_BYTES);

      await getAvailableDiskBytes("/some/path");

      const message = String(warnMock.mock.calls[0][0]);
      expect(message).toContain(FAKE_FREE_BYTES_ENV_VAR);
      expect(message).toContain(String(OVERRIDE_BYTES));
      expect(message).toContain("NOT a real");
    });
  });

  // ==========================================================================
  // CONTROL 4 — defensive parsing. A typo must not become NaN free bytes.
  // ==========================================================================
  describe("control 4 — unparseable values are ignored, with one warning", () => {
    it.each([
      ["non-numeric", "abc"],
      ["negative", "-5"],
      ["explicitly empty", ""],
      ["whitespace only", "   "],
      ["a value with units", "1GB"],
      ["overflowing to Infinity", "1e400"],
    ])("%s (%p): the REAL value is used and exactly one warning is emitted", async (_label, raw) => {
      mockRealDiskAt48Gb();
      process.env[FAKE_FREE_BYTES_ENV_VAR] = raw;

      const available = await getAvailableDiskBytes("/some/path");

      expect(available).toBe(REAL_AVAILABLE_BYTES);
      expect(Number.isFinite(available)).toBe(true); // never NaN into the guard
      expect(warnMock).toHaveBeenCalledTimes(1);
      // The rejection notice must NOT be the "in force" line — a garbage value
      // that announced itself as active would be the worst of both worlds.
      expect(inForceWarnings()).toHaveLength(0);
      expect(String(warnMock.mock.calls[0][0])).toContain("IGNORING");
    });

    it("a rejected value cannot make the guard refuse: NaN never reaches the arithmetic", async () => {
      mockRealDiskAt48Gb();
      process.env[FAKE_FREE_BYTES_ENV_VAR] = "abc";

      const verdict = evaluateAttachmentSpace(2 * GB, await getAvailableDiskBytes("/some/path"));

      // With NaN available bytes, `shortfall <= 0` is false and every import
      // would be refused while reporting an unreadable number.
      expect(verdict.fits).toBe(true);
      expect(verdict.availableBytes).toBe(REAL_AVAILABLE_BYTES);
    });

    it("surrounding whitespace on a valid number is tolerated", async () => {
      mockRealDiskAt48Gb();
      process.env[FAKE_FREE_BYTES_ENV_VAR] = ` ${OVERRIDE_BYTES} `;

      expect(await getAvailableDiskBytes("/some/path")).toBe(OVERRIDE_BYTES);
    });

    it("a rejected value still leaves the real read able to fail OPEN", async () => {
      jest
        .spyOn(fs.promises, "statfs")
        .mockRejectedValue(new Error("ENOTSUP: statfs not supported"));
      process.env[FAKE_FREE_BYTES_ENV_VAR] = "abc";

      expect(await getAvailableDiskBytes("/some/path")).toBeNull();
    });
  });
});
