/**
 * iPhone backup passwords, held for the user (BACKLOG-3816 S4 / BACKLOG-3817).
 *
 * One entry per device UDID in `userData/backup-password-store.json`, each password wrapped
 * by the host SecretStore (macOS Keychain / Windows DPAPI via Electron safeStorage). The raw
 * password never touches disk and is never logged.
 *
 * An entry is either a password the user typed for a phone that already encrypts its
 * backups (origin "user", stored only after it unlocked a real backup), or one Keepr
 * generated to turn encryption on (origin "generated", stored BEFORE the phone is asked to
 * use it, so a crash in between cannot leave the phone locked with a password nobody has).
 *
 * ## Fail closed — the dataKeyService rules
 *
 * A store or entry that EXISTS but cannot be opened is never replaced. The phone keeps
 * using that password; a new one would not open its backups, and Keepr must never turn
 * encryption off to get out of it. Unreadable file, malformed JSON, an entry that will not
 * unwrap, secure storage unavailable — each throws {@link BackupPasswordUnavailableError}
 * and writes nothing. Only an ABSENT store, or an absent entry for that device, may be
 * written, and every write is read back and unwrapped before it counts.
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";

import type { SecretStore } from "../../capabilities/secretStore";
import { hostSecretStore } from "../../capabilities/secretStoreProvider";
import { hostAppPaths } from "../../capabilities/appPathsProvider";
import { hostLogger } from "../../capabilities/loggerProvider";
import { writeFileAtomic } from "./fileCrypto";

export const BACKUP_PASSWORD_STORE_FILENAME = "backup-password-store.json";
const STORE_VERSION = 1;
/** 24 random bytes → 32 base64url characters. */
const GENERATED_PASSWORD_BYTES = 24;
const UDID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

export type BackupPasswordOrigin = "user" | "generated";

/** A stored backup password exists but cannot be produced. Never replace it. */
export class BackupPasswordUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupPasswordUnavailableError";
  }
}

interface StoredEntry {
  wrapped: string;
  origin: BackupPasswordOrigin;
  createdAt: string;
}

interface StoreFile {
  version: number;
  devices: Record<string, StoredEntry>;
}

export type StoredBackupPassword =
  | { kind: "absent" }
  | { kind: "found"; password: string; origin: BackupPasswordOrigin };

export interface BackupPasswordStore {
  /** Throws BackupPasswordUnavailableError when an entry/store exists but cannot be opened. */
  get(udid: string): Promise<StoredBackupPassword>;
  /**
   * Store a password for a device that has none. Refuses (throws) when an entry already
   * exists for the device — readable or not — or the store cannot be read. Read-back verified.
   */
  put(udid: string, password: string, origin: BackupPasswordOrigin): Promise<void>;
  /**
   * Replace a READABLE entry whose password the caller has shown no longer opens the
   * phone's backup, with one the caller has shown does (the user changed it in Finder or
   * iTunes). An entry that cannot be unwrapped is never replaced — this throws instead.
   */
  replaceVerified(udid: string, password: string): Promise<void>;
  storePath(): string;
}

export interface BackupPasswordStoreDeps {
  baseDir: () => string;
  secretStore: SecretStore;
  log?: (level: "info" | "warn" | "error", message: string) => void;
}

/** A new random backup password. */
export function generateBackupPassword(): string {
  return crypto.randomBytes(GENERATED_PASSWORD_BYTES).toString("base64url");
}

function checkUdid(udid: string): string {
  if (!UDID_PATTERN.test(udid)) throw new Error("Invalid device identifier");
  return udid;
}

export function createBackupPasswordStore(deps: BackupPasswordStoreDeps): BackupPasswordStore {
  const storePath = () => path.join(deps.baseDir(), BACKUP_PASSWORD_STORE_FILENAME);
  let chain: Promise<unknown> = Promise.resolve();
  const serialise = <T>(work: () => Promise<T>): Promise<T> => {
    const run = chain.then(work, work);
    chain = run.catch(() => undefined);
    return run;
  };

  const requireSecureStorage = () => {
    let available = false;
    try {
      available = deps.secretStore.isEncryptionAvailable();
    } catch {
      available = false;
    }
    if (!available) {
      throw new BackupPasswordUnavailableError("Secure storage is unavailable, so the iPhone backup password cannot be opened or saved.");
    }
  };

  /** null = no store file. Throws when the file exists but is unusable. */
  const readStore = async (): Promise<StoreFile | null> => {
    let raw: Buffer;
    try {
      raw = await fs.promises.readFile(storePath());
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
      throw new BackupPasswordUnavailableError(`The iPhone backup password store could not be read: ${(error as NodeJS.ErrnoException)?.code ?? "error"}`);
    }
    let parsed: StoreFile;
    try {
      parsed = JSON.parse(raw.toString("utf8")) as StoreFile;
    } catch {
      throw new BackupPasswordUnavailableError("The iPhone backup password store is not valid JSON");
    }
    if (!parsed || parsed.version !== STORE_VERSION || typeof parsed.devices !== "object" || parsed.devices === null) {
      throw new BackupPasswordUnavailableError("The iPhone backup password store has an unknown shape");
    }
    return parsed;
  };

  const unwrap = (entry: StoredEntry): string => {
    if (!entry || typeof entry.wrapped !== "string") {
      throw new BackupPasswordUnavailableError("The saved iPhone backup password entry is malformed");
    }
    let password: string;
    try {
      password = deps.secretStore.decryptString(Buffer.from(entry.wrapped, "base64"));
    } catch {
      throw new BackupPasswordUnavailableError(
        "The saved iPhone backup password could not be unlocked by secure storage on this computer. It has NOT been replaced.",
      );
    }
    if (!password) throw new BackupPasswordUnavailableError("The saved iPhone backup password is empty");
    return password;
  };

  const write = async (
    udid: string,
    password: string,
    origin: BackupPasswordOrigin,
    mode: "create" | "replace",
  ): Promise<void> => {
    checkUdid(udid);
    if (!password) throw new Error("Refusing to store an empty backup password");
    requireSecureStorage();
    const store = (await readStore()) ?? { version: STORE_VERSION, devices: {} };
    const existing = store.devices[udid];
    if (mode === "create" && existing) {
      throw new BackupPasswordUnavailableError(
        "A backup password is already saved for this iPhone; it is never overwritten.",
      );
    }
    if (mode === "replace") {
      if (!existing) throw new BackupPasswordUnavailableError("No saved backup password to replace");
      // Throws when the old entry cannot be unwrapped: an unreadable entry is never replaced.
      unwrap(existing);
    }
    const wrapped = deps.secretStore.encryptString(password).toString("base64");
    store.devices[udid] = { wrapped, origin, createdAt: new Date().toISOString() };
    await writeFileAtomic(storePath(), JSON.stringify(store, null, 2));

    // Read back: the entry must unwrap to the same password before anyone relies on it.
    const reread = await readStore();
    const back = reread?.devices[udid];
    const opened = back ? unwrap(back) : "";
    const a = Buffer.from(opened);
    const b = Buffer.from(password);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      throw new BackupPasswordUnavailableError("The saved iPhone backup password did not survive a write/read round trip");
    }
    deps.log?.("info", `[BackupPassword] saved (${origin}, ${mode})`);
  };

  return {
    storePath,
    async get(udid) {
      checkUdid(udid);
      const store = await readStore();
      const entry = store?.devices[udid];
      if (!entry) return { kind: "absent" };
      requireSecureStorage();
      return { kind: "found", password: unwrap(entry), origin: entry.origin };
    },
    put(udid, password, origin) {
      return serialise(() => write(udid, password, origin, "create"));
    },
    replaceVerified(udid, password) {
      return serialise(() => write(udid, password, "user", "replace"));
    },
  };
}

let singleton: BackupPasswordStore | null = null;

export function getBackupPasswordStore(): BackupPasswordStore {
  if (!singleton) {
    singleton = createBackupPasswordStore({
      baseDir: () => hostAppPaths.userData(),
      secretStore: hostSecretStore,
      log: (level, message) => hostLogger[level](message),
    });
  }
  return singleton;
}
