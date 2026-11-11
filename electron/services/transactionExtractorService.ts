/**
 * Email object structure
 */
interface Email {
  subject?: string;
  from?: string;
  to?: string;
  body?: string;
  bodyPlain?: string;
  snippet?: string;
  bodyPreview?: string;
  date: string | Date;
}

/**
 * Party with role
 */
interface Party {
  email?: string;
  role?: string;
  name?: string;
}

/**
 * Keyword match
 */
interface KeywordMatch {
  category: string;
  keyword: string;
}

/**
 * Analysis result
 */
export interface AnalysisResult {
  isRealEstateRelated: boolean;
  transactionType: "purchase" | "sale" | null;
  confidence: number;
  addresses: string[];
  amounts: number[];
  dates: string[];
  parties: Party[];
  mlsNumbers: string[];
  keywords: KeywordMatch[];
  subject?: string;
  from?: string;
  date: string | Date;
  snippet?: string;
}

/**
 * Transaction summary
 */
export interface TransactionSummary {
  propertyAddress: string;
  transactionType: "purchase" | "sale" | null;
  salePrice: number | null;
  closingDate: string | null;
  mlsNumbers: string[];
  communicationsCount: number;
  firstCommunication: number;
  lastCommunication: number;
  confidence: number;
  emails: AnalysisResult[];
}

/**
 * Keywords for classification
 */
interface Keywords {
  transaction: string[];
  purchase: string[];
  sale: string[];
  parties: string[];
  [key: string]: string[];
}

/**
 * Regex patterns
 */
/**
 * Street suffixes the address patterns end the street at (the original list,
 * kept as it was).
 */
const STREET_SUFFIX =
  "(?:Street|St|Avenue|Ave|Road|Rd|Drive|Dr|Lane|Ln|Way|Court|Ct|Boulevard|Blvd|Place|Pl|Circle|Cir|Parkway|Pkwy|Trail|Ter|Crescent|Hill|Freeway|Path|Route|Rte|Square|Turnpike|Vista|Viaduct|Cove|Dale|Ridge|View|Walk|Wood|Drive|Court)";

/** The street: a number, the name (it may span a line), then a suffix. Group 1. */
const STREET = `\\b(\\d+\\s+[A-Za-z\\s\\-\\.]+?\\s+${STREET_SUFFIX})`;

/**
 * BACKLOG-4225: US state and territory codes. Matched on lowercased text with
 * flag i, so a bare `[A-Z]{2}` matched any two-letter word ("to", "is").
 */
const US_STATE_CODES = [
  "al", "ak", "az", "ar", "ca", "co", "ct", "de", "fl", "ga", "hi", "id", "il", "in", "ia", "ks",
  "ky", "la", "me", "md", "ma", "mi", "mn", "ms", "mo", "mt", "ne", "nv", "nh", "nj", "nm", "ny",
  "nc", "nd", "oh", "ok", "or", "pa", "ri", "sc", "sd", "tn", "tx", "ut", "vt", "va", "wa", "wv",
  "wi", "wy", "dc", "pr", "vi", "gu", "as", "mp",
];
const STATE = `(?:${US_STATE_CODES.join("|")})`;

/** A city of 1-4 words, on one line. */
const CITY = "[A-Za-z]+(?:[ \\t]+[A-Za-z]+){0,3}";
/** Between city and state: a comma and/or spaces, never a line break. */
const CITY_STATE_SEP = "(?:[ \\t]*,[ \\t]*|[ \\t]+)";

/** Street + city + state + ZIP. One line break is allowed after the suffix (group 2). */
const ADDRESS_WITH_ZIP = new RegExp(
  `${STREET}([ \\t]*,?[ \\t]*\\r?\\n[ \\t]*|[ \\t]*,[ \\t]*|[ \\t]+)(${CITY}${CITY_STATE_SEP}${STATE}[ \\t,]+\\d{5}(?:-\\d{4})?)\\b`,
  "gi",
);

/**
 * Street + city + state, no ZIP, all on one line. The state must end the
 * address: a comma, period, semicolon, line break or the end of the text
 * follows it, so prose ("... lives in ohio") is not read as a city and state.
 */
const ADDRESS_NO_ZIP = new RegExp(
  `${STREET}([ \\t]*,[ \\t]*|[ \\t]+)(${CITY}${CITY_STATE_SEP}${STATE})\\b(?=[ \\t]*(?:[,.;\\r\\n]|$))`,
  "gi",
);

/** BACKLOG-4225: the street alone, ending at the suffix. */
const ADDRESS_STREET_ONLY = new RegExp(`${STREET}\\b`, "gi");

/**
 * One address match as one line: whitespace collapsed, and a line break
 * between the street and the city line shown as ", " so the street line
 * stays the street.
 */
function cleanAddressMatch(m: RegExpMatchArray): string {
  const ws = (s: string): string => s.replace(/\s+/g, " ").trim();
  const street = ws(m[1] ?? m[0]);
  if (m[3] === undefined) return street;
  const sep = m[2] ?? " ";
  const joiner = sep.includes(",") || /\n/.test(sep) ? ", " : " ";
  return `${street}${joiner}${ws(m[3])}`;
}

interface Patterns {
  address: RegExp;
  money: RegExp;
  largeAmount: RegExp;
  date: RegExp;
  dateNumeric: RegExp;
  email: RegExp;
  phone: RegExp;
  mls: RegExp;
}

/**
 * Transaction Extractor Service
 * Analyzes emails and extracts real estate transaction data
 * Uses pattern matching and keyword detection
 */
class TransactionExtractorService {
  private keywords: Keywords = {
    transaction: [
      "closing",
      "escrow",
      "earnest money",
      "offer",
      "acceptance",
      "mutual acceptance",
      "purchase agreement",
      "sale agreement",
      "mls",
      "listing",
      "buyer",
      "seller",
      "real estate",
      "property",
      "contract",
      "addendum",
      "inspection",
      "house",
      "home",
      "condo",
      "townhouse",
      "apartment",
      "viewing",
      "showing",
      "tour",
      "open house",
      "representation agreement",
      "buyer representation",
      "listing agreement",
      "commission",
      "appraisal",
      "title",
      "deed",
      "mortgage",
      "loan",
      "financing",
      "pre-approval",
    ],
    purchase: [
      "buying",
      "buyer",
      "purchase",
      "offer to purchase",
      "buying agent",
      "purchase price",
      "down payment",
      "buyer representation",
    ],
    sale: [
      "selling",
      "seller",
      "listing",
      "list price",
      "selling agent",
      "sale price",
      "listing agreement",
    ],
    parties: [
      "buyer",
      "seller",
      "agent",
      "broker",
      "escrow officer",
      "title company",
      "lender",
      "inspector",
      "appraiser",
    ],
  };

  private patterns: Patterns = {
    // Address patterns - Multiple patterns for flexibility
    // Pattern 1: Full address with ZIP (most confident)
    // Format: 123 Main Street, San Francisco, CA 94102
    // BACKLOG-4225: the city/state tail stays on one line (one line break is
    // allowed right after the street suffix, for a city line under the
    // street), the city is at most 4 words, and the state must be a real US
    // state/territory code.
    address: ADDRESS_WITH_ZIP,

    // Money amounts
    money: /\$\s?(\d{1,3}(?:,\d{3})*(?:\.\d{2})?)/g,
    largeAmount: /\$\s?(\d{1,3}(?:,\d{3})+(?:\.\d{2})?)/g, // For property prices

    // Dates
    date: /\b(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[,\s]+\d{1,2}[,\s]+\d{4}\b/gi,
    dateNumeric: /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g,

    // Email addresses
    email: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,

    // Phone numbers
    phone: /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g,

    // MLS numbers
    mls: /\bMLS[#\s]*(\d+)\b/gi,
  };

  /**
   * Analyze an email and extract transaction data
   * @param email - Email object from Gmail/Outlook
   * @returns Extracted transaction data
   */
  analyzeEmail(email: Email): AnalysisResult {
    const text = this._getEmailText(email);

    return {
      // Classification
      isRealEstateRelated: this._isRealEstateRelated(text),
      transactionType: this._detectTransactionType(text),
      confidence: this._calculateConfidence(text),

      // Extracted data
      addresses: this._extractAddresses(text),
      amounts: this._extractAmounts(text),
      dates: this._extractDates(text),
      parties: this._extractParties(email, text),
      mlsNumbers: this._extractMLSNumbers(text),

      // Keywords found
      keywords: this._extractKeywords(text),

      // Email metadata
      subject: email.subject,
      from: email.from,
      date: email.date,
      snippet: email.snippet || email.bodyPreview,
    };
  }

  /**
   * Get searchable text from email
   * @private
   */
  private _getEmailText(email: Email): string {
    const parts = [
      email.subject || "",
      email.bodyPlain || email.body || "",
      email.snippet || "",
    ];
    return parts.join(" ").toLowerCase();
  }

  /**
   * Check if email is real estate related
   * @private
   */
  private _isRealEstateRelated(text: string): boolean {
    const keywordCount = this.keywords.transaction.filter((keyword) =>
      text.includes(keyword.toLowerCase()),
    ).length;

    return keywordCount >= 2; // At least 2 keywords must match
  }

  /**
   * Detect transaction type (purchase or sale)
   * @private
   */
  private _detectTransactionType(text: string): "purchase" | "sale" | null {
    const purchaseScore = this.keywords.purchase.filter((keyword) =>
      text.includes(keyword.toLowerCase()),
    ).length;

    const saleScore = this.keywords.sale.filter((keyword) =>
      text.includes(keyword.toLowerCase()),
    ).length;

    if (purchaseScore > saleScore) return "purchase";
    if (saleScore > purchaseScore) return "sale";
    return null; // Unknown
  }

  /**
   * Calculate confidence score (0-100) - Enhanced Algorithm
   * @private
   */
  private _calculateConfidence(text: string): number {
    let score = 0;
    let bonusMultiplier = 1.0;

    // 1. Keywords present (max 40 points)
    const keywordMatches = this.keywords.transaction.filter((keyword) =>
      text.includes(keyword.toLowerCase()),
    ).length;
    const keywordScore = Math.min(keywordMatches * 5, 40);
    score += keywordScore;

    // Bonus: Many keywords = higher multiplier
    if (keywordMatches >= 5) bonusMultiplier += 0.1;
    if (keywordMatches >= 8) bonusMultiplier += 0.1;

    // 2. Has valid address (20 points)
    const hasAddress = this.patterns.address.test(text);
    if (hasAddress) {
      score += 20;
      // Bonus: If address appears multiple times (thread discussion)
      const addressMatches = (text.match(this.patterns.address) || []).length;
      if (addressMatches > 2) score += 5;
    }

    // 3. Has money amounts (up to 20 points)
    const moneyMatches = (text.match(this.patterns.largeAmount) || []).length;
    if (moneyMatches > 0) {
      // More amounts = more likely real transaction
      score += Math.min(10 + moneyMatches * 3, 20);
    }

    // 4. Has dates (up to 15 points)
    const dateMatches = [
      ...(text.match(this.patterns.date) || []),
      ...(text.match(this.patterns.dateNumeric) || []),
    ];
    if (dateMatches.length > 0) {
      // Multiple dates = timeline discussion
      score += Math.min(10 + dateMatches.length * 2, 15);
    }

    // 5. Has MLS number (15 points - strong indicator)
    if (this.patterns.mls.test(text)) {
      score += 15;
      bonusMultiplier += 0.1; // MLS = professional listing
    }

    // 6. Context analysis bonuses
    // Check for common real estate phrases
    const contextPhrases = [
      "mutual acceptance",
      "purchase agreement",
      "closing disclosure",
      "earnest money",
      "inspection contingency",
      "title report",
      "escrow instructions",
      "final walkthrough",
      "loan approval",
    ];
    const contextMatches = contextPhrases.filter((phrase) =>
      text.includes(phrase.toLowerCase()),
    ).length;
    if (contextMatches > 0) {
      score += Math.min(contextMatches * 3, 10);
    }

    // 7. Email pattern analysis
    // If subject contains key transaction terms = higher confidence
    const subjectBonus = this._analyzeSubjectLine(text);
    score += subjectBonus;

    // Apply multiplier and cap at 100
    const finalScore = Math.min(Math.round(score * bonusMultiplier), 100);

    return finalScore;
  }

  /**
   * Analyze email subject line for transaction indicators
   * @private
   */
  private _analyzeSubjectLine(text: string): number {
    // Extract likely subject (first line or text before body)
    const firstLine = text.split("\n")[0].toLowerCase();

    let bonus = 0;

    // Subject contains address
    if (this.patterns.address.test(firstLine)) bonus += 5;

    // Subject contains transaction keywords
    const subjectKeywords = [
      "closing",
      "offer",
      "accepted",
      "pending",
      "sold",
      "contract",
    ];
    const subjectMatches = subjectKeywords.filter((kw) =>
      firstLine.includes(kw),
    ).length;
    bonus += subjectMatches * 2;

    return Math.min(bonus, 10);
  }

  /**
   * Calculate field-specific confidence
   * Used for individual field extractions (closing_date, sale_price, etc.)
   */
  calculateFieldConfidence(
    fieldName: string,
    extractedValue: string,
    text: string,
    allMatches: any[] = [],
  ): number {
    let confidence = 0;

    switch (fieldName) {
      case "closing_date":
        // Higher confidence if:
        // - Appears near "closing" keyword
        // - Format is consistent (MM/DD/YYYY)
        // - Date is in reasonable range (not too far in past/future)
        if (
          text.includes("closing") &&
          text.indexOf(extractedValue) - text.indexOf("closing") < 100
        ) {
          confidence += 30;
        }
        if (allMatches.length === 1) confidence += 20; // Only one date = likely correct
        if (allMatches.length <= 3) confidence += 10;
        if (this._isReasonableClosingDate(extractedValue)) confidence += 40;
        break;

      case "sale_price":
        // Higher confidence if:
        // - Amount is in reasonable range ($50k - $50M)
        // - Appears near "price" or "sale" keywords
        // - Is the largest amount mentioned
        const price = parseFloat(extractedValue.replace(/[^0-9.]/g, ""));
        if (price >= 50000 && price <= 50000000) confidence += 40;
        if (allMatches.length > 0 && Math.max(...allMatches) === price)
          confidence += 20;
        if (text.includes("sale price") || text.includes("purchase price"))
          confidence += 30;
        if (text.indexOf(extractedValue) - text.lastIndexOf("price") < 50)
          confidence += 10;
        break;

      case "transaction_type":
        // Higher confidence if:
        // - Clear buyer/seller language
        // - Listing agreement vs purchase agreement mentioned
        const purchaseKeywords = ["buying", "buyer", "purchase agreement"];
        const saleKeywords = ["selling", "seller", "listing agreement"];
        const pCount = purchaseKeywords.filter((kw) =>
          text.includes(kw),
        ).length;
        const sCount = saleKeywords.filter((kw) => text.includes(kw)).length;
        const diff = Math.abs(pCount - sCount);
        confidence += Math.min(diff * 20, 80);
        if (
          text.includes("representing buyer") ||
          text.includes("representing seller")
        )
          confidence += 20;
        break;

      case "property_address":
        // Higher confidence if:
        // - Well-formatted US address
        // - Appears multiple times
        // - Has zip code
        if (this.patterns.address.test(extractedValue)) confidence += 50;
        if (extractedValue.match(/\d{5}(-\d{4})?/)) confidence += 20; // Has zip
        const occurrences = (
          text.match(
            new RegExp(
              extractedValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
              "gi",
            ),
          ) || []
        ).length;
        confidence += Math.min(occurrences * 5, 30);
        break;

      default:
        confidence = 50; // Default medium confidence
    }

    return Math.min(confidence, 100);
  }

  /**
   * Check if date is reasonable for a closing date
   * @private
   */
  private _isReasonableClosingDate(dateStr: string): boolean {
    try {
      const date = new Date(dateStr);
      const now = new Date();
      const twoYearsAgo = new Date(
        now.getFullYear() - 2,
        now.getMonth(),
        now.getDate(),
      );
      const oneYearAhead = new Date(
        now.getFullYear() + 1,
        now.getMonth(),
        now.getDate(),
      );

      // Reasonable if within 2 years past to 1 year future
      return date >= twoYearsAgo && date <= oneYearAhead;
    } catch {
      return false;
    }
  }

  /**
   * Extract property addresses
   * @private
   */
  private _extractAddresses(text: string): string[] {
    // 1. Street + city + state + ZIP. 2. Street + city + state, no ZIP.
    // 3. BACKLOG-4225: the street alone, ending at the street suffix.
    // Each runs only when the one before it found nothing.
    for (const pattern of [ADDRESS_WITH_ZIP, ADDRESS_NO_ZIP, ADDRESS_STREET_ONLY]) {
      // A fresh copy: `patterns.address` is this same /g regex, and its
      // `.test()` calls elsewhere leave lastIndex where a match ended.
      const found = [...text.matchAll(new RegExp(pattern))].map(cleanAddressMatch);
      if (found.length > 0) return [...new Set(found)];
    }
    return [];
  }

  /**
   * Extract monetary amounts
   * @private
   */
  private _extractAmounts(text: string): number[] {
    const matches = text.match(this.patterns.money) || [];
    return matches
      .map((amount) => {
        // Remove $ and commas, convert to number
        const cleaned = amount.replace(/[\$,]/g, "");
        return parseFloat(cleaned);
      })
      .filter((amount) => amount > 0);
  }

  /**
   * Extract dates
   * @private
   */
  private _extractDates(text: string): string[] {
    const textDates = text.match(this.patterns.date) || [];
    const numericDates = text.match(this.patterns.dateNumeric) || [];

    const allDates = [...textDates, ...numericDates];

    // Try to parse and validate dates
    return allDates
      .map((dateStr) => {
        try {
          const parsed = new Date(dateStr);
          if (!isNaN(parsed.getTime())) {
            return parsed.toISOString().split("T")[0]; // Return YYYY-MM-DD format
          }
        } catch {
          // Invalid date, skip
        }
        return null;
      })
      .filter(Boolean) as string[];
  }

  /**
   * Extract parties involved
   * @private
   */
  private _extractParties(email: Email, text: string): Party[] {
    const parties: Party[] = [];

    // Extract from email participants
    if (email.from) parties.push({ email: email.from, role: "sender" });
    if (email.to) {
      email.to.split(",").forEach((addr) => {
        parties.push({ email: addr.trim(), role: "recipient" });
      });
    }

    // Detect roles from keywords
    this.keywords.parties.forEach((role) => {
      const rolePattern = new RegExp(
        `\\b${role}\\b[:\\s]*([A-Z][a-z]+\\s+[A-Z][a-z]+)`,
        "gi",
      );
      const matches = text.match(rolePattern);
      if (matches) {
        matches.forEach((match) => {
          parties.push({ role: role, name: match });
        });
      }
    });

    return parties;
  }

  /**
   * Extract MLS numbers
   * @private
   */
  private _extractMLSNumbers(text: string): string[] {
    const matches = text.match(this.patterns.mls) || [];
    return matches.map((match) => {
      const number = match.replace(/[^0-9]/g, "");
      return number;
    });
  }

  /**
   * Extract keywords found
   * @private
   */
  private _extractKeywords(text: string): KeywordMatch[] {
    const found: KeywordMatch[] = [];

    Object.entries(this.keywords).forEach(([category, words]) => {
      words.forEach((keyword) => {
        if (text.includes(keyword.toLowerCase())) {
          found.push({ category, keyword });
        }
      });
    });

    return found;
  }

  /**
   * Batch analyze multiple emails
   * @param emails - Array of email objects
   * @returns Array of analysis results
   */
  batchAnalyze(emails: Email[]): AnalysisResult[] {
    return emails.map((email) => this.analyzeEmail(email));
  }

  /**
   * Group emails by property address
   * @param analyzedEmails - Array of analyzed email results
   * @returns Emails grouped by address
   */
  groupByProperty(
    analyzedEmails: AnalysisResult[],
  ): Record<string, AnalysisResult[]> {
    const groups: Record<string, AnalysisResult[]> = {};

    analyzedEmails.forEach((analysis) => {
      if (analysis.addresses.length > 0) {
        const primaryAddress = analysis.addresses[0];

        if (!groups[primaryAddress]) {
          groups[primaryAddress] = [];
        }

        groups[primaryAddress].push(analysis);
      }
    });

    return groups;
  }

  /**
   * Generate transaction summary from grouped emails
   * @param emailGroup - Group of emails for same property
   * @returns Transaction summary
   */
  generateTransactionSummary(
    emailGroup: AnalysisResult[],
  ): TransactionSummary | null {
    if (emailGroup.length === 0) return null;

    // Get primary address
    const address = emailGroup[0].addresses[0];

    // Aggregate all amounts
    const allAmounts = emailGroup.flatMap((e) => e.amounts);

    // Get all dates
    const allDates = emailGroup.flatMap((e) => e.dates).filter(Boolean);

    // Get all MLS numbers
    const mlsNumbers = [...new Set(emailGroup.flatMap((e) => e.mlsNumbers))];

    // Determine transaction type (most common)
    const types = emailGroup.map((e) => e.transactionType).filter(Boolean);
    const transactionType = types.length > 0 ? types[0] : null;

    // Calculate average confidence
    const avgConfidence = Math.round(
      emailGroup.reduce((sum, e) => sum + e.confidence, 0) / emailGroup.length,
    );

    // Find likely sale price (largest amount)
    const salePrice = allAmounts.length > 0 ? Math.max(...allAmounts) : null;

    // Find closing date (last date mentioned)
    const closingDate =
      allDates.length > 0 ? allDates.sort().reverse()[0] : null;

    return {
      propertyAddress: address,
      transactionType,
      salePrice,
      closingDate,
      mlsNumbers,
      communicationsCount: emailGroup.length,
      firstCommunication: Math.min(
        ...emailGroup.map((e) => new Date(e.date).getTime()),
      ),
      lastCommunication: Math.max(
        ...emailGroup.map((e) => new Date(e.date).getTime()),
      ),
      confidence: avgConfidence,
      emails: emailGroup,
    };
  }
}

export default new TransactionExtractorService();
