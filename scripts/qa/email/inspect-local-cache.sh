#!/usr/bin/env bash
# Inspect Keepr's local cache for an email account during BACKLOG-1722 QA.
#
# Usage:
#   scripts/qa/email/inspect-local-cache.sh <email-address>
#
# Reports:
#   - total emails synced + direction breakdown
#   - email_participants row count
#   - per-address participant counts
#   - cross-check: sender vs participants (catches drops)
#
# Notes:
# - The Keepr DB is encrypted with SQLCipher. This script assumes a *decrypted
#   plaintext copy* at $KEEPR_QA_DB (default
#   ~/.keepr-qa/keepr-decrypted.db). Decrypt once with:
#     sqlcipher /path/to/encrypted.db \
#       "PRAGMA key='<your-key>'; \
#        PRAGMA cipher_compatibility=4; \
#        ATTACH DATABASE '/tmp/keepr-decrypted.db' AS plain KEY ''; \
#        SELECT sqlcipher_export('plain'); DETACH plain;"
# - Read-only; never writes to the DB.

set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <email-address>" >&2
  exit 2
fi

ADDR="$1"
LOWER="$(printf '%s' "$ADDR" | tr '[:upper:]' '[:lower:]')"
DB="${KEEPR_QA_DB:-$HOME/.keepr-qa/keepr-decrypted.db}"

if [[ ! -f "$DB" ]]; then
  echo "Decrypted DB not found at $DB" >&2
  echo "Set KEEPR_QA_DB or decrypt the Keepr DB first (see header)." >&2
  exit 1
fi

echo "=== Inspect local cache for: $ADDR (lowercased: $LOWER) ==="
echo "DB: $DB"
echo

echo "--- Total emails synced ---"
sqlite3 "$DB" "SELECT COUNT(*) FROM emails;"
echo

echo "--- Emails by direction ---"
sqlite3 -header -column "$DB" \
  "SELECT direction, COUNT(*) AS count FROM emails GROUP BY direction;"
echo

echo "--- email_participants row count ---"
sqlite3 "$DB" "SELECT COUNT(*) FROM email_participants;"
echo

echo "--- Participants involving $LOWER, by role ---"
sqlite3 -header -column "$DB" \
  "SELECT role, COUNT(*) AS count
     FROM email_participants
    WHERE email_address = '$LOWER'
    GROUP BY role
    ORDER BY role;"
echo

echo "--- Top-20 participants by total appearance ---"
sqlite3 -header -column "$DB" \
  "SELECT email_address, COUNT(*) AS appearances
     FROM email_participants
    GROUP BY email_address
    ORDER BY appearances DESC
    LIMIT 20;"
echo

echo "--- Cross-check: sender LIKE vs junction exact for $LOWER ---"
echo "(post-BACKLOG-1722, junction should be >= sender — junction also covers To/Cc/Bcc)"
sqlite3 -header -column "$DB" "
  SELECT
    (SELECT COUNT(*) FROM emails WHERE LOWER(sender) LIKE '%$LOWER%')
      AS legacy_sender_like,
    (SELECT COUNT(DISTINCT email_id) FROM email_participants WHERE email_address = '$LOWER' AND role = 'from')
      AS junction_from_exact,
    (SELECT COUNT(DISTINCT email_id) FROM email_participants WHERE email_address = '$LOWER')
      AS junction_any_role;
"
echo

echo "--- Sample 10 emails where $LOWER appears as BCC only (G3 / BACKLOG-1550) ---"
sqlite3 -header -column "$DB" "
  SELECT e.id, substr(e.subject, 1, 60) AS subject_short, e.sent_at
    FROM email_participants ep
    JOIN emails e ON e.id = ep.email_id
   WHERE ep.email_address = '$LOWER'
     AND ep.role = 'bcc'
     AND e.id NOT IN (
       SELECT email_id FROM email_participants
        WHERE email_address = '$LOWER' AND role IN ('from', 'to', 'cc')
     )
   ORDER BY e.sent_at DESC
   LIMIT 10;
"

echo
echo "=== Done ==="
