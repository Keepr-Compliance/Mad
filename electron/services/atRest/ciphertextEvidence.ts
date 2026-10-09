/**
 * Is there already ciphertext under this userData directory? (BACKLOG-3816 S0)
 *
 * Asked by dataKeyService on the ONE path that creates a key: the key store does
 * not exist. A missing store is normally a first launch. It can also be a store
 * that was deleted (by hand, by a partial reset) or lost to a power cut before its
 * directory entry reached disk. In those cases files sealed under the old key are
 * still on disk, and creating a new key would leave them unreadable with no error
 * anywhere. So before creating, look for evidence of ciphertext and refuse if any
 * is found.
 *
 * Evidence, cheapest first:
 *   1. `at-rest-state.json` records a scope as `migrating` or `done`.
 *   2. A backup marker in `Backups/.keepr-at-rest/` says `migrating`, `encrypted`
 *      or `syncing`.
 *   3. A structurally valid KEPRENC v1 container ({@link isStructurallyEncrypted}:
 *      full 60-byte header + a file size consistent with its chunk layout — NOT the
 *      7-byte magic, which any sender can put at the start of an attachment) on any
 *      file in the attachment scopes under userData: `message-attachments`,
 *      `attachments`, `rcs-cache-staging`, `logs`. A missing directory counts as
 *      empty. Nothing is created. No key is needed (there is no key store here).
 *
 * A state file or marker that exists but cannot be parsed counts as evidence: it
 * cannot rule ciphertext out, and the cost of a wrong "no" is every file lost.
 *
 * Not scanned: the iPhone backup trees under `Backups/<udid>` (hundreds of thousands
 * of files). Their at-rest state is recorded in the backup markers (item 2), which
 * live outside the backup tree for exactly this kind of question.
 *
 * Cost: the scan runs only when the store is missing, i.e. once per userData
 * directory on the launch that creates the key — which on an upgrade is a customer
 * with existing plaintext attachments. It stops at the first hit and reads at most
 * {@link MAX_FILES_SCANNED} files; past that it stops and reports no header evidence
 * (logged), so a very large attachment store cannot block key creation forever.
 */
import fs from "fs";
import path from "path";

import { isStructurallyEncrypted } from "./fileCrypto";

export const SCANNED_SCOPE_DIRS = ["message-attachments", "attachments", "rcs-cache-staging", "logs"] as const;
export const MAX_FILES_SCANNED = 200_000;

const STATE_FILE_NAME = "at-rest-state.json";
const MARKER_DIR = path.join("Backups", ".keepr-at-rest");
const ENCRYPTED_SCOPE_STATES = new Set(["migrating", "done"]);
const ENCRYPTED_BACKUP_STATES = new Set(["migrating", "encrypted", "syncing"]);

export interface CiphertextEvidenceOptions {
  maxFiles?: number;
  log?: (level: "info" | "warn" | "error", message: string) => void;
}

async function readJsonIfPresent(file: string): Promise<{ present: false } | { present: true; value: unknown }> {
  let raw: string;
  try {
    raw = await fs.promises.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { present: false };
    return { present: true, value: undefined };
  }
  try {
    return { present: true, value: JSON.parse(raw) as unknown };
  } catch {
    return { present: true, value: undefined };
  }
}

async function stateEvidence(userData: string): Promise<string | null> {
  const read = await readJsonIfPresent(path.join(userData, STATE_FILE_NAME));
  if (!read.present) return null;
  const parsed = read.value as { scopes?: Record<string, { state?: string }> } | undefined;
  if (!parsed || typeof parsed.scopes !== "object" || parsed.scopes === null) {
    return `${STATE_FILE_NAME} exists but cannot be read`;
  }
  for (const [scope, entry] of Object.entries(parsed.scopes)) {
    if (entry && ENCRYPTED_SCOPE_STATES.has(String(entry.state))) {
      return `${STATE_FILE_NAME} records scope "${scope}" as ${entry.state}`;
    }
  }
  return null;
}

async function markerEvidence(userData: string): Promise<string | null> {
  const dir = path.join(userData, MARKER_DIR);
  let names: string[];
  try {
    names = await fs.promises.readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    return `the backup marker directory exists but cannot be read`;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const read = await readJsonIfPresent(path.join(dir, name));
    if (!read.present) continue;
    const marker = read.value as { state?: string } | undefined;
    if (!marker || typeof marker.state !== "string") return `backup marker ${name} cannot be read`;
    if (ENCRYPTED_BACKUP_STATES.has(marker.state)) return `backup marker ${name} says ${marker.state}`;
  }
  return null;
}

async function looksEncrypted(file: string): Promise<boolean> {
  try {
    return await isStructurallyEncrypted(file);
  } catch {
    return false; // unreadable file: no evidence either way from its content
  }
}

async function headerEvidence(userData: string, opts: CiphertextEvidenceOptions): Promise<string | null> {
  const max = opts.maxFiles ?? MAX_FILES_SCANNED;
  let scanned = 0;
  const stack: string[] = SCANNED_SCOPE_DIRS.map((d) => path.join(userData, d));
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue; // missing or unreadable directory: nothing we can read is in it
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        if (scanned >= max) {
          opts.log?.("warn", `[AtRest] ciphertext scan stopped after ${max} files with no KEPRENC header found`);
          return null;
        }
        scanned++;
        if (await looksEncrypted(full)) {
          return `an encrypted file already exists under ${path.relative(userData, dir) || "."}`;
        }
      }
    }
  }
  return null;
}

/** A human-readable reason when ciphertext may already exist under `userData`, else null. */
export async function findCiphertextEvidence(
  userData: string,
  opts: CiphertextEvidenceOptions = {},
): Promise<string | null> {
  return (
    (await stateEvidence(userData)) ??
    (await markerEvidence(userData)) ??
    (await headerEvidence(userData, opts))
  );
}
