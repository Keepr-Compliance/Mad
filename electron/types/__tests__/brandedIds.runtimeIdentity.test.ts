/**
 * BACKLOG-3067 — control 4. The brand is erased; prove it.
 *
 * Everything else in this item is checked by the compiler, which is exactly why
 * this suite has to exist. If a brand changed anything at runtime — wrapped the
 * value, boxed it, made it a non-primitive, broke `===` against the string it came
 * from — the app would break in ways `tsc` cannot see: ids are compared, used as
 * object and `Map` keys, serialised to the renderer over IPC, written into SQLite,
 * and logged. Every one of those is an identity operation on a primitive string.
 *
 * `CommunicationId = string & { readonly __brand: "CommunicationId" }` is an
 * intersection with a type that has no runtime existence, and `asCommunicationId`
 * is `(id) => id as CommunicationId` — a cast, which emits nothing. So the
 * expected answer to every assertion below is "identical to the raw string". These
 * assertions are cheap and they are the difference between believing that and
 * having checked it.
 */
import { randomUUID } from "crypto";
import {
  asCommunicationId,
  asEmailId,
  asTransactionId,
  type CommunicationId,
} from "../ids";

/**
 * GENERATED, never a literal. A uuid has no shape that separates an invented id
 * from a live customer's, so the repo's fixture-PII gate refuses bare uuids on
 * added lines (BACKLOG-2871: a real `organization_id` reached this PUBLIC repo
 * inside a comment, and that object is still fetchable by SHA). Generating it is
 * also the better test: every assertion below is value-independent, so they now
 * hold for an ARBITRARY id rather than one hand-picked string — and `randomUUID`
 * is what `createCommunication` itself uses to mint a real one.
 */
const RAW = randomUUID();

describe("BACKLOG-3067 — a branded id IS the string it came from", () => {
  it("returns the same value, by reference", () => {
    const branded = asCommunicationId(RAW);

    expect(branded).toBe(RAW);
    expect(Object.is(branded, RAW)).toBe(true);
    expect(branded === RAW).toBe(true);
  });

  it("is a primitive string, not an object", () => {
    const branded = asCommunicationId(RAW);

    expect(typeof branded).toBe("string");
    // Widened to `unknown` first, with no cast: `instanceof` rejects an operand of
    // this type outright (TS2358, because a branded id is a primitive-intersection,
    // not an object type). Worth keeping rather than dropping — a boxed `String`
    // would satisfy `==` against the raw value and fail `===`, and `===` on ids is
    // what every Map lookup, dedup and exclusion check in the app runs on.
    const widened: unknown = branded;
    expect(widened instanceof String).toBe(false);
    expect(Object.prototype.toString.call(branded)).toBe("[object String]");
  });

  it("carries no runtime brand property", () => {
    const branded = asCommunicationId(RAW);

    // The property exists only in the type. Reading it at runtime yields undefined,
    // and nothing in the codebase may depend on it being there.
    expect((branded as unknown as Record<string, unknown>).__brand).toBeUndefined();
    expect(Object.keys(branded)).toEqual(Object.keys(RAW));
  });

  it("survives JSON round-tripping — this is how ids reach the renderer", () => {
    const branded = asCommunicationId(RAW);
    const roundTripped = JSON.parse(JSON.stringify({ id: branded })) as { id: string };

    expect(roundTripped.id).toBe(RAW);
    expect(JSON.stringify(branded)).toBe(JSON.stringify(RAW));
  });

  it("works as an object key, a Map key and a Set member", () => {
    const branded = asCommunicationId(RAW);

    const record: Record<string, number> = { [branded]: 1 };
    expect(record[RAW]).toBe(1);

    const map = new Map<CommunicationId, number>([[branded, 1]]);
    // Looked up with the RAW string, through a differently-typed handle: the two
    // must be the same key, or every id-keyed lookup in the app silently misses.
    expect(map.get(RAW as CommunicationId)).toBe(1);

    const set = new Set<string>([branded]);
    expect(set.has(RAW)).toBe(true);
  });

  it("behaves as a string in every ordinary operation", () => {
    const branded = asCommunicationId(RAW);

    expect(branded.length).toBe(RAW.length);
    expect(branded.toUpperCase()).toBe(RAW.toUpperCase());
    expect(`id=${branded}`).toBe(`id=${RAW}`);
    expect(branded + "!").toBe(RAW + "!");
    expect([RAW].includes(branded)).toBe(true);
    expect([branded].join(",")).toBe(RAW);
  });

  it("keeps ids of DIFFERENT kinds equal at runtime when the strings are equal", () => {
    // The brands separate them at compile time and NOWHERE ELSE. Anyone reasoning
    // about runtime behaviour has to know the two are indistinguishable once the
    // program is running — which is precisely why BACKLOG-2829 was not observable
    // at runtime either, and had to be caught by the compiler.
    const asComm = asCommunicationId(RAW);
    const asEmail = asEmailId(RAW);
    const asTx = asTransactionId(RAW);

    expect(asComm).toBe(asEmail);
    expect(asEmail).toBe(asTx);
    expect(new Set<string>([asComm, asEmail, asTx]).size).toBe(1);
  });
});
