/**
 * The one read path for stored attachment files (BACKLOG-3816 S2).
 *
 * Every attachment reader (preview, DOCX buffer, open-with-system-viewer, export,
 * text extraction, broker upload) goes through here instead of `fs.readFile` /
 * `fs.copyFile`, so an encrypted (KEPRENC) file is decrypted on read.
 *
 * Phase switch. While a scope is migrating, its folder holds both plaintext
 * (not yet sealed) and ciphertext files, so readers pass plaintext through. Once
 * S3's migration records the scope as `done` in `at-rest-state.json`, every file
 * in it must be ciphertext and a plaintext file is refused (requireEncrypted) —
 * a plaintext file appearing after `done` is a writer bug or a planted file.
 *
 * Scope keys S3 MUST write (see containment.ATTACHMENT_ROOTS):
 *   "message-attachments"  → userData/message-attachments
 *   "email-attachments"    → userData/attachments
 * They deliberately differ from the startup job id "attachments", so a naming
 * mismatch fails OPEN (plaintext still accepted), never closed.
 */
import fs from "fs";
import path from "path";

import { hostAppPaths } from "../../capabilities/appPathsProvider";
import { getAtRestFiles } from "./dataKeyService";
import type { FileCrypto } from "./fileCrypto";
import { getMarkerStore, type MarkerStore } from "./markers";
import {
  ATTACHMENT_ROOTS,
  isInside,
  resolveContainedAttachment,
  type AttachmentScope,
  type ResolvedAttachment,
} from "./containment";

interface ReaderDeps {
  files: () => FileCrypto;
  markers: () => MarkerStore;
  userData: () => string;
}

const defaultDeps: ReaderDeps = {
  files: () => getAtRestFiles(),
  markers: () => getMarkerStore(),
  userData: () => hostAppPaths.userData(),
};

let deps: ReaderDeps = defaultDeps;

/** Tests only. Pass `null` to restore the real dependencies. */
export function setAttachmentReaderDepsForTests(next: Partial<ReaderDeps> | null): void {
  deps = next ? { ...defaultDeps, ...next } : defaultDeps;
}

export function attachmentUserData(): string {
  return deps.userData();
}

/** true once S3 has recorded the scope as fully migrated. A malformed state file throws. */
export async function scopeRequiresEncryption(scope: AttachmentScope): Promise<boolean> {
  const entry = await deps.markers().getScope(scope);
  return entry?.state === "done";
}

/**
 * The scope a DB-stored path lies in, without requiring that it exist inside one
 * (DB rows may hold legacy paths). Lexical check after path.resolve; realpath is
 * attempted so a link inside a root is judged by its target.
 */
async function scopeOf(storedPath: string): Promise<AttachmentScope | null> {
  const userData = deps.userData();
  let real = path.resolve(storedPath);
  try {
    real = await fs.promises.realpath(storedPath);
  } catch {
    /* missing file: the read below reports it */
  }
  for (const root of ATTACHMENT_ROOTS) {
    let realRoot = path.join(userData, root.dir);
    try {
      realRoot = await fs.promises.realpath(realRoot);
    } catch {
      /* root not created yet */
    }
    if (isInside(real, realRoot)) return root.scope;
  }
  return null;
}

async function requirementFor(storedPath: string): Promise<boolean> {
  const scope = await scopeOf(storedPath);
  return scope ? scopeRequiresEncryption(scope) : false;
}

// ---------------------------------------------------------------------------
// Renderer-supplied paths (IPC): containment is enforced.
// ---------------------------------------------------------------------------

/** Resolve a path the renderer sent: must be a regular file inside an attachment root. */
export async function resolveRendererAttachment(storedPath: string): Promise<ResolvedAttachment> {
  return resolveContainedAttachment(storedPath, deps.userData());
}

export async function readContainedAttachment(resolved: ResolvedAttachment): Promise<Buffer> {
  const requireEncrypted = await scopeRequiresEncryption(resolved.scope);
  return deps.files().readAllDecrypted(resolved.realPath, { requireEncrypted });
}

export async function decryptContainedAttachmentTo(
  resolved: ResolvedAttachment,
  destPath: string,
): Promise<void> {
  const requireEncrypted = await scopeRequiresEncryption(resolved.scope);
  await deps.files().decryptToFile(resolved.realPath, destPath, { requireEncrypted });
}

// ---------------------------------------------------------------------------
// DB-stored paths (export, upload, text extraction): decrypt, phase switch by
// the folder the path is in.
// ---------------------------------------------------------------------------

/** Whole plaintext of a stored attachment. */
export async function readStoredAttachment(storedPath: string): Promise<Buffer> {
  const requireEncrypted = await requirementFor(storedPath);
  return deps.files().readAllDecrypted(storedPath, { requireEncrypted });
}

/** Write the plaintext of a stored attachment to `destPath` (all-or-nothing). */
export async function decryptStoredAttachmentTo(storedPath: string, destPath: string): Promise<void> {
  const requireEncrypted = await requirementFor(storedPath);
  await deps.files().decryptToFile(storedPath, destPath, { requireEncrypted });
}

/** Plaintext size from the header (no decrypt). null when the file cannot be read. */
export async function statStoredAttachment(storedPath: string): Promise<{ size: number } | null> {
  try {
    const st = await fs.promises.stat(storedPath);
    if (!st.isFile()) return null;
    const { encrypted, size } = await deps.files().statPlaintext(storedPath);
    if (!encrypted && (await requirementFor(storedPath))) return null;
    return { size };
  } catch {
    return null;
  }
}

/**
 * Handle-bound variants: the caller opened the file once; size and bytes both
 * come from that handle (no path re-resolve between check and use).
 */
export async function statOpenAttachment(
  storedPath: string,
  handle: fs.promises.FileHandle,
): Promise<{ size: number; encrypted: boolean }> {
  return deps.files().statPlaintextFromHandle(handle);
}

export async function readOpenAttachment(
  storedPath: string,
  handle: fs.promises.FileHandle,
): Promise<Buffer> {
  const requireEncrypted = await requirementFor(storedPath);
  return deps.files().readAllDecryptedFromHandle(handle, { requireEncrypted });
}
