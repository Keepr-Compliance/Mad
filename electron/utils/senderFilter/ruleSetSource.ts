/**
 * Where the active sender rule set came from — BACKLOG-4175 PR4.
 *
 * Types only, so Learn mode (`services/learn/*`) can carry the provenance of
 * the set a run used without importing the store that selects it.
 */

/** `download` = the server's answer; `cache` = the last valid answer on disk; `bundled` = shipped. */
export type SenderRulesSource = "download" | "cache" | "bundled";

export interface SenderRulesProvenance {
  version: number;
  source: SenderRulesSource;
  /** The most recent download was refused by the schema (the set in use is the cache or bundled). */
  downloadRejected: boolean;
}
