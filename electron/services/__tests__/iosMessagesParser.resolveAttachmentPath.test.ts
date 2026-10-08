/**
 * BACKLOG-3789: attachment path validation for iOS backups.
 *
 * Real sms.db attachment and sticker paths must resolve to their MediaDomain
 * backup file; anything outside `Library/SMS/Attachments/` and
 * `Library/SMS/StickerCache/`, or containing a `..`/`.`/empty
 * segment, a backslash or a NUL must be rejected.
 */
import crypto from "crypto";
import path from "path";

jest.mock("better-sqlite3-multiple-ciphers", () => jest.fn());
jest.mock("electron-log", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import log from "electron-log";
import { iOSMessagesParser } from "../iosMessagesParser";

beforeEach(() => {
  iOSMessagesParser.flushRejectedPathSummary();
  jest.clearAllMocks();
});

const BACKUP = path.resolve("/backups/00008030-TEST");
const GUID = "5F2C0E1A-9B7D-4C3E-8A11-2D4F6B8C0E9A"; // pii-allow-uuid: synthetic attachment GUID, not a record id

function expectedFile(relativePath: string): string {
  const hash = crypto
    .createHash("sha1")
    .update(`MediaDomain-${relativePath}`)
    .digest("hex");
  return path.join(BACKUP, hash.substring(0, 2), hash);
}

describe("iOSMessagesParser.computeBackupFileHash", () => {
  it("matches the well-known sms.db fileID (anchors the domain-path formula)", () => {
    expect(
      iOSMessagesParser.computeBackupFileHash("HomeDomain", "Library/SMS/sms.db"),
    ).toBe(iOSMessagesParser.SMS_DB_HASH);
  });
});

describe("iOSMessagesParser.resolveAttachmentPath — accepted", () => {
  const ACCEPTED: Array<[string, string]> = [
    // Shape from the founder's log: ~/Library/SMS/Attachments/<xx>/<yy>/at_0_<GUID>/<name>
    [`~/Library/SMS/Attachments/3a/10/at_0_${GUID}/IMG_4021.HEIC`, `Library/SMS/Attachments/3a/10/at_0_${GUID}/IMG_4021.HEIC`],
    [`/var/mobile/Library/SMS/Attachments/3a/10/at_0_${GUID}/IMG_4021.HEIC`, `Library/SMS/Attachments/3a/10/at_0_${GUID}/IMG_4021.HEIC`],
    // Filenames with consecutive dots are ordinary names, not traversal
    [`~/Library/SMS/Attachments/0f/15/at_0_${GUID}/Offer...pdf`, `Library/SMS/Attachments/0f/15/at_0_${GUID}/Offer...pdf`],
    [`~/Library/SMS/Attachments/0f/15/at_0_${GUID}/Inspection..report.pdf`, `Library/SMS/Attachments/0f/15/at_0_${GUID}/Inspection..report.pdf`],
    [`~/Library/SMS/Attachments/0f/15/at_0_${GUID}/..hidden.jpg`, `Library/SMS/Attachments/0f/15/at_0_${GUID}/..hidden.jpg`],
    [`~/Library/SMS/Attachments/0f/15/at_0_${GUID}/trailing..`, `Library/SMS/Attachments/0f/15/at_0_${GUID}/trailing..`],
    [`/var/mobile/Library/SMS/Attachments/0f/15/at_0_${GUID}/a...b...c.mov`, `Library/SMS/Attachments/0f/15/at_0_${GUID}/a...b...c.mov`],
    // Spaces and unicode in names
    [`~/Library/SMS/Attachments/aa/02/at_1_${GUID}/Purchase Contract – final.pdf`, `Library/SMS/Attachments/aa/02/at_1_${GUID}/Purchase Contract – final.pdf`],
    // Sticker images (StickerCache) are attachments too
    [`~/Library/SMS/StickerCache/4c/${GUID}/sticker.heic`, `Library/SMS/StickerCache/4c/${GUID}/sticker.heic`],
    [`/var/mobile/Library/SMS/StickerCache/4c/${GUID}/sticker..png`, `Library/SMS/StickerCache/4c/${GUID}/sticker..png`],
    // Flat form used by older fixtures
    ["~/Library/SMS/Attachments/photo.jpg", "Library/SMS/Attachments/photo.jpg"],
  ];

  it.each(ACCEPTED)("%s", (original, relative) => {
    expect(iOSMessagesParser.toMediaDomainRelativePath(original)).toBe(relative);
    expect(iOSMessagesParser.resolveAttachmentPath(BACKUP, original)).toBe(
      expectedFile(relative),
    );
  });

  it("returns a file inside the backup directory", () => {
    const resolved = iOSMessagesParser.resolveAttachmentPath(
      BACKUP,
      `~/Library/SMS/Attachments/3a/10/at_0_${GUID}/Offer...pdf`,
    );
    expect(resolved).not.toBeNull();
    expect(path.dirname(path.dirname(resolved as string))).toBe(BACKUP);
    expect(path.basename(resolved as string)).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("iOSMessagesParser.resolveAttachmentPath — rejected", () => {
  const BASES = [
    ["Library", "SMS", "Attachments", "3a", "10", `at_0_${GUID}`, "IMG_4021.HEIC"],
    ["Library", "SMS", "StickerCache", "4c", GUID, "sticker.heic"],
  ];

  // Insert a bad segment at every depth, and also replace each segment with it.
  function segmentVariants(BASE_SEGMENTS: string[], bad: string): string[] {
    const out: string[] = [];
    for (let i = 0; i <= BASE_SEGMENTS.length; i++) {
      const inserted = [...BASE_SEGMENTS.slice(0, i), bad, ...BASE_SEGMENTS.slice(i)];
      out.push(inserted.join("/"));
    }
    for (let i = 0; i < BASE_SEGMENTS.length; i++) {
      const replaced = [...BASE_SEGMENTS];
      replaced[i] = bad;
      out.push(replaced.join("/"));
    }
    return out;
  }

  const PREFIXES = ["~/", "/var/mobile/"];

  const REJECTED: string[] = [];
  for (const prefix of PREFIXES) {
    for (const base of BASES) {
      for (const bad of ["..", ".", ""]) {
        for (const rel of segmentVariants(base, bad)) REJECTED.push(prefix + rel);
      }
      // Backslash and NUL at every character position of the relative path
      const rel = base.join("/");
      for (let i = 0; i <= rel.length; i++) {
        REJECTED.push(prefix + rel.slice(0, i) + "\\" + rel.slice(i));
        REJECTED.push(prefix + rel.slice(0, i) + "\0" + rel.slice(i));
      }
    }
    // Backslash traversal spelled Windows-style
    REJECTED.push(`${prefix}Library\\SMS\\Attachments\\..\\..\\sms.db`);
    REJECTED.push(`${prefix}Library/SMS/Attachments/..\\..\\sms.db`);
    // Outside the attachments root
    REJECTED.push(`${prefix}Library/SMS/sms.db`);
    REJECTED.push(`${prefix}Library/SMS/AttachmentsX/3a/10/x.jpg`);
    REJECTED.push(`${prefix}Library/SMS/StickerCacheX/3a/x.png`);
    REJECTED.push(`${prefix}Library/SMS/StickerCache`);
    REJECTED.push(`${prefix}Library/SMS/StickerCache/`);
    REJECTED.push(`${prefix}Library/SMS/StickerCache/../sms.db`);
    REJECTED.push(`${prefix}Library/Preferences/com.apple.x.plist`);
    REJECTED.push(`${prefix}library/sms/attachments/3a/x.jpg`);
    REJECTED.push(`${prefix}Library/SMS/Attachments`);
    REJECTED.push(`${prefix}Library/SMS/Attachments/`);
    REJECTED.push(`${prefix}../Library/SMS/Attachments/x.jpg`);
    REJECTED.push(`${prefix}../../../../etc/passwd`);
    REJECTED.push(`${prefix}/Library/SMS/Attachments/x.jpg`);
  }
  // No recognised prefix
  REJECTED.push(
    "Library/SMS/Attachments/3a/x.jpg",
    "/Library/SMS/Attachments/3a/x.jpg",
    "/etc/passwd",
    "/private/var/mobile/Library/SMS/Attachments/3a/x.jpg",
    "/var/mobileLibrary/SMS/Attachments/3a/x.jpg",
    "~Library/SMS/Attachments/3a/x.jpg",
    "~root/Library/SMS/Attachments/3a/x.jpg",
    "C:\\Windows\\System32\\x.dll",
    "../Library/SMS/Attachments/x.jpg",
    "file:///var/mobile/Library/SMS/Attachments/x.jpg",
  );

  it("sweep covers every variant (sanity)", () => {
    expect(REJECTED.length).toBeGreaterThan(800);
  });

  it.each(REJECTED.map((p) => [JSON.stringify(p)] as [string]))("%s", (encoded) => {
    const original = JSON.parse(encoded) as string;
    expect(iOSMessagesParser.toMediaDomainRelativePath(original)).toBeNull();
    expect(iOSMessagesParser.resolveAttachmentPath(BACKUP, original)).toBeNull();
  });

  it("rejects an empty path", () => {
    expect(iOSMessagesParser.resolveAttachmentPath(BACKUP, "")).toBeNull();
  });
});

describe("iOSMessagesParser rejection logging", () => {
  const PER_PATH = "iOSMessagesParser: Rejected attachment path";
  const SUMMARY = "iOSMessagesParser: Rejected attachment paths";
  const perPathCalls = () =>
    (log.warn as jest.Mock).mock.calls.filter(([msg]) => msg === PER_PATH);

  it("logs a traversal attempt individually, sanitized (no file names)", () => {
    iOSMessagesParser.resolveAttachmentPath(
      BACKUP,
      "~/Library/SMS/Attachments/3a/../../../secret-name.db",
    );
    expect(perPathCalls()).toEqual([
      [PER_PATH, { rule: "dot-segment", head: "~/Library", segments: 9, failedSegment: 5 }],
    ]);
    expect(JSON.stringify((log.warn as jest.Mock).mock.calls)).not.toContain("secret-name");
  });

  it.each([
    ["backslash", "~/Library/SMS/Attachments\\..\\x.db", 3],
    ["nul", "~/Library/SMS/Attachments/x\0.jpg", 4],
    ["dot-segment", "~/../private-file.txt", 1],
    ["absolute", "/etc/passwd", 0],
  ])("logs attack rule %s individually", (rule, p, failedSegment) => {
    iOSMessagesParser.resolveAttachmentPath(BACKUP, p);
    const calls = perPathCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toMatchObject({ rule, failedSegment });
    expect(JSON.stringify(calls)).not.toMatch(/passwd|private-file|x\.jpg|x\.db/);
  });

  it.each([
    ["root", "~/Library/Preferences/com.example.plist"],
    ["prefix", "Library/SMS/Attachments/3a/x.jpg"],
    ["empty-segment", "~/Library/SMS/Attachments/3a//x.jpg"],
  ])("does not log benign rule %s per path", (rule, p) => {
    expect(iOSMessagesParser.resolveAttachmentPath(BACKUP, p)).toBeNull();
    expect(log.warn).not.toHaveBeenCalled();
    expect(iOSMessagesParser.flushRejectedPathSummary()).toEqual({ [rule]: 1 });
  });

  it("throttles attack lines per summary window and reports the remainder", () => {
    const limit = iOSMessagesParser.ATTACK_LOG_LIMIT;
    for (let i = 0; i < limit + 3; i++) {
      iOSMessagesParser.resolveAttachmentPath(BACKUP, `~/Library/SMS/Attachments/../${i}.db`);
    }
    expect(perPathCalls()).toHaveLength(limit);
    const counts = iOSMessagesParser.flushRejectedPathSummary();
    expect(counts).toEqual({ "dot-segment": limit + 3, attackLinesSuppressed: 3 });
    expect(log.warn).toHaveBeenLastCalledWith(SUMMARY, counts);

    // The next window logs individually again
    jest.clearAllMocks();
    iOSMessagesParser.resolveAttachmentPath(BACKUP, "~/Library/SMS/Attachments/../again.db");
    expect(perPathCalls()).toHaveLength(1);
  });

  it("summarizes every rule once per window", () => {
    const paths = [
      "/etc/passwd",
      "~/Library/Preferences/x.plist",
      "~/Library/SMS/Attachments/../sms.db",
      "~/Library/SMS/Attachments/a/../../sms.db",
      "~/Library/SMS/Attachments\\x.jpg",
      "~/Library/SMS/Attachments/x\0.jpg",
      "relative/path.jpg",
      "~/Library/SMS/Attachments//x.jpg",
      `~/Library/SMS/Attachments/3a/10/at_0_${GUID}/Offer...pdf`, // accepted
    ];
    for (const p of paths) iOSMessagesParser.resolveAttachmentPath(BACKUP, p);
    jest.clearAllMocks();
    const counts = iOSMessagesParser.flushRejectedPathSummary();
    expect(counts).toEqual({
      absolute: 1,
      root: 1,
      "dot-segment": 2,
      backslash: 1,
      nul: 1,
      prefix: 1,
      "empty-segment": 1,
    });
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(SUMMARY, counts);
  });

  it("resets after flushing and logs nothing when there were no rejections", () => {
    iOSMessagesParser.resolveAttachmentPath(BACKUP, "/etc/passwd");
    iOSMessagesParser.flushRejectedPathSummary();
    jest.clearAllMocks();
    expect(iOSMessagesParser.flushRejectedPathSummary()).toEqual({});
    expect(log.warn).not.toHaveBeenCalled();
  });
});
