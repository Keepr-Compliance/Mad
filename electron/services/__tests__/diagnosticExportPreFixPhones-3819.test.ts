/**
 * BACKLOG-3819 (SR decision, option c) — logs already on disk are NOT
 * re-scrubbed at launch. Lines written before the key-context rule existed can
 * still hold a bare phone under a "phone" key; the guarantee is that the
 * diagnostic EXPORT re-runs the redactor over every line and removes them.
 *
 * The pre-fix lines are written straight to disk (sealed and plaintext),
 * bypassing the sink hook, exactly as an older build left them. The JSON block
 * is produced by JSON.stringify(metadata, null, 2), as logService formats it.
 * Synthetic numbers only.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { sealLogText } from "../atRest/sealedLog";
import { buildDiagnosticLogText } from "../diagnosticLogExport";

const KEY = { keyId: "66".repeat(16), key: Buffer.alloc(32, 6) };
const P1 = "5555550131";
const P2 = "5555550132";
const P3 = "5555550133";
const P4 = "5555550134";

const preFixBlock = (phone: string) =>
  "[2026-10-08 09:00:00.000] [info]  2026-10-08T09:00:00.000Z INFO  [ContactDbService] Backfill: Found phone-message matches\n" +
  JSON.stringify(
    { matchCount: 1, samples: [{ contactId: "a1b2c3d4", phone, lastDate: "2026-10-01T12:00:00.000Z" }] },
    null,
    2,
  ) +
  "\n[2026-10-08 09:00:01.000] [info]  backup-estimate bytes=6013820953\n";

describe("BACKLOG-3819: the export redacts pre-fix bare phones still on disk", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-export-3819-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("sealed main.log, sealed archive, plaintext fallback and in-memory lines", () => {
    const main = path.join(dir, "main.log");
    fs.writeFileSync(path.join(dir, "main.old.log"), sealLogText(preFixBlock(P1), KEY));
    fs.writeFileSync(main, sealLogText(preFixBlock(P2), KEY));
    fs.writeFileSync(path.join(dir, "main.unsealed.log"), preFixBlock(P3));
    const built = buildDiagnosticLogText(dir, {
      keyFor: (id) => (id === KEY.keyId ? KEY.key : null),
      pending: [{ file: main, text: preFixBlock(P4) }],
    });
    const t = built.text;
    // every source really made it into the export (guards against a vacuous pass)
    expect(built.files.map((f) => [f.name, f.status])).toEqual([
      ["main.old.log", "sealed"],
      ["main.log", "sealed"],
      ["main.unsealed.log", "plaintext"],
    ]);
    expect(t.match(/Found phone-message matches/g)).toHaveLength(4);
    for (const p of [P1, P2, P3, P4]) expect(t).not.toContain(p);
    for (const tail of ["31", "32", "33", "34"]) expect(t).toContain(`"phone": "***${tail}"`);
    // diagnostics intact
    expect(t.match(/bytes=6013820953/g)).toHaveLength(4);
    expect(t.match(/"contactId": "a1b2c3d4"/g)).toHaveLength(4);
  });
});
