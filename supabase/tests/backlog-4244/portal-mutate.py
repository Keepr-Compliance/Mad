#!/usr/bin/env python3
"""BACKLOG-4244: mutants of the portal code, each checked against the jest suites that should catch it.

Usage: portal-mutate.py [mode ...]   (no mode: all)

Each mutant is an exact-string replace in one file; it stops when the fragment does not match exactly
once. The script prints MUTATION APPLIED and the changed line, runs the named suites with --json, prints
the failed and total test counts, restores the file from the text it read, and checks the tree is clean.
Commit first.
"""
import os, re, subprocess, sys

here = os.path.dirname(os.path.abspath(__file__))
root = subprocess.check_output(['git', '-C', here, 'rev-parse', '--show-toplevel'], text=True).strip()
BP = 'broker-portal/'
DT = BP + '__tests__/mcp/data-tools.test.ts'
PAR = BP + '__tests__/mcp/data-tools-parity.test.ts'
ROUTE = BP + '__tests__/mcp/route.test.ts'

MUTANTS = [
    ('C32_schema_requires_missing_key', BP + 'lib/mcp/tools/shapes.ts',
     "        required: Object.keys(s.props),", "        required: [...Object.keys(s.props), 'zz_missing'],", [DT]),
    ('C17_extra_keys_accepted', BP + 'lib/mcp/tools/shapes.ts',
     "      if (Object.keys(v).length !== keys.length) return false;\n", "", [DT]),
    ('C17_types_not_checked', BP + 'lib/mcp/tools/shapes.ts',
     "      return typeof v === 'number' && Number.isInteger(v) && (!s.values || s.values.includes(v));",
     "      return true;", [DT]),
    ('C10_limit_not_checked_in_node', BP + 'lib/mcp/tools/deals.ts',
     "    limit = optInteger(o, 'limit', 1, 50);", "    limit = optInteger(o, 'limit', 1, 1000);", [DT]),
    ('C10_unknown_argument_accepted', BP + 'lib/mcp/tools/result.ts',
     "    if (!allowed.includes(k)) throw new InvalidInput();\n", "", [DT]),
    ('C39_arguments_required', BP + 'lib/mcp/tools/result.ts',
     "  if (raw === undefined || raw === null) return {};", "  if (raw === undefined || raw === null) throw new InvalidInput();", [DT]),
    ('C16_transport_reads_as_empty_list', BP + 'lib/mcp/tools/result.ts',
     "  return toolError(TOOL_MESSAGES.unavailable);\n}\n\n/** Config and digest",
     "  return toolResult({ deals: [] });\n}\n\n/** Config and digest", [DT]),
    ('C11_no_size_cap', BP + 'lib/mcp/tools/result.ts',
     "  if (text.length > MAX_RESULT_CHARS) return toolError(TOOL_MESSAGES.too_large);\n", "", [DT]),
    ('C13_result_logged', BP + 'lib/mcp/tools/result.ts',
     "  const text = JSON.stringify(result);\n", "  const text = JSON.stringify(result);\n  console.info('[mcp] result', text);\n", [DT]),
    ('C18_description_word_changed', BP + 'lib/mcp/tools/text.ts',
     "most recently saved first", "newest first", [DT]),
    ('C19_read_only_hint_dropped', BP + 'lib/mcp/tools/result.ts',
     "  readOnlyHint: true,\n", "", [DT, ROUTE]),
    ('OUT_schema_forbids_extra_keys', BP + 'lib/mcp/tools/shapes.ts',
     "        required: Object.keys(s.props),", "        required: Object.keys(s.props),\n        additionalProperties: false,", [DT]),
    ('OUT_saved_from_not_nullable', BP + 'lib/mcp/tools/shapes.ts',
     "  saved_from: int(true),", "  saved_from: int(),", [DT]),
    ('C15_parameter_renamed', BP + 'lib/mcp/oauth/rpc.ts',
     "    p_deal_id: a.dealId,\n    p_only_open", "    p_deal: a.dealId,\n    p_only_open", [PAR]),
    ('C24_details_key_dropped', BP + 'lib/mcp/tools/shapes.ts',
     "  export_status: str(true),\n};", "};", [PAR, DT]),
    ('C24_phone_key_renamed', BP + 'lib/mcp/tools/shapes.ts',
     "export const PHONE_PROPS = { e164: str(true),", "export const PHONE_PROPS = { phone: str(true),", [PAR, DT]),
]


def run_jest(files):
    """(failed, total) from jest's summary line ("Tests: <n> failed, <m> passed, <t> total")"""
    r = subprocess.run(['npx', 'jest', '--config', 'broker-portal/jest.config.js', '--silent'] + files,
                       cwd=root, capture_output=True, text=True)
    out = r.stdout + '\n' + r.stderr
    m = re.search(r'^Tests:\s+(.*?)(\d+) total$', out, re.M)
    if not m:
        raise SystemExit('no jest summary: ' + out[-800:])
    f = re.search(r'(\d+) failed', m.group(1))
    return (int(f.group(1)) if f else 0), int(m.group(2))


def main():
    want = set(sys.argv[1:])
    if subprocess.run(['git', '-C', root, 'status', '--porcelain', '--', 'broker-portal/lib', 'broker-portal/__tests__'],
                      capture_output=True, text=True).stdout.strip():
        raise SystemExit('commit first: broker-portal has uncommitted changes')
    rows = []
    for mode, path, old, new, files in MUTANTS:
        if want and mode not in want:
            continue
        p = os.path.join(root, path)
        text = open(p).read()
        n = text.count(old)
        if n != 1:
            raise SystemExit('MUTATION NOT APPLIED %s: fragment matched %d times' % (mode, n))
        open(p, 'w').write(text.replace(old, new))
        print('MUTATION APPLIED %s %s\n  - %s\n  + %s' % (mode, path, old.strip()[:140], new.strip()[:140]))
        try:
            failed, total = run_jest(files)
        finally:
            open(p, 'w').write(text)
        print('  -> failed=%d total=%d %s' % (failed, total, 'RED' if failed and total else 'STAYED GREEN'))
        rows.append((mode, failed, total))
    dirty = subprocess.run(['git', '-C', root, 'status', '--porcelain', '--', 'broker-portal/lib', 'broker-portal/__tests__'],
                           capture_output=True, text=True).stdout.strip()
    print('restored: ' + ('NO, tree dirty:\n' + dirty if dirty else 'yes, tree clean'))
    base = run_jest([DT, PAR, ROUTE])
    print('after restore: failed=%d total=%d' % base)
    missed = [r for r in rows if not (r[1] and r[2])]
    print('MUTANTS red=%d stayed_green=%d' % (len(rows) - len(missed), len(missed)))
    sys.exit(1 if missed or dirty or base[0] or not base[1] else 0)


main()
