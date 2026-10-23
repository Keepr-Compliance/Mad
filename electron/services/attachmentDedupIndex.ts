/**
 * Which stored file a new attachment row should point at — BACKLOG-4040 S2.
 *
 * Used by the Mac Messages and iPhone sync writers. Files are content-addressed
 * (`<sha256><ext>`) and shared across sources, so before writing a file the
 * writer asks whether the same bytes are already stored.
 *
 * Before S2 both writers answered from the hash alone and then REBUILT the path
 * with their own extension. Two defects followed:
 *   - D1: a row for that hash existed but its file had been removed, so the new
 *     row pointed at nothing;
 *   - D2: the bytes were stored as `h.jpg` (another source), the new attachment
 *     was `IMG.jpeg`, and the new row pointed at `h.jpeg`, which never existed.
 *
 * Now: every stored spelling of a hash is remembered, and a new row is linked
 * to the first one that EXISTS on disk inside the writer's own folder. If none
 * exists, the writer stores the file again under a LOWER-CASE extension.
 *
 * Existing rows are never rewritten here. A row that already points at a
 * missing file stays as it is (repairing it is not this module's job).
 */
import fs from "fs";
import path from "path";

/** The hash part of a stored name (`<sha256><ext>`), lower-cased. */
function hashOf(storedPath: string): string {
  const base = path.posix.basename(storedPath.replace(/\\/g, "/"));
  const ext = path.posix.extname(base);
  return base.slice(0, base.length - ext.length).toLowerCase();
}

/** The extension a NEW stored file gets: the source's, lower-cased. */
export function storedExtension(filename: string): string {
  return path.extname(filename).toLowerCase();
}

export class AttachmentDedupIndex {
  private readonly byHash = new Map<string, string[]>();

  /**
   * @param attachmentsDir absolute folder the writer stores into
   * @param userData relative stored paths are resolved under it
   */
  constructor(
    private readonly attachmentsDir: string,
    private readonly userData: string,
  ) {}

  /** Remember a stored path (from an existing row, or one this run just wrote). */
  add(storedPath: string | null | undefined): void {
    if (typeof storedPath !== "string" || storedPath.length === 0) return;
    const h = hashOf(storedPath);
    if (h.length === 0) return;
    const list = this.byHash.get(h);
    if (!list) this.byHash.set(h, [storedPath]);
    else if (!list.includes(storedPath)) list.push(storedPath);
  }

  /** Distinct hashes known (for the run's log line). */
  get size(): number {
    return this.byHash.size;
  }

  private absolute(storedPath: string): string {
    return path.isAbsolute(storedPath) ? storedPath : path.join(this.userData, storedPath);
  }

  /**
   * An existing file holding these bytes, as an absolute path a new row can
   * store, or null when the file must be written. Only files inside the
   * writer's own folder are reused.
   */
  existingFileFor(contentHash: string): string | null {
    const list = this.byHash.get(contentHash.toLowerCase());
    if (!list) return null;
    const dir = path.resolve(this.attachmentsDir);
    for (const stored of list) {
      const abs = path.resolve(this.absolute(stored));
      if (path.dirname(abs) !== dir) continue;
      try {
        if (fs.statSync(abs).isFile()) return abs;
      } catch {
        // missing: try the next spelling
      }
    }
    return null;
  }
}
