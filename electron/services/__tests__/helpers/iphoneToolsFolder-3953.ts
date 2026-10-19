/**
 * BACKLOG-3953: a real tools folder on disk, laid out as the installer leaves it, so the
 * block detector's stat calls run against real files rather than a mocked fs.
 */
import fs from "fs";
import os from "os";
import path from "path";

export interface ToolsFolder {
  dir: string;
  remove(name: string): void;
  empty(name: string): void;
  cleanup(): void;
}

/** Every name in `files` written with non-empty content. */
export function makeToolsFolder(files: readonly string[]): ToolsFolder {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-3953-"));
  const dir = path.join(root, "win", "libimobiledevice");
  fs.mkdirSync(dir, { recursive: true });
  for (const name of files) fs.writeFileSync(path.join(dir, name), "MZ");
  return {
    dir,
    remove: (name) => fs.rmSync(path.join(dir, name)),
    empty: (name) => fs.writeFileSync(path.join(dir, name), ""),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}
