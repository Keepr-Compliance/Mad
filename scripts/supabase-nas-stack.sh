#!/usr/bin/env bash
# Persistent Supabase test stack on the NAS (BACKLOG-3114).
#
# WHAT IT IS
#   A Postgres 17.6 + auth + PostgREST + storage + Studio stack running on the
#   NAS, holding PRODUCTION'S `public` SCHEMA as of 2026-09-05 (68 tables /
#   129 policies / 26 triggers / 177 functions) plus the migrations production
#   has not run yet. Schema only -- no production rows. It is where a plpgsql
#   change gets EXECUTED instead of grepped: before this, migration tests parsed
#   SQL text and a two-session concurrency test had nowhere to run.
#
# HOW AN AGENT CONNECTS
#   Nothing. Run `./scripts/supabase-nas-stack.sh controls` and it works.
#
#   The stack's ports are published on the NAS's TAILNET address only, so the
#   database is reachable from any machine on the tailnet and from nowhere else
#   -- not from the home LAN, not from the internet. There is no ssh in the data
#   path, no port forward, no Touch ID prompt, and nothing to start first.
#
#   Two local files carry what must not be in a public repo. Both are outside
#   the repo tree, mode 600, and both have env-var overrides:
#       ~/.keepr/nas-tailnet-ip    the NAS's tailnet address   ($NAS_TAILNET_IP)
#       ~/.keepr/keepr_agent_pw    the keepr_agent password    ($KEEPR_AGENT_PW_FILE)
#   If either is missing this script refuses with the command that creates it.
#
# WHO IT CONNECTS AS
#   `keepr_agent` -- LOGIN, BYPASSRLS, and NOSUPERUSER / NOCREATEDB /
#   NOCREATEROLE / NOREPLICATION. It holds DML on exactly the four tables the
#   BACKLOG-3096 controls touch and EXECUTE on the one function under test.
#   `DROP TABLE`, `CREATE TABLE`, `CREATE ROLE`, `CREATE DATABASE`,
#   `ALTER TABLE ... DISABLE ROW LEVEL SECURITY` and `COPY ... TO PROGRAM` are
#   all refused -- see BACKLOG-3114 for the measured board.
#
#   BYPASSRLS is deliberate and is not a way around least privilege. Every
#   policy on these tables keys on `auth.uid()`, which is NULL for a direct
#   login role, so without it the fixtures cannot be seeded at all (measured:
#   `new row violates row-level security policy for table "users"`). The old
#   `postgres` connection had the same effect for free -- it owns the tables,
#   and an owner bypasses RLS unless FORCE is set. This makes that explicit
#   instead of implicit, and drops superuser along the way.
#
#   `up` still authenticates as the stack's own `postgres` role: the Supabase
#   CLI owns those containers and manages that credential itself.
#
# WHAT DOES NOT WORK: `supabase migration up`
#   The repo's 151 migration files carry only 63 distinct versions (the CLI keys
#   history by the leading digits, so the 15 files named 20260313_* are one
#   version). `up` refuses this directory in both reachable states -- see
#   BACKLOG-3114 for the two measured failures, and BACKLOG-3126 for the
#   reconciliation. Apply new migrations with `psql -v ON_ERROR_STOP=1 -f <file>`
#   and insert the history row by hand.
#
# NEVER point any of this at production. Every command takes an explicit
# --db-url or a psql URL; none uses --linked.
set -euo pipefail

NAS_SSH_ALIAS="${NAS_SSH_ALIAS:-ugreen}"          # ssh alias; CONTROL PLANE ONLY
EXPECT_DOCKER_HOST="ssh://${NAS_SSH_ALIAS}"
PROJECT_ID="${SUPABASE_PROJECT_ID:-keepr-test}"
NETWORK="supabase_network_${PROJECT_ID}"

DB_PORT=54322
STACK_PORTS="54321 ${DB_PORT} 54323 54324"        # api, db, studio, inbucket

DB_USER="${KEEPR_DB_USER:-keepr_agent}"
KEEPR_AGENT_PW_FILE="${KEEPR_AGENT_PW_FILE:-$HOME/.keepr/keepr_agent_pw}"
NAS_TAILNET_IP_FILE="${NAS_TAILNET_IP_FILE:-$HOME/.keepr/nas-tailnet-ip}"

BASELINE="${BASELINE:-$HOME/.keepr/db-baseline/baseline-2026-09-05.sql}"
PSQL="${PSQL:-/opt/homebrew/opt/libpq/bin/psql}"  # brew install libpq
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# The NAS cluster's Postgres system identifier, read from the stack itself on
# 2026-09-05. It is what proves the database on the other end is THE stack and
# not some other Postgres that happens to answer.
EXPECT_SYSID="${NAS_DB_SYSID:-7682178635586883628}"

# A dead route should fail in seconds, not hang on a TCP timeout.
export PGCONNECT_TIMEOUT="${PGCONNECT_TIMEOUT:-15}"

# Never echo a connection string: if anyone overrides it with a real password it
# would land in stderr and in any captured log.
redact() { sed -E 's#://[^@/]*@#://***:***@#g' <<<"$1"; }

# ---------------------------------------------------------------------------
# Address and credential resolution. No literal of either is in this file.
# ---------------------------------------------------------------------------

# Tailscale hands out addresses from the CGNAT range 100.64.0.0/10. Checking the
# RANGE rather than a value keeps the guard structural: a LAN address, a public
# address or a typo is refused, and nothing identifying is written down.
resolve_tailnet_ip() {
  local ip="${NAS_TAILNET_IP:-}"
  if [ -z "$ip" ] && [ -r "$NAS_TAILNET_IP_FILE" ]; then
    ip="$(tr -d '[:space:]' < "$NAS_TAILNET_IP_FILE")"
  fi
  if [ -z "$ip" ]; then
    echo "REFUSING: the NAS's tailnet address is not configured." >&2
    echo "  Set NAS_TAILNET_IP, or write it once (mode 600):" >&2
    echo "    mkdir -p ~/.keepr && umask 077 && \\" >&2
    echo "      ssh ${NAS_SSH_ALIAS} 'docker exec tailscale tailscale ip -4' \\" >&2
    echo "      | tr -d '[:space:]' > ${NAS_TAILNET_IP_FILE}" >&2
    exit 1
  fi
  if ! [[ "$ip" =~ ^100\.(6[4-9]|[7-9][0-9]|1[0-1][0-9]|12[0-7])\.[0-9]{1,3}\.[0-9]{1,3}$ ]]; then
    echo "REFUSING: '${ip}' is not in Tailscale's 100.64.0.0/10 range." >&2
    echo "  This stack is reachable over the tailnet only. A LAN address here" >&2
    echo "  means something is published where it should not be." >&2
    exit 1
  fi
  NAS_TAILNET_IP="$ip"
}

# The password goes into PGPASSWORD, never into the URL: control-5-run.sh hands
# the URL to psql on the ARGV, where `ps` would show it to every user on the box.
resolve_db_url() {
  resolve_tailnet_ip
  # Env first (a 1Password-mounted environment can supply KEEPR_AGENT_PW
  # directly), then the file. Same order as the tailnet address.
  if [ -n "${KEEPR_AGENT_PW:-}" ]; then
    PGPASSWORD="$KEEPR_AGENT_PW"
    export PGPASSWORD
    DB_URL="${DATABASE_URL:-postgresql://${DB_USER}@${NAS_TAILNET_IP}:${DB_PORT}/postgres}"
    return 0
  fi
  if [ ! -r "$KEEPR_AGENT_PW_FILE" ]; then
    echo "REFUSING: no ${DB_USER} password in \$KEEPR_AGENT_PW or ${KEEPR_AGENT_PW_FILE}." >&2
    echo "  It is held in 1Password. Restore it with (mode 600):" >&2
    echo "    mkdir -p ~/.keepr && umask 077 && \\" >&2
    echo "      op read 'op://<vault>/keepr_agent NAS test stack/password' \\" >&2
    echo "      > ${KEEPR_AGENT_PW_FILE}" >&2
    exit 1
  fi
  PGPASSWORD="$(tr -d '\n' < "$KEEPR_AGENT_PW_FILE")"
  export PGPASSWORD
  DB_URL="${DATABASE_URL:-postgresql://${DB_USER}@${NAS_TAILNET_IP}:${DB_PORT}/postgres}"
}

# `baseline` loads production's schema dump, which only the schema owner can do.
# "postgres" is the Supabase CLI's fixed default for a local stack -- it is not a
# secret and the CLI would reject any other value. What keeps it safe is that
# the port is published on the tailnet only; see the Tailscale ACL on the item.
resolve_admin_url() {
  resolve_tailnet_ip
  ADMIN_URL="${SUPABASE_ADMIN_DB_URL:-postgresql://postgres:${SUPABASE_DB_PASSWORD:-postgres}@${NAS_TAILNET_IP}:${DB_PORT}/postgres}"
}

# ---------------------------------------------------------------------------
# Guards
# ---------------------------------------------------------------------------

# GUARD 1: Docker commands must name the NAS. Only `up`/`down`/`status` need it
# -- they drive the container engine. It is deliberately NOT on the database
# subcommands any more: a stack on this Mac cannot bind the NAS's tailnet
# address, so the address is itself discriminating, and GUARD 2 still runs.
require_nas_docker_host() {
  if [ -z "${DOCKER_HOST:-}" ]; then
    echo "REFUSING: DOCKER_HOST is not set." >&2
    echo "  Unset, the Supabase CLI targets this Mac's Docker engine, not the NAS." >&2
    echo "  Run:  export DOCKER_HOST='${EXPECT_DOCKER_HOST}'" >&2
    exit 1
  fi
  if [ "$DOCKER_HOST" != "$EXPECT_DOCKER_HOST" ]; then
    echo "REFUSING: DOCKER_HOST is '${DOCKER_HOST}', expected '${EXPECT_DOCKER_HOST}'." >&2
    exit 1
  fi
  export DOCKER_HOST
}

# GUARD 2: the database on the other end must BE the NAS cluster.
require_db() {
  local url="${1:-$DB_URL}" sysid
  sysid=$("$PSQL" "$url" -tAc "select system_identifier from pg_control_system()" 2>/dev/null || true)
  if [ -z "$sysid" ]; then
    echo "REFUSING: cannot reach a database at $(redact "$url")." >&2
    echo "  Check this Mac is on the tailnet, and that the stack is up:" >&2
    echo "    $(basename "$0") status     (needs DOCKER_HOST)" >&2
    exit 1
  fi
  if [ "$sysid" != "$EXPECT_SYSID" ]; then
    echo "REFUSING: $(redact "$url") is Postgres cluster '${sysid}'," >&2
    echo "  but the NAS stack is '${EXPECT_SYSID}'. Set NAS_DB_SYSID only if the" >&2
    echo "  NAS volume was genuinely recreated." >&2
    exit 1
  fi
}

# ---------------------------------------------------------------------------
# The bind. This is what keeps the database off the LAN.
# ---------------------------------------------------------------------------
#
# Docker fixes a container's publish address at CREATE time and the Supabase CLI
# owns these containers, so `-p <ip>:<port>` is not ours to pass. The network is:
# a bridge network carrying `com.docker.network.bridge.host_binding_ipv4` makes
# that the default publish address for every container on it -- all four ports at
# once, IPv4 and IPv6 wildcard alike. `supabase start --network-id` then uses the
# network we prepared instead of generating a plain one.
ensure_network() {
  local current
  if docker network inspect "$NETWORK" >/dev/null 2>&1; then
    current=$(docker network inspect "$NETWORK" \
      --format '{{index .Options "com.docker.network.bridge.host_binding_ipv4"}}' 2>/dev/null || true)
    [ "$current" = "$NAS_TAILNET_IP" ] && return 0
    echo "[net] ${NETWORK} binds to '${current:-0.0.0.0 (all interfaces)}' -- recreating" >&2
    if ! docker network rm "$NETWORK" >/dev/null 2>&1; then
      echo "REFUSING: cannot remove ${NETWORK} -- containers are still attached." >&2
      echo "  Run:  $(basename "$0") down     then try again." >&2
      exit 1
    fi
  fi
  docker network create \
    --opt "com.docker.network.bridge.host_binding_ipv4=${NAS_TAILNET_IP}" \
    --label "com.docker.compose.project=${PROJECT_ID}" \
    --label "com.supabase.cli.project=${PROJECT_ID}" \
    "$NETWORK" >/dev/null
  echo "[net] created ${NETWORK} bound to the tailnet address" >&2
}

# `supabase start` talks to the database at 127.0.0.1: the CLI derives its own
# hostname from DOCKER_HOST and only honours a `tcp://` one, so an `ssh://` host
# always yields loopback. Once the DB is off loopback, `start` cannot reach it
# and tears the stack down -- measured, and the same failure the first bring-up
# hit for a different reason.
#
# So `up`, and only `up`, holds a forward open for the duration of the CLI call.
# It is PURE TCP over the tailnet: no ssh, no exec channel, no ControlPersist, no
# Touch ID, and `trap` removes it on every exit path. Nothing else in this file
# needs it.
FORWARD_PIDS=""
forward_down() {
  [ -n "$FORWARD_PIDS" ] || return 0
  # shellcheck disable=SC2086
  kill $FORWARD_PIDS 2>/dev/null || true
  FORWARD_PIDS=""
}
forward_up() {
  command -v socat >/dev/null 2>&1 || {
    echo "REFUSING: socat is not installed (brew install socat)." >&2; exit 1; }
  trap forward_down EXIT INT TERM
  for p in $STACK_PORTS; do
    if lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then
      # REFUSE, never skip. A listener here is not ours, and letting the CLI
      # address it is how a run against the wrong stack reports success.
      echo "REFUSING: 127.0.0.1:${p} is already in use by another process." >&2
      echo "  A local 'supabase start' or a stale forward is holding it. Stop it first." >&2
      exit 1
    fi
    socat TCP-LISTEN:"$p",bind=127.0.0.1,reuseaddr,fork TCP:"${NAS_TAILNET_IP}:${p}" &
    FORWARD_PIDS="$FORWARD_PIDS $!"
  done
}

case "${1:-help}" in
  up)
    require_nas_docker_host; resolve_tailnet_ip
    # `up` is the only path that drives Docker over ssh. If the ssh master has
    # expired there is a 1Password prompt waiting on the founder's screen, and
    # nothing else would say so.
    ssh -O check "$NAS_SSH_ALIAS" >/dev/null 2>&1 \
      || echo "[nas] opening an ssh connection -- approve the 1Password prompt once" >&2
    ensure_network; forward_up
    cd "$REPO" && supabase start --network-id "$NETWORK"
    forward_down
    ;;
  # No --no-backup: the point of this stack is that the data survives.
  down)   require_nas_docker_host; cd "$REPO" && supabase stop ;;
  status)
    # NOTE: the CLI prints every URL as http://127.0.0.1:<port>. Those are
    # WRONG here and nothing is listening on them -- the CLI derives the host
    # from DOCKER_HOST and only honours a `tcp://` one. Substitute the tailnet
    # address (this script's `psql`/`controls` already do).
    require_nas_docker_host; cd "$REPO" && supabase status
    ;;

  bindcheck)
    # The control for the whole point of this file: every published stack port
    # must be on the tailnet address, and none on a wildcard.
    require_nas_docker_host; resolve_tailnet_ip
    echo "--- published ports, as Docker reports them ---"
    docker ps --filter "name=supabase_" --format '{{.Names}}\t{{.Ports}}'
    echo "--- host listeners on the stack's ports ---"
    docker run --rm --network host alpine sh -c \
      "netstat -ltn 2>/dev/null | grep -E ':(54321|54322|54323|54324) '" || true
    echo "--- verdict ---"
    if docker ps --filter "name=supabase_" --format '{{.Ports}}' \
        | grep -qE '(^|, )(0\.0\.0\.0|\[::\]):(54321|54322|54323|54324)'; then
      echo "FAIL: a stack port is published on a wildcard address." >&2; exit 1
    fi
    echo "OK: no stack port is published on 0.0.0.0 or [::]."
    ;;

  psql)   resolve_db_url; require_db; shift || true; "$PSQL" "$DB_URL" "$@" ;;

  baseline)
    # Schema load, as the owner. Refuses over a database that already has the
    # schema: a second load is not idempotent and its errors scroll past unread.
    resolve_admin_url; require_db "$ADMIN_URL"
    [ -f "$BASELINE" ] || { echo "baseline not found: $BASELINE" >&2; exit 1; }
    n=$("$PSQL" "$ADMIN_URL" -tAc "select count(*) from information_schema.tables where table_schema='public'")
    [ "$n" = "0" ] || { echo "public schema already has $n tables -- refusing" >&2; exit 1; }
    "$PSQL" "$ADMIN_URL" -v ON_ERROR_STOP=1 -f "$BASELINE"
    ;;

  verify)
    # A fidelity assertion, not a smoke test. The four counts are production's,
    # and the md5 is production's own pg_get_functiondef for
    # auto_provision_it_admin BEFORE the 3096 fix -- so on a freshly loaded
    # baseline it matches, and after 3096 is applied it deliberately does not.
    #
    # The counts read pg_class / pg_trigger, NOT information_schema. The
    # information_schema views are filtered to what the CURRENT ROLE holds
    # privileges on, so the moment this stopped connecting as the table owner
    # they reported `tables = 3` and `triggers = 3` against an intact 68-table
    # baseline -- an assertion that fails for a reason that has nothing to do
    # with the schema. The catalogs are not filtered: measured 68|129|26|177 as
    # both `postgres` and `keepr_agent`.
    resolve_db_url; require_db
    "$PSQL" "$DB_URL" -v ON_ERROR_STOP=1 <<'SQL'
select (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
          where n.nspname='public' and c.relkind='r') as tables,
       (select count(*) from pg_policies where schemaname='public') as policies,
       (select count(*) from pg_trigger t join pg_class c on c.oid=t.tgrelid
          join pg_namespace n on n.oid=c.relnamespace
          where n.nspname='public' and not t.tgisinternal) as triggers,
       (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public') as functions,
       (select count(*) from supabase_migrations.schema_migrations) as history_rows,
       md5(pg_get_functiondef('public.auto_provision_it_admin'::regproc)) = '0f8c87bb35f8aa31b3b245907666e892' as baseline_body_unmodified;
SQL
    ;;

  controls)
    # The seven BACKLOG-3096 controls. Control 5 needs two concurrent sessions,
    # so psql must be on PATH for its runner.
    resolve_db_url; require_db
    rc=0
    for f in "$REPO"/supabase/tests/backlog-3096/control-[123467]-*.sql; do
      if out=$("$PSQL" "$DB_URL" -v ON_ERROR_STOP=1 -f "$f" 2>&1) && ! grep -qiE "ERROR|FATAL" <<<"$out"; then
        printf '%-72s GREEN\n' "$(basename "$f")"
      else
        printf '%-72s RED   %s\n' "$(basename "$f")" "$(grep -iE 'ERROR' <<<"$out" | head -1)"; rc=1
      fi
    done
    DATABASE_URL="$DB_URL" PATH="$(dirname "$PSQL"):$PATH" \
      "$REPO"/supabase/tests/backlog-3096/control-5-run.sh || rc=1
    exit $rc
    ;;

  *)
    sed -n '2,54p' "${BASH_SOURCE[0]}"
    echo "usage: $(basename "$0") {up|down|status|bindcheck|psql|baseline|verify|controls}"
    ;;
esac
