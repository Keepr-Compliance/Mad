/**
 * BACKLOG-3819 — the log-sink redactor removes customer emails and phone
 * numbers and leaves every other number in a real log line alone.
 *
 * NEGATIVE CORPUS: each line below is transcribed from a line shape in the
 * app's actual electron-log output (installed-app main.log and dev-profile
 * main.old.log on the founder's Mac, read 2026-10-08), with identifiers
 * swapped for generated values of the same shape. The emitting source is cited
 * where it is in this repo. Shape census of those files is recorded on
 * BACKLOG-3819 (pm_comments).
 */

import { createHash, randomBytes, randomUUID } from "crypto";
import { redactLogText, redactPhone } from "../redactSensitive";

/** A 40-hex git SHA, generated per run. */
const SHA = createHash("sha1").update(randomBytes(8)).digest("hex");
/** A base64 sha512 like electron-updater's `sha512:` field, with digits after a "+". */
const B64 = `${randomBytes(30).toString("base64")}A+15555550123B${randomBytes(12).toString("base64")}==`;
const U1 = randomUUID();
const U2 = randomUUID();
/** A UUID whose final segment is all digits. */
const U_DIGITS = `${randomUUID().slice(0, 24)}${String(Date.now()).slice(-12).padStart(12, "4")}`;

const NEGATIVE_CORPUS: string[] = [
  // electron-log line prefix + ISO timestamp emitted by logService
  "[2026-10-04 17:47:23.943] [info]  2026-10-04T23:47:23.943Z INFO  [Contacts] [Main] Read 1192 contacts from shadow table",
  // UUIDs (AutoLinkService)
  `[2026-09-07 14:06:14.113] [info]  2026-09-07T20:06:14.113Z INFO  [AutoLinkService] Auto-linking communications for contact ${U1} to transaction ${U2}`,
  `[2026-10-04 18:06:19.644] [info]  2026-10-05T00:06:19.643Z INFO  [SubmissionService] [Submission] Versioning from submission ${U1} (status: needs_changes) — previous version retained`,
  // UUID whose final segment is all digits — the shape the older RCS phone
  // redactor turns into "<phone>"
  `[2026-10-04 18:06:19.644] [info]  transaction ${U_DIGITS} loaded`,
  // byte counts (MacOSMessagesImportService)
  "[2026-10-04 18:00:37.667] [warn]  2026-10-05T00:00:37.667Z WARN  [MacOSMessagesImportService] Skipping oversized attachment: 108150240 bytes",
  "      size: 881698121",
  "[2026-09-26 10:00:00.000] [info]  [DeviceSyncOrchestrator] backup-estimate bytes=5798205440 reusedPreviousBackup=true",
  // updater (electron-updater) lines
  "[2026-09-07 14:01:53.879] [info]  Download speed: 58269 - Downloaded 0.02%",
  "  releaseDate: '2026-09-07T19:42:19.265Z',",
  "[2026-09-07 14:01:53.071] [info]  Found version 2.36.0 (url: Keepr-2.36.0-mac.zip, Keepr-2.36.0-arm64-mac.zip, Keepr-2.36.0.dmg, Keepr-2.36.0-arm64.dmg)",
  "    <id>tag:github.com,2008:Repository/1170941315/v2.38.1</id>",
  `      sha512: '${B64}',`,
  // durations
  "[2026-09-07 12:33:11.843] [info]  [DeviceDetection] Starting device polling (interval: 2000ms)",
  "[2026-09-26 10:00:00.000] [info]  [SyncTimeline] phase-end phase=backup durationMs=1234567 elapsed=20.6m",
  // device udid shape (SyncHandlers)
  "[2026-09-27 09:44:07.441] [info]  [SyncHandlers] Device connected { name: 'iPad', udid: '00008101-000A1B2C3D4E5F60' }",
  // git SHA, epoch seconds and epoch milliseconds, IP address, process id
  `[2026-09-26 10:00:00.000] [info]  build ${SHA} at 1728432000 (1728432000123) from 192.168.100.200 PID: 48213`,
  // Renderer relay prefix (handlers/systemHandlers.ts log:renderer) with progress counters
  "[2026-09-26 10:00:00.000] [info]  [Renderer] [IPhoneSyncFlow] storing: Saving messages... 663,000 of 663,000",
  // timezone offsets
  "2026-10-08T22:22:48+00:00 / 2026-10-08T22:22:48+0000 / 2026-10-08 22:22:48.540",
  // already-redacted text is stable
  "[2026-10-08 22:22:48.540] [info]  user j***@example.com phone ***99",
];

describe("BACKLOG-3819 L3: real log line shapes pass through unchanged", () => {
  it.each(NEGATIVE_CORPUS.map((l) => [l]))("%s", (line) => {
    expect(redactLogText(line)).toBe(line);
  });
});

const POSITIVE: Array<[string, string, string]> = [
  // [input, raw value that must disappear, expected replacement]
  ["sent to +15555550123 ok", "+15555550123", "***23"],
  ["handle +1 (555) 555-0147 linked", "+1 (555) 555-0147", "***47"],
  ["UK +44 20 7946 0958 x", "+44 20 7946 0958", "***58"],
  ["call (555) 555-0199 now", "(555) 555-0199", "***99"],
  ["call (555)555-0199 now", "(555)555-0199", "***99"],
  ["phone=555-555-0172,", "555-555-0172", "***72"],
  ["phone 555.555.0164.", "555.555.0164", "***64"],
  ["phone 555 555 0110", "555 555 0110", "***10"],
  ["phone 1-555-555-0133", "1-555-555-0133", "***33"],
  ["{ handle: '+15555550188' }", "+15555550188", "***88"],
  ["jane.doe@example.com wrote", "jane.doe@example.com", "j***@example.com"],
  ["iMessage +15555550111@s.example.net", "+15555550111", "+***@s.example.net"],
];

describe("BACKLOG-3819: emails and phones are redacted, last two digits kept", () => {
  it.each(POSITIVE)("%s", (input, raw, replacement) => {
    const out = redactLogText(input);
    expect(out).not.toContain(raw);
    expect(out).toContain(replacement);
    // idempotent
    expect(redactLogText(out)).toBe(out);
  });

  it("redactPhone keeps exactly the last two digits", () => {
    expect(redactPhone("+1 (555) 555-0199")).toBe("***99");
    expect(redactPhone("")).toBe("***");
    expect(redactPhone("7")).toBe("***");
  });
});
