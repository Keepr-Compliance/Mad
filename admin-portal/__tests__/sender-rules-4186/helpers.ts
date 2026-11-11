/**
 * BACKLOG-4186 PR B test helpers: the 4175 corpus and a recording fake of the Supabase rpc client.
 */
import fs from 'fs';
import path from 'path';

import type { RpcClient, RpcError } from '@/lib/sender-rules/api';
import type { SenderRuleSet } from '@/lib/sender-rules/types';

export interface CorpusCase {
  name: string;
  content: unknown;
  /** The desktop Zod schema's answer. */
  zod: boolean;
  /** The SQL validator's answer (recorded by the 4175 keepr-test harness). */
  sql: boolean;
}

/** supabase/tests/backlog-4175/corpus.json, resolved from this file (never from the cwd). */
export const CORPUS_PATH = path.resolve(__dirname, '../../../supabase/tests/backlog-4175/corpus.json');

export function loadCorpus(): CorpusCase[] {
  return JSON.parse(fs.readFileSync(CORPUS_PATH, 'utf8')) as CorpusCase[];
}

/** The bundled v1 rule set: the corpus's "bundled" case (= the 4175 seed). A fresh copy. */
export function bundled(): SenderRuleSet {
  const c = loadCorpus().find((x) => x.name === 'bundled');
  if (!c) throw new Error('corpus has no "bundled" case');
  return JSON.parse(JSON.stringify(c.content)) as SenderRuleSet;
}

export function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

export interface RpcCall {
  fn: string;
  args: Record<string, unknown> | undefined;
  /** The args as supabase-js sends them: JSON.stringify drops an undefined key. */
  wire: Record<string, unknown> | undefined;
}

type Answer = { data?: unknown; error?: RpcError | null };

/** A fake client: answers per function name (a value or a function of the args), records every call. */
export function fakeClient(answers: Record<string, Answer | ((args: Record<string, unknown> | undefined) => Answer)> = {}) {
  const calls: RpcCall[] = [];
  const client: RpcClient = {
    rpc(fn, args) {
      calls.push({ fn, args, wire: args === undefined ? undefined : JSON.parse(JSON.stringify(args)) });
      const a = answers[fn];
      const ans = typeof a === 'function' ? a(args) : a ?? {};
      return Promise.resolve({ data: ans.data ?? null, error: ans.error ?? null });
    },
  };
  return { client, calls };
}
