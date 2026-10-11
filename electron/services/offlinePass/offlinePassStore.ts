/**
 * Offline pass store (BACKLOG-3675). Main process only.
 *
 * One pass at a time, in `<userData>/offline-pass.bin`, encrypted with the
 * OS-backed secret store (the same one the session tokens use). Nothing here
 * is reachable from the renderer: there is no IPC channel and no preload
 * method for the pass.
 *
 * Every method is non-throwing. Any failure reads as "no pass", which the
 * caller treats as not entitled (the normal paywall path):
 *   - encryption unavailable  → nothing is written; reads return null
 *   - decrypt / parse failure → the file is deleted; read returns null
 *
 * High-water mark: the largest wall-clock second the store has observed. A
 * read raises it to `max(highWater, now)`; storing a freshly verified pass
 * resets it to the pass's `iat` (server time), so one forward clock jump
 * cannot block every later pass.
 */

import { app } from "electron";
import { promises as fs } from "fs";
import path from "path";
import { hostSecretStore } from "../../capabilities/secretStoreProvider";
import logService from "../logService";

const MODULE = "OfflinePassStore";
export const OFFLINE_PASS_FILE_NAME = "offline-pass.bin";
/** Persist a raised high-water mark only when it moved this much. */
const HIGH_WATER_WRITE_STEP_SEC = 60;

export interface StoredOfflinePass {
  token: string;
  highWaterSec: number;
}

function passFilePath(): string {
  return path.join(app.getPath("userData"), OFFLINE_PASS_FILE_NAME);
}

function encryptionAvailable(): boolean {
  try {
    return hostSecretStore.isEncryptionAvailable() === true;
  } catch {
    return false;
  }
}

async function writeRecord(record: StoredOfflinePass): Promise<boolean> {
  if (!encryptionAvailable()) return false;
  const encrypted = hostSecretStore.encryptString(JSON.stringify(record));
  await fs.writeFile(passFilePath(), encrypted, { mode: 0o600 });
  return true;
}

function parseRecord(text: string): StoredOfflinePass | null {
  const value: unknown = JSON.parse(text);
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.token !== "string" || record.token.length === 0) return null;
  if (typeof record.highWaterSec !== "number" || !Number.isFinite(record.highWaterSec)) return null;
  return { token: record.token, highWaterSec: record.highWaterSec };
}

/** Remove the stored pass. Never throws. */
export async function deleteOfflinePass(): Promise<void> {
  try {
    await fs.rm(passFilePath(), { force: true });
  } catch (error) {
    logService.warn("[OfflinePass] Failed to delete stored pass", MODULE, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Store a pass that has ALREADY passed verification for the current user.
 * Resets the high-water mark to the pass's issue time. Never throws.
 * @returns true when the pass was written.
 */
export async function storeOfflinePass(token: string, iatSec: number): Promise<boolean> {
  try {
    return await writeRecord({ token, highWaterSec: iatSec });
  } catch (error) {
    logService.warn("[OfflinePass] Failed to store pass", MODULE, {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Read the stored pass and raise the high-water mark to `nowSec`.
 * @returns the pass and the (raised) high-water mark, or null. Never throws.
 */
export async function readOfflinePass(nowSec: number): Promise<StoredOfflinePass | null> {
  if (!encryptionAvailable()) return null;

  let encrypted: Buffer;
  try {
    encrypted = await fs.readFile(passFilePath());
  } catch {
    return null; // no file
  }

  let record: StoredOfflinePass | null = null;
  try {
    record = parseRecord(hostSecretStore.decryptString(encrypted));
  } catch {
    record = null;
  }
  if (!record) {
    logService.warn("[OfflinePass] Stored pass unreadable; deleting it", MODULE);
    await deleteOfflinePass();
    return null;
  }

  const raised = Math.max(record.highWaterSec, nowSec);
  if (raised - record.highWaterSec > HIGH_WATER_WRITE_STEP_SEC) {
    try {
      await writeRecord({ token: record.token, highWaterSec: raised });
    } catch {
      /* best-effort: the in-memory value below still applies to this read */
    }
  }
  return { token: record.token, highWaterSec: raised };
}
