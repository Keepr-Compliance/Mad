/**
 * Synthetic fixtures for BACKLOG-4257 detectSignals tests. Invented streets,
 * .example / .test domains only. No real mailbox content.
 */
import { BUNDLED_SENDER_RULES } from "../../../utils/senderFilter/bundledRules";
import { buildKeepSets } from "../../../utils/senderFilter/senderFilter";
import type { EmailSignalInput, SignalContext } from "../types";

export const DEAL_CONTACT = "pat.buyer@buyers.example";
export const LENDER_CONTACT = "loans@lender.example";

/** The bundled rules plus one reserved test domain treated as free mail. */
const RULES = { ...BUNDLED_SENDER_RULES, freeMailDomains: [...BUNDLED_SENDER_RULES.freeMailDomains, "freemail.test"] };

export const CTX: SignalContext = {
  rules: RULES,
  keep: buildKeepSets([DEAL_CONTACT, LENDER_CONTACT, "someone@freemail.test"], RULES),
  vendorRoleDomains: new Set(["lender.example"]),
};

const p = (lines: string[]) => lines.map((l) => `<p>${l}</p>`).join("\n");

/** C1: a newsletter whose only address is the sender's postal address in the footer. */
export const NEWSLETTER: EmailSignalInput = {
  subject: "This week in the market",
  bodyHtml: `<html><body>${p([
    "Hello neighbor,",
    "Rates moved again this week and inventory is up.",
    "Here are five tips for spring cleaning.",
    "Our team hosted a community event downtown.",
    "Read our latest blog post about staging.",
    "Thinking of moving? Get a free market report.",
    "Follow us for more updates.",
    "Acme Realty Newsletter",
    "4821 Lantern Grove Way, Brindleford, ZZ 99001",
    "Unsubscribe | Privacy Policy",
    "© 2026 Acme Realty. All rights reserved.",
  ])}</body></html>`,
  bodyPlain: null,
  sender: "news@acme-realty.example",
  recipients: "me@agent.example",
  bulkMailHeaders: JSON.stringify({ list_unsubscribe: "<mailto:u@acme-realty.example>" }),
};

/** C2: an agent's message whose only address is the brokerage address in the signature. */
export const SIGNATURE: EmailSignalInput = {
  subject: "Documents",
  bodyHtml: null,
  bodyPlain: [
    "Hi Sam,",
    "",
    "The buyers are reviewing the documents today.",
    "I will follow up tomorrow.",
    "",
    "-- ",
    "Jordan Testagent",
    "Example Realty Group",
    "77 Quillfeather Court",
    "Marbleton, ZZ 99002",
  ].join("\n"),
  sender: "jordan@realty.example",
  recipients: DEAL_CONTACT,
};

/** A deal message: address in the subject and at the top of the body. */
export const DEAL_SUBJECT: EmailSignalInput = {
  subject: "Offer on 512 Wobbleberry Lane, Testville, ZZ 99003",
  bodyHtml: null,
  bodyPlain: "Attached is our offer on 512 Wobbleberry Lane, Testville, ZZ 99003.\nPlease confirm receipt.",
  sender: DEAL_CONTACT,
  recipients: "me@agent.example",
};

/** Address only at the top of the body. */
export const DEAL_BODY_TOP: EmailSignalInput = {
  subject: "Quick question",
  bodyHtml: null,
  bodyPlain: [
    "Can we see 908 Marigold Drive, Testville, ZZ 99004 on Saturday?",
    "My clients are flexible on time.",
    "They liked the photos.",
    "Thanks for checking.",
  ].join("\n"),
  sender: "friend@freemail.test",
};

/** C3 (a): Outlook reply — the stage word is only below divRplyFwdMsg. */
export const C3_OUTLOOK: EmailSignalInput = {
  subject: "RE: Next steps",
  bodyHtml:
    '<html><body><div>Thanks, see you Monday.</div>' +
    '<hr tabindex="-1" style="display:inline-block;width:98%">' +
    '<div id="divRplyFwdMsg" dir="ltr"><b>From:</b> Alex Example<br><b>Sent:</b> Monday<br><b>Subject:</b> Next steps</div>' +
    "<div>Good news: we are now under contract on the home.</div></body></html>",
  bodyPlain: null,
  sender: "alex@realty.example",
};

/** C3 (b): a generic reply — the stage word is only inside blockquote type=cite, no attribution line. */
export const C3_CITE: EmailSignalInput = {
  subject: "Re: Response",
  bodyHtml:
    "<html><body><div>Sounds good to me.</div>" +
    '<blockquote type="cite"><div>The sellers sent a counter this morning.</div></blockquote></body></html>',
  bodyPlain: null,
  sender: "alex@realty.example",
};

/** C3 (c): a Gmail reply whose attribution line is not English "On ... wrote:". */
export const C3_GMAIL_NON_ENGLISH: EmailSignalInput = {
  subject: "Re: Valor",
  bodyHtml:
    '<html><body><div dir="ltr">Perfecto, gracias.</div>' +
    '<div class="gmail_quote"><div dir="ltr" class="gmail_attr">El lun, 5 ene 2026 a las 9:00, Alex escribió:</div>' +
    '<blockquote class="gmail_quote" style="margin:0 0 0 .8ex">The appraisal came in at value.</blockquote></div></body></html>',
  bodyPlain: null,
  sender: "alex@realty.example",
};

/** Plain-text reply: an address and a stage word only in '>' lines. */
export const PLAIN_QUOTED: EmailSignalInput = {
  subject: "Re: hello",
  bodyHtml: null,
  bodyPlain: [
    "Got it, thanks.",
    "",
    "> The inspection for 330 Dandelion Road, Testville, ZZ 99005 is booked.",
  ].join("\n"),
  sender: "alex@realty.example",
};

/** C4: stage words only as parts of longer words. */
export const C4_TRAPS: EmailSignalInput = {
  subject: "Kitchen update",
  bodyHtml: null,
  bodyPlain:
    "We replaced the countertops and encountered no issues with the countertop install.\n" +
    "New offerings arrive next week; one offering is a sink.\n" +
    "I am enclosing the brochure.",
  sender: "contractor@builder.example",
};

/** C4 minimal pair: the same stages as whole words. */
export const C4_POSITIVE: EmailSignalInput = {
  subject: "Status",
  bodyHtml: null,
  bodyPlain:
    "We received an offer.\nThey sent a counter offer.\nThe inspection and appraisal are scheduled.\nClosing is Friday.",
  sender: "contractor@builder.example",
};

export const ALL_FIXTURES: Record<string, EmailSignalInput> = {
  NEWSLETTER,
  SIGNATURE,
  DEAL_SUBJECT,
  DEAL_BODY_TOP,
  C3_OUTLOOK,
  C3_CITE,
  C3_GMAIL_NON_ENGLISH,
  PLAIN_QUOTED,
  C4_TRAPS,
  C4_POSITIVE,
};
