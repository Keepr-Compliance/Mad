/**
 * Address Normalization Utility
 *
 * Normalizes property addresses to their core components (street number +
 * distinctive street-name words) for content matching against email bodies.
 * Used by auto-link services to filter emails to the correct transaction when
 * multiple transactions share the same contacts.
 *
 * TASK-2087: Address filtering applies to EMAILS ONLY, not text messages.
 *
 * BACKLOG-2311: The matcher is now canonicalization-aware. Street suffixes and
 * directionals are folded to ONE canonical token in BOTH directions
 * ("Rd"/"Road" -> "road", "SW"/"Southwest" -> "southwest"), and only the street
 * number plus the DISTINCTIVE name word(s) are REQUIRED. Suffix + directional
 * are OPTIONAL (a bonus/tie-breaker, never a hard gate). Previously an email
 * that said "3414 Sapp Rd SW" failed to match a stored "3414 Sapp Road
 * Southwest" because the literal tokens "road" AND "southwest" were required.
 *
 * @see TASK-2087
 * @see BACKLOG-2311
 */

/**
 * BACKLOG-2311: Street-suffix canonicalization.
 *
 * Every abbreviation AND full form folds to ONE canonical token so a stored
 * "Road" and an email's "Rd" compare equal. Keys are lowercased, period-free.
 */
const SUFFIX_CANON: Record<string, string> = {
  st: "street", street: "street",
  rd: "road", road: "road",
  ave: "avenue", avenue: "avenue",
  blvd: "boulevard", boulevard: "boulevard",
  dr: "drive", drive: "drive",
  ct: "court", court: "court",
  ln: "lane", lane: "lane",
  pl: "place", place: "place",
  cir: "circle", circle: "circle",
  ter: "terrace", terrace: "terrace",
  trl: "trail", trail: "trail",
  pkwy: "parkway", parkway: "parkway",
  hwy: "highway", highway: "highway",
  lp: "loop", loop: "loop",
  aly: "alley", alley: "alley",
  xing: "crossing", crossing: "crossing",
  // Suffixes with no common abbreviation still canonicalize to themselves so
  // they are treated as OPTIONAL (stripped from the required set).
  way: "way",
  path: "path",
  run: "run",
  pass: "pass",
  pike: "pike",
  commons: "commons",
};

/**
 * BACKLOG-2311: Directional canonicalization (prefix OR suffix position).
 *
 * "NW"/"Northwest" both fold to "northwest". Directionals are OPTIONAL — never
 * required for a match — so "NW Johnson" and "Northwest Johnson" compare equal
 * and an email that omits the directional entirely still matches.
 */
const DIRECTIONAL_CANON: Record<string, string> = {
  n: "north", north: "north",
  s: "south", south: "south",
  e: "east", east: "east",
  w: "west", west: "west",
  ne: "northeast", northeast: "northeast",
  nw: "northwest", northwest: "northwest",
  se: "southeast", southeast: "southeast",
  sw: "southwest", southwest: "southwest",
};

/**
 * Reverse map: canonical token -> every literal variant that folds to it
 * (including the canonical form itself). Used to match a required word
 * leniently against any of its spellings in free text.
 *
 * e.g. "street" -> ["st", "street"], "northwest" -> ["nw", "northwest"].
 */
const CANON_VARIANTS: Record<string, string[]> = buildVariants({
  ...SUFFIX_CANON,
  ...DIRECTIONAL_CANON,
});

function buildVariants(canonMap: Record<string, string>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [token, canon] of Object.entries(canonMap)) {
    const list = out[canon] ?? (out[canon] = []);
    if (!list.includes(token)) list.push(token);
    if (!list.includes(canon)) list.push(canon);
  }
  return out;
}

/**
 * A single token classified as a canonical directional, canonical suffix, or a
 * distinctive name word.
 */
function classifyToken(
  token: string
): { kind: "directional" | "suffix" | "name"; value: string } {
  const directional = DIRECTIONAL_CANON[token];
  if (directional) return { kind: "directional", value: directional };
  const suffix = SUFFIX_CANON[token];
  if (suffix) return { kind: "suffix", value: suffix };
  return { kind: "name", value: token };
}

/**
 * Normalized address split into REQUIRED and OPTIONAL parts.
 *
 * A content match requires the street number AND every `requiredNameWords`
 * entry. `optionalWords` (canonical suffix + directional) are a bonus signal —
 * present for logging / future scoring (BACKLOG-2319) but never required.
 */
export interface NormalizedAddress {
  /** The street number, e.g. "3414" */
  streetNumber: string;
  /**
   * Distinctive street-name word(s) — canonical, lowercased. NOT the suffix,
   * NOT the directional. e.g. "sapp", or ["martin","luther","king"].
   * Always non-empty (see fallback in normalizeAddress).
   */
  requiredNameWords: string[];
  /**
   * Canonical suffix + directional tokens, e.g. ["road","southwest"]. Optional
   * — a tie-breaker / bonus, never required for a match.
   */
  optionalWords: string[];
  /** Canonical combined string for logging, e.g. "3414 sapp road southwest" */
  full: string;
}

function uniquePush(arr: string[], value: string): void {
  if (!arr.includes(value)) arr.push(value);
}

/**
 * Normalize a property address to its core components for content matching.
 *
 * Extracts the street number and classifies every remaining token as a
 * canonical directional, canonical suffix, or a distinctive name word. REQUIRED
 * = street number + distinctive name word(s). Suffix + directional are OPTIONAL.
 *
 * If a name is ONLY a directional/suffix (rare, e.g. "1200 Highway"), the
 * classification would leave zero distinctive words; we then fall back to
 * requiring whatever canonical tokens exist so matching never goes unbounded.
 *
 * Examples:
 *   "3414 Sapp Road Southwest" -> { streetNumber:"3414", requiredNameWords:["sapp"], optionalWords:["road","southwest"] }
 *   "3414 Sapp Rd SW"          -> { streetNumber:"3414", requiredNameWords:["sapp"], optionalWords:["road","southwest"] }
 *   "7890 NW Johnson Blvd"      -> { streetNumber:"7890", requiredNameWords:["johnson"], optionalWords:["northwest","boulevard"] }
 *   "100 Main"                  -> { streetNumber:"100", requiredNameWords:["main"], optionalWords:[] }
 *   ""                          -> null
 *   "Portland, OR"              -> null (no street number)
 *
 * @param fullAddress - The full address string to normalize
 * @returns NormalizedAddress with separate parts, or null if unparseable
 */
export function normalizeAddress(fullAddress: string | null | undefined): NormalizedAddress | null {
  if (!fullAddress || !fullAddress.trim()) return null;

  // Take only the part before the first comma (street portion)
  const streetPart = fullAddress.split(",")[0].trim().toLowerCase();

  // Split into tokens, stripping trailing periods from abbreviations ("St." / "N.")
  const tokens = streetPart
    .split(/\s+/)
    .map((t) => t.replace(/\.$/, ""))
    .filter(Boolean);

  if (tokens.length < 2) return null;

  // First token must start with a digit (street number)
  if (!/^\d/.test(tokens[0])) return null;

  const streetNumber = tokens[0];

  const requiredNameWords: string[] = [];
  const optionalWords: string[] = [];

  for (const token of tokens.slice(1)) {
    const classified = classifyToken(token);
    if (classified.kind === "name") {
      uniquePush(requiredNameWords, classified.value);
    } else {
      uniquePush(optionalWords, classified.value);
    }
  }

  // Fallback: name is only directional/suffix (e.g. "1200 Highway", "99 St").
  // Require whatever canonical tokens exist rather than match unbounded.
  if (requiredNameWords.length === 0) {
    for (const w of optionalWords) uniquePush(requiredNameWords, w);
    optionalWords.length = 0;
  }

  // tokens.length >= 2 guarantees at least one non-number token, so
  // requiredNameWords is always non-empty here — but guard defensively.
  if (requiredNameWords.length === 0) return null;

  const full = `${streetNumber} ${[...requiredNameWords, ...optionalWords].join(" ")}`;

  return {
    streetNumber,
    requiredNameWords,
    optionalWords,
    full,
  };
}

/**
 * Check if a word appears in content with word boundaries.
 * Prevents false positives like "123" matching "1234" or "oak" matching "oakland".
 *
 * @param content - The text to search in
 * @param word - The word to find (will be regex-escaped)
 * @returns true if the word appears as a whole word in content
 */
function containsWord(content: string, word: string): boolean {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i").test(content);
}

/**
 * Match a canonical word against content, accepting ANY known spelling variant.
 *
 * For a distinctive name word (e.g. "sapp") this is just a whole-word check.
 * For a canonical suffix/directional (only ever required via the fallback path,
 * e.g. "highway"), it also matches its abbreviations ("hwy").
 */
function matchesCanonicalWord(content: string, canonicalWord: string): boolean {
  const variants = CANON_VARIANTS[canonicalWord] ?? [canonicalWord];
  return variants.some((v) => containsWord(content, v));
}

/**
 * Check if text content contains the address: the street number AND every
 * REQUIRED (distinctive) name word, each with word-boundary matching. They do
 * not need to be adjacent. Suffix + directional (optionalWords) are NOT
 * required — this is what lets "3414 Sapp Rd SW" match "3414 Sapp Road
 * Southwest" (and vice-versa) even though the suffix/directional spellings
 * differ.
 *
 * Hard false-positive guards (BACKLOG-2311):
 * - NEVER matches on the street number alone (a distinctive name word is also
 *   required), so "$3,414" / "3414 sq ft" do not match number 3414.
 * - NEVER matches on a single common word alone (the street number is also
 *   required), so "main" with no number does not match.
 *
 * @param content - The text content to search (email subject, body)
 * @param normalizedAddress - The NormalizedAddress from normalizeAddress()
 * @returns true if the content contains the street number and all required name words
 */
export function contentContainsAddress(
  content: string | null | undefined,
  normalizedAddress: NormalizedAddress
): boolean {
  if (!content) return false;

  // Guard: a valid normalized address always has at least one distinctive
  // required word; without one we must never match (number-only is a false
  // positive).
  if (normalizedAddress.requiredNameWords.length === 0) return false;

  // Require the street number as a whole word (blocks "34141", "$3,414").
  if (!containsWord(content, normalizedAddress.streetNumber)) {
    return false;
  }

  // Require every distinctive name word (variant-aware for the rare fallback
  // case where a required word is itself a canonical suffix/directional).
  for (const word of normalizedAddress.requiredNameWords) {
    if (!matchesCanonicalWord(content, word)) {
      return false;
    }
  }

  return true;
}

/**
 * Count how many of an address's OPTIONAL (suffix + directional) tokens appear
 * in the content. Not used for the pass/fail gate — exposed for tie-breaking /
 * scoring and richer telemetry (BACKLOG-2319).
 *
 * @param content - The text content to search
 * @param normalizedAddress - The NormalizedAddress from normalizeAddress()
 * @returns Number of optional tokens matched (0..optionalWords.length)
 */
export function countOptionalWordMatches(
  content: string | null | undefined,
  normalizedAddress: NormalizedAddress
): number {
  if (!content) return 0;
  let count = 0;
  for (const word of normalizedAddress.optionalWords) {
    if (matchesCanonicalWord(content, word)) count++;
  }
  return count;
}

/**
 * Generic fallback helper for address-filtered queries.
 *
 * Runs `queryFn` with the normalized address. If the result is empty and an
 * address was provided, retries without the address filter.
 *
 * BACKLOG-2311: Re-wired into autoLinkService / messageMatchingService. After
 * BACKLOG-1364 disconnected it, an address near-miss returned 0 links instead
 * of widening. The fallback now runs again: when the address-filtered query
 * returns 0 unlinked results, we attach the contact's in-window emails
 * unfiltered (loud telemetry below) rather than dropping them.
 *
 * BACKLOG-1340: The fallback ALWAYS runs when the address-filtered query
 * returns 0 unlinked results, even if some already-linked emails match the
 * address. The `countWithFilter` callback is still called for diagnostic
 * logging but no longer gates the fallback decision.
 *
 * @param queryFn - Async function that returns results, optionally filtered by address
 * @param normalizedAddress - The NormalizedAddress to filter by, or null to skip filtering
 * @param debugLog - Callback for logging fallback events (avoids importing logService here)
 * @param entityType - Label for log messages (e.g. "emails", "matches")
 * @param countWithFilter - Optional callback that returns the total count of items matching
 *   the address filter INCLUDING already-linked ones. Used for diagnostic logging only.
 * @returns The query results (filtered if possible, unfiltered as fallback)
 */
export async function withAddressFallback<T>(
  queryFn: (address: NormalizedAddress | null) => Promise<T[]>,
  normalizedAddress: NormalizedAddress | null,
  debugLog: (message: string) => Promise<void> | void,
  entityType: string,
  countWithFilter?: (address: NormalizedAddress) => Promise<number>
): Promise<T[]> {
  const results = await queryFn(normalizedAddress);

  if (results.length === 0 && normalizedAddress) {
    // BACKLOG-1340: Log how many total (including linked) match the address for diagnostics.
    // This helps distinguish "address filter too strict" from "all matching emails already linked".
    let totalMatching = 0;
    if (countWithFilter) {
      totalMatching = await countWithFilter(normalizedAddress);
      if (totalMatching > 0) {
        await debugLog(
          `Address filter: ${totalMatching} ${entityType} match "${normalizedAddress.full}" but all are already linked — falling back to unfiltered to catch non-address emails`
        );
      }
    }

    // BACKLOG-1340 / BACKLOG-2311: Always fall back when address-filtered query returns 0
    // unlinked results. A near-miss on abbreviation/directional (or an email that simply
    // doesn't name the street, e.g. scheduling correspondence) should still auto-link.
    const unfiltered = await queryFn(null);
    if (unfiltered.length > 0) {
      await debugLog(
        `Address filter fallback: ${results.length} ${entityType} matched "${normalizedAddress.full}" (${totalMatching} total incl. linked), returning ${unfiltered.length} unfiltered`
      );
    } else if (totalMatching === 0) {
      await debugLog(
        `Address filter fallback: no ${entityType} matched "${normalizedAddress.full}" even without filter`
      );
    }
    return unfiltered;
  }

  if (results.length > 0 && normalizedAddress) {
    await debugLog(
      `Address filter applied: ${results.length} ${entityType} matched "${normalizedAddress.full}"`
    );
  }

  return results;
}
