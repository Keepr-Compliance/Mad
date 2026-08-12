/** @jest-environment node */
/**
 * The consent screen describes what is actually collected (BACKLOG-2428)
 *
 * The disclosure is the only protection a user has here: PII scrubbing is
 * deferred by an explicit founder decision, so what the screen says is the
 * whole of the promise. That makes it worth testing in both directions.
 *
 * **Over-stating is not the safe direction.** v2 said the report carries "the
 * names, phone numbers and email addresses of your contacts" and warned about
 * "people who are not Keepr users — your clients and their phone numbers".
 * Exactly one thing made that true: a "contact-trace" scope whose producer
 * dumped up to 200 raw unresolved handles. It never worked — there was no
 * contact picker anywhere in the app, so nobody could name the individual —
 * and it was never asked for. It is gone. A disclosure that keeps warning
 * about it is asking people to consent to something that does not happen,
 * which teaches them to discount the parts that are accurate.
 *
 * **Under-stating is not safe either**, so the one route that genuinely
 * remains is asserted to still be disclosed: `collectDiagnostics()` carries
 * the last ten `failure_log` rows with `error_message` verbatim, unsanitised.
 */

import { createHash } from "crypto";
import {
  SUPPORT_ACCESS_DISCLOSURE_ID,
  SUPPORT_ACCESS_DISCLOSURE_TEXT,
  currentDisclosure,
  currentDisclosureHash,
  hashDisclosure,
} from "../disclosure";
import {
  SUPPORT_LOG_SCOPES,
  SUPPORT_LOG_SCOPE_DETAILS,
  DEFAULT_SUPPORT_LOG_SCOPES,
  normaliseScopes,
} from "../scopes";

describe("support access disclosure", () => {
  describe("the attested hash", () => {
    it("is the sha256 of the text that is actually shipped", () => {
      // Recomputed here rather than read from the module, so an edit to the
      // text that forgot to change anything else still has to survive this.
      const independent = createHash("sha256")
        .update(SUPPORT_ACCESS_DISCLOSURE_TEXT, "utf8")
        .digest("hex");

      expect(currentDisclosureHash()).toBe(independent);
      expect(currentDisclosure().hash).toBe(independent);
      expect(currentDisclosure().text).toBe(SUPPORT_ACCESS_DISCLOSURE_TEXT);
    });

    it("changes when a single character of the wording changes", () => {
      // The property the consent record depends on: a grant made today stays
      // interpretable after the text is rewritten, because the hash pins which
      // wording it was.
      expect(hashDisclosure(`${SUPPORT_ACCESS_DISCLOSURE_TEXT} `)).not.toBe(
        currentDisclosureHash(),
      );
    });

    it("carries the version the wording was bumped to", () => {
      expect(SUPPORT_ACCESS_DISCLOSURE_ID).toBe("support-access-disclosure-v3");
      expect(currentDisclosure().id).toBe(SUPPORT_ACCESS_DISCLOSURE_ID);
    });
  });

  describe("what the wording claims", () => {
    it("no longer claims a contact's details are traced or exported", () => {
      const text = SUPPORT_ACCESS_DISCLOSURE_TEXT.toLowerCase();

      // The v2 sentences, verbatim. Each was true only because of the removed
      // scope.
      expect(text).not.toContain(
        "the names, phone numbers and email addresses of your contacts",
      );
      expect(text).not.toContain("people who are not keepr users");
      expect(text).not.toContain("your clients and their phone numbers");

      // And the claim itself, however it might be re-phrased.
      expect(text).not.toMatch(/follows? (one|a) (named|specific) contact/);
      expect(text).not.toMatch(/through every stage/);
    });

    it("still discloses the one route by which a name can reach a report", () => {
      // `collectDiagnostics()` copies failure_log rows in with their raw
      // error_message. Nothing sanitises them, so this must stay disclosed.
      const text = SUPPORT_ACCESS_DISCLOSURE_TEXT.toLowerCase();
      expect(text).toContain("error messages");
      expect(text).toMatch(/can mention a name/);
    });

    it("still says what is never sent, and how long anything lasts", () => {
      const text = SUPPORT_ACCESS_DISCLOSURE_TEXT.toLowerCase();
      expect(text).toContain("what does not get sent");
      expect(text).toContain("contents of your messages and emails");
      expect(text).toContain("encrypted");
      expect(text).toContain("30 days");
      expect(text).toContain("ends by itself");
    });
  });

  describe("the scope catalogue behind it", () => {
    it("no longer offers the contact-trace scope", () => {
      expect([...SUPPORT_LOG_SCOPES]).toEqual([
        "message-import",
        "contact-resolution",
        "email-sync",
        "transaction-linking",
      ]);
      expect(SUPPORT_LOG_SCOPE_DETAILS).not.toHaveProperty("contact-trace");
    });

    it("drops contact-trace off the wire rather than trusting it", () => {
      // A stale renderer, or a hand-edited state file, must not be able to
      // re-enable a scope that no longer exists.
      expect(normaliseScopes(["contact-trace", "email-sync"])).toEqual([
        "email-sync",
      ]);
      expect(normaliseScopes(["contact-trace"])).toEqual([]);
    });

    it("offers every remaining scope by default, and describes none as naming a person", () => {
      expect([...DEFAULT_SUPPORT_LOG_SCOPES].sort()).toEqual(
        [...SUPPORT_LOG_SCOPES].sort(),
      );

      for (const scope of SUPPORT_LOG_SCOPES) {
        const detail = SUPPORT_LOG_SCOPE_DETAILS[scope];
        expect(detail).toBeDefined();
        // The "identifying" flag is gone with the only scope that set it; a
        // description that still promised a person's details would be the same
        // false claim wearing different clothes.
        expect(detail).not.toHaveProperty("identifying");
        expect(detail.description.toLowerCase()).not.toMatch(
          /name, phone number and email address/,
        );
      }
    });
  });
});
