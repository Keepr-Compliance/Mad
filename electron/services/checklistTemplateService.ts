/**
 * Broker checklist templates, read from the cloud — BACKLOG-3475.
 *
 * Modelled on `featureGateService`: a 5-minute memory cache, a 7-day disk cache
 * for offline use, both keyed by organization AND user (BACKLOG-3618: a
 * listing holds the user's own templates), and an `invalidate()` the renderer
 * can call after the broker edits a template in the portal, also run on every
 * sign-out.
 *
 * ## What is allowed to fail open here, and what is not
 *
 * **This service decides nothing about entitlement.** It answers "which
 * templates does this organization have", and serving a slightly stale answer
 * to a user on a train is right. Whether the user may use checklists AT ALL is
 * `isChecklistsAllowed()` in `featureGateHandlers`, which fails CLOSED, and the
 * handler calls it before this service is reached.
 *
 * ## `null` is not an empty list
 *
 * A read that could not be completed returns `null`. An organization with no
 * templates returns `{ source, templates: [] }`. Collapsing the two would put
 * "your brokerage has not set up any checklists" in front of a user whose wifi
 * is off — a false statement about someone else's account, which is the same
 * mistake `resolveStrictFeatureState` avoids by answering `unknown` rather than
 * `blocked`. There is no `catch` in this file that turns a failure into `[]`.
 *
 * ## Why rows are validated and dropped rather than trusted or thrown on
 *
 * The rows come from a table a broker edits. A row this build cannot parse is
 * dropped and logged; the rest of the listing is still usable, and a malformed
 * row never reaches the disk cache, so it cannot outlive the read that produced
 * it. See `electron/schemas/checklist.ts` for which fields degrade and which
 * disqualify a row.
 */

import { promises as fs } from "fs";
import path from "path";

import { app } from "electron";
import * as Sentry from "@sentry/electron/main";

import { safeValidate } from "../schemas/validate";
import { CloudChecklistTemplateSchema } from "../schemas/checklist";
import logService from "./logService";
import supabaseService from "./supabaseService";
import type {
  ChecklistTemplate,
  ChecklistTemplateItem,
  ChecklistTemplateListing,
} from "../types/checklist";
import type { DocumentType } from "../types/models";

/** Cache time-to-live: 5 minutes. Same as the feature cache. */
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Maximum age for the persisted cache: 7 days. Past that the answer is old
 * enough that showing it would be misleading, and `null` is the honest reply.
 */
const PERSISTED_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Cache file name, in the app's userData directory. */
const TEMPLATE_CACHE_FILENAME = "checklist-templates-cache.json";

/**
 * The exact column list BACKLOG-3473 probed against the real stack
 * (`supabase/tests/backlog-3473/postgrest/probe.mjs`), so the request this
 * ships is the request that was proven to pass that table's RLS.
 */
const TEMPLATE_SELECT =
  "id,name,description,sort_order,updated_at," +
  "checklist_template_items(id,title,description,is_required,expected_document_type,sort_order)";

/**
 * BACKLOG-3618: the same read plus the two columns that say whose template it
 * is and whether it is sent with submissions.
 */
const TEMPLATE_SELECT_3618 =
  "id,name,description,sort_order,updated_at,owner_user_id,include_in_submission," +
  "checklist_template_items(id,title,description,is_required,expected_document_type,sort_order)";

/**
 * PostgREST's answer when a selected or filtered column does not exist —
 * captured from production on 2026-09-30, before the 3618 migration was
 * applied: HTTP 400, `{"code":"42703","details":null,"hint":null,"message":
 * "column checklist_templates.owner_user_id does not exist"}`. A database
 * without the 3618 columns (not yet applied, or rolled back) answers exactly
 * this, and ONLY this code sends the read back to {@link TEMPLATE_SELECT}.
 */
const UNDEFINED_COLUMN_CODE = "42703";

/**
 * The user id goes into a PostgREST filter string, so it must be a plain
 * token. A Supabase user id is a UUID; anything with filter syntax in it is
 * refused rather than escaped.
 */
const FILTER_SAFE_ID = /^[A-Za-z0-9-]+$/;

interface TemplateCache {
  templates: ChecklistTemplate[];
  fetchedAt: number;
  orgId: string;
  /**
   * BACKLOG-3618: whose listing this is. A listing now holds the user's own
   * templates, so it belongs to one person, not to the organization. A file
   * written before 3618 has no `userId` and is refused.
   */
  userId: string;
}

function toItem(row: {
  id: string;
  title: string;
  description: string | null;
  is_required: boolean;
  expected_document_type: string | null;
  sort_order: number;
}): ChecklistTemplateItem {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    isRequired: row.is_required === true,
    expectedDocumentType: (row.expected_document_type as DocumentType | null) ?? null,
    sortOrder: row.sort_order,
  };
}

class ChecklistTemplateService {
  private cache: TemplateCache | null = null;
  /**
   * The reads currently out, one per organization + user pair, keyed by the
   * organization and user each asked about. See {@link
   * ChecklistTemplateService.fetchOnce}.
   */
  private fetchInProgress = new Map<string, Promise<ChecklistTemplate[] | null>>();

  /**
   * The templates this organization may pick from.
   *
   * Resolution order, and it is the order that matters:
   *   1. a fresh memory cache for THIS org + user;
   *   2. the cloud;
   *   3. the disk cache for THIS org + user, if it is under 7 days old;
   *   4. `null` — could not find out.
   *
   * @param orgId Resolved by the caller through `resolveOrgId()`. This service
   *   never resolves an organization for itself: the handler is where the
   *   membership question is answered, and answering it twice in two ways is
   *   how two parts of an app come to disagree about who the user is.
   */
  async listTemplates(orgId: string): Promise<ChecklistTemplateListing | null> {
    // BACKLOG-3618: the listing includes the user's own templates, so every
    // cache is keyed on the user as well as the organization. No signed-in
    // user → nothing can be read AND no cache can be shown: a file on this
    // profile may belong to someone else.
    const userId = await this.currentUserId(orgId);
    if (!userId) return null;

    if (this.isCacheFresh(orgId, userId)) {
      return { source: "cache", templates: this.cache!.templates };
    }

    const fetched = await this.fetchOnce(orgId, userId);
    if (fetched) {
      return { source: "live", templates: fetched };
    }

    const persisted = await this.loadPersistedCache(orgId, userId);
    if (persisted) {
      this.cache = persisted;
      return { source: "cache", templates: persisted.templates };
    }

    return null;
  }

  /**
   * Drop the memory cache AND the file, so the next read goes to the cloud.
   *
   * Both, not one. A broker who renames a template in the portal and comes back
   * to the desktop is told the change is live; clearing only the memory cache
   * would let the next read fall through to a file holding exactly the stale
   * rows they just replaced, on any read where the network was slow. The file
   * is the part that survives a restart, so it is the part that has to go.
   */
  async invalidate(): Promise<void> {
    this.cache = null;
    try {
      await fs.unlink(this.getCacheFilePath());
      logService.debug(
        "[ChecklistTemplates] Cache invalidated (memory + disk)",
        "ChecklistTemplateService",
      );
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        logService.warn(
          "[ChecklistTemplates] Failed to remove persisted cache",
          "ChecklistTemplateService",
          { error: error instanceof Error ? error.message : "Unknown error" },
        );
      }
    }
  }

  private async currentUserId(orgId: string): Promise<string | null> {
    try {
      const session = await supabaseService.getAuthSession();
      const userId = session?.userId ?? null;
      if (!userId || !FILTER_SAFE_ID.test(userId)) {
        logService.warn(
          "[ChecklistTemplates] No usable signed-in user, cannot list templates",
          "ChecklistTemplateService",
          { orgId },
        );
        return null;
      }
      return userId;
    } catch (error) {
      logService.warn(
        "[ChecklistTemplates] Reading the signed-in user threw",
        "ChecklistTemplateService",
        { orgId, error: error instanceof Error ? error.message : "Unknown error" },
      );
      return null;
    }
  }

  private isCacheFresh(orgId: string, userId: string): boolean {
    if (!this.cache) return false;
    if (this.cache.orgId !== orgId) return false;
    if (this.cache.userId !== userId) return false;
    return Date.now() - this.cache.fetchedAt < CACHE_TTL_MS;
  }

  /**
   * Collapse concurrent reads onto one request — for the SAME organization
   * and user.
   *
   * Keying the in-flight reads by organization AND user (BACKLOG-3618) is the
   * whole point, and it is the same hazard {@link
   * ChecklistTemplateService.loadPersistedCache} guards on the disk path: a
   * user who belongs to two brokerages, or who switches accounts, must never be
   * handed the other organization's templates. Sharing the promise blind would
   * do exactly that, and `listTemplates` would then label the other
   * brokerage's rows `source: "live"` — plan-holder data, from a plan they are
   * not on, presented as freshly confirmed.
   *
   * `featureGateService.ensureFresh` shares its promise WITHOUT this check and
   * is still safe, for a reason that does not carry over here: it returns
   * `void`, and both of its callers re-read `this.cache` behind
   * `this.cache.orgId === orgId`, so a foreign result is dropped one line
   * later. Returning the promise's VALUE is what removes that second line of
   * defence, which is why the check belongs in this function.
   *
   * A map rather than one slot (BACKLOG-3476): with a single slot, reads for
   * A, then B, then A again while both are out would lose A's entry to B and
   * send a second request for A. One entry per organization + user pair
   * (BACKLOG-3618) keeps every pair's collapsing independent of the others.
   */
  private async fetchOnce(orgId: string, userId: string): Promise<ChecklistTemplate[] | null> {
    // BACKLOG-3618: keyed on the user too — two users' reads are two answers.
    const key = `${orgId}|${userId}`;
    const inFlight = this.fetchInProgress.get(key);
    if (inFlight) {
      return inFlight;
    }

    const promise = this.fetchFromSupabase(orgId, userId);
    this.fetchInProgress.set(key, promise);
    try {
      return await promise;
    } finally {
      // Delete only our OWN entry. Nothing else writes this key today, so the
      // comparison always holds; it is here so that a later writer (a forced
      // refresh, say) cannot have its read deleted by an older one finishing.
      if (this.fetchInProgress.get(key) === promise) {
        this.fetchInProgress.delete(key);
      }
    }
  }

  /**
   * One PostgREST read under BACKLOG-3473's RLS, or `null`.
   *
   * Every failure lands in the same place on purpose: no session, a thrown
   * client, a PostgREST error of any code, a body that is not a list. The
   * desktop has no business telling those apart — the only two things the
   * surface above can say are "here are your templates" and "we could not read
   * them". In particular this must NOT special-case any one error code — for
   * example the missing-table error the API returned before BACKLOG-3473's
   * tables were applied to production (they are now). An error branch written
   * around one response would be a guess about a shape nobody has captured.
   */
  private async fetchFromSupabase(
    orgId: string,
    userId: string,
  ): Promise<ChecklistTemplate[] | null> {
    try {
      const client = supabaseService.getClient();

      // BACKLOG-3618: brokerage templates plus the user's OWN. The owner filter
      // is explicit even though RLS already hides other people's templates:
      // if the policy ever lets a broker see agents' lists, this read must
      // still show a user only theirs.
      let { data, error } = await client
        .from("checklist_templates")
        .select(TEMPLATE_SELECT_3618)
        .eq("organization_id", orgId)
        .is("archived_at", null)
        .or(`owner_user_id.is.null,owner_user_id.eq.${userId}`)
        .order("sort_order", { ascending: true });

      // A database without the 3618 columns (not yet applied, or rolled back)
      // has no own templates at all — every row is the brokerage's and is
      // sent. Read it the way builds before 3618 did. Only the captured
      // missing-column code comes here; every other error is a failed read.
      if (error && (error as { code?: unknown }).code === UNDEFINED_COLUMN_CODE) {
        logService.info(
          "[ChecklistTemplates] Own-template columns absent, reading brokerage templates only",
          "ChecklistTemplateService",
          { orgId },
        );
        ({ data, error } = await client
          .from("checklist_templates")
          .select(TEMPLATE_SELECT)
          .eq("organization_id", orgId)
          .is("archived_at", null)
          .order("sort_order", { ascending: true }));
      }

      if (error) {
        logService.warn(
          "[ChecklistTemplates] Template read failed",
          "ChecklistTemplateService",
          { orgId, code: error.code, message: error.message },
        );
        return null;
      }
      if (!Array.isArray(data)) {
        // A shape this code cannot read is not "no templates".
        logService.warn(
          "[ChecklistTemplates] Template read returned a body that is not a list",
          "ChecklistTemplateService",
          { orgId },
        );
        return null;
      }

      const templates = this.parseRows(data, orgId, userId);

      this.cache = { templates, fetchedAt: Date.now(), orgId, userId };
      await this.persistCache();
      return templates;
    } catch (error) {
      logService.warn(
        "[ChecklistTemplates] Template read threw",
        "ChecklistTemplateService",
        { orgId, error: error instanceof Error ? error.message : "Unknown error" },
      );
      Sentry.captureException(error, {
        tags: {
          service: "checklist-template-service",
          operation: "fetchFromSupabase",
        },
      });
      return null;
    }
  }

  /**
   * Validate every row, drop the ones that do not parse, and sort.
   *
   * The items are sorted HERE rather than by the server because a PostgREST
   * embed carries no order — `.order("sort_order")` applies to the outer table
   * only, and trusting the embed's arrival order is how a checklist comes out
   * shuffled on one machine and not another.
   */
  private parseRows(rows: unknown[], orgId: string, userId: string): ChecklistTemplate[] {
    const templates: ChecklistTemplate[] = [];
    let dropped = 0;
    let notOwn = 0;

    for (const row of rows) {
      const parsed = safeValidate(CloudChecklistTemplateSchema, row);
      if (!parsed.success) {
        dropped += 1;
        continue;
      }
      // BACKLOG-3618: absent (pre-3618 database) or null = the brokerage's.
      // Someone else's own template never reaches the list or the cache,
      // whatever the server sent.
      const owner = parsed.data.owner_user_id ?? null;
      if (owner !== null && owner !== userId) {
        notOwn += 1;
        continue;
      }
      const isMine = owner !== null;
      templates.push({
        id: parsed.data.id,
        name: parsed.data.name,
        description: parsed.data.description,
        sortOrder: parsed.data.sort_order,
        updatedAt: parsed.data.updated_at,
        items: parsed.data.checklist_template_items
          .map(toItem)
          .sort((a, b) => a.sortOrder - b.sortOrder),
        isMine,
        // A brokerage template is always sent (the database's CHECK); only an
        // own template can be held back, and an absent value means sent.
        includeInSubmission: isMine ? parsed.data.include_in_submission !== false : true,
      });
    }

    if (notOwn > 0) {
      logService.warn(
        "[ChecklistTemplates] Dropped another user's own templates from the read",
        "ChecklistTemplateService",
        { orgId, dropped: notOwn },
      );
    }
    if (dropped > 0) {
      logService.warn(
        "[ChecklistTemplates] Dropped template rows that did not validate",
        "ChecklistTemplateService",
        { orgId, dropped, kept: templates.length },
      );
    }
    return templates.sort((a, b) => a.sortOrder - b.sortOrder);
  }

  private getCacheFilePath(): string {
    return path.join(app.getPath("userData"), TEMPLATE_CACHE_FILENAME);
  }

  private async persistCache(): Promise<void> {
    if (!this.cache) return;
    try {
      await fs.writeFile(
        this.getCacheFilePath(),
        JSON.stringify(this.cache, null, 2),
        "utf8",
      );
    } catch (error) {
      logService.warn(
        "[ChecklistTemplates] Failed to persist cache to disk",
        "ChecklistTemplateService",
        { error: error instanceof Error ? error.message : "Unknown error" },
      );
      Sentry.captureException(error, {
        tags: {
          service: "checklist-template-service",
          operation: "persistCache",
        },
      });
    }
  }

  /**
   * The disk cache, if it belongs to THIS organization and is not too old.
   *
   * The `orgId` comparison is the whole reason the file stores one: a user who
   * belongs to two brokerages, or who switches accounts, would otherwise be
   * shown the other organization's checklist templates — plan-holder data, from
   * a plan they are not on, rendered as though it were theirs.
   */
  private async loadPersistedCache(orgId: string, userId: string): Promise<TemplateCache | null> {
    try {
      const raw = await fs.readFile(this.getCacheFilePath(), "utf8");
      const cache: TemplateCache = JSON.parse(raw);

      if (cache.orgId !== orgId) {
        logService.debug(
          "[ChecklistTemplates] Persisted cache is for a different org, ignoring",
          "ChecklistTemplateService",
        );
        return null;
      }
      // BACKLOG-3618: and for THIS user. A second person signing in to the
      // same profile, same brokerage, must never see the first one's own
      // checklists. A pre-3618 file has no userId and is refused here.
      if (cache.userId !== userId) {
        logService.debug(
          "[ChecklistTemplates] Persisted cache is for a different user, ignoring",
          "ChecklistTemplateService",
        );
        return null;
      }

      const age = Date.now() - cache.fetchedAt;
      if (age > PERSISTED_CACHE_MAX_AGE_MS) {
        logService.info(
          "[ChecklistTemplates] Persisted cache too old, discarding",
          "ChecklistTemplateService",
          { orgId, ageDays: Math.round(age / (24 * 60 * 60 * 1000)) },
        );
        try {
          await fs.unlink(this.getCacheFilePath());
        } catch {
          // Nothing to clean up, or it cannot be removed. Either way the cache
          // was already refused above.
        }
        return null;
      }

      if (!Array.isArray(cache.templates)) return null;
      return cache;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        logService.warn(
          "[ChecklistTemplates] Failed to read persisted cache",
          "ChecklistTemplateService",
          { error: error instanceof Error ? error.message : "Unknown error" },
        );
      }
      return null;
    }
  }
}

const checklistTemplateService = new ChecklistTemplateService();
export default checklistTemplateService;
