#!/usr/bin/env node
/**
 * check-migration-grants — check the grants in Supabase migration files ADDED
 * by a pull request. (BACKLOG-3611)
 *
 * ## What it checks
 *
 * Only files ADDED under `supabase/migrations/` in the PR diff. Files that
 * already exist on the base branch are not checked (they are grandfathered).
 *
 * FAIL — a `CREATE [OR REPLACE] FUNCTION` in schema public ends the file with
 *        EXECUTE still held by PUBLIC or anon. "Ends the file" means: the
 *        REVOKE / GRANT statements in the file that name the function are
 *        replayed in order, and the last statement for PUBLIC and the last for
 *        anon must both be a REVOKE. Several REVOKE statements may be combined
 *        (one naming PUBLIC, another naming anon). A REVOKE that names more
 *        roles (`FROM PUBLIC, anon, authenticated`) also counts.
 * FAIL — a `CREATE TABLE` in schema public ends the file with TRUNCATE still
 *        held by anon or authenticated (same replay; `REVOKE ALL` counts).
 * WARN — a `SECURITY DEFINER` function whose body contains neither
 *        `auth.uid()` nor `auth.role()`.
 *
 * ## Exemptions (each decided here, each covered by a test)
 *
 * 1. Marker. A function is exempt from the FAIL rule when a comment inside its
 *    CREATE statement, or in the comment lines directly above it, reads
 *        -- Intentionally callable by anon: <flow>
 *    — the label CLAUDE.md and `.claude/docs/shared/security-patterns.md`
 *    document (PR #2775). It is the only accepted spelling. The flow must be
 *    non-empty. The WARN rule still applies.
 *
 * 2. Re-creating an existing function. `CREATE OR REPLACE` on a function that
 *    already exists keeps that function's grants, so the file does not widen
 *    them. Such a re-create PASSES when ALL of these hold:
 *      - a function with the same name AND the same argument types still
 *        exists after the base branch's migrations are replayed in version
 *        order (created, and not dropped by a later base migration — a
 *        function the base dropped is treated as new);
 *      - the file does not `DROP FUNCTION` that name (a DROP resets the ACL to
 *        the defaults, which give PUBLIC and anon EXECUTE);
 *      - the file has no GRANT to PUBLIC or anon naming that function.
 *    A function created outside the migrations (in the dashboard) is not in
 *    the catalog and is treated as new: the check asks for the REVOKE. That
 *    errs towards failing.
 *
 * 3. Trigger functions (`RETURNS trigger` / `RETURNS event_trigger`) are
 *    exempt from the FAIL and WARN rules. Postgres refuses to call them
 *    outside a trigger, so EXECUTE through the API does nothing.
 *
 * ## Scope and limits (stated so nobody has to discover them)
 *
 * - Schema: functions and tables in `public`, or unqualified (the migration
 *   search_path is public). Other schemas are not exposed by the API.
 * - Overloads are matched by name + argument types. Argument types are
 *   normalised: parameter names, IN/INOUT/VARIADIC modes, DEFAULT clauses and
 *   type modifiers are dropped, OUT parameters are left out (Postgres does the
 *   same), common aliases are folded (int/int4 -> integer, bool -> boolean,
 *   timestamptz -> timestamp with time zone, ...), and a leading `public.` on
 *   a type is dropped. A REVOKE that names a function without an argument
 *   list matches every overload of that name. Types are compared as text: a
 *   domain and its base type, or `character varying` vs `text`, do not match.
 * - SQL is lexed, not parsed: comments, string literals, dollar-quoted bodies
 *   and quoted identifiers are recognised, so a REVOKE written inside a
 *   function body or a DO block is NOT counted. Statements built dynamically
 *   (`EXECUTE format('CREATE FUNCTION ...')` inside a DO block) are invisible
 *   to this check. SQL-standard bodies (`BEGIN ATOMIC ... END`) contain
 *   top-level semicolons and are not supported (none exist in the repo today).
 * - `CREATE PROCEDURE` is not checked: procedures run through CALL and are not
 *   exposed by the API.
 * - The existing-function catalog replays the base branch's migrations in
 *   version order: `CREATE FUNCTION` adds a signature, a later `DROP FUNCTION`
 *   removes it (one signature, or every overload when the DROP names no
 *   argument list). DROPs written inside DO blocks or dynamic SQL are not
 *   seen, and neither are functions dropped outside the migrations.
 * - The catalog does not include other files added by the same PR. File 1
 *   creating a function (with its REVOKE) and file 2 re-creating it without a
 *   REVOKE fails on file 2. Fail-safe; the fix is a one-line REVOKE.
 * - Renames are read as additions (`--no-renames`). A grandfathered migration
 *   that is re-timestamped (renamed) is checked as new and fails if it has no
 *   REVOKE. Fail-safe.
 * - The re-create exemption means "this file does not WIDEN the grants", not
 *   "this function is locked down": the function keeps whatever grants it had
 *   on the base, including a missing REVOKE from an older migration.
 * - The WARN rule also fires on service-role-only SECURITY DEFINER functions
 *   that legitimately have no auth.uid() check. It is advisory.
 *
 * ## Modes
 *
 *   --base <ref>                 PR mode. Checks files added between <ref> and
 *                                HEAD (`git diff --no-renames --diff-filter=A
 *                                <ref>...HEAD`). File content comes from HEAD;
 *                                the existing-function catalog comes from the
 *                                migration files in <ref>'s tree. A file moved
 *                                in from supabase/parked/ counts as added.
 *   --files <a.sql> [b.sql ...]  Check these files directly (tests, local use).
 *   --catalog-dir <dir>          With --files: the existing-function catalog is
 *                                every .sql file in <dir>, except files with
 *                                the same basename as a checked file.
 *   --json                       Print the result as JSON instead of text.
 *
 * Exit codes — the same contract as check-message-hygiene.mjs:
 *   0  clean (warnings allowed)
 *   1  at least one FAIL
 *   2  cannot resolve the input (bad ref, unreadable file, usage error)
 */

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { basename, join } from "node:path";

const MIGRATIONS_DIR = "supabase/migrations";

// ---------------------------------------------------------------------------
// Lexer: split SQL into top-level statements, masking literals and comments.
// ---------------------------------------------------------------------------

const IDENT_CHAR = /[A-Za-z0-9_$]/;

/**
 * Returns statements: { code, line, bodies, comments }
 *   code     — the statement text with comments removed and every string /
 *              dollar-quoted literal replaced by a placeholder. Quoted
 *              identifiers are kept verbatim.
 *   line     — 1-based line of the statement's first non-blank character.
 *   bodies   — contents of the string / dollar-quoted literals, in order.
 *   comments — comment texts between the previous statement and the end of
 *              this one (leading comments + comments inside it).
 */
export function lexStatements(sql) {
  const statements = [];
  let code = "";
  let bodies = [];
  let comments = [];
  let startLine = null;
  let line = 1;
  let i = 0;
  const n = sql.length;

  const markStart = () => {
    if (startLine === null) startLine = line;
  };
  const advance = (text) => {
    for (const ch of text) if (ch === "\n") line += 1;
  };
  const flush = () => {
    if (code.trim().length > 0) {
      statements.push({ code, line: startLine ?? line, bodies, comments });
      comments = [];
    }
    // Comments that trail a statement with nothing after them stay attached
    // to the next statement (they are "above" it).
    code = "";
    bodies = [];
    startLine = null;
  };

  while (i < n) {
    const ch = sql[i];
    const next = sql[i + 1];

    // -- line comment
    if (ch === "-" && next === "-") {
      let j = sql.indexOf("\n", i);
      if (j === -1) j = n;
      comments.push(sql.slice(i + 2, j));
      code += " ";
      i = j;
      continue;
    }
    // /* block comment */ (nestable in Postgres)
    if (ch === "/" && next === "*") {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (sql[j] === "/" && sql[j + 1] === "*") {
          depth += 1;
          j += 2;
        } else if (sql[j] === "*" && sql[j + 1] === "/") {
          depth -= 1;
          j += 2;
        } else j += 1;
      }
      const text = sql.slice(i, j);
      comments.push(text.slice(2, -2));
      advance(text);
      code += " ";
      i = j;
      continue;
    }
    // 'string' or E'string'
    if (ch === "'") {
      markStart();
      const prev = sql[i - 1];
      const prev2 = sql[i - 2];
      const escapes =
        (prev === "E" || prev === "e") && !(prev2 && IDENT_CHAR.test(prev2));
      let j = i + 1;
      let content = "";
      while (j < n) {
        if (escapes && sql[j] === "\\") {
          content += sql.slice(j, j + 2);
          j += 2;
          continue;
        }
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            content += "'";
            j += 2;
            continue;
          }
          break;
        }
        content += sql[j];
        j += 1;
      }
      advance(sql.slice(i, j + 1));
      bodies.push(content);
      code += "'S'";
      i = j + 1;
      continue;
    }
    // "quoted identifier" — kept verbatim
    if (ch === '"') {
      markStart();
      let j = i + 1;
      while (j < n) {
        if (sql[j] === '"') {
          if (sql[j + 1] === '"') {
            j += 2;
            continue;
          }
          break;
        }
        j += 1;
      }
      const text = sql.slice(i, j + 1);
      advance(text);
      code += text;
      i = j + 1;
      continue;
    }
    // $tag$ dollar-quoted $tag$
    if (ch === "$" && !(i > 0 && IDENT_CHAR.test(sql[i - 1]))) {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 64));
      if (m) {
        markStart();
        const tag = m[0];
        const close = sql.indexOf(tag, i + tag.length);
        const end = close === -1 ? n : close + tag.length;
        const content = sql.slice(i + tag.length, close === -1 ? n : close);
        advance(sql.slice(i, end));
        bodies.push(content);
        code += "$BODY$";
        i = end;
        continue;
      }
    }
    if (ch === ";") {
      flush();
      i += 1;
      continue;
    }
    if (ch === "\n") line += 1;
    if (!/\s/.test(ch)) markStart();
    code += ch;
    i += 1;
  }
  flush();
  return statements;
}

// ---------------------------------------------------------------------------
// Small parsing helpers
// ---------------------------------------------------------------------------

const IDENT_RE = String.raw`(?:"(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$]*)`;
const QNAME_RE = String.raw`(${IDENT_RE})(?:\s*\.\s*(${IDENT_RE}))?`;

/** Unquoted identifiers fold to lower case; quoted ones keep their case. */
export function normIdent(id) {
  if (id.startsWith('"')) return id.slice(1, -1).replace(/""/g, '"');
  return id.toLowerCase();
}

/** [schema|null, name] from the two capture groups of QNAME_RE. */
function qname(a, b) {
  return b === undefined ? [null, normIdent(a)] : [normIdent(a), normIdent(b)];
}

function isPublicSchema(schema) {
  return schema === null || schema === "public";
}

/** Split on commas that are not inside parentheses or quoted identifiers. */
export function splitTopLevel(text, sep = ",") {
  const out = [];
  let depth = 0;
  let cur = "";
  let inQuote = false;
  for (const ch of text) {
    if (ch === '"') inQuote = !inQuote;
    if (!inQuote) {
      if (ch === "(") depth += 1;
      else if (ch === ")") depth -= 1;
      else if (ch === sep && depth === 0) {
        out.push(cur);
        cur = "";
        continue;
      }
    }
    cur += ch;
  }
  if (cur.trim().length > 0) out.push(cur);
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Index of the parenthesis that closes the one at `open`. */
function matchParen(text, open) {
  let depth = 0;
  let inQuote = false;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') inQuote = !inQuote;
    if (inQuote) continue;
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

const TYPE_ALIASES = new Map([
  ["int", "integer"],
  ["int4", "integer"],
  ["int8", "bigint"],
  ["int2", "smallint"],
  ["bool", "boolean"],
  ["varchar", "character varying"],
  ["char", "character"],
  ["bpchar", "character"],
  ["float8", "double precision"],
  ["float", "double precision"],
  ["float4", "real"],
  ["decimal", "numeric"],
  ["timestamptz", "timestamp with time zone"],
  ["timestamp without time zone", "timestamp"],
  ["timetz", "time with time zone"],
  ["time without time zone", "time"],
]);

// First words of multi-word type names, and the words that continue them.
const MULTIWORD_START = new Set([
  "double",
  "character",
  "char",
  "national",
  "bit",
  "timestamp",
  "time",
  "interval",
]);
const MULTIWORD_CONTINUE = new Set([
  "precision",
  "varying",
  "with",
  "without",
  "character",
]);

/** Normalise one type name for signature comparison. */
export function normType(raw) {
  let t = raw.trim();
  let arraySuffix = "";
  // Array markers: text[] / text [] / text ARRAY
  const arr = /((?:\s*\[\s*\d*\s*\])+|\s+array)$/i.exec(t);
  if (arr) {
    const dims = (arr[1].match(/\[/g) || ["["]).length;
    arraySuffix = "[]".repeat(dims);
    t = t.slice(0, arr.index);
  }
  // Type modifiers are not part of a function's identity.
  t = t.replace(/\s*\([^)]*\)/g, " ");
  // Quoted identifiers keep case; everything else folds.
  t = t
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.split(".").map((p) => normIdent(p)).join("."))
    .join(" ");
  if (t.startsWith("public.")) t = t.slice("public.".length);
  t = TYPE_ALIASES.get(t) ?? t;
  return t + arraySuffix;
}

/**
 * Argument list (text between the parentheses) -> normalised identity type
 * list, e.g. "p_id uuid, p_n INT DEFAULT 3, OUT x text" -> ["uuid","integer"].
 */
export function normArgs(argText) {
  const types = [];
  for (let arg of splitTopLevel(argText)) {
    // Drop DEFAULT / = default expressions.
    arg = arg.replace(/\s+default\s+[\s\S]*$/i, "").replace(/\s*=\s*[\s\S]*$/, "");
    let words = arg.trim().split(/\s+/);
    let mode = "in";
    if (/^(in|out|inout|variadic)$/i.test(words[0]) && words.length > 1) {
      mode = words[0].toLowerCase();
      words = words.slice(1);
    }
    if (mode === "out") continue;
    if (words.length >= 2) {
      const first = words[0].toLowerCase();
      const second = words[1].toLowerCase().replace(/\(.*$/, "");
      const looksLikeType =
        MULTIWORD_START.has(first) && MULTIWORD_CONTINUE.has(second);
      if (!looksLikeType) words = words.slice(1); // drop the parameter name
    }
    types.push(normType(words.join(" ")));
  }
  return types;
}

function sigKey(name, types) {
  return `${name}(${types.join(",")})`;
}

// ---------------------------------------------------------------------------
// Statement classifiers
// ---------------------------------------------------------------------------

const CREATE_FN_RE = new RegExp(
  String.raw`^\s*CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+${QNAME_RE}\s*\(`,
  "i",
);

/** CREATE [OR REPLACE] FUNCTION -> descriptor, or null. */
export function parseCreateFunction(stmt) {
  const m = CREATE_FN_RE.exec(stmt.code);
  if (!m) return null;
  const [schema, name] = qname(m[2], m[3]);
  const open = m.index + m[0].length - 1;
  const close = matchParen(stmt.code, open);
  if (close === -1) return null;
  const types = normArgs(stmt.code.slice(open + 1, close));
  const rest = stmt.code.slice(close + 1);
  return {
    schema,
    name,
    types,
    key: sigKey(name, types),
    orReplace: Boolean(m[1]),
    isTrigger: /\bRETURNS\s+(?:SETOF\s+)?(?:event_)?trigger\b/i.test(rest),
    securityDefiner: /\bSECURITY\s+DEFINER\b/i.test(rest),
    callerCheck: stmt.bodies.some((b) =>
      /\bauth\s*\.\s*"?(?:uid|role)"?\s*\(/i.test(b),
    ),
  };
}

const CREATE_TABLE_RE = new RegExp(
  String.raw`^\s*CREATE\s+(?:(?:GLOBAL|LOCAL)\s+)?(TEMP\s+|TEMPORARY\s+|UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${QNAME_RE}`,
  "i",
);

export function parseCreateTable(stmt) {
  const m = CREATE_TABLE_RE.exec(stmt.code);
  if (!m) return null;
  const temp = Boolean(m[1]) && /^TEMP/i.test(m[1].trim());
  const [schema, name] = qname(m[2], m[3]);
  return { schema, name, temp };
}

const DROP_FN_RE = /^\s*DROP\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?([\s\S]*?)(?:\s+(?:CASCADE|RESTRICT))?\s*$/i;

/** DROP FUNCTION -> list of dropped functions { name, types|null } (public only). */
export function parseDropFunction(stmt) {
  const m = DROP_FN_RE.exec(stmt.code);
  if (!m) return null;
  const refs = [];
  for (const item of splitTopLevel(m[1])) {
    const t = parseObjectRef(item);
    if (t && isPublicSchema(t.schema)) refs.push({ name: t.name, types: t.types });
  }
  return refs;
}

/** "public.f(uuid, text)" or "f" -> { schema, name, types|null } */
function parseObjectRef(item) {
  const m = new RegExp(String.raw`^\s*${QNAME_RE}\s*`).exec(item);
  if (!m) return null;
  const [schema, name] = qname(m[1], m[2]);
  const rest = item.slice(m[0].length);
  let types = null;
  if (rest.startsWith("(")) {
    const close = matchParen(rest, 0);
    if (close !== -1) types = normArgs(rest.slice(1, close));
  }
  return { schema, name, types };
}

function parseRoles(text) {
  return splitTopLevel(text).map((r) => {
    const role = r.replace(/^GROUP\s+/i, "").trim();
    return normIdent(role);
  });
}

const PRIV_RE =
  /^\s*(GRANT|REVOKE)\s+(GRANT\s+OPTION\s+FOR\s+)?([\s\S]+?)\s+ON\s+([\s\S]+?)\s+(TO|FROM)\s+([\s\S]+?)(?:\s+WITH\s+GRANT\s+OPTION|\s+GRANTED\s+BY\s+\S+|\s+CASCADE|\s+RESTRICT)*\s*$/i;

/**
 * GRANT / REVOKE on functions or tables -> descriptor, or null.
 *   { op: "grant"|"revoke", kind: "function"|"table",
 *     privileges: Set, all: boolean,
 *     targets: [{schema,name,types}] | "ALL_IN_PUBLIC", roles: [] }
 */
export function parsePrivilege(stmt) {
  const m = PRIV_RE.exec(stmt.code);
  if (!m) return null;
  const op = m[1].toLowerCase();
  if (op === "revoke" && m[2]) return null; // GRANT OPTION FOR keeps the privilege
  const privText = m[3].trim();
  const privileges = new Set(
    splitTopLevel(privText).map((p) => p.replace(/\s*\(.*$/, "").trim().toLowerCase()),
  );
  const all = privileges.has("all") || privileges.has("all privileges");
  const roles = parseRoles(m[6]);
  let objText = m[4].trim();

  let kind;
  let targets;
  let am;
  if ((am = /^ALL\s+(FUNCTIONS|ROUTINES|TABLES)\s+IN\s+SCHEMA\s+([\s\S]+)$/i.exec(objText))) {
    kind = /TABLES/i.test(am[1]) ? "table" : "function";
    const schemas = splitTopLevel(am[2]).map(normIdent);
    if (!schemas.includes("public")) return null;
    targets = "ALL_IN_PUBLIC";
  } else if ((am = /^(FUNCTION|ROUTINE)\s+([\s\S]+)$/i.exec(objText))) {
    kind = "function";
    targets = splitTopLevel(am[2]).map(parseObjectRef).filter(Boolean);
  } else if (/^(SEQUENCE|SCHEMA|DATABASE|DOMAIN|TYPE|LANGUAGE|LARGE\s+OBJECT|FOREIGN|TABLESPACE|PROCEDURE|PARAMETER)\b/i.test(objText)) {
    return null;
  } else {
    kind = "table";
    objText = objText.replace(/^TABLE\s+/i, "");
    targets = splitTopLevel(objText).map(parseObjectRef).filter(Boolean);
  }
  return { op, kind, privileges, all, targets, roles };
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

const MARKER_RE = /^\s*Intentionally callable by anon\s*:\s*\S/i;

function hasMarker(stmt) {
  return stmt.comments.some((c) => c.split("\n").some((l) => MARKER_RE.test(l)));
}

/**
 * Catalog of the functions that exist after applying the given SQL texts IN
 * ORDER: Set of sig keys. A CREATE adds a signature; a later DROP FUNCTION
 * removes it (by signature, or every overload when the DROP names no argument
 * list), and a CREATE after the DROP adds it back.
 */
export function buildCatalog(texts) {
  const keys = new Set();
  for (const text of texts) {
    for (const stmt of lexStatements(text)) {
      const fn = parseCreateFunction(stmt);
      if (fn) {
        if (isPublicSchema(fn.schema)) keys.add(fn.key);
        continue;
      }
      const drops = parseDropFunction(stmt);
      if (!drops) continue;
      for (const d of drops) {
        const exact = d.types === null ? null : sigKey(d.name, d.types);
        for (const key of [...keys]) {
          if (exact !== null ? key === exact : key.slice(0, key.indexOf("(")) === d.name) {
            keys.delete(key);
          }
        }
      }
    }
  }
  return keys;
}

/**
 * Order migration file names the way they are applied: by the version prefix
 * before the first "_" (so "20260313_x" comes before "20260313120000_y"), then
 * by full name.
 */
export function sortMigrations(names) {
  const version = (n) => basename(n).split("_")[0];
  return [...names].sort((a, b) => {
    const va = version(a);
    const vb = version(b);
    if (va !== vb) return va < vb ? -1 : 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

function targetMatchesFunction(t, fn) {
  if (!isPublicSchema(t.schema) || t.name !== fn.name) return false;
  return t.types === null || sigKey(t.name, t.types) === fn.key;
}

function targetMatchesTable(t, table) {
  return isPublicSchema(t.schema) && t.name === table.name;
}

/**
 * Replay GRANT/REVOKE statements for one object and one set of roles.
 * Returns { last: Map(role -> "grant"|"revoke"), granted: Set(role) }.
 */
function replay(privs, matches, relevant, roles) {
  const last = new Map();
  const granted = new Set();
  for (const p of privs) {
    if (!relevant(p)) continue;
    const hit = p.targets === "ALL_IN_PUBLIC" || p.targets.some(matches);
    if (!hit) continue;
    for (const role of p.roles) {
      if (!roles.includes(role)) continue;
      last.set(role, p.op);
      if (p.op === "grant") granted.add(role);
    }
  }
  return { last, granted };
}

/**
 * Analyse one migration file.
 * @param {string} sql
 * @param {Set<string>} catalog  sig keys of functions existing on the base
 * @returns {{failures: object[], warnings: object[], passes: object[]}}
 */
export function analyzeMigration(sql, catalog = new Set()) {
  const statements = lexStatements(sql);
  const failures = [];
  const warnings = [];
  const passes = [];

  const functions = [];
  const tables = [];
  const privs = [];
  const dropped = new Set();

  for (const stmt of statements) {
    const fn = parseCreateFunction(stmt);
    if (fn) {
      functions.push({ ...fn, line: stmt.line, marker: hasMarker(stmt) });
      continue;
    }
    const table = parseCreateTable(stmt);
    if (table) {
      tables.push({ ...table, line: stmt.line });
      continue;
    }
    const drops = parseDropFunction(stmt);
    if (drops) {
      for (const d of drops) dropped.add(d.name);
      continue;
    }
    const p = parsePrivilege(stmt);
    if (p) privs.push(p);
  }

  const FN_ROLES = ["public", "anon"];
  for (const fn of functions) {
    const label = `${fn.schema ?? "public"}.${fn.key}`;
    if (fn.securityDefiner && !fn.isTrigger && !fn.callerCheck) {
      warnings.push({
        line: fn.line,
        rule: "definer-without-caller-check",
        object: label,
        message: `SECURITY DEFINER function ${label} has neither auth.uid() nor auth.role() in its body.`,
      });
    }
    if (!isPublicSchema(fn.schema)) continue;
    if (fn.isTrigger) {
      passes.push({ line: fn.line, object: label, reason: "trigger function" });
      continue;
    }
    if (fn.marker) {
      passes.push({ line: fn.line, object: label, reason: "intentionally-public marker" });
      continue;
    }
    const { last, granted } = replay(
      privs,
      (t) => targetMatchesFunction(t, fn),
      (p) => p.kind === "function" && (p.all || p.privileges.has("execute")),
      FN_ROLES,
    );
    const revokedBoth = FN_ROLES.every((r) => last.get(r) === "revoke");
    if (revokedBoth) {
      passes.push({ line: fn.line, object: label, reason: "EXECUTE revoked from PUBLIC and anon" });
      continue;
    }
    const regranted = FN_ROLES.filter((r) => last.get(r) === "grant");
    if (regranted.length > 0) {
      failures.push({
        line: fn.line,
        rule: "function-granted-to-anon",
        object: label,
        message: `${label}: the file GRANTs EXECUTE to ${regranted.join(" and ")}. Revoke it, or mark the function "-- Intentionally callable by anon: <flow>".`,
      });
      continue;
    }
    const existing =
      fn.orReplace && catalog.has(fn.key) && !dropped.has(fn.name) && granted.size === 0;
    if (existing) {
      passes.push({
        line: fn.line,
        object: label,
        reason: "re-create of an existing function; its grants are unchanged",
      });
      continue;
    }
    const missing = FN_ROLES.filter((r) => last.get(r) !== "revoke").map((r) =>
      r === "public" ? "PUBLIC" : r,
    );
    const why = dropped.has(fn.name)
      ? " (the file drops and re-creates it, which resets its grants)"
      : "";
    failures.push({
      line: fn.line,
      rule: "function-missing-revoke",
      object: label,
      message: `${label}: no REVOKE EXECUTE ... FROM ${missing.join(", ")} in this file${why}. Add "REVOKE EXECUTE ON FUNCTION public.${fn.key} FROM PUBLIC, anon;", or mark the function "-- Intentionally callable by anon: <flow>".`,
    });
  }

  const TABLE_ROLES = ["anon", "authenticated"];
  for (const table of tables) {
    if (table.temp || !isPublicSchema(table.schema)) continue;
    const label = `${table.schema ?? "public"}.${table.name}`;
    const { last } = replay(
      privs,
      (t) => targetMatchesTable(t, table),
      (p) => p.kind === "table" && (p.all || p.privileges.has("truncate")),
      TABLE_ROLES,
    );
    if (TABLE_ROLES.every((r) => last.get(r) === "revoke")) {
      passes.push({ line: table.line, object: label, reason: "TRUNCATE revoked from anon and authenticated" });
      continue;
    }
    const missing = TABLE_ROLES.filter((r) => last.get(r) !== "revoke");
    failures.push({
      line: table.line,
      rule: "table-missing-truncate-revoke",
      object: label,
      message: `${label}: no REVOKE TRUNCATE ... FROM ${missing.join(", ")} in this file. Add "REVOKE TRUNCATE ON ${label} FROM anon, authenticated;".`,
    });
  }

  return { failures, warnings, passes };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function usage(msg) {
  process.stderr.write(`check-migration-grants: ${msg}\n`);
  process.stderr.write(
    "usage: check-migration-grants.mjs --base <ref> [--json]\n" +
      "       check-migration-grants.mjs --files <a.sql> [...] [--catalog-dir <dir>] [--json]\n",
  );
  process.exit(2);
}

function parseArgs(argv) {
  const opts = { base: null, files: [], catalogDir: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--base") opts.base = argv[++i];
    else if (a === "--catalog-dir") opts.catalogDir = argv[++i];
    else if (a === "--json") opts.json = true;
    else if (a === "--files") {
      while (i + 1 < argv.length && !argv[i + 1].startsWith("--")) opts.files.push(argv[++i]);
    } else usage(`unknown argument: ${a}`);
  }
  if (opts.base === undefined || opts.catalogDir === undefined) usage("missing value");
  if (!opts.base && opts.files.length === 0) usage("give --base <ref> or --files");
  if (opts.base && opts.files.length > 0) usage("--base and --files are exclusive");
  return opts;
}

function loadInputs(opts) {
  if (opts.base) {
    try {
      git(["rev-parse", "--verify", "--quiet", `${opts.base}^{commit}`]);
    } catch {
      usage(`cannot resolve base ref: ${opts.base}`);
    }
    const added = git([
      "diff", "--name-only", "--no-renames", "--diff-filter=A",
      `${opts.base}...HEAD`, "--", `${MIGRATIONS_DIR}/`,
    ])
      .split("\n")
      .filter((f) => f.endsWith(".sql"));
    const files = added.map((path) => ({ path, sql: git(["show", `HEAD:${path}`]) }));
    const baseFiles = git(["ls-tree", "-r", "--name-only", opts.base, "--", `${MIGRATIONS_DIR}/`])
      .split("\n")
      .filter((f) => f.endsWith(".sql"));
    const catalog = buildCatalog(
      sortMigrations(baseFiles).map((f) => git(["show", `${opts.base}:${f}`])),
    );
    return { files, catalog };
  }
  const files = opts.files.map((path) => {
    if (!existsSync(path)) usage(`cannot read ${path}`);
    return { path, sql: readFileSync(path, "utf8") };
  });
  let catalog = new Set();
  if (opts.catalogDir) {
    if (!existsSync(opts.catalogDir)) usage(`cannot read catalog dir ${opts.catalogDir}`);
    const skip = new Set(files.map((f) => basename(f.path)));
    const texts = sortMigrations(
      readdirSync(opts.catalogDir).filter((f) => f.endsWith(".sql") && !skip.has(f)),
    ).map((f) => readFileSync(join(opts.catalogDir, f), "utf8"));
    catalog = buildCatalog(texts);
  }
  return { files, catalog };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { files, catalog } = loadInputs(opts);
  const inCI = process.env.GITHUB_ACTIONS === "true";
  const results = files.map((f) => ({ file: f.path, ...analyzeMigration(f.sql, catalog) }));
  const failCount = results.reduce((s, r) => s + r.failures.length, 0);
  const warnCount = results.reduce((s, r) => s + r.warnings.length, 0);

  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ files: results, failCount, warnCount }, null, 2)}\n`);
  } else if (files.length === 0) {
    process.stdout.write("check-migration-grants: no migration files added. Nothing to check.\n");
  } else {
    for (const r of results) {
      process.stdout.write(`${r.file}\n`);
      for (const p of r.passes) process.stdout.write(`  ok    :${p.line} ${p.object} — ${p.reason}\n`);
      for (const w of r.warnings) {
        process.stdout.write(`  WARN  :${w.line} ${w.message}\n`);
        if (inCI) process.stdout.write(`::warning file=${r.file},line=${w.line},title=Migration Grants::${w.message}\n`);
      }
      for (const f of r.failures) {
        process.stdout.write(`  FAIL  :${f.line} ${f.message}\n`);
        if (inCI) process.stdout.write(`::error file=${r.file},line=${f.line},title=Migration Grants::${f.message}\n`);
      }
    }
    process.stdout.write(
      `\ncheck-migration-grants: ${files.length} file(s), ${failCount} failure(s), ${warnCount} warning(s).\n`,
    );
  }
  process.exit(failCount > 0 ? 1 : 0);
}

const isMain =
  process.argv[1] !== undefined && process.argv[1].endsWith("check-migration-grants.mjs");
if (isMain) main();
