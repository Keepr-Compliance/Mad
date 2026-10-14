#!/usr/bin/env bash
# BACKLOG-3473 offline gate control (added by BACKLOG-3945). A stand-in for psql
# that answers run.sh gate's queries without a database, so the SHIPPED gate code
# can be run against a captured catalogue:
#
#   CAPTURE=<file of key|value lines> PSQL="$PWD/lib/stub-psql.sh" \
#     bash run.sh 'postgres://postgres@127.0.0.1/x' gate
#
# CAPTURE = the output of lib/gate-catalog.sql (one key|value per line). The
# expected pins themselves (`grep -v '^#' lib/gate-expected.txt`) must gate
# clean; one changed value must mismatch; one added key must be UNKNOWN.
# Serves the gate command only; any other command gets a placeholder line.
set -euo pipefail
: "${CAPTURE:?set CAPTURE to a gate-catalog.sql output file}"
for a in "$@"; do case "$a" in *gate-catalog.sql) cat "$CAPTURE"; exit 0 ;; esac; done
for a in "$@"; do case "$a" in
  *server_version_num*) echo 150000; exit 0 ;;
  "select current_user") echo postgres; exit 0 ;;
esac; done
echo "stub-line"
