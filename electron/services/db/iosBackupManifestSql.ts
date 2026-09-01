/**
 * SQL for reading an iOS backup's `Manifest.db` — BACKLOG-2989 (epic BACKLOG-2958).
 *
 * Moved out of `backupDecryptionService.decryptFile`. The rule that SQL text is
 * defined only under `electron/services/db/**` is BACKLOG-2959.
 *
 * ## This is NOT the Keepr schema, and that is the reason to name it clearly
 *
 * `Manifest.db` is Apple's index of an iPhone backup: one row per file in the
 * backup, keyed by `fileID` (the SHA-1 that also names the file on disk), with
 * `domain` + `relativePath` giving the file's logical location on the device
 * and `file` holding the serialised plist of its metadata — which is where the
 * per-file encryption key lives. It is a foreign schema this app reads, never
 * one it writes or migrates.
 *
 * Keeping the statement here, next to Keepr's own SQL, is deliberate: the rule
 * is about where SQL TEXT is defined, not about which database answers it.
 * `decryptFile` continues to execute it against the manifest connection it
 * opened, which the gate permits — executing declared SQL on a non-singleton
 * handle is allowed exactly where it is declared.
 *
 * The text is byte-identical to the statement this replaced, verified by
 * comparing the gate's own content hash (`62a2c5cc887c`) before and after.
 */

/**
 * One file's manifest row, by its `fileID` hash. One bound parameter.
 * Returns `{ fileID, domain, relativePath, file }`, where `file` is the raw
 * plist blob carrying the file's metadata and encryption key.
 */
export const MANIFEST_FILE_BY_ID_SQL =
  "SELECT fileID, domain, relativePath, file FROM Files WHERE fileID = ?";
