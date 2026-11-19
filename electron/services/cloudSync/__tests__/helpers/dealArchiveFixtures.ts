/**
 * BACKLOG-4263 PR-4c — a deal with a row in each of the 15 tables a deal delete removes, and the 2 SET NULL
 * tables naming it. Not transcribed from one producer: every column of every table is filled (a sweep), so a
 * restore that drops or alters any column fails the full-row comparison. Columns with a CHECK or a foreign key
 * take a value the schema accepts; every other column takes a distinct typed value. Ids are all-zero fakes.
 */
import type { SqlDb } from "../../../db/cloudSyncSqlDb";
import { DEAL_ARCHIVE_SET_NULL_TABLES, DEAL_ARCHIVE_TABLES } from "../../../db/cloudSyncDealArchive";
import { REPOINT_MESSAGE_TRANSACTION_SQL } from "../../../db/messageDbService";

type Row = Record<string, unknown>;

export const fz = (kind: number, n: number) => `00000000-0000-0000-${String(kind).padStart(4, "0")}-${String(n).padStart(12, "0")}`;

function columns(db: SqlDb, table: string): Array<{ name: string; type: string }> {
  return db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; type: string }>;
}

/** A distinct value for a column with no constraint, by declared type. */
function typed(table: string, col: { name: string; type: string }, n: number): unknown {
  const t = (col.type || "").toUpperCase();
  if (t.includes("INT")) return 3 + n;
  if (t.includes("REAL") || t.includes("FLOA") || t.includes("DOUB")) return 0.25 + n;
  if (t.includes("DATE") || t.includes("TIME")) return `2026-0${1 + (n % 9)}-1${n % 10}T0${n % 10}:0${n % 10}:00Z`;
  return `${table}.${col.name}.${n}`;
}

/** Fills every column of `table`: `fixed` wins, then the typed default. */
function fullRow(db: SqlDb, table: string, fixed: Row, n: number): Row {
  const out: Row = {};
  for (const c of columns(db, table)) out[c.name] = c.name in fixed ? fixed[c.name] : typed(table, c, n);
  return out;
}

function insert(db: SqlDb, table: string, row: Row): void {
  const keys = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${keys.map((k) => `"${k}"`).join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`).run(
    ...keys.map((k) => row[k]),
  );
}

export interface DealFixture {
  deal: string;
  user: string;
  contact: string;
  contact2: string;
  email: string;
  email2: string;
  message: string;
  message2: string;
  attachment: string;
  checklist: string;
  item: string;
  linkEmail: string;
  linkText: string;
  feedback: string;
}

/** The evidence rows the deal's rows point at (emails, texts, an attachment, contacts). */
export function seedEvidence(db: SqlDb, user: string, k = 1): Omit<DealFixture, "deal" | "checklist" | "item" | "linkEmail" | "linkText" | "feedback"> {
  const e = {
    user,
    contact: fz(60, k * 10 + 1),
    contact2: fz(60, k * 10 + 2),
    email: fz(61, k * 10 + 1),
    email2: fz(61, k * 10 + 2),
    message: fz(62, k * 10 + 1),
    message2: fz(62, k * 10 + 2),
    attachment: fz(63, k * 10 + 1),
  };
  for (const c of [e.contact, e.contact2]) db.prepare("INSERT INTO contacts (id, user_id, display_name, source) VALUES (?, ?, ?, 'manual')").run(c, user, `Person ${c.slice(-4)}`);
  for (const m of [e.email, e.email2]) db.prepare("INSERT INTO emails (id, user_id, subject, thread_id) VALUES (?, ?, 'Offer', NULL)").run(m, user);
  for (const m of [e.message, e.message2]) {
    db.prepare("INSERT INTO messages (id, user_id, channel, direction, body_text, thread_id, sent_at) VALUES (?, ?, 'sms', 'inbound', 'hello', 'thr-4263', '2026-11-01T10:00:00Z')").run(m, user);
  }
  db.prepare("INSERT INTO attachments (id, message_id, filename) VALUES (?, ?, 'offer.pdf')").run(e.attachment, e.message);
  return e;
}

/**
 * Inserts the deal (every column filled) and one row in each of the 15 tables (two where a second row shows a
 * different shape), plus a classification_feedback row and a text whose column names the deal.
 */
export function seedFullDeal(db: SqlDb, user: string, deal: string, k = 1): DealFixture {
  const ev = seedEvidence(db, user, k);
  const checklist = fz(64, k);
  const item = fz(65, k);
  const linkEmail = fz(66, k * 10 + 1);
  const linkText = fz(66, k * 10 + 2);
  const feedback = fz(67, k);
  insert(
    db,
    "transactions",
    fullRow(
      db,
      "transactions",
      {
        id: deal,
        user_id: user,
        property_address: `${k}2 Main St, Springfield`,
        transaction_type: "purchase",
        status: "active",
        stage_source: "user",
        export_status: "not_exported",
        export_format: "pdf",
        detection_status: "confirmed",
        detection_source: "manual",
        detection_method: "manual",
        submission_status: "not_submitted",
        submission_id: null,
        organization_id: null,
        last_review_notes: null,
      },
      k,
    ),
  );
  const fix: Record<string, Row[]> = {
    audit_packages: [{ id: fz(70, k), transaction_id: deal, user_id: user, format: "pdf" }],
    communications: [
      { id: fz(71, k * 10 + 1), user_id: user, transaction_id: deal, message_id: null, email_id: ev.email, thread_id: null, link_source: "manual" },
      { id: fz(71, k * 10 + 2), user_id: user, transaction_id: deal, message_id: ev.message, email_id: null, thread_id: "thr-4263", link_source: "auto" },
    ],
    extracted_transaction_data: [{ id: fz(72, k), transaction_id: deal, field_name: "sale_price", source_message_id: ev.message, extraction_method: "pattern" }],
    ignored_communications: [{ id: fz(73, k), user_id: user, transaction_id: deal, email_id: ev.email2 }],
    pending_review_communications: [{ id: fz(74, k), user_id: user, transaction_id: deal, email_id: ev.email2, thread_id: null }],
    pending_review_match_reasons: [{ transaction_id: deal, email_id: ev.email2, reason: "address" }],
    transaction_contacts: [{ id: fz(75, k), transaction_id: deal, contact_id: ev.contact, removed_at: null }],
    transaction_participants: [{ id: fz(76, k), transaction_id: deal, contact_id: ev.contact2, role: "buyer", role_source: "user" }],
    transaction_stage_history: [{ id: fz(77, k), transaction_id: deal, stage: "offer", source: "user", trigger_message_id: ev.message2 }],
    transaction_hidden_texts: [{ transaction_id: deal, message_id: ev.message2, hidden_by: user }],
    transaction_checklists: [{ id: checklist, transaction_id: deal, template_id: "tpl-4263", template_name: "Purchase", sort_order: 0 }],
    transaction_checklist_items: [
      {
        id: item,
        checklist_id: checklist,
        title: "Inspection",
        description: "Book it",
        is_required: 1,
        expected_document_type: "inspection",
        is_checked: 1,
        checked_at: "2026-11-02T10:00:00Z",
        due_date: "2026-12-01",
        sort_order: 0,
        // BACKLOG-4263 PR-11c: the author columns ride along with the archive and the restore
        note: "Booked by the agent",
        done_by_kind: "ai_app",
        done_by_app: "anthropic",
        done_by_at: "2026-11-02T10:00:00.000Z",
        done_by_stamp: "2026-11-02T10:00:00Z",
        note_by_kind: "agent",
        note_by_app: null,
        note_by_at: "2026-11-02T09:00:00.000Z",
        note_by_digest: "7b10b6869d6c10792f1cc4248edc0ffca1b0804195cc1a4a0f20305a6317387f",
      },
    ],
    transaction_checklist_links: [
      { id: linkEmail, item_id: item, kind: "email", label: "The offer", include_outside_dates: 0 },
      { id: linkText, item_id: item, kind: "text", label: "The text", include_outside_dates: 1 },
    ],
    transaction_checklist_link_members: [
      { id: fz(68, k * 10 + 1), link_id: linkEmail, kind: "email", attachment_id: null, email_id: ev.email, message_id: null },
      { id: fz(68, k * 10 + 2), link_id: linkText, kind: "text", attachment_id: null, email_id: null, message_id: ev.message },
      { id: fz(68, k * 10 + 3), link_id: linkEmail, kind: "attachment", attachment_id: ev.attachment, email_id: null, message_id: null },
    ],
    transaction_opens: [{ transaction_id: deal, opened_at: "2026-11-03T10:00:00.000Z" }],
  };
  // The third member is an attachment on the email link: the FK (link_id, kind) needs an attachment link.
  fix.transaction_checklist_links.push({ id: fz(66, k * 10 + 3), item_id: item, kind: "attachment", label: "The file", include_outside_dates: 0 });
  fix.transaction_checklist_link_members[2].link_id = fz(66, k * 10 + 3);
  let n = 0;
  for (const t of DEAL_ARCHIVE_TABLES) {
    for (const r of fix[t.table] ?? []) insert(db, t.table, fullRow(db, t.table, r, ++n));
  }
  insert(
    db,
    "classification_feedback",
    fullRow(db, "classification_feedback", { id: feedback, user_id: user, message_id: ev.message, attachment_id: ev.attachment, transaction_id: deal, contact_id: ev.contact, feedback_type: "transaction_link" }, 90),
  );
  db.prepare("UPDATE messages SET transaction_id = ? WHERE id = ?").run(deal, ev.message);
  return { deal, checklist, item, linkEmail, linkText, feedback, ...ev };
}

/** Every row of the deal in every archived table (the deal row first), and the 2 SET NULL tables' rows. */
export function snapshotDeal(db: SqlDb, deal: string): Record<string, Row[]> {
  const out: Record<string, Row[]> = {
    transactions: db.prepare("SELECT * FROM transactions WHERE id = ?").all(deal) as Row[],
  };
  for (const t of DEAL_ARCHIVE_TABLES) out[t.table] = db.prepare(`SELECT * FROM ${t.table} WHERE ${t.where} ORDER BY rowid`).all(deal) as Row[];
  for (const t of DEAL_ARCHIVE_SET_NULL_TABLES) out[t] = db.prepare(`SELECT * FROM ${t} WHERE transaction_id = ? ORDER BY id`).all(deal) as Row[];
  return out;
}

/**
 * What deleteTransactionSync (electron/services/db/transactionDbService.ts) does, on a test handle, in one
 * transaction: the archive step, the texts naming the deal, the DELETE, each of those texts re-pointed.
 */
export function deleteLikeTheHandler(db: SqlDb, deal: string, archive: (db: SqlDb, id: string, flag: boolean, now: Date) => boolean, now: Date, flag = true): boolean {
  return db.transaction(() => {
    const a = archive(db, deal, flag, now);
    const named = db.prepare("SELECT id FROM messages WHERE transaction_id = ?").all(deal) as Array<{ id: string }>;
    db.prepare("DELETE FROM transactions WHERE id = ?").run(deal);
    for (const { id } of named) db.prepare(REPOINT_MESSAGE_TRANSACTION_SQL as unknown as string).run(id);
    return a;
  })();
}
