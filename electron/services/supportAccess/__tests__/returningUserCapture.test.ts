/** @jest-environment node */
/**
 * A returning user can capture a report (BACKLOG-2430)
 *
 * ## The bug this reproduces
 *
 * The founder granted support access, pressed "Capture a report now", and got:
 *
 *     ERROR [KeychainGate] Cannot encrypt - keychain access not yet allowed.
 *     ERROR [SupportAccessHandlers] Handler error: ...
 *
 * `keychainGate._unlocked` is a field on a module singleton, so it is
 * per-process: every launch starts locked. The only thing that ever called
 * `unlock()` was the onboarding secure-storage step, which a returning user
 * never sees again — so the gate stayed shut for the entire session, and
 * support access, its only consumer, could not seal anything. The encrypted
 * database kept working throughout because `databaseEncryptionService` imports
 * `safeStorage` directly and bypasses the gate, which is why nothing else
 * looked broken.
 *
 * ## Why this suite wires the real thing
 *
 * The existing support-access suites construct the cipher with `makeTestCipher`
 * — a stub with no gate behind it. That is the reason a locked-by-default
 * runtime state shipped: nothing exercised it. So everything here is
 * production code, assembled exactly as `supportAccess/index.ts` assembles it:
 * the real `keychainGate` singleton, the real keychain key provider, the real
 * AES-256-GCM cipher, the real log store and the real report queue.
 *
 * Only `safeStorage` is faked, because a unit test cannot own a macOS keychain.
 * It is faked as a *working* keychain — the point is that the gate refuses to
 * call it, not that the OS is unavailable.
 *
 * A "launch" here is `jest.resetModules()` plus a fresh dynamic import. That is
 * a faithful simulation: a new process is precisely what resets the singleton.
 */

import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import { gunzipSync } from "zlib";
import { SupportLogStore } from "../supportLogStore";
import { SupportReportQueue } from "../supportReportQueue";
import {
  createAesGcmCipher,
  createKeychainKeyProvider,
} from "../supportCipher";
import type { SupportCipher } from "../supportCipher";
import type { SupportConsentRecord } from "../types";

/**
 * A keychain that works. Prefixed rather than reversible-by-accident so a
 * plaintext leak cannot pass as a decrypt.
 */
const KEYCHAIN_PREFIX = "keychain-sealed:";

jest.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) =>
      Buffer.from(`${"keychain-sealed:"}${plaintext}`, "utf8"),
    decryptString: (sealed: Buffer) => {
      const text = sealed.toString("utf8");
      if (!text.startsWith("keychain-sealed:")) {
        throw new Error("Not sealed by this keychain");
      }
      return text.slice("keychain-sealed:".length);
    },
  },
}));

jest.mock("../../logService", () => ({
  __esModule: true,
  default: {
    info: jest.fn().mockResolvedValue(undefined),
    warn: jest.fn().mockResolvedValue(undefined),
    error: jest.fn().mockResolvedValue(undefined),
    debug: jest.fn().mockResolvedValue(undefined),
  },
}));

const T0 = Date.parse("2026-08-02T23:55:00.000Z");

const CONSENT: SupportConsentRecord = {
  id: "consent-returning-user",
  grantedAt: new Date(T0).toISOString(),
  expiresAt: new Date(T0 + 7 * 24 * 60 * 60 * 1000).toISOString(),
  durationId: "7d",
  appVersion: "2.27.0",
  disclosureId: "support-access-disclosure-v3",
  disclosureHash: "hash-not-under-test-here",
  disclosureText: "The wording that was shown.",
  scopes: ["message-import", "contact-resolution"],
};

/** The marker written into the scoped log, so the payload can be identified. */
const LOG_MARKER = "resolve-phone-names";

type KeychainGate = typeof import("../../keychainGate").default;

interface Launch {
  gate: KeychainGate;
  queue: SupportReportQueue;
  logStore: SupportLogStore;
  cipher: SupportCipher;
}

describe("support access on a returning user's Mac", () => {
  let baseDir: string;
  let now: number;

  beforeEach(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "keepr-support-return-"));
    now = T0;
  });

  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  /**
   * Start the app. A fresh module registry gives a fresh `keychainGate`
   * singleton — locked, exactly as a real launch leaves it — and the cipher is
   * then built around *that* instance, mirroring `supportAccess/index.ts`.
   */
  async function launch(): Promise<Launch> {
    jest.resetModules();
    // BACKLOG-2962: a fresh registry means a fresh, empty capability provider.
    // A real launch installs the shell's SecretStore; so does this one.
    require("../../../../tests/helpers/installTestSecretStore").installTestSecretStore();
    const gate = (await import("../../keychainGate")).default;

    const cipher = createAesGcmCipher(
      createKeychainKeyProvider({
        baseDir,
        isEncryptionAvailable: () => gate.isEncryptionAvailable(),
        sealString: (plaintext) => gate.encryptString(plaintext),
        openString: (sealed) => gate.decryptString(sealed),
      }),
    );

    const logStore = new SupportLogStore({
      now: () => now,
      baseDir,
      isScopeActive: () => true,
      currentConsentId: () => CONSENT.id,
      cipher,
    });

    const queue = new SupportReportQueue({
      now: () => now,
      baseDir,
      logStore,
      cipher,
      collectDiagnostics: async () => ({
        app_version: "2.27.0",
        db_initialized: true,
      }),
      getConsent: () => CONSENT,
    });

    return { gate, queue, logStore, cipher };
  }

  /** True once secure storage has been set up — the no-prompt file check. */
  async function secureStorageProvisioned(): Promise<boolean> {
    try {
      await fs.access(path.join(baseDir, "cipher-key.bin"));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * First run: the user passes the onboarding secure-storage step, which is the
   * one place `unlock()` is ever called. This is the only launch in which the
   * feature used to work.
   */
  async function completeOnboarding(): Promise<void> {
    const first = await launch();
    first.gate.unlock();
    await first.logStore.write("contact-resolution", LOG_MARKER, {
      attempted: 3,
      resolved: 2,
    });
    await first.queue.capture("manual");
    expect(await secureStorageProvisioned()).toBe(true);
  }

  it("starts every launch locked, which is what made this per-session", async () => {
    const { gate } = await launch();
    expect(gate.isUnlocked()).toBe(false);

    gate.unlock();
    expect(gate.isUnlocked()).toBe(true);

    // Quit and reopen. Nothing persists, which is the whole defect: the flag
    // lives in memory, so the app cannot remember that this was settled.
    const relaunched = await launch();
    expect(relaunched.gate.isUnlocked()).toBe(false);
  });

  /**
   * THE CONTROL — the founder's session, reproduced.
   *
   * Secure storage is provisioned, the grant is open, nobody is onboarding,
   * and the startup unlock is *not* performed. Capture must fail, and it must
   * fail with the message he saw.
   */
  it("fails to capture when the gate is left at its locked default", async () => {
    await completeOnboarding();

    const returning = await launch();
    expect(returning.gate.isUnlocked()).toBe(false);

    await expect(returning.queue.capture("manual")).rejects.toThrow(
      /keychain access not yet allowed/i,
    );

    // And the visible symptom: the list stays empty, so the UI would show a
    // healthy countdown over nothing at all.
    expect(await returning.queue.list()).toHaveLength(1); // only onboarding's
  });

  /**
   * THE FIX — same launch, with the startup unlock in place.
   */
  it("captures and seals a report when startup unlocks an already-provisioned gate", async () => {
    await completeOnboarding();

    const returning = await launch();
    expect(returning.gate.isUnlocked()).toBe(false);

    // What main.ts now does at startup. The key store is on disk, so the user
    // agreed to secure storage in an earlier session.
    const provisioned = await secureStorageProvisioned();
    expect(provisioned).toBe(true);
    expect(returning.gate.unlockIfProvisioned(() => provisioned)).toBe(true);

    await returning.logStore.write("contact-resolution", LOG_MARKER, {
      attempted: 9,
      resolved: 7,
    });
    const meta = await returning.queue.capture("manual");

    expect(meta.id).toBeTruthy();
    expect(meta.state).toBe("queued");
    expect(meta.byteSize).toBeGreaterThan(0);

    // Produced *and sealed*. Reading the body back goes through open(), so a
    // report that could not be decrypted would fail right here.
    const payload = JSON.parse(
      gunzipSync(await returning.queue.readBody(meta.id)).toString("utf8"),
    ) as { consent: { id: string }; logs: { text: string } };
    expect(payload.consent.id).toBe(CONSENT.id);
    expect(payload.logs.text).toContain(LOG_MARKER);

    // Sealed means sealed: the bytes on disk are not a gzip anyone can open,
    // which is the property the locked gate was protecting in the first place.
    const queueDir = path.join(baseDir, "queue");
    const payloadFile = (await fs.readdir(queueDir)).find(
      (name) => name.startsWith(meta.id) && name.endsWith(".enc"),
    );
    expect(payloadFile).toBeDefined();
    const onDisk = await fs.readFile(path.join(queueDir, payloadFile as string));
    expect(() => gunzipSync(onDisk)).toThrow();
    expect(onDisk.toString("utf8")).not.toContain(LOG_MARKER);
    expect(onDisk.toString("utf8")).not.toContain(KEYCHAIN_PREFIX);
  });

  /**
   * A user who never finished onboarding has no key store, so the startup
   * unlock must decline. Unlocking here would raise a keychain prompt nobody
   * asked for — the exact thing the gate exists to prevent.
   */
  it("does not unlock on a machine where secure storage was never set up", async () => {
    const fresh = await launch();

    expect(await secureStorageProvisioned()).toBe(false);
    expect(fresh.gate.unlockIfProvisioned(() => false)).toBe(false);
    expect(fresh.gate.isUnlocked()).toBe(false);

    await expect(fresh.queue.capture("manual")).rejects.toThrow(
      /keychain access not yet allowed/i,
    );
  });
});
