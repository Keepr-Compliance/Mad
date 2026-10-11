/**
 * Locations the renderer may ask the OS to open or reveal (BACKLOG-3808).
 *
 * The `open-folder` and `system:show-in-folder` channels used to hand whatever
 * string the renderer sent straight to `shell.openPath` / `shell.showItemInFolder`.
 * Now the main process keeps a small, process-lifetime registry of the paths IT
 * wrote (the transaction exports) and those channels open only an exact match.
 *
 * Matching is done on realpath, so `..` segments and links resolve to their real
 * target before comparison: a path that merely starts inside an export, or a link
 * that points from one to somewhere else, does not match. The recorded kind
 * (file / directory) must also still hold when the open is requested.
 */
import fs from "fs";
import path from "path";

export type OpenableKind = "file" | "dir";

/** Why a request was refused. Logged as-is; never carries path contents. */
export type OpenRefusal =
  | "invalid"
  | "not_absolute"
  | "not_found"
  | "not_registered"
  | "kind_changed";

export type OpenableResolution =
  | { ok: true; realPath: string; kind: OpenableKind }
  | { ok: false; reason: OpenRefusal };

/** Message the renderer receives on any refusal. */
export const OPEN_REFUSED_MESSAGE =
  "Keepr can only open files and folders it created.";

const MAX_ENTRIES = 100;

/** key (realpath, case-folded on win32) -> recorded entry. Insertion-ordered. */
const registry = new Map<string, { realPath: string; kind: OpenableKind }>();

function keyFor(realPath: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? realPath.toLowerCase() : realPath;
}

async function kindOf(realPath: string): Promise<OpenableKind | null> {
  const st = await fs.promises.lstat(realPath);
  if (st.isDirectory()) return "dir";
  if (st.isFile()) return "file";
  return null;
}

/**
 * Record a path main just wrote so the renderer may later open it. Best effort:
 * a path that cannot be resolved is simply not recorded (opening it is refused).
 */
export async function rememberOpenablePath(
  writtenPath: string | null | undefined,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (!writtenPath || typeof writtenPath !== "string") return;
  try {
    const realPath = await fs.promises.realpath(writtenPath);
    const kind = await kindOf(realPath);
    if (!kind) return;
    const key = keyFor(realPath, platform);
    registry.delete(key);
    registry.set(key, { realPath, kind });
    while (registry.size > MAX_ENTRIES) {
      const oldest = registry.keys().next().value;
      if (oldest === undefined) break;
      registry.delete(oldest);
    }
  } catch {
    // not recorded
  }
}

/** Resolve a renderer-supplied path to a registered location, or refuse. */
export async function resolveOpenablePath(
  candidate: unknown,
  platform: NodeJS.Platform = process.platform,
): Promise<OpenableResolution> {
  if (typeof candidate !== "string" || candidate.length === 0 || candidate.length > 4096 || candidate.includes("\0")) {
    return { ok: false, reason: "invalid" };
  }
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  if (!pathApi.isAbsolute(candidate)) {
    return { ok: false, reason: "not_absolute" };
  }
  let realPath: string;
  try {
    realPath = await fs.promises.realpath(candidate);
  } catch {
    return { ok: false, reason: "not_found" };
  }
  const entry = registry.get(keyFor(realPath, platform));
  if (!entry) {
    return { ok: false, reason: "not_registered" };
  }
  let kind: OpenableKind | null;
  try {
    kind = await kindOf(realPath);
  } catch {
    return { ok: false, reason: "not_found" };
  }
  if (kind !== entry.kind) {
    return { ok: false, reason: "kind_changed" };
  }
  return { ok: true, realPath, kind };
}

/** Test-only: forget every recorded path. */
export function clearOpenablePathsForTests(): void {
  registry.clear();
}
