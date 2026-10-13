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
  /**
   * BACKLOG-3925: the street name as the address-only route reads it — the name words
   * in written order, ending at the first street suffix after a name word (or at a
   * unit/floor token, or a city/province/postcode tail). Absent on hand-built values;
   * the route then falls back to `requiredNameWords`. The contact route never reads it.
   */
  streetNameWords?: string[];
}

/** Words that start the unit / floor part of an address, after the street. */
const STREET_END_WORDS = new Set([
  "floor", "fl", "suite", "ste", "unit", "apt", "apartment", "room", "rm", "#",
]);

/** US states, Canadian provinces/territories: a bare code after the street name starts the tail. */
const REGION_CODES = new Set([
  "al","ak","az","ar","ca","co","ct","de","fl","ga","hi","id","il","in","ia","ks","ky","la","me","md",
  "ma","mi","mn","ms","mo","mt","ne","nv","nh","nj","nm","ny","nc","nd","oh","ok","or","pa","ri","sc",
  "sd","tn","tx","ut","vt","va","wa","wv","wi","wy","dc","on","qc","bc","ab","sk","mb","nb","ns","pe",
  "nl","yt","nt","nu",
]);

const COUNTRY_WORDS = new Set(["canada", "usa", "us"]);

/** Canadian postcode half ("m2n"), US zip ("90210", "90210-1234"). */
function isPostcodeToken(t: string): boolean {
  return /^[a-z]\d[a-z]$/.test(t) || /^\d{5}(-\d{4})?$/.test(t);
}

/**
 * BACKLOG-3925: the street name from the tokens after the street number. Ends at the
 * first street suffix once a name word has been seen (a suffix BEFORE any name word is
 * part of the name: "St Charles Ave", "Avenue of the Americas"), at a unit/floor token,
 * or — when no comma split the address — at a postcode, or a region code / country word that
 * is last or followed by a postcode / country word.
 */
function streetNameFromTokens(rest: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    const next = rest[i + 1];
    const kind = classifyToken(token).kind;
    if (kind === "suffix" && out.length > 0) break;
    if (out.length > 0) {
      if (STREET_END_WORDS.has(token) || token.startsWith("#")) {
        // "Example 10th Floor": the ordinal belongs to the floor, not the street.
        if ((token === "floor" || token === "fl") && /^\d+(st|nd|rd|th)$/.test(out[out.length - 1])) out.pop();
        break;
      }
      if (isPostcodeToken(token)) break;
      // A region code / country word is also an ordinary street-name word ("Ponce de Leon",
      // "Rue de la Montagne", "Old Mt Vernon"): it ends the street only as the last word or
      // when a postcode or country word follows.
      if ((REGION_CODES.has(token) || COUNTRY_WORDS.has(token)) &&
          (next === undefined || isPostcodeToken(next) || COUNTRY_WORDS.has(next))) break;
    }
    if (kind === "name") uniquePush(out, token);
  }
  return out;
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
    streetNameWords: streetNameFromTokens(tokens.slice(1)),
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

/** Words of a text, lowercased; "7,000" and "12.5" stay ONE token (a price is not a number). */
const ADJACENT_TOKEN_RE = /[a-z0-9]+(?:[,.][0-9]+)*/gi;

/**
 * Unit designators. In a deal address the designator and the token after it ("Unit 4",
 * "Apt 2B", "Suite 200", "# 4") are not part of the street name, and emails about the
 * street rarely repeat them right after it — so the address route does not require them.
 */
const UNIT_DESIGNATORS = new Set(["unit", "apt", "apartment", "suite", "ste", "#"]);

/**
 * A few short words that are written with a period but are not suffixes or
 * directionals ("Jr.", "Mt."). With those, a period then whitespace still joins.
 */
const PERIOD_ABBREVIATIONS = new Set(["jr", "sr", "mt", "ft"]);

/**
 * BACKLOG-3925: the street-name words the address-only route requires, in order —
 * {@link NormalizedAddress.requiredNameWords} with unit designators taken out
 * ("1428 Maple Ave Unit 4" and "1428 Maple Ave #4" both require only "maple"). The SQL
 * prefilter binds the FIRST of these, so the prefilter and the matcher cannot disagree.
 * When nothing is left (a name that was only a unit), the canonical suffix/directional
 * words stand in, as in normalizeAddress's own fallback.
 */
export function addressRouteNameWords(normalizedAddress: NormalizedAddress): string[] {
  const streetWords = normalizedAddress.streetNameWords;
  const words = streetWords && streetWords.length > 0 ? streetWords : normalizedAddress.requiredNameWords;
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (UNIT_DESIGNATORS.has(w)) {
      i++; // and the unit's own token
      continue;
    }
    if (w.startsWith("#")) continue;
    out.push(w);
  }
  if (out.length > 0) return out;
  return [...normalizedAddress.optionalWords];
}

/**
 * BACKLOG-3925: the street-number spellings the address route accepts for a deal. A
 * deal number written as a range ("12-14") accepts either end.
 */
export function addressRouteStreetNumbers(normalizedAddress: NormalizedAddress): string[] {
  const parts = normalizedAddress.streetNumber.split(/[-–]/).filter(Boolean);
  return parts.length > 1 ? parts : [normalizedAddress.streetNumber];
}

/**
 * BACKLOG-3925: the word the address route's SQL prefilter looks for (lowercased
 * substring of subject or body) — the first word of addressRouteNameWords. Empty (the
 * check is off) when that word has spelling variants ("highway" / "hwy") or is not
 * plain ASCII (SQLite's lower() folds ASCII only), so the prefilter never drops a row
 * the matcher would accept.
 */
export function addressRoutePrefilterWord(normalizedAddress: NormalizedAddress): string {
  const first = addressRouteNameWords(normalizedAddress)[0] ?? "";
  if (CANON_VARIANTS[first] || !/^[a-z0-9]+$/.test(first)) return "";
  return first;
}

interface AdjToken {
  text: string;
  /** The text between the previous token and this one. */
  gap: string;
  /** Immediately preceded by "$". */
  afterDollar: boolean;
}

function isOptionalAddressToken(text: string): boolean {
  return classifyToken(text).kind !== "name";
}

/**
 * Consecutive words: separated by whitespace only, or by a period and whitespace when
 * the previous word is an abbreviation ("12 E. Elm St", "Oak St. 7").
 */
function joinedToPrev(tokens: AdjToken[], k: number): boolean {
  if (k <= 0 || !tokens[k]) return false;
  const gap = tokens[k].gap;
  if (/^\s+$/.test(gap)) return true;
  if (!/^\.\s+$/.test(gap)) return false;
  const prev = tokens[k - 1].text;
  return isOptionalAddressToken(prev) || PERIOD_ABBREVIATIONS.has(prev);
}

/** "1428-1430": two plain numbers joined by a hyphen are one street-number span. */
function rangeToPrev(tokens: AdjToken[], k: number): boolean {
  if (k <= 0 || !tokens[k]) return false;
  return /^\s*[-–]\s*$/.test(tokens[k].gap) && /^\d+[a-z]?$/.test(tokens[k].text) && /^\d+[a-z]?$/.test(tokens[k - 1].text);
}

function tokenIs(token: AdjToken | undefined, canonicalWord: string): boolean {
  if (!token) return false;
  const variants = CANON_VARIANTS[canonicalWord] ?? [canonicalWord];
  return variants.includes(token.text);
}

/**
 * The street name starting at tokens[at]: every word in order, consecutive, with any
 * run of suffix/directional words allowed between two name words. Returns the index
 * after the last name word, or -1.
 */
function nameRunAt(tokens: AdjToken[], at: number, words: string[]): number {
  if (!tokenIs(tokens[at], words[0])) return -1;
  let k = at + 1;
  for (let w = 1; w < words.length; w++) {
    while (joinedToPrev(tokens, k) && !tokenIs(tokens[k], words[w]) && isOptionalAddressToken(tokens[k].text)) k++;
    if (!joinedToPrev(tokens, k) || !tokenIs(tokens[k], words[w])) return -1;
    k++;
  }
  return k;
}

/**
 * BACKLOG-3925 address-only precision: like {@link contentContainsAddress}, but the
 * street number and the FIRST street-name word must be ADJACENT, in either order:
 * "12 Park Rd", "12 N Park Rd", "10 St Charles Ave", "1234 Avenue of the Americas",
 * "12 E. Elm St", "Park Rd SW 12", "Oak St. 7". Used only by the address-only review
 * route; the contact route keeps `contentContainsAddress`.
 *
 * Adjacent means consecutive words (see joinedToPrev) with nothing but a run of suffix
 * or directional words (St, Ave, N, SW...) between the number and the name, or between
 * the name and a trailing number. Any other word breaks it: "$7,000 ... Oak St" and
 * "closing at 12 on Park Ave" do not match "7 Oak St" / "12 Park Rd". A number written
 * "$7" is a price. "1428-1430 Maple Ave" names both 1428 and 1430. The deal's unit
 * ("Unit 4", "#4") is not required (addressRouteNameWords).
 */
export function contentContainsAddressAdjacent(
  content: string | null | undefined,
  normalizedAddress: NormalizedAddress
): boolean {
  if (!content) return false;
  const name = addressRouteNameWords(normalizedAddress);
  if (name.length === 0) return false;
  const numbers = addressRouteStreetNumbers(normalizedAddress);

  const tokens: AdjToken[] = [];
  let prevEnd = -1;
  const lower = content.toLowerCase();
  for (const m of lower.matchAll(ADJACENT_TOKEN_RE)) {
    const start = m.index ?? 0;
    tokens.push({
      text: m[0].replace(/[.,]+$/, ""),
      gap: prevEnd < 0 ? "" : lower.slice(prevEnd, start),
      afterDollar: start > 0 && lower[start - 1] === "$",
    });
    prevEnd = start + m[0].length;
  }

  for (let i = 0; i < tokens.length; i++) {
    if (!numbers.includes(tokens[i].text)) continue;
    // The number's span: "1428-1430" is one span whichever end the deal has.
    let first = i;
    while (rangeToPrev(tokens, first)) first--;
    let last = i;
    while (rangeToPrev(tokens, last + 1)) last++;
    if (tokens[first].afterDollar) continue;

    // Number first: "12 Park", "12 N Park", "10 St Charles", "1234 Avenue of the Americas".
    for (let k = last + 1; joinedToPrev(tokens, k); k++) {
      if (nameRunAt(tokens, k, name) >= 0) return true;
      if (!isOptionalAddressToken(tokens[k].text)) break;
    }

    // Name first: "Park 12", "Park Rd 12", "Sapp Rd SW 12", "Oak St. 7".
    if (!joinedToPrev(tokens, first)) continue;
    // The name must end (exclusive) at `end`; `end` walks back over a run of
    // suffix/directional words, each joined to the word before it.
    let end = first;
    for (;;) {
      for (let start = Math.max(0, end - 1 - 2 * name.length - 6); start < end; start++) {
        if (nameRunAt(tokens, start, name) === end) return true;
      }
      const k = end - 1;
      if (k < 1 || !isOptionalAddressToken(tokens[k].text) || !joinedToPrev(tokens, k)) break;
      end = k;
    }
  }
  return false;
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
