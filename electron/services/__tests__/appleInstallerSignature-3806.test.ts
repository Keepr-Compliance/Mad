/**
 * BACKLOG-3806: the Apple installer signature check.
 *
 * A file passes only when Windows reports the signature Valid AND the signer
 * is Apple Inc. (CN and O). The file path reaches PowerShell only through an
 * environment variable.
 */

const mockExecFile = jest.fn();
jest.mock("child_process", () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
}));

jest.mock("electron-log", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

import {
  evaluateSignature,
  isAppleSigner,
  parseSubject,
  verifyAppleSignature,
  SIGCHECK_PATH_ENV,
  SIGCHECK_SCRIPT,
} from "../appleInstallerSignature";
import {
  APPLE_SUBJECT_WINDOWS,
  HASH_MISMATCH_APPLE,
  NOT_SIGNED,
  NOT_TRUSTED_APPLE,
  VALID_APPLE,
  VALID_OTHER_SIGNER,
} from "./appleInstallerSignature.fixtures";

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;

function setPlatform(p: string) {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
}

function psReturns(stdout: string, error: Error | null = null) {
  mockExecFile.mockImplementation(
    (_file: string, _args: string[], _opts: unknown, cb: (e: Error | null, out: string, err: string) => void) => {
      cb(error, stdout, "");
    },
  );
}

beforeEach(() => {
  jest.clearAllMocks();
});

afterEach(() => {
  Object.defineProperty(process, "platform", originalPlatform);
});

describe("evaluateSignature — both conditions are required", () => {
  it("accepts a Valid signature from Apple Inc.", () => {
    expect(evaluateSignature(VALID_APPLE)).toEqual({
      ok: true,
      reason: "valid",
      status: "Valid",
      subject: APPLE_SUBJECT_WINDOWS,
    });
  });

  it("refuses a Valid signature from any other signer", () => {
    const r = evaluateSignature(VALID_OTHER_SIGNER);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("wrong_signer");
  });

  it.each([
    ["HashMismatch", HASH_MISMATCH_APPLE],
    ["NotTrusted", NOT_TRUSTED_APPLE],
    ["NotSigned", NOT_SIGNED],
  ])("refuses an Apple-named file whose status is %s", (_label, fixture) => {
    const r = evaluateSignature(fixture);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("invalid_status");
  });

  it.each(["UnknownError", "Incompatible", "NotSupportedFileFormat", "", null])(
    "refuses status %p even with the Apple subject",
    (status) => {
      expect(evaluateSignature({ ...VALID_APPLE, Status: status }).ok).toBe(false);
    },
  );
});

describe("isAppleSigner — exact CN and O", () => {
  it.each([
    [APPLE_SUBJECT_WINDOWS, true],
    ["CN=Apple Inc., O=Apple Inc., C=US", true],
    ["O=Apple Inc., CN=Apple Inc.", true],
    ["CN=Apple Inc., O=Apple Inc. Ltd, C=US", false],
    ["CN=Apple Inc, O=Apple Inc., C=US", false],
    ["CN=apple inc., O=Apple Inc., C=US", false],
    ["CN=Apple Inc., C=US", false],
    ["O=Apple Inc., C=US", false],
    ["CN=Evil, O=Apple Inc., C=US", false],
    ["CN=Apple Inc., O=Evil Corp, C=US", false],
    // a second CN or O
    ["CN=Apple Inc., CN=Evil, O=Apple Inc.", false],
    // quoted value containing a comma: cannot be split safely
    ['CN="Apple Inc., O=Apple Inc.", O=Evil', false],
    // multi-valued RDN
    ["CN=Apple Inc.+OU=x, O=Apple Inc.", false],
    ["", false],
    [null, false],
  ])("%p -> %p", (subject, expected) => {
    expect(isAppleSigner(subject as string | null)).toBe(expected);
  });

  it("parseSubject keeps every attribute", () => {
    const attrs = parseSubject(APPLE_SUBJECT_WINDOWS)!;
    expect(attrs.get("CN")).toEqual(["Apple Inc."]);
    expect(attrs.get("O")).toEqual(["Apple Inc."]);
    expect(attrs.get("S")).toEqual(["California"]);
  });
});

describe("verifyAppleSignature", () => {
  it("does nothing off Windows", async () => {
    setPlatform("darwin");
    const r = await verifyAppleSignature("/x/AppleMobileDeviceSupport64.msi");
    expect(r).toEqual({ ok: false, reason: "unsupported_platform", status: null, subject: null });
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("returns ok for Valid + Apple output", async () => {
    setPlatform("win32");
    psReturns(JSON.stringify(VALID_APPLE));
    const r = await verifyAppleSignature("C:\\keepr\\AppleMobileDeviceSupport64.msi");
    expect(r.ok).toBe(true);
  });

  it.each([
    ["other signer", JSON.stringify(VALID_OTHER_SIGNER), null],
    ["hash mismatch", JSON.stringify(HASH_MISMATCH_APPLE), null],
    ["not signed", JSON.stringify(NOT_SIGNED), null],
    ["unparseable output", "not json", null],
    ["empty output", "", null],
    ["powershell failed", "", new Error("spawn failed")],
  ])("refuses on %s", async (_l, out, err) => {
    setPlatform("win32");
    psReturns(out as string, err as Error | null);
    const r = await verifyAppleSignature("C:\\keepr\\AppleMobileDeviceSupport64.msi");
    expect(r.ok).toBe(false);
  });

  it("passes the path only through the environment, never in the command", async () => {
    setPlatform("win32");
    psReturns(JSON.stringify(VALID_APPLE));
    const hostile =
      "C:\\Users\\a'b\"; Remove-Item -Recurse C:\\ ; $(calc) `whoami` & echo\\AppleMobileDeviceSupport64.msi";
    await verifyAppleSignature(hostile);

    expect(mockExecFile).toHaveBeenCalledTimes(1);
    const [file, args, opts] = mockExecFile.mock.calls[0] as [
      string,
      string[],
      { env: Record<string, string> },
    ];
    expect(file.toLowerCase()).toMatch(/\\windowspowershell\\v1\.0\\powershell\.exe$/);
    expect(args).toEqual(["-NoProfile", "-NonInteractive", "-Command", SIGCHECK_SCRIPT]);
    for (const arg of [file, ...args]) {
      expect(arg).not.toContain("Remove-Item");
      expect(arg).not.toContain("a'b");
    }
    expect(opts.env[SIGCHECK_PATH_ENV]).toBe(hostile);
    expect(SIGCHECK_SCRIPT).toContain(`-LiteralPath $env:${SIGCHECK_PATH_ENV}`);
  });
});
