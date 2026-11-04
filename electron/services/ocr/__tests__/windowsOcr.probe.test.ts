/**
 * @jest-environment node
 *
 * BACKLOG-3943 — Windows OCR PROBE (founder ruling 4: CI probe first).
 *
 * Runs ONLY on win32; on macOS and Linux jest reports these tests as SKIPPED, never as
 * passed (SR plan review R8). The Windows OCR child itself is a later PR; this file answers
 * the two questions that design rests on, on the CI runner:
 *
 *   1. Does Windows PowerShell 5.1 project Windows.Media.Ocr, and which recogniser
 *      languages does the machine have? (Printed to the log; an empty list is reported,
 *      not failed — the runner image may lack the OCR language feature.)
 *   2. SR plan review R6: can a script passed with -EncodedCommand read raw bytes from
 *      stdin ([Console]::OpenStandardInput())? If yes, the Windows child needs no temp
 *      file for the decrypted document.
 *
 * powershell.exe is started by absolute path, with a minimal env that keeps SystemRoot /
 * windir (Windows PowerShell does not start without them).
 */
import { spawnSync } from "child_process";
import { createHash } from "crypto";
import path from "path";

const describeWindows = process.platform === "win32" ? describe : describe.skip;

function powershellPath(): string {
  return path.win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function minimalEnv(): NodeJS.ProcessEnv {
  const root = process.env.SystemRoot ?? "C:\\Windows";
  return {
    SystemRoot: root,
    windir: process.env.windir ?? root,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    PATH: path.win32.join(root, "System32"),
  };
}

function runPowerShell(script: string, input?: Buffer) {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return spawnSync(powershellPath(), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
    env: minimalEnv(),
    input,
    timeout: 60_000,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
}

describeWindows("Windows OCR probe (win32 only)", () => {
  it("Windows.Media.Ocr is projected; prints the recogniser languages and MaxImageDimension", () => {
    const r = runPowerShell(
      [
        "$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]",
        "$langs = @([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | ForEach-Object { $_.LanguageTag })",
        "'OCR_LANGS=' + ($langs -join ',')",
        "'OCR_MAX_DIM=' + [Windows.Media.Ocr.OcrEngine]::MaxImageDimension",
        "'PS_VERSION=' + $PSVersionTable.PSVersion.ToString()",
      ].join("\n"),
    );
    const out = r.stdout?.toString("utf8") ?? "";
    // The answer the probe exists for — read it in the CI log.
    console.log(`[BACKLOG-3943 probe] exit=${r.status}\n${out}\nstderr: ${(r.stderr?.toString("utf8") ?? "").slice(0, 500)}`);
    expect(r.status).toBe(0);
    expect(out).toContain("OCR_LANGS=");
    expect(out).toContain("OCR_MAX_DIM=");
  }, 90_000);

  it("R6: stdin bytes reach a script passed with -EncodedCommand, unchanged", () => {
    const input = Buffer.from(Array.from({ length: 65_536 }, (_, i) => (i * 31 + 7) % 256));
    const expectedSha = createHash("sha256").update(input).digest("hex");
    const r = runPowerShell(
      [
        "$in = [Console]::OpenStandardInput()",
        "$ms = New-Object System.IO.MemoryStream",
        "$in.CopyTo($ms)",
        "$b = $ms.ToArray()",
        "'LEN=' + $b.Length",
        "$h = [System.Security.Cryptography.SHA256]::Create().ComputeHash($b)",
        "'SHA=' + ([System.BitConverter]::ToString($h) -replace '-','').ToLower()",
      ].join("\n"),
      input,
    );
    const out = r.stdout?.toString("utf8") ?? "";
    console.log(`[BACKLOG-3943 probe R6] exit=${r.status}\n${out}`);
    expect(r.status).toBe(0);
    expect(out).toContain(`LEN=${input.length}`);
    expect(out).toContain(`SHA=${expectedSha}`);
  }, 90_000);
});
