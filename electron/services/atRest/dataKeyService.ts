/**
 * The file-data key for at-rest encryption (BACKLOG-3816 S0).
 *
 * One random 32-byte key, generated once per userData directory, stored in
 * `userData/data-key-store.json` wrapped by the host SecretStore (macOS Keychain /
 * Windows DPAPI via Electron safeStorage). The raw key never touches disk.
 *
 * ## Never regenerate
 *
 * A store that EXISTS but cannot be opened is not replaced. Every encrypted file on
 * disk is sealed under the key in that store; writing a new key would orphan all of
 * them, silently. So the only path that creates a key is "the store file does not
 * exist" (ENOENT). Unreadable file, malformed JSON, a key that will not unwrap, a
 * key of the wrong length, secure storage unavailable — every one of those throws
 * {@link DataKeyUnavailableError} and writes nothing. Writers then refuse to write
 * plaintext (fail closed) and the condition stays recoverable.
 *
 * This is the model in `supportAccess/supportCipher.ts`. It is deliberately NOT the
 * model in `databaseEncryptionService.getEncryptionKey`, which generates a new key
 * when unwrapping fails (BACKLOG-3824).
 *
 * ## What may be logged
 *
 * The keyId only — a 16-byte HMAC of the key, not the key. Never the key, never the
 * wrapped blob.
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";

import type { SecretStore } from "../../capabilities/secretStore";
import { hostSecretStore } from "../../capabilities/secretStoreProvider";
import { hostAppPaths } from "../../capabilities/appPathsProvider";
import { hostLogger } from "../../capabilities/loggerProvider";
import {
  DATA_KEY_BYTES,
  createFileCrypto,
  tmpPathFor,
  type AtRestKey,
  type FileCrypto,
  type KeyResolver,
} from "./fileCrypto";

export const DATA_KEY_STORE_FILENAME = "data-key-store.json";
const STORE_VERSION = 1;
const KEY_ID_LABEL = Buffer.from("keepr-at-rest/key-id/v1", "ascii");

/** The file-data key cannot be produced. Callers must fail closed — never fall back to plaintext. */
export class DataKeyUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DataKeyUnavailableError";
  }
}

interface StoredKey {
  keyId: string;
  /** base64 of SecretStore.encryptString(base64(key)) */
  wrapped: string;
  createdAt: string;
}

interface KeyStoreFile {
  version: number;
  current: StoredKey;
  /** Keys retired by a future rotation. Still needed to read files sealed under them. */
  previous: StoredKey[];
}

export interface DataKeyServiceDeps {
  baseDir: () => string;
  secretStore: SecretStore;
  log?: (level: "info" | "warn" | "error", message: string) => void;
}

export interface DataKeyService extends KeyResolver {
  /** Path of the store file, for reset/uninstall coverage (S7). */
  storePath(): string;
  /** Drop the in-memory copy (tests; account reset). */
  clearCache(): void;
}

export function keyIdFor(key: Buffer): string {
  return crypto.createHmac("sha256", key).update(KEY_ID_LABEL).digest().subarray(0, 16).toString("hex");
}

/** The store already exists — another writer won. The caller re-reads it. */
class StoreExistsError extends Error {}

async function createStoreExclusive(file: string, contents: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = tmpPathFor(file);
  try {
    const handle = await fs.promises.open(tmp, "wx", 0o600);
    try {
      await handle.writeFile(contents);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fs.promises.link(tmp, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "EEXIST") throw new StoreExistsError();
      throw new DataKeyUnavailableError(`Could not create the file-data key store: ${String(error)}`);
    }
  } finally {
    await fs.promises.unlink(tmp).catch(() => undefined);
  }
}

export function createDataKeyService(deps: DataKeyServiceDeps): DataKeyService {
  let cached: { current: AtRestKey; byId: Map<string, Buffer> } | null = null;
  let inFlight: Promise<{ current: AtRestKey; byId: Map<string, Buffer> }> | null = null;
  const storePath = () => path.join(deps.baseDir(), DATA_KEY_STORE_FILENAME);

  const unwrap = (entry: StoredKey, label: string): Buffer => {
    let opened: string;
    try {
      opened = deps.secretStore.decryptString(Buffer.from(entry.wrapped, "base64"));
    } catch (error) {
      throw new DataKeyUnavailableError(
        `The ${label} file-data key could not be unlocked by secure storage: ${String(error)}. ` +
          "It has NOT been replaced — encrypted files stay recoverable once secure storage works again.",
      );
    }
    const key = Buffer.from(opened, "base64");
    if (key.length !== DATA_KEY_BYTES) {
      throw new DataKeyUnavailableError(`The ${label} file-data key is malformed`);
    }
    if (keyIdFor(key) !== entry.keyId) {
      throw new DataKeyUnavailableError(`The ${label} file-data key does not match its key id`);
    }
    return key;
  };

  const resolve = async () => {
    let available = false;
    try {
      available = deps.secretStore.isEncryptionAvailable();
    } catch {
      available = false;
    }
    if (!available) {
      throw new DataKeyUnavailableError(
        "Secure storage is unavailable, so the file-data key cannot be opened or created.",
      );
    }

    const file = storePath();
    let raw: Buffer | null = null;
    try {
      raw = await fs.promises.readFile(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
        throw new DataKeyUnavailableError(`Could not read the file-data key store: ${String(error)}`);
      }
    }

    if (raw) {
      let parsed: KeyStoreFile;
      try {
        parsed = JSON.parse(raw.toString("utf8")) as KeyStoreFile;
      } catch {
        throw new DataKeyUnavailableError("The file-data key store is not valid JSON");
      }
      if (
        !parsed ||
        parsed.version !== STORE_VERSION ||
        !parsed.current ||
        typeof parsed.current.wrapped !== "string" ||
        typeof parsed.current.keyId !== "string"
      ) {
        throw new DataKeyUnavailableError("The file-data key store has an unknown shape");
      }
      const byId = new Map<string, Buffer>();
      const key = unwrap(parsed.current, "current");
      byId.set(parsed.current.keyId, key);
      for (const prev of Array.isArray(parsed.previous) ? parsed.previous : []) {
        try {
          byId.set(prev.keyId, unwrap(prev, "previous"));
        } catch (error) {
          // A previous key that will not open only affects files sealed under it;
          // keyFor() reports those individually.
          deps.log?.("warn", `[AtRest] previous data key ${prev.keyId} unavailable: ${String(error)}`);
        }
      }
      deps.log?.("info", `[AtRest] data key loaded (keyId ${parsed.current.keyId})`);
      return { current: { keyId: parsed.current.keyId, key }, byId };
    }

    // ENOENT — the only path that creates a key.
    const key = crypto.randomBytes(DATA_KEY_BYTES);
    const keyId = keyIdFor(key);
    const store: KeyStoreFile = {
      version: STORE_VERSION,
      current: {
        keyId,
        wrapped: deps.secretStore.encryptString(key.toString("base64")).toString("base64"),
        createdAt: new Date().toISOString(),
      },
      previous: [],
    };
    // Never overwrite: a rename would replace a store another process created a
    // moment ago, which is regeneration by another name. Link the fsynced temp
    // into place instead — link(2) fails with EEXIST rather than replacing.
    await createStoreExclusive(file, JSON.stringify(store, null, 2));

    let reread: KeyStoreFile;
    try {
      reread = JSON.parse((await fs.promises.readFile(file)).toString("utf8")) as KeyStoreFile;
    } catch (error) {
      throw new DataKeyUnavailableError(`The new file-data key store could not be read back: ${String(error)}`);
    }
    const verify = unwrap(reread.current, "new");
    if (verify.length !== key.length || !crypto.timingSafeEqual(verify, key)) {
      throw new DataKeyUnavailableError("The new file-data key did not survive a write/read round-trip");
    }
    deps.log?.("info", `[AtRest] data key created (keyId ${keyId})`);
    return { current: { keyId, key }, byId: new Map([[keyId, key]]) };
  };

  const resolveOnce = () =>
    resolve().catch((error) => {
      // Lost a creation race: the store now exists, so read it (never create).
      if (error instanceof StoreExistsError) return resolve();
      throw error;
    });

  const load = async () => {
    if (cached) return cached;
    if (!inFlight) {
      inFlight = resolveOnce()
        .then((value) => {
          cached = value;
          return value;
        })
        .finally(() => {
          inFlight = null;
        });
    }
    return inFlight;
  };

  return {
    async currentKey() {
      return (await load()).current;
    },
    async keyFor(keyId: string) {
      const key = (await load()).byId.get(keyId);
      if (!key) {
        throw new DataKeyUnavailableError(`No file-data key with id ${keyId} is held on this computer`);
      }
      return key;
    },
    storePath,
    clearCache() {
      cached = null;
    },
  };
}

// ---------------------------------------------------------------------------
// Process singletons — built lazily so nothing touches secure storage at import.
// ---------------------------------------------------------------------------

let dataKeyService: DataKeyService | null = null;
let atRestFiles: FileCrypto | null = null;

export function getDataKeyService(): DataKeyService {
  if (!dataKeyService) {
    dataKeyService = createDataKeyService({
      baseDir: () => hostAppPaths.userData(),
      secretStore: hostSecretStore,
      log: (level, message) => hostLogger[level](message),
    });
  }
  return dataKeyService;
}

/** The FileCrypto every writer and reader in the app uses. */
export function getAtRestFiles(): FileCrypto {
  if (!atRestFiles) atRestFiles = createFileCrypto(getDataKeyService());
  return atRestFiles;
}
