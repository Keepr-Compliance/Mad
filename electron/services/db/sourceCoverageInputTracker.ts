/**
 * BACKLOG-3837: has anything that the per-source text floors read changed since they
 * were last read? Answered without reading a message row.
 *
 * The floors (MESSAGES_FLOOR_BY_SOURCE_SQL) walk every text row of the user and
 * json_extract its source: 1.9 s at 668k messages warm, far longer cold on the PC. They
 * only change when a messages row is inserted, deleted, or has one of the columns the
 * floor query reads changed. So the result is cached against this token.
 *
 * The mechanism (TEMP triggers on the main connection, MAX(rowid) for inserts, a random
 * epoch per connection) is shared: messagesInputTracker.ts.
 */
import type { Database as DatabaseType } from "better-sqlite3";
import { sql } from "./core/sqlText";
import {
  messagesTokenKey,
  readMessagesInputToken,
  type MessagesInputToken,
  type MessagesInputTrackerSpec,
} from "./messagesInputTracker";

export type SourceCoverageInputToken = MessagesInputToken;

const BUMP = sql`UPDATE temp.keepr_srccov_gen SET n = n + 1 WHERE k = 'writes'`;

/** The columns MESSAGES_FLOOR_BY_SOURCE_SQL reads (besides the key). */
const SPEC: MessagesInputTrackerSpec = {
  triggers: [
    {
      name: "keepr_srccov_msg_del",
      drop: sql`DROP TRIGGER IF EXISTS temp.keepr_srccov_msg_del`,
      ddl: sql`CREATE TEMP TRIGGER IF NOT EXISTS keepr_srccov_msg_del AFTER DELETE ON main.messages
    BEGIN ${BUMP}; END`,
    },
    {
      name: "keepr_srccov_msg_upd",
      drop: sql`DROP TRIGGER IF EXISTS temp.keepr_srccov_msg_upd`,
      ddl: sql`CREATE TEMP TRIGGER IF NOT EXISTS keepr_srccov_msg_upd
    AFTER UPDATE OF metadata, channel, duplicate_of, user_id, sent_at, associated_message_type ON main.messages
    WHEN OLD.metadata IS NOT NEW.metadata OR OLD.channel IS NOT NEW.channel
      OR OLD.duplicate_of IS NOT NEW.duplicate_of OR OLD.user_id IS NOT NEW.user_id
      OR OLD.sent_at IS NOT NEW.sent_at OR OLD.associated_message_type IS NOT NEW.associated_message_type
    BEGIN ${BUMP}; END`,
    },
  ],
  installedTriggersSql: sql`SELECT name, tbl_name FROM temp.sqlite_master WHERE type = 'trigger' AND name LIKE 'keepr_srccov_%'`,
  genRowsSql: sql`SELECT k, n FROM temp.keepr_srccov_gen`,
  dropGenSql: sql`DROP TABLE IF EXISTS temp.keepr_srccov_gen`,
  createGenSql: sql`CREATE TEMP TABLE IF NOT EXISTS keepr_srccov_gen (k TEXT PRIMARY KEY, n INTEGER NOT NULL)`,
  seedGenSql: sql`INSERT OR IGNORE INTO temp.keepr_srccov_gen (k, n) VALUES ('epoch', ?), ('writes', 0)`,
};

/**
 * The current token, installing the triggers when this connection has none (or lost
 * one). Null when they cannot be installed: callers then never serve a cached answer.
 */
export function readSourceCoverageInputToken(db: DatabaseType): SourceCoverageInputToken | null {
  return readMessagesInputToken(db, SPEC);
}

export function sourceCoverageTokenKey(t: SourceCoverageInputToken): string {
  return messagesTokenKey(t);
}
