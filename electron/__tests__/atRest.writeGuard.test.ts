/**
 * @jest-environment node
 */
/**
 * At-rest durability guard + sister reader guard (BACKLOG-3816 S0).
 *
 * WRITER GUARD. Every call in `electron/` to a file-writing API is counted, per
 * file, by walking the TypeScript AST (never shell grep: one raw NUL byte makes a
 * file invisible to grep — BACKLOG-2637). Each file that writes must appear in
 * WRITER_ALLOWLIST with its EXACT count and a reason. So:
 *
 *   - a new writer in an unlisted file             -> red ("not in the allowlist")
 *   - one more writer in a listed file             -> red ("count went up")
 *   - a writer removed or converted to atRest/*    -> red ("count went down") —
 *                                                     lower the entry, so the list
 *                                                     never carries a stale allowance
 *
 * `electron/services/atRest/**` is exempt: that is where encrypted writes live.
 * Converting a writer means routing it through `getAtRestFiles()` and lowering or
 * deleting its entry here.
 *
 * READER GUARD. Every file that names `storage_path` / `storagePath` and also calls
 * a raw read API (or builds a `file://` URL) is counted the same way against
 * READER_ALLOWLIST. Once attachments are encrypted (S1/S3), those raw reads hand
 * ciphertext to whoever consumes them; S2 converts them to openDecryptStream /
 * readAllDecrypted / decryptToFile and lowers the entries.
 *
 * ## What this does NOT see (measured limits, not assumptions)
 *
 *   - Low-level writes: `fs.write`, `fs.writeSync`, `fileHandle.write`, `writev`,
 *     `fs.open(..., "w")`. They are not in the API set. `handle.writeFile` IS seen.
 *   - Custom wrappers whose method name is not in the set (e.g. `fs.copyDir` in
 *     rcsExtensionDelivery) — only the wrapper's own body is counted.
 *   - Writers outside `electron/` and child processes (idevicebackup2, shell-outs).
 *   - Readers that receive a stored path under another name: the reader guard only
 *     sees files that name `storage_path`/`storagePath` themselves. It is a
 *     tripwire, not a proof of coverage; S2's own reader tests are the proof.
 *   - The renderer (`src/`) — file:// use there is S2's scope.
 */
import fs from "fs";
import path from "path";
import ts from "typescript";

const REPO = path.resolve(__dirname, "..", "..");
const SCAN_ROOT = path.join(REPO, "electron");
const EXEMPT_PREFIX = "electron/services/atRest/";

const WRITE_APIS = new Set([
  "writeFile",
  "writeFileSync",
  "appendFile",
  "appendFileSync",
  "copyFile",
  "copyFileSync",
  "createWriteStream",
  "cp",
  "cpSync",
  "rename",
  "renameSync",
]);

const READ_APIS = new Set([
  "readFile",
  "readFileSync",
  "createReadStream",
  "copyFile",
  "copyFileSync",
  "cp",
  "cpSync",
  "openPath",
  "pathToFileURL",
]);

type Entry = { count: number; reason: string };

const S1 = "PENDING S1 — writes plaintext customer content under userData; S1 routes it through atRest";
const EXPORT = "user-initiated export to a destination the user chose; plaintext by intent";
const SEALED = "content is already sealed (SecretStore / AES-GCM) before it is written";
const META = "small cache/state file with no customer content";
const SQLCIPHER = "copies/moves the SQLCipher-encrypted database file (ciphertext)";

/**
 * Raw writers that are allowed today. Count = number of write calls in the file.
 * Measured at int-portal/release-2.40 @ 0d1dcf87c.
 */
const WRITER_ALLOWLIST: Record<string, Entry> = {
  // --- plaintext customer content, converted by later slices -------------------
  "electron/services/iPhoneSyncStorageService.ts": { count: 1, reason: `${S1} (iPhone message attachments)` },
  "electron/services/macOSMessagesImportService/macOSMessagesImportService.ts": { count: 1, reason: `${S1} (macOS Messages attachments)` },
  "electron/services/emailAttachmentService.ts": { count: 1, reason: `${S1} (email attachments, D2)` },
  "electron/services/rcsImportMedia.ts": { count: 1, reason: `${S1} (RCS media via injected writeFile)` },
  "electron/handlers/rcsImportHandlers.ts": { count: 6, reason: `${S1} (RCS writeFile/rename/copyFile deps for media + staging)` },
  "electron/services/rcsCacheStaging.ts": { count: 1, reason: `${S1} (RCS staged media temp)` },
  "electron/services/backupService.ts": { count: 1, reason: "S4/BACKLOG-3816 — fs.rename of an unencrypted iPhone backup folder aside (Backups/.keepr-replaced-*) until the encrypted chain verifies; moves, never writes content" },
  "electron/services/backupDecryptionService.ts": { count: 2, reason: "S4/BACKLOG-3817 — parse copies of an encrypted iPhone backup, only under userData/at-rest-tmp/ios-<runId>, removed after persistence and swept at launch" },
  "electron/services/logService.ts": { count: 2, reason: "PENDING S5 — app log file (redaction + retention, BACKLOG-3819)" },
  "electron/outlookService.ts": { count: 1, reason: "MSAL token cache on the legacy Outlook path; design cut line 2.40.1 (dead MSAL path)" },
  // --- exports the user asked for -----------------------------------------------
  "electron/services/folderExport/folderExportService.ts": { count: 10, reason: `${EXPORT}; 2 calls are print-to-PDF temp HTML in os.tmpdir (S6 temp sweep)` },
  "electron/services/folderExport/attachmentHelpers.ts": { count: 1, reason: `${EXPORT} (copies attachments out — S2 makes this decryptToFile)` },
  "electron/services/enhancedExportService.ts": { count: 5, reason: EXPORT },
  "electron/services/pdfExportService.ts": { count: 2, reason: `${EXPORT}; 1 call is print-to-PDF temp HTML in os.tmpdir (S6 temp sweep)` },
  "electron/services/ccpaExportService.ts": { count: 1, reason: `${EXPORT} (CCPA data export)` },
  // --- database file management ---------------------------------------------------
  "electron/services/databaseService.ts": {
    count: 6,
    reason:
      `${SQLCIPHER} — 3 calls (restore from backup, pre-schema-migration backup, pre-junction-backfill snapshot). The other 3 are the one-time ` +
      "plaintext→SQLCipher migration (_migrateToEncryptedDatabase): one copies the PRE-ENCRYPTION PLAINTEXT " +
      "database to `.backup`, one moves the newly built SQLCipher file into place, one restores the plaintext " +
      "`.backup` if the migration fails. Allowed as a legacy path: it runs only on a database that is still " +
      "plaintext, and the plaintext `.backup` is deleted once the migration succeeds",
  },
  "electron/services/sqliteBackupService.ts": { count: 4, reason: SQLCIPHER },
  "electron/services/databaseEncryptionService.ts": { count: 2, reason: `${SEALED} (DB key store)` },
  // --- already sealed ---------------------------------------------------------------
  "electron/services/sessionService.ts": { count: 1, reason: `${SEALED} (session file via encryptSessionData)` },
  "electron/services/offlinePass/offlinePassStore.ts": { count: 1, reason: SEALED },
  "electron/services/supportAccess/supportCipher.ts": { count: 2, reason: `${SEALED} (wrapped support key, tmp+rename)` },
  "electron/services/supportAccess/supportLogStore.ts": { count: 2, reason: `${SEALED} (framed sealed records + rotation rename)` },
  "electron/services/supportAccess/supportReportQueue.ts": { count: 3, reason: `${SEALED} (sealed payload) + meta JSON with no content` },
  "electron/services/supportAccess/supportAccessService.ts": { count: 2, reason: `${META} (support consent state, tmp+rename)` },
  "electron/services/supportAccess/supabaseSupportTransport.ts": { count: 2, reason: `${META} (ticket id map, tmp+rename)` },
  // --- metadata caches --------------------------------------------------------------
  "electron/services/checklistTemplateService.ts": { count: 1, reason: `${META} (checklist template cache)` },
  "electron/services/featureGateService.ts": { count: 1, reason: `${META} (feature flag cache)` },
  "electron/services/licenseService.ts": { count: 1, reason: `${META} (license status cache)` },
  "electron/services/crashReportingPreference.ts": { count: 1, reason: `${META} (crash reporting on/off)` },
  // --- not under userData -------------------------------------------------------------
  "electron/services/appCleanupService.ts": { count: 1, reason: "uninstall helper script in the temp dir; no customer content" },
  "electron/services/appleDriverService.ts": { count: 2, reason: "Apple driver installer copy/download in the temp dir; no customer content" },
  "electron/services/rcsExtensionDelivery.ts": { count: 3, reason: "installs the bundled Chrome extension folder; no customer content" },
};

const S2 = "PENDING S2 — raw read of a stored attachment path; S2 converts to the atRest readers";

/** Raw readers in files that name storage_path/storagePath. Count = read calls + file:// literals. */
const READER_ALLOWLIST: Record<string, Entry> = {
  "electron/handlers/attachmentHandlers.ts": { count: 3, reason: `${S2} (preview/open/data-URL handlers)` },
  "electron/services/attachmentTextExtractionService.ts": { count: 1, reason: `${S2} (text extraction)` },
  "electron/services/databaseService.ts": { count: 5, reason: `${S2} where it reads attachments; other reads are DB/key files` },
  "electron/services/folderExport/attachmentHelpers.ts": { count: 1, reason: `${S2} (export copy)` },
  "electron/services/folderExport/folderExportService.ts": { count: 1, reason: `${S2} (export copy)` },
  "electron/services/folderExport/textExportHelpers.ts": { count: 2, reason: `${S2} (inline images in text export)` },
  "electron/services/iPhoneSyncStorageService.ts": { count: 2, reason: "reads the SOURCE file in the iPhone backup to hash/copy it; S1 hashes plaintext during encrypt" },
  "electron/services/macOSMessagesImportService/macOSMessagesImportService.ts": { count: 2, reason: "reads the SOURCE file in ~/Library/Messages to hash/copy it; S1 scope" },
  "electron/services/supabaseStorageService.ts": { count: 1, reason: `${S2} (broker upload)` },
  "electron/services/supportAccess/supabaseSupportTransport.ts": { count: 1, reason: "reads its own ticket map, not an attachment" },
};

function listSources(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      listSources(p, out);
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$|\.d\.ts$/.test(entry.name)) {
      out.push(p);
    }
  }
  return out;
}

function calleeName(expr: ts.Expression): string | null {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  if (ts.isElementAccessExpression(expr) && ts.isStringLiteralLike(expr.argumentExpression)) {
    return expr.argumentExpression.text;
  }
  return null;
}

function scanSource(text: string, fileName = "x.ts") {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  let writes = 0;
  let reads = 0;
  let namesStoragePath = false;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node.expression);
      if (name && WRITE_APIS.has(name)) writes++;
      if (name && READ_APIS.has(name)) reads++;
    }
    if (ts.isIdentifier(node) && (node.text === "storage_path" || node.text === "storagePath")) {
      namesStoragePath = true;
    }
    if (
      (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) &&
      node.text.includes("file://")
    ) {
      reads++;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { writes, reads, namesStoragePath };
}

function inventory() {
  const writers: Record<string, number> = {};
  const readers: Record<string, number> = {};
  const files = listSources(SCAN_ROOT);
  for (const abs of files) {
    const rel = path.relative(REPO, abs).split(path.sep).join("/");
    if (rel.startsWith(EXEMPT_PREFIX)) continue;
    // utf8 decode never drops a file; the TS scanner treats a NUL as a character.
    const { writes, reads, namesStoragePath } = scanSource(fs.readFileSync(abs, "utf8"), abs);
    if (writes > 0) writers[rel] = writes;
    if (namesStoragePath && reads > 0) readers[rel] = reads;
  }
  return { writers, readers, scanned: files.length };
}

function diff(found: Record<string, number>, allow: Record<string, Entry>): string[] {
  const problems: string[] = [];
  for (const [file, count] of Object.entries(found)) {
    const entry = allow[file];
    if (!entry) problems.push(`${file}: ${count} raw call(s), not in the allowlist`);
    else if (count > entry.count) problems.push(`${file}: count went up ${entry.count} -> ${count}`);
    else if (count < entry.count) problems.push(`${file}: count went down ${entry.count} -> ${count} — lower the entry`);
  }
  for (const file of Object.keys(allow)) {
    if (!(file in found)) problems.push(`${file}: allowlisted but has no raw calls now — delete the entry`);
  }
  return problems;
}

const inv = inventory();

describe("at-rest durability guard (BACKLOG-3816)", () => {
  it("scans the whole main-process tree", () => {
    expect(inv.scanned).toBeGreaterThan(300);
  });

  it("every allowlist entry carries a reason", () => {
    for (const [file, entry] of [...Object.entries(WRITER_ALLOWLIST), ...Object.entries(READER_ALLOWLIST)]) {
      expect({ file, ok: entry.reason.trim().length > 10 && entry.count > 0 }).toEqual({ file, ok: true });
    }
  });

  it("no raw file writer outside atRest/ beyond the allowlist", () => {
    expect(diff(inv.writers, WRITER_ALLOWLIST)).toEqual([]);
  });

  it("no raw reader of a stored attachment path beyond the allowlist", () => {
    expect(diff(inv.readers, READER_ALLOWLIST)).toEqual([]);
  });

  describe("the scanner can see what it claims to (positive controls)", () => {
    it.each([
      ["fs.writeFile(p, d)", 1],
      ["fs.promises\n  .copyFile(a, b)", 1],
      ['fs["appendFileSync"](p, d)', 1],
      ["await handle.writeFile(d)", 1],
      ["// fs.writeFile(p, d)\nconst s = 'fs.writeFile(p)';", 0],
      ["interface X { writeFile(p: string): void }", 0],
      ["const x = '\\u0000'; fs.createWriteStream(p)", 1],
    ])("%s -> %i write(s)", (src, n) => {
      expect(scanSource(src as string).writes).toBe(n);
    });

    it("a NUL byte in the source does not hide a writer", () => {
      expect(scanSource(`const a = "${String.fromCharCode(0)}";\nfs.writeFileSync(p, d);`).writes).toBe(1);
    });

    it("reader detection needs a storage_path name and counts file:// literals", () => {
      expect(scanSource("fs.readFileSync(att.storage_path)")).toMatchObject({ reads: 1, namesStoragePath: true });
      expect(scanSource("const u = `file://${storagePath}`")).toMatchObject({ reads: 1, namesStoragePath: true });
      expect(scanSource("fs.readFileSync(p)").namesStoragePath).toBe(false);
    });
  });
});
