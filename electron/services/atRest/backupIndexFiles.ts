/**
 * The kept iPhone backup's root plists at rest (BACKLOG-3816).
 *
 * Info.plist (phone number, IMEI, ICCID, serial number, installed apps), Status.plist
 * and Manifest.plist are sealed between syncs like every other file in a Keepr-managed
 * chain. Code that reads them OUTSIDE a sync (the backup status check, the backup list,
 * the encrypted-chain checks) reads its bytes as before and passes them through
 * {@link openBackupIndexBytes}: a sealed file is decrypted in memory, a plaintext one
 * (pre-2.40, during a sync, or an Apple-encrypted chain, which Keepr never seals) is
 * returned unchanged.
 *
 * Throws when the file is sealed and cannot be opened (key not held, tampered); every
 * caller already fails closed on a read error.
 */
import { getDataKeyService } from "./dataKeyService";
import { openContainerBytes, type KeyResolver } from "./fileCrypto";

/** The three device-metadata plists at the root of a backup chain. */
export const BACKUP_ROOT_PLISTS: readonly string[] = ["Info.plist", "Status.plist", "Manifest.plist"];

let keysForTests: KeyResolver | null = null;

export async function openBackupIndexBytes(raw: Buffer): Promise<Buffer> {
  return openContainerBytes(raw, keysForTests ?? getDataKeyService());
}

/** Test seam: the key resolver used instead of the app's key store. */
export function setBackupIndexKeysForTests(keys: KeyResolver | null): void {
  keysForTests = keys;
}
