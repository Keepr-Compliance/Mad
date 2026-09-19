/**
 * BACKLOG-2953 — `BackupErrorCode` must be exhaustively switchable, and the
 * published tuple must be the union.
 *
 * THE DEFECT THIS PINS: `backupService.ts:897` emitted
 * `"BACKUP_FAILED" as BackupErrorCode`. The string was never a member; the cast
 * made it compile. Any exhaustive `switch` over the union would have let that
 * value fall through in silence, because the compiler believed it could not
 * occur. The item's own required proof is compiler-level (delete the cast, `tsc`
 * goes red); this file is the guard for the NEXT such value.
 *
 * WHICH GATE SEES WHAT. `tsconfig.json` excludes every `*.test.ts` file, so the
 * type-level assertions in this file are checked by `npm run type-check:tests`
 * (`tsc -p tsconfig.test.json`, CI step added by BACKLOG-2414) — NOT by
 * `npm run type-check`. The tuple-covers-union half lives in the shipped
 * `electron/types/backupErrorCodes.ts` so `npm run type-check` catches that half
 * too. Both are needed: the shipped assert says "the tuple is the union"; the
 * switch below says "every member has a handler".
 *
 * Mutations that must go red here:
 *   - add a member to the union in `backup.ts` without a `case` below →
 *     `type-check:tests` red on the `never` arm (and `type-check` red in the leaf,
 *     since the tuple would now be missing it);
 *   - delete a `case` below → `type-check:tests` red on the `never` arm;
 *   - list an entry twice in the tuple → the uniqueness test fails at runtime.
 */

import { BACKUP_ERROR_CODES } from "../backupErrorCodes";
import type { BackupErrorCode } from "../backup";

/** Mutual `extends` — one-directional would pass while one side was narrower. */
type Equals<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

const _TUPLE_ELEMENT_IS_THE_UNION: Equals<
  (typeof BACKUP_ERROR_CODES)[number],
  BackupErrorCode
> = true;
void _TUPLE_ELEMENT_IS_THE_UNION;

/**
 * The exhaustive switch 2913's design invites. Every member returns a label; the
 * `default` arm assigns to `never`, so a member with no `case` is a compile error
 * naming the member. Labels are test-local — production copy lives in
 * `backupService.ts` — so nothing here is a second source of user-facing text.
 */
function classOf(code: BackupErrorCode): "input" | "device" | "link" | "host" | "unknown" {
  switch (code) {
    case "PASSWORD_REQUIRED":
    case "INCORRECT_PASSWORD":
    case "INVALID_UDID":
      return "input";
    case "DEVICE_NOT_FOUND":
    case "DEVICE_LOCKED":
    case "BACKUP_FILE_MISSING":
    case "DECRYPTION_FAILED":
      return "device";
    case "CONNECTION_LOST":
    case "SERVICE_UNAVAILABLE":
    case "BACKUP_TIMEOUT":
      return "link";
    case "INSUFFICIENT_SPACE":
    case "BACKUP_CANCELLED":
      return "host";
    case "UNKNOWN_ERROR":
      return "unknown";
    default: {
      const _exhaustive: never = code;
      void _exhaustive;
      throw new Error(`Unhandled BackupErrorCode: ${String(code)}`);
    }
  }
}

describe("BACKLOG-2953: BackupErrorCode is exhaustively switchable", () => {
  it("has a handler for every published member (the switch above compiles and runs)", () => {
    for (const code of BACKUP_ERROR_CODES) {
      expect(() => classOf(code)).not.toThrow();
    }
  });

  it("lists each member exactly once", () => {
    expect(new Set(BACKUP_ERROR_CODES).size).toBe(BACKUP_ERROR_CODES.length);
  });

  it("publishes the member the :897 guard now emits", () => {
    expect(BACKUP_ERROR_CODES).toContain("INVALID_UDID");
  });

  it("does not publish the string the cast used to smuggle in", () => {
    // `as readonly string[]` so the assertion is about the VALUE, not a type error.
    expect((BACKUP_ERROR_CODES as readonly string[]).includes("BACKUP_FAILED")).toBe(false);
  });

  it("classifies the guard's code as an input fault, not a device state", () => {
    expect(classOf("INVALID_UDID")).toBe("input");
  });
});
