/**
 * Crashed-WAL fixture producer (BACKLOG-2993 boundary sweep).
 *
 * Builds an encrypted v70-shape database in WAL mode, leaves committed frames
 * in the -wal file, and SIGKILLs ITSELF so the connection never closes and the
 * WAL is never checkpointed — a real crashed writer, not a simulation. The
 * parent test asserts the -wal survives non-empty, then proves the baseline
 * fence still ACCEPTS the file (version and openability are independent axes).
 *
 * Transcribed from the live experiment run for the SR review addendum: a
 * readonly open+read of exactly this shape SUCCEEDS under
 * better-sqlite3-multiple-ciphers (with and without the -shm), main file hash
 * unchanged.
 *
 * argv: <driverPath> <dbFile> <dumpPath>
 * Exits: SIGKILL on success; exit code 1 with a message on any failure.
 */
/* eslint-disable no-console */
const fs = require("fs");

const [, , driverPath, dbFile, dumpPath] = process.argv;
if (!driverPath || !dbFile || !dumpPath) {
  console.error("usage: hotWalWriter.cjs <driverPath> <dbFile> <dumpPath>");
  process.exit(1);
}

try {
  const Database = require(driverPath);
  const db = new Database(dbFile);
  // EXACTLY the production opener's keying text.
  db.pragma(`key = "x'test-encryption-key-hex'"`);
  db.pragma("cipher_compatibility = 4");
  db.pragma("journal_mode = WAL");
  db.exec(fs.readFileSync(dumpPath, "utf8"));
  // Pad the WAL so "hot" is unambiguous.
  db.exec("CREATE TABLE IF NOT EXISTS _wal_padding (id INTEGER PRIMARY KEY, blob TEXT)");
  const ins = db.prepare("INSERT INTO _wal_padding (blob) VALUES (?)");
  for (let i = 0; i < 200; i++) ins.run("x".repeat(1000));

  const walSize = fs.existsSync(`${dbFile}-wal`) ? fs.statSync(`${dbFile}-wal`).size : 0;
  if (walSize <= 0) {
    console.error("wal file missing or empty — fixture would not be hot");
    process.exit(1);
  }
  console.log(`HOT_WAL_READY wal=${walSize}`);
  // Die without closing: no checkpoint, no clean shutdown.
  process.kill(process.pid, "SIGKILL");
} catch (e) {
  console.error("hotWalWriter failed:", e && e.message ? e.message : String(e));
  process.exit(1);
}
