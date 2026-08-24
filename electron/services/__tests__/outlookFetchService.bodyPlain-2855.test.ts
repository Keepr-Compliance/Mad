/**
 * @jest-environment node
 *
 * BACKLOG-2855 — the Outlook mapper must DERIVE plain text from the HTML body,
 * not fall back to Graph's `bodyPreview`.
 *
 * WHAT THIS FILE PROVES, AND WHY IT IS SEPARATE FROM THE UTIL SUITE
 * ----------------------------------------------------------------
 * `electron/utils/__tests__/htmlToPlainText.test.ts` proves the converter is
 * correct. It cannot prove anything is WIRED to it. This file drives the real
 * `outlookFetchService.searchEmails()` through a mocked axios, so reverting the
 * one-line mapper change turns these red — which is the control that makes them
 * worth having.
 *
 * The last section goes one step further and proves the CONSEQUENCE: it stores
 * the mapper's output in a real SQLite `emails` row and runs the production
 * search query against it. Before the fix, a term past the preview cutoff was
 * silently unfindable. Nothing in the repo covered that.
 *
 * FIXTURE PROVENANCE — TRANSCRIBED, NOT INVENTED
 * ---------------------------------------------
 * Every Graph shape below is copied from a documented real response:
 *
 *   Source: https://learn.microsoft.com/en-us/graph/api/message-get?view=graph-rest-1.0
 *     - Example 1 ("Get a specific message"): a 200 OK whose `body` is
 *       `{"contentType":"html","content":"<html>\r\n<head>\r\n<meta .../>..."}`
 *       alongside `"bodyPreview":"The group represents Nevada."`
 *     - Example 3 ("Get message body in text format"): the same resource with
 *       `Prefer: outlook.body-content-type="text"`, giving `contentType:"text"`.
 *     - Example 4 ("Get MIME content"): the raw MIME of a real message, whose
 *       `text/html` part carries Outlook's standard document skeleton.
 *
 *   Source: https://learn.microsoft.com/en-us/graph/api/resources/message?view=graph-rest-1.0
 *     - `body` is an `itemBody`; `bodyPreview` is a separate String property
 *       documented as "The first 255 characters of the message body. It is in
 *       text format."
 *
 * ON THE NUMBER 255: it is Microsoft's DOCUMENTED cap, not a figure measured
 * against this tenant's live traffic. It is corroborated by the docs' own
 * Example 3, whose `bodyPreview` measures exactly 255 characters and is cut
 * mid-word ("...\r\n\r\n\r\n\r\nTh"). The defect does not depend on the exact
 * number — only on the preview being a prefix of the body.
 */

import path from "path";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");
import type { Database as DatabaseType } from "better-sqlite3";

import outlookFetchService from "../outlookFetchService";
import databaseService from "../databaseService";
import microsoftAuthService from "../microsoftAuthService";
import axios from "axios";
import type { OAuthToken } from "../../types/models";
import { buildEmailQuery } from "../db/transactionSearchDbService";

jest.mock("../databaseService");
jest.mock("../microsoftAuthService");
jest.mock("axios");

const mockDatabaseService = databaseService as jest.Mocked<typeof databaseService>;
const mockAxios = axios as jest.MockedFunction<typeof axios>;
void microsoftAuthService;

const USER_ID = "test-user-id";
const mockTokenRecord = {
  id: "token-id",
  user_id: USER_ID,
  provider: "microsoft" as const,
  purpose: "mailbox" as const,
  access_token: "test-access-token",
  refresh_token: "test-refresh-token",
  token_expires_at: new Date(Date.now() + 3600000).toISOString(),
  connected_email_address: "test@example.com",
  is_active: true,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
} as OAuthToken;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Outlook's standard document skeleton, transcribed from Graph `Get message`
 * Example 4's `text/html` MIME part (quoted-printable decoded: `=3D` → `=`,
 * soft `=` line breaks joined).
 *
 * The `<style>` block is REAL Outlook output, present on essentially every
 * message. It is also the negative control: `margin-top` must never reach
 * `body_plain`, or every Outlook email would be indexed with CSS in it.
 */
function outlookDocument(innerHtml: string): string {
  return `<html>
<head>
<meta http-equiv="Content-Type" content="text/html; charset=iso-8859-1">
<style type="text/css" style="display:none;"><!-- P {margin-top:0;margin-bottom:0;} --></style>
</head>
<body dir="ltr">
<div id="divtagdefaultwrapper" style="font-size:12pt;color:#000000;font-family:Calibri,Helvetica,sans-serif;" dir="ltr">
${innerHtml}
</div>
</body>
</html>`;
}

/**
 * A token that appears ONLY deep inside the message body — never in the
 * subject, never in the preview. Identity assertions use this; a length
 * assertion would also pass if the mapper returned raw HTML, which is exactly
 * the mistake this item is about.
 */
const SENTINEL = "ARBOR-CREST-PARCEL-88231";

/** A term inside the first 255 characters — findable even WITH the defect. */
const EARLY_TERM = "counter-offer";

const LONG_BODY_HTML = outlookDocument(
  [
    "<p>Hi Dana,</p>",
    "<p>Following up on the counter-offer we discussed yesterday afternoon. The",
    "sellers have reviewed the revised terms and are prepared to move forward,",
    "subject to the inspection contingency being resolved within the timeline we",
    "agreed. I have attached the updated addendum for your records, and I will",
    "circulate the revised closing disclosure as soon as the lender releases it.</p>",
    "<p>A few items still outstanding before we can schedule the walkthrough:</p>",
    "<ul>",
    "<li>Confirmation from the title company that the survey has been ordered</li>",
    "<li>The signed lead-based paint disclosure from both parties</li>",
    "<li>Wire instructions verified by phone, not by email</li>",
    "</ul>",
    `<p>The parcel identifier for the property is ${SENTINEL} and the county`,
    "recorder has it listed under the original plat name. Please reference that",
    "identifier on every document you submit, because the street address alone",
    "matches two separate lots in that subdivision.</p>",
    "<p>Best regards,<br>Alex</p>",
  ].join("\n"),
);

/**
 * What Graph would actually send alongside that body: a short text preview.
 * Built as a genuine 255-character prefix of the message text, per the
 * documented "first 255 characters" behaviour, so the fixture reproduces the
 * real relationship between the two fields rather than asserting a made-up one.
 */
/**
 * Exactly 255 characters, cut mid-word — the shape Graph documents and the
 * shape its own Example 3 response exhibits. Asserted below rather than
 * trusted: the first draft of this constant was 252 characters and the
 * fixture-property control caught it.
 */
const LONG_BODY_PREVIEW =
  "Hi Dana, Following up on the counter-offer we discussed yesterday afternoon. The sellers have reviewed the revised terms and are prepared to move forward, subject to the inspection contingency being resolved within the timeline we agreed. I have attached ";

/** Graph `Get message` Example 1, verbatim. HTML source longer, TEXT shorter. */
const EXAMPLE_1_HTML =
  '<html>\r\n<head>\r\n<meta http-equiv="Content-Type" content="text/html; charset=utf-8">\r\n<meta content="text/html; charset=us-ascii">\r\n</head>\r\n<body>\r\nThe group represents Nevada.\r\n</body>\r\n</html>\r\n';
const EXAMPLE_1_PREVIEW = "The group represents Nevada.";

/**
 * Graph `Get message` Example 3 `body.content`, verbatim (contentType "text").
 *
 * Transcribed by extracting the JSON string straight out of the doc source
 * rather than retyped. That matters: an earlier draft dropped the five `[😊]`
 * placeholders the real response carries, which made the "verbatim" label
 * false (SR review, S1). They also give this pass-through case non-ASCII /
 * surrogate-pair coverage, which is the reason to restore them rather than
 * relax the claim.
 *
 * `EXAMPLE_3_PREVIEW` below does NOT contain them and is equally verbatim —
 * Graph's own `bodyPreview` for this message omits them, so the preview is not
 * a literal prefix of the body. Do not "fix" one to match the other.
 *
 * Source: microsoft-graph-docs-contrib, api-reference/v1.0/api/message-get.md,
 * Example 3 response, `body.content` (NOT `uniqueBody.content`, which differs).
 */
const EXAMPLE_3_TEXT_CONTENT =
  "Welcome to our group, Dana! Hope you will enjoy working with us [😊] [😊] [😊] [😊] [😊] !\r\n\r\nWould you like to choose a day for our orientation from the available times below:\r\n\r\n\r\nDate\r\n        Time\r\n\r\nApril 14, 2017\r\n        1-3pm\r\n\r\nApril 21, 2017\r\n        10-12noon\r\n\r\n\r\n\r\nThanks!\r\n\r\n";
const EXAMPLE_3_PREVIEW =
  "Welcome to our group, Dana! Hope you will enjoy working with us !\r\n\r\nWould you like to choose a day for our orientation from the available times below:\r\n\r\n\r\nDate\r\n        Time\r\n\r\nApril 14, 2017\r\n        1-3pm\r\n\r\nApril 21, 2017\r\n        10-12noon\r\n\r\n\r\n\r\nTh";

interface GraphMessageFixture {
  id?: string;
  conversationId?: string;
  subject?: string;
  receivedDateTime?: string;
  sentDateTime?: string;
  hasAttachments?: boolean;
  body?: { content: string; contentType: string } | null;
  bodyPreview?: string;
}

function graphMessage(overrides: GraphMessageFixture): GraphMessageFixture {
  return {
    id: "msg-1",
    conversationId: "conv-1",
    subject: "Counter-offer follow-up",
    receivedDateTime: "2024-01-15T10:00:00Z",
    sentDateTime: "2024-01-15T09:59:00Z",
    hasAttachments: false,
    ...overrides,
  };
}

/** Drive the REAL mapper: mocked Graph response in, ParsedEmail out. */
async function mapViaService(message: GraphMessageFixture) {
  mockAxios.mockResolvedValue({ data: { value: [message] } });
  const results = await outlookFetchService.searchEmails({});
  return results[0];
}

// ---------------------------------------------------------------------------

describe("BACKLOG-2855 — Outlook bodyPlain derivation", () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    mockDatabaseService.getOAuthToken.mockResolvedValue(mockTokenRecord);
    await outlookFetchService.initialize(USER_ID);
  });

  describe("the core defect: a term past the preview cutoff", () => {
    it("the fixture itself has the property under test", () => {
      // A control on the CONTROL. If the sentinel were inside the preview, or
      // the preview were not a real prefix, every assertion below would pass
      // for the wrong reason.
      expect(LONG_BODY_PREVIEW).toHaveLength(255);
      expect(LONG_BODY_PREVIEW).not.toContain(SENTINEL);
      expect(LONG_BODY_PREVIEW).toContain(EARLY_TERM);
      expect(LONG_BODY_HTML.length).toBeGreaterThan(1000);
    });

    it("derives plain text CONTAINING a sentinel that appears only past character 300", async () => {
      const email = await mapViaService(
        graphMessage({
          body: { content: LONG_BODY_HTML, contentType: "html" },
          bodyPreview: LONG_BODY_PREVIEW,
        }),
      );

      // Identity, never length: a length assertion also passes if the mapper
      // returns the raw HTML, which would be a different bug with the same
      // measurement.
      expect(email.bodyPlain).toContain(SENTINEL);
      expect(email.bodyPlain.indexOf(SENTINEL)).toBeGreaterThan(300);
      expect(email.bodyPlain).not.toBe(LONG_BODY_PREVIEW);
    });

    it("produces plain TEXT — no tags survive", async () => {
      const email = await mapViaService(
        graphMessage({
          body: { content: LONG_BODY_HTML, contentType: "html" },
          bodyPreview: LONG_BODY_PREVIEW,
        }),
      );

      expect(email.bodyPlain).not.toContain("<");
      expect(email.bodyPlain).not.toContain("</p>");
      expect(email.bodyPlain).not.toContain("divtagdefaultwrapper");
    });

    it("does not index Outlook's boilerplate <style> rules as message text", async () => {
      const email = await mapViaService(
        graphMessage({
          body: { content: LONG_BODY_HTML, contentType: "html" },
          bodyPreview: LONG_BODY_PREVIEW,
        }),
      );

      expect(email.bodyPlain).not.toContain("margin-top");
      expect(email.bodyPlain).not.toContain("Calibri");
    });

    it("leaves body_html untouched — the HTML column still gets raw HTML", async () => {
      const email = await mapViaService(
        graphMessage({
          body: { content: LONG_BODY_HTML, contentType: "html" },
          bodyPreview: LONG_BODY_PREVIEW,
        }),
      );

      expect(email.body).toBe(LONG_BODY_HTML);
    });

    it("keeps bodyPreview in the snippet field, where 255 characters is correct", async () => {
      const email = await mapViaService(
        graphMessage({
          body: { content: LONG_BODY_HTML, contentType: "html" },
          bodyPreview: LONG_BODY_PREVIEW,
        }),
      );

      expect(email.snippet).toBe(LONG_BODY_PREVIEW);
    });
  });

  describe("boundary sweep", () => {
    it('contentType "text" uses body.content VERBATIM, unconverted', async () => {
      const email = await mapViaService(
        graphMessage({
          body: { content: EXAMPLE_3_TEXT_CONTENT, contentType: "text" },
          bodyPreview: EXAMPLE_3_PREVIEW,
        }),
      );

      // Byte-for-byte, CRLFs and all. A plain-text body must not be run through
      // an HTML converter — `a < b` in a plain-text mail would lose "< b".
      expect(email.bodyPlain).toBe(EXAMPLE_3_TEXT_CONTENT);
    });

    it("an HTML body whose TEXT is shorter than the preview still yields the text", async () => {
      // Graph Example 1: 243 characters of HTML, 28 characters of text, and a
      // 28-character preview. The bug is INVISIBLE here — both the old and new
      // code produce the same string — which is exactly why it is asserted: a
      // naive fix that always preferred the longer value would regress it.
      const email = await mapViaService(
        graphMessage({
          body: { content: EXAMPLE_1_HTML, contentType: "html" },
          bodyPreview: EXAMPLE_1_PREVIEW,
        }),
      );

      expect(email.bodyPlain).toBe("The group represents Nevada.");
    });

    it("a missing body yields an empty string", async () => {
      const email = await mapViaService(graphMessage({ body: null }));

      expect(email.body).toBe("");
      expect(email.bodyPlain).toBe("");
    });

    it("an empty bodyPreview does not stop HTML derivation", async () => {
      const email = await mapViaService(
        graphMessage({
          body: { content: "<p>Real content here</p>", contentType: "html" },
          bodyPreview: "",
        }),
      );

      expect(email.bodyPlain).toBe("Real content here");
    });

    it("falls back to bodyPreview when the HTML carries no text at all", async () => {
      // The LAST-RESORT path. An HTML body of pure markup (a tracking pixel
      // wrapper, say) derives to "", so the preview is better than nothing.
      const email = await mapViaService(
        graphMessage({
          body: { content: '<div><img src="cid:pixel"></div>', contentType: "html" },
          bodyPreview: "Something rather than nothing",
        }),
      );

      expect(email.bodyPlain).toBe("Something rather than nothing");
    });

    it("yields an empty string when there is neither text nor a preview", async () => {
      const email = await mapViaService(
        graphMessage({
          body: { content: "<div></div>", contentType: "html" },
          bodyPreview: "",
        }),
      );

      expect(email.bodyPlain).toBe("");
    });

    it("decodes entities and honours <br> runs from a real message body", async () => {
      const email = await mapViaService(
        graphMessage({
          body: {
            content: outlookDocument(
              "<p>Smith &amp; Jones<br><br>Suite&nbsp;300 &lt;by appointment&gt;</p>",
            ),
            contentType: "html",
          },
          bodyPreview: "Smith & Jones",
        }),
      );

      expect(email.bodyPlain).toContain("Smith & Jones");
      expect(email.bodyPlain).toContain("Suite 300 <by appointment>");
      expect(email.bodyPlain).not.toContain("&amp;");
      expect(email.bodyPlain).not.toContain("&nbsp;");
    });

    it("excludes <script> contents from the stored text", async () => {
      const email = await mapViaService(
        graphMessage({
          body: {
            content: outlookDocument(
              '<p>Visible sentence</p><script>var trackingBeacon = "doNotIndexMe";</script>',
            ),
            contentType: "html",
          },
          bodyPreview: "Visible sentence",
        }),
      );

      expect(email.bodyPlain).toContain("Visible sentence");
      expect(email.bodyPlain).not.toContain("doNotIndexMe");
    });
  });

  // -------------------------------------------------------------------------
  // THE CONSEQUENCE. Nothing in the repo covered this before BACKLOG-2855.
  // -------------------------------------------------------------------------
  describe("consequence: search finds a term past the preview cutoff", () => {
    const TXN = "11111111-1111-4111-8111-111111111111";
    const OUTLOOK_EMAIL_ID = "email-outlook-html";
    const DECOY_EMAIL_ID = "email-decoy";

    let db: DatabaseType;

    /**
     * Column subset sufficient for `buildEmailQuery`, transcribed from
     * `electron/database/schema.sql`. The `attachments` table is required even
     * though it stays empty: the query's EXISTS clause and its matched-filename
     * projection both reference it, so without it every search throws.
     */
    function createSchema(database: DatabaseType): void {
      database.exec(`
        CREATE TABLE emails (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          subject TEXT,
          body_plain TEXT,
          body_html TEXT,
          sender TEXT,
          recipients TEXT,
          sent_at DATETIME
        );
        CREATE TABLE communications (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          transaction_id TEXT,
          message_id TEXT,
          email_id TEXT,
          thread_id TEXT
        );
        CREATE TABLE attachments (
          id TEXT PRIMARY KEY,
          message_id TEXT,
          email_id TEXT,
          external_message_id TEXT,
          filename TEXT NOT NULL
        );
      `);
    }

    /** Run the PRODUCTION search query and return the matched email ids. */
    function searchIds(term: string): string[] {
      const built = buildEmailQuery(TXN, term, 20);
      const rows = db.prepare(built.sql).all(...built.params) as { id: string }[];
      return rows.map((r) => r.id).sort();
    }

    beforeEach(async () => {
      db = new Database(":memory:");
      createSchema(db);

      // The email under test is stored EXACTLY as production stores it: the
      // mapper's own output, not a hand-written string. That is what makes
      // reverting the mapper redden this test.
      const mapped = await mapViaService(
        graphMessage({
          id: "graph-msg-1",
          body: { content: LONG_BODY_HTML, contentType: "html" },
          bodyPreview: LONG_BODY_PREVIEW,
        }),
      );

      db.prepare(
        `INSERT INTO emails (id, user_id, subject, body_plain, body_html, sender, recipients, sent_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        OUTLOOK_EMAIL_ID,
        USER_ID,
        mapped.subject ?? "",
        mapped.bodyPlain,
        mapped.body,
        "alex@contoso.com",
        "dana@contoso.com",
        "2024-01-15T09:59:00Z",
      );

      // A second linked email that must NOT match, so the assertions below are
      // about identity and not about "the query returned something".
      db.prepare(
        `INSERT INTO emails (id, user_id, subject, body_plain, body_html, sender, recipients, sent_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        DECOY_EMAIL_ID,
        USER_ID,
        "Unrelated thread",
        "This message is about the quarterly newsletter archive and nothing else.",
        "<p>This message is about the quarterly newsletter archive and nothing else.</p>",
        "someone@example.com",
        "dana@contoso.com",
        "2024-01-14T09:00:00Z",
      );

      for (const [id, emailId] of [
        ["comm-1", OUTLOOK_EMAIL_ID],
        ["comm-2", DECOY_EMAIL_ID],
      ]) {
        db.prepare(
          `INSERT INTO communications (id, user_id, transaction_id, email_id)
           VALUES (?, ?, ?, ?)`,
        ).run(id, USER_ID, TXN, emailId);
      }
    });

    afterEach(() => {
      db.close();
    });

    it("stores the derived text, not the preview", () => {
      const stored = db
        .prepare("SELECT body_plain AS bodyPlain FROM emails WHERE id = ?")
        .get(OUTLOOK_EMAIL_ID) as { bodyPlain: string };

      expect(stored.bodyPlain).toContain(SENTINEL);
      expect(stored.bodyPlain).not.toBe(LONG_BODY_PREVIEW);
    });

    it("FINDS the email by a term that appears ONLY past the preview cutoff", () => {
      // This is the whole item. Before the fix, `body_plain` held the 255-char
      // preview and this returned []. No error, no warning — just no result.
      expect(searchIds(SENTINEL)).toEqual([OUTLOOK_EMAIL_ID]);
    });

    it("still finds the email by a term INSIDE the preview", () => {
      // Guards against a fix that trades one truncation for another.
      expect(searchIds(EARLY_TERM)).toEqual([OUTLOOK_EMAIL_ID]);
    });

    it("discriminates between the two linked emails", () => {
      // Asserted in BOTH directions, so a query that simply returned every
      // linked row could not pass.
      expect(searchIds(SENTINEL)).not.toContain(DECOY_EMAIL_ID);
      expect(searchIds("quarterly newsletter")).toEqual([DECOY_EMAIL_ID]);
    });

    it("does not make Outlook's CSS boilerplate searchable", () => {
      // If <style> contents reached body_plain, EVERY Outlook email in the
      // database would match this term.
      expect(searchIds("margin-top")).toEqual([]);
      expect(searchIds("Calibri")).toEqual([]);
    });
  });
});
