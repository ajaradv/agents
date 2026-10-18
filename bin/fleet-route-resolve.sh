#!/usr/bin/env bash
# fleet-route-resolve.sh - ask Jev (typesafe.ai System One) who should own a
# captain message: one registered agent, one group (via its lead), or Firstmate.
# Opt-in, like bin/fm-dispatch-resolve.sh in fleet/home, whose contract this follows.
#
# Usage:
#   fleet-route-resolve.sh <message-file | -> [--dry-run]
#
# Options sent to Jev (one Choice question):
#   agent_<id>   every registered assistant in agents/*/agent.yaml (not crew-only
#                templates), described by the `description:` in its roles/<role>.md frontmatter
#   group_<id>   every group in $FLEET_INBOX/dashboard-groups.json (name, lead, members)
#   firstmate    ship or multi-step project work for Firstmate to triage and dispatch
#   ask          nothing clearly fits; the captain picks
#
# Opt-in gate: TYPESAFE_API_KEY in the environment, else a TYPESAFE_API_KEY= line
#   in fleet/home/.env. Absent: one "route-resolve: off" line on stderr, nothing
#   on stdout, exit 0, no network call. The key reaches curl as a header read from
#   a file descriptor, never on argv.
#
# Never-send check: when fleet/home/config/dispatch-never-send exists, every string
#   in the request is checked against it (case-insensitive literals, whitespace
#   collapsed) before the POST. A match prints "route-resolve: off (...; nothing
#   sent)" on stderr naming only the line number, and exits 0.
#
# --dry-run prints the request JSON (with the message) and sends nothing; no key needed.
#
# Output (stdout):
#   route-resolve:
#     status: clear | ambiguous | escalate | error
#     choice: <option key>
#     target: agent:<id> | group:<id> | firstmate
#     send_to: <thread id>        (a group resolves to its lead)
#     confidence: <0..1>
#     probabilities: <key>=<p> ... (highest first)
#     reason: <why the status is not clear>
#   clear     -> send to send_to
#   ambiguous -> confidence below 0.6; show the probabilities and let the captain pick
#   escalate  -> Jev chose `ask`, or there is nothing to route to
#   error     -> API, network, or response failure; the captain picks
#   Every outcome exits 0. Exit 2 only for usage errors or missing jq/curl.
set -u

KEY=${TYPESAFE_API_KEY:-}
unset TYPESAFE_API_KEY

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FM_HOME="${FM_HOME:-$ROOT/fleet/home}"
INBOX="${FLEET_INBOX:-$ROOT/fleet/inbox}"
INBOX="${INBOX/#\~/$HOME}"
NEVER_SEND_PATH="${ROUTE_NEVER_SEND:-$FM_HOME/config/dispatch-never-send}"
CONFIDENCE_FLOOR=0.6
TS_MODEL=jev-latest
TS_BASE="${TYPESAFE_BASE:-https://api.typesafe.ai}"
TS_TIMEOUT=5

die() { printf 'error: %s\n' "$1" >&2; exit 2; }
usage() { awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$0"; }

MSG='' DRY=false
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=true; shift ;;
    -h|--help) usage; exit 0 ;;
    -) [ -z "$MSG" ] || die "one message only"; MSG=-; shift ;;
    -*) die "unknown flag $1" ;;
    *) [ -z "$MSG" ] || die "one message only"; MSG=$1; shift ;;
  esac
done
[ -n "$MSG" ] || die "message file or - required (see --help)"
command -v jq >/dev/null 2>&1 || die "jq required"

TMP=$(mktemp -d) || die "mktemp failed"
trap 'rm -rf "$TMP"' EXIT
if [ "$MSG" = - ]; then cat > "$TMP/msg"; else [ -r "$MSG" ] || die "message not readable: $MSG"; cp "$MSG" "$TMP/msg"; fi
[ -s "$TMP/msg" ] || die "empty message"

# ---- opt-in gate ------------------------------------------------------------------
env_get() { # last KEY=value line in a dotenv file, quotes stripped, never echoed elsewhere
  [ -r "$2" ] || return 0
  awk -v k="$1" -F= '
    { sub(/^[ \t]*export[ \t]+/, "") }
    $1 == k { v = substr($0, index($0, "=") + 1) }
    END { gsub(/^[ \t"'"'"']+|[ \t"'"'"']+$/, "", v); printf "%s", v }' "$2"
}
if ! $DRY; then
  # The service account; a plain .env file only (a 1Password mount pipe would prompt the captain).
  [ -n "$KEY" ] || KEY=$("$ROOT/bin/fleet-secrets" 2>/dev/null | awk -F= '$1 == "TYPESAFE_API_KEY" { print substr($0, index($0, "=") + 1) }')
  [ -n "$KEY" ] || { [ -f "$FM_HOME/.env" ] && KEY=$(env_get TYPESAFE_API_KEY "$FM_HOME/.env"); }
  if [ -z "$KEY" ]; then
    echo "route-resolve: off (TYPESAFE_API_KEY absent from the environment and $FM_HOME/.env)" >&2
    exit 0
  fi
  command -v curl >/dev/null 2>&1 || die "curl required"
fi

# ---- options -----------------------------------------------------------------------
yaml_get() { awk -v k="$1" -F: '$1 == k { v = $0; sub(/^[^:]*:[ \t]*/, "", v); gsub(/^["'"'"']|["'"'"']$/, "", v); print v; exit }' "$2"; }
role_description() { # frontmatter description: of roles/<role>.md
  awk 'NR == 1 && $0 != "---" { exit } NR > 1 && $0 == "---" { exit }
       /^description:/ { sub(/^description:[ \t]*/, ""); print; exit }' "$1" 2>/dev/null
}

: > "$TMP/agents.tsv"
for y in "$ROOT"/agents/*/agent.yaml; do
  [ -f "$y" ] || continue
  id=$(yaml_get id "$y"); type=$(yaml_get type "$y"); role=$(yaml_get role "$y")
  [ "$type" = assistant ] || continue
  # Crew-only templates (lead, scout) exist only aboard ships as <ship>-<role>; not a recipient by themselves.
  [ "$(yaml_get crew "$y")" = only ] && continue
  printf '%s\t%s\n' "$id" "$(role_description "$ROOT/roles/${role:-$id}.md")" >> "$TMP/agents.tsv"
done
jq -R -s 'split("\n") | map(select(length > 0) | split("\t") | {id: .[0], desc: (.[1] // "")})' "$TMP/agents.tsv" > "$TMP/agents.json"

GROUPS_FILE="$INBOX/dashboard-groups.json"
if [ -r "$GROUPS_FILE" ]; then
  jq '[(.groups // [])[] | select(.id and .lead and (.members | type) == "array")]' "$GROUPS_FILE" > "$TMP/groups.json" 2>/dev/null \
    || echo '[]' > "$TMP/groups.json"
else
  echo '[]' > "$TMP/groups.json"
fi

REQUEST=$(jq -n --rawfile msg "$TMP/msg" --arg model "$TS_MODEL" \
  --slurpfile agents "$TMP/agents.json" --slurpfile groups "$TMP/groups.json" '
  ($agents[0]) as $a | ($groups[0]) as $g |
  ($a | map({key: ("agent_" + .id), value: ("Send to the \(.id) agent. \(.desc)")}) | from_entries) as $ac |
  ($g | map(. as $grp | {key: ("group_" + .id),
      value: ("Send to the \(.name) group, led by \(.lead), with members \(.members | join(", ")). The lead coordinates: "
              + ([$grp.members[] as $m | $a[] | select(.id == $m) | "\(.id): \(.desc)"] | join(" ")))})
   | from_entries) as $gc |
  {
    model: $model,
    state: {message: $msg},
    questions: {
      route: {
        type: "choice",
        instructions: "The captain wrote `message` on the fleet dashboard. Which ONE recipient should own it? Prefer a single agent when one agent'"'"'s job covers it, a group when it needs that group'"'"'s members working together, and firstmate when it is project or ship work that needs triage, planning, or crews. Fleet commands and fleet questions belong to the omni agent (alice) even when they name a ship or describe the work: setting sail on a ship (\"<ship>, set sail: <goal>\" starts a voyage; the ship'"'"'s crew does the work), docking, crew or budget changes, stopping an agent, and questions about what a ship or the fleet is doing. Pick `ask` when nothing clearly fits.",
        criteria: ($ac + $gc + {
          firstmate: "Send to Firstmate: work on a project or ship that needs triage, a plan, or crews (features, bugfixes, refactors, research tasks) and is not phrased as a fleet command, or questions about Firstmate'"'"'s own tasks already in flight. Not fleet commands (set sail or dock a voyage, even with a goal; change a crew; stop an agent) and not questions about what a ship is doing: those go to the omni agent.",
          ask: "No option clearly fits, or the message is ambiguous; ask the captain."
        })
      }
    }
  }')

if $DRY; then printf '%s\n' "$REQUEST"; exit 0; fi

emit() { # status reason
  printf 'route-resolve:\n  status: %s\n' "$1"
  [ -z "${2:-}" ] || printf '  reason: %s\n' "$2"
  exit 0
}

# ---- never-send check -----------------------------------------------------------------
never_send_off() { echo "route-resolve: off ($1; nothing sent)" >&2; exit 0; }
if [ -e "$NEVER_SEND_PATH" ] || [ -L "$NEVER_SEND_PATH" ]; then
  { [ -f "$NEVER_SEND_PATH" ] && [ -r "$NEVER_SEND_PATH" ]; } || never_send_off "$NEVER_SEND_PATH is not a readable regular file"
  jq -r '.. | strings | gsub("\\s+"; " ")' <<<"$REQUEST" > "$TMP/send.txt" 2>/dev/null || never_send_off "could not extract the request text"
  n=0
  while IFS= read -r value; do
    n=$((n + 1))
    value=$(printf '%s' "$value" | tr -s '[:space:]' ' ')
    value=${value# }; value=${value% }
    case "$value" in ''|'#'*) continue ;; esac
    grep -qiF -e "$value" "$TMP/send.txt" 2>/dev/null; rc=$?
    case "$rc" in
      0) never_send_off "message matches $NEVER_SEND_PATH line $n" ;;
      1) ;;
      *) never_send_off "could not check the request against $NEVER_SEND_PATH line $n" ;;
    esac
  done < "$NEVER_SEND_PATH"
fi

# ---- ask Jev --------------------------------------------------------------------------
HTTP=$(printf '%s' "$REQUEST" | curl -sS --max-time "$TS_TIMEOUT" -o "$TMP/resp" -w '%{http_code}' \
  -X POST "$TS_BASE/v1/systemone" -H 'Content-Type: application/json' \
  -H @/dev/fd/3 3< <(printf 'Authorization: Bearer %s\n' "$KEY") \
  --data-binary @- 2>/dev/null) || HTTP=000
[ "$HTTP" = 200 ] || emit error "http $HTTP: $(head -c 200 "$TMP/resp" 2>/dev/null | tr '\n' ' ')"

jq -e --argjson req "$REQUEST" '
  ($req.questions.route.criteria | keys | sort) as $choices |
  .answers.route as $a |
  ($a.choice | type) == "string" and
  ($choices | index($a.choice)) != null and
  ($a.confidence | type) == "number" and $a.confidence >= 0 and $a.confidence <= 1 and
  ($a.probabilities | type) == "object" and
  (($a.probabilities | keys | sort) == $choices)' "$TMP/resp" >/dev/null 2>&1 \
  || emit error "response is not a route Choice answer"

jq -r --arg floor "$CONFIDENCE_FLOOR" --slurpfile groups "$TMP/groups.json" '
  .answers.route as $a | ($groups[0]) as $g |
  ($a.choice) as $c |
  (if $c == "firstmate" then {target: "firstmate", send_to: "firstmate"}
   elif ($c | startswith("agent_")) then ($c | ltrimstr("agent_")) as $id | {target: ("agent:" + $id), send_to: $id}
   elif ($c | startswith("group_")) then ($c | ltrimstr("group_")) as $id
     | {target: ("group:" + $id), send_to: ([$g[] | select(.id == $id) | .lead][0] // "")}
   else {target: "", send_to: ""} end) as $t |
  (if $c == "ask" then ["escalate", "Jev chose ask"]
   elif $a.confidence < ($floor | tonumber) then ["ambiguous", "confidence \($a.confidence) below \($floor)"]
   else ["clear", ""] end) as $s |
  "route-resolve:",
  "  status: \($s[0])",
  "  choice: \($c)",
  (if $t.target != "" then "  target: \($t.target)\n  send_to: \($t.send_to)" else empty end),
  "  confidence: \($a.confidence)",
  "  probabilities: " + ($a.probabilities | to_entries | sort_by(-.value) | map("\(.key)=\((.value * 100 | round) / 100)") | join(" ")),
  (if $s[1] != "" then "  reason: \($s[1])" else empty end)
' "$TMP/resp"
exit 0
