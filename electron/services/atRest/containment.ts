/**
 * Path containment for stored attachment files (BACKLOG-3816 S2).
 *
 * Every reader that turns a stored path (a DB `storage_path`, or one the renderer
 * sends back over IPC) into bytes must first prove the path is a REGULAR FILE that
 * really lives inside one of the attachment roots. The old checks were
 * `path.normalize(p).startsWith(userData)`, which:
 *   - accepts any file under userData (mad.db, the key stores, logs);
 *   - accepts a sibling directory sharing the prefix (`.../keepr-evil/x` vs `.../keepr`);
 *   - follows symlinks / junctions, so a link inside the root can point anywhere.
 *
 * Here both the candidate and the root are resolved with realpath (links and
 * junctions followed to their real target), compared with a separator-aware,
 * case-insensitive-on-Windows check, and the target must be a regular file.
 */
import fs from "fs";
import path from "path";

import { SCOPE_EMAIL_ATTACHMENTS, SCOPE_MESSAGE_ATTACHMENTS } from "./markers";

export class ContainmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContainmentError";
  }
}

/** The attachment roots under userData, and the at-rest scope key each one migrates under. */
export const ATTACHMENT_ROOTS = [
  { dir: "message-attachments", scope: SCOPE_MESSAGE_ATTACHMENTS },
  { dir: "attachments", scope: SCOPE_EMAIL_ATTACHMENTS },
] as const;

export type AttachmentScope = (typeof ATTACHMENT_ROOTS)[number]["scope"];

/**
 * Is `child` the same as, or inside, `parent`? Both must already be absolute and
 * real (no `..`, no links). Separator-aware: `/a/bc` is NOT inside `/a/b`.
 */
export function isInside(child: string, parent: string, platform: NodeJS.Platform = process.platform): boolean {
  const fold = (p: string) => (platform === "win32" ? p.toLowerCase() : p);
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const c = fold(pathApi.resolve(child));
  const p = fold(pathApi.resolve(parent));
  if (c === p) return true;
  const withSep = p.endsWith(pathApi.sep) ? p : p + pathApi.sep;
  return c.startsWith(withSep);
}

export interface ResolvedAttachment {
  /** realpath of the file — the only path a reader may open. */
  realPath: string;
  /** Which root it is in. */
  scope: AttachmentScope;
}

/**
 * Resolve a stored path to a regular file strictly inside one of the attachment
 * roots under `userData`. Throws ContainmentError otherwise (including when the
 * file does not exist — callers map that to "not found").
 */
export async function resolveContainedAttachment(
  storedPath: string,
  userData: string,
  platform: NodeJS.Platform = process.platform,
): Promise<ResolvedAttachment> {
  if (!storedPath || typeof storedPath !== "string" || storedPath.includes("\0")) {
    throw new ContainmentError("invalid attachment path");
  }
  if (!path.isAbsolute(storedPath)) {
    throw new ContainmentError("attachment path is not absolute");
  }
  let real: string;
  try {
    real = await fs.promises.realpath(storedPath);
  } catch {
    throw new ContainmentError("attachment file not found");
  }
  for (const root of ATTACHMENT_ROOTS) {
    let realRoot: string;
    try {
      realRoot = await fs.promises.realpath(path.join(userData, root.dir));
    } catch {
      continue; // root does not exist yet — nothing can be inside it
    }
    if (real === realRoot || !isInside(real, realRoot, platform)) continue;
    // lstat on the REAL path: after realpath it is not a link; this refuses
    // directories, FIFOs, sockets and devices.
    const st = await fs.promises.lstat(real);
    if (!st.isFile()) throw new ContainmentError("attachment path is not a regular file");
    return { realPath: real, scope: root.scope };
  }
  throw new ContainmentError("attachment path is outside the attachment folders");
}
