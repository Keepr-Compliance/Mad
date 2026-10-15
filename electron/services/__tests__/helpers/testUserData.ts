/**
 * BACKLOG-3816 S4-C (B1): a fresh userData directory per test file, under os.tmpdir().
 *
 * Suites that reach the at-rest stores (data key, backup password store, Backups/) must
 * never share a fixed path such as "/tmp" — two suites, or the developer's own profile,
 * would read and write the same store file. Use from a jest.mock factory:
 *
 *   jest.mock("electron", () => ({
 *     app: {
 *       isPackaged: false,
 *       // eslint-disable-next-line @typescript-eslint/no-require-imports
 *       getPath: jest.fn(() => require("./helpers/testUserData").testUserDataDir()),
 *     },
 *   }));
 *
 * Enforced by electron/__tests__/atRest.testIsolation.test.ts.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

let dir: string | null = null;

/** Created on first use; one per test file (jest gives each file its own module registry). */
export function testUserDataDir(): string {
  if (!dir) dir = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-jest-userdata-"));
  return dir;
}

export function removeTestUserDataDir(): void {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = null;
}
