/**
 * Keepr — conversation extraction for Messages for Web (BACKLOG-3619 POC).
 *
 * A PURE function over a DOM: given the conversation page's document, its URL
 * and "now", it returns every message the page has loaded. It never fetches,
 * never touches chrome.* APIs and never mutates the page, so jest can run it
 * against a fixture exactly as the content script runs it against the page.
 *
 * Loaded two ways:
 *   - as a content script (listed before content.js in manifest.json), where
 *     it sets `globalThis.KeeprExtract`;
 *   - from jest via `require`, where it sets `module.exports`.
 *
 * BACKLOG-3620 adds images (blob: URLs; the content script reads the bytes),
 * files (name + size only — not imported), reactions, and keeps image-only
 * messages. Structure from the live-page notes: images
 * `mws-image-message-part[aria-label="<Name> sent an image. …"]` →
 * `[data-e2e-message-image]` → `img[src^="blob:"]`; files
 * `mws-file-message-part[data-e2e-file]` with aria-label
 * "<Name> sent a file: <name>. …"; reactions
 * `mw-message-reactions-display span.reaction[data-e2e-reaction]` (text = the
 * emoji) and a label tail "<Reactor> reacted with <word>.".
 *
 * PAGE STRUCTURE: the message wrapper, the message core (outgoing / RCS flags),
 * the text part, the aria-label wording, tombstone rows and the header title
 * were observed on the live page (2026-09-29, one SMS conversation, en-US).
 * NOT observed there: "Today" / "Yesterday" / weekday date forms and the quoted
 * reply container — those are handled defensively. A missing piece yields a
 * skipped message with a reason, never a throw and never an invented value.
 */
(function (root) {
  "use strict";

  var SELECTORS = {
    /**
     * One message; its id is the `msg-id` attribute. The id is numeric and NOT
     * unique across conversations — callers key on (conversation id, msg-id).
     * System rows are `mws-tombstone-message-wrapper` and never match.
     */
    message: "mws-message-wrapper[msg-id]",
    /** On the message core; present on every message with value true|false. */
    outgoing: '[data-e2e-message-outgoing="true"]',
    /** On the message core; true = RCS, false = SMS. */
    rcsFlag: "[data-e2e-message-rcs]",
    /** The message's text content (inside mws-text-message-part). */
    text: "[data-e2e-message-content]",
    /** Fallback when no content element exists. */
    textFallback: "mws-text-message-part",
    /** The element whose aria-label carries sender, text and date. */
    label: "mws-text-message-part[aria-label], .msg-focus-element[aria-label], [aria-label]",
    /** A quoted parent message (reply-to). Its text is NOT this message's text. */
    quoted: ".embed-msg-part-container",
    /** BACKLOG-3620: an image or GIF; its bytes are behind a blob: URL. */
    image: "mws-image-message-part [data-e2e-message-image] img[src]",
    /** BACKLOG-3620: a file (PDF, …) — recorded by name and size only. */
    file: "mws-file-message-part[data-e2e-file]",
    /** BACKLOG-3620: one reaction pill; its text is the emoji. */
    reaction: "mw-message-reactions-display span.reaction[data-e2e-reaction]",
    /** Conversation title candidates, first non-empty wins. */
    title: [
      "[data-e2e-header-title] h2",
      "[data-e2e-header-title]",
      "[data-e2e-conversation-name]",
      "mws-conversation-header h2",
      "mws-conversation-header .title",
      "h2.title",
    ],
  };

  var MONTHS = {
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
    jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
  };

  var WEEKDAYS = {
    sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
    thursday: 4, friday: 5, saturday: 6,
  };

  /**
   * "Sent on <date> at <h>:<mm> <AM|PM>" / "Received on …". Global: the LAST
   * match in a label is the date, because the message text that precedes it
   * can itself contain "on" and periods.
   */
  var DATE_RE = /\b(Sent|Received) on ([^.]+?),? at (\d{1,2}):(\d{2})\s*([AP])\.?M\b/gi;
  /**
   * Observed shapes: "<Sender Name> said: <text>. Received on …",
   * "<Sender Name> sent an image. Received on …", "<Sender Name> sent a file: …".
   */
  // History v2 sender fallback (English): "<name> said: …", "<name> replied: …",
  // "<name> sent …" — ANCHORED at the start, so a reaction later in the label
  // ("… <reactor> reacted with …") is never taken for the sender. The name is
  // only used to map a group sender to a number; never logged, never a key.
  var SENDER_RE = /^(.+?) (?:said: |replied: |replied\b|sent an? \w+|sent a file\b)/;
  /** Reaction tail on a message label: "<Reactor> reacted with <word>." */
  var REACTED_RE = /(?:^|\.\s+)([^.]+?) reacted with ([^.]+?)(?=\.|$)/g;
  /**
   * A label with a time and no day ("Received at 2:56 PM" — a message under
   * a time-only header): today. UNTRACED wording, handled defensively.
   */
  var TIME_ONLY_RE = /\b(Sent|Received) at (\d{1,2}):(\d{2})\s*([AP])\.?M\b/i;
  /** A bubble whose whole text is a video file name ("<uuid>.mp4", "159605.mp4"): an attachment. */
  var VIDEO_NAME_RE = /^[\w.-]+\.(mp4|mov|m4v|3gp|3gpp|webm|avi)$/i;
  /**
   * An SMS tapback summary line ("Loved an image", "Laughed at “…”") sent by
   * a phone that cannot send RCS reactions: a reaction on its target, not a
   * message. Verb → emoji.
   */
  var TAPBACK_RE = /^(Loved|Liked|Disliked|Laughed at|Emphasized|Questioned) (?:(an image|a photo|a movie|a video|an attachment|a GIF|an audio message)|[“"](.+)[”"])$/;
  var TAPBACK_EMOJI = {
    loved: "\u2764\ufe0f", liked: "\ud83d\udc4d", disliked: "\ud83d\udc4e",
    "laughed at": "\ud83d\ude02", emphasized: "\u203c\ufe0f", questioned: "\u2753",
  };

  /** File label: "<Name> sent a file: <file name>. Sent on …". */
  var FILE_RE = /sent a file: (.+?)\. (?:Sent|Received) on /;

  function normalizeSpace(s) {
    return String(s || "").replace(/[\s  ]+/g, " ").trim();
  }

  function startOfDay(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }

  /**
   * The calendar day a date phrase names, in the page's local time zone, or
   * null. en-US page assumed (POC).
   */
  function parseDayPhrase(phrase, now) {
    var p = normalizeSpace(phrase).toLowerCase();
    var today = startOfDay(now);

    if (p === "today") return today;
    if (p === "yesterday") {
      return new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
    }
    if (Object.prototype.hasOwnProperty.call(WEEKDAYS, p)) {
      // The most recent such day strictly before today (today reads "Today").
      var back = (today.getDay() - WEEKDAYS[p] + 7) % 7 || 7;
      return new Date(today.getFullYear(), today.getMonth(), today.getDate() - back);
    }

    // "September 28, 2026" / "Sep 28, 2026" / "Sep 28" (optionally prefixed by a weekday)
    var m = p.match(/(?:[a-z]+,\s*)?([a-z]{3,9})\.?\s+(\d{1,2})(?:,\s*(\d{4}))?$/);
    if (m && Object.prototype.hasOwnProperty.call(MONTHS, m[1].slice(0, 3))) {
      var month = MONTHS[m[1].slice(0, 3)];
      var day = parseInt(m[2], 10);
      if (m[3]) return new Date(parseInt(m[3], 10), month, day);
      var guess = new Date(today.getFullYear(), month, day);
      // No year shown means this year — unless that is in the future.
      if (guess > today) guess = new Date(today.getFullYear() - 1, month, day);
      return guess;
    }

    // "9/28/26" or "9/28/2026"
    var n = p.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
    if (n) {
      var y = parseInt(n[3], 10);
      if (y < 100) y += 2000;
      return new Date(y, parseInt(n[1], 10) - 1, parseInt(n[2], 10));
    }
    return null;
  }

  /**
   * Parse one aria-label. Returns { direction, date } or null when the label
   * carries no "Sent on / Received on" phrase.
   */
  function parseAriaDate(label, now) {
    var text = normalizeSpace(label);
    var matches = [];
    var cur;
    DATE_RE.lastIndex = 0;
    while ((cur = DATE_RE.exec(text)) !== null) matches.push(cur);
    // Last parseable match wins (message text precedes the date).
    var m = null;
    var day = null;
    for (var i = matches.length - 1; i >= 0 && !day; i--) {
      m = matches[i];
      day = parseDayPhrase(m[2], now);
    }
    if (!day) {
      var t = text.match(TIME_ONLY_RE);
      if (!t) return null;
      var th = parseInt(t[2], 10) % 12;
      if (t[4].toUpperCase() === "P") th += 12;
      return {
        direction: t[1].toLowerCase() === "sent" ? "outbound" : "inbound",
        date: timeOnDay(null, th, parseInt(t[3], 10), now),
        timeOnly: { hour: th, minute: parseInt(t[3], 10) },
      };
    }
    var hour = parseInt(m[3], 10) % 12;
    if (m[5].toUpperCase() === "P") hour += 12;
    var minute = parseInt(m[4], 10);
    return {
      direction: m[1].toLowerCase() === "sent" ? "outbound" : "inbound",
      date: new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute),
    };
  }

  /** A time with no day: on `day` (a day separator's) — else today, or yesterday when today's would be > 5 min in the future. */
  function timeOnDay(day, hour, minute, now) {
    if (day) return new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute);
    var td = startOfDay(now);
    var d = new Date(td.getFullYear(), td.getMonth(), td.getDate(), hour, minute);
    if (d.getTime() - now.getTime() > 5 * 60 * 1000) d = new Date(td.getFullYear(), td.getMonth(), td.getDate() - 1, hour, minute);
    return d;
  }

  /**
   * Day separators in the messages pane (UNTRACED shapes, handled
   * defensively): the date rows Google shows between messages, e.g.
   * "Monday, July 28, 2025 · 1:43 PM", "Yesterday · 2:56 PM", "2:56 PM ·".
   */
  var DAY_SEPARATOR_SELECTORS = "mws-tombstone-message-wrapper, [data-e2e-date-separator], mws-message-date-separator";

  /** The day the nearest preceding day separator names (a time-only one is skipped), or null. */
  function precedingSeparatorDay(wrapper, now) {
    var doc = wrapper.ownerDocument;
    var all = doc.querySelectorAll(SELECTORS.message + ", " + DAY_SEPARATOR_SELECTORS);
    var idx = Array.prototype.indexOf.call(all, wrapper);
    for (var i = idx - 1; i >= 0; i--) {
      var el = all[i];
      if (el.matches && el.matches(SELECTORS.message)) continue;
      var parts = normalizeSpace(el.textContent).split("·");
      for (var p = 0; p < parts.length; p++) {
        var day = parseDayPhrase(parts[p], now);
        if (day) return day;
      }
    }
    return null;
  }

  function firstText(scope, selectors) {
    for (var i = 0; i < selectors.length; i++) {
      var el = scope.querySelector(selectors[i]);
      var t = el ? normalizeSpace(el.textContent) : "";
      if (t) return t;
    }
    return "";
  }

  /** "rcs" | "sms" from the message core's RCS flag, or null when absent. */
  function messageTransport(wrapper) {
    var el = wrapper.matches(SELECTORS.rcsFlag) ? wrapper : wrapper.querySelector(SELECTORS.rcsFlag);
    if (!el) return null;
    var v = String(el.getAttribute("data-e2e-message-rcs")).toLowerCase();
    if (v === "true") return "rcs";
    if (v === "false") return "sms";
    return null;
  }

  function isInside(el, ancestorSelector, stopAt) {
    var cur = el.parentElement;
    while (cur && cur !== stopAt) {
      if (cur.matches && cur.matches(ancestorSelector)) return true;
      cur = cur.parentElement;
    }
    return false;
  }

  /** This message's own text: every text part not inside a quoted parent, de-nested. */
  function messageText(wrapper) {
    var parts = Array.prototype.slice.call(wrapper.querySelectorAll(SELECTORS.text));
    if (parts.length === 0) {
      parts = Array.prototype.slice.call(wrapper.querySelectorAll(SELECTORS.textFallback));
    }
    var own = parts.filter(function (el) {
      if (el.matches(SELECTORS.quoted) || isInside(el, SELECTORS.quoted, wrapper)) return false;
      // Skip a part nested inside another matched part (avoids doubled text).
      return !parts.some(function (other) {
        return other !== el && other.contains(el);
      });
    });
    return own
      .map(function (el) { return normalizeSpace(el.textContent); })
      .filter(Boolean)
      .join("\n");
  }

  /** The first aria-label in the message that carries a date, parsed. */
  function messageLabel(wrapper, now) {
    var labelled = [wrapper].concat(
      Array.prototype.slice.call(wrapper.querySelectorAll(SELECTORS.label))
    );
    for (var i = 0; i < labelled.length; i++) {
      if (isInside(labelled[i], SELECTORS.quoted, wrapper)) continue;
      var label = labelled[i].getAttribute("aria-label");
      if (!label) continue;
      var parsed = parseAriaDate(label, now);
      if (parsed) {
        var s = normalizeSpace(label).match(SENDER_RE);
        return { parsed: parsed, sender: s ? s[1] : "" };
      }
    }
    return null;
  }

  /** Every aria-label in the message that is not inside a quoted parent. */
  function ownLabels(wrapper) {
    var labelled = [wrapper].concat(
      Array.prototype.slice.call(wrapper.querySelectorAll("[aria-label]"))
    );
    var out = [];
    for (var i = 0; i < labelled.length; i++) {
      if (labelled[i] !== wrapper && isInside(labelled[i], SELECTORS.quoted, wrapper)) continue;
      var label = labelled[i].getAttribute("aria-label");
      if (label) out.push(normalizeSpace(label));
    }
    return out;
  }

  /** blob: URLs of this message's own images, in page order. */
  function messageImages(wrapper) {
    var imgs = Array.prototype.slice.call(wrapper.querySelectorAll(SELECTORS.image));
    var out = [];
    for (var i = 0; i < imgs.length; i++) {
      if (isInside(imgs[i], SELECTORS.quoted, wrapper)) continue;
      var src = imgs[i].getAttribute("src") || "";
      if (src) out.push(src);
    }
    return out;
  }

  /** Files shown on this message: name and size text only. */
  function messageFiles(wrapper) {
    var parts = Array.prototype.slice.call(wrapper.querySelectorAll(SELECTORS.file));
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      if (isInside(parts[i], SELECTORS.quoted, wrapper)) continue;
      var label = normalizeSpace(parts[i].getAttribute("aria-label"));
      var m = label.match(FILE_RE);
      var name = m ? m[1] : "";
      var visible = normalizeSpace(parts[i].textContent);
      if (!name) name = visible;
      var size = normalizeSpace(visible.replace(name, ""));
      if (name) out.push({ name: name, size: size });
    }
    return out;
  }

  /**
   * Reactions on this message. Each pill's text is the emoji; the reactor comes
   * from the label tails "<Name> reacted with <word>.", paired in order
   * (UNTRACED: the page's pairing of several tails to several pills). "You" is
   * the user ("me").
   */
  function messageReactions(wrapper) {
    var spans = Array.prototype.slice.call(wrapper.querySelectorAll(SELECTORS.reaction));
    if (spans.length === 0) return [];
    var tails = [];
    var labels = ownLabels(wrapper);
    for (var i = 0; i < labels.length && tails.length === 0; i++) {
      var cur;
      REACTED_RE.lastIndex = 0;
      while ((cur = REACTED_RE.exec(labels[i])) !== null) {
        tails.push({ reactor: normalizeSpace(cur[1]), word: normalizeSpace(cur[2]) });
      }
    }
    var out = [];
    for (var j = 0; j < spans.length; j++) {
      // The attribute is the emoji alone; a pill shared by several people may
      // show a count after it ("😡 2"), so the text is a fallback with any
      // trailing count removed.
      var emoji = normalizeSpace(spans[j].getAttribute("data-e2e-reaction-emoji")) ||
        normalizeSpace(normalizeSpace(spans[j].textContent).replace(/\s*\d+$/, ""));
      if (!emoji) continue;
      var tail = tails.length === spans.length ? tails[j] : tails.length === 1 ? tails[0] : null;
      var reactor = tail ? tail.reactor : "";
      out.push({
        emoji: emoji,
        reactor: /^you$/i.test(reactor) ? "me" : reactor,
        word: tail ? tail.word : "",
      });
    }
    return out;
  }

  function conversationIdFromUrl(href) {
    var m = String(href || "").match(/\/web\/conversations\/([^/?#]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  /**
   * Extract the open conversation.
   *
   * @param {Document} doc
   * @param {string} href  location.href of the page
   * @param {Date} now     "now" for Today / Yesterday
   * @returns {{
   *   conversationId: string|null, title: string,
   *   messages: Array<{msgId:string, direction:"inbound"|"outbound", sender:string,
   *                    text:string, sentAt:string, transport:"rcs"|"sms"|null}>,
   *   skipped: {noDate:number, noText:number, duplicate:number}
   * }}
   */
  function extractConversation(doc, href, now) {
    var title = firstText(doc, SELECTORS.title);
    var result = {
      conversationId: conversationIdFromUrl(href),
      title: title,
      messages: [],
      skipped: { noDate: 0, noText: 0, duplicate: 0 },
    };
    var seen = {};
    var wrappers = doc.querySelectorAll(SELECTORS.message);
    for (var i = 0; i < wrappers.length; i++) {
      var w = wrappers[i];
      var msgId = normalizeSpace(w.getAttribute("msg-id"));
      if (!msgId) continue;
      if (seen[msgId]) {
        result.skipped.duplicate++;
        continue;
      }
      seen[msgId] = true;

      var text = messageText(w);
      var images = messageImages(w);
      var files = messageFiles(w);
      // A video shown as its file name: an attachment, not text.
      if (images.length === 0 && VIDEO_NAME_RE.test(text)) {
        files.push({ name: text, size: "" });
        text = "";
      }
      // An image bubble whose image did not load (no blob yet): still an
      // attachment message, never silently dropped.
      if (images.length === 0 && hasOwnImagePart(w)) files.push({ name: "image (not loaded)", size: "" });
      // BACKLOG-3620: an image-only (or file-only) message is kept.
      if (!text && images.length === 0 && files.length === 0) {
        result.skipped.noText++;
        continue;
      }
      var dated = messageLabel(w, now);
      // A time-only label: the nearest preceding day separator's day.
      if (dated && dated.parsed.timeOnly) {
        dated.parsed.date = timeOnDay(precedingSeparatorDay(w, now), dated.parsed.timeOnly.hour, dated.parsed.timeOnly.minute, now);
      }
      if (!dated) {
        result.skipped.noDate++;
        continue;
      }

      var outgoing = w.matches(SELECTORS.outgoing) || !!w.querySelector(SELECTORS.outgoing);
      // Incoming: the name before " said: " in the label; the chat title if none.
      var sender = outgoing ? "me" : dated.sender || title;

      result.messages.push({
        msgId: msgId,
        direction: outgoing ? "outbound" : "inbound",
        sender: sender,
        text: text,
        sentAt: dated.parsed.date.toISOString(),
        transport: messageTransport(w),
        images: images.length,
        imageSrcs: images,
        files: files,
        reactions: messageReactions(w),
      });
    }
    result.messages = foldTapbackLines(result.messages);
    return result;
  }

  /** An image part of this message (not of a quoted parent), loaded or not. */
  function hasOwnImagePart(wrapper) {
    var parts = wrapper.querySelectorAll("mws-image-message-part");
    for (var i = 0; i < parts.length; i++) {
      if (!isInside(parts[i], SELECTORS.quoted, wrapper)) return true;
    }
    return false;
  }

  /**
   * Tapback summary lines → reactions on their target: the latest earlier
   * message whose text is the quoted text, or (for "an image" etc.) the
   * latest earlier message with media. No target on screen → kept as a
   * message (never lost).
   */
  function foldTapbackLines(messages) {
    var out = [];
    for (var i = 0; i < messages.length; i++) {
      var msg = messages[i];
      var m = msg.images === 0 && msg.files.length === 0 ? String(msg.text).match(TAPBACK_RE) : null;
      var target = null;
      if (m) {
        for (var j = out.length - 1; j >= 0 && !target; j--) {
          var c = out[j];
          if (m[3] !== undefined ? c.text === m[3] : c.images > 0 || c.files.length > 0) target = c;
        }
      }
      if (!target) {
        out.push(msg);
        continue;
      }
      var verb = m[1].toLowerCase();
      target.reactions.push({ emoji: TAPBACK_EMOJI[verb], reactor: msg.sender, word: verb.replace(/ at$/, "") });
    }
    return out;
  }

  var api = {
    SELECTORS: SELECTORS,
    extractConversation: extractConversation,
    parseAriaDate: parseAriaDate,
    conversationIdFromUrl: conversationIdFromUrl,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.KeeprExtract = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
