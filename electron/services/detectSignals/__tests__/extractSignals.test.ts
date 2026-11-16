/**
 * BACKLOG-4257 (M3) PR1 — per-email signal extraction, controls C1–C5.
 * Synthetic fixtures only (fixtures.ts).
 */
import { extractEmailSignals } from "../extractSignals";
import { canonicalizeEmail } from "../canonicalText";
import { hasWholeWord } from "../wholeWord";
import { matchForms } from "../../formRecognition/formMatcher";
import { DEFAULT_REGISTRY } from "../../formRecognition/registry";
import { S7_FORM_21, fixtureText } from "../../formRecognition/__tests__/fixtures/nwmlsHeaders";
import type { EmailSignals, EmailSignalInput } from "../types";
import {
  ALL_FIXTURES,
  C3_CITE,
  C3_GMAIL_NON_ENGLISH,
  C3_OUTLOOK,
  C4_POSITIVE,
  C4_TRAPS,
  CTX,
  DEAL_BODY_TOP,
  DEAL_CONTACT,
  DEAL_SUBJECT,
  LENDER_CONTACT,
  NEWSLETTER,
  PLAIN_QUOTED,
  SIGNATURE,
} from "./fixtures";

const run = (input: EmailSignalInput) => extractEmailSignals(input, CTX);
const sig = (input: EmailSignalInput) => run(input).signals;

const FORM_EMAIL: EmailSignalInput = {
  subject: "Paperwork",
  bodyHtml: null,
  bodyPlain: "See attached.",
  sender: DEAL_CONTACT,
  attachments: [
    { filename: "Form 21 Purchase and Sale.pdf", textContent: fixtureText(S7_FORM_21) },
    { filename: "photo.jpg", textContent: null },
  ],
};

describe("C1 — newsletter footer address", () => {
  it("places the address in the footer, next to a footer cue", () => {
    const s = sig(NEWSLETTER);
    expect(s.anchor).toEqual({ count: 1, placement: "footer", nearFooterCue: true, inQuoteOnly: false });
  });
});

describe("C2 — signature block", () => {
  it("places the brokerage address after the signature separator", () => {
    const s = sig(SIGNATURE);
    expect(s.anchor.placement).toBe("afterSignature");
    expect(s.anchor.count).toBe(1);
    expect(s.anchor.nearFooterCue).toBe(false);
  });

  it("a sign-off line also starts the signature", () => {
    const s = sig({ ...SIGNATURE, bodyPlain: (SIGNATURE.bodyPlain as string).replace("-- ", "Best regards,") });
    expect(s.anchor.placement).toBe("afterSignature");
  });
});

describe("anchor placement — positives", () => {
  it("subject outranks the body", () => {
    expect(sig(DEAL_SUBJECT).anchor).toEqual({ count: 1, placement: "subject", nearFooterCue: false, inQuoteOnly: false });
  });

  it("an address in the first lines is bodyTop", () => {
    expect(sig(DEAL_BODY_TOP).anchor.placement).toBe("bodyTop");
  });

  it("no address anywhere is none", () => {
    expect(sig(C4_TRAPS).anchor).toEqual({ count: 0, placement: "none", nearFooterCue: false, inQuoteOnly: false });
  });

  it("an address only in quoted lines is inQuoteOnly, not counted", () => {
    expect(sig(PLAIN_QUOTED).anchor).toEqual({ count: 0, placement: "none", nearFooterCue: false, inQuoteOnly: true });
  });

  it("address keys come back beside the record, not inside it", () => {
    const r = run(DEAL_SUBJECT);
    expect(r.addressKeys).toHaveLength(1);
    expect(JSON.stringify(r.signals)).not.toContain(r.addressKeys[0]);
  });
});

describe("C3 — a stage word only in the quoted reply does not fire", () => {
  it.each([
    ["Outlook divRplyFwdMsg", C3_OUTLOOK, "underContract"],
    ["blockquote type=cite", C3_CITE, "counter"],
    ["gmail_quote with a non-English attribution", C3_GMAIL_NON_ENGLISH, "appraisal"],
  ] as const)("%s", (_name, input, stage) => {
    // The stage word IS in the message: the full text (quotes kept) carries it.
    expect(canonicalizeEmail(input).fullLines.join("\n")).toMatch(
      stage === "underContract" ? /under contract/ : new RegExp(stage),
    );
    const s = sig(input);
    expect(s.stage[stage]).toBe(false);
    expect(s.stage.ownTextOnly).toBe(false);
  });

  it("plain '>' quoted lines do not fire either", () => {
    const s = sig(PLAIN_QUOTED);
    expect(s.stage.inspection).toBe(false);
    expect(s.stage.ownTextOnly).toBe(false);
  });
});

describe("C4 — stage terms are whole words", () => {
  it("countertop(s), encountered, offering(s), enclosing fire nothing", () => {
    const s = sig(C4_TRAPS);
    expect(s.stage).toEqual({
      offer: false,
      counter: false,
      underContract: false,
      inspection: false,
      appraisal: false,
      closing: false,
      inSubject: false,
      ownTextOnly: true,
    });
  });

  it("minimal pair: the same stages as whole words fire", () => {
    const s = sig(C4_POSITIVE);
    expect(s.stage).toMatchObject({ offer: true, counter: true, inspection: true, appraisal: true, closing: true });
    expect(s.stage.inSubject).toBe(false);
  });

  it("hasWholeWord: trap words vs whole words", () => {
    expect(hasWholeWord("new countertops", "counter")).toBe(false);
    expect(hasWholeWord("we encountered", "counter")).toBe(false);
    expect(hasWholeWord("our offerings", "offer")).toBe(false);
    expect(hasWholeWord("enclosing it", "closing")).toBe(false);
    expect(hasWholeWord("a counter-offer", "counter offer")).toBe(true);
    expect(hasWholeWord("©2026 acme", "©")).toBe(true);
  });

  it("a stage in the subject sets inSubject", () => {
    expect(sig(DEAL_SUBJECT).stage).toMatchObject({ offer: true, inSubject: true, ownTextOnly: true });
  });
});

describe("sender", () => {
  const tierOf = (sender: string) => sig({ ...C4_TRAPS, sender }).sender.tier;

  it("tiers in precedence order", () => {
    expect(tierOf(`Pat <${DEAL_CONTACT}>`)).toBe("dealContact");
    expect(tierOf(LENDER_CONTACT)).toBe("dealContact");
    expect(tierOf("other@lender.example")).toBe("vendorRoleDomain");
    expect(tierOf("other@buyers.example")).toBe("dealContactDomain");
    expect(tierOf("dse@docusign.net")).toBe("platform");
    expect(tierOf("stranger@freemail.test")).toBe("freeMail");
    expect(tierOf("x@unrelated.test")).toBe("other");
    // a free-mail contact's domain never becomes a deal-contact domain (K3)
    expect(CTX.keep.contactDomains.has("freemail.test")).toBe(false);
    expect(tierOf("")).toBe("other");
  });

  it("bulk headers and deal-contact recipients", () => {
    expect(sig(NEWSLETTER).sender).toEqual({ tier: "other", recipientIsDealContact: false, bulk: true });
    expect(sig(SIGNATURE).sender).toEqual({ tier: "other", recipientIsDealContact: true, bulk: false });
  });
});

describe("forms", () => {
  it("matches forms in attachment text and classifies filenames", () => {
    const f = sig(FORM_EMAIL).forms;
    expect(f).toEqual({
      attachments: 2,
      attachmentsWithText: 1,
      matches: [{ formId: "nwmls-21", kind: "purchase_agreement", occurrences: 6 }],
      filenameClass: "purchaseAgreement",
    });
  });

  it("no attachments", () => {
    expect(sig(C4_TRAPS).forms).toEqual({ attachments: 0, attachmentsWithText: 0, matches: [], filenameClass: "none" });
  });

  it("unmatched filenames are other", () => {
    const f = sig({ ...C4_TRAPS, attachments: [{ filename: "IMG_0001.jpg", textContent: null }] }).forms;
    expect(f.filenameClass).toBe("other");
  });
});

// ---------------------------------------------------------------------------
// C5 — leak
// ---------------------------------------------------------------------------

type Equal<A, B> = (<G>() => G extends A ? 1 : 2) extends <G>() => G extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;
/** Paths in T whose type is the wide `string` (a free string). */
type FreeStringPaths<T, P extends string = ""> = T extends string
  ? string extends T
    ? P
    : never
  : T extends readonly (infer U)[]
    ? FreeStringPaths<U, `${P}[]`>
    : T extends object
      ? { [K in keyof T & string]: FreeStringPaths<T[K], `${P}.${K}`> }[keyof T & string]
      : never;

// The only free string is the registry id; the runtime test below pins every emitted id to the registry.
export type C5TypeCheck = Expect<Equal<FreeStringPaths<EmailSignals>, ".forms.matches[].formId">>;

describe("C5 — the record carries no addresses, subjects or document text", () => {
  const records = { ...ALL_FIXTURES, FORM_EMAIL };
  const registryIds = new Set<string>([
    ...[...DEFAULT_REGISTRY.byCode.values()].map((r) => r.id),
    ...[...DEFAULT_REGISTRY.byTitle.values()].flat().map((r) => r.id),
  ]);
  const evidence = matchForms(fixtureText(S7_FORM_21)).map((m) => m.evidence);

  it.each(Object.entries(records))("%s", (_name, input) => {
    const r = run(input);
    const json = JSON.stringify(r.signals);
    expect(json).not.toContain("@");
    expect(json).not.toMatch(/\b\d{2,}\s+[a-z]+/i); // no street-shaped text
    for (const key of r.addressKeys) expect(json).not.toContain(key);
    const subject = (input.subject ?? "").toLowerCase();
    if (subject) expect(json.toLowerCase()).not.toContain(subject);
    for (const ev of evidence) expect(json).not.toContain(ev.slice(0, 40));
    expect(json).not.toContain("evidence");
    for (const m of r.signals.forms.matches) {
      expect(Object.keys(m).sort()).toEqual(["formId", "kind", "occurrences"]);
      expect(registryIds.has(m.formId)).toBe(true);
    }
  });

  it("the form fixture actually produced a match (anti-vacuity)", () => {
    expect(run(FORM_EMAIL).signals.forms.matches.length).toBeGreaterThan(0);
    expect(evidence.length).toBeGreaterThan(0);
  });
});
