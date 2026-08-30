/**
 * @file Structural schema fingerprint + diff — shared comparison machinery.
 *
 * Extracted verbatim from `databaseService.schema-parity.test.ts` (BACKLOG-1770)
 * for BACKLOG-2993, so that the schema-baseline GENERATOR
 * (`generateSchemaBaseline.gen.ts`) and the parity CONTROL
 * (`databaseService.schema-parity.test.ts`) compare schemas through the SAME
 * code path. If the extraction and the comparison shared nothing, a
 * normalization bug could mask a real divergence in one direction only.
 *
 * COMPARISON METHOD (structural, not raw-CREATE-text — the latter is brittle
 * against whitespace / quoting / IF NOT EXISTS / column re-ordering):
 *   tables   : set membership + per-column PRAGMA table_info
 *              (name, type, notnull, dflt_value, pk) + PRAGMA foreign_key_list
 *   indexes  : PRAGMA index_list (unique, origin, partial) + PRAGMA index_info
 *   triggers : sqlite_master name + whitespace-normalized body
 *   views    : sqlite_master name + whitespace-normalized body
 */

export interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

export interface ForeignKeyInfo {
  table: string;
  from: string;
  to: string | null;
  on_update: string;
  on_delete: string;
  match: string;
}

export interface TableInfo {
  columns: ColumnInfo[];
  foreignKeys: ForeignKeyInfo[];
}

export interface IndexInfo {
  table: string;
  unique: number;
  origin: string;
  partial: number;
  columns: string[];
}

export interface SchemaFingerprint {
  tables: Record<string, TableInfo>;
  indexes: Record<string, IndexInfo>;
  triggers: Record<string, string>;
  views: Record<string, string>;
}

export interface Divergence {
  key: string;
  detail: string;
}

/** Collapse all whitespace runs to a single space, drop IF NOT EXISTS, trim. */
export function normalizeSql(sql: string | null): string {
  if (!sql) return "";
  return sql
    .replace(/if\s+not\s+exists/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function extractFingerprint(db: any): SchemaFingerprint {
  const tableNames = (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>
  ).map((r) => r.name);

  const tables: Record<string, TableInfo> = {};
  const indexes: Record<string, IndexInfo> = {};

  for (const t of tableNames) {
    const columns = (
      db.prepare(`PRAGMA table_info("${t}")`).all() as Array<{
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
        pk: number;
      }>
    ).map((c) => ({
      name: c.name,
      type: c.type,
      notnull: c.notnull,
      dflt_value: c.dflt_value,
      pk: c.pk,
    }));

    const foreignKeys = (
      db.prepare(`PRAGMA foreign_key_list("${t}")`).all() as Array<{
        table: string;
        from: string;
        to: string | null;
        on_update: string;
        on_delete: string;
        match: string;
      }>
    )
      .map((f) => ({
        table: f.table,
        from: f.from,
        to: f.to,
        on_update: f.on_update,
        on_delete: f.on_delete,
        match: f.match,
      }))
      // Deterministic order — PRAGMA order is not guaranteed stable.
      .sort((a, b) =>
        `${a.table}.${a.from}.${a.to}`.localeCompare(`${b.table}.${b.from}.${b.to}`),
      );

    tables[t] = { columns, foreignKeys };

    const idxList = db.prepare(`PRAGMA index_list("${t}")`).all() as Array<{
      name: string;
      unique: number;
      origin: string;
      partial: number;
    }>;
    for (const idx of idxList) {
      const cols = (
        db.prepare(`PRAGMA index_info("${idx.name}")`).all() as Array<{
          name: string | null;
        }>
      ).map((i) => i.name ?? "<expr>");
      indexes[idx.name] = {
        table: t,
        unique: idx.unique,
        origin: idx.origin,
        partial: idx.partial,
        columns: cols,
      };
    }
  }

  const triggers: Record<string, string> = {};
  (
    db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type='trigger'")
      .all() as Array<{ name: string; sql: string | null }>
  ).forEach((r: { name: string; sql: string | null }) => {
    triggers[r.name] = normalizeSql(r.sql);
  });

  const views: Record<string, string> = {};
  (
    db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type='view'")
      .all() as Array<{ name: string; sql: string | null }>
  ).forEach((r: { name: string; sql: string | null }) => {
    views[r.name] = normalizeSql(r.sql);
  });

  return { tables, indexes, triggers, views };
}

/**
 * Diff two fingerprints. `labelA` / `labelB` name the two sides in the emitted
 * detail strings (e.g. "FRESH(schema.sql)" vs "FROZEN(chain-v69 transcript)").
 * Divergence KEYS are label-independent so allowlists survive a relabel.
 */
export function diffFingerprints(
  a: SchemaFingerprint,
  b: SchemaFingerprint,
  labelA: string,
  labelB: string,
): Divergence[] {
  const out: Divergence[] = [];

  // ---- Tables ----
  const allTables = new Set([...Object.keys(a.tables), ...Object.keys(b.tables)]);
  for (const t of [...allTables].sort()) {
    const ta = a.tables[t];
    const tb = b.tables[t];
    if (ta && !tb) {
      out.push({
        key: `TABLE:${t}`,
        detail: `table "${t}" present in ${labelA} but MISSING in ${labelB}`,
      });
      continue;
    }
    if (!ta && tb) {
      out.push({
        key: `TABLE:${t}`,
        detail: `table "${t}" present in ${labelB} but MISSING in ${labelA}`,
      });
      continue;
    }
    if (!ta || !tb) continue;

    // Columns (keyed by name so ordering never causes false positives)
    const aCols = new Map(ta.columns.map((c) => [c.name, c]));
    const bCols = new Map(tb.columns.map((c) => [c.name, c]));
    for (const name of new Set([...aCols.keys(), ...bCols.keys()])) {
      const ca = aCols.get(name);
      const cb = bCols.get(name);
      if (ca && !cb) {
        out.push({
          key: `COLUMN:${t}.${name}`,
          detail: `column "${t}.${name}" present in ${labelA} but MISSING in ${labelB}`,
        });
        continue;
      }
      if (!ca && cb) {
        out.push({
          key: `COLUMN:${t}.${name}`,
          detail: `column "${t}.${name}" present in ${labelB} but MISSING in ${labelA}`,
        });
        continue;
      }
      if (!ca || !cb) continue;
      const attrs: Array<keyof ColumnInfo> = ["type", "notnull", "dflt_value", "pk"];
      for (const attr of attrs) {
        if (String(ca[attr]) !== String(cb[attr])) {
          out.push({
            key: `COLUMN:${t}.${name}#${attr}`,
            detail:
              `column "${t}.${name}" ${attr} differs: ${labelA}=${JSON.stringify(ca[attr])} ` +
              `${labelB}=${JSON.stringify(cb[attr])}`,
          });
        }
      }
    }

    // Foreign keys (compared as normalized sorted tuples)
    const fkStr = (fks: ForeignKeyInfo[]) =>
      fks
        .map(
          (f) =>
            `${f.from}->${f.table}.${f.to} onUpd=${f.on_update} onDel=${f.on_delete} match=${f.match}`,
        )
        .join(" | ");
    const aFk = fkStr(ta.foreignKeys);
    const bFk = fkStr(tb.foreignKeys);
    if (aFk !== bFk) {
      out.push({
        key: `FK:${t}`,
        detail: `foreign keys for "${t}" differ:\n      ${labelA}:   [${aFk}]\n      ${labelB}: [${bFk}]`,
      });
    }
  }

  // ---- Indexes ----
  const allIdx = new Set([...Object.keys(a.indexes), ...Object.keys(b.indexes)]);
  for (const name of [...allIdx].sort()) {
    const ia = a.indexes[name];
    const ib = b.indexes[name];
    if (ia && !ib) {
      out.push({
        key: `INDEX:${name}`,
        detail: `index "${name}" (on ${ia.table}) present in ${labelA} but MISSING in ${labelB}`,
      });
      continue;
    }
    if (!ia && ib) {
      out.push({
        key: `INDEX:${name}`,
        detail: `index "${name}" (on ${ib.table}) present in ${labelB} but MISSING in ${labelA}`,
      });
      continue;
    }
    if (!ia || !ib) continue;
    const aSig = `${ia.table} unique=${ia.unique} origin=${ia.origin} partial=${ia.partial} cols=[${ia.columns.join(",")}]`;
    const bSig = `${ib.table} unique=${ib.unique} origin=${ib.origin} partial=${ib.partial} cols=[${ib.columns.join(",")}]`;
    if (aSig !== bSig) {
      out.push({
        key: `INDEX:${name}#shape`,
        detail: `index "${name}" shape differs:\n      ${labelA}:   ${aSig}\n      ${labelB}: ${bSig}`,
      });
    }
  }

  // ---- Triggers ----
  const allTrig = new Set([...Object.keys(a.triggers), ...Object.keys(b.triggers)]);
  for (const name of [...allTrig].sort()) {
    const ba = a.triggers[name];
    const bb = b.triggers[name];
    if (ba === undefined && bb !== undefined) {
      out.push({
        key: `TRIGGER:${name}`,
        detail: `trigger "${name}" present in ${labelB} but MISSING in ${labelA}`,
      });
      continue;
    }
    if (ba !== undefined && bb === undefined) {
      out.push({
        key: `TRIGGER:${name}`,
        detail: `trigger "${name}" present in ${labelA} but MISSING in ${labelB}`,
      });
      continue;
    }
    if (ba !== bb) {
      out.push({
        key: `TRIGGER:${name}#body`,
        detail: `trigger "${name}" body differs:\n      ${labelA}:   ${ba}\n      ${labelB}: ${bb}`,
      });
    }
  }

  // ---- Views ----
  const allView = new Set([...Object.keys(a.views), ...Object.keys(b.views)]);
  for (const name of [...allView].sort()) {
    const va = a.views[name];
    const vb = b.views[name];
    if (va === undefined && vb !== undefined) {
      out.push({
        key: `VIEW:${name}`,
        detail: `view "${name}" present in ${labelB} but MISSING in ${labelA}`,
      });
      continue;
    }
    if (va !== undefined && vb === undefined) {
      out.push({
        key: `VIEW:${name}`,
        detail: `view "${name}" present in ${labelA} but MISSING in ${labelB}`,
      });
      continue;
    }
    if (va !== vb) {
      out.push({
        key: `VIEW:${name}#body`,
        detail: `view "${name}" body differs:\n      ${labelA}:   ${va}\n      ${labelB}: ${vb}`,
      });
    }
  }

  return out;
}
