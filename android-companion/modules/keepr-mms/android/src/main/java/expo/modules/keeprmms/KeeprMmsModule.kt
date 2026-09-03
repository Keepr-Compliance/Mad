package expo.modules.keeprmms

import android.Manifest
import android.content.ContentResolver
import android.content.Context
import android.content.pm.PackageManager
import android.database.Cursor
import android.net.Uri
import android.util.Log
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONArray
import org.json.JSONObject

/**
 * KeeprMms — a bounded, oldest-first read of the Android MMS store (BACKLOG-2973).
 *
 * ## Why this module exists at all
 *
 * `services/smsReader.ts` reads through `react-native-get-sms-android`, whose
 * `SmsModule.list` hard-codes the authority (`Uri.parse("content://sms/" + box)`).
 * No `box` value reaches `content://mms`, so **nothing in the companion could see
 * an MMS row**. That is why RCS conversations, group threads and photo messages
 * are all invisible to the audit (BACKLOG-3037) — not because they are
 * unreachable, but because nobody looked where they land.
 *
 * `react-native-get-mms-android` was evaluated and rejected on its API surface,
 * not on build grounds (it does build, after a two-hunk Gradle patch). Its only
 * bounded entry point is `getMMS(threadId)`, and a thread id can only be
 * discovered from `content://sms` rows — which an RCS-only conversation does not
 * have. Its other entry point, `getAllMMS()`, has no `minDate`, no max count, no
 * sort order and no offset: adopting it would abandon both the BACKLOG-2199
 * oldest-first cursor and BACKLOG-2207 bounded paging. Full working in the
 * BACKLOG-2973 comment thread.
 *
 * ## What this module deliberately does NOT do
 *
 * It returns the provider's rows **raw and uninterpreted**: no SMIL filtering, no
 * text concatenation, no participant resolution, no mapping to `SyncMessage`.
 * Those are BACKLOG-2974 (body) and BACKLOG-2975 (participants), and they need
 * product decisions this module must not pre-empt. Mapping here would also mean
 * inventing a `sender` and a `body` for a shape that has neither — the exact
 * collapse-to-empty this codebase keeps paying for.
 *
 * ## Provider facts this implementation is built on
 *
 * Observed on a live API-36 emulator during the BACKLOG-2973 spike, each with a
 * discriminating control (see the item's comment thread):
 *
 *  - **`content://mms` has NO `address` column.** Querying it fails with
 *    `no such column: address`, discriminated against a bogus-column control.
 *    Participants live only in `content://mms/{id}/addr`.
 *  - **A `READ_SMS` caller is served a view, not the table:**
 *    `CREATE VIEW pdu_restricted AS SELECT * FROM pdu WHERE (msg_box=1 OR msg_box=2) AND (m_type!=130)`.
 *    So we see received + sent and never an undownloaded-MMS stub. Drafts are out
 *    of scope by founder ruling, so this view costs us nothing and is not worked
 *    around.
 *  - **Default sort is `date DESC`.** Left alone, a bounded read returns the
 *    NEWEST n rows rather than a contiguous prefix, and advancing the cursor past
 *    them strands older messages forever (BACKLOG-2199). We force `date ASC`.
 *  - **Reading needs no root**, only `READ_SMS`.
 *
 * ## The `date` unit is NOT yet observed from a real writer
 *
 * Seeded values round-trip byte-identical, so the provider does not normalise:
 * the unit is whatever wrote the row. AOSP documents `Telephony.BaseMmsColumns.DATE`
 * as **seconds** (SMS is milliseconds) and SMS Backup & Restore exports
 * milliseconds. Neither is an observation of Google Messages.
 *
 * This is not just a parsing problem — it is a **selection** problem, and that is
 * the dangerous half. The caller's cursor is in milliseconds. If the rows are in
 * seconds, `date >= <ms floor>` matches nothing, and the read returns zero rows
 * forever while looking perfectly healthy. That is the BACKLOG-1448 shape.
 * So the selection is written to be unit-agnostic (see [buildSelection]) and the
 * raw value is logged on every page so the first real-device read settles it as
 * a fact rather than an assumption.
 */
class KeeprMmsModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("KeeprMms")

    /**
     * One bounded page of MMS rows, oldest-first.
     *
     * @param minDate  cursor floor in MILLISECONDS (the unit `smsReader` already
     *                 uses). `<= 0` means "no floor". Inclusive (`>=`), matching
     *                 the SMS path where callers pass `lastSynced + 1`.
     * @param indexFrom row offset into the sorted, filtered set.
     * @param maxCount  maximum rows to return for this page.
     * @return a JSON string `{ "rawCount": n, "rows": [...] }`. A string rather
     *         than a structured value on purpose: it mirrors the payload contract
     *         `smsReader` already parses, and it keeps `parse_failed` a real,
     *         reachable failure reason instead of a category that can never fire.
     */
    AsyncFunction("list") { minDate: Double, indexFrom: Int, maxCount: Int ->
      listMms(minDate.toLong(), indexFrom, maxCount)
    }
  }

  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  private fun listMms(minDateMs: Long, indexFrom: Int, maxCount: Int): String {
    val ctx = context

    // Checked explicitly rather than left to the SecurityException the query
    // would throw: a revoked permission must be reported as `permission_denied`
    // and never as an empty page (BACKLOG-2206).
    if (ctx.checkSelfPermission(Manifest.permission.READ_SMS) != PackageManager.PERMISSION_GRANTED) {
      throw MmsPermissionDeniedException()
    }

    if (maxCount <= 0) {
      return JSONObject().put(KEY_RAW_COUNT, 0).put(KEY_ROWS, JSONArray()).toString()
    }

    val resolver = ctx.contentResolver
    val selection = buildSelection(minDateMs)

    val rows = JSONArray()
    var rawCount = 0

    queryOrThrow(
      resolver = resolver,
      uri = MMS_URI,
      projection = MMS_PROJECTION,
      selection = selection?.first,
      selectionArgs = selection?.second,
      sortOrder = SORT_OLDEST_FIRST
    ).use { cursor ->
      // Window by absolute cursor position rather than by appending LIMIT/OFFSET
      // to the sort order. The LIMIT-in-sortOrder trick is a SQLite-passthrough
      // quirk that is unverified against MmsProvider; `moveToPosition` is the
      // mechanism `react-native-get-sms-android` already uses successfully on the
      // sibling authority, and it cannot be silently ignored by the provider.
      if (!cursor.moveToPosition(indexFrom)) {
        // Offset is at or past the end of the set — a genuine, successful empty
        // page (this is how the paging loop learns the backlog is exhausted).
        return@use
      }
      do {
        if (rawCount >= maxCount) break
        rows.put(readMessage(resolver, cursor))
        rawCount++
      } while (cursor.moveToNext())
    }

    // The raw `date` of the first row, logged unparsed. The unit is the one fact
    // this module could not observe from a real writer; the first real-device
    // read settles it, and it can only do so if the value is visible.
    if (rows.length() > 0) {
      Log.i(
        TAG,
        "page minDateMs=$minDateMs indexFrom=$indexFrom maxCount=$maxCount -> $rawCount rows; " +
          "first row _id=${rows.getJSONObject(0).optString(COL_ID)} " +
          "thread_id=${rows.getJSONObject(0).optString(COL_THREAD_ID)} " +
          "RAW date=${rows.getJSONObject(0).optString(COL_DATE)} (unit NOT normalised here)"
      )
    } else {
      Log.i(TAG, "page minDateMs=$minDateMs indexFrom=$indexFrom maxCount=$maxCount -> 0 rows")
    }

    return JSONObject().put(KEY_RAW_COUNT, rawCount).put(KEY_ROWS, rows).toString()
  }

  /**
   * The `date >=` filter, written so it is correct whether the provider stores
   * seconds or milliseconds — see the class comment. A row is classified by its
   * own magnitude and compared against the matching floor:
   *
   *     (date <  1e11 AND date >= floorSeconds)    -- second-magnitude row
   *  OR (date >= 1e11 AND date >= floorMillis)     -- millisecond-magnitude row
   *
   * The boundary is unambiguous for any real message: 1e11 ms is 1973-03-03 and
   * 1e11 s is the year 5138, so no genuine message can be misclassified.
   *
   * Returns null when there is no floor to apply. Values are BOUND, never
   * concatenated — the library this replaced built `"thread_id=" + threadId` by
   * hand.
   */
  private fun buildSelection(minDateMs: Long): Pair<String, Array<String>>? {
    if (minDateMs <= 0) return null
    // Integer division floors, which keeps the bound INCLUSIVE: a row stored at
    // second s is kept for any cursor within that second, so a message can never
    // fall between the two units and be skipped.
    val floorSeconds = minDateMs / 1000L
    return Pair(
      "($COL_DATE < $MILLIS_MAGNITUDE_THRESHOLD AND $COL_DATE >= ?) OR " +
        "($COL_DATE >= $MILLIS_MAGNITUDE_THRESHOLD AND $COL_DATE >= ?)",
      arrayOf(floorSeconds.toString(), minDateMs.toString())
    )
  }

  /** One `content://mms` row, plus its parts and addresses, all raw. */
  private fun readMessage(resolver: ContentResolver, cursor: Cursor): JSONObject {
    val row = JSONObject()
    for (column in MMS_PROJECTION) {
      row.put(column, cursor.stringOrNull(column))
    }

    val messageId = cursor.stringOrNull(COL_ID)
      ?: throw MmsQueryFailedException("content://mms returned a row with no $COL_ID", null)

    row.put(KEY_PARTS, readChildren(resolver, partUri(messageId), PART_PROJECTION))
    row.put(KEY_ADDRS, readChildren(resolver, addrUri(messageId), ADDR_PROJECTION))
    return row
  }

  /**
   * Rows from a per-message child table (`.../part`, `.../addr`).
   *
   * A failure here fails the WHOLE read rather than yielding an empty list: an
   * empty `parts` list is indistinguishable from "this message has no
   * attachments", and an empty `addrs` list from "nobody is on this thread".
   * Both are wrong answers that look like data (BACKLOG-1448 / 2206).
   */
  private fun readChildren(
    resolver: ContentResolver,
    uri: Uri,
    projection: Array<String>
  ): JSONArray {
    val out = JSONArray()
    queryOrThrow(resolver, uri, projection, null, null, null).use { cursor ->
      while (cursor.moveToNext()) {
        val child = JSONObject()
        for (column in projection) {
          child.put(column, cursor.stringOrNull(column))
        }
        out.put(child)
      }
    }
    return out
  }

  /**
   * `resolver.query` with the two failure modes made explicit.
   *
   * A **null cursor** is the important one: it means the provider refused the
   * query, and it is returned rather than thrown. Treated as "no rows" it is a
   * silent zero-message read — the on-device form of the defect that hid a broken
   * SMS reader for an entire release (BACKLOG-1448).
   */
  private fun queryOrThrow(
    resolver: ContentResolver,
    uri: Uri,
    projection: Array<String>,
    selection: String?,
    selectionArgs: Array<String>?,
    sortOrder: String?
  ): Cursor {
    val cursor = try {
      resolver.query(uri, projection, selection, selectionArgs, sortOrder)
    } catch (e: SecurityException) {
      // READ_SMS revoked between the check above and the query, or an OEM
      // provider refusing this caller outright.
      throw MmsPermissionDeniedException(e)
    } catch (e: Exception) {
      throw MmsQueryFailedException("query failed for $uri: ${e.message}", e)
    }
    return cursor ?: throw MmsQueryFailedException(
      "content resolver returned a NULL cursor for $uri (provider refused the query)",
      null
    )
  }

  private fun Cursor.stringOrNull(column: String): String? {
    val index = getColumnIndex(column)
    if (index < 0 || isNull(index)) return null
    return getString(index)
  }

  private companion object {
    const val TAG = "KeeprMms"

    val MMS_URI: Uri = Uri.parse("content://mms")

    /**
     * `content://mms/{id}/part`, NOT `content://mms/part`. The latter accepts an
     * insert and silently writes a garbage `mid` (observed: `mid=2047483647`),
     * which produces orphaned parts that look like a reader bug. BACKLOG-2974.
     */
    fun partUri(messageId: String): Uri = Uri.parse("content://mms/$messageId/part")

    fun addrUri(messageId: String): Uri = Uri.parse("content://mms/$messageId/addr")

    const val COL_ID = "_id"
    const val COL_THREAD_ID = "thread_id"
    const val COL_DATE = "date"

    /**
     * Deliberately NOT `address` — that column does not exist on `content://mms`
     * and projecting it fails the whole query (`no such column: address`).
     */
    val MMS_PROJECTION = arrayOf(COL_ID, COL_THREAD_ID, COL_DATE, "date_sent", "msg_box", "m_type")

    val PART_PROJECTION = arrayOf(COL_ID, "seq", "ct", "name", "cl", "chset", "text", "_data")

    val ADDR_PROJECTION = arrayOf(COL_ID, "address", "type", "charset")

    /** BACKLOG-2199: oldest-first, so a bounded page is a contiguous prefix. */
    const val SORT_OLDEST_FIRST = "date ASC"

    /** 1e11 — see [buildSelection]. */
    const val MILLIS_MAGNITUDE_THRESHOLD = 100000000000L

    const val KEY_RAW_COUNT = "rawCount"
    const val KEY_ROWS = "rows"
    const val KEY_PARTS = "parts"
    const val KEY_ADDRS = "addrs"

}

/**
 * READ_SMS is not granted (or was revoked mid-run). Carries its own code so the
 * JS side can render the actionable "re-grant SMS access" copy rather than the
 * generic read-error copy.
 */
internal class MmsPermissionDeniedException(cause: Throwable? = null) : CodedException(
  "ERR_MMS_PERMISSION_DENIED",
  "READ_SMS permission is not granted, so the MMS store cannot be read",
  cause
)

/** The provider refused or failed the query. NEVER reported as zero rows. */
internal class MmsQueryFailedException(detail: String, cause: Throwable?) : CodedException(
  "ERR_MMS_QUERY_FAILED",
  detail,
  cause
)
