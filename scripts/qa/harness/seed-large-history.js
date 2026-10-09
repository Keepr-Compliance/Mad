'use strict';
/**
 * BACKLOG-3785 — LARGE-HISTORY fixture seeder (synthetic, no customer data).
 *
 * Adds an iPhone-sized text history to an ISOLATED profile that seed-fixture.js has already
 * provisioned (encrypted mad.db + seeded user/session/license). Shape matches the founder's PC
 * as reported in pm_comments on BACKLOG-3785 (counts only):
 *   ~670k messages across ~2,300 chats (`thread_id = ios-chat-<n>`), ~65k attachment rows,
 *   ~1,186 iPhone contacts with phones, a few transactions.
 * Row shapes are transcribed from the real writers:
 *   messages     <- iPhoneSyncStorageService.storeMessages (participants JSON, participants_flat =
 *                   handle digits, metadata.source = "iphone_sync") + syncDbService.batchInsertMessages
 *   attachments  <- syncDbService.insertAttachment column list
 *   contact_phones.phone_normalized <- phoneNormalization.toLookupKey (E.164 without "+")
 *
 * USAGE (Electron binary — better-sqlite3 is Electron-ABI):
 *   KEEPR_QA_DB_KEY=<hex> node_modules/.bin/electron scripts/qa/harness/seed-large-history.js \
 *     --user-data-dir <isolatedProfile> [--messages 670000] [--chats 2300] [--contacts 1186] \
 *     [--attachments 65000]
 * Run scripts/qa/harness/seed-fixture.js on the same profile with the same KEEPR_QA_DB_KEY first.
 * Refuses the real keepr profile (same guard as seed-fixture.js). Also writes session.json.
 *
 * LAUNCHING against the profile (dev build, never the founder's profile):
 *   HOME=<empty dir> KEEPR_USER_DATA_DIR=<profile> node_modules/.bin/electron . \
 *     --remote-debugging-port=9337 --remote-allow-origins='*'
 * HOME MUST point at an empty directory. On macOS a dev build inherits Full Disk Access from the
 * launching terminal, and the dashboard auto-starts the macOS Messages import (chat.db) and the
 * Contacts read — both resolve paths from process.env.HOME. Without the override the scratch DB
 * fills with the developer's own messages and contacts.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { assertIsolatedProfile } = require('./seed-fixture.js');

function parseArgs(argv) {
  const o = { messages: 670000, chats: 2300, contacts: 1186, attachments: 65000, transactions: 3 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--user-data-dir') o.userDataDir = argv[++i];
    else if (a.startsWith('--')) o[a.slice(2)] = Number(argv[++i]);
  }
  if (!o.userDataDir) throw new Error('--user-data-dir is required');
  return o;
}

// Deterministic PRNG (mulberry32) so two runs build the same corpus.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = (
  'ok sounds good see you then the inspection is scheduled for tuesday can you send the ' +
  'disclosures offer accepted closing date moved lender needs the appraisal thanks call me ' +
  'when you get a chance running late keys are in the lockbox escrow title walkthrough tomorrow'
).split(' ');

function main() {
  const { app } = require('electron');
  app.setName('keepr');
  app.whenReady().then(() => {
    try {
      run(parseArgs(process.argv.slice(2)));
      app.quit();
      process.exit(0);
    } catch (e) {
      process.stderr.write(`seed-large-history error: ${e && e.stack ? e.stack : e}\n`);
      process.exit(2);
    }
  });
}

function run(o) {
  assertIsolatedProfile(o.userDataDir);
  const key = (process.env.KEEPR_QA_DB_KEY || '').trim();
  if (!/^[0-9a-f]{64}$/i.test(key)) throw new Error('KEEPR_QA_DB_KEY (64 hex) is required');
  const Database = require('better-sqlite3-multiple-ciphers');
  const db = new Database(path.join(path.resolve(o.userDataDir), 'mad.db'), { fileMustExist: true });
  db.pragma(`key = "x'${key}'"`);
  db.pragma('cipher_compatibility = 4');
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  const user = db.prepare('SELECT id FROM users_local LIMIT 1').get();
  if (!user) throw new Error('no users_local row — run seed-fixture.js first');
  const userId = user.id;
  // seed-fixture.js stamps HEAD_SCHEMA_VERSION = 61, below the BACKLOG-2993 baseline (70), so the
  // app refuses the DB ("Pre-baseline database refused"). schema.sql IS the baseline structure and
  // stamps its own version; re-stamp to that so the app replays only the post-baseline migrations.
  const schemaSql = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'electron', 'database', 'schema.sql'), 'utf8');
  const stamp = Number((schemaSql.match(/INTO schema_version \(id, version\) VALUES \(1, (\d+)\)/) || [])[1]);
  if (!stamp) throw new Error('could not read the schema_version stamp from schema.sql');
  db.prepare('UPDATE schema_version SET version = ? WHERE id = 1').run(stamp);
  const r = rng(3785);
  const t0 = Date.now();

  // ---- contacts (source iphone) + phones ----
  const phones = [];
  const insC = db.prepare(
    `INSERT OR REPLACE INTO contacts (id, user_id, display_name, source, is_imported) VALUES (?, ?, ?, 'iphone', 1)`,
  );
  const insP = db.prepare(
    `INSERT OR IGNORE INTO contact_phones (id, contact_id, phone_e164, phone_display, phone_normalized, is_primary, source)
     VALUES (?, ?, ?, ?, ?, 1, 'import')`,
  );
  const contactIds = [];
  db.transaction(() => {
    for (let i = 0; i < o.contacts; i++) {
      const id = `c3785000-0000-4000-8000-${String(i).padStart(12, '0')}`;
      const line = String(1000000 + i * 7).slice(-7);
      const e164 = `+1206${line}`;
      insC.run(id, userId, `Synthetic Contact ${i}`);
      insP.run(`${id}-p`, id, e164, `(206) ${line.slice(0, 3)}-${line.slice(3)}`, e164.slice(1));
      phones.push(e164);
      contactIds.push(id);
    }
  })();
  // ~20% of chat handles are numbers with no contact (unknown senders)
  for (let i = 0; i < Math.round(o.contacts * 0.25); i++) phones.push(`+1425${String(2000000 + i * 11).slice(-7)}`);

  // ---- chats: skewed sizes summing to o.messages ----
  const weights = [];
  for (let c = 0; c < o.chats; c++) weights.push(1 / Math.pow(c + 1, 0.9));
  const wsum = weights.reduce((a, b) => a + b, 0);
  const sizes = weights.map((w) => Math.max(1, Math.floor((w / wsum) * o.messages)));
  let short = o.messages - sizes.reduce((a, b) => a + b, 0);
  for (let c = 0; short > 0; c = (c + 1) % o.chats, short--) sizes[c]++;
  const chats = sizes.map((n, c) => {
    const group = r() < 0.1;
    const members = [];
    const k = group ? 2 + Math.floor(r() * 5) : 1;
    for (let j = 0; j < k; j++) members.push(phones[Math.floor(r() * phones.length)]);
    return { id: `ios-chat-${c + 1}`, n, members };
  });

  // ---- messages ----
  const insM = db.prepare(
    `INSERT OR IGNORE INTO messages (
      id, user_id, channel, external_id, direction, body_text, participants, participants_flat, thread_id,
      sent_at, has_attachments, message_type, metadata, sync_session_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, CURRENT_TIMESTAMP)`,
  );
  const insA = db.prepare(
    `INSERT OR IGNORE INTO attachments (id, message_id, external_message_id, filename, mime_type, file_size_bytes, storage_path, sync_session_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, CURRENT_TIMESTAMP)`,
  );
  const lastByPhone = new Map();
  const attachEvery = Math.max(1, Math.floor(o.messages / o.attachments));
  const start = Date.parse('2016-01-01T00:00:00Z');
  const span = Date.parse('2026-10-01T00:00:00Z') - start;
  let m = 0;
  let a = 0;
  const BATCH = 10000;
  let pending = [];
  const flush = db.transaction((rows) => {
    for (const row of rows) {
      insM.run(row.m);
      if (row.a) insA.run(row.a);
    }
  });
  for (const chat of chats) {
    const base = start + Math.floor(r() * span * 0.5);
    const step = Math.max(60000, Math.floor((start + span - base) / chat.n));
    for (let i = 0; i < chat.n; i++) {
      const handle = chat.members[Math.floor(r() * chat.members.length)];
      const out = r() < 0.45;
      let body = '';
      const len = 3 + Math.floor(r() * 18);
      for (let w = 0; w < len; w++) body += (w ? ' ' : '') + WORDS[Math.floor(r() * WORDS.length)];
      const sent = new Date(base + i * step + Math.floor(r() * step)).toISOString();
      const guid = crypto.randomUUID().toUpperCase();
      const id = crypto.randomUUID();
      const hasAtt = (m % attachEvery === 0 && a < o.attachments) ? 1 : 0;
      const participants = JSON.stringify(
        chat.members.length > 1
          ? { from: out ? 'me' : handle, to: out ? chat.members : ['me', ...chat.members.filter((p) => p !== handle)] }
          : { from: out ? 'me' : handle, to: out ? [handle] : ['me'] },
      );
      const metadata = JSON.stringify({
        source: 'iphone_sync', originalId: m + 1, dateRead: null, dateDelivered: null, attachmentCount: hasAtt,
      });
      pending.push({
        m: [id, userId, r() < 0.8 ? 'imessage' : 'sms', guid, out ? 'outbound' : 'inbound', body, participants,
          handle.replace(/\D/g, ''), chat.id, sent, hasAtt, hasAtt ? 'attachment_only' : 'text', metadata],
        a: hasAtt
          ? [crypto.randomUUID(), id, guid, `IMG_${a}.jpeg`, 'image/jpeg', 100000 + Math.floor(r() * 3e6),
            path.join('attachments', `${a}.jpeg`)]
          : null,
      });
      if (hasAtt) a++;
      for (const p of chat.members) {
        const k = p.slice(1);
        if (!lastByPhone.has(k) || lastByPhone.get(k) < sent) lastByPhone.set(k, sent);
      }
      m++;
      if (pending.length >= BATCH) { flush(pending); pending = []; }
    }
  }
  if (pending.length) flush(pending);

  const insL = db.prepare('INSERT OR REPLACE INTO phone_last_message (phone_normalized, user_id, last_message_at) VALUES (?, ?, ?)');
  db.transaction(() => { for (const [k, v] of lastByPhone) insL.run(k, userId, v); })();

  // ---- extra transactions, each with a few contacts assigned ----
  const insT = db.prepare(
    `INSERT OR REPLACE INTO transactions (id, user_id, property_address, property_street, property_city, property_state,
      property_zip, transaction_type, status, started_at, created_at, skip_address_filter)
     VALUES (?, ?, ?, ?, 'Seattle', 'WA', '98115', 'purchase', 'active', '2025-01-01', '2025-01-01', 1)`,
  );
  const insTC = db.prepare('INSERT OR REPLACE INTO transaction_contacts (id, transaction_id, contact_id, role) VALUES (?, ?, ?, ?)');
  db.transaction(() => {
    for (let t = 0; t < o.transactions; t++) {
      const tid = `b3785000-0000-4000-8000-${String(t).padStart(12, '0')}`;
      insT.run(tid, userId, `${100 + t} Synthetic Ave, Seattle, WA 98115`, `${100 + t} Synthetic Ave`);
      for (let j = 0; j < 4; j++) insTC.run(`${tid}-tc${j}`, tid, contactIds[t * 4 + j], j === 0 ? 'buyer' : 'other');
    }
  })();

  db.pragma('wal_checkpoint(TRUNCATE)');
  db.prepare('ANALYZE').run();
  const counts = {
    messages: db.prepare('SELECT COUNT(*) n FROM messages').get().n,
    threads: db.prepare('SELECT COUNT(DISTINCT thread_id) n FROM messages').get().n,
    attachments: db.prepare('SELECT COUNT(*) n FROM attachments').get().n,
    contacts: db.prepare('SELECT COUNT(*) n FROM contacts').get().n,
    transactions: db.prepare('SELECT COUNT(*) n FROM transactions').get().n,
    seconds: Math.round((Date.now() - t0) / 1000),
  };
  // session.json (plaintext; the app wraps it on first read) — same shape as
  // e2e/driver/seed/seedProfile.ts writeSessionJson, plus accountSetupFinishedAt: the
  // BACKLOG-3673 offline cache of the account-setup record. Without it, an offline profile
  // stops at "Couldn't load your account settings" (ACCOUNT_SETUP_UNAVAILABLE).
  const u = db.prepare('SELECT id, email, oauth_provider FROM users_local LIMIT 1').get();
  const sess = db.prepare('SELECT session_token, expires_at FROM sessions WHERE user_id = ? LIMIT 1').get(u.id);
  const now = Date.now();
  fs.writeFileSync(path.join(path.resolve(o.userDataDir), 'session.json'), JSON.stringify({
    user: { id: u.id, email: u.email, display_name: 'QA Seed' },
    sessionToken: sess.session_token,
    provider: u.oauth_provider,
    expiresAt: new Date(sess.expires_at).getTime(),
    createdAt: now, savedAt: now, lastServerValidatedAt: now,
    accountSetupFinishedAt: new Date(now).toISOString(),
  }, null, 2), 'utf8');
  db.close();
  process.stdout.write(`__LARGE_SEED__ ${JSON.stringify(counts)}\n`);
}

const isEntry = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);
if (isEntry) main();

module.exports = { parseArgs };
