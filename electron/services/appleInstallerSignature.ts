/**
 * Authenticode check for Apple driver installers (BACKLOG-3806).
 *
 * Before Keepr hands an Apple installer (MSI or EXE) to Windows, it asks
 * Windows whether the file carries a valid Authenticode signature from
 * Apple Inc. Both conditions are required: Windows must report the
 * signature as Valid, and the signing certificate's subject must name
 * Apple Inc. as both the common name and the organisation.
 *
 * The file path never appears in PowerShell command text. It is passed in an
 * environment variable and read with -LiteralPath, so no character in a path
 * can change what the command does.
 */

import { execFile } from "child_process";
import path from "path";
import log from "electron-log";

/** Signer the Apple driver installers are signed by (CN and O, exact). */
export const APPLE_SIGNER = { CN: "Apple Inc.", O: "Apple Inc." } as const;

/** Environment variable that carries the path to the PowerShell check. */
export const SIGCHECK_PATH_ENV = "KEEPR_SIGCHECK_PATH";

/**
 * PowerShell run by the check. Constant text: it contains no caller data.
 * Status is converted to its name so the JSON carries "Valid", not an integer.
 */
export const SIGCHECK_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  `$s = Get-AuthenticodeSignature -LiteralPath $env:${SIGCHECK_PATH_ENV}`,
  "$c = $s.SignerCertificate",
  "[pscustomobject]@{",
  "  Status = $s.Status.ToString()",
  "  StatusMessage = [string]$s.StatusMessage",
  "  Subject = $(if ($c) { $c.Subject } else { $null })",
  "  Thumbprint = $(if ($c) { $c.Thumbprint } else { $null })",
  "} | ConvertTo-Json -Compress",
].join("\n");

/** Shape printed by SIGCHECK_SCRIPT. */
export interface RawSignatureResult {
  Status: string | null;
  StatusMessage?: string | null;
  Subject: string | null;
  Thumbprint?: string | null;
}

export type SignatureCheckReason =
  | "valid"
  | "invalid_status"
  | "wrong_signer"
  | "check_failed"
  | "unsupported_platform";

export interface SignatureCheck {
  ok: boolean;
  reason: SignatureCheckReason;
  status: string | null;
  subject: string | null;
}

/**
 * Parse a Windows-rendered X.500 subject ("CN=..., O=..., C=US") into
 * attribute -> values. Returns null for anything that cannot be split
 * unambiguously: quoted values (which may contain commas), multi-valued RDNs
 * ("+"), escapes, or components without "=".
 */
export function parseSubject(subject: string): Map<string, string[]> | null {
  if (!subject || /["+\\]/.test(subject)) return null;
  const attrs = new Map<string, string[]>();
  for (const part of subject.split(",")) {
    const eq = part.indexOf("=");
    if (eq <= 0) return null;
    const key = part.slice(0, eq).trim().toUpperCase();
    const value = part.slice(eq + 1).trim();
    if (!key || !value) return null;
    attrs.set(key, [...(attrs.get(key) ?? []), value]);
  }
  return attrs;
}

/** True when the subject names Apple Inc. as its only CN and only O. */
export function isAppleSigner(subject: string | null): boolean {
  if (!subject) return false;
  const attrs = parseSubject(subject);
  if (!attrs) return false;
  const cn = attrs.get("CN") ?? [];
  const o = attrs.get("O") ?? [];
  return (
    cn.length === 1 &&
    cn[0] === APPLE_SIGNER.CN &&
    o.length === 1 &&
    o[0] === APPLE_SIGNER.O
  );
}

/** Decide a check from the PowerShell output. Both conditions are required. */
export function evaluateSignature(raw: RawSignatureResult): SignatureCheck {
  const status = typeof raw.Status === "string" ? raw.Status : null;
  const subject = typeof raw.Subject === "string" ? raw.Subject : null;
  if (status !== "Valid") {
    return { ok: false, reason: "invalid_status", status, subject };
  }
  if (!isAppleSigner(subject)) {
    return { ok: false, reason: "wrong_signer", status, subject };
  }
  return { ok: true, reason: "valid", status, subject };
}

export function powershellPath(): string {
  return path.win32.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

/**
 * Ask Windows whether `filePath` is validly signed by Apple Inc.
 * Never throws; any failure to run or parse the check is a refusal.
 */
export function verifyAppleSignature(filePath: string): Promise<SignatureCheck> {
  if (process.platform !== "win32") {
    return Promise.resolve({
      ok: false,
      reason: "unsupported_platform",
      status: null,
      subject: null,
    });
  }

  return new Promise((resolve) => {
    execFile(
      powershellPath(),
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        SIGCHECK_SCRIPT,
      ],
      {
        timeout: 60000,
        windowsHide: true,
        env: { ...process.env, [SIGCHECK_PATH_ENV]: filePath },
      },
      (error, stdout) => {
        if (error) {
          log.error("[AppleInstallerSignature] Signature check failed to run:", error);
          resolve({ ok: false, reason: "check_failed", status: null, subject: null });
          return;
        }
        try {
          const raw = JSON.parse(String(stdout).trim()) as RawSignatureResult;
          const result = evaluateSignature(raw);
          log.info("[AppleInstallerSignature] Signature check:", {
            file: path.win32.basename(filePath),
            status: result.status,
            subject: result.subject,
            thumbprint: raw.Thumbprint ?? null,
            ok: result.ok,
          });
          resolve(result);
        } catch (parseError) {
          log.error("[AppleInstallerSignature] Unreadable signature check output:", parseError);
          resolve({ ok: false, reason: "check_failed", status: null, subject: null });
        }
      },
    );
  });
}
