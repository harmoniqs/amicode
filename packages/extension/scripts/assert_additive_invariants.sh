#!/usr/bin/env bash
# assert_additive_invariants.sh — the ADR 0027 cross-cutting "peer studios stay
# ADDITIVE" gate (#1346). Peer slices ADD files; their whole safety story is that
# the merged hub/star path — the never-fork guard shim, the one-parser rule,
# single-writer-per-DB — is left BYTE-UNCHANGED, and that peer
# machines never take the never-fork `client` stance. This gate makes that a
# STANDING MECHANICAL check that runs on every peer slice's CI, so a regression in
# any peer slice is caught. It is a SIBLING of assert_fleet_guard.sh (which stays
# intact); this one adds the four ADR-0027 additive invariants.
#
# Four machine invariants (issue #1346):
#   AC1 never_fork_guard_bytes_changed == 0   both copies of the never-fork guard
#                                             shim are an EMPTY diff vs the
#                                             MERGE-BASE. (ADR 0028/#1368 lifts the
#                                             enroll-verb byte-freeze — see the
#                                             FROZEN note below.)
#   AC2 new_fleet_json_parsers        == 0    no NEW parser of fleet.json; peer reads
#                                             go through the existing @amicode/schema
#                                             reader (parseFleetTopology).
#   AC3 max_db_writers_per_machine    <= 1    adopt-or-spawn is the sole writer; the
#                                             attach path is PROXY-ONLY (spawns no
#                                             engine, opens no second DB writer).
#   AC4 peer_client_stance_used       == 0    the peer-attach flow writes no fleet.json
#                                             with role=client and never installs the
#                                             guard (attach writes the attachment
#                                             POINTER, not fleet.json).
#
# ── AC1 baseline: the MERGE-BASE, NOT the base tip (the make-or-break) ────────
# The base branch (feature/free-tier-fleet) advances independently of a peer
# branch. Diffing the base TIP would report the BASE's drift as OURS — a FALSE
# fail (e.g. #1357/#1355 rewrote the enroll verb on the base). The merge-base is
# our true branch point: an empty diff there proves WE touched nothing, and it
# moves correctly under a future rebase onto the advanced base (the merge-base
# tracks the rebase; our diff stays empty). If AC1 ever reds on the guard
# set, the BASELINE is wrong (it must be the merge-base) — never "fix" it by
# editing the guard, excluding files, or weakening the assertion.
#
# DELIBERATE, director-tracked: the live proxy/SSE re-target to an attached peer
# is intentionally UNWIRED (server.ts held byte-identical, the D3 resolver not in
# live dispatch). "Attach is proxy-only / spawns no engine" (AC3/AC4) is
# CONSISTENT with that deferral — it is not a bug to fix here.
#
# Exit-code contract:
#   0  all four invariants hold.
#   1  a REAL violation (AC1 nonempty diff / AC2 new parser / AC3 second writer /
#      AC4 client stance) — ALWAYS a hard failure, never soft.
#   3  AC1 UNVERIFIABLE: the base ref is not resolvable in this sandbox (a shallow
#      checkout with the base branch unfetched). A loud warning, not a violation.
#      Set INVARIANT_STRICT=1 (CI does) to promote this to a hard failure — an
#      unverifiable invariant must never SILENTLY pass in CI.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"

STRICT="${INVARIANT_STRICT:-0}"
fails=0
ac1_unverifiable=0
fail() { echo "[additive-gate] FAIL $*" >&2; fails=$((fails + 1)); }
ok() { echo "[additive-gate] ok $*"; }

# ── AC1 — never-fork guard byte-unchanged vs the MERGE-BASE ──────────────────
BASE_REF="${INVARIANT_BASE_REF:-origin/feature/free-tier-fleet}"

# The never-fork guard frozen set: BOTH copies of the guard shim (canonical +
# the VSIX-shipped mirror). ADR 0028 (#1368) SUPERSEDES ADR 0027's byte-freeze of
# the enroll verb — `fleet_enroll_verb.ts` (+ its test) legitimately evolve to
# produce self-reported device identity (friendly name + device_type) on the
# roster row, so they are NO LONGER frozen here. ADR 0027 froze the enroll verb to
# prove ITS peer-studio work was additive; that proof is discharged (merged), and
# the enroll path's REAL invariants are still enforced elsewhere: the never-fork
# guard bytes below stay frozen, and one-parser / single-writer / no-client-stance
# are AC2 / AC3 / AC4 (+ the separate assert_fleet_guard.sh). The guard's INSTALLER
# (deploy_guard.mjs) and ASSERT (assert_fleet_guard.sh) are NOT frozen here — that
# "the attach flow never installs the guard" concern is AC4's; AC1 pins the
# never-fork guard's BYTES.
FROZEN=(
  "tools/fleet/amico-opencode-fleet-guard"
  "packages/extension/tools/fleet/amico-opencode-fleet-guard"
)

resolvable() { git rev-parse --verify --quiet "$1" >/dev/null 2>&1; }

# Resolve the base ref: the explicit override, else the PR base branch
# (GITHUB_BASE_REF on pull_request events), else the default. A shallow CI
# checkout may not carry it, so best-effort fetch when it is absent.
BASE=""
if resolvable "$BASE_REF"; then
  BASE="$BASE_REF"
elif [ -n "${GITHUB_BASE_REF:-}" ] && resolvable "origin/${GITHUB_BASE_REF}"; then
  BASE="origin/${GITHUB_BASE_REF}"
else
  FETCH_BRANCH="${GITHUB_BASE_REF:-${BASE_REF#origin/}}"
  git fetch --no-tags --quiet origin "$FETCH_BRANCH" 2>/dev/null || true
  if resolvable "$BASE_REF"; then
    BASE="$BASE_REF"
  elif [ -n "${GITHUB_BASE_REF:-}" ] && resolvable "origin/${GITHUB_BASE_REF}"; then
    BASE="origin/${GITHUB_BASE_REF}"
  elif resolvable FETCH_HEAD; then
    BASE="FETCH_HEAD"
  fi
fi

if [ -z "$BASE" ]; then
  echo "[additive-gate] AC1 UNVERIFIABLE: base ref '$BASE_REF' not resolvable" >&2
  echo "                 fetch it (git fetch origin ${BASE_REF#origin/}) — AC1 diffs vs the MERGE-BASE" >&2
  ac1_unverifiable=1
else
  MERGE_BASE="$(git merge-base HEAD "$BASE" 2>/dev/null || true)"
  if [ -z "$MERGE_BASE" ]; then
    echo "[additive-gate] AC1 UNVERIFIABLE: no merge-base between HEAD and $BASE" >&2
    ac1_unverifiable=1
  elif git diff --quiet "$MERGE_BASE"..HEAD -- "${FROZEN[@]}"; then
    ok "AC1 never-fork guard byte-unchanged vs merge-base ${MERGE_BASE:0:12} (base=$BASE)"
  else
    fail "AC1 never-fork guard CHANGED vs merge-base ${MERGE_BASE:0:12}:"
    git --no-pager diff --stat "$MERGE_BASE"..HEAD -- "${FROZEN[@]}" >&2
    echo "     if this is base DRIFT not your edit, your BASELINE is wrong — it MUST be" >&2
    echo "     the merge-base, not the base tip (issue #1346 ★). Never weaken this." >&2
  fi
fi

# ── AC2 — no NEW parser of fleet.json outside the ONE parser home ────────────
# The ONE parser home is @amicode/schema (packages/schema/src): parseFleetTopology
# (the reader) + writeFleetConfig (the writer). The violation is a source file
# ELSEWHERE that reads a /fleet.json path via readFileSync (the raw-parse idiom
# fleet_topology_single_parser.test.ts already gates on). The TRAP: keeper_pointer
# / attachment_pointer MENTION fleet.json in comments and parse their OWN sibling
# (keeper.json / attachment.json) — a comment or a sibling-parse is FINE. So we
# strip pure-comment lines and match the readFileSync(...fleet.json) idiom, which
# a comment or a sibling-parse cannot trip.
prev=$fails
ac2_hits="$(
  grep -rInE 'readFileSync[^;]*fleet\.json' \
    --include='*.ts' --include='*.mjs' --include='*.js' \
    packages tools 2>/dev/null |
    grep -v '/node_modules/' |
    grep -v '/dist/' |
    grep -v '/.materialized/' |
    grep -vE '/test/|\.test\.' |
    grep -v 'packages/schema/' |
    grep -vE '^[^:]+:[0-9]+:[[:space:]]*(//|\*|/\*)' ||
    true
)"
if [ -n "$ac2_hits" ]; then
  fail "AC2 a NEW fleet.json parser appeared outside @amicode/schema (peer reads MUST go through parseFleetTopology):"
  echo "$ac2_hits" >&2
fi
# the parser home must still exist (the reader was not moved/renamed out from
# under the invariant)
grep -qE 'export function parseFleetTopology' packages/schema/src/fleet_projection.ts ||
  fail "AC2 the one parser (parseFleetTopology) vanished from @amicode/schema"
[ "$fails" -eq "$prev" ] && ok "AC2 no new fleet.json parser (the one parser stays @amicode/schema)"

# ── AC3 — the peer/attach path opens no second DB writer (proxy-only) ────────
# adopt-or-spawn (server_lifecycle.ts) is the SOLE writer primitive: it ADOPTS a
# live survivor, never cold-spawns a rival engine onto an occupied port. The
# attach path must not reach it — it stands up a PROXY (an ssh -L forward), never
# a local engine. NOTE: attachment_transport DOES spawn `ssh` (the proxy forward)
# — that is proxy-only by construction, NOT an engine, so we forbid the engine
# primitives precisely, never "spawn" wholesale.
prev=$fails
AS="packages/extension/src/amicode_service"
for m in attach_action.ts attachment_pointer.ts attachment_transport.ts attach_state.ts attachment_credential.ts; do
  f="$AS/$m"
  [ -f "$f" ] || continue
  if grep -qE 'server_lifecycle|adoptOrSpawn|coldSpawn|buildLiveDeps' "$f"; then
    fail "AC3 $m reaches the engine-writer primitive (server_lifecycle/adoptOrSpawn) — attach must be proxy-only"
  fi
done
if grep -qE 'spawn[^;]*opencode' "$AS/attachment_transport.ts" 2>/dev/null; then
  fail "AC3 attachment_transport spawns an opencode engine — the attach path spawns only the ssh proxy"
fi
grep -qE 'adoptOrSpawn' packages/extension/src/server_lifecycle.ts ||
  fail "AC3 the adopt-or-spawn writer primitive vanished from server_lifecycle.ts"
[ "$fails" -eq "$prev" ] && ok "AC3 attach path is proxy-only; adopt-or-spawn is the sole DB writer"

# ── AC4 — the peer-attach flow uses no client stance ─────────────────────────
# The peer-attach flow writes no fleet.json (no writeFleetConfig/fleet_config),
# no role=client, and never installs the never-fork guard (deploy_guard / the
# guard binary). Peers stay `standalone` and advertise; the guard is never
# triggered. (Behaviorally exercised in additive_invariants_gate.test.ts: a real
# attach writes the attachment POINTER, not fleet.json.)
prev=$fails
for m in attach_action.ts attachment_pointer.ts attachment_transport.ts; do
  f="$AS/$m"
  [ -f "$f" ] || continue
  grep -qE 'writeFleetConfig|fleet_config' "$f" &&
    fail "AC4 $m writes fleet.json (writeFleetConfig) — the peer-attach flow must not take the client stance"
  grep -qE '"role"[[:space:]]*:[[:space:]]*"client"|role:[[:space:]]*"client"' "$f" &&
    fail "AC4 $m writes role=client — peers stay standalone"
  grep -qE 'deploy_guard|amico-opencode-fleet-guard' "$f" &&
    fail "AC4 $m installs the never-fork guard — attach is proxy-only, the guard is never triggered"
done
# the attach ROUTES delegate to the pointer verb (not a fleet.json/guard path)
grep -qE '/amicode/fleet/attach"' "$AS/index.ts" ||
  fail "AC4 the attach route is missing from index.ts (the peer-attach flow must exist to be non-vacuous)"
[ "$fails" -eq "$prev" ] && ok "AC4 the peer-attach flow uses no client stance (no fleet.json, no role=client, no guard)"

# ── verdict ──────────────────────────────────────────────────────────────────
if [ "$fails" -gt 0 ]; then
  echo "[additive-gate] $fails additive invariant(s) VIOLATED — peer studios are NOT additive" >&2
  exit 1
fi
if [ "$ac1_unverifiable" -eq 1 ]; then
  if [ "$STRICT" = "1" ]; then
    echo "[additive-gate] AC1 unverifiable AND INVARIANT_STRICT=1 — failing (CI must be able to verify)" >&2
    exit 1
  fi
  echo "[additive-gate] AC2/AC3/AC4 hold; AC1 unverified (base ref absent) — set INVARIANT_STRICT=1 to hard-fail" >&2
  exit 3
fi
echo "[additive-gate] all four ADR-0027 additive invariants hold — peer studios stay additive"
exit 0
