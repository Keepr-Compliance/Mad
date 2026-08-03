/** @jest-environment node */
/**
 * Upgrading over a live v2 grant (BACKLOG-2428)
 *
 * BACKLOG-2428 removes a scope and BACKLOG-2430's PR bumps the disclosure to
 * v3. Both change how a *previously written* `state.json` is interpreted, and
 * the normalisation that handles it had been read but never executed — no test
 * started from a real on-disk prior-version file.
 *
 * That is the BACKLOG-2298 lesson exactly: a change that passes every suite
 * because every suite starts at HEAD, and breaks on a real upgrade. So these
 * start from bytes on disk that the *previous* build would have written, and
 * drive the real `load()`.
 *
 * The properties that matter on an upgrade:
 *  - an open window stays open — the deadline is an absolute instant, and a
 *    version bump is not a reason to revoke someone's grant
 *  - the removed scope is stripped, so nothing collects under it
 *  - the v2 consent record keeps its v2 wording verbatim; it has to attest what
 *    that person actually read, not what this build ships
 */

import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import { SupportAccessService } from "../supportAccessService";
import { SUPPORT_ACCESS_DISCLOSURE_ID } from "../disclosure";

const T0 = Date.parse("2026-08-02T09:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

/** The exact wording v2 shipped, including the two sentences v3 removed. */
const V2_TEXT = [
  "While support access is on, Keepr collects extra detail about what the app is doing on this Mac and sends it to Keepr support.",
  "",
  "• The names, phone numbers and email addresses of your contacts, as they appear in the app.",
  "",
  "This includes information about people who are not Keepr users — your clients and their phone numbers.",
].join("\n");

describe("upgrading over a v2 support-access grant", () => {
  let baseDir: string;
  let now: number;

  /** Write the file the previous build would have left behind. */
  async function writeV2State(scopes: string[]): Promise<void> {
    await fs.mkdir(baseDir, { recursive: true });
    await fs.writeFile(
      path.join(baseDir, "state.json"),
      JSON.stringify(
        {
          version: 1,
          current: {
            id: "v2-grant",
            grantedAt: new Date(T0).toISOString(),
            expiresAt: new Date(T0 + 7 * DAY).toISOString(),
            durationId: "7d",
            appVersion: "2.26.0",
            disclosureId: "support-access-disclosure-v2",
            disclosureHash: "a".repeat(64),
            disclosureText: V2_TEXT,
            scopes,
          },
          history: [],
        },
        null,
        2,
      ),
      "utf8",
    );
  }

  const makeService = () =>
    new SupportAccessService({
      now: () => now,
      baseDir,
      appVersion: () => "2.27.0",
    });

  beforeEach(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "keepr-support-v2-"));
    now = T0 + DAY; // one day into a seven-day window
  });

  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it("keeps an open window open across the upgrade", async () => {
    await writeV2State([
      "message-import",
      "contact-resolution",
      "contact-trace",
    ]);

    const access = makeService();
    await access.load();

    // Six days left. Closing it because the app updated would be a silent
    // revocation the user never asked for.
    expect(access.isActive()).toBe(true);
    expect(access.msRemaining()).toBe(6 * DAY);
    expect(await access.reconcile()).toBe(false);
  });

  it("strips the removed scope but keeps the rest", async () => {
    await writeV2State([
      "message-import",
      "contact-resolution",
      "contact-trace",
    ]);

    const access = makeService();
    await access.load();

    expect(access.activeScopes()).toEqual([
      "message-import",
      "contact-resolution",
    ]);
    // The point of the removal: nothing can collect under it any more, even
    // though this user did tick it.
    expect(access.isScopeActive("contact-trace" as never)).toBe(false);
    expect(access.isScopeActive("contact-resolution")).toBe(true);
  });

  it("keeps the v2 wording verbatim on the v2 record", async () => {
    await writeV2State(["message-import"]);

    const access = makeService();
    await access.load();

    const consent = access.getConsentRecord();
    // The record has to answer "what did this person actually see?". Rewriting
    // it to the shipped v3 text would destroy the only evidence of that.
    expect(consent?.disclosureId).toBe("support-access-disclosure-v2");
    expect(consent?.disclosureId).not.toBe(SUPPORT_ACCESS_DISCLOSURE_ID);
    expect(consent?.disclosureText).toBe(V2_TEXT);
    expect(consent?.disclosureText).toContain(
      "The names, phone numbers and email addresses of your contacts",
    );
  });

  it("collects strictly less than the v2 grant authorised", async () => {
    // The direction that matters for consent: an upgrade must never widen what
    // is collected beyond what the person agreed to. v2 promised more than v3
    // collects, so every surviving scope was already covered by their consent.
    await writeV2State([
      "message-import",
      "contact-resolution",
      "email-sync",
      "transaction-linking",
      "contact-trace",
    ]);

    const access = makeService();
    await access.load();

    const granted = new Set(["message-import", "contact-resolution", "email-sync", "transaction-linking", "contact-trace"]);
    for (const scope of access.activeScopes()) {
      expect(granted.has(scope)).toBe(true);
    }
    expect(access.activeScopes()).not.toContain("contact-trace");
  });

  /**
   * The edge this suite exists to surface.
   *
   * `contact-trace` was off by default, so reaching this needed someone to
   * untick all four defaults and tick only that one. After the upgrade their
   * scope list normalises to empty — and `isActive()` keys on `expiresAt`, not
   * on scopes, so the window stays open while collecting nothing.
   *
   * Asserted as the behaviour that actually occurs rather than the behaviour
   * that ought to: `grant()` refuses zero scopes (`:310-315`) but `load()` has
   * no equivalent, and changing that would alter how real persisted grants are
   * treated — a decision with a consent dimension, not a test fix. Reported
   * rather than quietly changed. It fails safe (nothing is recorded) but the
   * panel would say the app is collecting from "0 areas".
   */
  it("leaves a contact-trace-only grant open but collecting nothing", async () => {
    await writeV2State(["contact-trace"]);

    const access = makeService();
    await access.load();

    expect(access.activeScopes()).toEqual([]);
    expect(access.isActive()).toBe(true);
    expect(access.getState().consent?.scopes).toEqual([]);
  });

  it("survives a state file that a previous build never wrote at all", async () => {
    // The other upgrade path: no file. Must start closed, not throw.
    const access = makeService();
    await access.load();

    expect(access.isActive()).toBe(false);
    expect(access.getState().everGranted).toBe(false);
  });
});
