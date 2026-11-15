/**
 * Sender rule-set schema — BACKLOG-4175.
 *
 * The one validator for a rule set, whatever its source (the bundled fallback
 * today; a downloaded or cached set later). Strict at every nesting level: an
 * unknown key anywhere is refused. Every list is capped. Hosts, addresses and
 * local parts are literal lowercase strings; nothing here is ever compiled into
 * a RegExp or evaluated.
 *
 * Refused outright: `gmailUpdates` set to "live" on any surface (measure-only by
 * founder ruling), and `authentication_results` as a bulk-header key (it rides
 * on almost every message, so it says nothing about bulk mail).
 */
import { z } from "zod/v4";

import { SINGLE_VALUE_HEADERS } from "../bulkMailHeaders";
import type { SenderRuleSet } from "./bundledRules";

const HOST_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const ADDRESS_RE = /^[^@\s]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const LOCAL_PART_RE = /^[^@\s]+$/;

const lower = (s: string) => s === s.toLowerCase();

const Host = z.string().max(253).regex(HOST_RE).refine(lower);
const Address = z.string().max(254).regex(ADDRESS_RE).refine(lower);
const LocalPart = z.string().min(1).max(64).regex(LOCAL_PART_RE).refine(lower);
const Mode = z.enum(["off", "measure", "live"]);
const Modes = z.strictObject({ learnQuestions: Mode, addressPass: Mode, detector: Mode });
const MeasureOnlyModes = z.strictObject({
  learnQuestions: z.enum(["off", "measure"]),
  addressPass: z.enum(["off", "measure"]),
  detector: z.enum(["off", "measure"]),
});

const BULK_KEYS = Object.values(SINGLE_VALUE_HEADERS) as [
  (typeof SINGLE_VALUE_HEADERS)[keyof typeof SINGLE_VALUE_HEADERS],
  ...(typeof SINGLE_VALUE_HEADERS)[keyof typeof SINGLE_VALUE_HEADERS][],
];

export const SenderRuleSetSchema = z.strictObject({
  schema: z.literal(1),
  version: z.number().int().positive(),
  suppress: z.strictObject({
    exactAddresses: z.array(Address).max(500),
    hosts: z.array(Host).max(2000),
    localParts: z
      .array(z.strictObject({ value: LocalPart, match: z.enum(["exact", "prefix"]) }))
      .max(50),
    bulkHeaders: z.strictObject({
      anyKeyPresent: z.array(z.enum(BULK_KEYS)).max(BULK_KEYS.length),
      precedenceValues: z.array(z.string().min(1).max(32).refine(lower)).max(10),
      autoSubmittedCounts: z.boolean(),
    }),
  }),
  keep: z.strictObject({
    platformHosts: z.array(Host).max(200),
    platformAddresses: z.array(Address).max(200),
  }),
  freeMailDomains: z.array(Host).max(500),
  thresholds: z.strictObject({
    minCensusLinkedEmails: z.number().int().min(0),
    reportSendIntervalHours: z.number().int().positive(),
    reportMaxRows: z.number().int().positive().max(500),
    // BACKLOG-4212: optional. Answers needed before a sender the user marked as a newsletter is
    // hidden for that user; 0 = off. Not in the bundled set; the server validator mirrors this.
    userSuppressMinAnswers: z.number().int().min(0).max(20).optional(),
  }),
  modes: z.strictObject({
    seedAddress: Modes,
    approvedHost: Modes,
    localPart: Modes,
    bulkHeaders: Modes,
    gmailPromotions: Modes,
    gmailSocial: Modes,
    gmailUpdates: MeasureOnlyModes,
  }),
});

/** A valid rule set, or null. Never throws. */
export function parseSenderRuleSet(input: unknown): SenderRuleSet | null {
  const r = SenderRuleSetSchema.safeParse(input);
  return r.success ? (r.data as SenderRuleSet) : null;
}

// Compile-time parity: what the schema accepts is a SenderRuleSet.
type Parsed = z.infer<typeof SenderRuleSetSchema>;
const _parity: (p: Parsed) => SenderRuleSet = (p) => p;
void _parity;
