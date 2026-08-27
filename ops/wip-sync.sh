#!/usr/bin/env bash
# wip-sync.sh — the code-repo layer of the fleet model (see the fleet skill).
#
# Why this exists: the fleet auto-syncs the chat DB (one canonical server) and
# the vaults (armonia-sync, 15-min + write-triggered). CODE repos get no daemon
# ON PURPOSE: file-syncing a live .git between two machines is the corruption
# scenario, so only COMMITS cross machines. This script is the switch ritual:
#
#   wip-sync.sh status   per-repo report: branch, dirty count, ahead/behind vs
#                        upstream (as of last fetch — no network), wip branches
#   wip-sync.sh leave    commit every dirty repo as "wip: <host> <ts>" and push.
#                        On main/master/detached the WIP goes to a wip/<host>
#                        branch instead — never WIP-commit main. If the upstream
#                        moved only by wip: commits (the other machine's
#                        handoffs), re-anchor with `reset --soft` — the CURRENT
#                        TREE is authoritative, so no stash dance, no conflicts.
#   wip-sync.sh arrive   fetch every repo; fast-forward a clean behind branch;
#                        then un-commit any run of tip "wip:" commits
#                        (reset --mixed to the first non-wip ancestor) so the
#                        work shows up as LOCAL CHANGES again. If the tree is
#                        clean and exactly one wip/* branch exists, switch to
#                        it first (that's the other machine's WIP).
#
# WIP commits are disposable snapshots — each wip commit captures the whole
# tree of the machine that made it, so a chain of them never diverges and
# never needs merging. When the work firms up, split/squash it into real
# commits (or squash-merge the PR). Never force-push.
#
# Config: WIP_ROOT (default ~/armonia/repos), WIP_HOST (default: trailing alnum
# token of the LocalHostName — "Aarons-Mac-mini" → "mini"). Vaults under
# ~/.amico/vaults are out of scope: armonia-sync owns them.
#
# v2 2026-08-20: multi-remote resilience, born of the qldpc-challenge incident
# (origin = unitaryfoundation, read-only; fork = writable; leave stranded the
# snapshot locally). leave now pushes to the first remote that ACCEPTS (origin,
# then the rest), re-anchoring over incoming wip-only snapshots on non-FF;
# arrive/status see all remotes, so a wip branch hosted on a fork is
# discoverable on the other machine. Never force-pushes — a remote carrying
# real (non-wip) incoming commits is genuine divergence and stays a warning.
set -uo pipefail
export PATH="/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin:$PATH"

ROOT="${WIP_ROOT:-$HOME/armonia/repos}"
HOST="${WIP_HOST:-$(scutil --get LocalHostName 2>/dev/null || hostname -s)}"
HOST="$(printf '%s' "$HOST" | tr '[:upper:]' '[:lower:]' | sed -E 's/.*[^a-z0-9]([a-z0-9]+)$/\1/; s/[^a-z0-9]//g')"
FAILS=0

say()  { printf '%s\n' "$*"; }
warn() { printf '  !! %s\n' "$*" >&2; FAILS=$((FAILS + 1)); }

repos() {
  [ -d "$ROOT" ] || return 0
  find "$ROOT" -maxdepth 3 -type d -name .git 2>/dev/null | sed 's|/\.git$||' | sort
}

branch_of() { git -C "$1" branch --show-current 2>/dev/null; }
dirty_n()   { git -C "$1" status --porcelain 2>/dev/null | wc -l | tr -d ' '; }

# wip/* branch names, local AND remote-tracking (deduped) — after a fetch the
# other machine's WIP usually exists only as <remote>/wip/<host>, which may not
# be origin (a fork can host it).
wip_branches() {
  { git -C "$1" branch --list 'wip/*' --format='%(refname:short)' 2>/dev/null
    git -C "$1" for-each-ref --format='%(refname:short)' 'refs/remotes/*/wip/*' 2>/dev/null | sed 's|^[^/]*/||'
  } | sort -u
}

# Every remote, origin first then the rest — a repo may carry a writable fork
# beside a read-only origin (qldpc-challenge is the live example).
remotes_of() {
  if git -C "$1" remote 2>/dev/null | grep -qx origin; then printf 'origin\n'; fi
  git -C "$1" remote 2>/dev/null | grep -vx origin || true
  return 0
}

# Fetch every remote, per-remote offline-tolerant. Fails (1) only when remotes
# exist and ALL of them refused — one bad remote never blocks the ritual.
fetch_all() {
  local r=$1 rm ok=0
  for rm in $(remotes_of "$r"); do
    git -C "$r" fetch --prune "$rm" >/dev/null 2>&1 && ok=$((ok + 1))
  done
  [ "$ok" -gt 0 ] && return 0
  [ -n "$(git -C "$r" remote 2>/dev/null)" ] && return 1
  return 0
}

# Push <branch> to the first remote that accepts it: origin, then the rest.
# On a non-FF rejection whose incoming commits are ALL wip: snapshots, re-anchor
# (reset --soft + amend — the snapshot model: the CURRENT tree is the newer
# truth, a chain of full-tree handoffs never diverges) and retry that remote
# once. Real (non-wip) incoming commits = genuine divergence: skip the remote,
# never force. Echoes the remote that took the push; silent, exit 1 if all
# refuse.
push_branch() {
  local r=$1 branch=$2 rm ref incoming msg
  for rm in $(remotes_of "$r"); do
    git -C "$r" push -u "$rm" "$branch" >/dev/null 2>&1 && { printf '%s\n' "$rm"; return 0; }
    git -C "$r" fetch --prune "$rm" >/dev/null 2>&1 || continue
    ref="refs/remotes/$rm/$branch"
    git -C "$r" rev-parse --verify "$ref" >/dev/null 2>&1 || continue
    incoming="$(git -C "$r" log --format=%s "HEAD..$ref" 2>/dev/null)"
    [ -n "$incoming" ] || continue
    printf '%s\n' "$incoming" | grep -qv '^wip:' && continue
    # Stack a fresh snapshot-commit on the incoming one (NOT --amend: replacing
    # the remote snapshot would still be non-FF — the chain grows, never forks).
    msg="$(git -C "$r" log -1 --format=%s)"
    git -C "$r" reset --soft "$ref" >/dev/null 2>&1 || continue
    git -C "$r" commit -q -m "$msg" >/dev/null 2>&1 || continue
    git -C "$r" push -u "$rm" "$branch" >/dev/null 2>&1 && { printf '%s\n' "$rm"; return 0; }
  done
  return 1
}

# True if the repo has unresolved merge conflicts. `git pull --rebase
# --autostash` can exit 0 even when the stash POP conflicts — without this
# guard a leave would COMMIT the conflict markers.
in_conflict() { [ -n "$(git -C "$1" ls-files -u 2>/dev/null)" ]; }

# First ancestor whose subject is NOT a wip: commit (the base of the current
# wip run), empty if none within 50. Expects a fetch to have happened already.
wip_run_base() {
  git -C "$1" log --format='%H%x09%s' -n 50 2>/dev/null \
    | awk -F'\t' '$2 !~ /^wip:/ { print $1; exit }'
}

cmd_status() {
  local r name branch dirty ab behind ahead wips
  for r in $(repos); do
    name="${r#"$ROOT"/}"
    branch="$(branch_of "$r")"; branch="${branch:-DETACHED}"
    dirty="$(dirty_n "$r")"
    ab="$(git -C "$r" rev-list --left-right --count '@{upstream}...HEAD' 2>/dev/null)"
    if [ -n "$ab" ]; then
      behind="$(printf '%s' "$ab" | cut -f1)"; ahead="$(printf '%s' "$ab" | cut -f2)"
    else
      behind="?"; ahead="?"
    fi
    wips="$(wip_branches "$r" | tr '\n' ' ')"
    printf '%-42s branch=%-28s dirty=%-3s ahead=%s behind=%s %s\n' \
      "$name" "$branch" "$dirty" "$ahead" "$behind" "${wips:+wip-branches: $wips}"
  done
  say "(ahead/behind as of last fetch; host=$HOST root=$ROOT)"
}

cmd_leave() {
  local r name branch behind pushed
  git -C "$ROOT" rev-parse >/dev/null 2>&1 # noop, keeps shellcheck honest
  for r in $(repos); do
    name="${r#"$ROOT"/}"
    [ "$(dirty_n "$r")" = "0" ] && continue
    branch="$(branch_of "$r")"
    case "$branch" in
      main|master|"")
        say "== $name: on '${branch:-DETACHED}', moving WIP to wip/$HOST"
        if ! git -C "$r" switch -c "wip/$HOST" 2>/dev/null; then
          git -C "$r" switch "wip/$HOST" 2>/dev/null || { warn "$name: cannot switch to wip/$HOST with a dirty tree — resolve by hand"; continue; }
        fi
        branch="$(branch_of "$r")"
        ;;
    esac
    fetch_all "$r" || true  # one bad remote never blocks the snapshot
    if git -C "$r" rev-parse --verify '@{upstream}' >/dev/null 2>&1; then
      behind="$(git -C "$r" rev-list --count 'HEAD..@{upstream}' 2>/dev/null || echo 0)"
      if [ "${behind:-0}" -gt 0 ]; then
        if git -C "$r" log --format=%s "HEAD..@{upstream}" | grep -qv '^wip:'; then
          # Real (non-wip) commits incoming: genuine divergence, replay ours.
          git -C "$r" pull --rebase --autostash >/dev/null 2>&1 || { warn "$name: rebase onto upstream failed — resolve by hand in $r"; continue; }
          in_conflict "$r" && { warn "$name: autostash pop CONFLICTED — resolve by hand in $r"; continue; }
        else
          # Incoming is only wip: snapshots — each is a full-tree handoff, and
          # the CURRENT tree is the newer truth. Re-anchor, never merge.
          git -C "$r" reset --soft '@{upstream}' >/dev/null 2>&1 || { warn "$name: re-anchor failed"; continue; }
          say "== $name: re-anchored over $behind incoming wip commit(s)"
        fi
      fi
    fi
    git -C "$r" add -A
    git -C "$r" commit -q -m "wip: $HOST $(date +%Y-%m-%dT%H:%M)" || { warn "$name: commit failed"; continue; }
    if pushed="$(push_branch "$r" "$branch")"; then
      say "== $name: pushed wip commit on $branch → $pushed"
    else
      warn "$name: push failed on every remote (committed locally on $branch)"
    fi
  done
}

cmd_arrive() {
  local r name branch wb others n behind ahead base
  for r in $(repos); do
    name="${r#"$ROOT"/}"
    fetch_all "$r" || warn "$name: fetch failed on every remote (offline?)"
    branch="$(branch_of "$r")"
    # Switch to a sole wip/* branch when the tree is clean — that's the other
    # machine's handoff waiting for us.
    others=""
    n=0
    for wb in $(wip_branches "$r"); do
      [ "$wb" = "$branch" ] && continue
      others="$others $wb"; n=$((n + 1))
    done
    if [ "$n" -gt 1 ] || { [ "$n" -eq 1 ] && [ "$(dirty_n "$r")" != "0" ]; }; then
      say "== $name: wip branches present:${others} — switch by hand: git -C \"$r\" switch <branch>"
    elif [ "$n" -eq 1 ] && [ "$(dirty_n "$r")" = "0" ]; then
      case "$branch" in
        wip/*) : ;; # already on a wip branch, stay
        *)
          wb="${others# }"
          git -C "$r" switch "$wb" >/dev/null 2>&1 && say "== $name: switched to $wb"
          branch="$(branch_of "$r")"
          ;;
      esac
    fi
    # Catch up the current branch.
    if git -C "$r" rev-parse --verify '@{upstream}' >/dev/null 2>&1; then
      behind="$(git -C "$r" rev-list --count 'HEAD..@{upstream}' 2>/dev/null || echo 0)"
      ahead="$(git -C "$r" rev-list --count '@{upstream}..HEAD' 2>/dev/null || echo 0)"
      if [ "$(dirty_n "$r")" != "0" ]; then
        # Dirty tree with an upstream that moved: replay, guard the pop.
        if [ "${behind:-0}" -gt 0 ]; then
          git -C "$r" pull --rebase --autostash >/dev/null 2>&1 || warn "$name: pull --rebase failed — resolve by hand in $r"
          in_conflict "$r" && warn "$name: autostash pop CONFLICTED — resolve by hand in $r"
        fi
      elif [ "${behind:-0}" -gt 0 ] && [ "${ahead:-0}" -eq 0 ]; then
        git -C "$r" merge --ff-only '@{upstream}' >/dev/null 2>&1 \
          && say "== $name: fast-forwarded $branch ($behind commit(s))"
      fi
    fi
    # Un-commit the wip run at the tip so the work shows up as local changes.
    if [ "$(dirty_n "$r")" = "0" ] && [ "$(git -C "$r" log -1 --format=%s 2>/dev/null | cut -c1-4)" = "wip:" ]; then
      base="$(wip_run_base "$r")"
      if [ -n "$base" ]; then
        git -C "$r" reset --mixed "$base" >/dev/null 2>&1 \
          && say "== $name: unstaged wip run on $branch ($(dirty_n "$r") local changes)"
      fi
    fi
  done
}

case "${1:-status}" in
  status) cmd_status ;;
  leave)  cmd_leave ;;
  arrive) cmd_arrive ;;
  *) say "usage: wip-sync.sh [status|leave|arrive]" >&2; exit 2 ;;
esac
exit "$([ "$FAILS" -gt 0 ] && echo 1 || echo 0)"
