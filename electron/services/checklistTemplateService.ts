/**
 * Broker checklist templates, read from the cloud — BACKLOG-3475.
 *
 * Modelled on `featureGateService`: a 5-minute memory cache, a 7-day disk cache
 * for offline use, both keyed by organization, and an `invalidate()` the
 * renderer can call after the broker edits a template in the portal.
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

interface TemplateCache {
  templates: ChecklistTemplate[];
  fetchedAt: number;
  orgId: string;
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
  private fetchInProgress: Promise<ChecklistTemplate[] | null> | null = null;

  /**
   * The templates this organization may pick from.
   *
   * Resolution order, and it is the order that matters:
   *   1. a fresh memory cache for THIS org;
   *   2. the cloud;
   *   3. the disk cache for THIS org, if it is under 7 days old;
   *   4. `null` — could not find out.
   *
   * @param orgId Resolved by the caller through `resolveOrgId()`. This service
   *   never resolves an organization for itself: the handler is where the
   *   membership question is answered, and answering it twice in two ways is
   *   how two parts of an app come to disagree about who the user is.
   */
  async listTemplates(orgId: string): Promise<ChecklistTemplateListing | null> {
    if (this.isCacheFresh(orgId)) {
      return { source: "cache", templates: this.cache!.templates };
    }

    const fetched = await this.fetchOnce(orgId);
    if (fetched) {
      return { source: "live", templates: fetched };
    }

    const persisted = await this.loadPersistedCache(orgId);
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

  private isCacheFresh(orgId: string): boolean {
    if (!this.cache) return false;
    if (this.cache.orgId !== orgId) return false;
    return Date.now() - this.cache.fetchedAt < CACHE_TTL_MS;
  }

  /** Collapse concurrent reads onto one request, as the feature cache does. */
  private async fetchOnce(orgId: string): Promise<ChecklistTemplate[] | null> {
    if (this.fetchInProgress) {
      return this.fetchInProgress;
    }
    this.fetchInProgress = this.fetchFromSupabase(orgId);
    try {
      return await this.fetchInProgress;
    } finally {
      this.fetchInProgress = null;
    }
  }

  /**
   * One PostgREST read under BACKLOG-3473's RLS, or `null`.
   *
   * Every failure lands in the same place on purpose: no session, a thrown
   * client, a PostgREST error of any code, a body that is not a list. The
   * desktop has no business telling those apart — the only two things the
   * surface above can say are "here are your templates" and "we could not read
   * them". In particular this must NOT special-case the error the API returns
   * today, which is a missing table: 3473 is not applied to production yet, and
   * an error branch written around that one response would be a guess about a
   * shape nobody has captured.
   */
  private async fetchFromSupabase(orgId: string): Promise<ChecklistTemplate[] | null> {
    try {
      const client = supabaseService.getClient();

      // The read is RLS-scoped to the caller's membership, so it is worth
      // nothing without a session. Asking first turns a confusing empty result
      // into an honest "could not read".
      const session = await supabaseService.getAuthSession();
      if (!session) {
        logService.warn(
          "[ChecklistTemplates] No Supabase auth session, cannot read templates",
          "ChecklistTemplateService",
          { orgId },
        );
        return null;
      }

      const { data, error } = await client
        .from("checklist_templates")
        .select(TEMPLATE_SELECT)
        .eq("organization_id", orgId)
        .is("archived_at", null)
        .order("sort_order", { ascending: true });

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

      const templates = this.parseRows(data, orgId);

      this.cache = { templates, fetchedAt: Date.now(), orgId };
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
  private parseRows(rows: unknown[], orgId: string): ChecklistTemplate[] {
    const templates: ChecklistTemplate[] = [];
    let dropped = 0;

    for (const row of rows) {
      const parsed = safeValidate(CloudChecklistTemplateSchema, row);
      if (!parsed.success) {
        dropped += 1;
        continue;
      }
      templates.push({
        id: parsed.data.id,
        name: parsed.data.name,
        description: parsed.data.description,
        sortOrder: parsed.data.sort_order,
        updatedAt: parsed.data.updated_at,
        items: parsed.data.checklist_template_items
          .map(toItem)
          .sort((a, b) => a.sortOrder - b.sortOrder),
      });
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
  private async loadPersistedCache(orgId: string): Promise<TemplateCache | null> {
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
