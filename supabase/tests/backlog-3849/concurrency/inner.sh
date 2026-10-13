#!/usr/bin/env bash
# Runs INSIDE the Postgres container (both sessions local, no ssh latency between them).
# $1 = database name. Prints one result line per test and variant.
set -u
DB="$1"
P() { psql -U postgres -d "$DB" -X -q -tA -v ON_ERROR_STOP=1 "$@"; }
ROW() {
  P -c "TRUNCATE billing_outbox" \
    -c "INSERT INTO billing_outbox (stripe_mode, kind, organization_id, dedupe_key, run_after) VALUES ('live','fx',gen_random_uuid(),'k1',now()-interval '1 minute')"
}

# S1 + S2: A holds its claim transaction 3 s; B starts 1 s in (inside A's open
# transaction); C runs after both commit (a drain one minute later, lease live).
for fn in orig nolock noskip nolease; do
  ROW
  ( P -c "BEGIN" -c "SELECT 'A='||count(*) FROM claim_$fn('live',10)" -c "SELECT pg_sleep(3)" -c "COMMIT" > /tmp/t3849_a.out ) &
  sleep 1
  B=$(P -c "SELECT 'B='||count(*)||' waited_s='||round(extract(epoch from clock_timestamp()-now())::numeric,2) FROM (SELECT 1 FROM claim_$fn('live',10)) q")
  wait
  C=$(P -c "SELECT 'C='||count(*) FROM claim_$fn('live',10)")
  echo "S1S2|$fn|$(tr -d '\n' < /tmp/t3849_a.out)|$B|$C|attempts=$(P -c 'SELECT attempts FROM billing_outbox')"
done

# S3: one due test row and one due live row; a live claim.
for fn in orig nomode; do
  P -c "TRUNCATE billing_outbox" \
    -c "INSERT INTO billing_outbox (stripe_mode, kind, organization_id, dedupe_key, run_after) VALUES ('test','fx',gen_random_uuid(),'t1',now()-interval '1 minute'),('live','fx',gen_random_uuid(),'l1',now()-interval '1 minute')"
  echo "S3|$fn|modes=$(P -c "SELECT coalesce(string_agg(stripe_mode,',' ORDER BY stripe_mode),'none') FROM claim_$fn('live',10)")"
done

# Parked row: run_after = infinity is never claimed (drain parks rows this way).
P -c "TRUNCATE billing_outbox" \
  -c "INSERT INTO billing_outbox (stripe_mode, kind, organization_id, dedupe_key, run_after, attempts) VALUES ('live','fx',gen_random_uuid(),'p1','infinity',8)"
echo "PARK|orig|claimed=$(P -c "SELECT count(*) FROM claim_orig('live',10)")"

# The drain's guarded write: W1 claims, lease expires, W2 re-claims, W1 writes late.
ROW
W1=$(P -c "SELECT attempts FROM claim_orig('live',10)")
P -c "UPDATE billing_outbox SET claimed_until = now()-interval '1 second'"
W2=$(P -c "SELECT attempts FROM claim_orig('live',10)")
G=$(P -c "WITH u AS (UPDATE billing_outbox SET processed_at=now() WHERE dedupe_key='k1' AND attempts=$W1 RETURNING 1) SELECT count(*) FROM u")
echo "GUARD|orig|w1=$W1|w2=$W2|late_guarded_rows=$G"

# The claim itself has no try cap (why the drain parks at claim, R4).
P -c "TRUNCATE billing_outbox" \
  -c "INSERT INTO billing_outbox (stripe_mode, kind, organization_id, dedupe_key, run_after, attempts, claimed_until) VALUES ('live','fx',gen_random_uuid(),'c1',now()-interval '1 minute',8,now()-interval '1 second')"
echo "CAP|orig|claimed_attempts=$(P -c "SELECT attempts FROM claim_orig('live',10)")"
