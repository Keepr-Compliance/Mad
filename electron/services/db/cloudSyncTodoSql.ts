/**
 * Keepr Cloud todos, local side — BACKLOG-4263 PR-3 (plan §1.4, §1.8, §3.2, §5).
 *
 * The local tables the two-way todo protocol keeps (declared in schema.sql,
 * mirrored here), and the six capture triggers that record every checklist and
 * item change of a Keepr Cloud user in `cloud_sync_todo_outbox`, inside the
 * statement that made the change (so inside the caller's own transaction).
 * Nothing in this PR reads the outbox; PR-4a sends it.
 *
 * Trigger rules:
 * - D1: only built-in SQLite functions (strftime, julianday, json_object,
 *   json_group_array, json, randomblob, hex, lower, coalesce). No trigger names
 *   an app-registered function: a connection without it (a 2.48.0 build, any
 *   other process) would fail every write to the table.
 * - W24: every write is `INSERT … SELECT … FROM cloud_sync_settings s WHERE
 *   s.user_id = <owner of the row> AND s.enabled = 1`. A row whose owner never
 *   turned Keepr Cloud on (or whose parent is already gone in a cascade)
 *   selects nothing and writes nothing. No body can raise.
 * - R3 / E2: the per-computer counter (`cloud_sync_todo_counter`) is moved by a
 *   plain UPDATE before the outbox insert reads it: `edit_seq + 1`, and the
 *   epoch is bumped when the wall clock is more than 120 s behind the highest
 *   time it has seen. An absent counter row is a no-op, and the outbox then
 *   gets NULL `edit_seq` and `clock_epoch` (both nullable).
 * - D7: the apply guard (`cloud_sync_applying`) suppresses the op inserts and
 *   the counter step only. The trash archive in the two BEFORE DELETE triggers
 *   is never guarded, so a pulled removal is still archived.
 * - R7: a removal op and the trash archive come from the deleting row's own
 *   BEFORE DELETE trigger. In a cascade the parent row is already gone when a
 *   child trigger runs, so the owner lookup is NULL and the child writes nothing
 *   (checklist delete → one checklist op, items archived, no item op; deal
 *   delete → no todo op and no trash row).
 * - A part is recorded only when its value really changed (`IS NOT`).
 * - A re-edit of a part still waiting to be sent replaces the value, takes a
 *   new op_id and edit_seq, bumps `generation`, and keeps `base_rev` (the rev
 *   the first unsent edit was made against).
 */

/** Same shape as CloudSyncTriggerSpec (cloudSyncSql.ts). */
export interface TodoTriggerSpec {
  name: string;
  table: string;
  requires: Record<string, readonly string[]>;
  sql: string;
}

export const CLOUD_SYNC_TODO_TABLES_DDL = `CREATE TABLE IF NOT EXISTS cloud_sync_todo_outbox (
  project_ref    TEXT NOT NULL,
  owner_user_id  TEXT NOT NULL,
  entity         TEXT NOT NULL,
  local_id       TEXT NOT NULL,
  part           TEXT NOT NULL,
  transaction_id TEXT,
  value_json     TEXT,
  base_rev       INTEGER,
  edit_seq       INTEGER,
  edited_at      TEXT NOT NULL,
  clock_epoch    INTEGER,
  op_id          TEXT NOT NULL,
  generation     INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (project_ref, owner_user_id, entity, local_id, part)
);
CREATE TABLE IF NOT EXISTS cloud_sync_todo_counter (
  project_ref   TEXT NOT NULL,
  install_id    TEXT NOT NULL,
  edit_seq      INTEGER NOT NULL DEFAULT 0,
  max_wall_seen TEXT,
  clock_epoch   INTEGER NOT NULL DEFAULT 0,
  rewound_at    TEXT,
  PRIMARY KEY (project_ref, install_id)
);
CREATE TABLE IF NOT EXISTS cloud_sync_todo_state (
  project_ref    TEXT NOT NULL,
  owner_user_id  TEXT NOT NULL,
  entity         TEXT NOT NULL,
  local_id       TEXT NOT NULL,
  transaction_id TEXT,
  cloud_id       TEXT,
  cloud_deal_id  TEXT,
  done_rev       INTEGER,
  done_json      TEXT,
  title_rev      INTEGER,
  title_json     TEXT,
  note_rev       INTEGER,
  note_json      TEXT,
  due_rev        INTEGER,
  due_json       TEXT,
  order_rev      INTEGER,
  order_json     TEXT,
  removed_rev    INTEGER,
  removed_json   TEXT,
  updated_at     TEXT NOT NULL,
  PRIMARY KEY (project_ref, owner_user_id, entity, local_id)
);
CREATE TABLE IF NOT EXISTS cloud_sync_todo_cursor (
  project_ref    TEXT NOT NULL,
  owner_user_id  TEXT NOT NULL,
  last_seq       INTEGER NOT NULL DEFAULT 0,
  full_pull_owed INTEGER NOT NULL DEFAULT 1,
  updated_at     TEXT,
  PRIMARY KEY (project_ref, owner_user_id)
);
CREATE TABLE IF NOT EXISTS cloud_sync_todo_parked (
  project_ref   TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  entity        TEXT NOT NULL,
  cloud_id      TEXT NOT NULL,
  change_seq    INTEGER,
  row_json      TEXT,
  error_code    TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  parked_at     TEXT NOT NULL,
  PRIMARY KEY (project_ref, owner_user_id, entity, cloud_id)
);
CREATE TABLE IF NOT EXISTS cloud_sync_todo_notices (
  id             INTEGER PRIMARY KEY,
  project_ref    TEXT NOT NULL,
  owner_user_id  TEXT NOT NULL,
  entity         TEXT NOT NULL,
  local_id       TEXT NOT NULL,
  part           TEXT,
  kind           TEXT NOT NULL,
  transaction_id TEXT,
  other_json     TEXT,
  actor_kind     TEXT,
  actor_label    TEXT,
  change_seq     INTEGER,
  created_at     TEXT NOT NULL,
  dismissed_at   TEXT
);
CREATE TABLE IF NOT EXISTS cloud_sync_todo_trash (
  project_ref    TEXT NOT NULL,
  owner_user_id  TEXT NOT NULL,
  entity         TEXT NOT NULL,
  local_id       TEXT NOT NULL,
  transaction_id TEXT,
  checklist_id   TEXT,
  removed_with   TEXT,
  removed_at     TEXT NOT NULL,
  payload_json   TEXT,
  PRIMARY KEY (project_ref, owner_user_id, entity, local_id)
);
CREATE TABLE IF NOT EXISTS cloud_sync_applying (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  started_at TEXT NOT NULL
);`;

export const CLOUD_SYNC_TODO_TABLES = [
  "cloud_sync_todo_outbox",
  "cloud_sync_todo_counter",
  "cloud_sync_todo_state",
  "cloud_sync_todo_cursor",
  "cloud_sync_todo_parked",
  "cloud_sync_todo_notices",
  "cloud_sync_todo_trash",
  "cloud_sync_applying",
] as const;

// ---------------------------------------------------------------- building blocks

/** Wall time with milliseconds, built-in only (D1). */
export const TODO_NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
/** E2: a backward step bigger than this makes the earlier ops' times unknowable. */
export const CLOCK_STEP_SECONDS = 120;

const NOT_APPLYING = "NOT EXISTS (SELECT 1 FROM cloud_sync_applying)";
const GATE = "WHEN EXISTS (SELECT 1 FROM cloud_sync_settings WHERE enabled = 1)";

type Ref = "NEW" | "OLD";
const ITEM_DEAL = (r: Ref) => `(SELECT c.transaction_id FROM transaction_checklists c WHERE c.id = ${r}.checklist_id)`;
const ITEM_OWNER = (r: Ref) =>
  `(SELECT t.user_id FROM transaction_checklists c JOIN transactions t ON t.id = c.transaction_id WHERE c.id = ${r}.checklist_id)`;
const CHECKLIST_OWNER = (r: Ref) => `(SELECT t.user_id FROM transactions t WHERE t.id = ${r}.transaction_id)`;

const ownerOn = (owner: string, project: string) =>
  `EXISTS (SELECT 1 FROM cloud_sync_settings s WHERE s.project_ref = ${project} AND s.user_id = ${owner} AND s.enabled = 1)`;

/** The epoch test on the counter row's own (pre-update) values. */
const STEPPED_BACK = `(julianday(max_wall_seen) IS NOT NULL AND julianday('now') < julianday(max_wall_seen) - ${CLOCK_STEP_SECONDS}.0 / 86400.0)`;

/**
 * R3 + E2: one plain UPDATE of this computer's counter row (absent row: no-op).
 * Runs only when an op will be written (owner on, not applying, `cond`).
 */
function counterStep(owner: string, cond: string): string {
  return `UPDATE cloud_sync_todo_counter
     SET edit_seq = edit_seq + 1,
         clock_epoch = clock_epoch + (CASE WHEN ${STEPPED_BACK} THEN 1 ELSE 0 END),
         max_wall_seen = CASE
           WHEN julianday(max_wall_seen) IS NULL OR ${STEPPED_BACK} OR julianday('now') > julianday(max_wall_seen) THEN ${TODO_NOW}
           ELSE max_wall_seen END
   WHERE (${cond}) AND ${NOT_APPLYING}
     AND install_id = (SELECT i.install_id FROM cloud_sync_install i WHERE i.project_ref = cloud_sync_todo_counter.project_ref)
     AND ${ownerOn(owner, "cloud_sync_todo_counter.project_ref")};`;
}

interface OpArgs {
  entity: "checklist" | "item";
  ref: Ref;
  part: string;
  owner: string;
  deal: string;
  value: string;
  cond: string;
}

/** One outbox op (guarded), reading the counter the step above just moved. */
function opInsert(a: OpArgs): string {
  const baseRev =
    a.part === "create"
      ? "NULL"
      : `(SELECT st.${a.part}_rev FROM cloud_sync_todo_state st WHERE st.project_ref = s.project_ref AND st.owner_user_id = s.user_id AND st.entity = '${a.entity}' AND st.local_id = ${a.ref}.id)`;
  return `INSERT INTO cloud_sync_todo_outbox
    (project_ref, owner_user_id, entity, local_id, part, transaction_id, value_json, base_rev, edit_seq, edited_at, clock_epoch, op_id, generation)
  SELECT s.project_ref, s.user_id, '${a.entity}', ${a.ref}.id, '${a.part}', ${a.deal}, ${a.value}, ${baseRev},
         k.edit_seq, ${TODO_NOW}, k.clock_epoch, lower(hex(randomblob(16))), 1
    FROM cloud_sync_settings s
    LEFT JOIN cloud_sync_install i ON i.project_ref = s.project_ref
    LEFT JOIN cloud_sync_todo_counter k ON k.project_ref = i.project_ref AND k.install_id = i.install_id
   WHERE s.user_id = ${a.owner} AND s.enabled = 1 AND (${a.cond}) AND ${NOT_APPLYING}
  ON CONFLICT (project_ref, owner_user_id, entity, local_id, part) DO UPDATE SET
    transaction_id = excluded.transaction_id, value_json = excluded.value_json, edit_seq = excluded.edit_seq,
    edited_at = excluded.edited_at, clock_epoch = excluded.clock_epoch, op_id = excluded.op_id,
    generation = cloud_sync_todo_outbox.generation + 1;`;
}

/** JSON of one item row (create op value and trash payload). */
const itemJson = (r: string) =>
  `json_object('id', ${r}.id, 'checklist_id', ${r}.checklist_id, 'title', ${r}.title, 'description', ${r}.description,
    'is_required', ${r}.is_required, 'expected_document_type', ${r}.expected_document_type, 'is_checked', ${r}.is_checked,
    'checked_at', ${r}.checked_at, 'note', ${r}.note, 'due_date', ${r}.due_date, 'sort_order', ${r}.sort_order, 'created_at', ${r}.created_at)`;
const checklistJson = (r: string) =>
  `json_object('id', ${r}.id, 'transaction_id', ${r}.transaction_id, 'template_id', ${r}.template_id,
    'template_name', ${r}.template_name, 'sort_order', ${r}.sort_order, 'selected_at', ${r}.selected_at)`;

/** An item's links and their members, as a JSON array (`itemId` is an SQL expression). */
const linksJson = (itemId: string) =>
  `json((SELECT json_group_array(json_object('id', l.id, 'kind', l.kind, 'label', l.label, 'sort_order', l.sort_order,
      'created_at', l.created_at, 'include_outside_dates', l.include_outside_dates,
      'members', json((SELECT json_group_array(json_object('id', m.id, 'kind', m.kind, 'attachment_id', m.attachment_id,
        'email_id', m.email_id, 'message_id', m.message_id)) FROM transaction_checklist_link_members m WHERE m.link_id = l.id))))
    FROM transaction_checklist_links l WHERE l.item_id = ${itemId}))`;

const TRASH_UPSERT = `ON CONFLICT (project_ref, owner_user_id, entity, local_id) DO UPDATE SET
    transaction_id = excluded.transaction_id, checklist_id = excluded.checklist_id, removed_with = excluded.removed_with,
    removed_at = excluded.removed_at, payload_json = excluded.payload_json;`;

/** D7: never guarded. */
function itemTrashFromOld(): string {
  return `INSERT INTO cloud_sync_todo_trash
    (project_ref, owner_user_id, entity, local_id, transaction_id, checklist_id, removed_with, removed_at, payload_json)
  SELECT s.project_ref, s.user_id, 'item', OLD.id, ${ITEM_DEAL("OLD")}, OLD.checklist_id, NULL, ${TODO_NOW},
         json_object('item', json(${itemJson("OLD")}), 'links', ${linksJson("OLD.id")})
    FROM cloud_sync_settings s
   WHERE s.user_id = ${ITEM_OWNER("OLD")} AND s.enabled = 1
  ${TRASH_UPSERT}`;
}

/** D7: never guarded. The checklist row, then each of its items with links and members. */
function checklistTrashFromOld(): string {
  return `INSERT INTO cloud_sync_todo_trash
    (project_ref, owner_user_id, entity, local_id, transaction_id, checklist_id, removed_with, removed_at, payload_json)
  SELECT s.project_ref, s.user_id, 'checklist', OLD.id, OLD.transaction_id, OLD.id, NULL, ${TODO_NOW},
         json_object('checklist', json(${checklistJson("OLD")}))
    FROM cloud_sync_settings s
   WHERE s.user_id = ${CHECKLIST_OWNER("OLD")} AND s.enabled = 1
  ${TRASH_UPSERT}
  INSERT INTO cloud_sync_todo_trash
    (project_ref, owner_user_id, entity, local_id, transaction_id, checklist_id, removed_with, removed_at, payload_json)
  SELECT s.project_ref, s.user_id, 'item', it.id, OLD.transaction_id, it.checklist_id, OLD.id, ${TODO_NOW},
         json_object('item', json(${itemJson("it")}), 'links', ${linksJson("it.id")})
    FROM cloud_sync_settings s JOIN transaction_checklist_items it ON it.checklist_id = OLD.id
   WHERE s.user_id = ${CHECKLIST_OWNER("OLD")} AND s.enabled = 1
  ${TRASH_UPSERT}`;
}

function todoSpec(
  name: string,
  table: string,
  timing: "AFTER" | "BEFORE",
  event: string,
  body: string,
  requires: Record<string, readonly string[]>,
): TodoTriggerSpec {
  return {
    name,
    table,
    requires: {
      cloud_sync_settings: ["project_ref", "user_id", "enabled"],
      cloud_sync_install: ["project_ref", "install_id"],
      cloud_sync_applying: ["id"],
      cloud_sync_todo_counter: ["project_ref", "install_id", "edit_seq", "max_wall_seen", "clock_epoch"],
      cloud_sync_todo_outbox: [
        "project_ref",
        "owner_user_id",
        "entity",
        "local_id",
        "part",
        "transaction_id",
        "value_json",
        "base_rev",
        "edit_seq",
        "edited_at",
        "clock_epoch",
        "op_id",
        "generation",
      ],
      cloud_sync_todo_state: ["project_ref", "owner_user_id", "entity", "local_id", "done_rev", "title_rev", "note_rev", "due_rev", "order_rev", "removed_rev"],
      transactions: ["id", "user_id"],
      ...requires,
    },
    sql: `CREATE TRIGGER ${name}\n${timing} ${event} ON ${table}\n${GATE}\nBEGIN\n  ${body}\nEND;`,
  };
}

/** Item columns each part records (plan §1.1). */
export const TODO_ITEM_PARTS: ReadonlyArray<{ part: string; columns: readonly string[] }> = [
  { part: "done", columns: ["is_checked", "checked_at"] },
  { part: "title", columns: ["title"] },
  { part: "note", columns: ["note"] },
  { part: "due", columns: ["due_date"] },
  { part: "order", columns: ["sort_order"] },
];
const ITEM_COLUMNS = [
  "id",
  "checklist_id",
  "title",
  "description",
  "is_required",
  "expected_document_type",
  "is_checked",
  "checked_at",
  "note",
  "due_date",
  "sort_order",
  "created_at",
];
const CHECKLIST_COLUMNS = ["id", "transaction_id", "template_id", "template_name", "sort_order", "selected_at"];
const TRASH_COLUMNS = ["project_ref", "owner_user_id", "entity", "local_id", "transaction_id", "checklist_id", "removed_with", "removed_at", "payload_json"];
const LINK_TABLES = {
  transaction_checklist_links: ["id", "item_id", "kind", "label", "sort_order", "created_at", "include_outside_dates"],
  transaction_checklist_link_members: ["id", "link_id", "kind", "attachment_id", "email_id", "message_id"],
};

const changed = (cols: readonly string[]) => cols.map((c) => `OLD.${c} IS NOT NEW.${c}`).join(" OR ");
const ANY_ITEM_PART = TODO_ITEM_PARTS.map((p) => `(${changed(p.columns)})`).join(" OR ");
const ITEM_PART_COLUMNS = TODO_ITEM_PARTS.flatMap((p) => p.columns);

export const CLOUD_SYNC_TODO_TRIGGERS: readonly TodoTriggerSpec[] = [
  todoSpec(
    "trg_cloud_sync_todo_checklist_insert",
    "transaction_checklists",
    "AFTER",
    "INSERT",
    `${counterStep(CHECKLIST_OWNER("NEW"), "1 = 1")}
  ${opInsert({ entity: "checklist", ref: "NEW", part: "create", owner: CHECKLIST_OWNER("NEW"), deal: "NEW.transaction_id", value: checklistJson("NEW"), cond: "1 = 1" })}`,
    { transaction_checklists: CHECKLIST_COLUMNS },
  ),
  todoSpec(
    "trg_cloud_sync_todo_checklist_update",
    "transaction_checklists",
    "AFTER",
    "UPDATE OF sort_order",
    `${counterStep(CHECKLIST_OWNER("NEW"), changed(["sort_order"]))}
  ${opInsert({
    entity: "checklist",
    ref: "NEW",
    part: "order",
    owner: CHECKLIST_OWNER("NEW"),
    deal: "NEW.transaction_id",
    value: "json_object('sort_order', NEW.sort_order)",
    cond: changed(["sort_order"]),
  })}`,
    { transaction_checklists: ["id", "transaction_id", "sort_order"] },
  ),
  todoSpec(
    "trg_cloud_sync_todo_checklist_delete",
    "transaction_checklists",
    "BEFORE",
    "DELETE",
    `${checklistTrashFromOld()}
  ${counterStep(CHECKLIST_OWNER("OLD"), "1 = 1")}
  ${opInsert({ entity: "checklist", ref: "OLD", part: "removed", owner: CHECKLIST_OWNER("OLD"), deal: "OLD.transaction_id", value: "json_object('removed', 1)", cond: "1 = 1" })}`,
    {
      transaction_checklists: CHECKLIST_COLUMNS,
      transaction_checklist_items: ITEM_COLUMNS,
      cloud_sync_todo_trash: TRASH_COLUMNS,
      ...LINK_TABLES,
    },
  ),
  todoSpec(
    "trg_cloud_sync_todo_item_insert",
    "transaction_checklist_items",
    "AFTER",
    "INSERT",
    `${counterStep(ITEM_OWNER("NEW"), "1 = 1")}
  ${opInsert({ entity: "item", ref: "NEW", part: "create", owner: ITEM_OWNER("NEW"), deal: ITEM_DEAL("NEW"), value: itemJson("NEW"), cond: "1 = 1" })}`,
    { transaction_checklist_items: ITEM_COLUMNS, transaction_checklists: ["id", "transaction_id"] },
  ),
  todoSpec(
    "trg_cloud_sync_todo_item_update",
    "transaction_checklist_items",
    "AFTER",
    `UPDATE OF ${ITEM_PART_COLUMNS.join(", ")}`,
    [
      counterStep(ITEM_OWNER("NEW"), ANY_ITEM_PART),
      ...TODO_ITEM_PARTS.map((p) =>
        opInsert({
          entity: "item",
          ref: "NEW",
          part: p.part,
          owner: ITEM_OWNER("NEW"),
          deal: ITEM_DEAL("NEW"),
          value: `json_object(${p.columns.map((c) => `'${c}', NEW.${c}`).join(", ")})`,
          cond: changed(p.columns),
        }),
      ),
    ].join("\n  "),
    { transaction_checklist_items: ["id", "checklist_id", ...ITEM_PART_COLUMNS], transaction_checklists: ["id", "transaction_id"] },
  ),
  todoSpec(
    "trg_cloud_sync_todo_item_delete",
    "transaction_checklist_items",
    "BEFORE",
    "DELETE",
    `${itemTrashFromOld()}
  ${counterStep(ITEM_OWNER("OLD"), "1 = 1")}
  ${opInsert({ entity: "item", ref: "OLD", part: "removed", owner: ITEM_OWNER("OLD"), deal: ITEM_DEAL("OLD"), value: "json_object('removed', 1)", cond: "1 = 1" })}`,
    {
      transaction_checklist_items: ITEM_COLUMNS,
      transaction_checklists: ["id", "transaction_id"],
      cloud_sync_todo_trash: TRASH_COLUMNS,
      ...LINK_TABLES,
    },
  ),
];

/**
 * Turn-on (R3): this computer's counter row, created when it is absent, from
 * the install row. One bound parameter: the project ref.
 */
export const SEED_TODO_COUNTER_SQL = `INSERT INTO cloud_sync_todo_counter (project_ref, install_id, edit_seq, clock_epoch)
SELECT i.project_ref, i.install_id, 0, 0 FROM cloud_sync_install i WHERE i.project_ref = ?
ON CONFLICT (project_ref, install_id) DO NOTHING`;
