/**
 * BACKLOG-4050: crash-report text rules.
 *   C4 / C4s  profile folder name -> [user]; boundary sweep (SR A5)
 *   C5 / C5s  address inside app-generated export names -> [address]
 *   C9 / C9s  user-chosen file names -> [file]; app-owned paths kept (SR A6)
 * Synthetic data only.
 */
import {
  redactCrashReportText,
  redactExportFileNames,
  redactLocalPaths,
  redactUserFileNames,
  redactUserProfile,
} from "../redactSensitive";

// Windows install (per-user, electron-builder oneClick) under the profile.
const WIN_RESOURCES = String.raw`C:\Users\Jane Doe\AppData\Local\Programs\keepr\resources`;
const WIN_APP_ROOTS = [WIN_RESOURCES, String.raw`C:\Users\Jane Doe\AppData\Roaming\keepr`];

describe("BACKLOG-4050 C4: redactUserProfile boundary sweep", () => {
  // [input, expected]. Every row: the name is gone and the rest is kept.
  const rows: Array<[string, string]> = [
    [String.raw`C:\Users\Jane\x`, String.raw`C:\Users\[user]\x`],
    [String.raw`C:\Users\Jane Doe\x`, String.raw`C:\Users\[user]\x`],
    [String.raw`C:\Users\Jane  Doe\x`, String.raw`C:\Users\[user]\x`],
    ["c:/users/jane doe/x", "c:/users/[user]/x"],
    [String.raw`C:\\Users\\Jane Doe\\AppData`, String.raw`C:\\Users\\[user]\\AppData`],
    [String.raw`\\?\C:\Users\Jane Doe\x`, String.raw`\\?\C:\Users\[user]\x`],
    [String.raw`C:\Users\JANEDO~1\AppData\Local\Temp\x`, String.raw`C:\Users\[user]\AppData\Local\Temp\x`],
    [String.raw`D:\Users\Jane Doe\x`, String.raw`D:\Users\[user]\x`],
    [String.raw`mkdir 'C:\Users\Jane Doe'`, String.raw`mkdir 'C:\Users\[user]'`],
    [String.raw`EPERM at C:\Users\Jane Doe`, String.raw`EPERM at C:\Users\[user]`],
    [String.raw`C:\Users\Sean O'Brien\AppData\x`, String.raw`C:\Users\[user]\AppData\x`],
    [String.raw`mkdir 'C:\Users\Sean O'Brien'`, String.raw`mkdir 'C:\Users\[user]'`],
    [String.raw`C:\Users\José Núñez\x`, String.raw`C:\Users\[user]\x`],
    ["/Users/Jane Doe/Downloads/x", "/Users/[user]/Downloads/x"],
    ["/home/jane doe/x", "/home/[user]/x"],
    ["file:///Users/Jane Doe/x", "file:///Users/[user]/x"],
  ];

  it.each(rows)("%s", (input, expected) => {
    expect(redactUserProfile(input)).toBe(expected);
  });

  it("over-redaction bound: an unquoted name with no separator after it stops at the newline", () => {
    const out = redactUserProfile(String.raw`C:\Users\Jane Doe could not open x` + "\nEACCES: permission denied");
    expect(out).toBe(String.raw`C:\Users\[user]` + "\nEACCES: permission denied");
  });

  it("over-redaction bound: no boundary within 64 characters still loses the name", () => {
    const out = redactUserProfile(String.raw`C:\Users\Jane Doe ` + "y".repeat(80));
    expect(out).not.toContain("Jane");
    expect(out).not.toContain("Doe");
  });

  it("a profile outside Users/home is caught through homeDir", () => {
    const out = redactUserProfile(String.raw`open 'D:\Profiles\Jane Doe\Desktop\x'`, String.raw`D:\Profiles\Jane Doe`);
    expect(out).toBe(String.raw`open 'D:\Profiles\[user]\Desktop\x'`);
  });

  it("is idempotent", () => {
    const once = redactUserProfile(String.raw`spawn C:\Users\Jane Doe\x.exe ENOENT`);
    expect(redactUserProfile(once)).toBe(once);
  });
});

describe("BACKLOG-4050 C4s: non-profile text is unchanged", () => {
  it.each([
    String.raw`C:\Program Files\Keepr\resources\x.dll`,
    "https://host.example.com/home/a/b",
    "https://host.example.com/Users/a/b",
    "GET /rest/v1/transactions failed with 500",
    "ENOENT: no such file or directory",
    // pii-allow-uuid: invented all-zero fixture id, not from any live row
    "id 00000000-0000-4000-8000-000000000001",
  ])("%s", (input) => {
    expect(redactUserProfile(input)).toBe(input);
  });
});

describe("BACKLOG-4050: redactLocalPaths no longer leaks a spaced username (the named defect)", () => {
  it("Windows and macOS spaced profiles become one <path>", () => {
    expect(redactLocalPaths(String.raw`spawn C:\Users\Jane Doe\AppData\x.exe ENOENT`)).toBe("spawn <path> ENOENT");
    expect(redactLocalPaths("open '/Users/Jane Doe/Downloads/x.pdf'")).toBe("open '<path>'");
  });

  it("the documented example still holds", () => {
    expect(redactLocalPaths("EACCES: /Users/jane/Library/x")).toBe("EACCES: <path>");
  });
});

describe("BACKLOG-4050 C5 / C5s: export names", () => {
  it.each([
    ["Transaction_742_Evergreen_Terrace_Springfield_IL_62704_1729800000000.pdf", "Transaction_[address]_1729800000000.pdf"],
    ["Transaction_Summary_742_Evergreen_Terrace_1729800000000.pdf", "Transaction_Summary_[address]_1729800000000.pdf"],
    ["Transaction_Full_742_Evergreen_Terrace_1729800000000.pdf", "Transaction_Full_[address]_1729800000000.pdf"],
    ["Transaction_742_Evergreen_Terrace_1729800000000.xlsx", "Transaction_[address]_1729800000000.xlsx"],
    ["/x/Transaction_742_Evergreen_Terrace_1729800000000/a.eml", "/x/Transaction_[address]_1729800000000/a.eml"],
    ["/x/742_Evergreen_Terrace_Combined_Report.pdf", "/x/[address]_Combined_Report.pdf"],
    ["/x/742_Evergreen_Terrace_Export_1729800000000/y", "/x/[address]_Export_1729800000000/y"],
  ])("%s", (input, expected) => {
    expect(redactExportFileNames(input)).toBe(expected);
  });

  it("C5: an fs error on an export loses the address and the profile, keeps code, directory and timestamp", () => {
    const out = redactCrashReportText(
      "EACCES: permission denied, open '/Users/Jane Doe/Downloads/Transaction_742_Evergreen_Terrace_1729800000000.pdf'",
    );
    expect(out).toBe("EACCES: permission denied, open '/Users/[user]/Downloads/Transaction_[address]_1729800000000.pdf'");
  });
});

describe("BACKLOG-4050 C9 / C9s: user-chosen file names", () => {
  it("C9: a chosen name on macOS loses name and number, keeps the code and directory", () => {
    const out = redactCrashReportText("ENOENT: no such file or directory, open '/Users/Jane Doe/Desktop/Smith 742 Elm.pdf'");
    expect(out).toBe("ENOENT: no such file or directory, open '/Users/[user]/Desktop/[file]'");
  });

  it("C9: a chosen name on another Windows drive", () => {
    const out = redactCrashReportText(String.raw`EPERM: operation not permitted, open 'D:\Clients\Smith deal.xlsx'`);
    expect(out).toBe(String.raw`EPERM: operation not permitted, open 'D:\Clients\[file]'`);
  });

  it("C9: an unquoted path loses its final segment, keeps line and column", () => {
    expect(redactUserFileNames("at f (/Users/[user]/dev/Smith.js:10:5)")).toBe("at f (/Users/[user]/dev/[file]:10:5)");
  });

  it("C9s: the app's own paths are kept", () => {
    const resourcesExe = String.raw`C:\Users\[user]\AppData\Local\Programs\keepr\resources\win\libimobiledevice\idevice_id.exe`;
    expect(redactUserFileNames(`spawn ${resourcesExe} ENOENT`, WIN_APP_ROOTS)).toBe(`spawn ${resourcesExe} ENOENT`);
    const asar = "/Applications/Keepr.app/Contents/Resources/app.asar/dist-electron/main.js";
    expect(redactUserFileNames(`at x (${asar}:1:2)`)).toBe(`at x (${asar}:1:2)`);
    expect(redactUserFileNames("open '/usr/lib/libsqlite3.dylib'")).toBe("open '/usr/lib/libsqlite3.dylib'");
  });

  it("C9s: a root passed by the host is exempt even when the root itself holds the profile name", () => {
    const db = String.raw`open 'C:\Users\Jane Doe\AppData\Roaming\keepr\mad.db'`;
    expect(redactCrashReportText(db, { appRoots: WIN_APP_ROOTS })).toBe(String.raw`open 'C:\Users\[user]\AppData\Roaming\keepr\mad.db'`);
    expect(redactCrashReportText(db)).toBe(String.raw`open 'C:\Users\[user]\AppData\Roaming\keepr\[file]'`);
  });

  it("C9s: a redirected profile (homeDir outside Users) still matches its app root", () => {
    const home = String.raw`D:\Profiles\Jane Doe`;
    const root = String.raw`D:\Profiles\Jane Doe\AppData\Local\Programs\keepr-x\resources`;
    const out = redactCrashReportText(String.raw`spawn ${root}\win\tool.exe ENOENT`, { homeDir: home, appRoots: [root] });
    expect(out).toBe(String.raw`spawn D:\Profiles\[user]\AppData\Local\Programs\keepr-x\resources\win\tool.exe ENOENT`);
  });

  it("C9s: URL paths and placeholders are left alone", () => {
    expect(redactUserFileNames("GET /rest/v1/transactions failed")).toBe("GET /rest/v1/transactions failed");
    expect(redactUserFileNames("https://host.example.com/a/b.pdf")).toBe("https://host.example.com/a/b.pdf");
    expect(redactUserFileNames("open '/Users/[user]'")).toBe("open '/Users/[user]'");
  });
});

describe("BACKLOG-4050 C8 (text half): record ids pass every rule unchanged", () => {
  it("transaction and contact ids", () => {
    // pii-allow-uuid: invented all-zero fixture id, not from any live row
    const text = "txn 00000000-0000-4000-8000-000000000001 contact 00000000-0000-4000-8000-000000000002";
    expect(redactCrashReportText(text, { homeDir: "/Users/Jane Doe", appRoots: WIN_APP_ROOTS })).toBe(text);
  });
});

// BACKLOG-4050 S-1: system and app-support paths stay visible; Library folders
// that hold user files do not.
describe("BACKLOG-4050 S-1: /Library paths", () => {
  it("support survives: Messages/chat.db and Application Support names are kept", () => {
    expect(redactUserFileNames("SQLITE_CANTOPEN '/Users/[user]/Library/Messages/chat.db'")).toBe("SQLITE_CANTOPEN '/Users/[user]/Library/Messages/chat.db'");
    expect(redactUserFileNames("open /Users/[user]/Library/Application Support/keepr/mad.db")).toContain("/Users/[user]/Library/Application");
    expect(redactUserFileNames("EACCES /Library/Preferences/x.plist")).toBe("EACCES /Library/Preferences/x.plist");
  });

  it("leak control: a file under Mobile Documents or CloudStorage still becomes [file]", () => {
    expect(redactUserFileNames("open '/Users/[user]/Library/Mobile Documents/com~apple~CloudDocs/Smith deal.pdf'")).toBe(
      "open '/Users/[user]/Library/Mobile Documents/com~apple~CloudDocs/[file]'",
    );
    expect(redactUserFileNames("open '/Users/[user]/Library/CloudStorage/Dropbox/Smith deal.pdf'")).toBe(
      "open '/Users/[user]/Library/CloudStorage/Dropbox/[file]'",
    );
  });

  it("D-1: Messages/Attachments file becomes [file]", () => {
    expect(redactUserFileNames("open '/Users/[user]/Library/Messages/Attachments/ab/12/AB12-GUID/742 Elm St purchase agreement.pdf'")).toBe(
      "open '/Users/[user]/Library/Messages/Attachments/ab/12/AB12-GUID/[file]'",
    );
  });

  it("D-1: a bare file directly under Library becomes [file]", () => {
    expect(redactUserFileNames("save failed '/Users/[user]/Library/Smith audit export.pdf'")).toBe("save failed '/Users/[user]/Library/[file]'");
  });

  it("D-1: Mail and Group Containers files become [file]", () => {
    expect(redactUserFileNames("open '/Users/[user]/Library/Mail/V10/ABC/Attachments/Smith deal.pdf'")).toBe(
      "open '/Users/[user]/Library/Mail/V10/ABC/Attachments/[file]'",
    );
    expect(redactUserFileNames("open '/Users/[user]/Library/Group Containers/UBF8T346G9.Office/Outlook/Smith deal.pdf'")).toBe(
      "open '/Users/[user]/Library/Group Containers/UBF8T346G9.Office/Outlook/[file]'",
    );
  });

  it("D-1: chat.db (and -wal/-shm) and an Application Support path are kept", () => {
    expect(redactUserFileNames("open '/Users/[user]/Library/Messages/chat.db-wal'")).toBe("open '/Users/[user]/Library/Messages/chat.db-wal'");
    expect(redactUserFileNames("open '/Users/[user]/Library/Application Support/keepr/mad.db'")).toBe(
      "open '/Users/[user]/Library/Application Support/keepr/mad.db'",
    );
  });

  it("a folder merely named Library elsewhere is not exempt", () => {
    expect(redactUserFileNames("open '/Users/[user]/Documents/Library/Smith deal.pdf'")).toBe("open '/Users/[user]/Documents/Library/[file]'");
  });
});
