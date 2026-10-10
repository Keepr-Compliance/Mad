"""Write a mutant of the 3862 migration. Exact-string replace; exits 2 if the
pattern does not occur exactly once, so an unapplied mutation cannot pass as
a run. Usage: python3 mutate.py <migration> <mutant> <out>"""
import sys
src = open(sys.argv[1]).read()
UPDATE = src[src.index("UPDATE public.credit_pricing_tiers"):src.index("-- Open one flat band")]
INSERT = src[src.index("INSERT INTO public.credit_pricing_tiers"):src.index("-- Fail the migration")]
DO = src[src.index("DO $$"):]
GUARD = """
 WHERE NOT EXISTS (SELECT 1 FROM public.credit_pricing_tiers
                    WHERE scope = 'individual' AND effective_to IS NULL);"""
M = {
  "no_insert": [(INSERT, "")],
  "no_update": [(UPDATE, "")],
  "reprice":   [("   SET effective_to = now()\n", "   SET unit_price_cents = 1499\n")],
  "no_guard":  [(GUARD, ";")],
}
name = sys.argv[2]
nodo = name.endswith("+nodo")
reps = list(M[name.removesuffix("+nodo")]) + ([(DO, "")] if nodo else [])
out = src
for old, new in reps:
    if out.count(old) != 1:
        print(f"MUTATION NOT APPLIED: pattern occurs {out.count(old)} times"); sys.exit(2)
    out = out.replace(old, new)
if out == src:
    print("MUTATION NOT APPLIED: no change"); sys.exit(2)
open(sys.argv[3], "w").write(out)
