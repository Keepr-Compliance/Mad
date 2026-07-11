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

const SENTINEL = '__QA_SEED_JSON__ ';

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

/** Generate a 256-bit key, wrap it with safeStorage, and write db-key-store.json (app format). */
function provisionKeyStore(userDataPath) {
  const crypto = require('crypto');
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

/** The default known fixture. Deterministic ids so re-seeds are idempotent (INSERT OR REPLACE). */
function defaultFixture() {
  const nowIso = new Date().toISOString();
  // The app validates user IDs as UUIDs (getPhoneType et al. reject non-UUIDs), so the seeded
  // user id + all user_id FKs MUST be a valid UUID. Fixed value → deterministic, idempotent re-seed.
  const userId = 'a0000000-0000-4000-8000-00000000e2e0';
  const sessionToken = process.env.KEEPR_QA_SESSION_TOKEN || 'qa-seed-session-token-0001';
  const txId = 'qa-seed-tx-birchwood';
  // Session expires well into the future so validateSession passes.
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
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
    contacts: [
      { id: 'qa-seed-contact-1', user_id: userId, display_name: 'Alice Buyer', email: 'alice.buyer@example.com', company: 'Buyer Co' },
      { id: 'qa-seed-contact-2', user_id: userId, display_name: 'Bob Seller', email: 'bob.seller@example.com', company: 'Seller LLC' },
      { id: 'qa-seed-contact-3', user_id: userId, display_name: 'Carol Escrow', email: 'carol.escrow@example.com', company: 'Escrow Partners' },
    ],
    transaction: {
      id: txId,
      user_id: userId,
      property_address: '742 Birchwood Lane NE, Seattle, WA 98115',
      property_street: '742 Birchwood Lane NE',
      property_city: 'Seattle',
      property_state: 'WA',
      property_zip: '98115',
      transaction_type: 'purchase',
      status: 'active',
      started_at: nowIso,
    },
    emails: [
      { id: 'qa-seed-email-1', user_id: userId, source: 'gmail', direction: 'inbound', subject: 'Offer accepted on 742 Birchwood Lane NE', body_plain: 'Great news — the seller accepted.' },
      { id: 'qa-seed-email-2', user_id: userId, source: 'gmail', direction: 'outbound', subject: 'Re: Inspection scheduling', body_plain: 'Inspection is set for next Tuesday.' },
      { id: 'qa-seed-email-3', user_id: userId, source: 'gmail', direction: 'inbound', subject: 'Escrow instructions', body_plain: 'Please review the attached escrow instructions.' },
    ],
    communications: [
      { id: 'qa-seed-comm-1', user_id: userId, transaction_id: txId, email_id: 'qa-seed-email-1', link_source: 'auto' },
      { id: 'qa-seed-comm-2', user_id: userId, transaction_id: txId, email_id: 'qa-seed-email-2', link_source: 'auto' },
      { id: 'qa-seed-comm-3', user_id: userId, transaction_id: txId, email_id: 'qa-seed-email-3', link_source: 'manual' },
    ],
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
         transaction_type, status, started_at)
       VALUES (@id, @user_id, @property_address, @property_street, @property_city, @property_state, @property_zip,
         @transaction_type, @status, @started_at)`,
    ).run(t);

    const eStmt = db.prepare(
      `INSERT OR REPLACE INTO emails (id, user_id, source, direction, subject, body_plain)
       VALUES (@id, @user_id, @source, @direction, @subject, @body_plain)`,
    );
    for (const e of fx.emails) eStmt.run(e);

    const commStmt = db.prepare(
      `INSERT OR REPLACE INTO communications (id, user_id, transaction_id, email_id, link_source)
       VALUES (@id, @user_id, @transaction_id, @email_id, @link_source)`,
    );
    for (const cm of fx.communications) commStmt.run(cm);
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

module.exports = { parseArgs, assertIsolatedProfile, defaultFixture, SENTINEL };
