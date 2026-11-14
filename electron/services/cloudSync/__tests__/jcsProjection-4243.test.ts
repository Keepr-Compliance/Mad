/**
 * @jest-environment node
 *
 * BACKLOG-4243 PR-2 — content hash and deal projection.
 * Vectors: scratchpad/4236/prebuild.md §(b) "Worked examples" (canonical text
 * and sha256 transcribed verbatim). Shape: supabase/contracts/cloud-deal-shape-v1.json.
 */
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { contentHash, jcs, sha256Hex, type JsonValue } from "../jcs";
import {
  buildDealDto,
  calendarDateInstant,
  cleanText,
  DEAL_HASHED_FIELDS,
  DEAL_SOURCE_COLUMNS,
  projectDeal,
  type DealRow,
} from "../projection";

const CONTRACT = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "..", "..", "..", "supabase", "contracts", "cloud-deal-shape-v1.json"), "utf8"),
);

// prebuild.md §(b): [canonical text, sha256]. The objects are re-parsed from the text.
const VECTORS: Array<[string, string]> = [
  [
    '{"closed_at":null,"details":{"a":[2,1],"b":1},"detection_confidence":0.92,"detection_method":null,"detection_source":"manual","detection_status":"confirmed","local_created_at":"2026-01-05T17:03:09.120Z","lock_reason":null,"organization_id":null,"property_address":"12 Main St, Springfield","property_city":"Springfield","property_state":"WA","property_street":"12 Main St","property_zip":"98000","reviewed_at":null,"started_at":"2026-01-05T00:00:00.000Z","status":"active","texts_outside_window_count":3,"transaction_type":"purchase"}',
    "dcf673d8288912b8dd2895d6bd5fb0ef12ab0a8748317a97c3f9b7052103385d",
  ],
  [
    '{"company":null,"contact_deleted":false,"contact_source":"manual",' +
      '"display_name":"Ana Lee",' +
      '"emails":[{"email":"ana@example.test","is_primary":true,"label":null}],"is_primary":true,"local_contact_id":"c-1","notes":null,"phones":[],"removed_reason":null,"role":"buyer","role_category":"client","specific_role":null}',
    "e54093fc85c48798395eed09a8ec48bb8e22317be5d94f73496b2afeebc53e38",
  ],
  [
    '{"is_private":true,"selected_at":"2026-01-06T09:00:00.000Z","sort_order":0,"template_id":"keepr:my-items","template_name":"My items"}',
    "eb971099190d1e1753ea6eb272c244b5469130aa0be9b3fd86126439d8e30a74",
  ],
  [
    '{"checked_at":null,"description":null,"expected_document_type":null,"is_checked":false,"is_required":true,"links":null,"local_checklist_id":"cl-1","local_created_at":"2026-01-06T09:00:00.000Z","note":"café","sort_order":2,"title":"Inspection"}',
    "53a44049cebbdaf62299db0e1b381e410d7db67e59dd090b874d091fe634051d",
  ],
  [
    '{"body_text":"Line 1\\nLine 2","channel":"email","direction":"inbound","hidden_from_export":false,"link_confidence":1,"link_origin":"link","link_source":"auto","linked_at":null,"local_link_id":"cm-1","match_reason":"address_missing","participants":{"from":"a@example.test","to":["b@example.test"]},"received_at":null,"sent_at":"2026-01-07T10:15:00.000Z","subject":"Offer","thread_key":"thr-1"}',
    "215fdb3c830c188cd52c3bb0b4f9252668839f058b67b459841e0bda2695ac28",
  ],
];

/** Reverses key order recursively so a sort is required to reproduce the text. */
function scramble(v: JsonValue): JsonValue {
  if (Array.isArray(v)) return v.map(scramble);
  if (v && typeof v === "object") {
    const out: Record<string, JsonValue> = {};
    for (const k of Object.keys(v).reverse()) out[k] = scramble(v[k]);
    return out;
  }
  return v;
}

describe("JCS and content hash — prebuild.md vectors", () => {
  it.each(VECTORS.map((v, i) => [i, ...v]))("vector %i: canonical text and sha256 match", (_i, text, hash) => {
    const obj = scramble(JSON.parse(text as string));
    expect(jcs(obj)).toBe(text);
    expect(contentHash(obj)).toBe(hash);
  });

  it("the file vector (64 a's) hashes as recorded", () => {
    const text = `{"blob_sha256":"${"a".repeat(64)}","filename":"offer.pdf","message_channel_kind":"email","message_local_id":"e-1","mime_type":"application/pdf","not_saved_reason":null,"size_bytes":1024}`;
    expect(jcs(scramble(JSON.parse(text)))).toBe(text);
    expect(sha256Hex(text)).toBe("7f2481c9a06e5469a0aaf50b4eabb74afc02d646e7598c029f5cd917881e08be");
  });
});

const BASE_ROW: DealRow = {
  id: "deal-0101-4243",
  property_address: "12 Main St, Springfield",
  property_street: "12 Main St",
  property_city: "Springfield",
  property_state: "WA",
  property_zip: "98000",
  transaction_type: "purchase",
  status: "active",
  started_at: "2026-01-05",
  closed_at: null,
  detection_status: "confirmed",
  detection_source: "manual",
  detection_confidence: 0.92,
  detection_method: null,
  reviewed_at: null,
  created_at: "2026-01-05 17:03:09",
  submission_status: "not_submitted",
  listing_price: 450000.0,
  sale_price: null,
  earnest_money_amount: null,
  commission_offered_rate: null,
  commission_actual_rate: null,
  commission_gross_amount: null,
  mutual_acceptance_date: "2026-01-10",
  inspection_deadline: null,
  financing_deadline: null,
  closing_deadline: null,
  representation_start_date: null,
  stage: null,
  export_status: "not_exported",
  updated_at: "2026-01-06 08:00:00",
};

describe("deal DTO — contract shape (C2.16)", () => {
  it("has exactly the frozen hashed fields and the contract's details keys", () => {
    const dto = buildDealDto(BASE_ROW);
    expect(Object.keys(dto).sort()).toEqual([...DEAL_HASHED_FIELDS].sort());
    const details = dto.details as Record<string, JsonValue>;
    expect(Object.keys(details).sort()).toEqual(Object.keys(CONTRACT.deal.details.keys).sort());
    expect(details.v).toBe(CONTRACT.deal.details.v);
    for (const [k, t] of Object.entries(CONTRACT.deal.details.keys as Record<string, string>)) {
      const v = details[k];
      if (v === null) continue;
      expect(typeof v).toBe(t === "date" ? "string" : t);
    }
  });

  it("produces the expected DTO text for a real-shaped row", () => {
    expect(jcs(buildDealDto(BASE_ROW))).toBe(
      '{"closed_at":null,"details":{"closing_deadline":null,"commission_actual_rate":null,"commission_gross_amount":null,"commission_offered_rate":null,"earnest_money_amount":null,"export_status":"not_exported","financing_deadline":null,"inspection_deadline":null,"listing_price":450000,"mutual_acceptance_date":"2026-01-10","representation_start_date":null,"sale_price":null,"stage":null,"submission_status":"not_submitted","v":1},"detection_confidence":0.92,"detection_method":null,"detection_source":"manual","detection_status":"confirmed","local_created_at":"2026-01-05T17:03:09.000Z","lock_reason":null,"organization_id":null,"property_address":"12 Main St, Springfield","property_city":"Springfield","property_state":"WA","property_street":"12 Main St","property_zip":"98000","reviewed_at":null,"started_at":"2026-01-05T00:00:00.000Z","status":"active","texts_outside_window_count":null,"transaction_type":"purchase"}',
    );
  });

  it("REAL 450000.0 and the text '450000' hash the same; non-finite is null", () => {
    const a = projectDeal(BASE_ROW, "install-aa-4243").hash;
    const b = projectDeal({ ...BASE_ROW, listing_price: "450000" }, "install-aa-4243").hash;
    expect(a).toBe(b);
    expect((buildDealDto({ ...BASE_ROW, sale_price: Infinity }).details as Record<string, JsonValue>).sale_price).toBeNull();
  });

  it("identity and provenance keys are sent but not hashed (C2.7)", () => {
    const p1 = projectDeal(BASE_ROW, "install-aa-4243");
    const p2 = projectDeal({ ...BASE_ROW, updated_at: "2027-01-01 00:00:00" }, "install-bb-4243");
    expect(p1.hash).toBe(p2.hash);
    expect(p1.payload.content_hash).toBe(p1.hash);
    expect(p1.payload.local_id).toBe(BASE_ROW.id);
    expect(p1.payload.source_install_id).toBe("install-aa-4243");
    expect(p1.payload.source_updated_at).toBe("2026-01-06T08:00:00.000Z");
  });

  it("lock_reason follows dealLockReason", () => {
    expect(buildDealDto({ ...BASE_ROW, submission_status: "approved" }).lock_reason).toBe("sealed");
    expect(buildDealDto({ ...BASE_ROW, submission_status: "submitted" }).lock_reason).toBe("submitted");
  });
});

describe("dates (C2.18)", () => {
  const send = (v: unknown) => buildDealDto({ ...BASE_ROW, started_at: v }).started_at;
  it("date-only and zone-less instant both send the calendar date", () => {
    expect(send("2026-01-05")).toBe("2026-01-05T00:00:00.000Z");
    expect(send("2026-01-05 17:03:09")).toBe("2026-01-05T00:00:00.000Z");
  });
  it("an instant with Z keeps its first 10 characters (the recorded one-day difference)", () => {
    expect(send("2026-01-06T03:00:00.000Z")).toBe("2026-01-06T00:00:00.000Z");
  });
  it("closed_at from the detection writer (full ISO) sends its first 10 characters", () => {
    expect(buildDealDto({ ...BASE_ROW, closed_at: "2026-03-01T22:15:00.000Z" }).closed_at).toBe("2026-03-01T00:00:00.000Z");
  });
  it("created_at zone-less is UTC; unparseable dates are null", () => {
    expect(buildDealDto({ ...BASE_ROW, created_at: "2026-01-05 17:03:09" }).local_created_at).toBe("2026-01-05T17:03:09.000Z");
    expect(calendarDateInstant("soon")).toBeNull();
    expect(buildDealDto({ ...BASE_ROW, reviewed_at: "not a date" }).reviewed_at).toBeNull();
  });
});

describe("text cleaning (C2.19)", () => {
  it("removes U+0000 and lone surrogates; keeps pairs and normal text", () => {
    expect(cleanText("a\u0000b")).toBe("ab");
    expect(cleanText("x\ud800y")).toBe("xy");
    expect(cleanText("x\udc00y")).toBe("xy");
    expect(cleanText("😀 café")).toBe("😀 café");
    const dto = buildDealDto({ ...BASE_ROW, property_city: "Spring\u0000field\ud800" });
    expect(dto.property_city).toBe("Springfield");
    expect(projectDeal({ ...BASE_ROW, property_city: "Spring\u0000field\ud800" }, "i").hash).toBe(
      projectDeal(BASE_ROW, "i").hash,
    );
  });
});

describe("hash is time-zone independent (C2.17)", () => {
  it("same row hashed under TZ=America/Los_Angeles and TZ=UTC", () => {
    const script = `
      require("ts-node/register/transpile-only");
      const { projectDeal } = require(${JSON.stringify(path.join(__dirname, "..", "projection.ts"))});
      const row = ${JSON.stringify(BASE_ROW)};
      row.reviewed_at = "2026-01-05 23:30:00"; row.closed_at = "2026-01-06T03:00:00.000Z";
      process.stdout.write(JSON.stringify({ off: new Date("2026-01-05T12:00:00").getTimezoneOffset(), hash: projectDeal(row, "i").hash }));
    `;
    const run = (tz: string) => {
      const r = spawnSync(process.execPath, ["-e", script], { env: { ...process.env, TZ: tz }, encoding: "utf8" });
      if (r.status !== 0) throw new Error(r.stderr.slice(0, 400));
      return JSON.parse(r.stdout) as { off: number; hash: string };
    };
    const la = run("America/Los_Angeles");
    const utc = run("UTC");
    expect(la.off).not.toBe(0);
    expect(utc.off).toBe(0);
    expect(la.hash).toBe(utc.hash);
  });
});

describe("trigger column list derives from the projection (C2.14 drift guard)", () => {
  it("every DTO source column is in DEAL_SOURCE_COLUMNS", () => {
    // Reads every key buildDealDto touches by proxying the row.
    const read = new Set<string>();
    const proxy = new Proxy({ ...BASE_ROW } as Record<string, unknown>, {
      get(t, k) {
        if (typeof k === "string") read.add(k);
        return t[k as string];
      },
    });
    buildDealDto(proxy as unknown as DealRow);
    for (const k of read) expect(DEAL_SOURCE_COLUMNS as readonly string[]).toContain(k);
  });
});
