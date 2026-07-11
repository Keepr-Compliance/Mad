'use strict';
/**
 * QA Harness — encrypted-DB FIXTURE SEEDER (BACKLOG-1940 pivot).
 *
 * Standalone Electron-MAIN script. Opens the app's OWN encrypted SQLite DB in an ISOLATED
 * QA profile using the app's OWN cipher pragmas + the profile's DB key (from safeStorage),
 * then raw-INSERTs a KNOWN fixture so the reliable QA driver has real content to navigate:
 *   - 1 users_local (the seeded account)
 *   - 1 sessions row  (session_token MUST match the seeded session.json → getCurrentUser passes)
 *   - N contacts + contact_emails
 *   - >=1 transaction (a real property the driver's clickFirstTransaction() opens)
 *   - a few emails + communications links (so the transaction has attached content)
 *
 * SAFETY — ISOLATED PROFILE ONLY:
 *   - Requires --user-data-dir <isolated profile>. It REFUSES to run against the real
 *     ~/Library/Application Support/keepr profile (guard below). It NEVER touches real data.
 *   - The isolated profile's DB + key are created by launching the app once on that profile
 *     first (DB init runs at boot, before login) — see e2e/driver/seed/seedProfile.ts.
 *
 * WHY ELECTRON: the DB key is only reachable via Electron `safeStorage`, and
 * better-sqlite3-multiple-ciphers is built against Electron's ABI (Homebrew sqlcipher can't
 * read this DB). Mirrors scripts/qa/harness/db-assert.js (H3 cipher-open).
 *
 * USAGE (via the app electron binary, NOT node):
 *   node_modules/.bin/electron scripts/qa/harness/seed-fixture.js \
 *     --user-data-dir <isolatedProfile> [--fixture <path.json>] [--out <resultPath>]
 *
 * The seeded IDENTITY (user id, session token, first transaction id/address) is emitted as a
 * single sentinel-prefixed JSON line on stdout AND written to --out, so the TS wrapper can wire
 * the session.json token + assert the driver lands on the seeded transaction.
 *
 * EXIT CODES: 0 = seeded · 2 = usage / IO / decrypt / uncaught error.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SENTINEL = '__QA_SEED_JSON__ ';

/**
 * Deterministic email_participants.participant_hash: SHA-256 of
 * `email_id|role|position|email_address` (per the schema note at electron/database/schema.sql).
 * Stable cross-row dedup key; also a future embedding key. Kept in sync with the app's
 * participant-hash convention (BACKLOG-1722).
 */
function participantHash(emailId, role, position, emailAddress) {
  return crypto.createHash('sha256').update(`${emailId}|${role}|${position}|${emailAddress}`).digest('hex');
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--user-data-dir') opts.userDataDir = argv[++i];
    else if (a === '--fixture') opts.fixture = argv[++i];
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '--help' || a === '-h') opts.help = true;
    // ignore Electron's own flags
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Safety: never seed the real profile
// ---------------------------------------------------------------------------

function assertIsolatedProfile(userDataDir) {
  if (!userDataDir) {
    throw new Error('seed-fixture requires --user-data-dir <isolated profile>.');
  }
  const resolved = path.resolve(userDataDir);
  const home = require('os').homedir();
  const realMac = path.join(home, 'Library', 'Application Support', 'keepr');
  const realMacCap = path.join(home, 'Library', 'Application Support', 'Keepr');
  if (resolved === realMac || resolved === realMacCap) {
    throw new Error(`REFUSING to seed the REAL keepr profile at ${resolved}. Use an isolated --user-data-dir.`);
  }
}

// ---------------------------------------------------------------------------
// Key retrieval — replicates databaseEncryptionService key read (safeStorage)
// ---------------------------------------------------------------------------

function getEncryptionKey(userDataPath) {
  const explicit = process.env.KEEPR_QA_DB_KEY;
  if (explicit) return explicit.trim();

  const { safeStorage } = require('electron');
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS encryption (safeStorage) unavailable — cannot read the profile DB key.');
  }
  const keyStorePath = path.join(userDataPath, 'db-key-store.json');
  if (!fs.existsSync(keyStorePath)) {
    throw new Error(`Key store not found at ${keyStorePath}. Launch the app once on this profile first.`);
  }
  const store = JSON.parse(fs.readFileSync(keyStorePath, 'utf8'));
  if (!store.encryptedKey) throw new Error(`Key store at ${keyStorePath} has no encryptedKey.`);
  return safeStorage.decryptString(Buffer.from(store.encryptedKey, 'base64'));
}

// ---------------------------------------------------------------------------
// DB creation — provision the encrypted mad.db + db-key-store.json + baseline schema
// EXACTLY as the app does, but self-contained (no heavy app-service import, which hangs
// on the full IPC/Sentry/migration graph). This runs UNDER Electron on the isolated
// --user-data-dir so safeStorage wraps the key the same way the app would.
//
// We avoid the app's renderer/onboarding flow, which DEFERS first-time-macOS DB init to the
// secure-storage onboarding step (so a fresh profile never auto-creates the DB). The app then
// migrates this baseline (schema_version 32) forward on its next launch — schema.sql is fully
// IF NOT EXISTS and migrations are version-based + idempotent, so the seeded rows survive.
// ---------------------------------------------------------------------------

/**
 * Provision the DB key + db-key-store.json (app format).
 *
 * BACKLOG-1950 SINGLE-INSTANCE / NO-KEYCHAIN: when KEEPR_QA_DB_KEY is set (the address-filter cell
 * always sets a FIXED key), use it DIRECTLY — no safeStorage decrypt/encrypt. This lets the seeder
 * AND every reader (count-linked / db-assert / clear-linked, all via `--key`) share one known key
 * with ZERO keychain prompts and NO extra Electron process to decrypt it. We still write
 * db-key-store.json (best-effort, only if safeStorage is available) so the app's own launch path,
 * which reads the key via safeStorage, keeps working — but with an env key set, that path is driven
 * with the SAME env key, so the store is not required to open the DB.
 */
function provisionKeyStore(userDataPath) {
  const crypto = require('crypto');
  const explicit = process.env.KEEPR_QA_DB_KEY;
  if (explicit) {
    const keyHex = explicit.trim();
    // Best-effort store write (app format) — never fatal if safeStorage is unavailable, because the
    // env key is authoritative for both seeding and reads in this mode.
    try {
      const { safeStorage } = require('electron');
      if (safeStorage.isEncryptionAvailable()) {
        const encryptedBase64 = safeStorage.encryptString(keyHex).toString('base64');
        const keyStore = {
          encryptedKey: encryptedBase64,
          metadata: { keyId: crypto.randomUUID(), createdAt: new Date().toISOString(), version: 1 },
        };
        fs.writeFileSync(path.join(userDataPath, 'db-key-store.json'), JSON.stringify(keyStore, null, 2), 'utf8');
      }
    } catch {
      /* best-effort — env key is authoritative */
    }
    return keyHex;
  }

  const { safeStorage } = require('electron');
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS encryption (safeStorage) unavailable — cannot provision the DB key.');
  }
  const keyHex = crypto.randomBytes(32).toString('hex');
  const encryptedBase64 = safeStorage.encryptString(keyHex).toString('base64');
  const keyStore = {
    encryptedKey: encryptedBase64,
    metadata: { keyId: crypto.randomUUID(), createdAt: new Date().toISOString(), version: 1 },
  };
  fs.writeFileSync(path.join(userDataPath, 'db-key-store.json'), JSON.stringify(keyStore, null, 2), 'utf8');
  return keyHex;
}

function ensureDbInitialized(userDataPath) {
  fs.mkdirSync(userDataPath, { recursive: true });
  const dbPath = path.join(userDataPath, 'mad.db');
  if (fs.existsSync(dbPath)) return; // already provisioned

  const repoRoot = findRepoRoot(__dirname);
  const schemaPath = path.join(repoRoot, 'electron', 'database', 'schema.sql');
  if (!fs.existsSync(schemaPath)) {
    throw new Error(`schema.sql not found at ${schemaPath}.`);
  }
  const schemaSql = fs.readFileSync(schemaPath, 'utf8');
  const key = provisionKeyStore(userDataPath);

  const Database = require('better-sqlite3-multiple-ciphers');
  const db = new Database(dbPath);
  try {
    db.pragma(`key = "x'${key}'"`);
    db.pragma('cipher_compatibility = 4');
    db.pragma('foreign_keys = ON');
    db.exec(schemaSql); // creates the full baseline schema (all IF NOT EXISTS)
  } finally {
    db.close();
  }
  if (!fs.existsSync(dbPath)) {
    throw new Error(`Failed to create ${dbPath}.`);
  }
}

function findRepoRoot(startDir) {
  let dir = startDir;
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return startDir;
}

// ---------------------------------------------------------------------------
// DB open (writable) — replicates the app's cipher pragmas exactly
// ---------------------------------------------------------------------------

function openDbForWrite(dbPath, hexKey) {
  const Database = require('better-sqlite3-multiple-ciphers');
  const db = new Database(dbPath, { fileMustExist: true });
  db.pragma(`key = "x'${hexKey}'"`);
  db.pragma('cipher_compatibility = 4');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  // Force a read to fail fast on a bad key.
  db.prepare('SELECT COUNT(*) AS n FROM sqlite_master').get();
  return db;
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Fixture constants — the DETERMINISTIC address-filter corpus (BACKLOG-1947).
//
// The whole point of this fixture is to make the app's address-filter toggle
// (transactions.skip_address_filter, a per-transaction LINKING-POLICY switch —
// BACKLOG-1867) assert EXACT linked-email counts, the fixture analog of the real
// 69/37. Everything below is grounded in the app's OWN linking logic so the
// fixture's match/no-match classification mirrors what the app actually does:
//
//   - filter-OFF (skip_address_filter = 1, "link all"): an email links iff a
//     transaction contact is a PARTICIPANT (email_participants.email_address IN
//     the contacts' addresses) AND sent_at is inside the transaction date window.
//     See autoLinkService.findEmailsByContactEmails (the email_participants
//     junction) + emailDateRange.computeTransactionDateRange.
//   - filter-ON  (skip_address_filter = 0, address filter APPLIED): the OFF set
//     AND subject/body contains ALL address tokens (substring LIKE per token).
//     Tokens = normalizeAddress("742 Birchwood Lane NE") =
//     ["742","birchwood","lane","ne"]  (only a TRAILING street suffix is popped;
//     the last token "ne" is not a suffix, so "lane" is kept). filter-ON ⊆ OFF.
//
// DATE-WINDOW INVARIANT (load-bearing — see docs/qa/scenarios/fixture-filter-counts.json
// and e2e/tests/filter-toggle-counts.spec.ts): the H3 derived-query oracle
// (db-set-diff-core.buildDerivedQuery) intentionally OMITS the sent_at window
// (deferred to BACKLOG-1887/FU-1), while the RUNTIME linker enforces it. They can
// only agree if EVERY COUNTED email is inside the window. So the transaction uses a
// FIXED past started_at and every email a FIXED in-window sent_at; the window is
// [WINDOW_START, today] because closed_at is null (end defaults to now). We do NOT
// seed any out-of-window email (SR Option A) — an out-of-window participant+address
// match would be counted by the windowless oracle but excluded by the windowed
// runtime, a FALSE divergence caused by the fixture rather than the app.
// ---------------------------------------------------------------------------

/** Fixed transaction start — the lower bound of computeTransactionDateRange (closed_at=null → end=today). */
const FIXTURE_WINDOW_START = '2026-01-01T00:00:00.000Z';
/** Property address whose tokens drive the filter-ON subset. */
const FIXTURE_ADDRESS = '742 Birchwood Lane NE, Seattle, WA 98115';

// ---------------------------------------------------------------------------
// BACKLOG-1982 (delete-emails cell): the DETERMINISTIC thread structure.
//
// The delete-emails cell (e2e/tests/delete-emails.spec.ts) must assert BOTH a
// singleton unlink AND a THREAD-EXPANSION unlink with EXACT, deterministic counts.
// The app's unlinkCommunication expands to every sibling communications row that
// shares the same thread_id in the transaction (transactionService.ts), and
// autoLink copies emails.thread_id → communications.thread_id — so controlling
// emails.thread_id controls the expansion.
//
// This structure is applied ONLY when KEEPR_QA_DELETE_EMAILS_THREADS === '1'. The
// DEFAULT seed path (env unset) leaves every email's thread_id NULL — BYTE-IDENTICAL
// to before — so the BACKLOG-1950 fixture-filter-counts fidelity guard is unaffected
// (it never reads thread_id, and this map is applied via a SEPARATE post-insert UPDATE,
// not by changing the default emails INSERT column list). Precedent for env-gating the
// seed: KEEPR_QA_START_SKIP_FILTER / KEEPR_QA_UNASSIGN_CONTACTS.
//
//   THREAD A = match-1 + match-2  (a 2-email thread → unlinking one expands to BOTH)
//   THREAD B = match-3            (a 1-email thread that STILL carries a thread_id)
//   match-4  = NULL thread_id     (a singleton with NO thread_id → no backend expansion)
//
// NOTE (load-bearing, SR-reviewed): the sibling-expansion SQL requires the link row's
// message_id to be NULL/'' (c.message_id IS NULL OR c.message_id = ''). The seeded emails
// carry NO message_id and auto-link's INSERT omits it, so expansion fires. Do NOT add a
// message_id to these emails/links or expansion silently degrades to a 1-row unlink.
const DELETE_EMAILS_THREAD_MAP = {
  'qa-seed-email-match-1': 'qa-seed-thread-A',
  'qa-seed-email-match-2': 'qa-seed-thread-A',
  'qa-seed-email-match-3': 'qa-seed-thread-B',
  // qa-seed-email-match-4 intentionally omitted → NULL thread_id (singleton, no expansion)
};

// BACKLOG-1949: the 3 QA contacts MUST have VALID UUIDs. The seeder inserts them via INSERT OR REPLACE
// (bypassing validation), but the app's Edit-Contacts SAVE path runs the REAL UUID validator (the same
// guard already applied to userId/txId above) and correctly REJECTS a non-UUID contact id with
// "Validation error: Contact ID must be a valid UUID", writing nothing. Previously these ids were the
// literals `qa-seed-contact-1/2/3`, so the add-users-with-roles cell's Save failed and the junction came
// back empty (HARNESS_ERROR). These are FIXED, deterministic, clearly-synthetic UUIDv4 values (the `19`
// tail echoes BACKLOG-1949) — so re-seeds stay idempotent and the cell can reference the identical ids.
// SINGLE SOURCE OF TRUTH: users-roles-core.ts mirrors these; a qa:test cross-check asserts they match.
const QA_SEED_CONTACT_IDS = {
  1: '00000000-0000-4000-8000-000000001941',
  2: '00000000-0000-4000-8000-000000001942',
  3: '00000000-0000-4000-8000-000000001943',
};

/** The default known fixture. Deterministic ids so re-seeds are idempotent (INSERT OR REPLACE). */
function defaultFixture() {
  const nowIso = new Date().toISOString();
  // The app validates user IDs AND transaction IDs as UUIDs (getPhoneType, validateTransactionId
  // et al. reject non-UUIDs), so the seeded user id + all user_id FKs AND the transaction id MUST
  // be valid UUIDs. Fixed values → deterministic, idempotent re-seed.
  // BACKLOG-1950: the txId was previously a non-UUID ("qa-seed-tx-birchwood"); the detail IPCs
  // (transactions:get-details / get-communications) run validateTransactionId and REJECTED it with
  // "Transaction ID must be a valid UUID", so contact_assignments never loaded and the address-filter
  // toggle (gated on hasContacts) never rendered. A valid UUID fixes the whole detail-view path.
  const userId = 'a0000000-0000-4000-8000-00000000e2e0';
  const sessionToken = process.env.KEEPR_QA_SESSION_TOKEN || 'qa-seed-session-token-0001';
  const txId = 'b0000000-0000-4000-8000-00000000d100';
  // Session expires well into the future so validateSession passes.
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  const contacts = [
    { id: QA_SEED_CONTACT_IDS[1], user_id: userId, display_name: 'Alice Buyer', email: 'alice.buyer@example.com', company: 'Buyer Co' },
    { id: QA_SEED_CONTACT_IDS[2], user_id: userId, display_name: 'Bob Seller', email: 'bob.seller@example.com', company: 'Seller LLC' },
    { id: QA_SEED_CONTACT_IDS[3], user_id: userId, display_name: 'Carol Escrow', email: 'carol.escrow@example.com', company: 'Escrow Partners' },
  ];

  // The deterministic corpus. `class` documents each email's intended role (NOT persisted):
  //   'off-on'   participant contact + all address tokens → filter-OFF AND filter-ON
  //   'off-only' participant contact, missing an address token → filter-OFF only
  //   'decoy'    participant is NOT a transaction contact → NEITHER (proves participant IN() is the gate)
  //   'own'      only the user's own address → excluded (the app drops the user's own email)
  // (No out-of-window class under SR Option A — every seeded email is in-window; see the header note.)
  // `from` is the sole participant address seeded into email_participants (role='from', position 0).
  const emails = [
    // 4 MATCH → OFF + ON (participant contact AND subject/body contain 742/birchwood/lane/ne)
    { id: 'qa-seed-email-match-1', class: 'off-on', from: 'alice.buyer@example.com', user_id: userId, source: 'gmail', direction: 'inbound', subject: '742 Birchwood Lane NE — offer accepted', body_plain: 'Seller accepted your offer on 742 Birchwood Lane NE.', sent_at: '2026-01-05T17:00:00.000Z' },
    { id: 'qa-seed-email-match-2', class: 'off-on', from: 'bob.seller@example.com', user_id: userId, source: 'gmail', direction: 'outbound', subject: 'Re: 742 Birchwood Lane NE inspection', body_plain: 'Inspection booked for 742 Birchwood Lane NE.', sent_at: '2026-01-12T18:30:00.000Z' },
    { id: 'qa-seed-email-match-3', class: 'off-on', from: 'carol.escrow@example.com', user_id: userId, source: 'gmail', direction: 'inbound', subject: 'Closing docs — 742 Birchwood Lane NE', body_plain: 'Please sign the closing packet for 742 Birchwood Lane NE.', sent_at: '2026-02-01T16:00:00.000Z' },
    { id: 'qa-seed-email-match-4', class: 'off-on', from: 'alice.buyer@example.com', user_id: userId, source: 'gmail', direction: 'inbound', subject: 'Wire instructions — 742 Birchwood Lane NE', body_plain: 'Escrow wire for the 742 Birchwood Lane NE purchase.', sent_at: '2026-02-14T19:00:00.000Z' },
    // 2 NO-MATCH → OFF only (participant contact, but subject/body omit >=1 address token, incl. no substring 'ne')
    { id: 'qa-seed-email-nomatch-1', class: 'off-only', from: 'bob.seller@example.com', user_id: userId, source: 'gmail', direction: 'inbound', subject: 'Coffee catch-up Friday?', body_plain: 'Grab a drink to chat about the paperwork.', sent_at: '2026-01-20T20:00:00.000Z' },
    { id: 'qa-seed-email-nomatch-2', class: 'off-only', from: 'carol.escrow@example.com', user_id: userId, source: 'gmail', direction: 'outbound', subject: 'Docs you asked about', body_plain: 'Attaching the forms you wanted for our files.', sent_at: '2026-02-20T15:00:00.000Z' },
    // 2 DECOY → NEITHER (participant is not a transaction contact; decoy-2 deliberately mentions the address to
    // prove the participant IN() clause — not free-text — is the gate)
    { id: 'qa-seed-email-decoy-1', class: 'decoy', from: 'random@stranger.com', user_id: userId, source: 'gmail', direction: 'inbound', subject: 'Spring listings blast', body_plain: 'Featured homes this spring.', sent_at: '2026-01-08T12:00:00.000Z' },
    { id: 'qa-seed-email-decoy-2', class: 'decoy', from: 'marketing@spam.com', user_id: userId, source: 'gmail', direction: 'inbound', subject: '742 Birchwood Lane NE flyer', body_plain: 'Open house at 742 Birchwood Lane NE.', sent_at: '2026-01-09T12:00:00.000Z' },
    // 1 OWN-only → excluded (only the user's own address participates)
    { id: 'qa-seed-email-own-1', class: 'own', from: 'qa.seed@keepr.test', user_id: userId, source: 'gmail', direction: 'outbound', subject: 'Your account summary', body_plain: 'Monthly summary for your files.', sent_at: '2026-01-10T12:00:00.000Z' },
  ];
  // NOTE (BACKLOG-1950, SR Option A): every COUNTED email is deliberately INSIDE the transaction
  // date window [2026-01-01, today]. We do NOT seed an out-of-window negative control: the H3 oracle
  // (buildDerivedQuery) omits the sent_at window (deferred to BACKLOG-1887/FU-1) while the RUNTIME
  // linker enforces it, so an out-of-window participant+address match would be counted by the oracle
  // (7) but excluded by the runtime (6) — a false divergence caused by the FIXTURE, not the app.
  // Dropping it keeps oracle == runtime == OFF=6 / ON=4 BY CONSTRUCTION.

  return {
    user: {
      id: userId,
      email: 'qa.seed@keepr.test',
      first_name: 'QA',
      last_name: 'Seed',
      display_name: 'QA Seed',
      oauth_provider: 'google',
      oauth_id: 'qa-seed-oauth-0001',
      subscription_tier: 'pro',
      subscription_status: 'active',
      terms_accepted_at: nowIso,
      // Mark onboarding complete so the app routes straight to the dashboard (not the Setup flow):
      // isOnboardingComplete() requires a phone type + completed email onboarding (+ macOS
      // permissions, which the E2E hook grants). See LoadingOrchestrator/reducer.
      mobile_phone_type: 'iphone',
      email_onboarding_completed_at: nowIso,
    },
    session: { id: 'qa-seed-sess-0001', user_id: userId, session_token: sessionToken, expires_at: expiresAt },
    // A mailbox OAuth token row is the app's source of truth for "email onboarding completed"
    // (checkEmailOnboarding derives completed from a mailbox token, NOT the flag). Seeding one row
    // marks the email-connect onboarding step complete so the app routes to the dashboard.
    mailboxToken: {
      id: 'qa-seed-token-google-mailbox',
      user_id: userId,
      provider: 'google',
      purpose: 'mailbox',
      connected_email_address: 'qa.seed@keepr.test',
      mailbox_connected: 1,
      is_active: 1,
    },
    contacts,
    // BACKLOG-1947: assign the contacts to the transaction. Load-bearing on BOTH sides:
    //   - UI: the address-filter toggle renders only when the tx has contacts (hasContacts gate).
    //   - Backend: transactions:update-address-filter re-links by looping the ASSIGNED contacts.
    //
    // BACKLOG-1949 (add-users-with-roles cell): when KEEPR_QA_UNASSIGN_CONTACTS==='1', seed the SAME
    // 3 contacts but assign ZERO to the transaction — so they appear in the "Add Contacts" (Screen 2)
    // available list and the cell can drive the full add-with-role flow from a clean junction. The
    // DEFAULT path (no env var) is byte-identical to before, so the 1950/1947 exact-count cell + its
    // fidelity guard (which never reads transactionContacts) are unaffected. Precedent for env-gating
    // the seed: KEEPR_QA_START_SKIP_FILTER (transaction.skip_address_filter above).
    transactionContacts:
      process.env.KEEPR_QA_UNASSIGN_CONTACTS === '1'
        ? []
        : contacts.map((c, i) => ({
            id: `qa-seed-txc-${i + 1}`,
            transaction_id: txId,
            contact_id: c.id,
            role: i === 0 ? 'buyer' : i === 1 ? 'seller' : 'escrow',
          })),
    transaction: {
      id: txId,
      user_id: userId,
      property_address: FIXTURE_ADDRESS,
      property_street: '742 Birchwood Lane NE',
      property_city: 'Seattle',
      property_state: 'WA',
      property_zip: '98115',
      transaction_type: 'purchase',
      status: 'active',
      // FIXED past start (NOT now()) so computeTransactionDateRange yields a real [start, today] window
      // that contains every counted email. created_at mirrors it so the fallback path is consistent.
      started_at: FIXTURE_WINDOW_START,
      created_at: FIXTURE_WINDOW_START,
      // Starting toggle state. Default 0 (address filter APPLIED / toggle ON). The clean-slate ON
      // observation (BACKLOG-1950) seeds this at 1 (filter OFF) so the FIRST UI toggle to ON fires
      // the ON-only re-link (the change-triggered handler only re-links on a state change).
      skip_address_filter: process.env.KEEPR_QA_START_SKIP_FILTER === '1' ? 1 : 0,
    },
    emails,
    // BACKLOG-1947/1950: seed the corpus UNLINKED (no communications rows). The toggle-driven auto-link
    // is what creates the links we OBSERVE (clean-slate OFF==6, ON==4, monotonic). Pre-linking would
    // defeat the runtime observation. The H3 oracle is communications-independent regardless.
    communications: [],
  };
}

function loadFixture(opts) {
  if (opts.fixture && fs.existsSync(opts.fixture)) {
    return JSON.parse(fs.readFileSync(opts.fixture, 'utf8'));
  }
  return defaultFixture();
}

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

function seed(db, fx) {
  const tx = db.transaction(() => {
    const u = fx.user;
    db.prepare(
      `INSERT OR REPLACE INTO users_local
        (id, email, first_name, last_name, display_name, oauth_provider, oauth_id,
         subscription_tier, subscription_status, is_active, terms_accepted_at,
         mobile_phone_type, email_onboarding_completed_at)
       VALUES (@id, @email, @first_name, @last_name, @display_name, @oauth_provider, @oauth_id,
         @subscription_tier, @subscription_status, 1, @terms_accepted_at,
         @mobile_phone_type, @email_onboarding_completed_at)`,
    ).run(u);

    const s = fx.session;
    db.prepare(
      `INSERT OR REPLACE INTO sessions (id, user_id, session_token, expires_at)
       VALUES (@id, @user_id, @session_token, @expires_at)`,
    ).run(s);

    if (fx.mailboxToken) {
      db.prepare(
        `INSERT OR REPLACE INTO oauth_tokens
          (id, user_id, provider, purpose, connected_email_address, mailbox_connected, is_active)
         VALUES (@id, @user_id, @provider, @purpose, @connected_email_address, @mailbox_connected, @is_active)`,
      ).run(fx.mailboxToken);
    }

    const cStmt = db.prepare(
      `INSERT OR REPLACE INTO contacts (id, user_id, display_name, company, source, is_imported)
       VALUES (@id, @user_id, @display_name, @company, 'email', 1)`,
    );
    const ceStmt = db.prepare(
      `INSERT OR REPLACE INTO contact_emails (id, contact_id, email, is_primary, source)
       VALUES (@id, @contact_id, @email, 1, 'import')`,
    );
    for (const c of fx.contacts) {
      cStmt.run({ id: c.id, user_id: c.user_id, display_name: c.display_name, company: c.company || null });
      ceStmt.run({ id: `${c.id}-email`, contact_id: c.id, email: c.email });
    }

    const t = fx.transaction;
    db.prepare(
      `INSERT OR REPLACE INTO transactions
        (id, user_id, property_address, property_street, property_city, property_state, property_zip,
         transaction_type, status, started_at, created_at, skip_address_filter)
       VALUES (@id, @user_id, @property_address, @property_street, @property_city, @property_state, @property_zip,
         @transaction_type, @status, @started_at, @created_at, @skip_address_filter)`,
    ).run({
      ...t,
      created_at: t.created_at ?? t.started_at,
      skip_address_filter: t.skip_address_filter ?? 0,
    });

    // BACKLOG-1947: assign contacts to the transaction (load-bearing for the UI toggle + re-link loop).
    if (Array.isArray(fx.transactionContacts)) {
      const txcStmt = db.prepare(
        `INSERT OR REPLACE INTO transaction_contacts (id, transaction_id, contact_id, role)
         VALUES (@id, @transaction_id, @contact_id, @role)`,
      );
      for (const txc of fx.transactionContacts) {
        txcStmt.run({ id: txc.id, transaction_id: txc.transaction_id, contact_id: txc.contact_id, role: txc.role ?? null });
      }
    }

    // BACKLOG-1947: emails now carry an explicit sent_at (needed by the date window + the H3 oracle's
    // date derivation). Only the persisted columns are bound — the fixture's `class`/`from` helper
    // fields are used for participants below, not written to the emails row.
    const eStmt = db.prepare(
      `INSERT OR REPLACE INTO emails (id, user_id, source, direction, subject, body_plain, sender, sent_at)
       VALUES (@id, @user_id, @source, @direction, @subject, @body_plain, @sender, @sent_at)`,
    );
    for (const e of fx.emails) {
      eStmt.run({
        id: e.id,
        user_id: e.user_id,
        source: e.source,
        direction: e.direction,
        subject: e.subject,
        body_plain: e.body_plain ?? null,
        // Denormalized sender kept consistent with the participant we seed (verbatim, case-preserved).
        sender: e.from ?? null,
        sent_at: e.sent_at ?? null,
      });
    }

    // BACKLOG-1982 (delete-emails cell): OPTIONALLY assign the deterministic thread structure via a
    // SEPARATE post-insert UPDATE — the emails INSERT above stays BYTE-IDENTICAL to the default path
    // (no thread_id in its column list), so the BACKLOG-1950 fidelity guard is unaffected. Applied
    // ONLY when KEEPR_QA_DELETE_EMAILS_THREADS === '1'. autoLink then copies emails.thread_id into
    // communications.thread_id (autoLinkService), so unlinkCommunication expands across siblings.
    if (process.env.KEEPR_QA_DELETE_EMAILS_THREADS === '1') {
      const threadStmt = db.prepare('UPDATE emails SET thread_id = ? WHERE id = ?');
      for (const [emailId, threadId] of Object.entries(DELETE_EMAILS_THREAD_MAP)) {
        threadStmt.run(threadId, emailId);
      }
    }

    // BACKLOG-1947/1722: seed the email_participants junction — the app's INDEXED, exact-match linking
    // source. We seed one 'from' participant (position 0) per email with the lowercased+trimmed address
    // (the runtime `ep.email_address IN (...)` clause matches lowercase; see autoLinkService). Emails
    // with no `from` are skipped (none in the default fixture).
    const epStmt = db.prepare(
      `INSERT OR REPLACE INTO email_participants
        (email_id, role, position, participant_hash, email_address, display_name, resolved_contact_id)
       VALUES (@email_id, @role, @position, @participant_hash, @email_address, @display_name, @resolved_contact_id)`,
    );
    for (const e of fx.emails) {
      if (!e.from) continue;
      const role = 'from';
      const position = 0;
      const emailAddress = String(e.from).toLowerCase().trim();
      epStmt.run({
        email_id: e.id,
        role,
        position,
        participant_hash: participantHash(e.id, role, position, emailAddress),
        email_address: emailAddress,
        display_name: e.from, // verbatim (case preserved) per schema note
        resolved_contact_id: null,
      });
    }

    // Communications are seeded ONLY if the fixture provides them (default: none — the toggle-driven
    // auto-link creates the links we observe). Preserved for custom fixtures that pre-link.
    if (Array.isArray(fx.communications) && fx.communications.length > 0) {
      const commStmt = db.prepare(
        `INSERT OR REPLACE INTO communications (id, user_id, transaction_id, email_id, link_source)
         VALUES (@id, @user_id, @transaction_id, @email_id, @link_source)`,
      );
      for (const cm of fx.communications) commStmt.run(cm);
    }
  });
  tx();

  return {
    userId: fx.user.id,
    email: fx.user.email,
    sessionToken: fx.session.session_token,
    sessionExpiresAt: fx.session.expires_at,
    provider: fx.user.oauth_provider,
    transactionId: fx.transaction.id,
    propertyAddress: fx.transaction.property_address,
    contacts: fx.contacts.length,
    emails: fx.emails.length,
  };
}

// ---------------------------------------------------------------------------
// License offline cache — so the app's LicenseGate passes without a real cloud license.
//
// The app validates the license against Supabase, but our seeded session has NO supabaseTokens
// (deliberately — see seedProfile.ts), so the unauthenticated Supabase call throws and
// validateLicense() falls back to the OFFLINE CACHE at userData/license-cache.json
// ({ status, userId, cachedAt } within the offline grace window). We write a VALID cache so the
// gate passes. Fixture-only — no app-code change; the app never overwrites it because it only
// re-caches on a SUCCESSFUL cloud validation, which cannot happen unauthenticated.
// ---------------------------------------------------------------------------

function writeLicenseCache(userDataPath, userId) {
  const status = {
    isValid: true,
    licenseType: 'individual',
    transactionCount: 1,
    transactionLimit: 1000,
    canCreateTransaction: true,
    deviceCount: 1,
    deviceLimit: 2,
    aiEnabled: false,
  };
  const cache = { status, userId, cachedAt: Date.now() };
  fs.writeFileSync(path.join(userDataPath, 'license-cache.json'), JSON.stringify(cache, null, 2), 'utf8');
}

// ---------------------------------------------------------------------------
// Output + main
// ---------------------------------------------------------------------------

function emit(opts, obj) {
  const line = SENTINEL + JSON.stringify(obj);
  if (opts.out) {
    try {
      fs.writeFileSync(opts.out, JSON.stringify(obj));
    } catch (e) {
      process.stderr.write(`seed-fixture: failed to write --out ${opts.out}: ${e.message}\n`);
    }
  }
  process.stdout.write(line + '\n');
}

function run(opts) {
  assertIsolatedProfile(opts.userDataDir);
  const userDataPath = path.resolve(opts.userDataDir);
  // Create the encrypted DB + key + schema in the isolated profile if not present.
  ensureDbInitialized(userDataPath);
  const dbPath = path.join(userDataPath, 'mad.db');
  const key = getEncryptionKey(userDataPath);
  const db = openDbForWrite(dbPath, key);
  try {
    const fx = loadFixture(opts);
    const result = seed(db, fx);
    writeLicenseCache(userDataPath, fx.user.id);
    return result;
  } finally {
    db.close();
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write('seed-fixture: seed an isolated QA profile DB. See file header.\n');
    process.exit(0);
    return;
  }

  const fail = (err) => {
    const msg = err && err.message ? err.message : String(err);
    try { emit(opts, { seeded: false, error: msg }); } catch (_) { /* last resort */ }
    process.stderr.write(`\n  x seed-fixture error: ${msg}\n`);
    process.exit(2);
  };
  process.on('uncaughtException', fail);
  process.on('unhandledRejection', fail);

  // Seeding provisions the encrypted DB (schema.sql exec) and reads/writes the key via safeStorage,
  // both of which require a ready Electron app. Always run under Electron's app lifecycle.
  const { app } = require('electron');
  app.setName('keepr'); // match the app's lowercase name so safeStorage resolves the profile key
  app.whenReady().then(() => {
    try {
      const result = run(opts);
      emit(opts, { seeded: true, ...result });
      app.quit();
      process.exit(0);
    } catch (err) {
      fail(err);
    }
  });
}

// Entry detection: under Electron, `require.main === module` is FALSE (require.main.filename is
// undefined), so we instead check whether THIS file is the launched entry script (argv[1]). When
// required by jest (unit tests), argv[1] is jest's runner, so main() is NOT invoked.
const isEntryScript = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);
if (isEntryScript || require.main === module) {
  main();
}

module.exports = {
  parseArgs,
  assertIsolatedProfile,
  defaultFixture,
  participantHash,
  SENTINEL,
  FIXTURE_ADDRESS,
  FIXTURE_WINDOW_START,
  QA_SEED_CONTACT_IDS,
  DELETE_EMAILS_THREAD_MAP,
};
