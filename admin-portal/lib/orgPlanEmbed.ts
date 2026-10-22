/**
 * BACKLOG-4021: read the plan out of a PostgREST `organization_plans(plan_id, plans(...))` embed.
 *
 * organization_plans has UNIQUE (organization_id), so PostgREST returns the embed as a single
 * OBJECT (documented behaviour for a one-to-one relationship: "embedding ... a unique foreign
 * key returns an object"). Code that read `embed[0]` got undefined and showed "None".
 * An array is still accepted so either shape resolves to the same row.
 */

export interface OrgPlanEmbedRow {
  plan_id: string;
  plans: { id: string; name: string; tier: string } | null;
}

export type OrgPlanEmbed = OrgPlanEmbedRow | OrgPlanEmbedRow[] | null | undefined;

export function pickOrgPlanRow(embed: OrgPlanEmbed): OrgPlanEmbedRow | null {
  if (!embed) return null;
  if (Array.isArray(embed)) return embed[0] ?? null;
  return embed;
}
