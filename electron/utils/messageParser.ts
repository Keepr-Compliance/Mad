/**
 * Message Parser Utilities
 * Handles extraction of text from macOS Messages attributed body format
 *
 * The attributedBody field in macOS Messages contains an NSAttributedString
 * serialized in one of two formats:
 *
 * 1. **Binary plist (bplist00)** - NSKeyedArchiver format, parsed with simple-plist
 *    - Starts with "bplist00" magic bytes
 *    - Contains $archiver, $objects, $top keys
 *    - String content stored in $objects array
 *
 * 2. **Typedstream format** - Legacy Apple format, parsed with custom extractor
 *    - Starts with "streamtyped" or other markers
 *    - Contains NSString markers and inline text
 *
 * TASK-1035: Added binary plist support to fix corruption where bplist data
 * was being misinterpreted as text (showing "bplist00" garbage characters).
 *
 * @see https://fatbobman.com/en/posts/deep-dive-into-imessage/
 * @see https://github.com/alexkwolfe/imessage-parser
 */

/**
 * Preamble bytes that appear after NSString marker in typedstream format.
 * There are two variants:
 * - REGULAR (0x94): Used for immutable NSString in simple messages
 * - MUTABLE (0x95): Used for NSMutableString in rich messages (links, calendars, etc.)
 *
 * The former imessage-parser library only handled REGULAR, causing rich messages to fail.
 */
const NSSTRING_PREAMBLE_REGULAR = Buffer.from([0x01, 0x94, 0x84, 0x01, 0x2b]);
const NSSTRING_PREAMBLE_MUTABLE = Buffer.from([0x01, 0x95, 0x84, 0x01, 0x2b]);

// eslint-disable-next-line @typescript-eslint/no-var-requires
const simplePlist = require("simple-plist") as {
  parse: (data: Buffer | string) => unknown;
};

import {
  MAX_MESSAGE_TEXT_LENGTH,
  MIN_MESSAGE_TEXT_LENGTH,
  MIN_CLEANED_TEXT_LENGTH,
  REGEX_PATTERNS,
} from "../constants";
import logService from "../services/logService";
// Note: containsReplacementChars and tryMultipleEncodings are now deprecated
// TASK-1049: Removed heuristic encoding fallbacks - we now use deterministic parsing

/**
 * Magic bytes for binary plist format
 * Binary plists start with "bplist00" (8 bytes)
 */
const BPLIST_MAGIC = Buffer.from("bplist00");

/**
 * Check if a buffer is a binary plist (bplist00 format)
 * @param buffer - Buffer to check
 * @returns True if buffer starts with bplist00 magic bytes
 */
export function isBinaryPlist(buffer: Buffer): boolean {
  if (buffer.length < BPLIST_MAGIC.length) {
    return false;
  }
  return buffer.subarray(0, BPLIST_MAGIC.length).equals(BPLIST_MAGIC);
}

/**
 * Typedstream marker for detecting legacy Apple typedstream format
 * Typedstream buffers contain "streamtyped" marker, typically within first 50 bytes
 * (there may be 1-4 preamble bytes before the marker)
 */
const TYPEDSTREAM_MARKER = Buffer.from("streamtyped");

/**
 * Check if a buffer is in typedstream format
 *
 * Typedstream is a legacy Apple serialization format used for NSAttributedString.
 * The marker "streamtyped" appears within the first ~50 bytes, potentially
 * preceded by preamble bytes.
 *
 * @param buffer - Buffer to check
 * @returns True if buffer contains streamtyped marker in first 50 bytes
 */
export function isTypedstream(buffer: Buffer): boolean {
  if (buffer.length < TYPEDSTREAM_MARKER.length) {
    return false;
  }

  // Check for "streamtyped" marker anywhere in first 50 bytes
  // (there may be preamble bytes before it)
  const searchWindow = buffer.subarray(0, Math.min(50, buffer.length));
  return searchWindow.includes(TYPEDSTREAM_MARKER);
}

/**
 * Possible formats for attributedBody data
 */
export type AttributedBodyFormat = "bplist" | "typedstream" | "unknown";

/**
 * Detect the format of an attributedBody buffer using magic bytes
 *
 * This function provides deterministic format detection before parsing:
 * - Binary plist (bplist00): NSKeyedArchiver format, starts with "bplist00"
 * - Typedstream: Legacy Apple format, contains "streamtyped" marker
 * - Unknown: Format not recognized, may need heuristic parsing
 *
 * TASK-1046: Foundation for deterministic message parsing refactor
 *
 * @param buffer - Buffer to detect format for (can be null/undefined)
 * @returns Detected format: 'bplist', 'typedstream', or 'unknown'
 */
export function detectAttributedBodyFormat(
  buffer: Buffer | null | undefined
): AttributedBodyFormat {
  if (!buffer || buffer.length === 0) {
    return "unknown";
  }

  if (isBinaryPlist(buffer)) {
    logService.debug("Detected binary plist format (bplist00 magic bytes)", "MessageParser");
    return "bplist";
  }

  if (isTypedstream(buffer)) {
    logService.debug("Detected typedstream format (streamtyped marker)", "MessageParser");
    return "typedstream";
  }

  logService.debug("Unknown attributedBody format", "MessageParser");
  return "unknown";
}

/**
 * NSKeyedArchiver plist structure (simplified)
 * The actual structure is complex, but we extract text from $objects
 */
interface NSKeyedArchiverPlist {
  $archiver?: string;
  $objects?: unknown[];
  $top?: { root?: { CF$UID?: number } | number };
  $version?: number;
}

/**
 * Maximum buffer size to attempt parsing (5MB)
 * Very large buffers can cause stack overflow in plist/typedstream parsers
 */
const MAX_BUFFER_SIZE = 5 * 1024 * 1024;

/**
 * Extract text from binary plist containing NSAttributedString
 *
 * NSKeyedArchiver stores objects in $objects array with references.
 * The string content is typically stored as:
 * - Direct string values in $objects
 * - Objects with NS.string or NSString keys
 *
 * @param buffer - Binary plist buffer
 * @returns Extracted text or null if parsing fails
 */
export function extractTextFromBinaryPlist(buffer: Buffer): string | null {
  // Safety check: skip excessively large buffers that could cause stack overflow
  if (buffer.length > MAX_BUFFER_SIZE) {
    logService.warn("Binary plist buffer too large, skipping", "MessageParser", {
      bufferLength: buffer.length,
      maxAllowed: MAX_BUFFER_SIZE,
    });
    return null;
  }

  try {
    const parsed = simplePlist.parse(buffer) as NSKeyedArchiverPlist;

    // Verify this is an NSKeyedArchiver plist
    if (parsed.$archiver !== "NSKeyedArchiver" || !parsed.$objects) {
      logService.debug("Not an NSKeyedArchiver plist or missing $objects", "MessageParser");
      return null;
    }

    const objects = parsed.$objects;

    // Strategy 1: Find the longest string in $objects
    // NSAttributedString stores the text content as a string in the objects array
    const stringCandidates: string[] = [];

    for (const obj of objects) {
      // Direct string value
      if (typeof obj === "string" && obj.length > 0) {
        // Skip metadata strings
        if (!isNSKeyedArchiverMetadata(obj)) {
          stringCandidates.push(obj);
        }
      }

      // Object with NS.string property (NSMutableString)
      if (obj && typeof obj === "object" && "NS.string" in obj) {
        const nsString = (obj as { "NS.string": unknown })["NS.string"];
        if (typeof nsString === "string" && nsString.length > 0) {
          stringCandidates.push(nsString);
        }
      }

      // Object with NSString property
      if (obj && typeof obj === "object" && "NSString" in obj) {
        const nsString = (obj as { NSString: unknown }).NSString;
        if (typeof nsString === "string" && nsString.length > 0) {
          stringCandidates.push(nsString);
        }
      }
    }

    if (stringCandidates.length === 0) {
      logService.debug("No string candidates found in binary plist", "MessageParser");
      return null;
    }

    // Return the longest non-metadata string (likely the message content)
    stringCandidates.sort((a, b) => b.length - a.length);
    const result = stringCandidates[0];

    logService.debug(`Extracted text from binary plist: ${result.length} chars`, "MessageParser");
    return result;
  } catch (error) {
    logService.debug("Binary plist parsing failed", "MessageParser", {
      error: (error as Error).message,
    });
    return null;
  }
}

/**
 * Check if a string is NSKeyedArchiver metadata (should be filtered from results)
 *
 * NSKeyedArchiver format contains many internal metadata strings that should
 * not be returned as message content. This function identifies these patterns:
 *
 * - $null: Null placeholder
 * - NS*: Cocoa class names (NSString, NSArray, NSMutableString, etc.)
 * - __kIM*: iMessage internal keys with double underscore prefix
 * - kIM*: iMessage internal keys without underscore prefix (TASK-1047)
 * - AttributeName/MessagePart: Formatting attributes
 * - $class: Class reference marker
 * - XX.yyyy patterns: Property accessors (NS.string, NS.data, etc.)
 *
 * @param text - String to check
 * @returns True if the string is metadata and should be filtered
 */
function isNSKeyedArchiverMetadata(text: string): boolean {
  return (
    text === "$null" ||
    text.startsWith("NS") ||
    text.startsWith("__kIM") ||
    text.startsWith("kIM") || // TASK-1047: iMessage keys without underscore prefix
    text.includes("AttributeName") ||
    text.includes("MessagePart") ||
    text.includes("$class") ||
    /^[A-Z]{2,}\.[a-z]+$/.test(text) // e.g., "NS.string", "NS.data"
  );
}

/**
 * Custom typedstream parser that handles both regular and mutable NSString preambles.
 *
 * The former imessage-parser library only recognized the REGULAR preamble (0x94),
 * but rich messages (links, calendar events, etc.) use MUTABLE preamble (0x95).
 * This function properly handles both cases.
 *
 * @param buffer - Typedstream buffer to parse
 * @returns Extracted text or null if parsing fails
 */
export function extractTextFromTypedstream(buffer: Buffer): string | null {
  // Safety check: skip excessively large buffers that could cause stack overflow
  if (buffer.length > MAX_BUFFER_SIZE) {
    logService.warn("Typedstream buffer too large, skipping", "MessageParser", {
      bufferLength: buffer.length,
      maxAllowed: MAX_BUFFER_SIZE,
    });
    return null;
  }

  const results: string[] = [];
  // BACKLOG-2262 (BACKLOG-2279 §2): lenient truncation-recovery candidates —
  // captured only when the declared length overruns the remaining buffer (a
  // truncated / corrupt blob). Used only if the strict tier finds nothing.
  const truncatedResults: string[] = [];
  let offset = 0;
  const nsStringMarker = Buffer.from("NSString");

  while (offset < buffer.length) {
    const idx = buffer.indexOf(nsStringMarker, offset);
    if (idx === -1) break;

    let pos = idx + 8; // After "NSString"

    // Check for preambles (both regular and mutable)
    let hadPreamble = false;
    if (pos + 5 <= buffer.length) {
      const nextBytes = buffer.subarray(pos, pos + 5);
      if (
        nextBytes.equals(NSSTRING_PREAMBLE_REGULAR) ||
        nextBytes.equals(NSSTRING_PREAMBLE_MUTABLE)
      ) {
        pos += 5; // Skip preamble
        hadPreamble = true;
      }
    }

    if (pos >= buffer.length) break;

    // Read length prefix. Apple typedstream length markers:
    //   1 byte          → the length itself (0x00–0x80)
    //   0x81 + u16 LE   → lengths up to 65_535
    //   0x82 + u32 LE   → larger lengths (BACKLOG-2262 / BACKLOG-2279 §2)
    // Parsing 0x82 correctly matters even when the resulting length exceeds our
    // text cap: it advances `pos` by the right amount so subsequent markers are
    // not misread.
    const lengthByte = buffer[pos++];
    let length: number;

    if (lengthByte === 0x81) {
      // Extended length (2 bytes little-endian)
      if (pos + 2 > buffer.length) break;
      length = buffer[pos] | (buffer[pos + 1] << 8);
      pos += 2;
    } else if (lengthByte === 0x82) {
      // Extended length (4 bytes little-endian, unsigned). Build without `<< 24`
      // so the high bit is not interpreted as a sign.
      if (pos + 4 > buffer.length) break;
      length =
        buffer[pos] | (buffer[pos + 1] << 8) | (buffer[pos + 2] << 16);
      length += buffer[pos + 3] * 0x1000000;
      pos += 4;
    } else {
      length = lengthByte;
    }

    const available = buffer.length - pos;

    if (
      length > 0 &&
      length <= available &&
      length < MAX_MESSAGE_TEXT_LENGTH
    ) {
      // Strict tier: the declared length fits within the buffer and the cap.
      const text = buffer.subarray(pos, pos + length).toString("utf8");
      // Filter out metadata strings using consistent helper function
      // TASK-1048: Use isTypedstreamMetadata for consistent filtering
      if (text.length > MIN_CLEANED_TEXT_LENGTH && !isTypedstreamMetadata(text)) {
        results.push(text);
      }
    } else if (
      hadPreamble &&
      length > available &&
      available > MIN_CLEANED_TEXT_LENGTH
    ) {
      // Lenient truncation-recovery tier: the declared length overruns the buffer
      // (truncated / corrupt blob). Recover whatever readable text is present,
      // clamped to the buffer and the text cap, rather than dropping the message.
      // Gated on a matched NSString preamble so a spurious "NSString" occurrence
      // INSIDE already-decoded text cannot leak a trailing fragment.
      const capped = Math.min(available, MAX_MESSAGE_TEXT_LENGTH);
      const text = buffer.subarray(pos, pos + capped).toString("utf8");
      if (!isTypedstreamMetadata(text)) {
        truncatedResults.push(text);
      }
    }

    offset = idx + 1;
  }

  if (results.length > 0) {
    // Return longest strict result (likely the actual message content)
    results.sort((a, b) => b.length - a.length);
    return results[0];
  }

  // Only fall back to truncation recovery when the strict tier found nothing.
  // Guard the recovered text with the same binary-garbage detector used elsewhere
  // so we never surface decoded noise as message content.
  if (truncatedResults.length > 0) {
    truncatedResults.sort((a, b) => b.length - a.length);
    const candidate = cleanExtractedText(truncatedResults[0]);
    if (
      candidate.length >= MIN_CLEANED_TEXT_LENGTH &&
      !looksLikeBinaryGarbage(candidate)
    ) {
      return candidate;
    }
  }

  return null;
}

/**
 * Message object interface
 */
export interface Message {
  text?: string | null;
  attributedBody?: Buffer | null;
  cache_has_attachments?: number;
}

/**
 * Check if text appears to be binary garbage (UTF-16 misinterpreted bytes)
 *
 * When binary data (like typedstream) is stored as UTF-16 and then read as UTF-8,
 * it produces specific garbage patterns:
 * - "streamtyped" as UTF-16 LE produces Oriya and CJK characters
 * - iMessage metadata keys may leak through partially encoded
 *
 * TASK-1071: Re-added garbage detection for message.text field.
 * The attributedBody parsing uses deterministic format detection (TASK-1049),
 * but the text field may already contain garbage from incorrect storage.
 *
 * @param text - Text to check for garbage patterns
 * @returns True if text appears to be binary garbage
 */
export function looksLikeBinaryGarbage(text: string): boolean {
  if (!text || text.length < 5) return false;

  // Pattern 1: UTF-16 interpreted "streamtyped" produces Oriya script characters
  // "st" as UTF-16 LE = 0x7473 = specific code points
  // From test data: garbage starts with Oriya characters mixed with CJK
  // Oriya Unicode block: U+0B00-U+0B7F
  const hasOriyaChars = /[\u0B00-\u0B7F]/.test(text);

  // Pattern 2: CJK characters mixed with Oriya (very specific garbage pattern)
  // This combination is extremely rare in legitimate text
  const hasCJKChars = /[\u4E00-\u9FFF]/.test(text);

  if (hasOriyaChars && hasCJKChars) {
    // Oriya + CJK together is almost certainly garbage
    // Legitimate mixed scripts would be very unusual
    return true;
  }

  // Pattern 3: iMessage metadata strings that leaked through
  // These should never appear in display text
  if (/__kIM\w+AttributeName/.test(text)) return true;
  if (/kIMMessagePart\w*AttributeName/.test(text)) return true;
  if (/NSMutableAttributedString|NSAttributedString/.test(text)) return true;

  // Pattern 4: High concentration of unusual Unicode ranges in short text
  // Binary data interpreted as UTF-16 often produces characters in
  // rarely-used Unicode ranges (private use, surrogates, specials)
  const unusualRanges = /[\uE000-\uF8FF]|[\uFFF0-\uFFFF]/g; // Private use + specials
  const unusualMatches = text.match(unusualRanges);
  if (unusualMatches && unusualMatches.length > text.length * 0.1) {
    // More than 10% unusual characters suggests garbage
    return true;
  }

  // Pattern 5: Oriya at the start of text (very strong indicator)
  // Legitimate Oriya text is extremely rare in this context
  // "streamtyped" as UTF-16 LE starts with Oriya character
  if (/^[\u0B00-\u0B7F]/.test(text)) {
    return true;
  }

  return false;
}

/**
 * Object Replacement Character (U+FFFC) — macOS Messages uses this as the inline
 * placeholder for a message's attachment. A caption-less media message decodes to
 * only this character (plus formatting artifacts), which is NOT real text.
 */

/**
 * BACKLOG-2262: A decoded string is "effectively empty" when, after removing
 * object-replacement (U+FFFC) and Unicode replacement (U+FFFD) characters and
 * whitespace, nothing remains. Caption-less media and undecodable blobs land here
 * and are treated as empty ("") rather than surfaced as message content.
 *
 * @param text - Candidate text
 * @returns True when there is no real textual content
 */
export function isEffectivelyEmptyText(text: string | null | undefined): boolean {
  if (!text) return true;
  // "Real" content = anything that is not whitespace, the object-replacement
  // character (U+FFFC), or the Unicode replacement character (U+FFFD).
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code === undefined) continue;
    if (code === 0xfffc || code === 0xfffd) continue;
    if (/\s/.test(ch)) continue;
    return false; // found a real, content-bearing character
  }
  return true;
}

/**
 * Extract text from macOS Messages attributedBody blob
 *
 * Uses DETERMINISTIC format detection based on magic bytes:
 * 1. "bplist00" -> Binary plist (NSKeyedArchiver)
 * 2. "streamtyped" -> Typedstream (legacy Apple format)
 * 3. Neither -> Unknown format
 *
 * NEVER guesses encoding or uses heuristics.
 *
 * TASK-1049: Refactored to use deterministic format detection and remove
 * all heuristic fallbacks.
 *
 * BACKLOG-2262: On any failure to decode real text (unknown format, empty/null
 * input, parse miss, or content that is only attachment placeholders), returns an
 * empty string "" — NOT a "[placeholder]". The import layer decides what to do
 * with an empty-text message (e.g. retain it when it carries an attachment), which
 * previously could not happen because "[...]" placeholders triggered a drop.
 *
 * @param attributedBodyBuffer - The attributedBody buffer from Messages database
 * @returns Extracted text, or "" when no real text could be decoded
 */
export async function extractTextFromAttributedBody(
  attributedBodyBuffer: Buffer | null | undefined
): Promise<string> {
  if (!attributedBodyBuffer || attributedBodyBuffer.length === 0) {
    return "";
  }

  // DETERMINISTIC: Detect format from magic bytes
  const format = detectAttributedBodyFormat(attributedBodyBuffer);

  logService.debug(`Detected attributedBody format: ${format}`, "MessageParser", {
    bufferLength: attributedBodyBuffer.length,
  });

  switch (format) {
    case "bplist": {
      const result = extractTextFromBinaryPlist(attributedBodyBuffer);
      if (result && result.length >= MIN_MESSAGE_TEXT_LENGTH) {
        const cleaned = cleanExtractedText(result);
        if (
          cleaned.length >= MIN_MESSAGE_TEXT_LENGTH &&
          cleaned.length < MAX_MESSAGE_TEXT_LENGTH &&
          !isEffectivelyEmptyText(cleaned)
        ) {
          return cleaned;
        }
      }
      // Binary plist parse failed / no real content
      logService.debug("Binary plist extraction returned no content", "MessageParser");
      return "";
    }

    case "typedstream": {
      // Custom parser handles both regular (0x94) and mutable (0x95) NSString preambles,
      // extended length encoding (1-byte, 0x81/u16, 0x82/u32), a truncation-recovery
      // tier, and metadata filtering. This replaces the imessage-parser library which
      // only handled the regular preamble and brought in 72 npm vulnerabilities via its
      // sqlite3 -> node-gyp -> tar dependency chain.
      // Wrap in try-catch to handle potential stack overflow from malformed data
      try {
        const customResult = extractTextFromTypedstream(attributedBodyBuffer);
        if (customResult && customResult.length >= MIN_MESSAGE_TEXT_LENGTH) {
          const cleaned = cleanExtractedText(customResult);
          if (
            cleaned.length >= MIN_MESSAGE_TEXT_LENGTH &&
            cleaned.length < MAX_MESSAGE_TEXT_LENGTH &&
            !isEffectivelyEmptyText(cleaned)
          ) {
            logService.debug(`Typedstream parser succeeded: ${cleaned.length} chars`, "MessageParser");
            return cleaned;
          }
        }
      } catch (parseError) {
        logService.warn("Typedstream parser error", "MessageParser", {
          error: (parseError as Error).message,
          bufferLength: attributedBodyBuffer.length,
        });
      }

      // Typedstream parse failed / no real content
      logService.debug("Typedstream extraction returned no content", "MessageParser");
      return "";
    }

    case "unknown":
    default: {
      // Unknown format - do NOT guess, do NOT try encodings
      logService.warn("Unknown attributedBody format", "MessageParser", {
        bufferLength: attributedBodyBuffer.length,
        hexPreview: attributedBodyBuffer.subarray(0, 20).toString("hex"),
      });
      return "";
    }
  }
}

/**
 * Check if a string segment is typedstream metadata (should be filtered from results)
 *
 * Typedstream format contains internal metadata strings that should not be
 * returned as message content. This function identifies these patterns:
 *
 * - Cocoa class names: NSAttributedString, NSMutableString, NSObject, etc.
 * - Property accessors: NS.* patterns
 * - Archive markers: $class, $objects, $archiver, $version, $top
 * - iMessage keys: __kIM*, kIM* prefixes (TASK-1048: added kIM for consistency)
 * - Attribute markers: AttributeName patterns
 * - Format markers: streamtyped
 * - Hex-like strings: short hex sequences often appearing as metadata
 *
 * TASK-1048: Consolidated from inline checks for consistency
 *
 * @param text - String to check
 * @returns True if the string is metadata and should be filtered
 */
function isTypedstreamMetadata(text: string): boolean {
  return (
    // Cocoa class names
    text.includes("NSAttributedString") ||
    text.includes("NSMutableString") ||
    text.includes("NSObject") ||
    text.includes("NSDictionary") ||
    text.includes("NSArray") ||
    text.includes("NSString") ||
    text.includes("NSData") || // TASK-1048: Added from inline checks
    // Property accessors
    text.startsWith("NS.") ||
    // Archive markers
    text.includes("$class") ||
    text.includes("$objects") ||
    text.includes("$archiver") ||
    text.includes("$version") ||
    text.includes("$top") ||
    // iMessage internal keys
    text.includes("__kIM") ||
    text.startsWith("kIM") || // TASK-1048: Added for consistency with TASK-1047
    text.includes("AttributeName") ||
    // Format markers
    text.includes("streamtyped") ||
    // Hex-like strings (often metadata)
    /^[0-9A-Fa-f]{2,4}$/.test(text.trim())
  );
}

/**
 * Clean extracted text by removing control characters and artifacts
 *
 * IMPORTANT: This function does NOT remove U+FFFD replacement characters.
 * Removing replacement characters causes DATA LOSS as they often represent
 * actual characters that couldn't be decoded. Instead, we preserve them
 * and rely on multi-encoding detection to properly decode the text upstream.
 *
 * @param text - Text to clean
 * @returns Cleaned text
 */
export function cleanExtractedText(text: string): string {
  if (!text) return "";

  let cleaned = text;

  // Remove null bytes and control characters FIRST
  // NOTE: We do NOT remove U+FFFD (replacement character) as that causes data loss
  cleaned = cleaned
    .replace(REGEX_PATTERNS.NULL_BYTES, "") // Remove null bytes
    .replace(REGEX_PATTERNS.CONTROL_CHARS, "") // Remove control chars (but NOT U+FFFD)
    .trim();

  // Remove iMessage internal attribute names that might have leaked through
  cleaned = cleaned.replace(/__kIM\w+/g, "").trim();
  cleaned = cleaned.replace(/kIMMessagePart\w*/g, "").trim();

  // AGGRESSIVE: Remove "00" anywhere it appears on its own line or at start
  // This handles various encoding artifacts from typedstream parsing
  cleaned = cleaned
    .replace(/^00\n/gm, "") // "00" on its own line (multiline)
    .replace(/^00\r\n/gm, "") // "00" with Windows line endings
    .replace(/^00\s+/gm, "") // "00" followed by whitespace at line start
    .replace(/^00$/gm, "") // "00" as entire line
    .trim();

  // Split into lines and filter empty ones
  const lines = cleaned.split(/[\r\n]+/);
  const filteredLines = lines
    .map((line) => line.trim())
    .filter((line) => {
      if (line.length === 0) return false;
      // Remove lines that are just "00" or other short hex values
      if (/^[0-9A-Fa-f]{2,4}$/.test(line)) return false;
      return true;
    });

  return filteredLines.join("\n").trim();
}

/**
 * Get message text from a message object
 *
 * Priority:
 * 1. Use message.text if present, valid after cleaning, and NOT garbage
 * 2. Parse attributedBody using deterministic format detection
 * 3. Otherwise return "" (empty)
 *
 * TASK-1071: Re-added looksLikeBinaryGarbage check for message.text field.
 * If the text field contains binary garbage (UTF-16 misinterpreted bytes),
 * we fall back to attributedBody parsing which uses deterministic format
 * detection (TASK-1049).
 *
 * BACKLOG-2262: Returns "" (empty) — NOT a "[placeholder]" — when no real text
 * can be decoded (including caption-less media and reaction/system messages). The
 * import layer retains an empty-text message when it carries an attachment, so the
 * attachment is no longer orphaned; genuinely empty, attachment-less messages are
 * dropped by the import filter.
 *
 * @param message - Message object from database
 * @returns Message text, or "" when no real text could be decoded
 */
export async function getMessageText(message: Message): Promise<string> {
  // If text field exists and is not empty, check if it's valid
  if (message.text && message.text.length >= MIN_MESSAGE_TEXT_LENGTH) {
    // TASK-1071: Check for binary garbage before using text field
    // This catches cases where binary data was incorrectly stored as text
    if (!looksLikeBinaryGarbage(message.text)) {
      const cleaned = cleanExtractedText(message.text);
      if (cleaned.length >= MIN_MESSAGE_TEXT_LENGTH) {
        return cleaned;
      }
    } else {
      // Text field contains garbage, log and fall through to attributedBody
      logService.debug("Text field contains binary garbage, falling back to attributedBody", "MessageParser", {
        textLength: message.text.length,
        textPreview: message.text.substring(0, 50),
      });
    }
  }

  // Try to extract from attributed body
  if (message.attributedBody) {
    return await extractTextFromAttributedBody(message.attributedBody);
  }

  // BACKLOG-2262: No decodable text. Return "" — the import layer keeps the
  // message when it carries an attachment (has_attachments) and drops it
  // otherwise. Do NOT emit a "[placeholder]" that would trigger a row drop.
  return "";
}
