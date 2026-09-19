/**
 * Apple's macOS Messages database (`~/Library/Messages/chat.db`) — BACKLOG-2990 chunk 3a.
 *
 * Moved out of `services/macOSMessagesImportService/macOSMessagesImportService.ts`
 * under BACKLOG-2959's rule: SQL text is DEFINED in `db/`, wherever it is executed.
 *
 * ## Apple's schema, and why the rule still applies
 *
 * `chat.db` is Apple's, not Keepr's. This app OPENS IT READ-ONLY and never
 * writes, migrates or owns it. The rule is about where SQL text is DEFINED, not
 * about which database answers it — and the access path is already `db/`-owned,
 * since `openSqliteReadOnly` is the single ESLint-enforced entry point for these
 * handles.
 *
 * The module is named for the schema so nobody mistakes `chat_handle_join` for a
 * Keepr table, and so Apple's identifiers never enter Keepr's branded name types
 * (`StagingTableName` and friends). Same reasoning as `appleAddressBookSql.ts`
 * for `AddressBook.sqlitedb` and `appleSmsDbSql.ts` for an iPhone backup's
 * `sms.db`.
 *
 * ## Separate from `appleSmsDbSql.ts`, deliberately
 *
 * An iPhone backup's `sms.db` and a Mac's `chat.db` are the same Apple Messages
 * schema, but they are read by two different importers, over two different
 * drivers, for two different projections. `appleSmsDbSql.ts` (chunk 2) serves
 * `iosMessagesParser` over better-sqlite3; this serves the macOS importer over
 * node-sqlite3. Merging them would couple two import paths that have never
 * needed to agree, so that a change made for one silently reshapes the other.
 *
 * ## Shape: text out, execution stays with the caller
 *
 * Every export here is a CONSTANT. Nothing in this file executes anything, so
 * each call site keeps its own verb and stays an enumerated site the gate can
 * see — the shape `db/emailForceSetSql.ts` describes as allowed. The forbidden
 * combination is a `db/` export that RECEIVES SQL text as a parameter and
 * EXECUTES it, leaving the caller with no verb.
 *
 * ## Not moved by this chunk
 *
 * Four statements in the importer splice in `dateFilterClause` / `capFetchClause`
 * — SQL text built in `services/` by `buildMessageWindowSql`. Moving those here
 * as-is would mean this module executing a predicate it was handed as text,
 * which is exactly the design BACKLOG-2989 commit A2 removed. They move once
 * BACKLOG-3062 makes the window predicate build from plan DATA, with the numbers
 * BOUND rather than spliced.
 */

/**
 * Every importable row, unfiltered by date — the "X of Y" denominator.
 *
 * BACKLOG-2280: reactions ARE imported, so this count and the fetch SELECT must
 * cover the SAME scope. The fetch loop runs `while (fetchedCount < total)`, so a
 * count that excluded reactions while the SELECT included them (or the reverse)
 * would terminate the loop early and silently DROP the newest rows, which are
 * last under `ORDER BY message.ROWID ASC`.
 *
 * `guid IS NOT NULL` is the importability test: a row without a GUID has no
 * stable external identity, so it can be neither deduplicated nor re-linked.
 *
 * Executed on BOTH paths — the import run reads it with `all`, the pre-flight
 * estimate with `get`. One text, so the estimate and the run it precedes can
 * never describe different libraries.
 */
export const MACOS_MESSAGE_TOTAL_COUNT_SQL = `
          SELECT COUNT(*) as count FROM message WHERE guid IS NOT NULL
        `;

/**
 * The real participant list for every chat, from the join table.
 *
 * Small table, loaded in one shot rather than per-chat: the importer builds a
 * `chat_id -> handle[]` map once and reads it for every message. `handle.id` is
 * the phone number or Apple ID as Apple stores it.
 */
export const MACOS_CHAT_MEMBER_HANDLES_SQL = `
          SELECT
            chat_handle_join.chat_id,
            handle.id as handle_id
          FROM chat_handle_join
          JOIN handle ON chat_handle_join.handle_id = handle.ROWID
        `;

/**
 * Which of the user's OWN identifiers they used in each conversation.
 *
 * `account_login` carries a `P:` (phone) or `E:` (email) prefix that the caller
 * strips. Filtered to non-NULL here because a chat with no account_login tells
 * the importer nothing.
 */
export const MACOS_CHAT_ACCOUNT_LOGINS_SQL = `
          SELECT
            ROWID as chat_id,
            account_login
          FROM chat
          WHERE account_login IS NOT NULL
        `;

/**
 * The user-visible GROUP NAME ("Closing Team") — BACKLOG-2814.
 *
 * A SEPARATE query from the `account_login` one rather than another column on
 * it, because that query is filtered `WHERE account_login IS NOT NULL` and a
 * named group whose chat row has no account_login would be silently dropped.
 *
 * NULL is filtered here, the empty string in `buildChatNameMap`. Apple uses BOTH
 * for "unnamed", and against a real chat.db the empty string outnumbers NULL
 * more than ten to one (2,564 vs 234 of 2,886) — so treating only NULL as absent
 * would name almost every chat "".
 */
export const MACOS_CHAT_DISPLAY_NAMES_SQL = `
          SELECT
            ROWID as chat_id,
            display_name
          FROM chat
          WHERE display_name IS NOT NULL
        `;

/**
 * Attachments joined to the messages that carry them, for the import itself.
 *
 * Both `IS NOT NULL` terms are load-bearing: a row with no message GUID cannot
 * be linked to anything the importer stores, and a row with no filename has no
 * source file to copy.
 */
export const MACOS_MESSAGE_ATTACHMENTS_SQL = `
          SELECT
            attachment.ROWID as attachment_id,
            message.ROWID as message_id,
            message.guid as message_guid,
            attachment.guid,
            attachment.filename,
            attachment.mime_type,
            attachment.transfer_name,
            attachment.total_bytes,
            attachment.is_outgoing
          FROM attachment
          JOIN message_attachment_join ON attachment.ROWID = message_attachment_join.attachment_id
          JOIN message ON message.ROWID = message_attachment_join.message_id
          WHERE message.guid IS NOT NULL
            AND attachment.filename IS NOT NULL
        `;

/**
 * Filename-to-GUID pairs, for repairing attachment rows whose `message_id` went
 * stale after a re-sync gave the message a new primary key.
 *
 * A narrower projection than `MACOS_MESSAGE_ATTACHMENTS_SQL` on purpose — the
 * repair needs only the mapping, and this runs over the user's whole attachment
 * history.
 */
export const MACOS_ATTACHMENT_FILENAME_GUIDS_SQL = `
        SELECT
          attachment.filename,
          message.guid as message_guid
        FROM attachment
        JOIN message_attachment_join ON attachment.ROWID = message_attachment_join.attachment_id
        JOIN message ON message.ROWID = message_attachment_join.message_id
        WHERE attachment.filename IS NOT NULL AND message.guid IS NOT NULL
      `;
