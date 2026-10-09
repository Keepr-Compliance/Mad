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
import { redactLogText, redactPhone, redactValueForKey } from "../redactSensitive";

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

// ---------------------------------------------------------------------------
// Founder QA 2026-10-09: bare phones under contact-like keys.
//
// The JSON fixture below is PRODUCED, not typed: logService.formatLogEntry
// (electron/services/logService.ts) appends `JSON.stringify(metadata, null, 2)`,
// and the metadata shape is the one ContactDbService's backfill emitted before
// this fix. All digits are synthetic (555-01xx).
// ---------------------------------------------------------------------------

const BARE_A = "5555550123";
const BARE_B = "5555550145";

/** Exactly what logService wrote for the backfill sample before the fix. */
const BACKFILL_SAMPLE_TEXT =
  "2026-10-09T18:00:00.000Z INFO  [ContactDbService] Backfill: Found phone-message matches\n" +
  JSON.stringify(
    {
      matchCount: 2,
      samples: [
        { contactId: "a1b2c3d4", phone: BARE_A, lastDate: "2026-10-01T12:00:00.000Z" },
        { contactId: "e5f60718", phone: BARE_B, lastDate: "2026-10-02T12:00:00.000Z" },
      ],
    },
    null,
    2,
  );

describe("BACKLOG-3819: bare phones under contact-like keys are redacted", () => {
  it("the backfill JSON sample block loses every bare phone, keeps ids and dates", () => {
    const out = redactLogText(BACKFILL_SAMPLE_TEXT);
    expect(out).not.toContain(BARE_A);
    expect(out).not.toContain(BARE_B);
    expect(out).toContain('"phone": "***23"');
    expect(out).toContain('"phone": "***45"');
    expect(out).toContain('"contactId": "a1b2c3d4"');
    expect(out).toContain('"lastDate": "2026-10-01T12:00:00.000Z"');
    expect(out).toContain('"matchCount": 2');
    expect(redactLogText(out)).toBe(out);
  });

  const KEYED: Array<[string, string, string]> = [
    // [input, raw value that must disappear, expected text]
    [`phone: ${BARE_A}`, BARE_A, "phone: ***23"],
    [`phone=${BARE_A} ok`, BARE_A, "phone=***23 ok"],
    [`{ phone: '${BARE_A}' }`, BARE_A, "{ phone: '***23' }"],
    [`"phoneNumber":"${BARE_A}"`, BARE_A, '"phoneNumber":"***23"'],
    [`"phone_number": ${BARE_A},`, BARE_A, '"phone_number": ***23,'],
    [`"normalized_phone": "${BARE_A}"`, BARE_A, '"normalized_phone": "***23"'],
    [`"phone_e164": "1${BARE_A}"`, `1${BARE_A}`, '"phone_e164": "***23"'],
    [`handle: '${BARE_A}'`, BARE_A, "handle: '***23'"],
    [`"chat_identifier": "chat${BARE_A}"`, BARE_A, '"chat_identifier": "chat***23"'],
    [`"participants_flat": "${BARE_A}, ${BARE_B}"`, BARE_A, '"participants_flat": "***23, ***45"'],
    [`"from": "${BARE_A}"`, BARE_A, '"from": "***23"'],
    [`to: 1${BARE_B}`, BARE_B, "to: ***45"],
    [`"sender": "+1${BARE_A}"`, BARE_A, '"sender": "***23"'],
    [`"address": "${BARE_B}"`, BARE_B, '"address": "***45"'],
    [`"email": "jane@example.com"`, "jane@example.com", '"email": "j***@example.com"'],
  ];

  it.each(KEYED)("%s", (input, raw, expected) => {
    const out = redactLogText(input);
    expect(out).not.toContain(raw);
    expect(out).toBe(expected);
    expect(redactLogText(out)).toBe(out);
  });

  it("a multi-line participants array loses every bare phone", () => {
    const text = JSON.stringify({ participants: [BARE_A, `+1${BARE_B}`, "jane@example.com"] }, null, 2);
    const out = redactLogText(text);
    expect(out).not.toContain(BARE_A);
    expect(out).not.toContain(BARE_B);
    expect(out).not.toContain("jane@example.com");
    expect(out).toContain('"***23"');
    expect(out).toContain('"***45"');
    expect(redactLogText(out)).toBe(out);
  });

  it("formatted, E.164 and iMessage-handle phones are still redacted without a key", () => {
    const out = redactLogText(
      `a +1${BARE_A} b (555) 555-0145 c +1${BARE_B}@s.example.net d tel ${"+1 555 555 0177"}`,
    );
    expect(out).not.toMatch(/555.?555.?01\d\d/);
  });
});

describe("BACKLOG-3819: key context never touches ids, counts, timestamps or ambiguous values", () => {
  const UUID = randomUUID();
  const UNCHANGED = [
    "[2026-10-09 10:00:00.000] [info]  [DeviceSyncOrchestrator] backup-estimate bytes=6013820953 reusedPreviousBackup=true",
    `"contactId": "${UUID}"`,
    `"transactionId": "${UUID}", "id": 6013820953`,
    `{ "durationMs": 6013820953, "size": 6013820953, "count": 6013820953 }`,
    `"lastDate": "2026-10-01T12:00:00.000Z"`,
    // weak keys keep values that are not whole phone numbers
    `"to": "develop", "from": "2026-10-01", "sender": "me", "address": "12 Main St"`,
    `to: 123456789`,
    // a contact-like key with a short or non-numeric value
    `"phone": "unknown", "handle": null, "phones": 3`,
    // a key that merely contains "phone"
    `"phoneCount": 6013820953, "hasPhone": true, "phoneLast2": "23"`,
  ];
  it.each(UNCHANGED.map((l) => [l]))("%s", (line) => {
    expect(redactLogText(line)).toBe(line);
  });
});

describe("BACKLOG-3819: redactValueForKey (object arguments to electron-log)", () => {
  it("redacts strong keys whatever the format, weak keys only when phone-shaped", () => {
    expect(redactValueForKey("phone", BARE_A)).toBe("***23");
    expect(redactValueForKey("phone", Number(BARE_A))).toBe("***23");
    expect(redactValueForKey("normalized_phone", BARE_A)).toBe("***23");
    expect(redactValueForKey("participants", [BARE_A, BARE_B])).toEqual(["***23", "***45"]);
    expect(redactValueForKey("to", BARE_A)).toBe("***23");
    expect(redactValueForKey("to", "develop")).toBe("develop");
    expect(redactValueForKey("contactId", BARE_A)).toBe(BARE_A);
    expect(redactValueForKey("bytes", 6013820953)).toBe(6013820953);
  });
});

describe("BACKLOG-3819: the sink hook redacts contact-like keys in object arguments", () => {
  it("redactLogValue drops a bare phone under `phone`, keeps ids and counts", () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { redactLogValue } = require("../../config/logFileConfig");
    const out = redactLogValue({
      matchCount: 2,
      samples: [{ contactId: "a1b2c3d4", phone: BARE_A, bytes: 6013820953 }],
      participants: [BARE_B],
    });
    expect(JSON.stringify(out)).not.toContain(BARE_A);
    expect(JSON.stringify(out)).not.toContain(BARE_B);
    expect(out).toEqual({
      matchCount: 2,
      samples: [{ contactId: "a1b2c3d4", phone: "***23", bytes: 6013820953 }],
      participants: ["***45"],
    });
  });
});
