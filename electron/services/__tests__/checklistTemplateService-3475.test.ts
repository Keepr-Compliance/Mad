/**
 * @jest-environment node
 *
 * BACKLOG-3475 C13 — the broker template read and its two caches.
 *
 * ===========================================================================
 * WHERE THE FIXTURES COME FROM
 * ===========================================================================
 * Every PostgREST response below is transcribed from
 * `supabase/tests/backlog-3473/fixtures/postgrest-desktop-read.json`, captured
 * by BACKLOG-3473 against the real Postgres + PostgREST stack with
 * `@supabase/supabase-js 2.110.2` — the version installed in this repo. The
 * `<fixture:...>` and `<timestamp>` placeholders are the file's own redactions
 * and are kept VERBATIM rather than substituted, so what this suite asserts on
 * is character-for-character what the capture recorded. Nothing here was
 * written from memory.
 *
 * Jest never reaches the network (BACKLOG-3284 installs a guard that fails any
 * test attempting an outbound connection), so the client is mocked. That is why
 * the transcription matters: the mock is the only thing standing in for a real
 * server, and a mock nobody captured is a test of an imagined API.
 *
 * ONE THING THIS SUITE DOES NOT CLAIM. The error object used for "the read
 * failed" is the capture's ANON refusal (401 / 42501). It is a real PostgREST
 * error object, and it exercises the branch — but it is not the error
 * production returns TODAY, which is a missing table, because BACKLOG-3473 is
 * not applied there. That shape was NOT captured: the NAS stack was unreachable
 * from this machine when this was written (the stack was up; the tailnet path
 * from the Mac was down — pm_comments `e8091638`). The service is written so it
 * cannot matter: every non-null error lands in the same branch, and no code
 * here reads `error.code`. A branch written around one uncaptured response
 * would be a guess wearing a fixture's clothes.
 *
 * ===========================================================================
 * THE WRONG IMPLEMENTATIONS THIS SUITE EXISTS TO CATCH
 * ===========================================================================
 *   a failed read served as an empty list
 *       "Your brokerage has not set up any checklists" told to a user whose
 *       wifi is off — a false statement about someone else's account. C13-C and
 *       C13-D are the pair that separate them.
 *   a disk cache that is not keyed by organization
 *       A user in two brokerages, or one who switches accounts, shown the other
 *       organization's templates: plan-holder data from a plan they are not on.
 *       C13-F.
 *   an invalidate that clears memory but not the file
 *       The broker renames a template in the portal, the desktop says it
 *       refreshed, and the next read falls through to a file holding exactly
 *       the rows that were replaced. C13-H.
 *   trusting the embed's arrival order
 *       A PostgREST embed carries no order; `.order()` applies to the outer
 *       table only. A checklist that comes out shuffled on one machine and not
 *       another. C13-B.
 *   a malformed row that reaches the cache
 *       One bad row poisoning every later offline read. C13-I.
 *   an in-flight request shared between two ORGANIZATIONS
 *       The same plan-holder leak as the disk cache, one layer up and through
 *       a path the disk check cannot see: a second organization's read, made
 *       while the first is still out, handed the first's rows and labelled
 *       `source: "live"`. C13-K. The sequential org test in C13-H passes
 *       against this bug, which is why C13-K exists.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import path from "path";

const MOCK_USER_DATA = path.join("/mock", "user", "data");
const CACHE_PATH = path.join(MOCK_USER_DATA, "checklist-templates-cache.json");

const ORG_A = "00000000-0000-4000-8000-00003475e0a1"; // pii-allow-uuid: invented fixture id
const ORG_B = "00000000-0000-4000-8000-00003475e0b2"; // pii-allow-uuid: invented fixture id

jest.mock("electron", () => ({
  app: { getPath: jest.fn(() => path.join("/mock", "user", "data")) },
}));

/**
 * A REAL (if tiny) in-memory filesystem rather than three independent stubs.
 *
 * The difference is load-bearing for C13-H. With stubs, "invalidate removed the
 * file" can only be asserted by checking that `unlink` was CALLED and then
 * telling `readFile` to fail — which models the removal instead of observing
 * it, and passes just as well against an `invalidate` that clears memory only.
 * Here `unlink` really removes the entry, so a later read finds what is
 * actually there.
 */
const diskFiles = new Map<string, string>();
const enoent = () => Object.assign(new Error("ENOENT"), { code: "ENOENT" });
const mockFs = {
  writeFile: jest.fn(async (p: string, data: string) => {
    diskFiles.set(p, data);
  }),
  readFile: jest.fn(async (p: string) => {
    const value = diskFiles.get(p);
    if (value === undefined) throw enoent();
    return value;
  }),
  unlink: jest.fn(async (p: string) => {
    if (!diskFiles.delete(p)) throw enoent();
  }),
};
jest.mock("fs", () => ({ promises: mockFs }));

jest.mock("@sentry/electron/main", () => ({ captureException: jest.fn() }));

jest.mock("../logService", () => {
  const fns = {
    info: jest.fn().mockResolvedValue(undefined),
    debug: jest.fn().mockResolvedValue(undefined),
    warn: jest.fn().mockResolvedValue(undefined),
    error: jest.fn().mockResolvedValue(undefined),
  };
  return { __esModule: true, default: fns, logService: fns };
});

/**
 * The chainable PostgREST builder, the shape `entitlementService.test.ts` uses.
 * `order()` is the terminal call in this service, so it resolves the response.
 */
let nextResponse: { data: unknown; error: unknown } = { data: [], error: null };
const calls: Array<{ table: string; select: string; eq: unknown[][]; is: unknown[][]; order: unknown[][] }> = [];

/**
 * Opt-in, per-request responses. `nextResponse` is one shared value, which is
 * all every test but C13-K needs; C13-K has two requests OUT AT ONCE and has to
 * answer them separately and on its own schedule. Null by default and reset in
 * `beforeEach`, so no other test's behaviour changes.
 */
let responder: ((record: (typeof calls)[number]) => Promise<{ data: unknown; error: unknown }>) | null = null;

const mockFrom = jest.fn((table: string) => {
  const record = { table, select: "", eq: [] as unknown[][], is: [] as unknown[][], order: [] as unknown[][] };
  calls.push(record);
  const qb: Record<string, any> = {};
  qb.select = jest.fn((cols: string) => {
    record.select = cols;
    return qb;
  });
  qb.eq = jest.fn((...args: unknown[]) => {
    record.eq.push(args);
    return qb;
  });
  qb.is = jest.fn((...args: unknown[]) => {
    record.is.push(args);
    return qb;
  });
  qb.order = jest.fn((...args: unknown[]) => {
    record.order.push(args);
    if (responder) return responder(record);
    return Promise.resolve(nextResponse);
  });
  return qb;
});

const mockGetAuthSession = jest.fn();
jest.mock("../supabaseService", () => ({
  __esModule: true,
  default: {
    getClient: () => ({ from: mockFrom }),
    getAuthSession: mockGetAuthSession,
  },
}));

// ---------------------------------------------------------------------------
// Fixtures — transcribed verbatim from fixtures/postgrest-desktop-read.json
// ---------------------------------------------------------------------------

/** Case "D1 desktop read as P1's agent": status=200 error=null rows=1 items=2. */
const D1_DATA = [
  {
    id: "<fixture:template-p1-active>",
    name: "Probe template",
    description: "shown in the list only",
    sort_order: 10,
    updated_at: "<timestamp>",
    checklist_template_items: [
      {
        id: "<fixture:item-p1-1>",
        title: "Probe item 1",
        sort_order: 10,
        description: "the desktop tooltip",
        is_required: true,
        expected_document_type: "contract",
      },
      {
        id: "<fixture:item-p1-2>",
        title: "Probe item 2",
        sort_order: 20,
        description: null,
        is_required: false,
        expected_document_type: null,
      },
    ],
  },
];

/** Case "D2 same request, P2's agent": status=200 error=null rows=0. */
const D2_DATA: unknown[] = [];

/** Case "A anon reads checklist_templates": status=401 code=42501. */
const ANON_REFUSAL = {
  code: "42501",
  details: null,
  hint: null,
  message: "permission denied for table checklist_templates",
};

const DAY_MS = 24 * 60 * 60 * 1000;

type Service = typeof import("../checklistTemplateService").default;

/**
 * A FRESH service instance per test. The shipped module is a singleton, so
 * without this the memory cache would leak between tests and a disk-cache
 * assertion could pass by reading a cache the previous test left in memory.
 */
function loadService(): Service {
  let service!: Service;
  jest.isolateModules(() => {
    service = require("../checklistTemplateService").default;
  });
  return service;
}

function resolveWith(data: unknown, error: unknown = null): void {
  nextResponse = { data, error };
}

function persisted(): any {
  const call = mockFs.writeFile.mock.calls.at(-1);
  return call ? JSON.parse(call[1] as string) : null;
}

beforeEach(() => {
  jest.clearAllMocks();
  calls.length = 0;
  responder = null;
  diskFiles.clear();
  mockGetAuthSession.mockResolvedValue({ userId: "u-3475", accessToken: "t" });
  resolveWith(D1_DATA);
});

describe("BACKLOG-3475 C13-A — the D1 capture, read live", () => {
  it("returns the captured template with both items, typed and in order", async () => {
    const listing = await loadService().listTemplates(ORG_A);

    expect(listing).not.toBeNull();
    expect(listing!.source).toBe("live");
    expect(listing!.templates).toHaveLength(1);

    const [template] = listing!.templates;
    expect(template.id).toBe("<fixture:template-p1-active>");
    expect(template.name).toBe("Probe template");
    expect(template.description).toBe("shown in the list only");
    expect(template.sortOrder).toBe(10);
    expect(template.updatedAt).toBe("<timestamp>");

    expect(template.items.map((i) => i.id)).toEqual([
      "<fixture:item-p1-1>",
      "<fixture:item-p1-2>",
    ]);
    expect(template.items.map((i) => i.title)).toEqual(["Probe item 1", "Probe item 2"]);
    expect(template.items.map((i) => i.isRequired)).toEqual([true, false]);
    expect(template.items.map((i) => i.expectedDocumentType)).toEqual(["contract", null]);
    expect(template.items.map((i) => i.description)).toEqual(["the desktop tooltip", null]);
  });

  it("asks for exactly the request BACKLOG-3473 probed: this org, unarchived, ordered", async () => {
    await loadService().listTemplates(ORG_A);

    expect(calls).toHaveLength(1);
    expect(calls[0].table).toBe("checklist_templates");
    expect(calls[0].select).toBe(
      "id,name,description,sort_order,updated_at," +
        "checklist_template_items(id,title,description,is_required,expected_document_type,sort_order)",
    );
    expect(calls[0].eq).toEqual([["organization_id", ORG_A]]);
    expect(calls[0].is).toEqual([["archived_at", null]]);
    expect(calls[0].order).toEqual([["sort_order", { ascending: true }]]);
  });
});

describe("BACKLOG-3475 C13-B — the embed carries no order", () => {
  it("sorts items by sort_order even when the server hands them back reversed", async () => {
    const reversed = [
      {
        ...D1_DATA[0],
        checklist_template_items: [...D1_DATA[0].checklist_template_items].reverse(),
      },
    ];
    resolveWith(reversed);

    const listing = await loadService().listTemplates(ORG_A);

    // `.order("sort_order")` applies to `checklist_templates` only; the embed is
    // unordered, so arrival order is not a promise the server makes.
    expect(listing!.templates[0].items.map((i) => i.sortOrder)).toEqual([10, 20]);
    expect(listing!.templates[0].items.map((i) => i.title)).toEqual([
      "Probe item 1",
      "Probe item 2",
    ]);
  });
});

describe("BACKLOG-3475 C13-C / C13-D — no templates is not the same answer as could not read", () => {
  it("C13-C: the D2 capture (another org's agent, 0 rows) is a SUCCESSFUL empty listing", async () => {
    resolveWith(D2_DATA);

    const listing = await loadService().listTemplates(ORG_A);

    expect(listing).not.toBeNull();
    expect(listing!.source).toBe("live");
    expect(listing!.templates).toEqual([]);
  });

  it("C13-D: a PostgREST error with no cache to fall back on is null, and caches nothing", async () => {
    resolveWith(null, ANON_REFUSAL);

    const listing = await loadService().listTemplates(ORG_A);

    expect(listing).toBeNull();
    expect(mockFs.writeFile).not.toHaveBeenCalled();
  });

  it("C13-D: a body that is not a list is null, not an empty listing", async () => {
    resolveWith({ unexpected: "shape" });

    expect(await loadService().listTemplates(ORG_A)).toBeNull();
    expect(mockFs.writeFile).not.toHaveBeenCalled();
  });

  it("C13-D: a client that throws is null, not an empty listing", async () => {
    mockGetAuthSession.mockRejectedValue(new Error("client exploded"));

    expect(await loadService().listTemplates(ORG_A)).toBeNull();
  });
});

describe("BACKLOG-3475 C13-E / C13-F / C13-G — the disk cache", () => {
  it("C13-E: a failed read falls back to this org's file", async () => {
    diskFiles.set(
      CACHE_PATH,
      JSON.stringify({
        orgId: ORG_A,
        fetchedAt: Date.now() - 60_000,
        templates: [
          {
            id: "<fixture:template-p1-active>",
            name: "Probe template",
            description: null,
            sortOrder: 10,
            updatedAt: "<timestamp>",
            items: [],
          },
        ],
      }),
    );
    resolveWith(null, ANON_REFUSAL);

    const listing = await loadService().listTemplates(ORG_A);

    expect(listing).not.toBeNull();
    expect(listing!.source).toBe("cache");
    expect(listing!.templates.map((t) => t.name)).toEqual(["Probe template"]);
  });

  it("C13-F: a file belonging to ANOTHER org is refused, and the answer is null", async () => {
    diskFiles.set(
      CACHE_PATH,
      JSON.stringify({
        orgId: ORG_B,
        fetchedAt: Date.now() - 60_000,
        templates: [
          {
            id: "<fixture:template-p1-active>",
            name: "Other brokerage's template",
            description: null,
            sortOrder: 10,
            updatedAt: null,
            items: [],
          },
        ],
      }),
    );
    resolveWith(null, ANON_REFUSAL);

    const listing = await loadService().listTemplates(ORG_A);

    // Not "an empty list" and not "the other org's list": we could not find out.
    expect(listing).toBeNull();
  });

  it("C13-G: a file older than seven days is discarded and removed", async () => {
    diskFiles.set(
      CACHE_PATH,
      JSON.stringify({
        orgId: ORG_A,
        fetchedAt: Date.now() - 8 * DAY_MS,
        templates: [{ id: "t", name: "Stale", description: null, sortOrder: 0, updatedAt: null, items: [] }],
      }),
    );
    resolveWith(null, ANON_REFUSAL);

    expect(await loadService().listTemplates(ORG_A)).toBeNull();
    expect(diskFiles.has(CACHE_PATH)).toBe(false);
  });
});

describe("BACKLOG-3475 C13-H — invalidate clears BOTH caches", () => {
  it("after invalidate, a failed read cannot resurrect the old rows from the file", async () => {
    const service = loadService();

    // 1. A live read populates memory and writes the file.
    await service.listTemplates(ORG_A);
    expect(diskFiles.has(CACHE_PATH)).toBe(true);

    // 2. Invalidate.
    await service.invalidate();

    // 3. OBSERVE the file, do not assume it. `unlink` on the in-memory disk
    //    really removes the entry, so an `invalidate` that cleared memory only
    //    would leave the entry here and the read below would serve exactly the
    //    rows the broker replaced.
    expect(diskFiles.has(CACHE_PATH)).toBe(false);

    resolveWith(null, ANON_REFUSAL);
    expect(await service.listTemplates(ORG_A)).toBeNull();
  });

  it("the memory cache is dropped too: the next read goes back to the network", async () => {
    const service = loadService();
    await service.listTemplates(ORG_A);
    expect(calls).toHaveLength(1);

    await service.invalidate();
    await service.listTemplates(ORG_A);

    // Without the memory clear this would still be 1: the entry is well inside
    // the 5-minute TTL.
    expect(calls).toHaveLength(2);
  });

  it("a fresh memory entry IS reused within the TTL (the control for the test above)", async () => {
    const service = loadService();
    await service.listTemplates(ORG_A);
    await service.listTemplates(ORG_A);

    expect(calls).toHaveLength(1);
  });

  it("a memory entry for ANOTHER org is never reused", async () => {
    const service = loadService();
    await service.listTemplates(ORG_A);
    await service.listTemplates(ORG_B);

    expect(calls).toHaveLength(2);
    expect(calls[1].eq).toEqual([["organization_id", ORG_B]]);
  });
});

describe("BACKLOG-3475 C13-I — a row this build cannot read is dropped, never cached", () => {
  it("keeps the valid template, drops the malformed one, and persists only what it kept", async () => {
    resolveWith([
      D1_DATA[0],
      // `title` is absent. The cloud CHECK requires 1..300 characters, so this
      // is a row no correct producer emits — which is exactly why a build must
      // not carry it forward into an offline cache.
      {
        id: "<fixture:template-broken>",
        name: "Broken template",
        description: null,
        sort_order: 20,
        updated_at: null,
        checklist_template_items: [{ id: "x", sort_order: 0, is_required: true, description: null, expected_document_type: null }],
      },
    ]);

    const listing = await loadService().listTemplates(ORG_A);

    // The embed is `.catch([])`, so the outer row survives with no items rather
    // than disappearing from a list the broker can see in their own portal.
    expect(listing!.templates.map((t) => t.id)).toEqual([
      "<fixture:template-p1-active>",
      "<fixture:template-broken>",
    ]);
    expect(listing!.templates[1].items).toEqual([]);
    expect(persisted().templates[1].items).toEqual([]);
  });

  it("drops a template row whose own required fields are missing", async () => {
    resolveWith([D1_DATA[0], { id: "<fixture:nameless>", sort_order: 5 }]);

    const listing = await loadService().listTemplates(ORG_A);

    expect(listing!.templates.map((t) => t.id)).toEqual(["<fixture:template-p1-active>"]);
    expect(persisted().templates.map((t: any) => t.id)).toEqual([
      "<fixture:template-p1-active>",
    ]);
  });

  it("an eleventh document type keeps the item and loses only the hint", async () => {
    resolveWith([
      {
        ...D1_DATA[0],
        checklist_template_items: [
          { ...D1_DATA[0].checklist_template_items[0], expected_document_type: "correspondence" },
        ],
      },
    ]);

    const listing = await loadService().listTemplates(ORG_A);

    expect(listing!.templates[0].items.map((i) => i.title)).toEqual(["Probe item 1"]);
    expect(listing!.templates[0].items[0].expectedDocumentType).toBeNull();
  });
});

describe("BACKLOG-3475 C13-J — no session is not an empty listing", () => {
  it("returns null and never issues the query", async () => {
    mockGetAuthSession.mockResolvedValue(null);

    expect(await loadService().listTemplates(ORG_A)).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe("BACKLOG-3475 C13-K — a concurrent read for ANOTHER org is never served this org's rows", () => {
  /** The D1 row relabelled, so ORG_B's answer is distinguishable from ORG_A's. */
  const ORG_B_DATA = [
    {
      ...D1_DATA[0],
      id: "<fixture:template-p2-active>",
      name: "Other brokerage's template",
      checklist_template_items: [],
    },
  ];

  /** Let every queued microtask run. */
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

  it("two overlapping reads for different organizations each get their own rows", async () => {
    const pending: Array<() => void> = [];
    responder = (record) =>
      new Promise((resolve) => {
        const org = record.eq[0][1] as string;
        pending.push(() =>
          resolve({ data: org === ORG_A ? D1_DATA : ORG_B_DATA, error: null }),
        );
      });

    const service = loadService();

    // 1. ORG_A's read is out and has NOT answered.
    const a = service.listTemplates(ORG_A);
    await settle();
    expect(pending).toHaveLength(1);

    // 2. ORG_B reads while it is still out. This is the ONLY state in which
    //    `fetchOnce` shares a promise at all, so it is the only state in which
    //    the organization check can matter.
    const b = service.listTemplates(ORG_B);
    await settle();

    // 3. Drain whatever is waiting. Deliberately NOT "wait until two requests
    //    exist": without the organization check ORG_B issues no request of its
    //    own, and waiting for a second would make this control fail by TIMEOUT
    //    — a slow red that says nothing about which implementation ran.
    for (let i = 0; i < 5 && pending.length > 0; i += 1) {
      for (const resolve of pending.splice(0)) resolve();
      await settle();
    }

    const [listingA, listingB] = await Promise.all([a, b]);

    // Identity, not a count: one request per organization, each asking about
    // its own. Sharing the promise blind leaves this `[ORG_A]`.
    expect(calls.map((c) => c.eq[0][1])).toEqual([ORG_A, ORG_B]);

    expect(listingA!.templates.map((t) => t.name)).toEqual(["Probe template"]);
    // The leak: without the check this is ORG_A's list, carried back to a user
    // of ORG_B under `source: "live"`.
    expect(listingB!.source).toBe("live");
    expect(listingB!.templates.map((t) => t.name)).toEqual(["Other brokerage's template"]);
  });

  it("a read that finishes does not strand a SECOND org's request still in flight", async () => {
    // The `finally` clause clears only its OWN entry. Clearing unconditionally
    // looks harmless — the leak above is already closed by then — but it drops
    // the in-flight entry belonging to a request that is still out, so every
    // later caller for that organization issues a duplicate read.
    //
    // Three callers, because two cannot see it: the first has to FINISH while
    // the second is still out, and only a third can observe what the second's
    // entry is worth afterwards.
    const pending: Array<() => void> = [];
    responder = (record) =>
      new Promise((resolve) => {
        const org = record.eq[0][1] as string;
        pending.push(() =>
          resolve({ data: org === ORG_A ? D1_DATA : ORG_B_DATA, error: null }),
        );
      });

    const service = loadService();
    const a = service.listTemplates(ORG_A);
    await settle();
    const b = service.listTemplates(ORG_B);
    await settle();
    expect(pending).toHaveLength(2);

    // ORG_A answers and its `finally` runs. ORG_B's request is still out.
    pending.shift()!();
    await settle();
    expect(await a).not.toBeNull();

    // A third caller for ORG_B. It must ride on the request already out.
    const c = service.listTemplates(ORG_B);
    await settle();

    for (let i = 0; i < 5 && pending.length > 0; i += 1) {
      for (const resolve of pending.splice(0)) resolve();
      await settle();
    }

    const [listingB, listingC] = await Promise.all([b, c]);

    // Two requests, not three. Clearing unconditionally makes this
    // [ORG_A, ORG_B, ORG_B].
    expect(calls.map((call) => call.eq[0][1])).toEqual([ORG_A, ORG_B]);
    expect(listingB!.templates.map((t) => t.name)).toEqual(["Other brokerage's template"]);
    expect(listingC!.templates.map((t) => t.name)).toEqual(["Other brokerage's template"]);
  });

  it("A, then B, then A again while both are out: the second A rides on A's request (BACKLOG-3476)", async () => {
    // The single-slot shape this replaced held only the LATEST organization's
    // read, so B's read displaced A's entry and the second A started a
    // duplicate request: calls were [ORG_A, ORG_B, ORG_A]. Benign (both
    // answers are A's own rows) but not what `fetchOnce` promises. Measured
    // red against the single slot before the map landed.
    const pending: Array<() => void> = [];
    responder = (record) =>
      new Promise((resolve) => {
        const org = record.eq[0][1] as string;
        pending.push(() =>
          resolve({ data: org === ORG_A ? D1_DATA : ORG_B_DATA, error: null }),
        );
      });

    const service = loadService();
    const a1 = service.listTemplates(ORG_A);
    await settle();
    const b = service.listTemplates(ORG_B);
    await settle();
    const a2 = service.listTemplates(ORG_A);
    await settle();

    for (let i = 0; i < 5 && pending.length > 0; i += 1) {
      for (const resolve of pending.splice(0)) resolve();
      await settle();
    }

    const [listingA1, listingB, listingA2] = await Promise.all([a1, b, a2]);

    expect(calls.map((call) => call.eq[0][1])).toEqual([ORG_A, ORG_B]);
    expect(listingA1!.templates.map((t) => t.name)).toEqual(["Probe template"]);
    expect(listingA2!.templates.map((t) => t.name)).toEqual(["Probe template"]);
    expect(listingB!.templates.map((t) => t.name)).toEqual(["Other brokerage's template"]);
  });

  it("two overlapping reads for the SAME org still collapse onto one request", async () => {
    // The control for the control: the check must not cost the collapsing that
    // `fetchOnce` exists for.
    const pending: Array<() => void> = [];
    responder = () =>
      new Promise((resolve) => {
        pending.push(() => resolve({ data: D1_DATA, error: null }));
      });

    const service = loadService();
    const first = service.listTemplates(ORG_A);
    await settle();
    const second = service.listTemplates(ORG_A);
    await settle();

    for (const resolve of pending.splice(0)) resolve();
    const [one, two] = await Promise.all([first, second]);

    expect(calls).toHaveLength(1);
    expect(one!.templates.map((t) => t.name)).toEqual(["Probe template"]);
    expect(two!.templates.map((t) => t.name)).toEqual(["Probe template"]);
  });
});
